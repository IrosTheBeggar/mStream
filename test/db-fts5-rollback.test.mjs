/**
 * V31 rollback path tests.
 *
 * Three things matter for SCHEMA_V31_DOWN:
 *
 *   1. Idempotency — the down SQL must run cleanly on a v30 DB (every
 *      DROP is "IF EXISTS"), so a second rollback or a rollback against
 *      a never-upgraded DB doesn't crash.
 *
 *   2. Reversibility — running V31 up, then V31 down, must restore the
 *      v30 surface byte-for-byte: user_version = 30, no fts_* objects,
 *      and crucially no data loss in tracks/artists/albums (the
 *      tabletop concern with any rollback).
 *
 *   3. Re-application — after a down, running V31 up again must produce
 *      a working FTS index with correct backfill. This catches a class
 *      of bugs where the up path silently relies on some artefact of
 *      the original up that the down also cleared.
 *
 * The script wrapper (scripts/rollback-v31.js) is exercised separately
 * by running the production DB-rollback path; this test focuses on the
 * SQL itself so failures localise to schema.js rather than the script.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_V31_DOWN } from '../src/db/schema.js';

function freshDbV30() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  for (const m of MIGRATIONS) {
    if (m.version > 30) break;
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
  return db;
}

function applyV31(db) {
  const v31 = MIGRATIONS.find(m => m.version === 31);
  if (!v31) throw new Error('V31 not in MIGRATIONS');
  db.exec('BEGIN');
  db.exec(v31.sql);
  db.exec('PRAGMA user_version = 31');
  db.exec('COMMIT');
}

function applyV31Down(db) {
  db.exec('BEGIN');
  db.exec(SCHEMA_V31_DOWN);
  db.exec('COMMIT');
}

function countFtsObjects(db) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'fts_%' OR name LIKE '%_fts'"
  ).get().c;
}

function seedSomeData(db) {
  db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music');
  const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Aphex Twin').lastInsertRowid);
  const albid = Number(db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)').run('Selected Ambient Works 85-92', aid).lastInsertRowid);
  db.prepare('INSERT INTO tracks (filepath, library_id, title, artist_id, album_id) VALUES (?, 1, ?, ?, ?)')
    .run('at/saw.flac', 'Xtal', aid, albid);
}

describe('V31 rollback (SCHEMA_V31_DOWN)', () => {
  test('idempotency: running down on a v30 DB is a no-op (no FTS objects to drop)', () => {
    const db = freshDbV30();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 30);
    assert.equal(countFtsObjects(db), 0);
    // No error thrown — every DROP is IF EXISTS.
    applyV31Down(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 30);
    assert.equal(countFtsObjects(db), 0);
    db.close();
  });

  test('up → down: clears all fts_* objects and resets user_version to 30', () => {
    const db = freshDbV30();
    seedSomeData(db);
    applyV31(db);

    // Spot-check: up actually created the things we expect to clean up.
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 31);
    assert.ok(countFtsObjects(db) > 0);
    const triggersBefore = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name LIKE '%_fts'"
    ).get().c;
    assert.equal(triggersBefore, 9);

    applyV31Down(db);

    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 30);
    assert.equal(countFtsObjects(db), 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name LIKE '%_fts'").get().c,
      0,
    );
    db.close();
  });

  test('up → down preserves all tracks/artists/albums row data', () => {
    const db = freshDbV30();
    seedSomeData(db);

    const tracksBefore   = db.prepare('SELECT id, filepath, title FROM tracks ORDER BY id').all();
    const artistsBefore  = db.prepare('SELECT id, name FROM artists ORDER BY id').all();
    const albumsBefore   = db.prepare('SELECT id, name FROM albums ORDER BY id').all();

    applyV31(db);
    applyV31Down(db);

    const tracksAfter  = db.prepare('SELECT id, filepath, title FROM tracks ORDER BY id').all();
    const artistsAfter = db.prepare('SELECT id, name FROM artists ORDER BY id').all();
    const albumsAfter  = db.prepare('SELECT id, name FROM albums ORDER BY id').all();

    // Use length + per-row eq to avoid null-prototype deepEqual pitfalls.
    assert.equal(tracksAfter.length, tracksBefore.length);
    for (let i = 0; i < tracksBefore.length; i++) {
      assert.equal(tracksAfter[i].id, tracksBefore[i].id);
      assert.equal(tracksAfter[i].filepath, tracksBefore[i].filepath);
      assert.equal(tracksAfter[i].title, tracksBefore[i].title);
    }
    assert.equal(artistsAfter.length, artistsBefore.length);
    for (let i = 0; i < artistsBefore.length; i++) {
      assert.equal(artistsAfter[i].name, artistsBefore[i].name);
    }
    assert.equal(albumsAfter.length, albumsBefore.length);
    for (let i = 0; i < albumsBefore.length; i++) {
      assert.equal(albumsAfter[i].name, albumsBefore[i].name);
    }
    db.close();
  });

  test('up → down → up restores a working FTS index with correct backfill', () => {
    const db = freshDbV30();
    seedSomeData(db);

    applyV31(db);
    applyV31Down(db);
    applyV31(db);

    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 31);

    // The repeated up must rebuild from source rows — assert backfill
    // produced the right thing for our seed data.
    const trackRow = db.prepare('SELECT title, artist_name, album_name, filepath FROM fts_tracks').get();
    assert.equal(trackRow?.title, 'Xtal');
    assert.equal(trackRow?.artist_name, 'Aphex Twin');
    assert.equal(trackRow?.album_name, 'Selected Ambient Works 85-92');
    assert.equal(trackRow?.filepath, 'at/saw.flac');

    // And MATCH works (i.e. the FTS5 index actually got populated).
    const hits = db.prepare("SELECT title FROM fts_tracks WHERE fts_tracks MATCH 'aphex'").all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Xtal');
    db.close();
  });

  test('after down, INSERTs into tracks/artists/albums succeed without trigger errors', () => {
    // Once the triggers are dropped, the source tables must remain
    // fully writable. If any FK or trigger remnant blocks writes,
    // operators who roll back will find their server can't take
    // scan updates.
    const db = freshDbV30();
    applyV31(db);
    applyV31Down(db);

    db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music');
    const aid = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('Post-Rollback').lastInsertRowid);
    db.prepare('INSERT INTO tracks (filepath, library_id, title, artist_id) VALUES (?, 1, ?, ?)')
      .run('p.flac', 'After', aid);

    // And no fts_tracks table exists to receive a trigger-driven write.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'fts_tracks'").get().c,
      0,
    );
    db.close();
  });
});
