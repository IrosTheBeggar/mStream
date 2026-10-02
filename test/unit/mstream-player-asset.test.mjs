/**
 * The player release's two binary families, as mStream pins and stages them
 * (scripts/mstream-player-asset.mjs, scripts/update-mstream-player-manifest.mjs,
 * scripts/build-bun.mjs, src/util/mstream-player-bootstrap.js):
 *
 *   - the pin regex takes the bare binaries of BOTH families — terminal
 *     mstream-player-<plat>-<arch>[.exe] and desktop
 *     mstream-player-desktop-<plat>-<arch>[.exe] — and nothing else: not the
 *     Windows launcher stub, not the deb/rpm/web/zip/tar.gz packages
 *   - a pre-release (a '-' in the tag, or GitHub's prerelease: true) is
 *     refused with one line and a non-zero exit unless --allow-prerelease
 *   - bundles take the desktop entry when pinned, else the terminal one,
 *     and stage it under the TERMINAL name either way
 *   - the runtime fetch reads the terminal key only, so desktop keys are
 *     inert for npm/source/Docker installs
 *
 * Hermetic: the updater runs against a loopback server standing in for both
 * the release-asset base (MSTREAM_PLAYER_BASE) and the GitHub API
 * (MSTREAM_PLAYER_API).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BINARY_RE, assetFamily, playerAssetNames, choosePlayerAsset,
  playerFileDescription, stagedLine, prereleaseReason,
} from '../../scripts/mstream-player-asset.mjs';
import { manifestEntry } from '../../src/util/mstream-player-bootstrap.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPDATER = path.join(root, 'scripts', 'update-mstream-player-manifest.mjs');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TERMINAL = [
  'mstream-player-darwin-arm64', 'mstream-player-darwin-x64', 'mstream-player-linux-x64',
  'mstream-player-linux-arm64', 'mstream-player-linux-arm', 'mstream-player-win32-x64.exe',
];
const DESKTOP = [
  'mstream-player-desktop-darwin-arm64', 'mstream-player-desktop-darwin-x64',
  'mstream-player-desktop-linux-x64', 'mstream-player-desktop-win32-x64.exe',
];
const NOT_BINARIES = [
  'mstream-player-desktop-launch-win32-x64.exe',
  'mstream-player-desktop-darwin-arm64.app.zip',
  'mstream-player-desktop-darwin-x64.app.zip',
  'mstream-player-desktop-win32-x64.zip',
  'mstream-player-desktop-linux-x64.tar.gz',
  'mstream-player_0.10.0_amd64.deb',
  'mstream-player_0.10.0_armhf.deb',
  'mstream-player-0.10.0.x86_64.rpm',
  'mstream-player-0.10.0.aarch64.rpm',
  'mstream-player-web.tar.gz',
  'manifest.json',
  'mstream-player-freebsd-x64',
  'mstream-player-desktop-',
  '',
];

describe('BINARY_RE / assetFamily', () => {
  test('accepts both families', () => {
    for (const n of TERMINAL) {
      assert.ok(BINARY_RE.test(n), n);
      assert.equal(assetFamily(n), 'terminal', n);
    }
    for (const n of DESKTOP) {
      assert.ok(BINARY_RE.test(n), n);
      assert.equal(assetFamily(n), 'desktop', n);
    }
  });

  test('rejects the launcher stub and every package', () => {
    for (const n of NOT_BINARIES) {
      assert.equal(BINARY_RE.test(n), false, n);
      assert.equal(assetFamily(n), null, n);
    }
  });

  test('the terminal names are exactly what the regex accepted before', () => {
    const OLD = /^mstream-player-(darwin|linux|win32)-[a-z0-9]+(\.exe)?$/;
    for (const n of [...TERMINAL, ...DESKTOP, ...NOT_BINARIES]) {
      if (assetFamily(n) !== 'desktop') { assert.equal(BINARY_RE.test(n), OLD.test(n), n); }
    }
  });
});

describe('prereleaseReason', () => {
  test("a '-' in the tag is a pre-release, whatever GitHub says", () => {
    assert.match(prereleaseReason('v0.10.0-rc.1'), /carries a '-'/);
    assert.match(prereleaseReason('v0.10.0-rc.1', { prerelease: false }), /carries a '-'/);
  });
  test('GitHub prerelease: true is a pre-release', () => {
    assert.match(prereleaseReason('v0.10.0', { prerelease: true }), /marks release 'v0\.10\.0' as a pre-release/);
  });
  test('a plain tag with no or a non-prerelease release object passes', () => {
    assert.equal(prereleaseReason('v0.9.0'), null);
    assert.equal(prereleaseReason('v0.9.0', null), null);
    assert.equal(prereleaseReason('v0.9.0', { prerelease: false }), null);
    assert.equal(prereleaseReason('v0.9.0', { prerelease: 'true' }), null);
  });
});

describe('choosePlayerAsset', () => {
  const pin = (file) => ({ file, sha256: sha256(Buffer.from(file)), size: 1000 + file.length });
  const manifestOf = (...files) => ({ repo: 'o/r', tag: 'v1.0.0', assets: Object.fromEntries(files.map((f) => [f, pin(f)])) });
  const win = { plat: 'win32', arch: 'x64', ext: '.exe' };

  test('both pinned: the desktop entry, staged under the terminal name', () => {
    const m = manifestOf('mstream-player-win32-x64.exe', 'mstream-player-desktop-win32-x64.exe');
    const got = choosePlayerAsset(m, { ...win, prefer: 'desktop' });
    assert.equal(got.key, 'mstream-player-desktop-win32-x64.exe');
    assert.equal(got.family, 'desktop');
    assert.equal(got.stagedName, 'mstream-player-win32-x64.exe');
    assert.deepEqual(got.entry, m.assets['mstream-player-desktop-win32-x64.exe']);
    assert.equal(got.note, 'desktop family (mstream-player-desktop-win32-x64.exe)');
  });

  test('desktop is the default preference', () => {
    const m = manifestOf('mstream-player-darwin-arm64', 'mstream-player-desktop-darwin-arm64');
    assert.equal(choosePlayerAsset(m, { plat: 'darwin', arch: 'arm64' }).family, 'desktop');
  });

  test('terminal only (arm Linux, or a pre-desktop pin): the terminal entry, with a note saying why', () => {
    const m = manifestOf('mstream-player-linux-arm64', 'mstream-player-desktop-linux-x64');
    const got = choosePlayerAsset(m, { plat: 'linux', arch: 'arm64', prefer: 'desktop' });
    assert.equal(got.key, 'mstream-player-linux-arm64');
    assert.equal(got.family, 'terminal');
    assert.equal(got.stagedName, 'mstream-player-linux-arm64');
    assert.match(got.note, /^terminal family \(mstream-player-linux-arm64\) — no desktop pin for linux-arm64$/);
  });

  test('desktop only: the desktop entry, still staged under the terminal name', () => {
    const m = manifestOf('mstream-player-desktop-linux-x64');
    const got = choosePlayerAsset(m, { plat: 'linux', arch: 'x64', prefer: 'desktop' });
    assert.equal(got.key, 'mstream-player-desktop-linux-x64');
    assert.equal(got.stagedName, 'mstream-player-linux-x64');
  });

  test('neither pinned (or no manifest at all): null', () => {
    assert.equal(choosePlayerAsset(manifestOf('mstream-player-darwin-x64'), { ...win }), null);
    assert.equal(choosePlayerAsset({ assets: {} }, { ...win }), null);
    assert.equal(choosePlayerAsset({}, { ...win }), null);
    assert.equal(choosePlayerAsset(null, { ...win }), null);
  });

  test("prefer: 'terminal' takes the terminal entry when both are pinned, the desktop one only as a fallback", () => {
    const both = manifestOf('mstream-player-win32-x64.exe', 'mstream-player-desktop-win32-x64.exe');
    assert.equal(choosePlayerAsset(both, { ...win, prefer: 'terminal' }).key, 'mstream-player-win32-x64.exe');
    const desk = manifestOf('mstream-player-desktop-win32-x64.exe');
    const got = choosePlayerAsset(desk, { ...win, prefer: 'terminal' });
    assert.equal(got.family, 'desktop');
    assert.match(got.note, /no terminal pin/);
  });

  test('inherited keys are not pins, and a bad preference throws', () => {
    const m = { assets: Object.create({ 'mstream-player-desktop-win32-x64.exe': pin('x') }) };
    assert.equal(choosePlayerAsset(m, { ...win }), null);
    assert.throws(() => choosePlayerAsset({ assets: {} }, { ...win, prefer: 'gui' }), /prefer must be/);
  });

  test('playerAssetNames', () => {
    assert.deepEqual(playerAssetNames({ plat: 'linux', arch: 'arm' }), {
      terminal: 'mstream-player-linux-arm', desktop: 'mstream-player-desktop-linux-arm',
    });
  });
});

describe('the bundler-side strings', () => {
  test('FileDescription: mStream Player for desktop, mStream Server Audio for terminal', () => {
    assert.equal(playerFileDescription('desktop'), 'mStream Player');
    assert.equal(playerFileDescription('terminal'), 'mStream Server Audio');
  });

  test('the staged line names the family, the source asset and the staged name', () => {
    assert.equal(
      stagedLine({ family: 'desktop', key: 'mstream-player-desktop-win32-x64.exe', tag: 'v0.10.0', stagedName: 'mstream-player-win32-x64.exe', size: 50 * 1048576 }),
      'staged mstream-player v0.10.0 (desktop family): mstream-player-desktop-win32-x64.exe as mstream-player-win32-x64.exe -> bin/mstream-player/mstream-player-win32-x64.exe (50.0 MB, sha verified)',
    );
    assert.equal(
      stagedLine({ family: 'terminal', key: 'mstream-player-linux-arm64', tag: 'v0.10.0', stagedName: 'mstream-player-linux-arm64', size: 1048576 }),
      'staged mstream-player v0.10.0 (terminal family): mstream-player-linux-arm64 -> bin/mstream-player/mstream-player-linux-arm64 (1.0 MB, sha verified)',
    );
  });
});

describe('the runtime fetch reads the terminal key only', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-player-asset-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (sub, files) => {
    const d = path.join(dir, sub);
    fs.mkdirSync(d, { recursive: true });
    const assets = Object.fromEntries(files.map((f) => [f, { file: f, sha256: sha256(Buffer.from(f)), size: 4096 }]));
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ family: 'mstream-player', schema: 2, repo: 'IrosTheBeggar/mstream-terminal-player', tag: 'v1.0.0', assets }));
    return d;
  };

  test('both pinned: the terminal entry', () => {
    const d = write('both', ['mstream-player-linux-x64', 'mstream-player-desktop-linux-x64']);
    assert.equal(manifestEntry({ manifestDir: d, key: 'mstream-player-linux-x64' }).file, 'mstream-player-linux-x64');
  });

  test('desktop only: nothing to fetch', () => {
    const d = write('desk', ['mstream-player-desktop-linux-x64']);
    assert.equal(manifestEntry({ manifestDir: d, key: 'mstream-player-linux-x64' }), null);
  });
});

describe('update-mstream-player-manifest.mjs', () => {
  const BODIES = Object.fromEntries([...TERMINAL, ...DESKTOP].map((f) => [f, Buffer.from(`fixture bytes of ${f} `.repeat(32))]));
  const RELEASE = {
    name: 'mstream-player',
    version: '1.0.0',
    apiVersion: 1,
    assets: [
      ...TERMINAL, ...DESKTOP, ...NOT_BINARIES.filter((n) => n && n !== 'manifest.json'),
    ].map((file) => ({ file, sha256: BODIES[file] ? sha256(BODIES[file]) : sha256(Buffer.from(file)) })),
  };
  let server;
  let base;
  let tmp;
  let hits;
  let prereleaseFlag;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-player-updater-'));
    server = http.createServer((req, res) => {
      hits.push(req.url);
      const send = (code, body, type = 'application/octet-stream') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
      if (req.url === '/dl/manifest.json') { return send(200, JSON.stringify(RELEASE), 'application/json'); }
      if (req.url.startsWith('/dl/')) {
        const b = BODIES[req.url.slice(4)];
        return b ? send(200, b) : send(404, 'nope');
      }
      if (/^\/api\/repos\/o\/r\/releases\/tags\//.test(req.url)) {
        return send(200, JSON.stringify({ prerelease: prereleaseFlag }), 'application/json');
      }
      if (/^\/api\/repos\/o\/r\/commits\//.test(req.url)) {
        return send(200, JSON.stringify({ sha: 'c'.repeat(40) }), 'application/json');
      }
      return send(404, 'nope');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(args) {
    hits = [];
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [UPDATER, ...args], {
        env: { ...process.env, MSTREAM_PLAYER_BASE: `${base}/dl`, MSTREAM_PLAYER_API: `${base}/api` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out, err }));
    });
  }

  test("a '-' tag is refused with one line before anything is fetched", async () => {
    const out = path.join(tmp, 'rc-refused.json');
    const r = await run(['v1.0.0-rc.1', 'o/r', '--out', out]);
    assert.equal(r.code, 1);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
    assert.match(r.err, /^refusing to pin o\/r@v1\.0\.0-rc\.1: the tag 'v1\.0\.0-rc\.1' carries a '-' .* pass --allow-prerelease/);
    assert.deepEqual(hits, []);
    assert.equal(fs.existsSync(out), false);
  });

  test('a release GitHub marks prerelease: true is refused before any asset is downloaded', async () => {
    prereleaseFlag = true;
    const out = path.join(tmp, 'flagged.json');
    const r = await run(['v1.0.0', 'o/r', `--out=${out}`]);
    assert.equal(r.code, 1);
    assert.match(r.err.trim(), /^refusing to pin o\/r@v1\.0\.0: GitHub marks release 'v1\.0\.0' as a pre-release — pass --allow-prerelease/);
    assert.ok(hits.every((h) => h.startsWith('/api/')), hits.join(','));
    assert.equal(fs.existsSync(out), false);
  });

  test('--allow-prerelease pins both families (and nothing else) into --out', async () => {
    prereleaseFlag = true;
    const out = path.join(tmp, 'rc-allowed', 'manifest.json');
    const r = await run(['v1.0.0-rc.1', 'o/r', '--allow-prerelease', '--out', out]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /WARNING: pinning a pre-release \(--allow-prerelease\)/);
    assert.match(r.out, /pinned o\/r@v1\.0\.0-rc\.1: 10 platform binaries \(6 terminal, 4 desktop;/);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.schema, 2);
    assert.equal(m.tag, 'v1.0.0-rc.1');
    assert.equal(m.builtFrom, 'c'.repeat(40));
    assert.deepEqual(Object.keys(m.assets).sort(), [...TERMINAL, ...DESKTOP].sort());
    for (const [k, e] of Object.entries(m.assets)) {
      assert.deepEqual(e, { file: k, sha256: sha256(BODIES[k]), size: BODIES[k].length });
    }
    // only the binaries were downloaded — never a package or the stub
    const downloaded = hits.filter((h) => h.startsWith('/dl/') && h !== '/dl/manifest.json').map((h) => h.slice(4)).sort();
    assert.deepEqual(downloaded, [...TERMINAL, ...DESKTOP].sort());
  });

  test('a plain release is pinned without the flag', async () => {
    prereleaseFlag = false;
    const out = path.join(tmp, 'plain.json');
    const r = await run(['v1.0.0', 'o/r', '--out', out]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /WARNING/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).assets).length, 10);
  });

  test('unknown options and a missing tag print the usage', async () => {
    for (const args of [['v1.0.0', '--bogus'], [], ['--allow-prerelease'], ['v1.0.0', '--out']]) {
      const r = await run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /usage: node scripts\/update-mstream-player-manifest\.mjs <tag> \[owner\/repo\] \[--allow-prerelease\] \[--out <file>\]/);
    }
  });
});
