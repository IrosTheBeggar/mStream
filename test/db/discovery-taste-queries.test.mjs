/**
 * src/discovery/taste-queries.js against a real schema (in-memory
 * node:sqlite, every migration applied), plays seeded through the one write
 * path (recordPlayEvents) so events, rollups and counters agree.
 *
 * Fixture: two users, two libraries ('rock' = A, 'jazz' = B), tracks whose
 * canonical hashes are inserted directly — audio-hashed rows, one
 * file-hash-only row, and one song held in both libraries (the B copy has
 * the LOWER id) — plus two album rows sharing one card identity across the
 * libraries. Scope is passed as `libIds` (what tasteScope resolves through
 * eventScope/libraryFilter on a live server), so no manager is needed.
 *
 * Locks in:
 *  - the seed rule (plan §2.1): completed seeds; stopped at 35 s of 6 min
 *    does not, at 4 min does; a skip after a completed play removes the
 *    seed; skipped-only, uncounted and peer plays never seed;
 *  - the batch is RANDOM: the whole pool when it fits the limit, else a
 *    uniform subset (checked with a seeded generator, so never flaky);
 *    exclude shrinks the pool; accept runs only on the songs drawn;
 *  - window + widening: an empty window widens to all time and says so;
 *  - counters, random and album counts never leave the caller's libraries;
 *    a history reset hides pre-reset counters;
 *  - the random fallback is drawn fresh per call (a seeded generator keeps
 *    the checks exact), stays in the caller's scope and honours exclude;
 *  - the reset hook stores only its marker;
 *  - the plans: hash-index probes, never idx_tracks_library, the pinned
 *    skip subquery.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { recordPlayEvents, resetStats } from '../../src/stats/store.js';
import { toSqlite } from '../../src/stats/time.js';
import { albumItems } from '../../src/api/db.js';
import {
  historySeeds, counterSeeds, randomVisibleSeed, visibleTracksByHash,
  albumCards, albumCardRows, albumCardKey,
  onStatsReset, historyResetAt,
  EXCLUDE_CAP, SEED_CAP, WINDOWS, DEFAULT_WINDOW, DEFAULT_STALE_DAYS, LIMIT_CAPS, LIMIT_DEFAULTS, TASTE_NAMESPACE,
} from '../../src/discovery/taste-queries.js';
import * as tasteQueries from '../../src/discovery/taste-queries.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (days, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * HOUR);
const SIX_MIN = 360000;

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db);
  const user = (name) => Number(db.prepare('INSERT INTO users (username, password, salt) VALUES (?, \'h\', \'s\')').run(name).lastInsertRowid);
  const alice = user('alice');
  const bob = user('bob');
  const carol = user('carol');
  const lib = (name) => Number(db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run(name, `/srv/${name}`).lastInsertRowid);
  const A = lib('rock');
  const B = lib('jazz');
  const peer = Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Sam', 't', 'fedk_sam')").run().lastInsertRowid);
  const artist = Number(db.prepare("INSERT INTO artists (name) VALUES ('The Band')").run().lastInsertRowid);
  const album = (name, year, art, artistId = artist) => Number(db.prepare(
    'INSERT INTO albums (name, year, album_art_file, artist_id, track_count) VALUES (?, ?, ?, ?, 0)'
  ).run(name, year, art, artistId).lastInsertRowid);
  // Two album rows, ONE card: same (name, year, art), different artists.
  const blueA = album('Blue', 2001, 'blue.jpg');
  const blueB = album('Blue', 2001, 'blue.jpg', null);
  const green = album('Green', 1999, null);
  const ids = {};
  const ins = db.prepare(`INSERT INTO tracks (filepath, library_id, title, file_hash, audio_hash, duration, album_id, modified, scan_id)
                          VALUES (?, ?, ?, ?, ?, 360, ?, 1, 'seed')`);
  const track = (label, libId, fileHash, audioHash, albumId = null) => {
    ids[label] = Number(ins.run(`${label}.flac`, libId, label, fileHash, audioHash, albumId).lastInsertRowid);
  };
  track('sB', B, 'fsB', 'hs');                 // the shared song's B copy: the lower id
  track('a1', A, 'fa1', 'ha1', blueA);
  track('a2', A, 'fa2', 'ha2', blueA);
  track('a3', A, 'fa3', 'ha3', green);
  track('a4', A, 'fa4', 'ha4');
  track('a5', A, 'fa5', 'ha5');
  track('a6', A, 'fa6', 'ha6');
  track('a7', A, 'fa7', null, green);         // file-hash-only: canonical key 'fa7'
  track('b1', B, 'fb1', 'hb1', blueB);
  track('b2', B, 'fb2', 'hb2');
  track('sA', A, 'fsA', 'hs');                 // the shared song's A copy
  return { db, alice, bob, carol, A, B, peer, ids, albums: { blueA, blueB, green } };
}

let seq = 0;
const play = (userId, hash, libraryId, over = {}) => ({
  eventId: `ev-${++seq}`, userId, trackHash: hash, filepath: `${hash}.flac`, libraryId,
  outcome: 'completed', counted: true, playedMs: SIX_MIN, durationMs: SIX_MIN, startedAt: ago(1), ...over,
});
const skip = (userId, hash, libraryId, over = {}) =>
  play(userId, hash, libraryId, { outcome: 'skipped', counted: false, playedMs: 8000, ...over });

const hashesOf = (r) => r.hashes.map((h) => h.hash);
// A history batch is drawn in random order: compare it order-free.
const sortedHashes = (r) => hashesOf(r).sort();
const sortedRows = (r) => [...r.hashes].sort((x, y) => (x.hash < y.hash ? -1 : 1));
// A seeded generator (mulberry32), so a test of the draw is deterministic.
function seeded(n) {
  let a = n >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const onlyA = (c) => new Set([c.A]);
const onlyB = (c) => new Set([c.B]);

// A handle that records every statement run through it, so a test can ask
// SQLite for the plan of exactly what the module executed.
function spy(db) {
  const seen = [];
  return {
    seen,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      const rec = (fn) => (...p) => { seen.push({ sql, p }); return st[fn](...p); };
      return { all: rec('all'), get: rec('get'), run: rec('run') };
    },
  };
}
const planOf = (db, { sql, p }) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((s) => s.detail).join(' | ');

// ── History seeds ─────────────────────────────────────────────────────────

describe('historySeeds — the seed rule', () => {
  test('completed seeds; stopped at 4 min of 6 seeds; stopped at 35 s of 6 does not', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(1) }),
      play(c.alice, 'ha2', c.A, { outcome: 'stopped', playedMs: 35000, startedAt: ago(2) }), // counted (≥ 30 s), under half
      play(c.alice, 'ha3', c.A, { outcome: 'stopped', playedMs: 240000, startedAt: ago(3) }),
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW });
    assert.deepEqual(sortedRows(r), [
      { hash: 'ha1', lastPlayed: toSqlite(ago(1)), plays: 1, outcome: 'completed' },
      { hash: 'ha3', lastPlayed: toSqlite(ago(3)), plays: 1, outcome: 'stopped' },
    ]);
    assert.equal(r.window, 30);
    assert.equal(r.widenedFrom, null);
  });

  test('a skip after a completed play removes the seed; finishing it again restores it', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha4', c.A, { startedAt: ago(5) }),
      skip(c.alice, 'ha4', c.A, { startedAt: ago(4) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(6) }),
      skip(c.alice, 'ha5', c.A, { startedAt: ago(5) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(2) }),
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW });
    assert.deepEqual(hashesOf(r), ['ha5']);
    assert.equal(r.hashes[0].plays, 2, 'both completed plays of ha5 count');
  });

  test('skipped-only never seeds, counted or not; nor an uncounted completion, a peer play, or a NULL duration stop', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      skip(c.alice, 'ha6', c.A, { startedAt: ago(1) }),
      skip(c.alice, 'ha6', c.A, { counted: true, playedMs: 250000, startedAt: ago(2) }), // a skip at 70 %: counted
      play(c.alice, 'ha1', c.A, { counted: false, startedAt: ago(1) }),                // a seek to the end
      play(c.alice, 'hp', null, { peerId: c.peer, startedAt: ago(1) }),
      play(c.alice, 'ha2', c.A, { outcome: 'stopped', playedMs: 300000, durationMs: null, startedAt: ago(1) }),
    ]);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { libIds: null, windowDays: 0, now: NOW })), []);
  });

  test('plays counts seeding plays only; a song finished once is completed', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(3) }),
      play(c.alice, 'ha3', c.A, { outcome: 'stopped', playedMs: 300000, startedAt: ago(0, 1) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(1) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(9) }),
      play(c.alice, 'ha5', c.A, { outcome: 'stopped', playedMs: 35000, startedAt: ago(4) }), // not seeding
      play(c.alice, 'ha6', c.A, { outcome: 'stopped', playedMs: 300000, startedAt: ago(2) }),
      play(c.alice, 'ha6', c.A, { startedAt: ago(5) }),
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW });
    assert.deepEqual(sortedRows(r).map((h) => [h.hash, h.plays, h.outcome]),
      [['ha1', 1, 'completed'], ['ha3', 1, 'stopped'], ['ha5', 2, 'completed'], ['ha6', 2, 'completed']]);
    assert.equal(sortedRows(r)[3].lastPlayed, toSqlite(ago(2)), 'the newest seeding play');
  });

  test("never another user's plays, never a library the caller cannot see", () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(2) }),
      play(c.alice, 'hb1', c.B, { startedAt: ago(1) }),
      play(c.bob, 'hb2', c.B, { startedAt: ago(1) }),
    ]);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW })), ['ha1']);
    assert.deepEqual(sortedHashes(historySeeds(c.db, { id: c.alice }, { libIds: null, now: NOW })), ['ha1', 'hb1']);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.bob }, { libIds: onlyB(c), now: NOW })), ['hb2']);
    // No visible library at all: nothing, without a malformed IN ().
    assert.deepEqual(historySeeds(c.db, { id: c.alice }, { libIds: new Set(), now: NOW }),
      { hashes: [], window: 0, widenedFrom: 30 });
    // No user id (a federation key): nothing.
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: null }, { libIds: null, now: NOW })), []);
  });

});

describe('historySeeds — the random batch', () => {
  const FIVE = ['ha1', 'ha2', 'ha3', 'ha4', 'ha5'];
  const fivePlayed = () => {
    const c = seed();
    recordPlayEvents(c.db, FIVE.map((h, i) => play(c.alice, h, c.A, { startedAt: ago(i + 1) })));
    return c;
  };

  test('the whole pool when it fits the limit; else `limit` distinct songs of it', () => {
    const c = fivePlayed();
    const base = { libIds: onlyA(c), now: NOW };
    assert.deepEqual(sortedHashes(historySeeds(c.db, { id: c.alice }, { ...base, limit: 5 })), FIVE);
    assert.deepEqual(sortedHashes(historySeeds(c.db, { id: c.alice }, base)), FIVE, 'the default limit (12)');
    for (let n = 0; n < 50; n++) {
      const r = historySeeds(c.db, { id: c.alice }, { ...base, limit: 2, random: seeded(n) });
      assert.equal(r.hashes.length, 2);
      assert.equal(new Set(hashesOf(r)).size, 2, 'distinct');
      for (const h of hashesOf(r)) { assert.ok(FIVE.includes(h), h); }
      assert.equal(r.window, 30);
      assert.equal(r.widenedFrom, null);
    }
  });

  test('uniform over the pool, not newest first', () => {
    const c = fivePlayed();
    const rand = seeded(42);
    const counts = Object.fromEntries(FIVE.map((h) => [h, 0]));
    const draws = 2000;
    for (let n = 0; n < draws; n++) {
      for (const h of hashesOf(historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW, limit: 2, random: rand }))) { counts[h]++; }
    }
    // Each song is in 2/5 of the batches: 800 of 2000 expected (σ ≈ 22).
    for (const [h, k] of Object.entries(counts)) { assert.ok(k > 700 && k < 900, `${h}: ${k} of ${draws}`); }
  });

  test('Math.random by default: repeated calls draw different batches', () => {
    const c = fivePlayed();
    const batches = new Set();
    // C(5,2) = 10 batches: 30 identical draws would be a (1/10)^29 fluke.
    for (let n = 0; n < 30; n++) {
      batches.add(sortedHashes(historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW, limit: 2 })).join());
    }
    assert.ok(batches.size > 1, 'every call drew the same batch');
  });

  test('exclude shrinks the pool (array or Set)', () => {
    const c = fivePlayed();
    const base = { libIds: onlyA(c), now: NOW };
    assert.deepEqual(sortedHashes(historySeeds(c.db, { id: c.alice }, { ...base, exclude: ['ha1'] })), ['ha2', 'ha3', 'ha4', 'ha5']);
    for (let n = 0; n < 20; n++) {
      const r = historySeeds(c.db, { id: c.alice }, { ...base, limit: 2, exclude: new Set(['ha1', 'ha2', 'ha3']), random: seeded(n) });
      assert.deepEqual(sortedHashes(r), ['ha4', 'ha5'], 'two left, two wanted: always both');
    }
    // Everything in the window excluded: widen (all time has nothing else either).
    assert.deepEqual(historySeeds(c.db, { id: c.alice }, { ...base, exclude: FIVE }), { hashes: [], window: 0, widenedFrom: 30 });
  });

  test('accept filters the draw, runs only on the songs drawn, and caps at limit', () => {
    const c = fivePlayed();
    const base = { libIds: onlyA(c), now: NOW };
    for (let n = 0; n < 20; n++) {
      const r = historySeeds(c.db, { id: c.alice }, { ...base, limit: 4, accept: (h) => h !== 'ha2', random: seeded(n) });
      assert.deepEqual(sortedHashes(r), ['ha1', 'ha3', 'ha4', 'ha5']);
    }
    const asked = [];
    const one = historySeeds(c.db, { id: c.alice }, { ...base, limit: 1, accept: (h) => { asked.push(h); return true; } });
    assert.equal(one.hashes.length, 1);
    assert.deepEqual(asked, hashesOf(one), 'one draw, one probe');
  });
});

describe('historySeeds — window and widening', () => {
  test('an empty window widens to all time and reports the requested window', () => {
    const c = seed();
    recordPlayEvents(c.db, [play(c.bob, 'hb1', c.B, { startedAt: ago(60) })]);
    const user = { id: c.bob };
    assert.deepEqual(historySeeds(c.db, user, { windowDays: 30, libIds: null, now: NOW }), {
      hashes: [{ hash: 'hb1', lastPlayed: toSqlite(ago(60)), plays: 1, outcome: 'completed' }],
      window: 0,
      widenedFrom: 30,
    });
    const ninety = historySeeds(c.db, user, { windowDays: 90, libIds: null, now: NOW });
    assert.deepEqual([hashesOf(ninety), ninety.window, ninety.widenedFrom], [['hb1'], 90, null]);
    const all = historySeeds(c.db, user, { windowDays: 0, libIds: null, now: NOW });
    assert.deepEqual([hashesOf(all), all.window, all.widenedFrom], [['hb1'], 0, null]);
  });

  test('a window with seeds does not widen; older history stays out of it', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(40) }),
      play(c.alice, 'ha2', c.A, { startedAt: ago(3) }),
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { windowDays: 7, libIds: onlyA(c), now: NOW });
    assert.deepEqual([hashesOf(r), r.window, r.widenedFrom], [['ha2'], 7, null]);
  });

  test('no history at all: empty, and the widening is still reported', () => {
    const c = seed();
    assert.deepEqual(historySeeds(c.db, { id: c.carol }, { libIds: null, now: NOW }),
      { hashes: [], window: 0, widenedFrom: 30 });
  });

  test('a window holding only songs the caller rejects (un-analyzed, invisible) widens', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(2) }),
      play(c.alice, 'ha2', c.A, { startedAt: ago(50) }),
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW, accept: (h) => h === 'ha2' });
    assert.deepEqual([hashesOf(r), r.window, r.widenedFrom], [['ha2'], 0, 30]);
  });

  test('widening keeps the skip rule: finished long ago, skipped since → no seed', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(60) }),
      skip(c.alice, 'ha1', c.A, { startedAt: ago(10) }),
    ]);
    assert.deepEqual(historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW }),
      { hashes: [], window: 0, widenedFrom: 30 });
  });
});

// ── Counter seeds ─────────────────────────────────────────────────────────

describe('counterSeeds', () => {
  test("newest counter first, only the caller's libraries, never another user's", () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(2) }),
      play(c.alice, 'ha3', c.A, { startedAt: ago(1) }),
      play(c.alice, 'hb1', c.B, { startedAt: ago(0, 1) }),
      play(c.bob, 'ha2', c.A, { startedAt: ago(0, 2) }),
      skip(c.alice, 'ha4', c.A, { startedAt: ago(0, 3) }), // a counter row with play_count 0
    ]);
    const r = counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) });
    assert.deepEqual(r.hashes, [
      { hash: 'ha3', lastPlayed: toSqlite(ago(1)), plays: 1, outcome: null, trackId: c.ids.a3 },
      { hash: 'ha1', lastPlayed: toSqlite(ago(2)), plays: 1, outcome: null, trackId: c.ids.a1 },
    ]);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: null })), ['hb1', 'ha3', 'ha1']);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.bob }, { libIds: onlyB(c) })), []);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: new Set() })), []);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: null }, { libIds: null })), []);
  });

  test('a file-hash-only track resolves; shared audio resolves to the copy inside the scope', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'fa7', c.A, { startedAt: ago(2) }),
      play(c.alice, 'hs', c.A, { startedAt: ago(1) }),
    ]);
    const a = counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) });
    assert.deepEqual(a.hashes.map((h) => [h.hash, h.trackId]), [['hs', c.ids.sA], ['fa7', c.ids.a7]]);
    const all = counterSeeds(c.db, { id: c.alice }, { libIds: null });
    assert.equal(all.hashes[0].trackId, c.ids.sB, 'unscoped: the lowest id, like resolveTracks');
  });

  test('pages past counters that name tracks the caller cannot see', () => {
    const c = seed();
    recordPlayEvents(c.db, [play(c.alice, 'ha1', c.A, { startedAt: ago(30) })]);
    const ins = c.db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count, last_played) VALUES (?, ?, 1, ?)');
    for (let i = 0; i < 60; i++) { ins.run(c.alice, `gone-${i}`, toSqlite(ago(1, i))); }
    const r = counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c), limit: 1, overfetch: 1 });
    assert.deepEqual(hashesOf(r), ['ha1']);
  });

  test('exclude and accept', () => {
    const c = seed();
    recordPlayEvents(c.db, ['ha1', 'ha2', 'ha3'].map((h, i) => play(c.alice, h, c.A, { startedAt: ago(i + 1) })));
    const base = { libIds: onlyA(c) };
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { ...base, exclude: ['ha1'] })), ['ha2', 'ha3']);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { ...base, limit: 1, accept: (h) => h !== 'ha1' })), ['ha2']);
  });

  test('undated legacy counters come last; after a history reset only post-reset counters seed', () => {
    const c = seed();
    recordPlayEvents(c.db, [play(c.alice, 'ha1', c.A, { startedAt: ago(5) })]);
    c.db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count, last_played) VALUES (?, ?, 3, NULL)').run(c.alice, 'ha4');
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) })), ['ha1', 'ha4']);

    // POST /stats/reset {scope:'history'}: the log goes, the counters stay —
    // indistinguishable from a pre-V70 upgrade without the hook's marker.
    resetStats(c.db, c.alice, 'history');
    assert.equal(historyResetAt(c.db, c.alice), null);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) })), ['ha1', 'ha4']);
    onStatsReset(c.db, c.alice, 'history', { now: ago(1) });
    assert.notEqual(historyResetAt(c.db, c.alice), null);
    assert.equal(historyResetAt(c.db, c.alice), toSqlite(ago(1)));
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) })), []);

    recordPlayEvents(c.db, [play(c.alice, 'ha2', c.A, { startedAt: ago(0, 1) })]);
    assert.deepEqual(hashesOf(counterSeeds(c.db, { id: c.alice }, { libIds: onlyA(c) })), ['ha2']);
    // The reset is per user.
    assert.equal(historyResetAt(c.db, c.bob), null);
  });
});

// ── Random seed ───────────────────────────────────────────────────────────

describe('randomVisibleSeed', () => {
  const index = { entries: ['ha1', 'ha2', 'ha3', 'ha4', 'ha5', 'ha6', 'fa7', 'ghost', 'hb1', 'hb2', 'hs'].map((hash) => ({ hash })) };
  const libA = new Set(['ha1', 'ha2', 'ha3', 'ha4', 'ha5', 'ha6', 'fa7', 'hs']);
  const libB = new Set(['hb1', 'hb2', 'hs']);
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);

  test("drawn per call, and never outside the caller's libraries", () => {
    const c = seed();
    const picks = new Set();
    for (const n of seeds) {
      const a = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: seeded(n) });
      assert.ok(libA.has(a.hash), `${a.hash} is not in rock`);
      assert.equal(a.libraryId, c.A);
      assert.deepEqual(randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: seeded(n) }), a,
        'the same draw gives the same pick (the RNG is the only input)');
      picks.add(a.hash);
      const b = randomVisibleSeed(c.db, { id: c.bob }, index, { libIds: onlyB(c), random: seeded(n) });
      assert.ok(libB.has(b.hash), `${b.hash} is not in jazz`);
      assert.equal(b.libraryId, c.B);
    }
    assert.ok(picks.size >= 3, `thirty draws should not keep picking the same song (got ${[...picks]})`);
    // The song both libraries hold: draw until it is picked (a bounded walk
    // of seeds, so a fixture change cannot skip the check silently).
    let shared = null;
    for (let n = 1; n <= 366 && !shared; n++) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: seeded(n) });
      if (p.hash === 'hs') { shared = p; }
    }
    assert.ok(shared, "no draw picked 'hs'");
    assert.equal(shared.trackId, c.ids.sA, 'the copy inside the scope');
  });

  test('a different song can come back on the next call, and exclude keeps a song out', () => {
    // No day salt: two calls in a row draw independently. One RNG stream
    // across calls (as Math.random is), so a different song comes back
    // within a few calls; with the picks already shown in `exclude` every
    // call is a new song until the library runs out — then null.
    const c = seed();
    const rand = seeded(7);
    const first = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: rand });
    let other = null;
    for (let i = 0; i < 20 && !other; i++) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: rand });
      assert.ok(libA.has(p.hash));
      if (p.hash !== first.hash) { other = p; }
    }
    assert.ok(other, `twenty calls all picked ${first.hash}`);

    const shown = [];
    for (let i = 0; i < libA.size; i++) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), exclude: shown });
      assert.ok(p, `ran out after ${shown.length}`);
      assert.ok(libA.has(p.hash));
      assert.ok(!shown.includes(p.hash), `${p.hash} was excluded`);
      shown.push(p.hash);
    }
    assert.deepEqual([...shown].sort(), [...libA].sort(), 'every visible song came back once');
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), exclude: shown }), null,
      'nothing left outside exclude');
  });

  test('a small library behind a long run of invisible entries still varies per call', () => {
    // Libraries sit in contiguous runs of the index. A random offset + linear
    // walk would land on the run's FIRST track on ~95% of calls here; the
    // random permutation spreads the picks across the run.
    const c = seed();
    const run = ['ha1', 'ha2', 'ha3', 'ha4', 'ha5', 'ha6', 'fa7', 'hs'];
    const skewed = { entries: [...Array.from({ length: 300 }, (_, i) => ({ hash: `ghost-${i}` })), ...run.map((hash) => ({ hash }))] };
    const picks = new Map();
    for (const n of seeds) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, skewed, { libIds: onlyA(c), random: seeded(n) });
      picks.set(p.hash, (picks.get(p.hash) || 0) + 1);
    }
    assert.ok(picks.size >= 5, `picks cluster: ${JSON.stringify([...picks])}`);
    assert.ok(Math.max(...picks.values()) <= 12, `one song dominates: ${JSON.stringify([...picks])}`);
  });

  test('Math.random by default; entry and track id ride along', () => {
    const c = seed();
    const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c) });
    assert.ok(libA.has(p.hash));
    assert.equal(p.entry, index.entries.find((e) => e.hash === p.hash));
    assert.equal(p.trackId, p.hash === 'hs' ? c.ids.sA : c.ids[`a${p.hash.slice(-1)}`]);
    // An RNG at its edges stays inside the index.
    for (const edge of [0, 0.999999999]) {
      const q = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: () => edge });
      assert.ok(libA.has(q.hash));
    }
  });

  test('exclusions are never picked', () => {
    const c = seed();
    const all = [...libA].filter((h) => h !== 'ha3');
    for (const n of seeds.slice(0, 10)) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), random: seeded(n), exclude: all });
      assert.equal(p.hash, 'ha3');
    }
  });

  test('null when the caller can see no analyzed track, for an empty scope, or an empty index', () => {
    const c = seed();
    const elsewhere = { entries: [{ hash: 'ghost' }, { hash: 'hb1' }] };
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, elsewhere, { libIds: onlyA(c) }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: new Set() }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, { entries: [] }, { libIds: null }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, null, { libIds: null }), null);
    const one = randomVisibleSeed(c.db, { id: c.alice }, { entries: [{ hash: 'hb2' }] }, { libIds: null });
    assert.equal(one.hash, 'hb2');
  });
});

describe('visibleTracksByHash', () => {
  test('both canonical branches, the lowest id inside the scope, album ids', () => {
    const c = seed();
    const all = visibleTracksByHash(c.db, ['ha1', 'fa7', 'hs', 'ghost', 'fa1', '', null], null);
    assert.deepEqual([...all.keys()].sort(), ['fa7', 'ha1', 'hs']);
    assert.deepEqual(all.get('ha1'), { id: c.ids.a1, libraryId: c.A, albumId: c.albums.blueA });
    assert.equal(all.get('hs').id, c.ids.sB);
    assert.equal(all.get('fa1'), undefined, 'a file hash shadowed by an audio hash is not canonical');
    assert.equal(visibleTracksByHash(c.db, ['hs'], onlyA(c)).get('hs').id, c.ids.sA);
    assert.equal(visibleTracksByHash(c.db, ['ha1'], onlyB(c)).size, 0);
    assert.equal(visibleTracksByHash(c.db, ['ha1'], new Set()).size, 0);
  });
});

// ── Album cards ───────────────────────────────────────────────────────────

describe('albumCards / albumCardRows / albumCardKey', () => {
  const blueKey = (c) => ({ name: 'Blue', year: 2001, albumArtFile: 'blue.jpg', albumIds: [c.albums.blueA, c.albums.blueB] });
  const greenKey = (c) => ({ name: 'Green', year: 1999, albumArtFile: null, albumIds: [c.albums.green] });

  test('counts per scope: a track in a library the caller cannot see is not counted', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(2) }),
      play(c.alice, 'ha1', c.A, { startedAt: ago(9) }),
      play(c.bob, 'hb1', c.B, { startedAt: ago(1) }),     // bob's play: never alice's count
      skip(c.alice, 'ha2', c.A, { startedAt: ago(1) }),   // a counter row, play_count 0
    ]);
    const [blue, green] = albumCards(c.db, { id: c.alice }, [blueKey(c), greenKey(c)], { libIds: onlyA(c) });
    assert.deepEqual(blue, {
      key: albumCardKey({ name: 'Blue', year: 2001, album_art_file: 'blue.jpg' }),
      scopedTracks: 2, playedTracks: 1, lastPlayed: toSqlite(ago(2)), unplayed: false, stale: false,
    });
    assert.deepEqual([green.scopedTracks, green.playedTracks, green.lastPlayed, green.unplayed], [2, 0, null, true]);

    const [bobBlue] = albumCards(c.db, { id: c.bob }, [blueKey(c)], { libIds: onlyB(c) });
    assert.deepEqual([bobBlue.scopedTracks, bobBlue.playedTracks, bobBlue.lastPlayed], [1, 1, toSqlite(ago(1))]);
    const [aliceAll] = albumCards(c.db, { id: c.alice }, [blueKey(c)], { libIds: null });
    assert.deepEqual([aliceAll.scopedTracks, aliceAll.playedTracks], [3, 1]);
    const [none] = albumCards(c.db, { id: c.alice }, [blueKey(c)], { libIds: new Set() });
    assert.deepEqual([none.scopedTracks, none.playedTracks, none.unplayed], [0, 0, true]);
    const [anon] = albumCards(c.db, { id: null }, [blueKey(c)], { libIds: null });
    assert.deepEqual([anon.scopedTracks, anon.playedTracks], [3, 0]);
  });

  test('a file-hash-only track counts by its canonical key; stale against the cutoff', () => {
    const c = seed();
    recordPlayEvents(c.db, [play(c.alice, 'fa7', c.A, { startedAt: ago(120) })]);
    const user = { id: c.alice };
    const [green] = albumCards(c.db, user, [greenKey(c)], { libIds: onlyA(c), staleCutoff: toSqlite(ago(90)) });
    assert.deepEqual([green.playedTracks, green.lastPlayed, green.unplayed, green.stale], [1, toSqlite(ago(120)), false, true]);
    const [recent] = albumCards(c.db, user, [greenKey(c)], { libIds: onlyA(c), staleCutoff: ago(150) });
    assert.equal(recent.stale, false, 'played after the cutoff (a Date works too)');
    const [noCutoff] = albumCards(c.db, user, [greenKey(c)], { libIds: onlyA(c) });
    assert.equal(noCutoff.stale, false);
    // An undated legacy counter: played, but when is unknown — never stale.
    c.db.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count, last_played) VALUES (?, ?, 2, NULL)').run(c.bob, 'ha3');
    const [legacy] = albumCards(c.db, { id: c.bob }, [greenKey(c)], { libIds: null, staleCutoff: toSqlite(NOW) });
    assert.deepEqual([legacy.playedTracks, legacy.lastPlayed, legacy.stale], [1, null, false]);
  });

  test('albumCardRows expands an album id to its whole visible card, ready for albumItems', () => {
    const c = seed();
    const all = albumCardRows(c.db, { id: c.alice }, [c.albums.blueA], { libIds: null });
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].albumIds, [c.albums.blueA, c.albums.blueB].sort((x, y) => x - y));
    assert.equal(all[0].key, albumCardKey(all[0]));
    const [item] = albumItems(c.db, all);
    assert.equal(albumCardKey(item), all[0].key, 'the wire item keys like its row');
    assert.deepEqual([item.name, item.year, item.album_art_file], ['Blue', 2001, 'blue.jpg']);

    // Reached through rock's row, a jazz-only caller still gets the card —
    // restricted to the album rows it can see.
    const jazz = albumCardRows(c.db, { id: c.bob }, [c.albums.blueA], { libIds: onlyB(c) });
    assert.deepEqual(jazz.map((r) => r.albumIds), [[c.albums.blueB]]);
    assert.deepEqual(albumCardRows(c.db, { id: c.alice }, [c.albums.green, c.albums.blueA, c.albums.blueB], { libIds: onlyA(c) })
      .map((r) => [r.name, r.albumIds]).sort(), [['Blue', [c.albums.blueA]], ['Green', [c.albums.green]]]);
    assert.deepEqual(albumCardRows(c.db, { id: c.alice }, [c.albums.blueA], { libIds: new Set() }), []);
    assert.deepEqual(albumCardRows(c.db, { id: c.alice }, [], { libIds: null }), []);

    // The rows work as albumCards' card keys.
    const [counts] = albumCards(c.db, { id: c.alice }, all, { libIds: null });
    assert.equal(counts.scopedTracks, 3);
    assert.equal(counts.key, all[0].key);
  });

  test('albumCardKey: a row, a card key and a wire item agree; empty art is no art', () => {
    const k = albumCardKey({ name: 'Blue', year: 2001, album_art_file: 'blue.jpg' });
    assert.equal(albumCardKey({ name: 'Blue', year: 2001, albumArtFile: 'blue.jpg' }), k);
    assert.notEqual(albumCardKey({ name: 'Blue', year: 2002, album_art_file: 'blue.jpg' }), k);
    assert.equal(albumCardKey({ name: 'X', year: null, album_art_file: '' }), albumCardKey({ name: 'X', albumArtFile: null }));
  });
});

// ── Stats reset marker ────────────────────────────────────────────────────

describe('onStatsReset', () => {
  test('history/all stamp the marker (only the marker); counts does nothing', () => {
    const c = seed();
    const keys = (uid) => c.db.prepare('SELECT key FROM user_settings WHERE user_id = ? AND namespace = ?').all(uid, TASTE_NAMESPACE).map((r) => r.key);
    assert.deepEqual(onStatsReset(c.db, c.alice, 'counts'), { marked: false });
    assert.equal(historyResetAt(c.db, c.alice), null);
    assert.deepEqual(keys(c.alice), []);

    assert.deepEqual(onStatsReset(c.db, c.alice, 'history', { now: ago(0, 2) }), { marked: true });
    assert.equal(historyResetAt(c.db, c.alice), toSqlite(ago(0, 2)));
    assert.deepEqual(keys(c.alice), ['resetAt'], 'nothing else is stored per user');
    assert.equal(historyResetAt(c.db, c.bob), null, "another user's marker is untouched");

    // A second reset moves the marker.
    assert.deepEqual(onStatsReset(c.db, c.alice, 'all', { now: NOW }), { marked: true });
    assert.equal(historyResetAt(c.db, c.alice), toSqlite(NOW));
    assert.deepEqual(keys(c.alice), ['resetAt']);
    assert.deepEqual(onStatsReset(c.db, null, 'all'), { marked: false });
  });

  test('a damaged marker reads as no reset', () => {
    const c = seed();
    c.db.prepare('INSERT INTO user_settings (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, 0)')
      .run(c.alice, TASTE_NAMESPACE, 'resetAt', '{oops');
    assert.equal(historyResetAt(c.db, c.alice), null);
  });
});

describe('contract constants', () => {
  test('the caps the route validates against', () => {
    assert.equal(EXCLUDE_CAP, 200);
    assert.equal(SEED_CAP, 12);
    assert.deepEqual([...WINDOWS], [7, 30, 90, 0]);
    assert.equal(DEFAULT_WINDOW, 30);
    assert.equal(DEFAULT_STALE_DAYS, 90, 'the fixed library rule');
    assert.deepEqual({ ...LIMIT_CAPS }, { seeds: 12, tracks: 50, albums: 24, network: 50, peers: 25 });
    for (const [k, v] of Object.entries(LIMIT_DEFAULTS)) { assert.ok(v <= LIMIT_CAPS[k], k); }
  });

  test('the saved prefs and the library filters are gone', () => {
    for (const name of ['getTastePrefs', 'setTastePrefs', 'FILTERS', 'DEFAULT_FILTER', 'STALE_DAYS_MIN', 'STALE_DAYS_MAX', 'PREFS_NAMESPACE']) {
      assert.ok(!(name in tasteQueries), name);
    }
  });
});

// ── Plans ─────────────────────────────────────────────────────────────────

describe('query plans', () => {
  test('track probes seek the hash indexes, never idx_tracks_library', () => {
    const c = seed();
    const s = spy(c.db);
    visibleTracksByHash(s, ['ha1', 'fa7'], new Set([c.A, c.B]));
    const plan = planOf(c.db, s.seen[0]);
    assert.match(plan, /USING INDEX idx_tracks_audio_hash \(audio_hash=\?\)/, plan);
    assert.match(plan, /USING INDEX idx_tracks_hash \(file_hash=\?\)/, plan);
    assert.doesNotMatch(plan, /idx_tracks_library/, plan);
  });

  test('history seeds: the window on idx_play_events_user_time, the skip check pinned per song', () => {
    const c = seed();
    const s = spy(c.db);
    historySeeds(s, { id: c.alice }, { libIds: onlyA(c), now: NOW, windowDays: 30 });
    const plan = planOf(c.db, s.seen[0]);
    assert.match(plan, /SEARCH pe USING INDEX idx_play_events_user_time \(user_id=\? AND started_at>\?\)/, plan);
    assert.match(plan, /SEARCH s USING INDEX idx_play_events_user_hash \(user_id=\? AND track_hash=\?\)/, plan);
    assert.doesNotMatch(plan, /idx_play_events_library/, plan);
  });

  test('counter seeds walk idx_user_metadata_user_lastplayed', () => {
    const c = seed();
    recordPlayEvents(c.db, [play(c.alice, 'ha1', c.A)]);
    const s = spy(c.db);
    counterSeeds(s, { id: c.alice }, { libIds: onlyA(c) });
    const plan = planOf(c.db, s.seen.find((q) => /FROM user_metadata/.test(q.sql)));
    assert.match(plan, /USING INDEX idx_user_metadata_user_lastplayed \(user_id=\?\)/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  });

  test('album cards drive from idx_tracks_album and probe the counters by key', () => {
    const c = seed();
    const s = spy(c.db);
    albumCards(s, { id: c.alice }, [{ name: 'Blue', year: 2001, albumArtFile: 'blue.jpg', albumIds: [c.albums.blueA, c.albums.blueB] }], { libIds: onlyA(c) });
    const plan = planOf(c.db, s.seen[0]);
    assert.match(plan, /SEARCH t USING INDEX idx_tracks_album \(album_id=\?\)/, plan);
    assert.match(plan, /SEARCH um USING INDEX sqlite_autoindex_user_metadata_1 \(user_id=\? AND track_hash=\?\)/, plan);
    assert.doesNotMatch(plan, /idx_tracks_library/, plan);
  });
});
