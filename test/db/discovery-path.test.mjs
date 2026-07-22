/**
 * Unit tests for the sonic-path geometry (src/db/discovery-similarity.js:
 * slerp + pathBetween) over a handcrafted fake index — no server, no DB.
 *
 * Vector space: 4-d unit vectors parameterized by an angle in the XY plane,
 * so every cosine is cos(Δangle) and every assertion is exact trigonometry.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../../src/db/discovery-similarity.js';

const unit = (deg) => {
  const r = (deg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
};
const entry = (hash, artist, deg, title) => ({ hash, artist, title: title ?? hash, vec: unit(deg), genreTags: null });
const mkIndex = (entries) => ({ entries, byHash: new Map(entries.map((e) => [e.hash, e])) });
const allVisible = () => true;

describe('slerp', () => {
  test('midpoint of two unit vectors bisects the arc', () => {
    const m = sim.slerp(unit(0), unit(90), 0.5);
    assert.ok(Math.abs(m[0] - Math.SQRT1_2) < 1e-6, `x ${m[0]}`);
    assert.ok(Math.abs(m[1] - Math.SQRT1_2) < 1e-6, `y ${m[1]}`);
  });

  test('stays on the unit sphere at every t (arc, not chord)', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const v = sim.slerp(unit(0), unit(120), t);
      const norm = Math.hypot(...v);
      assert.ok(Math.abs(norm - 1) < 1e-6, `|v(${t})| = ${norm}`);
    }
  });

  test('t endpoints reproduce the inputs', () => {
    const a = unit(10);
    const b = unit(70);
    for (const [t, want] of [[0, a], [1, b]]) {
      const v = sim.slerp(a, b, t);
      for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(v[i] - want[i]) < 1e-6, `t=${t} [${i}]`);
      }
    }
  });

  test('near-parallel inputs fall back to normalized lerp (no /0)', () => {
    const a = unit(30);
    const v = sim.slerp(a, unit(30), 0.5);
    for (let i = 0; i < 4; i++) {
      assert.ok(Number.isFinite(v[i]), `component ${i} finite`);
      assert.ok(Math.abs(v[i] - a[i]) < 1e-5, `component ${i} ≈ input`);
    }
  });
});

describe('pathBetween', () => {
  test('waypoints snap to the nearest tracks along the arc, in order', () => {
    // Seeds at 0° and 90°; candidates at 20°, 45°, 70° plus off-arc decoys.
    // 3 waypoints land at 22.5° / 45° / 67.5° → picks are unambiguous.
    const index = mkIndex([
      entry('A', 'ArtA', 0),
      entry('B', 'ArtB', 90),
      entry('c20', 'X', 20),
      entry('c45', 'Y', 45),
      entry('c70', 'Z', 70),
      entry('far1', 'D', 160),
      entry('far2', 'D', -60),
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 3, allVisible);
    assert.deepEqual(out.map((o) => o.hash), ['c20', 'c45', 'c70']);
    assert.deepEqual(out.map((o) => o.t), [0.25, 0.5, 0.75]);
    // Each similarity is cos(waypoint − candidate angle), exactly.
    const expected = [Math.cos((2.5 * Math.PI) / 180), 1, Math.cos((2.5 * Math.PI) / 180)];
    out.forEach((o, i) => {
      assert.ok(Math.abs(o.similarity - expected[i]) < 1e-5,
        `waypoint ${i}: ${o.similarity} ≈ ${expected[i]}`);
    });
  });

  test('never re-picks a track or the seeds; shortens when the pool runs dry', () => {
    // Only one candidate for three waypoints: it's used once, then the
    // walk stops — no repeats, no nulls, no error.
    const index = mkIndex([
      entry('A', 'ArtA', 0),
      entry('B', 'ArtB', 90),
      entry('only', 'X', 45),
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 3, allVisible);
    assert.deepEqual(out.map((o) => o.hash), ['only']);
  });

  test('invisible tracks are skipped for the whole path, next-best wins', () => {
    const index = mkIndex([
      entry('A', 'ArtA', 0),
      entry('B', 'ArtB', 90),
      entry('hidden', 'X', 45),   // nearest to the midpoint, but not visible
      entry('backup', 'Y', 40),
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 1, (h) => h !== 'hidden');
    assert.deepEqual(out.map((o) => o.hash), ['backup']);
  });

  test('same song under two hashes (single vs EP master) picks only once', () => {
    // Real libraries hold the same track as different files with distinct
    // audio hashes. Hash dedupe alone would play "Mistaken" twice; the
    // normalized artist+title key must collapse them.
    const index = mkIndex([
      entry('A', 'ArtA', 0),
      entry('B', 'ArtB', 90),
      entry('single', 'Color Out', 40, 'Mistaken'),
      entry('epcut', 'Color Out', 50, 'mistaken '),   // case/space variant
      entry('other', 'X', 70, 'Other Song'),
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 3, allVisible);
    const hashes = out.map((o) => o.hash);
    assert.ok(!(hashes.includes('single') && hashes.includes('epcut')),
      `both copies picked: ${hashes}`);
    assert.ok(hashes.includes('other'));
  });

  test('untitled rows fall back to hash-only dedupe (both can appear)', () => {
    const index = mkIndex([
      { hash: 'A', artist: 'ArtA', title: null, vec: unit(0), genreTags: null },
      { hash: 'B', artist: 'ArtB', title: null, vec: unit(90), genreTags: null },
      { hash: 'u1', artist: null, title: null, vec: unit(30), genreTags: null },
      { hash: 'u2', artist: null, title: null, vec: unit(60), genreTags: null },
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 2, allVisible);
    assert.deepEqual(out.map((o) => o.hash), ['u1', 'u2']);
  });

  test('unknown seed hashes yield an empty path', () => {
    const index = mkIndex([entry('A', 'ArtA', 0)]);
    assert.deepEqual(sim.pathBetween(index, 'A', 'nope', 3, allVisible), []);
    assert.deepEqual(sim.pathBetween(index, 'nope', 'A', 3, allVisible), []);
  });

  test('identical seed vectors degrade gracefully (lerp fallback path)', () => {
    // Same vector under two hashes (duplicate-audio shape): every waypoint
    // is the seed direction; picks are the nearest OTHER tracks, no NaNs.
    const index = mkIndex([
      entry('A', 'ArtA', 30),
      entry('B', 'ArtB', 30),
      entry('c1', 'X', 33),
      entry('c2', 'Y', 25),
    ]);
    const out = sim.pathBetween(index, 'A', 'B', 2, allVisible);
    assert.equal(out.length, 2);
    assert.deepEqual(new Set(out.map((o) => o.hash)), new Set(['c1', 'c2']));
    for (const o of out) { assert.ok(Number.isFinite(o.similarity)); }
  });
});
