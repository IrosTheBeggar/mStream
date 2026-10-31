// The loopback listener the in-process iroh endpoints — Quick Connect
// (state/iroh.js) and federation (state/federation.js) — bridge their
// streams to (mStream#1101).
//
// A bridged stream is plain HTTP arriving from 127.0.0.1, and the public
// listener cannot be relied on to take it: bound to one interface (a LAN
// address) it refuses the loopback connect, and with TLS configured it drops
// the plaintext. Either way the pairing succeeds and every request after it
// dies. This listener is plain HTTP on 127.0.0.1 whatever the public bind
// is, and hands each request and upgrade to whatever the public listener
// serves at that moment (the app, the reboot stub, the /remote WebSocket
// server), so a reboot or a bind change needs nothing from it.
import http from 'node:http';
import winston from 'winston';

// What whileDown says (the reboot stub), for an upgrade's raw socket.
const DOWN_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

// The query parameter the phone app's loopback proxy (the Rust shim from
// mstream-iroh-tunnel) adds to every request URL, so it can tell its own
// app's connections from other local programs. The shim checks the token
// and forwards the request bytes as they are, so every request through
// Quick Connect reaches the web server with it, and a route whose query
// schema rejects unknown keys answers 400 ("__lt" is not allowed): the
// discovery plugin-jobs and downloads listings, the stats routes, the
// yt-dlp metadata lookup. Dropping it inside the shim is the fix that
// belongs there (a crate release and an app re-pin away); until then every
// bridged request and upgrade loses it here, and nothing else in its URL.
const LOCAL_TOKEN_KEY = '__lt';

// `url` without its __lt parameter: the path, every other parameter and
// the fragment stay byte for byte, and a query left empty takes its '?'
// with it.
export function stripLocalToken(url) {
  const q = url.indexOf('?');
  if (q < 0 || !url.includes(LOCAL_TOKEN_KEY, q)) { return url; }
  const hash = url.indexOf('#', q);
  const end = hash < 0 ? url.length : hash;
  const query = url.slice(q + 1, end).split('&')
    .filter((p) => p !== LOCAL_TOKEN_KEY && !p.startsWith(`${LOCAL_TOKEN_KEY}=`))
    .join('&');
  return url.slice(0, q) + (query ? `?${query}` : '') + url.slice(end);
}

// Listen on 127.0.0.1:<ephemeral>. `publicServer()` returns the current
// public listener, `onConnection(socket)` sees every accepted socket, and
// `whileDown(req, res)` answers while the public listener is not listening
// (a recycle under way, a listen retry), when it has no app attached.
// Resolves to the listening http.Server; rejects if it cannot listen.
export function listenBridge({ publicServer, onConnection, whileDown }) {
  const srv = http.createServer();
  srv.on('connection', onConnection);
  srv.on('request', (req, res) => {
    req.url = stripLocalToken(req.url);
    const pub = publicServer();
    if (pub && pub.listening) { pub.emit('request', req, res); } else { whileDown(req, res); }
  });
  srv.on('upgrade', (req, socket, head) => {
    req.url = stripLocalToken(req.url);
    const pub = publicServer();
    // emit() is false when nothing there takes upgrades: only between
    // remoteApi.stop() and its restart in a reboot, when the public listener
    // hands such a request to the reboot stub. Say what the stub says, as
    // whileDown does while it is not listening.
    if (!(pub && pub.listening && pub.emit('upgrade', req, socket, head))) { socket.end(DOWN_RESPONSE); }
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.off('error', reject);
      srv.on('error', (err) => winston.warn(`[iroh] bridge listener error: ${err.message}`));
      resolve(srv);
    });
  });
}
