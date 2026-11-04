// The music map's UMAP fit (docs/music-map-plan.md §3.5.2): a thin wrapper
// over umap-js 1.4.0 (exact pin — the stability tests are tied to the
// algorithm, so an upgrade is its own PR). This is the only module that
// imports umap-js, and only the map worker imports it, so the server process
// never loads the library. Everything else the worker needs lives in the
// pure map-lib.js.
//
// fitUmap(rows, init, { nNeighbors, minDist, seed, nEpochs, learningRate,
//                       onEpoch }) → { raw, knnIndices, knnDistances, epochs }
//   rows          n PCA rows (map-lib rowsOf), sorted by audio_hash: NN-descent
//                 and the SGD sampling depend on row order
//   init          Float64Array(2n) raw start positions (map-lib pcaInit for a
//                 rebuild; the previous RAW layout plus kNN placements for a
//                 warm refit — never the [0,1] map coordinates), or null for
//                 umap-js's own seeded random start
//   nEpochs       default: umap-js's 500/400/300/200 by n; a refit passes
//                 UMAP_REFIT (150 epochs, learning rate 0.3)
//   onEpoch(e, epochs)  after every epoch; a returned promise is awaited (the
//                 worker reports progress and yields with setImmediate there)
//   raw           Float64Array(2n), the fitted raw coordinates (umap-js units)
//   knnIndices / knnDistances   the fit's kNN graph, n × nNeighbors, self in
//                 column 0 at distance 0, distances Euclidean in PCA space —
//                 the near-duplicate candidates (map-lib knnGraphPairs)
//
// How the init gets in: umap-js has no option for it. initializeFit() draws a
// random start into this.embedding and aliases the optimiser's head and tail
// embeddings to that same array (umap.ts initializeOptimization), so the
// rows of getEmbedding() are written in place; assigning a new array would
// be silently ignored.
//
// Determinism: every random draw comes from mulberry32(seed), so the same
// rows, seed and runtime give the same bytes. Node and Bun diverge (Math.exp
// and Math.pow differ in the last bits), so tests assert properties there.

import { UMAP } from 'umap-js';
import { mulberry32, UMAP_PARAMS } from './map-lib.js';

export async function fitUmap(rows, init, {
  nNeighbors = UMAP_PARAMS.nNeighbors, minDist = UMAP_PARAMS.minDist, seed = UMAP_PARAMS.seed,
  nEpochs, learningRate, onEpoch,
} = {}) {
  const n = rows.length;
  // umap-js throws "Not enough data points" at n ≤ nNeighbors; say so first.
  if (n <= nNeighbors) {
    throw new Error(`fitUmap: ${n} rows cannot fit ${nNeighbors} neighbours (UMAP needs more rows than neighbours)`);
  }
  if (init && init.length !== 2 * n) {
    throw new Error(`fitUmap: init holds ${init.length / 2} points for ${n} rows`);
  }
  const X = rows.map((r) => (Array.isArray(r) ? r : Array.from(r)));
  const umap = new UMAP({ nComponents: 2, nNeighbors, minDist, random: mulberry32(seed), nEpochs, learningRate });
  const epochs = umap.initializeFit(X);
  // Set by initializeFit; private in the typings, plain fields at runtime.
  const { knnIndices, knnDistances } = umap;
  if (!Array.isArray(knnIndices) || !Array.isArray(knnDistances) || knnIndices.length !== n) {
    throw new Error('fitUmap: umap-js no longer exposes knnIndices/knnDistances after initializeFit');
  }
  if (init) {
    const emb = umap.getEmbedding();
    for (let i = 0; i < n; i++) {
      emb[i][0] = init[2 * i];
      emb[i][1] = init[2 * i + 1];
    }
  }
  for (let e = 0; e < epochs; e++) {
    umap.step();
    if (onEpoch) {
      const r = onEpoch(e + 1, epochs);
      if (r && typeof r.then === 'function') { await r; }
    }
  }
  const out = umap.getEmbedding();
  const raw = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    raw[2 * i] = out[i][0];
    raw[2 * i + 1] = out[i][1];
  }
  return { raw, knnIndices, knnDistances, epochs };
}
