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

// Cap on how many candidate torrents the content-match verifier
// inspects per probe. Each one costs a daemon round-trip for the
// file list + an mStream-side stat. Three is enough to weather the
// "first torrent is mid-recheck" race (we'll move on to the next)
// without blowing out worst-case time. Increase if you're seeing
// false-negative content matches in the wild.
const _CONTENT_MATCH_INSPECT_CAP = 3;

/**
 * Translate a daemon-side file path to its mStream-side equivalent
 * for content-match verification.
 *
 * The daemon's torrent file lives at `savePath + "/" + fileName`
 * (POSIX joined). Our candidate `daemonPath` maps to
 * `mstreamMirrorPath` — the directory mStream sees as the vpath root.
 * We need to translate the daemon's file path THROUGH that mapping:
 *
 *     daemon side:  savePath/<info-relative-path>          (the file)
 *                   daemonPath                              (the candidate dir)
 *     mstream side: mstreamMirrorPath                       (mirror of daemonPath)
 *                   mstreamMirrorPath/<rel-to-candidate>    (mirror of the file)
 *
 * Returns the on-disk path string when the file is at or under the
 * candidate; returns null when it isn't (the torrent shares a parent
 * with our candidate but its files live elsewhere). The naive
 * `path.join(mstreamMirrorPath, fileName)` was wrong whenever
 * savePath ≠ daemonPath — common when an operator saves all torrents
 * to a single parent dir and uses per-album subdirs as the vpath.
 *
 * Exported for unit tests. Internal — not part of the public API.
 */
export function _resolveOnDiskPath(daemonPath, mstreamMirrorPath, savePath, fileName) {
  if (!savePath || !fileName) { return null; }
  // Daemons in our supported set (qBit + Deluge in Docker) emit POSIX
  // paths in their RPC responses. path.posix.join collapses ../ and
  // multiple slashes safely.
  const daemonFile = path.posix.join(savePath, fileName).replace(/\/+$/, '');
  const candNorm   = (daemonPath || '').replace(/\/+$/, '');
  if (!candNorm)   { return null; }
  if (!daemonFile) { return null; }
  // The file must be strictly INSIDE the candidate (a daemon-side
  // path equal to the candidate would mean the candidate IS the
  // file, not a dir — nonsensical for our flow).
  if (!daemonFile.startsWith(candNorm + '/')) { return null; }
  const relToCandidate = daemonFile.slice(candNorm.length + 1);
  return path.join(mstreamMirrorPath, relToCandidate);
}

// ── Learned-prefix cache ─────────────────────────────────────────────────
//
// Module-level cache of daemon-side directory prefixes that have
// produced a `verified` result in past sweeps. The next vpath probed
// against the same client tries `<prefix>/<vpath.name>` as a
// high-priority candidate before the daemon-known-paths fan-out.
//
// Why: after `music → /downloads/music` verifies, the next vpath
// (`testlib`) is very likely at `/downloads/testlib`. The
// daemon-known-paths generator already produces this when save_path
// is `/downloads`, but setups that ONLY have per-category save paths
// or per-torrent overrides re-derive the prefix per vpath. The cache
// short-circuits that.
//
// Lifetime: in-memory only, cleared on process restart. Re-learning
// from a fresh boot is fast (one full sweep across libraries). Cap
// per client = 8 entries, evicting in insertion order — the typical
// operator has 1-3 libraries; 8 absorbs prefix churn from a vpath
// rename/re-add without unbounded growth.
//
// Only entries promoted to `verified` populate this cache. Inferred
// hits do NOT — they're already guesses, and propagating guesses
// would compound the error across vpaths. With Phase A landed,
// content-match gives qBit + Deluge a `verified` path, so all three
// clients can populate the cache.
const _LEARNED_PREFIX_CAP = 8;
const _verifiedPrefixes   = new Map();  // clientType → Map<prefix, lastUsed>

function _recordVerifiedPrefix(clientType, prefix) {
  if (!clientType || !prefix) { return; }
  let bucket = _verifiedPrefixes.get(clientType);
  if (!bucket) {
    bucket = new Map();
    _verifiedPrefixes.set(clientType, bucket);
  }
  // Delete-then-set bumps the entry to most-recent insertion order.
  bucket.delete(prefix);
  bucket.set(prefix, Date.now());
  while (bucket.size > _LEARNED_PREFIX_CAP) {
    bucket.delete(bucket.keys().next().value);
  }
}

