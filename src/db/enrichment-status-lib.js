// Durable "how enriched is the library" coverage counts for the scan
// status API (GET /api/v1/scan/status — src/api/scan.js).
//
// The task-queue registry answers "what is the queue doing right now";
// this module answers "how much of the library has each pass actually
// covered", straight from the DB (and the waveform cache dir), so the
// numbers survive restarts and are meaningful even when a pass is
// disabled. Each pass's `remaining` is grounded in the same eligibility
// predicate its worker uses to pick work (see the per-pass builders),
// minus the time-based cooldown terms — cooldowns move hour by hour and
// would make "remaining" oscillate without the library changing; the
// `outcomes` ledger map is what explains why remaining items aren't
// being retried right now.
//
// Every builder is wrapped so one broken source (a locked discovery.db,
// a permissions error on the waveform cache) nulls out ITS pass instead
// of failing the endpoint.
//
// Costs — honest numbers, not the "single-digit ms" this header used to
// claim (2026-07 audit H6, off by ~100×): a full recompute is ~8
// aggregate passes over tracks/albums plus the hash-ledger probes
// (~430 ms at 25k tracks) plus the discovery.db counts (0.8–1.4 s
// UNINDEXED; ~ms with the V2 partial index) plus one readdir of the
// waveform cache. The endpoint is NOT admin-only and the dashboard polls
// every 4 s, so the caching layer carries the load:
//   • fresh hits (≤ CACHE_TTL_MS) serve the memo;
//   • STALE hits serve the stale snapshot immediately and refresh
//     off-request, one builder per event-loop tick, so a poll never
//     blocks on a recompute (stale-while-revalidate);
//   • the globally-scoped passes (waveform, discovery) are memoised once
//     for all library signatures — their counts don't vary by caller;
//   • only the FIRST request for a signature (or force:true) pays a
//     synchronous full compute — there is nothing stale to serve yet.
// Freshness at pass/scan boundaries still comes from
// invalidateCoverageCache(), which also discards any refresh that was
// mid-flight when the world changed.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from './manager.js';
import * as discoveryDb from './discovery-db.js';
import {
  CACHE_EXT as WAVEFORM_CACHE_EXT,
  FAILED_EXT as WAVEFORM_FAILED_EXT,
} from './waveform-lib.js';

// Worker-mirror duration windows. Deliberately duplicated from the
// enqueue pre-checks in task-queue.js (which themselves mirror the
// worker defaults in *-backfill.mjs) rather than imported — this module
// must stay import-light so the API layer can use it without pulling in
// the whole queue/worker machinery.
const ANALYSIS_MIN_DURATION_SEC = 30;
const ANALYSIS_MAX_DURATION_SEC = 30 * 60;
// The discovery pass shares the analysis window.
const ACOUSTID_MIN_DURATION_SEC = 10;
const ACOUSTID_MAX_DURATION_SEC = 2 * 60 * 60;

// Above the admin page's 4 s poll on purpose: with a 5 s TTL every poll
// recomputed the whole snapshot. Freshness at pass/scan boundaries comes
// from invalidateCoverageCache(), not the TTL — this only bounds staleness
// of mid-pass counts.
const CACHE_TTL_MS = Number(process.env.MSTREAM_TEST_COVERAGE_TTL_MS) || 15_000;
const WAVEFORM_FS_TTL_MS = 60_000;

// key = sorted libIds signature → { at, data }. Bounded: a burst of
// distinct signatures (federation callers with per-key grants) clears
// the map rather than growing it forever.
const coverageCache = new Map();
const COVERAGE_CACHE_MAX_ENTRIES = 64;

let waveformFsCache = { at: 0, bins: 0, failed: 0 };

// Globally-scoped pass results (waveform, discovery) — identical for
// every library signature, so they're computed once per TTL window
// instead of once per signature.
let globalPassCache = { at: 0, values: {} };

// Refreshes in flight (per signature) + a generation counter: a refresh
// started before invalidateCoverageCache() must not land its
// now-outdated snapshot as fresh.
const refreshing = new Set();
let cacheGeneration = 0;

