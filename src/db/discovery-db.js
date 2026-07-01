// The separate music-discovery database (discovery.db).
//
// Holds the per-track dataset behind the planned cross-server discovery
// network: audio embeddings (similarity), external IDs (identity), and
// coarse filter metadata (BPM / key / tags). It is DELIBERATELY a second
// SQLite file next to mstream.db rather than more tables inside it:
//
//   * the whole point of the dataset is to be shared — a standalone file is
//     the exportable unit (see discovery-export.js);
//   * it quarantines opt-in, privacy-sensitive data (a music library is
//     surprisingly identifying) behind one file the operator can delete
//     wholesale without touching their library DB or its backups;
//   * its schema evolves on its own version line, independent of
//     mstream.db's migration chain.
//
// Nothing here runs unless `scanOptions.collectDiscoveryData` is enabled
// (config default OFF): server boot initializes the DB only when the flag is
// on, and the admin toggle initializes it the moment the flag flips on. The
// post-scan embedding worker that will actually populate discovery_tracks is
// the next phase — it writes through upsertDiscoveryTrack() below, following
// the audio-analysis-backfill worker contract.
//
// Cross-referencing: rows are keyed by the same canonical audio_hash as
// mstream.db's tracks table — that hash is the ONLY coupling between the two
// databases, and it never leaves this machine (exports replace it with the
// salted/derived export_id).

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { DatabaseSync } from './sqlite-driver.js';
import winston from 'winston';
import * as config from '../state/config.js';

// Independent version line — this is NOT mstream.db's SCHEMA_VERSION.
export const DISCOVERY_SCHEMA_VERSION = 1;

// Contract constants for the embedding column. Declared here (and copied
// into discovery_meta + every export snapshot) so a consumer never has to
// guess how to read the BLOBs. The model id / version / dimension are NOT
// constants: the embedding worker records them in discovery_meta when it
// writes its first vector, because vectors from different models (or model
// versions) live in incompatible spaces and must never be mixed.
export const EMBEDDING_DTYPE = 'float32le';
export const EMBEDDING_NORMALIZATION = 'l2';

let db = null;

