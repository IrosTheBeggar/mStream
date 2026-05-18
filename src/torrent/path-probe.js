// Per-vpath access probe. Splits cleanly into:
//
//   1. The primitive `probeDaemonPath(creds, clientType, daemonPath,
//      mstreamMirrorPath)` — drops a sentinel directory on mStream's
//      side, asks the registered verifier whether the daemon can see
//      the same directory, cleans up. Returns a structured result;
//      never throws on probe failure (probe-failure IS the result).
//
//   2. A registry of swappable verifier functions, one per client
//      type. Default verifiers are wired in module-level; tests or
//      future alternative-mechanism work can replace them via
//      `setVerifier(clientType, fn)`. The orchestrator and generators
//      don't know what verifier they're using — they just observe
//      `{verified, confidence, method, ...}` coming back.
//
//   3. Candidate generators that produce arrays of {daemonPath,
//      mstreamMirrorPath, source} tuples. Adding a new generator is
//      a pure function; no orchestrator changes needed.
//
//   4. `autoDetectMapping(vpath, creds, clientType, candidates)` that
//      runs candidates serially against the primitive, returning the
//      first verified hit (or the full attempt log on miss).

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as transmissionRpc from './transmission-rpc.js';
import * as qbittorrentRpc  from './qbittorrent-rpc.js';
import * as delugeRpc       from './deluge-rpc.js';
import { CONFIDENCE, CLIENT_TYPE } from './constants.js';

// ── Swappable verifiers ─────────────────────────────────────────────────

const _verifiers = {};

/**
 * Override the default verifier for a client. Returned shape:
 *   { verified: boolean,
 *     confidence: 'verified' | 'inferred' | 'unconfirmed',
 *     method:     string,            // identifier for telemetry/UI
 *     reason?:    string,            // populated when !verified
 *     extra?:     object }           // free-form per-verifier metadata
 *
 * Verifiers receive `{ daemonPath, mstreamMirrorPath, sentinelDirName }`
 * — they may use sentinelDirName to construct a daemon-side path that
 * matches the directory mStream just created, OR they may ignore it
 * entirely (qBittorrent's prefix-match verifier doesn't use it).
 */
export function setVerifier(clientType, fn) { _verifiers[clientType] = fn; }
export function getVerifier(clientType)     { return _verifiers[clientType]; }

// Default: Transmission's `free-space` RPC returns size-bytes for any
// path it can stat, and -1 when the path doesn't exist or is outside
// the daemon's filesystem view. Pointing it at the freshly-created
// sentinel directory inside the candidate vpath gives true round-trip
// verification: the daemon sees what mStream just wrote.
async function _transmissionFreeSpaceVerifier(creds, ctx) {
  const probePath = `${ctx.daemonPath.replace(/\/$/, '')}/${ctx.sentinelDirName}`;
  try {
    const r = await transmissionRpc.rpcCall(creds, 'free-space', { path: probePath });
    const sizeBytes = typeof r['size-bytes'] === 'number' ? r['size-bytes'] : -1;
    return sizeBytes >= 0
      ? { verified: true,  confidence: CONFIDENCE.VERIFIED,    method: 'transmission:free-space', extra: { sizeBytes } }
      : { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'transmission:free-space', reason: 'daemon free-space returned -1 (path not visible to daemon)' };
  } catch (err) {
    return { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'transmission:free-space', reason: err.message };
  }
}

// Default: qBittorrent has no `free-space` equivalent. We pull every
// path the daemon is explicitly configured to use (save_path,
// temp_path, scan_dirs keys, category savePaths) and check whether
// the candidate matches one of them or is a child path. This is
// `inferred` rather than `verified` — we know the daemon can reach
// this path because it's in its own config, but we haven't actually
// seen the daemon read what mStream just wrote.
//
// Reads `ctx.memo.knownPaths` if the orchestrator has cached it for
// this sweep — both the `daemonKnownPathsCandidates` generator and
// this verifier need the same list; pulling it twice per sweep (and
// once per candidate within a sweep) wasted daemon round-trips.
async function _qbittorrentKnownPathsVerifier(creds, ctx) {
  try {
    const known = await _resolveKnownPaths(creds, CLIENT_TYPE.QBITTORRENT, ctx.memo);
    const cand = ctx.daemonPath.replace(/\/+$/, '');
    const match = known.find(k => {
      const p = (k.path || '').replace(/\/+$/, '');
      return p && (cand === p || cand.startsWith(p + '/'));
    });
    return match
      ? { verified: true,  confidence: CONFIDENCE.INFERRED,    method: 'qbittorrent:known-paths', extra: { matchedAgainst: match.label, matchedPath: match.path } }
      : { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'qbittorrent:known-paths', reason: 'candidate did not match any of the daemon’s configured paths' };
  } catch (err) {
    return { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'qbittorrent:known-paths', reason: err.message };
  }
}

