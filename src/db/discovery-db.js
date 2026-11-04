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
import { resolveJournalMode, ensureDbFile, setJournalMode } from './journal-mode.js';

// Independent version line — this is NOT mstream.db's SCHEMA_VERSION.
export const DISCOVERY_SCHEMA_VERSION = 4;

// The music map's tables live BESIDE that version line (ensureMapTables
// below), on a line of their own: a change of their shape bumps this, and
// "migrating" them is dropping them for the next map pass to rebuild.
export const MAP_SCHEMA = 1;

// Contract constants for the embedding column. Declared here (and copied
// into discovery_meta + every export snapshot) so a consumer never has to
// guess how to read the BLOBs. The model id / version / dimension are NOT
// constants: the embedding worker records them in discovery_meta when it
// writes its first vector, because vectors from different models (or model
// versions) live in incompatible spaces and must never be mixed.
export const EMBEDDING_DTYPE = 'float32le';
export const EMBEDDING_NORMALIZATION = 'l2';

let db = null;
// The path the singleton actually opened — config-derived by default, but
// tests and forked workers pass explicit paths, and the export orchestrator
// needs to hand THAT path (not a re-derived one) to its child process.
let openedPath = null;

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

// V2: covering partial index for the status API's coverage counts (2026-07
// audit H6). Both the done-count (model_id = ? over embedded rows) and the
// ATTACH'd NOT-EXISTS eligibility probe (model_id = ? AND audio_hash = ?)
// resolve entirely inside this index instead of walking the table's
// blob-laden pages. The win is the COLD case — the audit measured
// 0.8–1.4 s per status recompute at 25k rows against uncached pages of a
// ~140 MB file; with everything warm the difference shrinks, which is why
// the request path additionally went stale-while-revalidate
// (enrichment-status-lib.js).
const SCHEMA_V2 = `
  CREATE INDEX IF NOT EXISTS idx_discovery_tracks_embedded_model
    ON discovery_tracks(model_id, audio_hash) WHERE embedding IS NOT NULL;
`;

// V3: catalogue fields (2026-09 discovery plug-in groundwork). A network
// recommendation used to travel as artist+title+duration only, which is not
// enough to find the recording anywhere else (Soulseek, Deezer/iTunes,
// Lidarr, MusicBrainz all disambiguate on album / year, and ISRC and the
// release-group MBID are direct-hit keys). All four are catalogue facts
// copied from the file's own tags — the same share-safe class as artist and
// title; no path, hash or listening data. Nullable and ADDITIVE on purpose:
// the export snapshot keeps its format version so older peers still read
// newer snapshots (discovery-export.js), and older discovery.db rows are
// filled in place by fillCatalogueFieldsFromLibrary() below.
//
// The partial index is what keeps the fill cheap to *detect*: task-queue's
// enqueue pre-check and the worker's fill gate both probe "is any row still
// unfilled?" through it instead of walking the table's blob-laden pages,
// and it shrinks to nothing once the fill has run.
const SCHEMA_V3 = `
  ALTER TABLE discovery_tracks ADD COLUMN album TEXT;
  ALTER TABLE discovery_tracks ADD COLUMN year INTEGER;
  ALTER TABLE discovery_tracks ADD COLUMN isrc TEXT;
  ALTER TABLE discovery_tracks ADD COLUMN release_group_mbid TEXT;
  CREATE INDEX IF NOT EXISTS idx_discovery_tracks_album_null
    ON discovery_tracks(audio_hash) WHERE album IS NULL;
`;

