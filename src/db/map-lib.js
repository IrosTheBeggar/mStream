// The music map's pure core (Atlas; docs/music-map-plan.md §3.4–§3.5, §3.8.9):
// every algorithm and codec the map worker (src/db/map-layout.mjs), the map
// routes (src/api/discovery-map.js) and the tests share. Pure: no I/O, no
// umap-js (src/db/map-umap.js is its only importer), no config or manager
// singletons — importable from the worker, the server and any test, under
// Node and Bun. Deterministic: the same input gives the same bytes within a
// runtime; the PCA basis is bit-identical across runtimes too (only + − × ÷ √
// on its path). Callers sort their rows by audio_hash (compareHash) before
// anything order-sensitive.
//
// No spread arguments over point arrays anywhere: Math.min(...xs) throws
// "Maximum call stack size exceeded" near 150,000 elements under Node 26.
//
// ── Frames and units ─────────────────────────────────────────────────────────
//   hashes      canonical audio hashes (32 lower-case hex; any string works),
//               sorted ascending with compareHash (code-unit order, equal to
//               SQLite's BINARY collation for ASCII)
//   vectors     current-model embeddings, dim × f32, L2-normalised
//   PCA space   Z: Float32Array(n·k), row i = point i's k components
//               (k = pcaComponents(dim, nSample) ≤ 50); Euclidean distances
//   xy          every 2-D array is interleaved: Float64Array(2n) = x0,y0,x1,y1…
//   raw         the layout frame UMAP, pca2 and kNN placement work in
//               (umap-js units, spans of ~10–40; pca2: PCA units)
//   map         raw through the layout's affine [a,b,c,d,e,f]:
//               (a·rx + b·ry + c, d·rx + e·ry + f) — [0,1]² after fitBox
//               (±0.02 after a warm refit); y grows DOWN, PC2 points up
//   u16         map × 65535, rounded and clamped (quantU16): payload and land
//   land grid   LAND_N² cells over [0,1]²; cell (x, y) is centred at
//               ((x + .5)/N, (y + .5)/N)
//   dots        near-duplicate groups (step 7): every list that "counts dots"
//               (regions, land, mixes) holds one entry per dot, sorted by dot
//               label, so ties broken "by hash" are ties broken by index
//
// ── Exports, in worker step order (§3.4.4) ───────────────────────────────────
// Constants: MAP_LAYOUT_VERSION, MAP_NEAR_DUP, MAP_PCA_NEAR_DUP_BOUND,
//   FIT_FLOOR, FIT_CEIL, PLACE_MAX, PLACE_CHECK_EVERY, PCA_* (sample cap,
//   k cap, seed, oversampling, power iterations), PCA2_BELOW, UMAP_PARAMS
//   {nNeighbors, minDist, seed}, UMAP_REFIT {nEpochs, learningRate},
//   UMAP_MIN_FIT, UMAP_INIT_BOX, KNN_PLACE_K, JITTER_SHARE, DISPLACE_K,
//   FIT_MARGIN, BOX_PAD, BOX_OUTSIDE_SHARE, ROTATE_STEP_DEG, GRID_CELL_SHARE,
//   TOWN_*, LLOYD_MAX_ITER, PROVINCE_K_MAX, STYLE_*, DISPLAY_STYLE,
//   SHORT_GENRE, JACCARD_KEEP, HUE_*, MIX_MAX, LAND_*, REGION_NONE (255),
//   MAP_FLAG_RECENT, MAP_RECENT_DAYS, KiB, MiB, MAP_RSS_SLACK, REFIT_*,
//   SWITCH_COVERAGE
//
// Helpers
//   mulberry32(seed) → () → [0,1)            seeded PRNG (pure integer maths)
//   compareHash(a, b) → −1|0|1               the hash sort order
//   hashSeed32(hash) → u32                   first 8 hex digits (FNV-1a fallback)
//   cosine(a, b) → number                    exact cosine of two vectors
//
// 1 Inventory
//   mapMethod(nU) → 'pca2'|'umap'            pca2 below PCA2_BELOW songs
//   decideMapMode({model, dim, nU, serving, nNew, nGone, settled, force,
//     nowMs}) → {mode, method, reason}       the §3.4.2 table, first match wins.
//     serving = null | {modelId, method, dim, layoutVersion, fittedAt (ms),
//     dirty (bool), nP = |P|, nPinL = |P ∩ L|, nU = the |U| it was fitted
//     for (params.nU; optional), nFit = its fit set at the fit (n_fit) and
//     nFitLive = its landmarks still in the library (both optional)};
//     dim = the blobs' dim (null when U is empty);
//     mode ∈ empty|mirror|rebuild|refit|place
//
// 2 PCA (sample = the ≤ PCA_SAMPLE_MAX lowest hashes of U)
//   pcaComponents(dim, nSample) → k          min(50, dim, nSample − 1), ≥ 0
//   randomizedPCA(X, m, d, {k, oversample, powerIters, seed}) → {k, dim,
//     mean: Float64Array(d), axes: Float64Array(k·d) row-major orthonormal,
//     variance: Float64Array(k) non-increasing, totalVariance}
//                                            X = Float32Array(m·d) sample rows.
//                                            Rademacher test matrix, signs
//                                            normalised (largest |component| > 0)
//   basisF32(pca) → {k, dim, mean: Float32Array, axes: Float32Array}
//                                            the stored form (pca_mean, pca_axes);
//                                            project with it so a rebuild and a
//                                            later place run agree bit for bit
//   projectInto(vec, vo, basis, out, oo)     one vector (at vec[vo]) → out[oo..+k]
//   projectRows(X, n, d, basis, out?) → Float32Array(n·k)
//   rowsOf(z, k, idx?) → number[][]          plain rows for fitUmap
//   pcaInit(z, k, idx?) → Float64Array(2m)   (Z₀, Z₁) scaled by max-abs into ±10
//   pca2Raw(z, k, n) → Float64Array(2n)      raw = (Z₀, Z₁); (Z₀, 0) at k = 1;
//                                            (0, 0) at k = 0
//
// 3 Fit set and budget: F = the min(nFitMax, |U|) lowest hashes of U, in
//   every mode that fits (U sorted by compareHash, then sliced); refits and
//   placements cap nFitMax at S.params.nFitMax. A UMAP fit needs
//   |F| ≥ UMAP_MIN_FIT.
//   mapFitBudget({runtime, totalMemBytes, constrainedBytes, cgroupLimitBytes,
//     cgroupUsageBytes, memAvailableBytes, parentRssBytes, nEmbedded, dim,
//     override, fitFloor}) → {nFitMax, budget, base, perPoint, limit,
//     available, indexRoom}                  bytes; §3.4.6's formula. Pass only
//                                            the readings you have (Linux:
//                                            MemAvailable and the cgroup).
//                                            `override` (mapMaxFitTracks, or
//                                            the queue's halved cap) caps the
//                                            derived size, never raises it
//   fitFitsBudget(b, nFit) → bool            base + perPoint·nFit ≤ budget
//   rssOverBudget(rss, b) → bool             rss > budget + MAP_RSS_SLACK
//   parseMemAvailable(text) → bytes|null     /proc/meminfo
//   parseCgroupLimit(text) → bytes (0 = none)   memory.max / limit_in_bytes
//   parseCgroupUsage(text) → bytes           memory.current / usage_in_bytes
//
// 4 Layout (UMAP itself: map-umap.js fitUmap)
//   rawSpan(xy) → [spanX, spanY]
//   procrustes(A, B) → {R: [r00,r01,r10,r11], s, t: [tx,ty], disparity}
//                                            the similarity (rotation, uniform
//                                            scale, translation; no reflection)
//                                            taking B onto A; disparity on the
//                                            unit-normalised centred sets
//   applySimilarity(T, xy, out?) → Float64Array
//   Refit recipe: init = applyAffine(invertAffine(S.affine), stored x,y) for F
//   members with a point, knnPlace against S's fit set for the others; fit
//   with UMAP_REFIT; T = procrustes(prevRaw, newRaw) over the members that had
//   points; applySimilarity(T, all new raw).
//
// 5 kNN placement (reference = the layout's fit set, placed = 'fit', in
//   every mode: refZ = their PCA rows, refRaw = their raw coordinates, i.e.
//   the inverse affine of their stored x, y; batches of PLACE_CHECK_EVERY,
//   at most PLACE_MAX per run)
//   knnPlace({refZ, refRaw, k, queryZ, hashes, span, neighbours, nearBound})
//     → {raw, pre: Float64Array(2q), near: [q, ref][]}
//                                            k nearest (≤ 10) by squared PCA
//                                            distance, w = 1/(1e-6 + d²);
//                                            raw = pre + jitter; near = kept
//                                            neighbours within nearBound
//   jitterFromHash(hash, spanX, spanY) → [jx, jy]   |j| ≤ JITTER_SHARE·span
//   displacementField({oldL, newL, points, k}) → Float64Array(2p)
//                                            point + Σw·(newL − oldL)/Σw over
//                                            its k nearest landmarks by old
//                                            position (any one frame)
//
// 6 Rotate, flip and fit (rebuild)
//   layoutAffine(raw, {z, k}) → {affine, aspect, deg, flipX, flipY}
//   rotateNearSquare(xy) → {deg, angle, score}   0–177° by 3°
//   rotationScore(xy, deg) → |ln aspect| + deg·1e-4
//   rotateXY(xy, angle, out?) → Float64Array
//   flipRule(z, k, xy) → {flipX, flipY}      corr(Z₀,x) < 0 → flip x;
//                                            corr(Z₁,y) > 0 → flip y
//   fitBox(xy, margin?) → {scale, ox, oy, loX, loY, aspect}
//   composeAffine({angle, flipX, flipY, box}) → affine
//   applyAffine(A, xy, out?) / invertAffine(A) → affine
//   needsBoxRefit(mapXY) → bool              > 1 % outside [−0.02, 1.02]²
//   refitAffine(A, mapXY) → {affine, aspect} fitBox(map) ∘ A (frame += 1)
//
// 7 Near-duplicate dots (candidates are index pairs; map them to hashes)
//   knnGraphPairs(knnIndices, knnDistances, bound?) → [i, j][]   i < j; the
//                                            fit's graph (fitted pairs)
//   knnPlace(...).near                       placed ↔ landmark pairs
//   gridCandidates(xy, cell, {z, k, maxDist}) → [i, j][]   placed ↔ placed:
//                                            pre-jitter raw of the placed
//                                            points, cell = GRID_CELL_SHARE ×
//                                            the larger raw span, 3 × 3 cells,
//                                            kept within maxDist in PCA space
//   groupNearDuplicates(pairs, verify, previous, {hashes, keepLabels,
//     reverify}) → Map<hash, dot>            union-find over hash pairs;
//                                            verify(hA, hB) checks the exact
//                                            vectors (cos ≥ MAP_NEAR_DUP).
//                                            keepLabels for place runs
//                                            (previous = every point's dot);
//                                            labels recomputed otherwise
//   groupsOf(dotOf) → Map<dot, hash[]>       labels and members sorted. A
//                                            dot's x, y, regions and
//                                            centralities come from its label
//                                            member when present, else from
//                                            any existing member (they all
//                                            carry the dot's values)
//
// 8 Regions (map positions of dots; one entry per dot, sorted by label)
//   townCount(n, {small}) → K1               n = dots clustered (the fit set's
//                                            dots); small = the pca2 rule
//   kmeansPP(xy, K, {restarts, seed, maxIter}) → {centres, assign, inertia}
//   lloyd(xy, centres, {maxIter}) → {centres, assign, inertia}   warm start
//   resizeCentres(centres, K, xy) → Float64Array(2K)
//   assignNearest(xy, centres) → Int32Array
//   compactClusters(assign, centres) → {assign, centres, sizes, map}
//   topStyle(genreTagsJson) → 'Genre---Style'|null   a dot's style = its
//                                            label member's top style
//   styleDisplay(style), genreOfStyle(style), genreLabel(genre) → string
//   townLabel(memberStyles, globalCounts, nTotal) → {style, label, genre}
//   matchRegionKeys(newSets, olds, {minJaccard}) → Int32Array (old index|−1)
//   buildRegions({xy, styles, members, townAssign, townCentres, previous,
//     provinceCentres, nextKey}) → {provinces, towns, region0, region1,
//     nextKey}                               ids, keys, labels, anchors,
//                                            extents, sizes, prevHue
//   assignToTowns(xy, townCentres, townParent) → {region0, region1}
//   refreshRegionGeometry({xy, region0, region1, nProvinces, nTowns,
//     townCentres, townParent}) → {provinces, towns}   size, x, y, anchor,
//                                            extent, dots per region id
//   centrality(z, k, assign, nRegions) → Float64Array   −‖z − mean‖ per dot
//                                            (z = the label member's row)
//   regionMix(members, z, k, central, {max}) → Int32Array   dot indices in
//                                            walk order (store their labels)
//   Recipes: rebuild — kmeansPP(fit dots, townCount) → assignNearest(all
//   dots) → compactClusters → buildRegions (previous = the old layout's
//   regions, for keys). Refit — displacementField moves the previous town
//   centres (old → new landmark map positions) → resizeCentres → lloyd over
//   the fit dots → assignNearest → compactClusters → buildRegions
//   (provinceCentres moved the same way when provinces are unlabelled).
//   Place — assignToTowns for new dots → refreshRegionGeometry → centrality
//   → regionMix for the regions whose membership changed. Towns take their
//   province's hue.
//
// 9 Land and hues
//   landSigma(nDots) → σ
//   buildLand({xy, province, nProvinces, sigma, N, provinceCap, layoutCap})
//     → {levels: {sigma, coast, mid, high} (land_levels), land: Uint8Array[]
//     (land-v1 per province id), eps: Float64Array, field}
//   landField({xy, province, nProvinces, sigma, N}) → {N, sigma, rad, xy,
//     dotsOf, boxes, total, best, second, owner}   per-cell density sums
//   landLevels(field, {coast}) → {sigma, coast, mid, high}
//   contourRings(get, [x0, y0, x1, y1], N) → Float64Array[]   marching
//                                            squares, rings in map units
//   simplifyClosed(ring, eps), chaikin(ring, iters), ringArea(ring),
//   normaliseRingU16(ring) → Uint16Array|null, pointInRings(px, py, rings)
//                                            → bool (even-odd)
//   landAdjacency(field, coast) → [p, q][]   provinces whose coasts touch or
//                                            come within ⌈3σ·N⌉ cells
//   assignHues(provinces, adjacency, opts) → Int16Array (hue per id)
//                                            provinces = [{id, size,
//                                            prevHue}] (buildRegions' output)
//
// Codecs (§3.8.9; all little-endian)
//   quantU16(v), encodePointsColsV1(cols), decodePointsColsV1(bytes, n),
//   encodeBitset(n, bitAt), bitsetGet(bytes, i), encodeLandV1(levels),
//   decodeLandV1(bytes), f32ToBytes(arr), f32FromBytes(blob, count?)
//
// Recent (routes)
//   utcMidnightDaysAgo(days, nowMs) → 'YYYY-MM-DD 00:00:00'
//   sqliteUtcToSec(text) → epoch seconds|null

