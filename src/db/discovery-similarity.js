// In-memory similarity index over discovery.db's embeddings — the read side
// of the discovery dataset. Powers /api/v1/discovery/local/similar/tracks and
// /similar-artists (src/api/discovery.js).
//
// Design: brute-force cosine over an in-memory Float32Array matrix. At
// self-hosted scale (10k tracks × 1280-d ≈ 50 MB, ~13M multiply-adds per
// query ≈ 15-30 ms) an ANN index would be pure complexity; vectors are
// L2-normalized at write time, so cosine = dot product.
//
// Cache invalidation rides discovery_meta.index_epoch — the BATCH-grained
// watermark writers publish at run/batch boundaries (discovery-db.js). It
// deliberately does NOT ride row_seq, which bumps on EVERY row write: keyed
// on row_seq, each request during a multi-hour embedding backfill saw a new
// value and rebuilt the full matrix on the event loop (audit H5, 1.5-1.7 s
// per rebuild at 25k tracks). DBs that predate the epoch key fall back to
// row_seq until a writer first publishes. A time-boxed safety net (below)
// still catches a writer that moved row_seq but never published, so a
// forgotten publish costs bounded staleness, never a stale-forever index.
// The active model is part of the cache key — only rows pinned to the
// CURRENTLY configured model are comparable (rows from an in-progress model
// migration are excluded until re-embedded).
//
// The peer-dataset import (the p2p thread) is expected to plug in here
// later: peer snapshots become additional entry sources feeding the same
// ranking scan.

import winston from 'winston';
import * as discoveryDb from './discovery-db.js';
import * as config from '../state/config.js';

let cache = null;

// Safety net for the epoch keying: if row_seq moved but no writer published
// a new epoch (a future writer that forgot, hand-edited DBs), rebuild anyway
// once the cache is this old. Bounds both failure modes: staleness can't
// exceed this window, and mid-backfill rebuild churn can't exceed one
// rebuild per window.
const STALE_REBUILD_MS =
  Number(process.env.MSTREAM_TEST_SIM_STALE_REBUILD_MS) || 5 * 60 * 1000;

// Test/ops hook: drop the cached matrix (e.g. after swapping discovery.db
// files out from under the process).
export function invalidate() { cache = null; }

// Blob → aligned Float32Array. node:sqlite hands back Uint8Arrays whose
// byteOffset isn't guaranteed 4-byte aligned; copy into a fresh buffer.
function blobToVec(blob) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return new Float32Array(buf);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; }
  return s;
}

function l2normalize(v) {
  let ss = 0;
  for (let i = 0; i < v.length; i++) { ss += v[i] * v[i]; }
  const n = Math.sqrt(ss) || 1;
  for (let i = 0; i < v.length; i++) { v[i] /= n; }
  return v;
}

/**
 * The current similarity index, rebuilt when the dataset or the configured
 * model changed. Returns null when discovery has no store to read (feature
 * never enabled / DB missing).
 *
 * Shape: {
 *   modelId, modelVersion, dim,
 *   entries: [{ hash, artist, vec, genreTags }],
 *   byHash:  Map<hash, entry>,
 *   artists: Map<artistName, { vec, analyzedCount, topTags }>,
 * }
 */
