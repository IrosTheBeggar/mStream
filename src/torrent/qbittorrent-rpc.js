// Minimal qBittorrent WebAPI v2 client. Different shape from
// Transmission's RPC: form-encoded login at /api/v2/auth/login returns
// a session cookie (`QBT_SID` or `QBT_SID_<port>`) which authorises
// subsequent GET calls. The cookie expires when the daemon restarts —
// we cache it per host:port and re-login on 401/403.
//
// Auth response shapes seen in the wild:
//   qBittorrent ≤ 4.5  → 200 with body 'Ok.' / 'Fails.' + Set-Cookie
//   qBittorrent ≥ 5.x  → 204 No Content + Set-Cookie on success;
//                        403 + body 'Fails.' on wrong creds
// We accept either by treating "Set-Cookie present" as success.
//
// Threat model matches the Transmission client: localhost / trusted
// LAN. We don't pin TLS, don't reject self-signed certs (the operator
// controls the daemon), and don't do CSRF beyond what qBittorrent
// requires — modern versions accept any Referer when CSRF protection
// is off, which is the default for headless/server deployments.

import { mapFetchError } from './rpc-errors.js';
import { STATUS } from './constants.js';
import { infoHashFromMetainfo, infoHashFromMagnet } from './info-hash.js';

// Bounded session cache. See deluge-rpc.js for the rationale —
// insertion-order eviction via Map iteration keeps memory predictable
// when an admin re-tests many hosts over the lifetime of the process.
const _SESSION_CACHE_MAX = 32;
const _sessionCache = new Map();
function _setSessionCacheEntry(key, value) {
  if (_sessionCache.has(key)) { _sessionCache.delete(key); }
  _sessionCache.set(key, value);
  while (_sessionCache.size > _SESSION_CACHE_MAX) {
    _sessionCache.delete(_sessionCache.keys().next().value);
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

function _cacheKey(host, port) {
  return `${host}:${port}`;
}

export function normaliseCreds(raw) {
  let host = (raw.host || '').trim();
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    host,
    port:     raw.port || 8080,
    username: raw.username || '',
    password: raw.password || '',
    useHttps: !!raw.useHttps,
  };
}

function _baseUrl(c) {
  return `${c.useHttps ? 'https' : 'http'}://${c.host}:${c.port}`;
}

// Exported with the underscore convention used elsewhere in the
// codebase for test-only access. Regression tests live in
// test/torrent-qbit-rpc.test.mjs and pin the cookie-name shapes
// across qBit versions we support.
export { _extractSid };
// Reach into the Set-Cookie header and pull out the qBittorrent SID.
// Cookie name varies by version:
//   - v4.4+ default (Linux/Docker)                 → `SID`
//   - v4.5.3 native-Windows                         → `SID`
//   - newer / alt-port builds                       → `QBT_SID`
//                                                   → `QBT_SID_<port>`
// The "QBT_SID" prefix was the historical assumption — it left the
// bare `SID` case broken against widely-deployed Windows 4.x. The
// match is anchored to either a `SID=` or `QBT_SID...` exact-prefix
// cookie name so we don't accidentally grab unrelated cookies a
// reverse-proxy might inject (e.g. `mySIDproxy=`).
function _extractSid(setCookieHeaders) {
  if (!setCookieHeaders) { return null; }
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of arr) {
    // Each entry looks like `SID=abc123; HttpOnly; path=/` or
    // `QBT_SID_8080=abc123; HttpOnly; path=/`. We want the first
    // name=value chunk; the rest are attributes we ignore (HttpOnly
    // etc. are server-set; we re-send the cookie via our own request).
    const first = raw.split(';')[0];
    // `QBT_SID(_<port>)?=…` covers QBT_SID and the alt-port form
    // (e.g. QBT_SID_8080=…). Plain `SID=…` is the v4.5.x form.
    // The trailing `=` anchor prevents matching unrelated cookies
    // whose names happen to contain "SID" (e.g. `mySIDproxy=`).
    if (/^(QBT_SID(_\d+)?|SID)=/i.test(first)) { return first; }
  }
  return null;
}

