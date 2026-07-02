// Export-snapshot builder for the music-discovery dataset (discovery.db).
//
// Produces a cleaned, self-contained SQLite file that is safe to hand to
// someone else: ONLY the share-safe columns travel. The internal columns
// (raw audio_hash, source_mtime, updated_at) and internal tables
// (discovery_lookups, the row_seq counter, the secret export_salt) never
// leave the machine — a music library is identifying, so the snapshot is
// built by explicit allowlist, not by copying-and-deleting.
//
// Mechanics note: `VACUUM INTO` cannot filter (it copies a whole schema
// verbatim), so the snapshot is built the explicit way — ATTACH a fresh
// file, CREATE the export tables, INSERT…SELECT the allowlisted columns.
// A freshly built file is already compact; no vacuum needed.
//
// The snapshot is self-describing: its `meta` table carries the embedding
// format contract (model id/version, dim, dtype, endianness, normalization)
// copied from discovery_meta, so a consumer can (a) know how to read the
// BLOBs and (b) refuse to mix vectors from an incompatible model version.
// A manifest.json (row count, sha256, sizes) is written next to it so a
// consumer can check compatibility before pulling the file.
//
// P0 scope: admin/local export only — one current snapshot at a stable
// path, rebuilt (overwritten) on each request. Network-peer / public
// distribution is a later phase; the incremental-cursor groundwork
// (updated_at) already exists in the live DB for when that lands.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import winston from 'winston';
import * as config from '../state/config.js';
import {
  getDiscoveryDb, getMeta,
  DISCOVERY_SCHEMA_VERSION, EMBEDDING_DTYPE, EMBEDDING_NORMALIZATION,
} from './discovery-db.js';

export const SNAPSHOT_FORMAT = 'mstream-discovery-snapshot';
export const SNAPSHOT_FORMAT_VERSION = 1;

export function exportDir() {
  return path.join(config.program.storage.dbDirectory, 'discovery-export');
}

export function snapshotPath() {
  return path.join(exportDir(), 'discovery-export.db');
}

export function manifestPath() {
  return path.join(exportDir(), 'manifest.json');
}

export function snapshotExists() {
  return fs.existsSync(snapshotPath());
}

// Current manifest, or null when no export has been built yet. A corrupt
// manifest is treated as absent (and logged) rather than crashing the
// admin endpoint — the fix is simply re-running the export.
export function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`discovery export manifest unreadable (${err.message}) — treating as absent`);
    }
    return null;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

