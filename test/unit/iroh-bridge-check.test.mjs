/**
 * The bridge check (mStream#1101). Right after start(), each in-process iroh
 * endpoint probes the target its streams are bridged to, and the admin status
 * routes report the outcome as bridgeOk/bridgeError: a tunnel that pairs fine
 * but whose requests cannot reach the web server is visible on the server.
 * Also pinned: start() bridges to the registered bridge target unless given
 * one, every admin route that starts an endpoint leaves it to, and a failing
 * backend connect warns once a minute, not once per stream.
 *
 * Stubbed: the native module (helpers/fake-iroh.mjs: no sockets, no relay),
 * and the discovery stack the discovery switch starts before federation
 * (helpers/fake-discovery-stack.mjs).
 */

import { describe, test, before, after, afterEach } from 'node:test';
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
import { localSocketPath } from '../../src/util/bridge-listener.js';

const FAKE_IROH = new URL('../helpers/fake-iroh.mjs', import.meta.url).href;
const FAKE_STACK = new URL('../helpers/fake-discovery-stack.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@number0/iroh') { return { url: FAKE_IROH, shortCircuit: true }; }
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith('/src/state/discovery-p2p-stack.js') ? { url: FAKE_STACK, shortCircuit: true } : resolved;
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
const NOT_YET = { bridgeOk: null, bridgeError: null, bridgeVia: null };

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// performance.now(), not Date.now(): the rate-limit test mocks Date.
async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (performance.now() > deadline) { throw new Error('condition not met in time'); }
    await new Promise((r) => setTimeout(r, 20));
  }
}
// A failed probe lands after its retries (1 s, then 2 s).
const landed = (mod) => waitFor(() => (mod.getBridgeCheck().bridgeOk !== null ? mod.getBridgeCheck() : null));

// The registered bridge target, counting what reaches it: each time start()
// asks for it, each probe it answers. Any HTTP status is an answer (a
// users-mode '/' redirects to /login).
const backend = { port: null, asked: 0, probes: [] };
const servers = [];
before(async () => {
  const srv = http.createServer((req, res) => { backend.probes.push(`${req.method} ${req.url}`); res.statusCode = 302; res.end(); });
  servers.push(srv);
  backend.port = await listen(srv);
  common.setBridgeTarget(() => {
    backend.asked += 1;
    return Promise.resolve({ targetHost: '127.0.0.1', targetPort: backend.port });
  });
});
after(() => { for (const s of servers) { s.close(); } });

// After every test that starts an endpoint, failed or not: the next one
// starts with both stopped.
async function stopBoth() {
  await iroh.stop();
  await federation.stop();
  backend.asked = 0;
  backend.probes.length = 0;
}

// A target that accepts and closes without a reply: a failed probe at once.
function hangUpPort() {
  const hangUp = net.createServer((s) => s.once('data', () => s.destroy()));
  servers.push(hangUp);
  return listen(hangUp);
}

describe('bridge check', () => {
  afterEach(stopBoth);

  test('start() without a target bridges to the registered one, and its probe is answered', async () => {
    await iroh.start({ connectSecret: CONNECT_SECRET, awaitOnline: false });
    assert.deepEqual(await landed(iroh), { bridgeOk: true, bridgeError: null, bridgeVia: 'loopback' });
    assert.equal(backend.asked, 1);
    assert.deepEqual(backend.probes, ['HEAD /'], 'the probe went to the registered target');
    await iroh.stop();
    assert.deepEqual(iroh.getBridgeCheck(), NOT_YET, 'stop() forgets the outcome');
  });

  test('an explicit targetPort wins; a refused one is reported with its error', async () => {
    const dead = await freePort();
    await federation.start({ targetPort: dead, awaitOnline: false });
    const check = await landed(federation);
    assert.equal(check.bridgeOk, false);
    assert.match(check.bridgeError, new RegExp(`ECONNREFUSED 127\\.0\\.0\\.1:${dead}`));
    assert.equal(backend.asked, 0, 'the registered target was not asked for');
  });

  test('a TLS target is reported as not answering plain HTTP', async () => {
    const tls = https.createServer();
    servers.push(tls);
    const tlsPort = await listen(tls);
    await iroh.start({ targetPort: tlsPort, connectSecret: CONNECT_SECRET, awaitOnline: false });
    const check = await landed(iroh);
    assert.equal(check.bridgeOk, false);
    assert.equal(check.bridgeError, `no plain-HTTP answer (TLS on that port?) (127.0.0.1:${tlsPort})`);
  });

  // What the TLS case above meets on some OpenSSL builds (no alert, just a
  // close), pinned on every one.
  test('a target that hangs up without answering reads the same', async () => {
    const port = await hangUpPort();
    await federation.start({ targetPort: port, awaitOnline: false });
    assert.equal((await landed(federation)).bridgeError, `no plain-HTTP answer (TLS on that port?) (127.0.0.1:${port})`);
  });

  test('a failed probe is tried again before it reports', async () => {
    let seen = 0;
    const flaky = http.createServer((req, res) => {
      seen += 1;
      if (seen === 1) { req.socket.destroy(); } else { res.end(); }
    });
    servers.push(flaky);
    const port = await listen(flaky);
    await federation.start({ targetPort: port, awaitOnline: false });
    assert.deepEqual(await landed(federation), { bridgeOk: true, bridgeError: null, bridgeVia: 'loopback' });
    assert.equal(seen, 2, 'the first probe failed and the retry was answered');
  });
});