// V4: mood heads (2026-10). The embedder's mood/character heads score each
// track on a fixed set of traits (discovery-features-lib.js, spec.moods).
// INTERNAL columns — the export allowlist carries only the coarse
// `danceability` + `mood_tags` that were in the format from the start:
//   mood_scores   JSON object, every head's 0–1 score
//   mood_version  the head set that produced them (spec.moods.version), so
//                 the worker re-analyses embedded rows whose pin is missing
//                 or old — once — the way model_id drives a model swap
// The V2 covering index gains mood_version so the enqueue pre-check and the
// status counts stay index-only when they ask "current model AND current
// moods?"; the old index is its prefix, so it goes.
const SCHEMA_V4 = `
  ALTER TABLE discovery_tracks ADD COLUMN mood_scores TEXT;
  ALTER TABLE discovery_tracks ADD COLUMN mood_version TEXT;
  DROP INDEX IF EXISTS idx_discovery_tracks_embedded_model;
  CREATE INDEX IF NOT EXISTS idx_discovery_tracks_embedded_model_mood
    ON discovery_tracks(model_id, audio_hash, mood_version) WHERE embedding IS NOT NULL;
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
];

// The music map (src/db/map-layout.mjs writes, src/api/discovery-map.js
// reads). Library-specific, rebuildable, never exported — the P2P export is
// an allowlist (discovery-export.js). Created by ensureMapTables(), NOT by
// a numbered migration: a V5 would make every older build turn discovery
// off entirely (runMigrations refuses a newer file) — Discover, sonic Auto
// DJ, the mood and genre syncs — to protect a cache the next pass rebuilds.
// Older builds ignore unknown tables, so a rollback costs only the map.
//
// Foreign keys are never enabled on this file: every cleanup is an explicit
// DELETE, and a layout always goes in this order — its map_points, its
// map_regions, then its map_layouts row.
//
// discovery_meta keys of the map: map_schema and map_epoch (ensureMapTables),
// map_version (bumped in the same transaction as any write to the serving
// layout's rows here — part of the map routes' rev), map_recent_after (the
// recent baseline: set once, kept across map-table resets, refits and model
// changes), map_next_key (the counter behind new 't:'/'c:' region keys).
// Map writes never touch row_seq or index_epoch: those drive the P2P
// auto-publish and the similarity-index rebuild.
const MAP_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS map_layouts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    state         TEXT    NOT NULL CHECK (state IN ('building','ready')),
    model_id      TEXT    NOT NULL,           -- the layout's identity is (model_id, layoutVersion, dim)
    model_version TEXT,                       -- informational: discovery_meta.embedding_model_version at rebuild
    method        TEXT    NOT NULL CHECK (method IN ('umap','pca2')),
    params        TEXT    NOT NULL,           -- JSON {layoutVersion, nNeighbors, minDist, seed, epochs, learningRate, warmFrom, nFitMax, runtime}
    dim           INTEGER NOT NULL,           -- embedding dimension, read from the blobs (never from the model registry)
    k             INTEGER NOT NULL,           -- PCA components kept: min(50, dim, nSample − 1); 0 for a one-song library
    pca_mean      BLOB    NOT NULL,           -- dim × f32le
    pca_axes      BLOB    NOT NULL,           -- k × dim × f32le, row-major, sign-normalised
    affine        TEXT    NOT NULL,           -- JSON [a,b,c,d,e,f]: map = (a·rx + b·ry + c, d·rx + e·ry + f)
    frame         INTEGER NOT NULL,           -- bumps when the affine is re-fitted (clients reset their view)
    aspect        REAL    NOT NULL,           -- width / height of the fitted box
    land_levels   TEXT    NOT NULL,           -- JSON {sigma, coast, mid, high}
    n_fit         INTEGER NOT NULL,           -- points in the UMAP fit set (landmarks when n > nFitMax)
    n_points      INTEGER NOT NULL,           -- hashes placed
    dirty         INTEGER NOT NULL DEFAULT 0, -- 1 while a place run's point chunks are ahead of its region update
    created_at    INTEGER NOT NULL,           -- epoch ms
    fitted_at     INTEGER NOT NULL,           -- epoch ms of the last rebuild or warm refit in this lineage
    placed_at     INTEGER                     -- epoch ms of the last placement batch
  );
  -- A rowid table: rows are ~320 B (two 32-char hashes, pca at k × 4 = 200 B, scalars),
  -- past SQLite's ~1/20-page guidance for WITHOUT ROWID tables.
  CREATE TABLE IF NOT EXISTS map_points (
    id         INTEGER PRIMARY KEY,
    layout_id  INTEGER NOT NULL,
    audio_hash TEXT    NOT NULL,              -- canonical hash (= COALESCE(audio_hash, file_hash))
    dot        TEXT    NOT NULL,              -- opaque near-duplicate group label; re-keys never touch it
    x          REAL    NOT NULL,              -- the DOT's position: every member of a group carries the group's values
    y          REAL    NOT NULL,              -- map units; [0,1] after fitBox, at most 0.02 outside after a warm refit
    placed     TEXT    NOT NULL CHECK (placed IN ('fit','knn','pca2')),   -- 'fit' = in the UMAP fit set (a landmark)
    region0    INTEGER NOT NULL,              -- per-layout province id 0..254 (the dot's)
    region1    INTEGER NOT NULL,              -- per-layout town id 0..254 (the dot's)
    central0   REAL    NOT NULL,              -- −‖z − mean(province)‖ in PCA space (higher = more central; the dot's)
    central1   REAL    NOT NULL,              -- the same against the town
    pca        BLOB    NOT NULL,              -- k × f32le, THIS member's own projection (saves re-reading 1280-d vectors)
    UNIQUE (layout_id, audio_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_map_points_hash ON map_points(audio_hash);   -- hash-transition re-keys
  CREATE TABLE IF NOT EXISTS map_regions (
    layout_id INTEGER NOT NULL,
    level     INTEGER NOT NULL CHECK (level IN (0,1)),
    id        INTEGER NOT NULL CHECK (id BETWEEN 0 AND 254),               -- fits the payload's u8 (255 = none)
    key       TEXT    NOT NULL,              -- stable across refits: 'g:<Genre>' | 't:<n>' | 'c:<n>'
    parent    INTEGER,                       -- province id, for a town
    label     TEXT,                          -- display name; NULL when no member has a style
    style     TEXT,                          -- raw 'Genre---Style' (town) or the genre (province)
    hue       INTEGER NOT NULL,              -- 0..359; towns carry their province's hue
    x REAL NOT NULL, y REAL NOT NULL,        -- town: k-means centre; province: centroid of its dots
    anchor_x  REAL NOT NULL, anchor_y REAL NOT NULL,
    extent    REAL NOT NULL,                 -- 80th-percentile member distance from the centroid
    size      INTEGER NOT NULL,              -- dots, library-wide
    mix       TEXT NOT NULL,                 -- JSON array of ≤ 64 dot labels in walk order
    land      BLOB,                          -- land-v1, provinces only
    PRIMARY KEY (layout_id, level, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_map_regions_key ON map_regions(layout_id, key);
`;

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
// concurrent reader/writer friendliness (or the rollback journal
// journal-mode.js picks where file locks can't keep processes apart),
// busy_timeout so a forked worker holding a write lock doesn't turn admin
// reads into instant SQLITE_BUSY errors.
//
// `dbPath` is optional — the server passes nothing (config-derived path);
// an explicit path is for callers with no config state (the forked workers,
// which receive paths via their JSON payload, and tests). Only the server
// sets the journal mode, like initDB(): the workers inherit it from the
// database header.
export function initDiscoveryDb(dbPath) {
  if (db) { return db; }

  openedPath = dbPath || discoveryDbPath();
  ensureDbFile(openedPath);
  db = new DatabaseSync(openedPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!dbPath) {
      setJournalMode(db, resolveJournalMode(config.program.storage.dbDirectory,
        { override: config.program.db?.journalMode }), openedPath);
    }
    runMigrations();
    seedMeta();
    ensureMapTables(db);
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
//
// A file this build cannot open — created by a newer mStream (the downgrade
// case), or any open/migration failure — reads as ABSENT here rather than
// throwing. Every caller already treats null as "discovery is off" and
// answers with its own clean 403/404; a throw instead escaped as a 500 from
// every discovery route on a downgraded install (2026-09-14 compat smoke).
// Boot logs the full reason once (server.js); this warns once per distinct
// cause so a burst of requests can't turn it into log spam, and retries on
// every call because the condition clears the moment the operator upgrades
// or replaces the file.
let lastOpenFailure = null;
export function openDiscoveryDbIfExists() {
  if (db) { return db; }
  if (!fs.existsSync(discoveryDbPath())) { return null; }
  try {
    return initDiscoveryDb();
  } catch (err) {
    if (lastOpenFailure !== err.message) {
      lastOpenFailure = err.message;
      winston.warn(`discovery DB unavailable — treating it as absent until it can be opened: ${err.message}`);
    }
    return null;
  }
}

// Boot with collection off: the server leaves discovery.db closed, but a
// worker can still open an existing file (acoustid does whenever it exists)
// and inherit its mode. Where this directory needs the DELETE fallback, put
// an existing file in it now, while the server is its only user — a worker
// holding it open in WAL later would refuse the switch. WAL needs no such
// step: the server sets it whenever it opens the file. Best-effort, no
// migrations: discovery data is optional and must never stop the boot.
export function settleDiscoveryJournalMode() {
  if (db) { return; }
  const p = discoveryDbPath();
  if (!fs.existsSync(p)) { return; }
  const mode = resolveJournalMode(config.program.storage.dbDirectory,
    { override: config.program.db?.journalMode });
  if (mode !== 'DELETE') { return; }
  let conn = null;
  try {
    conn = new DatabaseSync(p);
    conn.exec('PRAGMA busy_timeout = 5000');
    setJournalMode(conn, mode, p);
  } catch (err) {
    winston.warn(`discovery DB journal mode not settled: ${err.message}`);
  } finally {
    try { conn?.close(); } catch (_err) { /* never opened */ }
  }
}

export function closeDiscoveryDb() {
  if (!db) { return; }
  try { db.close(); } catch (err) {
    winston.warn(`discovery DB close failed: ${err.message}`);
  }
  db = null;
  openedPath = null;
}

// The path the open singleton was created from, or null when closed.
export function openedDiscoveryDbPath() {
  return db ? openedPath : null;
}

function runMigrations() {
  const currentVersion = db.prepare('PRAGMA user_version').get().user_version;

  // A discovery db from a newer mStream — the same case manager.js refuses
  // for mstream.db. Throwing here is the right size of failure for a side
  // dataset: initDiscoveryDb's caller logs it and leaves discovery off for
  // this boot, and the music server still comes up.
  if (currentVersion > DISCOVERY_SCHEMA_VERSION) {
    throw new Error(
      `The discovery database was created by a newer mStream: its schema is v${currentVersion}, ` +
      `this build supports up to v${DISCOVERY_SCHEMA_VERSION}. Upgrade mStream to the version that ` +
      'created it (or newer); discovery stays off until then.');
  }

  if (currentVersion === DISCOVERY_SCHEMA_VERSION) {
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

// The music map's tables, beside the versioned schema (see MAP_TABLES_SQL).
// Run by initDiscoveryDb after the migrations, so the server and every
// worker that opens the file get them.
//
// While discovery_meta.map_schema equals MAP_SCHEMA this only runs the
// IF-NOT-EXISTS DDL. Otherwise — a fresh file, an upgrade into the map, or
// a build with another table shape — one IMMEDIATE transaction drops the
// three tables, deletes the map_* meta keys except map_recent_after (the
// recent baseline outlives every map generation), recreates the tables and
// stamps map_schema plus a fresh map_epoch: 16 random hex characters naming
// THIS generation of map tables. mstream.db's serving pointer copies it, so
// a pointer left from a deleted or replaced discovery.db, or from before a
// reset, never reads new layout ids (AUTOINCREMENT restarts after a DROP).
// The schema is re-read inside the transaction: a second process opening
// the file at the same moment must not drop what the first just built. A
// current file whose map_epoch went missing (hand-edited meta) gets a fresh
// one, so no pointer can ever validate against nothing.
//
// `handle` is for callers holding a connection that is not the singleton;
// defaults to it. Returns { reset } — true when the tables were (re)built.
export function ensureMapTables(handle = getDiscoveryDb()) {
  const readSchema = handle.prepare("SELECT value FROM discovery_meta WHERE key = 'map_schema'");
  const newEpoch = () => crypto.randomBytes(8).toString('hex');
  let previous = null;
  let reset = false;
  if (readSchema.get()?.value !== String(MAP_SCHEMA)) {
    handle.exec('BEGIN IMMEDIATE');
    try {
      previous = readSchema.get()?.value ?? null;
      if (previous !== String(MAP_SCHEMA)) {
        handle.exec(`
          DROP TABLE IF EXISTS map_points;
          DROP TABLE IF EXISTS map_regions;
          DROP TABLE IF EXISTS map_layouts;
        `);
        handle.prepare(
          "DELETE FROM discovery_meta WHERE substr(key, 1, 4) = 'map_' AND key <> 'map_recent_after'"
        ).run();
        handle.exec(MAP_TABLES_SQL);
        const put = handle.prepare('INSERT INTO discovery_meta (key, value) VALUES (?, ?)');
        put.run('map_schema', String(MAP_SCHEMA));
        put.run('map_epoch', newEpoch());
        reset = true;
      }
      handle.exec('COMMIT');
    } catch (err) {
      try { handle.exec('ROLLBACK'); } catch (_e) { /* not in a transaction */ }
      throw err;
    }
  }
  if (!reset) {
    handle.exec(MAP_TABLES_SQL);
    handle.prepare("INSERT OR IGNORE INTO discovery_meta (key, value) VALUES ('map_epoch', ?)").run(newEpoch());
  } else if (previous !== null) {
    winston.info(`Music map tables reset (map schema v${previous} → v${MAP_SCHEMA}); the next map pass rebuilds them`);
  }
  return { reset };
}

// The map's counters are upserts, not UPDATEs: a reset deletes their keys,
// and an UPDATE of a missing key changes nothing — map_version would then
// never move again and the map routes would answer stale revisions. Both
// run on the caller's connection, inside the caller's write transaction.

/** Bump map_version (the serving layout's rows here changed); returns the new value. */
export function bumpMapVersion(handle = getDiscoveryDb()) {
  return handle.prepare(
    "INSERT INTO discovery_meta (key, value) VALUES ('map_version', '1') " +
    'ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 ' +
    'RETURNING CAST(value AS INTEGER) AS v'
  ).get().v;
}

/**
 * Reserve `count` numbers for new 't:' / 'c:' region keys (map_next_key,
 * one counter for both). Returns the first; the block is [first, first +
 * count). Numbers are never reused within a generation of map tables.
 */
export function reserveMapKeys(count, handle = getDiscoveryDb()) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`reserveMapKeys needs a count >= 0, got ${count}`);
  }
  // CAST(? AS INTEGER): node:sqlite binds every JS number as REAL, and
  // INTEGER + REAL would store '5.0'.
  return handle.prepare(
    "INSERT INTO discovery_meta (key, value) VALUES ('map_next_key', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(? AS INTEGER) ' +
    'RETURNING CAST(value AS INTEGER) AS next'
  ).get(String(count), count).next - count;
}