// ── constants ───────────────────────────────────────────────────────────────

// Bumping it forces one rebuild everywhere (§3.4.2), like a head-version pin.
export const MAP_LAYOUT_VERSION = 1;
// Same value as discovery-novelty.js's NEAR_DUP (a unit test pins the two
// together); restated because that module imports manager.js.
export const MAP_NEAR_DUP = 0.99;
// cos ≥ 0.99 ⇔ ‖a − b‖ ≤ 0.141421… for unit vectors, and a projection never
// lengthens a distance: an exact pre-filter in PCA space.
export const MAP_PCA_NEAR_DUP_BOUND = 0.1415;

export const FIT_FLOOR = 1000;
export const FIT_CEIL = 20000;
export const PLACE_MAX = 20000;
export const PLACE_CHECK_EVERY = 100;

export const PCA_SAMPLE_MAX = 5000;
export const PCA_K_MAX = 50;
export const PCA_SEED = 11;
export const PCA_OVERSAMPLE = 10;
export const PCA_POWER_ITERS = 2;
export const PCA2_BELOW = 50;

export const UMAP_PARAMS = Object.freeze({ nNeighbors: 15, minDist: 0.5, seed: 42 });
export const UMAP_REFIT = Object.freeze({ nEpochs: 150, learningRate: 0.3 });
// umap-js throws when n ≤ nNeighbors.
export const UMAP_MIN_FIT = UMAP_PARAMS.nNeighbors + 1;
// umap-js's own random init spans ±10; a PCA-2 init is scaled into the same box.
export const UMAP_INIT_BOX = 10;

export const KNN_PLACE_K = 10;
export const JITTER_SHARE = 0.0025;
export const DISPLACE_K = 8;

export const FIT_MARGIN = 0.04;
export const BOX_PAD = 0.02;
export const BOX_OUTSIDE_SHARE = 0.01;
export const ROTATE_STEP_DEG = 3;
export const GRID_CELL_SHARE = 0.005;

export const TOWN_K_MIN = 2;
export const TOWN_K_MAX = 120;
export const TOWN_RESTARTS = 4;
export const TOWN_SEED = 300;
export const LLOYD_MAX_ITER = 100;
export const PROVINCE_K_MAX = 12;

export const STYLE_MIN_SHARE = 0.15;
// Longer elements are skipped: a label is drawn on every client.
export const STYLE_MAX_LENGTH = 128;
export const DISPLAY_STYLE = Object.freeze({
  'Hip Hop---Instrumental': 'Instrumental Hip-Hop',
  'Hip Hop---Conscious': 'Conscious Hip-Hop',
  'Classical---Modern': 'Modern Classical',
});
export const SHORT_GENRE = Object.freeze({
  'Funk / Soul': 'Soul',
  'Folk, World, & Country': 'Folk',
  'Stage & Screen': 'Score',
});

export const JACCARD_KEEP = 0.5;

// Every 5° on 0–355 except 35–85: the webapp accent #fa832b sits near 50°
// and the phone's amber #ffab00 near 70° (61 candidates).
export const HUE_STEP = 5;
export const HUE_GAP = Object.freeze([35, 85]);
export const HUE_CANDIDATES = Object.freeze((() => {
  const out = [];
  for (let h = 0; h < 360; h += HUE_STEP) {
    if (h < HUE_GAP[0] || h > HUE_GAP[1]) { out.push(h); }
  }
  return out;
})());
export const HUE_MIN_APART = 60;

export const MIX_MAX = 64;

export const LAND_N = 400;
export const LAND_COAST = 0.45;
export const LAND_MID_PCT = 0.005;
export const LAND_HIGH_PCT = 0.04;
export const LAND_EPS = 0.0007;
export const LAND_MIN_AREA = 1.2e-5;
export const LAND_FINAL_EPS = 3e-4;
export const LAND_EPS_GROWTH = 1.5;
export const LAND_PROVINCE_CAP = 64 * 1024;
export const LAND_LAYOUT_CAP = 256 * 1024;
const LAND_CAP_STEPS = 64;

// Payload region ids are u8; 255 means none.
export const REGION_NONE = 255;
export const MAP_FLAG_RECENT = 1;
export const MAP_RECENT_DAYS = 30;

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const MAP_RSS_SLACK = 64 * MiB;

export const SWITCH_COVERAGE = 0.9;
export const REFIT_SHARE = 0.15;
export const REFIT_DAILY_MIN = 25;
export const REFIT_DAILY_SHARE = 0.02;
export const REFIT_AGE_MS = 24 * 60 * 60 * 1000;
export const REFIT_MIN_AGE_MS = 6 * 60 * 60 * 1000;

// ── helpers ─────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function compareHash(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const HEX8 = /^[0-9a-fA-F]{8}/;
export function hashSeed32(hash) {
  const s = String(hash);
  if (HEX8.test(s)) { return parseInt(s.slice(0, 8), 16) >>> 0; }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na * nb);
  return den > 0 ? s / den : 0;
}

// ── 1 · inventory: the mode table (§3.4.2) ─────────────────────────────────

export function mapMethod(nU) {
  return nU < PCA2_BELOW ? 'pca2' : 'umap';
}

export function decideMapMode({
  model, dim = null, nU, serving = null, nNew = 0, nGone = 0, settled = false, force = null, nowMs,
}) {
  const S = serving;
  if (nU === 0 && (!S || !(S.nPinL > 0))) {
    return { mode: 'empty', method: null, reason: 'nothing analysed' };
  }
  if (S && S.modelId !== model && !settled && !(nU >= SWITCH_COVERAGE * S.nPinL)
      && !(force === 'rebuild' && nU > 0)) {
    return { mode: 'mirror', method: S.method, reason: 'model switch pending' };
  }
  const want = mapMethod(nU);
  let why = null;
  if (!S) { why = 'no layout'; }
  else if (S.modelId !== model) { why = 'model switch'; }
  else if (S.layoutVersion !== MAP_LAYOUT_VERSION) { why = 'layout version'; }
  else if (dim != null && S.dim !== dim) { why = 'dimension'; }
  else if (force === 'rebuild' && nU > 0) { why = 'forced'; }
  else if (S.method !== want) { why = 'method'; }
  else if (S.method === 'pca2' && (nNew > 0 || nGone > 0)) { why = 'small library changed'; }
  // Against the larger of |P| and the |U| the layout was fitted for: a
  // rebuild or refit that hit placeMax places the rest over the next runs,
  // which must stay place runs instead of rebuilding again.
  else if (nNew >= Math.max(S.nP, S.nU ?? 0)) { why = 'library more than doubled'; }
  if (why) {
    // A rebuild always needs current-model vectors; without any, keep S.
    if (nU > 0) { return { mode: 'rebuild', method: want, reason: why }; }
    return { mode: 'mirror', method: S.method, reason: `${why}, no current-model vectors` };
  }
  const age = nowMs - S.fittedAt;
  // Landmarks lost since the fit: they are a uniform sample of the library
  // at the fit, so this is the gone rule counted cumulatively. Per pass, a
  // library that rotates slowly never trips a threshold, while each place
  // run prunes the landmarks whose songs left — without this the fit set
  // erodes until nothing is left to place against.
  const landmarksLost = S.method === 'umap' && Number.isInteger(S.nFit) && S.nFit > 0
    && Number.isInteger(S.nFitLive) && S.nFit - S.nFitLive >= REFIT_SHARE * S.nFit;
  // Fewer landmarks left in the library than one placement takes as
  // neighbours: the fit's songs left faster than the 6 h gate lets a refit
  // follow, and a place run would prune the last of what it measures
  // against. A warm refit now, whatever the layout's age — it keeps the
  // basis, the keys and the surviving songs' positions, which a rebuild
  // would reshuffle (the gate only paces refits that follow real change).
  const fewLandmarks = S.method === 'umap' && Number.isInteger(S.nFitLive) && S.nFitLive < KNN_PLACE_K;
  if (S.method === 'umap' && (fewLandmarks || (age >= REFIT_MIN_AGE_MS && (
    nNew >= REFIT_SHARE * S.nP || nGone >= REFIT_SHARE * S.nP || landmarksLost
    || (age >= REFIT_AGE_MS && nNew >= Math.max(REFIT_DAILY_MIN, REFIT_DAILY_SHARE * S.nP)))))) {
    return {
      mode: 'refit', method: 'umap', reason: fewLandmarks || landmarksLost ? 'landmarks left the library' : 'library changed',
    };
  }
  if (nNew > 0 || nGone > 0 || S.dirty) {
    return { mode: 'place', method: S.method, reason: S.dirty && !nNew && !nGone ? 'dirty' : 'new or gone songs' };
  }
  return { mode: 'mirror', method: S.method, reason: 'nothing changed' };
}

// ── 3 · memory budget (§3.4.6) ─────────────────────────────────────────────

export function mapFitBudget({
  runtime = 'node', totalMemBytes, constrainedBytes = 0, cgroupLimitBytes = 0, cgroupUsageBytes = 0,
  memAvailableBytes = null, parentRssBytes = 0, nEmbedded = 0, dim = 0, override, fitFloor = FIT_FLOOR,
} = {}) {
  const bun = runtime === 'bun';
  const perPoint = (bun ? 120 : 55) * KiB;
  const base = (bun ? 100 : 150) * MiB;
  const limit = Math.min(totalMemBytes,
    cgroupLimitBytes > 0 ? cgroupLimitBytes : Infinity,
    constrainedBytes > 0 ? constrainedBytes : Infinity);
  // The plan's `linux ? min(MemAvailable, cgroup room) : null`, taking only
  // the readings that exist (a missing one must not turn the budget NaN).
  let available = Number.isFinite(memAvailableBytes) ? memAvailableBytes : null;
  if (cgroupLimitBytes > 0) {
    const room = Math.max(0, cgroupLimitBytes - cgroupUsageBytes);
    available = available === null ? room : Math.min(available, room);
  }
  // One similarity-index rebuild in the server can coincide with the fit.
  const indexRoom = 2 * nEmbedded * dim * 4;
  const budget = Math.min(0.35 * limit, limit - parentRssBytes - 256 * MiB,
    available === null ? Infinity : 0.6 * available - indexRoom);
  const derived = Number.isFinite(budget) ? Math.floor((budget - base) / perPoint) : fitFloor;
  let nFitMax = clamp(derived, fitFloor, FIT_CEIL);
  // A cap, never a raise: a fit past the derived size fails the pre-fit
  // check anyway (fitFitsBudget against this same budget), so an override
  // above it — the queue's halved cap once a larger library has shrunk the
  // budget, say — would turn every pass into a memory-guard exit.
  if (Number.isInteger(override)) { nFitMax = Math.min(nFitMax, clamp(override, fitFloor, FIT_CEIL)); }
  return { nFitMax, budget, base, perPoint, limit, available, indexRoom };
}

export function fitFitsBudget(b, nFit) {
  return b.base + b.perPoint * nFit <= b.budget;
}

export function rssOverBudget(rss, b) {
  return rss > b.budget + MAP_RSS_SLACK;
}

export function parseMemAvailable(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text ?? ''));
  return m ? Number(m[1]) * 1024 : null;
}

// cgroup v2 memory.max says "max", v1 a huge sentinel (9223372036854771712):
// both mean no limit (0).
export function parseCgroupLimit(text) {
  const s = String(text ?? '').trim();
  if (!/^\d+$/.test(s)) { return 0; }
  const v = Number(s);
  return v > 0 && v < 2 ** 60 ? v : 0;
}

export function parseCgroupUsage(text) {
  const s = String(text ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : 0;
}

// ── 2 · PCA (§3.5.1) ───────────────────────────────────────────────────────

export function pcaComponents(dim, nSample) {
  return Math.max(0, Math.min(PCA_K_MAX, dim, nSample - 1));
}

// Modified Gram–Schmidt, twice, over Float64Array columns. A zero column
// stays zero.
function orthonormalize(cols) {
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < cols.length; c++) {
      const v = cols[c];
      for (let p = 0; p < c; p++) {
        const u = cols[p];
        let s = 0;
        for (let i = 0; i < v.length; i++) { s += u[i] * v[i]; }
        for (let i = 0; i < v.length; i++) { v[i] -= s * u[i]; }
      }
      let nn = 0;
      for (let i = 0; i < v.length; i++) { nn += v[i] * v[i]; }
      const inv = 1 / (Math.sqrt(nn) || 1);
      for (let i = 0; i < v.length; i++) { v[i] *= inv; }
    }
  }
  return cols;
}

