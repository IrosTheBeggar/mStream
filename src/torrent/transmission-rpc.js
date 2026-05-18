// Minimal Transmission RPC client. The protocol is a single POST to
// /transmission/rpc carrying `{method, arguments}` JSON, gated by a
// CSRF token Transmission supplies via the `X-Transmission-Session-Id`
// response header on a 409 challenge. Standard handshake:
//
//   1. Client sends request, possibly with a cached session-id header.
//   2. If session-id missing/stale, Transmission responds 409 with the
//      fresh id in the response header.
//   3. Client retries the same request with the fresh id.
//
// The session-id rotates whenever the daemon restarts, so we cache per
// host:port and let the 409 retry repopulate the cache on its own.
// One retry is always sufficient — we never observe a second 409 in
// the same call.
//
// Auth is optional HTTP Basic. Threat model: localhost or trusted LAN.
// We don't attempt TLS pinning, certificate validation policy, or any
// of the heavier security surface — that's the operator's choice via
// `useHttps` + the system's trust store.

import { mapFetchError } from './rpc-errors.js';
import { STATUS } from './constants.js';

const _sessionIdCache = new Map();

const DEFAULT_TIMEOUT_MS = 5000;

function _cacheKey(host, port) {
  return `${host}:${port}`;
}

function _buildUrl({ useHttps, host, port, rpcPath }) {
  const proto  = useHttps ? 'https' : 'http';
  const path   = rpcPath || '/transmission/rpc';
  return `${proto}://${host}:${port}${path}`;
}

function _basicAuth(username, password) {
  if (!username && !password) { return null; }
  return 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
}

// Coalesces a Joi-validated creds object into a stable shape and
// normalises the host (strip protocol if the user pasted a URL).
export function normaliseCreds(raw) {
  let host = (raw.host || '').trim();
  // Tolerate "http://1.2.3.4" or "1.2.3.4/path" — strip to just the
  // host part. rpcPath is its own field.
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    host,
    port:     raw.port || 9091,
    username: raw.username || '',
    password: raw.password || '',
    rpcPath:  raw.rpcPath  || '/transmission/rpc',
    useHttps: !!raw.useHttps,
  };
}

/**
 * One-shot RPC call. Throws with a human-readable message on every
 * failure mode — connection refused, DNS failure, 401, 5xx, malformed
 * JSON, RPC `result` other than 'success'. Callers should wrap in
 * try/catch and surface `err.message` to the user.
 */
export async function rpcCall(creds, method, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const c   = normaliseCreds(creds);
  if (!c.host) { throw new Error('Host is required'); }
  const url = _buildUrl(c);
  const key = _cacheKey(c.host, c.port);

  const basic = _basicAuth(c.username, c.password);

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'content-type': 'application/json' };
    if (basic) { headers.authorization = basic; }
    const sid = _sessionIdCache.get(key);
    if (sid) { headers['x-transmission-session-id'] = sid; }

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ method, arguments: args }),
        signal:  AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // fetch throws on network failure / timeout / abort.
      throw mapFetchError(err, { host: c.host, port: c.port, timeoutMs });
    }

    if (res.status === 409) {
      const fresh = res.headers.get('x-transmission-session-id');
      if (!fresh) { throw new Error('Server returned 409 without a session-id header'); }
      _sessionIdCache.set(key, fresh);
      continue; // retry once
    }
    if (res.status === 401) { throw new Error('Authentication failed (check username/password)'); }
    if (res.status === 403) { throw new Error('Forbidden (check whitelist / RPC settings)'); }
    if (!res.ok)            { throw new Error(`HTTP ${res.status} ${res.statusText}`); }

    let body;
    try { body = await res.json(); }
    catch { throw new Error('Server response was not JSON (is this really Transmission RPC?)'); }

    if (body.result && body.result !== 'success') {
      throw new Error(`RPC error: ${body.result}`);
    }
    return body.arguments || {};
  }
  throw new Error('Failed to acquire session-id after retry');
}

/**
 * Hand a torrent to the daemon.
 *
 *   addTorrent(creds, { metainfo: Buffer,  downloadDir, paused? }) — file upload
 *   addTorrent(creds, { magnet:   string,  downloadDir, paused? }) — magnet
 *
 * Exactly one of `metainfo` / `magnet` must be supplied. Returns
 * `{ infoHash, name, isDuplicate }`. Transmission's `torrent-add`
 * returns `torrent-duplicate` instead of `torrent-added` when the
 * info hash matches an existing torrent; we treat duplicate as
 * non-fatal (caller decides whether that's an error) and surface the
 * flag.
 */
