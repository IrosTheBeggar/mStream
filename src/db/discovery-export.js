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
  getDiscoveryDb, getMeta, discoveryDbPath, openedDiscoveryDbPath,
  DISCOVERY_SCHEMA_VERSION, EMBEDDING_DTYPE, EMBEDDING_NORMALIZATION,
} from './discovery-db.js';
import { launchWorker } from '../util/worker-process.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);
const EXPORT_SCRIPT_PATH = path.join(__dirname, 'discovery-export-script.mjs');
// A 138 MB copy takes seconds; leave slack for 100k-track libraries on slow
// disks before declaring the child wedged.
const EXPORT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

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

// Build (or rebuild) the current snapshot + manifest + README, on THIS
// process's discovery connection. Returns the manifest object.
//
// ⚠ The 100+ MB INSERT…SELECT inside is one synchronous DatabaseSync
// statement — in the server process it blocks the event loop for seconds
// (audit H3: 2.5–3.5 s at 25k tracks). Server-side callers must go through
// exportDiscoverySnapshot() below, which runs this in a forked child; this
// function stays exported for that child (discovery-export-script.mjs) and
// for tests that want the build synchronous and in-process.
export async function buildSnapshot(opts = {}) {
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
  let sourceRowSeq;
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
          'embedding_dtype', 'embedding_normalization',
          'embedding_model_license', 'embedding_model_attribution'
        )
      `);

      rowCount = db.prepare('SELECT COUNT(*) AS n FROM snap.tracks').get().n;
      // Captured INSIDE the transaction so it can't overshoot the snapshot's
      // actual content: auto-publish compares this against the live row_seq
      // to decide whether the export is stale.
      sourceRowSeq = Number(getMeta('row_seq') || 0);

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
    // discovery_meta.row_seq at build time — the freshness watermark
    // auto-publish (discovery-p2p.js) compares against. Not share-relevant
    // (the manifest never travels with the snapshot blob).
    sourceRowSeq,
    model: {
      id: getMeta('embedding_model_id'),
      version: getMeta('embedding_model_version'),
      dim: getMeta('embedding_dim') ? Number(getMeta('embedding_dim')) : null,
      dtype: EMBEDDING_DTYPE,
      normalization: EMBEDDING_NORMALIZATION,
    },
    // Inherited from the embedding model that produced the vectors. NC-SA
    // models (Discogs-EffNet) make the derived dataset NC-SA — declared
    // here AND in the snapshot's own meta table so no consumer is
    // surprised. Empty → no license asserted.
    license: getMeta('embedding_model_license') || null,
    attribution: getMeta('embedding_model_attribution') || null,
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

// ── Server-side entry point: build in a forked child ────────────────────────
//
// Same name + contract as the old in-process export (both callers — the
// admin route and p2p auto-publish — await it and get the manifest back),
// but the multi-second blob copy now happens in a child process, so the
// server's event loop stays free. The child gets its own connection to the
// same discovery.db; WAL gives its transaction the same point-in-time
// consistency the single-connection build had.
//
// Concurrent calls coalesce onto the running build (admin export racing
// auto-publish used to be an ATTACH failure; with a child per call it would
// be two children fighting over the same .building temp file).
let exportInFlight = null;

export async function exportDiscoverySnapshot(opts = {}) {
  while (exportInFlight) {
    const current = exportInFlight;
    const manifest = await current.promise.catch(() => null);
    // Same target: the just-finished build IS this caller's answer.
    if (manifest && current.dbPath === (opts.dbPath || openedDiscoveryDbPath() || discoveryDbPath())
      && current.outDir === (opts.outDir || exportDir())) {
      return manifest;
    }
    // Different target (or the run failed): loop until the slot frees, then
    // run our own build.
    if (exportInFlight === current) { exportInFlight = null; }
  }

  const dbPath = opts.dbPath || openedDiscoveryDbPath() || discoveryDbPath();
  const outDir = opts.outDir || exportDir();
  const entry = { dbPath, outDir, promise: null };
  entry.promise = runExportWorker(dbPath, outDir);
  exportInFlight = entry;
  try {
    return await entry.promise;
  } finally {
    if (exportInFlight === entry) { exportInFlight = null; }
  }
}

function runExportWorker(dbPath, outDir) {
  return new Promise((resolve, reject) => {
    const child = launchWorker('discovery-export', EXPORT_SCRIPT_PATH,
      JSON.stringify({ dbPath, outDir }));

    let settled = false;
    const finish = (err, value) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(watchdog);
      if (err) { reject(err); } else { resolve(value); }
    };
    const watchdog = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
      finish(new Error('discovery export worker timed out'));
    }, EXPORT_WORKER_TIMEOUT_MS);

    // stdout: line-buffered JSON events ({event:'error'} carries the cause);
    // stderr: forwarded to the log, tail kept for the failure message.
    let stdoutBuf = '';
    let childError = null;
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) { continue; }
        try {
          const evt = JSON.parse(line);
          if (evt.event === 'error') { childError = evt.message; }
        } catch (_e) { /* non-protocol chatter */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2048);
      winston.warn(`[discovery-export worker] ${text.trim()}`);
    });
    child.on('error', (err) => finish(new Error(`discovery export worker failed to start: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code !== 0 || signal) {
        return finish(new Error(childError
          || `discovery export worker exited ${signal || code}${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ''}`));
      }
      // The manifest on disk is the child's return value.
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')); }
      catch (err) {
        return finish(new Error(`discovery export worker succeeded but the manifest is unreadable: ${err.message}`));
      }
      finish(null, manifest);
    });
  });
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

## License

The dataset inherits the license of the embedding model that produced it —
declared in \`manifest.json\` (\`license\`, \`attribution\`) and this file's
\`meta\` table. Datasets built with Discogs-EffNet are **CC BY-NC-SA 4.0**
(non-commercial, share-alike; model by the Music Technology Group,
Universitat Pompeu Fabra).

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
