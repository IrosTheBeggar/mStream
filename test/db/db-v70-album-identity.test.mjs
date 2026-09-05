/**
 * V70 album-identity migration: data survival, fragment merge, triggers.
 *
 * V70 rebuilds `albums` (dropping UNIQUE(name, artist_id, year), adding
 * album_key + the aggregate columns) with the V18-style TEMP-table dance,
 * because DROP TABLE under foreign_keys=ON fires FK actions on every child:
 *
 *   - tracks.album_id          (ON DELETE SET NULL, V1)
 *   - user_album_stars         (ON DELETE CASCADE,  V11)
 *   - album_artists            (ON DELETE CASCADE,  V18)
 *   - album_art                (ON DELETE CASCADE,  V48)
 *   - album_art_lookups        (ON DELETE CASCADE,  V51)
 *
 * It drops tracks_ai_fts / tracks_au_fts for the duration (the RENAME
 * re-validates trigger bodies; the SET NULL + restore would rewrite every
 * fts_tracks row), recreates them plus the albums_* FTS triggers, adds the
 * tracks_*_agg dirty-marking triggers, copies every row's `name:` key in
 * SQL, and the js hook merges rows that now share a key (per-year
 * fragments) into their survivor — tracks, stars, credits, art links,
 * lookups, art default — then creates the UNIQUE key index and back-fills
 * the aggregates.
 *
 * These tests build a populated V69 database and upgrade it under
 * foreign_keys=ON + recursive_triggers=ON exactly as the runner does.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function buildV69Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db, { upToVersion: 69 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 69);

  db.exec(`
    INSERT INTO libraries (id, name, root_path, type, follow_symlinks) VALUES (1, 'lib', '/lib', 'music', 0);
    INSERT INTO users (id, username, password, salt) VALUES (1, 'u1', 'x', 'x');
    INSERT INTO users (id, username, password, salt) VALUES (2, 'u2', 'x', 'x');
    INSERT INTO artists (id, name) VALUES (10, 'Aa'), (11, 'Bb');
    -- Two per-year fragments of one album (the V70 target case; the 1991
    -- fragment carries the art + a compilation flag the survivor lacks), a
    -- normal album, and a trackless starred ghost with a NULL year.
    INSERT INTO albums (id, name, artist_id, year, album_art_file, album_art_source, album_artist, compilation, mbz_release_group_id) VALUES
      (1, 'Hits', 10, 1987, NULL, NULL, 'Aa', 0, NULL),
      (2, 'Hits', 10, 1991, 'hits.jpg', 'musicbrainz', 'Aa', 1, 'rg-1'),
      (3, 'Solo', 10, 2000, NULL, NULL, NULL, 0, NULL),
      (4, 'Other', 11, NULL, NULL, NULL, NULL, 0, NULL);
    INSERT INTO tracks (id, filepath, library_id, title, artist_id, album_id, year, duration) VALUES
      (100, 'a/1.mp3', 1, 'H1', 10, 1, 1987, 100.5),
      (101, 'a/2.mp3', 1, 'H2', 10, 1, 1987, 200.25),
      (102, 'a/3.mp3', 1, 'H3', 10, 2, 1991, 50),
      (103, 'b/1.mp3', 1, 'S1', 10, 3, 2000, 10),
      (104, 'c/1.mp3', 1, 'N1', 11, NULL, NULL, 5);
    INSERT INTO user_album_stars (user_id, album_id, starred_at) VALUES
      (1, 1, '2024-01-05 00:00:00'), (1, 2, '2024-01-01 00:00:00'), (2, 2, '2024-01-02 00:00:00'),
      (1, 4, '2024-01-03 00:00:00');
    INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (1, 10, 'main', 0), (2, 10, 'main', 0);
    INSERT INTO art_files (id, kind, cache_file, byte_size, content_hash) VALUES (7, 'cached', 'feedface.jpeg', 1234, 'feedface');
    INSERT INTO album_art (album_id, art_id, source, picture_type, position) VALUES (2, 7, 'musicbrainz', 3, 0);
    INSERT INTO album_art_lookups (album_id, last_attempt_at, outcome, attempts, fetched_hash) VALUES (2, 1700000000, 'found', 1, 'feedface');
  `);
  return db;
}

function upgrade(db) {
  applyAllMigrations(db, { fromVersion: 69 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
}

// node:sqlite rows carry a null prototype; strict deepEqual wants plain objects.
const rows = (stmt, ...args) => stmt.all(...args).map(r => ({ ...r }));

describe('V70 albums rebuild', () => {
  test('non-colliding albums keep their ids and every child survives', () => {
    const db = buildV69Fixture();
    upgrade(db);

    assert.deepEqual(db.prepare('SELECT id FROM albums ORDER BY id').all().map(r => r.id), [1, 3, 4],
      'survivor + untouched rows keep their ids; the merged fragment is gone');
    assert.deepEqual(rows(db.prepare('SELECT id, album_id FROM tracks ORDER BY id')),
      [{ id: 100, album_id: 1 }, { id: 101, album_id: 1 }, { id: 102, album_id: 1 },
       { id: 103, album_id: 3 }, { id: 104, album_id: null }],
      'tracks.album_id restored (SET NULL cascade undone); the fragment\'s track moved to the survivor');
    assert.deepEqual(rows(db.prepare('SELECT user_id, album_id FROM user_album_stars ORDER BY album_id, user_id')),
      [{ user_id: 1, album_id: 1 }, { user_id: 2, album_id: 1 }, { user_id: 1, album_id: 4 }],
      'stars restored, the fragment\'s stars re-homed (user 1 deduped, user 2 moved)');
    assert.equal(db.prepare("SELECT starred_at FROM user_album_stars WHERE user_id = 1 AND album_id = 1").get().starred_at,
      '2024-01-01 00:00:00', 'union keeps the EARLIER starred_at');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM album_artists').get().c, 1, 'credits deduped onto the survivor');
    assert.deepEqual(rows(db.prepare('SELECT album_id, art_id, source FROM album_art')),
      [{ album_id: 1, art_id: 7, source: 'musicbrainz' }], 'gallery link carried to the survivor');
    assert.deepEqual(rows(db.prepare('SELECT album_id, outcome FROM album_art_lookups')),
      [{ album_id: 1, outcome: 'found' }], 'downloader lookup row carried to the survivor');
    const surv = db.prepare('SELECT album_art_file, album_art_source, mbz_release_group_id, compilation FROM albums WHERE id = 1').get();
    assert.equal(surv.album_art_file, 'hits.jpg', 'art default filled from the fragment');
    assert.equal(surv.album_art_source, 'musicbrainz');
    assert.equal(surv.mbz_release_group_id, 'rg-1', 'MBIDs filled from the fragment');
    assert.equal(surv.compilation, 0, 'compilation stays the survivor\'s until the refresh recomputes it');
    // No TEMP leftovers.
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_temp_master WHERE name LIKE '_v70_%'").get().c, 0);
  });

  test('keys are the exact-name form and unique', () => {
    const db = buildV69Fixture();
    upgrade(db);
    const keys = Object.fromEntries(db.prepare('SELECT id, album_key FROM albums').all().map(r => [r.id, r.album_key]));
    assert.deepEqual(keys, { 1: 'name:Hits|10', 3: 'name:Solo|10', 4: 'name:Other|11' });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_albums_key'").get().c, 1);
    assert.throws(
      () => db.prepare("INSERT INTO albums (name, artist_id, year, album_key) VALUES ('Hits', 10, 2001, 'name:Hits|10')").run(),
      /UNIQUE/, 'duplicate album_key rejected');
  });

  test('survivor election: most tracks wins, ties break on the lowest id', () => {
    // Fixture as built: album 1 (2 tracks) beats album 2 (1 track).
    let db = buildV69Fixture();
    upgrade(db);
    assert.deepEqual(db.prepare("SELECT id FROM albums WHERE name = 'Hits'").all().map(r => r.id), [1]);

    // Flip the counts: album 2 gets two tracks → it survives, id 1 goes.
    db = buildV69Fixture();
    db.prepare('UPDATE tracks SET album_id = 2 WHERE id = 101').run();
    upgrade(db);
    assert.deepEqual(db.prepare("SELECT id FROM albums WHERE name = 'Hits'").all().map(r => r.id), [2]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tracks WHERE album_id = 2').get().c, 3);

    // Equal counts → lowest id.
    db = buildV69Fixture();
    db.prepare('DELETE FROM tracks WHERE id = 101').run();
    upgrade(db);
    assert.deepEqual(db.prepare("SELECT id FROM albums WHERE name = 'Hits'").all().map(r => r.id), [1]);
  });

  test('aggregates are back-filled from tracks and the dirty flag is cleared', () => {
    const db = buildV69Fixture();
    upgrade(db);
    assert.deepEqual(rows(db.prepare('SELECT id, year, year_min, year_max, track_count, duration_total, agg_dirty FROM albums ORDER BY id')), [
      { id: 1, year: 1987, year_min: 1987, year_max: 1991, track_count: 3, duration_total: 350.75, agg_dirty: 0 },
      { id: 3, year: 2000, year_min: 2000, year_max: 2000, track_count: 1, duration_total: 10, agg_dirty: 0 },
      { id: 4, year: null, year_min: null, year_max: null, track_count: 0, duration_total: 0, agg_dirty: 0 },
    ]);
  });

  test('per-track consensus inputs are copied from the album each track sat on', () => {
    const db = buildV69Fixture();
    upgrade(db);
    assert.deepEqual(rows(db.prepare('SELECT id, tag_album, tag_album_artist, tag_compilation FROM tracks ORDER BY id')), [
      { id: 100, tag_album: 'Hits', tag_album_artist: 'Aa', tag_compilation: 0 },
      { id: 101, tag_album: 'Hits', tag_album_artist: 'Aa', tag_compilation: 0 },
      // Copied from the 1991 fragment BEFORE the merge — the fragment's own
      // compilation flag is what this track will vote with.
      { id: 102, tag_album: 'Hits', tag_album_artist: 'Aa', tag_compilation: 1 },
      { id: 103, tag_album: 'Solo', tag_album_artist: null, tag_compilation: 0 },
      { id: 104, tag_album: null, tag_album_artist: null, tag_compilation: 0 },
    ]);
  });

  test('the old UNIQUE(name, artist_id, year) is gone; NULL keys stay legal for fixtures', () => {
    const db = buildV69Fixture();
    upgrade(db);
    // Two releases of one album by one artist in one year — legal now
    // (distinct MBIDs), illegal before.
    db.prepare("INSERT INTO albums (name, artist_id, year, album_key) VALUES ('Twin', 10, 2001, 'mbid:aaa')").run();
    db.prepare("INSERT INTO albums (name, artist_id, year, album_key) VALUES ('Twin', 10, 2001, 'mbid:bbb')").run();
    db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('NoKey', 10, 2001)").run();
    db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('NoKey', 10, 2001)").run();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM albums WHERE album_key IS NULL").get().c, 2);
    const acols = db.prepare('PRAGMA table_info(albums)').all().map(c => c.name);
    for (const c of ['album_key', 'year_min', 'year_max', 'track_count', 'duration_total', 'agg_dirty']) {
      assert.ok(acols.includes(c), `albums.${c} added`);
    }
  });

  test('FTS triggers are recreated and the index content is intact', () => {
    const db = buildV69Fixture();
    upgrade(db);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);
    for (const t of ['albums_ai_fts', 'albums_ad_fts', 'albums_au_fts', 'tracks_ai_fts', 'tracks_ad_fts', 'tracks_au_fts',
      'tracks_ai_agg', 'tracks_ad_agg', 'tracks_au_agg']) {
      assert.ok(triggers.includes(t), `${t} present after the rebuild`);
    }
    // The SET NULL + restore ran with tracks_au_fts dropped — the FTS rows
    // must still carry their album names (never nulled, never rewritten).
    assert.equal(db.prepare("SELECT album_name FROM fts_tracks WHERE rowid = 100").get().album_name, 'Hits');
    assert.equal(db.prepare("SELECT album_name FROM fts_tracks WHERE rowid = 103").get().album_name, 'Solo');
    // The merged fragment's fts_albums row is gone; the survivor's stays.
    assert.equal(db.prepare("SELECT COUNT(*) c FROM fts_albums WHERE fts_albums MATCH 'Hits'").get().c, 1);
    // ...and the recreated triggers still fan out.
    db.prepare("UPDATE albums SET name = 'Greatest Hits' WHERE id = 1").run();
    assert.equal(db.prepare("SELECT album_name FROM fts_tracks WHERE rowid = 102").get().album_name, 'Greatest Hits',
      'albums_au_fts fan-out reaches the moved track too');
    db.prepare("UPDATE tracks SET title = 'Renamed' WHERE id = 103").run();
    assert.equal(db.prepare("SELECT title FROM fts_tracks WHERE rowid = 103").get().title, 'Renamed', 'tracks_au_fts');
  });

  test('the tracks_*_agg triggers flag albums on insert, album move, consensus-input change and delete', () => {
    const db = buildV69Fixture();
    upgrade(db);
    const dirty = () => db.prepare('SELECT id FROM albums WHERE agg_dirty = 1 ORDER BY id').all().map(r => r.id);
    const clear = () => db.prepare('UPDATE albums SET agg_dirty = 0').run();
    assert.deepEqual(dirty(), [], 'clean after the migration');

    db.prepare("INSERT INTO tracks (id, filepath, library_id, title, album_id, year) VALUES (200, 'x/1.mp3', 1, 'X', 3, 2001)").run();
    assert.deepEqual(dirty(), [3], 'insert flags the album');
    clear();
    db.prepare('UPDATE tracks SET album_id = 1 WHERE id = 200').run();
    assert.deepEqual(dirty(), [1, 3], 'a move flags both the old and the new album');
    clear();
    db.prepare('UPDATE tracks SET album_id = NULL WHERE id = 200').run();
    assert.deepEqual(dirty(), [1], 'leaving to NO album still flags the album left');
    clear();
    db.prepare("UPDATE tracks SET tag_compilation = 1 WHERE id = 103").run();
    assert.deepEqual(dirty(), [3], 'a consensus-input change flags the album');
    clear();
    db.prepare("UPDATE tracks SET title = 'no effect' WHERE id = 103").run();
    assert.deepEqual(dirty(), [], 'unrelated columns do not');
    db.prepare('DELETE FROM tracks WHERE id = 103').run();
    assert.deepEqual(dirty(), [3], 'delete flags the album');
    clear();
    // The guard: a second write to an already-dirty album is a no-op, and
    // an album-less track touches nothing.
    db.prepare("INSERT INTO tracks (id, filepath, library_id, title) VALUES (201, 'x/2.mp3', 1, 'Y')").run();
    assert.deepEqual(dirty(), []);
  });

  test('an empty database migrates cleanly', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM albums').get().c, 0);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  });
});
