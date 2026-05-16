/**
 * V36 migration tests: tracks.source provenance column.
 *
 * V36 adds an open-enum TEXT column on `tracks` recording which code
 * path wrote the row. Only the ytdl handler populates it today ('ytdl').
 * NULL for every pre-existing row and for scanner-discovered tracks
 * without a recognised provenance tag.
 *
 * Covers:
 *   - Schema shape: V36 in MIGRATIONS, user_version advances, column
 *     present with TEXT affinity, no default, nullable.
 *   - Idempotency: applying migrations twice is a no-op.
 *   - V36_DOWN drops the column and resets user_version to 35.
 *   - INSERT round-trip with explicit value, NULL, and the schema's
 *     default-of-NULL on pre-existing-shape statements.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  SCHEMA_VERSION, MIGRATIONS, SCHEMA_V36_DOWN,
} from '../src/db/schema.js';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function getColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === column);
}

// ── Schema shape ────────────────────────────────────────────────────────────

describe('V36 schema shape', () => {
  test('SCHEMA_VERSION is at least 36', () => {
    assert.ok(SCHEMA_VERSION >= 36, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  });

  test('MIGRATIONS contains a v36 entry with a SQL string', () => {
    const v36 = MIGRATIONS.find(m => m.version === 36);
    assert.ok(v36, 'missing v36 migration');
    assert.equal(typeof v36.sql, 'string');
    assert.match(v36.sql, /ALTER TABLE tracks ADD COLUMN source TEXT/i);
  });

  test('v36 is NOT marked rescanRequired', () => {
    const v36 = MIGRATIONS.find(m => m.version === 36);
    // Existing rows can stay NULL — the column is non-load-bearing for
    // any consumer today. Forcing a full rescan on upgrade isn't worth
    // it for a provenance label.
    assert.ok(!v36.rescanRequired, 'V36 should not force a rescan on upgrade');
  });

  test('applying all migrations leaves user_version = SCHEMA_VERSION', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(v, SCHEMA_VERSION);
    db.close();
  });

  test('after V36, tracks.source column exists with TEXT affinity, no default, nullable', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const col = getColumn(db, 'tracks', 'source');
    assert.ok(col, 'tracks.source should exist');
    assert.equal(col.type.toUpperCase(), 'TEXT');
    assert.equal(col.notnull, 0, 'should be nullable');
    assert.equal(col.dflt_value, null, 'should have no default');
    db.close();
  });

  test('column add is the only schema delta V36 introduces', () => {
    const dbV35 = new DatabaseSync(':memory:');
    dbV35.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(dbV35, { upToVersion: 35 });
    const before = dbV35.prepare('PRAGMA table_info(tracks)').all().map(c => c.name).sort();
    dbV35.close();

    const dbV36 = new DatabaseSync(':memory:');
    dbV36.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(dbV36);
    const after = dbV36.prepare('PRAGMA table_info(tracks)').all().map(c => c.name).sort();
    dbV36.close();

    const added = after.filter(c => !before.includes(c));
    const removed = before.filter(c => !after.includes(c));
    assert.deepEqual(added, ['source'], 'only `source` should be added');
    assert.deepEqual(removed, [], 'V36 removes no columns');
  });
});

// ── INSERT round-trip ──────────────────────────────────────────────────────

describe('V36 INSERT round-trip', () => {
  function seedLibrary(db) {
    db.prepare('INSERT INTO libraries (name, root_path, type) VALUES (?, ?, ?)').run('lib', '/lib', 'music');
    return db.prepare('SELECT id FROM libraries WHERE name = ?').get('lib').id;
  }

  test('explicit "ytdl" value persists', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const lib = seedLibrary(db);
    db.prepare('INSERT INTO tracks (filepath, library_id, source) VALUES (?, ?, ?)')
      .run('a.mp3', lib, 'ytdl');
    const row = db.prepare('SELECT source FROM tracks WHERE filepath = ?').get('a.mp3');
    assert.equal(row.source, 'ytdl');
    db.close();
  });

  test('NULL persists', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const lib = seedLibrary(db);
    db.prepare('INSERT INTO tracks (filepath, library_id, source) VALUES (?, ?, ?)')
      .run('b.mp3', lib, null);
    const row = db.prepare('SELECT source FROM tracks WHERE filepath = ?').get('b.mp3');
    assert.equal(row.source, null);
    db.close();
  });

  test('omitting source defaults to NULL (no default, nullable)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const lib = seedLibrary(db);
    db.prepare('INSERT INTO tracks (filepath, library_id) VALUES (?, ?)').run('c.mp3', lib);
    const row = db.prepare('SELECT source FROM tracks WHERE filepath = ?').get('c.mp3');
    assert.equal(row.source, null);
    db.close();
  });

  test('open enum: arbitrary string label is accepted without a CHECK', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const lib = seedLibrary(db);
    db.prepare('INSERT INTO tracks (filepath, library_id, source) VALUES (?, ?, ?)')
      .run('d.mp3', lib, 'upload');
    const row = db.prepare('SELECT source FROM tracks WHERE filepath = ?').get('d.mp3');
    assert.equal(row.source, 'upload');
    db.close();
  });
});

// ── Rollback (SCHEMA_V36_DOWN) ─────────────────────────────────────────────

describe('V36 rollback', () => {
  test('SCHEMA_V36_DOWN drops the column and resets user_version', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(hasColumn(db, 'tracks', 'source'), true);

    db.exec(SCHEMA_V36_DOWN);

    assert.equal(hasColumn(db, 'tracks', 'source'), false, 'source column should be gone');
    const ver = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(ver, 35, 'user_version should be back to 35');
    db.close();
  });

  test('V36_DOWN preserves rows on the tracks table', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    db.prepare('INSERT INTO libraries (name, root_path, type) VALUES (?, ?, ?)').run('lib', '/lib', 'music');
    const lib = db.prepare('SELECT id FROM libraries WHERE name = ?').get('lib').id;
    db.prepare('INSERT INTO tracks (filepath, library_id, source) VALUES (?, ?, ?)')
      .run('a.mp3', lib, 'ytdl');
    db.prepare('INSERT INTO tracks (filepath, library_id, source) VALUES (?, ?, ?)')
      .run('b.mp3', lib, null);

    db.exec(SCHEMA_V36_DOWN);

    const rows = db.prepare('SELECT filepath FROM tracks ORDER BY filepath').all();
    assert.deepEqual(rows.map(r => r.filepath), ['a.mp3', 'b.mp3'],
      'rollback must preserve track rows — only the provenance column goes away');
    db.close();
  });
});
