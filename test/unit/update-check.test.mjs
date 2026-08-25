import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  validateManifest,
  parseBundleName,
  detectInstallMethod,
  detectSupervisor,
} from '../../src/util/update-check.js';

// ── compareVersions ──────────────────────────────────────────────────────────
// Strict numeric triples only: the release feed always carries bare X.Y.Z,
// so anything else is refused (null) rather than mis-ordered — a prerelease
// string sorting "newer" than a release would auto-stage a build the tag
// pipeline never shipped.

test('orders plain triples numerically, not lexically', () => {
  assert.ok(compareVersions('6.21.2', '6.21.1') > 0);
  assert.ok(compareVersions('6.9.0', '6.21.0') < 0); // lexical would say 9 > 21
  assert.ok(compareVersions('10.0.0', '9.99.99') > 0);
  assert.equal(compareVersions('6.21.2', '6.21.2'), 0);
});

test('refuses non-triple shapes outright', () => {
  assert.equal(compareVersions('6.21.2-beta.1', '6.21.1'), null);
  assert.equal(compareVersions('6.21', '6.21.1'), null);
  assert.equal(compareVersions('v6.21.2', '6.21.1'), null);
  assert.equal(compareVersions('', '6.21.1'), null);
  assert.equal(compareVersions('6.21.2', 'not-a-version'), null);
});

// ── validateManifest ─────────────────────────────────────────────────────────

const GOOD = {
  name: 'mstream',
  version: '6.22.0',
  apiVersion: 1,
  assets: [
    { file: 'mStream-6.22.0-linux-x64.zip', sha256: 'a'.repeat(64) },
    { file: 'mStream-6.22.0-win-x64-setup.exe', sha256: 'b'.repeat(64) },
  ],
};

test('accepts the generator contract, installers included', () => {
  assert.equal(validateManifest(GOOD).ok, true);
});

test('a foreign release capturing the latest pointer is rejected by name', () => {
  // The repo hosts asset-store releases (discovery-models-*); if one is ever
  // published non-prerelease it becomes GitHub "Latest" — the name check is
  // what keeps every updater from acting on it.
  const v = validateManifest({ ...GOOD, name: 'discovery-models' });
  assert.equal(v.ok, false);
  assert.ok(!v.apiMismatch);
});

test('a manifest from the future downgrades to notify-only, not to a guess', () => {
  const v = validateManifest({ ...GOOD, apiVersion: 2 });
  assert.equal(v.ok, false);
  assert.equal(v.apiMismatch, true);
});

test('rejects malformed shapes', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({ ...GOOD, version: 'v6.22.0' }).ok, false);
  assert.equal(validateManifest({ ...GOOD, version: '6.22.0-beta.1' }).ok, false);
  assert.equal(validateManifest({ ...GOOD, assets: [{ file: 'x.zip', sha256: 'nothex' }] }).ok, false);
  assert.equal(validateManifest({ ...GOOD, assets: 'zips' }).ok, false);
});

// ── parseBundleName ──────────────────────────────────────────────────────────

test('parses bundle dirs and zips, with and without musl', () => {
  assert.deepEqual(parseBundleName('mStream-6.21.2-linux-x64'), { version: '6.21.2', key: 'linux-x64' });
  assert.deepEqual(parseBundleName('mStream-6.21.2-linux-arm64-musl.zip'), { version: '6.21.2', key: 'linux-arm64-musl' });
  assert.deepEqual(parseBundleName('mStream-6.21.2-darwin-arm64'), { version: '6.21.2', key: 'darwin-arm64' });
  assert.deepEqual(parseBundleName('mStream-6.21.2-win-x64'), { version: '6.21.2', key: 'win-x64' });
});

test('refuses aside/partial names so pruning never eyes them', () => {
  assert.equal(parseBundleName('mStream-6.21.2-linux-x64.partial'), null);
  assert.equal(parseBundleName('mStream-6.21.2-linux-x64.replaced-20260820'), null);
  assert.equal(parseBundleName('current'), null);
  assert.equal(parseBundleName('mStream-6.21.2-beta.1-linux-x64'), null);
});

// ── detectInstallMethod ──────────────────────────────────────────────────────
// The decision table. Fake fs: a Set of paths that exist; realpath is
// identity. Shapes are posix-style; the fake normalizes separators because
// the production code path.join()s its probe paths with the HOST separator —
// on a Windows host that means backslashes against these forward-slash keys
// (this exact mismatch failed the windows CI test shard).

function fakeFs(existing, files = {}) {
  const set = new Set(existing);
  const norm = (p) => String(p).replaceAll('\\', '/');
  return {
    existsSync: (p) => set.has(norm(p)) || (norm(p) in files),
    realpathSync: (p) => p,
    accessSync: (p) => { if (!set.has(norm(p)) && !(norm(p) in files)) { throw new Error('ENOENT'); } },
    readFileSync: (p) => {
      if (norm(p) in files) { return files[norm(p)]; }
      throw new Error('ENOENT');
    },
  };
}

