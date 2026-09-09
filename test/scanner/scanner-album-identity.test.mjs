/**
 * V70 album identity + aggregate refresh, end-to-end on BOTH scanners.
 *
 *   - per-track years never fragment an album; the row's year is the most
 *     common track year, year_min/year_max the range, track_count the size;
 *   - MUSICBRAINZ_ALBUMID wins identity over differing album names/years, and
 *     two different MBIDs under one name stay two albums;
 *   - compilation is an OR over the tracks' flags; the album-artist display
 *     string is the per-track majority;
 *   - a year re-tag updates the same row (no re-mint);
 *   - deleting a file marks its album dirty through the stale sweep, so the
 *     count drops on the next scan;
 *   - nothing is left agg_dirty after a scan.
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary is
 * unavailable.
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
import { makeAudio, makeCompilationMp3 } from '../helpers/scanner-fixture.mjs';

const MP3  = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const FLAC = ['-c:a', 'flac'];

let rustBin;
let scratch;

function available() { return !!rustBin && fs.existsSync(FFMPEG); }

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-albumid-'));
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

let sandboxSeq = 0;
async function makeSandbox(engine) {
  const root = path.join(scratch, `sb${sandboxSeq++}-${engine}`);
  const libRoot = path.join(root, 'lib');
  const artDir = path.join(root, 'art');
  const waveDir = path.join(root, 'wave');
  await fsp.mkdir(libRoot, { recursive: true });
  await fsp.mkdir(artDir, { recursive: true });
  const dbPath = path.join(root, 'test.db');
  const { libraryId, vpath } = initEmptyDb(dbPath, libRoot);
  let scanSeq = 0;
  const scan = (overrides = {}) => {
    const config = buildScanConfig({
      dbPath, libraryId, vpath, directory: libRoot,
      albumArtDirectory: artDir, waveformCacheDir: waveDir,
      scanId: `scan-${scanSeq++}`, overrides,
    });
    return engine === 'js' ? runJsScan(config) : runScan(rustBin, config);
  };
  return { root, libRoot, dbPath, scan };
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  try { return fn(db); } finally { db.close(); }
}

const albumsByName = (db, name) => db.prepare(`
  SELECT id, album_key, year, year_min, year_max, track_count, compilation, album_artist, agg_dirty,
         ROUND(duration_total, 3) AS duration_total
    FROM albums WHERE name = ? ORDER BY id`).all(name);

async function touchFuture(filepath, secondsAhead = 10) {
  const t = new Date(Date.now() + secondsAhead * 1000);
  await fsp.utimes(filepath, t, t);
}

for (const engine of ['rust', 'js']) {
  describe(`album identity [${engine}]`, () => {
    test('per-track years land on ONE album; year is the mode, range is min..max', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'DJ Retro', 'Decades');
      const tracks = [['Retro A', '1987'], ['Retro B', '1991'], ['Retro C', '1991']];
      for (let i = 0; i < tracks.length; i++) {
        await makeAudio(path.join(dir, `0${i + 1}.mp3`), MP3, {
          title: `D${i + 1}`, artist: tracks[i][0], album: 'Decades',
          album_artist: 'DJ Retro', date: tracks[i][1], track: `${i + 1}/3`,
        });
      }
      await sb.scan();
      withDb(sb.dbPath, db => {
        const rows = albumsByName(db, 'Decades');
        assert.equal(rows.length, 1, `one album row, got ${JSON.stringify(rows)}`);
        const a = rows[0];
        const djRetro = db.prepare("SELECT id FROM artists WHERE name = 'DJ Retro'").get().id;
        assert.equal(a.album_key, `name:Decades|${djRetro}`, 'keyed on exact name + album-artist id, no year');
        assert.equal(a.year, 1991, 'most common track year');
        assert.equal(a.year_min, 1987);
        assert.equal(a.year_max, 1991);
        assert.equal(a.track_count, 3);
        assert.equal(a.album_artist, 'DJ Retro', 'per-track ALBUMARTIST majority');
        assert.equal(a.compilation, 0);
        assert.equal(a.agg_dirty, 0);
        assert.ok(a.duration_total > 2.5, `summed duration ${a.duration_total}`);
        // Per-track consensus inputs were stamped by this engine.
        assert.deepEqual(
          db.prepare("SELECT tag_album, tag_album_artist, tag_compilation FROM tracks ORDER BY filepath").all()
            .map(r => ({ ...r })), // node:sqlite rows have a null prototype
          Array(3).fill({ tag_album: 'Decades', tag_album_artist: 'DJ Retro', tag_compilation: 0 }));
      });
    });

    test('MUSICBRAINZ_ALBUMID wins identity over differing names and years; distinct MBIDs stay apart', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Blue Band');
      const mbid = '11111111-2222-3333-4444-555555555555';
      await makeAudio(path.join(dir, 'A', '01.flac'), FLAC, {
        title: 'B1', artist: 'Blue Band', album: 'Blue Album', date: '1994', track: '1/2',
        MUSICBRAINZ_ALBUMID: mbid,
      });
      // Only track 2 carries the release-group id: the album row's
      // fill-NULL MBID update (cache-hit path) must pick it up.
      await makeAudio(path.join(dir, 'A', '02.flac'), FLAC, {
        title: 'B2', artist: 'Blue Band', album: 'Blue Album (Deluxe)', date: '2004', track: '2/2',
        MUSICBRAINZ_ALBUMID: mbid, MUSICBRAINZ_RELEASEGROUPID: 'aaaaaaaa-0000-4000-8000-000000000001',
      });
      // Same album name + artist, different MBID → a different release.
      await makeAudio(path.join(dir, 'B', '01.flac'), FLAC, {
        title: 'B1 remaster', artist: 'Blue Band', album: 'Blue Album', date: '2014', track: '1/1',
        MUSICBRAINZ_ALBUMID: '99999999-2222-3333-4444-555555555555',
      });
      await sb.scan();
      withDb(sb.dbPath, db => {
        const rows = db.prepare(`SELECT name, album_key, year, year_min, year_max, track_count, mbz_album_id,
                                        mbz_release_group_id
                                   FROM albums ORDER BY album_key`).all();
        assert.equal(rows.length, 2, `two albums, got ${JSON.stringify(rows)}`);
        const [blue, remaster] = rows;
        assert.equal(blue.album_key, `mbid:${mbid}`);
        assert.equal(blue.name, 'Blue Album', 'name = most common tracks.album_name, BINARY-smallest on the tie');
        assert.equal(blue.mbz_album_id, mbid);
        assert.equal(blue.mbz_release_group_id, 'aaaaaaaa-0000-4000-8000-000000000001',
          'release-group id filled from the second track');
        assert.equal(blue.track_count, 2);
        assert.equal(blue.year_min, 1994);
        assert.equal(blue.year_max, 2004);
        assert.equal(blue.year, 1994, 'tie → earliest');
        assert.equal(remaster.album_key, 'mbid:99999999-2222-3333-4444-555555555555');
        assert.equal(remaster.track_count, 1);
      });
    });

    test('compilation is an OR over the tracks; a year re-tag updates the same row', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Mix');
      const p1 = path.join(dir, '01.mp3');
      await makeAudio(p1, MP3, { title: 'M1', artist: 'X', album: 'Mix', album_artist: 'Host', date: '2001' });
      // One TCMP frame on one track only.
      await makeCompilationMp3(path.join(dir, '02.mp3'), { title: 'M2', artist: 'Y', album: 'Mix', album_artist: 'Host', date: '2001' });
      await sb.scan();
      const before = withDb(sb.dbPath, db => albumsByName(db, 'Mix'));
      assert.equal(before.length, 1);
      assert.equal(before[0].compilation, 1, 'one flagged track flags the album');
      assert.equal(before[0].album_artist, 'Host');
      assert.equal(before[0].year, 2001);

      await makeAudio(p1, MP3, { title: 'M1', artist: 'X', album: 'Mix', album_artist: 'Host', date: '1999' });
      await touchFuture(p1);
      await sb.scan();
      const after = withDb(sb.dbPath, db => albumsByName(db, 'Mix'));
      assert.equal(after.length, 1, 'no re-mint on a year re-tag');
      assert.equal(after[0].id, before[0].id, 'same row');
      assert.equal(after[0].year_min, 1999);
      assert.equal(after[0].year_max, 2001);
      assert.equal(after[0].year, 1999, '1999 and 2001 tie → earliest');
      assert.equal(after[0].track_count, 2);
      assert.equal(after[0].agg_dirty, 0);
    });

    test('removing the TCMP / ALBUMARTIST tags from every track clears the album; a track re-tagged to no album leaves the count', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Clear');
      const p1 = path.join(dir, '01.mp3');
      const p2 = path.join(dir, '02.mp3');
      await makeCompilationMp3(p1, { title: 'C1', artist: 'X', album: 'Clear', album_artist: 'Host' });
      await makeCompilationMp3(p2, { title: 'C2', artist: 'Y', album: 'Clear', album_artist: 'Host' });
      await sb.scan();
      const a = withDb(sb.dbPath, db => albumsByName(db, 'Clear'))[0];
      assert.equal(a.compilation, 1);
      assert.equal(a.album_artist, 'Host');
      assert.equal(a.track_count, 2);

      // Re-tag both without TCMP and without ALBUMARTIST → consensus clears.
      await makeAudio(p1, MP3, { title: 'C1', artist: 'X', album: 'Clear' });
      await makeAudio(p2, MP3, { title: 'C2', artist: 'Y', album: 'Clear' });
      await touchFuture(p1);
      await touchFuture(p2);
      await sb.scan();
      // Without ALBUMARTIST the album-artist fallback is the track artist,
      // so the two tracks now key onto two albums ('Clear' by X, by Y).
      const rows = withDb(sb.dbPath, db => albumsByName(db, 'Clear'));
      assert.equal(rows.length, 2, 'no ALBUMARTIST → per-track-artist albums (pre-existing fallback)');
      for (const r of rows) {
        assert.equal(r.compilation, 0, 'TCMP removed from every track → flag cleared');
        assert.equal(r.album_artist, null, 'ALBUMARTIST removed → display credit cleared');
        assert.equal(r.track_count, 1);
      }

      // Re-tag one track with NO album at all: its old album must drop to
      // zero tracks (the trigger flags it) and then be reaped as an orphan.
      await makeAudio(p1, MP3, { title: 'C1', artist: 'X' });
      await touchFuture(p1, 20);
      await sb.scan();
      withDb(sb.dbPath, db => {
        const left = albumsByName(db, 'Clear');
        assert.equal(left.length, 1, 'the emptied album was reaped');
        assert.equal(left[0].track_count, 1);
        assert.equal(db.prepare("SELECT album_id FROM tracks WHERE title = 'C1'").get().album_id, null);
      });
    });

    test('a deleted file dirties its album through the stale sweep; nothing stays dirty', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Trio');
      for (let i = 1; i <= 3; i++) {
        await makeAudio(path.join(dir, `0${i}.mp3`), MP3, { title: `T${i}`, artist: 'Trio', album: 'Trio', date: '2010' });
      }
      await sb.scan();
      assert.equal(withDb(sb.dbPath, db => albumsByName(db, 'Trio'))[0].track_count, 3);

      await fsp.unlink(path.join(dir, '03.mp3'));
      await sb.scan();
      withDb(sb.dbPath, db => {
        const a = albumsByName(db, 'Trio')[0];
        assert.equal(a.track_count, 2, 'sweep-deleted track left the count');
        assert.equal(a.agg_dirty, 0);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM albums WHERE agg_dirty = 1').get().c, 0,
          'the refresh clears every flag');
      });
    });
  });
}
