/**
 * The flow orderer (src/db/flow-order.js) — the pure half of
 * POST /api/v1/db/flow. Covers the feature helpers (key parsing and costs,
 * tempo, energy, the PRNG, the median), the cost matrix (weights, fills,
 * penalties, absent terms), the solver against brute force, the layout and
 * permutation contract, determinism, `after`, arcs, the three solver
 * outcomes, and the stats / why-code reporting.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../src/db/flow-order.js';
import { CAMELOT_TO_KEYS } from '../../src/db/camelot.js';
import { NEAR_DUP } from '../../src/db/discovery-novelty.js';

const CODES = Object.keys(CAMELOT_TO_KEYS);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertClose = (a, b, eps = 1e-6, msg = '') => assert.ok(close(a, b, eps), `${msg} expected ${b}, got ${a}`);

const unit = (...xs) => {
  const v = Float32Array.from(xs);
  let s = 0;
  for (const x of v) { s += x * x; }
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
};
function randUnit(rng, dim) {
  const v = new Float32Array(dim);
  let s = 0;
  for (let k = 0; k < dim; k++) { v[k] = rng() - 0.5; s += v[k] * v[k]; }
  s = Math.sqrt(s) || 1;
  for (let k = 0; k < dim; k++) { v[k] /= s; }
  return v;
}
const node = (o) => ({
  vec: null, bpm: null, key: null, energy: null, artistId: null, albumId: null, hash: null, recKey: null, ...o,
});
const isPerm = (order, n) => order.length === n && new Set(order).size === n
  && order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
const D = (m, a, b) => m.D[a * m.N + b];

// Cost of a movable order between optional pins.
function runCost(model, path, first, last) {
  let c = 0;
  let prev = first;
  for (const id of path) {
    if (prev >= 0) { c += D(model, prev, id); }
    prev = id;
  }
  if (last >= 0 && path.length) { c += D(model, path[path.length - 1], last); }
  return c;
}

// Exact optimum by depth-first search with a cost bound.
function bruteBest(model, movable, first, last) {
  const m = movable.length;
  const used = new Uint8Array(m);
  let best = Infinity;
  const dfs = (prev, depth, cost) => {
    if (cost >= best) { return; }
    if (depth === m) {
      const total = cost + (last >= 0 ? D(model, prev, last) : 0);
      if (total < best) { best = total; }
      return;
    }
    for (let x = 0; x < m; x++) {
      if (used[x]) { continue; }
      used[x] = 1;
      dfs(movable[x], depth + 1, cost + (prev >= 0 ? D(model, prev, movable[x]) : 0));
      used[x] = 0;
    }
  };
  dfs(first, 0, 0);
  return best;
}

// A random item for solveFlow (rankKey unique per item).
function randItem(rng, i, { dim = 4, placed = false } = {}) {
  const it = {
    rankKey: `k${String(i).padStart(4, '0')}`,
    vec: placed || rng() < 0.8 ? randUnit(rng, dim) : null,
    bpm: rng() < 0.8 ? 60 + rng() * 120 : null,
    key: rng() < 0.7 ? CODES[Math.floor(rng() * 24)] : null,
    energy: rng() < 0.6 ? rng() : null,
    artistId: Math.floor(rng() * 4),
    albumId: Math.floor(rng() * 8),
    hash: `h${i}`,
    recKey: null,
  };
  return it;
}
const unanalysedItem = (i) => ({
  rankKey: `u${i}`, vec: null, bpm: null, key: null, energy: 0.5, artistId: 1, albumId: null, hash: `u${i}`, recKey: null,
});
const isPlaced = (it) => it != null && (it.vec != null || it.bpm != null || F.parseKey(it.key) != null);
// The neighbouring pairs of `order` that are both placed: what transitions
// and stats.after must describe, no more and no less.
function placedPairs(items, order) {
  const out = [];
  for (let k = 1; k < order.length; k++) {
    if (isPlaced(items[order[k - 1]]) && isPlaced(items[order[k]])) { out.push([order[k - 1], order[k]]); }
  }
  return out;
}
const lastPlacedOf = (items, order) => [...order].reverse().find((i) => isPlaced(items[i])) ?? null;

// ── keys ────────────────────────────────────────────────────────────────────

describe('parseKey', () => {
  test('the spellings tags carry', () => {
    for (const s of ['8A', '8a', ' A minor ', 'Am', 'A min', 'a  MINOR']) { assert.equal(F.parseKey(s), '8A', s); }
    assert.equal(F.parseKey('Bb minor'), '3A');
    assert.equal(F.parseKey('B♭ minor'), '3A');
    assert.equal(F.parseKey('G#m'), '1A');
    assert.equal(F.parseKey('Abm'), '1A');
    assert.equal(F.parseKey('F♯m'), '11A');
    assert.equal(F.parseKey('C major'), '8B');
    assert.equal(F.parseKey('C'), '8B');
    for (const s of ['junk', '', '   ', null, undefined, '1m', '12d']) { assert.equal(F.parseKey(s), null, String(s)); }
  });

  test('every spelling in the Camelot table parses to its own code', () => {
    for (const [code, names] of Object.entries(CAMELOT_TO_KEYS)) {
      for (const name of names) { assert.equal(F.parseKey(name), code, name); }
    }
  });
});

describe('keyCost', () => {
  test('the wheel table', () => {
    assert.equal(F.keyCost('8A', '8A'), 0);
    for (const [a, b] of [['8A', '9A'], ['8A', '7A'], ['12A', '1A'], ['8A', '8B']]) { assertClose(F.keyCost(a, b), 0.10, 1e-12, `${a}/${b}`); }
    for (const [a, b] of [['8A', '9B'], ['8A', '7B']]) { assertClose(F.keyCost(a, b), 0.35, 1e-12, `${a}/${b}`); }
    assertClose(F.keyCost('8A', '10A'), 0.5, 1e-12);
    assertClose(F.keyCost('8A', '3A'), 0.6, 1e-12);
    assertClose(F.keyCost('8A', '1A'), 0.6, 1e-12);
    assertClose(F.keyCost('8A', '11A'), 0.8, 1e-12);
    assertClose(F.keyCost('8A', '12A'), 0.9, 1e-12);
    assertClose(F.keyCost('8A', '2A'), 1.0, 1e-12);
  });

  test('symmetric over all 24×24 pairs', () => {
    for (const a of CODES) {
      for (const b of CODES) { assert.equal(F.keyCost(a, b), F.keyCost(b, a), `${a}/${b}`); }
    }
  });
});

// ── tempo / energy / utilities ──────────────────────────────────────────────

describe('tempoCost', () => {
  test('same tempo, half/double, ±6% and ±12%', () => {
    assert.deepEqual(F.tempoCost(120, 120), { cost: 0, octave: false });
    for (const [a, b] of [[70, 140], [140, 70]]) {
      const t = F.tempoCost(a, b);
      assert.equal(t.octave, true);
      assertClose(t.cost, 0.03, 1e-9);
    }
    assertClose(F.tempoCost(120, 127).cost, 0.5, 0.01);
    assert.equal(F.tempoCost(120, 135).cost, 1);
  });

  test('halfDouble off and a wider tolerance', () => {
    assert.equal(F.tempoCost(70, 140, { halfDouble: false }).cost, 1);
    const narrow = F.tempoCost(120, 127).cost;
    const wide = F.tempoCost(120, 127, { tolerance: 0.12 }).cost;
    assert.ok(wide / narrow > 0.45 && wide / narrow < 0.56, `ratio ${wide / narrow}`);
  });

  test('symmetric', () => {
    const rng = F.mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const a = 40 + rng() * 200;
      const b = 40 + rng() * 200;
      assert.deepEqual(F.tempoCost(a, b), F.tempoCost(b, a));
    }
  });
});

describe('energyOf', () => {
  test('mean with relaxed inverted; partial; none', () => {
    assertClose(F.energyOf({ aggressive: 0.7, party: 0.9, danceable: 0.9, relaxed: 0.2 }), 0.825, 1e-12);
    assertClose(F.energyOf({ aggressive: 0.4, party: null, danceable: undefined, relaxed: 0.6 }), 0.4, 1e-12);
    assert.equal(F.energyOf({ aggressive: null, party: null, danceable: null, relaxed: null }), null);
    assert.equal(F.energyOf({}), null);
    assert.equal(F.energyOf(null), null);
  });
});

describe('mulberry32 and medianOf', () => {
  test('mulberry32 is reproducible and in [0, 1)', () => {
    const a = F.mulberry32(42);
    const b = F.mulberry32(42);
    const c = F.mulberry32(43);
    let differs = false;
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
      if (x !== c()) { differs = true; }
    }
    assert.ok(differs);
  });

  test('medianOf = the sort-based lower median, never mutating', () => {
    const rng = F.mulberry32(11);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rng() * 300);
      const vals = Array.from({ length: n }, () => (rng() < 0.3 ? Math.floor(rng() * 5) : rng()));
      const copy = vals.slice();
      const sorted = vals.slice().sort((x, y) => x - y);
      assert.equal(F.medianOf(vals), sorted[(n - 1) >> 1]);
      assert.deepEqual(vals, copy);
      const typed = Float64Array.from(vals);
      const k = 1 + Math.floor(rng() * n);
      const head = Array.from(typed.subarray(0, k)).sort((x, y) => x - y);
      assert.equal(F.medianOf(typed, k), head[(k - 1) >> 1]);
      assert.deepEqual(Array.from(typed), copy);
    }
    assert.equal(F.medianOf([]), null);
    assert.equal(F.medianOf(new Float64Array(5), 0), null);
  });
});

// ── the cost matrix ─────────────────────────────────────────────────────────

describe('buildCostMatrix', () => {
  const base = () => [
    node({ vec: unit(1, 0, 0, 0), bpm: 120, key: '8A', energy: 0.2, artistId: 1, albumId: 10, hash: 'a' }),
    node({ vec: unit(0.8, 0.6, 0, 0), bpm: 120, key: '8A', energy: 0.5, artistId: 2, albumId: 20, hash: 'b' }),
    node({ vec: unit(0, 1, 0, 0), bpm: 126, key: '9B', energy: 0.9, artistId: 3, albumId: 30, hash: 'c' }),
  ];
  const t = F.tempoCost(120, 126).cost;

  test('symmetric, and the weighted sum of the four terms', async () => {
    const m = await F.buildCostMatrix(base(), { weights: F.WEIGHT_PRESETS.smooth });
    assert.deepEqual(m.signals, { sound: true, tempo: true, key: true, energy: true });
    assertClose(m.median, 0.4, 1e-6);
    // scaled sound: raw / (2 · 0.4), capped at 1
    assertClose(D(m, 0, 1), 0.55 * 0.25 + 0.10 * 0.3, 1e-5);
    assertClose(D(m, 0, 2), 0.55 * 1 + 0.20 * t + 0.15 * 0.35 + 0.10 * 0.7, 1e-5);
    assertClose(D(m, 1, 2), 0.55 * 0.5 + 0.20 * t + 0.15 * 0.35 + 0.10 * 0.4, 1e-5);
    for (let a = 0; a < 3; a++) {
      assert.equal(D(m, a, a), 0);
      for (let b = 0; b < 3; b++) { assert.equal(D(m, a, b), D(m, b, a)); }
    }
  });

  test('fills: the mean of the present pairs, sound shrunk for the same album / artist', async () => {
    const fillSound = (0.25 + 1 + 0.5) / 3;
    const sameAlbum = [...base(), node({ bpm: 120, key: '8A', energy: 0.2, artistId: 1, albumId: 10, hash: 'd' })];
    const m = await F.buildCostMatrix(sameAlbum, { weights: F.WEIGHT_PRESETS.smooth });
    assertClose(m.fill.sound, fillSound, 1e-6);
    assertClose(m.fill.tempo, t / 2, 1e-9);
    assertClose(D(m, 0, 3), 0.55 * fillSound * 0.6 + F.ARTIST_PENALTY, 1e-5);
    assertClose(D(m, 1, 3), 0.55 * fillSound + 0.10 * 0.3, 1e-5);

    const sameArtist = [...base(), node({ bpm: 120, key: '8A', energy: 0.2, artistId: 1, albumId: 99, hash: 'd' })];
    const m2 = await F.buildCostMatrix(sameArtist, { weights: F.WEIGHT_PRESETS.smooth });
    assertClose(D(m2, 0, 3), 0.55 * fillSound * 0.8 + F.ARTIST_PENALTY, 1e-5);

    const m3 = await F.buildCostMatrix(sameAlbum, { weights: F.WEIGHT_PRESETS.smooth, artistGap: false });
    assertClose(D(m3, 0, 3), 0.55 * fillSound * 0.6, 1e-5);
  });

  test('same-recording penalty by hash, by near-duplicate vectors and by recKey', async () => {
    const w = { weights: F.WEIGHT_PRESETS.smooth };
    const pair = (a, b) => [...base(), node({ bpm: 90, key: '1B', ...a }), node({ bpm: 90, key: '1B', ...b })];

    const byHash = await F.buildCostMatrix(pair({ hash: 'x' }, { hash: 'x' }), w);
    const noHash = await F.buildCostMatrix(pair({ hash: 'x' }, { hash: 'y' }), w);
    assertClose(D(byHash, 3, 4) - D(noHash, 3, 4), F.SAME_RECORDING_PENALTY, 1e-6);

    const v = unit(0.1, 0.2, 0.9, 0.1);
    const v2 = unit(0.1, 0.2, 0.9, 0.2);   // cos ≈ 0.995
    const nd = pair({ vec: v, hash: 'x' }, { vec: v2, hash: 'y' });
    const near = await F.buildCostMatrix(nd, { ...w, nearDup: 0.99 });
    const far = await F.buildCostMatrix(nd, { ...w, nearDup: 0.999 });
    assertClose(D(near, 3, 4) - D(far, 3, 4), F.SAME_RECORDING_PENALTY, 1e-6);

    const byKey = await F.buildCostMatrix(pair({ hash: 'x', recKey: 'a|t' }, { hash: 'y', recKey: 'a|t' }), w);
    const noKey = await F.buildCostMatrix(pair({ hash: 'x', recKey: 'a|t' }, { hash: 'y', recKey: 'b|t' }), w);
    assertClose(D(byKey, 3, 4) - D(noKey, 3, 4), F.SAME_RECORDING_PENALTY, 1e-6);
  });

  test('an absent term hands its weight to the others and reports false', async () => {
    const nodes = base().map((n) => ({ ...n, energy: null }));
    const m = await F.buildCostMatrix(nodes, { weights: F.WEIGHT_PRESETS.smooth });
    assert.deepEqual(m.signals, { sound: true, tempo: true, key: true, energy: false });
    assertClose(D(m, 0, 1), (0.55 * 0.25) / 0.9, 1e-5);
    assertClose(D(m, 0, 2), (0.55 + 0.20 * t + 0.15 * 0.35) / 0.9, 1e-5);
    const one = base().map((n, i) => ({ ...n, energy: i === 0 ? 0.5 : null }));
    assert.equal(F.signalPresence(one, F.WEIGHT_PRESETS.smooth).energy, false, 'one node is not a signal');
    assert.equal(F.signalPresence(base(), { ...F.WEIGHT_PRESETS.smooth, key: 0 }).key, false, 'weight 0 is unused');
  });

  test('the same-recording cosine is discovery-novelty.js NEAR_DUP', () => {
    assert.equal(F.SAME_RECORDING_COS, NEAR_DUP);
  });

  test('no ordinary pair costs more than COST_CEILING; the same recording pays twice that on top', async () => {
    assert.ok(F.SAME_RECORDING_PENALTY >= 2 * F.COST_CEILING);
    const rng = F.mulberry32(17);
    for (const weights of [F.WEIGHT_PRESETS.smooth, F.WEIGHT_PRESETS.dj, { sound: 0, tempo: 1, key: 0, energy: 0 }]) {
      const nodes = [];
      for (let i = 0; i < 40; i++) {
        const it = randItem(rng, i);
        nodes.push(node({ ...it, key: F.parseKey(it.key) }));
      }
      for (const k of [3, 7, 11]) { nodes.push({ ...nodes[k] }); }   // copies
      const m = await F.buildCostMatrix(nodes, { weights });
      let same = 0;
      for (let a = 0; a < m.N; a++) {
        for (let b = a + 1; b < m.N; b++) {
          assert.equal(D(m, a, b), D(m, b, a));
          if (F.pairTerms(m, a, b).sameRecording) {
            same++;
            assert.ok(D(m, a, b) >= F.SAME_RECORDING_PENALTY - 1e-6, `${a}/${b}: ${D(m, a, b)}`);
          } else {
            assert.ok(D(m, a, b) <= F.COST_CEILING + 1e-6, `${a}/${b}: ${D(m, a, b)}`);
          }
        }
      }
      assert.ok(same >= 3, `copies found: ${same}`);
    }
  });
});

// ── the solver ──────────────────────────────────────────────────────────────

describe('solveRun against brute force (n ≤ 9)', () => {
  const MODES = ['start', 'free', 'start+end', 'end'];
  const instances = [];
  const rng = F.mulberry32(42);
  for (let t = 0; t < 300; t++) {
    const n = 5 + (t % 5);
    const nodes = [];
    for (let i = 0; i < n; i++) {
      nodes.push(node({
        vec: randUnit(rng, 4),
        bpm: rng() < 0.1 ? null : 60 + rng() * 120,
        key: rng() < 0.15 ? null : CODES[Math.floor(rng() * 24)],
        energy: rng(),
        artistId: Math.floor(rng() * 3),
        albumId: Math.floor(rng() * 6),
        hash: `h${i}`,
      }));
    }
    const mode = MODES[t % 4];
    const first = mode === 'start' || mode === 'start+end' ? 0 : -1;
    const last = mode === 'end' || mode === 'start+end' ? n - 1 : -1;
    const movable = [];
    for (let i = 0; i < n; i++) { if (i !== first && i !== last) { movable.push(i); } }
    instances.push({ nodes, first, last, movable: Int32Array.from(movable) });
  }

  test('exact for small runs (the default) matches brute force', async () => {
    for (const ins of instances) {
      const model = await F.buildCostMatrix(ins.nodes, { weights: F.WEIGHT_PRESETS.smooth });
      const { path, status } = await F.solveRun(model, ins.movable, { first: ins.first, last: ins.last });
      assert.equal(status, 'complete');
      assert.deepEqual([...path].sort((a, b) => a - b), [...ins.movable]);
      assertClose(runCost(model, path, ins.first, ins.last), bruteBest(model, ins.movable, ins.first, ins.last), 1e-6);
    }
  });

  test('the heuristic alone stays close: mean gap ≤ 1%, ≥ 90% within 2%', async () => {
    let sum = 0;
    let within = 0;
    for (const ins of instances) {
      const model = await F.buildCostMatrix(ins.nodes, { weights: F.WEIGHT_PRESETS.smooth });
      const clock = F.createClock({ deadlineMs: 1e9 });
      const { path } = await F.solveRun(model, ins.movable, { first: ins.first, last: ins.last, exactMax: 0, clock });
      const opt = bruteBest(model, ins.movable, ins.first, ins.last);
      const h = runCost(model, path, ins.first, ins.last);
      assert.ok(h >= opt - 1e-9);
      const gap = (h - opt) / Math.max(opt, 1e-9);
      sum += gap;
      if (gap <= 0.02) { within++; }
    }
    const mean = sum / instances.length;
    assert.ok(mean <= 0.01, `mean gap ${mean}`);
    assert.ok(within / instances.length >= 0.9, `within 2%: ${within}/${instances.length}`);
  });
});

describe('solveFlow: the layout contract', () => {
  test('always a permutation; pins first/last; class arrays exact and disjoint', async () => {
    const rng = F.mulberry32(8);
    for (let t = 0; t < 200; t++) {
      const n = 2 + Math.floor(rng() * 39);
      const items = [];
      for (let i = 0; i < n; i++) {
        const r = rng();
        if (r < 0.1) { items.push(null); } else if (r < 0.2) { items.push(unanalysedItem(i)); } else if (r < 0.3 && i > 0) {
          items.push(items[Math.floor(rng() * i)]);   // a duplicate
        } else { items.push(randItem(rng, i)); }
      }
      const start = rng() < 0.5 ? Math.floor(rng() * n) : null;
      let end = rng() < 0.5 ? Math.floor(rng() * n) : null;
      if (end === start) { end = null; }
      const after = start == null && rng() < 0.4
        ? { vec: rng() < 0.5 ? randUnit(rng, 4) : null, bpm: 60 + rng() * 120, key: CODES[Math.floor(rng() * 24)] }
        : null;
      const r = await F.solveFlow(items, { start, end, after, arc: ['steady', 'up', 'down', 'wave'][t % 4], explain: true });

      assert.ok(isPerm(r.order, n), `t=${t}: ${r.order}`);
      if (start != null) { assert.equal(r.order[0], start); }
      if (end != null) { assert.equal(r.order[n - 1], end); }
      const expUnplaced = [];
      const expUnanalysed = [];
      items.forEach((it, i) => {
        if (it == null) { expUnplaced.push(i); } else if (!isPlaced(it)) { expUnanalysed.push(i); }
      });
      assert.deepEqual(r.unplaced, expUnplaced);
      assert.deepEqual(r.unanalysed, expUnanalysed);
      assert.equal(new Set([...r.unplaced, ...r.unanalysed]).size, r.unplaced.length + r.unanalysed.length);
      assert.ok(['complete', 'budget', 'deadline'].includes(r.solver));
      assert.ok(Array.isArray(r.transitions));

      const pins = new Set([start, end].filter((x) => x != null));
      const body = r.order.filter((i) => !pins.has(i));
      assert.equal(r.endIndex, lastPlacedOf(items, r.order), `t=${t}: endIndex`);
      if (Object.values(r.signals).some(Boolean)) {
        const tail = [...expUnanalysed, ...expUnplaced].filter((i) => !pins.has(i));
        assert.deepEqual(body.slice(body.length - tail.length), tail, `t=${t}: tail`);
        const pairs = placedPairs(items, r.order);
        assert.deepEqual(r.transitions.map((x) => [x.from, x.to]), pairs, `t=${t}: transitions`);
        assert.equal(r.stats.after.transitions, pairs.length, `t=${t}: stats.after`);
      } else {
        assert.deepEqual(body, [...Array(n).keys()].filter((i) => !pins.has(i)), `t=${t}: identity`);
      }
    }
  });

  test('missing data: unanalysed after the run, unplaced at the tail, pins regardless of class', async () => {
    const rng = F.mulberry32(5);
    const A = randItem(rng, 0, { placed: true });
    const B = randItem(rng, 1, { placed: true });
    const C = randItem(rng, 2, { placed: true });
    const items = [A, unanalysedItem(1), null, B, unanalysedItem(4), C, null];
    const r = await F.solveFlow(items);
    assert.deepEqual(r.order.slice(3), [1, 4, 2, 6]);
    assert.deepEqual([...r.order.slice(0, 3)].sort(), [0, 3, 5]);
    assert.deepEqual(r.unplaced, [2, 6]);
    assert.deepEqual(r.unanalysed, [1, 4]);

    const s = await F.solveFlow(items, { start: 2, end: 4 });
    assert.equal(s.order[0], 2, 'an unplaced start is still first');
    assert.equal(s.order[6], 4, 'an unanalysed end is still last');
    assert.deepEqual(s.unplaced, [2, 6]);
    assert.deepEqual(s.unanalysed, [1, 4]);
    assert.deepEqual(s.order.slice(4, 6), [1, 6]);
  });

  test('a pinned end behind a tail: no phantom run→end transition, in transitions or stats', async () => {
    const rng = F.mulberry32(11);
    const [A, B, C, D] = [0, 1, 2, 5].map((i) => randItem(rng, i, { placed: true }));
    const items = [A, B, C, unanalysedItem(3), null, D];
    const r = await F.solveFlow(items, { end: 0, explain: true });
    assert.deepEqual(r.order.slice(3), [3, 4, 0]);
    const pairs = placedPairs(items, r.order);
    assert.equal(pairs.length, 2);
    assert.deepEqual(r.transitions.map((x) => [x.from, x.to]), pairs);
    assert.ok(r.transitions.every((x) => x.to !== 0), 'nothing plays into end');
    assert.equal(r.stats.after.transitions, 2);
    assert.equal(r.stats.before.transitions, 2, 'before and after over the same songs');
    assert.equal(r.endIndex, 0, 'end is still the last placed song');

    // No tail: end joins the run, and its edge is reported.
    const joined = await F.solveFlow([A, B, C, D], { end: 0, explain: true });
    assert.equal(joined.transitions.length, 3);
    assert.equal(joined.transitions[2].to, 0);
    assert.equal(joined.stats.after.transitions, 3);
  });

  test('nothing to order by: input order, pins honoured, every signal false', async () => {
    const rng = F.mulberry32(6);
    const items = [randItem(rng, 0, { placed: true }), unanalysedItem(1), null];
    for (const [opts, want] of [[{}, [0, 1, 2]], [{ start: 2 }, [2, 0, 1]], [{ end: 0 }, [1, 2, 0]]]) {
      const r = await F.solveFlow(items, { ...opts, explain: true });
      assert.deepEqual(r.order, want);
      assert.deepEqual(r.signals, { sound: false, tempo: false, key: false, energy: false });
      assert.equal(r.stats, null);
      assert.equal(r.solver, 'complete');
      assert.equal(r.arc, 'steady');
      assert.deepEqual(r.transitions, []);
      assert.equal(r.endIndex, 0);
    }

    // Weights that use only a term no song has.
    const bpmOnly = [0, 1, 2, 3].map((i) => ({ rankKey: `b${i}`, bpm: 100 + i * 10 }));
    const r = await F.solveFlow(bpmOnly, { weights: { sound: 1, tempo: 0, key: 0, energy: 0 } });
    assert.deepEqual(r.order, [0, 1, 2, 3]);
    assert.deepEqual(r.signals, { sound: false, tempo: false, key: false, energy: false });
    assert.equal(r.stats, null);
  });

  test('after: the run flows out of the song before the list, which never appears in it', async () => {
    const ladder = { X: [128, '8A'], Y: [132, '9A'], Z: [136, '10A'], W: [140, '11A'] };
    const names = ['W', 'Y', 'X', 'Z'];
    const items = names.map((nm) => ({ rankKey: nm, bpm: ladder[nm][0], key: ladder[nm][1] }));
    const r = await F.solveFlow(items, { after: { bpm: 128, key: '8A' } });
    assert.ok(isPerm(r.order, 4));
    assert.deepEqual(r.order.map((i) => names[i]), ['X', 'Y', 'Z', 'W']);
    assert.equal(r.endIndex, 0);
  });

  test('after: a vector alone steers the run', async () => {
    // Five songs on an arc, sound only: end to end costs the same either way
    // round, so without `after` the direction is a tie-break. A vector past
    // one end must start the run there — the two answers below are reverses
    // of each other, so a dropped vector (one answer for both) fails one.
    const at = (deg) => unit(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0);
    const angles = [40, 0, 80, 20, 60];
    const items = angles.map((a) => ({ rankKey: `p${a}`, vec: at(a) }));
    for (const [from, want] of [[-25, [0, 20, 40, 60, 80]], [105, [80, 60, 40, 20, 0]]]) {
      for (const exactMax of [F.EXACT_MAX, 0]) {
        const r = await F.solveFlow(items, { after: { vec: at(from) }, exactMax, deadlineMs: 60_000 });
        assert.deepEqual(r.order.map((i) => angles[i]), want, `after at ${from}°, exactMax ${exactMax}`);
      }
    }
  });
});

describe('solveFlow: copies of one recording', () => {
  // Adjacent pairs of `order` that are the same recording, by `same`.
  const adjacentCopies = (items, order, same = (a, b) => a === b) => {
    let c = 0;
    for (let k = 1; k < order.length; k++) { if (same(items[order[k - 1]], items[order[k]])) { c++; } }
    return c;
  };
  const seqOf = (items, order, a) => order.map((i) => (items[i] === a ? 'A' : 'B')).join('');

  test('one copy among many is never next to its original (same file, a near-identical vector, the same artist + title)', async () => {
    const rng = F.mulberry32(31);
    const base = Array.from({ length: 112 }, (_, i) => randItem(rng, i, { dim: 16, placed: true }));
    const KINDS = ['file', 'nearVector', 'nameKey'];
    for (let t = 0; t < 18; t++) {
      const d = (t * 7) % 112;
      const kind = KINDS[t % 3];
      const orig = { ...base[d], recKey: kind === 'nameKey' ? 'artist|title' : null };
      let copy = orig;
      if (kind === 'nearVector') {
        const v = Float32Array.from(orig.vec);
        v[0] += 0.05;   // cos ≈ 0.999 with the original
        copy = { ...orig, rankKey: 'copy', vec: unit(...v), hash: 'copy' };
      } else if (kind === 'nameKey') {
        // A different file of the same song: only the artist + title match.
        copy = { ...randItem(rng, 900 + t, { dim: 16, placed: true }), rankKey: 'copy', hash: 'copy', recKey: 'artist|title' };
      }
      const items = base.slice();
      items[d] = orig;
      items.splice((d * 31) % 112, 0, copy);
      const r = await F.solveFlow(items, { deadlineMs: 60_000 });
      assert.ok(isPerm(r.order, 113));
      const pos = [];
      r.order.forEach((i, k) => { if (items[i] === orig || items[i] === copy) { pos.push(k); } });
      assert.equal(pos.length, 2);
      assert.ok(pos[1] - pos[0] > 1, `t=${t} (${kind}): the copies sit at ${pos}`);
    }
  });

  test('a list of nothing but two songs alternates; copies touch only as often as the counts force', async () => {
    const rng = F.mulberry32(32);
    const A = randItem(rng, 0, { dim: 16, placed: true });
    const B = { ...randItem(rng, 1, { dim: 16, placed: true }), artistId: A.artistId };
    // ≤ EXACT_MAX songs are solved exactly; the larger ones by the heuristic.
    for (const [na, nb] of [[3, 3], [4, 3], [5, 2], [10, 10], [11, 10], [15, 8]]) {
      const items = [...Array(na).fill(A), ...Array(nb).fill(B)];
      const r = await F.solveFlow(items, { deadlineMs: 60_000 });
      assert.ok(isPerm(r.order, na + nb));
      assert.equal(adjacentCopies(items, r.order), Math.max(0, na - nb - 1), `${na}+${nb}: ${seqOf(items, r.order, A)}`);
    }
  });

  test('1000 entries drawn from 112 songs: no copy next to another', async () => {
    const rng = F.mulberry32(33);
    const base = Array.from({ length: 112 }, (_, i) => randItem(rng, i, { dim: 16, placed: true }));
    const items = Array.from({ length: 1000 }, (_, i) => base[(i * 37) % 112]);
    const r = await F.solveFlow(items, { deadlineMs: 60_000 });
    assert.ok(['complete', 'budget'].includes(r.solver), r.solver);
    assert.ok(isPerm(r.order, 1000));
    assert.equal(adjacentCopies(items, r.order), 0);
  });
});

describe('solveFlow: copies under an energy arc', () => {
  // Recordings are colours; `pre` / `post` are the colour fixed before /
  // after the run (−1 another song, null none).
  // Fewest touching pairs over every order of the run, by search.
  function bruteTouching(counts, pre, post) {
    const left = counts.slice();
    let m = left.reduce((a, b) => a + b, 0);
    let best = Infinity;
    const walk = (last, touching) => {
      if (touching >= best) { return; }
      if (m === 0) {
        best = Math.min(best, touching + (post != null && post === last ? 1 : 0));
        return;
      }
      for (let c = 0; c < left.length; c++) {
        if (!left[c]) { continue; }
        left[c]--; m--;
        walk(c, touching + (c === last ? 1 : 0));
        left[c]++; m++;
      }
    };
    walk(pre ?? -2, 0);
    return best;
  }
  // The same by the bound: the largest 2K − L − 1 + f over the colours.
  function leastTouching(counts, pre, post) {
    const m = counts.reduce((a, b) => a + b, 0);
    const L = m + (pre != null ? 1 : 0) + (post != null ? 1 : 0);
    let worst = 0;
    counts.forEach((c, colour) => {
      const K = c + (pre === colour ? 1 : 0) + (post === colour ? 1 : 0);
      const f = (pre != null && pre !== colour ? 1 : 0) + (post != null && post !== colour ? 1 : 0);
      if (K) { worst = Math.max(worst, 2 * K - L - 1 + f); }
    });
    return worst;
  }
  const spearman = (xs) => {
    const n = xs.length;
    const ranks = new Array(n);
    xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).forEach(([, i], r) => { ranks[i] = r; });
    let d2 = 0;
    for (let i = 0; i < n; i++) { d2 += (ranks[i] - i) ** 2; }
    return 1 - (6 * d2) / (n * (n * n - 1));
  };

  test('the bound (and copiesForced) is the fewest touching pairs, checked by search', () => {
    const ends = [null, -1, 0, 1];
    for (let a = 0; a <= 5; a++) {
      for (let b = 0; b <= 4; b++) {
        for (let c = 0; c <= 3; c++) {
          const counts = [a, b, c];
          const m = a + b + c;
          if (m === 0 || m > 8) { continue; }
          for (const pre of ends) {
            for (const post of ends) {
              const want = bruteTouching(counts, pre, post);
              assert.equal(leastTouching(counts, pre, post), want, `${counts} pre ${pre} post ${post}`);
              const side = (end, colour) => (end == null ? null : end === colour);
              const viaModule = Math.max(...counts.map((k, colour) => F.copiesForced(k, m, side(pre, colour), side(post, colour))));
              assert.equal(viaModule, want, `copiesForced: ${counts} pre ${pre} post ${post}`);
            }
          }
        }
      }
    }
  });

  test('fuzz: under up, down and wave, copies touch exactly as often as the counts and pins force — no more than a steady order', async () => {
    const rng = F.mulberry32(41);
    const pick = (n) => Math.floor(rng() * n);
    let forcedLists = 0;
    let apartLists = 0;
    for (let t = 0; t < 240; t++) {
      const arc = ['up', 'down', 'wave'][t % 3];
      const n = 4 + pick(37);
      const k = 1 + pick(Math.ceil(n * 0.6));
      // Skewed draws: some lists are mostly one recording.
      const weight = Array.from({ length: k }, () => rng() ** 3 + 0.02);
      const sum = weight.reduce((x, y) => x + y, 0);
      const recs = Array.from({ length: k }, (_, c) => ({ ...randItem(rng, c, { dim: 16, placed: true }), energy: rng() }));
      const colour = [];
      const items = [];
      for (let i = 0; i < n; i++) {
        let r = rng() * sum;
        let c = 0;
        while (r >= weight[c] && c < k - 1) { r -= weight[c]; c++; }
        colour.push(c);
        items.push({ ...recs[c], rankKey: `c${c}-${i}` });   // the same file: same hash, same analysis
      }
      const opts = { arc, now: () => 0 };                     // a clock that never runs out
      if (rng() < 0.35) { opts.start = pick(n); }
      if (rng() < 0.35) { const e = pick(n); if (e !== opts.start) { opts.end = e; } }
      let afterColour = null;
      if (opts.start == null && rng() < 0.25) {
        afterColour = rng() < 0.6 ? colour[pick(n)] : -1;
        opts.after = { vec: afterColour >= 0 ? recs[afterColour].vec : randUnit(rng, 16), bpm: 100, key: '8A' };
      }
      if (rng() < 0.3) { opts.seed = pick(2 ** 31); }
      if (rng() < 0.3) { opts.exactMax = 0; }

      const pins = new Set([opts.start, opts.end].filter((x) => x != null));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < n; i++) { if (!pins.has(i)) { counts[colour[i]]++; } }
      const pre = opts.start != null ? colour[opts.start] : afterColour;
      const post = opts.end != null ? colour[opts.end] : null;
      const least = leastTouching(counts, pre, post);
      if (least > 0) { forcedLists++; } else if (counts.some((c) => c > 1)) { apartLists++; }
      const touching = (order) => {
        let c = afterColour != null && afterColour === colour[order[0]] ? 1 : 0;
        for (let q = 1; q < n; q++) { if (colour[order[q]] === colour[order[q - 1]]) { c++; } }
        return c;
      };
      const label = `t=${t} ${arc} n=${n} k=${k} start=${opts.start} end=${opts.end} after=${afterColour} seed=${opts.seed}`;

      const r = await F.solveFlow(items, opts);
      assert.equal(r.arc, arc, label);
      assert.ok(isPerm(r.order, n), label);
      if (opts.start != null) { assert.equal(r.order[0], opts.start, label); }
      if (opts.end != null) { assert.equal(r.order[n - 1], opts.end, label); }
      assert.equal(touching(r.order), least, `${label}: ${r.order.map((i) => colour[i]).join('.')}`);
      const steady = await F.solveFlow(items, { ...opts, arc: 'steady' });
      assert.equal(touching(steady.order), least, `${label} (steady)`);
    }
    // Both kinds of list came up: copies that must touch, copies kept apart.
    assert.ok(forcedLists >= 40 && apartLists >= 40, `forced ${forcedLists}, apart ${apartLists}`);
  });

  test('11 songs and a copy of one: never side by side under up, down or wave, and the arc keeps its shape', async () => {
    const rng = F.mulberry32(42);
    for (const arc of ['up', 'down', 'wave']) {
      let rho = 0;
      for (let t = 0; t < 30; t++) {
        const base = Array.from({ length: 11 }, (_, i) => ({ ...randItem(rng, i, { dim: 16, placed: true }), energy: rng() }));
        const orig = base[Math.floor(rng() * 11)];
        const copy = { ...orig, rankKey: 'copy' };
        const items = base.slice();
        items.splice(Math.floor(rng() * 12), 0, copy);
        const r = await F.solveFlow(items, { arc });
        assert.equal(r.arc, arc);
        const pos = [];
        r.order.forEach((i, q) => { if (items[i] === orig || items[i] === copy) { pos.push(q); } });
        assert.ok(pos[1] - pos[0] > 1, `${arc} t=${t}: the copies sit at ${pos}`);
        rho += spearman(r.order.map((i) => items[i].energy)) / 30;
      }
      if (arc === 'up') { assert.ok(rho >= 0.9, `up: mean rank correlation ${rho}`); }
      if (arc === 'down') { assert.ok(rho <= -0.9, `down: mean rank correlation ${rho}`); }
    }
  });

  test('five songs and a copy under up: the trade that parts the copies is the nearest in energy, so the arc keeps its shape', async () => {
    // Energies a < b = b′ < c < d < e cut into [a] [b] [b′] [c] [d e]: the
    // band holding b′ follows one that ends on b. Trading b′ with c is the
    // nearest fix; trading b with a (the first list) or with d (the second)
    // also parts them but opens on b or plays d second.
    for (const [a, b, c, d, e] of [[0.3, 0.5, 0.55, 0.9, 0.95], [0.1, 0.5, 0.7, 0.8, 0.9]]) {
      const songs = [a, b, c, d, e].map((energy, i) => ({ rankKey: `s${i}`, bpm: 100, energy, artistId: i, hash: `h${i}` }));
      for (const at of [0, 3, 5]) {
        const items = songs.slice();
        items.splice(at, 0, { ...songs[1], rankKey: 's1-copy' });
        const r = await F.solveFlow(items, { arc: 'up' });
        assert.equal(r.arc, 'up');
        const es = r.order.map((i) => items[i].energy);
        const label = `${[a, b, c, d, e]} copy at ${at}: ${es.join(' ')}`;
        const pos = r.order.flatMap((i, q) => (items[i].hash === 'h1' ? [q] : []));
        assert.ok(pos[1] - pos[0] > 1, `${label}: the copies touch`);
        assert.equal(es[0], a, `${label}: opens above the lowest energy`);
        // Positions 0–3 are bands 0–3 and positions 4–5 band 4; each song
        // plays within one band of where its energy cuts it.
        const band = (q) => Math.min(q, 4);
        const home = new Map([[a, [0]], [b, [1, 2]], [c, [3]], [d, [4]], [e, [4]]]);
        es.forEach((x, q) => {
          assert.ok(home.get(x).some((h) => Math.abs(h - band(q)) <= 1), `${label}: ${x} plays in band ${band(q)}`);
        });
        assert.ok(spearman(es) >= 0.9, `${label}: rank correlation ${spearman(es)}`);
      }
    }
  });
});

describe('solveFlow: determinism', () => {
  function fixture() {
    const rng = F.mulberry32(9);
    const items = [];
    const names = [];
    for (let i = 0; i < 33; i++) { items.push(randItem(rng, i, { placed: true })); names.push(`s${i}`); }
    items.push(items[3], items[3]); names.push('s3', 's3');          // two identical duplicates
    for (let i = 0; i < 3; i++) { items.push(unanalysedItem(i)); names.push(`u${i}`); }
    items.push(null, null); names.push('n0', 'n1');
    return { items, names, tail: new Set(['u0', 'u1', 'u2', 'n0', 'n1']) };
  }
  const shuffle = (n, seed) => {
    const rng = F.mulberry32(seed);
    const p = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
  };

  for (const label of ['pins', 'no pins', 'seed 7']) {
    test(`${label}: shuffled input gives the same run; a rerun on its own output gives the same order`, async () => {
      const { items, names, tail } = fixture();
      const n = items.length;
      const opts = label === 'seed 7' ? { seed: 7 } : {};
      const start = label === 'pins' ? 5 : null;
      const end = label === 'pins' ? 20 : null;

      const r1 = await F.solveFlow(items, { ...opts, start, end });
      assert.ok(['complete', 'budget'].includes(r1.solver));
      const seq1 = r1.order.map((i) => names[i]);

      // Shuffled, with the pins remapped to the same songs.
      const p = shuffle(n, 1234);
      const inv = [];
      p.forEach((from, to) => { inv[from] = to; });
      const items2 = p.map((i) => items[i]);
      const names2 = p.map((i) => names[i]);
      const r2 = await F.solveFlow(items2, { ...opts, start: start == null ? null : inv[start], end: end == null ? null : inv[end] });
      const seq2 = r2.order.map((i) => names2[i]);
      // The run depends only on the set; unanalysed and unplaced songs keep
      // their input order at the tail by contract.
      assert.deepEqual(seq2.filter((s) => !tail.has(s)), seq1.filter((s) => !tail.has(s)));
      assert.deepEqual(new Set(seq2.filter((s) => tail.has(s))), tail);

      // Rerun on its own output: the same order, tail included.
      const items3 = r1.order.map((i) => items[i]);
      const r3 = await F.solveFlow(items3, { ...opts, start: start == null ? null : 0, end: end == null ? null : n - 1 });
      assert.deepEqual(r3.order.map((i) => seq1[i]), seq1);

      if (label === 'seed 7') {
        const again = await F.solveFlow(items, { seed: 7 });
        assert.deepEqual(again.order, r1.order, 'the same seed reproduces its order');
        const distinct = new Set();
        for (let s = 1; s <= 5; s++) { distinct.add((await F.solveFlow(items, { seed: s })).order.join(',')); }
        assert.ok(distinct.size >= 2, 'different seeds vary the order');
      }
    });
  }
});

describe('solveFlow: arcs', () => {
  const rng = F.mulberry32(13);
  const items = Array.from({ length: 200 }, (_, i) => ({
    rankKey: `a${String(i).padStart(3, '0')}`, bpm: 80 + rng() * 80, energy: rng(),
  }));
  const spearman = (xs) => {
    const n = xs.length;
    const ranks = new Array(n);
    xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).forEach(([, i], r) => { ranks[i] = r; });
    let d2 = 0;
    for (let i = 0; i < n; i++) { d2 += (ranks[i] - i) ** 2; }
    return 1 - (6 * d2) / (n * (n * n - 1));
  };

  test('up and down follow energy', async () => {
    const up = await F.solveFlow(items, { arc: 'up' });
    assert.equal(up.arc, 'up');
    assert.ok(spearman(up.order.map((i) => items[i].energy)) >= 0.9);
    const down = await F.solveFlow(items, { arc: 'down' });
    assert.equal(down.arc, 'down');
    assert.ok(spearman(down.order.map((i) => items[i].energy)) <= -0.9);
  });

  test('wave rises to the middle and falls', async () => {
    const r = await F.solveFlow(items, { arc: 'wave' });
    const e = r.order.map((i) => items[i].energy);
    const means = [0, 1, 2, 3, 4].map((c) => e.slice(c * 40, c * 40 + 40).reduce((s, x) => s + x, 0) / 40);
    assert.ok(means[0] < means[1] && means[1] < means[2], `rising ${means}`);
    assert.ok(means[2] > means[3] && means[3] > means[4], `falling ${means}`);
  });

  test('no energy means steady; a pinned start stays first', async () => {
    const flat = items.map((it) => ({ ...it, energy: null }));
    const r = await F.solveFlow(flat, { arc: 'up' });
    assert.equal(r.arc, 'steady');
    const s = await F.solveFlow(items, { arc: 'up', start: 150 });
    assert.equal(s.order[0], 150);
    assert.ok(isPerm(s.order, 200));
  });

  test('arcBands: wave play order for five bands', () => {
    const model = { energy: Float64Array.from({ length: 10 }, (_, i) => i / 10) };
    const bands = F.arcBands(model, Int32Array.from([...Array(10).keys()]), 'wave');
    assert.deepEqual(bands.map((b) => [...b]), [[0, 1], [4, 5], [8, 9], [6, 7], [2, 3]]);
  });
});

describe('solveFlow: solver outcomes', () => {
  const rng = F.mulberry32(21);
  const items = (n, dim = 4) => Array.from({ length: n }, (_, i) => randItem(rng, i, { dim, placed: true }));

  test('deadline: a clock that runs out still gives a valid permutation', async () => {
    let t = 0;
    const r = await F.solveFlow(items(60), { exactMax: 0, now: () => (t += 300) });
    assert.equal(r.solver, 'deadline');
    assert.ok(isPerm(r.order, 60));
  });

  test('budget: a tiny evaluation budget still gives a valid permutation', async () => {
    const r = await F.solveFlow(items(60), { exactMax: 0, maxEvals: 10 });
    assert.equal(r.solver, 'budget');
    assert.ok(isPerm(r.order, 60));
  });

  test('n = 1000 completes or stops on the budget', async () => {
    // A generous deadline keeps a loaded CI machine from turning this into
    // a timing test.
    const r = await F.solveFlow(items(1000, 16), { deadlineMs: 60_000 });
    assert.ok(['complete', 'budget'].includes(r.solver), r.solver);
    assert.ok(isPerm(r.order, 1000));
    assert.ok(r.stats.after.meanCost < r.stats.before.meanCost);
  });

  test('the solver yields', async () => {
    let t = 0;
    let yields = 0;
    const yieldFn = () => { yields++; return Promise.resolve(); };
    const r = await F.solveFlow(items(300), { now: () => (t += 5), yieldFn, deadlineMs: 1e12 });
    assert.ok(isPerm(r.order, 300));
    assert.ok(yields >= 1, `yields ${yields}`);
  });
});

describe('reporting', () => {
  test('pathStats on a hand-built path', async () => {
    const nodes = [
      node({ bpm: 120, key: '8A', artistId: 1 }),
      node({ bpm: 60, key: '8A', artistId: 1 }),
      node({ bpm: 150, key: '2B', artistId: 2 }),
    ];
    const m = await F.buildCostMatrix(nodes, { weights: F.WEIGHT_PRESETS.smooth });
    const s = F.pathStats(m, [0, 1, 2]);
    const d01 = (0.20 / 0.35) * 0.03 + F.ARTIST_PENALTY;
    assert.deepEqual(s, {
      transitions: 2,
      meanCost: Math.round(((d01 + 1) / 2) * 1e4) / 1e4,
      meanSound: null,
      tempoOk: 50,
      keyOk: 50,
      keyClash: 1,
      artistRepeats: 1,
      worst: 1,
    });
    assert.equal(F.pathStats(m, [0]).meanCost, null);
  });

  test('transitionWhy: fixed codes in a fixed order', async () => {
    const nodes = [
      node({ vec: unit(1, 0, 0, 0), bpm: 124, key: '8A', artistId: 1 }),   // 0
      node({ vec: unit(1, 0.2, 0, 0), bpm: 126, key: '9A', artistId: 2 }), // 1
      node({ vec: unit(0, 1, 0, 0), bpm: 124, key: '8A', artistId: 3 }),   // 2
      node({ bpm: 126, key: '8A', artistId: 4 }),                          // 3
      node({ bpm: 70, key: '8A', artistId: 5 }),                           // 4
      node({ bpm: 140, key: '8B', artistId: 6 }),                          // 5
      node({ bpm: 62, key: '8A', artistId: 7 }),                           // 6
      node({ bpm: 170, key: '2B', artistId: 7 }),                          // 7
      node({ energy: 0.5 }),                                               // 8
      node({ energy: 0.2 }),                                               // 9
    ];
    const m = await F.buildCostMatrix(nodes, { weights: F.WEIGHT_PRESETS.smooth });
    assert.deepEqual(F.transitionWhy(m, 2, 3), ['sameKey', 'tempoMatch']);
    assert.deepEqual(F.transitionWhy(m, 4, 5), ['relativeKey', 'halfTime']);
    assert.deepEqual(F.transitionWhy(m, 6, 7), ['keyClash', 'tempoJump', 'sameArtist']);
    assert.deepEqual(F.transitionWhy(m, 0, 1), ['soundClose', 'adjacentKey', 'tempoMatch']);
    assert.deepEqual(F.transitionWhy(m, 8, 9), ['noData']);
    for (let a = 0; a < nodes.length; a++) {
      for (let b = 0; b < nodes.length; b++) {
        if (a === b) { continue; }
        const why = F.transitionWhy(m, a, b);
        const idx = why.map((c) => F.WHY_CODES.indexOf(c));
        assert.ok(idx.every((x, k) => x >= 0 && (k === 0 || x > idx[k - 1])), `${a}→${b}: ${why}`);
      }
    }
  });
});
