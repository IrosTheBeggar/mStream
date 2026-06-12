/**
 * V18 albums-rebuild data-survival tests.
 *
 * V18 rebuilds the albums table with the DROP TABLE + rename pattern.
 * The migration runner (src/db/manager.js) sets PRAGMA foreign_keys=ON
 * before migrating, and DROP TABLE under foreign_keys=ON performs an
 * implicit DELETE FROM that FIRES foreign-key actions on child tables.
 * At V18 time albums has two children:
 *
 *   - tracks.album_id        (ON DELETE SET NULL, V1)
 *   - user_album_stars       (ON DELETE CASCADE,  V11)
 *
 * The original V18 shipped without protection: every upgrade from
 * user_version <= 17 nulled all track→album links (masked by the forced
 * rescan) and permanently cascade-deleted all album stars (NOT masked —
 * the album-migration remap helper can't see rows that are already
 * gone). V18 now does the V24-style TEMP-table dance: snapshot the
 * child data, let the drop fire, restore after the rename. These tests
 * pin that behavior by building a populated V17 fixture and upgrading
 * it under foreign_keys=ON, exactly as the runner does.
 *
 * Rewriting the shipped V18 in place is safe: the runner only applies
 * migrations with version > user_version, so any DB that already ran
 * the lossy V18 never sees the new text — only DBs still at <= 17
 * (which would otherwise lose data fresh on every upgrade) get it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

// Build a V17 database holding the fixture rows the V18 drop would
// clobber: two albums, tracks pointing at them, album stars for two
// users, and an artist star (control — artists are never dropped).
function buildV17Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, { upToVersion: 17 });

  db.exec(`
    INSERT INTO users (id, username, password, salt) VALUES
      (1, 'alice', 'x', 'x'),
      (2, 'bob',   'x', 'x');
    INSERT INTO libraries (id, name, root_path) VALUES (1, 'music', '/music');
    INSERT INTO artists (id, name) VALUES (1, 'Artist A'), (2, 'Artist B');
    INSERT INTO albums (id, name, artist_id, year, album_art_file) VALUES
      (10, 'Album One', 1, 1990, 'one.jpg'),
      (20, 'Album Two', 2, 2005, NULL);
    INSERT INTO tracks (id, filepath, library_id, title, artist_id, album_id) VALUES
      (100, 'a/1.mp3', 1, 'Track 1', 1, 10),
      (101, 'a/2.mp3', 1, 'Track 2', 1, 10),
      (102, 'b/1.mp3', 1, 'Track 3', 2, 20),
      (103, 'loose.mp3', 1, 'No Album', 2, NULL);
    INSERT INTO user_album_stars (user_id, album_id, starred_at) VALUES
      (1, 10, '2020-01-01 00:00:00'),
      (1, 20, '2021-02-02 00:00:00'),
      (2, 10, '2022-03-03 00:00:00');
    INSERT INTO user_artist_stars (user_id, artist_id, starred_at) VALUES
      (1, 2, '2020-06-06 00:00:00');
  `);
  return db;
}

// ── Schema shape ────────────────────────────────────────────────────────────

describe('V18 schema shape', () => {
  test('MIGRATIONS contains a v18 entry that does the TEMP-table dance', () => {
    const v18 = MIGRATIONS.find(m => m.version === 18);
    assert.ok(v18, 'missing v18 migration');
    assert.equal(typeof v18.sql, 'string');
    assert.match(v18.sql, /CREATE TEMP TABLE _v18_album_stars_backup/i);
    assert.match(v18.sql, /CREATE TEMP TABLE _v18_track_album_backup/i);
    assert.match(v18.sql, /INSERT INTO user_album_stars SELECT \* FROM _v18_album_stars_backup/i);
  });

  test('v18 IS marked rescanRequired (album_artists/track_artists need tags)', () => {
    const v18 = MIGRATIONS.find(m => m.version === 18);
    assert.ok(v18.rescanRequired, 'V18 must force a rescan');
  });
});

// ── Data survival across the V17 → V18 upgrade ─────────────────────────────

describe('V18 albums rebuild under foreign_keys=ON', () => {
  test('tracks.album_id survives the rebuild', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    const links = db.prepare(
      'SELECT id, album_id FROM tracks ORDER BY id'
    ).all().map(r => [r.id, r.album_id]);
    assert.deepEqual(links, [[100, 10], [101, 10], [102, 20], [103, null]]);
    db.close();
  });

  test('user_album_stars rows survive verbatim', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    const stars = db.prepare(
      'SELECT user_id, album_id, starred_at FROM user_album_stars ORDER BY user_id, album_id'
    ).all().map(r => [r.user_id, r.album_id, r.starred_at]);
    assert.deepEqual(stars, [
      [1, 10, '2020-01-01 00:00:00'],
      [1, 20, '2021-02-02 00:00:00'],
      [2, 10, '2022-03-03 00:00:00'],
    ]);
    db.close();
  });

  test('user_artist_stars is untouched (artists are never dropped)', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    const stars = db.prepare(
      'SELECT user_id, artist_id, starred_at FROM user_artist_stars'
    ).all();
    assert.equal(stars.length, 1);
    assert.equal(stars[0].artist_id, 2);
    db.close();
  });

  test('albums rows keep their ids, data, and gain the new columns', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    const albums = db.prepare(
      'SELECT id, name, artist_id, year, album_art_file, album_artist, compilation FROM albums ORDER BY id'
    ).all();
    assert.deepEqual(albums.map(a => [a.id, a.name, a.artist_id, a.year, a.album_art_file]), [
      [10, 'Album One', 1, 1990, 'one.jpg'],
      [20, 'Album Two', 2, 2005, null],
    ]);
    for (const a of albums) {
      assert.equal(a.album_artist, null, 'album_artist starts NULL until rescan');
      assert.equal(a.compilation, 0, 'compilation defaults to 0');
    }
    db.close();
  });

  test('no _v18_* TEMP tables leak past the migration', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    const leftovers = db.prepare(
      "SELECT name FROM temp.sqlite_master WHERE name LIKE '_v18_%'"
    ).all();
    assert.deepEqual(leftovers, []);
    db.close();
  });

  test('FK actions on user_album_stars still work after the rebuild', () => {
    // The restored table must still cascade normally — deleting an album
    // post-migration removes its stars, deleting a user removes theirs.
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17, upToVersion: 18 });

    db.exec('DELETE FROM albums WHERE id = 10');
    const left = db.prepare(
      'SELECT user_id, album_id FROM user_album_stars'
    ).all();
    assert.deepEqual(left.map(r => [r.user_id, r.album_id]), [[1, 20]]);
    db.close();
  });
});

// ── Full-chain upgrade ──────────────────────────────────────────────────────

describe('V17 fixture through the full migration chain', () => {
  test('stars and album links survive V17 → SCHEMA_VERSION', () => {
    const db = buildV17Fixture();
    applyAllMigrations(db, { fromVersion: 17 });

    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);

    const stars = db.prepare(
      'SELECT user_id, album_id FROM user_album_stars ORDER BY user_id, album_id'
    ).all().map(r => [r.user_id, r.album_id]);
    assert.deepEqual(stars, [[1, 10], [1, 20], [2, 10]]);

    const links = db.prepare(
      'SELECT id, album_id FROM tracks ORDER BY id'
    ).all().map(r => [r.id, r.album_id]);
    assert.deepEqual(links, [[100, 10], [101, 10], [102, 20], [103, null]]);
    db.close();
  });
});