export function getIndex() {
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!ddb) { return null; }

  const modelId = config.program.scanOptions.discoveryModel;
  const rowSeq = discoveryDb.getMeta('row_seq') || '0';
  const epoch = discoveryDb.getMeta('index_epoch');
  // Batch-grained key when a writer has ever published; per-write fallback
  // otherwise (pre-epoch DBs, tests writing directly).
  const seq = epoch !== null ? epoch : rowSeq;
  if (cache && cache.seq === seq && cache.modelId === modelId) {
    // Epoch says fresh but rows moved underneath and nobody published —
    // serve the cache until it ages out, then rebuild despite the epoch.
    const unpublishedDrift = epoch !== null && cache.rowSeq !== rowSeq;
    if (!unpublishedDrift || Date.now() - cache.builtAt < STALE_REBUILD_MS) {
      return cache;
    }
  }

  const started = Date.now();
  const rows = ddb.prepare(`
    SELECT audio_hash, artist, title, embedding, genre_tags
      FROM discovery_tracks
     WHERE embedding IS NOT NULL AND model_id = ?
  `).all(modelId);

  const entries = [];
  const byHash = new Map();
  let dim = null;
  for (const r of rows) {
    const vec = blobToVec(r.embedding);
    if (dim === null) { dim = vec.length; }
    if (vec.length !== dim || dim === 0) { continue; }   // defensive: never mix dims
    let genreTags = null;
    if (r.genre_tags) {
      try { genreTags = JSON.parse(r.genre_tags); } catch (_e) { /* stays null */ }
    }
    const entry = {
      hash: r.audio_hash, artist: r.artist || null, title: r.title || null, vec, genreTags,
      // Same-song dedupe key, precomputed ONCE — pathBetween used to rebuild
      // it per entry per waypoint (two trims + lowercases × 25k × waypoints).
      // Rows without a title dedupe by hash alone (null key).
      nameKey: r.title
        ? `${(r.artist || '').trim().toLowerCase()}|${r.title.trim().toLowerCase()}`
        : null,
    };
    entries.push(entry);
    byHash.set(entry.hash, entry);
  }

  // Re-home every vector into ONE contiguous Float32Array and hand each
  // entry a subarray view of it. API-identical (entry.vec still indexes the
  // same floats), but the brute-force scans (rankTracks, pathBetween,
  // hashesWithinThreshold) now stream a single sequential buffer instead of
  // pointer-chasing 25k separately allocated arrays.
  const matrix = new Float32Array(entries.length * (dim || 0));
  for (let i = 0; i < entries.length; i++) {
    matrix.set(entries[i].vec, i * dim);
    entries[i].vec = matrix.subarray(i * dim, (i + 1) * dim);
  }

  // Artist centroids: mean of the artist's track vectors, re-normalized.
  // topTags = the artist's most frequent model tags (the "why similar"
  // line for the artists endpoint). Untagged/unknown-artist rows are not
  // part of the artist space.
  const artists = new Map();
  const grouped = new Map();
  for (const e of entries) {
    if (!e.artist) { continue; }
    if (!grouped.has(e.artist)) { grouped.set(e.artist, []); }
    grouped.get(e.artist).push(e);
  }
  for (const [name, list] of grouped) {
    const centroid = new Float32Array(dim);
    const tagCounts = new Map();
    for (const e of list) {
      for (let i = 0; i < dim; i++) { centroid[i] += e.vec[i]; }
      for (const t of e.genreTags || []) { tagCounts.set(t, (tagCounts.get(t) || 0) + 1); }
    }
    for (let i = 0; i < dim; i++) { centroid[i] /= list.length; }
    l2normalize(centroid);
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    artists.set(name, { vec: centroid, analyzedCount: list.length, topTags: topTags.length ? topTags : null });
  }

  const modelVersion = discoveryDb.getMeta('embedding_model_version') || null;
  cache = { seq, rowSeq, builtAt: Date.now(), modelId, modelVersion, dim, entries, byHash, artists, matrix };
  winston.info(`discovery similarity index built: ${entries.length} tracks, ${artists.size} artists, ${dim}-d (${Date.now() - started} ms)`);
  return cache;
}

/**
 * Mean of several (L2-normalized) vectors, re-normalized — the session
 * centroid for multi-seed queries (Auto-DJ's rolling anchor). Same math as
 * the artist centroids above. Returns null on empty input.
 */
export function centroidOf(vecs) {
  if (!Array.isArray(vecs) || vecs.length === 0) { return null; }
  const dim = vecs[0].length;
  const c = new Float32Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) { c[i] += v[i]; }
  }
  for (let i = 0; i < dim; i++) { c[i] /= vecs.length; }
  return l2normalize(c);
}

/**
 * The set of canonical hashes whose cosine vs `seedVec` is >= `minSimilarity`.
 * The sonic pool for Auto-DJ: un-analyzed tracks have no entry and are
 * therefore never in the pool — "within the similarity range" is only a
 * promise the index can make about vectors it has.
 */
export function hashesWithinThreshold(index, seedVec, minSimilarity) {
  const n = index.entries.length;
  const scores = scoresInto(new Float64Array(n), index, seedVec);
  const out = new Set();
  for (let i = 0; i < n; i++) {
    if (scores[i] >= minSimilarity) { out.add(index.entries[i].hash); }
  }
  return out;
}

/**
 * Cosine of one indexed track vs `seedVec`, or null when the hash isn't in
 * the index.
 */
export function similarityToHash(index, seedVec, hash) {
  const e = index.byHash.get(hash);
  return e ? dot(seedVec, e.vec) : null;
}

// Scores of every entry vs `seedVec`, written into `out` (Float64Array so
// near-tie ordering matches the old per-entry float64 dots exactly). The
// fast path is one flat monomorphic loop over the contiguous matrix — the
// per-entry dot() calls it replaces paid call + bounds overhead 25k times
// per scan and were the dominant cost of every ranking. Hand-built indexes
// without a matrix (tests, embedders) fall back to per-entry dots.
function scoresInto(out, index, seedVec) {
  const entries = index.entries;
  const n = entries.length;
  const dim = seedVec.length;
  const m = index.matrix;
  if (m && m.length === n * dim) {
    for (let i = 0, off = 0; i < n; i++, off += dim) {
      let s = 0;
      for (let k = 0; k < dim; k++) { s += seedVec[k] * m[off + k]; }
      out[i] = s;
    }
  } else {
    for (let i = 0; i < n; i++) { out[i] = dot(seedVec, entries[i].vec); }
  }
  return out;
}

