// mStream essentia BPM/key analyser — child process forked by
// src/db/task-queue.js.
//
// The analysis counterpart to album-art-backfill.mjs. The scanners only ever
// source BPM/key from embedded tags (bpm_source='tag'); this post-scan pass
// fills the gaps for tag-less files by decoding the audio (bundled ffmpeg →
// mono f32 PCM) and running essentia.js (RhythmExtractor2013 + KeyExtractor).
// The estimates land in tracks.bpm / musical_key (V32), which feed the Auto-DJ
// BPM-continuity / harmonic-mixing waterfall in src/api/random.js.
//
// Mirrors the album-art downloader's operational contract exactly: holds the
// serial task slot, processes at most maxPerRun tracks (and stops early at a
// wall-clock budget), records every attempt in audio_analysis_lookups (V54)
// with per-outcome cooldowns so undecodable / low-confidence files aren't
// re-decoded every scan, and reports hitCap so task-queue re-enqueues while a
// backlog remains. CPU-bound rather than network-bound, so the budget is the
// primary guard (a single decode+analysis can run for seconds).
//
// Work discovery is DB-driven + idempotent: any track with NULL bpm OR NULL
// musical_key, inside the duration window, not an excluded genre, off
// cooldown. De-duplicated by canonical hash COALESCE(audio_hash, file_hash) so
// byte-identical copies are analysed once and the result fans out to every
// copy.
//
// LICENSE NOTE: pulls in essentia.js (AGPL-3.0) via audio-analysis-lib.js — a
// deliberate project-owner decision (mStream is GPL-3.0). Gated by
// scanOptions.analyzeBpm; when off this worker is never forked.
//
// CLI input — single argv entry, JSON-encoded (built in task-queue.js):
//   { dbPath, ffmpegPath, maxPerRun, expectedSchemaVersion,
//     minDurationSec, maxDurationSec, maxAnalyzeSeconds,
//     minBpmConfidence, minKeyStrength,
//     analyzedCooldownSec, lowconfCooldownSec, errorCooldownSec,
//     runBudgetSec, skipGenres }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'audioAnalysisProgress', attempted, total }
//   { event: 'audioAnalysisComplete', attempted, analyzed, lowconf, errors, hitCap }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 completed (per-track failures recorded, not fatal);
// 1 fatal (bad input, DB open failure, ffmpeg missing); 3 schema-version guard.

import path from 'node:path';
import { DatabaseSync } from './sqlite-driver.js';
import Joi from 'joi';
import { decodePcmF32, analyzeSignal, getEssentia } from './audio-analysis-lib.js';

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
  // Resolved ffmpeg binary path (the main process owns ffmpeg-bootstrap; a
  // forked worker has no config to re-resolve it from).
  ffmpegPath: Joi.string().required(),
  maxPerRun: Joi.number().integer().min(1).default(200),
  // Same schema-version guard as the scanners + the art downloader.
  expectedSchemaVersion: Joi.number().integer().optional(),
  // Only analyse tracks in this duration window (seconds). Below: jingles /
  // SFX with no meaningful tempo. Above: DJ sets / audiobooks where one BPM/key
  // is meaningless and the decode is enormous.
  minDurationSec: Joi.number().min(0).default(30),
  maxDurationSec: Joi.number().min(1).default(30 * 60),
  // Hard cap on the decoded span fed to essentia (memory/time guard) — BPM/key
  // are stable enough across a track that the head is representative.
  maxAnalyzeSeconds: Joi.number().integer().min(10).default(600),
  // Confidence floors. RhythmExtractor2013 confidence is ~0–5.32; KeyExtractor
  // strength is 0–1. Below the floor the estimate is recorded as 'lowconf'
  // (long cooldown) instead of being written.
  minBpmConfidence: Joi.number().min(0).default(1.0),
  minKeyStrength: Joi.number().min(0).default(0.5),
  // Cooldowns before re-attempting a track. 'analyzed'/'lowconf' get the long
  // one (audio doesn't change without a rescan, which re-keys the cache);
  // 'error' the short one (a transient decode failure retries soon).
  analyzedCooldownSec: Joi.number().integer().min(0).default(90 * 24 * 60 * 60),
  lowconfCooldownSec: Joi.number().integer().min(0).default(90 * 24 * 60 * 60),
  errorCooldownSec: Joi.number().integer().min(0).default(24 * 60 * 60),
  // Wall-clock budget per run — the primary guard for this CPU-bound pass.
  // Hitting it ends early with hitCap so task-queue re-enqueues and any queued
  // scan/backup interleaves between passes.
  runBudgetSec: Joi.number().integer().min(1).default(300),
  // Genres (case-insensitive) whose tracks are skipped — spoken-word content
  // has no useful tempo/key.
  skipGenres: Joi.array().items(Joi.string()).default(['audiobook', 'audio book', 'podcast', 'speech']),
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

