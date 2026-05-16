/**
 * Mount guard sentinel tests.
 *
 * The mount guard (src/db/mount-guard.js, mirrored inline at the top of
 * rust-parser/src/main.rs) writes a `.mstream.md` file to each library
 * root after every successful scan, and pre-checks it at the start of
 * every subsequent scan. If the sentinel is missing AND the DB still
 * has tracks for that library, the scanner emits a structured
 * `scanAborted` event and exits without running `DELETE FROM tracks`
 * — protecting users from a vanished NAS / unplugged drive being
 * silently interpreted as "your library is now empty, delete
 * everything."
 *
 * Scenarios:
 *   1. First scan (no tracks in DB) — proceeds even without sentinel;
 *      writes the sentinel on success.
 *   2. Subsequent scan WITH sentinel intact — proceeds normally.
 *   3. Subsequent scan WITHOUT sentinel — aborts; DB unchanged.
 *   4. forceRescan WITHOUT sentinel — STILL aborts (data safety beats
 *      operator intent — explicit reset endpoint required).
 *   5. Sentinel content includes the expected human-readable explainer.
 *   6. JS fallback scanner enforces the same gate (parity with Rust).
 *
 * Admin reset endpoint is covered in test/admin-scan-params.test.mjs
 * — it's a thin wrapper around `writeSentinel`, identical structurally
 * to the existing admin/db/params/* routes.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig,
} from './helpers/scanner-runner.mjs';
import { generateLibrary, mkSpec } from './helpers/library-gen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SENTINEL_FILENAME = '.mstream.md';

let rustBin;
let workDir;

// runScan variant that returns ALL JSON events from stdout, not just
// scanComplete. The shared scanner-runner.runScan rejects when no
// scanComplete arrives — which is exactly the success state for the
// mount-guard abort case, so we need our own here.
function runScanCapture(rustBin, config) {
  return new Promise((resolve, reject) => {
    const p = spawn(rustBin, [JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      const events = stdout.split('\n')
        .map(l => l.trim()).filter(l => l.startsWith('{'))
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      resolve({ code, stdout, stderr, events });
    });
  });
}

function countTracks(dbPath, libraryId) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM tracks WHERE library_id = ?').get(libraryId);
  db.close();
  return row.cnt;
}

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) { return; }
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-mount-guard-'));
});

after(async () => {
  if (workDir) {
    await fsp.rm(workDir, { recursive: true, force: true,
      maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

function freshFixture(name) {
  const root = path.join(workDir, name);
  const libRoot = path.join(root, 'lib');
  const dbPath  = path.join(root, 'm.db');
  const artDir  = path.join(root, 'art');
  const wfDir   = path.join(root, 'wf');
  for (const d of [libRoot, root, artDir, wfDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { libRoot, dbPath, artDir, wfDir };
}

function buildCfg(fix, libraryId, vpath, overrides = {}) {
  return buildScanConfig({
    dbPath: fix.dbPath, libraryId, vpath, directory: fix.libRoot,
    albumArtDirectory: fix.artDir, waveformCacheDir: fix.wfDir,
    scanId: `mg-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    overrides,
  });
}

// ── Rust scanner ──────────────────────────────────────────────────────────

describe('rust-parser mount guard', () => {
  test('first-scan path: no sentinel + empty DB → proceeds and writes sentinel', async (t) => {
    if (!rustBin) { return t.skip('rust-parser binary not available'); }
    const fix = freshFixture('rust-first-scan');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock',
               duration: 5, toneFreq: 220 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'mg1');

    // Sanity: sentinel should NOT exist before the first scan.
    assert.equal(fs.existsSync(path.join(fix.libRoot, SENTINEL_FILENAME)), false,
      'pre-condition: no sentinel before first scan');

    const r = await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    assert.equal(r.code, 0, `scanner exited cleanly (stderr: ${r.stderr.slice(-300)})`);
    const complete = r.events.find(e => e.event === 'scanComplete');
    assert.ok(complete, 'first scan emitted scanComplete');
    assert.equal(complete.filesProcessed, 1);

    // Sentinel was written by the successful scan.
    assert.equal(fs.existsSync(path.join(fix.libRoot, SENTINEL_FILENAME)), true,
      'first scan wrote the sentinel');
  });

  test('subsequent scan WITH sentinel intact → proceeds normally', async (t) => {
    if (!rustBin) { return t.skip(); }
    const fix = freshFixture('rust-with-sentinel');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'mg2');

    // Run twice — second run hits the fast path; the sentinel persists.
    await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    assert.equal(countTracks(fix.dbPath, libraryId), 1,
      'first scan inserted the track');
    const r2 = await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    assert.equal(r2.code, 0);
    assert.ok(r2.events.some(e => e.event === 'scanComplete'),
      'second scan emitted scanComplete (sentinel present)');
    assert.ok(!r2.events.some(e => e.event === 'scanAborted'),
      'second scan did NOT emit scanAborted');
    assert.equal(countTracks(fix.dbPath, libraryId), 1,
      'track count unchanged across second scan');
  });

  test('subsequent scan WITHOUT sentinel → aborts; tracks preserved', async (t) => {
    if (!rustBin) { return t.skip(); }
    const fix = freshFixture('rust-no-sentinel');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5 }),
      mkSpec({ filepath: 'b.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5, toneFreq: 330 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'mg3');

    await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    assert.equal(countTracks(fix.dbPath, libraryId), 2);

    // Simulate a vanished mount: keep the directory accessible (so
    // is_dir() still passes) but delete the sentinel. This is exactly
    // the failure mode the guard is for — Docker volume fallback or
    // a misconfigured SMB share replacing the target with empty space.
    fs.unlinkSync(path.join(fix.libRoot, SENTINEL_FILENAME));
    // Also nuke the audio files so a non-guarded scan would 0-process
    // and run DELETE FROM tracks. This is what makes the test
    // meaningful — without the guard, both tracks would be gone.
    fs.unlinkSync(path.join(fix.libRoot, 'a.mp3'));
    fs.unlinkSync(path.join(fix.libRoot, 'b.mp3'));

    const r = await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    assert.equal(r.code, 0, `scanner exited 0 (clean abort) — stderr: ${r.stderr.slice(-300)}`);
    const abort = r.events.find(e => e.event === 'scanAborted');
    assert.ok(abort, `expected scanAborted event in: ${JSON.stringify(r.events)}`);
    assert.equal(abort.reason, 'mount_guard');
    assert.equal(abort.libraryId, libraryId);
    assert.equal(abort.trackCount, 2);
    assert.ok(!r.events.some(e => e.event === 'scanComplete'),
      'no scanComplete emitted on aborted scan');

    // Tracks must be preserved — the whole point of the guard.
    assert.equal(countTracks(fix.dbPath, libraryId), 2,
      'tracks preserved across the aborted scan');
  });

  test('forceRescan WITHOUT sentinel → STILL aborts (data safety)', async (t) => {
    if (!rustBin) { return t.skip(); }
    const fix = freshFixture('rust-force-rescan');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'mg4');

    await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    fs.unlinkSync(path.join(fix.libRoot, SENTINEL_FILENAME));

    // forceRescan = true. The audit was explicit: the guard MUST still
    // apply. forceRescan means "re-extract every file"; it doesn't
    // grant authority to delete the library if the mount is gone.
    const r = await runScanCapture(rustBin,
      buildCfg(fix, libraryId, vpath, { forceRescan: true }));
    assert.ok(r.events.some(e => e.event === 'scanAborted'),
      'forceRescan still triggers mount guard abort');
    assert.equal(countTracks(fix.dbPath, libraryId), 1);
  });

  test('sentinel content is the expected explainer text', async (t) => {
    if (!rustBin) { return t.skip(); }
    const fix = freshFixture('rust-sentinel-content');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'mg5');

    await runScanCapture(rustBin, buildCfg(fix, libraryId, vpath));
    const content = fs.readFileSync(path.join(fix.libRoot, SENTINEL_FILENAME), 'utf8');
    assert.match(content, /^# mStream — Mount Guard/, 'starts with the explainer header');
    assert.match(content, /Do NOT delete this file/i, 'tells operators not to delete it');
    assert.match(content, /reset-sentinel/, 'mentions the admin reset endpoint');
  });
});

// ── JS fallback scanner (parity) ───────────────────────────────────────────

describe('JS scanner mount guard', () => {
  // The JS scanner runs the same mount-guard logic via
  // src/db/mount-guard.js. Direct spawn — bypasses task-queue's
  // Rust-or-JS picker. Strip Rust-only fields (waveformCacheDir,
  // analyzeBpm is whitelisted but waveformCacheDir is not) since
  // the JS scanner's Joi schema strict-rejects unknown keys.
  function runJsScan(cfg) {
    const jsCfg = { ...cfg };
    delete jsCfg.waveformCacheDir;
    return new Promise((resolve) => {
      const p = spawn(process.execPath,
        [path.join(REPO_ROOT, 'src', 'db', 'scanner.mjs'), JSON.stringify(jsCfg)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => { stdout += d.toString(); });
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('exit', code => {
        const events = stdout.split('\n')
          .map(l => l.trim()).filter(l => l.startsWith('{'))
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
        resolve({ code, stdout, stderr, events });
      });
    });
  }

  test('first scan writes sentinel; subsequent scan w/o sentinel aborts', async () => {
    const fix = freshFixture('js-end-to-end');
    await generateLibrary({ outputDir: fix.libRoot, specs: [
      mkSpec({ filepath: 'a.mp3', artist: 'A', album: 'X', genre: 'Rock', duration: 5 }),
    ]});
    const { libraryId, vpath } = initEmptyDb(fix.dbPath, fix.libRoot, 'jsmg');

    const r1 = await runJsScan(buildCfg(fix, libraryId, vpath));
    assert.equal(r1.code, 0, `first scan exited 0; stderr: ${r1.stderr.slice(-300)}`);
    assert.equal(fs.existsSync(path.join(fix.libRoot, SENTINEL_FILENAME)), true,
      'JS scanner wrote sentinel on first scan');
    assert.ok(countTracks(fix.dbPath, libraryId) >= 1);

    fs.unlinkSync(path.join(fix.libRoot, SENTINEL_FILENAME));
    const r2 = await runJsScan(buildCfg(fix, libraryId, vpath));
    const abort = r2.events.find(e => e.event === 'scanAborted');
    assert.ok(abort, `JS scanner emitted scanAborted; events: ${JSON.stringify(r2.events)}`);
    assert.equal(abort.reason, 'mount_guard');
    assert.equal(countTracks(fix.dbPath, libraryId) >= 1, true,
      'JS scanner preserved tracks on aborted scan');
  });
});
