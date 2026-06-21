/**
 * Migration V31 schema-shape tests.
 *
 * Asserts that running every migration in sequence on a fresh in-memory
 * database lands at user_version = 31, creates the three FTS5 virtual
 * tables, and attaches the nine sync triggers. The mig runner itself
 * (src/db/manager.js → runMigrations()) is exercised indirectly by
 * other tests; here we apply the SQL directly so this test stays
 * deterministic and dependency-free.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations as applyMigrations } from '../helpers/apply-migrations.mjs';

// V34 introduced procedural migrations — see helpers/apply-migrations.mjs.
// Local wrapper for backwards-compat with this file's existing call sites.
function applyAllMigrations() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyMigrations(db);
  return db;
}

describe('V31 schema shape', () => {
  test('SCHEMA_VERSION constant is the latest migration version', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    assert.equal(SCHEMA_VERSION, last.version);
  });

  test('MIGRATIONS contains a v31 entry', () => {
    const v31 = MIGRATIONS.find(m => m.version === 31);
    assert.ok(v31, 'missing v31 migration');
    assert.ok(typeof v31.sql === 'string' && v31.sql.length > 0);
  });

  test('applying all migrations leaves user_version = SCHEMA_VERSION', () => {
    const db = applyAllMigrations();
    const v = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(v, SCHEMA_VERSION);
    db.close();
  });

  test('three FTS5 virtual tables exist', () => {
    const db = applyAllMigrations();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fts_tracks', 'fts_artists', 'fts_albums') ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(tables, ['fts_albums', 'fts_artists', 'fts_tracks']);
    db.close();
  });

  test('FTS5 tokenizer is unicode61 with diacritic folding (sanity probe)', () => {
    // Direct introspection of the tokenizer config string is awkward in
    // SQLite — easier to behave-test: insert "Sigur Rós", search "ros",
    // get a hit. If the diacritic-folding flag were off, this would
    // miss. Covered in more depth in db-fts5-backfill.test.mjs; this
    // is just a quick smoke check at the schema layer.
    const db = applyAllMigrations();
    db.prepare("INSERT INTO fts_artists(rowid, name) VALUES (?, ?)").run(100, 'Sigur Rós');
    const hits = db.prepare("SELECT rowid FROM fts_artists WHERE fts_artists MATCH 'ros'").all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rowid, 100);
    db.close();
  });

  test('all nine FTS sync triggers are attached', () => {
    const db = applyAllMigrations();
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_fts' ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(triggers, [
      'albums_ad_fts',
      'albums_ai_fts',
      'albums_au_fts',
      'artists_ad_fts',
      'artists_ai_fts',
      'artists_au_fts',
      'tracks_ad_fts',
      'tracks_ai_fts',
      'tracks_au_fts',
    ]);
    db.close();
  });

  test('UPDATE triggers watch the expected column allowlist on tracks', () => {
    // tracks_au_fts is declared AFTER UPDATE OF title, artist_id, album_id,
    // filepath. The DDL is what sqlite_master.sql exposes — pattern-match
    // on it as a defence against an accidental "AFTER UPDATE ON tracks"
    // (without the column list) regression in a future edit, which
    // would fire the trigger on every column write including user_metadata
    // cascades and burn FTS5 segment merges for no reason.
    const db = applyAllMigrations();
    const trigSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tracks_au_fts'"
    ).get().sql;
    assert.match(trigSql, /UPDATE OF title, artist_id, album_id, filepath/i);
    db.close();
  });

  test('artist/album UPDATE triggers watch OF name', () => {
    const db = applyAllMigrations();
    const artistSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='artists_au_fts'"
    ).get().sql;
    const albumSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='albums_au_fts'"
    ).get().sql;
    assert.match(artistSql, /UPDATE OF name/i);
    assert.match(albumSql, /UPDATE OF name/i);
    db.close();
  });
});
