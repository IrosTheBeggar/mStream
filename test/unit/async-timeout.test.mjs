/**
 * src/util/async.js — withTimeout / settleWithin.
 *
 * These exist to fix a leak, so the load-bearing test is not "does it return
 * the right value" but "is the loser's timer disarmed". A pending timer keeps
 * node's event loop alive, so the regression is observable as a PROCESS THAT
 * WILL NOT EXIT — which is exactly what the spawn tests below assert, and what
 * a purely in-process assertion would miss entirely.
 *
 * Before the fix, connectTunnel() held the loop 25s after a connect that
 * resolved in milliseconds (test/integration/iroh-handshake.test.mjs: 26.6s
 * for 2.1s of tests).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withTimeout, settleWithin } from '../../src/util/async.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'util', 'async.js')).href;

// Run `body` in a fresh node process and report how long until it EXITS.
// The timer under test is given a 60s deadline: if it is left armed the child
// cannot exit before then, so any pass here means it was cleared.
function msUntilExit(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { withTimeout, settleWithin } from ${JSON.stringify(MODULE_URL)};\n${body}`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const t0 = Date.now();
    // Well under the 60s deadline the child would wait out if it leaked, and
    // well over the ~0s a disarmed timer needs.
    const cap = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(cap);
      if (signal === 'SIGKILL') { return reject(new Error('child never exited — timer left armed')); }
      if (code !== 0) { return reject(new Error(`child exited ${code}: ${stderr.slice(-400)}`)); }
      resolve(Date.now() - t0);
    });
  });
}

describe('withTimeout', () => {
  test('resolves with the promise value when it wins', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 60_000, 'nope'), 'ok');
  });

  test('rejects with the given message when the deadline wins', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 10, 'too slow'),
      /too slow/);
  });

  test('propagates the promise\'s own rejection unchanged', async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error('inner')), 60_000, 'deadline'),
      /inner/);
  });

  test('disarms the timer once the promise wins — the process exits', async () => {
    const ms = await msUntilExit('await withTimeout(Promise.resolve(1), 60_000, "x");');
    assert.ok(ms < 15_000, `expected a prompt exit, took ${ms}ms`);
  });

  test('disarms the timer when the promise REJECTS, not just when it resolves',
    async () => {
      const ms = await msUntilExit(
        'try { await withTimeout(Promise.reject(new Error("e")), 60_000, "x"); } catch {}');
      assert.ok(ms < 15_000, `expected a prompt exit, took ${ms}ms`);
    });
});

describe('settleWithin', () => {
  test('resolves with the promise value when it wins', async () => {
    assert.equal(await settleWithin(Promise.resolve('ok'), 60_000, 'fallback'), 'ok');
  });

  test('resolves with timeoutValue when the timer wins', async () => {
    assert.equal(await settleWithin(new Promise(() => {}), 10, 'fallback'), 'fallback');
  });

  test('resolves undefined when the timer wins and no timeoutValue was given', async () => {
    assert.equal(await settleWithin(new Promise(() => {}), 10), undefined);
  });

  test('disarms the timer once the promise wins — the process exits', async () => {
    const ms = await msUntilExit('await settleWithin(Promise.resolve(1), 60_000, false);');
    assert.ok(ms < 15_000, `expected a prompt exit, took ${ms}ms`);
  });
});
