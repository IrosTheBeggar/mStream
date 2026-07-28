// mStream discovery-embedding worker — child process forked by
// src/db/task-queue.js.
//
// The 5th post-scan enrichment pass (waveform → album-art → lyrics →
// audio-analysis → discovery). Populates the SEPARATE discovery.db
// (src/db/discovery-db.js) with one audio embedding per canonical track,
// plus the share-safe metadata snapshot (artist/title/duration, BPM/key when
// the library already knows them). The embedding model is pluggable — see
// the registry in discovery-features-lib.js; this worker re-embeds any row
// whose stored (model_id) doesn't match the active model, which is how a
// model swap migrates the dataset in place.
//
// Mirrors audio-analysis-backfill.mjs's operational contract: holds the
// serial task slot, processes at most maxPerRun tracks, stops early at a
// wall-clock budget, reports hitCap so task-queue re-enqueues while a
// backlog remains. CPU-bound (decode + ONNX inference, seconds per track) —
// the budget is the primary guard.
//
// Cooldown design differs from the essentia pass deliberately: SUCCESS needs
// no ledger row, because success is directly visible in discovery_tracks
// (embedding present + model_id matches). discovery_lookups records FAILURES
// only ('error', short cooldown). This is what makes model swaps work: a
// swap makes every old-model row eligible again immediately, with no stale
// success-cooldowns to clear.
//
// Work discovery is DB-driven + idempotent: the worker opens discovery.db
// and ATTACHes the library DB read-only-in-practice (SELECTs only), picking
// tracks whose canonical hash has no current-model embedding, minus
// error-cooldown, deduped by canonical hash (byte-identical copies embed
// once), skipping spoken-word genres and out-of-window durations.
//
// CLI input — single argv entry, JSON-encoded (built in task-queue.js):
//   { discoveryDbPath, libraryDbPath, ffmpegPath, model, modelCacheDir,
//     maxPerRun, expectedSchemaVersion, minDurationSec, maxDurationSec,
//     maxAnalyzeSeconds, errorCooldownSec, runBudgetSec, skipGenres }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'discoveryProgress', attempted, total }
//   { event: 'discoveryComplete', attempted, embedded, errors, hitCap }
//   { event: 'error', message }     ← always followed by exit 1
//
// Exit codes: 0 completed (per-track failures recorded, not fatal);
// 1 fatal (bad input, DB open failure, model runtime unavailable);
// 3 library schema-version guard.

import path from 'node:path';
import Joi from 'joi';
import winston from 'winston';
import {
  initDiscoveryDb, setMeta, upsertDiscoveryTrack,
} from './discovery-db.js';
import { createEmbedder, analyzeFile, EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL } from './discovery-features-lib.js';

const SCHEMA_GUARD_EXIT = 3;
// Exit contract with task-queue.js: the environment can't load
// onnxruntime-node at all (missing optional dep, or a musl system whose
// glibc compat layer can't load onnxruntime's glibc-only binaries) — the
// queue latches the pass off until restart instead of retrying an identical
// failure every batch.
const RUNTIME_UNAVAILABLE_EXIT = 4;

// discovery-db.js logs through winston; a forked child has no transports
// configured, and winston prints a noisy meta-warning per call in that
// state. Route warn+ to stderr (task-queue forwards it) and drop info.
winston.configure({
  transports: [new winston.transports.Console({ level: 'warn', stderrLevels: ['error', 'warn'] })],
});

// ── Parse + validate CLI input ───────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  discoveryDbPath: Joi.string().required(),
  libraryDbPath: Joi.string().required(),
  // Resolved ffmpeg binary path (the main process owns ffmpeg-bootstrap; a
  // forked worker has no config to re-resolve it from).
  ffmpegPath: Joi.string().required(),
  // Registry key from discovery-features-lib.js. The worker re-embeds any
  // row whose stored model_id differs from this.
  model: Joi.string().valid(...Object.keys(EMBEDDING_MODELS)).default(DEFAULT_EMBEDDING_MODEL),
  // Where model weights download/cache (kept out of node_modules).
  modelCacheDir: Joi.string().optional(),
  maxPerRun: Joi.number().integer().min(1).default(50),
  // Guard against the LIBRARY db being mid-migration under us (same contract
  // as the other enrichment workers). discovery.db needs no equivalent —
  // this worker's own initDiscoveryDb() is its migrator.
  expectedSchemaVersion: Joi.number().integer().optional(),
  // Duration window (seconds). Below: jingles/SFX that would pollute the
  // similarity space. Above: DJ sets/audiobooks where one vector for hours
  // of audio is meaningless.
  minDurationSec: Joi.number().min(0).default(30),
  maxDurationSec: Joi.number().min(1).default(30 * 60),
  // Cap on the decoded span (memory guard; segments are drawn from within it).
  maxAnalyzeSeconds: Joi.number().integer().min(10).default(600),
  // Failed tracks retry after this (transient decode/inference blips).
  errorCooldownSec: Joi.number().integer().min(0).default(24 * 60 * 60),
  // Wall-clock budget per run — the primary guard for this CPU-bound pass.
  runBudgetSec: Joi.number().integer().min(1).default(300),
  // Spoken-word content is noise in a music-similarity index.
  skipGenres: Joi.array().items(Joi.string()).default(['audiobook', 'audio book', 'podcast', 'speech']),
});

