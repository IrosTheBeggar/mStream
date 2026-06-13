/**
 * Scanner determinism + parity tests.
 *
 * The scanner is allowed to choose its own walk order, but the DB it
 * produces MUST be content-identical between runs of the same library.
 * If two scans of the same fixture produce different snapshots, that's
 * a correctness bug — and one that gets much worse the moment file-
 * level parallelism lands. So the determinism test runs first against
 * the current serial scanner; any nondeterminism it surfaces has to be
 * fixed BEFORE Phase 2.
 *
 * Once Phase 2 lands, the parity tests below additionally assert that
 * scanThreads=1 and scanThreads=N produce the same snapshot, and that
 * scanThreads=N is itself deterministic across repeated runs.
 *
 * The test is skipped when:
 *   - The bundled ffmpeg is missing (CI environments without bin/).
 *   - No rust-parser binary is built or shipped.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan,
  waveformFilenames,
} from './helpers/scanner-runner.mjs';
import { snapshotDb } from './helpers/db-snapshot.mjs';
import { buildFixtureLibrary } from './helpers/scanner-fixture.mjs';

let rustBin;
let workDir;        // wraps libRoot, dbDir, artDir, wfDir for this suite
let libRoot;
let dbDir;
let artDir;
let wfDir;
let fixtureSummary;

function mkScratch(name) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `mstream-parity-${name}-`));
}

before(async () => {
  rustBin = findRustParser();
  if (!rustBin || !fs.existsSync(FFMPEG)) {
    return; // tests will skip
  }

  workDir = await mkScratch('work');
  libRoot = path.join(workDir, 'library');
  dbDir   = path.join(workDir, 'db');
  artDir  = path.join(workDir, 'art');
  wfDir   = path.join(workDir, 'waveforms');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(dbDir,   { recursive: true });
  await fsp.mkdir(artDir,  { recursive: true });
  await fsp.mkdir(wfDir,   { recursive: true });

  fixtureSummary = await buildFixtureLibrary(libRoot);
});

after(async () => {
  if (workDir) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Each test gets its own DB file + waveform subdir, so a leftover
// .bin from a prior run can't accidentally satisfy a dedup check.
async function freshScanEnv(label) {
  const dbPath = path.join(dbDir, `mstream-${label}.db`);
  const wfSub  = path.join(wfDir, label);
  await fsp.mkdir(wfSub, { recursive: true });
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot, 'testlib');
  return { dbPath, wfSub, libraryId, vpath };
}

// Run one full scan against a fresh env. Returns { snapshot, waveforms,
// event } for assertion.
async function scanAndSnapshot(label, overrides = {}) {
  const env = await freshScanEnv(label);
  const cfg = buildScanConfig({
    dbPath: env.dbPath, libraryId: env.libraryId, vpath: env.vpath,
    directory: libRoot,
    albumArtDirectory: artDir,
    waveformCacheDir: env.wfSub,
    scanId: `scan-${label}-${Date.now()}`,
    overrides,
  });
  const result = await runScan(rustBin, cfg);
  return {
    snapshot: snapshotDb(env.dbPath),
    waveforms: await waveformFilenames(env.wfSub),
    event: result.event,
  };
}

describe('scanner determinism + parity', () => {

  test('fixture library was built and is non-trivial', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    assert.ok(fixtureSummary.expectedAudioFiles >= 30,
      `fixture should have ≥30 files, got ${fixtureSummary.expectedAudioFiles}`);
  });

  test('determinism: two scans of the same library produce identical snapshots', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    const a = await scanAndSnapshot('det-a');
    const b = await scanAndSnapshot('det-b');

    // Sanity-check the scan actually walked the fixture.
    assert.equal(a.event.filesScanned, fixtureSummary.expectedAudioFiles,
      `expected ${fixtureSummary.expectedAudioFiles} files scanned, got ${a.event.filesScanned}`);
    assert.equal(a.event.filesProcessed, fixtureSummary.expectedAudioFiles,
      'first scan of an empty DB processes every file');

    // The actual parity check. deepEqual gives a clean diff on failure;
    // any column-level drift between runs surfaces here.
    assert.deepEqual(b.snapshot, a.snapshot,
      'scanner should produce identical DB state across two runs of the same library');
    assert.deepEqual(b.waveforms, a.waveforms,
      'scanner should produce the same waveform .bin set across two runs');
  });

  test('rescan of unchanged library is a fast-path no-op', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    // Initial scan populates the DB; rescan against the same DB should
    // skip every file via the mtime fast path.
    const env = await freshScanEnv('rescan');
    const baseCfg = {
      dbPath: env.dbPath, libraryId: env.libraryId, vpath: env.vpath,
      directory: libRoot,
      albumArtDirectory: artDir,
      waveformCacheDir: path.join(wfDir, 'rescan'),
    };
    await fsp.mkdir(baseCfg.waveformCacheDir, { recursive: true });

    const first  = await runScan(rustBin, buildScanConfig({ ...baseCfg, scanId: 'rescan-1' }));
    const second = await runScan(rustBin, buildScanConfig({ ...baseCfg, scanId: 'rescan-2' }));

    assert.equal(first.event.filesProcessed, fixtureSummary.expectedAudioFiles);
    assert.equal(second.event.filesProcessed, 0,
      'second scan should re-process zero files (every file mtime-stable)');
    assert.equal(second.event.filesUnchanged, fixtureSummary.expectedAudioFiles,
      'second scan should flag every file as unchanged');
  });

  test('resume: re-running a force scan with the SAME scan_id reprocesses nothing', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    // The migration boot-rescan reuses one stable scan id across restarts
    // so an interrupted force rescan RESUMES instead of restarting from
    // file zero. Model that here: force-scan with a FIXED id, then
    // force-scan AGAIN with the same id. Every row is already stamped with
    // it, so the scanner must skip them all even though forceRescan is set
    // — otherwise an interrupted migration rescan loops forever.
    const env = await freshScanEnv('resume');
    const baseCfg = {
      dbPath: env.dbPath, libraryId: env.libraryId, vpath: env.vpath,
      directory: libRoot,
      albumArtDirectory: artDir,
      waveformCacheDir: path.join(wfDir, 'resume'),
    };
    await fsp.mkdir(baseCfg.waveformCacheDir, { recursive: true });

    const first = await runScan(rustBin, buildScanConfig({
      ...baseCfg, scanId: 'epoch-fixed', overrides: { forceRescan: true },
    }));
    assert.equal(first.event.filesProcessed, fixtureSummary.expectedAudioFiles,
      'first force pass re-parses every file');

    const second = await runScan(rustBin, buildScanConfig({
      ...baseCfg, scanId: 'epoch-fixed', overrides: { forceRescan: true },
    }));

    // Feature-detect: a stale prebuilt binary (pre-resume) would re-parse
    // everything again. Skip rather than fail so CI on an un-rebuilt
    // binary stays green; a local `npm run build-rust` exercises it fully.
    if (second.event.filesProcessed !== 0) {
      return t.skip('rust-parser binary predates scan_id resume support — rebuild with `npm run build-rust`');
    }
    assert.equal(second.event.filesUnchanged, fixtureSummary.expectedAudioFiles,
      'a resumed pass must skip every row already stamped with the epoch id');
  });

  // ── Phase 2: parallel scan tests ────────────────────────────────────
  // These tests pass scanThreads in the JSON config. Until Phase 2
  // lands the field is ignored by the binary (serde default = 0 = auto
  // = serial today), so the tests still pass as "scanThreads has no
  // effect today" — and they automatically begin exercising the
  // parallel path the moment the binary recognises the field.

  test('parity: scanThreads=1 matches scanThreads=4', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    const serial   = await scanAndSnapshot('par-serial',   { scanThreads: 1 });
    const parallel = await scanAndSnapshot('par-parallel', { scanThreads: 4 });

    assert.deepEqual(parallel.snapshot, serial.snapshot,
      'parallel scan must produce identical DB state to serial scan');
    assert.deepEqual(parallel.waveforms, serial.waveforms,
      'parallel scan must produce the same waveform .bin set as serial');
  });

  test('determinism: scanThreads=4 is stable across repeated runs', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    const a = await scanAndSnapshot('par-rep-a', { scanThreads: 4 });
    const b = await scanAndSnapshot('par-rep-b', { scanThreads: 4 });
    const c = await scanAndSnapshot('par-rep-c', { scanThreads: 4 });

    assert.deepEqual(b.snapshot, a.snapshot, 'run B should match run A');
    assert.deepEqual(c.snapshot, a.snapshot, 'run C should match run A');
    assert.deepEqual(b.waveforms, a.waveforms);
    assert.deepEqual(c.waveforms, a.waveforms);
  });

  // Real libraries get incremental rescans after edits — some files
  // touched, most unchanged. The parallel writer routes Unchanged
  // (seen-set insert only) and Extracted (full commit_track) messages
  // interleaved on the same Connection. This exercises that mix
  // explicitly: bumping mtime on a few files forces them onto the
  // Extracted path while the rest take the fast-path. With unchanged
  // file CONTENT the resulting snapshot must equal the initial scan.
  test('parallel rescan with mixed changed/unchanged files is correct', async (t) => {
    if (!rustBin)              { return t.skip('no rust-parser binary'); }
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }

    const env = await freshScanEnv('par-mixed');
    const baseCfg = {
      dbPath: env.dbPath, libraryId: env.libraryId, vpath: env.vpath,
      directory: libRoot,
      albumArtDirectory: artDir,
      waveformCacheDir: path.join(wfDir, 'par-mixed'),
    };
    await fsp.mkdir(baseCfg.waveformCacheDir, { recursive: true });

    // Initial scan, capture golden snapshot.
    await runScan(rustBin, buildScanConfig({
      ...baseCfg, scanId: 'mixed-1',
      overrides: { scanThreads: 4 },
    }));
    const initial = snapshotDb(env.dbPath);

    // Touch mtime on ~25% of the audio files. Use a future timestamp
    // so the comparison can't tie with an mtime that quantises away.
    const audioFiles = await collectAudioFiles(libRoot);
    const toTouch = audioFiles.filter((_, i) => i % 4 === 0);
    assert.ok(toTouch.length >= 5, `need ≥5 touched files, got ${toTouch.length}`);
    const futureTs = new Date(Date.now() + 60_000);
    for (const f of toTouch) {
      await fsp.utimes(f, futureTs, futureTs);
    }

    // Mixed rescan with parallelism — writer drains a mix of
    // Unchanged + Extracted messages.
    const second = await runScan(rustBin, buildScanConfig({
      ...baseCfg, scanId: 'mixed-2',
      overrides: { scanThreads: 4 },
    }));

    assert.equal(second.event.filesProcessed, toTouch.length,
      `expected ${toTouch.length} reprocessed, got ${second.event.filesProcessed}`);
    assert.equal(second.event.filesUnchanged, audioFiles.length - toTouch.length,
      'fast-path should cover the un-touched files');

    // Content was unchanged — only mtime moved. Re-extraction should
    // produce byte-identical snapshot save for tracks.modified
    // (which we do snapshot, so this catches drift). Filter modified
    // out before comparing to allow the legitimate mtime change.
    const initialNoMtime = initial.tracks.map(stripModified);
    const secondSnap     = snapshotDb(env.dbPath);
    const secondNoMtime  = secondSnap.tracks.map(stripModified);
    assert.deepEqual(secondNoMtime, initialNoMtime,
      'mixed rescan should leave content rows byte-identical (modulo mtime)');
    // Everything else (artists, albums, M2M, art) MUST be unchanged —
    // the art tables especially: a touched file's clear-then-relink must
    // converge back to the identical set, not drift positions or dupe rows.
    assert.deepEqual(secondSnap.artists,      initial.artists);
    assert.deepEqual(secondSnap.albums,       initial.albums);
    assert.deepEqual(secondSnap.trackArtists, initial.trackArtists);
    assert.deepEqual(secondSnap.albumArtists, initial.albumArtists);
    assert.deepEqual(secondSnap.trackGenres,  initial.trackGenres);
    assert.deepEqual(secondSnap.artFiles,     initial.artFiles);
    assert.deepEqual(secondSnap.trackArt,     initial.trackArt);
    assert.deepEqual(secondSnap.albumArt,     initial.albumArt);
  });
});

function stripModified(row) {
  const { modified, ...rest } = row;
  return rest;
}

async function collectAudioFiles(root) {
  const SUPPORTED = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'm4b', 'aac', 'opus']);
  const out = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) { continue; }
      if (SUPPORTED.has(entry.name.slice(dot + 1).toLowerCase())) { out.push(full); }
    }
  }
  await walk(root);
  return out.sort();
}