// Memoise getKnownPaths(creds) across the lifetime of a sweep. The
// memo object lives on the stack of `sweepVpath` and gets threaded
// through both the generator (`daemonKnownPathsCandidates`) and the
// verifier — without it, every candidate probe re-fetches the same
// list. Returns `[]` on memo miss + RPC error so callers can degrade
// gracefully (treating "unknown paths" as "no inferred matches").
async function _resolveKnownPaths(creds, clientType, memo) {
  if (memo && memo.knownPaths != null) { return memo.knownPaths; }
  const rpc = clientType === CLIENT_TYPE.TRANSMISSION ? transmissionRpc
            : clientType === CLIENT_TYPE.QBITTORRENT  ? qbittorrentRpc
            : clientType === CLIENT_TYPE.DELUGE       ? delugeRpc
            : null;
  if (!rpc) { return []; }
  let result;
  try { result = await rpc.getKnownPaths(creds); }
  catch { result = []; }
  if (memo) { memo.knownPaths = result; }
  return result;
}

// Deluge has no free-space-style round-trip probe (the JSON-RPC
// doesn't expose path stat-ing), so we reuse the qBittorrent
// prefix-match verifier. Confidence stays 'inferred' rather than
// 'verified' for the same reason it does on qBittorrent — we can
// prove the daemon knows about the path, but not that mStream and
// the daemon are looking at the same physical directory.
async function _delugeKnownPathsVerifier(creds, ctx) {
  try {
    const known = await _resolveKnownPaths(creds, CLIENT_TYPE.DELUGE, ctx.memo);
    const cand = ctx.daemonPath.replace(/\/+$/, '');
    const match = known.find(k => {
      const p = (k.path || '').replace(/\/+$/, '');
      return p && (cand === p || cand.startsWith(p + '/'));
    });
    return match
      ? { verified: true,  confidence: CONFIDENCE.INFERRED,    method: 'deluge:known-paths', extra: { matchedAgainst: match.label, matchedPath: match.path } }
      : { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'deluge:known-paths', reason: 'candidate did not match any of the daemon’s configured paths' };
  } catch (err) {
    return { verified: false, confidence: CONFIDENCE.UNCONFIRMED, method: 'deluge:known-paths', reason: err.message };
  }
}

setVerifier(CLIENT_TYPE.TRANSMISSION, _transmissionFreeSpaceVerifier);
setVerifier(CLIENT_TYPE.QBITTORRENT,  _qbittorrentKnownPathsVerifier);
setVerifier(CLIENT_TYPE.DELUGE,       _delugeKnownPathsVerifier);

// ── Probe primitive ─────────────────────────────────────────────────────

/**
 * Single-candidate probe. Creates a sentinel directory on mStream's
 * side, invokes the registered verifier, cleans up. Returns:
 *
 *   { verified, confidence, method, mstreamWritable, reason?, extra? }
 *
 * `mstreamWritable` is captured independently — if mStream can't even
 * create the sentinel, we never get to call the verifier, but we
 * still want to report that fact distinctly from "daemon can't see
 * it." Operators looking at the result need to know whose fault it
 * is.
 */
export async function probeDaemonPath(creds, clientType, daemonPath, mstreamMirrorPath, memo) {
  const verifier = getVerifier(clientType);
  if (!verifier) {
    throw new Error(`No verifier registered for client type '${clientType}'`);
  }

  const sentinelDirName = `.mstream-probe-${randomUUID()}`;
  const sentinelFull    = path.join(mstreamMirrorPath, sentinelDirName);

  let mstreamWritable = false;
  try {
    await fs.mkdir(sentinelFull, { recursive: false });
    mstreamWritable = true;
  } catch (err) {
    // mStream can't write here. Don't even ask the daemon — the
    // result is unconfirmed regardless of the verifier, and we want
    // a clean error path.
    return {
      verified:        false,
      confidence:      CONFIDENCE.UNCONFIRMED,
      method:          'mstream:fs-access',
      mstreamWritable: false,
      reason:          `mStream cannot create directory at ${mstreamMirrorPath}: ${err.code || err.message}`,
    };
  }

  let result;
  try {
    result = await verifier(creds, { daemonPath, mstreamMirrorPath, sentinelDirName, memo });
  } catch (err) {
    result = {
      verified:   false,
      confidence: CONFIDENCE.UNCONFIRMED,
      method:     'verifier:exception',
      reason:     err.message,
    };
  } finally {
    // Always clean up the sentinel — even on success. A successful
    // probe doesn't justify leaving directories behind.
    try { await fs.rmdir(sentinelFull); } catch { /* swallow */ }
  }

  return { ...result, mstreamWritable };
}

// ── Candidate generators ────────────────────────────────────────────────

/**
 * Generator 1: bare-metal. Assumes mStream and the daemon share a
 * filesystem view — the absolute path mStream uses is the same path
 * the daemon would use. Single candidate.
 */
export function bareMetalCandidates(vpath) {
  return [{
    daemonPath:        vpath.root_path,
    mstreamMirrorPath: vpath.root_path,
    source:            'auto:bare-metal',
  }];
}

/**
 * Generator 2: daemon's own known paths. Pulls the daemon's
 * configured directories (Transmission's `download-dir` /
 * `incomplete-dir`; qBittorrent's `save_path` / `temp_path` /
 * `scan_dirs` / category savePaths) and constructs candidates by
 * appending the vpath's name or basename. Always probed against the
 * mStream-side vpath root for the sentinel.
 *
 * Strictly better than the static Docker generator when the
 * operator's daemon is configured at all — it uses ground truth, not
 * a guess. Falls back to nothing if `getKnownPaths` errors.
 */
