// The browsing face of federation: read a PEER's library through this
// server.
//
// Federation's inbound half has always been rich — a paired peer may call
// our whole read allowlist (api/federation-auth.js): artists, albums,
// genres, search, the file explorer, /media and /album-art. The outbound
// half had exactly two consumer routes, the Discover aggregator and the
// stream proxy, and BOTH need a path someone already handed you. Nothing
// let a local user simply open a peer and look around. These three routes
// are that missing half:
//
//   GET /api/v1/federation/peers                 peers this user can browse
//   ALL /api/v1/federation/peers/:id/api/<path>  one allowlisted read
//   GET /api/v1/federation/peers/:id/art/<file>  that peer's album art
//   GET /api/v1/federation/peers/:id/access      what a device needs to
//                                                reach that peer DIRECTLY
//
// All four take normal local-user auth and stay OFF the federation-key
// allowlist, so a peer can never chain a proxy through us — the same rule
// api/federation-stream.js states for the byte proxy.
//
// The proxy screens the requested route against the SHARED inbound
// allowlist (isFederationRouteAllowed) before dialing. The peer re-checks
// its own copy regardless, so this is not the security boundary; it exists
// so the two directions cannot drift into a route we proxy to but no peer
// will answer. Past that screen this server adds no path judgement: the
// path lives in the PEER's vpath namespace, and the peer's auth wall plus
// the grants on our key decide what is actually readable.

import { Readable } from 'node:stream';
import winston from 'winston';
import * as config from '../state/config.js';
import * as fedDb from '../db/federation.js';
import { isFederationRouteAllowed } from './federation-auth.js';
import { fedFetchWithDeadline } from './discovery-federation.js';
import { buildFederationGuestTicket, endpointIdFromTicket } from '../state/federation.js';
import WebError from '../util/web-error.js';

// Dial + response budget, matching testPeer and the stream proxy's header
// phase. Browse answers are small and fully buffered by the peer before it
// replies, so unlike a track body there is nothing to keep open past it.
const DEADLINE_MS = 15 * 1000;

// Copied from the peer's response. content-length is deliberately ABSENT:
// the peer gzips its JSON (util/compression.js), fetch transparently
// decompresses the body, and forwarding the compressed length would
// describe bytes we are no longer sending. Node re-chunks instead.
const FORWARD_RES = ['content-type', 'etag', 'last-modified', 'cache-control'];
// Art revalidation only — enough for a 304 round-trip on cached covers.
const FORWARD_REQ_ART = ['if-none-match', 'if-modified-since', 'accept'];

// Query params forwarded to the peer, per route family. An ALLOWLIST, not
// a filter: the webapp appends its local `?token=` to every <img> and
// audio URL, and that token is OUR jwt — forwarding it would hand a peer a
// working credential for this server. The allowlisted reads take no query
// params at all, so the API proxy forwards none; art takes `compress`.
const FORWARD_QUERY_ART = ['compress'];

function requireFederation() {
  if (config.program.federation.enabled !== true) {
    throw new WebError('federation is disabled (config: federation.enabled)', 403);
  }
}

function requirePeer(id) {
  const peer = fedDb.getFederationPeerById(Number(id));
  if (!peer) { throw new WebError('Peer not found', 404); }
  return peer;
}

// Express 5 named wildcards hand back decoded segments; re-encode each so
// the upstream URL survives spaces, #, %, ? in names exactly like the
// webapp's own escaping does. A `.` or `..` segment is rejected outright:
// undici resolves them on the wire, which for a prefix-allowlisted route
// (/media/, /album-art/) would let `/media/../api/v1/db/rated` slip past the
// startsWith screen and dial the peer for a route we would never proxy.
function remotePathFrom(params) {
  const segments = Array.isArray(params) ? params : String(params).split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new WebError('Invalid path', 400);
  }
  return segments.map(encodeURIComponent).join('/');
}

