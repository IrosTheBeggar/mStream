/**
 * stdio behavior when the console pipes lose their reader (dead parent).
 *
 * When the process that spawned mStream (desktop app, Docker, npm, a service
 * manager) dies without reaping it, the server's stdout/stderr pipes lose
 * their reader and the next console write raises EPIPE — and winston's
 * Console transport writes to process.stdout with no 'error' listener, so an
 * unguarded server escalates that to an uncaught exception and drops dead
 * (observed in the field: a ping or admin call made a healthy orphan log
 * itself to death, with the crash report lost down the same dead pipe).
 *
 * The guard (src/util/stdio-guard.js) is deliberately Bun-only: the shipped
 * standalone binaries are Bun builds, and they are what supervisors spawn
 * and orphan; node/npm installs keep Node's stock fail-fast semantics. Both
 * halves of that decision are pinned here:
 *
 *   - under Node, the server still DIES on its first post-breakage write —
 *     the guard must not install (widen the gate deliberately, not by
 *     accident, if that ever changes);
 *   - under Bun, it survives and drops the [stdio] breadcrumb into the
 *     live-log ring (skipped when bun isn't installed on this machine).
 *
 * The dead parent is simulated from this side of the pipes: destroying OUR
 * read ends is, from the child's perspective, exactly what a crashed
 * supervisor looks like. The log write is then triggered via a failed login,
 * which winston.warn()s unconditionally (src/api/auth.js) — no auth or
 * library needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const bunProbe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bunAvailable = !bunProbe.error && bunProbe.status === 0;

// Fire-and-forget a request that makes the server log (failed logins warn
// unconditionally, even with zero users). The response is throttled ~800ms
// and the server may die mid-request — only the write attempt matters.
function triggerLogWrite(baseUrl) {
  fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: 'nope' }),
  }).catch(() => { /* expected when the server dies underneath it */ });
}

test('Node keeps stock fail-fast stdio (guard is Bun-only)', async () => {
  const server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  try {
    const { proc, baseUrl } = server;
    assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.stdout.destroy();
    proc.stderr.destroy();
    triggerLogWrite(baseUrl);

    // Any post-breakage write (our trigger, or a background scan line) must
    // take the unguarded server down promptly. The timer is cleared so a
    // fast pass doesn't hold the test process open for the full window.
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), 8000); });
    const code = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    assert.notEqual(code, 'timeout',
      'expected the Node server to die on EPIPE — stock semantics; is the guard installing under Node?');
  } finally {
    await server.stop();
  }
});

test('Bun survives losing its console and leaves a breadcrumb',
  { skip: bunAvailable ? false : 'bun is not installed on this machine' },
  async () => {
    const server = await startServer(
      { dlnaMode: 'disabled', waitForScan: false, execPath: 'bun' });
    try {
      const { proc, baseUrl } = server;
      assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

      proc.stdout.destroy();
      proc.stderr.destroy();

      // A few rounds with settle time give the async stream 'error' event
      // every chance to surface (and kill an unguarded server).
      for (let i = 0; i < 4; i++) {
        triggerLogWrite(baseUrl);
        await sleep(250);
      }

      assert.equal(proc.exitCode, null,
        'guarded Bun server died after its stdio pipes broke');
      assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

      // The guard leaves one breadcrumb in the live-log ring so the admin
      // viewer records why console output stopped (public mode → no token).
      const logs = await (await fetch(`${baseUrl}/api/v1/admin/logs/recent?since=0`)).json();
      assert.ok(
        logs.entries.some(e => e.message.startsWith('[stdio] ') && e.message.includes('write failed')),
        'expected a [stdio] breadcrumb in the live-log ring');
    } finally {
      await server.stop();
    }
  });
