import path from 'path';
import fs from 'fs';
import { DatabaseSync } from './sqlite-driver.js';
import winston from 'winston';
import * as config from '../state/config.js';
import { SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { shouldMigrate, migrate } from './migrate-from-loki.js';
import { normalizeArtistName } from '../util/artist-normalize.js';

let db = null;
let clearSharedTimer = null;

// FTS5 capability flag. Set at initDB() time from
// `SELECT sqlite_compileoption_used('ENABLE_FTS5')`. Read by the search
// route to decide whether to honour `algorithm=fts5|combo` requests or
// force the LIKE path. Node's bundled SQLite (v22+) compiles FTS5 in by
// default; this flag is belt-and-braces against custom Node builds.
export let FTS5_AVAILABLE = false;

// ── Anonymous (no-users) sentinel ────────────────────────────────────────────
//
// users.user_id is a NOT NULL FK on every per-user table (user_metadata,
// playlists, cue_points, user_settings, …). When the admin hasn't created
// any real users — i.e. mStream is running in public read-only mode — every
// HTTP request still needs *some* valid user_id to attribute writes to,
// otherwise scrobbles, ratings, "save queue as playlist", etc. all crash
// with NOT NULL constraint violations.
//
// Solution: keep one always-present sentinel user row identified by the
// is_anonymous_sentinel = 1 flag (added in V25). When auth.js detects
// "no real users", it pins req.user.id to this sentinel's id so every
// downstream INSERT has a valid FK target without per-endpoint null guards.
//
// The flag, not the username, is what marks the sentinel — usernames have
// no server-side validation, so an admin could legitimately have already
// created a user with whatever default name we'd pick. ensureAnonymousUser()
// finds an unused name (suffixing if needed) for fresh sentinels, and
// existing real rows always get is_anonymous_sentinel = 0 by ALTER's
// default, so they can never be confused with the sentinel.
const ANONYMOUS_USERNAME_BASE = '__mstream_anonymous__';

let _anonymousUserId = null;

// ── In-memory cache for users and libraries ─────────────────────────────────
// These change rarely (admin panel only) but are read on every HTTP request.
// Cache is invalidated by calling invalidateCache() after any admin mutation.

let _usersCache = null;           // Map<username, userRow>
let _librariesCache = null;       // Array of library rows
let _librariesByNameCache = null; // Map<name, libraryRow>
let _userLibrariesCache = null;   // Map<userId, [libraryId, ...]>

// ── Initialize ──────────────────────────────────────────────────────────────

export function initDB() {
  const dbPath = path.join(config.program.storage.dbDirectory, 'mstream.db');
  db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // V31 adds AFTER triggers on tracks/artists/albums to maintain the
  // FTS5 index. The triggers themselves don't recursively fire other
  // user triggers (they write to FTS5 virtual tables, which have no
  // user-attached triggers), so recursive_triggers isn't strictly
  // required for V31. Set it on as defence-in-depth — cheap, and
  // any future trigger body that writes to a real table would need
  // it. Must match scanner.mjs + rust-parser for connection symmetry.
  db.exec('PRAGMA recursive_triggers = ON');

  // Performance tuning, mirroring the scanner connection (scanner.mjs).
  // cache_size + temp_store are pure wins with no durability trade-off: a larger
  // page cache keeps more of the DB/indexes hot, and temp_store=MEMORY builds
  // sort/GROUP BY temp B-trees (recently-added sort, search, stats) in RAM
  // instead of on disk. Both cache_size and synchronous are operator-configurable
  // (config.db.cacheSizeMb, default 64 MB; config.db.synchronous, default FULL
  // for user-data durability) and applied via setCacheSize()/setSynchronous() so
  // the admin panel can change either one live.
  setCacheSize(config.program.db?.cacheSizeMb || 64);
  db.exec('PRAGMA temp_store = MEMORY');
  setSynchronous(config.program.db?.synchronous || 'FULL');

  runMigrations();

  // Check FTS5 compile-time support after migrations (V31 needs it).
  // Done once at boot; the result is read by the search route on every
  // request, so a single ERROR log is enough — the route handles the
  // degraded path locally.
  try {
    // Don't alias the column to `on` — that's a SQLite reserved
    // keyword and prepare() throws ERR_SQLITE_ERROR ("SQL logic error")
    // before the SELECT ever runs. The catch below would then silently
    // set FTS5_AVAILABLE = false on every boot, even on installs where
    // FTS5 is fully compiled in.
    const row = db.prepare(
      "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5_enabled"
    ).get();
    FTS5_AVAILABLE = !!row?.fts5_enabled;
  } catch (_err) {
    FTS5_AVAILABLE = false;
  }
  if (!FTS5_AVAILABLE) {
    winston.error(
      'SQLite was compiled without FTS5 — search will fall back to LIKE-only. ' +
      'Most node:sqlite builds include FTS5; verify your Node distribution.'
    );
  }

  // One-time migration from LokiJS/config to SQLite
  if (shouldMigrate()) {
    migrate(db);
  }

  // Ensure the anonymous sentinel exists before populating caches —
  // auth.js's no-users branch needs its id at request time.
  ensureAnonymousUser();

  // Populate caches
  loadUsersCache();
  loadLibrariesCache();
  loadUserLibrariesCache();

  startSharedCleanup();

  winston.info(`Database initialized: ${dbPath}`);
}

// ── Access ──────────────────────────────────────────────────────────────────

export function getDB() {
  return db;
}

// Set the main connection's SQLite synchronous mode (FULL | NORMAL). PRAGMA
// synchronous is per-connection and live-settable — it takes effect from the
// next transaction with no reboot — so the admin toggle
// (util/admin.editDbSynchronous) can apply a change immediately. PRAGMA values
// can't be bound parameters, so the mode is allowlisted before interpolation.
export function setSynchronous(mode) {
  const m = String(mode).toUpperCase();
  if (m !== 'FULL' && m !== 'NORMAL') {
    throw new Error(`Invalid synchronous mode: ${mode}`);
  }
  db.exec(`PRAGMA synchronous = ${m}`);
}

// Set the main connection's SQLite page-cache size, in MEBIBYTES. PRAGMA
// cache_size is per-connection and live-settable, so the admin toggle
// (util/admin.editDbCacheSize) can apply a change immediately — it governs
// subsequent queries on this connection. We pass a negative value, which SQLite
// reads as "N KiB of memory" (a positive value would be a fixed page count, so
// the effective RAM would swing with page_size). The size is validated to a
// positive integer before interpolation — PRAGMA arguments can't be bound
// parameters, so this guards against injection via a malformed config value.
export function setCacheSize(mb) {
  const n = Number(mb);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid cache size (MB): ${mb}`);
  }
  db.exec(`PRAGMA cache_size = ${-(n * 1024)}`);
}

// Run fn inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw).
// Collapses a loop of writes into one fsync and makes the batch atomic, so
// callers doing bulk inserts/updates (playlist save, Subsonic star / scrobble /
// playlist mutations) don't pay a per-statement commit, and a concurrent reader
// never sees a half-applied batch. SQLite has no nested transactions — don't
// call this inside another transaction.
//
// BEGIN IMMEDIATE, not a deferred BEGIN: the scanner runs as a separate
// process that commits write batches continuously during a scan. With a
// deferred BEGIN, a body whose FIRST statement is a read (e.g. Subsonic
// updatePlaylist SELECTs playlist positions before writing) pins a read
// snapshot; when the scanner commits before the body's first write, the
// lock upgrade fails with SQLITE_BUSY_SNAPSHOT — which does NOT invoke the
// busy handler, so the 5s busy_timeout above never applies and the caller
// gets an instant non-retryable "database is locked". IMMEDIATE takes the
// write lock at BEGIN, where the busy handler IS honored, making that
// failure class impossible. Behavior-neutral for write-first bodies (they
// acquire the same lock one statement later anyway).
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

export function close() {
  stopSharedCleanup();
  if (db) {
    db.close();
    db = null;
  }
}

// ── Migrations ──────────────────────────────────────────────────────────────

function getSchemaVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function setSchemaVersion(version) {
  db.exec(`PRAGMA user_version = ${version}`);
}

function runMigrations() {
  const currentVersion = getSchemaVersion();

  if (currentVersion >= SCHEMA_VERSION) {
    winston.info(`Database schema is up to date (v${currentVersion})`);
    return;
  }

  winston.info(`Database schema v${currentVersion} → v${SCHEMA_VERSION}`);

  let needsRescan = false;
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      winston.info(`Applying migration v${migration.version}...`);
      // Wrap each migration in a single transaction so a multi-statement
      // migration (e.g. CREATE TABLE + CREATE INDEX + ALTER TABLE) either
      // applies fully or rolls back fully. Without this, a partial failure
      // could leave the DB in an inconsistent state that the next boot's
      // migration loop can't self-heal (e.g. ALTER TABLE ADD COLUMN has no
      // IF NOT EXISTS, so re-running after a mid-migration failure would
      // error with "duplicate column").
      //
      // IMMEDIATE for the same SQLITE_BUSY_SNAPSHOT reason as transaction()
      // above. Migrations are not guaranteed write-first against the MAIN
      // db: V24 opens with CREATE TEMP TABLE ... AS SELECT, which writes
      // only the per-connection temp db and READS main — and an orphaned
      // scanner from a previous server instance can still be committing
      // while this boot migrates. A migration aborts boot on failure, so
      // it should wait out busy_timeout, not die on an instant 517.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        setSchemaVersion(migration.version);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        winston.error(`Migration v${migration.version} failed: ${err.message}`);
        throw err;
      }
      if (migration.rescanRequired) {
        needsRescan = true;
      }
    }
  }

  // Write marker file if any migration requires a force rescan
  if (needsRescan) {
    const markerPath = path.join(config.program.storage.dbDirectory, '.rescan-pending');
    try {
      fs.writeFileSync(markerPath, '');
      winston.info('Migration requires force rescan — will run on next boot scan');
    } catch (_) {}
  }
}

// ── FTS5 maintenance ────────────────────────────────────────────────────────

// Run FTS5's segment-merge "optimize" command on each index. FTS5
// accumulates small index segments on every INSERT/UPDATE/DELETE; over
// a long-running scan a single index can pile up hundreds of segments,
// which slows MATCH queries until the next merge. 'optimize' merges
// everything into a single segment. Cheap to run after a scan settles
// (typically <100ms even on a 100k-row index); a no-op on a freshly
// rebuilt index.
//
// No-op when FTS5 isn't compiled in or when the tables haven't been
// created yet (early-boot calls before runMigrations). The IF NOT
// EXISTS check via sqlite_master is one cheap query — much less hassle
// than tracking a "tables ready" flag across the module.
export function optimizeFts() {
  if (!FTS5_AVAILABLE || !db) { return; }
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fts_tracks'"
  ).get();
  if (!exists) { return; }
  try {
    db.exec("INSERT INTO fts_tracks(fts_tracks) VALUES('optimize')");
    db.exec("INSERT INTO fts_artists(fts_artists) VALUES('optimize')");
    db.exec("INSERT INTO fts_albums(fts_albums) VALUES('optimize')");
  } catch (err) {
    winston.warn('FTS5 optimize failed', { stack: err });
  }
}

// ── Shared playlist cleanup ─────────────────────────────────────────────────

function startSharedCleanup() {
  const intervalHours = config.program.db?.clearSharedInterval;
  if (!intervalHours) { return; }

  clearSharedTimer = setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(now);
      winston.info('Cleared expired shared playlists');
    } catch (err) {
      winston.error('Failed to clear expired shared playlists', { stack: err });
    }
  }, intervalHours * 60 * 60 * 1000);
}

function stopSharedCleanup() {
  if (clearSharedTimer) {
    clearInterval(clearSharedTimer);
    clearSharedTimer = null;
  }
}

// ── Cache management ────────────────────────────────────────────────────────

export function invalidateCache() {
  _usersCache = null;
  _librariesCache = null;
  _librariesByNameCache = null;
  _userLibrariesCache = null;
}

function loadUsersCache() {
  if (_usersCache) { return; }
  _usersCache = new Map();
  for (const row of db.prepare('SELECT * FROM users').all()) {
    _usersCache.set(row.username, row);
  }
}

function loadLibrariesCache() {
  if (_librariesCache) { return; }
  _librariesCache = db.prepare('SELECT * FROM libraries').all();
  _librariesByNameCache = new Map();
  for (const lib of _librariesCache) {
    _librariesByNameCache.set(lib.name, lib);
  }
}

function loadUserLibrariesCache() {
  if (_userLibrariesCache) { return; }
  _userLibrariesCache = new Map();
  for (const row of db.prepare('SELECT user_id, library_id FROM user_libraries').all()) {
    if (!_userLibrariesCache.has(row.user_id)) {
      _userLibrariesCache.set(row.user_id, []);
    }
    _userLibrariesCache.get(row.user_id).push(row.library_id);
  }
}

// ── Cached lookups (hot path — called on every request) ─────────────────────

export function getUserByUsername(username) {
  loadUsersCache();
  const row = _usersCache.get(username);
  // The sentinel is never reachable by name. Login attempts already fail
  // at PBKDF2 (its stored hash is the literal '!' which no PBKDF2 output
  // can produce), but every other call site — admin mint-key, password
  // change, delete-user, edit-access, Subsonic getUser/updateUser — also
  // resolves users by name, and we don't want any of those to be able
  // to address the sentinel either. The auth no-users branch resolves
  // the sentinel by id (getAnonymousUserId), not name, so it's
  // unaffected by this filter.
  if (row?.is_anonymous_sentinel === 1) { return undefined; }
  return row;
}

export function getAllUsers() {
  loadUsersCache();
  // Hide the anonymous sentinel — empty-check `getAllUsers().length === 0`
  // should mean "no real users", and admin panels listing users shouldn't
  // surface a row no one can actually log in as.
  return Array.from(_usersCache.values()).filter(u => u.is_anonymous_sentinel !== 1);
}

export function getAnonymousUserId() {
  return _anonymousUserId;
}

// Returns the anonymous sentinel's full users-table row (or null when
// the sentinel hasn't been initialised yet — only happens before
// initDB() finishes).
//
// Callers: auth.js's no-users branch uses this to spread the sentinel's
// columns (lastfm_user, lastfm_password, listenbrainz_token, …) onto
// req.user, so public-mode requests look like a real-user request and
// the per-user-data endpoints (LB/Last.fm scrobbling, /lastfm/status,
// etc.) work without per-endpoint special-casing.
//
// getUserByUsername / getAllUsers intentionally hide the sentinel from
// admin-facing surfaces; this getter is the explicit bypass for the one
// caller that legitimately needs the full row.
export function getAnonymousUser() {
  if (_anonymousUserId === null) { return null; }
  loadUsersCache();
  for (const u of _usersCache.values()) {
    if (u.id === _anonymousUserId) { return u; }
  }
  return null;
}

// "Public mode" predicate. Returns true when the request has no user
// (legacy null-id callers) OR when it's been pinned to the anonymous
// sentinel by auth.js's no-users branch. Used wherever the old code
// said `if (!user || !user.id)` to mean "skip per-user filtering /
// short-circuit per-user state writes".
//
// Background: V25 introduced the sentinel so per-user tables (which all
// FK NOT NULL on users(id)) can accept inserts in public/no-users mode.
// auth.js now sets `req.user.id = getAnonymousUserId()` instead of `null`,
// which makes the sentinel id truthy. Every site that used `!user.id` as
// a shorthand for "public mode" got silently bypassed by the change —
// most visibly the library filter, which started returning `1=0` for
// public-mode requests because the sentinel has no user_libraries rows.
//
// Call this whenever the OLD intent was "treat the absence of a user as
// public mode" — it preserves that intent while remaining correct under
// the sentinel design.
export function isPublicMode(user) {
  if (!user || !user.id) { return true; }
  return _anonymousUserId !== null && user.id === _anonymousUserId;
}

function ensureAnonymousUser() {
  // Already have a sentinel? Reuse it.
  const existing = db.prepare('SELECT id FROM users WHERE is_anonymous_sentinel = 1').get();
  if (existing) {
    _anonymousUserId = existing.id;
    return;
  }

  // Pick a username that isn't already taken. Almost always the canonical
  // base; suffix with a counter only on the unlikely chance that an admin
  // has already created a user with that name.
  let username = ANONYMOUS_USERNAME_BASE;
  for (let i = 1; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); i++) {
    username = `${ANONYMOUS_USERNAME_BASE.slice(0, -2)}_${i}__`;
  }

  // Dummy password/salt are literal '!' — no PBKDF2 output ever produces
  // that exact string, so login attempts against the sentinel are
  // guaranteed to fail at the hash-comparison step in src/util/auth.js.
  const result = db.prepare(
    `INSERT INTO users (username, password, salt, is_admin, is_anonymous_sentinel,
                        allow_upload, allow_mkdir, allow_server_audio)
     VALUES (?, '!', '!', 0, 1, 0, 0, 0)`
  ).run(username);
  _anonymousUserId = Number(result.lastInsertRowid);
}

export function getLibraryByName(name) {
  loadLibrariesCache();
  return _librariesByNameCache.get(name);
}

export function getLibraryById(id) {
  loadLibrariesCache();
  return _librariesCache.find((l) => l.id === id);
}

export function getAllLibraries() {
  loadLibrariesCache();
  return _librariesCache;
}

export function getUserLibraryIds(user) {
  // Public mode (no user, or pinned to the anonymous sentinel by auth.js)
  // — every library is visible. Without this branch, the sentinel id (a
  // real integer with zero rows in user_libraries) would fall through to
  // the lookup below and return [], which libraryFilter then translates
  // to `1=0`, hiding every track. See isPublicMode() above for context.
  if (isPublicMode(user)) {
    loadLibrariesCache();
    return _librariesCache.map(l => l.id);
  }
  loadUserLibrariesCache();
  return _userLibrariesCache.get(user.id) || [];
}

// ── Helper queries (not cached — called less frequently) ────────────────────

export function inPlaceholders(arr) {
  return '(' + arr.map(() => '?').join(',') + ')';
}

export function findOrCreateArtist(name) {
  if (!name) { return null; }
  const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name);
  if (existing) { return existing.id; }
  const result = db.prepare('INSERT INTO artists (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

// Given an array of artist names from an external source (typically
// Last.fm `artist.getSimilar` output), return the subset that exists
// in the local library, using the canonical `artists.name` spelling
// — suitable for passing straight into an `IN (?, ?, ...)` filter on
// the tracks table.
//
// Matching is fuzzy through src/util/artist-normalize.js: case-folded,
// diacritic-stripped, `&`↔`and` swap, whitespace collapse. So a
// Last.fm "Beyoncé" matches a library "Beyonce"; "AC/DC" matches "AC DC";
// "Foo & Bar" matches "Foo and Bar". See the normalizer for the full
// rule set.
//
// Strategy: load `(id, name)` for every artist row (one query, cheap
// on libraries up to ~100k artists — single-digit ms), compute the
// normalized form per artist, then look each input name up in the
// resulting Map. No cache layer — invalidation interacts badly with
// scans that add new artists, and the per-call cost is well below
// the Last.fm HTTP round-trip we run before this anyway.
export function resolveArtistNamesForDJ(names) {
  if (!Array.isArray(names) || names.length === 0) { return []; }
  if (!db) { return []; }

  // Build normalized → first-seen library name lookup. Two library
  // artists that normalize to the same key (e.g. "Beyonce" + "Beyoncé"
  // both → "beyonce") collide here — we keep the first; both are
  // semantically the same artist for DJ purposes.
  const libByNorm = new Map();
  for (const row of db.prepare('SELECT name FROM artists').all()) {
    const norm = normalizeArtistName(row.name);
    if (norm && !libByNorm.has(norm)) {
      libByNorm.set(norm, row.name);
    }
  }

  // Dedup the input set in case Last.fm returned variants that
  // normalize to the same key.
  const result = new Set();
  for (const name of names) {
    if (typeof name !== 'string') { continue; }
    const norm = normalizeArtistName(name);
    if (!norm) { continue; }
    const libName = libByNorm.get(norm);
    if (libName) { result.add(libName); }
  }
  return [...result];
}

export function findOrCreateAlbum(name, artistId, year) {
  if (!name) { return null; }
  const existing = db.prepare(
    'SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?'
  ).get(name, artistId, year);
  if (existing) { return existing.id; }
  const result = db.prepare(
    'INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)'
  ).run(name, artistId, year);
  return Number(result.lastInsertRowid);
}

// Parse a genre string (e.g. "Rock; Electronic, Pop") into individual genre names.
// Handles comma, semicolon, and slash delimiters.
export function parseGenreString(genreStr) {
  if (!genreStr) { return []; }
  return genreStr
    .split(/[,;\/]/)
    .map(g => g.trim())
    .filter(g => g.length > 0);
}

// Find or create a genre by name. Returns the genre id.
export function findOrCreateGenre(name) {
  if (!name) { return null; }
  const existing = db.prepare('SELECT id FROM genres WHERE name = ?').get(name);
  if (existing) { return existing.id; }
  const result = db.prepare('INSERT INTO genres (name) VALUES (?)').run(name);
  return Number(result.lastInsertRowid);
}

// Link a track to its genres. Parses the genre string and creates junction entries.
export function setTrackGenres(trackId, genreStr) {
  const genres = parseGenreString(genreStr);
  if (genres.length === 0) { return; }

  const insertLink = db.prepare(
    'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
  );
  for (const name of genres) {
    const genreId = findOrCreateGenre(name);
    if (genreId) { insertLink.run(trackId, genreId); }
  }
}

// REPLACE-semantics version of setTrackGenres — clears the existing
// track_genres rows for this track first, then re-inserts based on the
// new genre string. Used by the file-edit / tag-write handler, which
// needs to reflect user edits to the genre tag (where the new tag may
// have FEWER genres than the old one — pure-INSERT would leak the old
// ones). The scanner doesn't need this because it clears track_genres
// itself before re-inserting on every re-parse, and its stale sweep
// deletes removed tracks (CASCADE drops their track_genres rows).
//
// Empty / null genreStr clears the link list entirely (matches the
// "user removed all genres from the tag" case).
//
// Wrapped in a transaction so concurrent readers never observe the
// in-between state where the DELETE has fired but the new INSERTs
// haven't landed yet. Without this, a /getSong or DLNA browse that
// happens to interleave between the two statements would see zero
// genres on the track and surface a misleading `genre: null` /
// missing upnp:genre. The scanner runs in a separate process so
// this matters in practice — the backup worker, scanner, and HTTP
// handlers all share the same DB file.
// BEGIN IMMEDIATE for the same reason as transaction() above — the body
// is write-first today, but IMMEDIATE keeps it immune to the
// SQLITE_BUSY_SNAPSHOT trap if a read is ever added before the DELETE.
export function replaceTrackGenres(trackId, genreStr) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM track_genres WHERE track_id = ?').run(trackId);
    setTrackGenres(trackId, genreStr);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

// ── Backup destinations + history (V26) ─────────────────────────────────────

// Defaults applied when a destination's exclude_globs column is NULL.
// Two groups. First, the OS detritus most music libraries pick up from
// being browsed via Explorer / Finder / indexer services. Second,
// in-flight temp files: mStream's own writers drop these inside the
// library while a backup may be walking it (album-art embed's
// *.tmp_art*, yt-dlp remux's *.tmp.*, generic *.tmp), and torrent
// clients keep in-progress downloads as *.part / *.!qb — mirroring
// those meant every pass copied half-written files and then trashed
// them as orphans on the next pass (churn that compounds on seedboxes,
// where each completed torrent triggers an after-scan backup while its
// neighbours are still downloading). Exclusion is symmetric
// (source AND dest), so previously-mirrored temp junk simply stops
// being maintained rather than being swept.
//
// Lives here (rather than in the API or worker) because both
// api/backup.js and the task-queue's runBackupTask need to agree on
// the effective list, and db/manager.js is the only module both
// already import. NULL-column destinations pick the new list up
// automatically; rows with custom patterns keep exactly what the
// operator saved.
export const DEFAULT_BACKUP_EXCLUDE_GLOBS = [
  'Thumbs.db', 'desktop.ini', '.DS_Store', '._*',
  '*.tmp', '*.tmp.*', '*.tmp_art*', '*.part', '*.!qb', '*.crdownload',
];

// Resolve a backup_destinations row's exclude_globs column into a
// concrete string array. NULL in storage → defaults; JSON array →
// parsed; malformed JSON → defaults (fail-safe so a bad row doesn't
// take the API/worker down).
export function getEffectiveExcludeGlobs(dest) {
  if (!dest || dest.exclude_globs == null) { return DEFAULT_BACKUP_EXCLUDE_GLOBS.slice(); }
  try {
    const parsed = JSON.parse(dest.exclude_globs);
    return Array.isArray(parsed) ? parsed : DEFAULT_BACKUP_EXCLUDE_GLOBS.slice();
  } catch (_) {
    return DEFAULT_BACKUP_EXCLUDE_GLOBS.slice();
  }
}


// All destination getters join libraries for name/root_path AND the
// per-library follow_symlinks flag — runBackupTask forwards it to the
// backup worker as followSymlinks. If the flag is missing from the
// SELECT, dest.follow_symlinks reads undefined → false, and symlinked
// library content is silently omitted from every backup.
export function getBackupDestinations() {
  return db.prepare(`
    SELECT d.*, l.name AS library_name, l.root_path AS library_root_path,
           l.follow_symlinks AS follow_symlinks
      FROM backup_destinations d
      JOIN libraries l ON l.id = d.library_id
     ORDER BY l.name, d.dest_path
  `).all();
}

export function getBackupDestinationById(id) {
  return db.prepare(`
    SELECT d.*, l.name AS library_name, l.root_path AS library_root_path,
           l.follow_symlinks AS follow_symlinks
      FROM backup_destinations d
      JOIN libraries l ON l.id = d.library_id
     WHERE d.id = ?
  `).get(id);
}

export function getBackupDestinationsByLibrary(libraryId, { triggerType, enabledOnly = true } = {}) {
  let sql = `
    SELECT d.*, l.name AS library_name, l.root_path AS library_root_path,
           l.follow_symlinks AS follow_symlinks
      FROM backup_destinations d
      JOIN libraries l ON l.id = d.library_id
     WHERE d.library_id = ?
  `;
  const params = [libraryId];
  if (enabledOnly) { sql += ' AND d.enabled = 1'; }
  if (triggerType) { sql += ' AND d.trigger_type = ?'; params.push(triggerType); }
  return db.prepare(sql).all(...params);
}

export function getBackupDestinationsByTrigger(triggerType) {
  return db.prepare(`
    SELECT d.*, l.name AS library_name, l.root_path AS library_root_path,
           l.follow_symlinks AS follow_symlinks
      FROM backup_destinations d
      JOIN libraries l ON l.id = d.library_id
     WHERE d.trigger_type = ? AND d.enabled = 1
  `).all(triggerType);
}

export function addBackupDestination({ libraryId, destPath, triggerType, dailyAtHour, retentionDays, enabled, excludeGlobs, interFileDelayMs }) {
  const result = db.prepare(`
    INSERT INTO backup_destinations
      (library_id, dest_path, trigger_type, daily_at_hour, retention_days, enabled, exclude_globs, inter_file_delay_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    libraryId,
    destPath,
    triggerType,
    dailyAtHour ?? null,
    retentionDays,
    enabled ? 1 : 0,
    // Stored as JSON text (or NULL meaning "use API defaults"). Encoding
    // here rather than in the API layer keeps the storage format
    // consistent regardless of caller.
    excludeGlobs == null ? null : JSON.stringify(excludeGlobs),
    interFileDelayMs ?? 0
  );
  return Number(result.lastInsertRowid);
}

// Patch a destination. Only the fields present in `fields` are updated;
// missing fields are left alone (so the API can do partial PATCH semantics).
// Note that `exclude_globs` accepts either a JSON-encoded string (set
// directly, used by API which encodes upstream) or null to clear; the
// caller is responsible for passing the encoded form.
export function updateBackupDestination(id, fields) {
  const allowed = ['dest_path', 'trigger_type', 'daily_at_hour', 'retention_days', 'enabled', 'exclude_globs', 'inter_file_delay_ms'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?`);
      const value = key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key];
      params.push(value);
    }
  }
  if (sets.length === 0) { return; }
  params.push(id);
  db.prepare(`UPDATE backup_destinations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteBackupDestination(id) {
  db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id);
}

// History row lifecycle: createBackupRunRow returns the row id, the worker
// updates counts via updateBackupRunProgress as it goes, and the manager
// finalises the row with finishBackupRunRow when the worker exits.
export function createBackupRunRow({ destinationId, triggerReason, status = 'running', errorMessage = null }) {
  // finished_at must use the same datetime('now') form as started_at and
  // finishBackupRunRow ('YYYY-MM-DD HH:MM:SS', UTC). A JS
  // new Date().toISOString() here produced a second, incompatible format
  // for rows created already-finished (skipped / disabled-before-start):
  // consumers normalise these timestamps with `s.replace(' ','T') + 'Z'`
  // (sqliteUtcToLocalDateKey, the admin UI's formatTime), and an ISO
  // value run through that gains a trailing 'ZZ' and parses to an
  // Invalid Date. The interpolated branch is a fixed SQL literal —
  // status is an internal enum, never user text.
  const finishedSql = status === 'running' ? 'NULL' : "datetime('now')";
  const result = db.prepare(`
    INSERT INTO backup_history
      (destination_id, started_at, finished_at, status, trigger_reason, error_message)
    VALUES (?, datetime('now'), ${finishedSql}, ?, ?, ?)
  `).run(destinationId, status, triggerReason, errorMessage);
  pruneBackupHistory(destinationId);
  return Number(result.lastInsertRowid);
}

// Keep at most this many history rows per destination. Without a cap the
// table grows one row per run forever (after-scan triggers alone can add
// dozens a day); 500 matches the history endpoint's maximum page size,
// so pruning never removes anything the UI could still request. Called
// on every row insert — the DELETE is a no-op until the cap is reached.
//
// A 'running' row is NEVER pruned: it belongs to a live worker that will
// finalise it (finishBackupRunRow) and whose progress the status
// endpoint reads back by id. Deleting it mid-run would turn those
// updates into silent no-ops. In practice the newest row is the running
// one so it sits safely at the top of the keep-window, but the explicit
// guard makes that independent of how many rows pile in behind it.
const BACKUP_HISTORY_MAX_ROWS = 500;
export function pruneBackupHistory(destinationId) {
  db.prepare(`
    DELETE FROM backup_history
     WHERE destination_id = ?
       AND status != 'running'
       AND id NOT IN (
         SELECT id FROM backup_history
          WHERE destination_id = ?
          ORDER BY id DESC
          LIMIT ${BACKUP_HISTORY_MAX_ROWS}
       )
  `).run(destinationId, destinationId);
}

export function updateBackupRunProgress(historyId, { filesCopied, filesUnchanged, filesTrashed, bytesCopied }) {
  db.prepare(`
    UPDATE backup_history
       SET files_copied    = ?,
           files_unchanged = ?,
           files_trashed   = ?,
           bytes_copied    = ?
     WHERE id = ?
  `).run(filesCopied ?? 0, filesUnchanged ?? 0, filesTrashed ?? 0, bytesCopied ?? 0, historyId);
}

export function finishBackupRunRow(historyId, { status, errorMessage = null }) {
  db.prepare(`
    UPDATE backup_history
       SET status        = ?,
           finished_at   = datetime('now'),
           error_message = ?
     WHERE id = ?
  `).run(status, errorMessage, historyId);
}

export function getBackupHistory(destinationId, limit = 50) {
  // Tie-break on id (DESC) because datetime('now') is second-precision
  // — multiple runs in the same second otherwise come back in arbitrary
  // order, which surprises both the API list view and tests that
  // immediately check "what was the most recent run?" id is monotonic
  // with insertion so it's a stable proxy for "actually most recent."
  return db.prepare(`
    SELECT * FROM backup_history
     WHERE destination_id = ?
     ORDER BY started_at DESC, id DESC
     LIMIT ?
  `).all(destinationId, limit);
}

// Called once at boot. Any row still 'running' at startup belongs to a
// previous process that crashed mid-backup; the worker can't recover, so
// flip it to 'failed' with a clear message rather than letting it sit
// "running" forever (which would also block the in-flight check that
// gates fresh runs against the same destination).
//
// `excludeHistoryId` is for the reboot-without-process-exit path: in
// `serveIt() -> reboot() -> serveIt()` the Node process keeps running,
// so a backup worker forked by the previous serveIt may still be alive
// and tracked by task-queue's activeBackupRun. Marking its row 'failed'
// just to have its real close handler overwrite the status moments later
// produces UI flicker; passing the live id here skips it.
export function markStaleBackupRunsFailed(excludeHistoryId = null) {
  const sql = excludeHistoryId == null
    ? `UPDATE backup_history
          SET status        = 'failed',
              finished_at   = datetime('now'),
              error_message = 'Interrupted by server restart'
        WHERE status = 'running'`
    : `UPDATE backup_history
          SET status        = 'failed',
              finished_at   = datetime('now'),
              error_message = 'Interrupted by server restart'
        WHERE status = 'running' AND id != ?`;
  const result = excludeHistoryId == null
    ? db.prepare(sql).run()
    : db.prepare(sql).run(excludeHistoryId);
  return result.changes;
}

// "Last fully-clean run" — no production caller since the scheduler
// moved to getLastBackupAttempt and progress estimation to
// getLastCountedBackupBefore. Kept (and pinned by tests) because the
// success-only semantic is the natural next UI surface ("last verified
// good backup: <date>") and its absence is what the 'partial' status
// exists to make visible.
export function getLastSuccessfulBackup(destinationId) {
  return db.prepare(`
    SELECT * FROM backup_history
     WHERE destination_id = ? AND status = 'success'
     ORDER BY started_at DESC, id DESC
     LIMIT 1
  `).get(destinationId);
}

export function getLastBackupRun(destinationId) {
  return db.prepare(`
    SELECT * FROM backup_history
     WHERE destination_id = ?
     ORDER BY started_at DESC, id DESC
     LIMIT 1
  `).get(destinationId);
}

// The most recent row that represents an actual ATTEMPT to run —
// everything except 'skipped'. Skip rows record a dedup NO-OP ("you
// clicked Run Now while a run was in flight"), and the daily scheduler
// must not let one consume the day's window: a manual click at 23:05
// while an after-scan run from 22:50 was still active would otherwise
// silently suppress a daily_at_hour=23 backup (the active run itself
// doesn't block — its 22:xx start is before the scheduled hour — but
// the skip row's 23:05 stamp does). The UI's last-run cell keeps using
// getLastBackupRun above, where showing the skip IS the point.
export function getLastBackupAttempt(destinationId) {
  return db.prepare(`
    SELECT * FROM backup_history
     WHERE destination_id = ? AND status != 'skipped'
     ORDER BY started_at DESC, id DESC
     LIMIT 1
  `).get(destinationId);
}

// Look up a single history row by primary key. Used by the live-status
// endpoint to fetch the active run's most recent counts (the worker
// updates the row on every progress event via updateBackupRunProgress,
// so the row's columns reflect the worker's latest state).
export function getBackupHistoryRowById(historyId) {
  return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(historyId);
}

// Find the most recent COUNTED run for `destinationId` strictly before
// `beforeHistoryId`, for the live-status progress denominator: a
// steady-state backup processes roughly the same total
// `(copied + unchanged + trashed)` count as its previous run, so that
// figure is our best zero-cost estimate. 'partial' runs count here
// (they processed nearly the whole library — a few per-file errors
// barely move the denominator) even though they're excluded from
// getLastSuccessfulBackup: without them, a destination with ONE
// perpetually-failing file (a name illegal on the backup FS, a locked
// track) would be 'partial' on every run and show an indeterminate
// spinner forever. Returns null on the first-ever run (UI then renders
// the spinner, correctly).
export function getLastCountedBackupBefore(destinationId, beforeHistoryId) {
  return db.prepare(`
    SELECT * FROM backup_history
     WHERE destination_id = ? AND status IN ('success', 'partial') AND id < ?
     ORDER BY started_at DESC, id DESC
     LIMIT 1
  `).get(destinationId, beforeHistoryId);
}
