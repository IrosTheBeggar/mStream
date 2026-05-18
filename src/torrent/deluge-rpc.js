// Minimal Deluge WebAPI JSON-RPC client. Same surface as the
// transmission/qbittorrent modules so the path-probe orchestrator,
// admin dispatcher, and Tier 3 tag-probe can dispatch on
// clientType without branching.
//
// Protocol shape:
//   POST /json   body {method, params, id}
//   Returns     {result, error, id}
//
// Auth: a single session cookie set by `auth.login`. We cache it
// per host:port, just like qBittorrent's QBT_SID. On 401/403 or an
// `Not authenticated` error result, we drop the cookie and retry
// once.
//
// Threat model + style mirrors the other two RPC modules.

import { mapFetchError } from './rpc-errors.js';
import { STATUS } from './constants.js';
import { infoHashFromMetainfo, infoHashFromMagnet } from './info-hash.js';

// Bounded session cache. The Map is keyed by host:port; a single
// mStream instance typically talks to one Deluge daemon, so this cap
// is conservative. The cap exists to bound memory in pathological
// cases (admin re-tests dozens of hosts) and to give us insertion-
// order eviction "for free" via Map iteration.
const _SESSION_CACHE_MAX = 32;
const _sessionCache       = new Map();
function _setSessionCacheEntry(key, value) {
  // Refresh insertion order so recently-used entries stay alive.
  if (_sessionCache.has(key)) { _sessionCache.delete(key); }
  _sessionCache.set(key, value);
  while (_sessionCache.size > _SESSION_CACHE_MAX) {
    const oldest = _sessionCache.keys().next().value;
    _sessionCache.delete(oldest);
    _daemonAttachedCache.delete(oldest);
  }
}
// Tracks which (host:port) sessions have already attached to a
// daemon. Deluge's WebUI is a separate process from the daemon (even
// in single-process Docker images they communicate via JSON-RPC),
// and `core.*` methods only work after `web.connect(host_id)` has
// been called for the current session. We do this once per cached
// session and remember it here.
const _daemonAttachedCache = new Set();
const DEFAULT_TIMEOUT_MS   = 5000;

function _cacheKey(host, port) { return `${host}:${port}`; }
function _baseUrl(c) { return `${c.useHttps ? 'https' : 'http'}://${c.host}:${c.port}`; }

// Coalesces a Joi-validated creds object into a stable shape. Same
// normalisation rules as the other RPC modules.
export function normaliseCreds(raw) {
  let host = (raw.host || '').trim();
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    host,
    port:     raw.port || 8112,
    password: raw.password || '',
    useHttps: !!raw.useHttps,
  };
}

// Sequential request-id counter. Deluge echoes the id back in the
// response; we don't strictly need it but it's part of the JSON-RPC
// envelope and using sequential ids keeps debug logs sensible.
let _rpcId = 0;

async function _rawRpc(c, method, params, sid, timeoutMs) {
  const headers = { 'content-type': 'application/json' };
  if (sid) { headers.cookie = sid; }
  let res;
  try {
    res = await fetch(`${_baseUrl(c)}/json`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ method, params, id: ++_rpcId }),
      signal:  AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw mapFetchError(err, { host: c.host, port: c.port, timeoutMs });
  }
  return res;
}

async function _login(c, { timeoutMs }) {
  const res = await _rawRpc(c, 'auth.login', [c.password], null, timeoutMs);
  if (res.status === 401 || res.status === 403) {
    throw new Error('Authentication failed (check password)');
  }
  if (!res.ok) { throw new Error(`Login failed: HTTP ${res.status}`); }

  // Parse the body FIRST — Deluge returns `result: false` on wrong
  // password but still sets a Set-Cookie header (the session cookie
  // tracks the failed-auth state). Don't be misled by the cookie's
  // presence into thinking auth succeeded.
  let body;
  try { body = await res.json(); } catch { throw new Error('Login response was not JSON'); }
  if (body.error) { throw new Error(`Login: ${body.error.message || JSON.stringify(body.error)}`); }
  if (body.result === false) { throw new Error('Authentication failed (check password)'); }

  // Auth succeeded — pull the session cookie out of Set-Cookie.
  const cookies = res.headers.getSetCookie?.() || [];
  const sid = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('_session_id='));
  if (!sid) { throw new Error('Login succeeded but no _session_id cookie was returned'); }
  _setSessionCacheEntry(_cacheKey(c.host, c.port), sid);
  return sid;
}

