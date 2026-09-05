/**
 * What a soft reboot (admin config change) must NOT break — the follow-ups to
 * the kept-listener reboot (reboot-keeps-listener.test.mjs):
 *
 *   - Quick Connect (the iroh tunnel) is up again after the reboot with the
 *     same endpoint id. reboot() used to fire iroh.stop() and forget it while
 *     the re-serve ran ~70 ms later: start() found the endpoint still closing,
 *     no-oped, the late stop nulled it, and the tunnel was dead until the next
 *     process restart — after ANY reboot-requiring admin save, no error logged.
 *   - The separate-port DLNA server keeps serving across the reboot on the
 *     same socket (kept listener) instead of close()+listen() — the re-listen
 *     is what dies on the Windows Bun bundle mid-scan.
 *   - Two admin saves in flight together both end up applied: the coalesced
 *     one used to be dropped when it landed after the in-flight reboot's
 *     config read.
 *   - A bind change to an address this machine cannot serve is reverted: the
 *     server stays reachable on the previous bind and the config file gets
 *     the previous port/address back (it used to exit, and exit again on every
 *     later start because the bad value stayed on disk).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';

// MSTREAM_TEST_BUN_BIN points at a bun executable when `bun` on PATH is not
// spawnable without a shell (npm's bun.ps1/bun.cmd shim on Windows).
const BUN_BIN = process.env.MSTREAM_TEST_BUN_BIN || 'bun';
const bunProbe = spawnSync(BUN_BIN, ['--version'], { encoding: 'utf8' });
const noBun = (!bunProbe.error && bunProbe.status === 0) ? false : 'bun is not installed on this machine';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let irohAvailable = true;
try { await import('@number0/iroh'); } catch { irohAvailable = false; }

async function login(server) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}
const adminGet = (server, jwt, p) => fetch(`${server.baseUrl}${p}`, { headers: { 'x-access-token': jwt } });
const adminPost = (server, jwt, p, body) => fetch(`${server.baseUrl}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': jwt }, body: JSON.stringify(body),
});

async function recentLogText(server, jwt, sinceSeq = 0) {
  const r = await adminGet(server, jwt, `/api/v1/admin/logs/recent?since=${sinceSeq}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  return { text: body.entries.map((e) => e.message ?? JSON.stringify(e)).join('\n'), lastSeq: body.lastSeq };
}

// Poll an admin GET until `pred(json)` holds; tolerates the reboot window.
async function waitForConfig(server, jwt, pred, what, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await adminGet(server, jwt, '/api/v1/admin/config');
      if (r.status === 200 && pred(await r.json())) { return; }
    } catch { /* mid-reboot */ }
    if (Date.now() > deadline) { throw new Error(`${what} never observed after reboot`); }
    await sleep(100);
  }
}

// Wait until the API has answered 200 continuously for ~1.5 s (no reboot in
// flight, no pending re-run about to start one).
async function settle(server, jwt, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (streak < 15) {
    let ok;
    try { ok = (await adminGet(server, jwt, '/api/v1/ping')).status === 200; } catch { ok = false; }
    streak = ok ? streak + 1 : 0;
    if (Date.now() > deadline) { throw new Error('server never settled'); }
    await sleep(100);
  }
}

async function irohStatus(server, jwt) {
  const r = await adminGet(server, jwt, '/api/v1/admin/iroh');
  assert.equal(r.status, 200);
  return r.json();
}
async function waitForTunnel(server, jwt, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let s = null;
    try { s = await irohStatus(server, jwt); } catch { /* mid-reboot */ }
    if (s && s.running) { return s; }
    if (s && !s.available) { return s; }
    if (Date.now() > deadline) { throw new Error('iroh tunnel never came up'); }
    await sleep(250);
  }
}

