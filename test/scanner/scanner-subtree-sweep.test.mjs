/**
 * Subtree-scoped stale sweep — both engines.
 *
 * Subtree scans used to skip the stale sweep entirely (rows outside the
 * subtree are absent from the seen-set, so an unscoped sweep would have
 * treated the whole rest of the library as deleted). The sweep now runs
 * with its candidate snapshot SCOPED to the subtree prefix, restoring
 * "unseen means the walked area lost this file":
 *
 *   - deletions INSIDE the subtree converge out on the subtree scan
 *     (with move re-homing — the pairing target map is whole-library,
 *     so a twin elsewhere adopts the references);
 *   - rows OUTSIDE the subtree are never candidates, even when their
 *     files are gone (pinned here AND in scanner-move-rehome);
 *   - the prefix respects path-segment boundaries ('sub' must not
 *     capture 'subX/…');
 *   - sweeping the last track of an album reaps the album/artist rows
 *     right away (orphan cleanup now runs after subtree deletes);
 *   - a DELETED subtree directory converges its rows (that is what a
 *     removed folder looks like), while an UNREADABLE one records a
 *     failed-walk prefix that shields them — outage ≠ deletion.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary
 * is unavailable; a prebuilt binary predating the scoped sweep is
 * feature-detected and skipped for the rust engine.
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
} from '../helpers/scanner-runner.mjs';
import { makeAudio } from '../helpers/scanner-fixture.mjs';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

let rustBin;
let scratch;
// null = probe not run; false = binary predates the scoped sweep.
let rustHasScopedSweep = null;

before(async () => {
  rustBin = findRustParser();
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-subsweep-'));

  // Feature-detect a stale prebuilt binary: scan a subtree after
  // deleting its only file — a pre-scoped-sweep build reports
  // staleEntriesRemoved 0 with the row left behind.
  if (rustBin && fs.existsSync(FFMPEG)) {
    const root = path.join(scratch, 'probe');
    const libRoot = path.join(root, 'lib');
    await makeAudio(path.join(libRoot, 'probe', 'p.mp3'), MP3, { title: 'P' }, 1);
    const dbPath = path.join(root, 'probe.db');
    const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
    const cfg = (scanId, overrides = {}) => buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: path.join(root, 'art'),
      waveformCacheDir: path.join(root, 'wave'),
      scanId, overrides,
    });
    await fsp.mkdir(path.join(root, 'art'), { recursive: true });
    await runScan(rustBin, cfg('probe-1'));
    await fsp.rm(path.join(libRoot, 'probe', 'p.mp3'));
    const { event } = await runScan(rustBin, cfg('probe-2', { subtree: 'probe' }));
    rustHasScopedSweep = event.staleEntriesRemoved === 1;
  }
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

let sandboxSeq = 0;
async function makeSandbox(engine) {
  const root = path.join(scratch, `sb${sandboxSeq++}-${engine}`);
  const libRoot = path.join(root, 'lib');
  const artDir = path.join(root, 'art');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let scanSeq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: artDir, waveformCacheDir: path.join(root, 'wave'),
      scanId: `scan-${scanSeq++}`, overrides,
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  return { root, libRoot, dbPath, libraryId, vpath, scan };
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
}
const trackPaths = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath FROM tracks ORDER BY filepath').all().map(r => r.filepath));
const albumNames = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT name FROM albums ORDER BY name').all().map(r => r.name));
const seedPlaylist = (dbPath, vpath, rel) => withDb(dbPath, db => {
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
              VALUES (1, 'mover', 'x', 'x')`).run();
  db.prepare(`INSERT OR IGNORE INTO playlists (id, name, user_id) VALUES (1, 'pl', 1)`).run();
  const pos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks').get().p;
  db.prepare(`INSERT INTO playlist_tracks (playlist_id, filepath, position)
              VALUES (1, ?, ?)`).run(`${vpath}/${rel}`, pos);
});
const playlistPaths = (dbPath) => withDb(dbPath, db =>
  db.prepare('SELECT filepath FROM playlist_tracks ORDER BY id').all().map(r => r.filepath));

for (const engine of ['rust', 'js']) {
  const engineAvailable = () =>
    fs.existsSync(FFMPEG) && (engine === 'js' || (!!rustBin && rustHasScopedSweep !== false));

  describe(`subtree-scoped sweep (${engine} scanner)`, () => {
    test('deletion inside the subtree converges on a subtree scan', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'keep.mp3'), MP3, { title: 'Keep' }, 1);
      await makeAudio(path.join(sb.libRoot, 'tor', 'a.mp3'), MP3, { title: 'A' }, 2);
      await makeAudio(path.join(sb.libRoot, 'tor', 'b.mp3'), MP3, { title: 'B' }, 3);
      await sb.scan();

      await fsp.rm(path.join(sb.libRoot, 'tor', 'a.mp3'));
      const { event } = await sb.scan({ subtree: 'tor' });

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['keep.mp3', 'tor/b.mp3']);
    });

    test('prefix respects segment boundaries: subtree "sub" never touches "subX/"', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'sub', 'in.mp3'), MP3, { title: 'In' }, 1);
      await makeAudio(path.join(sb.libRoot, 'subX', 'near.mp3'), MP3, { title: 'Near' }, 2);
      await sb.scan();

      // Both files deleted; only the true-subtree row may sweep.
      await fsp.rm(path.join(sb.libRoot, 'sub', 'in.mp3'));
      await fsp.rm(path.join(sb.libRoot, 'subX', 'near.mp3'));
      const { event } = await sb.scan({ subtree: 'sub' });

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['subX/near.mp3'],
        'subX/ must survive a scan of subtree "sub"');
    });

    test('move re-homing works inside a subtree scan (twin outside adopts refs)', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'outside.mp3'), MP3, { title: 'Twin' }, 4);
      await fsp.mkdir(path.join(sb.libRoot, 'tor'), { recursive: true });
      await fsp.copyFile(path.join(sb.libRoot, 'outside.mp3'),
        path.join(sb.libRoot, 'tor', 'inside.mp3'));
      await sb.scan();
      seedPlaylist(sb.dbPath, sb.vpath, 'tor/inside.mp3');

      await fsp.rm(path.join(sb.libRoot, 'tor', 'inside.mp3'));
      const { event } = await sb.scan({ subtree: 'tor' });

      assert.strictEqual(event.staleEntriesRemoved, 1);
      assert.strictEqual(event.movedTracksRehomed, 1);
      assert.deepStrictEqual(playlistPaths(sb.dbPath), [`${sb.vpath}/outside.mp3`],
        'the whole-library pairing map re-points refs across the subtree boundary');
    });

    test('sweeping the last track of an album reaps the album immediately', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'other', 'stay.mp3'), MP3,
        { artist: 'Stay', album: 'StayAlbum', title: 'Stay' }, 1);
      await makeAudio(path.join(sb.libRoot, 'gone', 'last.mp3'), MP3,
        { artist: 'Gone', album: 'GoneAlbum', title: 'Last' }, 2);
      await sb.scan();
      assert.deepStrictEqual(albumNames(sb.dbPath), ['GoneAlbum', 'StayAlbum']);

      await fsp.rm(path.join(sb.libRoot, 'gone', 'last.mp3'));
      await sb.scan({ subtree: 'gone' });

      assert.deepStrictEqual(albumNames(sb.dbPath), ['StayAlbum'],
        'the orphaned album must reap on the subtree scan, not the next full scan');
    });

    test('a deleted subtree directory converges its rows', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'keep.mp3'), MP3, { title: 'Keep' }, 1);
      await makeAudio(path.join(sb.libRoot, 'doomed', 'x.mp3'), MP3, { title: 'X' }, 2);
      await makeAudio(path.join(sb.libRoot, 'doomed', 'y.mp3'), MP3, { title: 'Y' }, 3);
      await sb.scan();

      await fsp.rm(path.join(sb.libRoot, 'doomed'), { recursive: true });
      const { event } = await sb.scan({ subtree: 'doomed' });

      assert.strictEqual(event.staleEntriesRemoved, 2,
        'a removed folder is a real deletion — its rows converge');
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['keep.mp3']);
    });

    test('a delete-less subtree scan reports zero and touches nothing', async (t) => {
      if (!engineAvailable()) { t.skip('ffmpeg/rust binary unavailable or stale'); return; }
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'tor', 'a.mp3'), MP3, { title: 'A' }, 1);
      await sb.scan();

      const { event } = await sb.scan({ subtree: 'tor' });
      assert.strictEqual(event.staleEntriesRemoved, 0);
      assert.strictEqual(event.movedTracksRehomed, 0);
      assert.deepStrictEqual(trackPaths(sb.dbPath), ['tor/a.mp3']);
    });
  });
}
