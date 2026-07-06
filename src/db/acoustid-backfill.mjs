// mStream AcoustID identifier — child process forked by src/db/task-queue.js.
//
// External-ID Phase 2, step two: derive MusicBrainz recording MBIDs for
// tracks whose tags don't carry one. Identity chain per track:
//   rust-parser --fingerprint (chromaprint TEST2, first 120s)
//     → POST api.acoustid.org/v2/lookup (rate-limited, app API key)
//     → recording MBID + AcoustID cluster id
//     → tracks.mbz_recording_id / acoustid_id (mbz_id_source='acoustid',
//       fill-NULL only — tag-sourced ids are never overwritten), fanned out
//       to every copy sharing the canonical hash
//     → discovery.db identity upgrade (export_id anon:→mbid:, rowversion
//       bump) so the network sees portable ids; the post-drain auto-publish
//       re-announces the snapshot.
//
// Mirrors audio-analysis-backfill.mjs's operational contract: serial task
// slot, maxPerRun + wall-clock budget, per-outcome cooldowns in
// acoustid_lookups (V56), hitCap re-enqueue. Network-bound: every attempt
// costs an API request, so the 3-req/s throttle (350ms) is the pacing guard.
//
// Cooldown design (matches the discovery worker): SUCCESS needs no ledger
// row — a matched track has mbz_recording_id set and drops out of the
// eligible set. acoustid_lookups records FAILURES only:
//   'nomatch'     not in AcoustID (long cooldown — coverage grows slowly)
//   'lowconf'     matched below the score floor / ambiguous (long)
//   'undecodable' fingerprinter returned null (opus, corrupt) (long)
//   'error'       transient (network, API hiccup) (short)
//
// CLI input — single argv entry, JSON-encoded (built in task-queue.js):
//   { dbPath, discoveryDbPath?, rustParserPath, apiKey, apiUrl?, maxPerRun,
//     expectedSchemaVersion, minDurationSec, maxDurationSec, minScore,
//     nomatchCooldownSec, errorCooldownSec, runBudgetSec, throttleMs }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'acoustidProgress', attempted, total }
//   { event: 'acoustidComplete', attempted, matched, nomatch, lowconf, undecodable, errors, hitCap }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 completed (per-track failures recorded, not fatal);
// 1 fatal (bad input, DB open failure, rust-parser predates --fingerprint);
// 3 library schema-version guard.

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Joi from 'joi';
import { DatabaseSync } from './sqlite-driver.js';
import { initDiscoveryDb, updateDiscoveryIdentity } from './discovery-db.js';

const run_ = promisify(execFile);
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
  // Optional: present when discovery collection has a DB — matched ids are
  // propagated so export_id upgrades from anon: to mbid:.
  discoveryDbPath: Joi.string().optional(),
  // Resolved rust-parser binary (the main process owns binary resolution).
  rustParserPath: Joi.string().required(),
  apiKey: Joi.string().required(),
  apiUrl: Joi.string().uri().default('https://api.acoustid.org/v2/lookup'),
  maxPerRun: Joi.number().integer().min(1).default(200),
  expectedSchemaVersion: Joi.number().integer().optional(),
  // Fingerprint window: very short files fingerprint poorly; very long ones
  // (DJ sets, audiobooks) aren't a single recording.
  minDurationSec: Joi.number().min(0).default(10),
  maxDurationSec: Joi.number().min(1).default(2 * 60 * 60),
  // Accept only confident matches — the live spike scored real music at
  // 98%+, so 0.9 leaves comfortable margin while rejecting fuzzy hits.
  minScore: Joi.number().min(0).max(1).default(0.9),
  // 'nomatch'/'lowconf'/'undecodable' share the long cooldown (AcoustID
  // coverage grows slowly; the audio never changes); 'error' retries soon.
  nomatchCooldownSec: Joi.number().integer().min(0).default(30 * 24 * 60 * 60),
  errorCooldownSec: Joi.number().integer().min(0).default(24 * 60 * 60),
  runBudgetSec: Joi.number().integer().min(1).default(300),
  // AcoustID allows 3 req/s per application — 350ms spacing keeps us under.
  throttleMs: Joi.number().integer().min(0).default(350),
});

const { error: validationError, value: cfg } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