// Cyclic Jacobi on a small symmetric matrix (m × m, row-major). Converges to
// exact zeros: from the fifth sweep an off-diagonal element too small to
// change either diagonal is zeroed, and the loop stops at a sweep with none
// left. Only + − × ÷ √ abs and comparisons: bit-identical across runtimes.
function jacobiEigen(A, m) {
  const a = Float64Array.from(A);
  const V = new Float64Array(m * m);
  for (let i = 0; i < m; i++) { V[i * m + i] = 1; }
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < m; p++) { for (let q = p + 1; q < m; q++) { off += Math.abs(a[p * m + q]); } }
    if (off === 0) { break; }
    for (let p = 0; p < m; p++) {
      for (let q = p + 1; q < m; q++) {
        const apq = a[p * m + q];
        if (apq === 0) { continue; }
        const app = a[p * m + p], aqq = a[q * m + q];
        const g = 100 * Math.abs(apq);
        if (sweep > 3 && Math.abs(app) + g === Math.abs(app) && Math.abs(aqq) + g === Math.abs(aqq)) {
          a[p * m + q] = 0;
          a[q * m + p] = 0;
          continue;
        }
        const theta = (aqq - app) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < m; k++) {
          const akp = a[k * m + p], akq = a[k * m + q];
          a[k * m + p] = c * akp - s * akq;
          a[k * m + q] = s * akp + c * akq;
        }
        for (let k = 0; k < m; k++) {
          const apk = a[p * m + k], aqk = a[q * m + k];
          a[p * m + k] = c * apk - s * aqk;
          a[q * m + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < m; k++) {
          const vkp = V[k * m + p], vkq = V[k * m + q];
          V[k * m + p] = c * vkp - s * vkq;
          V[k * m + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [];
  for (let i = 0; i < m; i++) { idx.push(i); }
  idx.sort((i, j) => a[j * m + j] - a[i * m + i]);   // stable: ties keep index order
  const values = new Float64Array(m);
  const vectors = [];
  for (let r = 0; r < m; r++) {
    const i = idx[r];
    values[r] = a[i * m + i];
    const v = new Float64Array(m);
    for (let k = 0; k < m; k++) { v[k] = V[k * m + i]; }
    vectors.push(v);
  }
  return { values, vectors };
}

// Randomized PCA (Halko, Martinsson & Tropp) of the m rows of X (m × d,
// centred on the fly): l = k + oversample Rademacher (±1) test vectors from
// mulberry32, powerIters power iterations, B = QᵀXc, the l × l Gram matrix
// by Jacobi, axes = Bᵀu/σ re-orthonormalised, each axis's largest-|component|
// made positive. k is clamped to min(m − 1, d), so tiny samples never read
// past the eigenvectors.
export function randomizedPCA(X, m, d, {
  k = pcaComponents(d, m), oversample = PCA_OVERSAMPLE, powerIters = PCA_POWER_ITERS, seed = PCA_SEED,
} = {}) {
  const mean = new Float64Array(d);
  for (let r = 0; r < m; r++) {
    const o = r * d;
    for (let j = 0; j < d; j++) { mean[j] += X[o + j]; }
  }
  if (m > 0) { for (let j = 0; j < d; j++) { mean[j] /= m; } }
  const xc = new Float64Array(d);
  const centre = (r) => {
    const o = r * d;
    let ss = 0;
    for (let j = 0; j < d; j++) { const v = X[o + j] - mean[j]; xc[j] = v; ss += v * v; }
    return ss;
  };
  let totalSS = 0;
  for (let r = 0; r < m; r++) { totalSS += centre(r); }
  const denom = Math.max(m - 1, 1);
  const kk = Math.max(0, Math.min(k, m - 1, d));
  if (kk === 0) {
    return { k: 0, dim: d, mean, axes: new Float64Array(0), variance: new Float64Array(0), totalVariance: totalSS / denom };
  }
  const l = Math.min(kk + oversample, d, m);
  const rand = mulberry32(seed);
  let omega = [];
  for (let c = 0; c < l; c++) {
    const v = new Float64Array(d);
    for (let j = 0; j < d; j++) { v[j] = rand() < 0.5 ? -1 : 1; }
    omega.push(v);
  }
  const timesX = (cols) => {   // Xc · cols → columns of length m
    const Y = cols.map(() => new Float64Array(m));
    for (let r = 0; r < m; r++) {
      centre(r);
      for (let c = 0; c < cols.length; c++) {
        const v = cols[c];
        let s = 0;
        for (let j = 0; j < d; j++) { s += xc[j] * v[j]; }
        Y[c][r] = s;
      }
    }
    return Y;
  };
  const timesXt = (cols) => {   // Xcᵀ · cols → columns of length d
    const out = cols.map(() => new Float64Array(d));
    for (let r = 0; r < m; r++) {
      centre(r);
      for (let c = 0; c < cols.length; c++) {
        const q = cols[c][r];
        const o = out[c];
        for (let j = 0; j < d; j++) { o[j] += q * xc[j]; }
      }
    }
    return out;
  };
  let Y = orthonormalize(timesX(omega));
  for (let it = 0; it < powerIters; it++) {
    omega = orthonormalize(timesXt(Y));
    Y = orthonormalize(timesX(omega));
  }
  const B = timesXt(Y);
  const G = new Float64Array(l * l);
  for (let a = 0; a < l; a++) {
    for (let b = a; b < l; b++) {
      let s = 0;
      for (let j = 0; j < d; j++) { s += B[a][j] * B[b][j]; }
      G[a * l + b] = s;
      G[b * l + a] = s;
    }
  }
  const { values, vectors } = jacobiEigen(G, l);
  const cols = [];
  const variance = new Float64Array(kk);
  for (let c = 0; c < kk; c++) {
    const sv = Math.sqrt(Math.max(values[c], 0)) || 1;
    const v = new Float64Array(d);
    for (let a = 0; a < l; a++) {
      const u = vectors[c][a];
      if (u === 0) { continue; }
      const row = B[a];
      for (let j = 0; j < d; j++) { v[j] += row[j] * u; }
    }
    for (let j = 0; j < d; j++) { v[j] /= sv; }
    cols.push(v);
    variance[c] = values[c] / denom;
  }
  orthonormalize(cols);
  const axes = new Float64Array(kk * d);
  for (let c = 0; c < kk; c++) {
    const v = cols[c];
    let bi = 0, bv = -1;
    for (let j = 0; j < d; j++) { const av = Math.abs(v[j]); if (av > bv) { bv = av; bi = j; } }
    const sign = v[bi] < 0 ? -1 : 1;
    for (let j = 0; j < d; j++) { axes[c * d + j] = sign * v[j]; }
  }
  return { k: kk, dim: d, mean, axes, variance, totalVariance: totalSS / denom };
}

export function basisF32(pca) {
  return { k: pca.k, dim: pca.dim, mean: Float32Array.from(pca.mean), axes: Float32Array.from(pca.axes) };
}

// One scratch row, grown on demand (the functions below are synchronous).
let projScratch = new Float64Array(0);

export function projectInto(vec, vo, basis, out, oo) {
  const { k, dim, mean, axes } = basis;
  if (projScratch.length < dim) { projScratch = new Float64Array(dim); }
  const xc = projScratch;
  for (let j = 0; j < dim; j++) { xc[j] = vec[vo + j] - mean[j]; }
  for (let c = 0; c < k; c++) {
    const ao = c * dim;
    let s = 0;
    for (let j = 0; j < dim; j++) { s += xc[j] * axes[ao + j]; }
    out[oo + c] = s;
  }
}

export function projectRows(X, n, d, basis, out = new Float32Array(n * basis.k)) {
  if (d !== basis.dim) { throw new Error(`projectRows: rows are ${d}-d, the basis is ${basis.dim}-d`); }
  for (let i = 0; i < n; i++) { projectInto(X, i * d, basis, out, i * basis.k); }
  return out;
}

export function rowsOf(z, k, idx = null) {
  const m = idx ? idx.length : (k > 0 ? z.length / k : 0);
  const rows = new Array(m);
  for (let r = 0; r < m; r++) {
    const o = (idx ? idx[r] : r) * k;
    const row = new Array(k);
    for (let j = 0; j < k; j++) { row[j] = z[o + j]; }
    rows[r] = row;
  }
  return rows;
}

export function pcaInit(z, k, idx = null) {
  const m = idx ? idx.length : (k > 0 ? z.length / k : 0);
  const out = new Float64Array(2 * m);
  if (k < 1) { return out; }
  let mx = 0;
  for (let r = 0; r < m; r++) {
    const o = (idx ? idx[r] : r) * k;
    const a = Math.abs(z[o]);
    if (a > mx) { mx = a; }
    if (k >= 2) { const b = Math.abs(z[o + 1]); if (b > mx) { mx = b; } }
  }
  const sc = mx > 0 ? UMAP_INIT_BOX / mx : 0;
  for (let r = 0; r < m; r++) {
    const o = (idx ? idx[r] : r) * k;
    out[2 * r] = z[o] * sc;
    out[2 * r + 1] = k >= 2 ? z[o + 1] * sc : 0;
  }
  return out;
}

export function pca2Raw(z, k, n) {
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    out[2 * i] = k >= 1 ? z[i * k] : 0;
    out[2 * i + 1] = k >= 2 ? z[i * k + 1] : 0;
  }
  return out;
}

// ── 4/6 · geometry (§3.5.3) ────────────────────────────────────────────────

export function rawSpan(xy) {
  const n = xy.length >> 1;
  if (n === 0) { return [0, 0]; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    if (x < x0) { x0 = x; }
    if (x > x1) { x1 = x; }
    if (y < y0) { y0 = y; }
    if (y > y1) { y1 = y; }
  }
  return [x1 - x0, y1 - y0];
}

export function rotateXY(xy, angle, out = new Float64Array(xy.length)) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const n = xy.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    out[2 * i] = c * x - s * y;
    out[2 * i + 1] = s * x + c * y;
  }
  return out;
}

// |ln aspect| of the bounding box rotated by `deg`, plus deg·1e-4 so the
// smallest angle wins near-ties. Spans below 1e-9 count as 1e-9.
export function rotationScore(xy, deg) {
  const a = deg * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const n = xy.length >> 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = xy[2 * i], py = xy[2 * i + 1];
    const x = c * px - s * py, y = s * px + c * py;
    if (x < x0) { x0 = x; }
    if (x > x1) { x1 = x; }
    if (y < y0) { y0 = y; }
    if (y > y1) { y1 = y; }
  }
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  return Math.abs(Math.log(w / h)) + deg * 1e-4;
}

export function rotateNearSquare(xy) {
  let bestDeg = 0, bestScore = Infinity;
  for (let deg = 0; deg < 180; deg += ROTATE_STEP_DEG) {
    const score = rotationScore(xy, deg);
    if (score < bestScore) { bestScore = score; bestDeg = deg; }
  }
  return { deg: bestDeg, angle: bestDeg * Math.PI / 180, score: bestScore };
}

// Pearson correlation of PCA component `comp` with xy's axis (0 = x, 1 = y);
// 0 when either side has no spread.
function corrComponent(z, k, comp, xy, axis) {
  const n = xy.length >> 1;
  if (n < 2 || comp >= k) { return 0; }
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += z[i * k + comp]; mb += xy[2 * i + axis]; }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = z[i * k + comp] - ma, db = xy[2 * i + axis] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

// Map y grows downward, so "PC2 increases upward" means corr(Z₁, y) ≤ 0.
export function flipRule(z, k, xy) {
  return { flipX: corrComponent(z, k, 0, xy, 0) < 0, flipY: corrComponent(z, k, 1, xy, 1) > 0 };
}

// Uniform scale into [margin, 1 − margin]², centred. A zero-extent axis is
// centred at the other axis's scale; a single point (or none) maps to 0.5.
export function fitBox(xy, margin = FIT_MARGIN) {
  const n = xy.length >> 1;
  if (n === 0) { return { scale: 1, ox: 0.5, oy: 0.5, loX: 0, loY: 0, aspect: 1 }; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    if (x < x0) { x0 = x; }
    if (x > x1) { x1 = x; }
    if (y < y0) { y0 = y; }
    if (y > y1) { y1 = y; }
  }
  const wx = x1 - x0, wy = y1 - y0;
  const span = wx > wy ? wx : wy;
  const aspect = wx > 0 && wy > 0 ? wx / wy : 1;
  if (!(span > 0)) { return { scale: 1, ox: 0.5, oy: 0.5, loX: x0, loY: y0, aspect }; }
  const inner = 1 - 2 * margin;
  const scale = inner / span;
  return { scale, ox: margin + (inner - wx * scale) / 2, oy: margin + (inner - wy * scale) / 2, loX: x0, loY: y0, aspect };
}

// raw → rotate by `angle` → negate the flipped axes → box: one affine
// [a,b,c,d,e,f], map = (a·rx + b·ry + c, d·rx + e·ry + f).
export function composeAffine({ angle = 0, flipX = false, flipY = false, box }) {
  const c0 = Math.cos(angle), s0 = Math.sin(angle);
  const fx = flipX ? -1 : 1, fy = flipY ? -1 : 1, sc = box.scale;
  return [
    sc * fx * c0, -sc * fx * s0, box.ox - box.loX * sc,
    sc * fy * s0, sc * fy * c0, box.oy - box.loY * sc,
  ];
}

export function applyAffine(A, xy, out = new Float64Array(xy.length)) {
  const [a, b, c, d, e, f] = A;
  const n = xy.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    out[2 * i] = a * x + b * y + c;
    out[2 * i + 1] = d * x + e * y + f;
  }
  return out;
}

