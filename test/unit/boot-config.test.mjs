import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import {
  userDataHome,
  resolveDefaultConfig,
  desktopDefaultConfig,
  ensureDesktopDefaultConfig,
} from '../../src/util/boot-config.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── userDataHome ─────────────────────────────────────────────────────────────
// The desktop profile writes a user's library metadata here; a wrong
// resolution scatters config/db into the wrong account dir or the app dir.

test('windows data home uses LOCALAPPDATA when set', () => {
  const env = { LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') };
  assert.equal(
    userDataHome('win32', env, () => { throw new Error('homedir must not be consulted'); }),
    join('C:', 'Users', 'u', 'AppData', 'Local', 'mStream')
  );
});

test('windows data home falls back to homedir when LOCALAPPDATA is unset', () => {
  assert.equal(
    userDataHome('win32', {}, () => join('C:', 'Users', 'svc')),
    join('C:', 'Users', 'svc', 'AppData', 'Local', 'mStream')
  );
});

test('macOS data home is Application Support', () => {
  assert.equal(
    userDataHome('darwin', {}, () => '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'mStream')
  );
});

test('linux data home honors XDG_DATA_HOME, else ~/.local/share (lowercase dir)', () => {
  assert.equal(
    userDataHome('linux', { XDG_DATA_HOME: '/data' }, () => '/home/u'),
    join('/data', 'mstream')
  );
  assert.equal(
    userDataHome('linux', {}, () => '/home/u'),
    join('/home/u', '.local', 'share', 'mstream')
  );
});

// ── resolveDefaultConfig ─────────────────────────────────────────────────────
// Precedence contract: env > server(non-standalone) > --portable > existing
// legacy file > desktop data home. A regression here silently splits an
// existing install's data from its config.

const LEGACY = join('/app', 'save/conf/default.json');
function resolve(overrides) {
  return resolveDefaultConfig({
    env: {},
    platform: 'linux',
    homedir: () => '/home/u',
    root: '/app',
    exists: () => false,
    ...overrides,
  });
}

test('MSTREAM_CONFIG wins over everything, even standalone', () => {
  const r = resolve({ env: { MSTREAM_CONFIG: '/etc/mstream.json' }, standalone: true, portable: true });
  assert.deepEqual(r, { path: '/etc/mstream.json', profile: 'env' });
});

test('non-standalone (source/npm) runs keep the appRoot path', () => {
  const r = resolve({ standalone: false });
  assert.deepEqual(r, { path: LEGACY, profile: 'server' });
});

test('--portable forces the next-to-binary path on a standalone build', () => {
  const r = resolve({ standalone: true, portable: true });
  assert.deepEqual(r, { path: LEGACY, profile: 'portable' });
});

test('an existing next-to-binary config is grandfathered on a standalone build', () => {
  const r = resolve({ standalone: true, exists: (p) => p === LEGACY });
  assert.deepEqual(r, { path: LEGACY, profile: 'legacy' });
});

test('a fresh standalone install resolves to the user data home', () => {
  const r = resolve({ standalone: true });
  const home = join('/home/u', '.local', 'share', 'mstream');
  assert.deepEqual(r, { path: join(home, 'conf', 'default.json'), profile: 'desktop', dataHome: home });
});

// ── desktopDefaultConfig ─────────────────────────────────────────────────────

test('desktop config points every writable dir under the data home', () => {
  const cfg = desktopDefaultConfig('/data/mstream');
  assert.deepEqual(cfg.storage, {
    dbDirectory: join('/data/mstream', 'db'),
    logsDirectory: join('/data/mstream', 'logs'),
    albumArtDirectory: join('/data/mstream', 'image-cache'),
    waveformCacheDirectory: join('/data/mstream', 'waveform-cache'),
  });
  assert.deepEqual(cfg.transcode, { ffmpegDirectory: join('/data/mstream', 'ffmpeg') });
  // modelCacheDirectory is config.js's derivation (sibling of dbDirectory);
  // writing it here would fork that logic.
  assert.equal(cfg.storage.modelCacheDirectory, undefined);
});

test('Quick Connect is on by default in the generated config', () => {
  assert.deepEqual(desktopDefaultConfig('/d').iroh, { enabled: true, shareCodePublic: true });
});

test('--quick-connect-off-by-default omits the iroh block entirely', () => {
  // Omitting (not writing enabled:false) leaves the operator's later manual
  // enable — or an admin-driven one — as the only author of that block, and
  // config.setup() still provisions the secrets it needs either way.
  const cfg = desktopDefaultConfig('/d', { quickConnectOffByDefault: true });
  assert.equal('iroh' in cfg, false);
});

test('every key the generated config sets exists in the real config schema', () => {
  // Source-contract guard: a rename in config.js (say waveformCacheDirectory)
  // would otherwise leave the generated desktop config silently pointing a
  // stale key at the data home while the real default stays at appRoot.
  const configSrc = readFileSync(join(repoRoot, 'src', 'state', 'config.js'), 'utf8');
  const cfg = desktopDefaultConfig('/d');
  for (const key of [...Object.keys(cfg.storage), ...Object.keys(cfg.transcode), ...Object.keys(cfg.iroh)]) {
    assert.match(configSrc, new RegExp(`\\b${key}\\s*:`), `config.js no longer declares '${key}'`);
  }
});

// ── ensureDesktopDefaultConfig ───────────────────────────────────────────────

async function tmpResolved() {
  const home = await mkdtemp(join(os.tmpdir(), 'mstream-bootcfg-'));
  return { path: join(home, 'conf', 'default.json'), profile: 'desktop', dataHome: home };
}

test('first run creates the config file (and its parent dirs)', async () => {
  const resolved = await tmpResolved();
  assert.equal(await ensureDesktopDefaultConfig(resolved), true);
  const written = JSON.parse(await readFile(resolved.path, 'utf8'));
  assert.equal(written.iroh.enabled, true);
  assert.equal(written.storage.dbDirectory, join(resolved.dataHome, 'db'));
});

test('an existing config is never overwritten and reports not-created', async () => {
  const resolved = await tmpResolved();
  await mkdir(dirname(resolved.path), { recursive: true });
  await writeFile(resolved.path, '{"port":9999}', 'utf8');
  assert.equal(await ensureDesktopDefaultConfig(resolved), false);
  assert.equal(await readFile(resolved.path, 'utf8'), '{"port":9999}');
});

test('non-desktop profiles are a no-op', async () => {
  const home = await mkdtemp(join(os.tmpdir(), 'mstream-bootcfg-'));
  const path = join(home, 'conf', 'default.json');
  assert.equal(await ensureDesktopDefaultConfig({ path, profile: 'server' }), false);
  await assert.rejects(access(path), 'no file may be written for the server profile');
});

// ── wrapper flag surface ─────────────────────────────────────────────────────
// The flags only matter if the shipped entrypoint actually accepts them.

test('cli-boot-wrapper --help documents the new flags', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['cli-boot-wrapper.js', '--help'], { cwd: repoRoot });
  assert.match(stdout, /--portable/);
  assert.match(stdout, /--quick-connect-off-by-default/);
});

test('cli-boot-wrapper accepts the new flags without booting into an arg error', async () => {
  // --version exits 0 before boot; unknown options exit 1 first. Combining
  // them proves the parser consumed the new flags rather than rejecting them.
  const { stdout } = await execFileAsync(
    process.execPath,
    ['cli-boot-wrapper.js', '--portable', '--quick-connect-off-by-default', '--version'],
    { cwd: repoRoot }
  );
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('cli-boot-wrapper still rejects unknown options', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['cli-boot-wrapper.js', '--quick-connect'], { cwd: repoRoot }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /unknown option/);
      return true;
    }
  );
});