function forwardQuery(query, allowed) {
  const out = new URLSearchParams();
  for (const key of allowed) {
    if (query[key] !== undefined) { out.set(key, String(query[key])); }
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

// Shared tail: copy the peer's status + safe headers, pipe its body, tear
// the upstream read down if the client goes away mid-transfer.
function pipeUpstream(upstream, res, peer, label) {
  res.status(upstream.status);
  for (const h of FORWARD_RES) {
    const v = upstream.headers.get(h);
    if (v) { res.setHeader(h, v); }
  }
  if (!upstream.body) { return res.end(); }

  const body = Readable.fromWeb(upstream.body);
  res.on('close', () => { body.destroy(); });
  body.on('error', (err) => {
    winston.warn(`[federation] browse proxy: body from peer '${peer.name}' (id=${peer.id}) failed mid-stream on ${label}: ${err.message}`);
    res.destroy();
  });
  body.pipe(res);
}

// ── Direct access: guest tokens for this server's own devices ─────────────
//
// GET /api/v1/federation/peers/:id/access hands a logged-in user what its
// device needs to reach the peer WITHOUT this server in the path: the peer's
// endpoint ticket and a guest token the peer minted for our key (POST
// /api/v1/federation/guest over the bridge — state/federation-guest.js on
// the peer's side). Tokens are cached per peer and re-minted once three
// quarters of their life is gone, or on ?refresh=1 for a client whose token
// the peer just refused, so a device polling this on every resume costs one
// bridge round trip a day. The key itself still never leaves this server.
const GUEST_REMINT_AT = 0.75; // fraction of the lifetime after which we re-mint
const GUEST_REFRESH_MIN_GAP_MS = 5 * 1000; // a refresh right after a mint is served from cache
const guestAccess = new Map(); // peerId -> { token, expiresAt: ms, mintedAt: ms }
const guestPending = new Map(); // peerId -> Promise<entry|null> (one mint in flight per peer)

function guestIsFresh(entry, { refresh }) {
  if (!entry) { return false; }
  const age = Date.now() - entry.mintedAt;
  if (refresh) { return age < GUEST_REFRESH_MIN_GAP_MS; }
  const life = entry.expiresAt - entry.mintedAt;
  return life > 0 && age < life * GUEST_REMINT_AT;
}

// Drop a peer's cached guest token — on removal (the row is gone; a re-added
// peer gets a fresh id anyway, this just keeps the map honest).
export function forgetPeerAccess(peerId) {
  guestAccess.delete(peerId);
}

// Ask the peer for a guest token. Resolves to the cache entry, or null when
// the peer refuses to mint: an older build whose allowlist has no guest
// route (its wall answers 403), or federation switched off there. Throws
// when the peer is unreachable or answers something unexpected.
async function mintGuestFromPeer(peer) {
  const fedClient = await import('../state/federation-client.js');
  const upstream = await fedFetchWithDeadline(fedClient, peer, '/api/v1/federation/guest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, DEADLINE_MS);
  if (upstream.status === 403 || upstream.status === 404) { return null; }
  if (!upstream.ok) { throw new Error(`peer answered http ${upstream.status} to the guest mint`); }
  const body = await upstream.json();
  if (typeof body?.token !== 'string' || typeof body?.expiresAt !== 'string') {
    throw new Error('peer answered the guest mint with an unexpected shape');
  }
  const expiresAt = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiresAt)) { throw new Error('peer answered the guest mint with an unreadable expiry'); }
  return { token: body.token, expiresAt, mintedAt: Date.now() };
}

function guestAccessFor(peer, { refresh = false } = {}) {
  const cached = guestAccess.get(peer.id);
  if (guestIsFresh(cached, { refresh })) { return Promise.resolve(cached); }
  const inFlight = guestPending.get(peer.id);
  if (inFlight) { return inFlight; }
  const p = mintGuestFromPeer(peer).then((entry) => {
    if (entry) { guestAccess.set(peer.id, entry); } else { guestAccess.delete(peer.id); }
    return entry;
  }).finally(() => guestPending.delete(peer.id));
  guestPending.set(peer.id, p);
  return p;
}

export function setup(mstream) {
  // The peers a local user may browse. Admin's /api/v1/admin/federation/peers
  // returns the row — which carries api_key and endpoint_ticket, both
  // credentials. This one is the read-only projection every logged-in user
  // gets: enough to name a peer, address it, and show whether the last
  // contact worked. last_seen/last_status are whatever the admin's
  // test-connection or a previous browse left behind; nothing here dials,
  // so listing peers stays free.
  mstream.get('/api/v1/federation/peers', (req, res) => {
    requireFederation();
    res.json({
      peers: fedDb.getFederationPeers().map((p) => ({
        id: p.id,
        name: p.name,
        lastSeen: p.last_seen || null,
        lastStatus: p.last_status || null,
        useDiscovery: p.use_discovery === 1,
        // The peer's iroh identity (a public key, not a credential): how a
        // client tells that two parents list the same server. Null when
        // this build cannot read tickets (no native module).
        endpointId: endpointIdFromTicket(p.endpoint_ticket),
      })),
    });
  });

  // What a device needs to reach a peer directly — see the section above.
  // Same guards as the proxies (federation on, known peer, local-user auth,
  // never a federation key), and the same 502 when the peer cannot be
  // reached; a peer that will not mint is a 200 with `direct: false`, so a
  // client can tell "fall back to the proxies" from "the peer is down".
  mstream.get('/api/v1/federation/peers/:id/access', async (req, res) => {
    requireFederation();
    const peer = requirePeer(req.params.id);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

    let entry;
    try {
      entry = await guestAccessFor(peer, { refresh });
    } catch (err) {
      winston.warn(`[federation] access: peer '${peer.name}' (id=${peer.id}) unreachable for the guest mint: ${err.message}`);
      throw new WebError('Peer unreachable', 502);
    }
    if (!entry) {
      return res.json({
        direct: false,
        reason: 'peer does not offer guest access (an older build, or federation is disabled there)',
      });
    }
    res.json({
      direct: true,
      endpointTicket: peer.endpoint_ticket,
      endpointId: endpointIdFromTicket(peer.endpoint_ticket),
      guestToken: entry.token,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      // The two above, packaged for the device's native dialer:
      // docs/federation-guest-ticket.md.
      directTicket: buildFederationGuestTicket({ endpointTicket: peer.endpoint_ticket, guestToken: entry.token }),
    });
  });

  // One allowlisted read, executed on the peer. Method and path are the
  // peer's own API surface, so the webapp calls db/albums, db/search or
  // file-explorer against a peer with the same shapes it uses locally.
  mstream.all('/api/v1/federation/peers/:id/api/*path', async (req, res) => {
    requireFederation();

    // Screen the route BEFORE looking the peer up: a request we would never
    // proxy is answered the same way whether or not the peer exists, and
    // nothing touches the database on the way to that answer.
    // exactOnly: this proxy forwards only the exact db/file-explorer reads.
    // The /media and /album-art byte trees have their own dedicated stream and
    // art proxies, so the API proxy must not inherit them as a second,
    // range-less path.
    const remotePath = `/${remotePathFrom(req.params.path)}`;
    if (!isFederationRouteAllowed(req.method, remotePath, { exactOnly: true })) {
      // Not a probing signal the way a bad key is — this is an authenticated
      // local user — but it is the only place a webapp bug that asks a peer
      // for a route no peer serves becomes visible, so log it.
      winston.warn(`[federation] browse proxy refused off-allowlist route ${req.method} ${remotePath} (peer id=${req.params.id})`);
      throw new WebError('Route not available over federation', 403);
    }

    const peer = requirePeer(req.params.id);

    const opts = { method: req.method, headers: {} };
    // Bodies are re-serialized from the parsed request rather than piped:
    // every allowlisted POST is a small JSON filter object, and rebuilding
    // it means nothing but valid JSON crosses the bridge.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
      opts.body = JSON.stringify(req.body ?? {});
      opts.headers['Content-Type'] = 'application/json';
    }

    const fedClient = await import('../state/federation-client.js');
    let upstream;
    try {
      upstream = await fedFetchWithDeadline(fedClient, peer, remotePath, opts, DEADLINE_MS);
    } catch (err) {
      winston.warn(`[federation] browse proxy: peer '${peer.name}' (id=${peer.id}) unreachable for ${req.method} ${remotePath}: ${err.message}`);
      throw new WebError('Peer unreachable', 502);
    }

    pipeUpstream(upstream, res, peer, remotePath);
  });

  // A peer's cover art. Same shape as the stream proxy, minus ranges —
  // art is small, and the browser only ever revalidates it.
  mstream.get('/api/v1/federation/peers/:id/art/*path', async (req, res) => {
    requireFederation();
    // Build (and validate) the path before the peer lookup, so a bad path is
    // refused without touching the database — as the API proxy does.
    const remotePath = `/album-art/${remotePathFrom(req.params.path)}`;
    const peer = requirePeer(req.params.id);

    const headers = {};
    for (const h of FORWARD_REQ_ART) {
      if (req.headers[h]) { headers[h] = req.headers[h]; }
    }

    const fedClient = await import('../state/federation-client.js');
    let upstream;
    try {
      upstream = await fedFetchWithDeadline(
        fedClient, peer,
        remotePath + forwardQuery(req.query, FORWARD_QUERY_ART),
        { headers }, DEADLINE_MS,
      );
    } catch (err) {
      winston.warn(`[federation] art proxy: peer '${peer.name}' (id=${peer.id}) unreachable for '${remotePath}': ${err.message}`);
      throw new WebError('Peer unreachable', 502);
    }

    pipeUpstream(upstream, res, peer, remotePath);
  });
}