// Tests poke config/library state between calls; give them (and the
// admin force-refresh, if one ever ships) a way to drop the memo.
export function invalidateCoverageCache() {
  coverageCache.clear();
  globalPassCache = { at: 0, values: {} };
  waveformFsCache = { at: 0, bins: 0, failed: 0 };
  cacheGeneration++;
}

// `library_id IN (...)` filter for the caller's accessible libraries —
// same contract as api/db.js#libraryFilter, minus the user plumbing (the
// caller resolves libIds via db.getUserLibraryIds so this module stays
// req-free). Empty access = `1=0`, matching libraryFilter.
function libClause(column, libIds) {
  if (libIds.length === 0) { return { clause: '1=0', params: [] }; }
  return {
    clause: `${column} IN (${libIds.map(() => '?').join(',')})`,
    params: libIds,
  };
}

// GROUP BY outcome over a per-hash attempt ledger, filtered to hashes
// that belong to at least one accessible track. The OR pair inside
// EXISTS is the canonical-identity join (COALESCE(audio_hash, file_hash)
// = ledger key) split so both arms stay indexed probes
// (idx_tracks_audio_hash / idx_tracks_hash).
function outcomesForHashLedger(d, table, outcomeCol, libIds) {
  const lib = libClause('t.library_id', libIds);
  // Ledger rows are keyed by the CANONICAL hash — COALESCE(audio_hash,
  // file_hash), exactly how every enrichment worker keys them — so
  // visibility is "the hash belongs to some visible track". Phrased as
  // IN (materialised subquery): one pass over tracks builds the hash set,
  // then each ledger row is a single probe.
  //
  // ⚠ Do NOT rewrite this as a correlated EXISTS with the coalesce spelled
  // out as an OR (t.audio_hash = l.audio_hash OR (t.audio_hash IS NULL AND
  // t.file_hash = l.audio_hash)): without ANALYZE stats SQLite plans that
  // probe via idx_tracks_library instead of the hash indexes — effectively
  // ledger-rows × library-rows. On a 19k-track library with an 18.5k-row
  // audio_analysis ledger that was ~22 SECONDS of synchronous main-thread
  // CPU per status poll (measured on prod, 2026-07-30, admin page pinned
  // the server at 100%); this form is ~20 ms on the same data.
  const rows = d.prepare(`
    SELECT l.${outcomeCol} AS outcome, COUNT(*) AS n
      FROM ${table} l
     WHERE l.audio_hash IN (
             SELECT COALESCE(t.audio_hash, t.file_hash)
               FROM tracks t
              WHERE ${lib.clause}
                AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
           )
     GROUP BY l.${outcomeCol}
  `).all(...lib.params);
  const out = {};
  for (const r of rows) { out[r.outcome] = r.n; }
  return out;
}

// ── Per-pass builders ───────────────────────────────────────────────────────

function albumartCoverage(d, libIds) {
  const lib = libClause('t.library_id', libIds);
  // Same album pool as the downloader: named, non-ghost (has at least
  // one track the caller can see). `done` = has a cover from ANY source
  // (scanner-extracted or downloaded) — coverage is about the artifact,
  // not who produced it.
  const row = d.prepare(`
    SELECT COUNT(*) AS eligible,
           SUM(CASE WHEN al.album_art_file IS NOT NULL THEN 1 ELSE 0 END) AS done
      FROM albums al
     WHERE al.name IS NOT NULL AND TRIM(al.name) != ''
       AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${lib.clause})
  `).get(...lib.params);

  const outcomeRows = d.prepare(`
    SELECT l.outcome AS outcome, COUNT(*) AS n
      FROM album_art_lookups l
      JOIN albums al ON al.id = l.album_id
     WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${lib.clause})
     GROUP BY l.outcome
  `).all(...lib.params);
  const outcomes = {};
  for (const r of outcomeRows) { outcomes[r.outcome] = r.n; }

  const done = row.done || 0;
  return {
    scope: 'library',
    unit: 'albums',
    done,
    remaining: (row.eligible || 0) - done,
    eligible: row.eligible || 0,
    outcomes,
  };
}