export function invertAffine(A) {
  const [a, b, c, d, e, f] = A;
  const det = a * e - b * d;
  if (!Number.isFinite(det) || det === 0) { throw new Error('invertAffine: singular affine'); }
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

export function layoutAffine(raw, { z = null, k = 0 } = {}) {
  for (let i = 0; i < raw.length; i++) {
    if (!Number.isFinite(raw[i])) { throw new Error('layoutAffine: non-finite raw coordinate'); }
  }
  const rot = rotateNearSquare(raw);
  const r1 = rotateXY(raw, rot.angle);
  const { flipX, flipY } = z && k > 0 ? flipRule(z, k, r1) : { flipX: false, flipY: false };
  if (flipX || flipY) {
    const n = r1.length >> 1;
    for (let i = 0; i < n; i++) {
      if (flipX) { r1[2 * i] = -r1[2 * i]; }
      if (flipY) { r1[2 * i + 1] = -r1[2 * i + 1]; }
    }
  }
  const box = fitBox(r1);
  return { affine: composeAffine({ angle: rot.angle, flipX, flipY, box }), aspect: box.aspect, deg: rot.deg, flipX, flipY };
}

export function needsBoxRefit(mapXY) {
  const n = mapXY.length >> 1;
  let outside = 0;
  for (let i = 0; i < n; i++) {
    const x = mapXY[2 * i], y = mapXY[2 * i + 1];
    if (x < -BOX_PAD || x > 1 + BOX_PAD || y < -BOX_PAD || y > 1 + BOX_PAD) { outside++; }
  }
  return outside > BOX_OUTSIDE_SHARE * n;
}

export function refitAffine(A, mapXY) {
  const box = fitBox(mapXY);
  const s = box.scale;
  const [a, b, c, d, e, f] = A;
  return {
    affine: [s * a, s * b, box.ox + (c - box.loX) * s, s * d, s * e, box.oy + (f - box.loY) * s],
    aspect: box.aspect,
  };
}

// The similarity (rotation R with det +1, uniform scale s, translation t)
// minimising Σ‖Aᵢ − (s·R·Bᵢ + t)‖². In 2-D the optimal angle is
// atan2(Q, P) with P = Σ a·b and Q = Σ (a_y b_x − a_x b_y) over the centred
// sets. disparity = 1 − (P² + Q²)/(‖a‖²‖b‖²), the residual after scaling both
// sets to unit norm (0 = same shape).
export function procrustes(A, B) {
  const n = Math.min(A.length, B.length) >> 1;
  if (n === 0) { return { R: [1, 0, 0, 1], s: 1, t: [0, 0], disparity: 0 }; }
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += A[2 * i]; ay += A[2 * i + 1]; bx += B[2 * i]; by += B[2 * i + 1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let P = 0, Q = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const a0 = A[2 * i] - ax, a1 = A[2 * i + 1] - ay, b0 = B[2 * i] - bx, b1 = B[2 * i + 1] - by;
    P += a0 * b0 + a1 * b1;
    Q += a1 * b0 - a0 * b1;
    saa += a0 * a0 + a1 * a1;
    sbb += b0 * b0 + b1 * b1;
  }
  if (!(sbb > 0)) { return { R: [1, 0, 0, 1], s: 1, t: [ax - bx, ay - by], disparity: saa > 0 ? 1 : 0 }; }
  const h = Math.sqrt(P * P + Q * Q);
  const c = h > 0 ? P / h : 1, sn = h > 0 ? Q / h : 0;
  const s = h / sbb;
  return {
    R: [c, -sn, sn, c],
    s,
    t: [ax - s * (c * bx - sn * by), ay - s * (sn * bx + c * by)],
    disparity: saa > 0 ? Math.max(0, 1 - (h * h) / (saa * sbb)) : 0,
  };
}

export function applySimilarity({ R, s, t }, xy, out = new Float64Array(xy.length)) {
  const n = xy.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    out[2 * i] = s * (R[0] * x + R[1] * y) + t[0];
    out[2 * i + 1] = s * (R[2] * x + R[3] * y) + t[1];
  }
  return out;
}

// ── 5 · kNN placement (§3.4.4 step 5) ──────────────────────────────────────

export function jitterFromHash(hash, spanX, spanY) {
  const u = hashSeed32(hash);
  const tx = (u >>> 16) / 65535 * 2 - 1, ty = (u & 0xffff) / 65535 * 2 - 1;
  return [tx * JITTER_SHARE * spanX, ty * JITTER_SHARE * spanY];
}

// A bounded max-heap over (distance, index): the root is the worst neighbour
// kept, and of two at one distance the higher index is the worse.
const worse = (d1, i1, d2, i2) => d1 > d2 || (d1 === d2 && i1 > i2);
function heapUp(hd, hi, pos) {
  while (pos > 0) {
    const p = (pos - 1) >> 1;
    if (!worse(hd[pos], hi[pos], hd[p], hi[p])) { break; }
    const td = hd[p]; hd[p] = hd[pos]; hd[pos] = td;
    const ti = hi[p]; hi[p] = hi[pos]; hi[pos] = ti;
    pos = p;
  }
}
function heapDown(hd, hi, size, pos) {
  for (;;) {
    const l = 2 * pos + 1, r = l + 1;
    let m = pos;
    if (l < size && worse(hd[l], hi[l], hd[m], hi[m])) { m = l; }
    if (r < size && worse(hd[r], hi[r], hd[m], hi[m])) { m = r; }
    if (m === pos) { return; }
    const td = hd[m]; hd[m] = hd[pos]; hd[pos] = td;
    const ti = hi[m]; hi[m] = hi[pos]; hi[pos] = ti;
    pos = m;
  }
}
// The heap's entries ascending by (distance, index), into nd/ni.
function heapSorted(hd, hi, size, nd, ni) {
  for (let a = 0; a < size; a++) {
    let pos = a;
    const d = hd[a], i = hi[a];
    while (pos > 0 && worse(nd[pos - 1], ni[pos - 1], d, i)) { nd[pos] = nd[pos - 1]; ni[pos] = ni[pos - 1]; pos--; }
    nd[pos] = d;
    ni[pos] = i;
  }
}

// Each query's `neighbours` nearest references by squared PCA distance
// (partial sums abandon a reference as soon as it cannot enter the heap; the
// components are in falling variance, so that is early), blended with
// w = 1/(1e-6 + d²). A placement is a pure function of the query row and the
// references, whatever the batch: callers run it in batches of
// PLACE_CHECK_EVERY and check their time budget between batches.
export function knnPlace({
  refZ, refRaw, k, queryZ, hashes = null, span = null, neighbours = KNN_PLACE_K, nearBound = 0,
}) {
  const nRef = refRaw.length >> 1;
  const nQ = k > 0 ? Math.floor(queryZ.length / k) : 0;
  const raw = new Float64Array(2 * nQ), pre = new Float64Array(2 * nQ);
  const near = [];
  if (nQ === 0) { return { raw, pre, near }; }
  if (nRef === 0) { throw new Error('knnPlace: no reference points'); }
  const kk = Math.max(1, Math.min(neighbours, nRef));
  const [sx, sy] = span ?? rawSpan(refRaw);
  const bound2 = nearBound > 0 ? nearBound * nearBound : -1;
  const hd = new Float64Array(kk), hi = new Int32Array(kk);
  const nd = new Float64Array(kk), ni = new Int32Array(kk);
  for (let q = 0; q < nQ; q++) {
    const qo = q * k;
    let size = 0;
    for (let r = 0; r < nRef; r++) {
      const ro = r * k;
      let s = 0;
      if (size < kk) {
        for (let j = 0; j < k; j++) { const t = queryZ[qo + j] - refZ[ro + j]; s += t * t; }
        hd[size] = s;
        hi[size] = r;
        heapUp(hd, hi, size);
        size++;
        continue;
      }
      const worst = hd[0];
      let j = 0;
      for (; j < k; j++) {
        const t = queryZ[qo + j] - refZ[ro + j];
        s += t * t;
        if (s > worst) { break; }
      }
      // Abandoned, or a tie: the lower index already held wins.
      if (j < k || !(s < worst)) { continue; }
      hd[0] = s;
      hi[0] = r;
      heapDown(hd, hi, kk, 0);
    }
    heapSorted(hd, hi, size, nd, ni);
    let wx = 0, wy = 0, ws = 0;
    for (let m = 0; m < size; m++) {
      const w = 1 / (1e-6 + nd[m]);
      const r = ni[m];
      wx += w * refRaw[2 * r];
      wy += w * refRaw[2 * r + 1];
      ws += w;
      if (nd[m] <= bound2) { near.push([q, r]); }
    }
    const px = wx / ws, py = wy / ws;
    pre[2 * q] = px;
    pre[2 * q + 1] = py;
    if (hashes) {
      const [jx, jy] = jitterFromHash(hashes[q], sx, sy);
      raw[2 * q] = px + jx;
      raw[2 * q + 1] = py + jy;
    } else {
      raw[2 * q] = px;
      raw[2 * q + 1] = py;
    }
  }
  return { raw, pre, near };
}

// A uniform grid over 2-D points (counting sort into cells, about two points
// per cell) for exact k-nearest queries.
function buildGrid(xy) {
  const n = xy.length >> 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    if (x < x0) { x0 = x; }
    if (x > x1) { x1 = x; }
    if (y < y0) { y0 = y; }
    if (y > y1) { y1 = y; }
  }
  const span = Math.max(x1 - x0, y1 - y0);
  const side = Math.max(1, Math.ceil(Math.sqrt(n / 2)));
  const cell = span > 0 ? span / side : 1;
  const cols = span > 0 ? Math.floor((x1 - x0) / cell) + 1 : 1;
  const rows = span > 0 ? Math.floor((y1 - y0) / cell) + 1 : 1;
  const cellOf = new Int32Array(n);
  const start = new Int32Array(cols * rows + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(cols - 1, Math.floor((xy[2 * i] - x0) / cell));
    const cy = Math.min(rows - 1, Math.floor((xy[2 * i + 1] - y0) / cell));
    cellOf[i] = cy * cols + cx;
    start[cellOf[i] + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) { start[c + 1] += start[c]; }
  const fill = start.slice(0, cols * rows);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) { items[fill[cellOf[i]]++] = i; }
  return { x0, y0, cell, cols, rows, start, items, xy };
}

// The kk nearest grid points to (qx, qy), ascending by (d², index), into
// ni/nd; returns how many were found. Rings of cells are searched outward
// until no unsearched cell can hold a closer point.
function gridKnn(g, qx, qy, kk, ni, nd) {
  const { x0, y0, cell, cols, rows, start, items, xy } = g;
  const qcx = Math.floor((qx - x0) / cell), qcy = Math.floor((qy - y0) / cell);
  const dxMin = qcx < 0 ? -qcx : (qcx >= cols ? qcx - cols + 1 : 0);
  const dyMin = qcy < 0 ? -qcy : (qcy >= rows ? qcy - rows + 1 : 0);
  const rFirst = Math.max(dxMin, dyMin);
  const rLast = Math.max(Math.abs(qcx), Math.abs(cols - 1 - qcx), Math.abs(qcy), Math.abs(rows - 1 - qcy));
  let found = 0;
  const visit = (cx, cy) => {
    const c = cy * cols + cx;
    for (let p = start[c]; p < start[c + 1]; p++) {
      const i = items[p];
      const dx = xy[2 * i] - qx, dy = xy[2 * i + 1] - qy;
      const d = dx * dx + dy * dy;
      let pos;
      if (found < kk) { pos = found++; }
      else if (worse(nd[kk - 1], ni[kk - 1], d, i)) { pos = kk - 1; }
      else { continue; }
      while (pos > 0 && worse(nd[pos - 1], ni[pos - 1], d, i)) { nd[pos] = nd[pos - 1]; ni[pos] = ni[pos - 1]; pos--; }
      nd[pos] = d;
      ni[pos] = i;
    }
  };
  for (let r = rFirst; r <= rLast; r++) {
    for (let cy = qcy - r; cy <= qcy + r; cy++) {
      if (cy < 0 || cy >= rows) { continue; }
      if (cy === qcy - r || cy === qcy + r) {
        for (let cx = Math.max(0, qcx - r); cx <= Math.min(cols - 1, qcx + r); cx++) { visit(cx, cy); }
      } else {
        if (qcx - r >= 0 && qcx - r < cols) { visit(qcx - r, cy); }
        if (r > 0 && qcx + r >= 0 && qcx + r < cols) { visit(qcx + r, cy); }
      }
    }
    // Every unsearched point is at least r cells away from the query.
    if (found === kk && nd[kk - 1] < (r * cell) * (r * cell)) { break; }
  }
  return found;
}

export function displacementField({ oldL, newL, points, k = DISPLACE_K }) {
  const nL = oldL.length >> 1, nP = points.length >> 1;
  const out = Float64Array.from(points);
  if (nL === 0 || nP === 0) { return out; }
  const g = buildGrid(oldL);
  const kk = Math.min(k, nL);
  const ni = new Int32Array(kk), nd = new Float64Array(kk);
  for (let p = 0; p < nP; p++) {
    const found = gridKnn(g, points[2 * p], points[2 * p + 1], kk, ni, nd);
    let wx = 0, wy = 0, ws = 0;
    for (let m = 0; m < found; m++) {
      const L = ni[m];
      const w = 1 / (1e-6 + nd[m]);
      wx += w * (newL[2 * L] - oldL[2 * L]);
      wy += w * (newL[2 * L + 1] - oldL[2 * L + 1]);
      ws += w;
    }
    if (ws > 0) {
      out[2 * p] += wx / ws;
      out[2 * p + 1] += wy / ws;
    }
  }
  return out;
}

// ── 7 · near-duplicate dots (§3.5.4) ───────────────────────────────────────

function sortPairs(pairs) {
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

// Fitted pairs from umap-js's kNN graph (self in column 0, distance 0;
// distances are Euclidean in the fit rows' space, i.e. PCA).
export function knnGraphPairs(knnIndices, knnDistances, bound = MAP_PCA_NEAR_DUP_BOUND) {
  const n = knnIndices.length;
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const row = knnIndices[i], dist = knnDistances[i];
    for (let c = 0; c < row.length; c++) {
      const j = row[c];
      if (j < 0 || j === i || !(dist[c] <= bound)) { continue; }
      const a = i < j ? i : j, b = i < j ? j : i;
      const key = a * n + b;
      if (seen.has(key)) { continue; }
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return sortPairs(pairs);
}

// Pairs of points in the same or adjacent cells (a 3 × 3 neighbourhood, each
// pair once), kept when their PCA rows are within maxDist (z given).
export function gridCandidates(xy, cell, { z = null, k = 0, maxDist = MAP_PCA_NEAR_DUP_BOUND } = {}) {
  const n = xy.length >> 1;
  if (n < 2) { return []; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    if (x < x0) { x0 = x; }
    if (x > x1) { x1 = x; }
    if (y < y0) { y0 = y; }
    if (y > y1) { y1 = y; }
  }
  // Keep the cell count sane whatever the caller passes.
  const span = Math.max(x1 - x0, y1 - y0);
  let c = cell > 0 ? cell : 1;
  if (span > 0 && span / c > 2 ** 20) { c = span / 2 ** 20; }
  const W = Math.floor((x1 - x0) / c) + 3;
  const cxOf = new Float64Array(n), cyOf = new Float64Array(n);
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((xy[2 * i] - x0) / c), cy = Math.floor((xy[2 * i + 1] - y0) / c);
    cxOf[i] = cx;
    cyOf[i] = cy;
    const key = cy * W + cx;
    const list = cells.get(key);
    if (list) { list.push(i); } else { cells.set(key, [i]); }
  }
  const max2 = maxDist * maxDist;
  const within = (i, j) => {
    if (!z) { return true; }
    let s = 0;
    for (let t = 0; t < k; t++) { const d = z[i * k + t] - z[j * k + t]; s += d * d; if (s > max2) { return false; } }
    return true;
  };
  const pairs = [];
  const HALF = [[1, 0], [-1, 1], [0, 1], [1, 1]];
  for (const list of cells.values()) {
    const cx = cxOf[list[0]], cy = cyOf[list[0]];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (within(list[a], list[b])) { pairs.push([list[a], list[b]]); }
      }
    }
    for (const [dx, dy] of HALF) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0) { continue; }
      const other = cells.get(ny * W + nx);
      if (!other) { continue; }
      for (const i of list) {
        for (const j of other) {
          if (within(i, j)) { pairs.push(i < j ? [i, j] : [j, i]); }
        }
      }
    }
  }
  return sortPairs(pairs);
}

