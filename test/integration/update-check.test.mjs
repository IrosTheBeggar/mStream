// End-to-end auto-update round-trip against a LOCAL fake release feed:
// check -> auto-stage (the embedded-installer path, which for a source run
// is the repo's own install.sh) -> `current` flipped -> tamper refused ->
// settings persist without a reboot -> non-managed installs refuse staging.
//
// The server is pointed at a scratch "release" over loopback HTTP via
// MSTREAM_RELEASE_BASE (the same knob the install scripts and CI contract
// job use) and at a scratch managed root via MSTREAM_UPDATE_ROOT. HOME is
// redirected so update-status.json and install.sh's side effects land in
// the test's temp dir, never in the developer's real data home.
//
// Windows is covered by the unit decision table + the installer-contract
// job: this suite's fake-bundle zips and install.sh staging are posix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import packageJson from '../../package.json' with { type: 'json' };

const posixOnly = process.platform === 'win32';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bundle key install.sh will derive on this host.
function hostKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return process.platform === 'darwin' ? `darwin-${arch}` : `linux-${arch}`;
}

let relDir; let relPort; let relServer; let tmpHome;

function makeBundle(version, key, { broken = false, probeFail = false } = {}) {
  const b = `mStream-${version}-${key}`;
  const dir = path.join(relDir, b);
  const inner = key.startsWith('darwin')
    ? path.join(dir, 'mStream.app', 'Contents', 'MacOS')
    : dir;
  spawnSync('mkdir', ['-p', inner]);
  const server = path.join(inner, 'mstream-server');
  // broken = a binary this host "cannot exec": the probe-before-flip in
  // install.sh must refuse it and the stager must report a failed stage.
  // probeFail = the subtler bad release: -V answers (the exec probe
  // passes), but the DEEP probe reports it would not boot - install.sh
  // must refuse on the sentinel.
  const stub = broken
    ? `printf '#!/bin/sh\\nexit 1\\n' > '${server}'`
    : probeFail
      ? `printf '#!/bin/sh\\n[ "$1" = -V ] && { echo ${version}; exit 0; }\\n[ "$1" = --boot-probe ] && { echo "boot-probe: FAIL simulated boot regression"; exit 1; }\\nexit 0\\n' > '${server}'`
      : `printf '#!/bin/sh\\n[ "$1" = -V ] && echo ${version}\\nexit 0\\n' > '${server}'`;
  spawnSync('bash', ['-c', `${stub} && chmod +x '${server}'`]);
  spawnSync('bash', ['-c', `echo 'fake bundle' > '${dir}/README.txt'`]);
  const zip = spawnSync('python3', ['-m', 'zipfile', '-c', `${b}.zip`, b], { cwd: relDir });
  assert.equal(zip.status, 0, `zip failed: ${zip.stderr}`);
  spawnSync('rm', ['-rf', dir]);
}

async function publish(version, { tamper = false, broken = false, probeFail = false } = {}) {
  for (const f of await fs.readdir(relDir)) {
    if (f.endsWith('.zip') || f === 'manifest.json') { await fs.rm(path.join(relDir, f)); }
  }
  makeBundle(version, hostKey(), { broken, probeFail });
  const gen = spawnSync('sh', [path.join(REPO_ROOT, 'scripts', 'release-manifest.sh'), version, relDir]);
  assert.equal(gen.status, 0, `manifest generation failed: ${gen.stderr}`);
  if (tamper) {
    const m = path.join(relDir, 'manifest.json');
    const doc = await fs.readFile(m, 'utf8');
    await fs.writeFile(m, doc.replace(/"sha256": "[0-9a-f]*"/, `"sha256": "${'0'.repeat(64)}"`));
  }
}

before(async function () {
  if (posixOnly) { return; }
  relDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-rel-'));
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-home-'));
  await fs.mkdir(path.join(tmpHome, 'Applications'), { recursive: true });
  relServer = http.createServer(async (req, res) => {
    try {
      const f = path.join(relDir, path.basename(new URL(req.url, 'http://x').pathname));
      res.end(await fs.readFile(f));
    } catch {
      res.statusCode = 404; res.end('nope');
    }
  });
  await new Promise((resolve) => relServer.listen(0, '127.0.0.1', resolve));
  relPort = relServer.address().port;
});

