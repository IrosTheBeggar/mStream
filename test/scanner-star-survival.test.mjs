/**
 * User-state survival across orphan sweeps and re-mints (schema-audit
 * batch: orphan-sweep-user-state-survival).
 *
 * Both star tables CASCADE on album/artist delete, and the scan-end
 * orphan sweep used to treat "no tracks reference it" as sufficient
 * grounds to delete — so a transiently-missing folder (sub-mount blip,
 * temporarily moved files) permanently destroyed every user's stars,
 * and an artist re-tag did the same (no artist twin of the album-stars
 * migration existed). This file pins the fixes on BOTH scanners:
 *
 *   - a starred album/artist whose files vanish survives the sweep as a
 *     ghost; restoring the files re-attaches it by natural key, stars
 *     intact. Unstarred trackless rows still sweep (no ghost build-up).
 *   - an ARTIST re-tag re-homes artist stars to the new artist row (the
 *     new migrateArtistStars / migrate_artist_stars), after which the
 *     old row sweeps normally.
 *   - moving ONE track off a multi-track album steals NOTHING (the
 *     unreferenced guard — previously migrateAlbumStars moved the
 *     album's stars whenever any single track changed albums).
 *   - an album re-mint (year re-tag) carries album_art_lookups + the
 *     album_art gallery links + a service-sourced default along with
 *     the stars (previously CASCADE-destroyed → re-downloads).
 *   - the seeded Various Artists row survives sweeps (carve-out) and is
 *     re-created on demand with its canonical MusicBrainz id.
 *   - reaping a cached art file clears the by-value album_art_file /
 *     image_file pointers that referenced it (no permanent 404s).
 *
 * Skipped (like scanner-parity.test.mjs) when ffmpeg or the rust binary
 * is unavailable.
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
import { VARIOUS_ARTISTS_MBZ_ID } from '../src/db/orphan-cleanup.js';

const MP3 = ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3'];

let rustBin;
let scratch;

function available() { return !!rustBin && fs.existsSync(FFMPEG); }

before(async () => {
  rustBin = findRustParser();
  if (!available()) { return; }
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-starsurv-'));
});

after(async () => {
  if (scratch) { await fsp.rm(scratch, { recursive: true, force: true }); }
});

// Each scenario gets its own sandbox: a library root, a DB, an art dir,
// and an engine-dispatched scan runner — so JS and Rust runs of the
// same scenario can't contaminate each other.
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
  return { root, libRoot, artDir, dbPath, libraryId, scan };
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function withDb(dbPath, fn) {
  const db = openDb(dbPath);
  try { return fn(db); } finally { db.close(); }
}

function seedUser(dbPath) {
  withDb(dbPath, db => {
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password, salt)
                VALUES (1, 'starrer', 'x', 'x')`).run();
  });
}

// Star helpers — direct DB writes, the same rows the API endpoints make.
function starAlbum(dbPath, albumName) {
  withDb(dbPath, db => {
    const al = db.prepare('SELECT id FROM albums WHERE name = ?').get(albumName);
    assert.ok(al, `album '${albumName}' should exist before starring`);
    db.prepare(`INSERT INTO user_album_stars (user_id, album_id, starred_at)
                VALUES (1, ?, '2024-01-01 00:00:00')`).run(al.id);
    return al.id;
  });
}
function starArtist(dbPath, artistName) {
  withDb(dbPath, db => {
    const ar = db.prepare('SELECT id FROM artists WHERE name = ?').get(artistName);
    assert.ok(ar, `artist '${artistName}' should exist before starring`);
    db.prepare(`INSERT INTO user_artist_stars (user_id, artist_id, starred_at)
                VALUES (1, ?, '2024-01-01 00:00:00')`).run(ar.id);
  });
}
function albumStars(dbPath) {
  return withDb(dbPath, db => db.prepare(
    `SELECT s.user_id, s.album_id, a.name FROM user_album_stars s
       LEFT JOIN albums a ON a.id = s.album_id ORDER BY s.album_id`).all()
    .map(r => ({ ...r })));
}
function artistStars(dbPath) {
  return withDb(dbPath, db => db.prepare(
    `SELECT s.user_id, s.artist_id, a.name FROM user_artist_stars s
       LEFT JOIN artists a ON a.id = s.artist_id ORDER BY s.artist_id`).all()
    .map(r => ({ ...r })));
}

// Bump a file's mtime well past its current value so the next scan's
// unchanged fast-path (seconds-granular in rust) must re-parse it.
async function touchFuture(filepath, secondsAhead = 10) {
  const t = new Date(Date.now() + secondsAhead * 1000);
  await fsp.utimes(filepath, t, t);
}

// MP3 with a REAL TCMP (compilation) frame. ffmpeg's mp3 muxer maps
// `-metadata compilation=1` to a TXXX:compilation frame that NEITHER
// scanner reads — so the tag is hand-built (same recipe as
// scanner-multi-art.test.mjs's typed-APIC fixture): bitexact bare tone,
// then an ID3v2.3 header with TIT2/TPE1/TALB/TCMP text frames.
function id3TextFrame(id, text) {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
async function makeCompilationMp3(filepath, meta) {
  await fsp.mkdir(path.dirname(filepath), { recursive: true });
  const bare = filepath + '.bare.mp3';
  const { ffmpeg } = await import('./helpers/scanner-fixture.mjs');
  await ffmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:duration=1',
    '-c:a', 'libmp3lame', '-b:a', '64k',
    '-map_metadata', '-1', '-fflags', '+bitexact',
    bare,
  ]);
  const frames = Buffer.concat([
    id3TextFrame('TIT2', meta.title),
    id3TextFrame('TPE1', meta.artist),
    id3TextFrame('TALB', meta.album),
    id3TextFrame('TCMP', '1'),
  ]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 0x03;
  const size = frames.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  const audio = await fsp.readFile(bare);
  await fsp.writeFile(filepath, Buffer.concat([header, frames, audio]));
  await fsp.unlink(bare);
}

// One fixture shape shared by the scenarios:
//   Band A/One/01.mp3, 02.mp3   (artist 'Band A', album 'One')
//   Band B/Two/03.mp3           (artist 'Band B', album 'Two')
async function buildBasicLib(libRoot) {
  await makeAudio(path.join(libRoot, 'Band A', 'One', '01.mp3'), MP3,
    { title: 'T1', artist: 'Band A', album: 'One' });
  await makeAudio(path.join(libRoot, 'Band A', 'One', '02.mp3'), MP3,
    { title: 'T2', artist: 'Band A', album: 'One' });
  await makeAudio(path.join(libRoot, 'Band B', 'Two', '03.mp3'), MP3,
    { title: 'T3', artist: 'Band B', album: 'Two' });
}

for (const engine of ['rust', 'js']) {
  describe(`star survival [${engine}]`, () => {
    test('starred album+artist survive a vanished folder as ghosts and re-attach on restore; unstarred rows sweep', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      await buildBasicLib(sb.libRoot);
      await sb.scan();
      seedUser(sb.dbPath);
      starAlbum(sb.dbPath, 'One');
      starArtist(sb.dbPath, 'Band A');
      const before = withDb(sb.dbPath, db => ({
        album: db.prepare(`SELECT id FROM albums WHERE name = 'One'`).get().id,
        artist: db.prepare(`SELECT id FROM artists WHERE name = 'Band A'`).get().id,
      }));

      // Vanish BOTH album folders (the starred and the unstarred one).
      const hideA = path.join(sb.root, 'hidden-a');
      const hideB = path.join(sb.root, 'hidden-b');
      await fsp.rename(path.join(sb.libRoot, 'Band A'), hideA);
      await fsp.rename(path.join(sb.libRoot, 'Band B'), hideB);
      await sb.scan();

      withDb(sb.dbPath, db => {
        assert.equal(db.prepare('SELECT COUNT(*) c FROM tracks').get().c, 0,
          'all tracks swept (files verifiably gone)');
        // Starred rows ghost; unstarred rows sweep.
        assert.ok(db.prepare(`SELECT 1 FROM albums WHERE name = 'One'`).get(),
          'starred album survives as a ghost');
        assert.ok(db.prepare(`SELECT 1 FROM artists WHERE name = 'Band A'`).get(),
          'starred artist survives as a ghost');
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM albums WHERE name = 'Two'`).get().c, 0,
          'unstarred trackless album still sweeps');
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM artists WHERE name = 'Band B'`).get().c, 0,
          'unstarred reference-less artist still sweeps');
      });
      assert.equal(albumStars(sb.dbPath).length, 1, 'album star intact while ghosted');
      assert.equal(artistStars(sb.dbPath).length, 1, 'artist star intact while ghosted');

      // Restore — ghosts re-attach by natural key, SAME ids.
      await fsp.rename(hideA, path.join(sb.libRoot, 'Band A'));
      await fsp.rename(hideB, path.join(sb.libRoot, 'Band B'));
      await sb.scan();
      withDb(sb.dbPath, db => {
        assert.equal(db.prepare(`SELECT id FROM albums WHERE name = 'One'`).get().id,
          before.album, 'album row reused (same id) on restore');
        assert.equal(db.prepare(`SELECT id FROM artists WHERE name = 'Band A'`).get().id,
          before.artist, 'artist row reused (same id) on restore');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM tracks').get().c, 3);
      });
      assert.equal(albumStars(sb.dbPath)[0].album_id, before.album, 'star re-attached');
      assert.equal(artistStars(sb.dbPath)[0].artist_id, before.artist, 'star re-attached');
    });

    test('artist re-tag re-homes the artist star to the new row; old row sweeps', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      await buildBasicLib(sb.libRoot);
      await sb.scan();
      seedUser(sb.dbPath);
      starArtist(sb.dbPath, 'Band A');
      starAlbum(sb.dbPath, 'One');

      // Re-tag every Band A file to the corrected spelling.
      for (const f of ['01.mp3', '02.mp3']) {
        const p = path.join(sb.libRoot, 'Band A', 'One', f);
        await makeAudio(p, MP3, { title: f, artist: 'Bánd A', album: 'One' });
        await touchFuture(p);
      }
      await sb.scan();

      const arStars = artistStars(sb.dbPath);
      assert.equal(arStars.length, 1, 'exactly one artist star after the rename');
      assert.equal(arStars[0].name, 'Bánd A', 'star re-homed to the renamed artist');
      withDb(sb.dbPath, db => {
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM artists WHERE name = 'Band A'`).get().c, 0,
          'old artist row swept once star-less and reference-less');
      });
      // The album re-minted too (identity includes artist_id) — its star
      // must have followed.
      const alStars = albumStars(sb.dbPath);
      assert.equal(alStars.length, 1);
      assert.equal(alStars[0].name, 'One', 'album star followed the re-mint');
    });

    test('moving ONE track off a multi-track album steals neither stars nor art state', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      await buildBasicLib(sb.libRoot);
      await sb.scan();
      seedUser(sb.dbPath);
      starAlbum(sb.dbPath, 'One');
      const albumOneId = withDb(sb.dbPath, db =>
        db.prepare(`SELECT id FROM albums WHERE name = 'One'`).get().id);

      // 02.mp3 leaves for a different album; 01.mp3 stays.
      const p = path.join(sb.libRoot, 'Band A', 'One', '02.mp3');
      await makeAudio(p, MP3, { title: 'T2', artist: 'Band A', album: 'B-Sides' });
      await touchFuture(p);
      await sb.scan();

      const stars = albumStars(sb.dbPath);
      assert.equal(stars.length, 1);
      assert.equal(stars[0].album_id, albumOneId,
        'star stays on the album that still has tracks');
      withDb(sb.dbPath, db => {
        assert.ok(db.prepare(`SELECT 1 FROM albums WHERE name = 'B-Sides'`).get(),
          'the departed track minted its new album');
      });
    });

    test('ARTIST rename with a diverging ALBUMARTIST: stars follow the track heir, not the album heir', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      // Review finding (high): the album-artist hop ran before the
      // track-artist hop and claimed the renamed artist's stars for the
      // NEW ALBUM artist. Here the re-tag renames ARTIST X→Y and
      // simultaneously sets ALBUMARTIST=Z — X's star must land on Y.
      const sb = await makeSandbox(engine);
      const p = path.join(sb.libRoot, 'X', 'Solo', '01.mp3');
      await makeAudio(p, MP3, { title: 'S1', artist: 'X', album: 'Solo' });
      await sb.scan();
      seedUser(sb.dbPath);
      starArtist(sb.dbPath, 'X');

      await makeAudio(p, MP3,
        { title: 'S1', artist: 'Y', album: 'Solo', album_artist: 'Z' });
      await touchFuture(p);
      await sb.scan();

      const stars = artistStars(sb.dbPath);
      assert.equal(stars.length, 1);
      assert.equal(stars[0].name, 'Y',
        'star follows the renamed track artist, not the new album artist');
    });

    test('rename + sibling deletion in one scan: the post-sweep replay still re-homes the star', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      // Review finding (medium ×2): the doomed sibling's not-yet-swept
      // row masks the unreferenced guard during the per-file hop, and
      // the renamed file is unchanged on later scans — without the
      // post-sweep replay the star strands on an invisible ghost
      // forever.
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'S', 'Strand', '01.mp3'), MP3,
        { title: 'W1', artist: 'Strander', album: 'Strand' });
      await makeAudio(path.join(sb.libRoot, 'S', 'Strand', '02.mp3'), MP3,
        { title: 'W2', artist: 'Strander', album: 'Strand' });
      await sb.scan();
      seedUser(sb.dbPath);
      starAlbum(sb.dbPath, 'Strand');

      // Same scan: 02 vanishes, 01 re-tags to the new album name.
      await fsp.unlink(path.join(sb.libRoot, 'S', 'Strand', '02.mp3'));
      const p1 = path.join(sb.libRoot, 'S', 'Strand', '01.mp3');
      await makeAudio(p1, MP3, { title: 'W1', artist: 'Strander', album: 'StrandNew' });
      await touchFuture(p1);
      await sb.scan();

      const stars = albumStars(sb.dbPath);
      assert.equal(stars.length, 1);
      assert.equal(stars[0].name, 'StrandNew',
        'replay re-homed the star after the doomed sibling was swept');
      withDb(sb.dbPath, db => {
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM albums WHERE name = 'Strand'`).get().c,
          0, 'old album swept once star-less');
      });
    });

    test('un-flagging a compilation never walks the Various Artists star onto the new album artist', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      // Review finding (medium): VA is sweep-exempt, so its stars are
      // never in danger — the album-artist hop must not claim them.
      const sb = await makeSandbox(engine);
      await makeCompilationMp3(path.join(sb.libRoot, 'Comp', 'c1.mp3'),
        { title: 'C1', artist: 'CompX', album: 'Mixtape' });
      await sb.scan();
      seedUser(sb.dbPath);
      starArtist(sb.dbPath, 'Various Artists');

      // Re-tag: plain album with an explicit ALBUMARTIST (no TCMP).
      const p = path.join(sb.libRoot, 'Comp', 'c1.mp3');
      await makeAudio(p, MP3,
        { title: 'C1', artist: 'CompX', album: 'Mixtape', album_artist: 'Solo Z' });
      await touchFuture(p);
      await sb.scan();

      const stars = artistStars(sb.dbPath);
      assert.equal(stars.length, 1);
      assert.equal(stars[0].name, 'Various Artists',
        'VA keeps its star — sweep-exempt stars never migrate');
    });

    test('album re-mint (year re-tag) carries lookups, gallery links, and a service default', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
      const sb = await makeSandbox(engine);
      // Art-less album so the downloader-ish state below is the only art.
      const p = path.join(sb.libRoot, 'Plain', '01.mp3');
      await makeAudio(p, MP3, { title: 'P1', artist: 'Plain P', album: 'Plain' });
      await sb.scan();
      seedUser(sb.dbPath);

      // Simulate the art downloader's footprint on this album: a cached
      // art row + gallery link + default pointer + a 'found' lookup row.
      const oldAlbumId = withDb(sb.dbPath, db => {
        const id = db.prepare(`SELECT id FROM albums WHERE name = 'Plain'`).get().id;
        db.prepare(`INSERT INTO art_files (kind, cache_file, byte_size, content_hash)
                    VALUES ('cached', 'feedface.jpeg', 1234, 'feedface')`).run();
        const artId = db.prepare(`SELECT id FROM art_files WHERE content_hash = 'feedface'`).get().id;
        db.prepare(`INSERT INTO album_art (album_id, art_id, source, picture_type, position)
                    VALUES (?, ?, 'musicbrainz', 3, 0)`).run(id, artId);
        db.prepare(`UPDATE albums SET album_art_file = 'feedface.jpeg',
                    album_art_source = 'musicbrainz' WHERE id = ?`).run(id);
        db.prepare(`INSERT INTO album_art_lookups (album_id, last_attempt_at, outcome, attempts, fetched_hash)
                    VALUES (?, '2026-06-01 00:00:00', 'found', 1, 'feedface')`).run(id);
        return id;
      });

      // Year re-tag → new (name, artist, year) identity → album re-mints.
      await makeAudio(p, MP3, { title: 'P1', artist: 'Plain P', album: 'Plain', date: '1999' });
      await touchFuture(p);
      await sb.scan();

      withDb(sb.dbPath, db => {
        const heir = db.prepare(`SELECT id, album_art_file, album_art_source
                                   FROM albums WHERE name = 'Plain'`).get();
        assert.ok(heir, 'album exists after re-mint');
        assert.notEqual(heir.id, oldAlbumId, 'the re-tag minted a new album row');
        assert.equal(heir.album_art_file, 'feedface.jpeg', 'service default carried');
        assert.equal(heir.album_art_source, 'musicbrainz', 'source carried with it');
        const link = db.prepare(`SELECT source FROM album_art WHERE album_id = ?`).get(heir.id);
        assert.ok(link, 'gallery link carried to the heir');
        assert.equal(link.source, 'musicbrainz');
        const lookup = db.prepare(`SELECT outcome, fetched_hash FROM album_art_lookups
                                     WHERE album_id = ?`).get(heir.id);
        assert.ok(lookup, 'downloader lookup row moved to the heir');
        assert.equal(lookup.outcome, 'found');
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM albums WHERE id = ?`).get(oldAlbumId).c,
          0, 'old album row swept after handing everything over');
      });
    });
  });
}

// Engine-independent scenarios (one engine each is enough — the logic
// under test is shared SQL, already covered cross-engine above).

describe('Various Artists protection', () => {
  test('VA row survives the sweep on a compilation-less library and is re-created on demand [rust+js]', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
    for (const engine of ['rust', 'js']) {
      const sb = await makeSandbox(engine);
      await buildBasicLib(sb.libRoot);
      await sb.scan();
      withDb(sb.dbPath, db => {
        const va = db.prepare(`SELECT id, mbz_artist_id FROM artists
                                 WHERE name = 'Various Artists'`).get();
        assert.ok(va, `[${engine}] seeded VA row survives a compilation-less whole-library scan`);
        assert.equal(va.mbz_artist_id, VARIOUS_ARTISTS_MBZ_ID);
      });

      // Hostile start: VA row gone entirely (legacy DBs that swept it).
      withDb(sb.dbPath, db => {
        db.prepare(`DELETE FROM artists WHERE name = 'Various Artists'`).run();
      });
      // An untagged compilation: TCMP=1, two artists, no ALBUMARTIST.
      await makeCompilationMp3(path.join(sb.libRoot, 'Comp', 'c1.mp3'),
        { title: 'C1', artist: 'Comp Artist X', album: 'Mixtape' });
      await makeCompilationMp3(path.join(sb.libRoot, 'Comp', 'c2.mp3'),
        { title: 'C2', artist: 'Comp Artist Y', album: 'Mixtape' });
      await sb.scan();

      withDb(sb.dbPath, db => {
        const va = db.prepare(`SELECT id, mbz_artist_id FROM artists
                                 WHERE name = 'Various Artists'`).get();
        assert.ok(va, `[${engine}] VA re-created on demand`);
        assert.equal(va.mbz_artist_id, VARIOUS_ARTISTS_MBZ_ID,
          `[${engine}] re-created with the canonical MusicBrainz id`);
        const rows = db.prepare(`SELECT id, artist_id FROM albums WHERE name = 'Mixtape'`).all();
        assert.equal(rows.length, 1,
          `[${engine}] one album row for the compilation (no fragmentation)`);
        assert.equal(rows[0].artist_id, va.id, `[${engine}] owned by VA`);
      });
    }
  });
});

describe('art-pointer cleanup on cache reap', () => {
  // A service-fetched cover (downloader-style: cached row + pointers
  // with a non-scanner source, NO library file backs it) whose cache
  // file vanished. The UPSERT's service-preserve arm rightly carries
  // the pointer through the re-parse — embedded/folder art can't
  // overwrite a service default — so without the reaper's pointer
  // clearing it would serve 404s forever. (An EMBEDDED default can't
  // hit this: a force-rescan re-caches the same bytes to the same
  // content-addressed name before the reaper looks.)
  test('reaping a vanished service cover clears the by-value default pointers [rust+js]', { skip: !available() && 'ffmpeg or rust-parser unavailable' }, async () => {
    for (const engine of ['rust', 'js']) {
      const sb = await makeSandbox(engine);
      await makeAudio(path.join(sb.libRoot, 'Plain', 'p1.mp3'), MP3,
        { title: 'P1', artist: 'Plain P', album: 'Plain' });
      await sb.scan();

      withDb(sb.dbPath, db => {
        db.prepare(`INSERT INTO art_files (kind, cache_file, byte_size, content_hash)
                    VALUES ('cached', 'feedface.jpeg', 1234, 'feedface')`).run();
        db.prepare(`UPDATE tracks SET album_art_file = 'feedface.jpeg',
                    album_art_source = 'musicbrainz' WHERE title = 'P1'`).run();
        db.prepare(`UPDATE albums SET album_art_file = 'feedface.jpeg',
                    album_art_source = 'musicbrainz' WHERE name = 'Plain'`).run();
      });

      // No feedface.jpeg in the cache dir → force-rescan reaps the row
      // and must clear the pointers it strands.
      await sb.scan({ forceRescan: true });

      withDb(sb.dbPath, db => {
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM art_files
                                   WHERE cache_file = 'feedface.jpeg'`).get().c, 0,
          `[${engine}] stale cached art row reaped`);
        const t = db.prepare(`SELECT album_art_file, album_art_source
                                FROM tracks WHERE title = 'P1'`).get();
        assert.equal(t.album_art_file, null, `[${engine}] track pointer cleared`);
        assert.equal(t.album_art_source, null, `[${engine}] track source cleared`);
        const al = db.prepare(`SELECT album_art_file, album_art_source
                                 FROM albums WHERE name = 'Plain'`).get();
        assert.equal(al.album_art_file, null, `[${engine}] album pointer cleared`);
        assert.equal(al.album_art_source, null, `[${engine}] album source cleared`);
      });
    }
  });
});
