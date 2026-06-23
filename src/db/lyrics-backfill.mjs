// mStream lyrics backfill — child process forked by src/db/task-queue.js.
//
// The fourth enrichment pass (scan → waveforms → album-art → this). Fills
// lyrics for tracks that have none (no embedded tag, no sidecar) from the
// configured providers. Mirrors the album-art downloader's lifecycle: runs
// after the scan queue drains, bounded by maxPerRun + a wall-clock budget so
// it yields the serial task slot, re-enqueued by the task queue while it
// keeps hitting the per-run cap.
//
// STATUS — SKELETON: the task-queue wiring is live (queue → fork → events →
// drain). This worker parses its payload, opens the DB, runs the REAL
// eligibility query, and emits the stdout protocol — but the per-track
// provider fetch lands in the next slice (the provider library doesn't exist
// yet), so today it is a safe no-op on DB state. The eligibility query +
// cooldown design below are final; only findLyricsForTrack + the write loop
// are stubbed.
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

import { DatabaseSync } from 'node:sqlite';
import Joi from 'joi';

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
       AND (
            lc.audio_hash IS NULL
         OR lc.fetched_at < (CASE WHEN lc.status = 'error' THEN ? ELSE ? END)
       )
     ORDER BY t.id
     LIMIT ?
  `).all(errorCutoff, notFoundCutoff, cfg.maxPerRun);
}

// ── Provider fetch + per-track write loop — NEXT SLICE ───────────────────────
// import { LYRICS_PROVIDERS } from './lyrics-lookup-lib.js'
// findLyricsForTrack(artist, title, duration): try cfg.providers in order →
//   { syncedLrc, plain, lang, source } | null (miss) | throw (transient).
// On hit: write tracks.lyrics_* + lyrics_source + a lyrics_cache 'hit' row in
// one BEGIN IMMEDIATE txn (+ optional sidecar); miss → 'miss', transient →
// 'error'. Throttle interRequestMs between fetches, honour runBudgetSec, emit
// lyricsProgress every 25, set hitCap when the cap/budget was hit and
// something was persisted.

async function run() {
  checkSchemaGuard('at start');
  const tracks = selectEligibleTracks();

  // Skeleton: the wiring is live but no provider is implemented yet, so there
  // is no per-track fetch to do. Report the eligible count (proves the
  // eligibility query + the queue → fork → events → drain path end to end)
  // and exit without touching the DB.
  console.log(`Lyrics backfill (skeleton): ${tracks.length} eligible track(s); `
    + `provider fetch lands in the next slice`);
  emit({ event: 'lyricsComplete', attempted: tracks.length, updated: 0,
    notFound: 0, errors: 0, hitCap: false });
}

run()
  .then(() => { try { db.close(); } catch (_) { /* best-effort */ } process.exit(0); })
  .catch((err) => {
    emit({ event: 'error', message: err?.message || String(err) });
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(1);
  });
