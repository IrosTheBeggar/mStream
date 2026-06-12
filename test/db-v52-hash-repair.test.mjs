/**
 * V52 canonical-hash repair tests.
 *
 * Builds a populated V51 fixture carrying every defect class the
 * migration repairs, upgrades it (foreign_keys=ON, the runner's
 * environment), and pins the post-state:
 *
 *   - mis-keyed user_metadata rows (track_hash = file_hash while the
 *     track has an audio_hash — the pre-V52 scrobble bug) re-key to the
 *     canonical hash;
 *   - collisions merge: play_count sums across ALL old rows (two files
 *     with identical audio share one audio_hash), earliest starred_at,
 *     latest last_played, canonical rating wins;
 *   - '' hashes normalize to NULL on tracks; ''-keyed user rows drop;
 *   - dead all-null user_metadata rows (unstar legacy) drop;
 *   - user_bookmarks collisions keep the most recently changed row;
 *   - lyrics_cache old-keyed rows re-key, or drop when a canonical row
 *     exists;
 *   - idx_user_bookmarks_hash exists afterwards;
 *   - V52 is NOT rescanRequired and leaves no temp tables.
 *
 * Same populated-fixture upgrade pattern as db-v18-albums-rebuild.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

function buildV51Fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, { upToVersion: 51 });

  db.exec(`
    INSERT INTO users (id, username, password, salt) VALUES (1, 'alice', 'x', 'x'), (2, 'bob', 'x', 'x');
    INSERT INTO libraries (id, name, root_path) VALUES (1, 'music', '/music');

    -- t1: has audio_hash (canonical = 'audio1'); its file_hash 'file1'
    --     carries mis-keyed rows.
    -- t2: duplicate content of t1 in another folder — same audio_hash,
    --     different file_hash ('file2'); also mis-keyed (many-to-one).
    -- t3: file-hash-only track (no audio_hash) — its rows are CORRECTLY
    --     keyed on file_hash and must not move.
    -- t4: '' audio_hash (the third-semantic bug) — normalizes to NULL.
    INSERT INTO tracks (id, filepath, library_id, title, file_hash, audio_hash) VALUES
      (1, 'a/t1.mp3', 1, 'T1', 'file1', 'audio1'),
      (2, 'b/t1-copy.mp3', 1, 'T1 copy', 'file2', 'audio1'),
      (3, 'c/t3.wav', 1, 'T3', 'file3', NULL),
      (4, 'd/t4.mp3', 1, 'T4', 'file4', '');

    -- alice: mis-keyed plays under BOTH file hashes + a canonical row
    -- with a rating → three-way merge into 'audio1'.
    INSERT INTO user_metadata (user_id, track_hash, play_count, rating, starred_at, last_played) VALUES
      (1, 'file1', 7, NULL, '2026-02-01', '2026-05-01'),
      (1, 'file2', 2, NULL, NULL, '2026-03-01'),
      (1, 'audio1', 5, 8, '2026-01-15', '2026-04-01'),
      -- bob: mis-keyed only — plain re-key, no merge.
      (2, 'file1', 3, NULL, NULL, NULL),
      -- correctly-keyed file-hash-only row — must not move.
      (1, 'file3', 4, NULL, NULL, NULL),
      -- ''-keyed junk + dead all-null row — both must drop.
      (1, '', 9, NULL, NULL, NULL),
      (2, 'file3', 0, NULL, NULL, NULL);

    -- bookmarks: alice holds both identities; the old-keyed one is newer.
    INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment, changed_at) VALUES
      (1, 'file1', 9000, 'newer', '2026-06-02'),
      (1, 'audio1', 100, 'older', '2026-06-01'),
      (2, 'file1', 555, NULL, '2026-06-01');

    INSERT INTO lyrics_cache (audio_hash, status, plain, fetched_at) VALUES
      ('file1', 'found', 'old-keyed', 10),
      ('audio1', 'found', 'canonical', 20),
      ('file2', 'miss', NULL, 30);
  `);
  return db;
}

describe('V52 schema shape', () => {
  test('MIGRATIONS has a v52 entry, not rescanRequired', () => {
    const v52 = MIGRATIONS.find(m => m.version === 52);
    assert.ok(v52, 'missing v52');
    assert.ok(!v52.rescanRequired, 'V52 repairs rows only — no rescan');
    assert.equal(SCHEMA_VERSION, 52);
  });
});

describe('V51 → V52 repair', () => {
  test('mis-keyed rows re-key with merge; correct rows stay; junk drops', () => {
    const db = buildV51Fixture();
    applyAllMigrations(db, { fromVersion: 51, upToVersion: 52 });

    // tracks '' normalization.
    assert.equal(db.prepare(`SELECT audio_hash FROM tracks WHERE id = 4`).get().audio_hash,
      null, "'' audio_hash normalized to NULL");

    // alice's three-way merge into the canonical row.
    const alice = db.prepare(
      `SELECT * FROM user_metadata WHERE user_id = 1 AND track_hash = 'audio1'`).get();
    assert.ok(alice, 'canonical row survives');
    assert.equal(alice.play_count, 14, 'plays sum across BOTH mis-keyed rows (7+2+5)');
    assert.equal(alice.rating, 8, 'canonical rating wins');
    assert.equal(alice.starred_at, '2026-01-15', 'earliest star wins');
    assert.equal(alice.last_played, '2026-05-01', 'latest play wins');
    assert.equal(db.prepare(
      `SELECT COUNT(*) c FROM user_metadata WHERE track_hash IN ('file1','file2')`).get().c,
      0, 'mis-keyed rows gone');

    // bob's plain re-key (no canonical row existed).
    const bob = db.prepare(
      `SELECT play_count FROM user_metadata WHERE user_id = 2 AND track_hash = 'audio1'`).get();
    assert.ok(bob, "bob's row re-keyed");
    assert.equal(bob.play_count, 3);

    // file-hash-only track's rows untouched.
    assert.ok(db.prepare(
      `SELECT 1 FROM user_metadata WHERE user_id = 1 AND track_hash = 'file3'`).get(),
      'correctly-keyed file-hash-only row stays');

    // junk rows dropped: ''-keyed and dead all-null.
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM user_metadata WHERE track_hash = ''`).get().c, 0);
    assert.equal(db.prepare(
      `SELECT COUNT(*) c FROM user_metadata WHERE user_id = 2 AND track_hash = 'file3'`).get().c,
      0, 'dead all-null row dropped');
  });

  test('bookmark collision keeps the newest; lone rows re-key', () => {
    const db = buildV51Fixture();
    applyAllMigrations(db, { fromVersion: 51, upToVersion: 52 });

    const alice = db.prepare(
      `SELECT * FROM user_bookmarks WHERE user_id = 1`).all();
    assert.equal(alice.length, 1);
    assert.equal(alice[0].track_hash, 'audio1');
    assert.equal(alice[0].position_ms, 9000, 'newer (old-keyed) bookmark won');
    assert.equal(alice[0].comment, 'newer');

    const bob = db.prepare(`SELECT * FROM user_bookmarks WHERE user_id = 2`).all();
    assert.equal(bob.length, 1);
    assert.equal(bob[0].track_hash, 'audio1', "bob's lone bookmark re-keyed");
    assert.equal(bob[0].position_ms, 555);
  });

  test('lyrics_cache: collision drops the old-keyed row, lone rows re-key', () => {
    const db = buildV51Fixture();
    applyAllMigrations(db, { fromVersion: 51, upToVersion: 52 });

    const rows = db.prepare(`SELECT audio_hash, plain FROM lyrics_cache ORDER BY audio_hash`).all();
    // 'file1' dropped (canonical 'audio1' exists); 'file2' would re-key
    // to 'audio1' but it ALSO collides post-'file1' cleanup — exactly
    // one row may remain for audio1.
    assert.equal(rows.filter(r => r.audio_hash === 'audio1').length, 1);
    assert.equal(rows.find(r => r.audio_hash === 'audio1').plain, 'canonical');
    assert.equal(rows.filter(r => ['file1', 'file2'].includes(r.audio_hash)).length, 0,
      'old-keyed cache rows gone');
  });

  test('idx_user_bookmarks_hash exists; no temp leftovers; full chain runs clean', () => {
    const db = buildV51Fixture();
    applyAllMigrations(db, { fromVersion: 51 });

    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_bookmarks_hash'`).get(),
      'bookmarks rekey index created');
    assert.deepEqual(db.prepare(
      `SELECT name FROM temp.sqlite_master WHERE name LIKE '_v52_%'`).all(), [],
      'no _v52_* temp tables leak');
  });

  test('fresh chain 0 → SCHEMA_VERSION runs clean (empty tables)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  });

  // ── Review-driven regressions ──────────────────────────────────────────

  test('two old hashes → one canonical with NO canonical row: merges, never throws (the boot-loop critical)', () => {
    // Two re-tagged copies share audio6; the user played BOTH via the
    // old scrobbler path (file-hash-keyed) and never touched any
    // canonical-keyed path. The original migration's "re-key the rest"
    // UPDATE minted duplicate (user, hash) keys here and aborted EVERY
    // boot on the UNIQUE throw.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db, { upToVersion: 51 });
    db.exec(`
      INSERT INTO users (id, username, password, salt) VALUES (1, 'u', 'x', 'x');
      INSERT INTO libraries (id, name, root_path) VALUES (1, 'm', '/m');
      INSERT INTO tracks (id, filepath, library_id, title, file_hash, audio_hash) VALUES
        (1, 'x/a.mp3', 1, 'A', 'file6a', 'audio6'),
        (2, 'y/a.mp3', 1, 'A', 'file6b', 'audio6');
      INSERT INTO user_metadata (user_id, track_hash, play_count, starred_at) VALUES
        (1, 'file6a', 4, '2026-03-01'),
        (1, 'file6b', 6, NULL);
      INSERT INTO user_bookmarks (user_id, track_hash, position_ms, changed_at) VALUES
        (1, 'file6a', 111, '2026-06-01'),
        (1, 'file6b', 222, '2026-06-02');
      INSERT INTO lyrics_cache (audio_hash, status, plain, fetched_at) VALUES
        ('file6a', 'miss', NULL, 10),
        ('file6b', 'found', 'best', 20);
    `);

    applyAllMigrations(db, { fromVersion: 51, upToVersion: 52 });

    const um = db.prepare(`SELECT * FROM user_metadata WHERE user_id = 1`).all();
    assert.equal(um.length, 1, 'single merged row, no UNIQUE throw');
    assert.equal(um[0].track_hash, 'audio6');
    assert.equal(um[0].play_count, 10, 'both old rows summed');
    assert.equal(um[0].starred_at, '2026-03-01');

    const bm = db.prepare(`SELECT * FROM user_bookmarks WHERE user_id = 1`).all();
    assert.equal(bm.length, 1);
    assert.equal(bm[0].track_hash, 'audio6');
    assert.equal(bm[0].position_ms, 222, 'newest old bookmark won');

    const lc = db.prepare(`SELECT * FROM lyrics_cache`).all();
    assert.equal(lc.length, 1, 'one lyrics survivor');
    assert.equal(lc[0].audio_hash, 'audio6');
    assert.equal(lc[0].plain, 'best', "the 'found' row beat the 'miss' row");
  });

  test('byte-identical duplicate copies do NOT multiply merged play counts (DISTINCT map)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(db, { upToVersion: 51 });
    db.exec(`
      INSERT INTO users (id, username, password, salt) VALUES (1, 'u', 'x', 'x');
      INSERT INTO libraries (id, name, root_path) VALUES (1, 'm', '/m');
      -- THREE byte-identical copies: same (file_hash, audio_hash) pair.
      INSERT INTO tracks (id, filepath, library_id, title, file_hash, audio_hash) VALUES
        (1, 'a/t.mp3', 1, 'T', 'file7', 'audio7'),
        (2, 'b/t.mp3', 1, 'T', 'file7', 'audio7'),
        (3, 'c/t.mp3', 1, 'T', 'file7', 'audio7');
      INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES
        (1, 'file7', 7),
        (1, 'audio7', 5);
    `);

    applyAllMigrations(db, { fromVersion: 51, upToVersion: 52 });

    const m = db.prepare(
      `SELECT play_count FROM user_metadata WHERE user_id = 1 AND track_hash = 'audio7'`).get();
    assert.equal(m.play_count, 12, '7+5, not 7×3+5');
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM user_metadata`).get().c, 1);
  });
});
