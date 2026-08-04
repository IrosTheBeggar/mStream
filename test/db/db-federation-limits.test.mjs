/**
 * V62 schema semantics for the federation bandwidth limits:
 *  - the three limit columns default to 0 (= unlimited) for fresh inserts
 *    AND for rows that predate the migration (the ALTER default);
 *  - federation_key_usage's (key_id, day) primary key supports the
 *    accumulate-on-conflict UPSERT the flusher uses;
 *  - usage rows die with their key (ON DELETE CASCADE — manager.js runs
 *    with PRAGMA foreign_keys = ON).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

// Mirrors db/federation.js recordFederationKeyUsage — the semantics under
// test here are the schema's (conflict target + accumulation), not the JS.
const UPSERT = `
  INSERT INTO federation_key_usage (key_id, day, bytes, requests) VALUES (?, ?, ?, ?)
  ON CONFLICT (key_id, day) DO UPDATE SET bytes = bytes + excluded.bytes,
                                          requests = requests + excluded.requests
`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // matches src/db/manager.js:61
  applyAllMigrations(db);
  return db;
}

describe('V62 federation bandwidth limits schema', () => {
  test('limit columns default to 0 on fresh inserts', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO federation_keys (key, name) VALUES ('fedk_test', 'Bob')`).run();
    const row = db.prepare(`SELECT stream_kbps, daily_mb, max_streams FROM federation_keys`).get();
    assert.deepEqual({ ...row }, { stream_kbps: 0, daily_mb: 0, max_streams: 0 });
  });

  test('keys minted before V62 come out of the upgrade unlimited', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db, { upToVersion: 61 });
    db.prepare(`INSERT INTO federation_keys (key, name) VALUES ('fedk_old', 'pre-upgrade')`).run();

    applyAllMigrations(db, { fromVersion: 61 });
    const row = db.prepare(`SELECT stream_kbps, daily_mb, max_streams FROM federation_keys`).get();
    assert.deepEqual({ ...row }, { stream_kbps: 0, daily_mb: 0, max_streams: 0 });
  });

  test('usage UPSERT accumulates within a (key, day) and separates days', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO federation_keys (id, key, name) VALUES (1, 'fedk_test', 'Bob')`).run();

    db.prepare(UPSERT).run(1, '2026-08-04', 1000, 1);
    db.prepare(UPSERT).run(1, '2026-08-04', 234, 2);
    db.prepare(UPSERT).run(1, '2026-08-05', 50, 1);

    const day1 = db.prepare(`SELECT bytes, requests FROM federation_key_usage WHERE key_id = 1 AND day = '2026-08-04'`).get();
    assert.deepEqual({ ...day1 }, { bytes: 1234, requests: 3 });
    const day2 = db.prepare(`SELECT bytes, requests FROM federation_key_usage WHERE key_id = 1 AND day = '2026-08-05'`).get();
    assert.deepEqual({ ...day2 }, { bytes: 50, requests: 1 });
  });

  test('usage rows die with their key (ON DELETE CASCADE)', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO federation_keys (id, key, name) VALUES (7, 'fedk_test', 'Bob')`).run();
    db.prepare(UPSERT).run(7, '2026-08-04', 42, 1);

    db.prepare(`DELETE FROM federation_keys WHERE id = 7`).run();
    const left = db.prepare(`SELECT COUNT(*) AS n FROM federation_key_usage`).get();
    assert.equal(left.n, 0);
  });
});
