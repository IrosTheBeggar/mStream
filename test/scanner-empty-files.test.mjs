/**
 * Zero-byte files are not tracks — in BOTH scanners.
 *
 * A supported extension used to be enough to index a file; an empty one then
 * became a row with no title, artist, album or duration that could never
 * play (a torrent placeholder, a copy that never finished, a truncated file).
 * Now the walk refuses zero-byte entries with one summary line per scan, and
 * the stale sweep applies the same size rule to rows whose files still exist,
 * so rows indexed before the rule — or files emptied since — converge out of
 * the index exactly the way unsupported extensions and ignored dot entries do.
 *
 * Same both-engine shape as scanner-ignore-rules.test.mjs: every scenario
 * runs against the Rust binary AND the JS fallback, each on its own database.
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

// Real audio, always indexed.
const NORMAL_FILES = [
  'Solo Artist/Echoes/01 One.mp3',
  'Solo Artist/Echoes/02 Two.mp3',
];
// Zero bytes each, in two formats, one beside real tracks and one alone in
// its folder (so an album that is ONLY placeholders never appears either).
const EMPTY_FILES = [
  'Solo Artist/Echoes/03 Placeholder.mp3',
  'Unfinished Album/01 Nothing.flac',
];

let rustBin;
let workDir;
let libRoot;
let dbDir;
let artDir;
// null = probe not run; false = binary predates the size rule (skip rust).
let rustHasSizeRule = null;

before(async () => {
  rustBin = findRustParser();
  if (!fs.existsSync(FFMPEG)) { return; } // every test skips

  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-empty-'));
  libRoot = path.join(workDir, 'library');
  dbDir   = path.join(workDir, 'db');
  artDir  = path.join(workDir, 'art');
  await fsp.mkdir(dbDir,  { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });

  let n = 0;
  for (const rel of NORMAL_FILES) {
    await makeAudio(path.join(libRoot, rel), MP3, {
      title:  `Empty Fixture ${++n}`,
      artist: 'Empty Artist',
      album:  'Echoes',
    });
  }
  for (const rel of EMPTY_FILES) {
    await fsp.mkdir(path.dirname(path.join(libRoot, rel)), { recursive: true });
    await fsp.writeFile(path.join(libRoot, rel), '');
  }

  // Feature-detect a stale prebuilt binary: a pre-rule build indexes the
  // placeholders. Rust tests skip on it (CI machines whose bin/rust-parser
  // predates the rebuild); a locally built target/release binary exercises
  // the rule for real.
  if (rustBin) {
    const probe = await scanTracks('probe-rust', {}, cfg => runScan(rustBin, cfg));
    rustHasSizeRule = !probe.filepaths.includes(EMPTY_FILES[0]);
  }
});

after(async () => {
  if (workDir) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

function engines() {
  return {
    rust: cfg => runScan(rustBin, cfg),
    js:   cfg => runJsScan(cfg),
  };
}

function skipReason(engine) {
  if (!fs.existsSync(FFMPEG)) { return 'no bundled ffmpeg'; }
  if (engine === 'rust' && !rustBin) { return 'no rust-parser binary'; }
  if (engine === 'rust' && rustHasSizeRule === false) {
    return 'rust-parser binary predates the zero-byte rule — rebuild with `npm run build-rust`';
  }
  return null;
}

function trackRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id, filepath FROM tracks ORDER BY filepath').all();
  db.close();
  return rows;
}

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
  const { event, stderr } = await runner(cfg);
  const rows = trackRows(env.dbPath);
  return { event, stderr, rows, filepaths: rows.map(r => r.filepath) };
}

const summaryLines = (stderr) => stderr.split('\n').filter(l => /skipped \d+ empty file\(s\)/.test(l));

describe('scanner: zero-byte files are not tracks', () => {

  test('empty files are skipped with one summary line; the rest of the library indexes [rust+js]', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    for (const [engine, runner] of Object.entries(engines())) {
      const reason = skipReason(engine);
      if (reason) { t.diagnostic(`skipping ${engine}: ${reason}`); continue; }

      const env = await scanTracks(`skip-${engine}`, {}, runner);
      assert.deepEqual(env.filepaths, [...NORMAL_FILES].sort(),
        `[${engine}] only the real files are tracks`);
      // The placeholders never enter the walk's file list, so they are not
      // "scanned" either — the progress denominator and the summary agree.
      assert.equal(env.event.filesScanned, NORMAL_FILES.length,
        `[${engine}] filesScanned counts the eligible files only`);
      assert.equal(env.event.staleEntriesRemoved, 0);
      const lines = summaryLines(env.stderr);
      assert.equal(lines.length, 1, `[${engine}] exactly one summary line, got: ${JSON.stringify(lines)}`);
      assert.match(lines[0], /skipped 2 empty file\(s\) \(0 bytes\)/, `[${engine}] the count is per scan`);
      // No album row for the folder that holds nothing but a placeholder.
      const db = new DatabaseSync(env.dbPath);
      const albums = db.prepare('SELECT name FROM albums ORDER BY name').all().map(r => r.name);
      db.close();
      assert.deepEqual(albums, ['Echoes'], `[${engine}] a placeholder-only folder is not an album`);
    }
  });

  test('convergence: a row whose file is empty now sweeps out on rescan, and re-indexes once the file is real again [rust+js]', async (t) => {
    if (!fs.existsSync(FFMPEG)) { return t.skip('no bundled ffmpeg'); }
    for (const [engine, runner] of Object.entries(engines())) {
      const reason = skipReason(engine);
      if (reason) { t.diagnostic(`skipping ${engine}: ${reason}`); continue; }

      const env = await scanTracks(`converge-${engine}`, {}, runner);
      assert.deepEqual(env.filepaths, [...NORMAL_FILES].sort());
      const [keep, truncated] = NORMAL_FILES;
      const keepIdBefore = env.rows.find(r => r.filepath === keep).id;

      // Two ways a row can point at an empty file: (a) an indexed track is
      // truncated to nothing (a copy that never finished), (b) a row that
      // predates the rule, seeded by direct INSERT for a placeholder that
      // still exists on disk. Both files are present — the sweep must doom
      // them off the size rule, not off absence.
      await fsp.truncate(path.join(libRoot, truncated), 0);
      const db = new DatabaseSync(env.dbPath);
      db.prepare('INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)')
        .run(EMPTY_FILES[0], env.libraryId, 'seeded before the rule');
      db.close();

      const second = await rescanTracks(env, `converge-${engine}-2`, {}, runner);
      assert.deepEqual(second.filepaths, [keep],
        `[${engine}] the truncated track and the pre-rule row both converge out`);
      assert.equal(second.event.staleEntriesRemoved, 2,
        `[${engine}] the sweep (not some other path) removes both rows`);
      assert.equal(second.rows[0].id, keepIdBefore,
        `[${engine}] the surviving row keeps its id`);
      assert.match(summaryLines(second.stderr)[0] || '', /skipped 3 empty file\(s\)/,
        `[${engine}] the truncated file joins the summary count`);

      // The file becomes real again: it re-indexes on the next scan, so the
      // rule is lossless for anything that turns back into audio.
      await makeAudio(path.join(libRoot, truncated), MP3, {
        title: 'Empty Fixture 2 (restored)', artist: 'Empty Artist', album: 'Echoes',
      });
      const third = await rescanTracks(env, `converge-${engine}-3`, {}, runner);
      assert.deepEqual(third.filepaths, [...NORMAL_FILES].sort(),
        `[${engine}] a restored file re-indexes`);
    }
  });
});