// Union-find over hash pairs (§3.4.4 step 7). `verify(hA, hB)` checks the
// exact current-model vectors (cos ≥ MAP_NEAR_DUP); it is called once per
// candidate whose ends are not already grouped.
//   keepLabels (place runs): `previous` (hash → dot for every existing point)
//     is trusted as it stands: an existing group keeps its label, new members
//     take it, merging groups keep the smaller label, and only a group of new
//     points is labelled afresh (its smallest member hash).
//   otherwise (rebuild, refit): labels are recomputed (smallest member hash);
//     `previous` groups seed the union when their members are still in
//     `hashes` and still connected through verified pairs (reverify).
// Returns hash → dot for every entry of `hashes`.
export function groupNearDuplicates(pairs, verify, previous = null, { hashes, keepLabels = false, reverify = true } = {}) {
  const n = hashes.length;
  const index = new Map();
  for (let i = 0; i < n; i++) { index.set(hashes[i], i); }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; }
  const label = new Array(n).fill(null);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const minLabel = (a, b) => (a == null ? b : b == null ? a : (a < b ? a : b));
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) { return; }
    const keep = ra < rb ? ra : rb, drop = ra < rb ? rb : ra;
    parent[drop] = keep;
    label[keep] = minLabel(label[keep], label[drop]);
  };
  if (previous) {
    const groups = new Map();
    for (const [h, dot] of previous) {
      const i = index.get(h);
      if (i === undefined) { continue; }
      if (keepLabels) { label[i] = dot; }
      const g = groups.get(dot);
      if (g) { g.push(i); } else { groups.set(dot, [i]); }
    }
    for (const members of groups.values()) {
      if (members.length < 2) { continue; }
      members.sort((a, b) => a - b);
      if (!keepLabels && reverify && !connectedUnder(members, hashes, verify)) { continue; }
      for (let m = 1; m < members.length; m++) { union(members[0], members[m]); }
    }
  }
  for (const [ha, hb] of pairs) {
    const ia = index.get(ha), ib = index.get(hb);
    if (ia === undefined || ib === undefined || ia === ib) { continue; }
    if (find(ia) === find(ib)) { continue; }
    if (verify(ha, hb)) { union(ia, ib); }
  }
  const smallest = new Map();   // root → smallest member hash
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const s = smallest.get(r);
    if (s === undefined || hashes[i] < s) { smallest.set(r, hashes[i]); }
  }
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    out.set(hashes[i], label[r] ?? smallest.get(r));
  }
  return out;
}

// Are the members one component under verified pairs? Stops as soon as they
// are, so a tight group costs one verify per member.
function connectedUnder(members, hashes, verify) {
  const m = members.length;
  const par = new Int32Array(m);
  for (let i = 0; i < m; i++) { par[i] = i; }
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  let comps = m;
  for (let a = 0; a < m && comps > 1; a++) {
    for (let b = a + 1; b < m && comps > 1; b++) {
      const ra = find(a), rb = find(b);
      if (ra === rb) { continue; }
      if (verify(hashes[members[a]], hashes[members[b]])) { par[rb] = ra; comps--; }
    }
  }
  return comps === 1;
}

export function groupsOf(dotOf) {
  const groups = new Map();
  for (const [h, dot] of dotOf) {
    const g = groups.get(dot);
    if (g) { g.push(h); } else { groups.set(dot, [h]); }
  }
  const out = new Map();
  for (const dot of [...groups.keys()].sort(compareHash)) { out.set(dot, groups.get(dot).sort(compareHash)); }
  return out;
}

// ── 8 · regions (§3.5.5) ───────────────────────────────────────────────────

export function townCount(n, { small = false } = {}) {
  if (!(n > 0)) { return 0; }
  const k = Math.round(Math.sqrt(n) / 2);
  if (small) { return Math.max(1, Math.min(n, k)); }
  return Math.min(n, clamp(k, TOWN_K_MIN, TOWN_K_MAX));
}

export function assignNearest(xy, centres) {
  const n = xy.length >> 1, K = centres.length >> 1;
  const assign = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    let b = -1, bd = Infinity;
    for (let c = 0; c < K; c++) {
      const dx = x - centres[2 * c], dy = y - centres[2 * c + 1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; b = c; }
    }
    assign[i] = b;
  }
  return assign;
}

// Lloyd iterations from the given centres: nearest centre (the lower index
// on ties), then each non-empty cluster's mean; an empty cluster keeps its
// centre. Stops when no assignment changes.
export function lloyd(xy, centres, { maxIter = LLOYD_MAX_ITER } = {}) {
  const n = xy.length >> 1, K = centres.length >> 1;
  const cents = Float64Array.from(centres);
  const assign = new Int32Array(n).fill(-1);
  const sx = new Float64Array(K), sy = new Float64Array(K), cnt = new Int32Array(K);
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations++;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1];
      let b = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const dx = x - cents[2 * c], dy = y - cents[2 * c + 1];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; b = c; }
      }
      if (assign[i] !== b) { assign[i] = b; changed = true; }
    }
    sx.fill(0); sy.fill(0); cnt.fill(0);
    for (let i = 0; i < n; i++) { const c = assign[i]; sx[c] += xy[2 * i]; sy[c] += xy[2 * i + 1]; cnt[c]++; }
    for (let c = 0; c < K; c++) {
      if (cnt[c] > 0) { cents[2 * c] = sx[c] / cnt[c]; cents[2 * c + 1] = sy[c] / cnt[c]; }
    }
    if (!changed) { break; }
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    const dx = xy[2 * i] - cents[2 * c], dy = xy[2 * i + 1] - cents[2 * c + 1];
    inertia += dx * dx + dy * dy;
  }
  return { centres: cents, assign, inertia, iterations };
}

// k-means++ seeding (mulberry32(seed + r) per restart), Lloyd to
// convergence, the lowest inertia wins (the earlier restart on ties).
export function kmeansPP(xy, K, { restarts = TOWN_RESTARTS, seed = TOWN_SEED, maxIter = LLOYD_MAX_ITER } = {}) {
  const n = xy.length >> 1;
  const KK = Math.min(K, n);
  if (KK <= 0) { return { centres: new Float64Array(0), assign: new Int32Array(n).fill(-1), inertia: 0, iterations: 0 }; }
  let best = null;
  const dd = new Float64Array(n);
  for (let r = 0; r < restarts; r++) {
    const rand = mulberry32(seed + r);
    const cents = new Float64Array(2 * KK);
    const first = Math.floor(rand() * n);
    cents[0] = xy[2 * first];
    cents[1] = xy[2 * first + 1];
    dd.fill(Infinity);
    for (let c = 1; c < KK; c++) {
      const lx = cents[2 * (c - 1)], ly = cents[2 * (c - 1) + 1];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const dx = xy[2 * i] - lx, dy = xy[2 * i + 1] - ly;
        const d = dx * dx + dy * dy;
        if (d < dd[i]) { dd[i] = d; }
        total += dd[i];
      }
      let rr = rand() * total, pick = 0;
      while (pick < n - 1 && rr > dd[pick]) { rr -= dd[pick]; pick++; }
      cents[2 * c] = xy[2 * pick];
      cents[2 * c + 1] = xy[2 * pick + 1];
    }
    const res = lloyd(xy, cents, { maxIter });
    if (!best || res.inertia < best.inertia) { best = res; }
  }
  return best;
}

// Warm starts change K by adding farthest points (the point farthest from
// every centre so far, the lower index on ties) or by dropping the smallest
// clusters' centres (the higher index on ties); the rest keep their order.
export function resizeCentres(centres, K, xy) {
  const K0 = centres.length >> 1, n = xy.length >> 1;
  if (K === K0) { return Float64Array.from(centres); }
  if (K > K0) {
    const out = [];
    for (let i = 0; i < 2 * K0; i++) { out.push(centres[i]); }
    const d = new Float64Array(n).fill(Infinity);
    for (let c = 0; c < K0; c++) {
      for (let i = 0; i < n; i++) {
        const dx = xy[2 * i] - centres[2 * c], dy = xy[2 * i + 1] - centres[2 * c + 1];
        const v = dx * dx + dy * dy;
        if (v < d[i]) { d[i] = v; }
      }
    }
    while ((out.length >> 1) < K) {
      let bi = -1, bv = 0;
      for (let i = 0; i < n; i++) { if (d[i] > bv) { bv = d[i]; bi = i; } }
      if (bi < 0) { break; }   // every point already sits on a centre
      const x = xy[2 * bi], y = xy[2 * bi + 1];
      out.push(x, y);
      for (let i = 0; i < n; i++) {
        const dx = xy[2 * i] - x, dy = xy[2 * i + 1] - y;
        const v = dx * dx + dy * dy;
        if (v < d[i]) { d[i] = v; }
      }
    }
    return Float64Array.from(out);
  }
  const sizes = new Int32Array(K0);
  const assign = assignNearest(xy, centres);
  for (let i = 0; i < n; i++) { if (assign[i] >= 0) { sizes[assign[i]]++; } }
  const order = [];
  for (let c = 0; c < K0; c++) { order.push(c); }
  order.sort((a, b) => sizes[a] - sizes[b] || b - a);
  const dropped = new Set(order.slice(0, K0 - Math.max(0, K)));
  const out = [];
  for (let c = 0; c < K0; c++) { if (!dropped.has(c)) { out.push(centres[2 * c], centres[2 * c + 1]); } }
  return Float64Array.from(out);
}

export function compactClusters(assign, centres) {
  const K = centres.length >> 1;
  const sizesAll = new Int32Array(K);
  for (let i = 0; i < assign.length; i++) { if (assign[i] >= 0 && assign[i] < K) { sizesAll[assign[i]]++; } }
  const map = new Int32Array(K).fill(-1);
  const keptCentres = [];
  const sizes = [];
  for (let c = 0; c < K; c++) {
    if (sizesAll[c] === 0) { continue; }
    map[c] = sizes.length;
    keptCentres.push(centres[2 * c], centres[2 * c + 1]);
    sizes.push(sizesAll[c]);
  }
  const out = new Int32Array(assign.length);
  for (let i = 0; i < assign.length; i++) { out[i] = assign[i] >= 0 && assign[i] < K ? map[assign[i]] : -1; }
  return { assign: out, centres: Float64Array.from(keptCentres), sizes: Int32Array.from(sizes), map };
}

// A track's top style from the raw discovery_tracks.genre_tags JSON: the
// first element that is a string 'Genre---Style' with both parts non-empty.
// Junk-hardened like genre-sync.js parseGenreTags (malformed JSON, non-array,
// non-strings), which this module cannot import (config.js, manager.js).
export function topStyle(json) {
  if (typeof json !== 'string' || json === '') { return null; }
  let tags;
  try {
    tags = JSON.parse(json);
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(tags)) { return null; }
  for (const raw of tags) {
    if (typeof raw !== 'string' || raw.length > STYLE_MAX_LENGTH) { continue; }
    const sep = raw.indexOf('---');
    if (sep <= 0) { continue; }
    const genre = raw.slice(0, sep).trim(), style = raw.slice(sep + 3).trim();
    if (genre && style) { return `${genre}---${style}`; }
  }
  return null;
}

export function genreOfStyle(style) {
  const sep = style.indexOf('---');
  return sep > 0 ? style.slice(0, sep) : style;
}

export function styleDisplay(style) {
  if (Object.hasOwn(DISPLAY_STYLE, style)) { return DISPLAY_STYLE[style]; }
  const sep = style.indexOf('---');
  return sep >= 0 ? style.slice(sep + 3) : style;
}

export function genreLabel(genre) {
  return Object.hasOwn(SHORT_GENRE, genre) ? SHORT_GENRE[genre] : genre;
}

// The town's label: among styles held by ≥ STYLE_MIN_SHARE of its members,
// the best share × √lift (lift = share / library share); else the most
// common style; null when no member has one. Its genre is the majority of
// the members' top-style genres. Ties: count, then name.
export function townLabel(memberStyles, globalCounts, nTotal) {
  const size = memberStyles.length;
  const counts = new Map(), genres = new Map();
  for (const s of memberStyles) {
    if (!s) { continue; }
    counts.set(s, (counts.get(s) || 0) + 1);
    const g = genreOfStyle(s);
    genres.set(g, (genres.get(g) || 0) + 1);
  }
  if (counts.size === 0) { return { style: null, label: null, genre: null }; }
  let best = null, bestScore = -1, bestCount = 0;
  let common = null, commonCount = 0;
  for (const [s, c] of counts) {
    if (c > commonCount || (c === commonCount && s < common)) { common = s; commonCount = c; }
    const share = c / size;
    if (share < STYLE_MIN_SHARE) { continue; }
    const globalShare = (globalCounts.get(s) || c) / nTotal;
    const score = share * Math.sqrt(share / globalShare);
    if (score > bestScore || (score === bestScore && (c > bestCount || (c === bestCount && s < best)))) {
      best = s; bestScore = score; bestCount = c;
    }
  }
  const style = best ?? common;
  let genre = null, genreCount = 0;
  for (const [g, c] of genres) {
    if (c > genreCount || (c === genreCount && g < genre)) { genre = g; genreCount = c; }
  }
  return { style, label: styleDisplay(style), genre };
}