// Pull the parent directory out of a verified daemonPath when the
// path's last segment is the vpath's name (the common case for
// per-library subdirectories under a shared root). When the
// daemonPath itself doesn't end with the vpath name (single-library
// setups, root-mounted libraries), we return the full daemonPath as
// the prefix — it's still useful: a future vpath sweep can try
// `<that-same-prefix>/<new-vpath-name>`. Empty / nonsense input
// returns null and the caller skips recording.
function _prefixFromVerifiedPath(vpath, daemonPath) {
  if (!daemonPath || typeof daemonPath !== 'string') { return null; }
  const trimmed = daemonPath.replace(/\/+$/, '');
  if (!trimmed) { return null; }
  // POSIX-style parent extraction. Daemons in our supported set all
  // emit POSIX paths in their RPC responses (Transmission's free-
  // space, qBit's save_path, Deluge's save_path). Windows daemons
  // would need separator normalisation, which is out of scope for v1.
  const lastSep = trimmed.lastIndexOf('/');
  if (lastSep <= 0) { return trimmed; }   // root-level path; treat the whole thing as the prefix
  const tail = trimmed.slice(lastSep + 1);
  const head = trimmed.slice(0, lastSep);
  // Match against the vpath's display name OR its on-disk basename.
  // Most setups have them aligned, but the daemon's view might use
  // either form depending on how the operator configured their
  // bind mount.
  const onDiskBase = vpath?.root_path ? path.basename(vpath.root_path) : '';
  if (tail === vpath?.name || (onDiskBase && tail === onDiskBase)) {
    return head;
  }
  // Last segment doesn't look like a per-vpath suffix; the path is
  // probably a single-library root. Store the whole thing — future
  // vpath sweeps can still produce `<root>/<their-name>` candidates.
  return trimmed;
}

// Exposed for tests + introspection. Resets the cache to empty.
// Production callers should NOT clear this — the cache is process-
// local and the auto-detect flow doesn't break when it's stale.
export function _resetLearnedPrefixes() { _verifiedPrefixes.clear(); }
export function _getLearnedPrefixes(clientType) {
  const b = _verifiedPrefixes.get(clientType);
  return b ? Array.from(b.keys()) : [];
}

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

// Content-match: ground-truth verifier shared by qBittorrent +
// Deluge. Asks the daemon for its current torrent list, filters to
// torrents whose own save_path is under (or matches) the candidate
// daemonPath, then for each one pulls the file list and checks that
// the first file's reported size matches what mStream sees at the
// equivalent mStream-side path. A single match across one file is
// strong evidence the daemon and mStream share a filesystem view —
// strong enough to promote the result from `inferred` to `verified`.
//
// Returns `null` (not a result object) when:
//   - The daemon's listTorrents fails (use known-paths fallback)
//   - No torrents have save_path under the candidate
//   - We inspected up to `_CONTENT_MATCH_INSPECT_CAP` torrents and
//     none produced a size-match (first file might still be
//     downloading, or the daemon's view drifted)
// The composed verifier turns null into a fall-through to the
// known-paths logic that lived here before.
//
// `methodLabel` is the per-client identifier we stamp on the result
// (qbittorrent:content-match vs deluge:content-match) — same surface
// as the rest of the verifier registry.
async function _tryContentMatchAgainstTorrents(creds, ctx, clientType, methodLabel) {
  const rpc = clientType === CLIENT_TYPE.QBITTORRENT ? qbittorrentRpc
            : clientType === CLIENT_TYPE.DELUGE       ? delugeRpc
            : null;
  if (!rpc) { return null; }

  // Memoise the torrent list per sweep — both this verifier and any
  // other code paths that want the daemon's session benefit from
  // the same cache. Without it, every candidate probe re-fetches.
  let listing;
  if (ctx.memo && ctx.memo.torrentList != null) {
    listing = ctx.memo.torrentList;
  } else {
    try { listing = await rpc.listTorrents(creds); }
    catch { listing = []; }
    if (ctx.memo) { ctx.memo.torrentList = listing; }
  }
  if (!Array.isArray(listing) || listing.length === 0) { return null; }

  const cand = ctx.daemonPath.replace(/\/+$/, '');
  // A torrent is a candidate for content-match when its savePath is
  // exactly the candidate or a child of it. Daemons sometimes report
  // contentPath (qBit) which includes the info-name subdir; either
  // is fine for filtering since they share a common prefix.
  const matchingTorrents = listing.filter(t => {
    const sp = (t.savePath    || '').replace(/\/+$/, '');
    const cp = (t.contentPath || '').replace(/\/+$/, '');
    const hits = (p) => p && (p === cand || p.startsWith(cand + '/') || cand.startsWith(p + '/'));
    return hits(sp) || hits(cp);
  });
  if (matchingTorrents.length === 0) { return null; }

  // Cap the daemon RPCs we spend on this verifier. The order is
  // whatever listTorrents returned — typically newest first for both
  // clients, which biases toward fully-downloaded content (more
  // likely to produce a size-match hit).
  const inspect = matchingTorrents.slice(0, _CONTENT_MATCH_INSPECT_CAP);
  for (const t of inspect) {
    let files;
    try {
      if (clientType === CLIENT_TYPE.QBITTORRENT) {
        files = await qbittorrentRpc.qbittorrentTorrentFiles(creds, t.infoHash);
      } else {
        files = await delugeRpc.delugeTorrentFiles(creds, t.infoHash);
      }
    } catch {
      continue;  // failed file lookup — try the next torrent
    }
    if (!Array.isArray(files) || files.length === 0) { continue; }

    // Pick the first file with a non-zero size. Files come from the
    // daemon in torrent-info order; the first audio track of an
    // album is typically files[0], which is exactly what we want
    // for a low-cost stat probe. Skip zero-byte files (placeholders,
    // empty files in obscure releases) since size-match on 0 is
    // meaningless.
    const firstFile = files.find(f => (f.size || 0) > 0) || files[0];
    if (!firstFile) { continue; }

    // Build the mStream-side path THROUGH the candidate's mapping —
    // see _resolveOnDiskPath for why this isn't just `path.join`.
    // When the file isn't under the candidate (torrent saved at a
    // shared parent dir but its files live in a sibling subdir), we
    // skip it and move on to the next torrent.
    const fileName = firstFile.name || '';
    const onDiskPath = _resolveOnDiskPath(
      ctx.daemonPath, ctx.mstreamMirrorPath, t.savePath, fileName,
    );
    if (!onDiskPath) { continue; }
    let stat;
    try { stat = await fs.stat(onDiskPath); }
    catch { continue; }
    if (!stat.isFile() || stat.size !== firstFile.size) { continue; }

    return {
      verified:   true,
      confidence: CONFIDENCE.VERIFIED,
      method:     methodLabel,
      extra: {
        viaTorrent:  t.infoHash,
        viaFile:     fileName,
        viaFileSize: firstFile.size,
      },
    };
  }
  return null;
}

