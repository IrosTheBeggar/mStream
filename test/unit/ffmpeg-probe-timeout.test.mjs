/**
 * ffmpeg-bootstrap: deletes or downloads over binaries only when they are
 * definitely broken AND mStream installed them.
 *
 * Two ways a working ffmpeg used to get destroyed:
 *   - A SLOW probe. `-version` running past its budget read as "unusable":
 *     ensureFfmpeg() unlinked ffmpeg + ffprobe, then went to download (and
 *     ended with no ffmpeg at all when the download could not happen). A
 *     loaded box, a slow disk, or a first-exec antivirus scan is enough.
 *     A probe that runs out of time now gets one longer retry. Two
 *     timeouts leave the binaries in place, and nothing downloads over them.
 *   - An OPERATOR's binaries. docs/json_config.md and bin/ffmpeg/README.md
 *     promise that binaries placed in a custom ffmpegDirectory are never
 *     touched. Step 1 deleted them anyway when they were too old, and the
 *     download renamed over them, including a distro's /usr/bin pair (the
 *     yt-dlp docker smoke did exactly that). Binaries without an install
 *     marker (receipt or legacy .checksum, see isManagedDir) in a custom dir
 *     now stay as they are.
 *
 * Hermetic, like ffmpeg-bootstrap.test.mjs:
 *   - MSTREAM_FFMPEG_MIRROR points every download at a loopback server
 *     whose bytes can never match the committed pins, so nothing installs.
 *     What is asserted is whether a download was ATTEMPTED.
 *   - PATH points at an empty dir, so the system-PATH rung finds nothing
 *     and every non-resolving outcome is a deterministic null.
 *   - MSTREAM_TEST_FFMPEG_PROBE_TIMEOUT_MS shrinks the probe budgets
 *     (first attempt 600ms, retry 6x = 3.6s), so a "slow" fake answers
 *     after 1.5s, between the two.
 * All of it is set BEFORE the first src import (config.js pulls in the
 * bootstrap transitively, and the bootstrap reads these at import).
 *
 * The fakes are shell / node scripts, hence no Windows. musl skips the
 * download step by design, and several cases assert on downloads.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isMusl = process.platform === 'linux' && !(process.report?.getReport?.()?.header?.glibcVersionRuntime);
const skip = process.platform === 'win32' ? 'the fake binaries are shell and node scripts'
  : isMusl ? 'musl skips the download step, and these cases assert on downloads'
  : /\s/.test(process.execPath) ? 'the slow fake needs a whitespace-free node path for its shebang'
  : false;

const FIRST_BUDGET_MS = 600;   // retry = 6x (VERSION_PROBE_RETRY_TIMEOUT_MS)
const LATE_ANSWER_MS = 1500;   // past the first budget, well inside the retry

let server;
let tmpDir;
let dirCounter = 0;
let config;
let bootstrap;
let savedPath;
const hits = [];   // mirror request paths: any entry = a download was attempted

const answers = (name, version) =>
  `#!/bin/sh\necho "${name} version ${version} Copyright (c) the fake-build authors"\n`;
const answersLate = (name) =>
  `#!${process.execPath}\nsetTimeout(() => console.log('${name} version 7.1 Copyright (c) the fake-build authors'), ${LATE_ANSWER_MS});\n`;
// exec, so the probe's SIGKILL lands on the sleeper itself: no orphans.
const neverAnswers = () => '#!/bin/sh\nexec /bin/sleep 30\n';

function freshDir() {
  const dir = path.join(tmpDir, `ffmpeg-${++dirCounter}`);
  config.program.transcode.ffmpegDirectory = dir;
  return dir;
}

function put(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

// What isManagedDir() reads as "mStream installed these".
function markOurs(dir) {
  fs.writeFileSync(path.join(dir, '.fetched.json'), JSON.stringify({
    schema: 1, family: 'ffmpeg', pins: { source: 'not-the-manifest' }, installedAt: new Date().toISOString(),
  }));
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

describe('ffmpeg-bootstrap: slow probes and operator binaries are never destroyed', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(new URL(req.url, 'http://x').pathname);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('never-hashes-to-a-pin');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.MSTREAM_FFMPEG_MIRROR = `http://127.0.0.1:${server.address().port}`;
    process.env.MSTREAM_TEST_FFMPEG_PROBE_TIMEOUT_MS = String(FIRST_BUDGET_MS);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ffmpeg-probe-timeout-'));
    const emptyPath = path.join(tmpDir, 'empty-path');
    fs.mkdirSync(emptyPath);
    savedPath = process.env.PATH;
    process.env.PATH = emptyPath;

    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    bootstrap = await import('../../src/util/ffmpeg-bootstrap.js');
  });

  beforeEach(() => {
    bootstrap.reset();
    hits.length = 0;
  });

  after(async () => {
    bootstrap?.reset();
    if (savedPath !== undefined) { process.env.PATH = savedPath; }
    if (server) { await new Promise((resolve) => server.close(resolve)); }
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  test('a probe that answers only after its first budget is retried, and the install resolves', async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answersLate('ffmpeg'));
    put(dir, 'ffprobe', answers('ffprobe', '7.1'));
    markOurs(dir);
    const before = snapshot(dir);

    const res = await bootstrap.ensureFfmpeg();
    assert.equal(res?.source, 'bundled', 'the late answer resolves the install');
    assert.equal(bootstrap.ffmpegBin(), path.join(dir, 'ffmpeg'));
    assert.deepEqual(snapshot(dir), before, 'nothing deleted or replaced');
    assert.deepEqual(hits, [], 'nothing downloaded');
  });

  test('an ffmpeg that never answers is left in place, and nothing downloads over it', async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', neverAnswers());
    put(dir, 'ffprobe', answers('ffprobe', '7.1'));
    markOurs(dir);
    const before = snapshot(dir);

    assert.equal(await bootstrap.ensureFfmpeg(), null);
    assert.deepEqual(snapshot(dir), before, 'a timeout is not a verdict: both binaries and the receipt stay');
    assert.deepEqual(hits, [], 'no download renames over binaries that merely did not answer');
  });

  test('an ffprobe that never answers next to a healthy ffmpeg is left in place too', async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answers('ffmpeg', '7.1'));
    put(dir, 'ffprobe', neverAnswers());
    markOurs(dir);
    const before = snapshot(dir);

    assert.equal(await bootstrap.ensureFfmpeg(), null);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(hits, []);
  });

  test('a broken build mStream installed is still deleted and re-downloaded', async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answers('ffmpeg', '4.4.2'));
    put(dir, 'ffprobe', answers('ffprobe', '4.4.2'));
    markOurs(dir);

    await bootstrap.ensureFfmpeg();
    assert.equal(fs.existsSync(path.join(dir, 'ffmpeg')), false, 'the unusable managed ffmpeg is unlinked');
    assert.equal(fs.existsSync(path.join(dir, 'ffprobe')), false, 'and its ffprobe');
    assert.ok(hits.length >= 1, 'a refresh download was attempted');
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled', 'the fake mirror bytes never install');
  });

  test("an operator's unusable binaries in a custom dir are never deleted or downloaded over", async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answers('ffmpeg', '4.4.2'));
    put(dir, 'ffprobe', answers('ffprobe', '4.4.2'));
    const before = snapshot(dir);

    assert.equal(await bootstrap.ensureFfmpeg(), null);
    assert.deepEqual(snapshot(dir), before, 'no install marker = the operator\'s files, untouched');
    assert.deepEqual(hits, [], 'a download would rename over them');
  });

  test("half of an operator's pair is not downloaded over", async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answers('ffmpeg', '7.1'));
    const before = snapshot(dir);

    assert.equal(await bootstrap.ensureFfmpeg(), null);
    assert.deepEqual(snapshot(dir), before, 'the lone ffmpeg survives and no ffprobe appears');
    assert.deepEqual(hits, []);
  });

  test('an empty custom dir still gets a download (a desktop profile\'s first run)', async () => {
    freshDir();   // not even created: <dataHome>/ffmpeg on first boot
    await bootstrap.ensureFfmpeg();
    assert.ok(hits.length >= 1, 'nothing there to protect, so the pinned build is fetched');
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
  });

  test('checkForUpdate refreshes only installs mStream made', async () => {
    const dir = freshDir();
    put(dir, 'ffmpeg', answers('ffmpeg', '7.1'));
    put(dir, 'ffprobe', answers('ffprobe', '7.1'));
    const before = snapshot(dir);
    assert.equal((await bootstrap.ensureFfmpeg())?.source, 'bundled', "an operator's healthy pair is used as-is");

    await bootstrap.checkForUpdate();
    assert.deepEqual(hits, [], "no update check fetches over the operator's binaries");

    // The same binaries with a receipt whose pins differ from the manifest:
    // ours, and stale, so the check refreshes. The fake bytes are refused
    // before the swap, so the live pair stays as it was.
    markOurs(dir);
    await bootstrap.checkForUpdate();
    assert.ok(hits.length >= 1, 'a stale managed install is refreshed');
    assert.equal(fs.readFileSync(path.join(dir, 'ffmpeg'), 'utf8'), before.ffmpeg, 'a refused download leaves the live ffmpeg');
  });
});