// Keys across refits (spec-fixes §4): new regions are matched to old ones by
// Jaccard over member hashes, greedily on the largest Jaccard, one to one,
// kept at ≥ minJaccard. Ties: overlap descending, then old key ascending,
// then new index ascending. newSets[i] is a Set of hashes; olds[j] =
// {key, members: Iterable<hash>}. Returns the old index per new index, −1
// when unmatched.
export function matchRegionKeys(newSets, olds, { minJaccard = JACCARD_KEEP } = {}) {
  const owner = new Map();
  const oldSize = new Array(olds.length).fill(0);
  olds.forEach((o, oi) => {
    const seen = new Set(o.members);
    oldSize[oi] = seen.size;
    for (const h of seen) { owner.set(h, oi); }
  });
  const cands = [];
  newSets.forEach((set, ni) => {
    const inter = new Map();
    for (const h of set) {
      const oi = owner.get(h);
      if (oi !== undefined) { inter.set(oi, (inter.get(oi) || 0) + 1); }
    }
    for (const [oi, c] of inter) {
      const union = set.size + oldSize[oi] - c;
      if (c / union >= minJaccard) { cands.push({ ni, oi, inter: c, union }); }
    }
  });
  cands.sort((a, b) => (b.inter * a.union - a.inter * b.union) || (b.inter - a.inter)
    || compareHash(olds[a.oi].key, olds[b.oi].key) || (a.ni - b.ni));
  const out = new Int32Array(newSets.length).fill(-1);
  const usedOld = new Set();
  for (const c of cands) {
    if (out[c.ni] !== -1 || usedOld.has(c.oi)) { continue; }
    out[c.ni] = c.oi;
    usedOld.add(c.oi);
  }
  return out;
}

