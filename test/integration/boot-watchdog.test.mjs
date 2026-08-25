// The headless boot watchdog end to end (src/util/boot-watchdog.js wired
// into cli-boot-wrapper.js): a managed install whose committed version
// crashes during boot — a malformed config, the same crash class a bad
// release ships — recovers on the third invocation by rolling `current`
// back, holding the failed version, and handing the invocation to the
// previous version's binary.
//
// The wrapper is driven as a real child process; the managed layout comes
// from the MSTREAM_UPDATE_ROOT escape hatch (the same knob update-check and
// its integration suite use), which also waives the standalone-binary
// requirement so a source run can exercise the guard. posix-only: the
// previous version's stand-in server is a shell stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { serverRel, attemptsFilePath } from '../../src/util/boot-watchdog.js';
import packageJson from '../../package.json' with { type: 'json' };

const posixOnly = process.platform === 'win32';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function hostKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return process.platform === 'darwin' ? `darwin-${arch}` : `linux-${arch}`;
}

function dataHomeOf(home) {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'mStream')
    : path.join(home, '.local', 'share', 'mstream');
}

// A scratch managed layout: current -> a dir for the RUNNING (package.json)
// version, a previous 0.0.1 bundle whose "server" is a stub that answers -V
// and marks its takeover on a real run.
async function makeLayout(home) {
  const root = path.join(home, 'app');
  const currentDir = path.join(root, `mStream-${packageJson.version}-${hostKey()}`);
  const prevDir = path.join(root, `mStream-0.0.1-${hostKey()}`);
  const prevServer = path.join(prevDir, serverRel());
  await fs.mkdir(currentDir, { recursive: true });
  await fs.mkdir(path.dirname(prevServer), { recursive: true });
  await fs.writeFile(prevServer, '#!/bin/sh\n'
    + 'if [ "${1:-}" = -V ]; then echo 0.0.1; exit 0; fi\n'
    + 'echo "PREV-SERVER-TOOK-OVER args=$*"\n'
    + 'exit 0\n');
  await fs.chmod(prevServer, 0o755);
  await fs.symlink(currentDir, path.join(root, 'current'));
  return { root, currentDir, prevDir };
}

function runWrapper(args, home, root) {
  return spawnSync(process.execPath, ['cli-boot-wrapper.js', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: home,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      MSTREAM_UPDATE_ROOT: root,
    },
  });
}

test('three crashed boots roll back, hold the version, and hand off to the previous binary', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-bwd-loop-'));
  try {
    const { root, prevDir } = await makeLayout(home);
    const dataHome = dataHomeOf(home);
    const badConf = path.join(home, 'bad-config.json');
    await fs.writeFile(badConf, 'not json at all{');

    // Boots 1 and 2: the guard counts, the config crash proceeds as today.
    for (const expected of [1, 2]) {
      const r = runWrapper(['-j', badConf], home, root);
      assert.equal(r.status, 1, `boot ${expected} must still fail on the broken config`);
      const doc = JSON.parse(fss.readFileSync(attemptsFilePath(dataHome), 'utf8'));
      assert.equal(doc.version, packageJson.version);
      assert.equal(doc.attempts, expected);
      assert.equal(
        await fs.readlink(path.join(root, 'current')),
        path.join(root, `mStream-${packageJson.version}-${hostKey()}`),
        'current must not move before the attempt budget is spent'
      );
    }

    // Boot 3: rollback + handoff. The stub exits 0 and the wrapper mirrors
    // it; the same argv rides through to the previous binary.
    const r3 = runWrapper(['-j', badConf], home, root);
    assert.equal(r3.status, 0, `handoff run failed: ${r3.stderr}`);
    assert.match(r3.stdout, /PREV-SERVER-TOOK-OVER args=-j /);
    assert.match(r3.stderr, /\[boot-watchdog\] .* rolling back to 0\.0\.1/);
    assert.equal(await fs.readlink(path.join(root, 'current')), prevDir);
    const hold = JSON.parse(await fs.readFile(path.join(dataHome, 'update-hold.json'), 'utf8'));
    assert.deepEqual(hold.held.map((h) => h.version), [packageJson.version]);

    // Boot 4: current is no longer committed to this version — the guard
    // stands down (no count, no re-roll) and the crash surfaces as-is.
    const before = fss.readFileSync(attemptsFilePath(dataHome), 'utf8');
    const r4 = runWrapper(['-j', badConf], home, root);
    assert.equal(r4.status, 1);
    assert.equal(fss.readFileSync(attemptsFilePath(dataHome), 'utf8'), before,
      'a layout committed elsewhere must not be counted against');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('-V and -h never touch the attempt counter (the installers\' exec probe stays pure)', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-bwd-probe-'));
  try {
    const { root } = await makeLayout(home);
    const v = runWrapper(['-V'], home, root);
    assert.equal(v.status, 0);
    assert.equal(v.stdout.trim(), packageJson.version);
    const h = runWrapper(['-h'], home, root);
    assert.equal(h.status, 0);
    await assert.rejects(fs.access(attemptsFilePath(dataHomeOf(home))),
      'probe invocations must leave no attempt record');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('a successful listen acknowledges the boot and clears the counter', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-bwd-ok-'));
  try {
    const { root } = await makeLayout(home);
    const dataHome = dataHomeOf(home);
    // As if one crashed boot already happened.
    await fs.mkdir(dataHome, { recursive: true });
    await fs.writeFile(attemptsFilePath(dataHome), JSON.stringify({
      schema: 1, version: packageJson.version, attempts: 1, firstAt: new Date().toISOString(),
    }));
    const srv = await startServer({
      waitForScan: false,
      env: {
        HOME: home,
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        MSTREAM_UPDATE_ROOT: root,
      },
    });
    try {
      // markBootOk fires in onListening; the helper resolving means the API
      // answered, which is later still. Poll briefly for the unlink.
      const start = Date.now();
      let gone = false;
      while (Date.now() - start < 10_000) {
        if (!fss.existsSync(attemptsFilePath(dataHome))) { gone = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(gone, true, 'the attempt counter must clear once the server listens');
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
