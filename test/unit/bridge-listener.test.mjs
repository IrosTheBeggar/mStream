/**
 * util/bridge-listener.js: the loopback listener the in-process iroh
 * endpoints bridge their streams to (mStream#1101).
 *
 * Contract: plain HTTP on 127.0.0.1 answers with whatever the public listener
 * serves at that moment, requests and WebSocket upgrades alike, whatever that
 * listener's address or TLS setting. The two #1101 failures are reproduced
 * first, each time: a loopback connect refused by a public listener bound to
 * another interface, and plain HTTP dropped by a TLS one. The phone app's
 * `__lt` query parameter (its loopback proxy's local token) is dropped on
 * the way through, and nothing else in the URL.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { listenBridge, stripLocalToken } from '../../src/util/bridge-listener.js';
import { connectOutcome, otherInterfaceAddress } from '../helpers/net.mjs';

const listen = (srv, address) => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(0, address, () => { srv.off('error', reject); resolve(srv.address().port); });
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// The first chunk a raw request gets back, as text ('' if the socket closes).
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(text));
    s.once('data', (chunk) => { s.destroy(); resolve(String(chunk)); });
    s.once('end', () => resolve(''));
    s.once('error', reject);
  });
}

// The public app every case serves: who it saw the request from.
function pingApp(name = 'public') {
  const app = express();
  app.get('/api/v1/ping', (req, res) => res.json({ from: name, remote: req.socket.remoteAddress }));
  return app;
}

async function otherInterfaceServer(app) {
  const address = await otherInterfaceAddress();
  if (!address) { return null; }
  const srv = http.createServer(app);
  return { srv, address, port: await listen(srv, address) };
}

const stub = (req, res) => { res.statusCode = 503; res.end('mStream is restarting'); };

describe('bridge listener (real sockets)', () => {
  const servers = [];
  const track = (srv) => { servers.push(srv); return srv; };
  after(() => { for (const s of servers) { s.close(); s.closeAllConnections?.(); } });

  test('a public listener on another interface: loopback is refused there, the bridge answers', async (t) => {
    const pub = await otherInterfaceServer(pingApp());
    if (!pub) { t.skip('no second address to listen on'); return; }
    track(pub.srv);
    assert.equal(await connectOutcome('127.0.0.1', pub.port), 'ECONNREFUSED', 'the #1101 precondition');

    const seen = [];
    const bridge = track(await listenBridge({ publicServer: () => pub.srv, onConnection: (s) => seen.push(s), whileDown: stub }));
    assert.equal(bridge.address().address, '127.0.0.1');
    const r = await get(bridge.address().port, '/api/v1/ping');
    assert.equal(r.status, 200);
    // The app sees a loopback caller, as mayShareCode and the admin gate expect.
    assert.deepEqual(JSON.parse(r.body), { from: 'public', remote: '127.0.0.1' });
    assert.equal(seen.length, 1, 'onConnection saw the bridged socket');
  });

  test('a TLS public listener: plain HTTP gets no answer there, the bridge answers', async () => {
    const pub = track(https.createServer(pingApp('tls')));
    const port = await listen(pub, '127.0.0.1');
    await assert.rejects(get(port, '/api/v1/ping'), 'the #1101 precondition');

    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));
    const r = await get(bridge.address().port, '/api/v1/ping');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).from, 'tls');
  });

  test('a WebSocket upgrade reaches the ws server attached to the public listener', async () => {
    const pub = track(https.createServer(pingApp()));
    await listen(pub, '127.0.0.1');
    const wss = new WebSocketServer({ server: pub });
    wss.on('connection', (ws, req) => ws.send(`hello ${req.url}`));
    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/?code=abc`);
    const msg = await new Promise((resolve, reject) => {
      ws.once('message', (m) => resolve(String(m)));
      ws.once('error', reject);
    });
    ws.close();
    wss.close();
    assert.equal(msg, 'hello /?code=abc');
  });

  test('an upgrade nothing can take gets the stub\'s 503, not a dropped socket', async () => {
    const upgrade = [
      'GET /?code=abc HTTP/1.1', 'Host: bridge', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n');
    const pub = track(http.createServer(pingApp()));
    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));
    const port = bridge.address().port;
    assert.match(await rawRequest(port, upgrade), /^HTTP\/1\.1 503 /, 'public listener not listening');
    await listen(pub, '127.0.0.1');
    // As between remoteApi.stop() and its restart: no ws server attached.
    assert.match(await rawRequest(port, upgrade), /^HTTP\/1\.1 503 /, 'nothing attached for upgrades');
  });

  test('it serves what the public listener serves now: the stub, a swapped app, a replaced listener', async () => {
    const app = pingApp('first');
    let pub = track(http.createServer(app));
    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));
    const port = bridge.address().port;

    // Not listening yet (a first boot, a recycle under way): whileDown answers.
    assert.equal((await get(port, '/api/v1/ping')).status, 503);
    await listen(pub, '127.0.0.1');
    assert.equal(JSON.parse((await get(port, '/api/v1/ping')).body).from, 'first');

    // reboot() parks the listener on its stub, then serveIt swaps a new app in.
    pub.off('request', app);
    pub.on('request', stub);
    assert.equal((await get(port, '/api/v1/ping')).status, 503);
    pub.off('request', stub);
    pub.on('request', pingApp('second'));
    assert.equal(JSON.parse((await get(port, '/api/v1/ping')).body).from, 'second');

    // A bind change replaces the listener object itself.
    pub = track(http.createServer(pingApp('third')));
    await listen(pub, '127.0.0.1');
    assert.equal(JSON.parse((await get(port, '/api/v1/ping')).body).from, 'third');
  });
});

// What the public app saw of a request's URL, as Express reads it.
function echoApp() {
  const app = express();
  app.get('/api/v1/echo', (req, res) => res.json({ url: req.url, originalUrl: req.originalUrl, query: req.query }));
  return app;
}

// The phone app's loopback proxy (the Rust shim from mstream-iroh-tunnel)
// adds `__lt=<token>` to every request URL and forwards the bytes as they
// are, so a route whose query schema rejects unknown keys answered 400 over
// Quick Connect. The bridge drops that parameter, and only that one, from
// requests and upgrades alike; the public listener itself is not touched.
describe("the tunnel client's __lt query parameter", () => {
  const servers = [];
  const track = (srv) => { servers.push(srv); return srv; };
  after(() => { for (const s of servers) { s.close(); s.closeAllConnections?.(); } });

  test('stripLocalToken drops that parameter and nothing else', () => {
    const cases = [
      ['/api/v1/ping', '/api/v1/ping'],
      ['/api/v1/ping?', '/api/v1/ping?'],
      ['/api/v1/discovery/plugin-jobs?__lt=4e90', '/api/v1/discovery/plugin-jobs'],
      ['/api/v1/discovery/plugin-jobs?__lt', '/api/v1/discovery/plugin-jobs'],
      ['/api/v1/discovery/plugin-jobs?state=queued&__lt=4e90', '/api/v1/discovery/plugin-jobs?state=queued'],
      ['/api/v1/db/albums?__lt=4e90&limit=10&offset=0', '/api/v1/db/albums?limit=10&offset=0'],
      // No re-encoding of what stays.
      ['/api/v1/stats/top?period=week&__lt=4e90&tz=Europe%2FParis&q=a+b', '/api/v1/stats/top?period=week&tz=Europe%2FParis&q=a+b'],
      // Only the exact key, and only in the query.
      ['/x?__ltx=1&x__lt=2&lt=3&a__lt', '/x?__ltx=1&x__lt=2&lt=3&a__lt'],
      ['/__lt?__lt=4e90', '/__lt'],
      ['/x?a=1&__lt=4e90#top', '/x?a=1#top'],
    ];
    for (const [given, expected] of cases) { assert.equal(stripLocalToken(given), expected, given); }
  });

  test('a request reaches the public app without it, the other parameters kept', async () => {
    const pub = track(http.createServer(echoApp()));
    await listen(pub, '127.0.0.1');
    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));
    const port = bridge.address().port;

    let r = await get(port, '/api/v1/echo?state=queued&__lt=4e90&limit=10');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), {
      url: '/api/v1/echo?state=queued&limit=10',
      originalUrl: '/api/v1/echo?state=queued&limit=10',
      query: { state: 'queued', limit: '10' },
    });
    r = await get(port, '/api/v1/echo?__lt=4e90');
    assert.deepEqual(JSON.parse(r.body), { url: '/api/v1/echo', originalUrl: '/api/v1/echo', query: {} });
    // Straight to the public listener, the parameter is still there.
    r = await get(pub.address().port, '/api/v1/echo?__lt=4e90');
    assert.deepEqual(JSON.parse(r.body).query, { __lt: '4e90' });
  });

  test('a WebSocket upgrade reaches the ws server without it', async () => {
    const pub = track(http.createServer(echoApp()));
    await listen(pub, '127.0.0.1');
    const wss = new WebSocketServer({ server: pub });
    wss.on('connection', (ws, req) => ws.send(`hello ${req.url}`));
    const bridge = track(await listenBridge({ publicServer: () => pub, onConnection: () => {}, whileDown: stub }));

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/?__lt=4e90&code=abc`);
    const msg = await new Promise((resolve, reject) => {
      ws.once('message', (m) => resolve(String(m)));
      ws.once('error', reject);
    });
    ws.close();
    wss.close();
    assert.equal(msg, 'hello /?code=abc');
  });
});
