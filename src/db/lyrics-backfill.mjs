// mStream lyrics backfill — child process forked by src/db/task-queue.js.
//
// The fourth enrichment pass (scan → waveforms → album-art → this). Fills
// lyrics for tracks that have none (no embedded tag, no sidecar) from the
// configured providers. Mirrors the album-art downloader's lifecycle: runs
// after the scan queue drains, bounded by maxPerRun + a wall-clock budget so
// it yields the serial task slot, re-enqueued by the task queue while it
// keeps hitting the per-run cap.
//
// Fetches from the configured providers (src/db/lyrics-lookup-lib.js) and, on
// a hit, writes tracks.lyrics_* + lyrics_source and a lyrics_cache 'hit' row
// in one transaction (optionally a sidecar .lrc). Misses / transient errors
// are recorded in lyrics_cache — the per-content cooldown ledger keyed on the
// canonical hash — so scheduled passes don't re-hammer the same dead ends.
//
// CLI input — single argv entry, JSON-encoded (built in task-queue.js):
//   { dbPath, providers, writeSidecar, maxPerRun, expectedSchemaVersion,
//     notFoundCooldownSec, errorCooldownSec, interRequestMs, runBudgetSec }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'lyricsProgress', attempted, total }
//   { event: 'lyricsComplete', attempted, updated, notFound, errors, hitCap }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 completed; 1 fatal (bad input, DB open failure);
// 3 schema-version guard.

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import Joi from 'joi';
import { LYRICS_PROVIDERS } from './lyrics-lookup-lib.js';

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
  // Providers to try, in order — first usable result wins. lrclib is the
  // clean default; netease/kugou are opt-in (off by default in config).
  providers: Joi.array()
    .items(Joi.string().valid('lrclib', 'netease', 'kugou'))
    .min(1).default(['lrclib']),
  writeSidecar: Joi.boolean().default(false),
  maxPerRun: Joi.number().integer().min(1).default(100),
  // Refuse to touch a DB whose PRAGMA user_version differs — same guard as
  // both scanners + the album-art worker.
  expectedSchemaVersion: Joi.number().integer().optional(),
  // Cooldowns before re-attempting a track. 'miss' gets the long one
  // (provider catalogues change slowly), 'error' the short one (transient).
  notFoundCooldownSec: Joi.number().integer().min(0).default(30 * 24 * 60 * 60),
  errorCooldownSec: Joi.number().integer().min(0).default(24 * 60 * 60),
  interRequestMs: Joi.number().integer().min(0).default(1100),
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

