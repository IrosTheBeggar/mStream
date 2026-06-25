// mStream album-art downloader — child process forked by src/db/task-queue.js.
//
// The third enrichment pass (scan → waveforms → this). The scanners only
// ever source art from embedded tags or folder images; this pass runs after
// the scan queue drains and fills the gaps from the operator-configured
// external services (MusicBrainz/Cover Art Archive, iTunes, Deezer).
//
// Modes (scanOptions.autoAlbumArtMode):
//   'missing' (default) — only albums with no cover at all. A found image
//       becomes the album default + the default of its art-less tracks
//       (with track_art links so the default stays a member of the set),
//       exactly the no-clobber shape: pinned/pre-existing defaults are
//       structurally untouchable because they're non-NULL.
//   'all' — every album. Albums that already have a cover get the fetched
//       image ADDED to their album_art gallery without touching any
//       default; the V50 hash dedupe skips images the album already
//       carries (same bytes as the embedded/folder/previously-fetched
//       art), so re-runs converge instead of accumulating.
//
// V50 content-hash dedupe: downloaded bytes are hashed BEFORE caching — an
// existing cached art_files row with that hash is linked instead of
// minting a duplicate file + row (covers shared across editions converge
// to one image), and album_art_lookups.fetched_hash records what each
// 'found' attempt returned.
//
// Rate-limit etiquette: services are queried in configured order, first
// usable image wins, with interRequestMs (default 1.1s — MusicBrainz's
// ~1 req/s policy) between albums. Every attempt is recorded in
// album_art_lookups (V51) with per-outcome cooldowns so scheduled scans
// never re-hammer the same dead ends; maxPerRun bounds each run's hold on
// the serial task slot and task-queue re-enqueues while hitCap persists.
//
// CLI input — single argv entry, JSON-encoded (built in task-queue.js):
//   { dbPath, albumArtDirectory, compressImage, services, mode,
//     writeToFolder, maxPerRun, expectedSchemaVersion,
//     notFoundCooldownSec, errorCooldownSec, interRequestMs }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'albumArtProgress', attempted, total }
//   { event: 'albumArtComplete', attempted, updated, deduped, notFound,
//     errors, hitCap }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 completed (per-album failures recorded, not fatal);
// 1 fatal (bad input, DB open failure); 3 schema-version guard.

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from './sqlite-driver.js';
import Joi from 'joi';
import {
  httpGet,
  saveImageToCache,
  saveCoverJpg,
  sniffImage,
  generateThumbnails,
  SERVICE_SEARCHERS,
} from './album-art-lib.js';

const SCHEMA_GUARD_EXIT = 3;

// ── Parse + validate CLI input ───────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  dbPath: Joi.string().required(),
  albumArtDirectory: Joi.string().required(),
  // Emit the zl-/zs- thumbnail variants alongside the cached cover.
  compressImage: Joi.boolean().default(true),
  // Services to query, in order — first to return a usable image wins.
  services: Joi.array()
    .items(Joi.string().valid('musicbrainz', 'itunes', 'deezer'))
    .min(1)
    .default(['musicbrainz', 'itunes', 'deezer']),
  mode: Joi.string().valid('missing', 'all').default('missing'),
  // Also write fetched covers as cover.jpg into each folder holding the
  // album's tracks (existing cover.jpg / identical content never
  // overwritten). Driven by scanOptions.autoAlbumArtWriteToFolder.
  writeToFolder: Joi.boolean().default(false),
  maxPerRun: Joi.number().integer().min(1).default(100),
  // Refuse to touch a DB whose PRAGMA user_version differs — same guard
  // as both scanners (half-migrated DB, second instance, racing migration).
  expectedSchemaVersion: Joi.number().integer().optional(),
  // Cooldowns before re-attempting an album. 'notfound' and 'found' get
  // the long one (service catalogues change slowly); 'error' the short
  // one (timeouts/5xx are likely transient).
  notFoundCooldownSec: Joi.number().integer().min(0).default(30 * 24 * 60 * 60),
  errorCooldownSec: Joi.number().integer().min(0).default(24 * 60 * 60),
  // Minimum spacing between per-album lookups: MusicBrainz asks ~1 req/s.
  interRequestMs: Joi.number().integer().min(0).default(1100),
  // Wall-clock budget per run. The whole pass holds the serial task slot;
  // against a blackholed network every lookup burns timeouts (up to
  // ~45-180s/album worst case), so the per-run ALBUM cap alone could hold
  // the slot for hours while scans/backups queue behind. Hitting the
  // budget ends the run early with hitCap so task-queue re-enqueues —
  // queued scans interleave between passes.
  runBudgetSec: Joi.number().integer().min(1).default(300),
});

