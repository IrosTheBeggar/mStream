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

// Listen on 127.0.0.1:<ephemeral>. `publicServer()` returns the current
// public listener, `onConnection(socket)` sees every accepted socket, and
// `whileDown(req, res)` answers while the public listener is not listening
// (a recycle under way, a listen retry), when it has no app attached.
// Resolves to the listening http.Server; rejects if it cannot listen.
export function listenBridge({ publicServer, onConnection, whileDown }) {
  const srv = http.createServer();
  srv.on('connection', onConnection);
  srv.on('request', (req, res) => {
    const pub = publicServer();
    if (pub && pub.listening) { pub.emit('request', req, res); } else { whileDown(req, res); }
  });
  srv.on('upgrade', (req, socket, head) => {
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
