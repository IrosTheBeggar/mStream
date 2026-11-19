/**
 * The Auto DJ's session seeds — More like and Less like — in
 * webapp/alpha/auto-dj.js (AUTODJ.seeds): the pure model (a port of the
 * phone's lib/util/auto_dj_seeds.dart, auto_dj_wire.dart and
 * auto_dj_skips.dart at mstream_music 1fdc0f31; the test names follow its
 * test/util/*_test.dart where they exist) and the container around it
 * (lanes, the held-aside set, persistence, the migration of today's seed).
 *
 * The module reads localStorage when it loads, so a Map-backed shim goes in
 * first; every test starts from an empty store, re-hydrated. Times are
 * injected (`now`, ms) wherever the API takes them.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const _store = new Map();
const _writes = [];
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _writes.push(k); _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};

const AUTODJ = require('../../webapp/alpha/auto-dj.js');
const S = AUTODJ.seeds;
const M = S.model;
const SEEDS = AUTODJ._internals.SEEDS;

beforeEach(() => {
  _store.clear();
  AUTODJ._internals.rehydrate();
  _writes.length = 0;
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const TTL = SEEDS.LESS_LIKE_TTL_MS;
const ROWS = 'mstream-dj-seedsRows';
const FROZEN_AT = 'mstream-dj-seedsFrozenAt';

// A song of this server (owner null) unless `owner` says otherwise.
const song = (name, extra = {}) => ({
  owner: null, path: `music/${name}.mp3`, title: name, artist: '', album: '', art: null, duration: null, ...extra,
});
const k = (name, owner = null) => S.keyOf(owner, `music/${name}.mp3`);
const titles = (rows) => rows.map((r) => r.title);
const stored = () => JSON.parse(_store.get(ROWS) || 'null');

// A running lane: the DJ on, its first pick made, so edits go live.
function lane(now = T0) {
  S.setArmed(true);
  S.laneEdge({ now });
  S.beginPick({ current: null, now });
}

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

// ─────────────────────────────────────────────────────────────────────
// 1. keys / wire path
// ─────────────────────────────────────────────────────────────────────

describe('seedKey / seedWirePath', () => {
  test('a leading slash is one song with its bare form', () => {
    assert.equal(M.seedWirePath('/music/a.mp3'), 'music/a.mp3');
    assert.equal(M.seedWirePath('music/a.mp3'), 'music/a.mp3');
    assert.equal(S.keyOf(null, '/music/a.mp3'), S.keyOf(null, 'music/a.mp3'));
    let s = M.pushPick(M.emptySeeds, song('a', { path: '/music/a.mp3' }), { now: T0 });
    s = M.pushPick(s, song('b'), { now: T0 + 1 });
    s = M.pushPick(s, song('a'), { now: T0 + 2 });
    assert.deepEqual(s.more.map((r) => r.key), ['local|music/b.mp3', 'local|music/a.mp3']);
    assert.equal(s.more[1].path, 'music/a.mp3', 'the row keeps the wire path');
  });

  test('the same path on two servers is two songs', () => {
    assert.equal(S.keyOf(null, 'music/a.mp3'), 'local|music/a.mp3');
    assert.equal(S.keyOf(7, 'music/a.mp3'), '7|music/a.mp3');
    assert.equal(S.keyOf(7, 'music/a.mp3'), AUTODJ.federatedKey(7, '/music/a.mp3'), 'one key format with the fan-out');
    let s = M.pushPick(M.emptySeeds, song('a'), { now: T0 });
    s = M.pushPick(s, song('a', { owner: 7 }), { now: T0 + 1 });
    assert.deepEqual(s.more.map((r) => [r.owner, r.path]), [[null, 'music/a.mp3'], [7, 'music/a.mp3']]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. pushPick
// ─────────────────────────────────────────────────────────────────────

describe('pushPick (More like, Drift)', () => {
  test('a pick comes in unpinned as the newest row', () => {
    let s = M.pushPick(M.emptySeeds, song('a'), { now: T0 });
    s = M.pushPick(s, song('b'), { now: T0 + 1 });
    assert.deepEqual(titles(s.more), ['a', 'b']);
    assert.deepEqual([s.more[1].pinned, s.more[1].origin, s.more[1].at], [false, 'pick', T0 + 1]);
  });

  test('five unpinned rows stay, the oldest leaving first', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 7; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    assert.deepEqual(titles(s.more), ['p3', 'p4', 'p5', 'p6', 'p7']);
  });

  test('pinned rows survive the rotation', () => {
    let s = M.addManual(M.emptySeeds, 'more', song('pin1'), { now: T0 });
    s = M.addManual(s, 'more', song('pin2'), { now: T0 });
    for (let i = 1; i <= 7; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    assert.deepEqual(titles(s.more), ['pin1', 'pin2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });

  test('the unpinned room is what the pins leave of eight', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 5; i++) { s = M.addManual(s, 'more', song(`pin${i}`), { now: T0 }); }
    for (let i = 1; i <= 4; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    assert.deepEqual(titles(s.more), ['pin1', 'pin2', 'pin3', 'pin4', 'pin5', 'p2', 'p3', 'p4']);
  });

  test("eight rows of the user's own leave no room: the pick stays out", () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 8; i++) { s = M.addManual(s, 'more', song(`pin${i}`), { now: T0 }); }
    assert.equal(M.pushPick(s, song('p'), { now: T0 + 1 }), s);
  });

  test('a re-pick moves to the newest place and keeps its pin', () => {
    let s = M.addManual(M.emptySeeds, 'more', song('a'), { now: T0 });
    s = M.pushPick(s, song('b'), { now: T0 + 1 });
    s = M.pushPick(s, song('a'), { now: T0 + 2 });
    assert.deepEqual(titles(s.more), ['b', 'a']);
    assert.deepEqual([s.more[1].pinned, s.more[1].at], [true, T0 + 2]);
  });

  test('a re-pick of the newest row is no change (same object)', () => {
    const s = M.pushPick(M.pushPick(M.emptySeeds, song('a'), { now: T0 }), song('b'), { now: T0 + 1 });
    assert.equal(M.pushPick(s, song('b'), { now: T0 + 2 }), s);
  });

  test('a song in Less like is never pushed', () => {
    const s = M.addManual(M.emptySeeds, 'less', song('a'), { now: T0 });
    assert.equal(M.pushPick(s, song('a'), { now: T0 + 1 }), s);
    assert.equal(M.pushPick(s, song('a', { path: '/music/a.mp3' }), { now: T0 + 1 }), s);
  });

  test('frozen: nothing changes', () => {
    const s = M.freeze(M.pushPick(M.emptySeeds, song('a'), { now: T0 }), T0 + 1);
    assert.equal(M.pushPick(s, song('b'), { now: T0 + 2 }), s);
  });

  test('a row with no path is never a seed', () => {
    assert.equal(M.pushPick(M.emptySeeds, song('a', { path: '/' }), { now: T0 }), M.emptySeeds);
    assert.equal(M.pushPick(M.emptySeeds, null, { now: T0 }), M.emptySeeds);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. caps and canAdd
// ─────────────────────────────────────────────────────────────────────

describe('caps and canAdd', () => {
  const pins = (list, n) => {
    let s = M.emptySeeds;
    for (let i = 1; i <= n; i++) { s = M.addManual(s, list, song(`${list}${i}`), { now: T0 }); }
    return s;
  };

  test('a list takes rows while it holds fewer than eight', () => {
    const s = pins('more', 7);
    assert.equal(M.canAdd(s, 'more'), true);
    assert.equal(M.canAdd(s, 'less'), true);
    assert.equal(M.canAdd(s, 'sideways'), false);
  });

  test('a row shown unpinned makes way: an add at eight pushes it out', () => {
    let s = pins('less', 7);
    s = M.quickSkip(s, song('skip'), { learn: true, now: T0 });
    assert.equal(s.less.length, 8);
    assert.equal(M.canAdd(s, 'less'), true);
    s = M.addManual(s, 'less', song('new'), { now: T0 + 1 });
    assert.equal(s.less.length, 8);
    assert.equal(s.less.some((r) => r.title === 'skip'), false);
    assert.equal(s.less[7].title, 'new');
  });

  test('eight pinned rows are full: an add and a move into them change nothing', () => {
    let s = pins('more', 8);
    s = M.addManual(s, 'less', song('x'), { now: T0 });
    assert.equal(M.canAdd(s, 'more'), false);
    assert.equal(M.addManual(s, 'more', song('y'), { now: T0 }), s);
    assert.equal(M.moveRow(s, k('x'), { now: T0 }), s);
  });

  test('Stay close at eight is full, though some rows are unpinned', () => {
    let s = pins('more', 4);
    for (let i = 1; i <= 4; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    assert.equal(s.more.length, 8);
    assert.equal(M.canAdd(s, 'more'), true, 'in Drift an unpinned row makes way');
    const f = M.freeze(s, T0 + 10);
    assert.equal(M.canAdd(f, 'more'), false);
    assert.equal(M.addManual(f, 'more', song('z'), { now: T0 + 11 }), f);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. quickSkip
// ─────────────────────────────────────────────────────────────────────

describe('quickSkip', () => {
  test('a pinned More like row stays and is not learned', () => {
    const s = M.addManual(M.emptySeeds, 'more', song('a'), { now: T0 });
    assert.equal(M.quickSkip(s, song('a'), { learn: true, now: T0 + 1 }), s);
  });

  test('learn: the newest unpinned Less like row with a fresh clock', () => {
    let s = M.pushPick(M.emptySeeds, song('a'), { now: T0 });
    s = M.addManual(s, 'less', song('old'), { now: T0 });
    s = M.quickSkip(s, song('a'), { learn: true, now: T0 + 5 });
    assert.deepEqual(s.more, []);
    assert.deepEqual(titles(s.less), ['old', 'a']);
    assert.deepEqual([s.less[1].pinned, s.less[1].origin, s.less[1].at], [false, 'skip', T0 + 5]);
  });

  test('a re-skip moves to newest with a fresh clock, keeping its pin', () => {
    let s = M.addManual(M.emptySeeds, 'less', song('a'), { now: T0 });
    s = M.addManual(s, 'less', song('b'), { now: T0 });
    s = M.quickSkip(s, song('a'), { learn: true, now: T0 + 9 });
    assert.deepEqual(titles(s.less), ['b', 'a']);
    assert.deepEqual([s.less[1].pinned, s.less[1].at], [true, T0 + 9]);
  });

  test('Less like keeps eight, the oldest unpinned leaving first', () => {
    let s = M.addManual(M.emptySeeds, 'less', song('pin'), { now: T0 });
    for (let i = 1; i <= 8; i++) { s = M.quickSkip(s, song(`s${i}`), { learn: true, now: T0 + i }); }
    assert.deepEqual(titles(s.less), ['pin', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
  });

  test('eight pinned Less like rows: the skip is not added', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 8; i++) { s = M.addManual(s, 'less', song(`pin${i}`), { now: T0 }); }
    s = M.pushPick(s, song('a'), { now: T0 });
    const next = M.quickSkip(s, song('a'), { learn: true, now: T0 + 1 });
    assert.deepEqual(next.more, [], 'it still leaves More like');
    assert.deepEqual(titles(next.less), titles(s.less));
  });

  test('learn off: only leaves More like', () => {
    const s = M.quickSkip(M.pushPick(M.emptySeeds, song('a'), { now: T0 }), song('a'), { learn: false, now: T0 + 1 });
    assert.deepEqual(s.more, []);
    assert.deepEqual(s.less, []);
  });

  test('frozen: nothing', () => {
    const s = M.freeze(M.pushPick(M.emptySeeds, song('a'), { now: T0 }), T0);
    assert.equal(M.quickSkip(s, song('a'), { learn: true, now: T0 + 1 }), s);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. manual edits
// ─────────────────────────────────────────────────────────────────────

describe('manual edits', () => {
  test('Add song pins the row and takes it out of the other list', () => {
    let s = M.addManual(M.emptySeeds, 'less', song('a'), { now: T0 });
    s = M.addManual(s, 'more', song('a'), { now: T0 + 1 });
    assert.deepEqual(titles(s.more), ['a']);
    assert.deepEqual(s.less, []);
    assert.deepEqual([s.more[0].pinned, s.more[0].origin], [true, 'manual']);
  });

  test('an add in Drift keeps More like within the ring', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 5; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    for (let i = 1; i <= 4; i++) { s = M.addManual(s, 'more', song(`pin${i}`), { now: T0 + 10 + i }); }
    assert.deepEqual(titles(s.more), ['p2', 'p3', 'p4', 'p5', 'pin1', 'pin2', 'pin3', 'pin4']);
  });

  test('a full list takes nothing', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 8; i++) { s = M.addManual(s, 'less', song(`pin${i}`), { now: T0 }); }
    assert.equal(M.addManual(s, 'less', song('x'), { now: T0 }), s);
  });

  test('a move pins and keeps the facts', () => {
    let s = M.pushPick(M.emptySeeds, song('a', { artist: 'Art', album: 'Al', art: 'a.jpg', duration: 200 }), { now: T0 });
    s = M.moveRow(s, k('a'), { now: T0 + 3 });
    assert.deepEqual(s.more, []);
    const r = s.less[0];
    assert.deepEqual([r.pinned, r.origin, r.at], [true, 'manual', T0 + 3]);
    assert.deepEqual([r.title, r.artist, r.album, r.art, r.duration], ['a', 'Art', 'Al', 'a.jpg', 200]);
  });

  test('unpinning Less like restarts its 30 minutes', () => {
    let s = M.addManual(M.emptySeeds, 'less', song('a'), { now: T0 });
    s = M.setPinned(s, 'less', k('a'), false, { now: T0 + 20 * MIN });
    assert.deepEqual([s.less[0].pinned, s.less[0].at], [false, T0 + 20 * MIN]);
    assert.equal(M.prune(s, T0 + 49 * MIN).less.length, 1, 'still there 29 minutes after the unpin');
    assert.equal(M.prune(s, T0 + 50 * MIN).less.length, 0);
  });

  test('unpinning More like leaves it until the next pick', () => {
    let s = M.addManual(M.emptySeeds, 'more', song('a'), { now: T0 });
    for (let i = 1; i <= 5; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    s = M.setPinned(s, 'more', k('a'), false, { now: T0 + 10 });
    assert.equal(s.more.length, 6, 'still listed');
    s = M.pushPick(s, song('p6'), { now: T0 + 11 });
    assert.deepEqual(titles(s.more), ['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  test('the pin toggle does nothing in Stay close', () => {
    const s = M.freeze(M.addManual(M.emptySeeds, 'more', song('a'), { now: T0 }), T0);
    assert.equal(M.setPinned(s, 'more', k('a'), false, { now: T0 + 1 }), s);
  });

  test('Remove works whatever the pin, in either mode', () => {
    let s = M.addManual(M.emptySeeds, 'more', song('a'), { now: T0 });
    s = M.pushPick(s, song('b'), { now: T0 });
    assert.deepEqual(titles(M.removeRow(s, 'more', k('a')).more), ['b']);
    assert.deepEqual(titles(M.removeRow(s, 'more', k('b')).more), ['a']);
    const f = M.freeze(s, T0);
    assert.deepEqual(titles(M.removeRow(f, 'more', k('a')).more), ['b']);
    assert.equal(M.removeRow(f, 'more', k('zz')), f);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Stay close
// ─────────────────────────────────────────────────────────────────────

describe('Stay close (freeze / thaw)', () => {
  test('an expired Less like row is not frozen in', () => {
    let s = M.quickSkip(M.emptySeeds, song('old'), { learn: true, now: T0 });
    s = M.quickSkip(s, song('new'), { learn: true, now: T0 + 20 * MIN });
    assert.deepEqual(titles(M.freeze(s, T0 + 31 * MIN).less), ['new']);
  });

  test('a frozen set keeps its frozenAt', () => {
    const f = M.freeze(M.emptySeeds, T0);
    assert.deepEqual([f.frozen, f.frozenAt], [true, T0]);
    assert.equal(M.freeze(f, T0 + 5), f);
    assert.equal(M.inMode(f, T0 + 5, true), f);
  });

  test('every row shows pinned; stored pins untouched', () => {
    const s = M.pushPick(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), song('pick'), { now: T0 });
    const f = M.freeze(s, T0 + 1);
    assert.deepEqual(f.more.map((r) => M.shownPinned(f, r)), [true, true]);
    assert.deepEqual(f.more.map((r) => r.pinned), [true, false]);
  });

  test("the user's own edits still work", () => {
    const f = M.freeze(M.pushPick(M.emptySeeds, song('a'), { now: T0 }), T0);
    const added = M.addManual(f, 'less', song('b'), { now: T0 + 1 });
    assert.deepEqual(titles(added.less), ['b']);
    const moved = M.moveRow(added, k('a'), { now: T0 + 2 });
    assert.deepEqual(titles(moved.less), ['b', 'a']);
    assert.equal(moved.frozen, true);
    assert.deepEqual(titles(M.removeRow(moved, 'less', k('b')).less), ['a']);
  });

  test("thaw shows the user's own pins again", () => {
    const s = M.pushPick(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), song('pick'), { now: T0 });
    const t = M.thaw(M.freeze(s, T0 + 1), T0 + 2);
    assert.deepEqual([t.frozen, t.frozenAt], [false, null]);
    assert.deepEqual(t.more.map((r) => M.shownPinned(t, r)), [true, false]);
  });

  test('thaw moves the unpinned Less like clocks forward by the pause', () => {
    const s = M.quickSkip(M.emptySeeds, song('a'), { learn: true, now: T0 });
    const t = M.thaw(M.freeze(s, T0 + 10 * MIN), T0 + 70 * MIN);
    assert.equal(t.less[0].at, T0 + 60 * MIN);
    assert.equal(M.prune(t, T0 + 89 * MIN).less.length, 1, '10 minutes before the freeze, 19 after the thaw');
    assert.equal(M.prune(t, T0 + 90 * MIN).less.length, 0);
  });

  test('a row that came in after the freeze stood still only since it came in', () => {
    const row = M.quickSkip(M.emptySeeds, song('a'), { learn: true, now: T0 + 10 * MIN }).less[0];
    const f = { more: [], less: [row], frozen: true, frozenAt: T0 };
    assert.equal(M.thaw(f, T0 + 40 * MIN).less[0].at, T0 + 40 * MIN);
  });

  test('thaw trims More like to the ring, oldest unpinned first', () => {
    let s = M.emptySeeds;
    for (let i = 1; i <= 5; i++) { s = M.pushPick(s, song(`p${i}`), { now: T0 + i }); }
    let f = M.freeze(s, T0 + 10);
    f = M.admitAnchor(f, song('anchor'), { usable: () => false, now: T0 + 11 });
    f = M.addManual(f, 'more', song('pin'), { now: T0 + 12 });
    assert.equal(f.more.length, 7);
    assert.deepEqual(titles(M.thaw(f, T0 + 20).more), ['p2', 'p3', 'p4', 'p5', 'anchor', 'pin']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. expiry
// ─────────────────────────────────────────────────────────────────────

describe('expiry (Drift time)', () => {
  test('kept at 29:59, gone at 30:00', () => {
    const s = M.quickSkip(M.emptySeeds, song('a'), { learn: true, now: T0 });
    assert.equal(M.prune(s, T0 + TTL - 1000), s);
    assert.deepEqual(M.prune(s, T0 + TTL).less, []);
  });

  test('a pin never expires', () => {
    const s = M.addManual(M.emptySeeds, 'less', song('a'), { now: T0 });
    assert.equal(M.prune(s, T0 + 10 * TTL), s);
    assert.equal(M.nextExpiry(s), null);
  });

  test('nextExpiry is the earliest', () => {
    let s = M.quickSkip(M.emptySeeds, song('a'), { learn: true, now: T0 });
    s = M.quickSkip(s, song('b'), { learn: true, now: T0 + 5 * MIN });
    s = M.addManual(s, 'less', song('pin'), { now: T0 - TTL });
    assert.equal(M.nextExpiry(s), T0 + TTL);
  });

  test('frozen: no prune, no nextExpiry', () => {
    const f = M.freeze(M.quickSkip(M.emptySeeds, song('a'), { learn: true, now: T0 }), T0 + 1);
    assert.equal(M.prune(f, T0 + 10 * TTL), f);
    assert.equal(M.nextExpiry(f), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. carryOver
// ─────────────────────────────────────────────────────────────────────

describe('carryOver (a new lane)', () => {
  test('Drift: pins and unpinned skips stay, clocks untouched; picks go', () => {
    let s = M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 });
    s = M.pushPick(s, song('pick'), { now: T0 + 1 });
    s = M.addManual(s, 'less', song('lpin'), { now: T0 });
    s = M.quickSkip(s, song('skip'), { learn: true, now: T0 + 2 });
    const c = M.carryOver(s, T0 + 10, false);
    assert.deepEqual(titles(c.more), ['pin']);
    assert.deepEqual(titles(c.less), ['lpin', 'skip']);
    assert.equal(c.less[1].at, T0 + 2);
    assert.equal(c.frozen, false);
  });

  test('frozen: every row stays with its pin, clock and frozenAt', () => {
    let s = M.pushPick(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), song('pick'), { now: T0 });
    s = M.quickSkip(s, song('skip'), { learn: true, now: T0 + 1 });
    const f = M.freeze(s, T0 + 5);
    assert.equal(M.carryOver(f, T0 + 50, true), f);
  });

  test('a never-armed set in Stay close freezes from now', () => {
    const c = M.carryOver(M.emptySeeds, T0 + 7, true);
    assert.deepEqual([c.frozen, c.frozenAt], [true, T0 + 7]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. admitAnchor
// ─────────────────────────────────────────────────────────────────────

describe('admitAnchor (the Stay close one song)', () => {
  const none = () => false;

  test('a usable row means nothing comes in', () => {
    const f = M.freeze(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), T0);
    assert.equal(M.admitAnchor(f, song('cur'), { usable: () => true, now: T0 + 1 }), f);
  });

  test('the one song comes in past eight', () => {
    let f = M.freshSeeds(true, T0);
    for (let i = 1; i <= 8; i++) { f = M.addManual(f, 'more', song(`pin${i}`), { now: T0 }); }
    const a = M.admitAnchor(f, song('cur'), { usable: none, now: T0 + 1 });
    assert.equal(a.more.length, 9);
    const r = a.more[8];
    assert.deepEqual([r.title, r.origin, r.pinned, M.shownPinned(a, r)], ['cur', 'anchor', false, true]);
  });

  test('it never removes a row', () => {
    let f = M.admitAnchor(M.freshSeeds(true, T0), song('a1'), { usable: none, now: T0 });
    f = M.admitAnchor(f, song('a2'), { usable: none, now: T0 + 1 });
    assert.deepEqual(titles(f.more), ['a1', 'a2']);
  });

  test('it refuses a song in either list', () => {
    let f = M.addManual(M.freshSeeds(true, T0), 'less', song('x'), { now: T0 });
    f = M.admitAnchor(f, song('y'), { usable: none, now: T0 });
    assert.equal(M.admitAnchor(f, song('x'), { usable: none, now: T0 + 1 }), f);
    assert.equal(M.admitAnchor(f, song('y'), { usable: none, now: T0 + 1 }), f);
  });

  test('it stops at sixteen', () => {
    let f = M.freshSeeds(true, T0);
    for (let i = 1; i <= 16; i++) { f = M.admitAnchor(f, song(`a${i}`), { usable: none, now: T0 + i }); }
    assert.equal(f.more.length, 16);
    assert.equal(M.admitAnchor(f, song('a17'), { usable: none, now: T0 + 17 }), f);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. merge
// ─────────────────────────────────────────────────────────────────────

describe('merge (the held-aside set)', () => {
  test('a held row wins over the live one', () => {
    const live = M.pushPick(M.emptySeeds, song('a', { title: 'live' }), { now: T0 });
    const pending = M.addManual(M.emptySeeds, 'less', song('a', { title: 'held' }), { now: T0 + 1 });
    const m = M.merge(live, pending, T0 + 2);
    assert.deepEqual(m.more, []);
    assert.deepEqual(titles(m.less), ['held']);
    assert.equal(m.less[0].pinned, true);
  });

  test("caps make live's oldest unpinned rows give way first", () => {
    let live = M.emptySeeds;
    for (let i = 1; i <= 3; i++) { live = M.addManual(live, 'more', song(`lp${i}`), { now: T0 }); }
    for (let i = 1; i <= 5; i++) { live = M.pushPick(live, song(`p${i}`), { now: T0 + i }); }
    let pending = M.addManual(M.emptySeeds, 'more', song('h1'), { now: T0 + 10 });
    pending = M.addManual(pending, 'more', song('h2'), { now: T0 + 11 });
    const m = M.merge(live, pending, T0 + 12);
    assert.deepEqual(titles(m.more), ['lp1', 'lp2', 'lp3', 'p3', 'p4', 'p5', 'h1', 'h2']);
  });

  test('frozen when either set is', () => {
    const live = M.pushPick(M.emptySeeds, song('a'), { now: T0 });
    const pending = M.addManual(M.freshSeeds(true, T0 + 5), 'more', song('b'), { now: T0 + 6 });
    const m = M.merge(live, pending, T0 + 7);
    assert.deepEqual([m.frozen, m.frozenAt], [true, T0 + 5]);
    assert.equal(M.merge(live, null, T0 + 7), live);
    assert.equal(M.merge(live, M.emptySeeds, T0 + 7), live);
  });

  test('an unpinned Less like row keeps the Drift time it ran', () => {
    const pending = M.quickSkip(M.emptySeeds, song('s'), { learn: true, now: T0 });
    const m = M.merge(M.freshSeeds(true, T0 + 5 * MIN), pending, T0 + 10 * MIN);
    assert.equal(m.less[0].at, T0 - 5 * MIN, 'ten minutes run, put before the freeze');
    const t = M.thaw(m, T0 + 100 * MIN);
    assert.equal(T0 + 100 * MIN - t.less[0].at, 10 * MIN, 'at the thaw it has still run ten minutes');
    const drift = M.merge(M.emptySeeds, pending, T0 + 10 * MIN);
    assert.equal(drift.less[0].at, T0, 'into Drift it keeps its own clock');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. the box
// ─────────────────────────────────────────────────────────────────────

describe('the box (clear pins when the queue is cleared)', () => {
  test('clearsPinsOnClear: only a user clear of a queue that held a row, with the box ticked', () => {
    for (const userClear of [false, true]) {
      for (const queueHadRows of [false, true]) {
        for (const setting of [false, true]) {
          assert.equal(AUTODJ.clearsPinsOnClear({ userClear, queueHadRows, setting }),
            userClear && queueHadRows && setting, JSON.stringify({ userClear, queueHadRows, setting }));
        }
      }
    }
    assert.equal(M.clearsPinsOnClear, AUTODJ.clearsPinsOnClear);
  });

  test("withoutPinned: Drift removes the user's pins only, skips keep their clocks", () => {
    let s = M.pushPick(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), song('pick'), { now: T0 });
    s = M.addManual(s, 'less', song('lpin'), { now: T0 });
    s = M.quickSkip(s, song('skip'), { learn: true, now: T0 + 3 });
    const w = M.withoutPinned(s);
    assert.deepEqual(titles(w.more), ['pick']);
    assert.deepEqual(titles(w.less), ['skip']);
    assert.equal(w.less[0].at, T0 + 3);
  });

  test('withoutPinned: Stay close empties both lists and stays frozen', () => {
    let s = M.pushPick(M.addManual(M.emptySeeds, 'more', song('pin'), { now: T0 }), song('pick'), { now: T0 });
    s = M.quickSkip(s, song('skip'), { learn: true, now: T0 + 3 });
    const w = M.withoutPinned(M.freeze(s, T0 + 4));
    assert.deepEqual([w.more, w.less, w.frozen, w.frozenAt], [[], [], true, T0 + 4]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 12. usableSeeds
// ─────────────────────────────────────────────────────────────────────

describe('usableSeeds (what a request carries)', () => {
  test('at most eight, the newest kept, oldest first', () => {
    let f = M.freshSeeds(true, T0);
    for (let i = 1; i <= 10; i++) { f = M.admitAnchor(f, song(`a${i}`), { usable: () => false, now: T0 + i }); }
    assert.deepEqual(titles(M.usableSeeds(f.more, () => true)), ['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10']);
    assert.deepEqual(titles(M.usableSeeds(f.more, (r) => r.title !== 'a10')),
      ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'], 'only the usable rows count');
  });

  test("past eight a pin never makes way for Stay close's one song", () => {
    let f = M.freshSeeds(true, T0);
    for (let i = 1; i <= 8; i++) { f = M.addManual(f, 'more', song(`pin${i}`), { now: T0 }); }
    f = M.admitAnchor(f, song('anchor'), { usable: () => false, now: T0 + 1 });
    assert.equal(f.more.length, 9);
    assert.deepEqual(titles(M.usableSeeds(f.more, () => true)),
      ['pin1', 'pin2', 'pin3', 'pin4', 'pin5', 'pin6', 'pin7', 'pin8']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 13. persistence
// ─────────────────────────────────────────────────────────────────────

describe('persistence', () => {
  test('Drift stores the pins only', () => {
    lane();
    S.add('more', song('pin'), T0 + 1);
    S.onPlay(song('pick'), { lanePick: true, now: T0 + 2 });
    S.add('less', song('lpin'), T0 + 3);
    assert.deepEqual(stored().map((e) => [e.list, e.path, e.pinned, e.title]),
      [['more', 'music/pin.mp3', true, 'pin'], ['less', 'music/lpin.mp3', true, 'lpin']]);
    assert.equal(_store.has(FROZEN_AT), false);
  });

  test('Stay close stores every row with its own pin and frozenAt', () => {
    lane();
    S.add('more', song('pin'), T0 + 1);
    S.onPlay(song('pick'), { lanePick: true, now: T0 + 2 });
    S.setMode('locked', T0 + 5);
    assert.deepEqual(stored().map((e) => [e.list, e.path, e.pinned, e.origin]),
      [['more', 'music/pin.mp3', true, 'manual'], ['more', 'music/pick.mp3', false, 'pick']]);
    assert.equal(JSON.parse(_store.get(FROZEN_AT)), T0 + 5);
  });

  test('a pick in Drift writes nothing (no localStorage write)', () => {
    lane();
    S.add('more', song('pin'), T0 + 1);
    _writes.length = 0;
    S.onPlay(song('pick'), { lanePick: true, now: T0 + 2 });
    S.quickSkip(song('pick'), { djPick: true, learn: true, now: T0 + 3 });
    assert.equal(S.view(T0 + 4).less.length, 1, 'an unpinned skip came in');
    assert.deepEqual(_writes, []);
  });

  test('only an explicit pinned:false reads unpinned', () => {
    _store.set('mstream-dj-sonicAnchorMode', JSON.stringify('locked'));
    _store.set(ROWS, JSON.stringify([
      { list: 'more', owner: null, path: 'music/a.mp3', title: 'a', pinned: false, origin: 'pick', at: T0 },
      { list: 'more', owner: null, path: 'music/b.mp3', title: 'b', origin: 'pick', at: T0 },
      { list: 'more', owner: null, path: 'music/c.mp3', title: 'c', pinned: 'no', origin: 'pick', at: T0 },
    ]));
    AUTODJ._internals.rehydrate();
    assert.deepEqual(S.view().more.map((r) => [r.title, r.pinned]).reverse(), [['a', false], ['b', true], ['c', true]]);
  });

  test('an unknown origin reads manual; a bad time reads now; a bad entry is skipped', () => {
    const entries = [
      { list: 'more', path: 'music/a.mp3', title: 'a', origin: 'gremlin', at: 'yesterday', pinned: true },
      { list: 'sideways', path: 'music/b.mp3', title: 'b' },
      { list: 'more', path: '', title: 'c' },
      { list: 'more', owner: 'a peer', path: 'music/d.mp3', title: 'd' },
      'junk', null, 42, ['more'],
    ];
    const read = entries.map((e) => M.storedRowFromJson(e, T0));
    assert.deepEqual(read.map((e) => e && [e.list, e.row.title, e.row.origin, e.row.at]),
      [['more', 'a', 'manual', T0], null, null, null, null, null, null, null]);
    assert.equal(M.storedRowFromJson({ list: 'less', path: 'x.mp3', at: 8.64e15 + 1 }, T0).row.at, T0, 'out of range');
    _store.set(ROWS, JSON.stringify(entries));
    const before = Date.now();
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.deepEqual(titles(v.more), ['a']);
    assert.ok(v.more[0].at >= before && v.more[0].at <= Date.now(), 'read at the load');
  });

  test('a key named twice keeps its last entry', () => {
    _store.set(ROWS, JSON.stringify([
      { list: 'more', path: 'music/a.mp3', title: 'first', pinned: true, origin: 'manual', at: T0 },
      { list: 'less', path: '/music/a.mp3', title: 'second', pinned: true, origin: 'manual', at: T0 + 1 },
    ]));
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.deepEqual(v.more, []);
    assert.deepEqual(titles(v.less), ['second']);
  });

  test('Drift load: only the pins come back', () => {
    _store.set(ROWS, JSON.stringify([
      { list: 'more', path: 'music/pin.mp3', title: 'pin', pinned: true, origin: 'manual', at: T0 },
      { list: 'more', path: 'music/pick.mp3', title: 'pick', pinned: false, origin: 'pick', at: T0 },
      { list: 'less', path: 'music/skip.mp3', title: 'skip', pinned: false, origin: 'skip', at: T0 },
    ]));
    _store.set(FROZEN_AT, JSON.stringify(T0));
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.equal(v.frozen, false);
    assert.deepEqual(titles(v.more), ['pin']);
    assert.deepEqual(v.less, []);
    assert.deepEqual(stored().map((e) => e.path), ['music/pin.mp3'], 'the first save writes the pins alone');
    assert.equal(_store.has(FROZEN_AT), false);
  });

  test('Stay close load: every row back as it was, closed time not counted', () => {
    _store.set('mstream-dj-sonicAnchorMode', JSON.stringify('locked'));
    _store.set(ROWS, JSON.stringify([
      { list: 'more', path: 'music/pin.mp3', title: 'pin', pinned: true, origin: 'manual', at: T0 },
      { list: 'more', path: 'music/anchor.mp3', title: 'anchor', pinned: false, origin: 'anchor', at: T0 },
      { list: 'less', path: 'music/skip.mp3', title: 'skip', pinned: false, origin: 'skip', at: T0 },
    ]));
    _store.set(FROZEN_AT, JSON.stringify(T0 + 10 * MIN));
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.equal(v.frozen, true);
    assert.deepEqual(v.more.map((r) => [r.title, r.pinned, r.shownPinned]), [['anchor', false, true], ['pin', true, true]]);
    assert.deepEqual(titles(v.less), ['skip']);
    _writes.length = 0;
    AUTODJ._internals.rehydrate();
    assert.deepEqual(_writes, [], 'a load of the file as it was writes nothing');
    // Back in Drift hours later, the skip has the 20 minutes it had left.
    const later = Date.now() + 5 * 3600 * 1000;
    S.setMode('rolling', later);
    assert.equal(S.view(later + 19 * MIN).less.length, 1);
    assert.equal(S.view(later + 20 * MIN).less.length, 0);
  });

  test('a bare row stays bare across a reload until it is filled', () => {
    lane();
    S.add('more', { owner: null, path: 'music/x.mp3', title: 'Repaired', bare: true }, T0 + 1);
    AUTODJ._internals.rehydrate();
    assert.deepEqual(S.bareRows(), [{ key: k('x'), owner: null, path: 'music/x.mp3' }]);
    S.fillFacts(k('x'), { title: 'Real', artist: 'Band', art: 'x.jpg' }, T0 + 2);
    AUTODJ._internals.rehydrate();
    assert.deepEqual(S.bareRows(), []);
    assert.deepEqual([S.view().more[0].title, S.view().more[0].art], ['Real', 'x.jpg']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 14. migration
// ─────────────────────────────────────────────────────────────────────

describe("migration (today's seed, ring and anchor)", () => {
  test("today's seed becomes a pinned More like row with its title repaired", () => {
    _store.set('mstream-dj-sonicSeed', JSON.stringify({ filepath: '/music/Artist/Song.mp3', title: 'Artist - Song — Artist' }));
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.equal(v.more.length, 1);
    const r = v.more[0];
    assert.deepEqual([r.key, r.title, r.artist, r.pinned, r.origin, r.bare],
      ['local|music/Artist/Song.mp3', 'Song', 'Artist', true, 'manual', true]);
    assert.deepEqual(stored().map((e) => [e.path, e.pinned, e.bare]), [['music/Artist/Song.mp3', true, true]]);
    assert.deepEqual(M.repairLegacyTitle('Song only', 'music/x.mp3'), { title: 'Song only', artist: '' });
    assert.deepEqual(M.repairLegacyTitle('music/x.mp3', '/music/x.mp3'), { title: '', artist: '' }, 'a title that is its path');
    assert.deepEqual(M.repairLegacyTitle('A - B - C — A', 'p'), { title: 'B - C', artist: 'A' });
  });

  test('the old ring, owners and locked anchor are dropped, the four keys removed', () => {
    _store.set('mstream-dj-sonicSeed', JSON.stringify({ filepath: 'music/s.mp3', title: 's' }));
    _store.set('mstream-dj-sonicHistory', JSON.stringify(['music/h1.mp3', 'music/h2.mp3']));
    _store.set('mstream-dj-sonicHistoryOwners', JSON.stringify({ 'music/h2.mp3': 7 }));
    _store.set('mstream-dj-sonicLockedAnchor', JSON.stringify('music/h1.mp3'));
    AUTODJ._internals.rehydrate();
    for (const key of ['sonicSeed', 'sonicHistory', 'sonicHistoryOwners', 'sonicLockedAnchor']) {
      assert.equal(_store.has(`mstream-dj-${key}`), false, key);
    }
    assert.deepEqual(S.view().more.map((r) => r.path), ['music/s.mp3']);
  });

  test('a stored locked mode is Stay close', () => {
    _store.set('mstream-dj-sonicAnchorMode', JSON.stringify('locked'));
    _store.set('mstream-dj-sonicLockedAnchor', JSON.stringify('music/h1.mp3'));
    AUTODJ._internals.rehydrate();
    const v = S.view();
    assert.deepEqual([v.mode, v.frozen, v.more], ['locked', true, []], 'the locked anchor itself is dropped');
    assert.equal(_store.has('mstream-dj-sonicLockedAnchor'), false);
  });

  test('a junk seed migrates nothing', () => {
    for (const junk of ['not-an-object', { filepath: 42 }, { filepath: '/' }, { title: 'x' }, null]) {
      _store.clear();
      _store.set('mstream-dj-sonicSeed', JSON.stringify(junk));
      AUTODJ._internals.rehydrate();
      assert.deepEqual(S.view().more, [], JSON.stringify(junk));
      assert.equal(_store.has('mstream-dj-sonicSeed'), false);
    }
  });

  test('a second load finds nothing to migrate', () => {
    _store.set('mstream-dj-sonicSeed', JSON.stringify({ filepath: 'music/s.mp3', title: 's' }));
    AUTODJ._internals.rehydrate();
    _writes.length = 0;
    AUTODJ._internals.rehydrate();
    assert.deepEqual(_writes, [], 'nothing to write');
    assert.deepEqual(S.view().more.map((r) => r.path), ['music/s.mp3']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 15. the container: lanes and picks
// ─────────────────────────────────────────────────────────────────────

describe('the container: lanes and picks', () => {
  test('laneEdge carries over and resets the lane', () => {
    const id = S.laneId();
    S.setArmed(true);
    S.laneEdge({ now: T0 });
    assert.equal(S.laneId(), id + 1);
    S.beginPick({ current: song('cur'), now: T0 });
    S.add('more', song('pin'), T0 + 1);
    S.onPlay(song('pick'), { lanePick: true, now: T0 + 2 });
    S.add('less', song('lpin'), T0 + 3);
    assert.equal(S.blendSkippable(k('cur')), true);
    S.laneEdge({ now: T0 + 4 });
    const v = S.view(T0 + 5);
    assert.deepEqual(titles(v.more), ['pin']);
    assert.deepEqual(titles(v.less), ['lpin']);
    assert.equal(S.blendSkippable(k('cur')), false, 'no blend in the new lane');
    assert.equal(S.beginPick({ current: null, now: T0 + 6 }).first, true, "the next pick is the lane's first");
  });

  test('laneEdge with the box takes the pins first', () => {
    lane();
    S.add('more', song('pin'), T0 + 1);
    S.onPlay(song('pick'), { lanePick: true, now: T0 + 2 });
    S.quickSkip(song('pick'), { djPick: true, learn: true, now: T0 + 3 });
    S.add('less', song('lpin'), T0 + 4);
    _writes.length = 0;
    S.laneEdge({ clearPins: true, now: T0 + 5 });
    const v = S.view(T0 + 6);
    assert.deepEqual(v.more, []);
    assert.deepEqual(titles(v.less), ['pick'], 'the unpinned skip keeps its clock');
    assert.deepEqual(stored(), []);
    _writes.length = 0;
    S.laneEdge({ clearPins: true, now: T0 + 7 });
    assert.ok(_writes.includes(ROWS), 'the stored list is written even when no row changed');
  });

  test('the first pick merges the held-aside set, then blends the current row in Drift', () => {
    S.add('more', song('held'), T0);
    assert.deepEqual(titles(S.view(T0).more), ['held'], 'the DJ off: held aside, shown');
    S.setArmed(true);
    S.laneEdge({ now: T0 + 1 });
    assert.deepEqual(titles(S.view(T0 + 1).more), ['held'], 'Start keeps it');
    assert.deepEqual(S.positives({ now: T0 + 1 }), [], 'not sent before the first pick');
    assert.equal(S.beginPick({ current: song('cur'), now: T0 + 2 }).first, true);
    assert.deepEqual(S.view(T0 + 3).more.map((r) => [r.title, r.pinned, r.origin]),
      [['cur', false, 'opener'], ['held', true, 'manual']]);
    assert.deepEqual(S.positives({ now: T0 + 3 }).map((p) => p.path), ['music/held.mp3', 'music/cur.mp3']);
  });

  test('no blend for a DJ pick of this lane, a song in Less like, a song already in More like, or no current row', () => {
    const fresh = () => {
      _store.clear();
      AUTODJ._internals.rehydrate();
      S.setArmed(true);
      S.laneEdge({ now: T0 });
    };
    fresh();
    S.beginPick({ current: song('pick'), currentIsLanePick: true, now: T0 });
    assert.deepEqual(S.view(T0).more, [], "this lane's pick");
    fresh();
    S.add('less', song('x'), T0);
    S.beginPick({ current: song('x'), now: T0 + 1 });
    assert.deepEqual(S.view(T0 + 1).more, [], 'in Less like');
    fresh();
    S.add('more', song('y'), T0);
    S.beginPick({ current: song('y'), now: T0 + 1 });
    assert.deepEqual(S.view(T0 + 1).more.map((r) => [r.title, r.pinned, r.origin]), [['y', true, 'manual']], 'keeps its pin');
    fresh();
    S.beginPick({ current: null, now: T0 });
    assert.deepEqual(S.view(T0).more, [], 'no current row');
    fresh();
    S.beginPick({ current: song('p', { owner: 7 }), route: 'local', now: T0 });
    assert.deepEqual(S.view(T0).more, [], 'the local route carries no peer row');
    fresh();
    S.beginPick({ current: song('p', { owner: 7 }), route: 'fanout', now: T0 });
    assert.deepEqual(S.view(T0).more.map((r) => r.key), ['7|music/p.mp3'], 'the fan-out does');
  });

  test('a second pick does not blend', () => {
    S.setArmed(true);
    S.laneEdge({ now: T0 });
    S.beginPick({ current: null, now: T0 });
    assert.equal(S.beginPick({ current: song('cur'), now: T0 + 1 }).first, false);
    assert.deepEqual(S.view(T0 + 1).more, []);
  });

  test('Stay close admits the current row once, then nothing — a removal sticks', () => {
    S.setMode('locked', T0);
    S.setArmed(true);
    S.laneEdge({ now: T0 });
    S.beginPick({ current: song('a'), sonicOn: true, now: T0 + 1 });
    assert.deepEqual(S.view(T0 + 1).more.map((r) => [r.title, r.origin, r.shownPinned]), [['a', 'anchor', true]]);
    S.remove(k('a'));
    S.beginPick({ current: song('b'), sonicOn: true, now: T0 + 2 });
    assert.deepEqual(S.view(T0 + 2).more, [], 'the lane took its one song');
    assert.deepEqual(S.positives({ current: song('b'), now: T0 + 2 }), [], 'and Stay close has no fallback');
    S.laneEdge({ now: T0 + 3 });
    S.beginPick({ current: song('c'), sonicOn: false, now: T0 + 4 });
    assert.deepEqual(S.view(T0 + 4).more, [], 'with sonic off nothing is admitted');
  });

  test("onPlay joins this lane's pick once per key, never an old lane's, never in Stay close", () => {
    lane();
    assert.equal(S.onPlay(song('a'), { lanePick: true, now: T0 + 1 }), true);
    assert.equal(S.onPlay(song('a'), { lanePick: true, now: T0 + 2 }), false, 'the same row again');
    assert.equal(S.onPlay(song('old'), { lanePick: false, now: T0 + 3 }), false, "an old lane's pick");
    S.setMode('locked', T0 + 4);
    assert.equal(S.onPlay(song('b'), { lanePick: true, now: T0 + 5 }), false, 'Stay close');
    S.setMode('rolling', T0 + 6);
    assert.equal(S.onPlay(song('b'), { lanePick: true, now: T0 + 7 }), false, 'the key moved on in Stay close');
    assert.deepEqual(titles(S.view(T0 + 8).more), ['a']);
    S.setArmed(false);
    assert.equal(S.onPlay(song('c'), { lanePick: true, now: T0 + 9 }), false, 'the DJ off');
  });

  test("a manual row's onPlay moves the key, so this lane's pick played again after it moves to newest; laneEdge clears the key", () => {
    lane();
    S.onPlay(song('a'), { lanePick: true, now: T0 + 1 });
    S.onPlay(song('b'), { lanePick: true, now: T0 + 2 });
    S.onPlay(song('manual'), { lanePick: false, now: T0 + 3 });
    assert.equal(S.onPlay(song('a'), { lanePick: true, now: T0 + 4 }), true);
    assert.deepEqual(titles(S.view(T0 + 5).more), ['a', 'b'], 'newest first');
    S.laneEdge({ now: T0 + 6 });
    S.beginPick({ current: null, now: T0 + 6 });
    assert.equal(S.onPlay(song('a'), { lanePick: true, now: T0 + 7 }), true, 'a new lane forgets the key');
  });

  test('edits route to the held-aside set while the DJ is off or before the first pick', () => {
    S.add('more', song('off'), T0);
    S.setArmed(true);
    S.laneEdge({ now: T0 + 1 });
    S.add('more', song('before'), T0 + 2);
    assert.deepEqual(S.positives({ now: T0 + 2 }), [], 'held aside: nothing live yet');
    S.laneEdge({ now: T0 + 3 });
    assert.deepEqual(titles(S.view(T0 + 3).more), ['before', 'off'], 'held rows outlive a clear');
    S.beginPick({ current: null, now: T0 + 4 });
    S.add('more', song('after'), T0 + 5);
    assert.deepEqual(S.positives({ now: T0 + 6 }).map((p) => p.path), ['music/off.mp3', 'music/before.mp3', 'music/after.mp3']);
  });

  test('setMode freezes and thaws both sets and re-arms the admission', () => {
    lane();
    S.add('more', song('pin'), T0 + 1);
    S.laneEdge({ now: T0 + 2 });
    S.add('less', song('held'), T0 + 3);
    assert.equal(S.setMode('locked', T0 + 4), true);
    const v = S.view(T0 + 5);
    assert.equal(v.frozen, true);
    assert.deepEqual([...v.more, ...v.less].map((r) => [r.title, r.shownPinned, r.locked]),
      [['pin', true, true], ['held', true, true]]);
    assert.equal(S.setPinned(k('held'), false, T0 + 6), false, 'Stay close: the pin toggle does nothing');
    assert.equal(S.setMode('locked', T0 + 7), false, 'unchanged: a no-op');
    S.beginPick({ current: song('cur'), sonicOn: true, now: T0 + 8 });
    assert.deepEqual(titles(S.view(T0 + 8).more), ['pin'], 'a usable row: nothing admitted');
    S.remove(k('pin'));
    S.setMode('rolling', T0 + 9);
    S.setMode('locked', T0 + 10);
    S.beginPick({ current: song('cur'), sonicOn: true, now: T0 + 11 });
    assert.deepEqual(S.view(T0 + 12).more.map((r) => [r.title, r.origin]), [['cur', 'anchor']], 'into Stay close re-arms it');
  });

  test('subscribe fires once per real change and never for a no-op', () => {
    const seen = [];
    const off = S.subscribe((v) => seen.push(titles(v.more)));
    S.add('more', song('a'), T0);
    assert.deepEqual(seen, [['a']]);
    S.remove(k('zzz'));
    S.setPinned(k('a'), true, T0);
    S.setMode('rolling', T0);
    S.view(T0);
    S.negatives(T0);
    S.positives({ now: T0 });
    S.prune(T0);
    assert.equal(seen.length, 1);
    S.setPinned(k('a'), false, T0 + 1);
    assert.equal(seen.length, 2);
    off();
    S.remove(k('a'));
    assert.equal(seen.length, 2, 'unsubscribed');
    S.subscribe(() => { throw new Error('boom'); });
    quietly(() => assert.doesNotThrow(() => S.add('more', song('b'), T0 + 2)));
  });

  test('a read (view, negatives) prunes an expired row but notifies nobody', () => {
    lane();
    S.onPlay(song('a'), { lanePick: true, now: T0 });
    S.quickSkip(song('a'), { djPick: true, learn: true, now: T0 + 1 });
    const seen = [];
    S.subscribe(() => seen.push(1));
    assert.equal(S.nextExpiry(T0 + 2), T0 + 1 + TTL);
    assert.deepEqual(S.negatives(T0 + 1 + TTL), []);
    assert.deepEqual(S.view(T0 + 1 + TTL).less, []);
    assert.equal(S.nextExpiry(T0 + 1 + TTL), null);
    assert.deepEqual(seen, []);
  });

  test('with eight pins the blend does not land and records no blend key', () => {
    S.setArmed(true);
    S.laneEdge({ now: T0 });
    for (let i = 1; i <= 8; i++) { S.add('more', song(`pin${i}`), T0); }
    S.beginPick({ current: song('cur'), now: T0 + 1 });
    assert.equal(S.view(T0 + 1).more.length, 8);
    S.remove(k('pin1'));
    S.add('more', song('cur'), T0 + 3);
    S.setPinned(k('cur'), false, T0 + 4);
    assert.equal(S.blendSkippable(k('cur')), false, 'no blend was recorded');
  });

  test('a held-aside set made in Stay close is frozen', () => {
    S.setMode('locked', T0);
    S.add('more', song('a'), T0 + 1);
    const v = S.view(T0 + 2);
    assert.equal(v.frozen, true);
    assert.deepEqual(v.more.map((r) => [r.title, r.locked, r.shownPinned]), [['a', true, true]]);
    assert.equal(S.setPinned(k('a'), false, T0 + 3), false);
    S.setMode('rolling', T0 + 4);
    assert.equal(S.view(T0 + 5).more[0].pinned, true, 'the pin stayed locked while held aside');
  });

  test('the pure rules the container runs on, and the covers', () => {
    assert.equal(M.seedAddHeldAside({ held: true, armed: true, lanePicked: true }), true, 'while a set is held aside');
    assert.equal(M.seedAddHeldAside({ held: false, armed: false, lanePicked: true }), true, 'the DJ off');
    assert.equal(M.seedAddHeldAside({ held: false, armed: true, lanePicked: false }), true, 'before the first pick');
    assert.equal(M.seedAddHeldAside({ held: false, armed: true, lanePicked: true }), false, 'a running lane');
    const go = { drift: true, laneStart: true, usable: true, inLessLike: false, alreadyMoreLike: false, isLanePick: false };
    assert.equal(M.blendsOnLaneStart(go), true);
    for (const flip of ['drift', 'laneStart', 'usable', 'inLessLike', 'alreadyMoreLike', 'isLanePick']) {
      assert.equal(M.blendsOnLaneStart({ ...go, [flip]: !go[flip] }), false, flip);
    }
    const blend = { key: 'local|a', blended: 'local|a', isDjPick: false, unpinnedInMoreLike: true };
    assert.equal(M.quickSkipsBlend(blend), true);
    assert.equal(M.quickSkipsBlend({ ...blend, isDjPick: true }), false, 'a DJ pick keeps its own rule');
    assert.equal(M.quickSkipsBlend({ ...blend, blended: null }), false, 'no blend this lane');
    assert.equal(M.quickSkipsBlend({ ...blend, unpinnedInMoreLike: false }), false, 'pinned since');
    lane();
    for (let i = 1; i <= 4; i++) { S.add('more', song(`t${i}`), T0 + i); }
    const v = S.view(T0 + 5);
    assert.deepEqual(titles(v.tiles), ['t4', 't3', 't2'], 'the three newest, newest first');
    assert.deepEqual(titles(M.tiles(M.addManual(M.emptySeeds, 'more', song('only'), { now: T0 }))), ['only']);
    assert.deepEqual(M.tiles(M.emptySeeds), []);
  });

  test('setMode refuses an unknown mode', () => {
    assert.equal(S.setMode('junk', T0), false);
    assert.equal(S.setMode(undefined, T0), false);
    assert.equal(AUTODJ.state.sonicAnchorMode, 'rolling');
    AUTODJ.setState({ sonicAnchorMode: 'junk' });
    assert.equal(AUTODJ.state.sonicAnchorMode, 'rolling');
    assert.equal(_store.has('mstream-dj-sonicAnchorMode'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 16. the wire reads
// ─────────────────────────────────────────────────────────────────────

describe('the wire reads (positives, negatives)', () => {
  test("positives: this server's usable rows, oldest first, ≤ 8, set-aside rows left out", () => {
    lane();
    for (let i = 1; i <= 3; i++) { S.add('more', song(`pin${i}`), T0 + i); }
    S.onPlay(song('peerpick', { owner: 7 }), { lanePick: true, now: T0 + 5 });
    assert.deepEqual(S.positives({ now: T0 + 6 }), [
      { path: 'music/pin1.mp3', peerId: null }, { path: 'music/pin2.mp3', peerId: null }, { path: 'music/pin3.mp3', peerId: null },
    ]);
    assert.equal(S.heal([k('pin2')], T0 + 7), true);
    assert.deepEqual(S.positives({ now: T0 + 7 }).map((p) => p.path), ['music/pin1.mp3', 'music/pin3.mp3']);
    assert.ok(titles(S.view(T0 + 7).more).includes('pin2'), 'a set-aside row stays listed');
    _store.clear();
    _store.set('mstream-dj-sonicAnchorMode', JSON.stringify('locked'));
    _store.set(ROWS, JSON.stringify([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ list: 'more', path: `music/p${i}.mp3`, title: `p${i}`, pinned: true, origin: 'manual', at: T0 })),
      { list: 'more', path: 'music/anchor.mp3', title: 'anchor', pinned: false, origin: 'anchor', at: T0 },
    ]));
    AUTODJ._internals.rehydrate();
    assert.deepEqual(S.positives({ now: T0 }).map((p) => p.path), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `music/p${i}.mp3`));
  });

  test('Drift falls back to the current row; Stay close does not', () => {
    lane();
    const cur = song('cur');
    assert.deepEqual(S.positives({ current: cur, now: T0 }), [{ path: 'music/cur.mp3', peerId: null }]);
    assert.deepEqual(S.positives({ current: song('p', { owner: 7 }), now: T0 }), [], 'local: never a peer row');
    S.add('less', cur, T0 + 1);
    assert.deepEqual(S.positives({ current: cur, now: T0 + 2 }), [], 'never a song in Less like');
    S.remove(k('cur'));
    S.heal([k('cur')], T0 + 3);
    assert.deepEqual(S.positives({ current: cur, now: T0 + 4 }), [], 'never a set-aside song');
    S.setMode('locked', T0 + 5);
    assert.deepEqual(S.positives({ current: cur, now: T0 + 6 }), [], 'Stay close: no fallback');
  });

  test('a dropped culprit stays out of the lane: neither the fallback nor a re-join sends it again', () => {
    lane();
    const cur = song('cur');
    S.onPlay(cur, { lanePick: true, now: T0 + 1 });
    assert.deepEqual(S.positives({ current: cur, now: T0 + 2 }).map((p) => p.path), ['music/cur.mp3']);
    assert.equal(S.heal([k('cur')], T0 + 3), true);
    assert.deepEqual(S.view(T0 + 3).more, [], 'the unpinned row is dropped');
    assert.deepEqual(S.positives({ current: cur, now: T0 + 4 }), [], 'the song playing is that row: no fallback to it');
    assert.equal(S.heal([k('cur')], T0 + 5), false, 'nothing left to change');
    S.onPlay(song('other'), { lanePick: true, now: T0 + 6 });
    S.onPlay(cur, { lanePick: true, now: T0 + 7 });
    assert.deepEqual(titles(S.view(T0 + 7).more), ['cur', 'other'], 'it may join again, listed');
    assert.deepEqual(S.positives({ current: cur, now: T0 + 8 }).map((p) => p.path), ['music/other.mp3'], 'but is not sent');
    S.laneEdge({ now: T0 + 9 });
    S.beginPick({ current: null, now: T0 + 10 });
    assert.deepEqual(S.positives({ current: cur, now: T0 + 11 }).map((p) => p.path), ['music/cur.mp3'], 'a new lane tries it again');
  });

  test('fanout positives keep peer rows with their owners', () => {
    lane();
    S.add('more', song('local'), T0);
    S.onPlay(song('remote', { owner: 7 }), { lanePick: true, now: T0 + 1 });
    assert.deepEqual(S.positives({ route: 'fanout', now: T0 + 2 }),
      [{ path: 'music/local.mp3', peerId: null }, { path: 'music/remote.mp3', peerId: 7 }]);
    assert.deepEqual(S.positives({ route: 'local', now: T0 + 2 }), [{ path: 'music/local.mp3', peerId: null }]);
    S.remove(k('local'));
    S.remove(k('remote', 7));
    assert.deepEqual(S.positives({ route: 'fanout', current: song('p', { owner: 9 }), now: T0 + 3 }),
      [{ path: 'music/p.mp3', peerId: 9 }], 'the fan-out falls back to any server\'s song');
  });

  test("negatives: this server's Less like rows, newest eight, oldest first", () => {
    lane();
    for (let i = 1; i <= 8; i++) { S.add('less', song(`n${i}`), T0 + i); }
    assert.deepEqual(S.negatives(T0 + 9), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `music/n${i}.mp3`));
    assert.equal(S.add('less', song('peer', { owner: 7 }), T0 + 10), false, 'Less like holds this server\'s songs only');
    _store.set(ROWS, JSON.stringify([
      { list: 'less', owner: 7, path: 'music/peer.mp3', title: 'p', pinned: true, origin: 'manual', at: T0 },
      { list: 'less', owner: null, path: 'music/own.mp3', title: 'o', pinned: true, origin: 'manual', at: T0 },
    ]));
    AUTODJ._internals.rehydrate();
    assert.deepEqual(S.negatives(T0), ['music/own.mp3'], 'a peer row is never sent');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 17. the quick-skip rule
// ─────────────────────────────────────────────────────────────────────

describe('the quick-skip rule (isQuickSkip / countsAsPlay)', () => {
  const q = (o) => AUTODJ.isQuickSkip({ djPick: true, hasNext: true, durationMs: null, ...o });
  test('heard 999 ms: no', () => { assert.equal(q({ heardMs: 999 }), false); });
  test('heard 1 s and 29.999 s: yes', () => {
    assert.equal(q({ heardMs: 1000 }), true);
    assert.equal(q({ heardMs: 29999 }), true);
  });
  test('heard 30 s: no', () => { assert.equal(q({ heardMs: 30000 }), false); });
  test('half of a 40 s song: no', () => {
    assert.equal(q({ heardMs: 20000, durationMs: 40000 }), false);
    assert.equal(q({ heardMs: 19999, durationMs: 40000 }), true);
  });
  test('no length: 30 s only', () => {
    assert.equal(q({ heardMs: 29999, durationMs: null }), true);
    assert.equal(q({ heardMs: 29999, durationMs: 0 }), true);
    assert.equal(AUTODJ.countsAsPlay(29999, undefined), false);
  });
  test('not a DJ pick: no', () => { assert.equal(q({ heardMs: 5000, djPick: false }), false); });
  test('no next row: no', () => {
    assert.equal(q({ heardMs: 5000, hasNext: false }), false);
    assert.equal(S.isQuickSkip, AUTODJ.isQuickSkip);
    assert.equal(S.countsAsPlay, AUTODJ.countsAsPlay);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 18. Add song's sections
// ─────────────────────────────────────────────────────────────────────

describe("Add song's sections", () => {
  const row = (name, extra = {}) => ({
    rawFilePath: `/music/${name}.mp3`, filepath: `music/${name}.mp3`, metadata: { title: name, artist: 'A' }, ...extra,
  });
  const none = { more: [], less: [] };

  test("Up next: rows after the current one, this server's, ≤ 20, not in the target list, once", () => {
    const playlist = [row('played'), row('cur'), row('n1'), row('peer', { federation: { peerId: 7 } }), row('n2'), row('n1'), row('inList')];
    for (let i = 0; i < 25; i++) { playlist.push(row(`x${i}`)); }
    const s = M.addSongSections({ list: 'more', playlist, position: 1, current: playlist[1], skips: [song('s')], recent: [], view: { more: [{ key: k('inList') }], less: [] } });
    assert.deepEqual(titles(s.upNext.slice(0, 3)), ['n1', 'n2', 'x0']);
    assert.equal(s.upNext.length, 20);
    assert.equal(s.upNext.some((f) => ['inList', 'peer', 'cur', 'played'].includes(f.title)), false);
    assert.deepEqual(s.skipped, [], 'More like has no Skipped section');
    assert.deepEqual(s.upNext[0], { owner: null, path: 'music/n1.mp3', title: 'n1', artist: 'A', album: '', art: null, duration: null });
  });

  test("Skipped only for Less like: the current row first, then the ring newest first, minus Up next's songs", () => {
    const playlist = [row('cur'), row('n1')];
    const skips = [song('s1'), song('n1'), song('s2', { owner: 7 }), song('s3')];
    const s = M.addSongSections({ list: 'less', playlist, position: 0, current: playlist[0], skips, recent: [], view: none });
    assert.deepEqual(titles(s.upNext), ['n1']);
    assert.deepEqual(titles(s.skipped), ['cur', 's1', 's3']);
  });

  test('Recently played drops both', () => {
    const playlist = [row('cur'), row('n1')];
    const s = M.addSongSections({
      list: 'less', playlist, position: 0, current: playlist[0], skips: [song('s1')],
      recent: [song('n1'), song('s1'), song('cur'), song('r1'), song('r1'), song('r2', { owner: 3 })], view: none,
    });
    assert.deepEqual(titles(s.recent), ['r1']);
  });

  test('a song in the other list stays offered', () => {
    const view = { more: [{ key: k('n1') }], less: [{ key: k('r1') }] };
    const s = M.addSongSections({ list: 'less', playlist: [row('cur'), row('n1')], position: 0, current: null, skips: [], recent: [song('r1'), song('r2')], view });
    assert.deepEqual(titles(s.upNext), ['n1'], 'in More like: offered for Less like');
    assert.deepEqual(titles(s.recent), ['r2'], 'in Less like itself: not offered');
    lane();
    S.add('more', song('n1'), T0);
    const c = S.addSongSections({ list: 'more', playlist: [row('cur'), row('n1'), row('n2')], position: 0, current: null, skips: [], recent: [], now: T0 });
    assert.deepEqual(titles(c.upNext), ['n2'], 'the container reads the current view');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 19. facts and fills
// ─────────────────────────────────────────────────────────────────────

describe('facts and fills', () => {
  test('factsFromSong: a queue row, a peer row, no path', () => {
    assert.deepEqual(S.factsFromSong({ rawFilePath: '/music/a.mp3', metadata: { title: 'A', artist: 'Band', album: 'Al', 'album-art': 'a.jpg', duration: 201.5, _djPicked: true } }),
      { owner: null, path: 'music/a.mp3', title: 'A', artist: 'Band', album: 'Al', art: 'a.jpg', duration: 201.5 });
    assert.deepEqual(S.factsFromSong({ rawFilePath: 'lib/b.mp3', metadata: {}, federation: { peerId: 7, peerName: 'P' } }),
      { owner: 7, path: 'lib/b.mp3', title: '', artist: '', album: '', art: null, duration: null });
    assert.equal(S.factsFromSong({ rawFilePath: '/', metadata: {} }), null);
    assert.equal(S.factsFromSong(null), null);
    assert.equal(S.factsFromSong(false), null, 'getCurrentSong() before the first play');
  });

  test('factsFromSearchHit, factsFromRecent and factsFromMeta', () => {
    assert.deepEqual(S.factsFromSearchHit({ name: 'Band - Song', filepath: 'music/s.mp3', album_art_file: 'f.jpg', metadata: null }),
      { owner: null, path: 'music/s.mp3', title: 'Band - Song', artist: '', album: '', art: 'f.jpg', duration: null });
    assert.deepEqual(S.factsFromSearchHit({ name: 'Band - Song', filepath: 'music/s.mp3', metadata: { title: 'Song', artist: 'Band', 'album-art': 'm.jpg', duration: 9 } }),
      { owner: null, path: 'music/s.mp3', title: 'Song', artist: 'Band', album: '', art: 'm.jpg', duration: 9 });
    assert.deepEqual(S.factsFromRecent({ filepath: 'music/r.mp3', metadata: { title: 'R', 'artist-display': 'X feat. Y' } }),
      { owner: null, path: 'music/r.mp3', title: 'R', artist: 'X feat. Y', album: '', art: null, duration: null });
    assert.deepEqual(S.factsFromMeta('/music/m.mp3', { title: 'M', duration: 'junk' }, 4),
      { owner: 4, path: 'music/m.mp3', title: 'M', artist: '', album: '', art: null, duration: null });
    assert.equal(S.factsFromRecent(null), null);
    assert.equal(S.factsFromSearchHit({ name: 'x' }), null);
  });

  test('a bare row is listed by bareRows and filled once by fillFacts, a stored one rewritten', () => {
    lane();
    S.add('more', { owner: null, path: 'music/x.mp3' }, T0);
    S.onPlay({ owner: null, path: 'music/y.mp3' }, { lanePick: true, now: T0 + 1 });
    S.onPlay({ owner: 7, path: 'music/z.mp3' }, { lanePick: true, now: T0 + 2 });
    assert.deepEqual(S.bareRows().map((r) => r.key).sort(), [k('x'), k('y')].sort(), 'local rows without a title');
    _writes.length = 0;
    assert.equal(S.fillFacts(k('x'), { title: 'X', artist: 'B', art: 'x.jpg', duration: 100 }, T0 + 3), true);
    assert.ok(_writes.includes(ROWS), 'a stored row is rewritten');
    assert.deepEqual([stored()[0].title, stored()[0].art, 'bare' in stored()[0]], ['X', 'x.jpg', false]);
    _writes.length = 0;
    assert.equal(S.fillFacts(k('y'), { title: 'Y' }, T0 + 4), true);
    assert.deepEqual(_writes, [], 'an unstored row writes nothing');
    assert.deepEqual(S.bareRows(), []);
    assert.equal(S.fillFacts(k('x'), { title: 'X', artist: 'B', art: 'x.jpg', duration: 100 }, T0 + 5), false, 'the same facts change nothing');
    assert.equal(S.fillFacts(k('nothing'), { title: 'N' }, T0 + 5), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 20. the Skipped ring
// ─────────────────────────────────────────────────────────────────────

describe('the Skipped ring', () => {
  test('noteSkip keeps the newest twenty, once each, persisted', () => {
    for (let i = 1; i <= 22; i++) { S.noteSkip(song(`s${i}`)); }
    S.noteSkip(song('s5', { path: '/music/s5.mp3' }));
    const ring = S.recentSkips();
    assert.equal(ring.length, 20);
    assert.deepEqual(titles(ring.slice(0, 3)), ['s5', 's22', 's21']);
    assert.equal(ring.filter((f) => f.title === 's5').length, 1);
    AUTODJ._internals.rehydrate();
    assert.deepEqual(titles(S.recentSkips()), titles(ring));
    assert.equal(S.noteSkip(null), false);
    S.recentSkips()[0].title = 'mutated';
    assert.equal(S.recentSkips()[0].title, 's5', 'copies');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 21. federation helpers
// ─────────────────────────────────────────────────────────────────────

describe('federation helpers (Less like on the fan-out)', () => {
  const ans = (peerId, path, similarity, avoided) => ({ peerId, song: { filepath: path, metadata: {} }, similarity, blocked: false, avoided });

  test('chooseFederatedPicks ranks an avoided song after every clean one', () => {
    const picks = AUTODJ.chooseFederatedPicks([
      ans(null, 'music/like-a-skip.mp3', 0.99, true),
      ans(7, 'music/clean-peer.mp3', 0.6, false),
      ans(null, 'music/clean-local.mp3', 0.7),
    ], new Set(), 3);
    assert.deepEqual(picks.map((p) => p.song.filepath), ['music/clean-local.mp3', 'music/clean-peer.mp3', 'music/like-a-skip.mp3']);
    assert.equal(AUTODJ.chooseFederatedPick([ans(null, 'music/a.mp3', 0.9, true)], new Set()).song.filepath, 'music/a.mp3',
      'a flagged song still plays when nothing clean is left');
  });

  test('federatedRecentKeys adds the avoid keys, and skips a null one', () => {
    const keys = AUTODJ.federatedRecentKeys([{ path: 'music/a.mp3', peerId: null }], null, [S.keyOf(null, 'music/blend.mp3'), null, '']);
    assert.deepEqual([...keys].sort(), ['local|music/a.mp3', 'local|music/blend.mp3']);
    assert.deepEqual([...AUTODJ.federatedRecentKeys([], null, [null])], []);
    assert.deepEqual([...AUTODJ.federatedRecentKeys([], null)], []);
  });
});
