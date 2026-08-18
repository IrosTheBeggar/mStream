/**
 * ffmpeg-bootstrap: the download+install must be single-flight across a soft
 * reboot.
 *
 * reboot() -> transcode.reset() -> ffmpeg-bootstrap reset() used to null the
 * cached resolution promise while a download was still in flight; the
 * re-served instance's transcode.init() then started a SECOND download +
 * extract into the SAME .staging dir (each rm'ing the other's files, both
 * racing to swap binaries in) — three "Downloading ffmpeg" lines in one CI
 * boot.log. Now the in-flight install is shared: a chain that arrives while an
 * install into the same dir is running joins it; a different dir (the reboot
 * changed ffmpegDirectory) gets its own.
 *
 * Hermetic: MSTREAM_FFMPEG_MIRROR points the bootstrap at a loopback server
 * that serves a slow fake archive and DELIBERATELY WRONG checksums, so every
 * download completes, fails verification (no extractor is spawned, nothing is
 * installed) and the chain falls through to the system-PATH probe. What is
 * asserted is how many times the archive was fetched. The env var is read at
 * module import, and config.js imports the bootstrap transitively (via
 * api/transcode.js), so the server is started and the env set BEFORE the
 * first src import.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// musl skips the download step by design (no static build) — nothing to test.
const isMusl = process.platform === 'linux' && !(process.report?.getReport?.()?.header?.glibcVersionRuntime);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(20);
  }
}

// How long the fake archive body is held open mid-transfer: the window in
// which reset() + a second ensureFfmpeg() land while the first download is
// still in flight. Generous, so a slow CI runner can't slip past it.
const HOLD_MS = 1500;
const ZERO_DIGEST = '0'.repeat(64);

let server;
let baseUrl;
let tmpDir;
let config;
let bootstrap;
const archiveHits = [];   // request paths of archive fetches, in order
const pending = new Set(); // held responses, released on teardown

describe('ffmpeg-bootstrap: single-flight install across reset()', { skip: isMusl && 'musl skips the download step' }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://x');
      // checksums.sha256 (BtbN) and <asset>.sha256 (martin-riedl): a digest
      // that can never match, so a finished download is refused, not installed.
      if (pathname.endsWith('.sha256')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end([
          `${ZERO_DIGEST}  ffmpeg-master-latest-linux64-gpl.tar.xz`,
          `${ZERO_DIGEST}  ffmpeg-master-latest-linuxarm64-gpl.tar.xz`,
          `${ZERO_DIGEST}  ffmpeg-master-latest-win64-gpl.zip`,
          '',
        ].join('\n'));
        return;
      }
      // The archive: headers + a first chunk now, the rest after HOLD_MS.
      archiveHits.push(pathname);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('not-an-archive-');
      const timer = setTimeout(() => { pending.delete(timer); res.end('tail'); }, HOLD_MS);
      pending.add(timer);
      res.on('close', () => { clearTimeout(timer); pending.delete(timer); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.MSTREAM_FFMPEG_MIRROR = baseUrl;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-ffmpeg-bootstrap-'));
    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    config.program.transcode.ffmpegDirectory = path.join(tmpDir, 'ffmpeg-a');
    bootstrap = await import('../../src/util/ffmpeg-bootstrap.js');
  });

  after(async () => {
    for (const t of pending) { clearTimeout(t); }
    bootstrap?.reset();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('concurrent callers share one download (baseline, no reset)', async () => {
    archiveHits.length = 0;
    const results = await Promise.all([bootstrap.ensureFfmpeg(), bootstrap.ensureFfmpeg(), bootstrap.ensureFfmpeg()]);
    assert.equal(archiveHits.length, 1, `archive fetched ${archiveHits.length}x: ${archiveHits.join(', ')}`);
    // Whatever the machine has on PATH, the outcome is one answer for all.
    assert.equal(results.length, 3);
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled', 'the fake archive must never install');
  });

  test('ensureFfmpeg() → reset() → ensureFfmpeg() mid-download issues ONE download', async () => {
    bootstrap.reset();
    archiveHits.length = 0;

    const first = bootstrap.ensureFfmpeg();
    await waitFor(() => archiveHits.length === 1, 'the first archive request');

    // The soft reboot: transcode.reset() -> reset(), then the re-served
    // instance's init() -> ensureFfmpeg(), while the archive is still coming in.
    bootstrap.reset();
    const second = bootstrap.ensureFfmpeg();

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(archiveHits.length, 1, `archive fetched ${archiveHits.length}x: ${archiveHits.join(', ')}`);
    // Both callers got an answer (whatever it is on this machine): the stale
    // chain finished as a bystander, the new one is the published state.
    assert.equal(r1 === null || typeof r1 === 'object', true);
    assert.equal(r2 === null || typeof r2 === 'object', true);
    assert.notEqual(bootstrap.getResolvedSource(), 'bundled');
  });

  test('a changed ffmpegDirectory mid-download starts its own install (two downloads, no sharing)', async () => {
    bootstrap.reset();
    archiveHits.length = 0;
    config.program.transcode.ffmpegDirectory = path.join(tmpDir, 'ffmpeg-b');

    const first = bootstrap.ensureFfmpeg();
    await waitFor(() => archiveHits.length === 1, 'the first archive request');

    bootstrap.reset();
    config.program.transcode.ffmpegDirectory = path.join(tmpDir, 'ffmpeg-c');
    const second = bootstrap.ensureFfmpeg();
    await waitFor(() => archiveHits.length === 2, 'the second archive request (new dir)');

    await Promise.all([first, second]);
    assert.equal(archiveHits.length, 2);
    // Each install staged under its own dir and cleaned up after itself.
    assert.equal(fs.existsSync(path.join(tmpDir, 'ffmpeg-b', '.staging')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'ffmpeg-c', '.staging')), false);
  });

  test('callers arriving after the reset join the current chain (still one download)', async () => {
    // Chain 1 downloads into dir D; reset(); chain 2 (same dir) joins the
    // download and a third caller joins chain 2 — one download for all three.
    // (The stale-chain guard in ensureFfmpeg — a superseded chain must not
    // publish or clear its successor's promise — is a race window of
    // microseconds and is covered by code comment, not asserted here.)
    bootstrap.reset();
    archiveHits.length = 0;
    config.program.transcode.ffmpegDirectory = path.join(tmpDir, 'ffmpeg-d');

    const first = bootstrap.ensureFfmpeg();
    await waitFor(() => archiveHits.length === 1, 'the first archive request');
    bootstrap.reset();
    const second = bootstrap.ensureFfmpeg();
    const third = bootstrap.ensureFfmpeg();   // joins chain 2's promise
    await Promise.all([first, second, third]);
    assert.equal(archiveHits.length, 1, `archive fetched ${archiveHits.length}x: ${archiveHits.join(', ')}`);
  });
});