async function _login(c, { timeoutMs }) {
  let res;
  try {
    res = await fetch(`${_baseUrl(c)}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: c.username, password: c.password }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw mapFetchError(err, { host: c.host, port: c.port, timeoutMs });
  }

  if (res.status === 401 || res.status === 403) {
    // qBittorrent emits multiple flavours of "no":
    //   401: typical wrong-credentials response in v5.x
    //   403: "user banned for X minutes after too many failed
    //        attempts" in some versions, or plain wrong creds in
    //        others. Body is 'Fails.' or empty.
    // We can't reliably distinguish ban-vs-bad-password from the
    // status alone, so the message names both.
    throw new Error('Authentication failed (check username/password — qBittorrent may also be temporarily banning this IP after repeated failures)');
  }

  // 200 + body 'Fails.' is the older-version wrong-creds response.
  if (res.status === 200) {
    const body = await res.text();
    if (body.trim() === 'Fails.') {
      throw new Error('Authentication failed (check username/password)');
    }
  }

  // 200/204 + Set-Cookie = success.
  const sid = _extractSid(res.headers.getSetCookie?.());
  if (!sid) {
    throw new Error(`Login succeeded (HTTP ${res.status}) but no session cookie was returned`);
  }
  _setSessionCacheEntry(_cacheKey(c.host, c.port), sid);
  return sid;
}

/**
 * Run a fetch against the daemon with the cached session cookie,
 * re-logging once on 401/403 (stale cookie after daemon restart).
 *
 * `doRequest(sid)` is the per-call fetch — it should construct the
 * request with `headers: { cookie: sid, ... }`. This helper handles:
 *   - obtaining a fresh sid via _login on cache miss
 *   - mapping fetch network errors via mapFetchError
 *   - the 401/403 retry-once-with-fresh-login pattern
 *
 * Used by _apiGet, addTorrent, and any future qBittorrent operation
 * — keeps the auth flow in exactly one place.
 */
async function _withAuth(creds, opts, doRequest) {
  const c = normaliseCreds(creds);
  if (!c.host) { throw new Error('Host is required'); }
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt < 2; attempt++) {
    let sid = _sessionCache.get(_cacheKey(c.host, c.port));
    if (!sid) { sid = await _login(c, { timeoutMs }); }

    let res;
    try { res = await doRequest(sid, c, timeoutMs); }
    catch (err) { throw mapFetchError(err, { host: c.host, port: c.port, timeoutMs }); }

    if (res.status === 401 || res.status === 403) {
      // Cookie went stale (daemon restart, eviction, etc.). Drop and
      // re-login once; if that also fails we surface the real error.
      _sessionCache.delete(_cacheKey(c.host, c.port));
      if (attempt === 0) { continue; }
      throw new Error(`Authentication failed (HTTP ${res.status})`);
    }
    return res;
  }
  throw new Error('Auth retry exhausted');
}

/**
 * GET an API endpoint with auth. Returns parsed JSON (or raw text if
 * the endpoint doesn't return JSON — `app/version`, for instance,
 * returns a plain string).
 */
async function _apiGet(creds, endpoint, opts = {}) {
  const parseAs = opts.parseAs || 'json';
  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}${endpoint}`, {
      method: 'GET',
      headers: { cookie: sid },
      signal:  AbortSignal.timeout(timeoutMs),
    }));
  if (!res.ok) { throw new Error(`HTTP ${res.status} ${res.statusText}`); }
  if (parseAs === 'text') { return await res.text(); }
  try { return await res.json(); }
  catch { throw new Error('Server response was not JSON'); }
}

/**
 * Hand a torrent to the daemon. Mirrors transmission-rpc.addTorrent
 * — same shape, same return value — so the route handler can
 * dispatch on clientType without branching.
 *
 *   addTorrent(creds, { metainfo: Buffer,  downloadDir, paused? })
 *   addTorrent(creds, { magnet:   string,  downloadDir, paused? })
 *
 * qBittorrent's /api/v2/torrents/add takes multipart/form-data:
 *   torrents   — file field for .torrent uploads
 *   urls       — text field for magnet URIs (one per line)
 *   savepath   — destination directory
 *   paused     — 'true' / 'false' (string)
 *
 * The endpoint responds 200 with body "Ok." or "Fails." (older
 * versions) or 200 with no body / 200 "Ok." on newer builds.
 * Critically: it does NOT return the info hash, so callers must
 * compute it themselves from the metainfo or magnet BEFORE calling.
 * That's why this function returns `{ infoHash: null }` — the
 * caller knows the hash; we just confirm the add was accepted.
 */
