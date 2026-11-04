/**
 * The music map's pure core (src/db/map-lib.js; docs/music-map-plan.md §3.5,
 * §3.8.9, §3.12): PCA (orthonormal, clamped, and a golden Rademacher basis
 * that is bit-identical across runtimes), geometry, kNN placement and the
 * displacement field, near-duplicate grouping, regions and keys, hues, mixes,
 * land (levels, nesting, caps, determinism), the codecs and the shared land
 * fixture, the memory budget, and the mode table. Deterministic throughout:
 * no assertion depends on wall-clock time. The bun leg recomputes the
 * runtime-independent outputs under Bun and compares them byte for byte.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../../src/db/map-lib.js';
import { NEAR_DUP } from '../../src/db/discovery-novelty.js';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_LIB = path.join(__dirname, '..', '..', 'src', 'db', 'map-lib.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'map', 'land-v1.json');
const GiB = 1024 * L.MiB;

// ── helpers ─────────────────────────────────────────────────────────────────

const sha = (...arrays) => {
  const h = crypto.createHash('sha256');
  for (const a of arrays) { h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
  return h.digest('hex');
};
// Box–Muller over mulberry32: fine for synthetic data inside one runtime
// (Math.log/Math.cos are not bit-identical across runtimes; the golden PCA
// set below avoids them).
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) { u = rand(); }
  while (v === 0) { v = rand(); }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function unitRows(X, n, d) {
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) { s += X[i * d + j] ** 2; }
    s = Math.sqrt(s) || 1;
    for (let j = 0; j < d; j++) { X[i * d + j] /= s; }
  }
  return X;
}
// Clustered unit vectors: a shared cone, cluster centres, member noise.
function clusteredVectors(n, d, seed, { clusters = 8, spread = 0.35 } = {}) {
  const rand = L.mulberry32(seed);
  const centres = [];
  for (let c = 0; c < clusters; c++) {
    const v = new Float64Array(d);
    for (let j = 0; j < d; j++) { v[j] = gaussian(rand) + 0.5; }
    centres.push(v);
  }
  const X = new Float32Array(n * d);
  const clusterOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(rand() * clusters);
    clusterOf[i] = c;
    for (let j = 0; j < d; j++) { X[i * d + j] = centres[c][j] + spread * gaussian(rand) * Math.sqrt(d) / 4; }
  }
  return { X: unitRows(X, n, d), clusterOf };
}
const randomHashes = (n, seed) => {
  const rand = L.mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let h = '';
    for (let w = 0; w < 4; w++) { h += Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0'); }
    out.push(h);
  }
  return out;
};
function corr(n, a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a(i); mb += b(i); }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a(i) - ma, y = b(i) - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
// A synthetic "map": Gaussian blobs (one per province) inside the unit square.
function blobMap(n, seed, { provinces = 8, sd = 0.045 } = {}) {
  const rand = L.mulberry32(seed);
  const centres = [];
  for (let p = 0; p < provinces; p++) {
    const a = (p / provinces) * 2 * Math.PI;
    centres.push([0.5 + 0.32 * Math.cos(a) + 0.04 * (rand() - 0.5), 0.5 + 0.32 * Math.sin(a) + 0.04 * (rand() - 0.5)]);
  }
  const xy = new Float64Array(2 * n), province = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.min(provinces - 1, Math.floor(Math.pow(rand(), 1.6) * provinces));
    province[i] = p;
    xy[2 * i] = Math.min(0.96, Math.max(0.04, centres[p][0] + sd * gaussian(rand)));
    xy[2 * i + 1] = Math.min(0.96, Math.max(0.04, centres[p][1] + sd * gaussian(rand)));
  }
  return { xy, province, provinces };
}
// A map-like layout for the town tests: genres > styles > artists, with
// Zipf-sized artists, so towns sit on islands the way a UMAP map's do.
function atlasMap(n, seed, { genres = 11 } = {}) {
  const rand = L.mulberry32(seed);
  const artists = [];
  for (let g = 0; g < genres; g++) {
    const gx = 0.12 + 0.76 * rand(), gy = 0.12 + 0.76 * rand();
    const styles = 3 + Math.floor(rand() * 3);
    for (let s = 0; s < styles; s++) {
      const sx = gx + 0.07 * gaussian(rand), sy = gy + 0.07 * gaussian(rand);
      const count = 3 + Math.floor(rand() * 6);
      for (let a = 0; a < count; a++) {
        artists.push({ x: sx + 0.025 * gaussian(rand), y: sy + 0.025 * gaussian(rand), sd: 0.006 + 0.006 * rand() });
      }
    }
  }
  const w = artists.map((_, i) => 1 / Math.pow((i % 17) + 1, 0.6));
  const wsum = w.reduce((s, v) => s + v, 0);
  const xy = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    let r = rand() * wsum, a = 0;
    while (a < artists.length - 1 && r > w[a]) { r -= w[a]; a++; }
    xy[2 * i] = Math.min(0.98, Math.max(0.02, artists[a].x + artists[a].sd * gaussian(rand)));
    xy[2 * i + 1] = Math.min(0.98, Math.max(0.02, artists[a].y + artists[a].sd * gaussian(rand)));
  }
  return xy;
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function distToRings(px, py, rings) {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = segDist(px, py, r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]);
      if (d < best) { best = d; }
    }
  }
  return best;
}
// Even-odd by scanline intervals: the crossings of the row y = py, sorted;
// inside when an odd number lie left of px. An oracle independent of
// pointInRings's ray loop.
function scanlineInside(px, py, rings) {
  const xs = [];
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const y0 = r[2 * j + 1], y1 = r[2 * i + 1];
      if ((y0 > py) === (y1 > py)) { continue; }
      const x0 = r[2 * j], x1 = r[2 * i];
      xs.push(x0 + (py - y0) * (x1 - x0) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  let left = 0;
  for (const x of xs) { if (x < px) { left++; } }
  return left % 2 === 1;
}

// The golden PCA input: only integer patterns and mulberry32 uniforms, so the
// data — and, through + − × ÷ √ only, the basis — are bit-identical under
// any runtime. Self-contained: the bun leg ships its source.
function goldenSet(mulberry32) {
  const m = 120, d = 64;
  const rand = mulberry32(20261102);
  const X = new Float32Array(m * d);
  for (let i = 0; i < m; i++) {
    const a = (i % 7) - 3, b = ((i * 5) % 11) - 5, c = (i % 3) - 1, e = ((i * 3) % 13) - 6;
    for (let j = 0; j < d; j++) {
      const base = a * ((j % 4) - 1.5) + 0.5 * b * (((j * 3) % 5) - 2)
        + 0.25 * c * (j % 2 ? 1 : -1) + 0.125 * e * (((j * 7) % 9) - 4);
      X[i * d + j] = base + (rand() - 0.5) * 0.2;
    }
  }
  return { X, m, d };
}
// Runtime-independent outputs, computed the same way by both legs.
function crossRuntimeDigest(L, goldenSet, crypto) {
  const sha = (...arrays) => {
    const h = crypto.createHash('sha256');
    for (const a of arrays) { h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
    return h.digest('hex');
  };
  const { X, m, d } = goldenSet(L.mulberry32);
  const pca = L.randomizedPCA(X, m, d);
  const basis = L.basisF32(pca);
  const Z = L.projectRows(X, m, d, basis);
  const refRaw = new Float64Array(2 * 80);
  for (let i = 0; i < 80; i++) { refRaw[2 * i] = Z[i * basis.k] * 3; refRaw[2 * i + 1] = Z[i * basis.k + 1] * 3; }
  const hashes = [];
  for (let i = 80; i < m; i++) { hashes.push((i * 2654435761 >>> 0).toString(16).padStart(8, '0') + 'abcd'); }
  const placed = L.knnPlace({ refZ: Z.subarray(0, 80 * basis.k), refRaw, k: basis.k, queryZ: Z.subarray(80 * basis.k), hashes });
  const km = L.kmeansPP(refRaw, 6);
  const land = L.encodeLandV1([[[1, 2, 300, 4, 5, 600]], [], [[7, 8, 9, 10, 11, 1200, 13, 14]]]);
  const cols = L.encodePointsColsV1({ ids: [3, 9, 70000], x: [0, 65535, 3], y: [1, 2, 3], region0: [0, 255, 4], region1: [1, 2, 255], flags: [1, 0, 1] });
  return {
    pca: sha(pca.mean, pca.axes, pca.variance),
    projections: sha(Z),
    placed: sha(placed.raw),
    kmeans: sha(km.centres, km.assign),
    codecs: sha(land, cols),
  };
}
// sha256 of the golden set's mean, axes and variance (Float64, little-endian),
// recorded under Node 26 and checked under Bun 1.4.3 by the bun leg. A change
// here means the PCA arithmetic changed: every stored basis would differ.
const GOLDEN_PCA = '36680b7ff9c368e9bc8af4a64f3e182084ef25475dd938c711d0cfc739086afd';

// ── PCA ─────────────────────────────────────────────────────────────────────

describe('PCA', () => {
  test('axes are orthonormal to 1e-9 and the variance never increases', () => {
    const { X } = clusteredVectors(400, 64, 1);
    const pca = L.randomizedPCA(X, 400, 64);
    assert.equal(pca.k, 50);
    assert.equal(pca.axes.length, 50 * 64);
    for (let a = 0; a < pca.k; a++) {
      for (let b = a; b < pca.k; b++) {
        let s = 0;
        for (let j = 0; j < 64; j++) { s += pca.axes[a * 64 + j] * pca.axes[b * 64 + j]; }
        assert.ok(Math.abs(s - (a === b ? 1 : 0)) <= 1e-9, `axes ${a}·${b} = ${s}`);
      }
    }
    for (let c = 1; c < pca.k; c++) { assert.ok(pca.variance[c] <= pca.variance[c - 1], `variance ${c}`); }
    let sum = 0;
    for (const v of pca.variance) { sum += v; }
    assert.ok(sum <= pca.totalVariance * (1 + 1e-9), 'kept variance ≤ total variance');
  });

  test('each axis has its largest-|component| positive', () => {
    const { X } = clusteredVectors(200, 40, 2);
    const pca = L.randomizedPCA(X, 200, 40);
    for (let c = 0; c < pca.k; c++) {
      let bi = 0;
      for (let j = 1; j < 40; j++) { if (Math.abs(pca.axes[c * 40 + j]) > Math.abs(pca.axes[c * 40 + bi])) { bi = j; } }
      assert.ok(pca.axes[c * 40 + bi] > 0, `axis ${c}`);
    }
  });

  test('tiny samples clamp k: n = 20 and n = 2 do not throw, n = 1 keeps no axes', () => {
    const { X } = clusteredVectors(20, 64, 3);
    const p20 = L.randomizedPCA(X, 20, 64);
    assert.equal(p20.k, 19);
    assert.equal(L.pcaComponents(64, 20), 19);
    const p2 = L.randomizedPCA(X.subarray(0, 2 * 64), 2, 64);
    assert.equal(p2.k, 1);
    let s = 0;
    for (let j = 0; j < 64; j++) { s += p2.axes[j] ** 2; }
    assert.ok(Math.abs(s - 1) < 1e-12, 'the one axis is a unit vector');
    const p1 = L.randomizedPCA(X.subarray(0, 64), 1, 64);
    assert.equal(p1.k, 0);
    assert.equal(p1.axes.length, 0);
    assert.equal(L.pcaComponents(8, 1000), 8, 'an 8-d model keeps 8');
    const z = L.projectRows(X.subarray(0, 64), 1, 64, L.basisF32(p1));
    assert.equal(z.length, 0);
  });

  test('the Rademacher basis is golden (bit-identical across runtimes)', () => {
    const digest = crossRuntimeDigest(L, goldenSet, crypto);
    assert.equal(digest.pca, GOLDEN_PCA);
  });

  test('projections with the stored f32 basis match, and the blobs round-trip', () => {
    const { X } = clusteredVectors(300, 32, 4);
    const pca = L.randomizedPCA(X, 300, 32, { k: 10 });
    const basis = L.basisF32(pca);
    const mean = L.f32FromBytes(L.f32ToBytes(basis.mean), 32);
    const axes = L.f32FromBytes(L.f32ToBytes(basis.axes), 10 * 32);
    assert.deepEqual(mean, basis.mean);
    assert.deepEqual(axes, basis.axes);
    const z1 = L.projectRows(X, 300, 32, basis);
    const z2 = L.projectRows(X, 300, 32, { k: 10, dim: 32, mean, axes });
    assert.equal(sha(z1), sha(z2));
    // The projected sample is centred (to f32 noise).
    for (let c = 0; c < 10; c++) {
      let s = 0;
      for (let i = 0; i < 300; i++) { s += z1[i * 10 + c]; }
      assert.ok(Math.abs(s / 300) < 1e-5, `component ${c} mean ${s / 300}`);
    }
  });
});

// ── geometry ────────────────────────────────────────────────────────────────

describe('geometry', () => {
  const synthRaw = (n, seed) => {
    const rand = L.mulberry32(seed);
    const raw = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const t = gaussian(rand) * 8, u = gaussian(rand);   // an 8:1 cloud along 10°
      raw[2 * i] = 0.985 * t - 0.174 * u + 3;
      raw[2 * i + 1] = 0.174 * t + 0.985 * u - 5;
    }
    return raw;
  };

  test('the affine round-trips raw → map → raw to 1e-9', () => {
    const raw = synthRaw(500, 5);
    const { affine } = L.layoutAffine(raw);
    const map = L.applyAffine(affine, raw);
    const back = L.applyAffine(L.invertAffine(affine), map);
    for (let i = 0; i < raw.length; i++) { assert.ok(Math.abs(back[i] - raw[i]) <= 1e-9, `coordinate ${i}`); }
    const rand = L.mulberry32(6);
    for (let t = 0; t < 20; t++) {
      const A = [rand() * 4 - 2, rand() * 4 - 2, rand() * 10, rand() * 4 - 2, rand() * 4 - 2, rand() * 10];
      const p = [rand() * 50 - 25, rand() * 50 - 25];
      const q = L.applyAffine(L.invertAffine(A), L.applyAffine(A, p));
      assert.ok(Math.abs(q[0] - p[0]) <= 1e-9 && Math.abs(q[1] - p[1]) <= 1e-9);
    }
  });

  test('the layout fits [0.04, 0.96]² with the aspect kept', () => {
    const raw = synthRaw(800, 7);
    const { affine, aspect } = L.layoutAffine(raw);
    const map = L.applyAffine(affine, raw);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 800; i++) {
      x0 = Math.min(x0, map[2 * i]); x1 = Math.max(x1, map[2 * i]);
      y0 = Math.min(y0, map[2 * i + 1]); y1 = Math.max(y1, map[2 * i + 1]);
    }
    assert.ok(Math.abs(Math.max(x1 - x0, y1 - y0) - 0.92) < 1e-9, 'the longer side spans 0.92');
    assert.ok(Math.abs((x1 - x0) / (y1 - y0) - aspect) < 1e-9, 'aspect = width / height');
    assert.ok(x0 >= 0.04 - 1e-12 && x1 <= 0.96 + 1e-12 && y0 >= 0.04 - 1e-12 && y1 <= 0.96 + 1e-12);
    assert.ok(Math.abs((x0 + x1) / 2 - 0.5) < 1e-9 && Math.abs((y0 + y1) / 2 - 0.5) < 1e-9, 'centred');
  });

  test('the rotation minimises |ln aspect| among the scanned angles', () => {
    const raw = synthRaw(600, 8);
    const rot = L.rotateNearSquare(raw);
    assert.equal(rot.deg % 3, 0);
    assert.ok(rot.deg >= 0 && rot.deg <= 177);
    for (let deg = 0; deg < 180; deg += 3) {
      assert.ok(L.rotationScore(raw, deg) >= rot.score, `${deg}° beats ${rot.deg}°`);
    }
    assert.ok(rot.score - rot.deg * 1e-4 < 0.2, 'the chosen box is near square');
    assert.ok(L.rotationScore(raw, 0) - 0 > 0.5, 'the unrotated cloud is not');
  });

  test('the flip rule holds: x follows PC1, y grows against PC2', () => {
    const rand = L.mulberry32(9);
    const n = 300, k = 3;
    const z = new Float32Array(n * k);
    for (let i = 0; i < n * k; i++) { z[i] = gaussian(rand); }
    for (const [sx, sy, swap] of [[1, 1, false], [-1, 1, false], [1, -1, false], [-1, -1, true]]) {
      const raw = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const a = z[i * k] * 3 + 0.3 * gaussian(rand), b = z[i * k + 1] + 0.3 * gaussian(rand);
        raw[2 * i] = sx * (swap ? b : a);
        raw[2 * i + 1] = sy * (swap ? a : b);
      }
      const { affine } = L.layoutAffine(raw, { z, k });
      const map = L.applyAffine(affine, raw);
      assert.ok(corr(n, (i) => z[i * k], (i) => map[2 * i]) >= 0, 'corr(Z0, x) ≥ 0');
      assert.ok(corr(n, (i) => z[i * k + 1], (i) => map[2 * i + 1]) <= 0, 'corr(Z1, y) ≤ 0');
    }
  });

  test('one point maps to (0.5, 0.5); a zero-span axis stays finite', () => {
    const one = L.layoutAffine(L.pca2Raw(new Float32Array(0), 0, 1));
    assert.deepEqual(Array.from(L.applyAffine(one.affine, [0, 0])), [0.5, 0.5]);
    assert.equal(one.aspect, 1);
    assert.equal(one.deg, 0);
    const far = L.layoutAffine([123.5, -77]);
    assert.deepEqual(Array.from(L.applyAffine(far.affine, [123.5, -77])), [0.5, 0.5]);
    // Two songs: k = 1, raw = (Z0, 0).
    const z2 = Float32Array.from([-0.3, 0.3]);
    const raw2 = L.pca2Raw(z2, 1, 2);
    assert.deepEqual(Array.from(raw2), [Math.fround(-0.3), 0, Math.fround(0.3), 0]);
    const two = L.layoutAffine(raw2, { z: z2, k: 1 });
    const m2 = L.applyAffine(two.affine, raw2);
    for (const v of m2) { assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${v}`); }
    assert.ok(Number.isFinite(two.aspect));
    const flat = L.fitBox([0, 5, 2, 5, 4, 5]);
    assert.ok(Number.isFinite(flat.scale) && flat.aspect === 1);
    const flatMap = L.applyAffine(L.composeAffine({ box: flat }), [0, 5, 4, 5]);
    [0.04, 0.5, 0.96, 0.5].forEach((v, i) => assert.ok(Math.abs(flatMap[i] - v) < 1e-12, `${flatMap[i]} vs ${v}`));
    assert.throws(() => L.layoutAffine([0, NaN]), /non-finite/);
  });

  test('fitBox, the rotation scan and the layout handle 200,000 points (no spread arguments)', () => {
    const rand = L.mulberry32(10);
    const raw = new Float64Array(400000);
    for (let i = 0; i < raw.length; i++) { raw[i] = rand() * 40 - 20; }
    const box = L.fitBox(raw);
    assert.ok(Number.isFinite(box.scale) && box.scale > 0);
    const { affine } = L.layoutAffine(raw);
    assert.ok(affine.every(Number.isFinite));
    assert.equal(L.rawSpan(raw).length, 2);
  });

  test('procrustes recovers a rotation, scale and shift; it never reflects', () => {
    const raw = synthRaw(200, 11);
    const T = { R: [Math.cos(0.7), -Math.sin(0.7), Math.sin(0.7), Math.cos(0.7)], s: 2.5, t: [4, -9] };
    const B = L.applySimilarity(T, raw);
    const fit = L.procrustes(raw, B);
    const back = L.applySimilarity(fit, B);
    for (let i = 0; i < raw.length; i++) { assert.ok(Math.abs(back[i] - raw[i]) < 1e-9); }
    assert.ok(fit.disparity < 1e-12);
    assert.ok(Math.abs(fit.s - 1 / 2.5) < 1e-12);
    // An asymmetric cloud (an elongated one mirrored is nearly a rotation of itself).
    const rand = L.mulberry32(41);
    const blob = new Float64Array(400);
    for (let i = 0; i < 200; i++) { blob[2 * i] = rand() ** 3 * 10; blob[2 * i + 1] = rand() * 4 + (blob[2 * i] > 5 ? 3 : 0); }
    const mirrored = Float64Array.from(blob);
    for (let i = 0; i < 200; i++) { mirrored[2 * i] = -mirrored[2 * i]; }
    const m = L.procrustes(blob, mirrored);
    assert.ok(Math.abs(m.R[0] * m.R[3] - m.R[1] * m.R[2] - 1) < 1e-12, 'det R = +1');
    assert.ok(m.disparity > 0.1, 'a mirror image is not a rotation');
  });

  test('a refit keeps the affine unless more than 1 % of points leave [−0.02, 1.02]²', () => {
    const inside = new Float64Array(200).fill(0.5);
    for (let i = 0; i < 1; i++) { inside[2 * i] = 1.1; }
    assert.equal(L.needsBoxRefit(inside), false, '1 of 100 outside is not more than 1 %');
    inside[2] = -0.5;
    assert.equal(L.needsBoxRefit(inside), true);
    const A = [2, 0, 0.1, 0, 2, 0.2];
    const raw = Float64Array.from([0, 0, 1, 0.5, 0.25, 1]);
    const map = L.applyAffine(A, raw);
    const { affine } = L.refitAffine(A, map);
    const refit = L.applyAffine(affine, raw);
    const box = L.fitBox(refit);
    assert.ok(Math.abs(box.scale - 1) < 1e-9, 'the refit box is already fitted');
  });
});

// ── kNN placement and the displacement field ────────────────────────────────

describe('kNN placement', () => {
  const k = 8;
  const fitSet = (nRef, seed) => {
    const rand = L.mulberry32(seed);
    const refZ = new Float32Array(nRef * k), refRaw = new Float64Array(2 * nRef);
    for (let i = 0; i < nRef * k; i++) { refZ[i] = gaussian(rand); }
    for (let i = 0; i < nRef; i++) { refRaw[2 * i] = refZ[i * k] * 5 + rand(); refRaw[2 * i + 1] = refZ[i * k + 1] * 5 + rand(); }
    return { refZ, refRaw };
  };
  const brute = (refZ, nRef, q, kk) => {
    const d = [];
    for (let r = 0; r < nRef; r++) {
      let s = 0;
      for (let j = 0; j < k; j++) { s += (q[j] - refZ[r * k + j]) ** 2; }
      d.push([s, r]);
    }
    d.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return d.slice(0, kk);
  };

  test('a placement is the inverse-square-weighted mean of its 10 nearest references', () => {
    const { refZ, refRaw } = fitSet(400, 12);
    const rand = L.mulberry32(13);
    const queryZ = new Float32Array(50 * k);
    for (let i = 0; i < queryZ.length; i++) { queryZ[i] = gaussian(rand); }
    const { pre, raw } = L.knnPlace({ refZ, refRaw, k, queryZ });
    for (let q = 0; q < 50; q++) {
      const nb = brute(refZ, 400, queryZ.subarray(q * k, q * k + k), 10);
      let wx = 0, wy = 0, ws = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [d2, r] of nb) {
        const w = 1 / (1e-6 + d2);
        wx += w * refRaw[2 * r]; wy += w * refRaw[2 * r + 1]; ws += w;
        x0 = Math.min(x0, refRaw[2 * r]); x1 = Math.max(x1, refRaw[2 * r]);
        y0 = Math.min(y0, refRaw[2 * r + 1]); y1 = Math.max(y1, refRaw[2 * r + 1]);
      }
      assert.ok(Math.abs(pre[2 * q] - wx / ws) < 1e-9 && Math.abs(pre[2 * q + 1] - wy / ws) < 1e-9, `query ${q}`);
      assert.ok(pre[2 * q] >= x0 - 1e-12 && pre[2 * q] <= x1 + 1e-12, 'convex in x');
      assert.ok(pre[2 * q + 1] >= y0 - 1e-12 && pre[2 * q + 1] <= y1 + 1e-12, 'convex in y');
      assert.equal(raw[2 * q], pre[2 * q], 'no hashes, no jitter');
    }
  });

  test('an exact duplicate lands on its twin, within the jitter bound', () => {
    const { refZ, refRaw } = fitSet(300, 14);
    const [sx, sy] = L.rawSpan(refRaw);
    const twins = [3, 77, 150, 299];
    const queryZ = new Float32Array(twins.length * k);
    twins.forEach((r, q) => queryZ.set(refZ.subarray(r * k, r * k + k), q * k));
    const hashes = ['0f0f0f0fdeadbeef', 'ffffffff00000000', '00000000ffffffff', 'not-a-hex-hash'];
    const { pre, raw } = L.knnPlace({ refZ, refRaw, k, queryZ, hashes });
    twins.forEach((r, q) => {
      assert.ok(Math.abs(pre[2 * q] - refRaw[2 * r]) <= 1e-3 * sx, 'the twin dominates x');
      assert.ok(Math.abs(pre[2 * q + 1] - refRaw[2 * r + 1]) <= 1e-3 * sy, 'the twin dominates y');
      assert.ok(Math.abs(raw[2 * q] - pre[2 * q]) <= L.JITTER_SHARE * sx + 1e-12);
      assert.ok(Math.abs(raw[2 * q + 1] - pre[2 * q + 1]) <= L.JITTER_SHARE * sy + 1e-12);
    });
  });

  test('the jitter is deterministic, bounded and per hash', () => {
    const a = L.jitterFromHash('8a6f0c2e11d34b5a9c0e7f6d5c4b3a29', 40, 30);
    assert.deepEqual(L.jitterFromHash('8a6f0c2e11d34b5a9c0e7f6d5c4b3a29', 40, 30), a);
    assert.notDeepEqual(L.jitterFromHash('8a6f0c2f11d34b5a9c0e7f6d5c4b3a29', 40, 30), a);
    assert.deepEqual(L.jitterFromHash('ffffffff', 40, 30), [L.JITTER_SHARE * 40, L.JITTER_SHARE * 30]);
    assert.deepEqual(L.jitterFromHash('00000000', 40, 30), [-L.JITTER_SHARE * 40, -L.JITTER_SHARE * 30]);
    for (const h of randomHashes(200, 15).concat(['x', 'track-7', ''])) {
      const [jx, jy] = L.jitterFromHash(h, 40, 30);
      assert.ok(Math.abs(jx) <= L.JITTER_SHARE * 40 && Math.abs(jy) <= L.JITTER_SHARE * 30);
    }
    assert.equal(L.hashSeed32('deadbeef00'), 0xdeadbeef);
    assert.equal(L.hashSeed32('zz'), L.hashSeed32('zz'));
  });

  test('placing 1,000 points in one batch or in ten gives identical bytes', () => {
    const { refZ, refRaw } = fitSet(500, 16);
    const rand = L.mulberry32(17);
    const queryZ = new Float32Array(1000 * k);
    for (let i = 0; i < queryZ.length; i++) { queryZ[i] = gaussian(rand); }
    const hashes = randomHashes(1000, 18);
    const span = L.rawSpan(refRaw);
    const one = L.knnPlace({ refZ, refRaw, k, queryZ, hashes, span });
    const tenRaw = new Float64Array(2000), tenPre = new Float64Array(2000);
    for (let b = 0; b < 10; b++) {
      const part = L.knnPlace({ refZ, refRaw, k, queryZ: queryZ.subarray(b * 100 * k, (b + 1) * 100 * k), hashes: hashes.slice(b * 100, (b + 1) * 100), span });
      tenRaw.set(part.raw, b * 200);
      tenPre.set(part.pre, b * 200);
    }
    assert.equal(sha(one.raw), sha(tenRaw));
    assert.equal(sha(one.pre), sha(tenPre));
  });

  test('near pairs are the kept neighbours within the bound', () => {
    const { refZ, refRaw } = fitSet(100, 19);
    const queryZ = new Float32Array(2 * k);
    queryZ.set(refZ.subarray(10 * k, 11 * k), 0);
    for (let j = 0; j < k; j++) { queryZ[k + j] = refZ[20 * k + j] + (j === 0 ? 0.05 : 0); }
    const { near } = L.knnPlace({ refZ, refRaw, k, queryZ, nearBound: L.MAP_PCA_NEAR_DUP_BOUND });
    assert.deepEqual(near, [[0, 10], [1, 20]]);
  });

  test('the displacement field carries points with their landmarks; the grid search is exact', () => {
    const rand = L.mulberry32(20);
    const oldL = new Float64Array(2 * 500), pts = new Float64Array(2 * 300);
    for (let i = 0; i < oldL.length; i++) { oldL[i] = rand() * 10; }
    for (let i = 0; i < pts.length; i++) { pts[i] = rand() * 12 - 1; }   // some outside the landmarks' box
    const shifted = oldL.map((v, i) => v + (i % 2 ? -0.75 : 2));
    const moved = L.displacementField({ oldL, newL: shifted, points: pts });
    for (let p = 0; p < 300; p++) {
      assert.ok(Math.abs(moved[2 * p] - pts[2 * p] - 2) < 1e-9 && Math.abs(moved[2 * p + 1] - pts[2 * p + 1] + 0.75) < 1e-9);
    }
    // A field that varies: compare with brute-force 8 nearest.
    const newL = oldL.map((v, i) => v + Math.sin(i));
    const got = L.displacementField({ oldL, newL, points: pts });
    for (let p = 0; p < 300; p++) {
      const d = [];
      for (let i = 0; i < 500; i++) { d.push([(oldL[2 * i] - pts[2 * p]) ** 2 + (oldL[2 * i + 1] - pts[2 * p + 1]) ** 2, i]); }
      d.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let wx = 0, wy = 0, ws = 0;
      for (const [d2, i] of d.slice(0, 8)) { const w = 1 / (1e-6 + d2); wx += w * (newL[2 * i] - oldL[2 * i]); wy += w * (newL[2 * i + 1] - oldL[2 * i + 1]); ws += w; }
      assert.ok(Math.abs(got[2 * p] - (pts[2 * p] + wx / ws)) < 1e-9, `point ${p} x`);
      assert.ok(Math.abs(got[2 * p + 1] - (pts[2 * p + 1] + wy / ws)) < 1e-9, `point ${p} y`);
    }
    assert.deepEqual(Array.from(L.displacementField({ oldL: new Float64Array(0), newL: new Float64Array(0), points: [1, 2] })), [1, 2]);
  });
});

// ── near-duplicate dots ─────────────────────────────────────────────────────

describe('near-duplicates', () => {
  // Unit f32 vectors; twin(a, c) has cosine c with a.
  const d = 32;
  const randUnit = (rand) => {
    const v = new Float64Array(d);
    for (let j = 0; j < d; j++) { v[j] = gaussian(rand); }
    const s = Math.sqrt(v.reduce((t, x) => t + x * x, 0));
    return v.map((x) => x / s);
  };
  const twin = (a, c, rand) => {
    const u = randUnit(rand);
    let dot = 0;
    for (let j = 0; j < d; j++) { dot += u[j] * a[j]; }
    const w = u.map((x, j) => x - dot * a[j]);
    const s = Math.sqrt(w.reduce((t, x) => t + x * x, 0));
    return a.map((x, j) => c * x + Math.sqrt(1 - c * c) * w[j] / s);
  };

  test('the threshold is discovery-novelty.js NEAR_DUP, and the PCA bound covers it', () => {
    assert.equal(L.MAP_NEAR_DUP, NEAR_DUP);
    assert.ok(L.MAP_PCA_NEAR_DUP_BOUND >= Math.sqrt(2 - 2 * L.MAP_NEAR_DUP));
    assert.ok(L.MAP_PCA_NEAR_DUP_BOUND - Math.sqrt(2 - 2 * L.MAP_NEAR_DUP) < 1e-3);
  });

  test('cos 0.995 → one dot, cos 0.98 → two (PCA pre-filter, exact verify)', () => {
    const rand = L.mulberry32(21);
    const vecs = [];
    for (let i = 0; i < 40; i++) { vecs.push(randUnit(rand)); }
    vecs.push(twin(vecs[0], 0.995, rand));   // 40
    vecs.push(twin(vecs[1], 0.98, rand));    // 41
    const n = vecs.length;
    const X = new Float32Array(n * d);
    vecs.forEach((v, i) => X.set(v, i * d));
    const pca = L.randomizedPCA(X, n, d);
    const Z = L.projectRows(X, n, d, L.basisF32(pca));
    const hashes = vecs.map((_, i) => `h${String(i).padStart(3, '0')}`);
    const idx = (h) => Number(h.slice(1));
    const verify = (a, b) => L.cosine(X.subarray(idx(a) * d, idx(a) * d + d), X.subarray(idx(b) * d, idx(b) * d + d)) >= L.MAP_NEAR_DUP;
    const xy = new Float64Array(2 * n);   // everything in one cell: the PCA bound does the filtering
    const pairs = L.gridCandidates(xy, 1, { z: Z, k: pca.k }).map(([a, b]) => [hashes[a], hashes[b]]);
    assert.deepEqual(pairs, [['h000', 'h040']]);
    const dotOf = L.groupNearDuplicates(pairs, verify, null, { hashes });
    assert.equal(dotOf.get('h040'), 'h000');
    assert.equal(dotOf.get('h000'), 'h000');
    assert.equal(dotOf.get('h041'), 'h041');
    assert.equal(dotOf.get('h001'), 'h001');
  });

  test('a candidate inside the PCA bound but under cos 0.99 stays two dots', () => {
    const rand = L.mulberry32(22);
    const n = 60, D = 32;
    const X = new Float32Array((n + 2) * D);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < D; j++) { X[i * D + j] = (j < 4 ? 3 * gaussian(rand) : 0.01 * gaussian(rand)); }
    }
    const a = new Float64Array(D);
    a[0] = 1; a[1] = 0.5;
    const b = Float64Array.from(a);
    b[20] = 0.19;   // the difference lives on an axis PCA drops
    const norm = (v) => { const s = Math.sqrt(v.reduce((t, x) => t + x * x, 0)); return v.map((x) => x / s); };
    X.set(norm(a), n * D);
    X.set(norm(b), (n + 1) * D);
    const pca = L.randomizedPCA(X, n + 2, D, { k: 4 });
    const Z = L.projectRows(X, n + 2, D, L.basisF32(pca));
    let dz = 0;
    for (let j = 0; j < 4; j++) { dz += (Z[n * 4 + j] - Z[(n + 1) * 4 + j]) ** 2; }
    const cos = L.cosine(X.subarray(n * D, n * D + D), X.subarray((n + 1) * D));
    assert.ok(Math.sqrt(dz) <= L.MAP_PCA_NEAR_DUP_BOUND && cos < L.MAP_NEAR_DUP, 'precondition');
    const hashes = ['a', 'b'];
    const calls = [];
    const dotOf = L.groupNearDuplicates([['a', 'b']], (x, y) => { calls.push([x, y]); return cos >= L.MAP_NEAR_DUP; }, null, { hashes });
    assert.deepEqual(calls, [['a', 'b']]);
    assert.equal(dotOf.get('a'), 'a');
    assert.equal(dotOf.get('b'), 'b');
  });

  test('the grid pass finds a placed↔placed pair the placement kNN cannot see', () => {
    const rand = L.mulberry32(23);
    const k = 6, nRef = 200;
    const refZ = new Float32Array(nRef * k), refRaw = new Float64Array(2 * nRef);
    for (let i = 0; i < refZ.length; i++) { refZ[i] = gaussian(rand); }
    for (let i = 0; i < nRef; i++) { refRaw[2 * i] = refZ[i * k] * 4; refRaw[2 * i + 1] = refZ[i * k + 1] * 4; }
    const queryZ = new Float32Array(3 * k);
    for (let j = 0; j < k; j++) { queryZ[j] = 0.3 + j * 0.1; queryZ[k + j] = queryZ[j] + 0.01; queryZ[2 * k + j] = -2 + j; }
    const { pre, near } = L.knnPlace({ refZ, refRaw, k, queryZ, hashes: ['p0', 'p1', 'p2'], nearBound: L.MAP_PCA_NEAR_DUP_BOUND });
    assert.deepEqual(near, [], 'neither placed point is a near-duplicate of a landmark');
    const [sx, sy] = L.rawSpan(refRaw);
    const pairs = L.gridCandidates(pre, L.GRID_CELL_SHARE * Math.max(sx, sy), { z: queryZ, k });
    assert.deepEqual(pairs, [[0, 1]]);
  });

  test('fitted pairs come from the kNN graph under the bound, each once', () => {
    const knnIndices = [[0, 1, 2], [1, 0, 2], [2, 0, 1]];
    const knnDistances = [[0, 0.1, 0.5], [0, 0.1, 0.2], [0, 0.14, 0.2]];
    assert.deepEqual(L.knnGraphPairs(knnIndices, knnDistances), [[0, 1], [0, 2]]);
  });

  test('previous groups carry over while they still verify', () => {
    const hashes = ['a', 'b', 'c', 'd'];
    const good = new Set(['a|b']);
    const verify = (x, y) => good.has(`${x < y ? x : y}|${x < y ? y : x}`);
    const previous = new Map([['a', 'a'], ['b', 'a'], ['c', 'c'], ['d', 'c']]);
    const dotOf = L.groupNearDuplicates([], verify, previous, { hashes });
    assert.equal(dotOf.get('b'), 'a', 'a–b still verifies: kept without a candidate pair');
    assert.equal(dotOf.get('d'), 'd', 'c–d no longer verifies: split');
    assert.equal(dotOf.get('c'), 'c');
  });

  test('labels never change when a member is renamed (place runs keep labels)', () => {
    // Group {A, B} labelled 'A'; A re-keyed to Z. Singleton P re-keyed to Q.
    const previous = new Map([['Z', 'A'], ['B', 'A'], ['Q', 'P'], ['M', 'M'], ['N', 'D']]);
    const hashes = ['B', 'C', 'M', 'N', 'Q', 'Z', 'E', 'F'].sort();
    const verify = () => true;
    const pairs = [['B', 'C'], ['M', 'N'], ['E', 'F']];
    const dotOf = L.groupNearDuplicates(pairs, verify, previous, { hashes, keepLabels: true });
    assert.equal(dotOf.get('Z'), 'A', 'the re-keyed label member keeps the label');
    assert.equal(dotOf.get('B'), 'A');
    assert.equal(dotOf.get('C'), 'A', 'a new member takes the group label');
    assert.equal(dotOf.get('Q'), 'P', 'a re-keyed singleton keeps its own old label');
    assert.equal(dotOf.get('M'), 'D', 'merging groups keep the smaller label');
    assert.equal(dotOf.get('N'), 'D');
    assert.equal(dotOf.get('E'), 'E', 'a group of new points takes its smallest hash');
    assert.equal(dotOf.get('F'), 'E');
    const groups = L.groupsOf(dotOf);
    assert.deepEqual([...groups.keys()], ['A', 'D', 'E', 'P']);
    assert.deepEqual(groups.get('A'), ['B', 'C', 'Z']);
  });
});

// ── regions ─────────────────────────────────────────────────────────────────

describe('regions', () => {
  const town = (style, n) => Array.from({ length: n }, () => style);

  test('townCount reproduces K = 22 at 2,003 songs and its clamps', () => {
    assert.equal(L.townCount(2003), 22);
    assert.equal(L.townCount(3), 2);
    assert.equal(L.townCount(1), 1);
    assert.equal(L.townCount(10 ** 6), 120);
    assert.equal(L.townCount(30, { small: true }), 3);
    assert.equal(L.townCount(1, { small: true }), 1);
    assert.equal(L.townCount(0), 0);
  });

  test('k-means++ is deterministic and keeps the lowest-inertia restart', () => {
    const { xy } = blobMap(1500, 24);
    const a = L.kmeansPP(xy, 12);
    const b = L.kmeansPP(xy, 12);
    assert.equal(sha(a.centres, a.assign), sha(b.centres, b.assign));
    let best = Infinity;
    for (let r = 0; r < L.TOWN_RESTARTS; r++) { best = Math.min(best, L.kmeansPP(xy, 12, { restarts: 1, seed: L.TOWN_SEED + r }).inertia); }
    assert.equal(a.inertia, best);
    for (let i = 0; i < 1500; i++) {
      const own = (xy[2 * i] - a.centres[2 * a.assign[i]]) ** 2 + (xy[2 * i + 1] - a.centres[2 * a.assign[i] + 1]) ** 2;
      for (let c = 0; c < 12; c++) {
        assert.ok(own <= (xy[2 * i] - a.centres[2 * c]) ** 2 + (xy[2 * i + 1] - a.centres[2 * c + 1]) ** 2 + 1e-15);
      }
    }
  });

  // Measured over 40 seeds of atlasMap: warm Lloyd keeps 95.5–100 % (mean
  // 99.5 %), fresh k-means++ 82 % on average — the design map gave 20–21 of
  // 21 against 13–20 (the plan's robustness review: 22 of 22 against 15).
  test('warm Lloyd keeps ≥ 95 % of town keys after +10 % songs on a 2,000-dot map', () => {
    const xy = atlasMap(2200, 25);
    const old = xy.subarray(0, 4000);
    const K0 = L.townCount(2000), K1 = L.townCount(2200);
    assert.equal(K0, 22);
    assert.equal(K1, 23, 'K1 grows by one: the resize path runs too');
    const fresh = L.kmeansPP(old, K0);
    const oldTowns = L.compactClusters(L.assignNearest(old, fresh.centres), fresh.centres);
    const sets = (assign, K) => {
      const out = Array.from({ length: K }, () => new Set());
      for (let i = 0; i < assign.length; i++) { out[assign[i]].add(`d${i}`); }
      return out;
    };
    const olds = sets(oldTowns.assign, oldTowns.sizes.length).map((members, j) => ({ key: `t:${j}`, members }));
    const warm = L.lloyd(xy, L.resizeCentres(oldTowns.centres, K1, xy));
    const now = L.compactClusters(L.assignNearest(xy, warm.centres), warm.centres);
    const match = L.matchRegionKeys(sets(now.assign, now.sizes.length), olds);
    const kept = new Set([...match].filter((o) => o >= 0));
    assert.ok(kept.size / olds.length >= 0.95, `kept ${kept.size} of ${olds.length}`);
  });

  test('K1 + 1 adds exactly one centre at the farthest point; K1 − 1 drops the smallest town', () => {
    const { xy } = blobMap(800, 26);
    const base = L.kmeansPP(xy, 9).centres;
    const grown = L.resizeCentres(base, 10, xy);
    assert.equal(grown.length, 20);
    assert.deepEqual(Array.from(grown.subarray(0, 18)), Array.from(base));
    let bi = -1, bv = -1;
    for (let i = 0; i < 800; i++) {
      let d = Infinity;
      for (let c = 0; c < 9; c++) { d = Math.min(d, (xy[2 * i] - base[2 * c]) ** 2 + (xy[2 * i + 1] - base[2 * c + 1]) ** 2); }
      if (d > bv) { bv = d; bi = i; }
    }
    assert.deepEqual([grown[18], grown[19]], [xy[2 * bi], xy[2 * bi + 1]]);
    const sizes = new Int32Array(9);
    for (const a of L.assignNearest(xy, base)) { sizes[a]++; }
    let smallest = 0;
    for (let c = 1; c < 9; c++) { if (sizes[c] < sizes[smallest] || (sizes[c] === sizes[smallest] && c > smallest)) { smallest = c; } }
    const shrunk = L.resizeCentres(base, 8, xy);
    const expect = [];
    for (let c = 0; c < 9; c++) { if (c !== smallest) { expect.push(base[2 * c], base[2 * c + 1]); } }
    assert.deepEqual(Array.from(shrunk), expect);
  });

  test('share × √lift picks the boards\' style; the most common style is the fallback', () => {
    const global = new Map([['Hip Hop---Boom Bap', 400], ['Hip Hop---Jazzy Hip-Hop', 60], ['Hip Hop---Instrumental', 20], ['Rock---Indie Rock', 1520]]);
    const members = [...town('Hip Hop---Boom Bap', 40), ...town('Hip Hop---Jazzy Hip-Hop', 30), ...town('Hip Hop---Instrumental', 10), ...town(null, 20)];
    const lab = L.townLabel(members, global, 2000);
    assert.deepEqual(lab, { style: 'Hip Hop---Jazzy Hip-Hop', label: 'Jazzy Hip-Hop', genre: 'Hip Hop' });
    const thin = L.townLabel([...town('Rock---Indie Rock', 10), ...town('Jazz---Bop', 9), ...town(null, 81)], global, 2000);
    assert.equal(thin.style, 'Rock---Indie Rock', 'no style reaches 15 %: the most common one');
    assert.deepEqual(L.townLabel(town(null, 5), global, 2000), { style: null, label: null, genre: null });
    const instrumental = L.townLabel(town('Hip Hop---Instrumental', 5), global, 2000);
    assert.equal(instrumental.label, 'Instrumental Hip-Hop');
  });

  test('the raw top-style parse survives junk', () => {
    assert.equal(L.topStyle('["Hip Hop---Boom Bap","Hip Hop---Jazzy Hip-Hop"]'), 'Hip Hop---Boom Bap');
    assert.equal(L.topStyle('not json'), null);
    assert.equal(L.topStyle('{"a":1}'), null);
    assert.equal(L.topStyle('"Rock---Indie"'), null);
    assert.equal(L.topStyle('[1, null, {"x":"Rock---Indie"}, ["Rock---Indie"]]'), null);
    assert.equal(L.topStyle('["Rock", "---Indie", "Rock---", "  Jazz --- Bop  "]'), 'Jazz---Bop');
    assert.equal(L.topStyle(`["${'x'.repeat(200)}---y", "Pop---Indie Pop"]`), 'Pop---Indie Pop');
    assert.equal(L.topStyle(null), null);
    assert.equal(L.topStyle(''), null);
    assert.equal(L.topStyle('[]'), null);
  });

  test('DISPLAY_STYLE and SHORT_GENRE are applied', () => {
    assert.equal(L.styleDisplay('Hip Hop---Instrumental'), 'Instrumental Hip-Hop');
    assert.equal(L.styleDisplay('Hip Hop---Conscious'), 'Conscious Hip-Hop');
    assert.equal(L.styleDisplay('Classical---Modern'), 'Modern Classical');
    assert.equal(L.styleDisplay('Jazz---Hard Bop'), 'Hard Bop');
    assert.equal(L.genreLabel('Funk / Soul'), 'Soul');
    assert.equal(L.genreLabel('Folk, World, & Country'), 'Folk');
    assert.equal(L.genreLabel('Stage & Screen'), 'Score');
    assert.equal(L.genreLabel('Electronic'), 'Electronic');
    assert.equal(L.genreLabel('toString'), 'toString', 'no prototype lookups');
  });

  // Three towns: Rock (with a style-less neighbour town) and Jazz.
  const regionInput = () => {
    const rand = L.mulberry32(27);
    const groups = [
      { at: [0.25, 0.3], n: 120, style: (i) => (i % 10 === 0 ? 'Rock---Alternative Rock' : 'Rock---Indie Rock') },
      { at: [0.75, 0.7], n: 90, style: () => 'Funk / Soul---Neo Soul' },
      { at: [0.32, 0.45], n: 30, style: () => null },
    ];
    const n = groups.reduce((s, g) => s + g.n, 0);
    const xy = new Float64Array(2 * n), styles = [], members = [], townAssign = new Int32Array(n);
    const townCentres = new Float64Array(6);
    let i = 0;
    groups.forEach((g, t) => {
      townCentres[2 * t] = g.at[0];
      townCentres[2 * t + 1] = g.at[1];
      for (let j = 0; j < g.n; j++, i++) {
        xy[2 * i] = g.at[0] + 0.02 * gaussian(rand);
        xy[2 * i + 1] = g.at[1] + 0.02 * gaussian(rand);
        styles.push(g.style(j));
        members.push([`h${String(i).padStart(4, '0')}`]);
        townAssign[i] = t;
      }
    });
    return { xy, styles, members, townAssign, townCentres, n };
  };

  test('genre provinces: keys g:<Genre>, short labels, ids by size, a style-less town joins its nearest genre', () => {
    const inp = regionInput();
    const r = L.buildRegions(inp);
    assert.deepEqual(r.provinces.map((p) => [p.id, p.key, p.label, p.size]), [[0, 'g:Rock', 'Rock', 150], [1, 'g:Funk / Soul', 'Soul', 90]]);
    assert.deepEqual(r.towns.map((t) => [t.id, t.parent, t.label, t.size]), [[0, 0, 'Indie Rock', 120], [1, 0, null, 30], [2, 1, 'Neo Soul', 90]]);
    assert.ok(r.towns.every((t) => /^t:\d+$/.test(t.key)));
    assert.equal(new Set(r.towns.map((t) => t.key)).size, 3);
    assert.equal(r.nextKey, 3);
    assert.equal(r.provinces[0].style, 'Rock');
    assert.equal(r.towns[0].style, 'Rock---Indie Rock');
    // region columns, anchors on members, the province anchor = its biggest town's
    for (const t of r.towns) {
      for (const i of t.dots) { assert.equal(r.region1[i], t.id); assert.equal(r.region0[i], t.parent); }
      const onMember = Array.from(t.dots).some((i) => inp.xy[2 * i] === t.anchorX && inp.xy[2 * i + 1] === t.anchorY);
      assert.ok(onMember, `town ${t.id}'s anchor is a member`);
      assert.ok(t.extent > 0);
    }
    assert.deepEqual([r.provinces[0].anchorX, r.provinces[0].anchorY], [r.towns[0].anchorX, r.towns[0].anchorY]);
    assert.ok(r.provinces.every((p) => p.prevHue === null));
  });

  test('a refit keeps matched keys, names and hues; unmatched towns get new keys', () => {
    const inp = regionInput();
    const first = L.buildRegions(inp);
    const memberSet = (dots) => new Set(Array.from(dots).map((i) => inp.members[i][0]));
    const previous = {
      towns: first.towns.map((t) => ({ key: t.key, label: t.id === 0 ? 'Old Name' : t.label, style: t.id === 0 ? 'Rock---Old' : t.style, members: memberSet(t.dots) })),
      provinces: first.provinces.map((p) => ({ key: p.key, label: p.label, hue: p.id === 0 ? 300 : 150, members: memberSet(p.dots) })),
    };
    const again = L.buildRegions({ ...inp, previous, nextKey: first.nextKey });
    assert.deepEqual(again.towns.map((t) => t.key), first.towns.map((t) => t.key));
    assert.equal(again.towns[0].label, 'Old Name', 'a matched town keeps its name');
    assert.equal(again.towns[0].style, 'Rock---Old');
    assert.equal(again.towns[1].label, null, 'the style-less town stays unnamed');
    const unnamed = { ...previous, towns: previous.towns.map((t, j) => (j === 0 ? { ...t, label: null, style: null } : t)) };
    assert.equal(L.buildRegions({ ...inp, previous: unnamed, nextKey: first.nextKey }).towns[0].label, 'Indie Rock', 'an old null name gives way to the computed one');
    assert.deepEqual(again.provinces.map((p) => p.prevHue), [300, 150]);
    assert.equal(again.nextKey, first.nextKey);
    // An unknown previous: every town is new.
    const other = L.buildRegions({ ...inp, previous: { towns: [{ key: 't:99', label: 'X', members: ['zz'] }], provinces: [] }, nextKey: 7 });
    assert.deepEqual(other.towns.map((t) => t.key), ['t:7', 't:8', 't:9']);
  });

  test('a place run joins new dots to the nearest town and refreshes geometry with the same rules', () => {
    const inp = regionInput();
    const r = L.buildRegions(inp);
    const townCentres = Float64Array.from(r.towns.flatMap((t) => [t.x, t.y]));
    const townParent = Int32Array.from(r.towns, (t) => t.parent);
    const same = L.refreshRegionGeometry({ xy: inp.xy, region0: r.region0, region1: r.region1, nProvinces: 2, nTowns: 3, townCentres, townParent });
    for (const [mine, theirs] of [[same.provinces, r.provinces], [same.towns, r.towns]]) {
      mine.forEach((g, id) => {
        for (const f of ['size', 'x', 'y', 'anchorX', 'anchorY', 'extent']) { assert.equal(g[f], theirs[id][f], `${f} of region ${id}`); }
        assert.deepEqual(Array.from(g.dots), Array.from(theirs[id].dots));
      });
    }
    // Three new dots by the Soul town, one by the style-less town.
    const add = Float64Array.from([0.76, 0.71, 0.74, 0.69, 0.75, 0.7, 0.33, 0.44]);
    const placed = L.assignToTowns(add, townCentres, townParent);
    assert.deepEqual(Array.from(placed.region1), [2, 2, 2, 1]);
    assert.deepEqual(Array.from(placed.region0), [1, 1, 1, 0]);
    const xy = new Float64Array(inp.xy.length + add.length);
    xy.set(inp.xy);
    xy.set(add, inp.xy.length);
    const region0 = Uint8Array.from([...r.region0, ...placed.region0]), region1 = Uint8Array.from([...r.region1, ...placed.region1]);
    const after = L.refreshRegionGeometry({ xy, region0, region1, nProvinces: 2, nTowns: 3, townCentres, townParent });
    assert.deepEqual(after.towns.map((t) => t.size), [120, 31, 93]);
    assert.deepEqual(after.provinces.map((p) => p.size), [151, 93]);
    assert.equal(after.towns[2].x, r.towns[2].x, 'a town keeps its centre');
    // A town whose songs all left reports size 0 and no anchor.
    const gone = Uint8Array.from(region1, (t) => (t === 1 ? L.REGION_NONE : t));
    const emptied = L.refreshRegionGeometry({ xy, region0, region1: gone, nProvinces: 2, nTowns: 3, townCentres, townParent });
    assert.equal(emptied.towns[1].size, 0);
    assert.equal(emptied.towns[1].anchorX, null);
  });

  test('with no genre anywhere, provinces cluster the town centres: no names, c: keys', () => {
    const rand = L.mulberry32(28);
    const centres = [[0.2, 0.2], [0.25, 0.22], [0.22, 0.27], [0.8, 0.2], [0.77, 0.25], [0.82, 0.23], [0.5, 0.8], [0.45, 0.78], [0.52, 0.84]];
    const n = centres.length * 20;
    const xy = new Float64Array(2 * n), townAssign = new Int32Array(n), members = [];
    for (let i = 0; i < n; i++) {
      const t = Math.floor(i / 20);
      xy[2 * i] = centres[t][0] + 0.005 * gaussian(rand);
      xy[2 * i + 1] = centres[t][1] + 0.005 * gaussian(rand);
      townAssign[i] = t;
      members.push([`m${i}`]);
    }
    const townCentres = Float64Array.from(centres.flat());
    const r = L.buildRegions({ xy, styles: new Array(n).fill(null), members, townAssign, townCentres, nextKey: 5 });
    assert.equal(r.provinces.length, 3, 'K0 = round(9 / 3)');
    assert.ok(r.provinces.every((p) => p.label === null && /^c:\d+$/.test(p.key)));
    assert.ok(r.towns.every((t) => t.label === null));
    const groupOf = (t) => r.towns.find((x) => x.dots.includes(t * 20)).parent;
    assert.equal(groupOf(0), groupOf(1));
    assert.equal(groupOf(1), groupOf(2));
    assert.notEqual(groupOf(0), groupOf(3));
    assert.notEqual(groupOf(3), groupOf(6));
    const memberSet = (dots) => new Set(Array.from(dots).map((i) => members[i][0]));
    const previous = {
      provinces: r.provinces.map((p) => ({ key: p.key, label: null, hue: 10 * p.id, members: memberSet(p.dots) })),
      towns: r.towns.map((t) => ({ key: t.key, label: null, members: memberSet(t.dots) })),
    };
    const pc = new Float64Array(r.provinces.length * 2);
    r.provinces.forEach((p, j) => { pc[2 * j] = p.x; pc[2 * j + 1] = p.y; });
    const again = L.buildRegions({ xy, styles: new Array(n).fill(null), members, townAssign, townCentres, previous, provinceCentres: pc, nextKey: r.nextKey });
    assert.deepEqual(again.provinces.map((p) => p.key).sort(), r.provinces.map((p) => p.key).sort());
    assert.deepEqual(again.provinces.map((p) => p.prevHue), again.provinces.map((p) => 10 * r.provinces.find((q) => q.key === p.key).id));
  });

  test('Jaccard matching: identity, split, merge, new, and 0.49 vs 0.50', () => {
    const range = (a, b, p = 'h') => { const s = new Set(); for (let i = a; i < b; i++) { s.add(`${p}${i}`); } return s; };
    const olds = [{ key: 't:1', members: range(0, 100) }, { key: 't:2', members: range(100, 140) }, { key: 't:3', members: range(200, 300) }];
    assert.deepEqual(Array.from(L.matchRegionKeys([range(0, 100), range(100, 140), range(200, 300)], olds)), [0, 1, 2], 'identity');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(0, 40), range(40, 100)], olds)), [-1, 0], 'a split keeps the key on the larger part');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(0, 140)], olds)), [0], 'a merge keeps the bigger overlap\'s key');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(0, 5, 'new')], olds)), [-1], 'new');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(200, 250)], olds)), [2], 'Jaccard 0.50 is kept');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(200, 249)], olds)), [-1], 'Jaccard 0.49 is not');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(250, 300), range(200, 250)], olds)), [2, -1], 'equal Jaccard, overlap and key: the lower new id');
    assert.deepEqual(Array.from(L.matchRegionKeys([range(200, 250)], [{ key: 't:9', members: range(200, 300) }, { key: 't:4', members: range(150, 250) }])), [1], 'equal Jaccard and overlap: the lower old key');
  });
});

// ── hues ────────────────────────────────────────────────────────────────────

describe('hues', () => {
  test('61 candidates every 5°, none in 35–85', () => {
    assert.equal(L.HUE_CANDIDATES.length, 61);
    for (const h of L.HUE_CANDIDATES) { assert.ok(h % 5 === 0 && h >= 0 && h < 360 && (h < 35 || h > 85), `${h}`); }
  });

  test('neighbours sit ≥ 60° apart when that is satisfiable, and no hue falls in 35–85', () => {
    const graphs = {
      path: [[0, 1], [1, 2], [2, 3], [3, 4]],
      cycle5: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]],
      k4: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
      star: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]],
      wheel: [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1]],
    };
    for (const [name, edges] of Object.entries(graphs)) {
      const P = 1 + edges.reduce((m, [a, b]) => Math.max(m, a, b), 0);
      const provinces = Array.from({ length: P }, (_, id) => ({ id, size: 100 - id * 7, prevHue: null }));
      const hues = L.assignHues(provinces, edges);
      for (const h of hues) { assert.ok(L.HUE_CANDIDATES.includes(h), `${name}: ${h}`); }
      for (const [a, b] of edges) { assert.ok(hueDist(hues[a], hues[b]) >= 60, `${name}: ${a}–${b} ${hues[a]}/${hues[b]}`); }
    }
    const lone = L.assignHues([{ id: 0, size: 5 }, { id: 1, size: 9 }, { id: 2, size: 1 }], []);
    assert.deepEqual(Array.from(lone), [180, 0, 90], 'no neighbours: spread over every assigned hue');
  });

  test('a matched province keeps its hue unless a neighbour now clashes', () => {
    const provinces = [{ id: 0, size: 50, prevHue: 210 }, { id: 1, size: 40, prevHue: 330 }, { id: 2, size: 30, prevHue: 100 }];
    assert.deepEqual(Array.from(L.assignHues(provinces, [[0, 1], [1, 2]])), [210, 330, 100]);
    const clash = L.assignHues([{ id: 0, size: 50, prevHue: 210 }, { id: 1, size: 40, prevHue: 240 }], [[0, 1]]);
    assert.equal(clash[0], 210);
    assert.ok(hueDist(clash[1], 210) >= 60);
    const banned = L.assignHues([{ id: 0, size: 5, prevHue: 50 }], []);
    assert.equal(banned[0], 0, 'a previous hue in the excluded band is not kept');
    const twin = L.assignHues([{ id: 0, size: 50, prevHue: 180 }, { id: 1, size: 40, prevHue: 180 }], []);
    assert.equal(twin[0], 180);
    assert.notEqual(twin[1], 180, 'a previous hue a larger province already took is not kept');
  });

  test('provinces with no shared coast still get their own hues', () => {
    // The demo library's shape: Hip Hop borders Rock and Electronic, which do
    // not touch. Maximising the neighbour distance alone gave both 180.
    const star = Array.from(L.assignHues([{ id: 0, size: 51 }, { id: 1, size: 34 }, { id: 2, size: 19 }], [[0, 1], [0, 2]]));
    assert.equal(new Set(star).size, 3, `three hues, got ${star}`);
    assert.ok(hueDist(star[0], star[1]) >= 60 && hueDist(star[0], star[2]) >= 60, `neighbours apart: ${star}`);
    assert.ok(hueDist(star[1], star[2]) >= 60, `leaves apart: ${star}`);
    // Eleven provinces (the boards' count) on a chain: all distinct, spread.
    const P = 11;
    const chain = Array.from({ length: P - 1 }, (_, i) => [i, i + 1]);
    const hues = Array.from(L.assignHues(Array.from({ length: P }, (_, id) => ({ id, size: 100 - id })), chain));
    assert.equal(new Set(hues).size, P, `eleven hues, got ${hues}`);
    for (let a = 0; a < P; a++) {
      for (let b = a + 1; b < P; b++) { assert.ok(hueDist(hues[a], hues[b]) >= 15, `${a}/${b}: ${hues}`); }
    }
    for (const [a, b] of chain) { assert.ok(hueDist(hues[a], hues[b]) >= 60, `chain ${a}–${b}: ${hues}`); }
  });
});

// ── centrality and mixes ────────────────────────────────────────────────────

describe('centrality and mixes', () => {
  const k = 5;
  const cloud = (n, seed) => {
    const rand = L.mulberry32(seed);
    const z = new Float32Array(n * k);
    for (let i = 0; i < z.length; i++) { z[i] = gaussian(rand); }
    return z;
  };

  test('centrality is minus the distance to the region\'s mean', () => {
    const z = cloud(60, 29);
    const assign = Uint8Array.from({ length: 60 }, (_, i) => (i < 20 ? 0 : i < 50 ? 1 : L.REGION_NONE));
    const c = L.centrality(z, k, assign, 2);
    for (const r of [0, 1]) {
      const ids = [...assign.keys()].filter((i) => assign[i] === r);
      const mean = new Float64Array(k);
      for (const i of ids) { for (let j = 0; j < k; j++) { mean[j] += z[i * k + j] / ids.length; } }
      for (const i of ids) {
        let s = 0;
        for (let j = 0; j < k; j++) { s += (z[i * k + j] - mean[j]) ** 2; }
        assert.ok(Math.abs(c[i] + Math.sqrt(s)) < 1e-9);
      }
    }
    assert.equal(c[55], 0, 'no region, no centrality');
  });

  test('a small region\'s mix is all of it, walked from its most central dot', () => {
    const z = cloud(30, 30);
    const members = Int32Array.from({ length: 30 }, (_, i) => i);
    const central = L.centrality(z, k, new Uint8Array(30), 1);
    const mix = L.regionMix(members, z, k, central);
    assert.equal(mix.length, 30);
    assert.equal(new Set(mix).size, 30);
    let c0 = 0;
    for (let i = 1; i < 30; i++) { if (central[i] > central[c0]) { c0 = i; } }
    assert.equal(mix[0], c0);
    const d2 = (a, b) => { let s = 0; for (let j = 0; j < k; j++) { s += (z[a * k + j] - z[b * k + j]) ** 2; } return s; };
    for (let s = 1; s < mix.length; s++) {
      for (let t = s; t < mix.length; t++) { assert.ok(d2(mix[s - 1], mix[s]) <= d2(mix[s - 1], mix[t]), 'each step goes to the nearest remaining dot'); }
    }
  });

  test('a big region\'s mix is 64 spread dots, deterministic', () => {
    const z = cloud(500, 31);
    const members = Int32Array.from({ length: 500 }, (_, i) => i);
    const central = L.centrality(z, k, new Uint8Array(500), 1);
    const a = L.regionMix(members, z, k, central);
    assert.equal(a.length, L.MIX_MAX);
    assert.equal(new Set(a).size, L.MIX_MAX);
    assert.equal(sha(a), sha(L.regionMix(members, z, k, central)));
    assert.equal(L.regionMix(new Int32Array(0), z, k, central).length, 0);
  });
});

// ── land ────────────────────────────────────────────────────────────────────

describe('land', () => {
  const tolerance = Math.ceil(2 * L.LAND_EPS * 65535);   // two simplification steps, in u16

  test('σ follows the library size, clamped', () => {
    assert.ok(Math.abs(L.landSigma(2000) - 0.010) < 1e-12);
    assert.equal(L.landSigma(1e9), 0.003);
    assert.equal(L.landSigma(1), 0.010 * Math.pow(2000, 1 / 6));
    assert.equal(L.landSigma(0), 0.04);
  });

  test('every dot stands on land; mid and high are the guarded percentiles; the terraces nest', () => {
    const { xy, province, provinces } = blobMap(2000, 32);
    const res = L.buildLand({ xy, province, nProvinces: provinces });
    const { N, total } = res.field;
    const vals = [];
    for (let i = 0; i < 2000; i++) {
      const gx = Math.min(N - 1, Math.floor(xy[2 * i] * N)), gy = Math.min(N - 1, Math.floor(xy[2 * i + 1] * N));
      assert.ok(total[gy * N + gx] >= res.levels.coast, `dot ${i} is below the coast`);
      vals.push(total[gy * N + gx]);
    }
    vals.sort((a, b) => a - b);
    const mid = Math.max(vals[Math.floor(0.005 * 2000)], 2 * L.LAND_COAST);
    assert.equal(res.levels.mid, mid);
    assert.equal(res.levels.high, Math.max(vals[Math.floor(0.04 * 2000)], 1.25 * mid));
    assert.equal(res.levels.coast, L.LAND_COAST);
    assert.equal(res.levels.sigma, L.landSigma(2000));
    let checked = 0;
    for (const blob of res.land) {
      const [coast, midR, high] = L.decodeLandV1(blob);
      assert.ok(coast.length > 0, 'every province has a coast');
      for (const [inner, outer] of [[high, midR], [midR, coast]]) {
        for (const ring of inner) {
          for (let v = 0; v < ring.length; v += 2) {
            const ok = L.pointInRings(ring[v], ring[v + 1], outer) || distToRings(ring[v], ring[v + 1], outer) <= tolerance;
            assert.ok(ok, `a vertex at (${ring[v]}, ${ring[v + 1]}) leaves the terrace below`);
            checked++;
          }
        }
      }
    }
    assert.ok(checked > 100);
  });

  test('rings are canonical: positive area, starting at their smallest vertex', () => {
    const { xy, province, provinces } = blobMap(1200, 33);
    const res = L.buildLand({ xy, province, nProvinces: provinces });
    for (const blob of res.land) {
      for (const level of L.decodeLandV1(blob)) {
        for (const r of level) {
          let a = 0;
          const n = r.length >> 1;
          for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]; }
          assert.ok(a > 0, 'positive area');
          for (let i = 1; i < n; i++) { assert.ok(r[2 * i] > r[0] || (r[2 * i] === r[0] && r[2 * i + 1] > r[1]), 'starts at the smallest (x, y)'); }
        }
      }
    }
  });

  test('unchanged input gives identical bytes', () => {
    const { xy, province, provinces } = blobMap(1500, 34);
    const a = L.buildLand({ xy, province, nProvinces: provinces });
    const b = L.buildLand({ xy: Float64Array.from(xy), province: Int32Array.from(province), nProvinces: provinces });
    assert.deepEqual(a.land.map((x) => sha(x)), b.land.map((x) => sha(x)));
    assert.deepEqual(a.levels, b.levels);
  });

  test('≤ 16 KB per province on the ×10 proxy', () => {
    const base = blobMap(2000, 35, { provinces: 11, sd: 0.04 });
    const rand = L.mulberry32(36);
    const n = 20000;
    const xy = new Float64Array(2 * n), province = new Int32Array(n);
    for (let r = 0; r < 10; r++) {
      for (let i = 0; i < 2000; i++) {
        const j = r * 2000 + i;
        xy[2 * j] = base.xy[2 * i] + (r ? 0.006 * gaussian(rand) : 0);
        xy[2 * j + 1] = base.xy[2 * i + 1] + (r ? 0.006 * gaussian(rand) : 0);
        province[j] = base.province[i];
      }
    }
    const res = L.buildLand({ xy, province, nProvinces: 11 });
    for (const blob of res.land) { assert.ok(blob.length <= 16 * 1024, `${blob.length} bytes`); }
    assert.ok(res.eps.every((e) => e === L.LAND_FINAL_EPS), 'no cap was needed');
  });

  // A jittered lattice of lone dots: one island each at σ = 0.003.
  const lattice = (side, provinces, seed) => {
    const rand = L.mulberry32(seed);
    const n = side * side;
    const xy = new Float64Array(2 * n), province = new Int32Array(n);
    for (let iy = 0; iy < side; iy++) {
      for (let ix = 0; ix < side; ix++) {
        const i = iy * side + ix;
        xy[2 * i] = (ix + 1) / (side + 1) + 0.001 * (rand() - 0.5);
        xy[2 * i + 1] = (iy + 1) / (side + 1) + 0.001 * (rand() - 0.5);
        province[i] = (ix + iy * 3) % provinces;
      }
    }
    return { xy, province };
  };

  test('the province cap raises ε until a province fits in 64 KB', () => {
    const { xy, province } = lattice(60, 1, 37);
    const open = L.buildLand({ xy, province, nProvinces: 1, sigma: 0.003, provinceCap: Infinity, layoutCap: Infinity });
    assert.ok(open.land[0].length > L.LAND_PROVINCE_CAP, `uncapped ${open.land[0].length} bytes`);
    const capped = L.buildLand({ xy, province, nProvinces: 1, sigma: 0.003 });
    assert.ok(capped.land[0].length <= L.LAND_PROVINCE_CAP, `capped ${capped.land[0].length} bytes`);
    assert.ok(capped.eps[0] > L.LAND_FINAL_EPS);
    const steps = Math.log(capped.eps[0] / L.LAND_FINAL_EPS) / Math.log(L.LAND_EPS_GROWTH);
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, 'ε grows in ×1.5 steps');
    L.decodeLandV1(capped.land[0]);
  });

  test('the layout cap raises ε until the land fits in 256 KB', () => {
    const { xy, province } = lattice(110, 8, 38);
    const open = L.buildLand({ xy, province, nProvinces: 8, sigma: 0.003, provinceCap: Infinity, layoutCap: Infinity });
    const openTotal = open.land.reduce((s, b) => s + b.length, 0);
    assert.ok(openTotal > L.LAND_LAYOUT_CAP, `uncapped ${openTotal} bytes`);
    const capped = L.buildLand({ xy, province, nProvinces: 8, sigma: 0.003 });
    const total = capped.land.reduce((s, b) => s + b.length, 0);
    assert.ok(total <= L.LAND_LAYOUT_CAP, `capped ${total} bytes`);
    for (const blob of capped.land) { assert.ok(blob.length <= L.LAND_PROVINCE_CAP); }
  });

  test('counts over 65,535 are refused before writing', () => {
    const big = new Uint16Array(2 * 65536);
    for (let i = 0; i < 65536; i++) { big[2 * i] = i & 0xffff; big[2 * i + 1] = i >> 8; }
    assert.throws(() => L.encodeLandV1([[big], [], []]), /65,535 vertices/);
    const tri = [0, 0, 5, 0, 0, 5];
    assert.throws(() => L.encodeLandV1([new Array(65536).fill(tri), [], []]), /65,535 rings/);
    assert.throws(() => L.encodeLandV1([[[0, 0, 5, 0]], [], []]), /at least 3/);
    assert.throws(() => L.encodeLandV1([[[0, 0, 5, 0, 0, 65536]], [], []]), /u16/);
  });

  test('the iterative Douglas–Peucker equals the recursive one', () => {
    // The prototype's recursive form (S/dir-A/lib.mjs dp/simplify) on closed
    // rings of points, with the same distance arithmetic.
    function dp(points, eps) {
      if (points.length < 3) { return points; }
      const [a, b] = [points[0], points[points.length - 1]];
      let idx = -1, max = 0;
      for (let i = 1; i < points.length - 1; i++) {
        const p = points[i];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
        const dist = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
        if (dist > max) { max = dist; idx = i; }
      }
      if (max > eps) { return [...dp(points.slice(0, idx + 1), eps).slice(0, -1), ...dp(points.slice(idx), eps)]; }
      return [a, b];
    }
    function simplify(ring, eps) {
      const a = ring[0];
      let far = 1, fd = -1;
      for (let i = 1; i < ring.length - 1; i++) {
        const d = (ring[i][0] - a[0]) ** 2 + (ring[i][1] - a[1]) ** 2;
        if (d > fd) { fd = d; far = i; }
      }
      return [...dp(ring.slice(0, far + 1), eps).slice(0, -1), ...dp(ring.slice(far), eps)];
    }
    const rand = L.mulberry32(39);
    for (let t = 0; t < 60; t++) {
      const n = 5 + Math.floor(rand() * 60);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI, r = 0.1 + 0.03 * rand();
        pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
      }
      for (const eps of [0.0007, 0.003, 0.01, 0.05]) {
        const expected = simplify([...pts, pts[0]], eps).slice(0, -1).flat();
        assert.deepEqual(Array.from(L.simplifyClosed(Float64Array.from(pts.flat()), eps)), expected, `ring ${t} at ε ${eps}`);
      }
    }
  });

  test('marching squares closes rings around a lone peak and a hole', () => {
    const N = 40;
    const ring = (x, y) => { const d = Math.hypot(x - 20, y - 20); return d < 12 && d > 5 ? 1 : -1; };
    const rings = L.contourRings(ring, [0, 0, N - 1, N - 1], N);
    assert.equal(rings.length, 2, 'an outer ring and a hole');
    const areas = rings.map((r) => L.ringArea(r)).sort((a, b) => Math.abs(b) - Math.abs(a));
    assert.ok(Math.sign(areas[0]) !== Math.sign(areas[1]), 'a hole runs the other way');
    assert.ok(L.pointInRings(20.5 / N, 30.5 / N, rings) && !L.pointInRings(20.5 / N, 20.5 / N, rings), 'even-odd: the band is land, the hole is sea');
  });

  test('touching provinces are adjacent, distant ones are not', () => {
    const rand = L.mulberry32(40);
    const n = 600;
    const xy = new Float64Array(2 * n), province = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i % 3;
      const c = [[0.3, 0.3], [0.38, 0.3], [0.8, 0.8]][p];
      xy[2 * i] = c[0] + 0.02 * gaussian(rand);
      xy[2 * i + 1] = c[1] + 0.02 * gaussian(rand);
      province[i] = p;
    }
    const res = L.buildLand({ xy, province, nProvinces: 3 });
    assert.deepEqual(L.landAdjacency(res.field, res.levels.coast), [[0, 1]]);
  });
});

// ── codecs ──────────────────────────────────────────────────────────────────

describe('codecs', () => {
  test('cols-v1: offsets, alignment and a round trip', () => {
    const cols = { ids: [5, 70000, 4294967295], x: [0, 65535, 1234], y: [9, 8, 7], region0: [0, 254, 255], region1: [3, 255, 1], flags: [1, 0, 1] };
    const bytes = L.encodePointsColsV1(cols);
    assert.equal(bytes.length, 33);
    const dv = new DataView(bytes.buffer);
    assert.equal(dv.getUint32(0, true), 5);
    assert.equal(dv.getUint32(8, true), 4294967295);
    assert.equal(dv.getUint16(12 + 2, true), 65535, 'x column at 4n');
    assert.equal(dv.getUint16(18 + 4, true), 7, 'y column at 6n');
    assert.deepEqual(Array.from(bytes.subarray(24, 27)), [0, 254, 255], 'province column at 8n');
    assert.deepEqual(Array.from(bytes.subarray(27, 30)), [3, 255, 1], 'town column at 9n');
    assert.deepEqual(Array.from(bytes.subarray(30, 33)), [1, 0, 1], 'flags at 10n');
    // A fresh buffer views directly (every column aligned to its element size).
    const buf = bytes.slice().buffer;
    assert.deepEqual(Array.from(new Uint32Array(buf, 0, 3)), cols.ids);
    assert.deepEqual(Array.from(new Uint16Array(buf, 12, 3)), cols.x);
    assert.deepEqual(Array.from(new Uint16Array(buf, 18, 3)), cols.y);
    for (let n = 1; n < 20; n++) { assert.ok((4 * n) % 2 === 0 && (6 * n) % 2 === 0); }
    const back = L.decodePointsColsV1(bytes, 3);
    assert.deepEqual(Array.from(back.ids), cols.ids);
    assert.deepEqual(Array.from(back.x), cols.x);
    assert.deepEqual(Array.from(back.flags), cols.flags);
    assert.throws(() => L.decodePointsColsV1(bytes, 4), /length/);
    assert.throws(() => L.encodePointsColsV1({ ...cols, ids: [5, 5, 6] }), /ascending/);
    assert.throws(() => L.encodePointsColsV1({ ...cols, x: [0, 65536, 1] }), /u16/);
    assert.throws(() => L.encodePointsColsV1({ ...cols, flags: [0, 256, 0] }), /u8/);
    assert.equal(L.encodePointsColsV1({ ids: [], x: [], y: [], region0: [], region1: [], flags: [] }).length, 0);
  });

  test('bitset: point i is bit (i & 7) of byte i >> 3, LSB first', () => {
    const set = new Set([0, 3, 8, 9]);
    const bytes = L.encodeBitset(10, (i) => set.has(i));
    assert.deepEqual(Array.from(bytes), [0b00001001, 0b00000011]);
    assert.deepEqual(Array.from(L.encodeBitset(10, [1, 0, 0, 1, 0, 0, 0, 0, 1, 1])), [9, 3]);
    for (let i = 0; i < 10; i++) { assert.equal(L.bitsetGet(bytes, i), set.has(i) ? 1 : 0); }
    assert.equal(L.encodeBitset(0, () => true).length, 0);
    assert.equal(L.encodeBitset(17, () => true).length, 3);
  });

  test('land-v1 round-trips; truncated and over-long blobs are rejected', () => {
    const levels = [[[1, 2, 3, 4, 5, 6], [10, 10, 20, 10, 20, 20, 10, 20]], [], [[65535, 0, 0, 65535, 65535, 65535]]];
    const bytes = L.encodeLandV1(levels);
    assert.equal(bytes.length, 2 + (2 + 12) + (2 + 16) + 2 + 2 + (2 + 12));
    const back = L.decodeLandV1(bytes);
    assert.deepEqual(back.map((rings) => rings.map((r) => Array.from(r))), levels);
    assert.throws(() => L.decodeLandV1(bytes.subarray(0, bytes.length - 1)), /truncated/);
    assert.throws(() => L.decodeLandV1(bytes.subarray(0, 1)), /truncated/);
    const longer = new Uint8Array(bytes.length + 2);
    longer.set(bytes);
    assert.throws(() => L.decodeLandV1(longer), /left over/);
    assert.throws(() => L.decodeLandV1(Uint8Array.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /fewer than 3/);
    assert.deepEqual(L.decodeLandV1(new Uint8Array(6)), [[], [], []]);
    const odd = new Uint8Array(bytes.length + 1);
    odd.set(bytes, 1);
    assert.deepEqual(L.decodeLandV1(odd.subarray(1)).map((r) => r.length), [2, 0, 1], 'an unaligned view decodes');
  });

  test('quantU16 rounds and clamps; f32 blobs come back aligned', () => {
    assert.equal(L.quantU16(0), 0);
    assert.equal(L.quantU16(1), 65535);
    assert.equal(L.quantU16(0.5), 32768);
    assert.equal(L.quantU16(-0.02), 0);
    assert.equal(L.quantU16(1.02), 65535);
    assert.equal(L.quantU16(NaN), 0);
    const f = Float32Array.from([1.5, -2.25, 3e-8]);
    const raw = L.f32ToBytes(f);
    const shifted = new Uint8Array(raw.length + 1);
    shifted.set(raw, 1);
    const back = L.f32FromBytes(shifted.subarray(1), 3);
    assert.deepEqual(Array.from(back), Array.from(f));
    assert.equal(back.byteOffset % 4, 0);
    assert.throws(() => L.f32FromBytes(new Uint8Array(5)), /multiple of 4/);
    assert.throws(() => L.f32FromBytes(raw, 4), /expected 4/);
  });
});

// ── the shared land fixture (Phases 3 and 4 decode it too) ─────────────────

// One province's terraces: a coast with a lake (a hole) holding an island,
// plus an islet off the coast; one mid ring; no high ring. Run with
// MSTREAM_WRITE_MAP_FIXTURES=1 to (re)write test/fixtures/map/land-v1.json.
const FIXTURE_SHAPES = {
  coast: [
    [14000, 6000, 51535, 6000, 59535, 14000, 59535, 51535, 51535, 59535, 14000, 59535, 6000, 51535, 6000, 14000],
    [32768, 16768, 48768, 32768, 32768, 48768, 16768, 32768],
    [28768, 28768, 36768, 28768, 32768, 36768],
    [61000, 61000, 64500, 61000, 64500, 64500, 61000, 64500],
  ],
  mid: [[9000, 20000, 13000, 20000, 13000, 45000, 9000, 45000]],
  high: [],
};
const PROBES = Array.from({ length: 16 }, (_, i) => 2048 + 4096 * i);
const LEVELS = ['coast', 'mid', 'high'];

function buildFixture() {
  const compare = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) { return a[i] - b[i]; } }
    return a.length - b.length;
  };
  const levels = {};
  for (const name of LEVELS) {
    levels[name] = FIXTURE_SHAPES[name]
      .map((r) => Array.from(L.normaliseRingU16(Float64Array.from(r, (v) => v / 65535))))
      .sort(compare);
  }
  const bytes = L.encodeLandV1(LEVELS.map((name) => levels[name]));
  const inside = {};
  for (const name of LEVELS) {
    inside[name] = PROBES.map((py) => PROBES.map((px) => (L.pointInRings(px, py, levels[name]) ? '1' : '0')).join(''));
  }
  return {
    format: 'land-v1',
    about: 'The shared land fixture (docs/music-map-plan.md §3.8.9, §3.12): one province\'s three terraces as the server writes them — rings normalised (positive area, start at the smallest (x, y)), u16 map units. coast holds an outer ring, a lake (a hole) with an island inside it, and an islet; mid one ring; high none. bytes = the land-v1 blob, base64. Fill each terrace even-odd; inside[level][j][i] is the expected fill at (probes[i], probes[j]): row j is y = probes[j], character i is x = probes[i]. Every probe sits at least 64 units from every edge.',
    fill: 'evenodd',
    levels,
    bytes: Buffer.from(bytes).toString('base64'),
    probes: PROBES,
    inside,
  };
}

describe('land-v1 fixture', () => {
  if (process.env.MSTREAM_WRITE_MAP_FIXTURES === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  test('it is what the codec and the ring normaliser produce today', () => {
    assert.deepEqual(fixture, buildFixture());
  });

  test('its bytes decode to its rings, and they re-encode to the same bytes', () => {
    const bytes = new Uint8Array(Buffer.from(fixture.bytes, 'base64'));
    const levels = L.decodeLandV1(bytes);
    assert.deepEqual(levels.map((rings) => rings.map((r) => Array.from(r))), LEVELS.map((name) => fixture.levels[name]));
    assert.deepEqual(L.encodeLandV1(LEVELS.map((name) => fixture.levels[name])), bytes);
    assert.throws(() => L.decodeLandV1(bytes.subarray(0, bytes.length - 2)), /truncated/);
  });

  test('the even-odd fill matches an independent scanline fill, with every probe clear of the edges', () => {
    const coastCount = { ones: 0, zeros: 0 };
    for (const name of LEVELS) {
      const rings = fixture.levels[name];
      fixture.probes.forEach((py, j) => {
        fixture.probes.forEach((px, i) => {
          const want = fixture.inside[name][j][i] === '1';
          assert.equal(scanlineInside(px, py, rings), want, `${name} at (${px}, ${py})`);
          assert.equal(L.pointInRings(px, py, rings), want);
          if (rings.length) { assert.ok(distToRings(px, py, rings) >= 64, `(${px}, ${py}) is too close to a ${name} edge`); }
          if (name === 'coast') { coastCount[want ? 'ones' : 'zeros']++; }
        });
      });
    }
    // The lake is sea and its island is land again.
    const at = (name, x, y) => fixture.inside[name][fixture.probes.indexOf(y)][fixture.probes.indexOf(x)] === '1';
    assert.equal(at('coast', 10240, 26624), true, 'on the main land');
    assert.equal(at('coast', 26624, 38912), false, 'in the lake');
    assert.equal(at('coast', 30720, 30720), true, 'on the island in the lake');
    assert.equal(at('coast', 63488, 63488), true, 'on the islet');
    assert.equal(at('coast', 2048, 2048), false, 'at sea');
    assert.equal(at('mid', 10240, 30720), true);
    assert.ok(fixture.inside.high.every((row) => !row.includes('1')));
    assert.ok(coastCount.ones > 50 && coastCount.zeros > 50);
  });
});

// ── the memory budget (§3.4.6) ──────────────────────────────────────────────

describe('mapFitBudget', () => {
  const host = (runtime, gib, extra = {}) => L.mapFitBudget({ runtime, totalMemBytes: gib * GiB, parentRssBytes: 200 * L.MiB, ...extra });

  test('the table: Bun and Node on 1/2/4/8 GB hosts, nothing else running', () => {
    const bun = [1, 2, 4, 8].map((g) => host('bun', g).nFitMax);
    const node = [1, 2, 4, 8].map((g) => host('node', g).nFitMax);
    assert.deepEqual(bun, [2205, 5263, 11380, 20000]);
    assert.deepEqual(node, [3880, 10552, 20000, 20000]);
    // The plan's "about 2.1k / 5.1k / 11.1k / 20k" for Bun.
    [2100, 5100, 11100, 20000].forEach((about, i) => assert.ok(Math.abs(bun[i] - about) / about < 0.06, `${bun[i]} vs ~${about}`));
    const b = host('bun', 4);
    assert.equal(b.perPoint, 120 * 1024);
    assert.equal(b.base, 100 * L.MiB);
    assert.equal(b.available, null, 'no Linux readings');
    assert.ok(L.fitFitsBudget(b, b.nFitMax) && !L.fitFitsBudget(b, b.nFitMax + 1));
  });

  test('MemAvailable and the cgroup bound the budget', () => {
    const mem = host('bun', 8, { memAvailableBytes: 1 * GiB, nEmbedded: 1000, dim: 1280 });
    assert.equal(mem.available, 1 * GiB);
    assert.equal(mem.nFitMax, Math.floor((0.6 * GiB - 2 * 1000 * 1280 * 4 - 100 * L.MiB) / (120 * 1024)));
    assert.equal(mem.nFitMax, 4306);
    const cg = L.mapFitBudget({ runtime: 'bun', totalMemBytes: 16 * GiB, cgroupLimitBytes: 2 * GiB, cgroupUsageBytes: 512 * L.MiB, memAvailableBytes: 10 * GiB, parentRssBytes: 200 * L.MiB });
    assert.equal(cg.limit, 2 * GiB);
    assert.equal(cg.available, 1.5 * GiB);
    assert.equal(cg.nFitMax, 5263, 'like a 2 GB host');
    const busy = L.mapFitBudget({ runtime: 'bun', totalMemBytes: 16 * GiB, cgroupLimitBytes: 2 * GiB, cgroupUsageBytes: 1.5 * GiB, parentRssBytes: 200 * L.MiB });
    assert.equal(busy.available, 0.5 * GiB, 'the cgroup alone, MemAvailable unread');
    assert.equal(busy.nFitMax, 1768);
    const constrained = L.mapFitBudget({ runtime: 'node', totalMemBytes: 8 * GiB, constrainedBytes: 1 * GiB, parentRssBytes: 200 * L.MiB });
    assert.equal(constrained.limit, 1 * GiB);
    assert.equal(constrained.nFitMax, 3880);
  });

  test('the similarity-index headroom lowers the cap: ~3–4k landmarks for 100k songs on a 4 GB Pi', () => {
    const small = host('bun', 4, { memAvailableBytes: 2.5 * GiB, nEmbedded: 2000, dim: 1280 });
    const big = host('bun', 4, { memAvailableBytes: 2.5 * GiB, nEmbedded: 100000, dim: 1280 });
    assert.equal(big.indexRoom, 2 * 100000 * 1280 * 4);
    assert.equal(big.nFitMax, 3920);
    assert.ok(big.nFitMax >= 3000 && big.nFitMax <= 4000);
    assert.ok(small.nFitMax > big.nFitMax);
  });

  test('the override clamps to [FIT_FLOOR, 20000] and caps the derived size; the floor can be lowered for tests', () => {
    assert.equal(host('bun', 4, { override: 500 }).nFitMax, 1000);
    assert.equal(host('bun', 8, { override: 50000 }).nFitMax, 20000);
    assert.equal(host('bun', 4, { override: 50000 }).nFitMax, 11380);
    assert.equal(host('bun', 1, { override: 5000 }).nFitMax, 2205, 'a setting caps the fit; it never raises it past memory');
    assert.equal(host('bun', 4, { override: 5000 }).nFitMax, 5000, 'under the derived size the setting wins');
    assert.equal(host('bun', 4, { override: 1234.5 }).nFitMax, 11380, 'a non-integer is ignored');
    assert.equal(host('bun', 4, { override: 200, fitFloor: 100 }).nFitMax, 200);
    assert.equal(L.mapFitBudget({ runtime: 'bun', totalMemBytes: 512 * L.MiB }).nFitMax, 1000, 'a tiny host gets the floor…');
    assert.equal(L.fitFitsBudget(L.mapFitBudget({ runtime: 'bun', totalMemBytes: 512 * L.MiB }), 1000), false, '…and the pre-fit check refuses it');
    const b = host('node', 2);
    assert.equal(L.rssOverBudget(b.budget + L.MAP_RSS_SLACK, b), false);
    assert.equal(L.rssOverBudget(b.budget + L.MAP_RSS_SLACK + 1, b), true);
  });

  test('the queue\'s halved cap gives way to a smaller budget instead of failing the pre-fit check', () => {
    // A 2 GB Linux host under Bun, 1280-d vectors. Run 1 (5k embedded) is
    // killed and the queue latches half its fit; by run 2 the backfill has
    // reached 60k embedded, and the similarity-index headroom has shrunk the
    // budget below that latch.
    const common = { runtime: 'bun', totalMemBytes: 2 * GiB, memAvailableBytes: 1.6 * GiB, parentRssBytes: 300 * L.MiB, dim: 1280 };
    const latch = Math.max(1000, Math.floor(L.mapFitBudget({ ...common, nEmbedded: 5000 }).nFitMax / 2));
    const derived = L.mapFitBudget({ ...common, nEmbedded: 60000 });
    assert.deepEqual([latch, derived.nFitMax], [2631, 2535]);
    const latched = L.mapFitBudget({ ...common, nEmbedded: 60000, override: latch });
    assert.equal(latched.nFitMax, derived.nFitMax, 'the derived size, not the latch');
    assert.ok(L.fitFitsBudget(latched, latched.nFitMax), 'so the pre-fit check passes: no exit 5');
  });

  test('the readings parse: /proc/meminfo and both cgroup versions', () => {
    const meminfo = 'MemTotal:        3884292 kB\nMemFree:          123456 kB\nMemAvailable:    2621440 kB\nBuffers:           1 kB\n';
    assert.equal(L.parseMemAvailable(meminfo), 2621440 * 1024);
    assert.equal(L.parseMemAvailable('MemTotal: 1 kB\n'), null);
    assert.equal(L.parseMemAvailable(undefined), null);
    assert.equal(L.parseCgroupLimit('max\n'), 0);
    assert.equal(L.parseCgroupLimit('2147483648\n'), 2147483648);
    assert.equal(L.parseCgroupLimit('9223372036854771712\n'), 0, 'cgroup v1 "unlimited"');
    assert.equal(L.parseCgroupLimit(''), 0);
    assert.equal(L.parseCgroupUsage('536870912\n'), 536870912);
    assert.equal(L.parseCgroupUsage('junk'), 0);
  });
});

// ── modes (§3.4.2) ──────────────────────────────────────────────────────────

describe('decideMapMode', () => {
  const H = 60 * 60 * 1000;
  const now = 1_800_000_000_000;
  const S = (over = {}) => ({ modelId: 'm', method: 'umap', dim: 64, layoutVersion: L.MAP_LAYOUT_VERSION, fittedAt: now - 2 * H, dirty: 0, nP: 1000, nPinL: 1000, ...over });
  const mode = (over) => L.decideMapMode({ model: 'm', dim: 64, nU: 1000, serving: S(), nowMs: now, ...over }).mode;

  test('empty, rebuild and the small-library rules', () => {
    assert.equal(mode({ nU: 0, serving: null, dim: null }), 'empty');
    assert.equal(mode({ nU: 0, serving: S({ nPinL: 0 }), dim: null }), 'empty');
    assert.equal(mode({ nU: 0, dim: null }), 'mirror', 'the old layout still has songs in the library');
    assert.equal(mode({ serving: null }), 'rebuild');
    assert.equal(L.decideMapMode({ model: 'm', dim: 64, nU: 30, serving: null, nowMs: now }).method, 'pca2');
    assert.equal(mode({ serving: S({ layoutVersion: 0 }) }), 'rebuild');
    assert.equal(mode({ serving: S({ dim: 8 }) }), 'rebuild');
    assert.equal(mode({ force: 'rebuild' }), 'rebuild');
    assert.equal(mode({ nU: 49 }), 'rebuild', 'umap → pca2 below 50');
    assert.equal(mode({ nU: 30, serving: S({ method: 'pca2', nP: 29, nPinL: 29 }), nNew: 1 }), 'rebuild', 'any change to a pca2 map');
    assert.equal(mode({ nU: 2001, nNew: 1001 }), 'rebuild', 'the library more than doubled');
    assert.equal(mode({ nU: 3000, nNew: 1500, serving: S({ nU: 3000 }) }), 'place', 'a capped rebuild places the rest instead of rebuilding again');
  });

  test('a model switch keeps the old layout serving until settled or 90 % covered', () => {
    const sw = { serving: S({ modelId: 'old' }) };
    assert.equal(mode({ ...sw, nU: 100 }), 'mirror');
    assert.equal(mode({ ...sw, nU: 100, settled: true }), 'rebuild');
    assert.equal(mode({ ...sw, nU: 900 }), 'rebuild');
    assert.equal(mode({ ...sw, nU: 100, force: 'rebuild' }), 'rebuild');
    assert.equal(mode({ ...sw, nU: 0, dim: null, force: 'rebuild' }), 'mirror', 'an admin rebuild with no new vectors does nothing');
    assert.equal(mode({ ...sw, nU: 0, dim: null, settled: true }), 'mirror', 'a rebuild always needs vectors');
  });

  test('refit, place and mirror', () => {
    assert.equal(mode({ nNew: 150, fittedAt: 0, serving: S({ fittedAt: now - 7 * H }) }), 'refit');
    assert.equal(mode({ nNew: 150, serving: S({ fittedAt: now - 5 * H }) }), 'place', 'never within 6 h of a fit');
    assert.equal(mode({ nGone: 150, serving: S({ fittedAt: now - 7 * H }) }), 'refit');
    assert.equal(mode({ nNew: 25, serving: S({ fittedAt: now - 25 * H }) }), 'refit', 'a day old and max(25, 2 %) new');
    assert.equal(mode({ nNew: 24, serving: S({ fittedAt: now - 25 * H }) }), 'place');
    assert.equal(mode({ nGone: 1 }), 'place');
    assert.equal(mode({ serving: S({ dirty: 1 }) }), 'place');
    assert.equal(mode({}), 'mirror');
  });

  test('landmarks that left since the fit: a refit at 15 % of the fit set, and before too few are left', () => {
    const fit = (live, over = {}) => S({ fittedAt: now - 7 * H, nFit: 1000, nFitLive: live, ...over });
    const decide = (over) => L.decideMapMode({ model: 'm', dim: 64, nU: 1000, nowMs: now, ...over });
    // Each pass under every threshold (5 new, 5 gone), but 150 of the 1,000
    // landmarks left since the fit: the gone rule, counted cumulatively.
    assert.deepEqual(decide({ nNew: 5, nGone: 5, serving: fit(850) }),
      { mode: 'refit', method: 'umap', reason: 'landmarks left the library' });
    assert.equal(mode({ nNew: 5, nGone: 5, serving: fit(851) }), 'place');
    assert.equal(mode({ serving: fit(850) }), 'refit', 'with nothing new this pass, too');
    assert.equal(mode({ nNew: 5, serving: fit(850, { fittedAt: now - 5 * H }) }), 'place', 'never within 6 h of a fit');
    // Fewer live landmarks than one placement takes as neighbours: a place
    // run would have nothing left to measure against, so a warm refit —
    // even within 6 h of the fit, and never the cold rebuild that would
    // reshuffle the surviving songs.
    const soon = { fittedAt: now - 1 * H, nP: 160, nPinL: 60 };
    assert.deepEqual(decide({ nU: 70, nNew: 10, nGone: 100, serving: fit(0, soon) }),
      { mode: 'refit', method: 'umap', reason: 'landmarks left the library' });
    assert.deepEqual(decide({ nU: 70, nGone: 100, serving: fit(0, { nP: 160, nPinL: 60 }) }),
      { mode: 'refit', method: 'umap', reason: 'landmarks left the library' }, 'past 6 h too: the plan\'s refit row');
    assert.equal(mode({ nNew: 10, serving: fit(L.KNN_PLACE_K - 1, soon) }), 'refit');
    assert.equal(mode({ serving: fit(L.KNN_PLACE_K - 1, soon) }), 'refit', 'with nothing new or gone this pass');
    assert.equal(mode({ nNew: 10, serving: fit(L.KNN_PLACE_K, soon) }), 'place');
    // The rebuild rows still come first.
    assert.equal(mode({ nU: 2001, nNew: 1001, serving: fit(0, soon) }), 'rebuild', 'the library more than doubled');
    assert.equal(mode({ nU: 30, serving: fit(0, soon) }), 'rebuild', 'umap → pca2');
    // A pca2 layout has no landmarks (its points are all 'pca2'), and a
    // layout read without the counts keeps the per-pass rules.
    assert.equal(mode({ nU: 30, serving: S({ method: 'pca2', nP: 30, nPinL: 30, nFit: 30, nFitLive: 0 }) }), 'mirror');
    assert.equal(mode({ nNew: 5, serving: S({ fittedAt: now - 7 * H }) }), 'place');
  });
});

// ── recent ──────────────────────────────────────────────────────────────────

describe('recent', () => {
  test('the cutoff is 00:00 UTC thirty days back, formatted like tracks.created_at', () => {
    assert.equal(L.utcMidnightDaysAgo(30, Date.UTC(2026, 10, 2, 15, 4, 5)), '2026-10-03 00:00:00');
    assert.equal(L.utcMidnightDaysAgo(0, Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01 00:00:00');
    assert.equal(L.sqliteUtcToSec('2026-11-02 10:00:00'), Date.UTC(2026, 10, 2, 10) / 1000);
    assert.equal(L.sqliteUtcToSec('garbage'), null);
    assert.equal(L.sqliteUtcToSec(null), null);
    assert.equal(L.MAP_FLAG_RECENT, 1);
  });
});

// ── the bun leg ─────────────────────────────────────────────────────────────

describe('bun', { skip: noBun || (process.versions.bun ? 'already running under bun' : false) }, () => {
  test('the runtime-independent outputs are byte-identical under Bun', () => {
    const script = [
      `import * as L from ${JSON.stringify(pathToFileURL(MAP_LIB).href)};`,
      'import crypto from \'node:crypto\';',
      `const goldenSet = ${goldenSet.toString()};`,
      `const crossRuntimeDigest = ${crossRuntimeDigest.toString()};`,
      'console.log(JSON.stringify(crossRuntimeDigest(L, goldenSet, crypto)));',
    ].join('\n');
    const res = spawnSync(BUN_BIN, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    const bun = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.deepEqual(bun, crossRuntimeDigest(L, goldenSet, crypto));
    assert.equal(bun.pca, GOLDEN_PCA);
  });
});