export async function addTorrent(creds, { metainfo, magnet, downloadDir, paused = false }, opts) {
  if (!metainfo && !magnet) { throw new Error('addTorrent: provide metainfo or magnet'); }
  if (!downloadDir) { throw new Error('addTorrent: downloadDir is required'); }

  const args = { 'download-dir': downloadDir, paused: !!paused };
  if (metainfo) {
    args.metainfo = Buffer.from(metainfo).toString('base64');
  } else {
    // Magnet URIs ride in `filename` per the Transmission RPC spec —
    // the field is mis-named for historical reasons.
    args.filename = magnet;
  }
  const r = await rpcCall(creds, 'torrent-add', args, opts);
  const added = r['torrent-added'] || r['torrent-duplicate'];
  if (!added) {
    throw new Error('torrent-add returned neither torrent-added nor torrent-duplicate');
  }
  return {
    infoHash:    (added.hashString || '').toLowerCase(),
    name:        added.name || '',
    isDuplicate: !!r['torrent-duplicate'],
  };
}

/**
 * Pull the daemon's configured directories. Used by the path-probe
 * `daemonKnownPathsCandidates` generator. Returns
 *   [{ label: 'download-dir',   path: '/downloads' },
 *    { label: 'incomplete-dir', path: '/downloads/.incomplete' }]
 *
 * `incomplete-dir` only appears if the daemon has `incomplete-dir-enabled`.
 * Symmetric with the qBittorrent helper of the same name so the
 * path-probe orchestrator can dispatch on clientType uniformly.
 */
export async function getKnownPaths(creds, opts) {
  const s = await rpcCall(creds, 'session-get', {}, opts);
  const out = [];
  if (s['download-dir']) {
    out.push({ label: 'download-dir', path: s['download-dir'] });
  }
  if (s['incomplete-dir-enabled'] && s['incomplete-dir']) {
    out.push({ label: 'incomplete-dir', path: s['incomplete-dir'] });
  }
  return out;
}

/**
 * Probe the daemon. Resolves to `{version, rpcVersion}` on success;
 * throws with a human-readable message on every failure mode.
 */
export async function testConnection(creds, opts) {
  const args = await rpcCall(creds, 'session-get', {}, opts);
  return {
    version:    args.version || null,
    rpcVersion: args['rpc-version'] || null,
  };
}

// Transmission status enum → normalised string. The numeric codes are
// stable across daemon versions (the protocol predates Transmission
// 2.0). Anything with a non-zero `error` field becomes 'error'
// regardless of the underlying status — that's how Transmission's own
// UI surfaces it too.
const _STATUS_BY_CODE = {
  0: STATUS.PAUSED,
  1: STATUS.QUEUED,
  2: STATUS.VERIFYING,
  3: STATUS.QUEUED,
  4: STATUS.DOWNLOADING,
  5: STATUS.QUEUED,
  6: STATUS.SEEDING,
};
function _normaliseStatus(row) {
  if (row.error && row.error !== 0) { return STATUS.ERROR; }
  return _STATUS_BY_CODE[row.status] || STATUS.UNKNOWN;
}

// Fields we ask the daemon for. Kept narrow on purpose — every field
// in this list traverses Transmission's RPC and our JSON pipeline on
// every poll; bloating it costs bandwidth and CPU. Add fields when a
// concrete UI requirement demands them.
const _LIST_FIELDS = [
  'id', 'hashString', 'name', 'status', 'error', 'errorString',
  'percentDone', 'rateDownload', 'rateUpload', 'eta',
  'totalSize', 'downloadedEver', 'addedDate', 'doneDate',
];

/**
 * List every torrent the daemon currently knows about. Resolves to an
 * array of normalised objects; throws on connection/auth/RPC failure.
 *
 * The returned shape is deliberately stable and decoupled from
 * Transmission's wire format — UI code should never see camelCase RPC
 * field names like `percentDone` or magic integers like `status: 4`.
 */
export async function listTorrents(creds, opts) {
  const args = await rpcCall(creds, 'torrent-get', { fields: _LIST_FIELDS }, opts);
  const rows = Array.isArray(args.torrents) ? args.torrents : [];
  return rows.map(r => ({
    clientTorrentId: r.id,
    infoHash:        (r.hashString || '').toLowerCase(),
    name:            r.name || '',
    status:          _normaliseStatus(r),
    percent:         typeof r.percentDone === 'number' ? r.percentDone : 0,
    rateDownload:    r.rateDownload || 0,
    rateUpload:      r.rateUpload   || 0,
    eta:             typeof r.eta === 'number' ? r.eta : -1,
    sizeBytes:       r.totalSize      || 0,
    downloadedBytes: r.downloadedEver || 0,
    errorMessage:    r.errorString || '',
    // Transmission emits these as unix seconds; pass through untouched.
    // `doneDate` is 0 for torrents that haven't finished.
    addedAt:         r.addedDate || 0,
    doneAt:          r.doneDate  || 0,
  }));
}
