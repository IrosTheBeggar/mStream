// Federation endpoint — the THIRD iroh persona (@number0/iroh v1), alongside
// the remote-access tunnel (state/iroh.js) and the discovery sidecar. Its own
// secretKey (config.federation.secretKey), its own ALPN, no discovery/gossip:
// pairing is ticket-swap only.
//
// Shape: same TCP-over-QUIC tunnel as state/iroh.js — accepted bi-streams
// bridge to the local mStream HTTP server, so a paired peer speaks plain HTTP
// (range requests, keep-alive) and authenticates every request with its
// x-federation-key header at the auth wall (api/federation-auth.js).
//
// The pipe gate differs from the tunnel's fixed shared secret: the FIRST
// bi-stream carries the peer's minted federation key. The server looks it up
// in federation_keys and TOFU-binds the dialer's EndpointId on first use —
// after the legitimate peer redeems its ticket, the same key from any other
// endpoint is rejected (and logged loudly: that's the credential-theft
// signal). Revoking the key kills the pipe handshake, every HTTP request
// (per-request wall lookup), and any LIVE connections via the registry below.
//
// Outbound dialing (connectToPeer) uses the SAME bound endpoint, not a
// throwaway like the tunnel client — the peer's TOFU binding needs a stable
// dialer EndpointId across reconnects.
//
// PORTABILITY: identical lazy-load contract to the tunnel — importing this
// module never throws; a missing native binary surfaces in start() and the
// boot site leaves the feature off.

import winston from 'winston';
import {
  loadIroh,
  asBuffer,
  delay,
  bridgeStreamToBackend,
  buildEnvelope,
  parseEnvelope,
} from './iroh-common.js';
import * as fedDb from '../db/federation.js';

// ALPN — both ends must present identical bytes; Array<number> per the v1
// binding. Bump the version if the handshake framing changes.
export const FEDERATION_ALPN = Array.from(Buffer.from('mstream/federation/1'));

const HANDSHAKE_LIMIT = 128; // fedk_ keys are 48 chars; anything bigger is garbage
const CONNECT_TIMEOUT_MS = 25000;

// Failed-handshake backoff, per remote EndpointId. The endpoint is publicly
// dialable and there's no global rate limiter, so after BACKOFF_THRESHOLD
// consecutive failures a remote is dropped on sight for BACKOFF_MS. In-memory
// only — a reboot forgives, which is fine for what this guards against
// (scripted retry loops, not offline attacks on a 256-bit key).
const BACKOFF_THRESHOLD = 5;
const BACKOFF_MS = 60 * 1000;
const failedHandshakes = new Map(); // remoteId -> { fails, blockedUntil }

// Server state
let irohMod = null;
let endpoint = null;
let endpointIdStr = null;

// Live authorized connections per key id, so revoking a key can sever its
// open pipes instead of waiting for the peer to reconnect and fail.
const liveConns = new Map(); // keyId -> Set<conn>

// ---------------------------------------------------------------------------
// Federation ticket: "mstrfed<V>:<base64url(JSON)>". Payload:
//   t  (required) this server's federation EndpointTicket string
//   k  (required) the minted read-only API key ('fedk_…')
//   n  (optional) server display name, for the friend's add-peer preview
//   l  (optional) granted vpath names — informational; the health endpoint
//                 is the live source of truth after pairing
// Unknown fields are ignored (forward compat). Spec: docs/federation-ticket.md.
// Unlike the tunnel QR, this carries a STANDING credential — swap it over a
// private channel; TOFU burn-on-redeem + per-key revocation are the backstops.
// ---------------------------------------------------------------------------

export const FEDERATION_TICKET_PREFIX = 'mstrfed';
export const FEDERATION_TICKET_VERSION = 1;

export function buildFederationTicket({ endpointTicket, key, serverName, libraries }) {
  const payload = { t: endpointTicket, k: key };
  if (serverName) { payload.n = serverName; }
  if (Array.isArray(libraries) && libraries.length > 0) { payload.l = libraries; }
  return buildEnvelope(FEDERATION_TICKET_PREFIX, FEDERATION_TICKET_VERSION, payload);
}