// Invalidate both the session cookie and the daemon-attached flag for
// a given host:port. The attached flag is tied to the session — a new
// login means a new session that hasn't called web.connect yet, so
// keeping the old attached marker would leave core.* calls failing
// until process restart. The two caches must always evict together.
function _invalidateSession(key) {
  _sessionCache.delete(key);
  _daemonAttachedCache.delete(key);
}

// Auth wrapper. Mirrors qBittorrent's _withAuth. Re-logs once on
// 401/403, on a JSON-RPC `Not authenticated` error code, or on a
// daemon-side `Not Connected` error (which means web.connect needs
// to be called again — typically after the WebUI restarted).
async function _call(creds, method, params, opts = {}) {
  const c = normaliseCreds(creds);
  if (!c.host) { throw new Error('Host is required'); }
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const key = _cacheKey(c.host, c.port);

  for (let attempt = 0; attempt < 2; attempt++) {
    let sid = _sessionCache.get(key);
    if (!sid) { sid = await _login(c, { timeoutMs }); }

    const res = await _rawRpc(c, method, params, sid, timeoutMs);
    if (res.status === 401 || res.status === 403) {
      _invalidateSession(key);
      if (attempt === 0) { continue; }
      throw new Error(`Authentication failed (HTTP ${res.status})`);
    }
    if (!res.ok) { throw new Error(`HTTP ${res.status} ${res.statusText}`); }

    let body;
    try { body = await res.json(); }
    catch { throw new Error('Server response was not JSON'); }

    if (body.error) {
      // Deluge returns {message, code} on errors. Code 1 is
      // "Not Authenticated"; "Not Connected" comes from core.* methods
      // when the WebUI lost (or never had) its daemon attachment.
      // Both are recoverable: drop the cached state and retry once.
      const msg = body.error.message || JSON.stringify(body.error);
      const isAuth = /not authenticated/i.test(msg);
      const isDetached = /not connected/i.test(msg);
      if ((isAuth || isDetached) && attempt === 0) {
        _invalidateSession(key);
        continue;
      }
      throw new Error(`RPC error: ${msg}`);
    }
    return body.result;
  }
  throw new Error('Auth retry exhausted');
}

/**
 * Ensure the WebUI is attached to a daemon. Deluge's `core.*` methods
 * are routed through the WebUI to the daemon over the daemon's own
 * RPC channel; if the WebUI hasn't called `web.connect(host_id)` for
 * the current session, every core.* call comes back "Unknown method".
 *
 * We cache the "attached" state per session so this runs at most
 * once per (host, port) until the session cookie expires. On cache
 * miss: query `web.connected`; if false, list hosts and connect to
 * the first one (Deluge stock config always has at least the
 * localhost host_id pre-populated).
 */
async function _ensureDaemonAttached(creds, opts) {
  const c = normaliseCreds(creds);
  const key = _cacheKey(c.host, c.port);
  if (_daemonAttachedCache.has(key)) { return; }

  const connected = await _call(creds, 'web.connected', [], opts);
  if (connected === true) {
    _daemonAttachedCache.add(key);
    return;
  }

  // Not connected — pull the host list and attach to the first one.
  // get_hosts returns [[host_id, ip, port, name], ...]
  const hosts = await _call(creds, 'web.get_hosts', [], opts);
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('Deluge WebUI has no daemon hosts configured');
  }
  const hostId = hosts[0]?.[0];
  if (!hostId) {
    throw new Error('Deluge WebUI host list is malformed');
  }
  await _call(creds, 'web.connect', [hostId], opts);
  _daemonAttachedCache.add(key);
}

// ── Public surface — matches transmission-rpc + qbittorrent-rpc ──────

/**
 * Probe the daemon. Resolves to `{version, rpcVersion}` on success;
 * throws with a human-readable message on every failure mode.
 */
export async function testConnection(creds, opts) {
  // Auth + daemon-attach. After this, all core.* methods are
  // available. Version comes from daemon.info — best-effort, but
  // since we just attached we should always get it.
  await _ensureDaemonAttached(creds, opts);
  let version = null;
  try {
    const info = await _call(creds, 'daemon.info', [], opts);
    if (typeof info === 'string') { version = info; }
  } catch { /* swallow — auth + attach worked, that's the contract */ }
  return { version, rpcVersion: null };
}

/**
 * Pull the daemon's configured directories. Used by the path-probe
 * `daemonKnownPathsCandidates` generator and by the prefix-matching
 * verifier (Deluge, like qBittorrent, has no free-space-style
 * round-trip probe).
 */