const SCHEMA_V1 = `
  -- Self-description + small internal state. Every export snapshot copies
  -- the embedding_* keys so the file explains its own vector format.
  -- Internal keys (never exported): row_seq (the monotonic rowversion
  -- counter behind updated_at) and export_salt (secret salt for anonymous
  -- export ids — exporting it would let anyone brute-force local audio
  -- hashes back out of a snapshot).
  CREATE TABLE IF NOT EXISTS discovery_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discovery_tracks (
    -- INTERNAL columns (never exported) ------------------------------------
    -- Canonical audio hash — joins to mstream.db tracks.audio_hash and
    -- dedupes multiple files carrying identical audio.
    audio_hash   TEXT PRIMARY KEY,
    -- Library-file mtime at analysis time, so rescans can skip unchanged
    -- files without re-deriving anything.
    source_mtime INTEGER,
    -- App-managed monotonic rowversion (discovery_meta.row_seq), NOT wall
    -- clock — wall clock can step backwards, which breaks "everything since
    -- cursor X" incremental export. Bumped on every insert/update.
    updated_at   INTEGER NOT NULL,

    -- EXPORTED columns ------------------------------------------------------
    -- Stable share-safe identity: 'mbid:<recording-mbid>' when known, else
    -- 'anon:<salted-hash>'. NOT unique — two different rips of the same
    -- recording legitimately share an MBID.
    export_id      TEXT NOT NULL,
    recording_mbid TEXT,
    acoustid_id    TEXT,
    artist   TEXT,
    title    TEXT,
    duration REAL,
    -- Embedding provenance, pinned per row so a model upgrade can migrate
    -- gradually without ever mixing vector spaces silently.
    model_id      TEXT,
    model_version TEXT,
    embedding     BLOB,
    -- Tier-1 filter metadata (never the similarity metric — that is what
    -- the embedding is for).
    bpm          INTEGER,
    musical_key  TEXT,
    danceability REAL,
    genre_tags   TEXT,   -- JSON array
    mood_tags    TEXT,   -- JSON array
    analyzed_at  INTEGER  -- wall-clock ms, informational only
  );

  CREATE INDEX IF NOT EXISTS idx_discovery_tracks_export_id  ON discovery_tracks(export_id);
  CREATE INDEX IF NOT EXISTS idx_discovery_tracks_updated_at ON discovery_tracks(updated_at);

  -- Negative cache for the embedding worker (same shape as
  -- audio_analysis_lookups in mstream.db): per-hash attempt ledger with
  -- per-outcome cooldowns so undecodable files aren't retried every pass.
  -- Internal only — never exported.
  CREATE TABLE IF NOT EXISTS discovery_lookups (
    audio_hash      TEXT PRIMARY KEY,
    last_attempt_at INTEGER NOT NULL,
    outcome         TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1
  );
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
];

export function discoveryDbPath() {
  return path.join(config.program.storage.dbDirectory, 'discovery.db');
}

export function isDiscoveryDbOpen() {
  return db !== null;
}

export function getDiscoveryDb() {
  if (!db) { throw new Error('discovery DB is not initialized'); }
  return db;
}

// Idempotent open + migrate. Mirrors manager.js initDB(): WAL for
// concurrent reader/writer friendliness, busy_timeout so a future forked
// worker holding a write lock doesn't turn admin reads into instant
// SQLITE_BUSY errors.
//
// `dbPath` is optional — the server passes nothing (config-derived path);
// an explicit path is for callers with no config state (the future forked
// embedding worker, which receives paths via its JSON payload, and tests).
export function initDiscoveryDb(dbPath) {
  if (db) { return db; }

  db = new DatabaseSync(dbPath || discoveryDbPath());
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    runMigrations();
    seedMeta();
  } catch (err) {
    // Don't leave a half-initialized handle behind — callers treat
    // isDiscoveryDbOpen() as "ready to use".
    closeDiscoveryDb();
    throw err;
  }
  return db;
}

// For admin surfaces (export/manifest/download) that may run while
// collection is off: reuse the open handle, else open a DB that already
// exists on disk, else null — deliberately does NOT create a fresh file,
// so hitting an export endpoint never silently enables the feature.
export function openDiscoveryDbIfExists() {
  if (db) { return db; }
  if (fs.existsSync(discoveryDbPath())) { return initDiscoveryDb(); }
  return null;
}

export function closeDiscoveryDb() {
  if (!db) { return; }
  try { db.close(); } catch (err) {
    winston.warn(`discovery DB close failed: ${err.message}`);
  }
  db = null;
}

function runMigrations() {
  const currentVersion = db.prepare('PRAGMA user_version').get().user_version;

  if (currentVersion >= DISCOVERY_SCHEMA_VERSION) {
    winston.info(`Discovery database schema is up to date (v${currentVersion})`);
    return;
  }

  winston.info(`Discovery database schema v${currentVersion} → v${DISCOVERY_SCHEMA_VERSION}`);

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      winston.info(`Applying discovery migration v${migration.version}...`);
      // Same all-or-nothing wrapping as manager.js: a multi-statement
      // migration either fully applies or fully rolls back.
      db.exec('BEGIN');
      try {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

// First-boot metadata. INSERT OR IGNORE keeps every key stable across
// restarts — in particular export_salt must never rotate, or previously
// exported anon: ids would stop matching future exports.
function seedMeta() {
  const seed = db.prepare('INSERT OR IGNORE INTO discovery_meta (key, value) VALUES (?, ?)');
  seed.run('created_at', new Date().toISOString());
  seed.run('row_seq', '0');
  seed.run('export_salt', crypto.randomBytes(32).toString('hex'));
  seed.run('embedding_dtype', EMBEDDING_DTYPE);
  seed.run('embedding_normalization', EMBEDDING_NORMALIZATION);
}

export function getMeta(key) {
  const row = getDiscoveryDb().prepare('SELECT value FROM discovery_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  getDiscoveryDb().prepare(
    'INSERT INTO discovery_meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Monotonic rowversion for updated_at / incremental export cursors.
function nextUpdateSeq() {
  const row = getDiscoveryDb().prepare(
    "UPDATE discovery_meta SET value = CAST(value AS INTEGER) + 1 " +
    "WHERE key = 'row_seq' RETURNING CAST(value AS INTEGER) AS seq"
  ).get();
  return row.seq;
}

// Share-safe identity for one row. Prefer the MusicBrainz recording MBID
// (the canonical cross-library key); tracks that haven't been identified
// yet get an opaque salted id instead, so the export never carries the raw
// local audio hash. The salt is per-install and secret — see seedMeta().
export function exportIdFor(recordingMbid, audioHash) {
  if (recordingMbid) { return `mbid:${String(recordingMbid).toLowerCase()}`; }
  const salt = getMeta('export_salt');
  const digest = crypto.createHash('sha256').update(salt + audioHash).digest('hex');
  return `anon:${digest.slice(0, 32)}`;
}

// Single write path for discovery rows — the embedding worker (next phase)
// and tests both go through here so the export_id / updated_at invariants
// hold no matter who writes. Fields not supplied are stored as NULL;
// re-upserting the same audio_hash replaces the row's values and bumps
// updated_at (so incremental consumers see it as changed).
export function upsertDiscoveryTrack(fields) {
  if (!fields || !fields.audioHash) { throw new Error('upsertDiscoveryTrack requires audioHash'); }

  // Positional params only — the Bun sqlite adapter (sqlite-driver.js under
  // `bun --compile`) does not support named parameters.
  const params = [
    fields.audioHash,
    fields.sourceMtime ?? null,
    nextUpdateSeq(),
    exportIdFor(fields.recordingMbid ?? null, fields.audioHash),
    fields.recordingMbid ?? null,
    fields.acoustidId ?? null,
    fields.artist ?? null,
    fields.title ?? null,
    fields.duration ?? null,
    fields.modelId ?? null,
    fields.modelVersion ?? null,
    fields.embedding ?? null,
    fields.bpm ?? null,
    fields.musicalKey ?? null,
    fields.danceability ?? null,
    fields.genreTags ? JSON.stringify(fields.genreTags) : null,
    fields.moodTags ? JSON.stringify(fields.moodTags) : null,
    Date.now(),
  ];

  getDiscoveryDb().prepare(`
    INSERT INTO discovery_tracks (
      audio_hash, source_mtime, updated_at, export_id, recording_mbid,
      acoustid_id, artist, title, duration, model_id, model_version,
      embedding, bpm, musical_key, danceability, genre_tags, mood_tags,
      analyzed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audio_hash) DO UPDATE SET
      source_mtime   = excluded.source_mtime,
      updated_at     = excluded.updated_at,
      export_id      = excluded.export_id,
      recording_mbid = excluded.recording_mbid,
      acoustid_id    = excluded.acoustid_id,
      artist         = excluded.artist,
      title          = excluded.title,
      duration       = excluded.duration,
      model_id       = excluded.model_id,
      model_version  = excluded.model_version,
      embedding      = excluded.embedding,
      bpm            = excluded.bpm,
      musical_key    = excluded.musical_key,
      danceability   = excluded.danceability,
      genre_tags     = excluded.genre_tags,
      mood_tags      = excluded.mood_tags,
      analyzed_at    = excluded.analyzed_at
  `).run(...params);
}