// The ~/Applications scenario exercises a separator-bound prefix check
// (host path.sep) that in production only ever runs on a darwin host —
// skip it on a Windows HOST; the mac and linux CI legs keep it covered.
const posixHostOnly = { skip: process.platform === 'win32' };

const noEnv = {};

test('MSTREAM_UPDATE_ROOT forces managed with the given root', () => {
  const r = detectInstallMethod({
    execPath: '/anything/node',
    platform: 'linux',
    env: { MSTREAM_UPDATE_ROOT: '/tmp/app' },
    standalone: false,
    fsx: fakeFs([]),
  });
  assert.deepEqual(r, { method: 'managed', root: '/tmp/app' });
});

test('a non-compiled runtime is npm/source', () => {
  const r = detectInstallMethod({
    execPath: '/usr/bin/node', platform: 'linux', env: noEnv, standalone: false, fsx: fakeFs([]),
  });
  assert.equal(r.method, 'npm-source');
});

test('docker wins over geometry on linux', () => {
  const r = detectInstallMethod({
    execPath: '/opt/mstream/mstream-server', platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs(['/.dockerenv']),
  });
  assert.equal(r.method, 'docker');
});

test('managed linux: versioned dir under a root holding current', () => {
  const root = '/home/u/.local/share/mstream/app';
  const r = detectInstallMethod({
    execPath: `${root}/mStream-6.21.2-linux-x64/mstream-server`,
    platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs([`${root}/current`]),
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('managed custom root: geometry needs no env var', () => {
  const root = '/srv/apps/mstream';
  const r = detectInstallMethod({
    execPath: `${root}/mStream-6.21.2-linux-x64/mstream-server`,
    platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs([`${root}/current`]),
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('managed darwin: the versioned .app under the default root', () => {
  const root = '/Users/u/Library/Application Support/mStream/app';
  const r = detectInstallMethod({
    execPath: `${root}/mStream-6.21.2-darwin-arm64/mStream.app/Contents/MacOS/mstream-server`,
    platform: 'darwin', env: noEnv, standalone: true,
    fsx: fakeFs([`${root}/current`]),
    homedir: () => '/Users/u',
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('the ~/Applications copy with the sibling marker is managed', posixHostOnly, () => {
  const root = '/Users/u/Library/Application Support/mStream/app';
  const r = detectInstallMethod({
    execPath: '/Users/u/Applications/mStream.app/Contents/MacOS/mstream-server',
    platform: 'darwin', env: noEnv, standalone: true,
    fsx: fakeFs(['/Users/u/Applications/.mstream-installer', `${root}/current`]),
    homedir: () => '/Users/u',
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('the ~/Applications copy WITHOUT the marker is portable (user-owned)', () => {
  const r = detectInstallMethod({
    execPath: '/Users/u/Applications/mStream.app/Contents/MacOS/mstream-server',
    platform: 'darwin', env: noEnv, standalone: true,
    fsx: fakeFs([]),
    homedir: () => '/Users/u',
  });
  assert.equal(r.method, 'portable');
});

test('a /Applications install is pkg territory', () => {
  const r = detectInstallMethod({
    execPath: '/Applications/mStream.app/Contents/MacOS/mstream-server',
    platform: 'darwin', env: noEnv, standalone: true,
    fsx: fakeFs([]),
    homedir: () => '/Users/u',
  });
  assert.equal(r.method, 'pkg');
});

test('a managed layout under /opt is still managed: geometry outranks prefix', () => {
  const root = '/opt/apps/mstream';
  const r = detectInstallMethod({
    execPath: `${root}/mStream-6.21.2-linux-x64/mstream-server`,
    platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs([`${root}/current`]),
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('the marker names a custom root; detection follows it from ~/Applications', posixHostOnly, () => {
  const root = '/srv/custom/mstream-root';
  const r = detectInstallMethod({
    execPath: '/Users/u/Applications/mStream.app/Contents/MacOS/mstream-server',
    platform: 'darwin', env: noEnv, standalone: true,
    fsx: fakeFs([`${root}/current`], {
      '/Users/u/Applications/.mstream-installer': `9.9.9\n${root}\n`,
    }),
    homedir: () => '/Users/u',
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('/opt is deb/rpm territory', () => {
  const r = detectInstallMethod({
    execPath: '/opt/mstream/mstream-server', platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs([]),
  });
  assert.equal(r.method, 'deb-rpm');
});

test('windows flat install at the Inno dir with no current is inno', () => {
  const r = detectInstallMethod({
    execPath: '/win/AppData/Local/Programs/mStream/mstream-server.exe',
    platform: 'win32', env: { LOCALAPPDATA: '/win/AppData/Local' }, standalone: true,
    fsx: fakeFs([]),
  });
  assert.equal(r.method, 'inno');
});

test('windows install.ps1 layout (versioned dir + current) is managed, not inno', () => {
  const root = '/win/AppData/Local/Programs/mStream';
  const r = detectInstallMethod({
    execPath: `${root}/mStream-6.21.2-win-x64/mstream-server.exe`,
    platform: 'win32', env: { LOCALAPPDATA: '/win/AppData/Local' }, standalone: true,
    fsx: fakeFs([`${root}/current`]),
  });
  assert.deepEqual(r, { method: 'managed', root });
});

test('a hand-extracted bundle with no current anywhere is portable', () => {
  const r = detectInstallMethod({
    execPath: '/home/u/Downloads/mStream-6.21.2-linux-x64/mstream-server',
    platform: 'linux', env: noEnv, standalone: true,
    fsx: fakeFs([]),
  });
  assert.equal(r.method, 'portable');
});

// ── detectSupervisor ─────────────────────────────────────────────────────────
// The auto-mode headless gate: exit(0) counts as an APPLY only when
// something restarts us afterwards. Only signals implying restart-on-clean-
// exit may pass — a false positive here is a silent outage.

function sup(env, extra = {}) {
  return detectSupervisor({
    env,
    platform: extra.platform ?? 'linux',
    readCgroup: extra.readCgroup ?? (() => { throw new Error('no cgroup'); }),
    queryRestart: extra.queryRestart ?? (() => null),
  });
}

test('nothing detectable = unsupervised; empty env vars read as unset', () => {
  assert.deepEqual(sup({}), { supervised: false, via: null });
  assert.deepEqual(sup({ MSTREAM_SUPERVISED: '' }), { supervised: false, via: null });
  assert.deepEqual(sup({ MSTREAM_SUPERVISED: '0' }), { supervised: false, via: null });
  assert.deepEqual(sup({ pm_id: '' }), { supervised: false, via: null });
  assert.deepEqual(sup({ INVOCATION_ID: '' }), { supervised: false, via: null });
});

test('MSTREAM_SUPERVISED is the operator override; pm2 numbers from 0', () => {
  assert.deepEqual(sup({ MSTREAM_SUPERVISED: '1' }), { supervised: true, via: 'env' });
  assert.deepEqual(sup({ MSTREAM_SUPERVISED: 'yes' }), { supervised: true, via: 'env' });
  assert.deepEqual(sup({ pm_id: '0' }), { supervised: true, via: 'pm2' });
  assert.deepEqual(sup({ pm_id: '7' }), { supervised: true, via: 'pm2' });
});

test('systemd counts only with a restart-on-clean-exit policy', () => {
  const env = { INVOCATION_ID: 'abc123' };
  const system = () => '0::/system.slice/mstream.service\n';
  const calls = [];
  const q = (policy) => (unit, userScope) => { calls.push([unit, userScope]); return policy; };
  assert.deepEqual(sup(env, { readCgroup: system, queryRestart: q('always') }),
    { supervised: true, via: 'systemd' });
  assert.deepEqual(calls.at(-1), ['mstream.service', false]);
  assert.deepEqual(sup(env, { readCgroup: system, queryRestart: q('on-success') }),
    { supervised: true, via: 'systemd' });
  // Restart=no is systemd's DEFAULT, and on-failure ignores exit 0 — both
  // leave the unit dead after a clean exit, so neither may count.
  assert.equal(sup(env, { readCgroup: system, queryRestart: q('no') }).supervised, false);
  assert.equal(sup(env, { readCgroup: system, queryRestart: q('on-failure') }).supervised, false);
  // Query failure (no systemctl, no permission) is conservative: undetected.
  assert.equal(sup(env, { readCgroup: system, queryRestart: () => null }).supervised, false);
});

test('systemd unit parsing: user units, Delegate= sub-cgroups, scopes, garbage', () => {
  const env = { INVOCATION_ID: 'abc123' };
  const calls = [];
  const q = (unit, userScope) => { calls.push([unit, userScope]); return 'always'; };
  // A user service: queried with --user, and user@N.service is NOT the unit.
  const user = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/mstream.service\n';
  assert.equal(sup(env, { readCgroup: user, queryRestart: q }).supervised, true);
  assert.deepEqual(calls.at(-1), ['mstream.service', true]);
  // A Delegate= sub-cgroup below the unit still resolves to the unit.
  const delegated = () => '0::/system.slice/mstream.service/payload\n';
  assert.equal(sup(env, { readCgroup: delegated, queryRestart: q }).supervised, true);
  assert.deepEqual(calls.at(-1), ['mstream.service', false]);
  // A scope (systemd-run --scope) has no restart policy: never supervised.
  const scope = () => '0::/user.slice/user-1000.slice/user@1000.service/run-u123.scope\n';
  assert.equal(sup(env, { readCgroup: scope, queryRestart: q }).supervised, false);
  // Unreadable cgroup: conservative.
  assert.equal(sup(env, { readCgroup: () => { throw new Error('nope'); }, queryRestart: q }).supervised, false);
  // INVOCATION_ID outside linux says nothing.
  assert.equal(sup(env, { platform: 'darwin', readCgroup: () => '0::/x.service', queryRestart: q }).supervised, false);
});
