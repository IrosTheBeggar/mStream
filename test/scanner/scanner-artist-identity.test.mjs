/**
 * V71 artist identity + aggregate refresh, end-to-end on BOTH scanners.
 *
 *   - case / quote-style spellings of one artist land on ONE row, and its
 *     display name is the majority spelling regardless of walk order;
 *   - a spelling variant no longer fragments an album keyed on that artist;
 *   - ARTISTSORT and MUSICBRAINZ_ARTISTID fill sort_name / mbz_artist_id when
 *     they can be attributed to exactly one artist; order_name follows the
 *     sort tag, else the name with a leading article dropped;
 *   - counts are maintained through deletes; nothing is left agg_dirty.
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
import { makeAudio } from '../helpers/scanner-fixture.mjs';

const MP3  = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const FLAC = ['-c:a', 'flac'];

let rustBin;
let scratch;

function available() { return !!rustBin && fs.existsSync(FFMPEG); }

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-artistid-'));
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

const artistByKey = (db, key) => db.prepare(`
  SELECT id, name, name_key, sort_name, mbz_artist_id, order_name, track_count, album_count, agg_dirty
    FROM artists WHERE name_key = ?`).get(key);

for (const engine of ['rust', 'js']) {
  describe(`artist identity [${engine}]`, () => {
    test('spelling variants share one row named by the majority; the album keyed on them stays whole', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Mix');
      const spellings = ['Solo Artist', 'Solo Artist', 'Solo Artist', 'solo artist', 'SOLO ARTIST'];
      for (let i = 0; i < spellings.length; i++) {
        await makeAudio(path.join(dir, `0${i + 1}.mp3`), MP3, {
          title: `M${i + 1}`, artist: spellings[i], album: 'Mix', date: '2001', track: `${i + 1}/5`,
        });
      }
      // Quote styles: two straight, one curly.
      const g = path.join(sb.libRoot, 'GNR');
      await makeAudio(path.join(g, '01.mp3'), MP3, { title: 'G1', artist: "Guns N' Roses", album: 'Lies' });
      await makeAudio(path.join(g, '02.mp3'), MP3, { title: 'G2', artist: "Guns N' Roses", album: 'Lies' });
      await makeAudio(path.join(g, '03.mp3'), MP3, { title: 'G3', artist: 'Guns N’ Roses', album: 'Lies' });
      // Both quote styles inside ONE multi-artist tag: one credit, not a
      // main + featured pair for the same artist id.
      await makeAudio(path.join(g, '04.mp3'), MP3, { title: 'G4', artist: "Guns N' Roses / Guns N’ Roses", album: 'Lies' });
      // A compilation whose ALBUMARTIST spells the sentinel in lower case:
      // its (single) album credit must not rename the seeded row.
      const c = path.join(sb.libRoot, 'Comp');
      await makeAudio(path.join(c, '01.mp3'), MP3, { title: 'C1', artist: 'Alpha', album_artist: 'various artists', album: 'Comp' });
      await makeAudio(path.join(c, '02.mp3'), MP3, { title: 'C2', artist: 'Beta', album_artist: 'various artists', album: 'Comp' });
      await sb.scan();
      withDb(sb.dbPath, db => {
        const names = db.prepare('SELECT name FROM artists ORDER BY name').all().map(r => r.name);
        assert.deepEqual(names, ['Alpha', 'Beta', "Guns N' Roses", 'Solo Artist', 'Various Artists'],
          'one row per artist, majority spellings; the VA seed keeps its canonical name');
        assert.deepEqual(
          db.prepare(`SELECT aa.tag_name FROM album_artists aa JOIN albums al ON al.id = aa.album_id
                       WHERE al.name = 'Comp'`).all().map(r => r.tag_name),
          ['various artists'], 'the album credit still records the tagged spelling');
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
                                  WHERE t.title = 'G4'`).get().c, 1,
          'quote variants inside one ARTIST tag collapse to one credit');
        const solo = artistByKey(db, 'solo artist');
        assert.equal(solo.track_count, 5);
        assert.equal(solo.album_count, 1);
        assert.equal(solo.agg_dirty, 0);
        assert.equal(solo.order_name, 'solo artist');
        // No ALBUMARTIST → the album keys on the primary track artist id;
        // since every spelling is the same id, 'Mix' is ONE album.
        assert.equal(db.prepare("SELECT COUNT(*) c FROM albums WHERE name = 'Mix'").get().c, 1);
        assert.equal(db.prepare("SELECT track_count FROM albums WHERE name = 'Mix'").get().track_count, 5);
        // The credits keep their raw spellings — those are the votes.
        assert.deepEqual(
          db.prepare(`SELECT tag_name, COUNT(*) AS n FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                       WHERE a.name_key = 'solo artist' GROUP BY tag_name ORDER BY n DESC, tag_name`).all()
            .map(r => ({ ...r })),
          [{ tag_name: 'Solo Artist', n: 3 }, { tag_name: 'SOLO ARTIST', n: 1 }, { tag_name: 'solo artist', n: 1 }]);
        const gnr = artistByKey(db, "guns n' roses");
        assert.equal(gnr.name, "Guns N' Roses", 'straight apostrophe outvotes the curly one 3:1');
        assert.equal(gnr.track_count, 4);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM artists WHERE agg_dirty = 1').get().c, 0);
      });
    });

    test('ARTISTSORT / MUSICBRAINZ_ARTISTID fill when attributable; order_name drops a leading article', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Tagged');
      await makeAudio(path.join(dir, '01.flac'), FLAC, {
        title: 'T1', artist: 'Solo Artist', album: 'Tagged', ARTISTSORT: 'Artist, Solo',
        MUSICBRAINZ_ARTISTID: '0a0a0a0a-1111-4222-8333-444444444444',
      });
      // Two artists, ONE id: unattributable → neither artist gets it.
      await makeAudio(path.join(dir, '02.flac'), FLAC, {
        title: 'T2', artist: 'Alpha / Beta', album: 'Tagged',
        MUSICBRAINZ_ARTISTID: '0b0b0b0b-1111-4222-8333-444444444444',
      });
      await makeAudio(path.join(dir, '03.mp3'), MP3, { title: 'T3', artist: 'The Zed', album: 'Tagged' });
      await sb.scan();
      withDb(sb.dbPath, db => {
        const solo = artistByKey(db, 'solo artist');
        assert.equal(solo.sort_name, 'Artist, Solo');
        assert.equal(solo.mbz_artist_id, '0a0a0a0a-1111-4222-8333-444444444444');
        assert.equal(solo.order_name, 'artist, solo', 'order_name follows the sort tag');
        assert.equal(artistByKey(db, 'alpha').mbz_artist_id, null, 'one id for two artists is not attributed');
        assert.equal(artistByKey(db, 'beta').mbz_artist_id, null);
        const zed = artistByKey(db, 'the zed');
        assert.equal(zed.name, 'The Zed');
        assert.equal(zed.order_name, 'zed', 'leading article dropped for the sort key');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM artists WHERE agg_dirty = 1').get().c, 0);
      });
    });

    test('counts follow deletes through the sweep', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const dir = path.join(sb.libRoot, 'Duo');
      for (let i = 1; i <= 3; i++) {
        await makeAudio(path.join(dir, `0${i}.mp3`), MP3, { title: `D${i}`, artist: 'Duo', album: 'Duo', date: '2010' });
      }
      await sb.scan();
      assert.equal(withDb(sb.dbPath, db => artistByKey(db, 'duo')).track_count, 3);
      await fsp.unlink(path.join(dir, '03.mp3'));
      await sb.scan();
      withDb(sb.dbPath, db => {
        const duo = artistByKey(db, 'duo');
        assert.equal(duo.track_count, 2, 'sweep-deleted track left the count');
        assert.equal(duo.album_count, 1);
        assert.equal(duo.agg_dirty, 0);
      });
    });
  });
}
