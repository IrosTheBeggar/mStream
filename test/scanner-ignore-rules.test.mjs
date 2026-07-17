/**
 * Scanner ignore rules — walk pruning + sweep convergence, both engines.
 *
 * Both scanners must (a) prune the hardcoded NAS-recycle/system directory
 * blocklist ($RECYCLE.BIN, #recycle, @Recycle, System Volume Information,
 * ...) unconditionally and case-insensitively, (b) skip dot-hidden files/
 * folders behind the default-true ignoreDotFiles/ignoreDotFolders flags —
 * where "dot-hidden" is a SINGLE leading dot, so '..WeirdAlbum' is an
 * ordinary album name that stays indexed — and (c) apply the SAME predicate
 * in the stale sweep, so rows indexed before the rules existed (or under
 * different flag settings) converge OUT of the index on the next scan even
 * though their files still exist on disk. Without (c), such rows would
 * survive forever as "still exists on disk" candidates.
 *
 * Skipped when the bundled ffmpeg is missing (fixture generation) or, for
 * the rust engine, when no rust-parser binary is available. A prebuilt
 * binary that predates the ignore rules is feature-detected and skipped
 * (same convention as the resume test in scanner-parity.test.mjs); the JS
 * scanner always runs from source.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findRustParser, FFMPEG, initEmptyDb, buildScanConfig, runScan, runJsScan,
} from './helpers/scanner-runner.mjs';
import { makeAudio } from './helpers/scanner-fixture.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

// Always indexed. '..WeirdAlbum' is the load-bearing one: a leading '..'
// is NOT a dot entry (albums really do start with ellipses).
const NORMAL_FILES = [
  '..WeirdAlbum/01 Weird.mp3',
  'Solo Artist/Echoes/01 One.mp3',
  'Solo Artist/Echoes/02 Two.mp3',
];
// Indexed only when the matching ignoreDot* flag is false.
const DOT_FILES = [
  '.hiddenalbum/01 Hid.mp3',              // dot FOLDER
  'Solo Artist/Echoes/.hidden.mp3',       // dot FILE beside normal files
];
// Never indexed: hardcoded blocklist, including a deeper-nested dir and a
// case variant (each under its own parent — Windows filesystems are
// case-insensitive, so '#recycle' and '#RECYCLE' as siblings would be ONE
// directory and the case check would test nothing).
const BLOCKLIST_FILES = [
  '#recycle/junk1.mp3',
  'CaseTest/#RECYCLE/case.mp3',
  'Nested Artist/@Recycle/junk2.mp3',
  'System Volume Information/svi.mp3',
];

let rustBin;
let workDir;
let libRoot;
let dbDir;
let artDir;
// null = probe not run; false = binary predates ignore rules (skip rust).
let rustHasIgnoreRules = null;

before(async () => {
  rustBin = findRustParser();
  if (!fs.existsSync(FFMPEG)) { return; } // every test skips

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-ignore-'));
  libRoot = path.join(workDir, 'library');
  dbDir   = path.join(workDir, 'db');
  artDir  = path.join(workDir, 'art');
  await fsp.mkdir(dbDir,  { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });

  let n = 0;
  for (const rel of [...NORMAL_FILES, ...DOT_FILES, ...BLOCKLIST_FILES]) {
    await makeAudio(path.join(libRoot, rel), MP3, {
      title:  `Ignore Fixture ${++n}`,
      artist: 'Ignore Artist',
      album:  'Ignore Album',
    });
  }

  // Feature-detect a stale prebuilt binary: a pre-ignore-rules build walks
  // straight into the blocklist dirs. Rust tests skip on it (CI machines
  // whose bin/rust-parser predates the rebuild); a locally built
  // target/release binary exercises the rules for real.
  if (rustBin) {
    const probe = await scanTracks('probe-rust', {}, cfg => runScan(rustBin, cfg));
    rustHasIgnoreRules = !probe.filepaths.includes('#recycle/junk1.mp3');
  }
});

after(async () => {
  if (workDir) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Both engines behind one interface; tests loop over the pair so every
// scenario runs against the Rust binary AND the JS fallback.
function engines() {
  return {
    rust: cfg => runScan(rustBin, cfg),
    js:   cfg => runJsScan(cfg),
  };
}

function skipReason(engine) {
  if (!fs.existsSync(FFMPEG)) { return 'no bundled ffmpeg'; }
  if (engine === 'rust' && !rustBin) { return 'no rust-parser binary'; }
  if (engine === 'rust' && rustHasIgnoreRules === false) {
    return 'rust-parser binary predates ignore rules — rebuild with `npm run build-rust`';
  }
  return null;
}

function trackRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id, filepath FROM tracks ORDER BY filepath').all();
  db.close();
  return rows;
}

// Fresh DB + one scan; returns the indexed filepaths (sorted, fwd slashes)
// plus everything needed for a follow-up rescan of the SAME DB.
async function scanTracks(label, overrides, runner) {
  const dbPath = path.join(dbDir, `mstream-${label}.db`);
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot, 'testlib');
  const result = await rescanTracks({ dbPath, libraryId, vpath }, `${label}-1`, overrides, runner);
  return { dbPath, libraryId, vpath, ...result };
}

async function rescanTracks(env, scanId, overrides, runner) {
  const cfg = buildScanConfig({
    dbPath: env.dbPath, libraryId: env.libraryId, vpath: env.vpath,
    directory: libRoot,
    albumArtDirectory: artDir,
    scanId,
    overrides,
  });
  const { event } = await runner(cfg);
  const rows = trackRows(env.dbPath);
  return { event, rows, filepaths: rows.map(r => r.filepath) };
}

describe('scanner ignore rules', () => {

  test('default flags: blocklist + dot entries pruned, ..-prefixed names indexed [rust+js]', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    for (const [engine, runner] of Object.entries(engines())) {
      const reason = skipReason(engine);
      if (reason) { t.diagnostic(`skipping ${engine}: ${reason}`); continue; }

      // No ignore fields in the config at all — the absent-field default
      // must be TRUE in both engines (serde default_true / `!== false`).
      const { filepaths, event } = await scanTracks(`default-${engine}`, {}, runner);
      assert.deepEqual(filepaths, NORMAL_FILES,
        `[${engine}] only normal files (incl. '..WeirdAlbum') may be indexed`);
      // Pruned at WALK time, not indexed-then-swept: the walk never even
      // counts the ignored files.
      assert.equal(event.filesScanned, NORMAL_FILES.length,
        `[${engine}] walk must not visit pruned entries`);
    }
  });

  test('ignoreDot* false: dot entries indexed, hardcoded blocklist still pruned [rust+js]', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    for (const [engine, runner] of Object.entries(engines())) {
      const reason = skipReason(engine);
      if (reason) { t.diagnostic(`skipping ${engine}: ${reason}`); continue; }

      const { filepaths } = await scanTracks(`flagsoff-${engine}`,
        { ignoreDotFiles: false, ignoreDotFolders: false }, runner);
      assert.deepEqual(filepaths, [...NORMAL_FILES, ...DOT_FILES].sort(),
        `[${engine}] flags off indexes dot entries but NEVER the blocklist dirs`);
    }
  });

  test('convergence: rows under ignored paths sweep out on rescan despite files existing [rust+js]', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    for (const [engine, runner] of Object.entries(engines())) {
      const reason = skipReason(engine);
      if (reason) { t.diagnostic(`skipping ${engine}: ${reason}`); continue; }

      // Scan 1 with both flags off gets the dot entries into the DB for
      // real; blocklist rows (which no walk ever indexes) are seeded by
      // direct INSERT, modelling rows indexed before the rules existed.
      // Every seeded path has a live file on disk — that's the point: the
      // sweep must doom them off the ignore predicate, not off absence.
      const env = await scanTracks(`converge-${engine}`,
        { ignoreDotFiles: false, ignoreDotFolders: false }, runner);
      assert.deepEqual(env.filepaths, [...NORMAL_FILES, ...DOT_FILES].sort());

      const db = new DatabaseSync(env.dbPath);
      const ins = db.prepare('INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)');
      for (const rel of BLOCKLIST_FILES) { ins.run(rel, env.libraryId, 'seeded'); }
      db.close();

      const normalIdsBefore = env.rows
        .filter(r => NORMAL_FILES.includes(r.filepath))
        .map(r => r.id);

      // Rescan with defaults: dot + blocklist rows are stale-swept even
      // though every file still exists; normal rows are untouched (same
      // ids — not deleted and re-created).
      const second = await rescanTracks(env, `converge-${engine}-2`, {}, runner);
      assert.deepEqual(second.filepaths, NORMAL_FILES,
        `[${engine}] previously-indexed ignored rows must converge out of the index`);
      assert.equal(second.event.staleEntriesRemoved,
        DOT_FILES.length + BLOCKLIST_FILES.length,
        `[${engine}] the sweep (not some other path) must remove the ignored rows`);
      const normalIdsAfter = second.rows
        .filter(r => NORMAL_FILES.includes(r.filepath))
        .map(r => r.id);
      assert.deepEqual(normalIdsAfter, normalIdsBefore,
        `[${engine}] normal rows must survive the sweep with their ids intact`);
    }
  });
});
