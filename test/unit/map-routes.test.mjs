/**
 * The music map routes' pure helpers and caches (src/api/discovery-map.js;
 * docs/music-map-plan.md §3.8.2–§3.8.3, §3.12):
 *
 *   - mapState: every row of §3.8.3 (ready / building / failed / empty) plus
 *     the 'disabled' answer behind the gate's environment 403;
 *   - mapRev: moves with every part, ignores grant order, and ignores the
 *     calendar day while no mirrored song can be recent;
 *   - derivePayload: representative = MIN visible id, points sorted by it,
 *     visible sizes, recent from the visible members' first arrival;
 *   - perf guard 2: the base-cache builder prepares its statement once per
 *     build whatever n, and yields between pages;
 *   - perf guard 3: two requests for one rev build once (single-flight plus
 *     the LRU), and a build that saw the pointer move is retried once.
 *
 * No wall-clock: every time input is an explicit nowMs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import {
  mapState, mapRev, recentWindow, derivePayload, buildBaseCache, createMapCache,
} from '../../src/api/discovery-map.js';
import {
  encodePointsColsV1, decodePointsColsV1, sqliteUtcToSec, REGION_NONE, MAP_FLAG_RECENT,
} from '../../src/db/map-lib.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 15, 30, 0);   // 2026-11-02 15:30 UTC

// ── mapState ────────────────────────────────────────────────────────────────

describe('mapState (§3.8.3)', () => {
  const pass = (patch = {}) => ({ pass: 'map', enabled: true, disabledReason: null, state: 'idle', progress: null, lastRun: null, ...patch });
  const run = (outcome) => ({ finishedAt: 1, outcome, hitCap: false, counts: null });
  const disc = (reason) => ({ pass: 'discovery', enabled: reason === null, disabledReason: reason, state: 'idle' });

  test('a valid serving layout is ready, whatever the passes say', () => {
    assert.equal(mapState({ serving: true }), 'ready');
    assert.equal(mapState({ serving: true, vectors: false, map: pass({ disabledReason: 'failing', lastRun: run('failed') }), discovery: disc('no-ffmpeg') }), 'ready');
  });

  test('building: a pass queued or running, or vectors with no pass finished since boot', () => {
    assert.equal(mapState({ vectors: true, map: pass({ state: 'queued' }) }), 'building');
    assert.equal(mapState({ vectors: true, map: pass({ state: 'running' }) }), 'building');
    assert.equal(mapState({ vectors: false, map: pass({ state: 'running' }) }), 'building', 'a running pass builds even before vectors are visible');
    assert.equal(mapState({ vectors: true, map: pass() }), 'building', 'no lastRun yet');
    assert.equal(mapState({ vectors: true, map: null }), 'building', 'no map pass registered at all');
    assert.equal(mapState({ vectors: true, map: pass({ state: 'queued', lastRun: run('failed') }) }), 'building',
      'a queued retry outranks the failed run before it');
  });

  test('failed: vectors, and the last pass did not complete or the pass is latched off', () => {
    assert.equal(mapState({ vectors: true, map: pass({ lastRun: run('failed') }) }), 'failed');
    assert.equal(mapState({ vectors: true, map: pass({ lastRun: run('killed') }) }), 'failed', 'the timeout kill counts');
    assert.equal(mapState({ vectors: true, map: pass({ state: 'disabled', enabled: false, disabledReason: 'failing', lastRun: run('failed') }) }), 'failed');
    assert.equal(mapState({ vectors: true, map: pass({ state: 'disabled', enabled: false, disabledReason: 'failing', lastRun: run('completed') }) }), 'failed',
      'the latch wins over an older completed run');
  });

  test('empty: nothing analysed yet, or the last pass completed with nothing to serve', () => {
    assert.equal(mapState({ vectors: false, map: pass() }), 'empty');
    assert.equal(mapState({ vectors: false, map: null, discovery: null }), 'empty');
    assert.equal(mapState({ vectors: false, map: pass({ lastRun: run('failed') }) }), 'empty', 'no vectors: nothing could have been drawn');
    assert.equal(mapState({ vectors: true, map: pass({ lastRun: run('completed') }) }), 'empty',
      'every embedded song left the library: the pass ran empty mode');
    assert.equal(mapState({ vectors: false, discovery: disc('config') }), 'empty', 'a config reason is not an environment one');
  });

  test('disabled (the gate\'s 403): no layout, no vector, the embedding pass off for an environment reason', () => {
    assert.equal(mapState({ vectors: false, discovery: disc('runtime-unavailable') }), 'disabled');
    assert.equal(mapState({ vectors: false, discovery: disc('no-ffmpeg') }), 'disabled');
    assert.equal(mapState({ vectors: false, map: pass({ state: 'running' }), discovery: disc('no-ffmpeg') }), 'disabled',
      'nothing can ever be drawn, running pass or not');
    assert.equal(mapState({ vectors: true, map: pass(), discovery: disc('no-ffmpeg') }), 'building',
      'existing vectors can still be laid out');
  });
});

// ── mapRev ──────────────────────────────────────────────────────────────────

describe('mapRev (§3.8.2)', () => {
  const parts = {
    mapEpoch: '0123456789abcdef', layoutId: 7, rev: 12, n: 940, mapVersion: '3',
    libraryIds: [1, 2], addedMax: '2026-01-05 10:00:00', recentAfter: '2026-01-01 00:00:00',
    nowMs: NOW, state: 'ready',
  };

  test('a short hex digest, stable for equal parts', () => {
    const r = mapRev(parts);
    assert.match(r, /^[0-9a-f]{16}$/);
    assert.equal(mapRev({ ...parts }), r);
  });

  test('changes with each part', () => {
    const r = mapRev(parts);
    for (const [k, v] of [
      ['mapEpoch', 'fedcba9876543210'], ['layoutId', 8], ['rev', 13], ['n', 939],
      ['mapVersion', '4'], ['libraryIds', [1]], ['state', 'building'],
    ]) {
      assert.notEqual(mapRev({ ...parts, [k]: v }), r, `${k} must move the rev`);
    }
    // The recent part, while a song can be recent.
    const fresh = { ...parts, addedMax: '2026-11-01 08:00:00' };
    assert.notEqual(mapRev(fresh), r, 'a mirrored song newer than the baseline and the cutoff');
  });

  test('grant order does not matter; grant sets do', () => {
    assert.equal(mapRev({ ...parts, libraryIds: [2, 1] }), mapRev(parts));
    assert.notEqual(mapRev({ ...parts, libraryIds: [1, 2, 3] }), mapRev(parts));
  });

  test('ignores the day while added_max is older than the cutoff', () => {
    const old = { ...parts, addedMax: '2026-09-01 00:00:00' };   // > 30 days before NOW
    assert.equal(mapRev({ ...old, nowMs: NOW + DAY }), mapRev(old));
    assert.equal(mapRev({ ...old, nowMs: NOW + 40 * DAY }), mapRev(old));
  });

  test('ignores the day while added_max is not after the baseline', () => {
    const settled = { ...parts, addedMax: '2026-11-01 08:00:00', recentAfter: '2026-11-01 08:00:00' };
    assert.equal(mapRev({ ...settled, nowMs: NOW + DAY }), mapRev(settled));
  });

  test('no baseline yet rings nothing, so the day stays out', () => {
    const fresh = { ...parts, addedMax: '2026-11-01 08:00:00', recentAfter: null };
    assert.equal(mapRev({ ...fresh, nowMs: NOW + DAY }), mapRev(fresh));
  });

  test('moves across midnight while some song is recent, not within the day', () => {
    const recent = { ...parts, addedMax: '2026-11-01 08:00:00' };
    assert.notEqual(mapRev({ ...recent, nowMs: NOW + DAY }), mapRev(recent));
    assert.equal(mapRev({ ...recent, nowMs: NOW + 60 * 60 * 1000 }), mapRev(recent), 'same UTC day, same rev');
  });
});

describe('recentWindow', () => {
  test('cutoff = 00:00 UTC thirty days back; no baseline = nothing recent', () => {
    const w = recentWindow('2026-01-01 00:00:00', NOW);
    assert.equal(w.afterSec, sqliteUtcToSec('2026-01-01 00:00:00'));
    assert.equal(w.cutoffSec, sqliteUtcToSec('2026-10-03 00:00:00'));
    assert.equal(recentWindow(null, NOW).afterSec, Infinity);
  });
});

// ── derivePayload ───────────────────────────────────────────────────────────

// A hand-built base: tracks in id order across two libraries.
//   dot 0: tracks 3 (lib 1, old) and 9 (lib 2, new)  — a copy in each library
//   dot 1: tracks 4 and 5 (lib 1)                    — near-duplicates
//   dot 2: track 7 (lib 2)
//   dot 3: track 8 (lib 1), no town (REGION_NONE)
function handBase() {
  const sec = (t) => sqliteUtcToSec(t);
  return {
    layoutId: 1,
    n: 6,
    trackId: Uint32Array.from([3, 4, 5, 7, 8, 9]),
    libId: Int32Array.from([1, 1, 1, 2, 1, 2]),
    created: Float64Array.from([
      sec('2025-01-01 00:00:00'), sec('2026-10-30 00:00:00'), sec('2026-10-31 00:00:00'),
      sec('2026-10-29 12:00:00'), sec('2026-10-28 00:00:00'), sec('2026-11-01 00:00:00'),
    ]),
    trackDot: Uint32Array.from([0, 1, 1, 2, 3, 0]),
    nDots: 4,
    dotX: Uint16Array.from([100, 200, 300, 400]),
    dotY: Uint16Array.from([1000, 2000, 3000, 4000]),
    dotR0: Uint8Array.from([0, 0, 1, 0]),
    dotR1: Uint8Array.from([0, 1, 2, REGION_NONE]),
  };
}
const recent = recentWindow('2026-10-01 00:00:00', NOW);   // cutoff 2026-10-03

describe('derivePayload (§3.8.2)', () => {
  test('every library visible: representative = MIN id, sorted by it, dot values and visible sizes', () => {
    const p = derivePayload(handBase(), { coversAllLibraries: true, params: [1, 2] }, recent);
    assert.equal(p.n, 4);
    assert.deepEqual([...p.ids], [3, 4, 7, 8], 'one point per dot, ascending representative ids');
    assert.deepEqual([...p.x], [100, 200, 300, 400]);
    assert.deepEqual([...p.y], [1000, 2000, 3000, 4000]);
    assert.deepEqual([...p.region0], [0, 0, 1, 0]);
    assert.deepEqual([...p.region1], [0, 1, 2, REGION_NONE]);
    assert.deepEqual([...p.pos], [0, 1, 2, 3]);
    assert.equal(p.sizes0[0], 3);
    assert.equal(p.sizes0[1], 1);
    assert.equal(p.sizes1[0], 1);
    assert.equal(p.sizes1[1], 1);
    assert.equal(p.sizes1[2], 1);
    assert.equal(p.sizes1[REGION_NONE], 0, 'REGION_NONE is never counted');
    // Recent: the visible members' first arrival after both the baseline and the cutoff.
    assert.deepEqual([...p.flags], [0, MAP_FLAG_RECENT, MAP_FLAG_RECENT, MAP_FLAG_RECENT],
      'dot 0 arrived in 2025 (its lib-1 copy), the rest in late October');
    // The columns are exactly what cols-v1 encodes.
    const back = decodePointsColsV1(encodePointsColsV1(p), p.n);
    assert.deepEqual([...back.ids], [...p.ids]);
  });

  test('one library visible: representatives, sizes and recency follow what the caller sees', () => {
    const p = derivePayload(handBase(), { coversAllLibraries: false, params: [2] }, recent);
    assert.deepEqual([...p.ids], [7, 9], 'dot 0 is represented by its lib-2 copy');
    assert.deepEqual([...p.pos], [1, -1, 0, -1], 'invisible dots map to −1');
    assert.equal(p.sizes0[0], 1);
    assert.equal(p.sizes0[1], 1);
    assert.deepEqual([...p.flags], [MAP_FLAG_RECENT, MAP_FLAG_RECENT],
      'the copy this caller sees arrived on 2026-11-01, so dot 0 is recent for them');
  });

  test('no grants: no points', () => {
    const p = derivePayload(handBase(), { coversAllLibraries: false, params: [] }, recent);
    assert.equal(p.n, 0);
    assert.equal(p.ids.length, 0);
  });

  test('no baseline: nothing is recent', () => {
    const p = derivePayload(handBase(), { coversAllLibraries: true, params: [1, 2] }, recentWindow(null, NOW));
    assert.deepEqual([...p.flags], [0, 0, 0, 0]);
  });
});

// ── the base cache and the payload LRU (perf guards 2 and 3) ────────────────

// An in-memory mstream.db at the current schema with one library, `n`
// tracks and a serving track_map generation (layout 5) of n/2 dots, plus
// rows of another generation (layout 4) that must never be read.
function mirrorDb(n) {
  const mdb = new DatabaseSync(':memory:');
  applyAllMigrations(mdb);
  mdb.prepare("INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('lib', '/lib', 'music', 0)").run();
  const lib = mdb.prepare('SELECT id FROM libraries').get().id;
  const addTrack = mdb.prepare("INSERT INTO tracks (filepath, library_id, created_at) VALUES (?, ?, '2026-01-01 00:00:00')");
  const addRow = mdb.prepare(`INSERT INTO track_map (layout_id, track_id, hash, dot, x, y, region0, region1, central0, central1)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`);
  mdb.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const id = Number(addTrack.run(`t${i}.mp3`, lib).lastInsertRowid);
    const dot = `d${Math.floor(i / 2)}`;
    addRow.run(5, id, `h${i}`, dot, i % 65536, (2 * i) % 65536);
    if (i % 3 === 0) { addRow.run(4, id, `h${i}`, `old${i}`, 1, 1); }
  }
  mdb.prepare("UPDATE track_map_meta SET active_layout = 5, map_epoch = 'e0', rev = 1 WHERE id = 1").run();
  mdb.exec('COMMIT');
  return mdb;
}

// Counts prepare() calls on a handle; everything else passes through.
function prepareSpy(mdb) {
  const spy = { prepares: 0 };
  spy.db = new Proxy(mdb, {
    get(target, prop) {
      if (prop === 'prepare') { return (sql) => { spy.prepares++; return target.prepare(sql); }; }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return spy;
}

describe('buildBaseCache (perf guard 2)', () => {
  test('one prepare per build whatever n, and a yield between pages', async () => {
    for (const [n, pageSize, pages] of [[100, 5000, 1], [5000, 5000, 2], [5000, 1000, 6], [100, 1000, 1]]) {
      const mdb = mirrorDb(n);
      const spy = prepareSpy(mdb);
      let yields = 0;
      const base = await buildBaseCache(spy.db, 5, { pageSize, yieldFn: () => { yields++; } });
      assert.equal(spy.prepares, 1, `n=${n} page=${pageSize}: one prepare`);
      assert.equal(yields, pages - 1, `n=${n} page=${pageSize}: a yield between each of ${pages} page reads`);
      assert.equal(base.n, n, 'the serving generation only (layout 4 is never read)');
      assert.equal(base.nDots, n / 2);
      mdb.close();
    }
  });

  test('columns: id order, dots grouped by label, created parsed once', async () => {
    const mdb = mirrorDb(10);
    const base = await buildBaseCache(mdb, 5, { yieldFn: async () => {} });
    assert.deepEqual([...base.trackId], [...base.trackId].sort((a, b) => a - b));
    assert.deepEqual([...base.trackDot], [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    assert.deepEqual([...base.dotX], [0, 2, 4, 6, 8], "each dot's first member speaks for it");
    assert.equal(base.created[0], sqliteUtcToSec('2026-01-01 00:00:00'));
    mdb.close();
  });
});

describe('createMapCache (perf guard 3)', () => {
  const snapOf = (mdb) => {
    const p = mdb.prepare('SELECT active_layout, map_epoch, rev FROM track_map_meta WHERE id = 1').get();
    const n = mdb.prepare('SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(p.active_layout).n;
    return { mapEpoch: p.map_epoch, layoutId: p.active_layout, rev: p.rev, n };
  };
  const all = { coversAllLibraries: true, params: [1] };

  test('two requests for one rev build once; the third is an LRU hit', async () => {
    const mdb = mirrorDb(200);
    const cache = createMapCache({ pageSize: 50, yieldFn: async () => {} });
    let makes = 0;
    const make = async () => {
      makes++;
      const base = await cache.getBase(mdb, snapOf(mdb));
      return derivePayload(base, all, recent);
    };
    const [a, b] = await Promise.all([cache.getPayload('r1', make), cache.getPayload('r1', make)]);
    assert.equal(a, b, 'the same entry');
    assert.equal(makes, 1);
    assert.equal(cache.stats.baseBuilds, 1);
    assert.equal(cache.stats.payloadBuilds, 1);
    assert.equal(await cache.getPayload('r1', make), a);
    assert.equal(makes, 1, 'served from the LRU');
    mdb.close();
  });

  test('concurrent base requests share one build; a new visibility re-derives without re-querying', async () => {
    const mdb = mirrorDb(200);
    const spy = prepareSpy(mdb);
    const cache = createMapCache({ pageSize: 50, yieldFn: async () => {} });
    const snap = snapOf(mdb);
    const [b1, b2] = await Promise.all([cache.getBase(spy.db, snap), cache.getBase(spy.db, snap)]);
    assert.equal(b1, b2);
    assert.equal(cache.stats.baseBuilds, 1);
    const before = spy.prepares;
    await cache.getPayload('other-visibility', async () => derivePayload(await cache.getBase(spy.db, snap), { coversAllLibraries: false, params: [] }, recent));
    assert.equal(cache.stats.baseBuilds, 1, 'the base is reused');
    assert.equal(spy.prepares, before, 'no SQL for a second visibility');
    mdb.close();
  });

  test('the LRU keeps the newest entries', async () => {
    const cache = createMapCache({ lruSize: 2 });
    let makes = 0;
    const make = () => { makes++; return { n: makes }; };
    await cache.getPayload('a', make);
    await cache.getPayload('b', make);
    await cache.getPayload('a', make);   // touch a
    await cache.getPayload('c', make);   // evicts b
    assert.equal(makes, 3);
    await cache.getPayload('a', make);
    assert.equal(makes, 3, 'a survived');
    await cache.getPayload('b', make);
    assert.equal(makes, 4, 'b was evicted');
  });

  test('a build that saw the pointer move is discarded and retried once, then cached', async () => {
    const mdb = mirrorDb(200);
    let moved = false;
    const cache = createMapCache({
      pageSize: 50,
      yieldFn: () => {
        if (!moved) { moved = true; mdb.prepare('UPDATE track_map_meta SET rev = rev + 1 WHERE id = 1').run(); }
      },
    });
    const first = snapOf(mdb);
    const base = await cache.getBase(mdb, first);
    assert.equal(cache.stats.baseBuilds, 2, 'scanned twice');
    assert.equal(base.n, 200);
    const now = snapOf(mdb);
    assert.notEqual(now.rev, first.rev);
    assert.equal(await cache.getBase(mdb, now), base, 'kept under the snapshot it verified');
    assert.equal(cache.stats.baseBuilds, 2);
    mdb.close();
  });
});