// ── Helpers ──────────────────────────────────────────────────────────────────

// Prune cache rows whose canonical hash no longer matches any track (deleted
// files). Cheap NOT IN over indexed columns; mirrors lyrics-lrclib's sweep.
function pruneOrphans() {
  try {
    db.prepare(`
      DELETE FROM audio_analysis_lookups
       WHERE audio_hash NOT IN (
         SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL
         UNION
         SELECT file_hash  FROM tracks WHERE file_hash  IS NOT NULL
       )
    `).run();
  } catch (_e) { /* best-effort housekeeping */ }
}

// Tracks needing analysis: NULL bpm OR NULL key, in the duration window, not an
// excluded genre, off cooldown. One representative row per canonical hash
// (MIN(id) — SQLite takes the other bare columns from that same row), so
// duplicate files are decoded once. 'error' rows come off cooldown sooner.
function selectEligibleTracks(nowSec) {
  const longCutoff = nowSec - Math.max(cfg.analyzedCooldownSec, cfg.lowconfCooldownSec);
  const errorCutoff = nowSec - cfg.errorCooldownSec;
  // Build the genre-exclusion IN list (lower-cased) from skipGenres.
  const genres = cfg.skipGenres.map((g) => g.toLowerCase());
  const genrePlaceholders = genres.length ? genres.map(() => '?').join(',') : null;
  const genreClause = genrePlaceholders
    ? `AND NOT EXISTS (
         SELECT 1 FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
          WHERE tg.track_id = t.id AND LOWER(g.name) IN (${genrePlaceholders})
       )`
    : '';
  const sql = `
    SELECT MIN(t.id) AS track_id,
           COALESCE(t.audio_hash, t.file_hash) AS canon_hash,
           t.filepath AS filepath,
           lib.root_path AS root
      FROM tracks t
      JOIN libraries lib ON lib.id = t.library_id
      LEFT JOIN audio_analysis_lookups la
             ON la.audio_hash = COALESCE(t.audio_hash, t.file_hash)
     WHERE (t.bpm IS NULL OR t.musical_key IS NULL)
       AND t.duration IS NOT NULL
       AND t.duration >= ? AND t.duration <= ?
       AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
       ${genreClause}
       AND (
            la.audio_hash IS NULL
         OR la.last_attempt_at < (CASE WHEN la.outcome = 'error' THEN ? ELSE ? END)
       )
     GROUP BY COALESCE(t.audio_hash, t.file_hash)
     ORDER BY track_id
     LIMIT ?
  `;
  const params = [cfg.minDurationSec, cfg.maxDurationSec, ...genres, errorCutoff, longCutoff, cfg.maxPerRun];
  return db.prepare(sql).all(...params);
}

// ── Prepared statements ──────────────────────────────────────────────────────

const recordLookup = db.prepare(`
  INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome, attempts)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(audio_hash) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = audio_analysis_lookups.attempts + 1
`);

