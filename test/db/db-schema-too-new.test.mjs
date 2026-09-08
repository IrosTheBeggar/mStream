/**
 * A database from this build's future refuses to boot.
 *
 * runMigrations() used to treat PRAGMA user_version > SCHEMA_VERSION as
 * "up to date" and carry on: an older release over a newer db (a rolled-
 * back docker tag, a manual downgrade, a branch switch in a dev checkout)
 * ran half-blind — both scanners refused, and every write it made was one
 * the newer schema could not trust once the user upgraded again. initDB()
 * now throws the one message that says what to do, and leaves the db as
 * it found it.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

let testRoot, config, manager;

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-toonew-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    port: 0,
  }, null, 2));
  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  manager = await import('../../src/db/manager.js');
});

after(() => {
  try { manager.close(); } catch (_) { /* not open */ }
  fs.rmSync(testRoot, { recursive: true, force: true });
});

// A fully migrated db stamped with the given user_version.
function writeDb(userVersion) {
  const dbPath = path.join(testRoot, 'db', 'mstream.db');
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* absent */ } }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return dbPath;
}

describe('schema newer than this build', () => {
  test('initDB refuses a db whose user_version is above SCHEMA_VERSION, and leaves it alone', () => {
    const dbPath = writeDb(SCHEMA_VERSION + 1);
    assert.throws(() => manager.initDB(), (err) => {
      assert.match(err.message, /newer mStream/);
      assert.match(err.message, new RegExp(`v${SCHEMA_VERSION + 1}`));
      assert.match(err.message, new RegExp(`up to v${SCHEMA_VERSION}`));
      assert.match(err.message, /backup/);
      return true;
    });
    manager.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION + 1);
    db.close();
  });

  test('a db at exactly SCHEMA_VERSION still boots', () => {
    writeDb(SCHEMA_VERSION);
    manager.initDB();
    assert.equal(manager.getDB().prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    manager.close();
  });
});
