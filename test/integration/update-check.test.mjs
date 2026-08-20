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

function makeBundle(version, key, { broken = false } = {}) {
  const b = `mStream-${version}-${key}`;
  const dir = path.join(relDir, b);
  const inner = key.startsWith('darwin')
    ? path.join(dir, 'mStream.app', 'Contents', 'MacOS')
    : dir;
  spawnSync('mkdir', ['-p', inner]);
  const server = path.join(inner, 'mstream-server');
  // broken = a binary this host "cannot exec": the probe-before-flip in
  // install.sh must refuse it and the stager must report a failed stage.
  const stub = broken
    ? `printf '#!/bin/sh\\nexit 1\\n' > '${server}'`
    : `printf '#!/bin/sh\\n[ "$1" = -V ] && echo ${version}\\nexit 0\\n' > '${server}'`;
  spawnSync('bash', ['-c', `${stub} && chmod +x '${server}'`]);
  spawnSync('bash', ['-c', `echo 'fake bundle' > '${dir}/README.txt'`]);
  const zip = spawnSync('python3', ['-m', 'zipfile', '-c', `${b}.zip`, b], { cwd: relDir });
  assert.equal(zip.status, 0, `zip failed: ${zip.stderr}`);
  spawnSync('rm', ['-rf', dir]);
}

async function publish(version, { tamper = false, broken = false } = {}) {
  for (const f of await fs.readdir(relDir)) {
    if (f.endsWith('.zip') || f === 'manifest.json') { await fs.rm(path.join(relDir, f)); }
  }
  makeBundle(version, hostKey(), { broken });
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

    // Check: finds 9.9.9 and (mode=stage default) starts staging on its own.
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
    const statusPath = process.platform === 'darwin'
      ? path.join(tmpHome, 'Library', 'Application Support', 'mStream', 'update-status.json')
      : path.join(tmpHome, '.local', 'share', 'mstream', 'update-status.json');
    const onDisk = JSON.parse(await fs.readFile(statusPath, 'utf8'));
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