// The K highest-scoring indices in [0, n), descending, considering only
// indices `eligible` accepts. Bounded min-heap over indices — O(n log K)
// and zero per-candidate allocation, vs the build-25k-objects-and-sort
// pattern this replaces (audit M9 / C3-JS-half). K >= n degrades to a
// plain filter + full sort, which is the correct fallback shape.
function selectTopKDesc(scores, n, k, eligible) {
  if (k >= n) {
    const all = [];
    for (let i = 0; i < n; i++) { if (eligible(i)) { all.push(i); } }
    all.sort((a, b) => scores[b] - scores[a]);
    return all;
  }
  const heap = new Int32Array(k);   // min-heap on scores[heap[i]]
  let size = 0;
  for (let i = 0; i < n; i++) {
    if (!eligible(i)) { continue; }
    if (size < k) {
      // sift up
      let c = size++;
      heap[c] = i;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (scores[heap[p]] <= scores[heap[c]]) { break; }
        const t = heap[p]; heap[p] = heap[c]; heap[c] = t;
        c = p;
      }
    } else if (scores[i] > scores[heap[0]]) {
      // replace the root, sift down
      heap[0] = i;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < size && scores[heap[l]] < scores[heap[m]]) { m = l; }
        if (r < size && scores[heap[r]] < scores[heap[m]]) { m = r; }
        if (m === p) { break; }
        const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
        p = m;
      }
    }
  }
  const out = Array.from(heap.subarray(0, size));
  out.sort((a, b) => scores[b] - scores[a]);
  return out;
}

/**
 * Entries ranked by similarity to `seedVec`, descending, excluding
 * `excludeHash`. The caller walks the ranking and applies its own
 * access/exclusion filters until it has enough results.
 *
 * `topK` truncates the ranking to the caller's consideration budget —
 * every route already caps its walk (max(limit*50, 2000) since the
 * 2026-07 audit), so ranking past the cap was pure waste: a 25k-object
 * allocation + full sort per Discover refresh. Omit it (Infinity) for the
 * legacy full ranking.
 */
export function rankTracks(index, seedVec, excludeHash, topK = Infinity) {
  const entries = index.entries;
  const n = entries.length;
  const scores = scoresInto(new Float64Array(n), index, seedVec);
  const k = Number.isFinite(topK) ? Math.max(0, topK) : n;
  const idx = selectTopKDesc(scores, n, k, (i) => entries[i].hash !== excludeHash);
  return idx.map((i) => ({ entry: entries[i], similarity: scores[i] }));
}

/**
 * Spherical interpolation between two UNIT vectors — the arc, not the
 * chord: lerping unit vectors cuts through the sphere's interior, where
 * cosine distances stop meaning anything; slerp stays in embedding space.
 * Falls back to normalized lerp when sin Ω → 0 (near-parallel seeds; the
 * antipodal case is theoretical — audio embeddings live in a cone).
 * Exported for tests.
 */
export function slerp(a, b, t) {
  let d = dot(a, b);
  if (d > 1) { d = 1; } else if (d < -1) { d = -1; }
  const omega = Math.acos(d);
  const s = Math.sin(omega);
  const out = new Float32Array(a.length);
  if (s < 1e-6) {
    for (let i = 0; i < a.length; i++) { out[i] = a[i] * (1 - t) + b[i] * t; }
    return l2normalize(out);
  }
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  for (let i = 0; i < a.length; i++) { out[i] = a[i] * wa + b[i] * wb; }
  return out;
}

/**
 * A "sonic path" from `hashA` to `hashB`: `waypoints` evenly spaced points
 * along the great-circle arc between the seeds' vectors (slerp), each
 * snapped to the nearest indexed track by cosine — skipping the seeds,
 * every earlier pick, and anything `visible(hash)` rejects (the caller's
 * library-access gate, consulted lazily best-candidate-first because it
 * costs a main-DB lookup; a rejected hash is rejected for every later
 * waypoint too, so it joins the skip set).
 *
 * Returns [{ hash, similarity, t }] in path order, `similarity` being the
 * pick's cosine against ITS OWN waypoint ("how on-path is this step").
 * Fewer rows than requested when the pool runs dry (tiny or mostly
 * invisible libraries) — never an error.
 *
 * Deliberately v1-simple: pure nearest-to-waypoint. Artist-diversity and
 * monotonic-progress rules are tuning knobs to add against real listening,
 * not guesses to bake in now.
 */
