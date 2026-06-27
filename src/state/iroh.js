// Iroh peer-to-peer remote-access tunnel for mStream (@number0/iroh v1).
//
// Goal: let a paired device reach this mStream server from anywhere — no
// port-forwarding, DDNS, or reverse proxy — by dialing the server's
// cryptographic EndpointId instead of an IP:port.
//
// Shape ("iroh as a transport tunnel"): we DON'T touch mStream's existing
// HTTP/Subsonic/DLNA stack. We bind an Iroh endpoint that accepts QUIC
// connections on a custom ALPN and proxies each bi-directional stream to the
// local mStream HTTP server on 127.0.0.1:<port>. One QUIC stream per client TCP
// connection, so full HTTP semantics (keep-alive, range/seek, parallel
// requests) are preserved — a plain TCP-over-QUIC tunnel.
//
// Access control (the "pipe gate"): the Iroh connection is authenticated +
// encrypted end-to-end by Iroh, but knowing the EndpointId alone is not enough
// to open the tunnel. Right after connecting, the client must prove knowledge of
// a shared `connectSecret` (carried inside the QR) over a one-shot handshake on
// the FIRST bi-stream; the server compares it constant-time and drops the
// connection on mismatch. The secret travels inside 1-RTT encrypted stream data
// (not the sniffable QUIC ALPN). mStream's normal auth wall still gates the API
// behind the tunnel — the secret only gates the pipe.
//
// PORTABILITY: @number0/iroh is an optional, prebuilt-native dependency with no
// binary for some platforms (e.g. Intel macOS). It is loaded LAZILY via dynamic
// import inside start()/connectTunnel(), so importing this module never throws;
// the boot site wraps start() in try/catch and simply leaves the feature off if
// the binary can't load.
//
// --- v1 API notes ---
//  * Bind with Endpoint.bind({secretKey, alpns}); POLL endpoint.acceptNext().
//  * recv.read(limit) RETURNS a byte array (EOF == empty array); writeAll()/
//    connect() take Array<number>, NOT Buffers. reset()/stop() take bigint.

import net from 'net';
import crypto from 'crypto';
import winston from 'winston';

// ALPN for the mStream tunnel — both ends must present identical bytes.
// v1 wants ALPNs as Array<number>. Bump the version if framing changes.
export const TUNNEL_ALPN = Array.from(Buffer.from('mstream/tunnel/2'));

const READ_CHUNK = 64 * 1024;
const HANDSHAKE_LIMIT = 256; // max bytes accepted for the auth handshake

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Lazily import the native module exactly once. Kept out of module scope so a
// missing/unloadable binary only surfaces when the feature is actually used.
let irohMod = null;
async function loadIroh() {
  if (!irohMod) { irohMod = await import('@number0/iroh'); }
  return irohMod;
}

// Normalize a secret given as a Buffer/Uint8Array/Array or a base64 string.
function asBuffer(secret) {
  if (typeof secret === 'string') { return Buffer.from(secret, 'base64'); }
  return Buffer.from(secret);
}

// Server state
let endpoint = null;        // the live Iroh endpoint (null when stopped)
let endpointIdStr = null;   // cached base32 EndpointId string
let connectSecretBuf = null; // Buffer the handshake compares against

// ---------------------------------------------------------------------------
// Generic byte pumps bridging an Iroh bi-stream <-> a Node TCP socket.
// ---------------------------------------------------------------------------

// Drain an Iroh recv stream into a TCP socket. v1 read(limit) returns a byte
// array; an empty array signals clean EOF. On clean EOF we half-close the socket
// (socket.end — NOT destroy) so an in-flight response keeps flowing. Errors
// propagate so bridge() can tear down the partner direction.
export async function pumpRecvToSocket(recv, socket) {
  for (;;) {
    const chunk = await recv.read(READ_CHUNK);
    if (chunk.length === 0) { break; }
    if (!socket.write(Buffer.from(chunk))) {
      await new Promise((resolve) => {
        const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
        socket.once('drain', done);
        socket.once('close', done);
      });
    }
    if (socket.destroyed || socket.writableEnded) { break; }
  }
  if (!socket.destroyed) { socket.end(); }
}