export async function getKnownPaths(creds, opts) {
  const out = [];
  try {
    await _ensureDaemonAttached(creds, opts);
    const cfg = await _call(creds, 'core.get_config', [], opts);
    if (cfg?.download_location) { out.push({ label: 'download_location', path: cfg.download_location }); }
    if (cfg?.move_completed && cfg?.move_completed_path) {
      out.push({ label: 'move_completed_path', path: cfg.move_completed_path });
    }
    // Deluge's `torrentfiles_location` is where .torrent files
    // themselves are stashed — usually not the download target, but
    // commonly the same physical filesystem, so worth knowing.
    if (cfg?.torrentfiles_location) {
      out.push({ label: 'torrentfiles_location', path: cfg.torrentfiles_location });
    }
  } catch { /* swallow — empty list = "unknown paths" */ }
  return out;
}

/**
 * Hand a torrent to the daemon. Mirrors the other clients' contract.
 *   addTorrent(creds, { metainfo: Buffer,  downloadDir, paused? })
 *   addTorrent(creds, { magnet:   string,  downloadDir, paused? })
 *
 * Deluge's add takes options as a dict — `download_location` (NOT
 * `download_dir` like Transmission), `add_paused`. Magnet-vs-file
 * uses different methods: `core.add_torrent_magnet` and
 * `core.add_torrent_file` respectively.
 *
 * Returns `{infoHash, name: '', isDuplicate}`. The hash is what
 * Deluge echoes back; `name` and `isDuplicate` are detected best-
 * effort. Deluge doesn't always cleanly signal duplicates — a
 * second add of the same hash returns the same hash without an
 * error, so we treat "same hash returned" as success and let the
 * caller's managed_torrents UPSERT dedupe.
 */
export async function addTorrent(creds, { metainfo, magnet, downloadDir, paused = false }, opts) {
  if (!metainfo && !magnet) { throw new Error('addTorrent: provide metainfo or magnet'); }
  if (!downloadDir) { throw new Error('addTorrent: downloadDir is required'); }
  await _ensureDaemonAttached(creds, opts);

  const options = {
    download_location: downloadDir,
    add_paused:        !!paused,
  };

  let hash;
  try {
    if (metainfo) {
      // core.add_torrent_file takes [filename, base64-data, options].
      // The filename is a label only — daemon doesn't read it from disk.
      const base64 = Buffer.from(metainfo).toString('base64');
      hash = await _call(creds, 'core.add_torrent_file', ['add.torrent', base64, options], opts);
    } else {
      hash = await _call(creds, 'core.add_torrent_magnet', [magnet, options], opts);
    }
  } catch (err) {
    // Deluge raises AddTorrentError with the message "Torrent already
    // in session (<hash>)" for duplicates. Catch that specific case
    // and return a clean duplicate result rather than propagating it
    // as a generic "daemon rejected" error to the caller.
    const m = /already in session\s*\(([0-9a-f]{40})\)/i.exec(err.message || '');
    if (m) {
      return { infoHash: m[1].toLowerCase(), name: '', isDuplicate: true };
    }
    throw err;
  }
  if (hash && typeof hash === 'string') {
    return { infoHash: hash.toLowerCase(), name: '', isDuplicate: false };
  }
  // Deluge returns null for two distinct reasons:
  //   1) the torrent is already in the session (duplicate)
  //   2) the add failed for some other reason (bad metainfo, daemon
  //      out of disk, etc.)
  // Previously we returned `{ infoHash: null, isDuplicate: true }`
  // unconditionally, which caused the caller to write a managed_torrents
  // row for a torrent that might not actually exist on the daemon. To
  // distinguish: compute the expected hash locally and query the
  // daemon for it. If the daemon has it, it's a genuine duplicate;
  // otherwise the add really failed and we throw so the caller can
  // surface a daemon_rejected error.
  let expectedHash;
  try {
    expectedHash = metainfo
      ? infoHashFromMetainfo(metainfo).infoHash
      : infoHashFromMagnet(magnet).infoHash;
  } catch (err) {
    // We couldn't even compute the hash from the input, so we can't
    // verify duplicate-ness. The add result was null, so something
    // went wrong — surface it.
    throw new Error(`Deluge returned no hash and the source is unparseable: ${err.message}`);
  }
  let status;
  try {
    status = await _call(creds, 'core.get_torrent_status', [expectedHash, ['hash']], opts);
  } catch (err) {
    // Can't tell — fail loud rather than write a phantom row.
    throw new Error(`Deluge returned no hash for the add and lookup failed: ${err.message}`);
  }
  if (status && typeof status === 'object' && status.hash) {
    return { infoHash: expectedHash, name: '', isDuplicate: true };
  }
  throw new Error('Deluge accepted the request but the torrent is not present in the session (add probably failed)');
}

