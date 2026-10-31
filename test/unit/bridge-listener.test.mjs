/**
 * util/bridge-listener.js: the loopback listener the in-process iroh
 * endpoints bridge their streams to (mStream#1101).
 *
 * Contract: plain HTTP on 127.0.0.1 answers with whatever the public listener
 * serves at that moment, requests and WebSocket upgrades alike, whatever that
 * listener's address or TLS setting. The two #1101 failures are reproduced
 * first, each time: a loopback connect refused by a public listener bound to
 * another interface, and plain HTTP dropped by a TLS one.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { listenBridge } from '../../src/util/bridge-listener.js';

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

function connectOutcome(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (err) => resolve(err.code));
  });
}

// The public app every case serves: who it saw the request from.
function pingApp(name = 'public') {
  const app = express();
  app.get('/api/v1/ping', (req, res) => res.json({ from: name, remote: req.socket.remoteAddress }));
  return app;
}

// A non-loopback address this machine can listen on, else a second loopback
// address (Linux and Windows route all of 127/8 locally; macOS does not).
async function otherInterfaceServer(app) {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const address of [...lan, '127.0.0.2']) {
    const srv = http.createServer(app);
    try { return { srv, address, port: await listen(srv, address) }; } catch { /* next */ }
  }
  return null;
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