export async function addTorrent(creds, { metainfo, magnet, downloadDir, paused = false }, opts = {}) {
  if (!metainfo && !magnet) { throw new Error('addTorrent: provide metainfo or magnet'); }
  if (!downloadDir) { throw new Error('addTorrent: downloadDir is required'); }

  // Detect duplicates by pre-checking /torrents/info. qBittorrent's
  // /torrents/add returns "Ok." for both fresh adds AND existing
  // duplicates with no way to distinguish from the response alone,
  // so we look up the expected hash first. Compute the hash locally
  // (cheap — same code path the route uses) and ask qBittorrent
  // whether it's already in the session. The pre-check adds one
  // round-trip on the happy path but is the only reliable way to
  // surface "already added" to the UI.
  //
  // Best-effort: if the hash compute fails or the lookup throws, we
  // continue with isDuplicate: null (= unknowable) so the caller can
  // render a neutral status rather than asserting either way.
  let expectedHash = null;
  let isDuplicate  = null;
  try {
    expectedHash = metainfo
      ? infoHashFromMetainfo(metainfo).infoHash
      : infoHashFromMagnet(magnet).infoHash;
  } catch { /* unparseable input — caller will hit the same error later */ }
  if (expectedHash) {
    try {
      const existing = await qbittorrentInfo(creds, expectedHash, opts);
      isDuplicate = Array.isArray(existing) && existing.length > 0;
    } catch { /* lookup failed — leave isDuplicate as null (unknowable) */ }
  }

  // Build the multipart body. Constructed inside the request closure
  // below so a stale-cookie retry doesn't try to re-send a consumed
  // FormData / Blob stream.
  const buildBody = () => {
    const fd = new FormData();
    fd.append('savepath', downloadDir);
    fd.append('paused',   paused ? 'true' : 'false');
    if (metainfo) {
      // Node's global FormData + Blob accept the Buffer-like Uint8Array
      // directly. Naming the file is required by qBittorrent's
      // multipart parser; the actual filename doesn't matter — it
      // dedupes by info hash.
      fd.append('torrents', new Blob([metainfo], { type: 'application/x-bittorrent' }), 'upload.torrent');
    } else {
      fd.append('urls', magnet);
    }
    return fd;
  };

  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { cookie: sid },  // fetch sets the multipart boundary itself
      body:    buildBody(),
      signal:  AbortSignal.timeout(timeoutMs),
    }));

  if (!res.ok) { throw new Error(`add failed: HTTP ${res.status}`); }
  const body = (await res.text()).trim();
  if (body === 'Fails.') {
    throw new Error('qBittorrent rejected the torrent (Fails.)');
  }
  // Success — caller already knows the hash they computed locally.
  // Surface the duplicate determination from the pre-check.
  return { infoHash: null, name: '', isDuplicate };
}

/**
 * Single-hash variant of /api/v2/torrents/info. Returns the row array
 * (length 0 or 1). Separated so addTorrent's pre-check can reuse it
 * without pulling in the verbose listTorrents path.
 */
export async function qbittorrentInfo(creds, infoHash, opts = {}) {
  const params = new URLSearchParams({ hashes: infoHash.toLowerCase() });
  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}/api/v2/torrents/info?${params.toString()}`, {
      headers: { cookie: sid },
      signal:  AbortSignal.timeout(timeoutMs),
    }));
  if (!res.ok) { throw new Error(`torrents/info failed: HTTP ${res.status}`); }
  return res.json();
}

// ── Tag-probe helpers (Tier 3) ───────────────────────────────────────
// Used by src/torrent/tag-probe.js. Each is a thin wrapper over a
// single qBittorrent endpoint, all routed through _withAuth so they
// share the same session-cookie + retry behaviour as the rest of the
// module.

/**
 * Set file priorities. `ids` is an array of file indices.
 *   priority 0 = skip (won't download)
 *   priority 7 = max (download first)
 * qBittorrent's endpoint expects ids joined with `|`.
 */
export async function qbittorrentFilePrio(creds, infoHash, ids, priority, opts = {}) {
  const params = new URLSearchParams({
    hash:     infoHash,
    id:       ids.join('|'),
    priority: String(priority),
  });
  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}/api/v2/torrents/filePrio?${params.toString()}`, {
      method:  'GET',
      headers: { cookie: sid },
      signal:  AbortSignal.timeout(timeoutMs),
    }));
  if (!res.ok) { throw new Error(`filePrio failed: HTTP ${res.status}`); }
}

/**
 * Resume a paused torrent. qBittorrent <= 4.x used /api/v2/torrents/resume;
 * v5+ renamed it to /start. We try /start first and fall back to
 * /resume on 404 so the module works against either era.
 */