// Default qBittorrent verifier. Tries content-match (round-trip
// verified) first; if that produces no result, falls through to the
// historical known-paths-prefix-match (inferred only).
//
// Reads `ctx.memo.knownPaths` if the orchestrator has cached it for
// this sweep — both the `daemonKnownPathsCandidates` generator and
// this verifier need the same list; pulling it twice per sweep (and
// once per candidate within a sweep) wasted daemon round-trips.
async function _qbittorrentKnownPathsVerifier(creds, ctx) {
  const content = await _tryContentMatchAgainstTorrents(creds, ctx, CLIENT_TYPE.QBITTORRENT, 'qbittorrent:content-match');
  if (content) { return content; }
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

// Default Deluge verifier. Same shape as qBittorrent's — content-match
// first (round-trip verified), known-paths-prefix-match second
// (inferred). Deluge's JSON-RPC has no free-space-style direct probe,
// so this chain is the only way to reach `verified` confidence
// without operator intervention.
async function _delugeKnownPathsVerifier(creds, ctx) {
  const content = await _tryContentMatchAgainstTorrents(creds, ctx, CLIENT_TYPE.DELUGE, 'deluge:content-match');
  if (content) { return content; }
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

/**
 * Generator 5: learned prefixes. For every prefix that has produced
 * a `verified` result against this client during the process's
 * lifetime, emit `<prefix>/<vpath.name>` as a candidate. Empty list
 * before the first verified hit; populated thereafter.
 *
 * The cache is per-client because Transmission and qBittorrent
 * pointed at the same daemon-side directories CAN have different
 * daemonPath views (different bind mounts / different containers).
 * Conflating prefixes across clients would generate false-positive
 * candidates that waste probes.
 */
export function learnedPrefixCandidates(vpath, clientType) {
  const prefixes = _getLearnedPrefixes(clientType);
  return prefixes.map(p => ({
    daemonPath:        `${p}/${vpath.name}`,
    mstreamMirrorPath: vpath.root_path,
    source:            'auto:learned-prefix',
  }));
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
      // Phase B: only `verified` results feed the learned-prefix
      // cache. `inferred` hits are still useful for the operator's
      // current vpath but propagating them across vpaths would
      // compound a guess into a confidently-wrong mapping. The
      // _prefixFromVerifiedPath helper drops anything malformed
      // silently — recording is best-effort.
      if (r.confidence === CONFIDENCE.VERIFIED) {
        const prefix = _prefixFromVerifiedPath(vpath, c.daemonPath);
        if (prefix) { _recordVerifiedPrefix(clientType, prefix); }
      }
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
  // Order matters — earlier candidates short-circuit later ones.
  //   1. bare-metal: free probe (no daemon call) for the
  //      "mStream and daemon see identical paths" case.
  //   2. learned prefixes: exploit the most recent verified ground
  //      truth before guessing. Empty before the first successful
  //      sweep, then high signal-to-noise once populated.
  //   3. daemon-known-paths: the daemon's own config — strong
  //      signal but produces 4-8 candidates per vpath.
  //   4. symlink/realpath: resolve a single rename via fs.realpath.
  //   5. default Docker conventions: last-resort static guesses.
  all.push(...bareMetalCandidates(vpath));
  all.push(...learnedPrefixCandidates(vpath, clientType));
  all.push(...(await daemonKnownPathsCandidates(vpath, creds, clientType, memo)));
  all.push(...(await symlinkAndRealpathCandidates(vpath)));
  all.push(...defaultDockerCandidates(vpath));
  // Dedupe by daemonPath so a learned prefix and a daemon-known-path
  // pointing at the same dir don't probe the same candidate twice.
  // Preserves the first occurrence (earlier-source wins).
  const seen = new Set();
  const deduped = [];
  for (const c of all) {
    const key = c.daemonPath.replace(/\/+$/, '');
    if (seen.has(key)) { continue; }
    seen.add(key);
    deduped.push(c);
  }
  return autoDetectMapping(vpath, creds, clientType, deduped, memo);
}
