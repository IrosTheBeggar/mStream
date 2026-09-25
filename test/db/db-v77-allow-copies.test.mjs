/**
 * V77: federation_keys.allow_copies — the per-key switch for copies by the
 * other server's discovery plug-in. A nullable-free column with a default,
 * so every existing key keeps allowing copies.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

describe('V77 federation_keys.allow_copies', () => {
  test('registered as plain SQL, covered by SCHEMA_VERSION', () => {
    const v77 = MIGRATIONS.find((m) => m.version === 77);
    assert.ok(v77, 'missing v77 migration');
    assert.match(v77.sql, /ALTER TABLE federation_keys ADD COLUMN allow_copies/);
    assert.ok(!v77.rescanRequired);
    assert.ok(SCHEMA_VERSION >= 77);
  });

  test('an existing key keeps allowing copies after the upgrade; a fresh key does too', () => {
    const db = freshDb();
    applyAllMigrations(db, { upToVersion: 76 });
    assert.ok(!columns(db, 'federation_keys').includes('allow_copies'));
    db.prepare("INSERT INTO federation_keys (key, name) VALUES ('fedk_test', 'old')").run();
    applyAllMigrations(db, { fromVersion: 76 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(columns(db, 'federation_keys').includes('allow_copies'));
    assert.equal(db.prepare("SELECT allow_copies FROM federation_keys WHERE name = 'old'").get().allow_copies, 1);
    db.prepare("INSERT INTO federation_keys (key, name) VALUES ('fedk_new', 'new')").run();
    assert.equal(db.prepare("SELECT allow_copies FROM federation_keys WHERE name = 'new'").get().allow_copies, 1);
    db.close();
  });
});
