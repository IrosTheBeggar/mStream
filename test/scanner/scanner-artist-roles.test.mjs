/**
 * V72 credit roles, display strings and split rules, end-to-end on BOTH
 * scanners.
 *
 *   - COMPOSER / CONDUCTOR / REMIXER / LYRICIST (Vorbis) and TCOM / TPE3 /
 *     TPE4 / TEXT (ID3v2) become track_artists rows with those roles, in tag
 *     order, and create artist rows for credit-only names;
 *   - tracks.artist_display is the ARTIST tag as written: "AC/DC" stays one
 *     artist (the JS scanner reads the raw frame — music-metadata would have
 *     split it), "Alpha / Beta" splits, a multi-valued tag (two Vorbis ARTIST
 *     comments, a null-separated ID3v2.4 TPE1) is honoured verbatim and
 *     displayed joined with ", ";
 *   - scanOptions.artistSplitExceptions keeps a listed name whole;
 *   - a re-tag that drops a role removes its credit row and the orphan sweep
 *     reaps a credit-only artist.
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
import { appendId3TextFrames } from '../helpers/id3.mjs';
import { appendFlacVorbisComments } from '../helpers/vorbis.mjs';

const MP3   = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];
const MP3V4 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '4'];
const FLAC  = ['-c:a', 'flac'];

let rustBin;
let scratch;

function available() { return !!rustBin && fs.existsSync(FFMPEG); }

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-roles-'));
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

// Bump a file's mtime well past "now" so the re-parse fires even when the
// spawned scanner's clock lags (Windows cross-process skew).
async function touchFuture(filepath, secondsAhead = 30) {
  const t = new Date(Date.now() + secondsAhead * 1000);
  await fsp.utimes(filepath, t, t);
}

// Credit rows of one track (by title): [role, position, artist name].
const credits = (db, title) => db.prepare(`
  SELECT ta.role, ta.position, a.name FROM track_artists ta
    JOIN tracks t ON t.id = ta.track_id JOIN artists a ON a.id = ta.artist_id
   WHERE t.title = ? ORDER BY ta.role, ta.position`).all(title).map(r => [r.role, r.position, r.name]);
const display = (db, title) => db.prepare('SELECT artist_display FROM tracks WHERE title = ?').get(title).artist_display;
const hasArtist = (db, name) => !!db.prepare('SELECT 1 FROM artists WHERE name = ?').get(name);

for (const engine of ['rust', 'js']) {
  describe(`credit roles + display [${engine}]`, () => {
    test('roles land in tag order, the display string is the tag as written, plural tags are never split', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const roles = path.join(sb.libRoot, 'Roles');
      await makeAudio(path.join(roles, '01.flac'), FLAC, {
        title: 'R1', artist: 'Lead Singer', album: 'Roles',
        COMPOSER: 'Comp One; Comp Two', CONDUCTOR: 'Maestro', REMIXER: 'Mixer', LYRICIST: 'Poet',
      });
      await makeAudio(path.join(roles, '02.mp3'), MP3, {
        title: 'R2', artist: 'Lead Singer feat. Guest Star', album: 'Roles',
        TCOM: 'Writer A / Writer B', TPE3: 'Maestro', TPE4: 'Mixer', TEXT: 'Poet',
      });
      const slash = path.join(sb.libRoot, 'Slash');
      await makeAudio(path.join(slash, '01.mp3'), MP3, { title: 'S1', artist: 'AC/DC', album: 'Slash' });
      await makeAudio(path.join(slash, '02.mp3'), MP3, { title: 'S2', artist: 'Alpha / Beta', album: 'Slash' });
      const plural = path.join(sb.libRoot, 'Plural');
      const p1 = path.join(plural, '01.flac');
      await makeAudio(p1, FLAC, { title: 'P1', artist: 'Duet A', album: 'Plural' });
      await appendFlacVorbisComments(p1, [['ARTIST', 'Duet B feat. Nobody']]);
      const p2 = path.join(plural, '02.mp3');
      await makeAudio(p2, MP3V4, { title: 'P2', album: 'Plural' });
      await appendId3TextFrames(p2, { TPE1: 'Solo X\0Solo Y feat. Z' }, { version: 4 });
      // A plural ALBUMARTIST: the album's display credit joins the values.
      const p3 = path.join(plural, '03.flac');
      await makeAudio(p3, FLAC, { title: 'P3', artist: 'Duet A', album_artist: 'Duet A', album: 'Plural AA' });
      await appendFlacVorbisComments(p3, [['ALBUMARTIST', 'Duet B']]);
      // A Picard-style ARTISTS list tag: never a credit source (lofty ignores it).
      const r3 = path.join(roles, '03.flac');
      await makeAudio(r3, FLAC, { title: 'R3', artist: 'Lead Singer feat. Guest Star', album: 'Roles' });
      await appendFlacVorbisComments(r3, [['ARTISTS', 'Wrong One'], ['ARTISTS', 'Guest Star']]);

      await sb.scan();
      withDb(sb.dbPath, db => {
        assert.deepEqual(credits(db, 'R1'), [
          ['composer', 0, 'Comp One'], ['composer', 1, 'Comp Two'],
          ['conductor', 0, 'Maestro'], ['lyricist', 0, 'Poet'],
          ['main', 0, 'Lead Singer'], ['remixer', 0, 'Mixer'],
        ], 'Vorbis role comments; COMPOSER split on "; "');
        assert.equal(display(db, 'R1'), 'Lead Singer');
        assert.deepEqual(credits(db, 'R2'), [
          ['composer', 0, 'Writer A'], ['composer', 1, 'Writer B'],
          ['conductor', 0, 'Maestro'], ['featured', 1, 'Guest Star'],
          ['lyricist', 0, 'Poet'], ['main', 0, 'Lead Singer'], ['remixer', 0, 'Mixer'],
        ], 'ID3v2.3 role frames; TCOM split on " / "');
        assert.equal(display(db, 'R2'), 'Lead Singer feat. Guest Star');

        assert.deepEqual(credits(db, 'S1'), [['main', 0, 'AC/DC']], 'a bare slash is not a delimiter');
        assert.equal(display(db, 'S1'), 'AC/DC');
        assert.ok(!hasArtist(db, 'AC') && !hasArtist(db, 'DC'), 'no AC / DC halves');
        assert.deepEqual(credits(db, 'S2'), [['featured', 1, 'Beta'], ['main', 0, 'Alpha']]);
        assert.equal(display(db, 'S2'), 'Alpha / Beta');

        assert.deepEqual(credits(db, 'P1'), [['featured', 1, 'Duet B feat. Nobody'], ['main', 0, 'Duet A']],
          'two Vorbis ARTIST comments: verbatim, the second is NOT split on feat.');
        assert.equal(display(db, 'P1'), 'Duet A, Duet B feat. Nobody');
        assert.ok(!hasArtist(db, 'Nobody'));
        assert.deepEqual(credits(db, 'P2'), [['featured', 1, 'Solo Y feat. Z'], ['main', 0, 'Solo X']],
          'null-separated ID3v2.4 TPE1: verbatim values');
        assert.equal(display(db, 'P2'), 'Solo X, Solo Y feat. Z');
        const aa = db.prepare("SELECT album_artist FROM albums WHERE name = 'Plural AA'").get();
        assert.equal(aa.album_artist, 'Duet A, Duet B', 'plural ALBUMARTIST → joined display credit');
        assert.deepEqual(
          db.prepare(`SELECT a.name FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
                       JOIN albums al ON al.id = aa.album_id WHERE al.name = 'Plural AA' ORDER BY aa.position`).all().map(r => r.name),
          ['Duet A', 'Duet B']);
        assert.deepEqual(credits(db, 'R3'), [['featured', 1, 'Guest Star'], ['main', 0, 'Lead Singer']],
          'credits come from ARTIST; the ARTISTS list tag is ignored');
        assert.equal(display(db, 'R3'), 'Lead Singer feat. Guest Star');
        assert.ok(!hasArtist(db, 'Wrong One'));

        // Credit-only artists exist as rows; counts cover every role.
        const maestro = db.prepare("SELECT track_count, album_count, agg_dirty FROM artists WHERE name = 'Maestro'").get();
        assert.deepEqual({ ...maestro }, { track_count: 2, album_count: 0, agg_dirty: 0 });
        assert.ok(hasArtist(db, 'Comp One') && hasArtist(db, 'Writer B'));
        assert.equal(db.prepare('SELECT COUNT(*) c FROM artists WHERE agg_dirty = 1').get().c, 0);
      });
    });

    test('a composer spelling never outvotes the performer spelling; a composer-only artist still converges', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const v = path.join(sb.libRoot, 'Vote');
      // 1 performer credit "John Lennon" vs 3 composer credits "JOHN LENNON"
      // (same identity key → one row): the performer spelling must win.
      await makeAudio(path.join(v, '01.mp3'), MP3, { title: 'V1', artist: 'John Lennon', album: 'Vote', TCOM: 'JOHN LENNON' });
      await makeAudio(path.join(v, '02.mp3'), MP3, { title: 'V2', artist: 'Other', album: 'Vote', TCOM: 'JOHN LENNON' });
      await makeAudio(path.join(v, '03.mp3'), MP3, { title: 'V3', artist: 'Other', album: 'Vote', TCOM: 'JOHN LENNON' });
      // A composer-only artist: mode over its composer credits (2:1).
      await makeAudio(path.join(v, '04.mp3'), MP3, { title: 'V4', artist: 'Other', album: 'Vote', TPE4: 'Comp X' });
      await makeAudio(path.join(v, '05.mp3'), MP3, { title: 'V5', artist: 'Other', album: 'Vote', TPE4: 'Comp X' });
      await makeAudio(path.join(v, '06.mp3'), MP3, { title: 'V6', artist: 'Other', album: 'Vote', TPE4: 'COMP X' });
      await sb.scan();
      withDb(sb.dbPath, db => {
        const names = db.prepare("SELECT name FROM artists WHERE name_key IN ('john lennon', 'comp x') ORDER BY name").all().map(r => r.name);
        assert.deepEqual(names, ['Comp X', 'John Lennon']);
        assert.equal(db.prepare("SELECT track_count FROM artists WHERE name = 'John Lennon'").get().track_count, 3,
          'credits of every role count as tracks');
      });
    });

    test('Picard-style "/"-joined MusicBrainz artist ids fill both credited artists', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      // ffmpeg writes an unknown key as a TXXX frame with that description —
      // exactly the Picard ID3v2.3 shape, ids joined with "/".
      await makeAudio(path.join(sb.libRoot, 'Mb', '01.mp3'), MP3, {
        title: 'MB1', artist: 'Betamax feat. Junia', album: 'Mb',
        'MusicBrainz Artist Id': '4755f284-f2a0-483e-b77e-29af4c663fba/ffee77a9-fa8a-4fda-936a-2c78b8de44ca',
      });
      await sb.scan();
      withDb(sb.dbPath, db => {
        assert.deepEqual(
          db.prepare("SELECT name, mbz_artist_id FROM artists WHERE name IN ('Betamax', 'Junia') ORDER BY name").all().map(r => [r.name, r.mbz_artist_id]),
          [['Betamax', '4755f284-f2a0-483e-b77e-29af4c663fba'], ['Junia', 'ffee77a9-fa8a-4fda-936a-2c78b8de44ca']]);
      });
    });

    test('artistSplitExceptions keeps a listed name whole (exact spelling)', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const withEx = await makeSandbox(engine);
      await makeAudio(path.join(withEx.libRoot, 'Ex', '01.mp3'), MP3, { title: 'E1', artist: 'AC / DC feat. Bon', album: 'Ex' });
      await withEx.scan({ artistSplitExceptions: ['AC / DC'] });
      withDb(withEx.dbPath, db => {
        assert.deepEqual(credits(db, 'E1'), [['featured', 1, 'Bon'], ['main', 0, 'AC / DC']]);
        assert.equal(display(db, 'E1'), 'AC / DC feat. Bon');
      });

      const without = await makeSandbox(engine);
      await makeAudio(path.join(without.libRoot, 'Ex', '01.mp3'), MP3, { title: 'E1', artist: 'AC / DC feat. Bon', album: 'Ex' });
      await without.scan();
      withDb(without.dbPath, db => {
        assert.deepEqual(credits(db, 'E1'), [['featured', 1, 'DC'], ['featured', 2, 'Bon'], ['main', 0, 'AC']],
          'without the exception the spaced slash splits');
      });
    });

    test('a re-tag that drops a role removes the credit; the credit-only artist is reaped', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      const f = path.join(sb.libRoot, 'Re', '01.flac');
      await makeAudio(f, FLAC, { title: 'X1', artist: 'Performer', album: 'Re', COMPOSER: 'Ghost Writer' });
      await sb.scan();
      withDb(sb.dbPath, db => {
        assert.deepEqual(credits(db, 'X1'), [['composer', 0, 'Ghost Writer'], ['main', 0, 'Performer']]);
        assert.ok(hasArtist(db, 'Ghost Writer'));
      });
      await makeAudio(f, FLAC, { title: 'X1', artist: 'Performer', album: 'Re' });
      await touchFuture(f);
      await sb.scan();
      withDb(sb.dbPath, db => {
        assert.deepEqual(credits(db, 'X1'), [['main', 0, 'Performer']], 'the composer row is gone');
        assert.ok(!hasArtist(db, 'Ghost Writer'), 'nothing references the composer any more → swept');
      });
    });
  });
}