// Fill NULLs only — never clobber a tag-sourced bpm/key — across every copy
// sharing the canonical hash. bpm_source becomes 'essentia' only when it was
// NULL (a tag-sourced row keeps its 'tag' provenance even if we add the key).
const fillAnalysis = db.prepare(`
  UPDATE tracks
     SET bpm         = COALESCE(bpm, ?),
         musical_key = COALESCE(musical_key, ?),
         bpm_source  = CASE WHEN bpm_source IS NULL THEN 'essentia' ELSE bpm_source END
   WHERE COALESCE(audio_hash, file_hash) = ?
     AND (bpm IS NULL OR musical_key IS NULL)
`);

// Persist an 'analyzed' result + its lookup row atomically, so a concurrent
// reader never sees the lookup recorded but the track not updated (or vice
// versa).
function commitAnalyzed(canonHash, bpm, musicalKey, attemptSec) {
  db.exec('BEGIN IMMEDIATE');
  try {
    fillAnalysis.run(bpm, musicalKey, canonHash);
    recordLookup.run(canonHash, attemptSec, 'analyzed');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  pruneOrphans();

  const nowSec = Math.floor(Date.now() / 1000);
  const tracks = selectEligibleTracks(nowSec);

  if (tracks.length === 0) {
    emit({ event: 'audioAnalysisComplete', attempted: 0, analyzed: 0, lowconf: 0, errors: 0, hitCap: false });
    return;
  }

  // Instantiate essentia once (loads the WASM backend) — fatal if it can't.
  const essentia = await getEssentia();

  const startMs = Date.now();
  let attempted = 0;
  let analyzed = 0;
  let lowconf = 0;
  let errors = 0;
  let persisted = 0;     // lookup rows actually written — hitCap depends on it
  let hitBudget = false;

  for (let i = 0; i < tracks.length; i++) {
    // Wall-clock budget: the primary guard for this CPU-bound pass. Un-attempted
    // tracks stay eligible; the hitCap re-enqueue resumes them next pass.
    if (Date.now() - startMs > cfg.runBudgetSec * 1000) { hitBudget = true; break; }

    const { canon_hash: canonHash, filepath, root } = tracks[i];
    attempted++;
    const attemptSec = Math.floor(Date.now() / 1000);
    let outcome = 'error';
    let recorded = false;

    try {
      const absPath = path.join(root, filepath);
      const signal = await decodePcmF32(absPath, cfg.ffmpegPath, { maxSeconds: cfg.maxAnalyzeSeconds });
      const r = analyzeSignal(signal, essentia);

      const bpmUsable = r.bpm != null && r.bpmConfidence >= cfg.minBpmConfidence;
      const keyUsable = r.musicalKey != null && r.keyStrength >= cfg.minKeyStrength;

      if (bpmUsable || keyUsable) {
        checkSchemaGuard('before commit');
        commitAnalyzed(canonHash, bpmUsable ? r.bpm : null, keyUsable ? r.musicalKey : null, attemptSec);
        recorded = true;
        persisted++;
        analyzed++;
      } else {
        outcome = 'lowconf';
        lowconf++;
      }
    } catch (_e) {
      // Decode/analysis failure (undecodable codec, timeout, disk). 'error' →
      // short cooldown so a transient blip retries soon.
      outcome = 'error';
      errors++;
    }

    if (!recorded) {
      try { recordLookup.run(canonHash, attemptSec, outcome); persisted++; }
      catch (_e) { /* best-effort */ }
    }

    if (attempted % 10 === 0 && i + 1 < tracks.length) {
      emit({ event: 'audioAnalysisProgress', attempted, total: tracks.length });
    }
  }

  emit({
    event: 'audioAnalysisComplete',
    attempted,
    analyzed,
    lowconf,
    errors,
    // More work probably remains (full batch or budget cut). persisted>0 breaks
    // the would-be infinite re-enqueue when NOTHING could be recorded.
    hitCap: (tracks.length === cfg.maxPerRun || hitBudget) && persisted > 0,
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
