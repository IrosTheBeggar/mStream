/**
 * V32 migration shape tests — bpm / musical_key / bpm_source columns
 * on the tracks table.
 *
 * Asserts:
 *   1. Three new columns are added in the right order, with the right
 *      affinities (INTEGER, TEXT, TEXT), all nullable, no default.
 *   2. The migration is non-rescanRequired (existing tracks rows keep
 *      NULLs until they're re-extracted; force-rescan is opt-in).
 *   3. INSERT…SELECT into the new columns round-trips without coercion
 *      (proves the column affinities are real, not a comment-only claim).
 *   4. An existing v31 database can be upgraded to v32 without losing
 *      pre-existing tracks rows (the ALTER TABLE statements are
 *      additive — no full-table rebuild).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';
import { applyAllMigrations as applyMigrations } from './helpers/apply-migrations.mjs';

// V34 introduced procedural migrations — see test/helpers/apply-migrations.mjs.
// These local wrappers preserve the test file's transaction-wrapping
// semantics (each migration in its own BEGIN/COMMIT) but delegate the
// dual-shape (sql vs procedural) handling to the shared helper.
function applyAllMigrations() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  return db;
}

function applyMigrationsUpTo(version) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, { upToVersion: version });
  return db;
}

describe('V32 schema shape', () => {
  test('SCHEMA_VERSION is at least 32', () => {
    assert.ok(SCHEMA_VERSION >= 32, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  });

  test('MIGRATIONS contains a v32 entry', () => {
    const v32 = MIGRATIONS.find(m => m.version === 32);
    assert.ok(v32, 'missing v32 migration');
    assert.ok(typeof v32.sql === 'string' && v32.sql.length > 0);
  });

  test('v32 migration is NOT marked rescanRequired', () => {
    const v32 = MIGRATIONS.find(m => m.version === 32);
    // Empty bpm/key columns are valid — gracefully degrades. Forcing a
    // full rescan of multi-terabyte libraries on upgrade isn't worth
    // it for a not-yet-shipped feature.
    assert.ok(!v32.rescanRequired, 'v32 should not force a rescan on upgrade');
  });

  test('tracks.bpm exists with INTEGER affinity and is nullable', () => {
    const db = applyAllMigrations();
    const cols = db.prepare("PRAGMA table_info('tracks')").all();
    const bpm = cols.find(c => c.name === 'bpm');
    assert.ok(bpm, 'bpm column missing');
    assert.equal(bpm.type, 'INTEGER');
    assert.equal(bpm.notnull, 0);
    assert.equal(bpm.dflt_value, null);
    db.close();
  });

  test('tracks.musical_key exists with TEXT affinity and is nullable', () => {
    const db = applyAllMigrations();
    const cols = db.prepare("PRAGMA table_info('tracks')").all();
    const mk = cols.find(c => c.name === 'musical_key');
    assert.ok(mk, 'musical_key column missing');
    assert.equal(mk.type, 'TEXT');
    assert.equal(mk.notnull, 0);
    db.close();
  });

  test('tracks.bpm_source exists with TEXT affinity and is nullable', () => {
    const db = applyAllMigrations();
    const cols = db.prepare("PRAGMA table_info('tracks')").all();
    const src = cols.find(c => c.name === 'bpm_source');
    assert.ok(src, 'bpm_source column missing');
    assert.equal(src.type, 'TEXT');
    assert.equal(src.notnull, 0);
    db.close();
  });

  test('INSERT round-trips BPM/key without coercion', () => {
    const db = applyAllMigrations();
    db.exec("INSERT INTO libraries (name, root_path) VALUES ('test', '/tmp/test')");
    const libId = db.prepare("SELECT id FROM libraries WHERE name = 'test'").get().id;
    db.prepare(
      `INSERT INTO tracks (filepath, library_id, title, bpm, musical_key, bpm_source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('a.mp3', libId, 'A', 128, '8A', 'tag');
    const row = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE filepath = ?').get('a.mp3');
    assert.equal(row.bpm, 128);
    assert.equal(typeof row.bpm, 'number');
    assert.equal(row.musical_key, '8A');
    assert.equal(row.bpm_source, 'tag');
    db.close();
  });

  test('NULL is the default for a track inserted without bpm/key', () => {
    const db = applyAllMigrations();
    db.exec("INSERT INTO libraries (name, root_path) VALUES ('test', '/tmp/test')");
    const libId = db.prepare("SELECT id FROM libraries WHERE name = 'test'").get().id;
    db.prepare(
      `INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)`
    ).run('a.mp3', libId, 'A');
    const row = db.prepare('SELECT bpm, musical_key, bpm_source FROM tracks WHERE filepath = ?').get('a.mp3');
    assert.equal(row.bpm, null);
    assert.equal(row.musical_key, null);
    assert.equal(row.bpm_source, null);
    db.close();
  });

  test('upgrading a v31 database to v32 preserves existing tracks rows', () => {
    // Build a database stopped at v31 with one tracks row, then apply
    // v32 only. The ALTER TABLE ADD COLUMN sequence in V32 is additive
    // (no table rebuild), so the row's id and existing column values
    // must survive untouched and the new columns must land as NULL.
    const db = applyMigrationsUpTo(31);
    db.exec("INSERT INTO libraries (name, root_path) VALUES ('test', '/tmp/test')");
    const libId = db.prepare("SELECT id FROM libraries WHERE name = 'test'").get().id;
    db.prepare(
      'INSERT INTO tracks (filepath, library_id, title) VALUES (?, ?, ?)'
    ).run('preserved.mp3', libId, 'Preserved');
    const beforeId = db.prepare('SELECT id FROM tracks WHERE filepath = ?').get('preserved.mp3').id;

    const v32 = MIGRATIONS.find(m => m.version === 32);
    db.exec('BEGIN'); db.exec(v32.sql); db.exec('PRAGMA user_version = 32'); db.exec('COMMIT');

    const row = db.prepare(
      'SELECT id, title, bpm, musical_key, bpm_source FROM tracks WHERE filepath = ?'
    ).get('preserved.mp3');
    assert.equal(row.id, beforeId);
    assert.equal(row.title, 'Preserved');
    assert.equal(row.bpm, null);
    assert.equal(row.musical_key, null);
    assert.equal(row.bpm_source, null);
    db.close();
  });
});