function suites(label, startOpts) {
describe(`soft reboot keeps Quick Connect (${label})`, { skip: irohAvailable ? false : 'no @number0/iroh binary for this platform' }, () => {
  let server;
  let jwt;
  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', users: [{ ...ADMIN, admin: true }],
      extraConfig: { iroh: { enabled: true } }, ...startOpts,
    });
    jwt = await login(server);
  });
  after(async () => { if (server) { await server.stop(); } });

  test('the tunnel is up again after a same-bind reboot, same endpoint id', async () => {
    const beforeStatus = await waitForTunnel(server, jwt);
    if (!beforeStatus.available) { return; }   // native module missing at runtime: nothing to prove
    assert.equal(beforeStatus.running, true);
    assert.ok(beforeStatus.endpointId);

    const { lastSeq } = await recentLogText(server, jwt);
    const r = await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: true });
    assert.equal(r.status, 200);
    await waitForConfig(server, jwt, (c) => c.trustProxy === true, 'trustProxy=true');

    // Not merely "still reports running" — a fresh "tunnel up" line proves the
    // re-serve actually started a new endpoint after the stop finished.
    const afterStatus = await waitForTunnel(server, jwt, 30_000);
    assert.equal(afterStatus.running, true, `tunnel dead after the reboot: ${JSON.stringify(afterStatus)}`);
    assert.equal(afterStatus.endpointId, beforeStatus.endpointId, 'the endpoint identity (secret key) must persist across the reboot');
    // running:true flips as soon as the new endpoint is BOUND; the "tunnel up"
    // line follows its bounded relay-online wait (up to 8 s) — poll for it.
    let text;
    for (const deadline = Date.now() + 20_000; ; ) {
      ({ text } = await recentLogText(server, jwt, lastSeq));
      if (/\[iroh\] tunnel up/.test(text) || Date.now() > deadline) { break; }
      await sleep(250);
    }
    assert.match(text, /Reboot: bind unchanged .* keeping the listening socket/);
    assert.match(text, /\[iroh\] tunnel up/);
  });
});

describe(`soft reboot keeps the separate-port DLNA listener (${label})`, () => {
  let server;
  let jwt;
  before(async () => {
    server = await startServer({ dlnaMode: 'separate-port', users: [{ ...ADMIN, admin: true }], ...startOpts });
    jwt = await login(server);
  });
  after(async () => { if (server) { await server.stop(); } });

  const ping = () => fetch(`${server.dlnaBaseUrl}/dlna/device.xml`);

  test('the DLNA port keeps answering through and after the reboot; the socket was kept, not re-listened', async () => {
    assert.equal((await ping()).status, 200);
    const { lastSeq } = await recentLogText(server, jwt);

    const r = await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: true });
    assert.equal(r.status, 200);
    // Hammer the DLNA port through the reboot window: it must never refuse.
    const outcomes = [];
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      try { outcomes.push((await ping()).status); } catch (err) { outcomes.push(err.cause?.code || err.message); }
    }
    assert.deepEqual(outcomes.filter((o) => o !== 200), [], `DLNA port faltered during the reboot: ${JSON.stringify(outcomes)}`);
    await waitForConfig(server, jwt, (c) => c.trustProxy === true, 'trustProxy=true');
    assert.equal((await ping()).status, 200);

    const { text } = await recentLogText(server, jwt, lastSeq);
    assert.match(text, /\[dlna\] Separate server kept across reboot/);
    assert.doesNotMatch(text, /\[dlna\] Separate server stopped|\[dlna\] Separate server error/);
  });
});

