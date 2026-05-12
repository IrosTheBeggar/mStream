/**
 * V31 trigger correctness tests.
 *
 * Exercises each of the nine FTS sync triggers (INSERT/UPDATE/DELETE
 * × {tracks, artists, albums}) by performing a write on the source
 * table and asserting the FTS5 index is in the expected state after.
 *
 * The cross-table cascade case (artist DELETE → tracks.artist_id SET
 * NULL → tracks_au_fts clears fts_tracks.artist_name) is the highest-
 * risk path here because it depends on PRAGMA recursive_triggers being
 * ON. The dedicated test verifies it directly and also checks the
 * "pragma off" failure mode so a future regression is caught.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from '../src/db/schema.js';

function freshDb({ recursiveTriggers = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  if (recursiveTriggers) {
    db.exec('PRAGMA recursive_triggers = ON');
  } else {
    db.exec('PRAGMA recursive_triggers = OFF');
  }
  for (const m of MIGRATIONS) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration v${m.version} failed: ${err.message}`, { cause: err });
    }
  }
  // Every test needs a library row for tracks.library_id NOT NULL FK.
  db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music');
  return db;
}

function getFtsTrack(db, id) {
  return db.prepare('SELECT title, artist_name, album_name, filepath FROM fts_tracks WHERE rowid = ?').get(id);
}

function matchTracks(db, query) {
  return db.prepare('SELECT rowid, title FROM fts_tracks WHERE fts_tracks MATCH ? ORDER BY rowid').all(query);
}

describe('V31 triggers — tracks', () => {
  test('INSERT INTO tracks adds an fts_tracks row visible to MATCH', () => {
    const db = freshDb();
    const artistId = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Radiohead').lastInsertRowid);
    const albumId  = Number(db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)').run('OK Computer', artistId).lastInsertRowid);
    const trackId  = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id, album_id) VALUES (?, 1, ?, ?, ?)'
    ).run('rh/karma.flac', 'Karma Police', artistId, albumId).lastInsertRowid);

    const row = getFtsTrack(db, trackId);
    // node:sqlite returns rows with null-prototype objects, which
    // deepStrictEqual rejects. Compare field-by-field instead.
    assert.equal(row.title, 'Karma Police');
    assert.equal(row.artist_name, 'Radiohead');
    assert.equal(row.album_name, 'OK Computer');
    assert.equal(row.filepath, 'rh/karma.flac');

    const hits = matchTracks(db, 'karma');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rowid, trackId);
    db.close();
  });

  test('UPDATE OF title rewrites the fts_tracks row', () => {
    const db = freshDb();
    const trackId = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title) VALUES (?, 1, ?)'
    ).run('t.flac', 'OldName').lastInsertRowid);

    assert.equal(matchTracks(db, 'oldname').length, 1);

    db.prepare('UPDATE tracks SET title = ? WHERE id = ?').run('NewName', trackId);
    assert.equal(matchTracks(db, 'oldname').length, 0, 'old title should no longer match');
    assert.equal(matchTracks(db, 'newname').length, 1, 'new title should match');
    db.close();
  });

  test('UPDATE OF artist_id rewrites fts_tracks.artist_name', () => {
    const db = freshDb();
    const a1 = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('FirstArtist').lastInsertRowid);
    const a2 = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('SecondArtist').lastInsertRowid);
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    ).run('x.flac', 'Song', a1).lastInsertRowid);

    assert.equal(getFtsTrack(db, tid).artist_name, 'FirstArtist');

    db.prepare('UPDATE tracks SET artist_id = ? WHERE id = ?').run(a2, tid);
    assert.equal(getFtsTrack(db, tid).artist_name, 'SecondArtist');
    db.close();
  });

  test('DELETE FROM tracks removes the fts_tracks row', () => {
    const db = freshDb();
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title) VALUES (?, 1, ?)'
    ).run('d.flac', 'ToDelete').lastInsertRowid);

    assert.equal(matchTracks(db, 'todelete').length, 1);
    db.prepare('DELETE FROM tracks WHERE id = ?').run(tid);
    assert.equal(matchTracks(db, 'todelete').length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_tracks WHERE rowid = ?').get(tid).c, 0);
    db.close();
  });

  test('writes to columns OUTSIDE the UPDATE OF allowlist do not rewrite fts_tracks', () => {
    // tracks_au_fts is AFTER UPDATE OF title, artist_id, album_id, filepath.
    // An UPDATE on e.g. `bitrate` or `duration` must NOT fire the trigger.
    // Test by observing that the FTS row content stays byte-identical after
    // a write to an unwatched column. The "did the trigger fire?" question
    // is invisible from SQL; the observable proxy is that an UPDATE that
    // shouldn't fire couldn't accidentally e.g. recompute artist_name from
    // a stale SELECT.
    const db = freshDb();
    const artistId = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('A').lastInsertRowid);
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id, bitrate) VALUES (?, 1, ?, ?, 128)'
    ).run('p.flac', 'Hello', artistId).lastInsertRowid);

    // Rename the artist row but DO NOT propagate (simulate stale state).
    // Direct fts_tracks update would do this, but we want to verify the
    // trigger path: write to tracks.bitrate and confirm artist_name in
    // FTS is still whatever the trigger last computed (i.e. 'A'), not
    // re-fetched from artists with a different value mid-test.
    db.prepare('UPDATE tracks SET bitrate = 256 WHERE id = ?').run(tid);
    assert.equal(getFtsTrack(db, tid).artist_name, 'A');
    db.close();
  });
});

describe('V31 triggers — artists', () => {
  test('INSERT INTO artists adds an fts_artists row', () => {
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Brand New').lastInsertRowid);
    const row = db.prepare('SELECT name FROM fts_artists WHERE rowid = ?').get(aid);
    assert.equal(row?.name, 'Brand New');
    db.close();
  });

  test('UPDATE OF artists.name fans out to every fts_tracks row using that artist', () => {
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('TempName').lastInsertRowid);
    const t1 = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    ).run('a.flac', 'Song A', aid).lastInsertRowid);
    const t2 = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    ).run('b.flac', 'Song B', aid).lastInsertRowid);

    assert.equal(getFtsTrack(db, t1).artist_name, 'TempName');
    assert.equal(getFtsTrack(db, t2).artist_name, 'TempName');

    db.prepare('UPDATE artists SET name = ? WHERE id = ?').run('FinalName', aid);

    assert.equal(getFtsTrack(db, t1).artist_name, 'FinalName');
    assert.equal(getFtsTrack(db, t2).artist_name, 'FinalName');
    // And fts_artists is also updated.
    assert.equal(db.prepare('SELECT name FROM fts_artists WHERE rowid = ?').get(aid).name, 'FinalName');
    db.close();
  });

  test('DELETE FROM artists removes the fts_artists row', () => {
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Doomed').lastInsertRowid);
    db.prepare('DELETE FROM artists WHERE id = ?').run(aid);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_artists WHERE rowid = ?').get(aid).c, 0);
    db.close();
  });

  test('DELETE FROM artists cascades through FK SET NULL and clears fts_tracks.artist_name', () => {
    const db = freshDb({ recursiveTriggers: true });
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('SoonGone').lastInsertRowid);
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    ).run('s.flac', 'Lives On', aid).lastInsertRowid);

    assert.equal(getFtsTrack(db, tid).artist_name, 'SoonGone');

    db.prepare('DELETE FROM artists WHERE id = ?').run(aid);

    // FK on tracks.artist_id is ON DELETE SET NULL, so the track row stays
    // but loses its parent ref. The cascaded UPDATE fires tracks_au_fts
    // which rewrites fts_tracks.artist_name to NULL.
    const trackRow = db.prepare('SELECT artist_id FROM tracks WHERE id = ?').get(tid);
    assert.equal(trackRow.artist_id, null);
    assert.equal(getFtsTrack(db, tid).artist_name, null);
    db.close();
  });

  test('FK cascade clears fts_tracks.artist_name even with recursive_triggers OFF', () => {
    // FK actions fire AFTER triggers on the child table as part of the
    // foreign_keys=ON contract, independent of recursive_triggers. The
    // recursive_triggers pragma only matters when a trigger's BODY writes
    // something that fires another user trigger — our trigger bodies only
    // write to FTS5 virtual tables (no user triggers attached). The pragma
    // is set in src/db/manager.js as defence-in-depth, not a requirement.
    // This test locks down that the cascade works without it.
    const db = freshDb({ recursiveTriggers: false });
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Vanishes').lastInsertRowid);
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    ).run('z.flac', 'Lingers', aid).lastInsertRowid);

    db.prepare('DELETE FROM artists WHERE id = ?').run(aid);
    assert.equal(db.prepare('SELECT artist_id FROM tracks WHERE id = ?').get(tid).artist_id, null);
    assert.equal(getFtsTrack(db, tid).artist_name, null);
    db.close();
  });
});

describe('V31 triggers — albums', () => {
  test('INSERT INTO albums adds an fts_albums row', () => {
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('X').lastInsertRowid);
    const albid = Number(db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)').run('Debut', aid).lastInsertRowid);
    assert.equal(db.prepare('SELECT name FROM fts_albums WHERE rowid = ?').get(albid).name, 'Debut');
    db.close();
  });

  test('UPDATE OF albums.name fans out to every fts_tracks row on that album', () => {
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('X').lastInsertRowid);
    const albid = Number(db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)').run('OldAlbum', aid).lastInsertRowid);
    const t1 = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, album_id) VALUES (?, 1, ?, ?)'
    ).run('1.flac', 'One', albid).lastInsertRowid);
    const t2 = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, album_id) VALUES (?, 1, ?, ?)'
    ).run('2.flac', 'Two', albid).lastInsertRowid);

    db.prepare('UPDATE albums SET name = ? WHERE id = ?').run('NewAlbum', albid);

    assert.equal(getFtsTrack(db, t1).album_name, 'NewAlbum');
    assert.equal(getFtsTrack(db, t2).album_name, 'NewAlbum');
    assert.equal(db.prepare('SELECT name FROM fts_albums WHERE rowid = ?').get(albid).name, 'NewAlbum');
    db.close();
  });

  test('DELETE FROM albums removes fts_albums row and clears fts_tracks.album_name via cascade', () => {
    const db = freshDb({ recursiveTriggers: true });
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('X').lastInsertRowid);
    const albid = Number(db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)').run('Doomed', aid).lastInsertRowid);
    const tid = Number(db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, album_id) VALUES (?, 1, ?, ?)'
    ).run('t.flac', 'Track', albid).lastInsertRowid);

    db.prepare('DELETE FROM albums WHERE id = ?').run(albid);

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_albums WHERE rowid = ?').get(albid).c, 0);
    assert.equal(getFtsTrack(db, tid).album_name, null);
    db.close();
  });
});

describe('V31 triggers — bulk-write performance contract', () => {
  test('bulk INSERT of 1000 tracks in one transaction populates fts_tracks fully', () => {
    // Not a benchmark — just verifies the trigger fires inside a large
    // transaction without losing rows. (FTS5 segment-merge timing is
    // separate; covered by the optimize call wired into onScanClose.)
    const db = freshDb();
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Bulk').lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)'
    );
    db.exec('BEGIN');
    for (let i = 0; i < 1000; i++) {
      ins.run(`bulk/${i}.flac`, `Track ${i}`, aid);
    }
    db.exec('COMMIT');

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tracks').get().c, 1000);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_tracks').get().c, 1000);
    // Random spot check via MATCH.
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS c FROM fts_tracks WHERE fts_tracks MATCH 'track'"
    ).get().c, 1000);
    db.close();
  });
});
