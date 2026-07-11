// The streaming face of federation: play a PEER's track through this
// server. Discovery-over-federation phase 4 — this is what turns the
// Discover panel's "From your peers" rows from leads into playable songs.
//
// GET /api/v1/federation/peers/:id/stream/<vpath-path>
//
// Normal local-user auth (the same `?token=` query the /media and
// /transcode audio URLs ride — the wall reads it for every route), and NOT
// on the federation-key allowlist, so a peer can never chain proxies
// through us. The handler is a thin byte pipe: forward the range and
// conditional request headers to the peer's /media/<path> over the
// federation bridge, copy the streaming response headers back, pipe the
// body. The PEER's auth wall + key grants decide what is actually readable
// — this server adds no local path judgement beyond URL hygiene, because
// the path lives in the peer's vpath namespace, not ours.
//
// Deliberately out of scope (degrade, don't pretend): transcode, waveform,
// lyrics, and stats for remote tracks — every one of those resolves paths
// against the LOCAL library.

import { Readable } from 'node:stream';
import winston from 'winston';
import * as config from '../state/config.js';
import * as fedDb from '../db/federation.js';
import { fedFetchWithDeadline } from './discovery-federation.js';
import WebError from '../util/web-error.js';

// Request headers forwarded verbatim — seeking needs range/if-range, and
// the browser's cache revalidation rides the conditionals.
const FORWARD_REQ = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept'];
// Response headers the audio element + seek logic need, copied from the
// peer. Everything else (cookies, server identity) stays behind.
const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
// Dial + response-header budget (matches testPeer's health timeout). The
// BODY has no deadline — tracks stream for minutes.
const HEADER_DEADLINE_MS = 15 * 1000;

export function setup(mstream) {
  mstream.get('/api/v1/federation/peers/:id/stream/*path', async (req, res) => {
    if (config.program.federation.enabled !== true) {
      throw new WebError('federation is disabled (config: federation.enabled)', 403);
    }
    const peer = fedDb.getFederationPeerById(Number(req.params.id));
    if (!peer) { throw new WebError('Peer not found', 404); }

    // Express 5 named wildcards hand back decoded segments (an array);
    // re-encode each so the upstream URL survives spaces, #, %, ? in
    // filenames exactly like the webapp's own /media escaping does.
    const segments = Array.isArray(req.params.path) ? req.params.path : String(req.params.path).split('/');
    const remotePath = segments.map(encodeURIComponent).join('/');

    const headers = {};
    for (const h of FORWARD_REQ) {
      if (req.headers[h]) { headers[h] = req.headers[h]; }
    }

    // Loaded lazily like every other fedFetch caller — federation-client
    // pulls in the iroh machinery, cold until a peer is actually dialed.
    const fedClient = await import('../state/federation-client.js');
    let upstream;
    try {
      // Deadline covers the dial + header phase ONLY (see
      // fedFetchWithDeadline) — once headers are back, the body may stream
      // for as long as the track lasts. Without it, playing a track whose
      // peer just went offline hangs the request in the iroh dial (~29s
      // measured) instead of failing crisply.
      upstream = await fedFetchWithDeadline(fedClient, peer, `/media/${remotePath}`, { headers }, HEADER_DEADLINE_MS);
    } catch (err) {
      winston.warn(`[federation] stream proxy: peer '${peer.name}' (id=${peer.id}) unreachable for '${remotePath}': ${err.message}`);
      throw new WebError('Peer unreachable', 502);
    }

    res.status(upstream.status);
    for (const h of FORWARD_RES) {
      const v = upstream.headers.get(h);
      if (v) { res.setHeader(h, v); }
    }
    if (!upstream.body) { return res.end(); }

    const body = Readable.fromWeb(upstream.body);
    // A dropped player connection (seek, skip, tab close) must tear down
    // the upstream read too — else abandoned streams keep pulling bytes
    // over the bridge until the file ends.
    res.on('close', () => { body.destroy(); });
    body.on('error', (err) => {
      // Mid-stream transport failure: headers are gone already, so all we
      // can do is cut the response and log why.
      winston.warn(`[federation] stream proxy: body from peer '${peer.name}' (id=${peer.id}) failed mid-stream: ${err.message}`);
      res.destroy();
    });
    body.pipe(res);
  });
}
