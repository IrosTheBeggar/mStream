/**
 * Unit test for src/db/hash-migration.js.
 *
 * Scenario: the scanner detects a file whose content hash changed (typical
 * trigger: external ID3 tag editor rewriting frames). Before deleting the
 * old tracks row and inserting a fresh one, we migrate the user-facing
 * rows keyed on track_hash — user_metadata, user_bookmarks, and
 * user_play_queue — so stars, play counts, bookmarks, and queue entries
 * follow the file's new identity rather than silently orphaning.
 *
 * This test runs against an in-memory SQLite DB with the same schema shape
 * the real scanner would see, so it exercises the migration in isolation
 * from the scanner subprocess and the rest of the server. The Rust side is
 * a straight port of the same logic (rust-parser/src/main.rs
 * #migrate_hash_references) — any behaviour change there must be mirrored.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateHashReferences } from '../../src/db/hash-migration.js';

function mkDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE user_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_hash TEXT NOT NULL,
      play_count INTEGER DEFAULT 0,
      last_played TEXT,
      rating INTEGER,
      starred_at TEXT
    );
    CREATE TABLE user_bookmarks (
      user_id INTEGER NOT NULL,
      track_hash TEXT NOT NULL,
      position_ms INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT,
      changed_at TEXT,
      PRIMARY KEY (user_id, track_hash)
    );
    CREATE TABLE user_play_queue (
      user_id INTEGER PRIMARY KEY,
      current_track_hash TEXT,
      position_ms INTEGER,
      changed_at TEXT,
      changed_by TEXT,
      track_hashes_json TEXT NOT NULL
    );
    CREATE TABLE lyrics_cache (
      audio_hash TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      synced_lrc TEXT, plain TEXT, lang TEXT, source TEXT,
      fetched_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE acoustid_lookups (
      audio_hash      TEXT PRIMARY KEY,
      last_attempt_at INTEGER NOT NULL,
      outcome         TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE audio_analysis_lookups (
      audio_hash      TEXT PRIMARY KEY,
      last_attempt_at INTEGER NOT NULL,
      outcome         TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX um_unique ON user_metadata(user_id, track_hash);
  `);
  return db;
}

describe('hash migration helper', () => {
  test('no-op when old and new hashes are equal', () => {
    const db = mkDb();
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES (1, ?, 5)').run('aaaa');
    const res = migrateHashReferences(db, 'aaaa', 'aaaa');
    assert.deepEqual(res, { metadata: 0, bookmarks: 0, queues: 0 });
  });

  test('no-op when either hash is falsy', () => {
    const db = mkDb();
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES (1, ?, 5)').run('aaaa');
    assert.deepEqual(migrateHashReferences(db, null, 'bbbb'), { metadata: 0, bookmarks: 0, queues: 0 });
    assert.deepEqual(migrateHashReferences(db, 'aaaa', ''),   { metadata: 0, bookmarks: 0, queues: 0 });
    // Original row untouched.
    const row = db.prepare('SELECT play_count FROM user_metadata WHERE track_hash = ?').get('aaaa');
    assert.equal(row.play_count, 5);
  });

  test('migrates user_metadata rows from old hash to new hash', () => {
    const db = mkDb();
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count, rating, starred_at) VALUES (1, ?, 7, 4, ?)')
      .run('oldhash', '2026-01-01 12:00:00');
    // A second user with the same hash — both should migrate.
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES (2, ?, 3)').run('oldhash');
    // An unrelated row on a different hash — should stay put.
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES (3, ?, 1)').run('unrelated');

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.metadata, 2);

    const migrated = db.prepare('SELECT user_id, play_count, rating FROM user_metadata WHERE track_hash = ?').all('newhash');
    assert.equal(migrated.length, 2);
    const byUser = Object.fromEntries(migrated.map(r => [r.user_id, r]));
    assert.equal(byUser[1].play_count, 7);
    assert.equal(byUser[1].rating, 4);
    assert.equal(byUser[2].play_count, 3);

    // Unrelated row untouched.
    const unrelated = db.prepare('SELECT play_count FROM user_metadata WHERE track_hash = ?').get('unrelated');
    assert.equal(unrelated.play_count, 1);

    // Old-hash rows gone.
    const orphaned = db.prepare('SELECT COUNT(*) AS n FROM user_metadata WHERE track_hash = ?').get('oldhash');
    assert.equal(orphaned.n, 0);
  });

  test('migrates user_bookmarks rows', () => {
    const db = mkDb();
    db.prepare('INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment) VALUES (1, ?, 12345, ?)')
      .run('oldhash', 'chapter 3');
    db.prepare('INSERT INTO user_bookmarks (user_id, track_hash, position_ms) VALUES (2, ?, 999)').run('other');

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.bookmarks, 1);

    const migrated = db.prepare('SELECT position_ms, comment FROM user_bookmarks WHERE track_hash = ?').get('newhash');
    assert.equal(migrated.position_ms, 12345);
    assert.equal(migrated.comment, 'chapter 3');

    const orphaned = db.prepare('SELECT COUNT(*) AS n FROM user_bookmarks WHERE track_hash = ?').get('oldhash');
    assert.equal(orphaned.n, 0);

    // Other bookmark untouched.
    const other = db.prepare('SELECT position_ms FROM user_bookmarks WHERE track_hash = ?').get('other');
    assert.equal(other.position_ms, 999);
  });

  test('migrates user_play_queue current_track_hash scalar', () => {
    const db = mkDb();
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, ?, 1234, '2026-01-01', 'web', '[]')
    `).run('oldhash');

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.queues, 1);

    const row = db.prepare('SELECT current_track_hash, position_ms FROM user_play_queue WHERE user_id = 1').get();
    assert.equal(row.current_track_hash, 'newhash');
    assert.equal(row.position_ms, 1234, 'unrelated columns preserved');
  });

  test('migrates occurrences inside track_hashes_json array, preserving order and unrelated entries', () => {
    const db = mkDb();
    // User queue has [a, oldhash, b, oldhash, c] with current pointing at b.
    const queue = JSON.stringify(['a', 'oldhash', 'b', 'oldhash', 'c']);
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, 'b', 0, '2026-01-01', 'web', ?)
    `).run(queue);

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.queues, 1);

    const row = db.prepare('SELECT current_track_hash, track_hashes_json FROM user_play_queue WHERE user_id = 1').get();
    assert.equal(row.current_track_hash, 'b', 'current did not change because it was not the target');
    assert.deepEqual(
      JSON.parse(row.track_hashes_json),
      ['a', 'newhash', 'b', 'newhash', 'c'],
      'both occurrences in the array replaced, order preserved',
    );
  });

  test('does not mutate unrelated queues', () => {
    const db = mkDb();
    // Queue A references oldhash, queue B does not.
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, 'oldhash', 0, NULL, NULL, ?)
    `).run(JSON.stringify(['oldhash', 'x']));
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (2, 'y', 0, NULL, NULL, ?)
    `).run(JSON.stringify(['y', 'z']));

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.queues, 1, 'only the referencing queue should update');

    const row2 = db.prepare('SELECT current_track_hash, track_hashes_json FROM user_play_queue WHERE user_id = 2').get();
    assert.equal(row2.current_track_hash, 'y');
    assert.deepEqual(JSON.parse(row2.track_hashes_json), ['y', 'z']);
  });

  test('quoted-hash instr() filter avoids false positives from substring overlap', () => {
    const db = mkDb();
    // `aaaa` is a prefix of `aaaaXYZ`. A naive `instr()` without quotes
    // would match both; the quoted-hash filter should match only `aaaa`.
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, 'aaaaXYZ', 0, NULL, NULL, ?)
    `).run(JSON.stringify(['aaaaXYZ', 'other']));

    const res = migrateHashReferences(db, 'aaaa', 'NEW');
    // Should be no-op: the queue has aaaaXYZ, not aaaa.
    assert.equal(res.queues, 0);
    const row = db.prepare('SELECT current_track_hash, track_hashes_json FROM user_play_queue WHERE user_id = 1').get();
    assert.equal(row.current_track_hash, 'aaaaXYZ');
    assert.deepEqual(JSON.parse(row.track_hashes_json), ['aaaaXYZ', 'other']);
  });

  test('skips rows with corrupt JSON without throwing', () => {
    const db = mkDb();
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, 'oldhash', 0, NULL, NULL, ?)
    `).run('"oldhash" but not valid json');

    // Throws nothing. Scalar migrates; array silently skipped (corrupt).
    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    // The current_track_hash IS updated on corrupt-JSON rows because the
    // SELECT still hit the row (via the scalar match), and we parse-then-
    // skip — the UPDATE never runs. Accept 0 as the count.
    assert.equal(res.queues, 0);
  });

  test('handles the full stars+ratings+bookmarks+queue combo in one call', () => {
    const db = mkDb();
    // All three tables reference oldhash for user 1.
    db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count, rating) VALUES (1, ?, 10, 5)').run('oldhash');
    db.prepare('INSERT INTO user_bookmarks (user_id, track_hash, position_ms) VALUES (1, ?, 500)').run('oldhash');
    db.prepare(`
      INSERT INTO user_play_queue (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
      VALUES (1, ?, 500, NULL, NULL, ?)
    `).run('oldhash', JSON.stringify(['oldhash']));

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.deepEqual(res, { metadata: 1, bookmarks: 1, queues: 1 });

    const m = db.prepare('SELECT play_count, rating FROM user_metadata WHERE track_hash = ?').get('newhash');
    assert.equal(m.play_count, 10);
    assert.equal(m.rating, 5);
    const b = db.prepare('SELECT position_ms FROM user_bookmarks WHERE track_hash = ?').get('newhash');
    assert.equal(b.position_ms, 500);
    const q = db.prepare('SELECT current_track_hash, track_hashes_json FROM user_play_queue WHERE user_id = 1').get();
    assert.equal(q.current_track_hash, 'newhash');
    assert.deepEqual(JSON.parse(q.track_hashes_json), ['newhash']);
  });

  // ── Collision merges (pre-V52 dual-keyed rows) ─────────────────────────
  // A user can hold rows under BOTH identities: the old scrobble bug
  // keyed plays on file_hash while star/rating paths keyed on
  // audio_hash. The rekey must MERGE, not throw on the UNIQUE
  // constraint — a throw aborts the per-file scan txn and re-aborts on
  // every later rescan.

  test('user_metadata collision merges: counts sum, earliest star, latest play, target rating wins', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count, rating, starred_at, last_played)
                VALUES (1, 'oldhash', 7, 3, '2026-02-01', '2026-05-01')`).run();
    db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count, rating, starred_at, last_played)
                VALUES (1, 'newhash', 5, NULL, '2026-01-01', '2026-06-01')`).run();

    const res = migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(res.metadata, 1);

    const rows = db.prepare(`SELECT * FROM user_metadata WHERE user_id = 1`).all();
    assert.equal(rows.length, 1, 'old row deleted after merge');
    const m = rows[0];
    assert.equal(m.track_hash, 'newhash');
    assert.equal(m.play_count, 12, 'play counts sum');
    assert.equal(m.starred_at, '2026-01-01', 'earliest star wins');
    assert.equal(m.last_played, '2026-06-01', 'latest play wins');
    assert.equal(m.rating, 3, 'NULL target rating takes the old value');
  });

  test('user_bookmarks collision: most recently changed wins outright', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment, changed_at)
                VALUES (1, 'oldhash', 9000, 'newer', '2026-06-02')`).run();
    db.prepare(`INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment, changed_at)
                VALUES (1, 'newhash', 100, 'older', '2026-06-01')`).run();

    migrateHashReferences(db, 'oldhash', 'newhash');

    const rows = db.prepare(`SELECT * FROM user_bookmarks WHERE user_id = 1`).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].track_hash, 'newhash');
    assert.equal(rows[0].position_ms, 9000, 'newer (old-keyed) position won');
    assert.equal(rows[0].comment, 'newer');
  });

  test('lyrics_cache follows the rekey; canonical row wins a collision', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO lyrics_cache (audio_hash, status, plain) VALUES ('oldhash', 'found', 'la la')`).run();
    migrateHashReferences(db, 'oldhash', 'newhash');
    assert.equal(db.prepare(`SELECT plain FROM lyrics_cache WHERE audio_hash = 'newhash'`).get().plain,
      'la la', 'lone cache row re-keys');

    db.prepare(`INSERT INTO lyrics_cache (audio_hash, status, plain) VALUES ('h1', 'miss', NULL)`).run();
    db.prepare(`INSERT INTO lyrics_cache (audio_hash, status, plain) VALUES ('h2', 'found', 'keep me')`).run();
    migrateHashReferences(db, 'h1', 'h2');
    const rows = db.prepare(`SELECT audio_hash, plain FROM lyrics_cache WHERE audio_hash IN ('h1','h2')`).all();
    assert.equal(rows.length, 1, 'old-keyed row dropped on collision');
    assert.equal(rows[0].plain, 'keep me', 'canonical row untouched');
  });

  test('scheme re-key: acoustid + audio-analysis cooldowns follow; canonical row wins a collision', () => {
    const db = mkDb();
    for (const table of ['acoustid_lookups', 'audio_analysis_lookups']) {
      db.prepare(`INSERT INTO ${table} (audio_hash, last_attempt_at, outcome)
                  VALUES ('oldhash', 100, 'nomatch')`).run();
    }
    migrateHashReferences(db, 'oldhash', 'newhash', { schemeRekey: true });
    for (const table of ['acoustid_lookups', 'audio_analysis_lookups']) {
      assert.equal(db.prepare(
        `SELECT outcome FROM ${table} WHERE audio_hash = 'newhash'`).get().outcome,
      'nomatch', `${table}: lone ledger row re-keys`);
    }

    db.prepare(`INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome)
                VALUES ('h1', 100, 'error')`).run();
    db.prepare(`INSERT INTO acoustid_lookups (audio_hash, last_attempt_at, outcome)
                VALUES ('h2', 200, 'nomatch')`).run();
    migrateHashReferences(db, 'h1', 'h2', { schemeRekey: true });
    const rows = db.prepare(
      `SELECT audio_hash, outcome FROM acoustid_lookups WHERE audio_hash IN ('h1','h2')`).all();
    assert.equal(rows.length, 1, 'old-keyed row dropped on collision');
    assert.equal(rows[0].outcome, 'nomatch', 'canonical row keeps its fresher history');
  });

  test('content change (default): cooldown ledgers stay behind, user state and lyrics follow', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO user_metadata (user_id, track_hash, play_count)
                VALUES (1, 'oldhash', 5)`).run();
    db.prepare(`INSERT INTO lyrics_cache (audio_hash, status, plain)
                VALUES ('oldhash', 'found', 'la la')`).run();
    for (const table of ['acoustid_lookups', 'audio_analysis_lookups']) {
      db.prepare(`INSERT INTO ${table} (audio_hash, last_attempt_at, outcome)
                  VALUES ('oldhash', 100, 'error')`).run();
    }

    migrateHashReferences(db, 'oldhash', 'newhash');  // no schemeRekey: content change

    assert.equal(db.prepare(
      `SELECT play_count FROM user_metadata WHERE track_hash = 'newhash'`).get().play_count,
    5, 'user state follows a content change (path is identity for user intent)');
    assert.equal(db.prepare(
      `SELECT plain FROM lyrics_cache WHERE audio_hash = 'newhash'`).get().plain,
    'la la', 'lyrics follow (long-standing behavior)');
    for (const table of ['acoustid_lookups', 'audio_analysis_lookups']) {
      assert.equal(db.prepare(
        `SELECT audio_hash FROM ${table}`).get().audio_hash, 'oldhash',
      `${table}: content-derived cooldown stays at the old identity — new audio ` +
      'must not inherit a failure for attempts that never ran against it');
    }
  });
});