// Pure (no native module). Throws on garbage, a missing prefix (no bare-body
// legacy for a brand-new format), a too-new version, or missing fields.
export function parseFederationTicket(str) {
  const { version, payload } = parseEnvelope(str, {
    prefix: FEDERATION_TICKET_PREFIX,
    maxVersion: FEDERATION_TICKET_VERSION,
    allowBare: false,
    label: 'federation ticket',
  });
  if (!payload || typeof payload.t !== 'string' || typeof payload.k !== 'string') {
    throw new Error('Invalid federation ticket (missing fields)');
  }
  return {
    version,
    endpointTicket: payload.t,
    apiKey: payload.k,
    name: typeof payload.n === 'string' ? payload.n : null,
    libraries: Array.isArray(payload.l) ? payload.l.filter((x) => typeof x === 'string') : [],
  };
}

// ---------------------------------------------------------------------------
// Inbound: accept loop + key handshake with TOFU
// ---------------------------------------------------------------------------

function isBackedOff(remote) {
  const entry = failedHandshakes.get(remote);
  if (!entry) { return false; }
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) { return true; }
  if (entry.blockedUntil && entry.blockedUntil <= Date.now()) { failedHandshakes.delete(remote); }
  return false;
}

function recordHandshakeFailure(remote) {
  const entry = failedHandshakes.get(remote) || { fails: 0, blockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= BACKOFF_THRESHOLD) {
    entry.blockedUntil = Date.now() + BACKOFF_MS;
    winston.warn(`[federation] backing off ${remote} for ${BACKOFF_MS / 1000}s after ${entry.fails} failed handshakes`);
  }
  failedHandshakes.set(remote, entry);
}

// First bi-stream carries the raw key. Look it up, enforce/establish the TOFU
// binding, reply OK/NO. Returns the key row on success, null otherwise.
async function authenticateConnection(conn, remote) {
  const authBi = await conn.acceptBi();
  const sent = Buffer.from(await authBi.recv.readToEnd(HANDSHAKE_LIMIT)).toString('utf8');

  let keyRow = sent.startsWith(fedDb.FEDERATION_KEY_PREFIX) ? fedDb.getFederationKeyByKey(sent) : undefined;
  let ok = false;
  if (!keyRow) {
    winston.warn(`[federation] rejected connection from ${remote}: unknown key`);
  } else {
    if (keyRow.bound_endpoint_id === null) {
      // TOFU: first redemption binds the key to this dialer. The guarded
      // UPDATE loses gracefully if a concurrent handshake (or a revoke)
      // got there first — either way, re-read and require an exact match.
      if (fedDb.bindFederationKeyEndpoint(keyRow.id, remote)) {
        winston.info(`[federation] key '${keyRow.name}' bound to endpoint ${remote} (first use)`);
      }
      keyRow = fedDb.getFederationKeyById(keyRow.id);
    }
    ok = Boolean(keyRow && keyRow.bound_endpoint_id === remote);
    if (keyRow && !ok) {
      // The one log line that matters most: a KNOWN key from the WRONG
      // endpoint means the ticket leaked (or the friend reinstalled — the
      // admin reset-binding action covers that case).
      winston.warn(`[federation] rejected key '${keyRow.name}' from ${remote}: bound to ${keyRow.bound_endpoint_id} (possible leaked ticket)`);
    }
  }

  try {
    await authBi.send.writeAll(Array.from(Buffer.from(ok ? 'OK' : 'NO')));
    await authBi.send.finish();
  } catch (_err) { /* peer may have hung up */ }
  return ok ? keyRow : null;
}

function trackConn(keyId, conn) {
  if (!liveConns.has(keyId)) { liveConns.set(keyId, new Set()); }
  liveConns.get(keyId).add(conn);
}

function untrackConn(keyId, conn) {
  const set = liveConns.get(keyId);
  if (!set) { return; }
  set.delete(conn);
  if (set.size === 0) { liveConns.delete(keyId); }
}

// Best-effort severing of a revoked key's open pipes. The DB row is already
// gone by the time this runs, so new handshakes and HTTP requests fail on
// their own; this just stops an existing tunnel from coasting on keep-alives.
export function closeConnectionsForKey(keyId) {
  const set = liveConns.get(keyId);
  if (!set) { return 0; }
  let closed = 0;
  for (const conn of set) {
    try { conn.close(1n, Array.from(Buffer.from('revoked'))); closed += 1; } catch (_err) { /* already gone */ }
  }
  liveConns.delete(keyId);
  return closed;
}