function lyricsCoverage(d, libIds) {
  const lib = libClause('t.library_id', libIds);
  // `remaining` mirrors the backfill worker's pool: lyric-less AND
  // lookup-able (title + artist). Lyric-less tracks missing either are
  // structurally unfillable and belong to neither bucket.
  const row = d.prepare(`
    SELECT SUM(CASE WHEN t.lyrics_embedded IS NOT NULL OR t.lyrics_synced_lrc IS NOT NULL
                    THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.lyrics_embedded IS NULL AND t.lyrics_synced_lrc IS NULL
                     AND t.title IS NOT NULL AND TRIM(t.title) != ''
                     AND t.artist_id IS NOT NULL
                    THEN 1 ELSE 0 END) AS remaining
      FROM tracks t
     WHERE ${lib.clause}
  `).get(...lib.params);

  return {
    scope: 'library',
    unit: 'tracks',
    done: row.done || 0,
    remaining: row.remaining || 0,
    // lyrics_cache.status vocabulary: 'hit' / 'notfound' / 'error'.
    outcomes: outcomesForHashLedger(d, 'lyrics_cache', 'status', libIds),
  };
}

function audioAnalysisCoverage(d, libIds) {
  const lib = libClause('t.library_id', libIds);
  // done = BOTH columns resolved (tag- or analysis-sourced); the worker's
  // NULL gate keeps single-sided rows eligible, so they count as remaining
  // when they fit the duration window.
  const row = d.prepare(`
    SELECT SUM(CASE WHEN t.bpm IS NOT NULL AND t.musical_key IS NOT NULL
                    THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN (t.bpm IS NULL OR t.musical_key IS NULL)
                     AND t.duration IS NOT NULL AND t.duration >= ? AND t.duration <= ?
                     AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
                    THEN 1 ELSE 0 END) AS remaining
      FROM tracks t
     WHERE ${lib.clause}
  `).get(ANALYSIS_MIN_DURATION_SEC, ANALYSIS_MAX_DURATION_SEC, ...lib.params);

  return {
    scope: 'library',
    unit: 'tracks',
    done: row.done || 0,
    remaining: row.remaining || 0,
    // audio_analysis_lookups vocabulary: 'analyzed' / 'lowconf' / 'error'.
    outcomes: outcomesForHashLedger(d, 'audio_analysis_lookups', 'outcome', libIds),
  };
}

function acoustidCoverage(d, libIds) {
  const lib = libClause('t.library_id', libIds);
  const row = d.prepare(`
    SELECT SUM(CASE WHEN t.mbz_recording_id IS NOT NULL THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.mbz_recording_id IS NOT NULL AND t.mbz_id_source = 'acoustid'
                    THEN 1 ELSE 0 END) AS from_acoustid,
           SUM(CASE WHEN t.mbz_recording_id IS NOT NULL AND t.mbz_id_source = 'tag'
                    THEN 1 ELSE 0 END) AS from_tag,
           SUM(CASE WHEN t.mbz_recording_id IS NULL
                     AND COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
                     AND t.duration IS NOT NULL AND t.duration >= ? AND t.duration <= ?
                    THEN 1 ELSE 0 END) AS remaining
      FROM tracks t
     WHERE ${lib.clause}
  `).get(ACOUSTID_MIN_DURATION_SEC, ACOUSTID_MAX_DURATION_SEC, ...lib.params);

  return {
    scope: 'library',
    unit: 'tracks',
    done: row.done || 0,
    remaining: row.remaining || 0,
    // Provenance split: MBIDs read from embedded tags vs derived by the
    // fingerprint pass — the pass only ever moves the second number.
    bySource: { tag: row.from_tag || 0, acoustid: row.from_acoustid || 0 },
    // acoustid_lookups vocabulary: 'nomatch' / 'lowconf' / 'undecodable' /
    // 'error'. Success writes no ledger row (the track just gains its MBID).
    outcomes: outcomesForHashLedger(d, 'acoustid_lookups', 'outcome', libIds),
  };
}