export async function daemonKnownPathsCandidates(vpath, creds, clientType, memo) {
  const known = await _resolveKnownPaths(creds, clientType, memo);
  if (known.length === 0) { return []; }

  const out = [];
  const seen = new Set();
  const push = (daemonPath) => {
    const norm = daemonPath.replace(/\/+$/, '');
    if (!norm || seen.has(norm)) { return; }
    seen.add(norm);
    out.push({ daemonPath: norm, mstreamMirrorPath: vpath.root_path, source: 'auto:daemon-paths' });
  };
  for (const k of known) {
    if (!k.path) { continue; }
    // Most common: daemon's known root + vpath name as subdir
    push(`${k.path.replace(/\/+$/, '')}/${vpath.name}`);
    // When vpath's on-disk basename differs from its mStream name
    const basename = path.basename(vpath.root_path);
    if (basename && basename !== vpath.name) {
      push(`${k.path.replace(/\/+$/, '')}/${basename}`);
    }
    // The daemon root itself (single-library setups)
    push(k.path);
  }
  return out;
}

/**
 * Generator 3: symlink/realpath. If mStream's vpath path is a symlink,
 * probe the resolved target too — common with NAS-backed setups where
 * the daemon is mounted on the realpath but mStream sees the symlink
 * (or vice versa). Zero daemon round-trips required; just one
 * `realpath` call.
 */
export async function symlinkAndRealpathCandidates(vpath) {
  let resolved;
  try { resolved = await fs.realpath(vpath.root_path); }
  catch { return []; }
  // realpath returned something different — try it as a candidate.
  if (resolved && resolved !== vpath.root_path) {
    return [{
      daemonPath:        resolved,
      mstreamMirrorPath: vpath.root_path,
      source:            'auto:realpath',
    }];
  }
  return [];
}

/**
 * Generator 4: default-Docker conventions. The fallback for cases
 * where neither bare-metal nor daemon-known-paths produced a hit —
 * tries the standard linuxserver/* image conventions
 * (/downloads/<name>, /downloads, /data/<name>, /music/<name>). All
 * candidates use the vpath's name; the operator's choice of names
 * matters for these hits.
 */
export function defaultDockerCandidates(vpath) {
  const name = vpath.name;
  return [
    { daemonPath: `/downloads/${name}`, mstreamMirrorPath: vpath.root_path, source: 'auto:docker' },
    { daemonPath: `/downloads`,         mstreamMirrorPath: vpath.root_path, source: 'auto:docker' },
    { daemonPath: `/data/${name}`,      mstreamMirrorPath: vpath.root_path, source: 'auto:docker' },
    { daemonPath: `/music/${name}`,     mstreamMirrorPath: vpath.root_path, source: 'auto:docker' },
  ];
}

// ── Orchestrator ────────────────────────────────────────────────────────

/**
 * Runs candidates serially against the primitive. Stops at the first
 * verified result. Returns a record describing what happened —
 * including the full attempt log on miss, so the UI can render
 * "we tried these N candidates and none worked" without a separate
 * round-trip.
 */
export async function autoDetectMapping(vpath, creds, clientType, candidates, memo) {
  const attempts = [];
  for (const c of candidates) {
    const r = await probeDaemonPath(creds, clientType, c.daemonPath, c.mstreamMirrorPath, memo);
    const attempt = { ...c, ...r };
    attempts.push(attempt);
    if (r.verified) {
      return {
        verified:    true,
        daemonPath:  c.daemonPath,
        source:      c.source,
        confidence:  r.confidence,
        method:      r.method,
        mstreamWritable: r.mstreamWritable,
        attempts,
      };
    }
  }
  return {
    verified:        false,
    daemonPath:      null,
    source:          null,
    confidence:      CONFIDENCE.UNCONFIRMED,
    method:          null,
    mstreamWritable: attempts[attempts.length - 1]?.mstreamWritable ?? null,
    attempts,
    reason:          attempts.length === 0 ? 'no candidates' : 'no candidate verified',
  };
}

/**
 * Sweep the full generator pipeline for a single vpath. Ordering
 * mirrors the priority discussed in the spec — cheapest / most likely
 * first; expensive / least likely last. Short-circuits on first hit.
 *
 * The `memo` object is created here (sweep-scoped) so getKnownPaths
 * is called at most once across the whole pipeline — both the
 * daemon-known-paths generator and the qBittorrent verifier read
 * `memo.knownPaths`.
 */
export async function sweepVpath(vpath, creds, clientType) {
  const memo = {};
  const all = [];
  all.push(...bareMetalCandidates(vpath));
  all.push(...(await daemonKnownPathsCandidates(vpath, creds, clientType, memo)));
  all.push(...(await symlinkAndRealpathCandidates(vpath)));
  all.push(...defaultDockerCandidates(vpath));
  return autoDetectMapping(vpath, creds, clientType, all, memo);
}
