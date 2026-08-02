/**
 * Lost supervision must end in a clean, logged self-termination.
 *
 * A supervisor that dies abruptly (desktop-app crash, force-kill) can't
 * clean up its child — the server it spawned lives on as an orphan holding
 * the supervisor's port, and its next console write EPIPE-crashes it at some
 * arbitrary later moment with the crash report lost down the dead pipe.
 * src/util/supervision.js turns both halves of that into deliberate
 * shutdowns:
 *
 *   - console loss (always on): a stdout/stderr write error → log the
 *     reason → exit 74 (sysexits EX_IOERR; distinct from the uncaught
 *     crash's exit 1, and nonzero so restart-on-failure supervisors bring
 *     the server back with fresh pipes);
 *   - `--supervised` (opt-in): stdin EOF — what a dead parent's closed
 *     pipe produces — → log → exit 0, immediately, no log write needed.
 *
 * The dead parent is simulated from this side of the pipes: destroying our
 * read ends (or closing our stdin write end) is, from the child's
 * perspective, exactly what a crashed supervisor looks like. Log writes are
 * triggered via a failed login, which winston.warn()s unconditionally
 * (src/api/auth.js) — no auth or library needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

// Waits for the child to exit, capped so a server that wrongly survives
// fails the test instead of hanging it. The timer is cleared on the fast
// path so a passing run doesn't hold the test process open.
function exitWithin(proc, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    proc.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function readLogFiles(tmpDir) {
  const dir = path.join(tmpDir, 'logs');
  let out = '';
  for (const f of await fs.readdir(dir).catch(() => [])) {
    out += await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
  }
  return out;
}

test('console loss → clean exit 74 with the reason on disk', async () => {
  // stdin stays the default 'ignore' (/dev/null): this doubles as the pin
  // that WITHOUT --supervised, an immediate stdin EOF must NOT shut the
  // server down — it boots and serves normally.
  const server = await startServer({
    dlnaMode: 'disabled', waitForScan: false, extraConfig: { writeLogs: true },
  });
  try {
    const { proc, baseUrl, tmpDir } = server;
    assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

    const exited = exitWithin(proc, 10_000);

    // The dead parent: close the read ends of the child's stdio pipes,
    // then make the server log (the response is throttled ~800ms and the
    // server exits underneath it, so fire-and-forget).
    proc.stdout.destroy();
    proc.stderr.destroy();
    fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'nope' }),
    }).catch(() => { /* expected */ });

    const code = await exited;
    assert.notEqual(code, 'timeout', 'server kept running after losing its console');
    assert.equal(code, 74, 'expected the deliberate EX_IOERR exit, not an uncaught crash');

    const logs = await readLogFiles(tmpDir);
    assert.match(logs, /console lost, shutting down/,
      'expected the shutdown reason in the on-disk log');
  } finally {
    await server.stop();
  }
});

test('--supervised: stdin EOF → immediate clean exit 0', async () => {
  const server = await startServer({
    dlnaMode: 'disabled', waitForScan: false, extraConfig: { writeLogs: true },
    extraArgs: ['--supervised'], stdin: 'pipe',
  });
  try {
    const { proc, baseUrl, tmpDir } = server;
    assert.equal((await fetch(`${baseUrl}/api/v1/ping`)).status, 200);

    const exited = exitWithin(proc, 10_000);
    proc.stdin.end(); // the supervisor vanishes — no log write required

    const code = await exited;
    assert.notEqual(code, 'timeout', 'supervised server ignored stdin EOF');
    assert.equal(code, 0, 'supervised shutdown is an orderly stop');

    const logs = await readLogFiles(tmpDir);
    assert.match(logs, /supervisor closed stdin/,
      'expected the shutdown reason in the on-disk log');
  } finally {
    await server.stop();
  }
});
