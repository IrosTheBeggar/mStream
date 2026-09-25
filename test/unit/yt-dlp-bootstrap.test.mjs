/**
 * src/util/yt-dlp-bootstrap.js — yt-dlp fetched on first use and kept
 * current. What this pins:
 *
 *   - the committed manifests are well-formed and pin this platform (or
 *     name it unpinned) — a fresh install's first fetch cannot dead-end
 *   - a first install is the PIN, and its receipt records the pinned tag
 *   - the live update: no download while the newest release's SHA2-256SUMS
 *     lists the hash already installed; a new hash is downloaded, verified
 *     against that file, probed, swapped in and receipted with the version
 *     the probe saw; bytes that miss the listed hash are refused and the
 *     old build kept; a build that reports an OLDER version is refused
 *     (never a downgrade); an operator-placed or absent copy is left alone
 *   - the newest release is read from GitHub's releases/latest redirect,
 *     and never asked on a mirror
 *   - which copy runs: the test hook and an explicit config binary as they
 *     are; otherwise the server's own copy while it is within
 *     SYSTEM_STALE_DAYS of the newest release we know of, else mStream's
 *     own — fetched on the spot, with the server's old copy as the fallback
 *     (and a note) when the fetch fails; the newer of two usable copies,
 *     the server's on a tie; the decision is cached
 *   - the daily check is a no-op under the hook, with updates off, and for
 *     an explicit binary
 *
 * Hermetic: a loopback server plays the mirror (MSTREAM_YTDLP_BASE — the
 * documented override, so the pins still gate what is installed) and the
 * probe is injected; nothing here executes a download.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import winston from 'winston';

import * as config from '../../src/state/config.js';
import * as boot from '../../src/util/yt-dlp-bootstrap.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = boot.ytDlpKey();
const FILE = 'fake-yt-dlp';
const PIN_TAG = '2026.08.19';
const PINNED = Buffer.from('the pinned yt-dlp '.repeat(64));
const NEWER = Buffer.from('a newer yt-dlp '.repeat(64));

let server;
let baseUrl;
let tmpRoot;
let manifestDir;
let entry;
const hits = [];
// What the loopback serves: the pin under its file name, and a `latest/`
// namespace whose SUMS and asset the tests rewrite per case.
const serve = { latestSums: null, latestBody: null };

function writeManifest(dir, { tag = PIN_TAG, body = PINNED, size = body.length } = {}) {
  const name = KEY.includes('-musl') ? 'manifest-musl.json' : 'manifest.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    family: 'yt-dlp', schema: 2, repo: 'yt-dlp/yt-dlp', tag,
    assets: { [KEY]: { file: FILE, sha256: sha256(body), size } },
  }));
}

function freshInstallDir(label) {
  const dir = path.join(tmpRoot, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function receiptOf(installDir) {
  try { return JSON.parse(fs.readFileSync(path.join(installDir, '.fetched.json'), 'utf8'))[KEY]; } catch (_e) { return undefined; }
}

const okProbe = () => Promise.resolve(true);
const versionProbe = (v) => () => Promise.resolve(v);

// A pinned install to start each live-update case from.
async function installPin(label) {
  const installDir = freshInstallDir(label);
  const dest = await boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe });
  assert.equal(dest, path.join(installDir, KEY));
  return installDir;
}

async function quietly(fn) {
  const real = { info: winston.info, warn: winston.warn, error: winston.error };
  const lines = [];
  for (const level of Object.keys(real)) { winston[level] = (line) => { lines.push(`${level}: ${line}`); }; }
  try { return await fn(lines); } finally { Object.assign(winston, real); }
}

describe('yt-dlp bootstrap', () => {
  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-bootstrap-'));
    manifestDir = path.join(tmpRoot, 'manifest');
    fs.mkdirSync(manifestDir);
    writeManifest(manifestDir);
    // A real config, so settings() reads a real youtube block the tests flip.
    fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify({ port: 3000, storage: { dbDirectory: tmpRoot }, discoveryPlugins: { youtube: { enabled: true } } }));
    await config.setup(path.join(tmpRoot, 'config.json'));

    server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      hits.push(p);
      if (p === `/${FILE}`) { res.writeHead(200); return res.end(PINNED); }
      if (p === '/latest/SHA2-256SUMS' && serve.latestSums !== null) { res.writeHead(200); return res.end(serve.latestSums); }
      if (p === `/latest/${FILE}` && serve.latestBody !== null) { res.writeHead(200); return res.end(serve.latestBody); }
      res.writeHead(404);
      res.end('no');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.MSTREAM_YTDLP_BASE = baseUrl;
    delete process.env.MSTREAM_YTDLP_BIN;
    entry = boot.manifestEntry({ manifestDir });
    assert.ok(entry, 'the test manifest pins this platform');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MSTREAM_YTDLP_BASE;
    delete process.env.MSTREAM_YTDLP_BIN;
    boot.reset();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    hits.length = 0;
    serve.latestSums = null;
    serve.latestBody = null;
    boot.reset();
    config.program.discoveryPlugins.youtube.autoUpdate = true;
    config.program.discoveryPlugins.youtube.binary = 'yt-dlp';
  });

  describe('versions and checksum files', () => {
    test('yt-dlp\'s date versions parse, compare and measure; nightlies carry a build number', () => {
      assert.deepEqual(boot.parseVersion('2026.08.19'), { text: '2026.08.19', date: Date.UTC(2026, 7, 19), build: 0 });
      assert.equal(boot.parseVersion('2026.08.19.232000').build, 232000);
      assert.equal(boot.parseVersion('v1.2.3'), null);
      assert.equal(boot.parseVersion(''), null);
      assert.equal(boot.compareVersions('2026.08.19', '2026.07.04'), 1);
      assert.equal(boot.compareVersions('2026.07.04', '2026.08.19'), -1);
      assert.equal(boot.compareVersions('2026.08.19.1', '2026.08.19'), 1);
      assert.equal(boot.compareVersions('2026.08.19', '2026.08.19'), 0);
      assert.equal(boot.compareVersions('garbage', '2026.01.01'), -1, 'an unreadable version sorts below every real one');
      assert.equal(boot.daysBehind('2026.07.04', '2026.08.19'), 46);
      assert.equal(boot.daysBehind('2026.08.19', '2026.07.04'), -46);
      assert.equal(boot.daysBehind('what', '2026.07.04'), null);
      assert.equal(boot.isMuchOlder('2026.07.04', '2026.08.19'), true, '46 days is much older');
      assert.equal(boot.isMuchOlder('2026.08.01', '2026.08.19'), false, '18 days is not');
      assert.equal(boot.isMuchOlder('2026.07.20', '2026.08.19'), false, `exactly ${boot.SYSTEM_STALE_DAYS} days is not`);
      assert.equal(boot.isMuchOlder('2026.07.19', '2026.08.19'), true, 'one more day is');
      assert.equal(boot.isMuchOlder('unreadable', '2026.08.19'), true, 'nothing vouches for a version that cannot be read');
    });

    test('SHA2-256SUMS: "<sha256>  <file>" lines, BSD asterisks tolerated, junk ignored', () => {
      const text = `${'a'.repeat(64)}  yt-dlp_linux\n${'B'.repeat(64)} *yt-dlp.exe\nnot a line\n\n${'c'.repeat(63)}  short\n`;
      assert.deepEqual(boot.parseSums(text), { 'yt-dlp_linux': 'a'.repeat(64), 'yt-dlp.exe': 'b'.repeat(64) });
      assert.deepEqual(boot.parseSums(''), {});
    });
  });

  describe('the committed manifests', () => {
    test('pin a real yt-dlp release for the platforms yt-dlp publishes standalone builds for, and validate entry by entry', () => {
      const dir = path.join(REPO_ROOT, 'bin', 'yt-dlp');
      for (const name of ['manifest.json', 'manifest-musl.json']) {
        const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        assert.equal(m.family, 'yt-dlp');
        assert.equal(m.repo, 'yt-dlp/yt-dlp');
        assert.ok(boot.parseVersion(m.tag), `${name} pins a release tag (${m.tag})`);
        for (const [key, e] of Object.entries(m.assets)) {
          assert.match(key, name === 'manifest-musl.json' ? /^yt-dlp-linux-(x64|arm64)-musl$/ : /^yt-dlp-(win32-(x64|arm64|ia32)\.exe|linux-(x64|arm64)|darwin-(x64|arm64))$/);
          const validated = boot.manifestEntry({ manifestDir: dir, key });
          assert.ok(validated, `${key} validates`);
          assert.equal(validated.tag, m.tag);
          assert.equal(validated.file, e.file);
          assert.equal(boot.deriveAssetUrl(validated), `https://github.com/yt-dlp/yt-dlp/releases/download/${m.tag}/${e.file}`);
        }
      }
      assert.equal(boot.manifestEntry({ manifestDir: dir, key: 'yt-dlp-linux-arm' }), null, '32-bit ARM Linux has no standalone build and is unpinned');
    });
  });

  describe('the first install', () => {
    test('is the pin — downloaded under its release file name, hash-checked, receipted with the pinned tag', async () => {
      const installDir = await installPin('pin');
      assert.deepEqual(hits, [`/${FILE}`]);
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), PINNED);
      const r = receiptOf(installDir);
      assert.equal(r.sha256, sha256(PINNED));
      assert.equal(r.version, PIN_TAG);
      assert.equal(r.source, 'pin');
      assert.ok(Date.parse(r.at) > 0);
      // Asked again: kept as it is, nothing fetched.
      await boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe });
      assert.equal(hits.length, 1);
    });
  });

  describe('the live update', () => {
    test('no download while the newest release lists the hash already installed', async () => {
      const installDir = await installPin('same');
      hits.length = 0;
      serve.latestSums = `${sha256(PINNED)}  ${FILE}\n${'0'.repeat(64)}  something-else\n`;
      const r = await boot.refresh({ installDir, entry, probe: versionProbe('2026.09.30') });
      assert.deepEqual({ updated: r.updated, version: r.version }, { updated: false, version: PIN_TAG });
      assert.deepEqual(hits, ['/latest/SHA2-256SUMS'], 'the checksum file alone');
      assert.equal(receiptOf(installDir).source, 'pin');
    });

    test('a new hash is downloaded, verified against the checksum file, probed, swapped in and receipted with the version the probe saw', async () => {
      const installDir = await installPin('newer');
      hits.length = 0;
      serve.latestSums = `${sha256(NEWER)}  ${FILE}\n`;
      serve.latestBody = NEWER;
      const lines = await quietly(async (out) => { await boot.refresh({ installDir, entry, probe: versionProbe('2026.09.30') }); return out; });
      assert.deepEqual(hits, ['/latest/SHA2-256SUMS', `/latest/${FILE}`]);
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), NEWER);
      const r = receiptOf(installDir);
      assert.equal(r.sha256, sha256(NEWER));
      assert.equal(r.version, '2026.09.30');
      assert.equal(r.source, 'mirror-latest');
      assert.ok(lines.some((l) => /now at 2026\.09\.30 \(was 2026\.08\.19\)/.test(l)), lines.join('\n'));
      assert.equal(fs.existsSync(path.join(installDir, `.staging-${KEY}`)), false);
      // And a receipted, intact copy is what ensure() keeps — the pin is a floor, not a ceiling.
      await boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe });
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), NEWER, 'not rolled back to the pin');
      assert.equal(hits.length, 2);
    });

    test('bytes that miss the listed hash are refused and the installed build kept', async () => {
      const installDir = await installPin('tamper');
      hits.length = 0;
      serve.latestSums = `${sha256(NEWER)}  ${FILE}\n`;
      serve.latestBody = Buffer.from('not what the checksum file promised');
      await quietly(() => assert.rejects(boot.refresh({ installDir, entry, probe: versionProbe('2026.09.30') }), /checksum mismatch/));
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), PINNED);
      assert.equal(receiptOf(installDir).version, PIN_TAG);
      assert.equal(fs.existsSync(path.join(installDir, `.staging-${KEY}`)), false, 'staging swept');
    });

    test('a build that reports an older version than the installed one is refused: never a downgrade', async () => {
      const installDir = await installPin('downgrade');
      serve.latestSums = `${sha256(NEWER)}  ${FILE}\n`;
      serve.latestBody = NEWER;
      const lines = await quietly(async (out) => {
        await assert.rejects(boot.refresh({ installDir, entry, probe: versionProbe('2026.01.01') }), /execution probe/);
        return out;
      });
      assert.ok(lines.some((l) => /older than the installed 2026\.08\.19 — refusing the downgrade/.test(l)), lines.join('\n'));
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), PINNED);
      // A build the probe cannot read at all is refused the same way.
      await quietly(() => assert.rejects(boot.refresh({ installDir, entry, probe: versionProbe(null) }), /execution probe/));
      assert.equal(receiptOf(installDir).version, PIN_TAG);
    });

    test('a checksum file without this platform\'s build, and a newest release that is not newer, change nothing', async () => {
      const installDir = await installPin('nothing');
      serve.latestSums = `${'0'.repeat(64)}  some-other-build\n`;
      await quietly(() => assert.rejects(boot.refresh({ installDir, entry, probe: okProbe }), new RegExp(`lists no ${FILE}`)));
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), PINNED);
      // GitHub mode (no mirror): a resolved tag at or below the installed
      // version ends the check before any request.
      delete process.env.MSTREAM_YTDLP_BASE;
      hits.length = 0;
      try {
        assert.deepEqual(await boot.refresh({ installDir, entry, latest: PIN_TAG }), { updated: false, version: PIN_TAG, latest: PIN_TAG });
        assert.deepEqual(await boot.refresh({ installDir, entry, latest: '2026.01.01' }), { updated: false, version: PIN_TAG, latest: '2026.01.01' });
      } finally {
        process.env.MSTREAM_YTDLP_BASE = baseUrl;
      }
      assert.equal(hits.length, 0);
    });

    test('nothing installed, or a copy someone placed themselves: left alone, no request', async () => {
      const empty = freshInstallDir('empty');
      assert.equal((await boot.refresh({ installDir: empty, entry })).skipped, 'not installed');
      const theirs = freshInstallDir('theirs');
      fs.writeFileSync(path.join(theirs, KEY), 'an operator\'s own build');
      assert.equal((await boot.refresh({ installDir: theirs, entry })).skipped, 'not installed by mStream');
      assert.equal(hits.length, 0);
      assert.equal(await boot.ensureYtDlp({ manifestDir, installDir: theirs, probe: okProbe }), path.join(theirs, KEY), 'and ensure hands it back untouched');
      assert.equal(fs.readFileSync(path.join(theirs, KEY), 'utf8'), 'an operator\'s own build');
      assert.equal(hits.length, 0);
    });

    test('a damaged managed copy (no longer hashing to its receipt) is replaced with the pin', async () => {
      const installDir = await installPin('damaged');
      fs.appendFileSync(path.join(installDir, KEY), 'bit rot');
      hits.length = 0;
      await quietly(() => boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe }));
      assert.deepEqual(hits, [`/${FILE}`]);
      assert.deepEqual(fs.readFileSync(path.join(installDir, KEY)), PINNED);
    });
  });

  describe('the newest release', () => {
    const fakeFetch = (status, location) => () => Promise.resolve({ status, headers: new Headers(location ? { location } : {}), body: null });

    test('is the tag GitHub\'s releases/latest redirects to; anything else reads as unknown', async () => {
      delete process.env.MSTREAM_YTDLP_BASE;
      try {
        assert.equal(await boot.latestVersion({ entry, fetchImpl: fakeFetch(302, 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.09.30') }), '2026.09.30');
        assert.equal(boot.newestKnown({ entry, managed: null }), '2026.09.30', 'and it is remembered as the newest known');
        await quietly(async () => {
          assert.equal(await boot.latestVersion({ entry, fetchImpl: fakeFetch(302, 'https://github.com/yt-dlp/yt-dlp/releases/tag/not-a-version') }), null);
          assert.equal(await boot.latestVersion({ entry, fetchImpl: fakeFetch(200, null) }), null);
          assert.equal(await boot.latestVersion({ entry, fetchImpl: () => Promise.reject(new Error('offline')) }), null);
        });
      } finally {
        process.env.MSTREAM_YTDLP_BASE = baseUrl;
      }
    });

    test('is never asked on a mirror, and the newest known falls back to the pin, the managed copy, or the check', async () => {
      let asked = 0;
      assert.equal(await boot.latestVersion({ entry, fetchImpl: () => { asked++; return Promise.resolve(); } }), null);
      assert.equal(asked, 0);
      assert.equal(boot.newestKnown({ entry, managed: null }), PIN_TAG);
      assert.equal(boot.newestKnown({ entry, managed: { version: '2026.09.01' } }), '2026.09.01');
      assert.equal(boot.newestKnown({ entry: null, managed: null }), null);
    });
  });

  describe('which copy runs', () => {
    const system = (version, extra = {}) => () => Promise.resolve({ cmd: 'yt-dlp', version, ...extra });
    const none = () => Promise.resolve(null);
    const noFetch = () => Promise.reject(new Error('ensure must not run'));
    const noUpdate = () => Promise.reject(new Error('update must not run'));

    test('the test hook and an explicit binary are used as they are, and named when missing', async () => {
      process.env.MSTREAM_YTDLP_BIN = path.join(tmpRoot, 'nope.exe');
      try {
        const missing = await boot.locate('yt-dlp', { findSystem: noFetch, ensure: noFetch });
        assert.equal(missing.bin, null);
        assert.equal(missing.source, 'env');
        assert.match(missing.reason, /yt-dlp not found \(.*nope\.exe\)/);
        const script = path.join(REPO_ROOT, 'test', 'helpers', 'fake-yt-dlp.mjs');
        process.env.MSTREAM_YTDLP_BIN = script;
        const hook = await boot.locate('/ignored/when/hooked', { findSystem: noFetch, ensure: noFetch });
        assert.deepEqual(hook.bin, { cmd: process.execPath, prefix: [script], script });
        assert.equal(hook.source, 'env');
      } finally {
        delete process.env.MSTREAM_YTDLP_BIN;
      }
      const theirs = path.join(tmpRoot, 'their-yt-dlp');
      fs.writeFileSync(theirs, 'x');
      const explicit = await boot.locate(theirs, { findSystem: noFetch, ensure: noFetch });
      assert.deepEqual(explicit.bin, { cmd: theirs, prefix: [] });
      assert.equal(explicit.source, 'config');
      assert.equal(explicit.version, null, 'not measured: the caller probes it');
      const gone = await boot.locate(path.join(tmpRoot, 'gone'), { findSystem: noFetch, ensure: noFetch });
      assert.equal(gone.bin, null);
      assert.match(gone.reason, /yt-dlp not found/);
    });

    test('a current copy on the server runs, and nothing is fetched', async () => {
      const installDir = freshInstallDir('sys-current');
      const d = await boot.locate('yt-dlp', { findSystem: system(PIN_TAG), ensure: noFetch, update: noUpdate, installDir, entry });
      assert.deepEqual(d.bin, { cmd: 'yt-dlp', prefix: [] });
      assert.equal(d.source, 'system');
      assert.equal(d.version, PIN_TAG);
      assert.equal(d.note, null);
      assert.equal(hits.length, 0);
    });

    test('a copy on the server that is much older than the newest known release is passed over for mStream\'s own, fetched on the spot and then updated', async () => {
      const installDir = freshInstallDir('sys-old');
      let updated = 0;
      const lines = await quietly(async (out) => {
        const d = await boot.locate('yt-dlp', {
          findSystem: system('2026.03.17'),
          ensure: () => boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe }),
          update: () => { updated++; return Promise.resolve({ updated: false }); },
          installDir, entry,
        });
        assert.equal(d.source, 'managed');
        assert.equal(d.path, path.join(installDir, KEY));
        assert.deepEqual(d.bin, { cmd: path.join(installDir, KEY), prefix: [] });
        assert.equal(d.version, PIN_TAG);
        assert.equal(d.note, null);
        return out;
      });
      assert.deepEqual(hits, [`/${FILE}`]);
      assert.equal(updated, 1, 'straight on to the newest release, so the first use does not run a month behind');
      assert.ok(lines.some((l) => /2026\.03\.17\) is 155 days behind 2026\.08\.19 — fetching mStream's own copy/.test(l)), lines.join('\n'));
    });

    test('with updates off the fetch stops at the pin', async () => {
      const installDir = freshInstallDir('sys-old-frozen');
      config.program.discoveryPlugins.youtube.autoUpdate = false;
      const d = await quietly(() => boot.locate('yt-dlp', {
        findSystem: none, ensure: () => boot.ensureYtDlp({ manifestDir, installDir, probe: okProbe }), update: noUpdate, installDir, entry,
      }));
      assert.equal(d.source, 'managed');
      assert.equal(boot.status().autoUpdate, false);
    });

    test('when the fetch fails, the server\'s old copy runs with a note that says so; with no copy at all, nothing runs and the reason says why', async () => {
      const installDir = freshInstallDir('fetch-fails');
      const failing = () => Promise.reject(new Error('HTTP 503 downloading it'));
      const d = await quietly(() => boot.locate('yt-dlp', { findSystem: system('2026.03.17'), ensure: failing, update: noUpdate, installDir, entry }));
      assert.equal(d.source, 'system');
      assert.deepEqual(d.bin, { cmd: 'yt-dlp', prefix: [] });
      assert.match(d.note, /is 155 days behind 2026\.08\.19 and the download failed \(HTTP 503 downloading it\) — using it anyway/);
      boot.reset();
      const nothing = await quietly(() => boot.locate('yt-dlp', { findSystem: none, ensure: failing, update: noUpdate, installDir, entry }));
      assert.equal(nothing.bin, null);
      assert.match(nothing.reason, /^yt-dlp not found \(yt-dlp is not installed on this server; the download failed \(HTTP 503 downloading it\)\)$/);
      boot.reset();
      // A copy that exists but cannot be run counts as none — and says so.
      const broken = await quietly(() => boot.locate('yt-dlp', { findSystem: system(null, { error: 'is not something this system can run (EACCES)' }), ensure: failing, update: noUpdate, installDir, entry }));
      assert.equal(broken.bin, null);
      assert.match(broken.reason, /cannot be run \(is not something this system can run \(EACCES\)\)/);
    });

    test('between two usable copies the newer one wins, the server\'s own on a tie', async () => {
      const installDir = await installPin('two-copies');
      // Managed at the pin, server at the same version: the server's.
      let d = await boot.locate('yt-dlp', { findSystem: system(PIN_TAG), ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(d.source, 'system');
      boot.reset();
      // The managed copy moved on: it is the newer one.
      serve.latestSums = `${sha256(NEWER)}  ${FILE}\n`;
      serve.latestBody = NEWER;
      await quietly(() => boot.refresh({ installDir, entry, probe: versionProbe('2026.09.30') }));
      d = await boot.locate('yt-dlp', { findSystem: system(PIN_TAG), ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(d.source, 'managed');
      assert.equal(d.version, '2026.09.30');
      boot.reset();
      // The server caught up past it: the server's again.
      d = await boot.locate('yt-dlp', { findSystem: system('2026.10.05'), ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(d.source, 'system');
      boot.reset();
      // A managed copy that fell far behind the newest known (updates off) does not win by default either.
      config.program.discoveryPlugins.youtube.autoUpdate = false;
      d = await boot.locate('yt-dlp', { findSystem: system('2026.12.01'), ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(d.source, 'system');
    });

    test('the decision is cached until told otherwise', async () => {
      const installDir = freshInstallDir('cache');
      let asked = 0;
      const counting = () => { asked++; return Promise.resolve({ cmd: 'yt-dlp', version: PIN_TAG }); };
      await boot.locate('yt-dlp', { findSystem: counting, ensure: noFetch, update: noUpdate, installDir, entry });
      await boot.locate('yt-dlp', { findSystem: counting, ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(asked, 1);
      await boot.locate('yt-dlp', { fresh: true, findSystem: counting, ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(asked, 2);
      boot.invalidate();
      await boot.locate('yt-dlp', { findSystem: counting, ensure: noFetch, update: noUpdate, installDir, entry });
      assert.equal(asked, 3);
      // Concurrent callers share one decision.
      boot.invalidate();
      await Promise.all([1, 2, 3].map(() => boot.locate('yt-dlp', { findSystem: counting, ensure: noFetch, update: noUpdate, installDir, entry })));
      assert.equal(asked, 4);
      const st = boot.status();
      assert.equal(st.source, 'system');
      assert.equal(st.autoUpdate, true);
    });
  });

  describe('the daily check', () => {
    test('is a no-op under the test hook, with updates off, and for an explicit binary', async () => {
      process.env.MSTREAM_YTDLP_BIN = 'x';
      try { assert.deepEqual(await boot.checkForUpdate(), { skipped: 'MSTREAM_YTDLP_BIN' }); } finally { delete process.env.MSTREAM_YTDLP_BIN; }
      config.program.discoveryPlugins.youtube.autoUpdate = false;
      assert.deepEqual(await boot.checkForUpdate(), { skipped: 'updates are off' });
      config.program.discoveryPlugins.youtube.autoUpdate = true;
      config.program.discoveryPlugins.youtube.binary = '/their/yt-dlp';
      assert.deepEqual(await boot.checkForUpdate(), { skipped: 'an explicit binary is configured' });
      assert.equal(hits.length, 0);
    });

    test('learns the newest release even with no managed copy, so a server copy that fell behind it is superseded', async () => {
      // A server that runs its own yt-dlp, within a month of the pin — and
      // the real newest release four months on. Without asking GitHub the
      // check measured the copy against the pin and kept it for ever.
      delete process.env.MSTREAM_YTDLP_BASE;
      const installDir = path.join(tmpRoot, 'daily-no-managed');
      const system = () => Promise.resolve({ cmd: 'yt-dlp', version: '2026.08.01' });
      const fetchImpl = () => Promise.resolve({ status: 302, headers: new Headers({ location: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.12.01' }), body: null });
      let asked = 0;
      const ensure = () => { asked++; return Promise.resolve(false); };   // the fetch itself is not this test's
      try {
        const result = await quietly(() => boot.checkForUpdate({ fetchImpl, findSystem: system, ensure, update: () => Promise.resolve({ updated: false }), installDir, entry }));
        assert.deepEqual(result, { updated: false, skipped: 'not installed', version: null, latest: '2026.12.01' });
        assert.equal(boot.status().latest, '2026.12.01', 'the newest release is known now');
        assert.equal(boot.newestKnown({ entry, managed: null }), '2026.12.01');
        assert.equal(asked, 1, 'the server copy, 122 days behind, is no longer current: the managed copy was asked for');
        const d = await boot.locate('yt-dlp', { findSystem: system, ensure: () => Promise.resolve(false), update: () => Promise.resolve({ updated: false }), installDir, entry });
        assert.equal(d.source, 'system');
        assert.match(d.note, /122 days behind 2026\.12\.01/, 'measured against the real newest release');
      } finally {
        process.env.MSTREAM_YTDLP_BASE = baseUrl;
      }
    });

    test('startAutoUpdate arms once and stopAutoUpdate disarms', () => {
      boot.startAutoUpdate();
      boot.startAutoUpdate();
      boot.stopAutoUpdate();
      boot.stopAutoUpdate();
    });
  });
});
