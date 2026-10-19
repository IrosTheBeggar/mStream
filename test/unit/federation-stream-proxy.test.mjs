/**
 * The parent's byte proxy to a peer's /media (src/api/federation-stream.js
 * relayPeerMedia) — which headers cross it, each way:
 *
 *  - X-mStream-Purpose reaches the peer, so a copy made through the proxy
 *    says so exactly as on the direct path, and a key with copies switched
 *    off refuses it (the peer's 403 comes back as it is); a plain stream
 *    says nothing, and the peer serves it;
 *  - the peer's 429s come back with their Retry-After — the stream cap's
 *    5 s and the daily quota's seconds to midnight — so a client can tell
 *    how long to wait;
 *  - range requests still seek (206 + Content-Range);
 *  - a HEAD asks the peer for its first byte (a key may not HEAD a peer's
 *    /media, and a plain GET would pull the whole file to throw it away)
 *    and answers with the whole file's size — an empty file's too — while
 *    the peer's refusals come back as they are;
 *  - nothing else crosses: our cookies and tokens never reach the peer, and
 *    the peer's cookies and server identity never reach our client;
 *  - a peer that cannot be dialed is a 502;
 *  - what GET /api/ advertises about the proxy (features.federationProxy,
 *    via describeProxy) is what it forwards.
 *
 * No iroh, no database: a loopback HTTP server stands in for the peer's
 * /media, and the dial is injected (the route handler passes the real
 * fedFetch over the federation bridge).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

import { relayPeerMedia, describeProxy } from '../../src/api/federation-stream.js';

const FILE = crypto.randomBytes(64 * 1024);

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const base = (server) => `http://127.0.0.1:${server.address().port}`;
const close = (server) => new Promise((resolve) => server.close(resolve));

describe('federation stream proxy: the headers that cross it', () => {
  let peer, proxy;
  const seen = []; // request headers the peer received, in order
  const methods = []; // and their methods

  before(async () => {
    // The peer's /media, reduced to the answers federation-limits.js gives.
    peer = await listen((req, res) => {
      seen.push(req.headers);
      methods.push(req.method);
      const json = (status, body, extra = {}) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/media/shared/busy.bin') {
        return json(429, { error: 'Too many concurrent streams' }, { 'retry-after': '5' });
      }
      if (req.url === '/media/shared/quota.bin') {
        return json(429, { error: 'Daily transfer quota exceeded' }, { 'retry-after': '3600' });
      }
      // federation-auth.js: a key may GET /media, never HEAD it.
      if (req.method !== 'GET') { return json(403, { error: 'Forbidden' }); }
      if (req.url === '/media/shared/no%20copies.bin' && req.headers['x-mstream-purpose'] === 'copy') {
        return json(403, { error: 'copies are not allowed with this key' });
      }
      // An empty file has no first byte: express.static's answer to a range
      // on one (mStream's error handler makes it a 500; the header stays).
      if (req.url === '/media/shared/empty.bin') {
        if (req.headers.range) { return json(500, { error: 'Server Error' }, { 'content-range': 'bytes */0' }); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 0 });
        return res.end();
      }
      const identity = { 'set-cookie': 'peer-session=1', server: 'peer-box', 'x-powered-by': 'peer' };
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])];
        res.writeHead(206, {
          'content-type': 'application/octet-stream', 'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${FILE.length}`, 'accept-ranges': 'bytes', etag: '"v1"', ...identity,
        });
        return res.end(FILE.subarray(start, end + 1));
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream', 'content-length': FILE.length,
        'accept-ranges': 'bytes', etag: '"v1"', ...identity,
      });
      res.end(FILE);
    });

    // This server's route, minus the peer lookup: the path re-encoded the
    // way the real handler does it, the dial a plain fetch to the stand-in.
    const app = express();
    app.get('/stream/*path', (req, res) => relayPeerMedia(req, res, {
      remotePath: req.params.path.map(encodeURIComponent).join('/'),
      peerLabel: 'peer \'stand-in\'',
      fetchMedia: req.query.dead
        ? () => Promise.reject(new Error('no answer within 15000ms (dial included)'))
        : (apiPath, opts) => fetch(base(peer) + apiPath, opts),
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    proxy = await listen(app);
  });

  after(async () => {
    await close(proxy);
    await close(peer);
  });

  const get = (path, headers = {}) => fetch(`${base(proxy)}/stream/${path}`, { headers });

  test('a copy says so to the peer, and a key with copies off refuses it through the proxy', async () => {
    const refused = await get('shared/no%20copies.bin', { 'X-mStream-Purpose': 'copy' });
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('content-type'), /application\/json/);
    assert.equal((await refused.json()).error, 'copies are not allowed with this key');
    assert.equal(seen.at(-1)['x-mstream-purpose'], 'copy');

    // The same file streamed: no purpose said, none invented.
    const played = await get('shared/no%20copies.bin');
    assert.equal(played.status, 200);
    assert.ok(Buffer.from(await played.arrayBuffer()).equals(FILE));
    assert.ok(!('x-mstream-purpose' in seen.at(-1)), 'a stream says nothing');
  });

  test('the peer\'s 429s come back with their Retry-After', async () => {
    const busy = await get('shared/busy.bin');
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '5');
    assert.equal((await busy.json()).error, 'Too many concurrent streams');

    const quota = await get('shared/quota.bin');
    assert.equal(quota.status, 429);
    assert.equal(quota.headers.get('retry-after'), '3600');
    assert.equal((await quota.json()).error, 'Daily transfer quota exceeded');
  });

  test('a range request still seeks', async () => {
    const r = await get('shared/track.bin', { Range: 'bytes=100-199' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 100-199/${FILE.length}`);
    assert.equal(seen.at(-1).range, 'bytes=100-199');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(FILE.subarray(100, 200)));
  });

  test('nothing else crosses: our credentials stay here, the peer\'s identity stays there', async () => {
    const r = await get('shared/track.bin', {
      Cookie: 'x-access-token=local-jwt', 'x-access-token': 'local-jwt', Authorization: 'Bearer local-jwt',
    });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    const sent = seen.at(-1);
    for (const h of ['cookie', 'x-access-token', 'authorization']) {
      assert.ok(!(h in sent), `${h} must never reach the peer`);
    }
    assert.equal(r.headers.get('etag'), '"v1"');
    assert.equal(r.headers.get('set-cookie'), null, 'the peer\'s cookies stay behind');
    assert.notEqual(r.headers.get('server'), 'peer-box');
    assert.equal(r.headers.get('x-powered-by'), 'Express', 'our own header, not the peer\'s');
  });

  const head = (path, headers = {}) => fetch(`${base(proxy)}/stream/${path}`, { method: 'HEAD', headers });

  test('a HEAD asks the peer for one byte and answers with the whole file\'s headers', async () => {
    const r = await head('shared/track.bin');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), String(FILE.length), 'the size, from the 206\'s Content-Range');
    assert.equal(r.headers.get('content-range'), null, 'a 200 has no range');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('etag'), '"v1"');
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await r.arrayBuffer()).byteLength, 0);
    // A GET for the first byte: a key may not HEAD the peer's /media (its
    // stand-in refuses one, as federation-auth.js does), and a plain GET
    // would pull — and meter — the whole file for this server to discard.
    assert.equal(methods.at(-1), 'GET');
    assert.equal(seen.at(-1).range, 'bytes=0-0');

    // Range means nothing on a HEAD: the client's own goes, the answer is
    // still the whole file's.
    const ranged = await head('shared/track.bin', { Range: 'bytes=100-199', 'If-Range': '"v1"' });
    assert.equal(ranged.status, 200);
    assert.equal(ranged.headers.get('content-length'), String(FILE.length));
    assert.equal(seen.at(-1).range, 'bytes=0-0');
    assert.ok(!('if-range' in seen.at(-1)));

    // A GET is still the client's GET.
    await (await get('shared/track.bin')).arrayBuffer();
    assert.equal(methods.at(-1), 'GET');
    assert.ok(!('range' in seen.at(-1)));
  });

  test('a HEAD of an empty file is a 200 of length 0; the peer\'s refusals come back as they are', async () => {
    const empty = await head('shared/empty.bin');
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal(empty.headers.get('content-type'), null, 'the probe never saw the file\'s own type');

    const busy = await head('shared/busy.bin');
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '5');
    const refused = await head('shared/no%20copies.bin', { 'X-mStream-Purpose': 'copy' });
    assert.equal(refused.status, 403);
  });

  test('a peer that cannot be dialed is a 502', async () => {
    const r = await get('shared/track.bin?dead=1');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'Peer unreachable');
  });

  test('what GET /api/ advertises is what the proxy forwards: the purpose', async () => {
    // features.federationProxy (api/server-info.js) is this, exactly.
    assert.deepEqual(describeProxy(), { purpose: true });
    const r = await get('shared/track.bin', { 'X-mStream-Purpose': 'copy' });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.equal(seen.at(-1)['x-mstream-purpose'], 'copy', 'the header the flag promises reaches the peer');
  });
});
