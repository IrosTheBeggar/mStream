/**
 * V72 migration: tracks.artist_display + credit roles in track_artists.
 *
 * ADD COLUMN only, no hook — the test pins the shape a V71 database ends up
 * in, that legacy rows carry a NULL display (the API falls back to the
 * primary artist's name until the forced rescan), and that the M2M table
 * accepts the new role values alongside a performer credit for the same
 * artist (the PK is (track, artist, role)).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, SCANNER_SCHEMA_CONTRACT, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function buildV71Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, { upToVersion: 71 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 71);
  db.exec(`
    INSERT INTO libraries (id, name, root_path, type, follow_symlinks) VALUES (1, 'lib', '/lib', 'music', 0);
    INSERT INTO artists (id, name) VALUES (10, 'Solo'), (11, 'Writer');
    INSERT INTO tracks (id, filepath, library_id, title, artist_id, duration) VALUES (100, 'a/1.mp3', 1, 'T1', 10, 10);
    INSERT INTO track_artists (track_id, artist_id, role, position, tag_name) VALUES (100, 10, 'main', 0, 'Solo');
  `);
  return db;
}

describe('V72 — artist_display + credit roles', () => {
  test('adds tracks.artist_display; legacy rows keep NULL; version + contract advance together', () => {
    const db = buildV71Fixture();
    applyAllMigrations(db, { fromVersion: 71 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 72);
    assert.ok(SCANNER_SCHEMA_CONTRACT >= 72, 'the scanners write a new column → the contract moves with it');
    const cols = db.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    assert.ok(cols.includes('artist_display'));
    assert.equal(db.prepare('SELECT artist_display FROM tracks WHERE id = 100').get().artist_display, null);
    const entry = MIGRATIONS.find((m) => m.version === 72);
    assert.equal(entry.rescanRequired, true, 'display strings and roles come from tags');
    assert.equal(entry.js, undefined, 'no hook — ADD COLUMN only');
  });

  test('track_artists takes the new roles next to a performer credit for the same artist', () => {
    const db = buildV71Fixture();
    applyAllMigrations(db, { fromVersion: 71 });
    const ins = db.prepare('INSERT INTO track_artists (track_id, artist_id, role, position, tag_name) VALUES (?, ?, ?, ?, ?)');
    ins.run(100, 10, 'composer', 0, 'Solo');        // performer AND composer
    ins.run(100, 11, 'composer', 1, 'Writer');
    ins.run(100, 11, 'lyricist', 0, 'Writer');
    assert.deepEqual(
      db.prepare('SELECT artist_id, role, position FROM track_artists WHERE track_id = 100 ORDER BY role, position').all()
        .map((r) => ({ ...r })),
      [
        { artist_id: 10, role: 'composer', position: 0 },
        { artist_id: 11, role: 'composer', position: 1 },
        { artist_id: 11, role: 'lyricist', position: 0 },
        { artist_id: 10, role: 'main', position: 0 },
      ]);
    // The V71 dirty triggers cover every role: the artists were flagged.
    assert.deepEqual(db.prepare('SELECT id FROM artists WHERE agg_dirty = 1 ORDER BY id').all().map((r) => r.id), [10, 11]);
    // Deleting the track cascades every credit row.
    db.prepare('DELETE FROM tracks WHERE id = 100').run();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM track_artists').get().c, 0);
  });
});