// Deluge status string → our normalised STATUS enum. Deluge's set is
// smaller than qBittorrent's: Allocating | Checking | Downloading |
// Seeding | Paused | Error | Queued | Moving | Active. Stick to the
// states that appear in real-world WebUI responses.
const _STATE_MAP = {
  Allocating:   STATUS.VERIFYING,
  Checking:     STATUS.VERIFYING,
  Moving:       STATUS.VERIFYING,
  Downloading:  STATUS.DOWNLOADING,
  Seeding:      STATUS.SEEDING,
  Paused:       STATUS.PAUSED,
  Queued:       STATUS.QUEUED,
  Error:        STATUS.ERROR,
  Active:       STATUS.DOWNLOADING,  // Deluge alias for "in some active state"
};

/**
 * List every torrent the daemon currently knows about. Normalised
 * to the shape transmission-rpc / qbittorrent-rpc return.
 */
export async function listTorrents(creds, opts) {
  await _ensureDaemonAttached(creds, opts);
  // core.get_torrents_status(filter_dict, keys) — we pass {} to
  // get everything, and the field list we actually care about.
  const fields = [
    'hash', 'name', 'state', 'progress', 'download_payload_rate',
    'upload_payload_rate', 'eta', 'total_size', 'all_time_download',
    'time_added', 'completed_time', 'message',
  ];
  const result = await _call(creds, 'core.get_torrents_status', [{}, fields], opts);
  if (!result || typeof result !== 'object') { return []; }

  return Object.entries(result).map(([hash, r]) => ({
    clientTorrentId: null,                       // Deluge identifies by hash everywhere
    infoHash:        (r.hash || hash).toLowerCase(),
    name:            r.name || '',
    status:          _STATE_MAP[r.state] || STATUS.UNKNOWN,
    // Deluge's `progress` is 0..100 (percent), not 0..1.
    percent:         typeof r.progress === 'number' ? r.progress / 100 : 0,
    rateDownload:    r.download_payload_rate || 0,
    rateUpload:      r.upload_payload_rate   || 0,
    eta:             (typeof r.eta === 'number' && r.eta > 0) ? r.eta : -1,
    sizeBytes:       r.total_size || 0,
    downloadedBytes: r.all_time_download || 0,
    errorMessage:    r.message && r.state === 'Error' ? r.message : '',
    addedAt:         r.time_added      || 0,
    doneAt:          r.completed_time  || 0,
  }));
}

// ── Tag-probe helpers (Tier 3) ───────────────────────────────────────
// Used by src/torrent/tag-probe.js. tag-probe currently only
// dispatches against Transmission and qBittorrent — Deluge gets
// added once the rest of the integration is verified.

export async function delugeSetFilePriorities(creds, infoHash, priorities, opts) {
  // core.set_torrent_options takes a hash list + options dict.
  // file_priorities is an array indexed by file index; values:
  // 0 = skip, 1 = low, 5 = normal, 7 = high (Deluge 2.x). For our
  // probe we pass [7 for target, 0 for others].
  await _call(creds, 'core.set_torrent_options', [[infoHash], { file_priorities: priorities }], opts);
}

export async function delugeResume(creds, infoHash, opts) {
  await _call(creds, 'core.resume_torrent', [[infoHash]], opts);
}

export async function delugeDelete(creds, infoHash, deleteFiles, opts) {
  await _call(creds, 'core.remove_torrent', [infoHash, !!deleteFiles], opts);
}

export async function delugeTorrentFiles(creds, infoHash, opts) {
  const status = await _call(creds, 'core.get_torrent_status', [infoHash, ['files', 'file_progress']], opts);
  if (!status || !Array.isArray(status.files)) { return []; }
  // Deluge returns parallel arrays: files[i] = {index, path, size},
  // file_progress[i] = 0..1.
  return status.files.map((f, i) => ({
    index:    f.index ?? i,
    name:     f.path,
    size:     f.size,
    progress: status.file_progress?.[i] ?? 0,
  }));
}
