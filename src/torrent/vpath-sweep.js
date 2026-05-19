// Shared vpath-sweep service. Pulls the active torrent client's creds
// out of config, calls pathProbe.sweepVpath() for each library passed
// in, and writes the result into the vpath-access-cache. Used by:
//
//   - admin-torrent.js — explicit user actions (test / connect / manual
//     verify / auto-detect button). Awaits the sweep so the admin UI
//     reflects fresh state immediately on the response.
//   - util/admin.js (addDirectory) — fire-and-forget when a new library
//     is created. The caller does NOT await; library-add must not block
//     on a daemon round-trip, and a daemon-down case shouldn't fail
//     the library-add.
//
// Manual cache entries (source=MANUAL) are preserved by the UPSERT —
// see vpathAccessCache.upsert. Per-vpath sweeps run in parallel; the
// cache UPSERT is atomic (V40 + the WHERE-on-DO-UPDATE clause), so
// concurrent writes across vpaths cannot corrupt each other.

import * as config from '../state/config.js';
import * as pathProbe from './path-probe.js';
import * as vpathAccessCache from './vpath-access-cache.js';
import { CLIENT_TYPE, SOURCE, isClientActive } from './constants.js';

/**
 * Sweep the supplied libraries against the active torrent client.
 * No-op when no client is active or no creds are saved — callers don't
 * have to gate this themselves.
 *
 * Returns when every sweep + cache-write has settled. Callers that
 * don't care about completion (background probes) can ignore the
 * promise; this function never throws — exceptions from a single sweep
 * are recorded as the cache row's verification reason.
 */
export async function sweepVpathsForActiveClient(libraries) {
  const active = config.program.torrent.client;
  if (!isClientActive(active)) { return; }
  const creds =
    active === CLIENT_TYPE.TRANSMISSION ? (config.program.torrent.transmission || {}) :
    active === CLIENT_TYPE.QBITTORRENT  ? (config.program.torrent.qbittorrent  || {}) :
    active === CLIENT_TYPE.DELUGE       ? (config.program.torrent.deluge       || {}) : null;
  if (!creds || !creds.host) { return; }

  await Promise.all(libraries.map(async lib => {
    // Mark the row pending BEFORE the daemon round-trip so the admin
    // UI renders a spinner instead of "not probed yet" during the
    // 100ms-30s window. Prior daemon_path / mstreamWritable are kept
    // so the operator sees the previous state alongside the badge.
    // No-op against MANUAL rows (manual stays manual).
    vpathAccessCache.markPending(active, lib.name);

    let result;
    try {
      result = await pathProbe.sweepVpath(lib, creds, active);
    } catch (err) {
      result = { verified: false, confidence: 'unconfirmed', method: 'sweep:exception', reason: err.message };
    }
    vpathAccessCache.upsert({
      clientType: active, vpathName: lib.name, result, source: SOURCE.AUTO,
    });
  }));
}
