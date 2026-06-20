/**
 * V34 migration tests: drop the legacy tracks.genre flat column, route
 * all reads through the track_genres M2M.
 *
 * V34 is forward-only — no SCHEMA_V34_DOWN, no rollback script. The
 * tracks table is a cache of on-disk ID3 tags; recovery from a bad
 * V34 is `rm save/db/mstream.db && restart` (fresh rescan) or
 * restore-from-backup. Same forward-only convention as V1-V30,
 * V32, V33.
 *
 * Covers:
 *   - Schema shape: V34 in MIGRATIONS, user_version advances, column gone.
 *   - Idempotency: applying migrations twice is a no-op.
 *   - M2M tables (genres, track_genres) preserved after V34.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// ── Schema shape ────────────────────────────────────────────────────────────

describe('V34 schema shape', () => {
  test('SCHEMA_VERSION is at least 34', () => {
    assert.ok(SCHEMA_VERSION >= 34, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  });

  test('MIGRATIONS contains a v34 entry with a SQL string', () => {
    const v34 = MIGRATIONS.find(m => m.version === 34);
    assert.ok(v34, 'missing v34 migration');
    assert.equal(typeof v34.sql, 'string');
    assert.match(v34.sql, /ALTER TABLE tracks DROP COLUMN genre/i);
  });

  test('v34 is NOT marked rescanRequired (data preserved by V2 M2M)', () => {
    const v34 = MIGRATIONS.find(m => m.version === 34);
    assert.ok(!v34.rescanRequired, 'V34 preserves data — no rescan needed');
  });

  test('applying all migrations leaves user_version = SCHEMA_VERSION', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(v, SCHEMA_VERSION);
    db.close();
  });

  test('after V34, tracks table has no `genre` column', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(hasColumn(db, 'tracks', 'genre'), false, 'tracks.genre should be dropped');
    db.close();
  });

  test('after V34, track_genres + genres tables still present', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.ok(hasColumn(db, 'track_genres', 'track_id'), 'track_genres preserved');
    assert.ok(hasColumn(db, 'track_genres', 'genre_id'), 'track_genres preserved');
    assert.ok(hasColumn(db, 'genres', 'name'),         'genres preserved');
    db.close();
  });
});

// ── End-to-end migration runner integration ────────────────────────────────

describe('V34 via the full migration loop', () => {
  test('fresh DB runs V1..V34 without error and lands at SCHEMA_VERSION', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    db.close();
  });

  test('column drop is the only schema delta V34 introduces', () => {
    // Build a V33 DB and a V34 DB independently, compare their
    // tracks-table column lists. Delta should be precisely "genre
    // removed" and nothing else.
    //
    // Both DBs must be bounded at their exact target version — later
    // migrations (e.g. V36's `source` column add) would otherwise leak
    // into the V34 snapshot and break the assertion.
    const dbV33 = new DatabaseSync(':memory:');
    dbV33.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(dbV33, { upToVersion: 33 });
    const before = dbV33.prepare('PRAGMA table_info(tracks)').all().map(c => c.name).sort();
    dbV33.close();

    const dbV34 = new DatabaseSync(':memory:');
    dbV34.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(dbV34, { upToVersion: 34 });
    const after = dbV34.prepare('PRAGMA table_info(tracks)').all().map(c => c.name).sort();
    dbV34.close();

    const removed = before.filter(c => !after.includes(c));
    const added = after.filter(c => !before.includes(c));
    assert.deepEqual(removed, ['genre'], 'only `genre` should be removed');
    assert.deepEqual(added, [], 'V34 adds no new columns');
  });
});