// Pump a TCP socket into an Iroh send stream (backpressure via async iteration).
// v1 writeAll wants Array<number>. Errors propagate so bridge() disposes the partner.
export async function pumpSocketToSend(socket, send) {
  for await (const chunk of socket) {
    await send.writeAll(Array.from(chunk));
  }
  await send.finish();
}

// Couple a connected TCP socket and an Iroh bi-stream into a full-duplex tunnel.
// If EITHER direction errors, dispose() force-tears-down both halves so the
// partner can't park. dispose() is idempotent and also runs once both settle.
export function bridge(socket, bi) {
  let disposed = false;
  const dispose = () => {
    if (disposed) { return; }
    disposed = true;
    try { socket.destroy(); } catch (_err) { /* already gone */ }
    bi.recv.stop(0n).catch(() => {});
    bi.send.reset(0n).catch(() => {});
  };
  // dispose() is the ABNORMAL-teardown path only. On clean completion each pump
  // closes its own half gracefully (recv EOF -> socket.end(); socket EOF ->
  // send.finish()), and we must NOT then reset()/stop() the streams: a reset
  // racing the peer's final read surfaces as a spurious "Reset(0)" on the other
  // end (truncating/erroring an otherwise-complete response). So only dispose
  // when a direction ERRORS — that tears down the partner so it can't park.
  socket.once('error', (err) => { winston.debug(`[iroh] tunnel socket error: ${err.message}`); dispose(); });
  pumpRecvToSocket(bi.recv, socket).catch((err) => { winston.debug(`[iroh] recv->socket pump ended: ${err?.message}`); dispose(); });
  pumpSocketToSend(socket, bi.send).catch((err) => { winston.debug(`[iroh] socket->send pump ended: ${err?.message}`); dispose(); });
}

// ---------------------------------------------------------------------------
// Composite ticket (what the QR encodes): EndpointTicket + connectSecret.
// ---------------------------------------------------------------------------

// Pairing-code envelope: "mstr<version>:<base64url(JSON payload)>".
// The two version axes are independent: this is the PAIRING-CODE version (what
// fields are in the QR), distinct from the TUNNEL_ALPN wire version above.
// Full spec: docs/iroh-pairing-code.md.
export const PAIRING_PREFIX = 'mstr';
export const PAIRING_VERSION = 1; // highest pairing-code version this build emits/understands

