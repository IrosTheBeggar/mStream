/**
 * Orphan cleanup correctness.
 *
 * cleanupOrphans() deletes albums/artists/genres no track references
 * anymore. The query was rewritten from `NOT IN (SELECT DISTINCT …)` to
 * correlated `NOT EXISTS` for performance; this guards the behaviour that
 * matters — that an artist referenced by ANY of the four paths
 * (tracks.artist_id, albums.artist_id, track_artists, album_artists) is
 * KEPT, and only genuinely unreferenced rows are deleted. Getting this
 * wrong would silently delete still-credited artists (e.g. the featured
 * half of an "A feat. B" collab), so it's worth a direct test.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { cleanupOrphans } from '../../src/db/orphan-cleanup.js';

const artistId = (db, name) => db.prepare('SELECT id FROM artists WHERE name = ?').get(name).id;
const has = (db, table, name) => !!db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name);

describe('cleanupOrphans', () => {
  test('keeps every reference path, deletes only unreferenced rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);

    db.prepare("INSERT INTO libraries (name, root_path, type) VALUES ('lib', '/x', 'music')").run();
    const libId = db.prepare("SELECT id FROM libraries WHERE name = 'lib'").get().id;

    // One artist per "kept" path + one true orphan.
    for (const n of ['ATrack', 'AAlbumPrimary', 'ATrackM2M', 'AAlbumM2M', 'AOrphan']) {
      db.prepare('INSERT INTO artists (name) VALUES (?)').run(n);
    }
    // Kept album (referenced by a track) with AAlbumPrimary as its
    // albums.artist_id; an orphan album referenced by nothing.
    db.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)')
      .run('AlbKept', artistId(db, 'AAlbumPrimary'), 2020);
    db.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)')
      .run('AlbOrphan', null, null);
    const albKept = db.prepare("SELECT id FROM albums WHERE name = 'AlbKept'").get().id;

    db.prepare('INSERT INTO genres (name) VALUES (?)').run('GKept');
    db.prepare('INSERT INTO genres (name) VALUES (?)').run('GOrphan');

    // A track: primary artist ATrack, album AlbKept, genre GKept.
    db.prepare('INSERT INTO tracks (filepath, library_id, artist_id, album_id) VALUES (?, ?, ?, ?)')
      .run('a.mp3', libId, artistId(db, 'ATrack'), albKept);
    const trackId = db.prepare("SELECT id FROM tracks WHERE filepath = 'a.mp3'").get().id;

    // Artists referenced ONLY through the M2M tables (the easy ones to get
    // wrong) — must survive.
    db.prepare("INSERT INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, 'featured', 1)")
      .run(trackId, artistId(db, 'ATrackM2M'));
    db.prepare("INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, 'main', 1)")
      .run(albKept, artistId(db, 'AAlbumM2M'));
    db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)')
      .run(trackId, db.prepare("SELECT id FROM genres WHERE name = 'GKept'").get().id);

    cleanupOrphans(db);

    for (const n of ['ATrack', 'AAlbumPrimary', 'ATrackM2M', 'AAlbumM2M']) {
      assert.ok(has(db, 'artists', n), `${n} is referenced and must be kept`);
    }
    assert.ok(!has(db, 'artists', 'AOrphan'), 'unreferenced artist must be deleted');
    assert.ok(has(db, 'albums', 'AlbKept'), 'referenced album must be kept');
    assert.ok(!has(db, 'albums', 'AlbOrphan'), 'unreferenced album must be deleted');
    assert.ok(has(db, 'genres', 'GKept'), 'referenced genre must be kept');
    assert.ok(!has(db, 'genres', 'GOrphan'), 'unreferenced genre must be deleted');

    db.close();
  });
});