export async function qbittorrentResume(creds, infoHash, opts = {}) {
  const body = new URLSearchParams({ hashes: infoHash }).toString();
  // Try /start first (v5+ canonical), fall back to /resume.
  for (const endpoint of ['/api/v2/torrents/start', '/api/v2/torrents/resume']) {
    const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
      fetch(`${_baseUrl(c)}${endpoint}`, {
        method:  'POST',
        headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal:  AbortSignal.timeout(timeoutMs),
      }));
    if (res.status === 404) { continue; }
    if (!res.ok) { throw new Error(`resume failed: HTTP ${res.status}`); }
    return;
  }
  throw new Error('resume failed: neither /start nor /resume accepted by daemon');
}

/**
 * Remove a torrent. `deleteFiles=true` tells qBittorrent to also
 * remove the downloaded files alongside the torrent record. Used by
 * the tag-probe's cleanup branch.
 */
export async function qbittorrentDelete(creds, infoHash, deleteFiles, opts = {}) {
  const body = new URLSearchParams({
    hashes: infoHash,
    deleteFiles: deleteFiles ? 'true' : 'false',
  }).toString();
  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}/api/v2/torrents/delete`, {
      method:  'POST',
      headers: { cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(timeoutMs),
    }));
  if (!res.ok) { throw new Error(`delete failed: HTTP ${res.status}`); }
}

/**
 * Per-file state for a torrent. Returns the raw qBittorrent response
 * (array of `{name, size, progress, priority, …}`) — tag-probe uses
 * this for polling the target file's `progress` field.
 */
export async function qbittorrentTorrentFiles(creds, infoHash, opts = {}) {
  const params = new URLSearchParams({ hash: infoHash });
  const res = await _withAuth(creds, opts, (sid, c, timeoutMs) =>
    fetch(`${_baseUrl(c)}/api/v2/torrents/files?${params.toString()}`, {
      method:  'GET',
      headers: { cookie: sid },
      signal:  AbortSignal.timeout(timeoutMs),
    }));
  if (!res.ok) { throw new Error(`torrents/files failed: HTTP ${res.status}`); }
  try { return await res.json(); }
  catch { throw new Error('torrents/files: non-JSON response'); }
}

/**
 * Pull the daemon's configured directories. Used by the path-probe
 * `daemonKnownPathsCandidates` generator and by the prefix-matching
 * verifier (which uses these as the "known-good" set against which
 * candidate daemon paths are compared).
 *
 * Returns
 *   [{ label: 'save_path',        path: '/downloads' },
 *    { label: 'temp_path',        path: '/downloads/.incomplete' },
 *    { label: 'scan_dir',         path: '/watch' },
 *    { label: 'category:music',   path: '/downloads/music' }]
 *
 * Tolerant of partial data — qBittorrent's preferences omit
 * temp_path when the temp-path feature is off, and categories may be
 * empty. Each section is fenced in its own try/catch so one bad
 * subquery doesn't lose the whole list.
 */
// Drop trailing slashes for path-equality comparisons. qBittorrent's
// config exposes save_path with whatever the operator typed in
// (sometimes '/downloads', sometimes '/downloads/'), and category
// savePaths frequently lack the trailing slash. A naive strict-string
// compare can then list category:foo as a distinct candidate that
// effectively duplicates save_path. Normalize before comparing.
function _normalizePath(p) {
  return typeof p === 'string' ? p.replace(/\/+$/, '') : p;
}

export async function getKnownPaths(creds, opts) {
  const out = [];
  let prefs;
  try { prefs = await _apiGet(creds, '/api/v2/app/preferences', opts); }
  catch { return out; }

  const seen = new Set();
  const pushPath = (label, raw) => {
    const norm = _normalizePath(raw);
    if (!norm || seen.has(norm)) { return; }
    seen.add(norm);
    out.push({ label, path: raw });
  };

  if (prefs.save_path) {
    pushPath('save_path', prefs.save_path);
  }
  if (prefs.temp_path_enabled && prefs.temp_path) {
    pushPath('temp_path', prefs.temp_path);
  }
  if (prefs.scan_dirs && typeof prefs.scan_dirs === 'object') {
    for (const k of Object.keys(prefs.scan_dirs)) {
      pushPath('scan_dir', k);
    }
  }

  try {
    const cats = await _apiGet(creds, '/api/v2/torrents/categories', opts);
    if (cats && typeof cats === 'object') {
      for (const [name, c] of Object.entries(cats)) {
        if (c?.savePath) {
          pushPath(`category:${name}`, c.savePath);
        }
      }
    }
  } catch { /* categories unavailable on this qBittorrent build — skip */ }

  return out;
}

/**
 * Probe the daemon. Resolves to `{version}` on success; throws with a
 * human-readable message on failure. Symmetric with
 * transmission-rpc.testConnection — the admin endpoint dispatches on
 * client type without caring which RPC dialect it speaks.
 */
export async function testConnection(creds, opts) {
  const version = await _apiGet(creds, '/api/v2/app/version', { ...opts, parseAs: 'text' });
  return {
    version:    (version || '').trim() || null,
    rpcVersion: null, // qBittorrent doesn't expose an RPC version number
  };
}

// qBittorrent's `state` enum is a flat list of strings rather than
// Transmission's integer + error pair. Normalise to the same shape
// the UI already understands. Unknown states fall through to
// 'unknown' rather than masquerading as one of the standard states.
const _STATE_MAP = {
  // Active states
  downloading:        STATUS.DOWNLOADING,
  metaDL:             STATUS.DOWNLOADING,
  forcedDL:           STATUS.DOWNLOADING,
  stalledDL:          STATUS.DOWNLOADING,
  uploading:          STATUS.SEEDING,
  forcedUP:           STATUS.SEEDING,
  stalledUP:          STATUS.SEEDING,
  // Suspended states
  pausedDL:           STATUS.PAUSED,
  pausedUP:           STATUS.PAUSED,
  stoppedDL:          STATUS.PAUSED,  // v5+ renamed pausedDL → stoppedDL
  stoppedUP:          STATUS.PAUSED,
  queuedDL:           STATUS.QUEUED,
  queuedUP:           STATUS.QUEUED,
  // Verifying / moving
  checkingDL:         STATUS.VERIFYING,
  checkingUP:         STATUS.VERIFYING,
  checkingResumeData: STATUS.VERIFYING,
  allocating:         STATUS.VERIFYING,
  moving:             STATUS.VERIFYING,
  // Terminal failure
  error:              STATUS.ERROR,
  missingFiles:       STATUS.ERROR,
  // Default
  unknown:            STATUS.UNKNOWN,
};

/**
 * List every torrent the daemon currently knows about. Returns the
 * same normalised shape as transmission-rpc.listTorrents — UI never
 * sees qBittorrent's `state` strings or its `progress` 0-to-1
 * convention raw.
 */
export async function listTorrents(creds, opts) {
  const rows = await _apiGet(creds, '/api/v2/torrents/info', opts);
  if (!Array.isArray(rows)) { return []; }
  return rows.map(r => ({
    // qBittorrent's `hash` is the same lowercase btih hex as
    // Transmission's `hashString`. The numeric "id" Transmission
    // exposes has no qBittorrent equivalent — qB identifies torrents
    // by hash everywhere. Surface `null` so consumers know it's
    // unavailable rather than fabricating one.
    clientTorrentId: null,
    infoHash:        (r.hash || '').toLowerCase(),
    name:            r.name || '',
    status:          _STATE_MAP[r.state] || 'unknown',
    percent:         typeof r.progress === 'number' ? r.progress : 0,
    rateDownload:    r.dlspeed || 0,
    rateUpload:      r.upspeed || 0,
    // qB uses `eta = 8640000` (100 days) as "infinite/unknown". Map
    // those to -1 so the UI's "no ETA" branch fires consistently with
    // the Transmission path.
    eta:             (typeof r.eta === 'number' && r.eta < 8640000) ? r.eta : -1,
    sizeBytes:       r.size       || 0,
    downloadedBytes: r.downloaded || r.completed || 0,
    // qBittorrent never returns a separate errorString; the most useful
    // surrogate is the human-readable state on 'error' / 'missingFiles'.
    errorMessage:    (r.state === 'error' || r.state === 'missingFiles') ? r.state : '',
    addedAt:         r.added_on      || 0,
    doneAt:          r.completion_on || 0,
    // Where the daemon believes the torrent's files live. The
    // content-match path-probe verifier reads these — savePath is
    // the root the torrent was added with; contentPath is the
    // effective path including the info-name subdir (multi-file) or
    // the filename (single-file). qBit may return either or both
    // depending on torrent state; we surface whichever is non-empty.
    savePath:        r.save_path    || '',
    contentPath:     r.content_path || '',
  }));
}
