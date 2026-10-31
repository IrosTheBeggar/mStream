/**
 * The bridge check (mStream#1101). Right after start(), each in-process iroh
 * endpoint probes the target its streams are bridged to, and the admin status
 * routes report the outcome as bridgeOk/bridgeError: a tunnel that pairs fine
 * but whose requests cannot reach the web server is visible on the server.
 * Also pinned: start() bridges to the registered bridge target unless given
 * one, and a failing backend connect warns once a minute, not once per stream.
 *
 * The native module is stubbed (helpers/fake-iroh.mjs): no sockets, no relay.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import express from 'express';
import winston from 'winston';

const FAKE_IROH = new URL('../helpers/fake-iroh.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@number0/iroh') { return { url: FAKE_IROH, shortCircuit: true }; }
    return nextResolve(specifier, context);
  },
});

const common = await import('../../src/state/iroh-common.js');
const iroh = await import('../../src/state/iroh.js');
const federation = await import('../../src/state/federation.js');
const config = await import('../../src/state/config.js');
const adminApi = await import('../../src/api/admin.js');
// After admin.js: its import of logger.js configures winston's transports.
winston.configure({ transports: [new winston.transports.Console({ silent: true })] });

const CONNECT_SECRET = Buffer.alloc(32, 7).toString('base64');
const NOT_YET = { bridgeOk: null, bridgeError: null };

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function waitFor(fn, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (Date.now() > deadline) { throw new Error('condition not met in time'); }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const landed = (mod) => waitFor(() => (mod.getBridgeCheck().bridgeOk !== null ? mod.getBridgeCheck() : null));

describe('bridge check', () => {
  const servers = [];
  let backendPort;
  let probes;
  before(async () => {
    probes = [];
    // Any HTTP status is an answer: the users-mode '/' redirects to /login.
    const backend = http.createServer((req, res) => { probes.push(`${req.method} ${req.url}`); res.statusCode = 302; res.end(); });
    servers.push(backend);
    backendPort = await listen(backend);
  });
  after(async () => {
    await iroh.stop();
    await federation.stop();
    for (const s of servers) { s.close(); }
  });

  test('start() without a target bridges to the registered one, and its probe is answered', async () => {
    common.setBridgeTarget('127.0.0.1', backendPort);
    probes.length = 0;
    await iroh.start({ connectSecret: CONNECT_SECRET, awaitOnline: false });
    assert.deepEqual(await landed(iroh), { bridgeOk: true, bridgeError: null });
    assert.deepEqual(probes, ['HEAD /'], 'the probe went to the registered target');
    await iroh.stop();
    assert.deepEqual(iroh.getBridgeCheck(), NOT_YET, 'stop() forgets the outcome');
  });

  test('an explicit targetPort wins; a refused one is reported with its error', async () => {
    common.setBridgeTarget('127.0.0.1', backendPort);
    const dead = await freePort();
    await federation.start({ targetPort: dead, awaitOnline: false });
    const check = await landed(federation);
    assert.equal(check.bridgeOk, false);
    assert.match(check.bridgeError, new RegExp(`ECONNREFUSED 127\\.0\\.0\\.1:${dead}`));
    await federation.stop();
  });

  test('a TLS target is reported as not answering HTTP', async () => {
    const tls = https.createServer();
    servers.push(tls);
    const tlsPort = await listen(tls);
    await iroh.start({ targetPort: tlsPort, connectSecret: CONNECT_SECRET, awaitOnline: false });
    const check = await landed(iroh);
    assert.equal(check.bridgeOk, false);
    assert.match(check.bridgeError, /not HTTP/);
    await iroh.stop();
  });

  test('the admin status routes carry the outcome', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-bridge-check-'));
    try {
      await config.setup(path.join(tmpDir, 'config.json'));
      const app = express();
      app.use((req, res, next) => { req.user = { admin: true }; next(); });
      adminApi.setup(app);
      const server = http.createServer(app);
      servers.push(server);
      const port = await listen(server);
      const status = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

      assert.deepEqual(
        (({ running, bridgeOk, bridgeError }) => ({ running, bridgeOk, bridgeError }))(await status('/api/v1/admin/iroh')),
        { running: false, ...NOT_YET });

      common.setBridgeTarget('127.0.0.1', backendPort);
      await iroh.start({ connectSecret: CONNECT_SECRET, awaitOnline: false });
      await federation.start({ targetPort: await freePort(), awaitOnline: false });
      await landed(iroh);
      await landed(federation);

      const tunnel = await status('/api/v1/admin/iroh');
      assert.deepEqual([tunnel.running, tunnel.bridgeOk, tunnel.bridgeError], [true, true, null]);
      const fed = await status('/api/v1/admin/federation');
      assert.equal(fed.running, true);
      assert.equal(fed.bridgeOk, false);
      assert.match(fed.bridgeError, /ECONNREFUSED/);
    } finally {
      await iroh.stop();
      await federation.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('backend connect failures', () => {
  test('warn once a minute per backend, counting the failures in between', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const warn = t.mock.method(winston, 'warn', () => {});
    const lines = () => warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('backend connect failed'));
    const dead = await freePort();
    let resets = 0;
    const bi = () => ({ send: { reset: () => { resets += 1; return Promise.resolve(); } }, recv: { stop: async () => {} } });

    for (let i = 0; i < 3; i++) { common.bridgeStreamToBackend(bi(), '127.0.0.1', dead); }
    await waitFor(() => resets === 3);
    assert.equal(lines().length, 1, 'three refused streams, one warning');
    assert.match(lines()[0], new RegExp(`\\(127\\.0\\.0\\.1:${dead}\\).*check its bind address and port`));

    t.mock.timers.tick(60_000);
    common.bridgeStreamToBackend(bi(), '127.0.0.1', dead);
    await waitFor(() => resets === 4);
    assert.equal(lines().length, 2);
    assert.match(lines()[1], /\(2 more since the last warning\)/);
  });
});