// ── Open SQLite databases ────────────────────────────────────────────────────

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

// Discovery DB is optional — identity propagation is best-effort and the
// feature works without collection enabled.
let discoveryOpen = false;
if (cfg.discoveryDbPath) {
  try {
    initDiscoveryDb(cfg.discoveryDbPath);
    discoveryOpen = true;
  } catch (err) {
    console.error(`Warning: discovery DB unavailable, skipping propagation: ${err?.message || err}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pruneOrphans() {
  try {
    db.prepare(`
      DELETE FROM acoustid_lookups
       WHERE audio_hash NOT IN (
         SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL
         UNION
         SELECT file_hash  FROM tracks WHERE file_hash  IS NOT NULL
       )
    `).run();
  } catch (_e) { /* best-effort housekeeping */ }
}

// Tracks needing identification: no recording MBID (from tags OR a previous
// pass), inside the duration window, off cooldown. One representative row
// per canonical hash; the match fans out to every copy.
function selectEligibleTracks(nowSec) {
  const longCutoff = nowSec - cfg.nomatchCooldownSec;
  const errorCutoff = nowSec - cfg.errorCooldownSec;
  return db.prepare(`
    SELECT MIN(t.id) AS track_id,
           COALESCE(t.audio_hash, t.file_hash) AS canon_hash,
           t.filepath AS filepath,
           t.duration AS duration,
           lib.root_path AS root
      FROM tracks t
      JOIN libraries lib ON lib.id = t.library_id
      LEFT JOIN acoustid_lookups la
             ON la.audio_hash = COALESCE(t.audio_hash, t.file_hash)
     WHERE t.mbz_recording_id IS NULL
       AND t.duration IS NOT NULL
       AND t.duration >= ? AND t.duration <= ?
       AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
       AND (
            la.audio_hash IS NULL
         OR la.last_attempt_at < (CASE WHEN la.outcome = 'error' THEN ? ELSE ? END)
       )
     GROUP BY COALESCE(t.audio_hash, t.file_hash)
     ORDER BY track_id
     LIMIT ?
  `).all(cfg.minDurationSec, cfg.maxDurationSec, errorCutoff, longCutoff, cfg.maxPerRun);
}

const recordLookup = db.prepare(`
  INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome, attempts)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(audio_hash) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = acoustid_lookups.attempts + 1
`);

// Fill NULLs only, across every copy sharing the canonical hash — a
// tag-sourced id (and its 'tag' provenance) is never overwritten.
const fillIdentity = db.prepare(`
  UPDATE tracks
     SET mbz_recording_id = COALESCE(mbz_recording_id, ?),
         acoustid_id      = COALESCE(acoustid_id, ?),
         mbz_id_source    = CASE WHEN mbz_id_source IS NULL THEN 'acoustid' ELSE mbz_id_source END
   WHERE COALESCE(audio_hash, file_hash) = ?
     AND mbz_recording_id IS NULL
`);

// ── Fingerprint + lookup ─────────────────────────────────────────────────────

async function fingerprintFile(absPath) {
  const { stdout } = await run_(cfg.rustParserPath, ['--fingerprint', absPath],
    { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

let lastRequestMs = 0;
async function throttledLookup(fingerprint, durationSec) {
  const wait = lastRequestMs + cfg.throttleMs - Date.now();
  if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
  lastRequestMs = Date.now();

  const body = new URLSearchParams({
    client: cfg.apiKey,
    format: 'json',
    duration: String(Math.round(durationSec)),
    // sources ranks a result's recordings by how many submissions back them
    // — the disambiguator when one fingerprint maps to several recordings.
    meta: 'recordings sources',
    fingerprint,
  });
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) { throw new Error(`AcoustID HTTP ${res.status}`); }
  return res.json();
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Distill a lookup response into an outcome. Exported shape:
//   { outcome: 'matched', recordingMbid, acoustidId } | { outcome: 'nomatch'|'lowconf' }
function judge(json) {
  if (!Array.isArray(json.results) || json.results.length === 0) {
    return { outcome: 'nomatch' };
  }
  const best = [...json.results].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if ((best.score || 0) < cfg.minScore) { return { outcome: 'lowconf' }; }
  const recordings = (best.recordings || []).filter((r) => MBID_RE.test(r.id || ''));
  if (recordings.length === 0) { return { outcome: 'nomatch' }; }
  // Most-backed recording wins (sources counts submissions per recording).
  recordings.sort((a, b) => (b.sources || 0) - (a.sources || 0));
  return { outcome: 'matched', recordingMbid: recordings[0].id, acoustidId: best.id || null };
}

function commitMatched(canonHash, recordingMbid, acoustidId) {
  // The library write is the source of truth; discovery propagation is a
  // separate best-effort step (its own DB, its own transaction semantics).
  db.exec('BEGIN IMMEDIATE');
  try {
    fillIdentity.run(recordingMbid, acoustidId, canonHash);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
  if (discoveryOpen) {
    try {
      updateDiscoveryIdentity(canonHash, recordingMbid, acoustidId);
    } catch (err) {
      console.error(`Warning: discovery identity propagation failed: ${err?.message || err}`);
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  // Capability probe: an old rust-parser treats --fingerprint as a scan
  // config path and errors/garbage — without this guard every track would be
  // cooldown-poisoned as 'undecodable'. Fatal: task-queue logs it once.
  try {
    const probe = await fingerprintFile('__mstream_fingerprint_probe__');
    if (!probe || !('fingerprint' in probe)) { throw new Error('bad probe output'); }
  } catch (_e) {
    emit({ event: 'error', message: 'rust-parser binary predates --fingerprint — update bin/rust-parser or rebuild' });
    process.exit(1);
  }

  pruneOrphans();

  const nowSec = Math.floor(Date.now() / 1000);
  const tracks = selectEligibleTracks(nowSec);

  if (tracks.length === 0) {
    emit({ event: 'acoustidComplete', attempted: 0, matched: 0, nomatch: 0, lowconf: 0, undecodable: 0, errors: 0, hitCap: false });
    return;
  }

  const startMs = Date.now();
  let attempted = 0;
  let matched = 0;
  let nomatch = 0;
  let lowconf = 0;
  let undecodable = 0;
  let errors = 0;
  let consecutiveApiErrors = 0;
  let persisted = 0;
  let hitBudget = false;

  for (let i = 0; i < tracks.length; i++) {
    if (Date.now() - startMs > cfg.runBudgetSec * 1000) { hitBudget = true; break; }
    // A dead API (bad key, outage) fails every request — stop burning the
    // budget; everything unattempted stays eligible for the next pass.
    if (consecutiveApiErrors >= 3) { hitBudget = true; break; }

    const t = tracks[i];
    attempted++;
    const attemptSec = Math.floor(Date.now() / 1000);
    let outcome; // null = matched (no ledger row); otherwise the failure kind

    try {
      const fp = await fingerprintFile(path.join(t.root, t.filepath));
      if (!fp.fingerprint) {
        outcome = 'undecodable';
        undecodable++;
      } else {
        const json = await throttledLookup(fp.fingerprint, t.duration);
        if (json.status !== 'ok') { throw new Error(`AcoustID status ${json.status}: ${json.error?.message || '?'}`); }
        consecutiveApiErrors = 0;
        const verdict = judge(json);
        if (verdict.outcome === 'matched') {
          checkSchemaGuard('before commit');
          commitMatched(t.canon_hash, verdict.recordingMbid, verdict.acoustidId);
          matched++;
          persisted++;
          outcome = null; // success — no ledger row
        } else {
          outcome = verdict.outcome;
          if (outcome === 'nomatch') { nomatch++; } else { lowconf++; }
        }
      }
    } catch (err) {
      outcome = 'error';
      errors++;
      consecutiveApiErrors++;
      console.error(`Warning: acoustid lookup failed for ${t.filepath}: ${err?.message || err}`);
    }

    if (outcome) {
      try { recordLookup.run(t.canon_hash, attemptSec, outcome); persisted++; }
      catch (_e) { /* best-effort */ }
    }

    if (attempted % 10 === 0 && i + 1 < tracks.length) {
      emit({ event: 'acoustidProgress', attempted, total: tracks.length });
    }
  }

  emit({
    event: 'acoustidComplete',
    attempted,
    matched,
    nomatch,
    lowconf,
    undecodable,
    errors,
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