// The member nearest the members' median (a name sits on land), and the
// 80th-percentile member distance from (cx, cy).
function anchorOf(dots, xy) {
  const xs = new Float64Array(dots.length), ys = new Float64Array(dots.length);
  dots.forEach((i, r) => { xs[r] = xy[2 * i]; ys[r] = xy[2 * i + 1]; });
  xs.sort();
  ys.sort();
  const mx = xs[dots.length >> 1], my = ys[dots.length >> 1];
  let best = dots[0], bd = Infinity;
  for (const i of dots) {
    const dx = xy[2 * i] - mx, dy = xy[2 * i + 1] - my;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return [xy[2 * best], xy[2 * best + 1]];
}

function extentOf(dots, xy, cx, cy) {
  const d = new Float64Array(dots.length);
  dots.forEach((i, r) => { d[r] = Math.sqrt((xy[2 * i] - cx) ** 2 + (xy[2 * i + 1] - cy) ** 2); });
  d.sort();
  return dots.length ? d[Math.min(dots.length - 1, Math.floor(dots.length * 0.8))] : 0;
}

// Place runs (§3.4.4 step 8): new dots join the nearest existing town
// centre (map_regions x, y) and that town's province; nothing re-clusters,
// so region ids, keys and names stay put.
export function assignToTowns(xy, townCentres, townParent) {
  const town = assignNearest(xy, townCentres);
  const n = town.length;
  const region0 = new Uint8Array(n).fill(REGION_NONE), region1 = new Uint8Array(n).fill(REGION_NONE);
  for (let i = 0; i < n; i++) {
    if (town[i] < 0) { continue; }
    region1[i] = town[i];
    region0[i] = townParent[town[i]];
  }
  return { region0, region1 };
}

// Every region's geometry from the dots' region columns: size (dots), centre
// (a town keeps its k-means centre; a province is its dots' centroid),
// anchor (a town's member nearest the members' median; a province takes its
// biggest town's, the lower id on ties), extent (80th-percentile member
// distance from the centre) and members. An empty region reports size 0 and
// null centre/anchor (a place run keeps its stored values). buildRegions
// uses it too, so every mode applies the same rules.
export function refreshRegionGeometry({ xy, region0, region1, nProvinces, nTowns, townCentres, townParent }) {
  const n = xy.length >> 1;
  const townDots = Array.from({ length: nTowns }, () => []);
  const provDots = Array.from({ length: nProvinces }, () => []);
  for (let i = 0; i < n; i++) {
    const t = region1[i], p = region0[i];
    if (t >= 0 && t < nTowns) { townDots[t].push(i); }
    if (p >= 0 && p < nProvinces) { provDots[p].push(i); }
  }
  const towns = townDots.map((dots, t) => {
    const x = townCentres[2 * t], y = townCentres[2 * t + 1];
    if (dots.length === 0) { return { size: 0, x, y, anchorX: null, anchorY: null, extent: 0, dots: new Int32Array(0) }; }
    const [anchorX, anchorY] = anchorOf(dots, xy);
    return { size: dots.length, x, y, anchorX, anchorY, extent: extentOf(dots, xy, x, y), dots: Int32Array.from(dots) };
  });
  const provinces = provDots.map((dots, p) => {
    if (dots.length === 0) { return { size: 0, x: null, y: null, anchorX: null, anchorY: null, extent: 0, dots: new Int32Array(0) }; }
    let sx = 0, sy = 0;
    for (const i of dots) { sx += xy[2 * i]; sy += xy[2 * i + 1]; }
    const x = sx / dots.length, y = sy / dots.length;
    let big = -1;
    for (let t = 0; t < nTowns; t++) {
      if (townParent[t] !== p || towns[t].size === 0) { continue; }
      if (big < 0 || towns[t].size > towns[big].size) { big = t; }
    }
    const [anchorX, anchorY] = big >= 0 ? [towns[big].anchorX, towns[big].anchorY] : anchorOf(dots, xy);
    return { size: dots.length, x, y, anchorX, anchorY, extent: extentOf(dots, xy, x, y), dots: Int32Array.from(dots) };
  });
  return { provinces, towns };
}

// Towns (level 1) from a finished town clustering; provinces (level 0) by
// genre, or — when no town has one — by k-means on the town centres
// (K0 = clamp(round(K1/3), 1, 12); warm from provinceCentres when given).
// Inputs, one entry per dot (sorted by dot label):
//   xy           Float64Array(2n) map positions
//   styles       top style per dot (topStyle of its label member) or null
//   members      member hashes per dot (the Jaccard sets)
//   townAssign   Int32Array(n) town cluster per dot (compactClusters output)
//   townCentres  Float64Array(2·K1)
//   previous     {towns, provinces}: [{key, label, style, hue, members}] or null
//   nextKey      discovery_meta.map_next_key
// Output regions: {level, id, key, parent, label, style, x, y, anchorX,
// anchorY, extent, size, dots: Int32Array, prevHue (provinces)}. Province ids
// by size descending, town ids by (parent, size descending); towns take their
// province's hue once assignHues has run.
export function buildRegions({ xy, styles, members, townAssign, townCentres, previous = null, provinceCentres = null, nextKey = 0 }) {
  const n = xy.length >> 1;
  const K1 = townCentres.length >> 1;
  const townDots = Array.from({ length: K1 }, () => []);
  for (let i = 0; i < n; i++) {
    const t = townAssign[i];
    if (t >= 0 && t < K1) { townDots[t].push(i); }
  }
  const globalCounts = new Map();
  for (let i = 0; i < n; i++) {
    const s = styles[i];
    if (s) { globalCounts.set(s, (globalCounts.get(s) || 0) + 1); }
  }
  const towns = [];
  for (let t = 0; t < K1; t++) {
    const dots = townDots[t];
    if (dots.length === 0) { continue; }
    const lab = townLabel(dots.map((i) => styles[i]), globalCounts, n);
    towns.push({ dots, x: townCentres[2 * t], y: townCentres[2 * t + 1], style: lab.style, label: lab.label, genre: lab.genre });
  }

  let provinces;
  const genred = towns.filter((t) => t.genre !== null);
  if (genred.length > 0) {
    const byGenre = new Map();
    for (const t of towns) {
      let g = t.genre;
      if (g === null) {   // join the province of the nearest town that has a genre
        let bd = Infinity;
        for (const o of genred) {
          const d = (o.x - t.x) ** 2 + (o.y - t.y) ** 2;
          if (d < bd) { bd = d; g = o.genre; }
        }
      }
      if (!byGenre.has(g)) { byGenre.set(g, []); }
      byGenre.get(g).push(t);
    }
    provinces = [...byGenre.entries()].map(([genre, ts]) => ({ genre, towns: ts }));
  } else {
    const pts = new Float64Array(2 * towns.length);
    towns.forEach((t, j) => { pts[2 * j] = t.x; pts[2 * j + 1] = t.y; });
    const K0 = Math.min(towns.length, clamp(Math.round(towns.length / 3), 1, PROVINCE_K_MAX));
    const res = provinceCentres && provinceCentres.length >= 2
      ? lloyd(pts, resizeCentres(provinceCentres, K0, pts))
      : kmeansPP(pts, K0);
    const groups = new Map();
    towns.forEach((t, j) => {
      const p = res.assign[j];
      if (!groups.has(p)) { groups.set(p, []); }
      groups.get(p).push(t);
    });
    provinces = [...groups.keys()].sort((a, b) => a - b).map((p) => ({ genre: null, towns: groups.get(p) }));
  }
  for (const p of provinces) {   // size and centroid order the ids
    let size = 0, sx = 0, sy = 0;
    for (const t of p.towns) { for (const i of t.dots) { size++; sx += xy[2 * i]; sy += xy[2 * i + 1]; } }
    p.size = size;
    p.cx = sx / size;
    p.cy = sy / size;
    p.label = p.genre !== null ? genreLabel(p.genre) : null;
    p.style = p.genre;
  }
  provinces.sort((a, b) => b.size - a.size
    || (a.genre !== null && b.genre !== null ? compareHash(a.genre, b.genre) : 0)
    || a.cx - b.cx || a.cy - b.cy);
  if (provinces.length > REGION_NONE) { throw new Error(`buildRegions: ${provinces.length} provinces (at most ${REGION_NONE})`); }
  provinces.forEach((p, id) => { p.id = id; for (const t of p.towns) { t.parent = id; } });
  for (const t of towns) { t.size = t.dots.length; }
  towns.sort((a, b) => a.parent - b.parent || b.size - a.size || a.x - b.x || a.y - b.y);
  if (towns.length > REGION_NONE) { throw new Error(`buildRegions: ${towns.length} towns (at most ${REGION_NONE})`); }
  towns.forEach((t, id) => { t.id = id; });
  const region0 = new Uint8Array(n).fill(REGION_NONE), region1 = new Uint8Array(n).fill(REGION_NONE);
  for (const t of towns) { for (const i of t.dots) { region1[i] = t.id; region0[i] = t.parent; } }
  const geo = refreshRegionGeometry({
    xy, region0, region1, nProvinces: provinces.length, nTowns: towns.length,
    townCentres: Float64Array.from(towns.flatMap((t) => [t.x, t.y])), townParent: Int32Array.from(towns, (t) => t.parent),
  });
  for (const r of [...provinces.map((p) => [p, geo.provinces[p.id]]), ...towns.map((t) => [t, geo.towns[t.id]])]) {
    Object.assign(r[0], { x: r[1].x, y: r[1].y, anchorX: r[1].anchorX, anchorY: r[1].anchorY, extent: r[1].extent, dots: r[1].dots });
  }

  // Keys: genre provinces by construction, the rest matched by Jaccard.
  const used = new Set();
  let next = nextKey;
  const fresh = (prefix) => {
    let key = `${prefix}${next++}`;
    while (used.has(key)) { key = `${prefix}${next++}`; }
    return key;
  };
  const memberSet = (dots) => {
    const s = new Set();
    for (const i of dots) { for (const h of members[i]) { s.add(h); } }
    return s;
  };
  const prevProvinces = previous?.provinces ?? [];
  if (provinces.length && provinces[0].genre !== null) {
    for (const p of provinces) {
      p.key = `g:${p.genre}`;
      const old = prevProvinces.find((o) => o.key === p.key);
      p.prevHue = old && Number.isInteger(old.hue) ? old.hue : null;
      used.add(p.key);
    }
  } else {
    const olds = prevProvinces.filter((o) => typeof o.key === 'string' && o.key.startsWith('c:'));
    const match = matchRegionKeys(provinces.map((p) => memberSet(p.dots)), olds);
    for (const p of provinces) {
      const o = match[p.id];
      if (o >= 0) {
        p.key = olds[o].key;
        p.prevHue = Number.isInteger(olds[o].hue) ? olds[o].hue : null;
        used.add(p.key);
      }
    }
    for (const p of provinces) {
      if (!p.key) { p.key = fresh('c:'); p.prevHue = null; used.add(p.key); }
    }
  }
  const prevTowns = previous?.towns ?? [];
  const tmatch = matchRegionKeys(towns.map((t) => memberSet(t.dots)), prevTowns);
  for (const t of towns) {
    const o = tmatch[t.id];
    if (o < 0) { continue; }
    const old = prevTowns[o];
    t.key = old.key;
    used.add(t.key);
    if (old.label != null) {   // a matched town keeps its name
      t.label = old.label;
      if (old.style != null) { t.style = old.style; }
    }
  }
  for (const t of towns) {
    if (!t.key) { t.key = fresh('t:'); used.add(t.key); }
  }

  return {
    provinces: provinces.map((p) => ({
      level: 0, id: p.id, key: p.key, parent: null, label: p.label, style: p.style, x: p.x, y: p.y,
      anchorX: p.anchorX, anchorY: p.anchorY, extent: p.extent, size: p.size, dots: p.dots, prevHue: p.prevHue,
    })),
    towns: towns.map((t) => ({
      level: 1, id: t.id, key: t.key, parent: t.parent, label: t.label, style: t.style, x: t.x, y: t.y,
      anchorX: t.anchorX, anchorY: t.anchorY, extent: t.extent, size: t.size, dots: t.dots,
    })),
    region0,
    region1,
    nextKey: next,
  };
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Province hues (§3.5.5): largest province first (then id); keep the
// previous hue while it stays ≥ minApart from every assigned neighbour and
// no larger province took it; otherwise the candidate that keeps ≥ minApart
// from the assigned neighbours (or comes closest to it), then the largest
// minimum distance to every assigned hue, then the smallest hue. Capping the
// neighbour term at minApart is what spreads the hues: maximising it
// outright sends every province that borders only the first one to the
// opposite hue, so two provinces with no shared coast end up one colour.
// provinces = [{id, size, prevHue}], adjacency = [[idA, idB], …].
export function assignHues(provinces, adjacency, { candidates = HUE_CANDIDATES, minApart = HUE_MIN_APART } = {}) {
  const P = provinces.reduce((m, p) => Math.max(m, p.id + 1), 0);
  const adj = Array.from({ length: P }, () => []);
  for (const [a, b] of adjacency) {
    if (a === b || a < 0 || b < 0 || a >= P || b >= P) { continue; }
    adj[a].push(b);
    adj[b].push(a);
  }
  const allowed = new Set(candidates);
  const hues = new Int16Array(P).fill(-1);
  const assigned = [];
  const order = [...provinces].sort((a, b) => b.size - a.size || a.id - b.id);
  for (const p of order) {
    const nb = [];
    for (const q of adj[p.id]) { if (hues[q] >= 0) { nb.push(hues[q]); } }
    let hue = null;
    if (Number.isInteger(p.prevHue) && allowed.has(p.prevHue) && !assigned.includes(p.prevHue)
        && nb.every((h) => hueDist(p.prevHue, h) >= minApart)) {
      hue = p.prevHue;
    } else {
      let bn = -1, ba = -1;
      for (const c of candidates) {
        let dn = Infinity, da = Infinity;
        for (const h of nb) { const d = hueDist(c, h); if (d < dn) { dn = d; } }
        for (const h of assigned) { const d = hueDist(c, h); if (d < da) { da = d; } }
        const sn = Math.min(dn, minApart);
        if (hue === null || sn > bn || (sn === bn && da > ba)) { hue = c; bn = sn; ba = da; }
      }
    }
    hues[p.id] = hue;
    assigned.push(hue);
  }
  return hues;
}

// ── centrality and mixes (§3.5.6) ──────────────────────────────────────────

export function centrality(z, k, assign, nRegions) {
  const n = assign.length;
  const means = new Float64Array(nRegions * k), counts = new Int32Array(nRegions);
  for (let i = 0; i < n; i++) {
    const r = assign[i];
    if (r < 0 || r >= nRegions) { continue; }
    counts[r]++;
    for (let j = 0; j < k; j++) { means[r * k + j] += z[i * k + j]; }
  }
  for (let r = 0; r < nRegions; r++) {
    if (counts[r]) { for (let j = 0; j < k; j++) { means[r * k + j] /= counts[r]; } }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = assign[i];
    if (r < 0 || r >= nRegions) { continue; }
    let s = 0;
    for (let j = 0; j < k; j++) { const d = z[i * k + j] - means[r * k + j]; s += d * d; }
    out[i] = -Math.sqrt(s);
  }
  return out;
}

// A region's mix: all its dots when ≤ max, else farthest-point sampling in
// PCA space from the most central dot; then ordered by a greedy
// nearest-neighbour walk from that dot. members = dot indices ascending
// (label order), so every tie goes to the smaller hash.
export function regionMix(members, z, k, central, { max = MIX_MAX } = {}) {
  const m = members.length;
  if (m === 0) { return new Int32Array(0); }
  const d2 = (a, b) => {
    let s = 0;
    for (let j = 0; j < k; j++) { const t = z[a * k + j] - z[b * k + j]; s += t * t; }
    return s;
  };
  let c0 = members[0];
  for (const i of members) { if (central[i] > central[c0]) { c0 = i; } }
  let chosen;
  if (m <= max) {
    chosen = Array.from(members);
  } else {
    chosen = [c0];
    const dist = new Float64Array(m);
    for (let p = 0; p < m; p++) { dist[p] = members[p] === c0 ? -1 : d2(members[p], c0); }
    while (chosen.length < max) {
      let bp = -1, bv = -1;
      for (let p = 0; p < m; p++) { if (dist[p] > bv) { bv = dist[p]; bp = p; } }
      if (bp < 0) { break; }
      const pick = members[bp];
      chosen.push(pick);
      dist[bp] = -1;
      for (let p = 0; p < m; p++) {
        if (dist[p] < 0) { continue; }
        const v = d2(members[p], pick);
        if (v < dist[p]) { dist[p] = v; }
      }
    }
    chosen.sort((a, b) => a - b);
  }
  const order = [c0];
  const left = chosen.filter((i) => i !== c0);
  let cur = c0;
  while (left.length) {
    let bp = 0, bv = Infinity;
    for (let p = 0; p < left.length; p++) {
      const v = d2(cur, left[p]);
      if (v < bv) { bv = v; bp = p; }
    }
    cur = left[bp];
    order.push(cur);
    left.splice(bp, 1);
  }
  return Int32Array.from(order);
}

// ── 9 · land (§3.5.8) ──────────────────────────────────────────────────────

export function landSigma(nDots) {
  if (!(nDots > 0)) { return 0.04; }
  return clamp(0.010 * Math.pow(2000 / nDots, 1 / 6), 0.003, 0.04);
}

// One province's KDE (a separable Gaussian cut off at ⌈3σ·N⌉ cells) into
// `out` (zeroed first); returns its cell box [x0, y0, x1, y1] or null.
function provinceKde(field, p, out) {
  const { N, sigma, rad, xy } = field;
  const dots = field.dotsOf[p];
  out.fill(0);
  if (dots.length === 0) { return null; }
  const inv = 1 / (2 * sigma * sigma);
  const wx = new Float64Array(2 * rad + 3), wy = new Float64Array(2 * rad + 3);
  let bx0 = N, by0 = N, bx1 = -1, by1 = -1;
  for (const i of dots) {
    const cx = xy[2 * i] * N, cy = xy[2 * i + 1] * N;
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(N - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(N - 1, Math.ceil(cy + rad));
    if (x0 > x1 || y0 > y1) { continue; }
    for (let x = x0; x <= x1; x++) { const dx = (x + 0.5 - cx) / N; wx[x - x0] = Math.exp(-dx * dx * inv); }
    for (let y = y0; y <= y1; y++) { const dy = (y + 0.5 - cy) / N; wy[y - y0] = Math.exp(-dy * dy * inv); }
    for (let y = y0; y <= y1; y++) {
      const w = wy[y - y0], row = y * N;
      for (let x = x0; x <= x1; x++) { out[row + x] += w * wx[x - x0]; }
    }
    if (x0 < bx0) { bx0 = x0; }
    if (y0 < by0) { by0 = y0; }
    if (x1 > bx1) { bx1 = x1; }
    if (y1 > by1) { by1 = y1; }
  }
  return bx1 < 0 ? null : [bx0, by0, bx1, by1];
}

// The density field: per cell the total over provinces and the strongest
// and second-strongest province values (the owner is the strongest; the
// lower id on ties). Province fields are recomputed one at a time, so memory
// stays O(N²) whatever the province count.
export function landField({ xy, province, nProvinces, sigma, N = LAND_N }) {
  const n = xy.length >> 1;
  const dotsOf = Array.from({ length: nProvinces }, () => []);
  for (let i = 0; i < n; i++) {
    const p = province[i];
    if (p >= 0 && p < nProvinces) { dotsOf[p].push(i); }
  }
  const field = {
    N, sigma, rad: Math.ceil(3 * sigma * N), xy,
    dotsOf: dotsOf.map((a) => Int32Array.from(a)),
    boxes: new Array(nProvinces).fill(null),
    total: new Float64Array(N * N), best: new Float64Array(N * N), second: new Float64Array(N * N),
    owner: new Int16Array(N * N).fill(-1),
  };
  const f = new Float64Array(N * N);
  const { total, best, second, owner } = field;
  for (let p = 0; p < nProvinces; p++) {
    const box = provinceKde(field, p, f);
    field.boxes[p] = box;
    if (!box) { continue; }
    for (let y = box[1]; y <= box[3]; y++) {
      for (let x = box[0]; x <= box[2]; x++) {
        const i = y * N + x, v = f[i];
        if (v === 0) { continue; }
        total[i] += v;
        if (v > best[i]) { second[i] = best[i]; best[i] = v; owner[i] = p; }
        else if (v > second[i]) { second[i] = v; }
      }
    }
  }
  return field;
}

// coast = LAND_COAST of one song's peak; mid and high = the 0.5th and 4th
// percentiles (value at floor(p·n) of the sorted list) of the total density
// at the dots' cells, guarded so the terraces stay nested on tiny libraries.
export function landLevels(field, { coast = LAND_COAST } = {}) {
  const { N, xy, total } = field;
  const n = xy.length >> 1;
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gx = clamp(Math.floor(xy[2 * i] * N), 0, N - 1), gy = clamp(Math.floor(xy[2 * i + 1] * N), 0, N - 1);
    vals[i] = total[gy * N + gx];
  }
  vals.sort();
  let mid = n ? vals[Math.min(n - 1, Math.floor(LAND_MID_PCT * n))] : 0;
  let high = n ? vals[Math.min(n - 1, Math.floor(LAND_HIGH_PCT * n))] : 0;
  mid = Math.max(mid, 2 * coast);
  high = Math.max(high, 1.25 * mid);
  return { sigma: field.sigma, coast, mid, high };
}

// Marching squares over the grid points of a cell box (padded by one point
// of −1 on every side, so every ring closes); `get(x, y) > 0` is inside.
// Segments keep the inside on one side (saddles join through the middle) and
// are stitched by grid-edge id, never by float keys. Rings are implicitly
// closed Float64Arrays in map units.
export function contourRings(get, box, N = LAND_N) {
  const [bx0, by0, bx1, by1] = box;
  const ox = bx0 - 1, oy = by0 - 1;
  const W = bx1 - bx0 + 3, H = by1 - by0 + 3;
  const val = new Float64Array(W * H).fill(-1);
  for (let ly = 1; ly < H - 1; ly++) {
    for (let lx = 1; lx < W - 1; lx++) { val[ly * W + lx] = get(ox + lx, oy + ly); }
  }
  const WH = W * H;
  const next = new Int32Array(2 * WH).fill(-1);
  for (let ly = 0; ly < H - 1; ly++) {
    for (let lx = 0; lx < W - 1; lx++) {
      const a = val[ly * W + lx], b = val[ly * W + lx + 1], c = val[(ly + 1) * W + lx + 1], d = val[(ly + 1) * W + lx];
      const idx = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
      if (idx === 0 || idx === 15) { continue; }
      const top = ly * W + lx, bottom = (ly + 1) * W + lx;
      const left = WH + ly * W + lx, right = WH + ly * W + lx + 1;
      switch (idx) {
        case 1: next[left] = bottom; break;
        case 2: next[bottom] = right; break;
        case 3: next[left] = right; break;
        case 4: next[right] = top; break;
        case 5: next[left] = top; next[right] = bottom; break;
        case 6: next[bottom] = top; break;
        case 7: next[left] = top; break;
        case 8: next[top] = left; break;
        case 9: next[top] = bottom; break;
        case 10: next[top] = right; next[bottom] = left; break;
        case 11: next[top] = right; break;
        case 12: next[right] = left; break;
        case 13: next[right] = bottom; break;
        case 14: next[bottom] = left; break;
      }
    }
  }
  const pointOf = (e, out) => {
    if (e < WH) {   // edge (lx, ly)–(lx + 1, ly)
      const ly = Math.floor(e / W), lx = e - ly * W;
      const va = val[ly * W + lx], vb = val[ly * W + lx + 1];
      out.push((ox + lx + va / (va - vb) + 0.5) / N, (oy + ly + 0.5) / N);
    } else {        // edge (lx, ly)–(lx, ly + 1)
      const e2 = e - WH, ly = Math.floor(e2 / W), lx = e2 - ly * W;
      const va = val[ly * W + lx], vb = val[(ly + 1) * W + lx];
      out.push((ox + lx + 0.5) / N, (oy + ly + va / (va - vb) + 0.5) / N);
    }
  };
  const rings = [];
  for (let e = 0; e < 2 * WH; e++) {
    if (next[e] === -1) { continue; }
    const pts = [];
    let cur = e;
    while (cur !== -1) {
      pointOf(cur, pts);
      const nx = next[cur];
      next[cur] = -1;
      if (nx === e) { break; }
      cur = nx;
    }
    if (pts.length >= 6) { rings.push(Float64Array.from(pts)); }
  }
  return rings;
}

export function ringArea(ring) {
  const n = ring.length >> 1;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    a += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
  }
  return a / 2;
}

// Douglas–Peucker on an implicitly closed ring: split at the vertex farthest
// from the start, simplify both halves as open lines (the second ends at the
// start again). Iterative: an explicit stack of index ranges over one array.
export function simplifyClosed(ring, eps) {
  const n = ring.length >> 1;
  if (n < 3) { return Float64Array.from(ring); }
  const ax = ring[0], ay = ring[1];
  let far = 1, fd = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[2 * i] - ax, dy = ring[2 * i + 1] - ay;
    const d = dx * dx + dy * dy;
    if (d > fd) { fd = d; far = i; }
  }
  const X = (i) => ring[2 * (i === n ? 0 : i)];
  const Y = (i) => ring[2 * (i === n ? 0 : i) + 1];
  const keep = new Uint8Array(n + 1);
  keep[0] = 1;
  keep[far] = 1;
  const stack = [0, far, far, n];
  while (stack.length) {
    const hi = stack.pop(), lo = stack.pop();
    if (hi - lo < 2) { continue; }
    const x0 = X(lo), y0 = Y(lo), x1 = X(hi), y1 = Y(hi);
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
    let idx = -1, max = 0;
    for (let i = lo + 1; i < hi; i++) {
      const dist = Math.abs(dy * X(i) - dx * Y(i) + x1 * y0 - y1 * x0) / len;
      if (dist > max) { max = dist; idx = i; }
    }
    if (max > eps) {
      keep[idx] = 1;
      stack.push(lo, idx, idx, hi);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) { if (keep[i]) { out.push(ring[2 * i], ring[2 * i + 1]); } }
  return Float64Array.from(out);
}

export function chaikin(ring, iters = 2) {
  let r = ring;
  for (let it = 0; it < iters; it++) {
    const n = r.length >> 1;
    const out = new Float64Array(4 * n);
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const px = r[2 * i], py = r[2 * i + 1], qx = r[2 * j], qy = r[2 * j + 1];
      out[4 * i] = 0.75 * px + 0.25 * qx;
      out[4 * i + 1] = 0.75 * py + 0.25 * qy;
      out[4 * i + 2] = 0.25 * px + 0.75 * qx;
      out[4 * i + 3] = 0.25 * py + 0.75 * qy;
    }
    r = out;
  }
  return r;
}

