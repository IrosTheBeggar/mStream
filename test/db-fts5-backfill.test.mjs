/**
 * V31 backfill correctness tests.
 *
 * Scenario: a v30 database has accumulated tracks/artists/albums. When
 * the v31 migration runs, the FTS5 tables are created and immediately
 * backfilled from the existing rows. Verify counts match the source
 * tables, indexed text is queryable, diacritic folding works, and
 * NULL FKs survive (LEFT JOIN in the backfill is what makes that
 * work).
 *
 * Test strategy: stop the migration runner at v30, seed deterministic
 * fixture data with known names, then apply v31 in isolation and
 * inspect the resulting FTS state.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from '../src/db/schema.js';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

// V34 introduced procedural migrations — see helpers/apply-migrations.mjs.
function applyMigrationsUpTo(db, maxVersion) {
  applyAllMigrations(db, { upToVersion: maxVersion });
}

function getV31() {
  const v31 = MIGRATIONS.find(m => m.version === 31);
  if (!v31) throw new Error('V31 migration not found');
  return v31;
}

// Seed fixture: 5 artists × 4 albums × ~2-3 tracks each = ~50 tracks.
// Names chosen to exercise MATCH (multi-word, diacritics, prefix).
const FIXTURE_ARTISTS = [
  'Pink Floyd',
  'Sigur Rós',
  'Daft Punk',
  'The Beatles',
  'Massive Attack',
];

function seedV30(db) {
  // V21 added libraries.follow_symlinks default 0, so this insert is fine.
  const libRes = db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music');
  const libId = Number(libRes.lastInsertRowid);

  const artistIds = new Map();
  const insArtist = db.prepare('INSERT INTO artists (name) VALUES (?)');
  for (const name of FIXTURE_ARTISTS) {
    const res = insArtist.run(name);
    artistIds.set(name, Number(res.lastInsertRowid));
  }

  let trackCount = 0;
  const insAlbum = db.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)');
  const insTrack = db.prepare('INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, track_number) VALUES (?, ?, ?, ?, ?, ?)');
  for (const artistName of FIXTURE_ARTISTS) {
    const artistId = artistIds.get(artistName);
    for (let alb = 1; alb <= 4; alb++) {
      const albumName = `${artistName} Album ${alb}`;
      const res = insAlbum.run(albumName, artistId, 2000 + alb);
      const albumId = Number(res.lastInsertRowid);
      const trackTotal = 2 + (alb % 2); // 2 or 3 tracks per album
      for (let t = 1; t <= trackTotal; t++) {
        const title = `${artistName} Song ${alb}-${t}`;
        const filepath = `${artistName}/${albumName}/${t}.flac`;
        insTrack.run(filepath, libId, title, artistId, albumId, t);
        trackCount++;
      }
    }
  }
  return { trackCount, artistCount: FIXTURE_ARTISTS.length, albumCount: FIXTURE_ARTISTS.length * 4 };
}

describe('V31 backfill', () => {
  test('FTS row counts match the source table counts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    const { trackCount, albumCount } = seedV30(db);
    // V18 seeds "Various Artists" in addition to our fixture artists.
    const artistsInDb = db.prepare('SELECT COUNT(*) AS c FROM artists').get().c;

    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_tracks').get().c, trackCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_artists').get().c, artistsInDb);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fts_albums').get().c, albumCount);
    db.close();
  });

  test("MATCH 'pink' returns Pink Floyd's tracks via denormalised artist_name", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    seedV30(db);
    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    const trackHits = db.prepare(
      "SELECT title, artist_name FROM fts_tracks WHERE fts_tracks MATCH 'pink' ORDER BY rowid"
    ).all();
    // Pink Floyd has 4 albums × (2 or 3 tracks) = 10 tracks in the fixture.
    assert.equal(trackHits.length, 10);
    for (const hit of trackHits) {
      assert.equal(hit.artist_name, 'Pink Floyd');
    }

    const artistHits = db.prepare(
      "SELECT name FROM fts_artists WHERE fts_artists MATCH 'pink'"
    ).all();
    assert.equal(artistHits.length, 1);
    assert.equal(artistHits[0].name, 'Pink Floyd');
    db.close();
  });

  test("diacritic folding: MATCH 'ros' finds 'Sigur Rós'", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    seedV30(db);
    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    const hits = db.prepare(
      "SELECT name FROM fts_artists WHERE fts_artists MATCH 'ros'"
    ).all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'Sigur Rós');
    db.close();
  });

  test("prefix MATCH 'mass*' finds Massive Attack tracks", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    seedV30(db);
    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    const hits = db.prepare(
      "SELECT artist_name FROM fts_tracks WHERE fts_tracks MATCH 'mass*'"
    ).all();
    assert.equal(hits.length, 10);
    assert.ok(hits.every(h => h.artist_name === 'Massive Attack'));
    db.close();
  });

  test('tracks with NULL artist_id / album_id (FK SET NULL leftovers) backfill cleanly', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    // Seed a library + one orphan track.
    const libId = Number(db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music').lastInsertRowid);
    db.prepare(
      'INSERT INTO tracks (filepath, library_id, title, artist_id, album_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('orphan.flac', libId, 'Lone Track');

    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    const row = db.prepare(
      "SELECT title, artist_name, album_name, filepath FROM fts_tracks"
    ).get();
    assert.equal(row.title, 'Lone Track');
    assert.equal(row.artist_name, null);
    assert.equal(row.album_name, null);
    assert.equal(row.filepath, 'orphan.flac');

    // And the track is still searchable by title even with NULL parents.
    const hits = db.prepare(
      "SELECT title FROM fts_tracks WHERE fts_tracks MATCH 'lone'"
    ).all();
    assert.equal(hits.length, 1);
    db.close();
  });

  test('rowid matches the source primary key for each FTS table', () => {
    // The triggers in steady-state use INSERT INTO fts_X(rowid, ...) with
    // NEW.id — this only works if backfill also keys on tracks.id /
    // artists.id / albums.id. A "rowid=ROWID()" backfill would line up
    // by coincidence on a fresh DB but break for any DB where ids
    // aren't contiguous (e.g. after deletes). Pin it down here.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyMigrationsUpTo(db, 30);
    // Insert then delete the first artist, so subsequent ids skip 2.
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('Deleted');
    db.prepare('DELETE FROM artists WHERE name = ?').run('Deleted');
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('First');
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('Second');
    const ids = db.prepare("SELECT id, name FROM artists WHERE name IN ('First','Second') ORDER BY id").all();

    const v31 = getV31();
    db.exec('BEGIN'); db.exec(v31.sql); db.exec('PRAGMA user_version = 31'); db.exec('COMMIT');

    for (const a of ids) {
      const fts = db.prepare("SELECT rowid, name FROM fts_artists WHERE rowid = ?").get(a.id);
      assert.equal(fts?.name, a.name, `rowid ${a.id} should map to ${a.name}`);
    }
    db.close();
  });
});
