/**
 * Regression tests for the JS fallback scanner (src/db/scanner.mjs).
 *
 * The parity suite (scanner-parity.test.mjs) only ever runs the Rust
 * binary, so the JS fallback's own code paths went untested and drifted.
 * These tests fork scanner.mjs directly — the same way task-queue.js
 * does — and cover two bugs fixed alongside them:
 *
 *   1. Config parity. task-queue.js sends `waveformCacheDir` (a
 *      Rust-only field) in every jsonLoad and no longer sends
 *      `generateWaveforms`. The JS scanner's Joi schema didn't accept
 *      `waveformCacheDir` and rejected unknown keys, so the fallback
 *      bailed with "Invalid JSON Input" before doing any work. A scan
 *      against an accessible (if empty) library must now run end-to-end.
 *
 *   2. Data-loss guard. If the library directory is inaccessible (a
 *      vanished CIFS/NFS mount), the scanner used to walk nothing and
 *      then DELETE every track for that library, cascading through
 *      albums / artists / user_album_stars. It must now abort without
 *      touching the tracks — mirroring rust-parser/src/main.rs.
 *
 * No audio fixtures or ffmpeg required: we hand-insert one tracks row
 * (the same shape the scanner writes for a tagless file) and assert
 * whether the scanner keeps it or sweeps it.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initEmptyDb, FFMPEG } from '../helpers/scanner-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(__dirname, '..', '..', 'src', 'db', 'scanner.mjs');
const ffmpegOk = fs.existsSync(FFMPEG);

let workDir;
let artDir;

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-jsscan-'));
  artDir = path.join(workDir, 'art');
  await fsp.mkdir(artDir, { recursive: true });
});

after(async () => {
  if (workDir) { await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
});

// A jsonLoad shaped exactly like task-queue.js's — crucially including
// the Rust-only `waveformCacheDir` — so a passing scan also proves the
// schema accepts the real production config.
function buildConfig({ dbPath, libraryId, directory, scanId }) {
  return {
    dbPath, libraryId, directory, scanId,
    vpath: 'guardlib',
    skipImg: true,            // no art work — keeps the test self-contained
    albumArtDirectory: artDir,
    compressImage: false,
    supportedFiles: {
      mp3: true, flac: true, wav: true, ogg: true,
      aac: true, m4a: true, m4b: true, opus: true,
    },
    scanCommitInterval: 25,
    scanThreads: 0,
    forceRescan: false,
    followSymlinks: false,
    analyzeBpm: true,
    waveformCacheDir: path.join(workDir, 'waveforms'),
    subtree: '',
  };
}

function runJsScanner(config) {
  return new Promise((resolve, reject) => {
    const child = fork(SCANNER, [JSON.stringify(config)], { silent: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Fresh DB with a library row + one hand-inserted track carrying an OLD
// scan_id, so the end-of-scan stale-cleanup DELETE would target it.
function seedDbWithTrack(label, rootPath) {
  const dbPath = path.join(workDir, `${label}.db`);
  const { libraryId } = initEmptyDb(dbPath, rootPath, `guardlib-${label}`);
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO tracks (filepath, library_id, scan_id) VALUES (?, ?, ?)')
    .run('old/song.mp3', libraryId, 'scan-old');
  db.close();
  return { dbPath, libraryId };
}

function trackCount(dbPath, libraryId) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?').get(libraryId).n;
  } finally {
    db.close();
  }
}

// Pull the scanner's `scanComplete` JSON event off stdout — same parse
// task-queue.js does. Returns the parsed object or null.
function scanCompleteEvent(stdout) {
  const line = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    .reverse().find(l => l.startsWith('{') && l.includes('"scanComplete"'));
  return line ? JSON.parse(line) : null;
}

// Generate a 1-second FLAC with basic tags via the bundled ffmpeg.
function makeFlac(fullPath, title) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-ac', '2', '-c:a', 'flac',
      '-metadata', `title=${title}`,
      '-metadata', 'artist=Guard Test',
      '-metadata', 'album=Guard Album',
      fullPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`)));
  });
}

describe('JS fallback scanner — config parity + data-loss guard', () => {
  // Happy path: exercises the refactored single-pass walk (collectFiles
  // recursion into sub/), the per-file insert path, and — on rescan —
  // the mtime fast-path + cached sidecar probe. Gated on ffmpeg because
  // it needs real audio files; skips cleanly without it.
  test('indexes audio across the tree, then rescans as a fast-path no-op', { timeout: 60_000 }, async (t) => {
    if (!ffmpegOk) { return t.skip('bundled ffmpeg missing'); }

    const lib = path.join(workDir, 'real-lib');
    await fsp.mkdir(path.join(lib, 'sub'), { recursive: true });
    await makeFlac(path.join(lib, 'a.flac'), 'Track A');
    await makeFlac(path.join(lib, 'sub', 'b.flac'), 'Track B'); // nested → tests recursion
    const dbPath = path.join(workDir, 'real.db');
    const { libraryId } = initEmptyDb(dbPath, lib, 'reallib');

    const first = await runJsScanner(buildConfig({ dbPath, libraryId, directory: lib, scanId: 'real-1' }));
    assert.equal(first.code, 0, `first scan should exit 0; STDERR:\n${first.stderr}`);
    const evt1 = scanCompleteEvent(first.stdout);
    assert.ok(evt1, `expected a scanComplete event; STDOUT:\n${first.stdout}`);
    assert.equal(evt1.filesProcessed, 2, 'both files newly processed');
    assert.equal(trackCount(dbPath, libraryId), 2, 'both files indexed, including the nested one');

    // Rescan against the same DB: mtimes unchanged → every file takes the
    // fast path, nothing is reprocessed, and the tracks stay put.
    const second = await runJsScanner(buildConfig({ dbPath, libraryId, directory: lib, scanId: 'real-2' }));
    assert.equal(second.code, 0, `rescan should exit 0; STDERR:\n${second.stderr}`);
    const evt2 = scanCompleteEvent(second.stdout);
    assert.equal(evt2.filesProcessed, 0, 'rescan reprocesses nothing (mtime fast-path)');
    assert.equal(evt2.filesUnchanged, 2, 'rescan flags both files unchanged');
    assert.equal(trackCount(dbPath, libraryId), 2, 'both tracks still present after the rescan');
  });

  test('accessible but empty library: scan runs and sweeps stale tracks', { timeout: 30_000 }, async () => {
    const emptyDir = path.join(workDir, 'empty-lib');
    await fsp.mkdir(emptyDir, { recursive: true });
    const { dbPath, libraryId } = seedDbWithTrack('empty', emptyDir);

    const r = await runJsScanner(buildConfig({
      dbPath, libraryId, directory: emptyDir, scanId: 'scan-new',
    }));

    // Schema accepts the real (waveformCacheDir-bearing) config → exit 0.
    assert.ok(!/Invalid JSON Input/.test(r.stdout + r.stderr),
      `scanner rejected the task-queue-shaped config:\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.code, 0, `scanner should exit 0; got ${r.code}\nSTDERR:\n${r.stderr}`);
    // Directory is genuinely empty AND accessible → the orphan track is
    // correctly swept. This is the legitimate-empty case, NOT a vanished
    // mount, so cleanup is expected to proceed.
    assert.equal(trackCount(dbPath, libraryId), 0,
      'stale track should be removed when the library is accessibly empty');
  });

  test('inaccessible library directory: scan aborts without deleting tracks', { timeout: 30_000 }, async () => {
    const missingDir = path.join(workDir, 'does-not-exist', 'library');
    const { dbPath, libraryId } = seedDbWithTrack('missing', missingDir);

    const r = await runJsScanner(buildConfig({
      dbPath, libraryId, directory: missingDir, scanId: 'scan-new',
    }));

    // Guard aborts with a non-zero code and a clear accessibility error...
    assert.equal(r.code, 1, `scanner should exit 1 on a vanished mount; got ${r.code}`);
    assert.match(r.stderr, /not accessible/,
      `expected an accessibility error, got:\n${r.stderr}`);
    // ...and crucially leaves the existing track intact.
    assert.equal(trackCount(dbPath, libraryId), 1,
      'tracks must survive a scan against an inaccessible directory');
  });
});