describe('admin routes', () => {
  let tmpDir;
  let base;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-bridge-check-'));
    const configFile = path.join(tmpDir, 'config.json');
    // Collecting already, so the discovery switch has no scan to force on.
    fs.writeFileSync(configFile, JSON.stringify({ scanOptions: { collectDiscoveryData: true } }));
    await config.setup(configFile);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { admin: true }; next(); });
    adminApi.setup(app);
    const server = http.createServer(app);
    servers.push(server);
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  afterEach(stopBoth);

  const status = async (p) => (await fetch(`${base}${p}`)).json();
  const post = async (p, body) => (await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const pick = ({ running, bridgeOk, bridgeError, bridgeVia }) => ({ running, bridgeOk, bridgeError, bridgeVia });

  test('the status routes carry the outcome', async () => {
    assert.deepEqual(pick(await status('/api/v1/admin/iroh')), { running: false, ...NOT_YET });

    await iroh.start({ connectSecret: CONNECT_SECRET, awaitOnline: false });
    await federation.start({ targetPort: await hangUpPort(), awaitOnline: false });
    await landed(iroh);
    await landed(federation);

    assert.deepEqual(pick(await status('/api/v1/admin/iroh')), { running: true, bridgeOk: true, bridgeError: null, bridgeVia: 'loopback' });
    const fed = await status('/api/v1/admin/federation');
    assert.equal(fed.running, true);
    assert.equal(fed.bridgeOk, false);
    assert.match(fed.bridgeError, /no plain-HTTP answer/);
  });

  // The routes below start an endpoint without a reboot. Each passed the
  // public port as the target, which a LAN-bound or SSL server never answers.
  async function startedAgainstTarget(endpoint) {
    assert.deepEqual(await landed(endpoint), { bridgeOk: true, bridgeError: null, bridgeVia: 'loopback' });
    assert.equal(backend.asked, 1, 'start() asked for the registered target');
    assert.deepEqual(backend.probes, ['HEAD /']);
  }

  test('turning Quick Connect on', async () => {
    assert.deepEqual(await post('/api/v1/admin/iroh', { enabled: true }), { enabled: true, available: true });
    await startedAgainstTarget(iroh);
  });

  test('rotating the Quick Connect secret', async () => {
    await post('/api/v1/admin/iroh', { enabled: true });
    await landed(iroh);
    backend.asked = 0;
    backend.probes.length = 0;
    assert.deepEqual(await post('/api/v1/admin/iroh/rotate-secret', {}), { rotated: true, available: true });
    await startedAgainstTarget(iroh);
  });

  test('turning federation on', async () => {
    assert.deepEqual(await post('/api/v1/admin/federation', { enabled: true }), { enabled: true, available: true });
    await startedAgainstTarget(federation);
  });

  test('the discovery switch with "accept federation requests"', async () => {
    const r = await post('/api/v1/admin/discovery/p2p/enabled', { enabled: true, acceptFederationRequests: true });
    assert.equal(r.acceptRequests, true, JSON.stringify(r));
    await startedAgainstTarget(federation);
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

// The local-socket fallback (mStream#1101, the Windows report): a loopback
// connect refused sends the stream over the local socket server.js
// registers, the route then sticks, and the bridge check reports it.
describe('local-socket fallback', () => {
  // The registered fallback: a plain HTTP server on a local socket, counting
  // what reaches it.
  const fallback = { path: null, asked: 0, served: [] };
  const register = () => common.setBridgeFallback(() => { fallback.asked += 1; return Promise.resolve({ targetPath: fallback.path }); });
  const mode = process.env.MSTREAM_BRIDGE;
  before(async () => {
    fallback.path = localSocketPath();
    const srv = http.createServer((req, res) => { fallback.served.push(`${req.method} ${req.url}`); res.end('ok'); });
    servers.push(srv);
    await new Promise((resolve) => srv.listen(fallback.path, resolve));
    register();
  });
  after(() => { common.setBridgeFallback(null); common.resetBridgeRoute(); });
  afterEach(async () => {
    await stopBoth();
    common.resetBridgeRoute();
    fallback.asked = 0;
    fallback.served.length = 0;
    if (mode === undefined) { delete process.env.MSTREAM_BRIDGE; } else { process.env.MSTREAM_BRIDGE = mode; }
  });

  // A bi-stream carrying one request; what came back lands in `reply`.
  function requestStream(text) {
    const chunks = [Array.from(Buffer.from(text)), []];
    const s = { reply: '', resets: 0 };
    s.bi = {
      recv: { read: () => Promise.resolve(chunks.shift() ?? []), stop: async () => {} },
      send: { writeAll: (arr) => { s.reply += Buffer.from(arr).toString(); return Promise.resolve(); }, finish: async () => {}, reset: () => { s.resets += 1; return Promise.resolve(); } },
    };
    return s;
  }
  const GET = 'GET /api/v1/ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
  const warnings = (warn) => warn.mock.calls.map((c) => String(c.arguments[0]));

  test('a stream refused on loopback takes the local socket, and later streams go straight there', async (t) => {
    const warn = t.mock.method(winston, 'warn', () => {});
    const dead = await freePort();
    const first = requestStream(GET);
    common.bridgeStreamToBackend(first.bi, '127.0.0.1', dead);
    await waitFor(() => first.reply.includes('HTTP/1.1 200'));
    assert.deepEqual(common.bridgeRoute(), { targetPath: fallback.path });
    assert.equal(fallback.asked, 1);
    assert.equal(warnings(warn).length, 1, 'one line for the switch, none for the refusal');
    assert.match(warnings(warn)[0], new RegExp(`loopback bridge refused \\(127\\.0\\.0\\.1:${dead}: connect ECONNREFUSED.*bridging over the local socket`));
    const second = requestStream(GET);
    common.bridgeStreamToBackend(second.bi, '127.0.0.1', dead);
    await waitFor(() => second.reply.includes('HTTP/1.1 200'));
    assert.equal(fallback.asked, 1, 'the route stuck: the fallback was not asked for again');
    assert.equal(warnings(warn).length, 1, 'and nothing more was warned');
    assert.deepEqual(fallback.served, ['GET /api/v1/ping', 'GET /api/v1/ping']);
  });

  test('the bridge check follows: a loopback that fails its retries reports the local socket as the route', async () => {
    const dead = await freePort();
    await federation.start({ targetPort: dead, awaitOnline: false });
    assert.deepEqual(await landed(federation), { bridgeOk: true, bridgeError: null, bridgeVia: 'local-socket' });
    assert.deepEqual(common.bridgeRoute(), { targetPath: fallback.path });
    assert.deepEqual(fallback.served, ['HEAD /']);
  });

  test('both refused: reported with both errors, and loopback stays the route', async () => {
    const dead = await freePort();
    const missing = localSocketPath();
    common.setBridgeFallback(() => Promise.resolve({ targetPath: missing }));
    try {
      await iroh.start({ targetPort: dead, connectSecret: CONNECT_SECRET, awaitOnline: false });
      const check = await landed(iroh);
      assert.equal(check.bridgeOk, false);
      assert.equal(check.bridgeVia, 'loopback');
      assert.match(check.bridgeError, new RegExp(`ECONNREFUSED 127\\.0\\.0\\.1:${dead}; local socket .*mstream-bridge`));
      assert.equal(common.bridgeRoute(), null);
    } finally {
      register();
    }
  });

  test('MSTREAM_BRIDGE=loopback never leaves loopback', async (t) => {
    const warn = t.mock.method(winston, 'warn', () => {});
    process.env.MSTREAM_BRIDGE = 'loopback';
    const dead = await freePort();
    const s = requestStream(GET);
    common.bridgeStreamToBackend(s.bi, '127.0.0.1', dead);
    await waitFor(() => s.resets === 1);
    assert.equal(fallback.asked, 0);
    assert.equal(common.bridgeRoute(), null);
    assert.match(warnings(warn)[0], /backend connect failed/);
  });

  test('MSTREAM_BRIDGE=socket takes the local socket from the first stream', async (t) => {
    const warn = t.mock.method(winston, 'warn', () => {});
    process.env.MSTREAM_BRIDGE = 'socket';
    const s = requestStream(GET);
    common.bridgeStreamToBackend(s.bi, '127.0.0.1', 1);
    await waitFor(() => s.reply.includes('HTTP/1.1 200'));
    assert.deepEqual(common.bridgeRoute(), { targetPath: fallback.path });
    assert.equal(warnings(warn).length, 0, 'no refusal to warn about');
  });
});
