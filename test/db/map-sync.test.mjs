/**
 * Music map mirror tests — V81 track_map / track_map_meta and the mirror in
 * src/db/map-sync.js that keeps them in step with discovery.db map_points.
 *
 * Same harness as mood-sync.test.mjs: the injectable core against fresh
 * in-memory mstream.db handles (full migrations) and a temp-file
 * discovery.db singleton. Transactions are observed through a transparent
 * wrapper around the mstream.db handle (spyOn), so the chunking and the rev
 * rule are asserted on what was actually written, never on timing.
 * Covers:
 *
 *   - V81 shape: columns, the one-row pointer, the cascade from tracks.
 *   - tracksByCanonicalHash moved to track-hashes.js, re-exported by
 *     genre-sync.js.
 *   - reconcile: copies and group members share a dot, u16 quantisation, a
 *     moved file gets a row, a track with no point loses its row, a no-op
 *     writes nothing, FK-guarded inserts, chunked writes, rev per serving
 *     chunk only, added_max.
 *   - the flip, the old generation's chunked delete, the pointer helpers.
 *   - a hash re-key through applyHashTransitionGroups (a singleton's own
 *     hash and a group's label member) keeps every track's row and position.
 *   - the similarity index absorbs the map pass's own mstream.db commits.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import {
  TRACK_MAP_CHUNK, reconcileTrackMap, flipTrackMap, clearTrackMapPointer,
  deleteTrackMapGenerations, readTrackMapPointer, mapPointerValid, generationAddedMax,
} from '../../src/db/map-sync.js';
import { tracksByCanonicalHash } from '../../src/db/track-hashes.js';
import * as genreSync from '../../src/db/genre-sync.js';
import {
  initDiscoveryDb, closeDiscoveryDb, getMeta, setMeta, ensureMapTables,
  applyHashTransitionGroups, upsertDiscoveryTrack,
} from '../../src/db/discovery-db.js';

// discovery-similarity.js reads its drift window at import, so it is imported
// (dynamically) only by the last describe, after this is set: 1 ms, so a
// drift the index notices always rebuilds after a short sleep — no test here
// depends on how long anything takes.
process.env.MSTREAM_TEST_SIM_STALE_REBUILD_MS = '1';

let tmpDir;
let ddb;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-map-sync-'));
  ddb = initDiscoveryDb(path.join(tmpDir, 'discovery.db'));
});

after(() => {
  closeDiscoveryDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
  setImmediate(() => process.exit(0));   // module-level timers (manager), like the other DB-backed suites
});

beforeEach(() => {
  ddb.exec('DELETE FROM map_points; DELETE FROM map_regions; DELETE FROM map_layouts;');
});

// Tracks 100 and 102 are copies (h1); 101 has only a file_hash (h2).
function freshMain() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db);
  db.exec(`
    INSERT INTO libraries (id, name, root_path) VALUES (1, 'music', '/music');
    INSERT INTO tracks (id, filepath, library_id, title, audio_hash, file_hash, created_at) VALUES
      (100, 'a/one.mp3',  1, 'One',      'h1', 'f1', '2026-01-01 00:00:00'),
      (101, 'a/two.mp3',  1, 'Two',      NULL, 'h2', '2026-01-02 00:00:00'),
      (102, 'a/copy.mp3', 1, 'One Copy', 'h1', 'f3', '2026-01-03 00:00:00'),
      (103, 'a/four.mp3', 1, 'Four',     'h4', 'f4', '2026-01-04 00:00:00'),
      (104, 'a/five.mp3', 1, 'Five',     'h5', 'f5', '2026-01-05 00:00:00');
  `);
  return db;
}

function addTrack(db, id, hash, createdAt = '2026-01-10 00:00:00') {
  db.prepare(`INSERT INTO tracks (id, filepath, library_id, title, audio_hash, file_hash, created_at)
              VALUES (?, ?, 1, ?, ?, ?, ?)`).run(id, `b/${id}.mp3`, `T${id}`, hash, `fx${id}`, createdAt);
}

function layout(state = 'ready') {
  return Number(ddb.prepare(`
    INSERT INTO map_layouts (state, model_id, method, params, dim, k, pca_mean, pca_axes, affine,
                             frame, aspect, land_levels, n_fit, n_points, created_at, fitted_at)
    VALUES (?, 'test-model', 'umap', '{}', 4, 2, ?, ?, '[1,0,0,0,1,0]', 1, 1, '{}', 0, 0, 0, 0)
  `).run(state, Buffer.alloc(16), Buffer.alloc(32)).lastInsertRowid);
}

function point(layoutId, hash, { dot = hash, x = 0.25, y = 0.75, r0 = 1, r1 = 3, c0 = -0.5, c1 = -0.25 } = {}) {
  ddb.prepare(`
    INSERT INTO map_points (layout_id, audio_hash, dot, x, y, placed, region0, region1, central0, central1, pca)
    VALUES (?, ?, ?, ?, ?, 'knn', ?, ?, ?, ?, ?)
    ON CONFLICT(layout_id, audio_hash) DO UPDATE SET
      dot = excluded.dot, x = excluded.x, y = excluded.y, region0 = excluded.region0,
      region1 = excluded.region1, central0 = excluded.central0, central1 = excluded.central1
  `).run(layoutId, hash, dot, x, y, r0, r1, c0, c1, Buffer.alloc(8));
}

// The generation as { track_id: row without layout/track ids }.
function rows(db, layoutId) {
  const out = {};
  for (const r of db.prepare(`SELECT track_id, hash, dot, x, y, region0, region1, central0, central1
                                FROM track_map WHERE layout_id = ? ORDER BY track_id`).all(layoutId)) {
    const { track_id: id, ...rest } = r;
    out[id] = { ...rest };
  }
  return out;
}

const u16 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 65535);
const epoch = () => getMeta('map_epoch');

// A transparent wrapper around an mstream.db handle that records every write
// transaction: the track_map rows its statements changed and its rev bumps.
// `onBegin(db, n)` runs right after the n-th BEGIN (1-based), inside it.
function spyOn(db, { onBegin } = {}) {
  const log = { begins: 0, txs: [], autocommitWrites: 0 };
  let cur = null;
  const handle = {
    exec(sql) {
      const head = sql.trim().split(/\s+/)[0].toUpperCase();
      const out = db.exec(sql);
      if (head === 'BEGIN') {
        cur = { rows: 0, revBumps: 0 };
        log.begins++;
        onBegin?.(db, log.begins);
      } else if (head === 'COMMIT') {
        log.txs.push(cur);
        cur = null;
      } else if (head === 'ROLLBACK') {
        cur = null;
      }
      return out;
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
      const touchesRows = /\btrack_map\b/.test(sql);   // the table itself, not track_map_meta
      const bumpsRev = /\btrack_map_meta\b/.test(sql) && /\brev\s*=\s*rev\s*\+\s*1/.test(sql);
      return {
        run(...args) {
          const r = stmt.run(...args);
          if (write && !cur) { log.autocommitWrites++; }
          if (write && cur && touchesRows) { cur.rows += r.changes; }
          if (write && cur && bumpsRev) { cur.revBumps += r.changes; }
          return r;
        },
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
  };
  return { handle, log };
}

// ── V81 schema ──────────────────────────────────────────────────────────────

describe('V81 schema', () => {
  test('SCHEMA_VERSION covers V81 and the migration is registered, with no rescan', () => {
    assert.ok(SCHEMA_VERSION >= 81, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
    const v81 = MIGRATIONS.find((m) => m.version === 81);
    assert.ok(v81, 'missing v81 migration');
    assert.ok(!v81.rescanRequired, 'new tables — nothing comes from tags');
    assert.ok(!v81.js, 'no procedural hook');
  });

  test('track_map, its indexes and the one-row pointer', () => {
    const db = freshMain();
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.deepEqual(cols('track_map'),
      ['layout_id', 'track_id', 'hash', 'dot', 'x', 'y', 'region0', 'region1', 'central0', 'central1']);
    assert.deepEqual(cols('track_map_meta'), ['id', 'active_layout', 'map_epoch', 'rev', 'added_max']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'track_map'")
      .all().map((r) => r.name);
    for (const name of ['idx_track_map_track', 'idx_track_map_dot', 'idx_track_map_hash',
      'idx_track_map_r0', 'idx_track_map_r1']) {
      assert.ok(idx.includes(name), name);
    }
    assert.deepEqual(readTrackMapPointer(db), { active_layout: null, map_epoch: null, rev: 0, added_max: null });
    assert.throws(() => db.prepare('INSERT INTO track_map_meta (id) VALUES (2)').run(), /CHECK constraint/);
    db.close();
  });

  test('a deleted track takes its rows from every generation along', () => {
    const db = freshMain();
    const ins = db.prepare(`INSERT INTO track_map (layout_id, track_id, hash, dot, x, y, region0, region1, central0, central1)
                            VALUES (?, ?, 'h1', 'h1', 0, 0, 0, 0, 0, 0)`);
    ins.run(1, 100);
    ins.run(2, 100);
    ins.run(2, 102);
    db.prepare('DELETE FROM tracks WHERE id = 100').run();
    assert.deepEqual(db.prepare('SELECT layout_id, track_id FROM track_map ORDER BY layout_id').all()
      .map((r) => [r.layout_id, r.track_id]), [[2, 102]]);
    db.close();
  });
});

// ── The shared track-hash helper ────────────────────────────────────────────

describe('tracksByCanonicalHash', () => {
  test('lives in track-hashes.js; genre-sync.js re-exports the same function', () => {
    assert.equal(genreSync.tracksByCanonicalHash, tracksByCanonicalHash);
    const db = freshMain();
    const map = tracksByCanonicalHash(db);
    assert.deepEqual(map.get('h1').slice().sort(), [100, 102], 'copies share the canonical hash');
    assert.deepEqual(map.get('h2'), [101], 'file_hash when there is no audio_hash');
    assert.equal(map.get('f1'), undefined, 'a file_hash under an audio_hash is not canonical');
    db.close();
  });
});

// ── reconcileTrackMap ───────────────────────────────────────────────────────

describe('reconcileTrackMap', () => {
  test('copies and group members share a dot and its values, u16-quantised', () => {
    const db = freshMain();
    const L = layout();
    point(L, 'h1', { x: 0.25, y: 0.75, r0: 4, r1: 9, c0: -0.125, c1: -0.0625 });
    point(L, 'h2', { x: -0.01, y: 1.02 });            // a warm refit's overhang clamps to the edge
    point(L, 'h4', { dot: 'h4', x: 0.6, y: 0.4 });    // a near-duplicate group labelled 'h4' …
    point(L, 'h5', { dot: 'h4', x: 0.6, y: 0.4 });    // … whose members all carry its values
    point(L, 'gone', { x: 0.9, y: 0.9 });             // no library file — no row

    const stats = reconcileTrackMap(db, ddb, L);
    assert.deepEqual(stats, { points: 5, tracks: 5, written: 5, removed: 0, addedMax: '2026-01-05 00:00:00' });
    const r = rows(db, L);
    assert.deepEqual(Object.keys(r).map(Number), [100, 101, 102, 103, 104]);
    assert.deepEqual(r[100], { hash: 'h1', dot: 'h1', x: u16(0.25), y: u16(0.75), region0: 4, region1: 9,
      central0: -0.125, central1: -0.0625 });
    assert.deepEqual(r[102], r[100], 'the copy shares the row');
    assert.equal(r[101].hash, 'h2');
    assert.deepEqual([r[101].x, r[101].y], [0, 65535]);
    assert.equal(r[103].dot, 'h4');
    assert.equal(r[104].dot, 'h4');
    assert.equal(r[104].hash, 'h5', 'each track keeps its own hash');
    assert.deepEqual([r[104].x, r[104].y], [r[103].x, r[103].y]);
    db.close();
  });

  test('a moved file (new id, same hash) gets a row; tracks with no point lose theirs', () => {
    const db = freshMain();
    const L = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L, h); }
    reconcileTrackMap(db, ddb, L);
    assert.deepEqual(Object.keys(rows(db, L)).map(Number), [100, 101, 102, 103]);

    db.prepare('DELETE FROM tracks WHERE id = 100').run();   // the move: the old row goes (cascade) …
    addTrack(db, 110, 'h1');                                // … and the new path keeps the hash
    ddb.prepare("DELETE FROM map_points WHERE layout_id = ? AND audio_hash = 'h2'").run(L);   // pruned point
    db.prepare("UPDATE tracks SET audio_hash = 'h9' WHERE id = 103").run();               // new audio, unplaced

    const stats = reconcileTrackMap(db, ddb, L);
    assert.equal(stats.written, 1);
    assert.equal(stats.removed, 2);
    const r = rows(db, L);
    assert.deepEqual(Object.keys(r).map(Number), [102, 110]);
    assert.deepEqual(r[110], r[102], 'the moved file lands on its dot');
    db.close();
  });

  test('a no-op reconcile writes nothing and leaves rev alone', () => {
    const db = freshMain();
    const L = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L, h); }
    reconcileTrackMap(db, ddb, L);
    flipTrackMap(db, { layoutId: L, mapEpoch: epoch() });
    const pointer = readTrackMapPointer(db);

    const spy = spyOn(db);
    const stats = reconcileTrackMap(spy.handle, ddb, L);
    assert.equal(stats.written, 0);
    assert.equal(stats.removed, 0);
    assert.equal(spy.log.begins, 0, 'no transaction opened');
    assert.equal(spy.log.autocommitWrites, 0, 'no statement wrote');
    assert.deepEqual(readTrackMapPointer(db), pointer);
    db.close();
  });

  test('FK-guarded inserts skip a track deleted mid-reconcile instead of aborting', () => {
    const db = freshMain();
    const L = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L, h); }
    // An admin library removal lands between the reads and the writes.
    const spy = spyOn(db, { onBegin: (raw, n) => { if (n === 1) { raw.prepare('DELETE FROM tracks WHERE id = 103').run(); } } });
    const stats = reconcileTrackMap(spy.handle, ddb, L);
    assert.equal(stats.tracks, 4);
    assert.equal(stats.written, 3);
    assert.deepEqual(Object.keys(rows(db, L)).map(Number), [100, 101, 102]);
    db.close();
  });

  test('writes are chunked: at most `chunk` rows per transaction', () => {
    assert.equal(TRACK_MAP_CHUNK, 2000);
    const db = freshMain();
    const L = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L, h); }
    for (let i = 0; i < 21; i++) { addTrack(db, 200 + i, `hx${i}`); point(L, `hx${i}`, { x: i / 21 }); }

    let spy = spyOn(db);
    let stats = reconcileTrackMap(spy.handle, ddb, L, { chunk: 4 });
    assert.equal(stats.written, 25);
    assert.deepEqual(spy.log.txs.map((t) => t.rows), [4, 4, 4, 4, 4, 4, 1]);

    // A mixed diff: 5 moved points (6 rows: h1 has two files) and 3 pruned ones.
    for (const h of ['h1', 'hx0', 'hx1', 'hx2', 'hx3']) { point(L, h, { x: 0.99 }); }
    ddb.prepare("DELETE FROM map_points WHERE layout_id = ? AND audio_hash IN ('hx4', 'hx5', 'hx6')").run(L);
    spy = spyOn(db);
    stats = reconcileTrackMap(spy.handle, ddb, L, { chunk: 3 });
    assert.deepEqual([stats.written, stats.removed], [6, 3]);
    assert.deepEqual(spy.log.txs.map((t) => t.rows), [3, 3, 3]);
    assert.ok(spy.log.txs.every((t) => t.rows <= 3));

    assert.throws(() => reconcileTrackMap(db, ddb, L, { chunk: 0 }), RangeError);
    db.close();
  });

  test('reads page through several keyset pages on both sides, edges included', () => {
    const db = freshMain();
    const L = layout();
    const N = 12000;   // more than two of the 5,000-row read pages
    const insT = db.prepare(`INSERT INTO tracks (id, filepath, library_id, title, audio_hash, file_hash)
                             VALUES (?, ?, 1, 't', ?, ?)`);
    const insP = ddb.prepare(`INSERT INTO map_points (layout_id, audio_hash, dot, x, y, placed, region0, region1,
                                                      central0, central1, pca)
                              VALUES (?, ?, ?, ?, 0.5, 'knn', 0, 0, -1, -1, ?)`);
    db.exec('BEGIN');
    ddb.exec('BEGIN');
    for (let i = 0; i < N; i++) {
      insT.run(1000 + i, `p/${i}.mp3`, `hp${i}`, `fp${i}`);
      insP.run(L, `hp${i}`, `hp${i}`, (i % 100) / 100, Buffer.alloc(8));
    }
    ddb.exec('COMMIT');
    db.exec('COMMIT');
    const first = reconcileTrackMap(db, ddb, L);
    assert.deepEqual([first.points, first.tracks, first.written], [N, N, N]);

    // Changes on both sides of each page edge (points 5,000 / 10,000 by id; track rows likewise).
    for (const i of [4999, 5000, 5001, 9999, 10000]) { point(L, `hp${i}`, { x: 0.999 }); }
    ddb.prepare("DELETE FROM map_points WHERE layout_id = ? AND audio_hash = 'hp7000'").run(L);
    addTrack(db, 50000, 'hp11999');   // a copy past the last existing row
    const second = reconcileTrackMap(db, ddb, L);
    assert.deepEqual([second.points, second.written, second.removed], [N - 1, 6, 1]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(L).n, N);
    assert.deepEqual([reconcileTrackMap(db, ddb, L).written, reconcileTrackMap(db, ddb, L).removed], [0, 0]);
    db.close();
  });

  test('a serving generation bumps rev once per chunk that changed rows; a new generation never', () => {
    const db = freshMain();
    const L1 = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L1, h); }
    reconcileTrackMap(db, ddb, L1);
    flipTrackMap(db, { layoutId: L1, mapEpoch: epoch() });
    const rev0 = readTrackMapPointer(db).rev;

    // A rebuild writes L2 while L1 serves: invisible, so its chunks leave rev alone.
    const L2 = layout();
    for (const h of ['h1', 'h2', 'h4', 'h5']) { point(L2, h, { x: 0.5 }); }
    let spy = spyOn(db);
    reconcileTrackMap(spy.handle, ddb, L2, { chunk: 2 });
    assert.equal(spy.log.txs.length, 3);
    assert.ok(spy.log.txs.every((t) => t.revBumps === 0), 'no bump for an invisible generation');
    assert.equal(readTrackMapPointer(db).rev, rev0);

    // A place run on the serving L1: 5 changed rows in chunks of 2 → 3 bumps.
    point(L1, 'h1', { x: 0.1 });   // 2 rows (copies)
    point(L1, 'h4', { x: 0.1 });   // 1 row
    point(L1, 'h5', { x: 0.1 });   // 1 new row
    ddb.prepare("DELETE FROM map_points WHERE layout_id = ? AND audio_hash = 'h2'").run(L1);   // 1 removal
    spy = spyOn(db);
    const stats = reconcileTrackMap(spy.handle, ddb, L1, { chunk: 2 });
    assert.deepEqual([stats.written, stats.removed], [4, 1]);
    assert.deepEqual(spy.log.txs.map((t) => [t.rows, t.revBumps]), [[2, 1], [2, 1], [1, 1]],
      'rev moves in the same transaction as the rows it describes');
    assert.equal(readTrackMapPointer(db).rev, rev0 + 3);
    db.close();
  });

  test('added_max follows the serving generation; a new one hands it to the flip', () => {
    const db = freshMain();
    const L = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L, h); }
    const first = reconcileTrackMap(db, ddb, L);
    assert.equal(first.addedMax, '2026-01-04 00:00:00');
    assert.equal(readTrackMapPointer(db).added_max, null, 'not serving yet: the pointer is untouched');
    flipTrackMap(db, { layoutId: L, mapEpoch: epoch(), addedMax: first.addedMax });
    assert.equal(readTrackMapPointer(db).added_max, '2026-01-04 00:00:00');

    addTrack(db, 111, 'h4', '2026-02-01 00:00:00');   // a new copy of a placed song
    let stats = reconcileTrackMap(db, ddb, L);
    assert.equal(stats.written, 1);
    assert.equal(stats.addedMax, '2026-02-01 00:00:00');
    assert.equal(readTrackMapPointer(db).added_max, '2026-02-01 00:00:00');

    // A cascade delete leaves it high until the next reconcile, which fixes it
    // without a row write — and without a rev bump: the rev reads it directly.
    db.prepare('DELETE FROM tracks WHERE id = 111').run();
    const rev = readTrackMapPointer(db).rev;
    stats = reconcileTrackMap(db, ddb, L);
    assert.deepEqual([stats.written, stats.removed], [0, 0]);
    assert.deepEqual([readTrackMapPointer(db).added_max, readTrackMapPointer(db).rev], ['2026-01-04 00:00:00', rev]);
    assert.equal(generationAddedMax(db, L), '2026-01-04 00:00:00');
    assert.equal(generationAddedMax(db, L + 1000), null, 'an empty generation');
    db.close();
  });

  test('a re-key through applyHashTransitionGroups keeps every track\'s row and position', () => {
    const db = freshMain();
    const L = layout();
    point(L, 'h1', { x: 0.1, y: 0.2, r0: 1, r1: 2 });              // a singleton: its dot is its own hash
    point(L, 'h4', { dot: 'h4', x: 0.6, y: 0.6, r0: 5, r1: 7 });   // a group's label member …
    point(L, 'h5', { dot: 'h4', x: 0.6, y: 0.6, r0: 5, r1: 7 });   // … and its other member
    reconcileTrackMap(db, ddb, L);
    flipTrackMap(db, { layoutId: L, mapEpoch: epoch() });
    const before_ = rows(db, L);

    // The scanner re-keys the files (a V60 hash transition) and the drain
    // applies the ledger to discovery.db, map points included.
    db.exec(`UPDATE tracks SET audio_hash = 'h1n' WHERE audio_hash = 'h1';
             UPDATE tracks SET audio_hash = 'h4n' WHERE audio_hash = 'h4';`);
    const out = applyHashTransitionGroups([
      { target: 'h1n', sources: ['h1'] },
      { target: 'h4n', sources: ['h4'] },
    ]);
    assert.deepEqual([out.pointsMoved, out.pointsDropped], [2, 0]);

    const stats = reconcileTrackMap(db, ddb, L);
    assert.equal(stats.removed, 0, 'no track lost its row');
    assert.equal(stats.written, 3, 'only the hash moved: tracks 100 and 102 (h1n), 103 (h4n)');
    const after_ = rows(db, L);
    assert.deepEqual(Object.keys(after_), Object.keys(before_));
    for (const id of Object.keys(before_)) {
      const { hash: _was, ...placeBefore } = before_[id];
      const { hash: _is, ...placeAfter } = after_[id];
      assert.deepEqual(placeAfter, placeBefore, `track ${id} kept its dot and position`);
    }
    assert.deepEqual([after_[100].hash, after_[102].hash, after_[103].hash, after_[104].hash],
      ['h1n', 'h1n', 'h4n', 'h5']);
    assert.deepEqual([after_[100].dot, after_[103].dot, after_[104].dot], ['h1', 'h4', 'h4'],
      'labels are opaque: the singleton keeps its label, the group still shares one dot');
    db.close();
  });
});

// ── The flip, the old generation's delete, the pointer ──────────────────────

describe('flip and generations', () => {
  test('the flip points at the new generation in one transaction; the old one goes in chunks', () => {
    const db = freshMain();
    const L1 = layout();
    for (const h of ['h1', 'h2', 'h4', 'h5']) { point(L1, h); }
    reconcileTrackMap(db, ddb, L1);
    flipTrackMap(db, { layoutId: L1, mapEpoch: epoch() });
    const L2 = layout();
    for (const h of ['h1', 'h2', 'h4']) { point(L2, h, { x: 0.5 }); }
    const built = reconcileTrackMap(db, ddb, L2);
    const before_ = readTrackMapPointer(db);

    let spy = spyOn(db);
    const { rev } = flipTrackMap(spy.handle, { layoutId: L2, mapEpoch: epoch(), addedMax: built.addedMax });
    assert.equal(spy.log.txs.length, 1, 'one tiny transaction');
    assert.equal(spy.log.txs[0].rows, 0, 'the flip writes no row');
    assert.deepEqual(readTrackMapPointer(db),
      { active_layout: L2, map_epoch: epoch(), rev: before_.rev + 1, added_max: '2026-01-04 00:00:00' });
    assert.equal(rev, before_.rev + 1);

    // L1 (5 rows) is now invisible: deleted in chunks of 2, rev untouched.
    spy = spyOn(db);
    const removed = deleteTrackMapGenerations(spy.handle, { keep: L2, chunk: 2 });
    assert.equal(removed, 5);
    assert.deepEqual(spy.log.txs.map((t) => t.rows), [2, 2, 1]);
    assert.ok(spy.log.txs.every((t) => t.revBumps === 0));
    assert.equal(readTrackMapPointer(db).rev, before_.rev + 1);
    assert.deepEqual(Object.keys(rows(db, L1)), []);
    assert.deepEqual(Object.keys(rows(db, L2)).map(Number), [100, 101, 102, 103]);
    db.close();
  });

  test('the serving generation is never deleted from under its pointer', () => {
    const db = freshMain();
    const L1 = layout();
    point(L1, 'h1');
    reconcileTrackMap(db, ddb, L1);
    flipTrackMap(db, { layoutId: L1, mapEpoch: epoch() });
    const L2 = layout();
    point(L2, 'h4');
    reconcileTrackMap(db, ddb, L2);

    assert.equal(deleteTrackMapGenerations(db, { keep: L2 }), 0, 'L1 serves, L2 is kept');
    assert.equal(deleteTrackMapGenerations(db), 1, 'keep = null still spares the serving L1');
    assert.deepEqual(Object.keys(rows(db, L1)).map(Number), [100, 102]);

    // The `empty` mode: clear the pointer first, then everything goes.
    const rev = readTrackMapPointer(db).rev;
    assert.equal(clearTrackMapPointer(db), true);
    assert.deepEqual(readTrackMapPointer(db), { active_layout: null, map_epoch: null, rev: rev + 1, added_max: null });
    assert.equal(clearTrackMapPointer(db), false, 'already empty: no write, no bump');
    assert.equal(readTrackMapPointer(db).rev, rev + 1);
    assert.equal(deleteTrackMapGenerations(db, { chunk: 1 }), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_map').get().n, 0);
    db.close();
  });

  test('flipTrackMap refuses a pointer that could never validate', () => {
    const db = freshMain();
    assert.throws(() => flipTrackMap(db, { layoutId: 1 }), /map_epoch/);
    assert.throws(() => flipTrackMap(db, { layoutId: 1, mapEpoch: '' }), /map_epoch/);
    assert.throws(() => flipTrackMap(db, { layoutId: '1', mapEpoch: epoch() }), /layoutId/);
    assert.equal(readTrackMapPointer(db).rev, 0);
    db.close();
  });

  test('a missing pointer row is recreated by the flip', () => {
    const db = freshMain();
    db.prepare('DELETE FROM track_map_meta').run();
    assert.deepEqual(readTrackMapPointer(db), { active_layout: null, map_epoch: null, rev: 0, added_max: null });
    const L = layout();
    point(L, 'h1');
    reconcileTrackMap(db, ddb, L);
    flipTrackMap(db, { layoutId: L, mapEpoch: epoch() });
    assert.deepEqual(readTrackMapPointer(db),
      { active_layout: L, map_epoch: epoch(), rev: 1, added_max: '2026-01-03 00:00:00' });
    db.close();
  });

  test('mapPointerValid: the current epoch and a ready layout, nothing else', () => {
    const db = freshMain();
    const ready = layout('ready');
    const building = layout('building');
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), false, 'no pointer');

    flipTrackMap(db, { layoutId: ready, mapEpoch: epoch() });
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), true);
    flipTrackMap(db, { layoutId: building, mapEpoch: epoch() });
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), false, 'a layout still building');
    flipTrackMap(db, { layoutId: ready + 1000, mapEpoch: epoch() });
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), false, 'a layout that is gone');
    flipTrackMap(db, { layoutId: ready, mapEpoch: '0123456789abcdef' });
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), false, 'another discovery.db\'s epoch');

    // A map-table reset renames the generation: yesterday's pointer stops validating.
    flipTrackMap(db, { layoutId: ready, mapEpoch: epoch() });
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), true);
    setMeta('map_schema', '0');
    ensureMapTables();
    const fresh = layout('ready');
    assert.equal(fresh, 1, 'layout ids restart after the reset');
    assert.equal(mapPointerValid(readTrackMapPointer(db), ddb), false);
    assert.equal(mapPointerValid({ ...readTrackMapPointer(db), active_layout: fresh }, ddb), false,
      'even when the old id names a new ready layout');
    db.close();
  });
});

// ── The similarity index absorbs the map pass's own commits ─────────────────

describe('the similarity index absorbs the map worker\'s mstream.db commits', () => {
  let testRoot;
  let manager;
  let sim;
  let worker;

  before(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-map-sync-sim-'));
    fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory: path.join(testRoot, 'db'),
        albumArtDirectory: path.join(testRoot, 'art'),
        logsDirectory: path.join(testRoot, 'logs'),
      },
      port: 0,
    }));
    const config = await import('../../src/state/config.js');
    await config.setup(path.join(testRoot, 'config.json'));
    manager = await import('../../src/db/manager.js');
    sim = await import('../../src/db/discovery-similarity.js');
    manager.initDB();
    // The map worker's own connection to mstream.db.
    worker = new DatabaseSync(path.join(testRoot, 'db', 'mstream.db'));
    worker.exec('PRAGMA busy_timeout = 5000');
    const model = config.program.scanOptions.discoveryModel;
    const blob = (v) => Buffer.from(new Float32Array(v).buffer);
    upsertDiscoveryTrack({ audioHash: 'sim-a', artist: 'A', title: 'a', modelId: model, embedding: blob([1, 0, 0, 0]) });
    upsertDiscoveryTrack({ audioHash: 'sim-b', artist: 'B', title: 'b', modelId: model, embedding: blob([0, 1, 0, 0]) });
  });

  after(() => {
    try { worker?.close(); } catch (_e) { /* closed */ }
    try { manager?.close(); } catch (_e) { /* closed */ }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
  });

  const mirrorCommit = () => worker.prepare('UPDATE track_map_meta SET rev = rev + 1 WHERE id = 1').run();

  test('absorbed commits are no drift; unabsorbed ones still rebuild after the window', async () => {
    sim.invalidate();
    const built = sim.getIndex();
    const before_ = sim.libraryVersionNow();
    assert.notEqual(before_, null);
    mirrorCommit();
    const after_ = sim.libraryVersionNow();
    assert.notEqual(after_, before_, 'another connection committed');

    assert.equal(sim.absorbLibraryVersion(before_, after_), true);
    await sleep(20);   // well past the 1 ms window, so only drift decides
    assert.equal(sim.getIndex(), built, 'nothing left to rebuild for');

    mirrorCommit();    // the same write, not absorbed: library drift
    await sleep(20);
    assert.notEqual(sim.getIndex(), built, 'unabsorbed drift rebuilds — the control');
  });

  test('refused when the cache moved on, when no index is cached, or without readings', () => {
    sim.invalidate();
    assert.equal(sim.absorbLibraryVersion(1, 2), false, 'no cached index');
    const built = sim.getIndex();
    const v = built.libVersion;
    assert.equal(sim.absorbLibraryVersion(v + 1, v + 2), false, 'rebuilt since `before` was read');
    assert.equal(sim.absorbLibraryVersion(null, v + 2), false);
    assert.equal(sim.absorbLibraryVersion(v, null), false);
    assert.equal(built.libVersion, v, 'a refusal changes nothing');
  });
});