const { error: validationError, value: cfg } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

// ── Open SQLite database ─────────────────────────────────────────────────────

const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

function checkSchemaGuard(context) {
  if (cfg.expectedSchemaVersion == null) { return; }
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v !== cfg.expectedSchemaVersion) {
    emit({ event: 'error',
      message: `schema-version guard: DB is V${v}, expected V${cfg.expectedSchemaVersion} (${context})` });
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(SCHEMA_GUARD_EXIT);
  }
}
checkSchemaGuard('at open');

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(event) {
  console.log(JSON.stringify(event));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Albums we haven't tried too recently. 'error' rows come off cooldown
// sooner than 'found'/'notfound' (CASE). Albums with no lookup row are
// always eligible. Mode decides the base set: art-less albums only, or
// every named album (gallery enrichment — dedupe keeps re-runs cheap).
// Trackless rows are excluded: starred ghosts (the orphan sweep keeps
// them) are invisible on every list surface, so fetching their art
// burns external requests on covers nobody can see — if the ghost
// re-attaches, its next eligibility check finds it normally.
function selectEligibleAlbums(nowSec) {
  const longCutoff = nowSec - cfg.notFoundCooldownSec;
  const errorCutoff = nowSec - cfg.errorCooldownSec;
  const artFilter = cfg.mode === 'all' ? '' : 'AND a.album_art_file IS NULL';
  return db.prepare(`
    SELECT a.id   AS album_id,
           a.name AS album_name,
           a.album_art_file AS current_default,
           COALESCE(NULLIF(a.album_artist, ''), ar.name) AS artist_name
      FROM albums a
      LEFT JOIN artists ar          ON ar.id = a.artist_id
      LEFT JOIN album_art_lookups l ON l.album_id = a.id
     WHERE a.name IS NOT NULL
       AND TRIM(a.name) != ''
       AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id)
       ${artFilter}
       AND (
            l.album_id IS NULL
         OR l.last_attempt_at < (CASE WHEN l.outcome = 'error' THEN ? ELSE ? END)
       )
     ORDER BY a.id
     LIMIT ?
  `).all(errorCutoff, longCutoff, cfg.maxPerRun);
}

// Try each configured service in order; first candidate that downloads to
// a real image wins (magic-byte sniffed — a captive portal's HTML page
// served with 200 must never become "album art"). Outcomes:
//   found    — got an image.
//   notfound — every service ANSWERED and offered nothing usable (no
//              candidates, 4xx on the image, or non-image payloads).
//   error    — a SEARCH failed (null sentinel from the lib: DNS, timeout,
//              5xx, rate limit) or a download hit a 5xx/timeout/socket
//              error — transient, retry on the short cooldown.
async function findArtForAlbum(artist, album) {
  let transientError = false;
  for (const svc of cfg.services) {
    const search = SERVICE_SEARCHERS[svc];
    if (!search) { continue; }
    const candidates = await search(artist || '', album);
    if (candidates == null) { transientError = true; continue; }
    for (const c of candidates) {
      if (!c.url) { continue; }
      try {
        const buf = await httpGet(c.url);
        if (buf.length >= 1000 && buf.length <= 10 * 1024 * 1024 && sniffImage(buf)) {
          return { buf, outcome: 'found', service: svc };
        }
        // Wrong size (tracking pixel / oversized) or not actually an
        // image — skip this candidate.
      } catch (e) {
        if (!/^HTTP 4\d\d/.test(e.message || '')) { transientError = true; }
      }
    }
  }
  return { buf: null, outcome: transientError ? 'error' : 'notfound' };
}

// ── Prepared statements ──────────────────────────────────────────────────────

const recordLookup = db.prepare(`
  INSERT INTO album_art_lookups (album_id, last_attempt_at, outcome, attempts, fetched_hash)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(album_id) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = album_art_lookups.attempts + 1,
    fetched_hash    = COALESCE(excluded.fetched_hash, album_art_lookups.fetched_hash)
`);
// V50 dedupe probes.
const albumHasHash = db.prepare(`
  SELECT 1 FROM album_art aa
    JOIN art_files af ON af.id = aa.art_id
   WHERE aa.album_id = ? AND af.content_hash = ? LIMIT 1`);
const findCachedByHash = db.prepare(
  "SELECT id, cache_file FROM art_files WHERE kind = 'cached' AND content_hash = ? LIMIT 1");
const insertCachedArt = db.prepare(
  "INSERT OR IGNORE INTO art_files (kind, cache_file, content_hash, byte_size) VALUES ('cached', ?, ?, ?)");
const findCachedByFile = db.prepare(
  "SELECT id FROM art_files WHERE kind = 'cached' AND cache_file = ?");
const linkAlbumArt = db.prepare(`
  INSERT OR IGNORE INTO album_art (album_id, art_id, source, picture_type, position)
  VALUES (?, ?, ?, NULL,
    (SELECT COALESCE(MAX(position), -1) + 1 FROM album_art WHERE album_id = ?))`);
const linkTrackArt = db.prepare(`
  INSERT OR IGNORE INTO track_art (track_id, art_id, source, picture_type, position)
  VALUES (?, ?, ?, NULL,
    (SELECT COALESCE(MAX(position), -1) + 1 FROM track_art WHERE track_id = ?))`);
const setAlbumDefault = db.prepare(
  'UPDATE albums SET album_art_file = ?, album_art_source = ? WHERE id = ? AND album_art_file IS NULL');
const artlessTracks = db.prepare(
  'SELECT id FROM tracks WHERE album_id = ? AND album_art_file IS NULL');
const setTrackDefault = db.prepare(
  'UPDATE tracks SET album_art_file = ?, album_art_source = ? WHERE id = ? AND album_art_file IS NULL');
// Distinct on-disk directories holding this album's tracks (cover.jpg writes).
const albumDirsStmt = db.prepare(`
  SELECT DISTINCT t.filepath AS filepath, l.root_path AS root
    FROM tracks t
    JOIN libraries l ON l.id = t.library_id
   WHERE t.album_id = ?
`);

// Resolve the fetched image to an art_files row: an existing cached row
// with this hash is REUSED (no new row — the dedupe); otherwise the image
// is cached + inserted. Returns { artId, filename }.
//
// The reuse branch RE-MATERIALIZES the file when it is gone from disk
// (operator cleared the image-cache dir): we are holding the exact bytes
// the row describes, and linking a row whose image 404s — while the next
// routine pass would dedupe against it forever — is the one outcome
// worse than a duplicate file.
async function resolveArtRow(buf, hash) {
  const existing = findCachedByHash.get(hash);
  if (existing) {
    const p = path.join(cfg.albumArtDirectory, existing.cache_file);
    if (!fs.existsSync(p)) {
      await fs.promises.writeFile(p, buf);
      if (cfg.compressImage) { await generateThumbnails(buf, cfg.albumArtDirectory, existing.cache_file); }
    }
    return { artId: existing.id, filename: existing.cache_file };
  }
  const { filename } = await saveImageToCache(buf, cfg.albumArtDirectory, cfg.compressImage);
  insertCachedArt.run(filename, hash, buf.length);
  const id = findCachedByFile.get(filename)?.id;
  return { artId: id, filename };
}

// Persist a successful find. One transaction so a concurrent reader never
// sees the album updated but its tracks not (or vice versa). The
// fill-NULL guards are re-checked LIVE inside the txn — a cover the user
// set (or another writer elected) between selection and commit wins.
// Returns whether the album's DEFAULT changed (vs. gallery-only), which
// gates the cover.jpg folder write: planting cover.jpg next to an album's
// settled art would re-elect it as the unpinned default on the next
// re-parse (cover.jpg ranks high in FOLDER_PRIORITY).
function commitFound(albumId, artId, filename, service, hash, attemptSec) {
  db.exec('BEGIN IMMEDIATE');
  try {
    linkAlbumArt.run(albumId, artId, service, albumId);
    // Default-stamping only ever fills NULLs: in 'all' mode an album with
    // an existing cover gets the gallery link above and nothing else.
    const changedAlbum = setAlbumDefault.run(filename, service, albumId).changes > 0;
    if (changedAlbum) {
      for (const t of artlessTracks.all(albumId)) {
        if (setTrackDefault.run(filename, service, t.id).changes > 0) {
          // Keep the V48 invariant: a track's default is a member of its
          // art set.
          linkTrackArt.run(t.id, artId, service, t.id);
        }
      }
    }
    recordLookup.run(albumId, attemptSec, 'found', hash);
    db.exec('COMMIT');
    return changedAlbum;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

// Write the fetched cover into every folder holding one of the album's
// tracks. Best-effort and outside the DB transaction: a read-only library
// directory is skipped, not fatal — the cached + DB art is in place
// regardless. saveCoverJpg never overwrites an existing cover.jpg.
async function writeFolderArt(albumId, imgBuf) {
  const dirs = new Set();
  for (const r of albumDirsStmt.all(albumId)) {
    if (r.root && r.filepath) { dirs.add(path.dirname(path.join(r.root, r.filepath))); }
  }
  for (const dir of dirs) {
    try { await saveCoverJpg(dir, imgBuf); }
    catch (_e) { /* best-effort — e.g. a read-only library directory */ }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const nowSec = Math.floor(Date.now() / 1000);
  const albums = selectEligibleAlbums(nowSec);

  if (albums.length === 0) {
    emit({ event: 'albumArtComplete', attempted: 0, updated: 0, deduped: 0, notFound: 0, errors: 0, hitCap: false });
    return;
  }

  const crypto = await import('node:crypto');
  const startMs = Date.now();
  let attempted = 0;
  let updated = 0;
  let deduped = 0;
  let notFound = 0;
  let errors = 0;
  let persisted = 0;   // lookup rows actually written — hitCap depends on it
  let hitBudget = false;

  for (let i = 0; i < albums.length; i++) {
    // Wall-clock budget: yield the serial task slot rather than holding it
    // for hours against a blackholed network (every un-attempted album
    // stays eligible; the hitCap re-enqueue resumes them next pass, with
    // queued scans/backups interleaving between passes).
    if (Date.now() - startMs > cfg.runBudgetSec * 1000) {
      hitBudget = true;
      break;
    }
    // Throttle before every lookup except the first.
    if (i > 0 && cfg.interRequestMs > 0) { await sleep(cfg.interRequestMs); }

    const { album_id: albumId, album_name: albumName, artist_name: artistName,
      current_default: currentDefault } = albums[i];
    attempted++;

    // Per-album timestamp: at large autoAlbumArtPerRun a run spans hours,
    // and stamping run-start time would shave that much off cooldowns.
    const attemptSec = Math.floor(Date.now() / 1000);
    let outcome;
    let fetchedHash = null;
    let recorded = false; // commitFound records inside its transaction
    try {
      const result = await findArtForAlbum(artistName, albumName);
      outcome = result.outcome;
      if (outcome === 'found') {
        fetchedHash = crypto.createHash('md5').update(result.buf).digest('hex');
        checkSchemaGuard('before commit');
        // Dedupe ONLY when the album already has a default: an album whose
        // gallery carries this image but whose default is NULL must fall
        // through and get stamped (otherwise it stays artless and
        // re-fetches forever) — commitFound + resolveArtRow are idempotent
        // against the existing rows.
        if (currentDefault != null && albumHasHash.get(albumId, fetchedHash)) {
          deduped++;
        } else {
          const { artId, filename } = await resolveArtRow(result.buf, fetchedHash);
          if (artId == null) { throw new Error('failed to resolve art_files row'); }
          const becameDefault = commitFound(albumId, artId, filename, result.service, fetchedHash, attemptSec);
          recorded = true;
          persisted++;
          // Folder writes only when the fetch became the album's default —
          // gallery-only enrichment ('all' mode on settled albums) must not
          // plant a cover.jpg that the next re-parse would elect.
          if (cfg.writeToFolder && becameDefault) { await writeFolderArt(albumId, result.buf); }
          updated++;
        }
      }
    } catch (_e) {
      // Unexpected failure (image decode, disk write, DB write) — treat
      // as transient so it retries on the short cooldown.
      outcome = 'error';
    }

    if (outcome !== 'found') {
      if (outcome === 'error') { errors++; } else { notFound++; }
    }
    if (!recorded) {
      try { recordLookup.run(albumId, attemptSec, outcome, fetchedHash); persisted++; }
      catch (_e) { /* best-effort */ }
    }

    if (attempted % 25 === 0 && i + 1 < albums.length) {
      emit({ event: 'albumArtProgress', attempted, total: albums.length });
    }
  }

  emit({
    event: 'albumArtComplete',
    attempted,
    updated,
    deduped,
    notFound,
    errors,
    // More eligible work probably remains (full batch or budget cut). The
    // persisted>0 guard breaks the would-be infinite re-enqueue loop when
    // NOTHING could be recorded (e.g. every lookup write failed): a next
    // run would just re-select the same albums and fail the same way.
    hitCap: (albums.length === cfg.maxPerRun || hitBudget) && persisted > 0,
  });
}

run()
  .then(() => {
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(0);
  })
  .catch((err) => {
    emit({ event: 'error', message: err?.message || String(err) });
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(1);
  });
