/**
 * V75: plugin_downloads — the record of what the discovery plug-ins brought
 * into the library.
 *
 * Pins that the migration is registered without a rescan, that a fresh
 * database has the table and its indexes, that an upgrade from V74 keeps
 * users and job rows intact, that there is at most ONE live record per
 * library path (a removed one does not block a new one), and that a record
 * survives its account's deletion as anonymous rather than blocking it.
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
const INSERT = `INSERT INTO plugin_downloads (plugin, user_id, vpath, filepath, downloaded_at) VALUES (?, ?, ?, ?, 1)`;

describe('V75 plugin_downloads', () => {
  test('registered as plain SQL, no rescan, covered by SCHEMA_VERSION', () => {
    const v75 = MIGRATIONS.find((m) => m.version === 75);
    assert.ok(v75, 'missing v75 migration');
    assert.match(v75.sql, /CREATE TABLE IF NOT EXISTS plugin_downloads/);
    assert.ok(!v75.rescanRequired, 'nothing comes from tags');
    assert.ok(!v75.js, 'no procedural hook');
    assert.ok(SCHEMA_VERSION >= 75);
  });

  test('a fresh database has the table, its columns and the indexes', () => {
    const db = freshDb();
    applyAllMigrations(db);
    assert.ok(tables(db).includes('plugin_downloads'));
    for (const c of ['plugin', 'user_id', 'job_id', 'vpath', 'filepath', 'file_hash', 'origin', 'title', 'artist', 'album', 'bytes', 'downloaded_at', 'removed_at', 'removed_by']) {
      assert.ok(columns(db, 'plugin_downloads').includes(c), c);
    }
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plugin_downloads'").all().map((i) => i.name);
    for (const name of ['idx_plugin_downloads_live', 'idx_plugin_downloads_user', 'idx_plugin_downloads_hash']) {
      assert.ok(idx.includes(name), name);
    }
    db.close();
  });

  test('upgrading a V74 database keeps users and jobs intact', () => {
    const db = freshDb();
    applyAllMigrations(db, { upToVersion: 74 });
    assert.ok(!tables(db).includes('plugin_downloads'));
    const uid = Number(db.prepare("INSERT INTO users (username, password, salt) VALUES ('alice', 'h', 's')").run().lastInsertRowid);
    db.prepare(`INSERT INTO discovery_plugin_jobs (plugin, user_id, rec_key, recommendation, state, created_at, updated_at)
                VALUES ('youtube', ?, 'text:k', '{}', 'done', 1, 1)`).run(uid);
    const userBefore = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
    const jobBefore = db.prepare('SELECT * FROM discovery_plugin_jobs').get();
    applyAllMigrations(db, { fromVersion: 74 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 75);
    assert.ok(tables(db).includes('plugin_downloads'));
    assert.deepEqual(db.prepare("SELECT * FROM users WHERE username = 'alice'").get(), userBefore);
    assert.deepEqual(db.prepare('SELECT * FROM discovery_plugin_jobs').get(), jobBefore);
    db.close();
  });

  test('one live record per library path; a removed one does not block a new one', () => {
    const db = freshDb();
    applyAllMigrations(db);
    const ins = db.prepare(INSERT);
    const first = Number(ins.run('youtube', null, 'music', 'Nova/Night Ferry/Remote_Hit.mp3').lastInsertRowid);
    assert.throws(() => ins.run('federation-copy', null, 'music', 'Nova/Night Ferry/Remote_Hit.mp3'), /UNIQUE/, 'a second live record at the path is refused');
    ins.run('youtube', null, 'other', 'Nova/Night Ferry/Remote_Hit.mp3');   // another library: fine
    db.prepare('UPDATE plugin_downloads SET removed_at = 2 WHERE id = ?').run(first);
    ins.run('youtube', null, 'music', 'Nova/Night Ferry/Remote_Hit.mp3');   // history does not block
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_downloads WHERE vpath = 'music'").get().n, 2);
    db.close();
  });

  test("deleting a user keeps its records, owner cleared", () => {
    const db = freshDb();
    applyAllMigrations(db);
    const uid = Number(db.prepare("INSERT INTO users (username, password, salt) VALUES ('bob', 'h', 's')").run().lastInsertRowid);
    db.prepare(INSERT).run('youtube', uid, 'music', 'a.mp3');
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    const row = db.prepare('SELECT user_id, vpath FROM plugin_downloads').get();
    assert.deepEqual([row.user_id, row.vpath], [null, 'music'], 'record kept, owner cleared');
    db.close();
  });
});
