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
import { verifyGuestToken } from './federation-guest.js';

// ALPN — both ends must present identical bytes; Array<number> per the v1
// binding. Bump the version if the handshake framing changes.
export const FEDERATION_ALPN = Array.from(Buffer.from('mstream/federation/1'));

// The first bi-stream carries either a fedk_ key (48 chars) or a guest
// token (a signed JWT — ~200 chars, see federation-guest.js); anything
// bigger than this is garbage.
const HANDSHAKE_LIMIT = 2048;
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
// In-flight stop(), or null — see state/iroh.js: a soft reboot's re-serve
// calls start() while the previous endpoint is still closing; start() must
// wait for that instead of no-oping on the closing endpoint.
let stopping = null;

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
//   e  (optional) ISO expiry of the key — informational, for the friend's
//                 add-peer preview; the minting server's row is the truth
//                 and enforcement never reads the ticket
// Unknown fields are ignored (forward compat). Spec: docs/federation-ticket.md.
// Unlike the tunnel QR, this carries a STANDING credential — swap it over a
// private channel; TOFU burn-on-redeem + per-key revocation are the backstops.
// ---------------------------------------------------------------------------

export const FEDERATION_TICKET_PREFIX = 'mstrfed';
export const FEDERATION_TICKET_VERSION = 1;

export function buildFederationTicket({ endpointTicket, key, serverName, libraries, expiresAt }) {
  const payload = { t: endpointTicket, k: key };
  if (serverName) { payload.n = serverName; }
  if (Array.isArray(libraries) && libraries.length > 0) { payload.l = libraries; }
  if (typeof expiresAt === 'string' && expiresAt) { payload.e = expiresAt; }
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
    expiresAt: typeof payload.e === 'string' ? payload.e : null,
  };
}

// ---------------------------------------------------------------------------
// Federation GUEST ticket: "mstrfedg<V>:<base64url(JSON)>". Payload:
//   t  (required) the PEER's federation EndpointTicket string
//   g  (required) a guest token the peer minted for the holder's key
//                 (federation-guest.js — a short-lived JWT)
// What a parent hands ONE OF ITS OWN DEVICES (the mobile app) so the device
// can dial the peer directly — the opposite audience from the federation
// ticket above, which goes admin-to-admin and carries a standing key. The
// prefixes are disjoint on purpose (`mstrfedg1:` never matches
// `^mstrfed(\d+):`), so a ticket pasted into the wrong parser fails
// cleanly. Unknown fields are ignored (forward compat).
// Spec: docs/federation-guest-ticket.md.
// ---------------------------------------------------------------------------

export const FEDERATION_GUEST_TICKET_PREFIX = 'mstrfedg';
export const FEDERATION_GUEST_TICKET_VERSION = 1;

export function buildFederationGuestTicket({ endpointTicket, guestToken }) {
  return buildEnvelope(FEDERATION_GUEST_TICKET_PREFIX, FEDERATION_GUEST_TICKET_VERSION, {
    t: endpointTicket,
    g: guestToken,
  });
}

