// In-memory similarity index over discovery.db's embeddings — the read side
// of the discovery dataset. Powers /api/v1/discovery/local/similar and
// /similar-artists (src/api/discovery.js).
//
// Design: brute-force cosine over an in-memory Float32Array matrix. At
// self-hosted scale (10k tracks × 1280-d ≈ 50 MB, ~13M multiply-adds per
// query ≈ 15-30 ms) an ANN index would be pure complexity; vectors are
// L2-normalized at write time, so cosine = dot product.
//
// Cache invalidation rides the dataset's own monotonic rowversion:
// discovery_meta.row_seq bumps on EVERY discovery_tracks write (that's what
// updated_at is derived from), so one cheap meta read per request tells us
// whether the matrix is stale. The active model is part of the cache key —
// only rows pinned to the CURRENTLY configured model are comparable (rows
// from an in-progress model migration are excluded until re-embedded).
//
// The peer-dataset import (the p2p thread) is expected to plug in here
// later: peer snapshots become additional entry sources feeding the same
// ranking scan.

import winston from 'winston';
import * as discoveryDb from './discovery-db.js';
import * as config from '../state/config.js';

let cache = null;

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
  const seq = discoveryDb.getMeta('row_seq') || '0';
  if (cache && cache.seq === seq && cache.modelId === modelId) { return cache; }

  const started = Date.now();
  const rows = ddb.prepare(`
    SELECT audio_hash, artist, embedding, genre_tags
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
    const entry = { hash: r.audio_hash, artist: r.artist || null, vec, genreTags };
    entries.push(entry);
    byHash.set(entry.hash, entry);
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
  cache = { seq, modelId, modelVersion, dim, entries, byHash, artists };
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
  const out = new Set();
  for (const e of index.entries) {
    if (dot(seedVec, e.vec) >= minSimilarity) { out.add(e.hash); }
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

/**
 * All entries ranked by similarity to `seedVec`, descending, excluding
 * `excludeHash`. The caller walks the ranking and applies its own
 * access/exclusion filters until it has enough results.
 */
export function rankTracks(index, seedVec, excludeHash) {
  const out = [];
  for (const e of index.entries) {
    if (e.hash === excludeHash) { continue; }
    out.push({ entry: e, similarity: dot(seedVec, e.vec) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
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