after(async () => {
  if (relServer) { relServer.close(); }
  for (const d of [relDir, tmpHome]) {
    if (d) { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
  }
});

function updEnv() {
  return {
    HOME: tmpHome,
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    MSTREAM_RELEASE_BASE: `http://127.0.0.1:${relPort}`,
    MSTREAM_UPDATE_ROOT: path.join(tmpHome, 'app'),
  };
}

async function pollStatus(baseUrl, pred, timeoutMs = 60_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${baseUrl}/api/v1/admin/update`);
    last = await r.json();
    if (pred(last)) { return last; }
    await sleep(250);
  }
  throw new Error(`status never satisfied predicate; last: ${JSON.stringify(last)}`);
}

test('managed round-trip: check, auto-stage, current flip, tamper refusal, live settings', { skip: posixOnly }, async () => {
  await publish('9.9.9');
  // --supervised + held stdin: the status file is written only by the
  // launcher-supervised instance (a shared data home must not be clobbered
  // by unrelated instances), and this test asserts on that file.
  const srv = await startServer({
    waitForScan: false, env: updEnv(),
    extraArgs: ['--supervised'], stdin: 'pipe',
  });
  try {
    // Boot state: forced-managed, nothing known yet.
    let s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update`)).json();
    assert.equal(s.method, 'managed');
    assert.equal(s.current, packageJson.version);
    assert.equal(s.staged, false);

    // Check: finds 9.9.9 and (default mode: staging is part of both stage
    // and auto) starts the download on its own.
    const check = await (await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' })).json();
    assert.equal(check.available, true);
    assert.equal(check.latest, '9.9.9');

    s = await pollStatus(srv.baseUrl, (x) => x.staged || x.error);
    assert.equal(s.error, null, `staging errored: ${s.error}`);
    assert.equal(s.staged, true);
    assert.equal(s.stagedVersion, '9.9.9');

    // The layout agreement: $ROOT/current -> the staged bundle.
    const root = path.join(tmpHome, 'app');
    const target = await fs.readlink(path.join(root, 'current'));
    assert.equal(path.basename(target), `mStream-9.9.9-${hostKey()}`);

    // The status file the launcher reads, in the redirected data home.
    // POLLED, not read once: the API state and the on-disk file are two
    // writes, and even with the server persisting immediately after the
    // flip, asserting on a single read races the fsync on a loaded
    // runner (this exact assert flaked on a full-ci macos shard).
    const statusPath = process.platform === 'darwin'
      ? path.join(tmpHome, 'Library', 'Application Support', 'mStream', 'update-status.json')
      : path.join(tmpHome, '.local', 'share', 'mstream', 'update-status.json');
    const onDisk = await (async () => {
      const start = Date.now();
      let last = null;
      while (Date.now() - start < 10_000) {
        try {
          last = JSON.parse(await fs.readFile(statusPath, 'utf8'));
          if (last.staged === true) { return last; }
        } catch { /* not written yet */ }
        await sleep(100);
      }
      throw new Error(`status file never reported staged:true; last: ${JSON.stringify(last)}`);
    })();
    assert.equal(onDisk.staged, true);
    assert.equal(onDisk.stagedVersion, '9.9.9');

    // A tampered release must not replace what is staged.
    await publish('9.9.10', { tamper: true });
    await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
    s = await pollStatus(srv.baseUrl, (x) => (x.error || '').includes('Staging failed'));
    assert.match(s.error, /Staging failed/);
    assert.equal(path.basename(await fs.readlink(path.join(root, 'current'))), `mStream-9.9.9-${hostKey()}`);

    // A bundle whose binary cannot exec must never take over: install.sh's
    // probe-before-flip refuses, the stager reports a failed stage, and
    // `current` stays put.
    await publish('9.9.11', { broken: true });
    await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
    // Match the probe's own words, not just 'Staging failed' — the tamper
    // step above already left that prefix in state.error.
    s = await pollStatus(srv.baseUrl, (x) => (x.error || '').includes('does not run on this system'));
    assert.match(s.error, /Staging failed/);
    assert.equal(path.basename(await fs.readlink(path.join(root, 'current'))), `mStream-9.9.9-${hostKey()}`);

    // Skip round-trip: a good newer release stages; skipping it un-stages
    // AND re-points current at the running version's folder; unskipping
    // re-stages it. This is the rollback companion — without it the daily
    // check silently re-flips onto the release the operator backed out of.
    await publish('9.9.12');
    await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
    s = await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.12');
    // A folder for the RUNNING version so the un-flip has a target (a real
    // managed install always has one; this server runs from source).
    const runningDir = path.join(root, `mStream-${packageJson.version}-${hostKey()}`);
    await fs.mkdir(runningDir, { recursive: true });
    const skipSet = await fetch(`${srv.baseUrl}/api/v1/admin/update/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipVersion: '9.9.12' }),
    });
    assert.equal(skipSet.status, 200);
    s = await pollStatus(srv.baseUrl, (x) => x.skipped && !x.staged);
    assert.equal(s.stagedVersion, null);
    assert.equal(await fs.readlink(path.join(root, 'current')), runningDir);
    const dlSkipped = await fetch(`${srv.baseUrl}/api/v1/admin/update/download`, { method: 'POST' });
    assert.equal(dlSkipped.status, 409);
    const unskip = await fetch(`${srv.baseUrl}/api/v1/admin/update/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipVersion: '' }),
    });
    assert.equal(unskip.status, 200);
    s = await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.12' && !x.skipped);

    // Settings persist to the config file and apply live.
    const set = await fetch(`${srv.baseUrl}/api/v1/admin/update/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'notify', check: false }),
    });
    assert.equal(set.status, 200);
    s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update`)).json();
    assert.equal(s.mode, 'notify');
    assert.equal(s.check, false);

    // Garbage settings are refused.
    const bad = await fetch(`${srv.baseUrl}/api/v1/admin/update/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'yolo' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.stop();
  }
});

// The per-OS data home under a redirected HOME — where update-status.json
// and update-hold.json land (userDataHome() in src/util/esm-helpers.js).
function dataHomeOf(home) {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'mStream')
    : path.join(home, '.local', 'share', 'mstream');
}

function envFor(home) {
  return {
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    MSTREAM_RELEASE_BASE: `http://127.0.0.1:${relPort}`,
    MSTREAM_UPDATE_ROOT: path.join(home, 'app'),
  };
}