// Build (or rebuild) the current snapshot + manifest + README.
// Returns the manifest object. Caller is responsible for serializing
// concurrent invocations (the admin route holds a simple in-flight flag).
// `opts.outDir` overrides the config-derived output directory (tests /
// config-less callers); the admin routes pass nothing.
export async function exportDiscoverySnapshot(opts = {}) {
  const db = getDiscoveryDb();

  const outDir = opts.outDir || exportDir();
  fs.mkdirSync(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'discovery-export.db');
  const tmpPath = `${finalPath}.building`;
  fs.rmSync(tmpPath, { force: true });

  // SQLite string literal: escape embedded single quotes by doubling.
  const attachTarget = tmpPath.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${attachTarget}' AS snap`);

  let rowCount;
  try {
    // One transaction around the whole build: the main connection spans both
    // schemas, so the snapshot is a consistent point-in-time view even if a
    // writer (the future embedding worker) is running concurrently.
    db.exec('BEGIN');
    try {
      db.exec(`
        PRAGMA snap.user_version = ${SNAPSHOT_FORMAT_VERSION};

        CREATE TABLE snap.meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE snap.tracks (
          -- Share-safe identity: 'mbid:<recording-mbid>' when known, else an
          -- opaque salted id. NOT unique across rows — two rips of the same
          -- recording legitimately share an MBID.
          export_id      TEXT NOT NULL,
          recording_mbid TEXT,
          acoustid_id    TEXT,
          artist   TEXT,
          title    TEXT,
          duration REAL,
          model_id      TEXT,
          model_version TEXT,
          embedding     BLOB,
          bpm          INTEGER,
          musical_key  TEXT,
          danceability REAL,
          genre_tags   TEXT,
          mood_tags    TEXT
        );

        CREATE INDEX snap.idx_tracks_export_id ON tracks(export_id);
      `);

      // Explicit column allowlist — audio_hash / source_mtime / updated_at
      // deliberately absent. Deterministic ordering so identical data
      // produces an identically ordered (diffable) snapshot; the trailing
      // audio_hash tiebreaker only fixes row order, the value itself is
      // not exported.
      db.exec(`
        INSERT INTO snap.tracks (
          export_id, recording_mbid, acoustid_id, artist, title, duration,
          model_id, model_version, embedding, bpm, musical_key, danceability,
          genre_tags, mood_tags
        )
        SELECT
          export_id, recording_mbid, acoustid_id, artist, title, duration,
          model_id, model_version, embedding, bpm, musical_key, danceability,
          genre_tags, mood_tags
        FROM discovery_tracks
        ORDER BY export_id, audio_hash
      `);

      // Meta travels by allowlist too — row_seq and (especially) the secret
      // export_salt must never ship.
      db.exec(`
        INSERT INTO snap.meta (key, value)
        SELECT key, value FROM discovery_meta
        WHERE key IN (
          'embedding_model_id', 'embedding_model_version', 'embedding_dim',
          'embedding_dtype', 'embedding_normalization'
        )
      `);

      rowCount = db.prepare('SELECT COUNT(*) AS n FROM snap.tracks').get().n;

      const putMeta = db.prepare('INSERT OR REPLACE INTO snap.meta (key, value) VALUES (?, ?)');
      putMeta.run('format', SNAPSHOT_FORMAT);
      putMeta.run('format_version', String(SNAPSHOT_FORMAT_VERSION));
      putMeta.run('source_schema_version', String(DISCOVERY_SCHEMA_VERSION));
      putMeta.run('generated_at', new Date().toISOString());
      putMeta.run('row_count', String(rowCount));
      putMeta.run('generator', 'mStream');

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    // Failed build: detach + drop the partial file, keep any previous
    // snapshot/manifest intact.
    try { db.exec('DETACH DATABASE snap'); } catch (_detachErr) { /* attach itself failed */ }
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  db.exec('DETACH DATABASE snap');

  // Swap into place. Windows rename() won't overwrite, so drop the old
  // snapshot first — the manifest (written after) is the source of truth,
  // and a crash in this window just means "re-run the export".
  fs.rmSync(finalPath, { force: true });
  fs.renameSync(tmpPath, finalPath);

  const manifest = {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    sourceSchemaVersion: DISCOVERY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    file: path.basename(finalPath),
    sizeBytes: fs.statSync(finalPath).size,
    sha256: await sha256File(finalPath),
    rowCount,
    model: {
      id: getMeta('embedding_model_id'),
      version: getMeta('embedding_model_version'),
      dim: getMeta('embedding_dim') ? Number(getMeta('embedding_dim')) : null,
      dtype: EMBEDDING_DTYPE,
      normalization: EMBEDDING_NORMALIZATION,
    },
    // No license is asserted for the exported data — distributing a snapshot
    // beyond personal backup is the operator's decision (and jurisdiction).
    license: null,
    notes: {
      exportId: 'export_id is "mbid:<musicbrainz-recording-id>" when known, '
        + 'else "anon:<opaque-salted-id>". It is NOT unique across rows: '
        + 'different encodings of the same recording share an MBID.',
      embedding: `Track embeddings are raw ${EMBEDDING_DTYPE} arrays `
        + `(little-endian), ${EMBEDDING_NORMALIZATION}-normalized; dim/model in meta. `
        + 'NULL until the analysis pass has processed the track.',
    },
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), readmeText());

  winston.info(`discovery export built: ${rowCount} tracks, ${manifest.sizeBytes} bytes`);
  return manifest;
}

function readmeText() {
  return `# mStream discovery-data snapshot

A self-contained SQLite database exported from an mStream server's
music-discovery dataset (\`${SNAPSHOT_FORMAT}\`, format version
${SNAPSHOT_FORMAT_VERSION}). Verify integrity against \`manifest.json\`
(sha256, row count) before use.

## Tables

- \`tracks\` — one row per analysed audio file.
  - \`export_id\`: \`mbid:<musicbrainz-recording-id>\` when the recording was
    identified, else \`anon:<opaque-id>\`. **Not unique** — different
    encodings of the same recording share an MBID.
  - \`embedding\`: raw little-endian float32 array, L2-normalized (cosine
    similarity = dot product). Dimension and model are declared in \`meta\`.
    NULL for tracks the analysis pass hasn't reached.
  - \`bpm\`, \`musical_key\`, \`danceability\`, \`genre_tags\`, \`mood_tags\`:
    coarse filter metadata (tags are JSON arrays).
- \`meta\` — key/value self-description: embedding model id/version/dim/
  dtype/normalization, format, generation time, row count.

Embeddings from different \`model_id\`/\`model_version\` values live in
incompatible vector spaces — never compare them.

## Reading it

\`\`\`python
import sqlite3, numpy as np
db = sqlite3.connect('discovery-export.db')
meta = dict(db.execute('SELECT key, value FROM meta'))
for export_id, blob in db.execute('SELECT export_id, embedding FROM tracks WHERE embedding IS NOT NULL'):
    vec = np.frombuffer(blob, dtype='<f4')
\`\`\`

No file paths, local identifiers, or listening history are included.
`;
}