/**
 * The recent baseline (map_recent_after, a tracks.created_at string): set
 * once, by the first ready layout, and never moved again — it survives
 * map-table resets, refits and model changes. An empty value is not a
 * baseline and is not stored. Returns true when this call set it.
 */
export function initMapRecentAfter(value, handle = getDiscoveryDb()) {
  if (value === null || value === undefined || value === '') { return false; }
  return handle.prepare(
    "INSERT OR IGNORE INTO discovery_meta (key, value) VALUES ('map_recent_after', ?)"
  ).run(String(value)).changes > 0;
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

// Advance row_seq without writing a row — for bulk operations whose plain
// DELETEs would otherwise be invisible to every row_seq consumer (the
// similarity index epoch below, auto-publish's freshness watermark). The
// embedding worker calls this once when its orphan prune actually removed
// rows.
export function bumpRowSeq() {
  return nextUpdateSeq();
}

// ── V3 catalogue-field fill ─────────────────────────────────────────────────
//
// Rows written before schema V3 have album / year / isrc /
// release_group_mbid = NULL although the library knows them. Nothing else
// would ever revisit those rows: the embedding worker only selects tracks
// with no current-model embedding. These two helpers run against the open
// discovery handle with the LIBRARY DB attached under `libSchema` (the
// worker attaches it as `lib`, task-queue's pre-check as `precheck_lib`).
//
// "Fillable" means album IS NULL here AND the library track has an album
// row — a file with no album tag can never be filled and must not count,
// or the pre-check would fork the worker on every drain forever. The
// canonical-hash join is the UNION ALL id-subquery form (not COALESCE or a
// flat OR) so both hash indexes on tracks are used; see resolveVisible in
// src/api/discovery.js for the measured difference.
function fillableJoin(libSchema) {
  return `
    SELECT 1 FROM ${libSchema}.tracks t
     WHERE t.album_id IS NOT NULL
       AND t.id IN (
             SELECT id FROM ${libSchema}.tracks WHERE audio_hash = discovery_tracks.audio_hash
             UNION ALL
             SELECT id FROM ${libSchema}.tracks WHERE file_hash = discovery_tracks.audio_hash AND audio_hash IS NULL
           )`;
}

export function hasFillableCatalogueRows(libSchema = 'lib') {
  const row = getDiscoveryDb().prepare(`
    SELECT 1 FROM discovery_tracks
     WHERE album IS NULL AND EXISTS (${fillableJoin(libSchema)})
     LIMIT 1
  `).get();
  return !!row;
}

// Fill every fillable row in one statement. The representative library
// track is the lowest id among the files sharing the canonical hash — the
// same choice the embedding worker makes (MIN(t.id)). Bumps row_seq once
// when anything changed so auto-publish sees a stale snapshot; per-row
// updated_at is deliberately left alone (nothing about the row's identity
// or vector moved). Returns the number of rows filled.
export function fillCatalogueFieldsFromLibrary(libSchema = 'lib') {
  const ddb = getDiscoveryDb();
  // Cheap gate through the partial index: the common steady state is "no
  // unfilled rows", and that must cost one index probe, not a scan.
  if (!ddb.prepare('SELECT 1 FROM discovery_tracks WHERE album IS NULL LIMIT 1').get()) { return 0; }
  const changes = ddb.prepare(`
    UPDATE discovery_tracks
       SET (album, year, isrc, release_group_mbid) = (
             SELECT al.name, COALESCE(t.year, al.year), t.isrc, al.mbz_release_group_id
               FROM ${libSchema}.tracks t
               JOIN ${libSchema}.albums al ON al.id = t.album_id
              WHERE t.id IN (
                      SELECT id FROM ${libSchema}.tracks WHERE audio_hash = discovery_tracks.audio_hash
                      UNION ALL
                      SELECT id FROM ${libSchema}.tracks WHERE file_hash = discovery_tracks.audio_hash AND audio_hash IS NULL
                    )
              ORDER BY t.id
              LIMIT 1)
     WHERE album IS NULL AND EXISTS (${fillableJoin(libSchema)})
  `).run().changes;
  if (changes > 0) { bumpRowSeq(); }
  return changes;
}

// ── Similarity-index epoch ──────────────────────────────────────────────────
//
// row_seq bumps on EVERY row write, which made it a catastrophic cache key
// for the in-memory similarity index: during an embedding backfill each
// upsert moved it, so every request rebuilt the full matrix (audit H5 —
// 1.5-1.7 s per rebuild at 25k tracks, recurring for hours). index_epoch is
// the BATCH-grained sibling: writers publish it at batch/run boundaries by
// copying row_seq's current value, so the epoch only moves when data
// changed AND a writer declared a consistent point to rebuild from.
//
// Contract for writers of discovery_tracks:
//   * per-row paths (upsertDiscoveryTrack, updateDiscoveryIdentity) do NOT
//     touch it;
//   * batch owners (the embedding worker's run end, the AcoustID worker's
//     run end, applyHashTransitionGroups) call publishIndexEpoch() once
//     when done.
// Readers treat a missing key as "no writer has ever published" and fall
// back to row_seq — pre-upgrade DBs and unit tests that write directly keep
// the old per-write invalidation until the first publish.
export function publishIndexEpoch() {
  setMeta('index_epoch', getMeta('row_seq') || '0');
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
    // V3 catalogue fields.
    fields.album ?? null,
    fields.year ?? null,
    fields.isrc ?? null,
    fields.releaseGroupMbid ?? null,
    // V4 mood heads.
    fields.moodScores ? JSON.stringify(fields.moodScores) : null,
    fields.moodVersion ?? null,
  ];

  getDiscoveryDb().prepare(`
    INSERT INTO discovery_tracks (
      audio_hash, source_mtime, updated_at, export_id, recording_mbid,
      acoustid_id, artist, title, duration, model_id, model_version,
      embedding, bpm, musical_key, danceability, genre_tags, mood_tags,
      analyzed_at, album, year, isrc, release_group_mbid,
      mood_scores, mood_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      analyzed_at    = excluded.analyzed_at,
      album              = excluded.album,
      year               = excluded.year,
      isrc               = excluded.isrc,
      release_group_mbid = excluded.release_group_mbid,
      mood_scores    = excluded.mood_scores,
      mood_version   = excluded.mood_version
  `).run(...params);
}