// Per-connection loop: bridge each subsequent bi-stream to the local HTTP
// server until the connection closes (identical to the tunnel).
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
        if (isBackedOff(remote)) {
          try { conn.close(1n, Array.from(Buffer.from('backoff'))); } catch (_err) { /* noop */ }
          return;
        }
        const keyRow = await authenticateConnection(conn, remote);
        if (!keyRow) {
          recordHandshakeFailure(remote);
          try { conn.close(1n, Array.from(Buffer.from('unauthorized'))); } catch (_err) { /* noop */ }
          return;
        }
        failedHandshakes.delete(remote);
        trackConn(keyRow.id, conn);
        winston.info(`[federation] peer connection authorized: key '${keyRow.name}' from ${remote}`);
        try {
          await acceptConnection(conn, targetHost, targetPort);
        } finally {
          untrackConn(keyRow.id, conn);
        }
        winston.info(`[federation] peer connection closed: key '${keyRow.name}' (${remote})`);
      } catch (err) {
        winston.debug(`[federation] incoming connection dropped (${remote}): ${err?.message}`);
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Start the federation endpoint.
//   targetPort  (required) local mStream HTTP port accepted streams bridge to.
//   targetHost  backend host, default loopback.
//   secretKey   32-byte endpoint identity (config.federation.secretKey).
//   awaitOnline wait (bounded) for a home relay so issued tickets carry relay
//               info (default true).
// Returns { endpointId }. Throws if the native module can't load.
export async function start({ targetPort, targetHost = '127.0.0.1', secretKey, awaitOnline = true } = {}) {
  if (endpoint) { return { endpointId: endpointIdStr }; }
  if (!targetPort) { throw new Error('federation.start: targetPort is required'); }

  irohMod = await loadIroh();
  const { Endpoint } = irohMod;

  const options = { alpns: [FEDERATION_ALPN] };
  if (secretKey) { options.secretKey = Array.from(asBuffer(secretKey)); }
  endpoint = await Endpoint.bind(options);
  endpointIdStr = endpoint.id().toString();

  if (awaitOnline) {
    await Promise.race([endpoint.online().catch(() => {}), delay(8000)]);
  }

  runAcceptLoop(targetHost, targetPort); // detached; ends when the endpoint closes
  winston.info(`[federation] endpoint up — endpointId=${endpointIdStr} -> ${targetHost}:${targetPort}`);
  return { endpointId: endpointIdStr };
}

export function getEndpointId() { return endpointIdStr; }

export function getEndpointAddr() {
  if (!endpoint) { return null; }
  return endpoint.addr();
}

// This server's federation EndpointTicket string (goes into minted tickets),
// or null when the endpoint isn't running.
export function getEndpointTicket() {
  if (!endpoint || !irohMod) { return null; }
  return irohMod.EndpointTicket.fromAddr(endpoint.addr()).toString();
}

export async function stop() {
  if (!endpoint) { return; }
  try { await endpoint.close(); } catch (_err) { /* best effort */ }
  endpoint = null;
  endpointIdStr = null;
  liveConns.clear();
  failedHandshakes.clear();
}

// ---------------------------------------------------------------------------
// Outbound: dial a peer from THIS endpoint (stable identity for their TOFU)
// ---------------------------------------------------------------------------

// Connect to a peer's federation endpoint and complete the key handshake.
// Requires the local endpoint to be running (federation.enabled) — dialing
// from a throwaway endpoint would present a different EndpointId every time
// and trip the peer's TOFU binding.
// Returns the open conn; callers open bi-streams per TCP connection and hand
// them to bridge() (see state/federation-client.js).
export async function connectToPeer(endpointTicketStr, apiKey) {
  if (!endpoint) { throw new Error('federation endpoint is not running (enable federation first)'); }
  const addr = irohMod.EndpointTicket.fromString(endpointTicketStr).endpointAddr();
  const conn = await Promise.race([
    endpoint.connect(addr, FEDERATION_ALPN),
    new Promise((_r, rej) => setTimeout(() => rej(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)),
  ]);

  // Key handshake on the first bi-stream. The server rejects by CLOSING with
  // reason "unauthorized"/"backoff", which can surface as a thrown transport
  // error instead of a readable non-OK body — same wrapped-read handling as
  // the tunnel client.
  const authBi = await conn.openBi();
  await authBi.send.writeAll(Array.from(Buffer.from(apiKey)));
  await authBi.send.finish();
  let resp;
  try {
    resp = Buffer.from(await authBi.recv.readToEnd(8)).toString('utf8');
  } catch (err) {
    if (/unauthorized|backoff|revoked/i.test(err?.message || '')) {
      throw new Error('federation handshake rejected (bad or revoked key)', { cause: err });
    }
    throw err;
  }
  if (resp !== 'OK') {
    throw new Error('federation handshake rejected (bad or revoked key)');
  }
  return conn;
}