function emit(event) { console.log(JSON.stringify(event)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

// ── Eligibility ──────────────────────────────────────────────────────────────
//
// Lyric-less tracks (no embedded tag, no sidecar) with the artist + title a
// provider needs, off cooldown via lyrics_cache — keyed on the canonical hash
// COALESCE(audio_hash, file_hash); 'miss'/'error' rows get the long/short TTL,
// tracks with no row are always eligible. Reusing lyrics_cache as the cooldown
// ledger (vs a new table) also gives cross-duplicate dedup for free. Ordered
// + capped at maxPerRun.
function selectEligibleTracks() {
  const nowMs = Date.now();
  const notFoundCutoff = nowMs - cfg.notFoundCooldownSec * 1000;
  const errorCutoff = nowMs - cfg.errorCooldownSec * 1000;
  return db.prepare(`
    SELECT t.id AS track_id, t.title AS title, t.duration AS duration,
           COALESCE(t.audio_hash, t.file_hash) AS canon_hash,
           ar.name AS artist_name
      FROM tracks t
      LEFT JOIN artists ar     ON ar.id = t.artist_id
      LEFT JOIN lyrics_cache lc ON lc.audio_hash = COALESCE(t.audio_hash, t.file_hash)
     WHERE t.lyrics_embedded IS NULL AND t.lyrics_synced_lrc IS NULL
       AND t.title IS NOT NULL AND TRIM(t.title) != ''
       AND t.artist_id IS NOT NULL AND ar.name IS NOT NULL
       AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
       AND (
            lc.audio_hash IS NULL
         OR lc.fetched_at < (CASE WHEN lc.status = 'error' THEN ? ELSE ? END)
       )
     ORDER BY t.id
     LIMIT ?
  `).all(errorCutoff, notFoundCutoff, cfg.maxPerRun);
}

// ── Cooldown ledger (lyrics_cache) + track writes ────────────────────────────

const cacheUpsert = db.prepare(`
  INSERT INTO lyrics_cache (audio_hash, status, synced_lrc, plain, lang, source, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(audio_hash) DO UPDATE SET
    status = excluded.status, synced_lrc = excluded.synced_lrc, plain = excluded.plain,
    lang = excluded.lang, source = excluded.source, fetched_at = excluded.fetched_at
`);
function writeCacheRow(canonHash, status, synced = null, plain = null, lang = null, source = null) {
  if (!canonHash) { return; }
  cacheUpsert.run(canonHash, status, synced, plain, lang, source, Date.now());
}

// Cross-duplicate dedup: a track sharing an audio_hash with one already
// fetched (this run or a prior one) copies the cached lyrics, no re-fetch.
const cacheHitStmt = db.prepare(
  `SELECT synced_lrc, plain, lang, source FROM lyrics_cache WHERE audio_hash = ? AND status = 'hit'`);
function cacheHitFor(canonHash) { return canonHash ? cacheHitStmt.get(canonHash) : null; }

const updateTrackLyrics = db.prepare(`
  UPDATE tracks
     SET lyrics_synced_lrc = COALESCE(?, lyrics_synced_lrc),
         lyrics_embedded   = COALESCE(?, lyrics_embedded),
         lyrics_lang       = ?,
         lyrics_source     = ?
   WHERE id = ? AND lyrics_synced_lrc IS NULL AND lyrics_embedded IS NULL
`);

// Write the found lyrics onto the track + the cache 'hit' row in one txn.
// The IS NULL re-guard keeps it idempotent (a track that gained lyrics
// between selection and now is left alone). lyrics_source = the provider so
// the scanner clobber-guard (Phase 5) preserves it across rescans. The
// lyrics_* write fires the V53 tracks_au_fts trigger → fts_tracks.lyrics.
function commitFound(trackId, res, canonHash) {
  const syncedLrc = res.syncedLrc || null;
  const plain = syncedLrc ? null : (res.plain || null);
  const lang = res.lang ? String(res.lang).slice(0, 2) : null;
  db.exec('BEGIN IMMEDIATE');
  let changed;
  try {
    changed = updateTrackLyrics.run(syncedLrc, plain, lang, res.source, trackId).changes > 0;
    writeCacheRow(canonHash, 'hit', syncedLrc, plain, lang, res.source);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
  if (changed && cfg.writeSidecar) { writeSidecar(trackId, syncedLrc, plain); }
  return changed;
}

// Best-effort sidecar: drop a sibling .lrc (or .txt for plain-only) next to
// the audio file. Never clobbers an existing sidecar; silent on any fs error.
function writeSidecar(trackId, syncedLrc, plain) {
  try {
    const row = db.prepare(
      `SELECT t.filepath, l.root_path FROM tracks t JOIN libraries l ON l.id = t.library_id WHERE t.id = ?`).get(trackId);
    if (!row?.filepath || !row?.root_path) { return; }
    const absolute = path.resolve(row.root_path, row.filepath);
    if (!fs.existsSync(absolute)) { return; }
    const parsed = path.parse(absolute);
    const lrcPath = path.join(parsed.dir, `${parsed.name}.lrc`);
    const txtPath = path.join(parsed.dir, `${parsed.name}.txt`);
    if (fs.existsSync(lrcPath) || fs.existsSync(txtPath)) { return; } // curation wins
    const payload = syncedLrc || plain;
    if (!payload) { return; }
    fs.writeFileSync(syncedLrc ? lrcPath : txtPath, payload, 'utf8');
  } catch (_e) { /* read-only FS, moved/renamed file, etc. — non-fatal */ }
}

// ── Provider dispatch ────────────────────────────────────────────────────────
// First usable result across cfg.providers wins. 'error' only when every
// attempted provider was transient and none returned text.
async function findLyricsForTrack(artist, title, durationSec) {
  let transient = false;
  for (const name of cfg.providers) {
    const provider = LYRICS_PROVIDERS[name];
    if (!provider) { continue; }
    try {
      const r = await provider(artist, title, durationSec || 0);
      if (r && (r.syncedLrc || r.plain)) { return { ...r, outcome: 'found' }; }
    } catch (err) {
      // Transient (timeout / 5xx / parse / gated provider). Don't abort the
      // dispatch — fall through to the next provider. Surface the cause
      // (catch-must-log) on stderr → the parent forwards it to winston.warn.
      transient = true;
      console.error(`Warning: lyrics provider '${name}' failed for `
        + `${artist} - ${title}: ${err?.message || err}`);
    }
  }
  return { outcome: transient ? 'error' : 'notfound' };
}

async function run() {
  checkSchemaGuard('at start');
  const tracks = selectEligibleTracks();
  if (tracks.length === 0) {
    emit({ event: 'lyricsComplete', attempted: 0, updated: 0, notFound: 0, errors: 0, hitCap: false });
    return;
  }

  const startMs = Date.now();
  let attempted = 0, updated = 0, notFound = 0, errors = 0;
  let persisted = 0;      // rows written — hitCap depends on it
  let hitBudget = false;
  let didNetwork = false;

  for (let i = 0; i < tracks.length; i++) {
    // Yield the serial slot rather than hold it for hours against a slow
    // network — un-attempted tracks stay eligible, the hitCap re-enqueue
    // resumes them, and queued scans interleave between passes.
    if (Date.now() - startMs > cfg.runBudgetSec * 1000) { hitBudget = true; break; }

    const t = tracks[i];
    attempted++;

    // True once we know a valid 'hit' cache row already exists for this hash
    // (the cross-dup copy path). Guards the catch below from clobbering it.
    let hadCachedHit = false;
    try {
      // Cross-duplicate dedup first — copy a prior hit for this hash, no network.
      const cached = cacheHitFor(t.canon_hash);
      if (cached) {
        hadCachedHit = true;
        if (commitFound(t.track_id, { syncedLrc: cached.synced_lrc, plain: cached.plain, lang: cached.lang, source: cached.source }, t.canon_hash)) { updated++; }
        persisted++;
        continue;
      }

      if (didNetwork && cfg.interRequestMs > 0) { await sleep(cfg.interRequestMs); }
      didNetwork = true;
      const result = await findLyricsForTrack(t.artist_name, t.title, t.duration);
      if (result.outcome === 'found') {
        if (commitFound(t.track_id, result, t.canon_hash)) { updated++; }
        persisted++;
      } else if (result.outcome === 'error') {
        // Count AFTER the write lands — if writeCacheRow throws, control falls
        // to the catch which owns the single errors++ (no double-count).
        writeCacheRow(t.canon_hash, 'error'); errors++; persisted++;
      } else {
        writeCacheRow(t.canon_hash, 'miss'); notFound++; persisted++;
      }
    } catch (err) {
      // A DB write failed (e.g. SQLITE_BUSY surviving the busy_timeout under
      // scan contention). Mirror the album-art worker: degrade to a per-track
      // error and keep going rather than aborting the whole pass. commitFound
      // already rolled back its own txn.
      errors++;
      console.error(`Warning: lyrics backfill failed to persist track `
        + `${t.track_id} (${t.artist_name} - ${t.title}): ${err?.message || err}`);
      // Best-effort 'error' cooldown row so a hard-failing track doesn't spin
      // every pass — but ONLY when no pre-existing 'hit' exists for this hash.
      // In the cross-dup copy path a valid 'hit' is already cached; writing
      // 'error' would clobber it and break serving for every duplicate-hash
      // twin, so leave it intact and let a later pass retry the copy.
      if (!hadCachedHit) {
        try { writeCacheRow(t.canon_hash, 'error'); persisted++; } catch (_) { /* DB unavailable */ }
      }
    }

    if (attempted % 25 === 0 && i + 1 < tracks.length) {
      emit({ event: 'lyricsProgress', attempted, total: tracks.length });
    }
  }

  emit({
    event: 'lyricsComplete',
    attempted, updated, notFound, errors,
    // More work probably remains (full batch or budget cut). persisted>0
    // breaks the would-be infinite re-enqueue when nothing could be written.
    hitCap: (tracks.length === cfg.maxPerRun || hitBudget) && persisted > 0,
  });
}

run()
  .then(() => { try { db.close(); } catch (_) { /* best-effort */ } process.exit(0); })
  .catch((err) => {
    emit({ event: 'error', message: err?.message || String(err) });
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(1);
  });