// Identity upgrade from the AcoustID pass: set the recording MBID (+ the
// AcoustID cluster id) on an EXISTING row and recompute export_id
// (anon: → mbid:) with a rowversion bump — deliberately NOT
// upsertDiscoveryTrack, which replaces unsupplied fields with NULL and
// would wipe the embedding. Fill-NULL only (a tag-sourced id that arrived
// via the embedding pass wins); no-op when the hash has no row yet — the
// embedding pass carries identity from the library when it creates rows,
// so either ordering converges. Returns true when a row changed.
export function updateDiscoveryIdentity(audioHash, recordingMbid, acoustidId) {
  if (!audioHash || !recordingMbid) { return false; }
  const changes = getDiscoveryDb().prepare(`
    UPDATE discovery_tracks
       SET recording_mbid = COALESCE(recording_mbid, ?),
           acoustid_id    = COALESCE(acoustid_id, ?),
           export_id      = ?,
           updated_at     = ?
     WHERE audio_hash = ? AND recording_mbid IS NULL
  `).run(recordingMbid, acoustidId ?? null,
    exportIdFor(recordingMbid, audioHash), nextUpdateSeq(), audioHash).changes;
  return changes > 0;
}

// V60 hash-transition re-key: move rows whose canonical audio hash was
// re-keyed by the scanner onto their new identity, preserving the
// single-write-path invariants raw UPDATEs would break — export_id is
// recomputed against the NEW hash (anon ids are salted hashes of the
// audio hash; a stale one would silently rotate the track's network
// identity at the next re-derive) and updated_at gets a rowversion bump
// (incremental consumers and the similarity index cache key on it).
//
// `groups` is [{ target, sources }]: every old identity that collapsed
// to `target` in one drain. Per group, canonical-wins with freshness:
// a row already AT the target was re-derived under the new identity and
// keeps its state (sources are dropped); otherwise the freshest source
// row moves and the rest are dropped — never the insertion-order
// roulette of applying pairs one at a time. One transaction for the
// whole apply: a mid-apply crash re-applies cleanly from the intact
// ledger instead of leaving a half-re-keyed table.
//
// The music map's points follow in the same transaction, in every layout
// that holds them (the serving one and the previous one): each source's
// rows take the target hash, and a source row whose layout already has a
// point at the target is dropped (that point serves the target's tracks
// from now on). The point keeps its position — no re-placement, no jump —
// and `dot` / `mix` are left alone: group labels are opaque and every
// member row carries its dot's values, so re-keying a group's label member,
// or a singleton's own hash, moves nothing and loses no track from the
// mirror. The next map pass (the queue enqueues one after the applier)
// reconciles track_map.hash. Map rows are no similarity-index input, so
// they never publish an index epoch.
//
// Returns { moved, dropped } for discovery_tracks plus { pointsMoved,
// pointsDropped } for map_points rows.
export function applyHashTransitionGroups(groups) {
  const out = { moved: 0, dropped: 0, pointsMoved: 0, pointsDropped: 0 };
  if (!groups || groups.length === 0) { return out; }
  const ddb = getDiscoveryDb();
  // Rowversions for the moves are reserved as ONE block inside the
  // transaction below (audit M1: per-move nextUpdateSeq() was one
  // discovery_meta UPDATE per row across a 15k-row drain). At most one
  // move per group, so groups.length covers it; unused reservations leave
  // gaps in row_seq, which is fine — it's a monotonic version, not a count.
  const reserveSeqs = ddb.prepare(
    "UPDATE discovery_meta SET value = CAST(value AS INTEGER) + ? " +
    "WHERE key = 'row_seq' RETURNING CAST(value AS INTEGER) AS seq");
  const stmts = {
    trackGet: ddb.prepare(
      'SELECT audio_hash, recording_mbid, updated_at FROM discovery_tracks WHERE audio_hash = ?'),
    trackDel: ddb.prepare('DELETE FROM discovery_tracks WHERE audio_hash = ?'),
    trackMove: ddb.prepare(
      'UPDATE discovery_tracks SET audio_hash = ?, export_id = ?, updated_at = ? WHERE audio_hash = ?'),
    lookGet: ddb.prepare(
      'SELECT audio_hash, last_attempt_at FROM discovery_lookups WHERE audio_hash = ?'),
    lookDel: ddb.prepare('DELETE FROM discovery_lookups WHERE audio_hash = ?'),
    lookMove: ddb.prepare(
      'UPDATE discovery_lookups SET audio_hash = ? WHERE audio_hash = ?'),
    // Both index-backed by idx_map_points_hash. OR IGNORE skips the rows
    // whose layout already has a point at the target (UNIQUE (layout_id,
    // audio_hash)); the DELETE then removes exactly those leftovers.
    pointMove: ddb.prepare('UPDATE OR IGNORE map_points SET audio_hash = ? WHERE audio_hash = ?'),
    pointDel: ddb.prepare('DELETE FROM map_points WHERE audio_hash = ?'),
  };
  ddb.exec('BEGIN');
  try {
    const seqBase = reserveSeqs.get(groups.length).seq - groups.length;
    let seqUsed = 0;
    for (const { target, sources } of groups) {
      const live = sources.map((s) => stmts.trackGet.get(s)).filter(Boolean);
      if (live.length > 0) {
        if (stmts.trackGet.get(target)) {
          for (const r of live) { stmts.trackDel.run(r.audio_hash); out.dropped++; }
        } else {
          live.sort((a, b) => b.updated_at - a.updated_at);
          stmts.trackMove.run(target,
            exportIdFor(live[0].recording_mbid, target), seqBase + (++seqUsed), live[0].audio_hash);
          out.moved++;
          for (const r of live.slice(1)) { stmts.trackDel.run(r.audio_hash); out.dropped++; }
        }
      }
      const lookups = sources.map((s) => stmts.lookGet.get(s)).filter(Boolean);
      if (lookups.length > 0) {
        if (stmts.lookGet.get(target)) {
          for (const r of lookups) { stmts.lookDel.run(r.audio_hash); }
        } else {
          lookups.sort((a, b) => b.last_attempt_at - a.last_attempt_at);
          stmts.lookMove.run(target, lookups[0].audio_hash);
          for (const r of lookups.slice(1)) { stmts.lookDel.run(r.audio_hash); }
        }
      }
      for (const source of sources) {
        if (source === target) { continue; }   // never: the DELETE would take the target's own points
        out.pointsMoved += stmts.pointMove.run(target, source).changes;
        out.pointsDropped += stmts.pointDel.run(source).changes;
      }
    }
    ddb.exec('COMMIT');
  } catch (err) {
    try { ddb.exec('ROLLBACK'); } catch (_e) { /* not in a transaction */ }
    throw err;
  }
  // Re-keyed hashes must reach the similarity index (its entries are keyed
  // by canonical hash; stale ones would miss every main-DB lookup) — this
  // drain is a batch owner, so it publishes.
  if (out.moved + out.dropped > 0) { publishIndexEpoch(); }
  return out;
}
