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
 *    seed; skipped-only, uncounted and peer plays never seed; completed
 *    ranks ahead of stopped, then newest;
 *  - window + widening: an empty window widens to all time and says so;
 *  - counters, random and album counts never leave the caller's libraries;
 *    a history reset hides pre-reset counters;
 *  - random is deterministic per user per day;
 *  - prefs merge / replace / trim at 200 / clear, and the reset hook;
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
  getTastePrefs, setTastePrefs, onStatsReset, historyResetAt,
  EXCLUDE_CAP, SEED_CAP, WINDOWS, FILTERS, LIMIT_CAPS, LIMIT_DEFAULTS, PREFS_NAMESPACE,
} from '../../src/discovery/taste-queries.js';

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
    assert.deepEqual(r.hashes, [
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

  test('completed ranks ahead of stopped, then newest; plays counts seeding plays only', () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(3) }),
      play(c.alice, 'ha3', c.A, { outcome: 'stopped', playedMs: 300000, startedAt: ago(0, 1) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(1) }),
      play(c.alice, 'ha5', c.A, { startedAt: ago(9) }),
      play(c.alice, 'ha5', c.A, { outcome: 'stopped', playedMs: 35000, startedAt: ago(4) }), // not seeding
    ]);
    const r = historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW });
    assert.deepEqual(hashesOf(r), ['ha5', 'ha1', 'ha3']);
    assert.deepEqual(r.hashes.map((h) => h.plays), [2, 1, 1]);
    assert.deepEqual(r.hashes.map((h) => h.outcome), ['completed', 'completed', 'stopped']);
  });

  test("never another user's plays, never a library the caller cannot see", () => {
    const c = seed();
    recordPlayEvents(c.db, [
      play(c.alice, 'ha1', c.A, { startedAt: ago(2) }),
      play(c.alice, 'hb1', c.B, { startedAt: ago(1) }),
      play(c.bob, 'hb2', c.B, { startedAt: ago(1) }),
    ]);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { libIds: onlyA(c), now: NOW })), ['ha1']);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { libIds: null, now: NOW })), ['hb1', 'ha1']);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.bob }, { libIds: onlyB(c), now: NOW })), ['hb2']);
    // No visible library at all: nothing, without a malformed IN ().
    assert.deepEqual(historySeeds(c.db, { id: c.alice }, { libIds: new Set(), now: NOW }),
      { hashes: [], window: 0, widenedFrom: 30 });
    // No user id (a federation key): nothing.
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: null }, { libIds: null, now: NOW })), []);
  });

  test('over-fetch: overfetch × limit rows; exclusions never eat into it; accept caps at limit', () => {
    const c = seed();
    recordPlayEvents(c.db, ['ha1', 'ha2', 'ha3', 'ha4', 'ha5'].map((h, i) => play(c.alice, h, c.A, { startedAt: ago(i + 1) })));
    const base = { libIds: onlyA(c), now: NOW };
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { ...base, limit: 2, overfetch: 2 })), ['ha1', 'ha2', 'ha3', 'ha4']);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { ...base, limit: 1, overfetch: 1, exclude: ['ha1'] })), ['ha2']);
    assert.deepEqual(hashesOf(historySeeds(c.db, { id: c.alice }, { ...base, limit: 1, overfetch: 1, exclude: new Set(['ha1', 'ha2']) })), ['ha3']);
    const accepted = historySeeds(c.db, { id: c.alice }, { ...base, limit: 2, accept: (h) => h !== 'ha2' });
    assert.deepEqual(hashesOf(accepted), ['ha1', 'ha3']);
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
  const days = Array.from({ length: 30 }, (_, i) => toSqlite(new Date(NOW.getTime() + i * DAY)).slice(0, 10));

  test("deterministic per user per day, and never outside the caller's libraries", () => {
    const c = seed();
    const picks = new Set();
    for (const daySalt of days) {
      const a = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), daySalt });
      assert.ok(libA.has(a.hash), `${a.hash} is not in rock`);
      assert.deepEqual(randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), daySalt }), a, 'same day, same pick');
      assert.equal(a.libraryId, c.A);
      picks.add(a.hash);
      const b = randomVisibleSeed(c.db, { id: c.bob }, index, { libIds: onlyB(c), daySalt });
      assert.ok(libB.has(b.hash), `${b.hash} is not in jazz`);
      assert.equal(b.libraryId, c.B);
    }
    assert.ok(picks.size >= 3, `a month of days should not keep picking the same song (got ${[...picks]})`);
    // The song both libraries hold: walk days until it is picked (a year
    // of salts, so a fixture or salt change cannot skip the check silently).
    let shared = null;
    for (let i = 0; i < 366 && !shared; i++) {
      const daySalt = toSqlite(new Date(NOW.getTime() + i * DAY)).slice(0, 10);
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), daySalt });
      if (p.hash === 'hs') { shared = p; }
    }
    assert.ok(shared, "no day of the year picked 'hs'");
    assert.equal(shared.trackId, c.ids.sA, 'the copy inside the scope');
  });

  test('a small library behind a long run of invisible entries still varies by day', () => {
    // Libraries sit in contiguous runs of the index. A seeded offset + linear
    // walk would land on the run's FIRST track on ~95% of days here; the
    // seeded permutation spreads the picks across the run.
    const c = seed();
    const run = ['ha1', 'ha2', 'ha3', 'ha4', 'ha5', 'ha6', 'fa7', 'hs'];
    const skewed = { entries: [...Array.from({ length: 300 }, (_, i) => ({ hash: `ghost-${i}` })), ...run.map((hash) => ({ hash }))] };
    const picks = new Map();
    for (const daySalt of days) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, skewed, { libIds: onlyA(c), daySalt });
      picks.set(p.hash, (picks.get(p.hash) || 0) + 1);
    }
    assert.ok(picks.size >= 5, `picks cluster: ${JSON.stringify([...picks])}`);
    assert.ok(Math.max(...picks.values()) <= 12, `one song dominates: ${JSON.stringify([...picks])}`);
  });

  test('the day salt defaults to the UTC date of `now`; entry and track id ride along', () => {
    const c = seed();
    const byNow = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), now: NOW });
    const bySalt = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), daySalt: '2026-10-05' });
    assert.deepEqual(byNow, bySalt);
    assert.equal(byNow.entry, index.entries.find((e) => e.hash === byNow.hash));
    assert.equal(byNow.trackId, byNow.hash === 'hs' ? c.ids.sA : c.ids[`a${byNow.hash.slice(-1)}`]);
  });

  test('exclusions are never picked', () => {
    const c = seed();
    const all = [...libA].filter((h) => h !== 'ha3');
    for (const daySalt of days.slice(0, 10)) {
      const p = randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: onlyA(c), daySalt, exclude: all });
      assert.equal(p.hash, 'ha3');
    }
  });

  test('null when the caller can see no analyzed track, for an empty scope, or an empty index', () => {
    const c = seed();
    const elsewhere = { entries: [{ hash: 'ghost' }, { hash: 'hb1' }] };
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, elsewhere, { libIds: onlyA(c), daySalt: 'x' }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, index, { libIds: new Set(), daySalt: 'x' }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, { entries: [] }, { libIds: null, daySalt: 'x' }), null);
    assert.equal(randomVisibleSeed(c.db, { id: c.alice }, null, { libIds: null, daySalt: 'x' }), null);
    const one = randomVisibleSeed(c.db, { id: c.alice }, { entries: [{ hash: 'hb2' }] }, { libIds: null, daySalt: 'x' });
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