export function pathBetween(index, hashA, hashB, waypoints, visible) {
  const a = index.byHash.get(hashA);
  const b = index.byHash.get(hashB);
  if (!a || !b || waypoints <= 0) { return []; }

  // Hash dedupe alone isn't enough: real libraries hold the same SONG as
  // several files (single vs EP master, re-encodes) with distinct audio
  // hashes, and a journey that plays "Mistaken" twice is broken. The
  // normalized artist+title key is precomputed at index build
  // (entry.nameKey); hand-built indexes (tests, embedders) get it memoized
  // on first touch. Rows missing a title fall back to hash-only dedupe.
  const keyOf = (e) => {
    if (e.nameKey === undefined) {
      e.nameKey = e.title
        ? `${(e.artist || '').trim().toLowerCase()}|${e.title.trim().toLowerCase()}`
        : null;
    }
    return e.nameKey;
  };
  const used = new Set([hashA, hashB]);
  const usedNames = new Set([keyOf(a), keyOf(b)].filter(Boolean));
  const out = [];

  // Per-waypoint cost used to be 25k dots + a 25k-object allocation + a full
  // sort, × every waypoint (2.2–5.7 s per /path request — audit C3-JS-half).
  // Two rework layers:
  //   1. slerp(a,b,t) is a LINEAR combination of the two endpoint vectors
  //      (wa·a + wb·b in both of its branches), so every waypoint's cosine
  //      against entry e is wa·dot(a,e) + wb·dot(b,e) — two full dot passes
  //      up front replace one per waypoint, and each waypoint's scores are
  //      a 25k-element multiply-add;
  //   2. the full sort per waypoint becomes a bounded top-K selection — the
  //      pick is nearly always in the first few candidates, and the rare
  //      pathological waypoint (every top candidate invisible to this
  //      caller) escalates to the full ordering once.
  const entries = index.entries;
  const n = entries.length;
  const dotA = scoresInto(new Float64Array(n), index, a.vec);
  const dotB = scoresInto(new Float64Array(n), index, b.vec);
  const scores = new Float64Array(n);
  const BATCH = 256;
  const eligible = (i) => {
    const e = entries[i];
    if (used.has(e.hash)) { return false; }
    const key = keyOf(e);
    return !(key && usedNames.has(key));
  };

  // Waypoint weights, replicating slerp()'s two branches on scalars: the
  // spherical weights when sin Ω is healthy, the normalized-lerp weights
  // when the seeds are near-parallel.
  let d = dot(a.vec, b.vec);
  if (d > 1) { d = 1; } else if (d < -1) { d = -1; }
  const omega = Math.acos(d);
  const sinOmega = Math.sin(omega);
  const weightsAt = (t) => {
    if (sinOmega < 1e-6) {
      const norm = Math.sqrt((1 - t) * (1 - t) + t * t + 2 * t * (1 - t) * d) || 1;
      return [(1 - t) / norm, t / norm];
    }
    return [Math.sin((1 - t) * omega) / sinOmega, Math.sin(t * omega) / sinOmega];
  };

  for (let k = 1; k <= waypoints; k++) {
    const t = k / (waypoints + 1);
    const [wa, wb] = weightsAt(t);
    for (let i = 0; i < n; i++) { scores[i] = wa * dotA[i] + wb * dotB[i]; }

    let pick = null;
    const walk = (indices) => {
      for (const i of indices) {
        if (!eligible(i)) { continue; }   // `used` grows during the walk
        const e = entries[i];
        if (visible(e.hash)) { pick = { entry: e, similarity: scores[i] }; return; }
        // A rejected hash is rejected for every later waypoint too.
        used.add(e.hash);
      }
    };
    const batch = selectTopKDesc(scores, n, BATCH, eligible);
    walk(batch);
    if (!pick && batch.length === BATCH) {
      walk(selectTopKDesc(scores, n, n, eligible));
    }

    if (!pick) { break; }
    used.add(pick.entry.hash);
    if (pick.entry.nameKey) { usedNames.add(pick.entry.nameKey); }
    out.push({ hash: pick.entry.hash, similarity: pick.similarity, t });
  }
  return out;
}

/**
 * All artists ranked by centroid similarity to `seedArtist`'s centroid.
 */
export function rankArtists(index, seedArtist) {
  const seed = index.artists.get(seedArtist);
  if (!seed) { return null; }
  const out = [];
  for (const [name, a] of index.artists) {
    if (name === seedArtist) { continue; }
    out.push({ artist: name, analyzedCount: a.analyzedCount, topTags: a.topTags, similarity: dot(seed.vec, a.vec) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

/**
 * An artist's own tracks ranked by similarity to `seedVec` — the "entry
 * points" into a similar artist: where to start listening, in the context
 * of the sound the user came from.
 */
export function rankArtistTracks(index, artistName, seedVec) {
  const out = [];
  for (const e of index.entries) {
    if (e.artist !== artistName) { continue; }
    out.push({ entry: e, similarity: dot(seedVec, e.vec) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}
