/**
 * Unit tests for rankTracksMulti (src/db/discovery-similarity.js), the
 * multi-seed ranking behind the Discover page's library source, over
 * hand-built indexes. No server, no DB.
 *
 * Most fixtures use 4-d unit vectors parameterized by an angle in the XY
 * plane, so every cosine is cos(Δangle) and orderings are plain
 * trigonometry. The oracle tests use a larger pseudo-random index, both as
 * hand-built entries and re-homed into one contiguous matrix the way
 * getIndex() builds it, so both scoresInto paths are covered.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../../src/db/discovery-similarity.js';
import { NEAR_DUP } from '../../src/db/discovery-novelty.js';

const unit = (deg) => {
  const r = (deg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
};
const entry = (hash, deg, { artist = `Artist ${hash}`, title = `Title ${hash}` } = {}) => (
  { hash, artist, title, vec: unit(deg), genreTags: null }
);
const mkIndex = (entries) => ({ entries, byHash: new Map(entries.map((e) => [e.hash, e])) });
const hashes = (rows) => rows.map((r) => r.entry.hash);
const cosDeg = (deg) => Math.cos((deg * Math.PI) / 180);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≈ ${b}`);

// Re-home every vector into one contiguous Float32Array (getIndex's layout)
// so scoresInto takes its flat-matrix fast path.
function withMatrix(index) {
  const dim = index.entries[0].vec.length;
  const matrix = new Float32Array(index.entries.length * dim);
  index.entries.forEach((e, i) => {
    matrix.set(e.vec, i * dim);
    e.vec = matrix.subarray(i * dim, (i + 1) * dim);
  });
  return { ...index, dim, matrix };
}

// Deterministic pseudo-random unit vectors (mulberry32), 16-d.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomUnit(next, dim = 16) {
  const v = new Float32Array(dim);
  let ss = 0;
  for (let i = 0; i < dim; i++) { v[i] = next() - 0.5; ss += v[i] * v[i]; }
  const n = Math.sqrt(ss);
  for (let i = 0; i < dim; i++) { v[i] /= n; }
  return v;
}
function randomIndex(n, seed) {
  const next = rng(seed);
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ hash: `h${i}`, artist: `Artist ${i % 30}`, title: `Title ${i}`, vec: randomUnit(next), genreTags: null });
  }
  return mkIndex(entries);
}

// The obvious O(n·S) definition, for comparison: each entry's best seed,
// filtered, sorted descending, truncated. Every title is unique in the
// random fixture, so dedupe never fires there.
function oracle(index, seedVecs, { mode, exclude = new Set(), nearDup = NEAR_DUP, topK }) {
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; } return s; };
  const c = mode === 'centroid' ? sim.centroidOf(seedVecs) : null;
  const rows = [];
  for (const e of index.entries) {
    if (exclude.has(e.hash)) { continue; }
    const perSeed = seedVecs.map((s) => dot(s, e.vec));
    if (Math.max(...perSeed) >= nearDup) { continue; }
    if (c) {
      rows.push({ hash: e.hash, similarity: dot(c, e.vec), seedIndex: null });
    } else {
      let best = 0;
      perSeed.forEach((v, j) => { if (v > perSeed[best]) { best = j; } });
      rows.push({ hash: e.hash, similarity: perSeed[best], seedIndex: best });
    }
  }
  rows.sort((a, b) => b.similarity - a.similarity);
  return rows.slice(0, topK);
}

describe('rankTracksMulti: max vs centroid', () => {
  // Seeds at 0° and 90°. c12 hugs seed 0, c75 leans to seed 1, c45 sits
  // exactly between them: a centroid (45°) loves it, neither seed does.
  const build = () => mkIndex([
    entry('seedA', 0), entry('seedB', 90),
    entry('c12', 12), entry('c45', 45), entry('c75', 75),
    entry('far', 200),
  ]);
  const seeds = [unit(0), unit(90)];
  const exclude = new Set(['seedA', 'seedB']);

  test("'max' ranks every entry by its best seed", async () => {
    const out = await sim.rankTracksMulti(build(), seeds, { exclude, mode: 'max' });
    assert.deepEqual(hashes(out), ['c12', 'c75', 'c45', 'far']);
    close(out[0].similarity, cosDeg(12), 'c12 vs seed 0');
    close(out[1].similarity, cosDeg(15), 'c75 vs seed 1');
    close(out[2].similarity, cosDeg(45), 'c45 vs its best seed');
  });

  test("'centroid' ranks by the one averaged vector, seedIndex null", async () => {
    const out = await sim.rankTracksMulti(build(), seeds, { exclude, mode: 'centroid' });
    assert.deepEqual(hashes(out), ['c45', 'c75', 'c12', 'far']);
    close(out[0].similarity, 1, 'c45 sits on the centroid');
    close(out[1].similarity, cosDeg(30), 'c75 vs centroid');
    close(out[2].similarity, cosDeg(33), 'c12 vs centroid');
    assert.ok(out.every((r) => r.seedIndex === null));
  });

  test('defaults to max mode; an unknown mode rejects', async () => {
    const out = await sim.rankTracksMulti(build(), seeds, { exclude });
    assert.deepEqual(hashes(out), ['c12', 'c75', 'c45', 'far']);
    await assert.rejects(sim.rankTracksMulti(build(), seeds, { mode: 'sum' }), /unknown mode/);
  });

  test('topK truncates after filtering; empty inputs answer []', async () => {
    const out = await sim.rankTracksMulti(build(), seeds, { exclude, topK: 2 });
    assert.deepEqual(hashes(out), ['c12', 'c75']);
    assert.deepEqual(await sim.rankTracksMulti(build(), seeds, { topK: 0 }), []);
    assert.deepEqual(await sim.rankTracksMulti(build(), [], {}), []);
    assert.deepEqual(await sim.rankTracksMulti(mkIndex([]), seeds, {}), []);
  });
});

describe('rankTracksMulti: seedIndex', () => {
  test('names the seed that produced each row, with that seed\'s exact cosine', async () => {
    // Three seeds 120° apart, one candidate 15° off each.
    const index = mkIndex([
      entry('near0', 15), entry('near1', 135), entry('near2', 255),
    ]);
    const seeds = [unit(0), unit(120), unit(240)];
    const out = await sim.rankTracksMulti(index, seeds, { mode: 'max' });
    const bySeed = Object.fromEntries(out.map((r) => [r.entry.hash, r.seedIndex]));
    assert.deepEqual(bySeed, { near0: 0, near1: 1, near2: 2 });
    for (const r of out) {
      assert.equal(r.similarity, sim.similarityToHash(index, seeds[r.seedIndex], r.entry.hash),
        `${r.entry.hash}: similarity is the dot vs seed ${r.seedIndex}`);
    }
  });

  test('an exact tie goes to the earlier seed', async () => {
    // Each dot is 0.5 exactly (the third component meets a zero), so the
    // two seeds tie bit for bit.
    const tie = new Float32Array([0.5, 0.5, Math.SQRT1_2, 0]);
    const index = mkIndex([{ hash: 'tie', artist: 'X', title: 'Tie', vec: tie, genreTags: null }]);
    const seedsAB = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
    assert.equal((await sim.rankTracksMulti(index, seedsAB))[0].seedIndex, 0);
    assert.equal((await sim.rankTracksMulti(index, [...seedsAB].reverse()))[0].seedIndex, 0);
  });
});

describe('rankTracksMulti: exclusions', () => {
  test('exclude (a Set, or any iterable of hashes) is honoured in both modes', async () => {
    const index = mkIndex([entry('top', 20), entry('next', 30), entry('third', 40)]);
    for (const mode of ['max', 'centroid']) {
      for (const exclude of [new Set(['top']), ['top']]) {
        const out = await sim.rankTracksMulti(index, [unit(0)], { exclude, mode });
        assert.deepEqual(hashes(out), ['next', 'third'], `${mode} ${exclude.constructor.name}`);
      }
    }
  });

  test("two other files of a seed's song (same artist|title) never surface", async () => {
    // The seed song exists as three files with distinct audio hashes: the
    // one the user finished, a remaster, and a re-encode tagged with case
    // and space variants. Neither alternate is a near-dup (20° and 30°
    // off), so only the name key keeps them out of "never played".
    const index = mkIndex([
      entry('seed', 0, { artist: 'Boards of Canada', title: 'Roygbiv' }),
      entry('remaster', 20, { artist: 'Boards of Canada', title: 'Roygbiv' }),
      entry('reencode', 30, { artist: ' boards of canada ', title: 'ROYGBIV ' }),
      entry('other1', 25), entry('other2', 35),
    ]);
    const seedEntry = index.byHash.get('seed');
    const exclude = new Set(['seed']);

    // Control: without the name keys the remaster ranks first.
    const loose = await sim.rankTracksMulti(index, [seedEntry.vec], { exclude });
    assert.equal(hashes(loose)[0], 'remaster');

    const excludeNameKeys = new Set([sim.entryNameKey(seedEntry)]);
    for (const mode of ['max', 'centroid']) {
      for (const dedupe of [true, false]) {
        for (const topK of [1, 2, 10, Infinity]) {
          const out = await sim.rankTracksMulti(index, [seedEntry.vec], { exclude, excludeNameKeys, mode, dedupe, topK });
          const got = hashes(out);
          assert.ok(!got.includes('remaster') && !got.includes('reencode'),
            `${mode} dedupe=${dedupe} topK=${topK}: ${got}`);
          assert.deepEqual(got, ['other1', 'other2'].slice(0, topK));
        }
      }
    }
  });

  test('entryNameKey matches the key getIndex/pathBetween use, null without a title', () => {
    assert.equal(sim.entryNameKey({ artist: ' Color Out ', title: 'Mistaken ' }), 'color out|mistaken');
    assert.equal(sim.entryNameKey({ artist: null, title: 'Solo' }), '|solo');
    assert.equal(sim.entryNameKey({ artist: 'X', title: null }), null);
    // A precomputed key is trusted as-is (getIndex already built it).
    assert.equal(sim.entryNameKey({ artist: 'X', title: 'Y', nameKey: 'pre' }), 'pre');
  });
});

describe('rankTracksMulti: near-duplicate guard', () => {
  test("an entry at ≥ 0.99 to its best seed is dropped ('max')", async () => {
    // 5° → cos 0.9962 (an untagged re-encode); 9° → 0.9877 (a real neighbour).
    const index = mkIndex([entry('reencode', 5), entry('neighbour', 9), entry('other', 100)]);
    const seeds = [unit(90), unit(0)];   // the re-encode's seed is NOT seed 0
    const out = await sim.rankTracksMulti(index, seeds);
    assert.deepEqual(hashes(out), ['neighbour', 'other']);

    // The threshold is inclusive, and tunable.
    const exact = sim.similarityToHash(index, seeds[1], 'neighbour');
    assert.deepEqual(hashes(await sim.rankTracksMulti(index, seeds, { nearDup: exact })), ['other']);
    assert.deepEqual(hashes(await sim.rankTracksMulti(index, seeds, { nearDup: exact + 1e-9 })),
      ['neighbour', 'other']);
    // Infinity switches the guard off; null does NOT mean "0" (that would
    // drop every positive match): it falls back to the default.
    assert.deepEqual(hashes(await sim.rankTracksMulti(index, seeds, { nearDup: Infinity })),
      ['reencode', 'neighbour', 'other']);
    assert.deepEqual(hashes(await sim.rankTracksMulti(index, seeds, { nearDup: null })),
      ['neighbour', 'other']);
  });

  test("'centroid' checks every seed, not the centroid", async () => {
    // Seeds at 0° and 90°: the centroid is 45°. 'onCentroid' is 1.0 to the
    // centroid but 0.71 to each seed, so it stays. 'reencode' is 3° from
    // seed 0 (0.9986) yet only cos 42° to the centroid, so a centroid-only
    // check would miss it.
    const index = mkIndex([entry('onCentroid', 45), entry('reencode', 3), entry('mid', 60)]);
    const out = await sim.rankTracksMulti(index, [unit(0), unit(90)], { mode: 'centroid' });
    assert.deepEqual(hashes(out), ['onCentroid', 'mid']);
  });

  test("'centroid' fills topK past a near-dup it rejected on the walk", async () => {
    // The near-dup is the centroid's top candidate (one seed) — the walk
    // drops it and the next rows take its place.
    const index = mkIndex([entry('reencode', 2), entry('a', 15), entry('b', 25), entry('c', 35)]);
    const out = await sim.rankTracksMulti(index, [unit(0)], { mode: 'centroid', topK: 2 });
    assert.deepEqual(hashes(out), ['a', 'b']);
  });
});

describe('rankTracksMulti: name-key dedupe', () => {
  test('keeps only the best-scoring file of a song; dedupe:false keeps every file', async () => {
    const song = { artist: 'Color Out', title: 'Mistaken' };
    const index = mkIndex([
      entry('ep', 25, song),
      entry('single', 20, song),
      entry('live', 40, { artist: 'color out', title: 'MISTAKEN' }),
      entry('other', 30),
    ]);
    const deduped = await sim.rankTracksMulti(index, [unit(0)]);
    assert.deepEqual(hashes(deduped), ['single', 'other']);
    const all = await sim.rankTracksMulti(index, [unit(0)], { dedupe: false });
    assert.deepEqual(hashes(all), ['single', 'ep', 'other', 'live']);
  });

  test('the best file is judged on the merged score, across seeds', async () => {
    // 'a' is the better file against seed 0, 'b' against seed 1; 'b' wins
    // overall (5°-closer to its seed than 'a' to its own).
    const song = { artist: 'Same', title: 'Song' };
    const index = mkIndex([entry('a', 20, song), entry('b', 105, song)]);
    const out = await sim.rankTracksMulti(index, [unit(0), unit(90)]);
    assert.deepEqual(out.map((r) => [r.entry.hash, r.seedIndex]), [['b', 1]]);
  });

  test('untitled rows dedupe by hash alone', async () => {
    const index = mkIndex([
      { hash: 'u1', artist: null, title: null, vec: unit(20), genreTags: null },
      { hash: 'u2', artist: null, title: null, vec: unit(30), genreTags: null },
    ]);
    assert.deepEqual(hashes(await sim.rankTracksMulti(index, [unit(0)])), ['u1', 'u2']);
  });

  test('a head full of one song still fills topK (escalates past the over-select)', async () => {
    // 300 files of ONE song outrank everything else; topK 5 over-selects
    // 69 rows, all the same song, so the walk must escalate to find the
    // next four distinct songs.
    const song = { artist: 'Loop', title: 'Forever' };
    const entries = [];
    for (let i = 0; i < 300; i++) { entries.push(entry(`dup${i}`, 10 + i * 0.01, song)); }
    for (let i = 0; i < 10; i++) { entries.push(entry(`d${i}`, 20 + i)); }
    const out = await sim.rankTracksMulti(mkIndex(entries), [unit(0)], { topK: 5 });
    assert.deepEqual(hashes(out), ['dup0', 'd0', 'd1', 'd2', 'd3']);
  });
});

describe('rankTracksMulti: matches the brute-force definition', () => {
  for (const layout of ['hand-built', 'matrix']) {
    test(`${layout}: 'max' and 'centroid' equal the oracle at several topK`, async () => {
      let index = randomIndex(600, 7);
      if (layout === 'matrix') { index = withMatrix(index); }
      const seedHashes = ['h3', 'h77', 'h150', 'h301', 'h599'];
      const seeds = seedHashes.map((h) => index.byHash.get(h).vec);
      const exclude = new Set([...seedHashes, 'h10', 'h11']);
      for (const mode of ['max', 'centroid']) {
        for (const topK of [1, 10, 100, 595, Infinity]) {
          const want = oracle(index, seeds, { mode, exclude, topK });
          const got = await sim.rankTracksMulti(index, seeds, { mode, exclude, topK });
          assert.equal(got.length, want.length, `${mode} topK=${topK} length`);
          got.forEach((r, i) => {
            assert.equal(r.entry.hash, want[i].hash, `${mode} topK=${topK} rank ${i}`);
            close(r.similarity, want[i].similarity, `${mode} topK=${topK} rank ${i} score`);
            assert.equal(r.seedIndex, want[i].seedIndex, `${mode} topK=${topK} rank ${i} seed`);
          });
        }
      }
    });
  }

  test("one seed in 'max' mode is rankTracks minus the seed's near-dups", async () => {
    const index = withMatrix(randomIndex(400, 11));
    const seed = index.byHash.get('h42').vec;
    const want = sim.rankTracks(index, seed, 'h42', 80).filter((r) => r.similarity < NEAR_DUP).slice(0, 50);
    const got = await sim.rankTracksMulti(index, [seed], { exclude: new Set(['h42']), topK: 50 });
    assert.deepEqual(hashes(got), want.map((r) => r.entry.hash));
    assert.deepEqual(got.map((r) => r.similarity), want.map((r) => r.similarity));
  });
});

describe('rankTracksMulti: yielding', () => {
  // Spies on the global the module reads at call time, and proves the event
  // loop really ran mid-ranking: a tick queued right after the call fires
  // before the ranking settles only if the function yielded.
  async function run(seedCount, opts) {
    const index = randomIndex(200, 3);
    const seeds = index.entries.slice(0, seedCount).map((e) => e.vec);
    const real = globalThis.setImmediate;
    let calls = 0;
    globalThis.setImmediate = (...args) => { calls++; return real(...args); };
    const timeline = [];
    try {
      const ranked = sim.rankTracksMulti(index, seeds, opts);
      const ticked = new Promise((resolve) => real(() => { timeline.push('tick'); resolve(); }));
      await Promise.all([ranked.then(() => timeline.push('settled')), ticked]);
    } finally {
      globalThis.setImmediate = real;
    }
    return { calls, timeline };
  }

  test('yields between passes (S - 1 times), letting other work run', async () => {
    const { calls, timeline } = await run(4, { mode: 'max' });
    assert.equal(calls, 3, '4 seeds -> 3 yields');
    assert.deepEqual(timeline, ['tick', 'settled']);
  });

  test('yieldBetween:false, one seed, or centroid mode never yield', async () => {
    for (const [seedCount, opts] of [[4, { yieldBetween: false }], [1, {}], [4, { mode: 'centroid' }]]) {
      const { calls, timeline } = await run(seedCount, opts);
      assert.equal(calls, 0, JSON.stringify(opts));
      assert.deepEqual(timeline, ['settled', 'tick'], JSON.stringify(opts));
    }
  });
});
