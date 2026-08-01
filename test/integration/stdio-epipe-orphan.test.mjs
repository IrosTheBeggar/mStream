/**
 * An orphaned server must survive losing its console.
 *
 * When the process that spawned mStream (desktop app, Docker, npm, a service
 * manager) dies without reaping it, the server's stdout/stderr pipes lose
 * their reader. The next console write then raises EPIPE — and winston's
 * Console transport writes to process.stdout with no 'error' listener, so an
 * unguarded server escalates that to an uncaught exception and drops dead the
 * moment it logs anything (observed in the field: a ping or admin call made a
 * healthy orphan log itself to death, with the crash report lost down the
 * same dead pipe). src/util/stdio-guard.js swallows those stream errors.
 *
 * The dead parent is simulated from this side of the pipes: destroying OUR
 * read ends is, from the child's perspective, exactly what a crashed
 * supervisor looks like. The log write is then triggered via a failed login,
 * which winston.warn()s unconditionally (src/api/auth.js) — no auth or
 * library needed.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('stdio EPIPE survival (orphaned server)', () => {
  let server;

  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  });

  after(async () => { if (server) { await server.stop(); } });

  test('keeps serving after its stdio pipes lose their reader', async () => {
    const { proc, baseUrl } = server;

    assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

    // The dead parent: close the read ends of the child's stdio pipes.
    proc.stdout.destroy();
    proc.stderr.destroy();

    // Trigger console writes. The 401 response is delayed ~800ms by the
    // login throttle, so fire-and-forget; the winston.warn fires immediately
    // on receipt. A few rounds with settle time give the async stream
    // 'error' event every chance to surface (and kill an unguarded server).
    for (let i = 0; i < 4; i++) {
      fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ghost', password: 'nope' }),
      }).catch(() => { /* only the server's survival matters */ });
      await sleep(250);
    }

    assert.equal(proc.exitCode, null,
      'server process died after its stdio pipes broke');
    assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);
  });
});
