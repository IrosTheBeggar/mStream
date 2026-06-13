/**
 * Loki→SQLite migration: transactional + idempotent.
 *
 * Regression tests for the bug where migrate() ran its four sub-migrations
 * in autocommit and wrote the success marker only at the very end. A
 * partial failure (e.g. an unparseable last-played date in user-metadata)
 * left the earlier steps committed, so the next boot re-ran the WHOLE
 * migration — and because playlist_tracks used a plain INSERT with no
 * unique constraint, every retry DUPLICATED every playlist's tracks,
 * compounding each boot. The fix wraps migrate() in one transaction and
 * clears a playlist's tracks before (re)inserting them.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

let config, migrateMod, baseDir;
let envCount = 0;

before(async () => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-loki-'));
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: baseDir,
      albumArtDirectory: path.join(baseDir, 'art'),
      logsDirectory: path.join(baseDir, 'logs'),
    },
    port: 0,
  }));
  config = await import('../src/state/config.js');
  await config.setup(path.join(baseDir, 'config.json'));
  migrateMod = await import('../src/db/migrate-from-loki.js');
});

after(() => {
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
});

// Fresh per-test env: its own dir (which becomes config dbDirectory, so
// migrate() reads the Loki files + writes the marker there), its own DB
// seeded with one user, and a user-data.loki-v1.db carrying `collections`.
function buildEnv(collections) {
  const dir = path.join(baseDir, `env-${envCount++}`);
  fs.mkdirSync(dir, { recursive: true });
  config.program.storage.dbDirectory = dir;

  const db = new DatabaseSync(path.join(dir, 'mstream.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db);
  db.prepare('INSERT INTO users (username, password, salt) VALUES (?, ?, ?)')
    .run('alice', 'pw', 'salt');

  fs.writeFileSync(path.join(dir, 'user-data.loki-v1.db'), JSON.stringify({ collections }));
  return { dir, db };
}

// Two rows of the same playlist → one playlist 'My Mix' with two tracks.
const PLAYLIST_COLLECTION = {
  name: 'playlists',
  data: [
    { user: 'alice', name: 'My Mix', filepath: 'a.mp3' },
    { user: 'alice', name: 'My Mix', filepath: 'b.mp3' },
  ],
};

const trackCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks').get().n;
const markerExists = (dir) => fs.existsSync(path.join(dir, '.migrated-from-loki'));

describe('migrate-from-loki: transactional + idempotent', () => {
  test('re-running the migration does NOT duplicate playlist tracks', () => {
    const { dir, db } = buildEnv([PLAYLIST_COLLECTION]);

    migrateMod.migrate(db);
    assert.equal(trackCount(db), 2, 'first run migrates both tracks');
    assert.ok(markerExists(dir), 'success marker is written');

    // Simulate a re-run (e.g. the marker write failed, or a later partial
    // failure on a previous boot left no marker). Without the
    // clear-before-insert this appended a second copy → 4 rows.
    migrateMod.migrate(db);
    assert.equal(trackCount(db), 2, 're-running migrate() must not duplicate playlist tracks');

    db.close();
  });

  test('a mid-migration failure rolls back — no partial rows, no marker', () => {
    // An unparseable last-played date makes migrateUserMetadata throw
    // (new Date(...).toISOString()) AFTER migratePlaylists has already
    // inserted its rows in the same transaction.
    const { dir, db } = buildEnv([
      PLAYLIST_COLLECTION,
      { name: 'user-metadata', data: [{ user: 'alice', hash: 'h1', lp: 'not-a-real-date' }] },
    ]);

    migrateMod.migrate(db);

    assert.equal(trackCount(db), 0,
      'a failed migration must roll back, leaving no playlist_tracks committed');
    assert.ok(!markerExists(dir),
      'marker must NOT be written when the migration failed (so the next boot retries cleanly)');

    db.close();
  });
});
