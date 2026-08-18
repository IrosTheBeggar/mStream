/**
 * util/kept-listener.js: the separate-port Subsonic/DLNA servers' listener.
 *
 * Contract: ensure() with an unchanged bind KEEPS the socket (no close, no
 * re-listen — the Windows/Bun inherited-handle reason lives in server.js);
 * a changed bind recycles it; a same-port recycle retries EADDRINUSE with
 * backoff instead of dying (the main listener's samePortRelisten rule); a
 * conflict on a NEW port is reported once and not retried.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createKeptListener } from '../../src/util/kept-listener.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
async function get(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, text: await r.text() };
}
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) { return; } } catch { /* not yet */ }
    if (Date.now() > deadline) { throw new Error('condition not met in time'); }
    await sleep(25);
  }
}

describe('kept listener (real sockets)', () => {
  const listeners = [];
  after(() => { for (const l of listeners) { l.stop(); } });

  test('same bind: the app and socket are kept, a changed port recycles', async () => {
    const port = await freePort();
    let builds = 0;
    const build = () => { builds++; const app = express(); const gen = builds; app.get('/who', (req, res) => res.send(`gen${gen}`)); return app; };
    const l = createKeptListener('test');
    listeners.push(l);

    l.ensure({ port, address: '127.0.0.1', build });
    await waitFor(async () => (await get(port, '/who')).status === 200);
    assert.equal((await get(port, '/who')).text, 'gen1');
    assert.equal(l.isRunning(), true);

    // Same bind again (what onListening does after a soft reboot): kept.
    l.ensure({ port, address: '127.0.0.1', build });
    await sleep(50);
    assert.equal(builds, 1, 'build() must not run again for an unchanged bind');
    assert.equal((await get(port, '/who')).text, 'gen1');

    // Port change: recycled onto the new port, old port closed.
    const port2 = await freePort();
    l.ensure({ port: port2, address: '127.0.0.1', build });
    await waitFor(async () => (await get(port2, '/who')).status === 200);
    assert.equal(builds, 2);
    assert.equal((await get(port2, '/who')).text, 'gen2');
    await waitFor(() => new Promise((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.on('error', () => resolve(true));
      s.on('connect', () => { s.destroy(); resolve(false); });
    }));

    l.stop();
    assert.equal(l.isRunning(), false);
    await waitFor(() => new Promise((resolve) => {
      const s = net.connect({ port: port2, host: '127.0.0.1' });
      s.on('error', () => resolve(true));
      s.on('connect', () => { s.destroy(); resolve(false); });
    }));
  });
});

// The retry logic, driven deterministically through a fake http.Server:
// listen() fails with EADDRINUSE N times, then succeeds.
describe('kept listener (retry logic)', () => {
  const realCreateServer = http.createServer;
  after(() => { http.createServer = realCreateServer; });

  function fakeServerFactory(script) {
    // script: array per created server of how many EADDRINUSE errors to emit
    // before 'listening'; missing entry = succeed immediately.
    const created = [];
    http.createServer = () => {
      const s = new EventEmitter();
      const idx = created.length;
      created.push(s);
      let failuresLeft = script[idx] ?? 0;
      s.listenCalls = 0;
      s.listen = () => {
        s.listenCalls++;
        setImmediate(() => {
          if (failuresLeft > 0) { failuresLeft--; const e = new Error('in use'); e.code = 'EADDRINUSE'; s.emit('error', e); }
          else { s.listening = true; s.emit('listening'); }
        });
      };
      s.close = (cb) => { s.listening = false; if (cb) { setImmediate(cb); } };
      return s;
    };
    return created;
  }

  test('a same-port recycle retries EADDRINUSE until it binds', async () => {
    const created = fakeServerFactory([0, 3]);   // first server binds; the recycle fails 3x
    const l = createKeptListener('retry');
    l.ensure({ port: 4000, address: '127.0.0.1', build: () => (() => {}) });
    await waitFor(() => created[0]?.listening);
    l.ensure({ port: 4000, address: '10.0.0.1', build: () => (() => {}) });   // same port, new address
    await waitFor(() => created[1]?.listening, 4000);
    assert.equal(created[1].listenCalls, 4, '3 failures + the successful attempt');
    assert.equal(l.isRunning(), true);
    l.stop();
  });

  test('a conflict on a NEW port is not retried', async () => {
    const created = fakeServerFactory([0, 5]);
    const l = createKeptListener('conflict');
    l.ensure({ port: 4000, address: '127.0.0.1', build: () => (() => {}) });
    await waitFor(() => created[0]?.listening);
    l.ensure({ port: 4001, address: '127.0.0.1', build: () => (() => {}) });   // moved port
    await sleep(300);
    assert.equal(created[1].listenCalls, 1, 'no retry on a real conflict');
    assert.equal(l.isRunning(), false, 'the failed listener is not reported as running');
  });
});