describe(`overlapping admin saves and rejected binds (${label})`, () => {
  let server;
  let jwt;
  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', users: [{ ...ADMIN, admin: true }], ...startOpts });
    jwt = await login(server);
  });
  after(async () => { if (server) { await server.stop(); } });

  test('two reboot-requiring saves in flight together are BOTH applied', async () => {
    const before = await (await adminGet(server, jwt, '/api/v1/admin/config')).json();
    const newMax = before.maxRequestSize === '100MB' ? '120MB' : '100MB';
    // Fire both without waiting: the second lands somewhere inside the first
    // reboot's window — before or after its config read; either way it must
    // end up applied (via that reboot, or the pending re-run).
    const [r1, r2] = await Promise.all([
      adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: !before.trustProxy }),
      adminPost(server, jwt, '/api/v1/admin/config/max-request-size', { maxRequestSize: newMax }),
    ]);
    assert.ok([200, 503].includes(r1.status), `first save: ${r1.status}`);
    assert.ok([200, 503].includes(r2.status), `second save: ${r2.status}`);
    // A 503 is the reboot stub answering a request that arrived mid-window; the
    // save then never happened, which is honest — re-issue it once the API is
    // back so the assertion below is about the coalescing, not the stub.
    await waitForConfig(server, jwt, () => true, 'API back');
    if (r1.status === 503) { assert.equal((await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: !before.trustProxy })).status, 200); }
    if (r2.status === 503) { assert.equal((await adminPost(server, jwt, '/api/v1/admin/config/max-request-size', { maxRequestSize: newMax })).status, 200); }
    await waitForConfig(server, jwt, (c) => c.trustProxy === !before.trustProxy && c.maxRequestSize === newMax, 'both saves applied');
    // Both are on disk too.
    const doc = JSON.parse(await fs.readFile(path.join(server.tmpDir, 'config.json'), 'utf8'));
    assert.equal(doc.trustProxy, !before.trustProxy);
    assert.equal(doc.maxRequestSize, newMax);
    // Let any coalesced re-run finish before the next test talks to the server.
    await settle(server, jwt);
  });

  test('a bind change to an unservable address is reverted, on disk and live', async () => {
    const { lastSeq } = await recentLogText(server, jwt);
    // 203.0.113.7 (TEST-NET-3) is not an address of this machine. Joi accepts
    // it (valid IP syntax), the save succeeds, and the reboot must refuse the
    // move without ever giving up the socket it is serving on.
    const r = await adminPost(server, jwt, '/api/v1/admin/config/address', { address: '203.0.113.7' });
    assert.equal(r.status, 200);
    // The address is 127.0.0.1 both before and after, so "config reports
    // 127.0.0.1" proves nothing by itself — wait for the on-disk revert (the
    // save had put 203.0.113.7 there; the reboot must put 127.0.0.1 back).
    const cfgPath = path.join(server.tmpDir, 'config.json');
    let doc;
    for (const deadline = Date.now() + 25_000; ; ) {
      try { doc = JSON.parse(await fs.readFile(cfgPath, 'utf8')); } catch { doc = null; }
      if (doc && doc.address === '127.0.0.1') { break; }
      if (Date.now() > deadline) { throw new Error(`config file never reverted: address=${doc && doc.address}`); }
      await sleep(100);
    }
    assert.equal(doc.port, server.port);
    await waitForConfig(server, jwt, (c) => c.address === '127.0.0.1', 'address reverted to 127.0.0.1');
    // Refused BEFORE the recycle: the working socket was never given up. The
    // re-serve's own log lines can land a beat after the file revert.
    let text;
    for (const deadline = Date.now() + 10_000; ; ) {
      try { ({ text } = await recentLogText(server, jwt, lastSeq)); } catch { text = ''; }
      if (/Access mStream locally/.test(text) && /keeping the listening socket/.test(text)) { break; }
      if (Date.now() > deadline) { break; }
      await sleep(100);
    }
    assert.match(text, /cannot be served \(EADDRNOTAVAIL\) .* keeping http:\/\/127\.0\.0\.1:/);
    assert.match(text, /Reboot: bind unchanged .* keeping the listening socket/);
    assert.doesNotMatch(text, /recycling the listener|retrying listen/);
    assert.match(text, /Access mStream locally/);
  });
});

describe(`the reboot sweep spares kept keep-alive connections (${label})`, () => {
  let server;
  let jwt;
  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', users: [{ ...ADMIN, admin: true }], ...startOpts });
    jwt = await login(server);
  });
  after(async () => { if (server) { await server.stop(); } });

  // One keep-alive connection: reuse it for a request served by the NEW app
  // shortly after the swap, then keep it alive across the +1 s sweep. It
  // used to be destroyed at +1 s regardless (it existed at reboot time),
  // resetting whatever the new app was sending on it - a browser's pooled
  // connection starting the next track.
  test('a pre-reboot idle connection reused by the new app is not destroyed at +1 s', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (p) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: p, agent, headers: { 'x-access-token': jwt } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
      });
      req.on('error', reject);
    });
    // Warm the pooled connection before the reboot, then leave it IDLE.
    assert.equal((await get('/api/v1/ping')).status, 200);
    const t0 = Date.now();
    const r = await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: true });
    assert.equal(r.status, 200);
    // Wait (on fresh connections) until the NEW app is serving, then send a
    // request down the idle pooled connection: it is served by the new app -
    // exactly the "browser starts the next track after the swap" shape...
    await waitForConfig(server, jwt, (c) => c.trustProxy === true, 'trustProxy=true');
    const mid = await get('/api/v1/ping');
    assert.equal(mid.status, 200);
    assert.equal(mid.reused, true, 'precondition: the pooled socket from before the reboot must be the one reused');
    // ...and it must survive the +1 s sweep: another request on the SAME
    // socket after that must not find it reset/closed.
    const untilSweepPassed = t0 + 1400 - Date.now();
    if (untilSweepPassed > 0) { await sleep(untilSweepPassed); }
    const late = await get('/api/v1/ping');
    assert.equal(late.status, 200);
    assert.equal(late.reused, true, 'the pooled keep-alive socket should still be the same one - the sweep must not have destroyed it');
    agent.destroy();
  });
});
}

suites('node', {});
// Same contract under the standalone-binary runtime (the one that bit
// hardest); skipped where bun is absent.
describe('bun', { skip: noBun }, () => { suites('bun', { execPath: BUN_BIN }); });
