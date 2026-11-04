/**
 * The UMAP wrapper (src/db/map-umap.js; docs/music-map-plan.md §3.5.2,
 * §3.12): same input and seed → the same bytes, another seed → other bytes;
 * the kNN graph umap-js leaves on the instance after initializeFit (a private
 * field the near-duplicate pass relies on — this test fails first if an
 * upgrade drops it); the init really reaches the optimiser; and a warm +10 %
 * refit at 2k stays put after Procrustes alignment. Node and Bun lay out the
 * same input differently, so nothing here pins coordinates, and the maximum
 * movement of a point across a refit is deliberately not bounded (measured
 * up to 33 % of the diagonal at 10k).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as L from '../../src/db/map-lib.js';
import { fitUmap } from '../../src/db/map-umap.js';

const sha = (a) => crypto.createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) { u = rand(); }
  while (v === 0) { v = rand(); }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Three loose clusters in 20-d (the shape probed when the plan was written).
function threeClusters(n = 300, d = 20) {
  const rand = L.mulberry32(5);
  return Array.from({ length: n }, (_, i) => Array.from({ length: d }, () => rand() + (i % 3)));
}
// Unit vectors shaped like EffNet tracks: a shared cone, then genre > artist
// > track in a 32-d latent space mapped into d (S/bench/lib.mjs's generator).
function syntheticLibrary(n, d, seed) {
  const rand = L.mulberry32(seed);
  const latent = 32, nGenres = 14, nArtists = Math.max(20, Math.round(n / 60));
  const W = new Float64Array(latent * d);
  for (let i = 0; i < W.length; i++) { W[i] = gaussian(rand) / Math.sqrt(latent); }
  const cone = new Float64Array(d);
  for (let j = 0; j < d; j++) { cone[j] = Math.abs(gaussian(rand)) * 0.74 / 28; }
  const genres = Array.from({ length: nGenres }, () => Float64Array.from({ length: latent }, () => gaussian(rand) * 0.61));
  const artists = Array.from({ length: nArtists }, (_, a) => {
    const g = Math.floor(rand() * nGenres);
    return { c: Float64Array.from({ length: latent }, (_, k) => genres[g][k] + gaussian(rand) * 0.53), w: 1 / Math.pow(a + 1, 0.6) };
  });
  const wsum = artists.reduce((s, a) => s + a.w, 0);
  const X = new Float32Array(n * d);
  const z = new Float64Array(latent);
  for (let i = 0; i < n; i++) {
    let r = rand() * wsum, a = 0;
    while (a < nArtists - 1 && r > artists[a].w) { r -= artists[a].w; a++; }
    for (let k = 0; k < latent; k++) { z[k] = artists[a].c[k] + gaussian(rand) * 0.61; }
    let ss = 0;
    for (let j = 0; j < d; j++) {
      let s = cone[j];
      for (let k = 0; k < latent; k++) { s += W[k * d + j] * z[k] / 28; }
      s += gaussian(rand) * 0.019;
      X[i * d + j] = s;
      ss += s * s;
    }
    const inv = 1 / Math.sqrt(ss);
    for (let j = 0; j < d; j++) { X[i * d + j] *= inv; }
  }
  return X;
}
const hashesFor = (n, seed) => {
  const rand = L.mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0') + Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0'));
};
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

describe('fitUmap', () => {
  test('the same 300 points and seed give identical bytes; another seed differs', async () => {
    const rows = threeClusters();
    const a = await fitUmap(rows, null, { seed: 42 });
    const b = await fitUmap(rows, null, { seed: 42 });
    const c = await fitUmap(rows, null, { seed: 7 });
    assert.equal(a.raw.length, 600);
    assert.equal(a.epochs, 500, 'umap-js picks 500 epochs at n ≤ 2,500');
    assert.equal(sha(a.raw), sha(b.raw));
    assert.notEqual(sha(a.raw), sha(c.raw));
    assert.ok(a.raw.every(Number.isFinite));
    // With a PCA-style init, still reproducible and still seed-dependent.
    const init = Float64Array.from({ length: 600 }, (_, i) => ((i * 7919) % 200) / 10 - 10);
    const d = await fitUmap(rows, init, { seed: 42 });
    const e = await fitUmap(rows, init, { seed: 42 });
    const f = await fitUmap(rows, init, { seed: 7 });
    assert.equal(sha(d.raw), sha(e.raw));
    assert.notEqual(sha(d.raw), sha(f.raw));
  });

  test('knnIndices and knnDistances are set by initializeFit: n × 15, self first at distance 0', async () => {
    const rows = threeClusters();
    const { knnIndices, knnDistances } = await fitUmap(rows, null, { nEpochs: 1 });
    assert.equal(knnIndices.length, 300);
    assert.equal(knnDistances.length, 300);
    for (let i = 0; i < 300; i++) {
      assert.equal(knnIndices[i].length, L.UMAP_PARAMS.nNeighbors);
      assert.equal(knnIndices[i][0], i, 'self in column 0');
      assert.equal(knnDistances[i][0], 0);
      for (let c = 1; c < knnIndices[i].length; c++) {
        assert.ok(Number.isInteger(knnIndices[i][c]) && knnIndices[i][c] >= 0 && knnIndices[i][c] < 300);
        assert.ok(knnDistances[i][c] >= knnDistances[i][c - 1], 'ascending distances');
      }
    }
    // The near-duplicate pass reads them as PCA-space distances.
    let s = 0;
    const j = knnIndices[0][1];
    for (let t = 0; t < 20; t++) { s += (rows[0][t] - rows[j][t]) ** 2; }
    assert.ok(Math.abs(Math.sqrt(s) - knnDistances[0][1]) < 1e-9, 'Euclidean in the rows\' own space');
  });

  test('the init is written into the optimiser state', async () => {
    const rows = threeClusters();
    const left = Float64Array.from({ length: 600 }, (_, i) => (i % 2 ? (i % 6) - 3 : -10 + (i % 10)));
    const right = left.map((v, i) => (i % 2 ? v : -v));
    const a = await fitUmap(rows, left, { nEpochs: 5 });
    const b = await fitUmap(rows, right, { nEpochs: 5 });
    assert.notEqual(sha(a.raw), sha(b.raw));
    let meanA = 0, meanB = 0;
    for (let i = 0; i < 300; i++) { meanA += a.raw[2 * i]; meanB += b.raw[2 * i]; }
    assert.ok(Math.sign(meanA) !== Math.sign(meanB), 'five epochs keep the mirrored starts apart');
    assert.equal(a.epochs, 5);
  });

  test('every epoch is reported, and a returned promise is awaited', async () => {
    const seen = [];
    let pending = 0;
    await fitUmap(threeClusters(), null, {
      nEpochs: 12,
      onEpoch: (e, total) => {
        assert.equal(pending, 0, 'the previous epoch\'s promise settled first');
        seen.push([e, total]);
        if (e % 4 === 0) {
          pending++;
          return new Promise((resolve) => setImmediate(() => { pending--; resolve(); }));
        }
        return undefined;
      },
    });
    assert.deepEqual(seen.map(([e]) => e), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(seen.every(([, total]) => total === 12));
  });

  test('UMAP needs more rows than neighbours', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => [i, i * 2, 3]);
    await assert.rejects(fitUmap(rows, null), /15 rows cannot fit 15 neighbours/);
    await assert.rejects(fitUmap(threeClusters(), new Float64Array(10)), /init holds 5 points for 300 rows/);
  });

  test('a warm +10 % refit at 2k: disparity ≤ 0.02, old points p50 ≤ 3 %, p95 ≤ 8 % of the diagonal', async () => {
    const nOld = 2000, n = 2200, d = 128;
    const X = syntheticLibrary(n, d, 7);
    const hashes = hashesFor(n, 8);
    const byHash = (ids) => ids.sort((a, b) => L.compareHash(hashes[a], hashes[b]));
    // Rebuild: PCA-50 on the old songs, a cold fit from PCA-2, the affine.
    const pca = L.randomizedPCA(X, nOld, d);
    const basis = L.basisF32(pca);
    const Z = L.projectRows(X, n, d, basis);
    const k = basis.k;
    const oldIds = byHash(Array.from({ length: nOld }, (_, i) => i));
    const cold = await fitUmap(L.rowsOf(Z, k, oldIds), L.pcaInit(Z, k, oldIds));
    const zOld = new Float32Array(nOld * k);
    oldIds.forEach((id, r) => zOld.set(Z.subarray(id * k, id * k + k), r * k));
    const { affine } = L.layoutAffine(cold.raw, { z: zOld, k });
    const stored = L.applyAffine(affine, cold.raw);   // map_points x, y
    // Refit: raw init from the stored map through the inverse affine; new
    // songs placed by kNN against the old fit set; 150 epochs at 0.3.
    const prevRaw = L.applyAffine(L.invertAffine(affine), stored);
    const prevOf = new Map(oldIds.map((id, r) => [id, r]));
    const newIds = byHash(Array.from({ length: n - nOld }, (_, i) => nOld + i));
    const zNew = new Float32Array(newIds.length * k);
    newIds.forEach((id, r) => zNew.set(Z.subarray(id * k, id * k + k), r * k));
    const placed = L.knnPlace({ refZ: zOld, refRaw: prevRaw, k, queryZ: zNew, hashes: newIds.map((id) => hashes[id]) });
    const placedOf = new Map(newIds.map((id, r) => [id, r]));
    const allIds = byHash(Array.from({ length: n }, (_, i) => i));
    const init = new Float64Array(2 * n);
    allIds.forEach((id, r) => {
      const src = prevOf.has(id) ? prevRaw : placed.raw;
      const at = prevOf.has(id) ? prevOf.get(id) : placedOf.get(id);
      init[2 * r] = src[2 * at];
      init[2 * r + 1] = src[2 * at + 1];
    });
    const warm = await fitUmap(L.rowsOf(Z, k, allIds), init, { ...L.UMAP_REFIT });
    assert.equal(warm.epochs, L.UMAP_REFIT.nEpochs);
    // Align the old songs' new raw onto their previous raw; measure.
    const A = new Float64Array(2 * nOld), B = new Float64Array(2 * nOld);
    let m = 0;
    allIds.forEach((id, r) => {
      if (!prevOf.has(id)) { return; }
      const p = prevOf.get(id);
      A[2 * m] = prevRaw[2 * p]; A[2 * m + 1] = prevRaw[2 * p + 1];
      B[2 * m] = warm.raw[2 * r]; B[2 * m + 1] = warm.raw[2 * r + 1];
      m++;
    });
    const T = L.procrustes(A, B);
    const aligned = L.applySimilarity(T, B);
    const [sx, sy] = L.rawSpan(A);
    const diag = Math.hypot(sx, sy);
    const moves = Float64Array.from({ length: nOld }, (_, i) => Math.hypot(aligned[2 * i] - A[2 * i], aligned[2 * i + 1] - A[2 * i + 1]) / diag).sort();
    assert.ok(T.disparity <= 0.02, `disparity ${T.disparity}`);
    assert.ok(quantile(moves, 0.5) <= 0.03, `p50 ${quantile(moves, 0.5)}`);
    assert.ok(quantile(moves, 0.95) <= 0.08, `p95 ${quantile(moves, 0.95)}`);
    assert.ok(aligned.every(Number.isFinite));
  });
});
