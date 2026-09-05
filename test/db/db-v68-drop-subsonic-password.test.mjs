/**
 * V68: users.subsonic_password_encrypted is dropped.
 *
 * The column (V35) held AES-encrypted, RECOVERABLE Subsonic passwords for
 * that protocol's token auth. The Subsonic API is gone and config.setup()
 * strips the `subsonicSecret` that keyed the ciphertext, so what the column
 * holds is unreadable data. Pins that the drop is registered, that a fresh
 * database never has the column, and that upgrading a V67 database with a
 * populated column keeps every other users field intact.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const COLUMN = 'subsonic_password_encrypted';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  return db;
}
const userColumns = (db) => db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);

describe('V68 drops users.subsonic_password_encrypted', () => {
  test('registered, plain DROP COLUMN, no rescan, covered by SCHEMA_VERSION', () => {
    const v68 = MIGRATIONS.find((m) => m.version === 68);
    assert.ok(v68, 'missing v68 migration');
    assert.match(v68.sql, /ALTER TABLE users DROP COLUMN subsonic_password_encrypted/);
    assert.ok(!v68.rescanRequired, 'a column drop needs no rescan');
    assert.ok(!v68.js, 'no procedural hook');
    assert.ok(SCHEMA_VERSION >= 68);
  });

  test('a fresh database never has the column', () => {
    const db = freshDb();
    applyAllMigrations(db);
    assert.ok(!userColumns(db).includes(COLUMN));
    db.close();
  });

  test('upgrading a V67 database with a populated column keeps every other users field', () => {
    const db = freshDb();
    applyAllMigrations(db, { upToVersion: 67 });
    assert.ok(userColumns(db).includes(COLUMN), 'V35..V67 still carry the column');

    db.prepare(`INSERT INTO users (username, password, salt, ${COLUMN})
                VALUES ('alice', 'pbkdf2-hash', 'salt', 'v1:iv:ciphertext-nobody-can-read')`).run();
    const before = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    assert.equal(before[COLUMN], 'v1:iv:ciphertext-nobody-can-read');
    delete before[COLUMN];

    // The real upgrade path: only migrations above the stored user_version run.
    applyAllMigrations(db, { fromVersion: 67 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(!userColumns(db).includes(COLUMN), 'column dropped');

    const after = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    assert.deepEqual(after, before, 'every other users column survives unchanged');
    db.close();
  });
});
