// Shared error-mapping for the torrent RPC clients. Both Transmission
// and qBittorrent talk over `fetch`, and both need to translate the
// node-side network-error palette into human-readable messages the
// admin UI can surface verbatim. The mapping was identical across
// the two modules; pulling it here keeps a single source of truth so
// new clients (Deluge, rTorrent, …) inherit the same messages
// without copy-paste drift.
//
// Callers wrap their `fetch` in try/catch and pipe the error through
// `mapFetchError(err, ctx)`. Anything we don't recognise falls
// through to the original error message, which preserves whatever
// detail node was already willing to give us.

export function mapFetchError(err, { host, port, timeoutMs }) {
  if (err.name === 'TimeoutError') {
    return new Error(`Connection timed out after ${timeoutMs} ms`);
  }
  const cause = err.cause?.code || err.code;
  if (cause === 'ECONNREFUSED') { return new Error(`Connection refused at ${host}:${port}`); }
  if (cause === 'ENOTFOUND')    { return new Error(`Host not found: ${host}`); }
  if (cause === 'EHOSTUNREACH') { return new Error(`Host unreachable: ${host}`); }
  return new Error(err.message || 'Network error');
}
