// Thin DB layer over `torrent_client_vpath_access` (V39).
//
// Responsibilities:
//   - upsert a row from a `sweepVpath` / `autoDetectMapping` result
//   - read all rows for a given client (for the admin UI + add-torrent gate)
//   - delete rows tied to a vpath that no longer exists
//   - "is this (client, vpath) confirmed?" — single-row lookup used by
//     the future add-torrent gate
//
// The probe pipeline owns the verification logic; this file owns
// nothing but the serialisation. Keep it that way — every probe
// strategy should be able to land its result here without changes.

import * as db from '../db/manager.js';
import { CONFIDENCE, SOURCE } from './constants.js';

/**
 * Persist a probe result. Manual entries (`source = 'manual'`) win
 * over auto-detect: if a manual row already exists for this
 * (client, vpath), an auto-sweep WILL NOT overwrite it.
 *
 * Atomicity matters here. The old implementation read the existing
 * row, then issued a separate INSERT — a concurrent manual write
 * could land between those two statements and get clobbered. The
 * SQLite UPSERT below collapses both into one statement: the WHERE
 * clause on the DO UPDATE skips overwriting a manual row unless
 * we're writing manual ourselves.
 *
 * Anything extra in the result object (like the `attempts` array on
 * a miss) is dropped — the cache is for state, not audit.
 */
export function upsert({
  clientType,
  vpathName,
  result,            // result object from autoDetectMapping
  source,            // 'auto' | 'manual' — overrides result.source for top-level routing
}) {
  const now = Math.floor(Date.now() / 1000);
  const effectiveSource = source || result.source || SOURCE.AUTO;

  // The DO UPDATE only fires when the existing row is NOT manual, OR
  // we're writing a manual row ourselves. This is the atomicity fix
  // for the prior read-then-write race. SOURCE.MANUAL is inlined into
  // the SQL via the parameter binding below — we can't use a JS const
  // inside the SQL string itself.
  const info = db.getDB().prepare(`
    INSERT INTO torrent_client_vpath_access
      (client_type, vpath_name, daemon_path, mstream_writable,
       confidence, source, method, last_probed_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_type, vpath_name) DO UPDATE SET
      daemon_path       = excluded.daemon_path,
      mstream_writable  = excluded.mstream_writable,
      confidence        = excluded.confidence,
      source            = excluded.source,
      method            = excluded.method,
      last_probed_at    = excluded.last_probed_at,
      last_error        = excluded.last_error
    WHERE torrent_client_vpath_access.source != ?
       OR excluded.source = ?
  `).run(
    clientType,
    vpathName,
    result.daemonPath || null,
    result.mstreamWritable == null ? null : (result.mstreamWritable ? 1 : 0),
    result.confidence || CONFIDENCE.UNCONFIRMED,
    effectiveSource,
    result.method || null,
    now,
    result.verified ? null : (result.reason || null),
    SOURCE.MANUAL,
    SOURCE.MANUAL,
  );
  // `info.changes` is 0 when the WHERE on the UPDATE filtered the
  // write out — i.e. a manual row exists and we were writing auto.
  // Callers don't currently care but the signal is here if needed.
  return { skipped: info.changes === 0 };
}

/**
 * Mark a (client, vpath) row as PENDING ahead of a sweep. Used by
 * background probes so the admin UI can render a spinner during the
 * daemon round-trip instead of showing the row as "not probed".
 *
 * Preserves daemon_path / mstream_writable / source from any prior
 * row — only confidence, method, last_probed_at, and last_error
 * change. That keeps the previous good state visible alongside the
 * "in flight" badge so the operator doesn't see the table flash to
 * empty during a re-probe.
 *
 * Like `upsert`, this respects the MANUAL-wins rule: a manual row
 * stays manual; the pending-write is a no-op against it.
 */
export function markPending(clientType, vpathName) {
  const now = Math.floor(Date.now() / 1000);
  const info = db.getDB().prepare(`
    INSERT INTO torrent_client_vpath_access
      (client_type, vpath_name, daemon_path, mstream_writable,
       confidence, source, method, last_probed_at, last_error)
    VALUES (?, ?, NULL, NULL, ?, ?, 'sweep:pending', ?, NULL)
    ON CONFLICT(client_type, vpath_name) DO UPDATE SET
      confidence     = excluded.confidence,
      method         = excluded.method,
      last_probed_at = excluded.last_probed_at,
      last_error     = NULL
    WHERE torrent_client_vpath_access.source != ?
  `).run(clientType, vpathName, CONFIDENCE.PENDING, SOURCE.AUTO, now, SOURCE.MANUAL);
  return { skipped: info.changes === 0 };
}

/**
 * All rows for a client, keyed by vpath_name. Empty object if nothing
 * has been probed yet for this client (which is the legitimate state
 * after a fresh connect to a client that's never been probed before).
 */
export function getAllForClient(clientType) {
  const rows = db.getDB().prepare(`
    SELECT vpath_name, daemon_path, mstream_writable, confidence, source, method, last_probed_at, last_error
    FROM torrent_client_vpath_access
    WHERE client_type = ?
  `).all(clientType);
  const out = {};
  for (const r of rows) {
    out[r.vpath_name] = {
      daemonPath:      r.daemon_path,
      mstreamWritable: r.mstream_writable == null ? null : !!r.mstream_writable,
      confidence:      r.confidence,
      source:          r.source,
      method:          r.method,
      lastProbedAt:    r.last_probed_at,
      lastError:       r.last_error,
    };
  }
  return out;
}

/**
 * Single-row lookup used by the (future) add-torrent gate. Returns
 * `null` when no row exists — caller distinguishes that from
 * `confidence='unconfirmed'` to drive the right 4xx code (412 for
 * "probe never ran" vs 409 for "probe says no").
 */
export function getOne(clientType, vpathName) {
  const r = db.getDB().prepare(`
    SELECT daemon_path, mstream_writable, confidence, source, method, last_probed_at, last_error
    FROM torrent_client_vpath_access
    WHERE client_type = ? AND vpath_name = ?
  `).get(clientType, vpathName);
  if (!r) { return null; }
  return {
    daemonPath:      r.daemon_path,
    mstreamWritable: r.mstream_writable == null ? null : !!r.mstream_writable,
    confidence:      r.confidence,
    source:          r.source,
    method:          r.method,
    lastProbedAt:    r.last_probed_at,
    lastError:       r.last_error,
  };
}

/**
 * Drop all rows for a vpath across every client. Called when the
 * vpath gets removed via the admin "remove library" flow — stale
 * rows aren't dangerous but they confuse the UI.
 */
export function deleteByVpath(vpathName) {
  db.getDB().prepare(
    'DELETE FROM torrent_client_vpath_access WHERE vpath_name = ?'
  ).run(vpathName);
}
