/**
 * lyrics_cache read + housekeeping helpers.
 *
 * HISTORY: this module was the reactive LRCLib fallback — on a request
 * for a lyric-less track it enqueued a background fetch against
 * lrclib.net and warmed `lyrics_cache`, so the client saw "no lyrics"
 * first and real data on a re-poll. That poll-and-warm path was removed
 * when lyrics became a proactive, multi-provider post-scan backfill
 * (src/db/lyrics-backfill.mjs writes lyrics straight onto tracks.lyrics_*).
 *
 * What survives here is everything that has nothing to do with fetching:
 *   - getCached()  — the read the serving endpoints (src/api/lyrics.js,
 *                    src/api/subsonic/handlers.js) still use as a
 *                    read-only fallback for a duplicate-hash twin the
 *                    backfill wrote a cache row for but hasn't yet copied
 *                    onto a given track row.
 *   - onBoot() / purgeOrphans() — ledger housekeeping. `lyrics_cache` is
 *                    now the backfill worker's cooldown/dedup ledger, so
 *                    sweeping orphaned + superseded rows still matters.
 *   - cacheStats() / purgeAll() / purgeTransient() — admin surface for
 *                    the subsonic lyrics-cache panel.
 *
 * NAMING GOTCHA: lyrics_cache.audio_hash actually stores the CANONICAL
 * hash — COALESCE(audio_hash, file_hash) — not audio_hash specifically.
 * Every call site keys with the fallback, and the scanner's hash rekey
 * migrates this table along with the other canonical-keyed user state.
 *
 * The fetch HTTP client + LRCLib protocol now live in the provider
 * library (src/db/lyrics-lookup-lib.js), used by the backfill worker.
 */

import winston from 'winston';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';

// Daily orphan-sweep timer. Bookkept so `_resetForTests()` can stop it.
let _orphanTimer = null;

// ── Boot hook ───────────────────────────────────────────────────────────────

/**
 * Called once at server boot (wired in server.js right after the db is
 * initialised). Two jobs:
 *   1. Demote any stale 'pending' rows. The reactive path wrote these
 *      while a fetch was in flight; the proactive worker never does, so
 *      in practice this only cleans up rows left by a pre-upgrade
 *      process. Harmless to keep as a safety sweep — a stuck 'pending'
 *      row has an infinite TTL and would otherwise serve "empty,
 *      never retry" forever.
 *   2. Sweep orphaned + superseded ledger rows now, and on a daily timer.
 */
export function onBoot() {
  try {
    const r = db.getDB().prepare(
      "UPDATE lyrics_cache SET status = 'error', fetched_at = 0 WHERE status = 'pending'"
    ).run();
    if (r.changes > 0) {
      winston.info(`[lyrics-cache] demoted ${r.changes} stale pending row(s) left by a previous run`);
    }
  } catch (err) {
    // lyrics_cache may not exist yet on a fresh DB before migrations
    // ran — boot is called after migrations, so this is a genuine
    // error and worth logging. Don't throw: lyrics are non-critical
    // and the server should come up regardless.
    winston.warn(`[lyrics-cache] boot cleanup skipped: ${err.message}`);
  }

  // Immediate orphan sweep, plus a daily repeat. Cheap enough that we
  // don't guard on any enable flag — even a deployment that never runs
  // the backfill might have leftover rows from a previous era.
  purgeOrphans();
  if (_orphanTimer) { clearInterval(_orphanTimer); }
  _orphanTimer = setInterval(() => {
    try { purgeOrphans(); } catch (_) { /* already logged */ }
  }, 24 * 60 * 60 * 1000);
  // unref() so the housekeeping tick doesn't keep the process alive —
  // test harnesses that spin up/tear down the server rely on this.
  if (typeof _orphanTimer.unref === 'function') { _orphanTimer.unref(); }
}

// ── Cache read (serving fallback) ─────────────────────────────────────────────

function now() { return Date.now(); }

// Fetch a cache row. Returns null if there's no row for this audio_hash.
// Annotates the row with `isFresh` (age vs the per-status TTL) so the
// serving endpoints can tell a fresh hit from a stale one — though with
// the reactive refresh gone, both are served identically; freshness is
// retained for the admin panel + any future re-attempt policy.
export function getCached(audioHash) {
  if (!audioHash) { return null; }
  const row = db.getDB().prepare(
    'SELECT audio_hash, status, synced_lrc, plain, lang, source, fetched_at FROM lyrics_cache WHERE audio_hash = ?'
  ).get(audioHash);
  if (!row) { return null; }
  const age = now() - (row.fetched_at || 0);
  const ttl = ttlForStatus(row.status);
  row.isFresh = age < ttl;
  return row;
}

