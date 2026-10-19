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
// the browser's cache revalidation rides the conditionals. The purpose
// header (X-mStream-Purpose: copy, api/federation-limits.js) rides along
// too, so a client copying files through this proxy says so to the peer
// exactly as it would on the direct path, and a key whose copies are
// switched off refuses it here as well.
export const FORWARD_REQ = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'x-mstream-purpose'];

// What GET /api/ says about this proxy (features.federationProxy,
// api/server-info.js): `purpose` — X-mStream-Purpose reaches the peer, so a
// copy through the proxy is a declared copy. Read off FORWARD_REQ, so the
// flag cannot claim a header the proxy does not forward. Older servers omit
// the key: their proxy drops the header, and a copy through it reaches the
// peer undeclared.
export function describeProxy() {
  return { purpose: FORWARD_REQ.includes('x-mstream-purpose') };
}

// Response headers the audio element + seek logic need, copied from the
// peer, plus Retry-After: the peer's 429s carry it (5 s past its stream
// cap, the seconds to its UTC midnight past its daily quota), and without
// it a client could not tell how long to wait. Everything else (cookies,
// server identity) stays behind.
export const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'retry-after'];
// Dial + response-header budget (matches testPeer's health timeout). The
// BODY has no deadline — tracks stream for minutes.
const HEADER_DEADLINE_MS = 15 * 1000;

// A HEAD's answer, from the peer's answer to `Range: bytes=0-0`: the
// whole file's headers, as a GET would have them. The 206's Content-Range
// carries the file's size (`bytes 0-0/<size>`). An empty file has no first
// byte: its answer is an error carrying `Content-Range: bytes */0` (a 416
// from express.static, which mStream's error handler turns into a 500 —
// the header stays). Either becomes a 200 with that Content-Length and no
// Content-Range. Anything else — a 200 from a peer that ignored the range,
// a 304, the peer's 403s, 404s and 429s with their Retry-After — comes
// back as the peer said it.
function headAnswerFromProbe(upstream) {
  const range = upstream.headers.get('content-range') || '';
  const partial = upstream.status === 206 && /^bytes \d+-\d+\/(\d+)$/.exec(range);
  const unsatisfied = !partial && /^bytes \*\/(\d+)$/.exec(range);
  const size = partial || unsatisfied;
  const headers = {};
  for (const h of FORWARD_RES) {
    if (size && (h === 'content-length' || h === 'content-range')) { continue; }
    // The error's type is its JSON body's, not the empty file's.
    if (unsatisfied && h === 'content-type') { continue; }
    const v = upstream.headers.get(h);
    if (v) { headers[h] = v; }
  }
  if (!size) { return { status: upstream.status, headers }; }
  headers['content-length'] = size[1];
  return { status: 200, headers };
}

// The byte pipe, with the dial injected (`fetchMedia(path, opts)` resolves
// to a fetch Response from the peer): forward the request headers, copy the
// safe response headers back — status included, so the peer's 403s and
// 429s reach the client as they are — and pipe the body. Exported so the
// unit tests can hand it a loopback stand-in for the peer.
export async function relayPeerMedia(req, res, { remotePath, fetchMedia, peerLabel }) {
  const headers = {};
  for (const h of FORWARD_REQ) {
    if (req.headers[h]) { headers[h] = req.headers[h]; }
  }

  // Express answers HEAD with this GET handler. Passed on as a plain GET, a
  // HEAD would pull the whole file — across the peer's link, onto the key's
  // daily quota and through one of its stream slots — for Node to discard
  // here. Passed on as a HEAD it is refused: a federation key may only GET
  // a peer's /media (federation-auth.js), so every peer answers 403. So a
  // HEAD asks the peer for the first byte (headAnswerFromProbe above).
  // Range has no meaning on a HEAD (RFC 9110 §14.2), so the client's own
  // range goes; its conditionals stay, and a 304 is still a 304.
  const head = req.method === 'HEAD';
  if (head) {
    delete headers['if-range'];
    headers.range = 'bytes=0-0';
  }
  let upstream;
  try {
    upstream = await fetchMedia(`/media/${remotePath}`, { headers });
  } catch (err) {
    winston.warn(`[federation] stream proxy: ${peerLabel} unreachable for '${remotePath}': ${err.message}`);
    throw new WebError('Peer unreachable', 502);
  }

  if (head) {
    // One byte, or (a peer that ignored the range) the start of the file:
    // cancelling stops whichever it is here.
    upstream.body?.cancel().catch(() => {});
    const answer = headAnswerFromProbe(upstream);
    res.status(answer.status);
    for (const [h, v] of Object.entries(answer.headers)) { res.setHeader(h, v); }
    return res.end();
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
    winston.warn(`[federation] stream proxy: body from ${peerLabel} failed mid-stream: ${err.message}`);
    res.destroy();
  });
  body.pipe(res);
}

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

    // Loaded lazily like every other fedFetch caller — federation-client
    // pulls in the iroh machinery, cold until a peer is actually dialed.
    const fedClient = await import('../state/federation-client.js');
    await relayPeerMedia(req, res, {
      remotePath,
      peerLabel: `peer '${peer.name}' (id=${peer.id})`,
      // Deadline covers the dial + header phase ONLY (see
      // fedFetchWithDeadline) — once headers are back, the body may stream
      // for as long as the track lasts. Without it, playing a track whose
      // peer just went offline hangs the request in the iroh dial (~29s
      // measured) instead of failing crisply.
      fetchMedia: (apiPath, opts) => fedFetchWithDeadline(fedClient, peer, apiPath, opts, HEADER_DEADLINE_MS),
    });
  });
}
