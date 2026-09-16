/**
 * The test-server harness (test/helpers/server.mjs) must never leave a
 * server behind — not even one a suite orphaned.
 *
 * What went wrong before: a suite booted two servers with
 * Promise.all([startServer(), startServer()]); under full-suite load on
 * Windows one boot missed its 90 s scan window and startServer threw WITHOUT
 * killing that child, while the sibling that had booted was never assigned
 * to the variable the suite's after() stops. Two live servers nobody could
 * reach kept the test process's stdio pipes open, `node --test` waited on
 * that file for ever, and `npm run test:integration` never exited.
 *
 * This runs a fixture file whose before() starts a server and then throws,
 * through a real `node --test` child, and checks that (a) the runner exits
 * at all, (b) it reports the fixture's failure, and (c) the orphaned server
 * process is gone afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'harness', 'orphan-before.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

test('an orphaned server does not hang the runner and does not survive it', { timeout: 180_000 }, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-orphan-')), 'pid');
  // This test itself runs inside a `node --test` worker, which carries
  // NODE_TEST_CONTEXT in its environment; an inner runner that inherits it
  // believes it is a worker too and never behaves as a runner. Strip it.
  const env = { ...process.env, ORPHAN_PID_FILE: pidFile };
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, ['--test', '--test-reporter=spec', FIXTURE], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  runner.stdout.on('data', (d) => { out += d; });
  runner.stderr.on('data', (d) => { out += d; });

  // The fixture's server boots in a few seconds; 120 s is the "it hung"
  // verdict, far above any healthy exit. Cancel the timer on exit — a
  // pending one would keep THIS worker alive for the full two minutes.
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 120_000);
    runner.once('exit', (code) => { clearTimeout(t); resolve({ code }); });
  });
  if (!exited) { try { runner.kill('SIGKILL'); } catch { /* noop */ } }
  assert.ok(exited, `node --test never exited: the orphaned server pinned it\n${out.slice(-2000)}`);
  assert.notEqual(exited.code, 0, 'the fixture is supposed to fail (its before() throws)');
  assert.match(out, /sibling boot failed \(simulated\)/, `the fixture's own failure must be reported\n${out.slice(-2000)}`);

  assert.ok(fs.existsSync(pidFile), 'the fixture recorded its server pid, so a server did boot');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  // TerminateProcess is asynchronous on Windows; give the tree a moment.
  for (let i = 0; i < 50 && alive(pid); i++) { await sleep(100); }
  assert.equal(alive(pid), false, `server pid ${pid} is still running after the runner exited`);
  fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
});