function ttlForStatus(status) {
  const l = config.program.lyrics || {};
  if (status === 'hit')   { return l.cacheTtlHitsMs   ?? 7 * 24 * 60 * 60 * 1000; }
  if (status === 'miss')  { return l.cacheTtlMissesMs ??     24 * 60 * 60 * 1000; }
  if (status === 'error') { return l.cacheTtlErrorsMs ??          60 * 60 * 1000; }
  // 'pending' — infinite TTL in practice; the boot hook demotes any
  // that linger from a pre-upgrade reactive process.
  return Infinity;
}

// ── Admin helpers (stats / purge) ─────────────────────────────────────────────

export function cacheStats() {
  const rows = db.getDB().prepare(
    'SELECT status, COUNT(*) AS n FROM lyrics_cache GROUP BY status'
  ).all();
  // `other` catches any status we don't recognise so `total` always
  // equals the sum of the named buckets. Future status values become
  // visible in the admin panel without silently inflating `total`.
  const out = { hit: 0, miss: 0, error: 0, pending: 0, other: 0, total: 0 };
  for (const r of rows) {
    if (r.status in out && r.status !== 'total' && r.status !== 'other') {
      out[r.status] = r.n;
    } else {
      out.other += r.n;
    }
    out.total += r.n;
  }
  return out;
}

/**
 * Drop every cache row. Called by the admin "purge all" button — useful
 * after a metadata cleanup to force the backfill to re-attempt tracks
 * it had cached as a miss. Returns the number of rows deleted.
 */
export function purgeAll() {
  const r = db.getDB().prepare('DELETE FROM lyrics_cache').run();
  return r.changes;
}

/**
 * Delete cache rows whose audio_hash no longer appears in the tracks
 * table, plus rows that are now fully superseded by track-level lyrics.
 * Called at boot and on a daily timer so the ledger doesn't accumulate
 * dead rows for removed/backfilled tracks.
 *
 * Returns the number of rows deleted.
 */
export function purgeOrphans() {
  try {
    const r = db.getDB().prepare(`
      DELETE FROM lyrics_cache
      WHERE audio_hash NOT IN (
        SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL
        UNION
        SELECT file_hash  FROM tracks WHERE file_hash  IS NOT NULL
      )
    `).run();
    // Superseded rows: EVERY track carrying this hash now has its OWN
    // lyrics, so the read path never consults this row again. The
    // NOT EXISTS arm is load-bearing: embedded lyrics live in TAGS, so a
    // tag-divergent duplicate (same audio_hash, no lyrics tag) is still
    // served from this row — evicting it would put that twin on an
    // evict→re-backfill treadmill.
    const s = db.getDB().prepare(`
      DELETE FROM lyrics_cache
      WHERE EXISTS (
        SELECT 1 FROM tracks t
        WHERE (t.audio_hash = lyrics_cache.audio_hash OR t.file_hash = lyrics_cache.audio_hash)
          AND (t.lyrics_synced_lrc IS NOT NULL OR t.lyrics_embedded IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM tracks t
        WHERE (t.audio_hash = lyrics_cache.audio_hash OR t.file_hash = lyrics_cache.audio_hash)
          AND t.lyrics_synced_lrc IS NULL AND t.lyrics_embedded IS NULL
      )
    `).run();
    const total = r.changes + s.changes;
    if (total > 0) {
      winston.info(`[lyrics-cache] swept ${r.changes} orphan + ${s.changes} superseded cache row(s)`);
    }
    return total;
  } catch (err) {
    winston.warn(`[lyrics-cache] orphan sweep failed: ${err.message}`);
    return 0;
  }
}

/**
 * Wipe just the error + pending rows so those tracks become eligible for
 * the backfill again. Used by the admin "retry errors" button to shake
 * loose a network-outage window without dropping successful hits.
 */
export function purgeTransient() {
  const r = db.getDB().prepare(
    "DELETE FROM lyrics_cache WHERE status IN ('error', 'pending')"
  ).run();
  return r.changes;
}

// ── Test-only internals ─────────────────────────────────────────────────────

/** Test-only: stop the daily orphan-sweep timer between cases. */
export function _resetForTests() {
  if (_orphanTimer) {
    clearInterval(_orphanTimer);
    _orphanTimer = null;
  }
}