// Pure (no native module). Throws on garbage, a missing prefix, a too-new
// version, or missing fields.
export function parseFederationGuestTicket(str) {
  const { version, payload } = parseEnvelope(str, {
    prefix: FEDERATION_GUEST_TICKET_PREFIX,
    maxVersion: FEDERATION_GUEST_TICKET_VERSION,
    allowBare: false,
    label: 'federation guest ticket',
  });
  if (!payload || typeof payload.t !== 'string' || typeof payload.g !== 'string') {
    throw new Error('Invalid federation guest ticket (missing fields)');
  }
  return { version, endpointTicket: payload.t, guestToken: payload.g };
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

// Forgive every backed-off remote. Called when the admin mints a key: the
// friend's next dial (with the new key) is expected, and the failures on
// the books are typically that same friend retrying a key the admin just
// revoked — which used to cost them a confusing minute (mStream #940).
export function clearHandshakeBackoff() {
  failedHandshakes.clear();
}

// First bi-stream carries the credential. Two kinds:
//   - a raw `fedk_` key: a paired SERVER. Look it up, enforce/establish the
//     TOFU binding to the dialer's EndpointId, reply OK/NO.
//   - a guest token (federation-guest.js): one of a key holder's own
//     DEVICES, carrying a short-lived JWT the holder fetched from us over
//     its bound pipe. Verified (signature, expiry) and resolved to its key;
//     NO binding — the device's endpoint is ephemeral, expiry is the bound
//     — but every other rule is the key's: a revoked or expired key rejects
//     its guests, and their pipes are tracked under the key so
//     closeConnectionsForKey severs them too.
// Returns { keyRow, via: 'peer' | 'guest' } on success, null otherwise.
// `onAuthorized` runs BEFORE the OK byte is flushed: the caller registers
// the connection in the live-conns map there, so a peer that has been told
// OK is already severable by closeConnectionsForKey — with registration
// after the reply, an admin revoking the key (or anything else acting on
// the client-visible OK) races the registry update and severs nothing.
async function authenticateConnection(conn, remote, onAuthorized) {
  const authBi = await conn.acceptBi();
  const sent = Buffer.from(await authBi.recv.readToEnd(HANDSHAKE_LIMIT)).toString('utf8');

  let keyRow = null;
  let ok = false;
  let via = 'peer';
  if (sent.startsWith(fedDb.FEDERATION_KEY_PREFIX)) {
    keyRow = fedDb.getFederationKeyByKey(sent) || null;
    if (!keyRow) {
      winston.warn(`[federation] rejected connection from ${remote}: unknown key`);
    } else if (keyRow.expired) {
      // Checked BEFORE the TOFU block: an expired-but-unredeemed ticket must
      // die without ever binding. The admin renewing the date re-arms it.
      winston.warn(`[federation] rejected expired key '${keyRow.name}' from ${remote}`);
      keyRow = null;
    } else {
      if (keyRow.bound_endpoint_id === null) {
        // TOFU: first redemption binds the key to this dialer. The guarded
        // UPDATE loses gracefully if a concurrent handshake (or a revoke)
        // got there first — either way, re-read and require an exact match.
        if (fedDb.bindFederationKeyEndpoint(keyRow.id, remote)) {
          winston.info(`[federation] key '${keyRow.name}' bound to endpoint ${remote} (first use)`);
        }
        keyRow = fedDb.getFederationKeyById(keyRow.id) || null;
      }
      ok = Boolean(keyRow && !keyRow.expired && keyRow.bound_endpoint_id === remote);
      if (keyRow && !ok) {
        // The one log line that matters most: a KNOWN key from the WRONG
        // endpoint means the ticket leaked (or the friend reinstalled — the
        // admin reset-binding action covers that case).
        winston.warn(`[federation] rejected key '${keyRow.name}' from ${remote}: bound to ${keyRow.bound_endpoint_id} (possible leaked ticket)`);
      }
    }
  } else {
    via = 'guest';
    let guest = null;
    try {
      guest = verifyGuestToken(sent);
    } catch (err) {
      winston.warn(`[federation] rejected connection from ${remote}: neither a key nor a valid guest token (${err.message})`);
    }
    if (guest) {
      keyRow = fedDb.getFederationKeyById(guest.keyId) || null;
      if (!keyRow) {
        winston.warn(`[federation] rejected guest of a revoked key (id=${guest.keyId}) from ${remote}`);
      } else if (keyRow.expired) {
        winston.warn(`[federation] rejected guest of expired key '${keyRow.name}' from ${remote}`);
        keyRow = null;
      } else {
        ok = true;
      }
    }
  }

  // Registry first, reply second (see the contract above). The write
  // failure below is swallowed, so ok ⇒ keyRow is returned ⇒ the caller's
  // untrack pairing in its finally still holds on every path.
  if (ok && onAuthorized) { onAuthorized(keyRow); }

  try {
    await authBi.send.writeAll(Array.from(Buffer.from(ok ? 'OK' : 'NO')));
    await authBi.send.finish();
  } catch (_err) { /* peer may have hung up */ }
  return ok ? { keyRow, via } : null;
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

async function runAcceptLoop(ep, targetHost, targetPort) {
  for (;;) {
    let incoming;
    try {
      incoming = await ep.acceptNext();
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
        // Tracking happens inside the handshake, before the peer hears OK
        // (see authenticateConnection's contract); a null return means the
        // callback never ran, so the failure path has nothing to untrack.
        const authed = await authenticateConnection(conn, remote,
          (row) => trackConn(row.id, conn));
        if (!authed) {
          recordHandshakeFailure(remote);
          try { conn.close(1n, Array.from(Buffer.from('unauthorized'))); } catch (_err) { /* noop */ }
          return;
        }
        const { keyRow, via } = authed;
        failedHandshakes.delete(remote);
        winston.info(`[federation] ${via} connection authorized: key '${keyRow.name}' from ${remote}`);
        try {
          await acceptConnection(conn, targetHost, targetPort);
        } finally {
          untrackConn(keyRow.id, conn);
        }
        winston.info(`[federation] ${via} connection closed: key '${keyRow.name}' (${remote})`);
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
  if (stopping) {
    try { await stopping; } catch (_err) { /* stop() is best-effort */ }
  }
  if (endpoint) { return { endpointId: endpointIdStr }; }
  if (!targetPort) { throw new Error('federation.start: targetPort is required'); }

  irohMod = await loadIroh();
  const { Endpoint } = irohMod;

  const options = { alpns: [FEDERATION_ALPN] };
  if (secretKey) { options.secretKey = Array.from(asBuffer(secretKey)); }
  const ep = await Endpoint.bind(options);
  endpoint = ep;
  endpointIdStr = ep.id().toString();

  if (awaitOnline) {
    await Promise.race([ep.online().catch(() => {}), delay(8000)]);
  }
  // stop() ran while we waited for the relay (see state/iroh.js): ep is
  // closed and the state cleared — the reboot's own start() takes over.
  if (endpoint !== ep) { return { endpointId: null }; }

  runAcceptLoop(ep, targetHost, targetPort); // detached; ends when the endpoint closes
  winston.info(`[federation] endpoint up — endpointId=${endpointIdStr} -> ${targetHost}:${targetPort}`);
  return { endpointId: endpointIdStr };
}

export function getEndpointId() { return endpointIdStr; }

// The EndpointId (base32 public key) inside an endpoint ticket string, or
// null when the native module is not loaded or the ticket does not parse. A
// public key is not a credential, so a parent may show it to its users (the
// peers projection): it is how a client tells that two parents list the
// same peer. Cached — the projection asks per peer per listing.
const endpointIdCache = new Map(); // ticket string -> id string | null
export function endpointIdFromTicket(endpointTicketStr) {
  if (!irohMod || typeof endpointTicketStr !== 'string') { return null; }
  if (endpointIdCache.has(endpointTicketStr)) { return endpointIdCache.get(endpointTicketStr); }
  let id = null;
  try {
    id = irohMod.EndpointTicket.fromString(endpointTicketStr).endpointAddr().id().toString();
  } catch (_err) { /* not a ticket this build can read */ }
  if (endpointIdCache.size >= 256) { endpointIdCache.clear(); }
  endpointIdCache.set(endpointTicketStr, id);
  return id;
}

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
  if (stopping) { return stopping; }
  if (!endpoint) { return; }
  const ep = endpoint;
  endpoint = null;
  endpointIdStr = null;
  liveConns.clear();
  failedHandshakes.clear();
  stopping = (async () => {
    try { await ep.close(); } catch (_err) { /* best effort */ }
  })();
  try { await stopping; } finally { stopping = null; }
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