// Waveforms are cache FILES keyed by canonical hash, not DB rows — count
// the artifacts themselves. Hash-keyed means library-access filtering
// does not apply (a hash shared across two libraries has ONE .bin), so
// this pass reports scope 'global'. `remaining` is derived
// (hashes − bins − failed markers) and can under-count when .bins for
// since-deleted tracks linger in the cache; it clamps at 0.
function waveformCoverage(d, now) {
  if (now - waveformFsCache.at > WAVEFORM_FS_TTL_MS) {
    let bins = 0;
    let failed = 0;
    try {
      // Current-generation names only. Artifacts from a superseded bar
      // format are swept at boot, but until that lands they must not be
      // counted as coverage the operator does not actually have.
      for (const name of fs.readdirSync(config.program.storage.waveformCacheDirectory)) {
        if (name.endsWith(WAVEFORM_CACHE_EXT)) { bins++; }
        else if (name.endsWith(WAVEFORM_FAILED_EXT)) { failed++; }
      }
    } catch (err) {
      // Missing dir = simply no waveforms generated yet (the pass creates
      // it); anything else is worth a breadcrumb but not a broken endpoint.
      if (err.code !== 'ENOENT') {
        winston.warn(`waveform coverage: cache dir unreadable: ${err.message}`);
      }
      bins = 0;
      failed = 0;
    }
    waveformFsCache = { at: now, bins, failed };
  }

  const row = d.prepare(`
    SELECT COUNT(DISTINCT COALESCE(audio_hash, file_hash)) AS hashes
      FROM tracks
     WHERE COALESCE(audio_hash, file_hash) IS NOT NULL
  `).get();

  const { bins, failed } = waveformFsCache;
  return {
    scope: 'global',
    unit: 'tracks',
    done: bins,
    remaining: Math.max(0, (row.hashes || 0) - bins - failed),
    outcomes: failed > 0 ? { failed } : {},
  };
}

// Discovery embeddings live in the separate discovery.db. No file on
// disk = collection has never been enabled → null (the API shows the
// pass as disabled with no coverage, which is the truth). Mirrors the
// enqueue pre-check's ATTACH pattern — the main process's handle is
// single-threaded, so the attach/detach can't interleave mid-statement
// with the pre-check's.
function discoveryCoverage() {
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!ddb) { return null; }
  const model = config.program.scanOptions.discoveryModel;

  const done = ddb.prepare(
    'SELECT COUNT(*) AS n FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ?'
  ).get(model).n;

  const libPath = path.join(config.program.storage.dbDirectory, 'mstream.db').replace(/'/g, "''");
  ddb.exec(`ATTACH DATABASE '${libPath}' AS cov_lib`);
  let remaining;
  try {
    // COUNT twin of the enqueue pre-check's LIMIT-1 eligibility probe:
    // canonical hashes in the duration window with no current-model
    // embedding. DISTINCT because discovery work is per-hash, not per-row.
    remaining = ddb.prepare(`
      SELECT COUNT(DISTINCT COALESCE(t.audio_hash, t.file_hash)) AS n
        FROM cov_lib.tracks t
       WHERE COALESCE(t.audio_hash, t.file_hash) IS NOT NULL
         AND t.duration IS NOT NULL AND t.duration >= ? AND t.duration <= ?
         AND NOT EXISTS (
               SELECT 1 FROM main.discovery_tracks dt
                WHERE dt.audio_hash = COALESCE(t.audio_hash, t.file_hash)
                  AND dt.embedding IS NOT NULL
                  AND dt.model_id = ?
             )
    `).get(ANALYSIS_MIN_DURATION_SEC, ANALYSIS_MAX_DURATION_SEC, model).n;
  } finally {
    ddb.exec('DETACH DATABASE cov_lib');
  }

  const outcomeRows = ddb.prepare(
    'SELECT outcome, COUNT(*) AS n FROM discovery_lookups GROUP BY outcome'
  ).all();
  const outcomes = {};
  for (const r of outcomeRows) { outcomes[r.outcome] = r.n; }

  return {
    scope: 'global',
    unit: 'tracks',
    model,
    done,
    remaining,
    outcomes,
  };
}

// ── Compute + caching machinery ─────────────────────────────────────────────

// One builder failing (locked discovery.db, mid-migration schema) nulls
// out its pass, never the endpoint.
function guard(label, fn) {
  try { return fn(); } catch (err) {
    winston.warn(`enrichment coverage: ${label} counts failed: ${err.message}`);
    return null;
  }
}

