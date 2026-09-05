/**
 * A soft reboot (admin config change) must not give up the listening socket
 * when the bind is unchanged, and must recycle it cleanly when it is.
 *
 * Why this matters: on Windows a listen socket is shared with every child
 * process holding an inherited handle to it, and under Bun <= 1.3.14 every
 * spawned child does (uSockets created inheritable handles — fixed upstream
 * in oven-sh/bun#36938, first released in Bun 1.4.0). A close()+listen() reboot
 * therefore got EADDRINUSE for as long as a scanner / transcode / ffmpeg
 * download / enrichment worker lived, and the old 5 s relisten budget then
 * took the whole process down. The reboot path now keeps the socket bound
 * (answering 503 while the app is rebuilt) unless port/address/TLS material
 * changed, and a same-port recycle retries EADDRINUSE patiently instead of
 * exiting.
 *
 * Covered here (Node always, Bun when installed):
 *   - same-bind reboot: no connection is ever refused during the window,
 *     every answer is a 503 or a real one, the new config lands, and the log
 *     says the socket was kept (no relisten, no retry);
 *   - bind-changed reboot (address): the listener is recycled and the API
 *     comes back on the new bind.
 * The Bun/child-process case itself is exercised end-to-end by the win-x64
 * leg of build-bun.yml (an ffmpeg download's PowerShell extractor is alive
 * at the reboot on a fast runner).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';

// MSTREAM_TEST_BUN_BIN points at a bun executable when `bun` on PATH is not
// spawnable without a shell (npm's bun.ps1/bun.cmd shim on Windows).
const BUN_BIN = process.env.MSTREAM_TEST_BUN_BIN || 'bun';
const bunProbe = spawnSync(BUN_BIN, ['--version'], { encoding: 'utf8' });
const bunAvailable = !bunProbe.error && bunProbe.status === 0;
const noBun = bunAvailable ? false : 'bun is not installed on this machine';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// The admin panel's live-log ring buffer survives the reboot's logger.reset(),
// so it is the black-box view of which reboot path ran.
async function recentLogText(server, jwt, sinceSeq = 0) {
  const r = await adminGet(server, jwt, `/api/v1/admin/logs/recent?since=${sinceSeq}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  return { text: body.entries.map(e => e.message ?? JSON.stringify(e)).join('\n'), lastSeq: body.lastSeq };
}

// One raw HTTP/1.1 GET on a fresh TCP connection. Resolves to the status code,
// or to a string naming the connection-level failure. During a kept-listener
// reboot the kernel keeps accepting, so a refusal here is the bug.
function rawGet(port, host, path, jwt) {
  return new Promise(resolve => {
    let buf = '';
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const sock = net.connect({ port, host }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nx-access-token: ${jwt}\r\nConnection: close\r\n\r\n`);
    });
    // 15 s, not 3: the property under test is "accepted, never REFUSED". The
    // reboot re-runs the boot chores on the event loop, and on a starved CI
    // runner one answer has taken longer than 3 s — that is slow, not refused.
    // A hung server still fails here, just later.
    sock.setTimeout(15_000, () => { done('timeout'); sock.destroy(); });
    sock.on('data', d => {
      buf += d;
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m) { done(Number(m[1])); sock.destroy(); }
    });
    sock.on('error', err => done(err.code || err.message));
    sock.on('close', () => done(buf ? 'closed-before-status' : 'closed-without-response'));
  });
}

async function waitForTrustProxy(server, jwt, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await adminGet(server, jwt, '/api/v1/admin/config');
      if (r.status === 200 && (await r.json()).trustProxy === expected) { return; }
    } catch { /* mid-reboot */ }
    if (Date.now() > deadline) { throw new Error(`trustProxy never became ${expected} after reboot`); }
    await sleep(100);
  }
}

async function waitForApi(baseUrl, jwt, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/ping`, { headers: { 'x-access-token': jwt } });
      if (r.status === 200) { return; }
    } catch { /* mid-reboot */ }
    if (Date.now() > deadline) { throw new Error(`API did not come back at ${baseUrl}`); }
    await sleep(100);
  }
}

function suite(label, startOpts) {
  describe(`soft reboot keeps the listener (${label})`, () => {
    let server;
    let jwt;

    before(async () => {
      server = await startServer({ dlnaMode: 'disabled', users: [{ ...ADMIN, admin: true }], ...startOpts });
      jwt = await login(server);
    });

    after(async () => { if (server) { await server.stop(); } });

    test('same-bind reboot: nothing is refused, the config lands, the socket was kept', async () => {
      const { lastSeq } = await recentLogText(server, jwt);

      const r = await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: true });
      assert.equal(r.status, 200);

      // Hammer fresh connections through the reboot window. Every one must be
      // accepted; every answer must be the reboot stub's 503 or a real reply.
      const outcomes = [];
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        outcomes.push(await rawGet(server.port, '127.0.0.1', '/api/v1/ping', jwt));
      }
      const bad = outcomes.filter(o => o !== 200 && o !== 503);
      assert.deepEqual(bad, [], `connection-level failures during the reboot window: ${JSON.stringify(outcomes)}`);
      assert.ok(outcomes.length > 0);

      await waitForTrustProxy(server, jwt, true);

      const { text } = await recentLogText(server, jwt, lastSeq);
      assert.match(text, /Rebooting Server/);
      assert.match(text, /Reboot: bind unchanged .* keeping the listening socket/);
      assert.doesNotMatch(text, /recycling the listener|retrying listen|already in use/);
      // The post-listen boot chores ran again on the kept socket.
      assert.match(text, /Access mStream locally/);

      // Leave the server as we found it (a second same-bind reboot).
      const r2 = await adminPost(server, jwt, '/api/v1/admin/config/trust-proxy', { trustProxy: false });
      assert.equal(r2.status, 200);
      await waitForTrustProxy(server, jwt, false);
    });

    test('bind-changed reboot (address): the listener is recycled and the API returns', async () => {
      const { lastSeq } = await recentLogText(server, jwt);
      // 127.0.0.1 -> 0.0.0.0 keeps 127.0.0.1 reachable but is a different bind.
      const r = await adminPost(server, jwt, '/api/v1/admin/config/address', { address: '0.0.0.0' });
      assert.equal(r.status, 200);
      await waitForApi(server.baseUrl, jwt);
      // Wait for the rebooted instance to report the new address.
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const c = await adminGet(server, jwt, '/api/v1/admin/config');
          if (c.status === 200 && (await c.json()).address === '0.0.0.0') { break; }
        } catch { /* mid-reboot */ }
        if (Date.now() > deadline) { throw new Error('address never became 0.0.0.0 after reboot'); }
        await sleep(100);
      }
      const { text } = await recentLogText(server, jwt, lastSeq);
      assert.match(text, /Reboot: bind changed .* recycling the listener/);
      assert.doesNotMatch(text, /keeping the listening socket|already in use/);
      assert.match(text, /Access mStream locally/);
    });
  });
}

suite('node', {});
// Same contract under the standalone-binary runtime. Skipped where bun is
// absent (the win-x64 CI smoke covers the shipped binary itself).
describe('bun', { skip: noBun }, () => { suite('bun', { execPath: BUN_BIN }); });
