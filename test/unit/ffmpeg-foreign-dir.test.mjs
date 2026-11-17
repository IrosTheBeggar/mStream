/**
 * ffmpeg-bootstrap: a configured ffmpegDirectory that mStream cannot use.
 *
 * YunoHost's package points transcode.ffmpegDirectory at /usr/bin: Debian
 * 12's ffmpeg 5 (mStream needs 6+), read-only for the service under the
 * unit's ProtectSystem=full. The bootstrap called the distro's binaries
 * "unusable, refreshing", tried to delete them, could not create
 * /usr/bin/.staging, and the chain ended there with no ffmpeg at all. (Run as
 * root over a writable /usr/bin, the same path deleted the distro's ffmpeg
 * and ffprobe and downloaded its own in their place.)
 *
 * What holds now:
 *  - binaries mStream did not install (a custom directory with no receipt)
 *    are never deleted and never installed over, usable or not;
 *  - a configured directory that cannot be used — such binaries in it, or no
 *    way to write to it — hands the install to the default data directory;
 *  - a download that merely FAILS is not tried again in the default one;
 *  - the update check answers for the directory actually in use.
 *
 * Hermetic like ffmpeg-bootstrap.test.mjs: MSTREAM_FFMPEG_MIRROR points at a
 * loopback server whose bytes can never match the committed pins, so every
 * install attempt is exactly one refused download and nothing is ever
 * installed. What is asserted is WHERE the attempt went (an install creates
 * its target directory), how many downloads there were, and what is on disk
 * afterwards. The default directory is injected — ensureFfmpeg({ defaultDir })
 * — because the real one is the checkout's bin/ffmpeg, which holds working
 * binaries on a dev machine and in CI.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// musl skips the download step by design, so it has no stand-in directory.
const isMusl = process.platform === 'linux' && !(process.report?.getReport?.()?.header?.glibcVersionRuntime);
const isWindows = process.platform === 'win32';
const binExt = isWindows ? '.exe' : '';
const FFMPEG = `ffmpeg${binExt}`;
const FFPROBE = `ffprobe${binExt}`;
// Somebody else's binary that mStream cannot run: no exec bit on POSIX, not a
// PE image on Windows. Byte-compared afterwards to prove it was not touched.
const STUB = 'a binary mStream did not install and cannot run';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(20);
  }
}

let server;
let tmpDir;
let config;
let bootstrap;
const hits = [];           // request paths of download attempts, in order
const pending = new Set(); // held responses, released on teardown
let holdMs = 0;            // > 0: keep the download in flight this long

// A fresh configured directory + default directory per test. Neither exists
// until something creates it.
function scenario(name) {
  const custom = path.join(tmpDir, `${name}-configured`);
  const standIn = path.join(tmpDir, `${name}-default`);
  config.program.transcode.ffmpegDirectory = custom;
  return { custom, standIn };
}

function placeStubs(dir, names = [FFMPEG, FFPROBE]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) { fs.writeFileSync(path.join(dir, name), STUB); }
}

// POSIX only: a pair that answers `-version` like a current ffmpeg would.
function placeRunnable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} version 7.1-stub Copyright (c) the test suite"\n`, { mode: 0o755 });
  }
}

function receipt(pins = { source: 'test-stale-pins' }) {
  return JSON.stringify({ schema: 1, family: 'ffmpeg', pins, installedAt: new Date().toISOString() });
}

const untouched = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8') === STUB;

describe('ffmpeg-bootstrap: a configured directory mStream cannot use', { skip: isMusl && 'musl skips the download step' }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(new URL(req.url, 'http://x').pathname);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (!holdMs) { return res.end('not-an-archive'); }
      res.write('not-an-archive-');
      const timer = setTimeout(() => { pending.delete(timer); res.end('tail'); }, holdMs);
      pending.add(timer);
      res.on('close', () => { clearTimeout(timer); pending.delete(timer); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.MSTREAM_FFMPEG_MIRROR = `http://127.0.0.1:${server.address().port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ffmpeg-foreign-'));
    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    bootstrap = await import('../../src/util/ffmpeg-bootstrap.js');
  });

  beforeEach(() => {
    bootstrap.reset();
    hits.length = 0;
    holdMs = 0;
  });

  after(async () => {
    for (const t of pending) { clearTimeout(t); }
    bootstrap?.reset();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unusable binaries mStream did not install stay as they are; the default directory takes the install', async () => {
    const { custom, standIn } = scenario('foreign-pair');
    placeStubs(custom);

    await bootstrap.ensureFfmpeg({ defaultDir: standIn });

    assert.ok(untouched(custom, FFMPEG), 'ffmpeg was not deleted or replaced');
    assert.ok(untouched(custom, FFPROBE), 'ffprobe was not deleted or replaced');
    assert.deepEqual(fs.readdirSync(custom).sort(), [FFMPEG, FFPROBE].sort(), 'nothing was added next to them');
    assert.equal(hits.length, 1, `one install attempt: ${hits.join(', ')}`);
    assert.equal(fs.existsSync(standIn), true, 'the attempt went to the default directory');
    assert.equal(fs.existsSync(path.join(standIn, '.staging')), false, 'staging cleaned up');
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled', 'the fake archive must never install');
  });

  test('half a pair that mStream did not install is not installed over', async () => {
    const { custom, standIn } = scenario('foreign-half');
    placeStubs(custom, [FFMPEG]);

    await bootstrap.ensureFfmpeg({ defaultDir: standIn });

    assert.ok(untouched(custom, FFMPEG));
    assert.deepEqual(fs.readdirSync(custom), [FFMPEG], 'no staging area, no second binary');
    assert.equal(hits.length, 1);
    assert.equal(fs.existsSync(standIn), true, 'the attempt went to the default directory');
  });

  for (const marker of ['.fetched.json', '.checksum']) {
    test(`an unusable install of mStream's own (${marker}) is still refreshed in place`, async () => {
      const { custom, standIn } = scenario(`ours-${marker.slice(1)}`);
      placeStubs(custom);
      fs.writeFileSync(path.join(custom, marker), marker === '.checksum' ? 'f'.repeat(64) : receipt());

      await bootstrap.ensureFfmpeg({ defaultDir: standIn });

      assert.equal(fs.existsSync(path.join(custom, FFMPEG)), false, 'the unusable ffmpeg was cleared for the refresh');
      assert.equal(fs.existsSync(path.join(custom, FFPROBE)), false, 'the unusable ffprobe was cleared for the refresh');
      assert.equal(hits.length, 1);
      assert.equal(fs.existsSync(standIn), false, 'the refresh stays in the configured directory');
    });
  }

  test('a configured directory that cannot take an install hands it to the default directory', async () => {
    // Portable stand-in for "cannot write here": a file sits where the
    // directory should be, so not even the directory can be made.
    const { custom, standIn } = scenario('not-a-directory');
    fs.writeFileSync(custom, 'a file where the directory should be');

    await bootstrap.ensureFfmpeg({ defaultDir: standIn });

    assert.equal(hits.length, 1, `one install attempt, in the default directory: ${hits.join(', ')}`);
    assert.equal(fs.existsSync(standIn), true);
    assert.equal(fs.readFileSync(custom, 'utf8'), 'a file where the directory should be');
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
  });

  const noPermissionBits = isWindows ? 'directory permission bits do not stop writes on Windows'
    : process.getuid?.() === 0 ? 'root ignores permission bits' : false;
  test('a read-only configured directory hands the install to the default directory', { skip: noPermissionBits }, async () => {
    const { custom, standIn } = scenario('read-only');
    fs.mkdirSync(custom);
    fs.chmodSync(custom, 0o555);
    try {
      await bootstrap.ensureFfmpeg({ defaultDir: standIn });
    } finally {
      fs.chmodSync(custom, 0o755);
    }

    assert.equal(hits.length, 1, `one install attempt, in the default directory: ${hits.join(', ')}`);
    assert.equal(fs.existsSync(standIn), true);
    assert.deepEqual(fs.readdirSync(custom), [], 'nothing was written to the read-only directory');
  });

  test('a download that fails in a writable configured directory is not tried again in the default one', async () => {
    const { custom, standIn } = scenario('writable');

    await bootstrap.ensureFfmpeg({ defaultDir: standIn });

    assert.equal(hits.length, 1, `exactly one download: ${hits.join(', ')}`);
    assert.equal(fs.existsSync(custom), true, 'the attempt was in the configured directory');
    assert.equal(fs.existsSync(standIn), false, 'the default directory was never touched');
  });

  test('a reset() while the default directory is installing: the next chain joins that download', async () => {
    // The chain asks about TWO directories in a row here (the unusable one,
    // then the default). Answering for the first must not forget the install
    // still running in the second, or a soft reboot downloads twice into the
    // same staging area.
    const { custom, standIn } = scenario('single-flight');
    fs.writeFileSync(custom, 'a file where the directory should be');
    holdMs = 800;

    const first = bootstrap.ensureFfmpeg({ defaultDir: standIn });
    await waitFor(() => hits.length === 1, 'the download into the default directory');
    bootstrap.reset();
    const second = bootstrap.ensureFfmpeg({ defaultDir: standIn });

    await Promise.all([first, second]);
    assert.equal(hits.length, 1, `archive fetched ${hits.length}x: ${hits.join(', ')}`);
  });

  // The rest needs a pair that actually RUNS; a shell script stands in for
  // one, which Windows cannot execute as ffmpeg.exe.
  const needsRunnable = isWindows && 'needs a runnable stand-in for ffmpeg';

  test('working binaries already in the default directory are used without a download, and the update check answers for them', { skip: needsRunnable }, async () => {
    const { custom, standIn } = scenario('second-boot');
    placeStubs(custom);
    placeRunnable(standIn);
    fs.writeFileSync(path.join(standIn, '.fetched.json'), receipt());

    const resolved = await bootstrap.ensureFfmpeg({ defaultDir: standIn });
    assert.equal(hits.length, 0, `no download on a later boot: ${hits.join(', ')}`);
    assert.equal(bootstrap.getResolvedSource(), 'bundled');
    assert.equal(resolved.ffmpeg, path.join(standIn, 'ffmpeg'));
    assert.equal(bootstrap.ffprobeBin(), path.join(standIn, 'ffprobe'));

    // Its receipt records other pins than the manifest's, so a refresh is
    // due — of the build in use, not of whatever sits in ffmpegDirectory.
    await bootstrap.checkForUpdate();
    assert.equal(hits.length, 1, `the refresh went after the build in use: ${hits.join(', ')}`);
    assert.ok(untouched(custom, FFMPEG) && untouched(custom, FFPROBE), 'the configured directory is still as it was');
    assert.deepEqual(fs.readdirSync(custom).sort(), [FFMPEG, FFPROBE].sort());
    assert.equal(fs.existsSync(path.join(standIn, 'ffmpeg')), true, 'a failed refresh leaves the working build in place');
  });

  test('working binaries mStream did not install are used as they are and never refreshed', { skip: needsRunnable }, async () => {
    const { custom, standIn } = scenario('foreign-working');
    placeRunnable(custom);

    const resolved = await bootstrap.ensureFfmpeg({ defaultDir: standIn });
    assert.equal(resolved.ffmpeg, path.join(custom, 'ffmpeg'));
    assert.equal(bootstrap.getResolvedSource(), 'bundled');

    await bootstrap.checkForUpdate();
    assert.equal(hits.length, 0, `nothing fetched: ${hits.join(', ')}`);
    assert.equal(fs.existsSync(standIn), false, 'the default directory was never needed');
    assert.deepEqual(fs.readdirSync(custom).sort(), ['ffmpeg', 'ffprobe']);
  });
});