// Waveform + discovery counts ignore the caller's libraries entirely
// (hash-keyed cache files / the separate discovery.db), so one result
// serves every signature for a TTL window.
function globalPass(label, now, fn) {
  if (now - globalPassCache.at > CACHE_TTL_MS) {
    globalPassCache = { at: now, values: {} };
  }
  if (!(label in globalPassCache.values)) {
    globalPassCache.values[label] = guard(label, fn);
  }
  return globalPassCache.values[label];
}

// The compute, expressed as an ordered step list so the synchronous
// first-call path and the chunked background refresh share one
// definition. Each step assigns into `data` when it runs.
function coverageSteps(d, ids, data) {
  const lib = libClause('t.library_id', ids);
  return [
    () => { data.totals = guard('totals', () => ({
      tracks: d.prepare(`SELECT COUNT(*) AS n FROM tracks t WHERE ${lib.clause}`)
        .get(...lib.params).n,
    })); },
    () => { data.passes.waveform = globalPass('waveform', Date.now(), () => waveformCoverage(d, Date.now())); },
    () => { data.passes.albumart = guard('albumart', () => albumartCoverage(d, ids)); },
    () => { data.passes.lyrics = guard('lyrics', () => lyricsCoverage(d, ids)); },
    () => { data.passes.audioanalysis = guard('audioanalysis', () => audioAnalysisCoverage(d, ids)); },
    () => { data.passes.discovery = globalPass('discovery', Date.now(), () => discoveryCoverage()); },
    () => { data.passes.acoustid = guard('acoustid', () => acoustidCoverage(d, ids)); },
  ];
}

function storeEntry(key, data) {
  if (coverageCache.size >= COVERAGE_CACHE_MAX_ENTRIES) { coverageCache.clear(); }
  coverageCache.set(key, { at: Date.now(), data });
}

function computeSync(d, ids) {
  const data = { passes: {} };
  for (const step of coverageSteps(d, ids, data)) { step(); }
  return data;
}

// Background refresh for a signature whose memo went stale: one builder
// per event-loop tick, so no single tick blocks longer than the slowest
// builder (~100 ms at 25k vs 0.5–2 s for the whole snapshot). The
// generation check discards the result if the world changed mid-flight
// (a pass finished, a scan landed) — the stale-serving caller already
// scheduled a fresh refresh under the new generation by then.
async function refreshInBackground(key, ids) {
  if (refreshing.has(key)) { return; }
  refreshing.add(key);
  const startedGeneration = cacheGeneration;
  try {
    const d = db.getDB();
    if (!d) { return; }
    const data = { passes: {} };
    for (const step of coverageSteps(d, ids, data)) {
      step();
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (cacheGeneration === startedGeneration) { storeEntry(key, data); }
  } catch (err) {
    winston.warn(`enrichment coverage: background refresh failed: ${err.message}`);
  } finally {
    refreshing.delete(key);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

// Coverage for every enrichment pass, memoised per accessible-library
// set. Returns { totals: { tracks }, passes: { <kind>: {...}|null } };
// null for the whole thing only when the library DB isn't open.
// `force` drops the memo first and recomputes synchronously (tests;
// admin refresh). A stale memo is served as-is while a chunked refresh
// runs off-request — see the header comment.
export function getEnrichmentCoverage(libIds, { force = false } = {}) {
  const d = db.getDB();
  if (!d) { return null; }
  const ids = Array.isArray(libIds) ? libIds : [];

  const key = [...ids].sort((a, b) => a - b).join(',');
  const now = Date.now();
  if (force) { coverageCache.delete(key); }
  const hit = coverageCache.get(key);
  if (hit && now - hit.at <= CACHE_TTL_MS) { return hit.data; }
  if (hit) {
    // Stale-while-revalidate: the poll gets the stale counts instantly;
    // the next poll (or the one after) sees the refreshed ones.
    refreshInBackground(key, ids);
    return hit.data;
  }

  // First sight of this signature (or force): nothing stale to serve.
  const data = computeSync(d, ids);
  storeEntry(key, data);
  return data;
}
