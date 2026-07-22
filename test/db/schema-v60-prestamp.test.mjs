/**
 * V60 pre-stamp + convergence-probe index.
 *
 * The V60 migration stamps hash_v = 2 directly onto rows whose
 * file_size is below generation 2's 25MB sampling threshold: their
 * full-MD5 hashes are byte-identical under the new scheme (the audio
 * payload can never exceed the file), so re-parsing them in the epoch
 * would re-derive provably-unchanged values. Rows at/above the
 * threshold — and rows with NULL file_size — stay at 1 for the
 * generation-scoped epoch. The migration also ships the self-emptying
 * partial index that makes the every-boot convergence probe O(1).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

const THRESHOLD = 25 * 1024 * 1024;

function dbAtV59WithTracks() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db, { upToVersion: 59 });
  db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', '/m')").run();
  const ins = db.prepare(
    'INSERT INTO tracks (filepath, library_id, file_hash, file_size) VALUES (?, 1, ?, ?)');
  ins.run('small.mp3', 'h-small', THRESHOLD - 1);
  ins.run('exact.flac', 'h-exact', THRESHOLD);       // boundary: sampled scheme
  ins.run('big.flac', 'h-big', THRESHOLD + 1);
  ins.run('nosize.wav', 'h-nosize', null);
  return db;
}

describe('SCHEMA_V60 pre-stamp', () => {
  test('sub-threshold rows are stamped generation 2; >=threshold and NULL-size stay 1', () => {
    const db = dbAtV59WithTracks();
    applyAllMigrations(db, { fromVersion: 59 });

    const rows = Object.fromEntries(db.prepare(
      'SELECT filepath, hash_v FROM tracks').all().map((r) => [r.filepath, r.hash_v]));
    assert.deepEqual(rows, {
      'small.mp3': 2,   // full hashes unchanged by construction — no re-parse needed
      'exact.flac': 1,  // fileSize >= threshold samples: the epoch must re-key it
      'big.flac': 1,
      'nosize.wav': 1,  // unknown size — the epoch decides
    });
    db.close();
  });

  test('the convergence probe is answered by the partial index', () => {
    const db = dbAtV59WithTracks();
    applyAllMigrations(db, { fromVersion: 59 });

    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tracks_hash_v_stale'")
      .get(), 'partial index shipped by V60');
    // The probe task-queue runs every boot must be index-answered — the
    // literal generation in the query text is what lets SQLite prove the
    // partial predicate applies (a bound parameter would not).
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT 1 FROM tracks WHERE hash_v < 2 LIMIT 1').all()
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_tracks_hash_v_stale/,
      `probe must use the partial index, got plan: ${plan}`);
    db.close();
  });
});