test('boot-failure holds: held version never stages, a newer release supersedes it, clearHold overrides', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-hold-'));
  try {
    // As if the launcher's watchdog rolled 9.9.20 back before this boot.
    const holdPath = path.join(dataHomeOf(home), 'update-hold.json');
    await fs.mkdir(path.dirname(holdPath), { recursive: true });
    await fs.writeFile(holdPath, JSON.stringify({
      schema: 1,
      held: [{ version: '9.9.20', at: 0, reason: 'server exited before it finished starting after an update' }],
    }));
    await publish('9.9.20');
    const srv = await startServer({
      waitForScan: false, env: envFor(home),
      extraArgs: ['--supervised'], stdin: 'pipe',
    });
    try {
      // The hold is visible from boot, before any check.
      let s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update`)).json();
      assert.deepEqual(s.heldVersions, ['9.9.20']);

      // The held version is reported but never staged (the default mode
      // would otherwise download and flip on this very check).
      s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' })).json();
      assert.equal(s.available, true);
      assert.equal(s.latest, '9.9.20');
      assert.equal(s.held, true);
      assert.equal(s.staged, false);
      await assert.rejects(fs.access(path.join(home, 'app', 'current')), 'a held version must never reach current');

      // An explicit download is refused, with the reason.
      const dl = await fetch(`${srv.baseUrl}/api/v1/admin/update/download`, { method: 'POST' });
      assert.equal(dl.status, 409);
      assert.match((await dl.json()).error, /failed to start .* held back/);

      // A newer release supersedes the hold: it stages normally while the
      // hold on the bad version stays on file (still newer than what runs).
      await publish('9.9.21');
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      s = await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.21');
      assert.equal(s.held, false);
      assert.deepEqual(s.heldVersions, ['9.9.20']);

      // Operator override: clearHold drops the record entirely.
      const clear = await fetch(`${srv.baseUrl}/api/v1/admin/update/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearHold: true }),
      });
      assert.equal(clear.status, 200);
      s = await pollStatus(srv.baseUrl, (x) => x.heldVersions.length === 0);
      await assert.rejects(fs.access(holdPath), 'a cleared hold file must be gone');
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('enforceHold re-points a current link left on a held version', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-enforce-'));
  try {
    // The layout a half-finished rollback leaves: current still aims at the
    // held version, while the previous (running) version's folder exists.
    const root = path.join(home, 'app');
    const heldDir = path.join(root, `mStream-9.9.20-${hostKey()}`);
    const runningDir = path.join(root, `mStream-${packageJson.version}-${hostKey()}`);
    await fs.mkdir(heldDir, { recursive: true });
    await fs.mkdir(runningDir, { recursive: true });
    await fs.symlink(heldDir, path.join(root, 'current'));
    const holdPath = path.join(dataHomeOf(home), 'update-hold.json');
    await fs.mkdir(path.dirname(holdPath), { recursive: true });
    await fs.writeFile(holdPath, JSON.stringify({ schema: 1, held: [{ version: '9.9.20', at: 0, reason: 't' }] }));
    await publish('9.9.20'); // the held version is also "latest": nothing may stage
    const srv = await startServer({
      waitForScan: false, env: envFor(home),
      extraArgs: ['--supervised'], stdin: 'pipe',
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      const start = Date.now();
      let target = null;
      while (Date.now() - start < 10_000) {
        target = await fs.readlink(path.join(root, 'current')).catch(() => null);
        if (target === runningDir) { break; }
        await sleep(100);
      }
      assert.equal(target, runningDir, 'current must be re-pointed at the running version');
      const s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update`)).json();
      assert.equal(s.held, true);
      assert.equal(s.staged, false);
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

// Supervision signals the RUNNER environment may carry (GitHub's runners
// live under systemd) must not leak into the spawned server: exported-but-
// empty reads as unset on the detection side.
function scrubSupervision(env) {
  return { ...env, MSTREAM_SUPERVISED: '', pm_id: '', INVOCATION_ID: '' };
}

test('a release that execs but would not boot is refused BEFORE the flip', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-probe-'));
  try {
    await publish('9.9.40');
    const srv = await startServer({
      waitForScan: false, env: envFor(home),
      extraArgs: ['--supervised'], stdin: 'pipe',
    });
    try {
      // A good release stages and flips normally.
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.40');
      const root = path.join(home, 'app');
      assert.equal(path.basename(await fs.readlink(path.join(root, 'current'))), `mStream-9.9.40-${hostKey()}`);

      // The subtle bad release: -V answers, the deep probe says "would not
      // boot". install.sh must refuse on the sentinel and leave `current`
      // exactly where it was - the stage-time refusal that self-heals when
      // the next release ships, with no watchdog ever needed.
      await publish('9.9.41', { probeFail: true });
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      const s = await pollStatus(srv.baseUrl, (x) => (x.error || '').includes('would not BOOT'));
      assert.match(s.error, /Staging failed/);
      assert.equal(path.basename(await fs.readlink(path.join(root, 'current'))), `mStream-9.9.40-${hostKey()}`,
        'a probe-refused release must never reach current');
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('auto mode without a supervisor stages but never self-exits', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-nosup-'));
  try {
    await publish('9.9.30');
    const srv = await startServer({
      waitForScan: true,   // the idle gate must be about supervision, not the boot scan
      env: { ...scrubSupervision(envFor(home)), MSTREAM_UPDATE_IDLE_QUIET_MS: '0' },
      extraConfig: { updates: { mode: 'auto', check: true } },
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      // headlessSupervisor lands 'none' only after maybeAutoApply passed
      // every earlier gate (staged, idle) and declined at supervision — so
      // this both proves the decline AND that the decline was the only
      // thing between the server and an exit.
      const s = await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.30'
        && x.headlessSupervisor === 'none');
      assert.equal(s.mode, 'auto');
      // The old behavior exited 0 about 1.5s after arming. Give it triple
      // that, then require the server alive and still answering.
      await sleep(5000);
      assert.equal(srv.proc.exitCode, null, 'an unsupervised auto server must not self-exit');
      const alive = await fetch(`${srv.baseUrl}/api/v1/admin/update`);
      assert.equal(alive.status, 200);
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('the idle gate holds an armed apply until a quiet window elapses', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-quiet-'));
  try {
    await publish('9.9.60');
    const srv = await startServer({
      waitForScan: true,
      // A short but real quiet window: recent activity must block the arm,
      // and its expiry must release it. The status poll itself is excluded
      // from the activity clock (GET /api/v1/admin/update), so polling for
      // the outcome cannot keep the server "active".
      env: { ...scrubSupervision(envFor(home)), MSTREAM_UPDATE_IDLE_QUIET_MS: '6000' },
      extraArgs: ['--supervised'], stdin: 'pipe',
      extraConfig: { updates: { mode: 'auto', check: true } },
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.60');
      // Fresh activity (a normal request): the quiet window has not
      // elapsed, so nothing may arm — the apply poll is paced to the
      // window, so give it one full cycle to prove the restraint.
      await fetch(`${srv.baseUrl}/api/`);
      await sleep(2000);
      let s = await (await fetch(`${srv.baseUrl}/api/v1/admin/update`)).json();
      assert.equal(s.applyRequested, false, 'an active server must not arm the apply');
      // Go quiet (only excluded status polls from here): the timer arms it
      // within roughly one window past the quiet threshold.
      s = await pollStatus(srv.baseUrl, (x) => x.applyRequested === true, 20_000);
      assert.equal(s.stagedVersion, '9.9.60');
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('supervised auto mode arms the launcher through the status file', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-arm-'));
  try {
    await publish('9.9.50');
    const srv = await startServer({
      waitForScan: true,   // idle must gate on supervision state, not the boot scan
      env: { ...scrubSupervision(envFor(home)), MSTREAM_UPDATE_IDLE_QUIET_MS: '0' },
      extraArgs: ['--supervised'], stdin: 'pipe',
      extraConfig: { updates: { mode: 'auto', check: true } },
    });
    try {
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.50');
      // The launcher contract: the on-disk file carries the arm plus a
      // FRESH per-request token (the launcher retries a failed apply only
      // when a new token appears - update-watchdog/apply smokes drive the
      // consuming side with the real binary).
      const statusPath = path.join(dataHomeOf(home), 'update-status.json');
      const start = Date.now();
      let doc = null;
      while (Date.now() - start < 15_000) {
        try {
          doc = JSON.parse(await fs.readFile(statusPath, 'utf8'));
          if (doc.applyRequested === true) { break; }
        } catch { /* not written yet */ }
        await sleep(150);
      }
      assert.equal(doc?.applyRequested, true, `status file never armed: ${JSON.stringify(doc)}`);
      assert.equal(doc.stagedVersion, '9.9.50');
      assert.ok(!Number.isNaN(Date.parse(doc.applyRequestedAt)), `token must be a timestamp: ${doc.applyRequestedAt}`);
      // Supervised = the LAUNCHER restarts us; the server itself must not
      // exit (that is the headless branch's move, gated separately).
      await sleep(3000);
      assert.equal(srv.proc.exitCode, null, 'a supervised server must never self-exit');
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('auto mode with MSTREAM_SUPERVISED=1 applies by exiting 0', { skip: posixOnly }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-sup-'));
  try {
    await publish('9.9.31');
    const srv = await startServer({
      waitForScan: true,
      env: { ...scrubSupervision(envFor(home)), MSTREAM_SUPERVISED: '1', MSTREAM_UPDATE_IDLE_QUIET_MS: '0' },
      extraConfig: { updates: { mode: 'auto', check: true } },
    });
    try {
      const exited = new Promise((resolve) => srv.proc.once('exit', resolve));
      await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' });
      await pollStatus(srv.baseUrl, (x) => x.staged && x.stagedVersion === '9.9.31')
        .catch(() => { /* the exit can outrun the poll - the assert below decides */ });
      const code = await Promise.race([
        exited,
        sleep(60_000).then(() => { throw new Error('supervised auto server never exited'); }),
      ]);
      assert.equal(code, 0, 'the headless apply is a clean exit for the supervisor to restart');
      assert.equal(
        path.basename(await fs.readlink(path.join(home, 'app', 'current'))),
        `mStream-9.9.31-${hostKey()}`,
        'the exit happened with the update staged behind current'
      );
    } finally {
      await srv.stop();
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('non-managed installs refuse staging; apply refuses with nothing staged', { skip: posixOnly }, async () => {
  await publish('9.9.9');
  const env = updEnv();
  delete env.MSTREAM_UPDATE_ROOT; // source run -> method npm-source
  // A separate home: this instance is NOT launcher-supervised, so it must
  // never write a status file at all (a docker/npm instance sharing the
  // data home would otherwise clobber the tray's state).
  const soloHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-upd-solo-'));
  env.HOME = soloHome;
  env.XDG_DATA_HOME = path.join(soloHome, '.local', 'share');
  const srv = await startServer({ waitForScan: false, env });
  try {
    const check = await (await fetch(`${srv.baseUrl}/api/v1/admin/update/check`, { method: 'POST' })).json();
    assert.equal(check.method, 'npm-source');
    assert.equal(check.available, true); // told...
    assert.equal(check.staged, false);   // ...but never touched

    const dl = await fetch(`${srv.baseUrl}/api/v1/admin/update/download`, { method: 'POST' });
    assert.equal(dl.status, 409);

    const ap = await fetch(`${srv.baseUrl}/api/v1/admin/update/apply`, { method: 'POST' });
    assert.equal(ap.status, 409);

    const soloStatus = process.platform === 'darwin'
      ? path.join(soloHome, 'Library', 'Application Support', 'mStream', 'update-status.json')
      : path.join(soloHome, '.local', 'share', 'mstream', 'update-status.json');
    await assert.rejects(fs.access(soloStatus), 'unsupervised instances must not write the status file');
  } finally {
    await srv.stop();
    await fs.rm(soloHome, { recursive: true, force: true }).catch(() => {});
  }
});