const { error: validationError, value: cfg } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

function emit(event) { console.log(JSON.stringify(event)); }

// ── Open databases ───────────────────────────────────────────────────────────
//
// discovery.db is the primary connection (this worker owns its writes);
// the library DB is ATTACHed for SELECTs only. initDiscoveryDb applies
// discovery migrations itself — this worker is a legitimate migrator for
// its own DB, unlike the library DB where it's a bystander.

let db;
try {
  db = initDiscoveryDb(cfg.discoveryDbPath);
  db.exec(`ATTACH DATABASE '${cfg.libraryDbPath.replace(/'/g, "''")}' AS lib`);
} catch (err) {
  emit({ event: 'error', message: `DB open failed: ${err.message}` });
  process.exit(1);
}

function checkSchemaGuard(context) {
  if (cfg.expectedSchemaVersion == null) { return; }
  const v = db.prepare('PRAGMA lib.user_version').get().user_version;
  if (v !== cfg.expectedSchemaVersion) {
    emit({ event: 'error',
      message: `schema-version guard: library DB is V${v}, expected V${cfg.expectedSchemaVersion} (${context})` });
    try { db.close(); } catch (_) { /* best-effort */ }
    process.exit(SCHEMA_GUARD_EXIT);
  }
}
checkSchemaGuard('at open');

// ── Work discovery ───────────────────────────────────────────────────────────

// Rows whose canonical hash no longer exists in the library (deleted files)
// are stale dataset entries — sweep both tables so the export never carries
// ghosts. Mirrors the other workers' orphan sweeps.
function pruneOrphans() {
  try {
    const sub = `
      SELECT audio_hash FROM lib.tracks WHERE audio_hash IS NOT NULL
      UNION
      SELECT file_hash  FROM lib.tracks WHERE file_hash  IS NOT NULL
    `;
    db.prepare(`DELETE FROM discovery_tracks  WHERE audio_hash NOT IN (${sub})`).run();
    db.prepare(`DELETE FROM discovery_lookups WHERE audio_hash NOT IN (${sub})`).run();
  } catch (_e) { /* best-effort housekeeping */ }
}

// Tracks needing (re-)embedding: no discovery row, no embedding yet, or an
// embedding pinned to a DIFFERENT model (the swap-migration path). One
// representative per canonical hash; failures respect the error cooldown.
function selectEligibleTracks(nowSec) {
  const errorCutoff = nowSec - cfg.errorCooldownSec;
  const genres = cfg.skipGenres.map((g) => g.toLowerCase());
  const genreClause = genres.length
    ? `AND NOT EXISTS (
         SELECT 1 FROM lib.track_genres tg JOIN lib.genres g ON g.id = tg.genre_id
          WHERE tg.track_id = t.id AND LOWER(g.name) IN (${genres.map(() => '?').join(',')})
       )`
    : '';
  const sql = `
    SELECT MIN(t.id) AS track_id,
           COALESCE(t.audio_hash, t.file_hash) AS canon_hash,
           t.filepath AS filepath,
           l.root_path AS root,
           t.title AS title,
           t.duration AS duration,
           t.bpm AS bpm,
           t.musical_key AS musical_key,
           t.mbz_recording_id AS mbz_recording_id,
           t.acoustid_id AS acoustid_id,
           a.name AS artist
      FROM lib.tracks t
      JOIN lib.libraries l ON l.id = t.library_id
      LEFT JOIN lib.artists a ON a.id = t.artist_id
      LEFT JOIN discovery_tracks dt
             ON dt.audio_hash = COALESCE(t.audio_hash, t.file_hash)
      LEFT JOIN discovery_lookups dl
             ON dl.audio_hash = COALESCE(t.audio_hash, t.file_hash)
     WHERE COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
       AND t.duration IS NOT NULL
       AND t.duration >= ? AND t.duration <= ?
       ${genreClause}
       AND (dt.audio_hash IS NULL OR dt.embedding IS NULL OR dt.model_id IS NOT ?)
       AND (dl.audio_hash IS NULL OR dl.last_attempt_at < ?)
     GROUP BY COALESCE(t.audio_hash, t.file_hash)
     ORDER BY track_id
     LIMIT ?
  `;
  const params = [cfg.minDurationSec, cfg.maxDurationSec, ...genres, cfg.model, errorCutoff, cfg.maxPerRun];
  return db.prepare(sql).all(...params);
}

