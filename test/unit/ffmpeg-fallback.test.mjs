/**
 * ffmpeg-bootstrap: a PRUNED pin falls back to BtbN's rolling `latest`
 * release — verified against that release's checksums.sha256 — instead of
 * leaving a fresh install with no ffmpeg.
 *
 * Why: BtbN deletes dated autobuild releases (util/prunetags.sh keeps the 14
 * newest dailies + each month's final build), and the 2026-08-19 pin 404'd on
 * 2026-09-02 for every fresh Linux and Windows install. The manifest now pins
 * month-end builds (see btbn-retention.test.mjs); this is the belt to that
 * brace.
 *
 * Hermetic like ffmpeg-bootstrap.test.mjs: MSTREAM_FFMPEG_MIRROR points at a
 * loopback server. The pinned asset answers 404 (or 500, for the no-fallback
 * case); `latest/checksums.sha256` lists a stable-branch build, a master
 * build, and noise, with digests that either match the fake archive bytes
 * (the fallback is verified and handed to the extractor, which fails on the
 * garbage — nothing installs) or never match (retried once, then refused).
 * What is asserted is which URLs were fetched, and how many times.
 *
 * macOS pins come from ffmpeg.martin-riedl.de versioned paths (no prune, no
 * BtbN, no fallback) and musl skips the download step, so both skip.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isMusl = process.platform === 'linux' && !(process.report?.getReport?.()?.header?.glibcVersionRuntime);
const skip = process.platform === 'darwin' ? 'macOS pins are martin-riedl versioned paths — no BtbN, no fallback'
  : isMusl ? 'musl skips the download step' : false;

const ARCHIVE_BYTES = Buffer.from('not-an-archive-but-hashes-deterministically');
const ARCHIVE_DIGEST = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
const ZERO_DIGEST = '0'.repeat(64);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let server;
let tmpDir;
let dirCounter = 0;
let config;
let bootstrap;
let pinnedFile;   // the platform's pinned BtbN file name from the committed manifest
let plat;         // linux64 | linuxarm64 | win64
let ext;          // tar.xz | zip
const hits = [];  // request paths, in order
let pinnedStatus = 404;   // what the pinned asset answers
let sumsMatch = true;     // whether latest/checksums.sha256 digests match ARCHIVE_BYTES

function checksumsText() {
  const d = sumsMatch ? ARCHIVE_DIGEST : ZERO_DIGEST;
  const other = plat === 'win64' ? 'linux64' : 'win64';
  const otherExt = plat === 'win64' ? 'tar.xz' : 'zip';
  return [
    `${d}  ffmpeg-master-latest-${plat}-gpl.${ext}`,
    `${d}  ffmpeg-master-latest-${plat}-gpl-shared.${ext}`,
    `${d}  ffmpeg-n8.1-latest-${plat}-gpl-8.1.${ext}`,
    `${d}  ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}`,
    `${d}  ffmpeg-n9.0-latest-${plat}-gpl-shared-9.0.${ext}`,
    `${d}  ffmpeg-n9.0-latest-${other}-gpl-9.0.${otherExt}`,
    `${d}  ffmpeg-master-latest-${plat}-lgpl.${ext}`,
    '',
  ].join('\n');
}

function count(pathname) {
  return hits.filter((h) => h === pathname).length;
}

function freshDir() {
  const dir = path.join(tmpDir, `ffmpeg-${++dirCounter}`);
  config.program.transcode.ffmpegDirectory = dir;
  return dir;
}

describe('ffmpeg-bootstrap: pruned pin → latest-release fallback', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://x');
      hits.push(pathname);
      if (pathname === '/latest/checksums.sha256') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(checksumsText());
      }
      if (pathname.startsWith('/latest/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(ARCHIVE_BYTES);
      }
      // The pinned asset: pruned upstream (404) or some other failure (500).
      res.writeHead(pinnedStatus, { 'content-type': 'text/plain' });
      res.end(pinnedStatus === 404 ? 'Not Found' : 'Internal Server Error');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.MSTREAM_FFMPEG_MIRROR = `http://127.0.0.1:${server.address().port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ffmpeg-fallback-'));
    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    config.program.transcode.ffmpegDirectory = path.join(tmpDir, 'ffmpeg-0');
    bootstrap = await import('../../src/util/ffmpeg-bootstrap.js');

    const release = bootstrap.pinnedRelease();
    assert.equal(release?.source, 'btbn', 'this platform must have a BtbN pin in bin/ffmpeg/manifest.json');
    pinnedFile = release.file;
    const m = /-(linux64|linuxarm64|win64)-gpl\.(tar\.xz|zip)$/.exec(pinnedFile);
    assert.ok(m, `pinned file has the BtbN shape: ${pinnedFile}`);
    [, plat, ext] = m;
  });

  beforeEach(() => {
    bootstrap.reset();
    hits.length = 0;
    pinnedStatus = 404;
    sumsMatch = true;
    freshDir();
  });

  after(async () => {
    bootstrap?.reset();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('pickLatestFallback prefers the newest stable branch, same platform and archive type', () => {
    const pick = bootstrap.pickLatestFallback(checksumsText(), pinnedFile);
    assert.deepEqual(pick, { name: `ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}`, sha256: ARCHIVE_DIGEST, branch: 'n9.0' });
  });

  test('pickLatestFallback takes the master snapshot only when no branch build is listed', () => {
    const masterOnly = `${ARCHIVE_DIGEST}  ffmpeg-master-latest-${plat}-gpl.${ext}\n${ZERO_DIGEST}  ffmpeg-master-latest-${plat}-gpl-shared.${ext}\n`;
    assert.deepEqual(bootstrap.pickLatestFallback(masterOnly, pinnedFile),
      { name: `ffmpeg-master-latest-${plat}-gpl.${ext}`, sha256: ARCHIVE_DIGEST, branch: 'master' });
  });

  test('pickLatestFallback refuses bad digests, other platforms, and non-BtbN pins', () => {
    assert.equal(bootstrap.pickLatestFallback(`nothex  ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}\n`, pinnedFile), null);
    const other = plat === 'win64' ? 'linux64' : 'win64';
    assert.equal(bootstrap.pickLatestFallback(`${ARCHIVE_DIGEST}  ffmpeg-n9.0-latest-${other}-gpl-9.0.${ext}\n`, pinnedFile), null);
    assert.equal(bootstrap.pickLatestFallback(checksumsText(), 'download/macos/arm64/1787073674_9.0.1/ffmpeg.zip'), null);
    assert.equal(bootstrap.pickLatestFallback('', pinnedFile), null);
  });

  test('a pruned pin (404) falls back to the latest stable-branch build, verified against its checksums', async () => {
    const dir = config.program.transcode.ffmpegDirectory;
    await bootstrap.ensureFfmpeg();
    assert.equal(count(`/${pinnedFile}`), 1, `pinned asset fetched: ${hits.join(', ')}`);
    assert.equal(count('/latest/checksums.sha256'), 1, `checksums fetched: ${hits.join(', ')}`);
    assert.equal(count(`/latest/ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}`), 1, `stable-branch asset fetched: ${hits.join(', ')}`);
    assert.equal(count(`/latest/ffmpeg-master-latest-${plat}-gpl.${ext}`), 0, 'master must not be fetched when a branch build exists');
    // The bytes verified, then the extractor choked on them: nothing installed.
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
    assert.equal(fs.existsSync(path.join(dir, '.fetched.json')), false, 'no receipt for a failed install');
    assert.equal(fs.existsSync(path.join(dir, '.staging')), false, 'staging cleaned up');
  });

  test('a fallback whose digest never matches is retried once, then refused', async () => {
    sumsMatch = false;
    await bootstrap.ensureFfmpeg();
    assert.equal(count('/latest/checksums.sha256'), 2, `checksums re-read once: ${hits.join(', ')}`);
    assert.equal(count(`/latest/ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}`), 2, `asset fetched twice: ${hits.join(', ')}`);
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
  });

  test('a non-404 failure of the pinned asset does NOT fall back', async () => {
    pinnedStatus = 500;
    await bootstrap.ensureFfmpeg();
    assert.equal(count(`/${pinnedFile}`), 1);
    assert.equal(hits.filter((h) => h.startsWith('/latest/')).length, 0, `latest must stay untouched: ${hits.join(', ')}`);
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
  });

  test('checkForUpdate leaves a fallback install alone while the manifest still pins the dead tag', async () => {
    const dir = config.program.transcode.ffmpegDirectory;
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bin', 'ffmpeg', 'manifest.json'), 'utf8'));
    const binExt = process.platform === 'win32' ? '.exe' : '';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `ffmpeg${binExt}`), 'stub');
    fs.writeFileSync(path.join(dir, `ffprobe${binExt}`), 'stub');
    const receipt = (forTag) => JSON.stringify({
      schema: 1, family: 'ffmpeg', installedAt: new Date().toISOString(),
      pins: { source: 'btbn-latest', forTag, file: `ffmpeg-n9.0-latest-${plat}-gpl-9.0.${ext}`, sha256: ARCHIVE_DIGEST },
    });

    // Same dead tag as the manifest: nothing to converge onto, no network.
    fs.writeFileSync(path.join(dir, '.fetched.json'), receipt(manifest.btbn.tag));
    await bootstrap.checkForUpdate();
    assert.equal(hits.length, 0, `no fetch expected: ${hits.join(', ')}`);

    // A manifest with a NEW tag (here: the receipt naming an older one) is
    // grounds to try the pin again — and, it being pruned too, to fall back.
    fs.writeFileSync(path.join(dir, '.fetched.json'), receipt('autobuild-2000-01-01-00-00'));
    await bootstrap.checkForUpdate();
    assert.equal(count(`/${pinnedFile}`), 1, `pinned asset retried: ${hits.join(', ')}`);
    assert.equal(count('/latest/checksums.sha256'), 1, `fallback attempted: ${hits.join(', ')}`);
  });
});
