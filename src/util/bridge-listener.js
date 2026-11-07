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
//
// The same listener also comes in a local-socket form (`path`): a named
// pipe under Node on Windows, a socket file elsewhere. That is the fallback
// for a machine where something resets loopback TCP connections (security
// software, a VPN kill switch — a Windows report on mStream#1101): those
// filters work on IP traffic and never see a pipe or a socket file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import winston from 'winston';

// What whileDown says (the reboot stub), for an upgrade's raw socket.
const DOWN_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

// The phone app tags every request URL with `__lt=<token>` for its loopback
// proxy (the Rust shim from mstream-iroh-tunnel), which checks the first
// request line of each connection and forwards the bytes as sent. This
// listener is the only hop that sees each request, so it drops the parameter
// here, for requests and upgrades alike, and nothing else in the URL: a route
// whose query schema rejects unknown keys would otherwise answer 400 through
// the tunnel. Streams that fall back to the public port keep it.
const LOCAL_TOKEN_KEY = '__lt';
const LOCAL_TOKEN_PARAM = `${LOCAL_TOKEN_KEY}=`;

// `url` without its __lt parameter: the path, every other parameter and
// the fragment stay byte for byte, and a query left empty takes its '?'
// with it.
export function stripLocalToken(url) {
  const q = url.indexOf('?');
  if (q < 0 || !url.includes(LOCAL_TOKEN_KEY, q)) { return url; }
  const hash = url.indexOf('#', q);
  const end = hash < 0 ? url.length : hash;
  const query = url.slice(q + 1, end).split('&')
    .filter((p) => p !== LOCAL_TOKEN_KEY && !p.startsWith(LOCAL_TOKEN_PARAM))
    .join('&');
  return url.slice(0, q) + (query ? `?${query}` : '') + url.slice(end);
}

const PIPE_PREFIX = '\\\\.\\pipe\\';

// Where the local-socket form listens. Node on Windows listens on named
// pipes only; Bun on Windows takes a socket file (AF_UNIX), not a pipe;
// Linux and macOS take socket files. Per process plus a random tail, so two
// servers on one machine never share one, and short: AF_UNIX paths are
// capped at about a hundred bytes, which a deep data directory would exceed.
export function localSocketPath(platform = process.platform, bun = Boolean(process.versions.bun), tmp = os.tmpdir()) {
  const name = `mstream-bridge-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return platform === 'win32' && !bun ? `${PIPE_PREFIX}${name}` : join(tmp, `${name}.sock`);
}

const isSocketFile = (p) => !p.startsWith(PIPE_PREFIX);

// A socket from the local-socket form has no peer address; the app reads
// req.socket.remoteAddress (mayShareCode, the admin gate, trust proxy), so
// give it what a loopback TCP socket shows.
function stampLoopback(socket) {
  for (const [key, value] of Object.entries({ remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 0 })) {
    Object.defineProperty(socket, key, { value, configurable: true });
  }
}

// A socket file outlives a process that dies hard: the next listen unlinks
// it first, and a clean close or exit removes it.
function removeOnClose(srv, file) {
  const remove = () => { try { fs.unlinkSync(file); } catch (_err) { /* already gone */ } };
  srv.once('close', remove);
  process.once('exit', remove);
}

// Listen on 127.0.0.1:<ephemeral>, or on the local socket `path`.
// `publicServer()` returns the current public listener, `onConnection(socket)`
// sees every accepted socket, and `whileDown(req, res)` answers while the
// public listener is not listening (a recycle under way, a listen retry),
// when it has no app attached.
// Resolves to the listening http.Server; rejects if it cannot listen.
export function listenBridge({ publicServer, onConnection, whileDown, path: sockPath = null }) {
  const srv = http.createServer();
  srv.on('connection', (socket) => {
    if (sockPath) { stampLoopback(socket); }
    onConnection(socket);
  });
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
    const listening = () => {
      srv.off('error', reject);
      srv.on('error', (err) => winston.warn(`[iroh] bridge listener error: ${err.message}`));
      if (sockPath && isSocketFile(sockPath)) { removeOnClose(srv, sockPath); }
      resolve(srv);
    };
    if (!sockPath) { srv.listen(0, '127.0.0.1', listening); return; }
    if (isSocketFile(sockPath)) { try { fs.unlinkSync(sockPath); } catch (_err) { /* nothing stale */ } }
    srv.listen(sockPath, listening);
  });
}
