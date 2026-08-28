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
//
// All three take normal local-user auth and stay OFF the federation-key
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
// webapp's own escaping does. Segments are joined, never resolved — a
// `..` survives as the literal text `..` and simply fails the allowlist.
function remotePathFrom(params) {
  const segments = Array.isArray(params) ? params : String(params).split('/');
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
      })),
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
    const remotePath = `/${remotePathFrom(req.params.path)}`;
    if (!isFederationRouteAllowed(req.method, remotePath)) {
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
    const peer = requirePeer(req.params.id);

    const remotePath = `/album-art/${remotePathFrom(req.params.path)}`;
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