// ── Prefs ─────────────────────────────────────────────────────────────────

describe('taste prefs', () => {
  const EMPTY = { window: null, filter: null, staleDays: null, exclude: [] };

  test('unset reads as nulls; partial updates keep the rest; null deletes', () => {
    const c = seed();
    assert.deepEqual(getTastePrefs(c.db, c.alice), EMPTY);
    assert.deepEqual(setTastePrefs(c.db, c.alice, { window: 0, filter: 'unplayed', staleDays: 30 }),
      { window: 0, filter: 'unplayed', staleDays: 30, exclude: [] });
    assert.deepEqual(setTastePrefs(c.db, c.alice, { window: 90 }),
      { window: 90, filter: 'unplayed', staleDays: 30, exclude: [] });
    assert.deepEqual(setTastePrefs(c.db, c.alice, { filter: null }),
      { window: 90, filter: null, staleDays: 30, exclude: [] });
    assert.deepEqual(getTastePrefs(c.db, c.bob), EMPTY, 'per user');
    const keys = c.db.prepare('SELECT key FROM user_settings WHERE user_id = ? AND namespace = ? ORDER BY key').all(c.alice, PREFS_NAMESPACE).map((r) => r.key);
    assert.deepEqual(keys, ['staleDays', 'window']);
  });

  test('exclusions merge (an old drop keeps its age) and trim oldest-first at the cap', () => {
    const c = seed();
    setTastePrefs(c.db, c.alice, { exclude: ['h1', 'h2'] }, { now: 1 });
    assert.deepEqual(setTastePrefs(c.db, c.alice, { exclude: ['h2', 'h3', 'h3'] }, { now: 2 }).exclude, ['h1', 'h2', 'h3']);
    const stored = JSON.parse(c.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND namespace = ? AND key = ?')
      .get(c.alice, PREFS_NAMESPACE, 'exclude').value);
    assert.deepEqual(stored, [{ hash: 'h1', at: 1 }, { hash: 'h2', at: 1 }, { hash: 'h3', at: 2 }]);

    const first = Array.from({ length: 150 }, (_, i) => `x${i}`);
    const second = Array.from({ length: 100 }, (_, i) => `y${i}`);
    setTastePrefs(c.db, c.bob, { exclude: first }, { now: 10 });
    const trimmed = setTastePrefs(c.db, c.bob, { exclude: second }, { now: 20 }).exclude;
    assert.equal(trimmed.length, EXCLUDE_CAP);
    assert.equal(trimmed[0], 'x50', 'the 50 oldest drops went');
    assert.equal(trimmed.at(-1), 'y99');
  });

  test('replaceExclude makes the list THE list; kept hashes keep their age', () => {
    const c = seed();
    setTastePrefs(c.db, c.alice, { exclude: ['h1', 'h2'] }, { now: 1 });
    setTastePrefs(c.db, c.alice, { exclude: ['h3'] }, { now: 2 });
    assert.deepEqual(setTastePrefs(c.db, c.alice, { exclude: ['h3', 'h4', 'h1'] }, { replaceExclude: true, now: 3 }).exclude,
      ['h1', 'h3', 'h4']);
    assert.deepEqual(setTastePrefs(c.db, c.alice, { exclude: [] }, { replaceExclude: true }).exclude, []);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ? AND key = ?').get(c.alice, 'exclude').n, 0);
    setTastePrefs(c.db, c.alice, { exclude: ['h9'] });
    assert.deepEqual(setTastePrefs(c.db, c.alice, { exclude: null }).exclude, []);
  });

  test('values outside the contract throw (the route validates first)', () => {
    const c = seed();
    for (const patch of [{ window: 14 }, { filter: 'new' }, { staleDays: 0 }, { staleDays: 3651 }, { staleDays: 1.5 },
      { exclude: 'h1' }, { exclude: [''] }, { exclude: ['x'.repeat(129)] }, { exclude: Array.from({ length: EXCLUDE_CAP + 1 }, (_, i) => `h${i}`) }]) {
      assert.throws(() => setTastePrefs(c.db, c.alice, patch), TypeError, JSON.stringify(patch).slice(0, 40));
    }
    assert.throws(() => setTastePrefs(c.db, null, { window: 7 }), TypeError);
    assert.deepEqual(getTastePrefs(c.db, c.alice), EMPTY, 'nothing half-written');
  });

  test('damaged stored values read as unset', () => {
    const c = seed();
    const ins = c.db.prepare('INSERT INTO user_settings (user_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, 0)');
    ins.run(c.alice, PREFS_NAMESPACE, 'window', '14');
    ins.run(c.alice, PREFS_NAMESPACE, 'filter', '{oops');
    ins.run(c.alice, PREFS_NAMESPACE, 'exclude', JSON.stringify([{ hash: 'h1', at: 1 }, 'h2', { hash: '' }, { hash: 'h1', at: 2 }]));
    assert.deepEqual(getTastePrefs(c.db, c.alice), { window: null, filter: null, staleDays: null, exclude: ['h1'] });
  });

  test('onStatsReset: history/all clear the namespace and mark; counts does nothing', () => {
    const c = seed();
    const prefs = { window: 7, filter: 'all', staleDays: 10, exclude: ['h1'] };
    setTastePrefs(c.db, c.alice, prefs);
    setTastePrefs(c.db, c.bob, prefs);
    assert.deepEqual(onStatsReset(c.db, c.alice, 'counts'), { cleared: 0, marked: false });
    assert.deepEqual(getTastePrefs(c.db, c.alice), prefs);
    assert.equal(historyResetAt(c.db, c.alice), null);

    assert.deepEqual(onStatsReset(c.db, c.alice, 'history', { now: ago(0, 2) }), { cleared: 4, marked: true });
    assert.deepEqual(getTastePrefs(c.db, c.alice), EMPTY);
    assert.equal(historyResetAt(c.db, c.alice), toSqlite(ago(0, 2)));
    assert.deepEqual(getTastePrefs(c.db, c.bob), prefs, "another user's prefs are untouched");

    // A second reset moves the marker (the old marker is part of what it clears).
    assert.deepEqual(onStatsReset(c.db, c.alice, 'all', { now: NOW }), { cleared: 1, marked: true });
    assert.equal(historyResetAt(c.db, c.alice), toSqlite(NOW));
    assert.deepEqual(onStatsReset(c.db, null, 'all'), { cleared: 0, marked: false });
  });
});

describe('contract constants', () => {
  test('the caps S5 validates against', () => {
    assert.equal(EXCLUDE_CAP, 200);
    assert.equal(SEED_CAP, 12);
    assert.deepEqual([...WINDOWS], [7, 30, 90, 0]);
    assert.deepEqual([...FILTERS], ['fresh', 'unplayed', 'all']);
    assert.deepEqual({ ...LIMIT_CAPS }, { seeds: 12, tracks: 50, albums: 24, network: 50, peers: 25 });
    for (const [k, v] of Object.entries(LIMIT_DEFAULTS)) { assert.ok(v <= LIMIT_CAPS[k], k); }
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
