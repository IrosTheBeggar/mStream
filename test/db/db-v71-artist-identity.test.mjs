/**
 * V71 artist-identity migration: key assignment, duplicate merge, re-keyed
 * albums, dirty-marking and key-fill triggers.
 *
 * V71 is ADD COLUMN only (no rebuild). Its js hook groups artists by
 * nameKey(name), elects a survivor per group (most credit rows + primary-
 * track references, then lowest id) and folds the others in: tracks, both
 * M2M tables, stars and artist art re-point; NULL sort / MBID / image
 * columns fill from the loser; every `name:`-keyed album of the loser is
 * re-keyed onto the survivor — merging with the survivor's own album of
 * that name through album-merge.js. Then the UNIQUE key index, order_name
 * and the counts are written.
 *
 * These tests build a populated V70 database and upgrade it under
 * foreign_keys=ON + recursive_triggers=ON exactly as the runner does.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const rows = (stmt, ...args) => stmt.all(...args).map(r => ({ ...r }));

function buildV70Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db, { upToVersion: 70 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 70);

  db.exec(`
    INSERT INTO libraries (id, name, root_path, type, follow_symlinks) VALUES (1, 'lib', '/lib', 'music', 0);
    INSERT INTO users (id, username, password, salt) VALUES (1, 'u1', 'x', 'x'), (2, 'u2', 'x', 'x');
    -- Three spellings of one artist (10 wins: most references), two quote
    -- styles of another (14 wins), and an untouched control.
    INSERT INTO artists (id, name, sort_name, mbz_artist_id) VALUES
      (10, 'Beatles', NULL, NULL),
      (11, 'beatles', 'Beatles, The', NULL),
      (12, 'BEATLES', NULL, 'mbz-beatles'),
      (13, 'Guns N’ Roses', NULL, NULL),
      (14, 'Guns N'' Roses', NULL, NULL),
      (15, 'Solo', NULL, NULL);
    INSERT INTO albums (id, name, artist_id, year, album_key) VALUES
      (1, 'Hits', 10, 1987, 'name:Hits|10'),
      (2, 'Hits', 11, 1987, 'name:Hits|11'),
      (3, 'Live', 12, 1990, 'name:Live|12'),
      (4, 'Blue', 11, 1994, 'mbid:aaaa-bbbb'),
      (5, 'Solo LP', 15, 2000, 'name:Solo LP|15');
    INSERT INTO tracks (id, filepath, library_id, title, artist_id, album_id, year, duration) VALUES
      (100, 'b/1.mp3', 1, 'B1', 10, 1, 1987, 10),
      (101, 'b/2.mp3', 1, 'B2', 10, 1, 1987, 10),
      (102, 'b/3.mp3', 1, 'B3', 10, 1, 1987, 10),
      (103, 'b/4.mp3', 1, 'B4', 11, 2, 1987, 10),
      (104, 'b/5.mp3', 1, 'B5', 12, 3, 1990, 10),
      (105, 'b/6.mp3', 1, 'B6', 11, 4, 1994, 10),
      (106, 'g/1.mp3', 1, 'G1', 13, NULL, NULL, 10),
      (107, 'g/2.mp3', 1, 'G2', 14, NULL, NULL, 10),
      (108, 'g/3.mp3', 1, 'G3', 14, NULL, NULL, 10),
      (109, 's/1.mp3', 1, 'S1', 15, 5, 2000, 10);
    INSERT INTO track_artists (track_id, artist_id, role, position)
      SELECT id, artist_id, 'main', 0 FROM tracks;
    INSERT INTO album_artists (album_id, artist_id, role, position) VALUES
      (1, 10, 'main', 0), (2, 11, 'main', 0), (3, 12, 'main', 0), (4, 11, 'main', 0), (5, 15, 'main', 0);
    INSERT INTO user_artist_stars (user_id, artist_id, starred_at) VALUES
      (1, 10, '2024-01-05 00:00:00'), (1, 11, '2024-01-01 00:00:00'), (2, 12, '2024-01-02 00:00:00'),
      (1, 13, '2024-02-01 00:00:00');
    INSERT INTO user_album_stars (user_id, album_id, starred_at) VALUES (1, 2, '2024-03-01 00:00:00');
    INSERT INTO art_files (id, kind, cache_file, byte_size, content_hash) VALUES (7, 'cached', 'gnr.jpeg', 100, 'gnr');
    INSERT INTO artist_art (artist_id, art_id, source, picture_type, position) VALUES (11, 7, 'lastfm', 3, 0);
  `);
  return db;
}

function upgrade(db) {
  applyAllMigrations(db, { fromVersion: 70 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
}

describe('V71 artist identity', () => {
  test('spelling variants merge into the most-referenced row; controls and the VA seed are untouched', () => {
    const db = buildV70Fixture();
    upgrade(db);
    const artists = rows(db.prepare('SELECT id, name, name_key FROM artists ORDER BY id'));
    assert.deepEqual(artists.filter(a => a.id >= 10), [
      { id: 10, name: 'Beatles', name_key: 'beatles' },
      { id: 14, name: "Guns N' Roses", name_key: "guns n' roses" },
      { id: 15, name: 'Solo', name_key: 'solo' },
    ]);
    assert.equal(db.prepare("SELECT name_key FROM artists WHERE name = 'Various Artists'").get().name_key, 'various artists');
  });

  test('tracks, credits, stars and art re-point to the survivor; NULL columns fill from the losers', () => {
    const db = buildV70Fixture();
    upgrade(db);
    assert.deepEqual(db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE id BETWEEN 100 AND 105').all().map(r => r.artist_id), [10]);
    assert.deepEqual(db.prepare('SELECT DISTINCT artist_id FROM tracks WHERE id BETWEEN 106 AND 108').all().map(r => r.artist_id), [14]);
    // Credit rows follow, keeping the spelling each one was seeded with.
    assert.deepEqual(rows(db.prepare('SELECT track_id, tag_name FROM track_artists WHERE artist_id = 10 ORDER BY track_id')), [
      { track_id: 100, tag_name: 'Beatles' }, { track_id: 101, tag_name: 'Beatles' }, { track_id: 102, tag_name: 'Beatles' },
      { track_id: 103, tag_name: 'beatles' }, { track_id: 104, tag_name: 'BEATLES' }, { track_id: 105, tag_name: 'beatles' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM track_artists WHERE artist_id IN (11, 12, 13)').get().c, 0);
    // Stars: union with the EARLIER starred_at, user 2's star moved.
    assert.deepEqual(rows(db.prepare('SELECT user_id, artist_id, starred_at FROM user_artist_stars ORDER BY artist_id, user_id')), [
      { user_id: 1, artist_id: 10, starred_at: '2024-01-01 00:00:00' },
      { user_id: 2, artist_id: 10, starred_at: '2024-01-02 00:00:00' },
      { user_id: 1, artist_id: 14, starred_at: '2024-02-01 00:00:00' },
    ]);
    assert.deepEqual(rows(db.prepare('SELECT artist_id, art_id FROM artist_art')), [{ artist_id: 10, art_id: 7 }]);
    const surv = db.prepare('SELECT sort_name, mbz_artist_id, order_name FROM artists WHERE id = 10').get();
    assert.equal(surv.sort_name, 'Beatles, The', 'sort name filled from a loser');
    assert.equal(surv.mbz_artist_id, 'mbz-beatles', 'MBID filled from a loser');
    assert.equal(surv.order_name, 'beatles, the', 'order_name follows the sort name');
    // The repoint fired tracks_au_fts, so the FTS row carries the survivor.
    assert.equal(db.prepare('SELECT artist_name FROM fts_tracks WHERE rowid = 103').get().artist_name, 'Beatles');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM fts_artists WHERE fts_artists MATCH 'beatles'").get().c, 1);
  });

  test("the losers' albums re-key onto the survivor, merging with its own same-name album", () => {
    const db = buildV70Fixture();
    upgrade(db);
    const albums = rows(db.prepare('SELECT id, name, artist_id, album_key, track_count, year_min, year_max, agg_dirty FROM albums ORDER BY id'));
    assert.deepEqual(albums, [
      { id: 1, name: 'Hits', artist_id: 10, album_key: 'name:Hits|10', track_count: 4, year_min: 1987, year_max: 1987, agg_dirty: 0 },
      { id: 3, name: 'Live', artist_id: 10, album_key: 'name:Live|10', track_count: 1, year_min: 1990, year_max: 1990, agg_dirty: 0 },
      { id: 4, name: 'Blue', artist_id: 10, album_key: 'mbid:aaaa-bbbb', track_count: 1, year_min: 1994, year_max: 1994, agg_dirty: 0 },
      { id: 5, name: 'Solo LP', artist_id: 15, album_key: 'name:Solo LP|15', track_count: 1, year_min: 2000, year_max: 2000, agg_dirty: 0 },
    ]);
    assert.equal(db.prepare('SELECT album_id FROM tracks WHERE id = 103').get().album_id, 1, "album 2's track moved into album 1");
    assert.deepEqual(rows(db.prepare('SELECT user_id, album_id FROM user_album_stars')), [{ user_id: 1, album_id: 1 }], 'album star followed the merge');
    assert.deepEqual(db.prepare('SELECT DISTINCT album_id FROM album_artists WHERE artist_id = 10 ORDER BY album_id').all().map(r => r.album_id), [1, 3, 4]);
  });

  test('counts, keys and indexes', () => {
    const db = buildV70Fixture();
    upgrade(db);
    assert.deepEqual(rows(db.prepare('SELECT id, track_count, album_count, agg_dirty FROM artists WHERE id >= 10 ORDER BY id')), [
      { id: 10, track_count: 6, album_count: 3, agg_dirty: 0 },
      { id: 14, track_count: 3, album_count: 0, agg_dirty: 0 },
      { id: 15, track_count: 1, album_count: 1, agg_dirty: 0 },
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_artists_key'").get().c, 1);
    assert.throws(
      () => db.prepare("INSERT INTO artists (name, name_key) VALUES ('Beatles Tribute', 'beatles')").run(),
      /UNIQUE/, 'duplicate name_key rejected');
  });

  test('key-fill trigger covers rows inserted without a key; dirty triggers flag credit changes', () => {
    const db = buildV70Fixture();
    upgrade(db);
    db.prepare("INSERT INTO artists (id, name) VALUES (20, '  New  Guy ')").run();
    assert.deepEqual({ ...db.prepare('SELECT name_key, order_name, agg_dirty FROM artists WHERE id = 20').get() },
      { name_key: 'new  guy', order_name: null, agg_dirty: 1 },
      'fixture rows get lower(trim(name)) — an ASCII approximation, internal whitespace kept; order_name is the refresh\'s');
    db.prepare('UPDATE artists SET agg_dirty = 0').run();
    const dirty = () => db.prepare('SELECT id FROM artists WHERE agg_dirty = 1 ORDER BY id').all().map(r => r.id);
    db.prepare("INSERT INTO track_artists (track_id, artist_id, role, position, tag_name) VALUES (109, 20, 'featured', 1, 'New Guy')").run();
    assert.deepEqual(dirty(), [20], 'a new credit flags the artist');
    db.prepare('UPDATE artists SET agg_dirty = 0').run();
    db.prepare('DELETE FROM tracks WHERE id = 109').run();
    assert.deepEqual(dirty(), [15, 20], 'a track delete cascades through track_artists and flags every credited artist');
    db.prepare('UPDATE artists SET agg_dirty = 0').run();
    db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position, tag_name) VALUES (5, 20, 'main', 1, 'New Guy')").run();
    assert.deepEqual(dirty(), [20], 'an album credit flags the artist too');
  });

  test('an empty database migrates cleanly and the VA seed is keyed', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare("SELECT name_key, order_name FROM artists WHERE name = 'Various Artists'").get() },
      { name_key: 'various artists', order_name: 'various artists' });
  });
});