// Build the pairing code the QR carries. v1 payload = { t: <EndpointTicket>, s: <secret base64> }.
export function buildCompositeTicket(ticketStr, secret) {
  const payload = { t: ticketStr, s: asBuffer(secret).toString('base64') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${PAIRING_PREFIX}${PAIRING_VERSION}:${body}`;
}

// Parse a pairing code -> { version, ticket: <EndpointTicket string>, secret: <base64 string> }.
// Pure (no native module needed). Accepts the versioned `mstr<V>:` envelope and,
// for back-compat, a bare base64url(JSON) body (treated as implicit v1). Rejects
// a version newer than this build understands with an actionable error.
export function parseCompositeTicket(code) {
  const str = String(code).trim();
  let version = 1;
  let body = str;
  const m = str.match(/^mstr(\d+):(.*)$/s);
  if (m) {
    version = Number(m[1]);
    body = m[2];
  }
  if (version > PAIRING_VERSION) {
    throw new Error(`Pairing code is version ${version}; this build supports up to v${PAIRING_VERSION}. Update to a newer version.`);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error('Invalid pairing code', { cause: err });
  }
  if (!payload || typeof payload.t !== 'string' || typeof payload.s !== 'string') {
    throw new Error('Invalid pairing code (missing fields)');
  }
  return { version, ticket: payload.t, secret: payload.s };
}

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

// Wire one accepted Iroh bi-stream to a fresh TCP connection to the backend.
function bridgeStreamToBackend(bi, targetHost, targetPort) {
  const socket = net.connect({ host: targetHost, port: targetPort });
  let started = false;
  socket.once('connect', () => { started = true; bridge(socket, bi); });
  socket.once('error', (err) => {
    if (started) { return; } // bridge() now owns teardown
    winston.warn(`[iroh] backend connect failed (${targetHost}:${targetPort}): ${err.message}`);
    bi.send.reset(0n).catch(() => {});
    bi.recv.stop(0n).catch(() => {});
  });
}

// Validate the shared-secret handshake on a freshly-accepted connection. The
// client's FIRST bi-stream carries the secret; we compare constant-time and
// reply OK / NO. Returns true iff the secret matched.
async function authenticateConnection(conn) {
  const authBi = await conn.acceptBi();
  const sent = Buffer.from(await authBi.recv.readToEnd(HANDSHAKE_LIMIT));
  const ok = sent.length === connectSecretBuf.length && crypto.timingSafeEqual(sent, connectSecretBuf);
  try {
    await authBi.send.writeAll(Array.from(Buffer.from(ok ? 'OK' : 'NO')));
    await authBi.send.finish();
  } catch (_err) { /* peer may have hung up */ }
  return ok;
}

// Per-connection tunnel loop: accept bi-streams (after the auth stream) and
// bridge each to the backend until the connection closes.
async function acceptConnection(conn, targetHost, targetPort) {
  for (;;) {
    let bi;
    try {
      bi = await conn.acceptBi();
    } catch (_err) {
      break; // connection closed by peer / transport error
    }
    bridgeStreamToBackend(bi, targetHost, targetPort);
  }
}

// Top-level accept loop: pull incoming connections, complete the handshake, and
// hand authorized connections to acceptConnection. Unauthorized peers are closed.
async function runAcceptLoop(targetHost, targetPort) {
  for (;;) {
    let incoming;
    try {
      incoming = await endpoint.acceptNext();
    } catch (_err) {
      break; // endpoint closing
    }
    if (incoming === null) { break; } // endpoint closed
    (async () => {
      let remote = '(unknown)';
      try {
        const accepting = await incoming.accept();
        const conn = await accepting.connect();
        try { remote = conn.remoteId().toString(); } catch (_err) { /* noop */ }
        const authed = await authenticateConnection(conn);
        if (!authed) {
          winston.warn(`[iroh] rejected connection from ${remote} (bad connect secret)`);
          try { conn.close(1n, Array.from(Buffer.from('unauthorized'))); } catch (_err) { /* noop */ }
          return;
        }
        winston.info(`[iroh] tunnel connection authorized: ${remote}`);
        await acceptConnection(conn, targetHost, targetPort);
        winston.info(`[iroh] tunnel connection closed: ${remote}`);
      } catch (err) {
        winston.debug(`[iroh] incoming connection dropped (${remote}): ${err?.message}`);
      }
    })();
  }
}

// Start the tunnel.
//   targetPort    (required) local port to proxy accepted streams to (mStream).
//   targetHost    backend host, default loopback.
//   secretKey     32-byte endpoint identity (Buffer/array or base64 string).
//   connectSecret shared pipe secret (Buffer or base64 string) the client must present.
//   awaitOnline   wait (bounded) for a home relay so the ticket has relay info (default true).
// Returns { endpointId }. Throws if the native module can't load (caller handles).
export async function start({ targetPort, targetHost = '127.0.0.1', secretKey, connectSecret, awaitOnline = true } = {}) {
  if (endpoint) { return { endpointId: endpointIdStr }; }
  if (!targetPort) { throw new Error('iroh.start: targetPort is required'); }
  if (!connectSecret) { throw new Error('iroh.start: connectSecret is required'); }

  const { Endpoint } = await loadIroh();
  connectSecretBuf = asBuffer(connectSecret);

  const options = { alpns: [TUNNEL_ALPN] };
  if (secretKey) { options.secretKey = Array.from(asBuffer(secretKey)); }
  endpoint = await Endpoint.bind(options);
  endpointIdStr = endpoint.id().toString();

  if (awaitOnline) {
    await Promise.race([endpoint.online().catch(() => {}), delay(8000)]);
  }

  runAcceptLoop(targetHost, targetPort); // detached; ends when the endpoint closes
  winston.info(`[iroh] tunnel up — endpointId=${endpointIdStr} -> ${targetHost}:${targetPort}`);
  return { endpointId: endpointIdStr };
}

// The base32 EndpointId string, or null if not started.
export function getEndpointId() { return endpointIdStr; }

// The EndpointAddr (id + relay + direct addresses), or null if not started.
export function getEndpointAddr() {
  if (!endpoint) { return null; }
  return endpoint.addr();
}

// The composite QR string (EndpointTicket + connectSecret), or null if not started.
export function getTicket() {
  if (!endpoint || !irohMod) { return null; }
  const ticketStr = irohMod.EndpointTicket.fromAddr(endpoint.addr()).toString();
  return buildCompositeTicket(ticketStr, connectSecretBuf);
}

export function getEndpoint() { return endpoint; }

export async function stop() {
  if (!endpoint) { return; }
  try { await endpoint.close(); } catch (_err) { /* best effort */ }
  endpoint = null;
  endpointIdStr = null;
  connectSecretBuf = null;
}

// Generate a fresh 32-byte secret (used for both the endpoint key and the
// connect secret). Returns a Buffer.
export function generateSecretKey() {
  return crypto.randomBytes(32);
}

// ---------------------------------------------------------------------------
// Client side (used by the dev scripts and, later, the desktop/mobile clients).
// ---------------------------------------------------------------------------

// Dial a tunnel from a composite ticket and complete the secret handshake.
// Returns { client, conn } — open per-TCP-connection streams with conn.openBi()
// and hand them to bridge(). Throws on auth failure / unreachable server.
export async function connectTunnel(compositeTicket, { awaitOnline = true } = {}) {
  const { ticket, secret } = parseCompositeTicket(compositeTicket);
  const { Endpoint, EndpointTicket } = await loadIroh();

  const client = await Endpoint.bind({});
  // Cross-network: establish our own home relay BEFORE dialing, else the first
  // stream can reset on a not-ready path.
  if (awaitOnline) {
    await Promise.race([client.online().catch(() => {}), delay(8000)]);
  }

  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const conn = await Promise.race([
    client.connect(addr, TUNNEL_ALPN),
    new Promise((_r, rej) => setTimeout(() => rej(new Error('connect timed out after 25s')), 25000)),
  ]);

  // Secret handshake on the first bi-stream.
  const authBi = await conn.openBi();
  await authBi.send.writeAll(Array.from(Buffer.from(secret, 'base64')));
  await authBi.send.finish();
  // The server rejects a bad secret by *closing* the connection with reason
  // "unauthorized" (see runAcceptLoop) rather than replying with a non-"OK"
  // body. Depending on timing/platform that surfaces here either as an empty
  // read (resp !== 'OK' below) or as a thrown ConnectionLost/ApplicationClosed
  // error — so the read must be wrapped, otherwise the raw QUIC error escapes
  // on some platforms (it did on Linux) instead of the clean rejection.
  let resp;
  try {
    resp = Buffer.from(await authBi.recv.readToEnd(8)).toString('utf8');
  } catch (err) {
    try { await client.close(); } catch (_err) { /* noop */ }
    if (/unauthorized/i.test(err?.message || '')) {
      throw new Error('tunnel handshake rejected (bad connect secret)', { cause: err });
    }
    throw err;
  }
  if (resp !== 'OK') {
    try { await client.close(); } catch (_err) { /* noop */ }
    throw new Error('tunnel handshake rejected (bad connect secret)');
  }
  return { client, conn };
}
