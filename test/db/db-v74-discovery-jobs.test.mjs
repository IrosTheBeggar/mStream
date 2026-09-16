/**
 * V74: discovery_plugin_jobs + user_settings + users.allow_discovery_jobs.
 *
 * Pins that the migration is registered without a rescan, that a fresh
 * database has both tables with the live-job uniqueness in place, that an
 * upgrade from V73 keeps every users row intact and gives it the new flag
 * at 0, and the two invariants the runner relies on: only ONE live job per
 * (plugin, recommendation), and a job's user survives the user's deletion
 * as NULL rather than blocking it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  return db;
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

describe('V74 discovery plug-in jobs + user settings', () => {
  test('registered as plain SQL, no rescan, covered by SCHEMA_VERSION', () => {
    const v74 = MIGRATIONS.find((m) => m.version === 74);
    assert.ok(v74, 'missing v74 migration');
    assert.match(v74.sql, /CREATE TABLE IF NOT EXISTS discovery_plugin_jobs/);
    assert.match(v74.sql, /CREATE TABLE IF NOT EXISTS user_settings/);
    assert.match(v74.sql, /ALTER TABLE users ADD COLUMN allow_discovery_jobs INTEGER NOT NULL DEFAULT 0/);
    assert.ok(!v74.rescanRequired, 'nothing comes from tags');
    assert.ok(!v74.js, 'no procedural hook');
    assert.ok(SCHEMA_VERSION >= 74);
  });

  test('a fresh database has both tables, the indexes and the users flag', () => {
    const db = freshDb();
    applyAllMigrations(db);
    assert.ok(tables(db).includes('discovery_plugin_jobs'));
    assert.ok(tables(db).includes('user_settings'));
    assert.ok(columns(db, 'users').includes('allow_discovery_jobs'));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'discovery_plugin_jobs'").all().map((i) => i.name);
    for (const name of ['idx_discovery_plugin_jobs_state', 'idx_discovery_plugin_jobs_user', 'idx_discovery_plugin_jobs_live']) {
      assert.ok(idx.includes(name), name);
    }
    db.close();
  });

  test('upgrading a V73 database keeps users intact and defaults the new flag to 0', () => {
    const db = freshDb();
    applyAllMigrations(db, { upToVersion: 73 });
    assert.ok(!columns(db, 'users').includes('allow_discovery_jobs'));
    db.prepare("INSERT INTO users (username, password, salt, allow_torrent) VALUES ('alice', 'h', 's', 1)").run();
    const before = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    applyAllMigrations(db, { fromVersion: 73 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 74);
    const after = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    assert.equal(after.allow_discovery_jobs, 0);
    for (const k of Object.keys(before)) { assert.deepEqual(after[k], before[k], `users.${k} unchanged`); }
    db.close();
  });

  test('one live job per (plugin, recommendation); finished rows do not block a new one', () => {
    const db = freshDb();
    applyAllMigrations(db);
    const ins = db.prepare(`
      INSERT INTO discovery_plugin_jobs (plugin, rec_key, recommendation, state, created_at, updated_at)
      VALUES (?, ?, '{}', ?, 1, 1)`);
    ins.run('x', 'text:abc', 'queued');
    assert.throws(() => ins.run('x', 'text:abc', 'running'), /UNIQUE/, 'second live job refused');
    ins.run('y', 'text:abc', 'queued');                 // another plug-in: fine
    db.prepare("UPDATE discovery_plugin_jobs SET state = 'done' WHERE plugin = 'x'").run();
    ins.run('x', 'text:abc', 'queued');                 // history does not block
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM discovery_plugin_jobs WHERE plugin = 'x'").get().n, 2);
    db.close();
  });

  test("deleting a user nulls its jobs' user_id and removes its settings", () => {
    const db = freshDb();
    applyAllMigrations(db);
    const uid = Number(db.prepare("INSERT INTO users (username, password, salt) VALUES ('bob', 'h', 's')").run().lastInsertRowid);
    db.prepare(`INSERT INTO discovery_plugin_jobs (plugin, user_id, rec_key, recommendation, created_at, updated_at)
                VALUES ('x', ?, 'text:k', '{}', 1, 1)`).run(uid);
    db.prepare("INSERT INTO user_settings (user_id, namespace, key, value, updated_at) VALUES (?, 'ns', 'k', '\"v\"', 1)").run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    assert.equal(db.prepare('SELECT user_id FROM discovery_plugin_jobs').get().user_id, null, 'job kept, owner cleared');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0, 'settings cascade');
    db.close();
  });
});