// Quantise a ring to u16 and make it canonical, so an unchanged coast gives
// identical bytes: consecutive repeats dropped, positive area (shoelace on
// the integers, y down), starting at the smallest (x, y) vertex. Null when
// fewer than 3 vertices or no area remain.
export function normaliseRingU16(ring) {
  const n = ring.length >> 1;
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    const x = quantU16(ring[2 * i]), y = quantU16(ring[2 * i + 1]);
    if (xs.length && xs[xs.length - 1] === x && ys[ys.length - 1] === y) { continue; }
    xs.push(x);
    ys.push(y);
  }
  while (xs.length > 1 && xs[0] === xs[xs.length - 1] && ys[0] === ys[ys.length - 1]) { xs.pop(); ys.pop(); }
  const m = xs.length;
  if (m < 3) { return null; }
  let area2 = 0;
  for (let i = 0; i < m; i++) {
    const j = i + 1 < m ? i + 1 : 0;
    area2 += xs[i] * ys[j] - xs[j] * ys[i];
  }
  if (area2 === 0) { return null; }
  if (area2 < 0) { xs.reverse(); ys.reverse(); }
  let s = 0;
  for (let i = 1; i < m; i++) {
    if (xs[i] < xs[s] || (xs[i] === xs[s] && ys[i] < ys[s])) { s = i; }
  }
  const out = new Uint16Array(2 * m);
  for (let r = 0; r < m; r++) {
    const i = (s + r) % m;
    out[2 * r] = xs[i];
    out[2 * r + 1] = ys[i];
  }
  return out;
}

const compareRings = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { return a[i] - b[i]; } }
  return a.length - b.length;
};

// Even-odd point-in-polygon over flat rings (any units).
export function pointInRings(px, py, rings) {
  let inside = false;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) { inside = !inside; }
    }
  }
  return inside;
}

// Province p's rings at one level up to the final simplification: inside =
// min(own − strongest other, total − level) > 0, simplified at LAND_EPS,
// Chaikin ×2, specks under LAND_MIN_AREA dropped.
function provinceRingsPre(field, p, level, f) {
  const box = field.boxes[p];
  if (!box) { return []; }
  const { N, total, best, second, owner } = field;
  const get = (x, y) => {
    const i = y * N + x;
    const own = f[i] - (owner[i] === p ? second[i] : best[i]);
    const above = total[i] - level;
    return own < above ? own : above;
  };
  const out = [];
  for (const ring of contourRings(get, box, N)) {
    const smooth = chaikin(simplifyClosed(ring, LAND_EPS), 2);
    if (Math.abs(ringArea(smooth)) >= LAND_MIN_AREA) { out.push(smooth); }
  }
  return out;
}

function finishRings(pre, eps) {
  const out = [];
  for (const ring of pre) {
    const q = normaliseRingU16(simplifyClosed(ring, eps));
    if (q) { out.push(q); }
  }
  return out.sort(compareRings);
}

// The land step: field, levels, then per province the three terraces
// (coast, mid, high) as one land-v1 blob. Caps: a province over provinceCap
// raises its final ε ×LAND_EPS_GROWTH per step until it fits; then, while the
// layout is over layoutCap, a floor under every province's ε rises the same
// way. `eps` reports each province's final ε.
export function buildLand({
  xy, province, nProvinces, sigma = landSigma(xy.length >> 1), N = LAND_N,
  provinceCap = LAND_PROVINCE_CAP, layoutCap = LAND_LAYOUT_CAP,
}) {
  const field = landField({ xy, province, nProvinces, sigma, N });
  const levels = landLevels(field);
  const f = new Float64Array(N * N);
  const pre = [];
  for (let p = 0; p < nProvinces; p++) {
    if (!field.boxes[p]) { pre.push([[], [], []]); continue; }
    provinceKde(field, p, f);
    pre.push([levels.coast, levels.mid, levels.high].map((L) => provinceRingsPre(field, p, L, f)));
  }
  const eps = new Float64Array(nProvinces).fill(LAND_FINAL_EPS);
  const land = new Array(nProvinces);
  const encode = (p) => { land[p] = encodeLandV1(pre[p].map((rings) => finishRings(rings, eps[p]))); };
  for (let p = 0; p < nProvinces; p++) {
    encode(p);
    for (let step = 0; land[p].length > provinceCap && step < LAND_CAP_STEPS; step++) {
      eps[p] *= LAND_EPS_GROWTH;
      encode(p);
    }
  }
  let sum = 0;
  for (let p = 0; p < nProvinces; p++) { sum += land[p].length; }
  let floor = LAND_FINAL_EPS;
  for (let step = 0; sum > layoutCap && step < LAND_CAP_STEPS; step++) {
    floor *= LAND_EPS_GROWTH;
    sum = 0;
    for (let p = 0; p < nProvinces; p++) {
      if (eps[p] < floor) { eps[p] = floor; encode(p); }
      sum += land[p].length;
    }
  }
  return { levels, land, eps, field };
}

// Provinces are neighbours when their coast-level land comes within
// ⌈3σ·N⌉ cells (a square dilation; touching coasts are within one cell).
export function landAdjacency(field, coast) {
  const { N, sigma, total, best, second, owner } = field;
  const P = field.dotsOf.length;
  const R = Math.ceil(3 * sigma * N);
  const landOwner = new Int16Array(N * N).fill(-1);
  for (let i = 0; i < N * N; i++) {
    if (owner[i] >= 0 && total[i] > coast && best[i] > second[i]) { landOwner[i] = owner[i]; }
  }
  const rowHit = new Uint8Array(N * N), hit = new Uint8Array(N * N);
  const pre = new Int32Array(N + 1);
  const seen = new Set();
  const pairs = [];
  for (let p = 0; p < P; p++) {
    let any = false;
    for (let i = 0; i < N * N; i++) { if (landOwner[i] === p) { any = true; break; } }
    if (!any) { continue; }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) { pre[x + 1] = pre[x] + (landOwner[y * N + x] === p ? 1 : 0); }
      for (let x = 0; x < N; x++) { rowHit[y * N + x] = pre[Math.min(N, x + R + 1)] - pre[Math.max(0, x - R)] > 0 ? 1 : 0; }
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) { pre[y + 1] = pre[y] + rowHit[y * N + x]; }
      for (let y = 0; y < N; y++) { hit[y * N + x] = pre[Math.min(N, y + R + 1)] - pre[Math.max(0, y - R)] > 0 ? 1 : 0; }
    }
    for (let i = 0; i < N * N; i++) {
      const q = landOwner[i];
      if (!hit[i] || q < 0 || q === p) { continue; }
      const a = p < q ? p : q, b = p < q ? q : p;
      const key = a * 65536 + b;
      if (!seen.has(key)) { seen.add(key); pairs.push([a, b]); }
    }
  }
  return sortPairs(pairs);
}

// ── codecs (§3.5.9, §3.8.9; little-endian) ─────────────────────────────────

export function quantU16(v) {
  if (!Number.isFinite(v)) { return 0; }
  return Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 65535);
}

const isU = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

// cols-v1: n points sorted by id ascending, 11·n bytes — u32 ids at 0, u16 x
// at 4n, u16 y at 6n, u8 province at 8n, u8 town at 9n, u8 flags at 10n.
// Every column starts aligned to its element size.
export function encodePointsColsV1({ ids, x, y, region0, region1, flags }) {
  const n = ids.length;
  for (const col of [x, y, region0, region1, flags]) {
    if (col.length !== n) { throw new Error('cols-v1: columns differ in length'); }
  }
  const out = new Uint8Array(11 * n);
  const dv = new DataView(out.buffer);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (!isU(id, 0xffffffff) || id <= prev) { throw new Error('cols-v1: ids must be ascending u32'); }
    prev = id;
    if (!isU(x[i], 0xffff) || !isU(y[i], 0xffff)) { throw new Error('cols-v1: x and y must be u16'); }
    if (!isU(region0[i], 0xff) || !isU(region1[i], 0xff) || !isU(flags[i], 0xff)) { throw new Error('cols-v1: regions and flags must be u8'); }
    dv.setUint32(4 * i, id, true);
    dv.setUint16(4 * n + 2 * i, x[i], true);
    dv.setUint16(6 * n + 2 * i, y[i], true);
    out[8 * n + i] = region0[i];
    out[9 * n + i] = region1[i];
    out[10 * n + i] = flags[i];
  }
  return out;
}

export function decodePointsColsV1(bytes, n) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!Number.isInteger(n) || n < 0 || u8.length !== 11 * n) { throw new Error('cols-v1: length does not match n'); }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ids = new Uint32Array(n), x = new Uint16Array(n), y = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = dv.getUint32(4 * i, true);
    x[i] = dv.getUint16(4 * n + 2 * i, true);
    y[i] = dv.getUint16(6 * n + 2 * i, true);
  }
  return {
    ids, x, y,
    region0: u8.slice(8 * n, 9 * n),
    region1: u8.slice(9 * n, 10 * n),
    flags: u8.slice(10 * n, 11 * n),
  };
}

// ⌈n/8⌉ bytes; point i is bit (i & 7), LSB first, of byte i >> 3.
export function encodeBitset(n, bitAt) {
  const at = typeof bitAt === 'function' ? bitAt : (i) => bitAt[i];
  const out = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) { if (at(i)) { out[i >> 3] |= 1 << (i & 7); } }
  return out;
}

export function bitsetGet(bytes, i) {
  return (bytes[i >> 3] >> (i & 7)) & 1;
}

// land-v1, one blob per province: three times (coast, mid, high) a u16 ring
// count, then per ring a u16 vertex count (≥ 3) and that many (u16 x, u16 y),
// closed implicitly. `levels` = [coast, mid, high], each an array of flat
// rings [x0, y0, x1, y1, …] in u16. Counts over 65,535 throw (DataView's
// setUint16 would wrap them silently).
export function encodeLandV1(levels) {
  if (!Array.isArray(levels) || levels.length !== 3) { throw new Error('land-v1: expected three levels'); }
  let size = 0;
  for (const rings of levels) {
    if (rings.length > 0xffff) { throw new Error('land-v1: more than 65,535 rings in a level'); }
    size += 2;
    for (const r of rings) {
      const vc = r.length >> 1;
      if (r.length % 2 !== 0 || vc < 3) { throw new Error('land-v1: a ring needs at least 3 (x, y) vertices'); }
      if (vc > 0xffff) { throw new Error('land-v1: more than 65,535 vertices in a ring'); }
      size += 2 + 4 * vc;
    }
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const rings of levels) {
    dv.setUint16(o, rings.length, true);
    o += 2;
    for (const r of rings) {
      dv.setUint16(o, r.length >> 1, true);
      o += 2;
      for (let j = 0; j < r.length; j++) {
        if (!isU(r[j], 0xffff)) { throw new Error('land-v1: coordinates must be u16'); }
        dv.setUint16(o, r[j], true);
        o += 2;
      }
    }
  }
  return out;
}

// Rejects a blob whose counts run past its end, a ring under 3 vertices, or
// bytes left over after the last vertex.
export function decodeLandV1(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = u8.length;
  let o = 0;
  const levels = [];
  for (let l = 0; l < 3; l++) {
    if (o + 2 > len) { throw new Error('land-v1: truncated ring count'); }
    const rc = dv.getUint16(o, true);
    o += 2;
    const rings = [];
    for (let r = 0; r < rc; r++) {
      if (o + 2 > len) { throw new Error('land-v1: truncated vertex count'); }
      const vc = dv.getUint16(o, true);
      o += 2;
      if (vc < 3) { throw new Error('land-v1: a ring has fewer than 3 vertices'); }
      if (o + 4 * vc > len) { throw new Error('land-v1: truncated ring'); }
      const ring = new Uint16Array(2 * vc);
      for (let j = 0; j < 2 * vc; j++) { ring[j] = dv.getUint16(o, true); o += 2; }
      rings.push(ring);
    }
    levels.push(rings);
  }
  if (o !== len) { throw new Error('land-v1: bytes left over after the last ring'); }
  return levels;
}

// f32le BLOBs (pca_mean, pca_axes, map_points.pca, embeddings).
export function f32ToBytes(arr) {
  const f = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  if (HOST_LE) { return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); }
  const out = new Uint8Array(4 * f.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < f.length; i++) { dv.setFloat32(4 * i, f[i], true); }
  return out;
}

// A BLOB → an aligned Float32Array copy (node:sqlite's Uint8Arrays are not
// guaranteed 4-byte aligned). `count` checks the element count.
export function f32FromBytes(blob, count = null) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (u8.byteLength % 4 !== 0) { throw new Error('f32 blob: length is not a multiple of 4'); }
  if (count != null && u8.byteLength !== 4 * count) { throw new Error(`f32 blob: expected ${count} floats, got ${u8.byteLength / 4}`); }
  const out = new Float32Array(u8.byteLength / 4);
  if (HOST_LE) {
    new Uint8Array(out.buffer).set(u8);
  } else {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < out.length; i++) { out[i] = dv.getFloat32(4 * i, true); }
  }
  return out;
}

// ── recent (§3.5.7, §3.8.3) ────────────────────────────────────────────────

// 00:00 UTC `days` days before nowMs, formatted like tracks.created_at.
export function utcMidnightDaysAgo(days, nowMs) {
  const d = new Date(nowMs);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - days);
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// 'YYYY-MM-DD HH:MM:SS' (SQLite datetime(), UTC) → epoch seconds, or null.
export function sqliteUtcToSec(text) {
  if (typeof text !== 'string') { return null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) { return null; }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