const recordError = db.prepare(`
  INSERT INTO discovery_lookups (audio_hash, last_attempt_at, outcome, attempts)
  VALUES (?, ?, 'error', 1)
  ON CONFLICT(audio_hash) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    outcome         = excluded.outcome,
    attempts        = discovery_lookups.attempts + 1
`);

const clearError = db.prepare('DELETE FROM discovery_lookups WHERE audio_hash = ?');

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  pruneOrphans();

  const nowSec = Math.floor(Date.now() / 1000);
  const tracks = selectEligibleTracks(nowSec);

  if (tracks.length === 0) {
    emit({ event: 'discoveryComplete', attempted: 0, embedded: 0, errors: 0, hitCap: false });
    return;
  }

  // Load the model only when there's work — a no-op fork must stay cheap.
  // Real models take ~20 s + a first-use download; fatal if unavailable
  // (missing optional dep, no network for the first download): nothing can
  // be embedded, so exit 1 and let the next drain retry.
  const embedder = await createEmbedder(cfg.model, { modelCacheDir: cfg.modelCacheDir });

  // Pin the active model in discovery_meta — the export manifest reads it,
  // and the (future) network layer declares it. Per-row pins still allow a
  // mixed-model dataset mid-migration; meta names the model being written.
  // The license travels too: NC-SA models make the DATASET NC-SA (the
  // manifest must say so), permissive models keep it unencumbered.
  setMeta('embedding_model_id', cfg.model);
  setMeta('embedding_model_version', embedder.spec.version);
  setMeta('embedding_dim', String(embedder.spec.dim));
  setMeta('embedding_model_license', embedder.spec.license || '');
  setMeta('embedding_model_attribution', embedder.spec.attribution || '');

  const startMs = Date.now();
  let attempted = 0;
  let embedded = 0;
  let errors = 0;
  let persisted = 0;     // rows actually written — hitCap depends on it
  let hitBudget = false;

  for (let i = 0; i < tracks.length; i++) {
    // Wall-clock budget: un-attempted tracks stay eligible; the hitCap
    // re-enqueue resumes them next pass.
    if (Date.now() - startMs > cfg.runBudgetSec * 1000) { hitBudget = true; break; }

    const t = tracks[i];
    attempted++;
    const attemptSec = Math.floor(Date.now() / 1000);

    try {
      const absPath = path.join(t.root, t.filepath);
      const { embedding, genreTags } =
        await analyzeFile(embedder, absPath, cfg.ffmpegPath, {
          maxSeconds: cfg.maxAnalyzeSeconds,
          // Known duration → analyzeFile seek-decodes just the analysis
          // windows instead of the whole file.
          durationSec: t.duration,
        });

      upsertDiscoveryTrack({
        audioHash: t.canon_hash,
        artist: t.artist,
        title: t.title,
        duration: t.duration,
        modelId: cfg.model,
        modelVersion: embedder.spec.version,
        embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        // Model-derived style tags (EffNet's activations head) — free with
        // the same inference. NULL for models without a classifier head.
        genreTags,
        // Tier-1 filter metadata the library already knows (tag- or
        // essentia-sourced).
        bpm: t.bpm,
        musicalKey: t.musical_key,
        // Identity carried from the library (tag-ingested or a previous
        // AcoustID pass) so a row CREATED after identification is born with
        // its mbid: export_id — the acoustid worker's targeted update only
        // covers rows that already existed.
        recordingMbid: t.mbz_recording_id,
        acoustidId: t.acoustid_id,
      });
      // A previous failure for this hash is superseded by success.
      try { clearError.run(t.canon_hash); } catch (_e) { /* best-effort */ }
      embedded++;
      persisted++;
    } catch (err) {
      // Decode/inference failure (undecodable codec, timeout, disk, OOM).
      // Short cooldown so a transient blip retries soon. A dependency-
      // missing error mid-loop can't happen (embedder already loaded).
      errors++;
      console.error(`Warning: embed failed for ${t.filepath}: ${err?.message || err}`);
      try { recordError.run(t.canon_hash, attemptSec); persisted++; }
      catch (_e) { /* best-effort */ }
    }

    if (attempted % 5 === 0 && i + 1 < tracks.length) {
      emit({ event: 'discoveryProgress', attempted, total: tracks.length });
    }
  }

  emit({
    event: 'discoveryComplete',
    attempted,
    embedded,
    errors,
    // More work probably remains (full batch or budget cut). persisted>0
    // breaks the would-be infinite re-enqueue when NOTHING could be written.
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
    // dependencyMissing (set by createEmbedder): onnxruntime-node absent
    // or unloadable here — a structural failure that repeats identically
    // every batch, so tell the queue to latch the pass off until restart.
    process.exit(err?.dependencyMissing === true ? RUNTIME_UNAVAILABLE_EXIT : 1);
  });
