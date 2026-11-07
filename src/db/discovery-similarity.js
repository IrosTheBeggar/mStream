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
import { nameKey } from './name-key.js';
import { NEAR_DUP } from './discovery-novelty.js';
import * as db from './manager.js';

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

// Artist identity in the index = the library's rule (src/db/name-key.js):
// spellings that fold to one key are ONE artist. Empty / whitespace-only
// (an untagged row) → null, and the row stays out of the artist space.
function artistKey(raw) {
  const key = nameKey(raw);
  return key || null;
}

// Memoized per entry; hand-built indexes (tests, embedders) get it on first
// touch, the way pathBetween memoizes the same-song key.
function artistKeyOf(e) {
  if (e.artistKey === undefined) { e.artistKey = artistKey(e.artist); }
  return e.artistKey;
}

// Who owns each embedded row TODAY, by canonical hash: the library track's
// primary artist (name_key + current display name). The catalogue string is
// the spelling a track had when it was embedded; the library's word is the
// artist's identity NOW — spellings V71 merged, credits the scanner has since
// re-split ("Atb Feat. X" → Atb + featured X), files retagged after their
// embedding. Duplicate files share a hash: the lowest track id decides,
// deterministically. Null when no main database is open (module-level
// callers in tests) — rows then fold by their catalogue spelling alone.
function loadLibraryOwners() {
  const main = db.getDB();
  if (!main) { return null; }
  const owners = new Map();
  const rows = main.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name_key AS key, a.name AS name
      FROM tracks t
      JOIN artists a ON a.id = t.artist_id
     WHERE a.name_key IS NOT NULL AND a.name_key <> ''
     ORDER BY t.id
  `).all();
  for (const r of rows) {
    if (r.hash && !owners.has(r.hash)) { owners.set(r.hash, { key: r.key, name: r.name }); }
  }
  return owners;
}

// The main connection's counter of OTHER connections' commits — the scanner's
// when a rescan merges, renames or re-homes artists. Null when no main
// database is open.
function libraryVersion() {
  const main = db.getDB();
  if (!main) { return null; }
  return main.prepare('PRAGMA data_version').get().data_version;
}

/**
 * The artist identity of one catalogue row: the library's when the row's
 * track is still in the library (`owner` = { key, name } from
 * loadLibraryOwners), else the folded catalogue spelling with no library name.
 */
export function artistIdentity(catalogueArtist, owner) {
  if (owner) { return { artistKey: owner.key, libraryArtist: owner.name }; }
  return { artistKey: artistKey(catalogueArtist), libraryArtist: null };
}

/**
 * Artist centroid groups over `entries` (each carrying `artistKey`, plus
 * `libraryArtist` when library-owned): one group per key — mean of the
 * group's vectors, re-normalized — with `analyzedCount`, the three most
 * frequent model tags as `topTags` (the "why similar" line), and `name`: the
 * library's current name when any row is library-owned, else the group's
 * most frequent catalogue spelling (ties → first seen, Map order = row
 * order). Rows without a key (untagged orphans) are not part of the artist
 * space.
 */
export function groupArtists(entries, dim) {
  const grouped = new Map();
  for (const e of entries) {
    const key = artistKeyOf(e);
    if (!key) { continue; }
    if (!grouped.has(key)) { grouped.set(key, []); }
    grouped.get(key).push(e);
  }
  const artists = new Map();
  for (const [key, list] of grouped) {
    const centroid = new Float32Array(dim);
    const tagCounts = new Map();
    const spellings = new Map();
    let libraryName = null;
    for (const e of list) {
      for (let i = 0; i < dim; i++) { centroid[i] += e.vec[i]; }
      for (const t of e.genreTags || []) { tagCounts.set(t, (tagCounts.get(t) || 0) + 1); }
      if (e.artist) { spellings.set(e.artist, (spellings.get(e.artist) || 0) + 1); }
      if (!libraryName && e.libraryArtist) { libraryName = e.libraryArtist; }
    }
    for (let i = 0; i < dim; i++) { centroid[i] /= list.length; }
    l2normalize(centroid);
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    let name = libraryName;
    if (!name) {
      let best = 0;
      for (const [spelling, n] of spellings) { if (n > best) { best = n; name = spelling; } }
    }
    artists.set(key, { name, vec: centroid, analyzedCount: list.length, topTags: topTags.length ? topTags : null });
  }
  return artists;
}

/**
 * The current similarity index, rebuilt when the dataset or the configured
 * model changed. Returns null when discovery has no store to read (feature
 * never enabled / DB missing).
 *
 * Shape: {
 *   modelId, modelVersion, dim,
 *   entries: [{ hash, artist, artistKey, libraryArtist, vec, genreTags }],
 *   byHash:  Map<hash, entry>,
 *   artists: Map<artistKey, { name, vec, analyzedCount, topTags }>,
 * }
 *
 * Artist identity is the library's. A catalogue row keeps the spelling its
 * track had when it was embedded — frozen until re-embedded — while the
 * library moves on: V71 merged spellings ("Beatles"/"beatles"), the 6.28
 * scanner re-splits credits ("Atb Feat. X" → Atb + featured X), files get
 * retagged. So a row whose track is still in the library takes that track's
 * primary artist as its identity (`artistKey` = the artist's name_key,
 * `libraryArtist` = its current name), joined by canonical hash at build
 * time; a row whose track is gone folds its catalogue spelling with nameKey
 * (so a deleted file's embedding still counts for its artist). ONE centroid
 * per artist, any spelling seeds it, and the index rebuilds when the library
 * changes under it (see libraryVersion), not only when the catalogue does.
 */
/// Cheapest possible "would a similarity query find anything?" — one indexed
/// existence check, no vector decode, no index build.
///
/// Deliberately NOT getIndex(): that rebuilds the in-memory index whenever the
/// cache is stale, and the only caller of this is the PUBLIC /api/ endpoint.
/// Letting an unauthenticated request force an index build would be a free
/// amplification vector on a large library.
///
/// Returns false when discovery is switched off, the DB has never been
/// created, or nothing has been embedded yet for the configured model — which
/// are the three ways a client asking "can I use sonic similarity" gets the
/// same practical answer: not right now.
export function hasEmbeddings() {
  if (config.program.scanOptions.collectDiscoveryData !== true) { return false; }
  try {
    const ddb = discoveryDb.openDiscoveryDbIfExists();
    if (!ddb) { return false; }
    const row = ddb.prepare(
      'SELECT 1 FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? LIMIT 1'
    ).get(config.program.scanOptions.discoveryModel);
    return row !== undefined;
  } catch (err) {
    // Never let a capability probe take down the endpoint that reports it.
    winston.warn(`[discovery] readiness check failed: ${err.message}`);
    return false;
  }
}

export function getIndex() {
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  if (!ddb) { return null; }

  const modelId = config.program.scanOptions.discoveryModel;
  const rowSeq = discoveryDb.getMeta('row_seq') || '0';
  const epoch = discoveryDb.getMeta('index_epoch');
  // Batch-grained key when a writer has ever published; per-write fallback
  // otherwise (pre-epoch DBs, tests writing directly).
  const seq = epoch !== null ? epoch : rowSeq;
  const libVersion = libraryVersion();
  if (cache && cache.seq === seq && cache.modelId === modelId) {
    // Epoch says fresh but rows moved underneath and nobody published — or
    // the LIBRARY changed under the artist identities (another connection
    // committed: a rescan that merged, renamed or re-homed artists) — serve
    // the cache until it ages out, then rebuild despite the epoch. Bounded
    // staleness and bounded churn, both ways.
    const unpublishedDrift = epoch !== null && cache.rowSeq !== rowSeq;
    const libraryDrift = libVersion !== null && cache.libVersion !== libVersion;
    if ((!unpublishedDrift && !libraryDrift) || Date.now() - cache.builtAt < STALE_REBUILD_MS) {
      return cache;
    }
  }

  const started = Date.now();
  const rows = ddb.prepare(`
    SELECT audio_hash, artist, title, embedding, genre_tags
      FROM discovery_tracks
     WHERE embedding IS NOT NULL AND model_id = ?
  `).all(modelId);

  const owners = loadLibraryOwners();
  let owned = 0;
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
    const owner = owners ? owners.get(r.audio_hash) : undefined;
    if (owner) { owned++; }
    const entry = {
      hash: r.audio_hash, artist: r.artist || null, title: r.title || null, vec, genreTags,
      ...artistIdentity(r.artist, owner),
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

  // Artist centroids — one per artist identity (see the Shape note).
  const artists = groupArtists(entries, dim || 0);

  const modelVersion = discoveryDb.getMeta('embedding_model_version') || null;
  cache = { seq, rowSeq, libVersion, builtAt: Date.now(), modelId, modelVersion, dim, entries, byHash, artists, matrix };
  winston.info(`discovery similarity index built: ${entries.length} tracks, ${artists.size} artists, ${dim}-d (${Date.now() - started} ms); ${owned} rows keyed by the library, ${entries.length - owned} by catalogue spelling`);
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
 * An entry's same-song key: normalized "artist|title", or null for rows
 * without a title (those dedupe by hash alone). The rule getIndex
 * precomputes into entry.nameKey and pathBetween memoizes; hand-built
 * indexes (tests, embedders) get it on first touch. Exported so a caller
 * can build rankTracksMulti's `excludeNameKeys` from its seed entries
 * without restating the rule.
 */
export function entryNameKey(e) {
  if (e.nameKey === undefined) {
    e.nameKey = e.title
      ? `${(e.artist || '').trim().toLowerCase()}|${e.title.trim().toLowerCase()}`
      : null;
  }
  return e.nameKey;
}

const asSet = (x) => (x == null ? null : x instanceof Set ? x : new Set(x));

/**
 * Entries ranked against SEVERAL seed vectors — the Discover page's library
 * source, seeded by the user's play history. Resolves to
 * [{ entry, similarity, seedIndex }], descending, at most `topK` long (the
 * caller's consideration budget, as for rankTracks).
 *
 *   mode 'max'       every entry scores against its BEST seed, and
 *                    `seedIndex` names that seed (ties → the earlier one) so
 *                    a row can say "because you finished X". An eclectic
 *                    history keeps each of its corners; a centroid would
 *                    average them into a sound no seed has.
 *   mode 'centroid'  one pass against centroidOf(seedVecs); seedIndex null.
 *
 * Cost. One scoresInto pass is ~24 ms at 25k × 1280-d on M-series, and 'max'
 * pays one per seed. It cannot share a single pass the way 'centroid' does:
 * a mean of dot products is the dot product with the mean vector (linear,
 * the trick pathBetween's waypoints use; the centroid's renormalization only
 * rescales it), so S seeds collapse into one query vector before the scan,
 * but a max of dot products has no such
 * collapse — every seed must meet every row. The one way to read the matrix
 * once, a fused loop carrying S accumulators per row, measured slower than
 * S plain passes (336 vs 259 ms for 12 seeds): each plain pass streams the
 * matrix against one cache-hot seed. So the caller caps the seed count, the
 * passes reuse one scratch buffer, and with `yieldBetween` (default true)
 * the event loop runs between passes instead of stalling for S × 24 ms.
 * The buffers are per call, never module-level: a yield lets another
 * request in, and a shared buffer would be overwritten under this one.
 *
 * Eligibility:
 *   - `exclude` (Set of hashes): the seeds themselves, dropped seeds.
 *   - `excludeNameKeys` (Set of entryNameKey values): every other file of a
 *     seed SONG. Play counts key by hash, so an alternate master or a
 *     re-encode of a song the user just finished reads as "never played".
 *   - `nearDup` (default NEAR_DUP, 0.99, the novelty filter's guard): an
 *     entry this close to a seed is the same recording, an untagged
 *     re-encode the name key cannot catch. 'max' judges it against the
 *     entry's own best seed; 'centroid' has no per-seed scores, so it checks
 *     every seed lazily, only for the rows the ranked walk reaches (S dots
 *     per row: ~20 ms on top of the pass for 6 seeds × a 2000-row walk).
 *   - `dedupe` (default true): one file per nameKey, the best-scoring. It
 *     runs before the caller's visibility walk, so a caller that hides some
 *     files from some users should pass false and dedupe its ACCEPTED rows
 *     instead (first per key wins, the walk being descending): otherwise a
 *     best file the user cannot see hides the alternate they can.
 */
export async function rankTracksMulti(index, seedVecs, {
  exclude = null,
  excludeNameKeys = null,
  nearDup = NEAR_DUP,
  topK = Infinity,
  mode = 'max',
  yieldBetween = true,
  dedupe = true,
} = {}) {
  if (mode !== 'max' && mode !== 'centroid') {
    throw new TypeError(`rankTracksMulti: unknown mode '${mode}'`);
  }
  const entries = index.entries;
  const n = entries.length;
  const k = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : n;
  if (!Array.isArray(seedVecs) || seedVecs.length === 0 || n === 0 || k === 0) { return []; }
  // `null` must not slip through as `>= 0` and drop every positive match;
  // Infinity is the explicit way to switch the guard off.
  const dupAt = typeof nearDup === 'number' && !Number.isNaN(nearDup) ? nearDup : NEAR_DUP;

  let scores;            // what the ranking sorts by
  let bestSeed = null;   // 'max': the seed that produced scores[i]
  if (mode === 'centroid') {
    scores = scoresInto(new Float64Array(n), index, centroidOf(seedVecs));
  } else {
    // Pass 0 writes straight into the max buffer; passes 1..S-1 share one
    // scratch buffer and merge.
    scores = scoresInto(new Float64Array(n), index, seedVecs[0]);
    bestSeed = new Int32Array(n);   // zero-filled = seed 0
    const pass = seedVecs.length > 1 ? new Float64Array(n) : null;
    for (let s = 1; s < seedVecs.length; s++) {
      if (yieldBetween) { await new Promise((r) => setImmediate(r)); }
      scoresInto(pass, index, seedVecs[s]);
      for (let i = 0; i < n; i++) {
        if (pass[i] > scores[i]) { scores[i] = pass[i]; bestSeed[i] = s; }
      }
    }
  }

  // Per-entry state: 0 = ineligible, 1 = eligible, 2 = eligible and cleared
  // by the lazy near-dup check. The cheap filters run once here, not per
  // selectTopKDesc probe (a Set lookup × 25k, twice on escalation).
  const excludeHashes = asSet(exclude);
  const excludeKeys = asSet(excludeNameKeys);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    if (excludeHashes?.size && excludeHashes.has(e.hash)) { continue; }
    if (excludeKeys?.size) {
      const key = entryNameKey(e);
      if (key && excludeKeys.has(key)) { continue; }
    }
    // 'max': scores[i] IS the similarity to the entry's own best seed.
    if (bestSeed && scores[i] >= dupAt) { continue; }
    ok[i] = 1;
  }

  // 'centroid': S dots per row, so only for rows the walk reaches.
  const nearDupOfASeed = bestSeed ? null : (i) => {
    const v = entries[i].vec;
    for (const seed of seedVecs) { if (dot(seed, v) >= dupAt) { return true; } }
    return false;
  };

  // The order-dependent filters run on the ranked walk, best first: the
  // first file seen per nameKey is that song's best.
  const walk = (order) => {
    const out = [];
    const seenKeys = dedupe ? new Set() : null;
    for (const i of order) {
      if (out.length >= k) { break; }
      if (ok[i] === 0) { continue; }
      if (nearDupOfASeed && ok[i] === 1) {
        if (nearDupOfASeed(i)) { ok[i] = 0; continue; }
        ok[i] = 2;
      }
      const e = entries[i];
      if (seenKeys) {
        const key = entryNameKey(e);
        if (key) {
          if (seenKeys.has(key)) { continue; }
          seenKeys.add(key);
        }
      }
      out.push({ entry: e, similarity: scores[i], seedIndex: bestSeed ? bestSeed[i] : null });
    }
    return out;
  };

  // Over-select so the walk's rejections rarely leave the list short; when
  // they do and more candidates exist, escalate once to the full ordering
  // (pathBetween's pattern): still correct, just slower, on pathological
  // data such as a song with hundreds of files.
  const eligible = (i) => ok[i] !== 0;
  const want = Math.min(n, k + Math.max(64, k >> 2));
  const head = selectTopKDesc(scores, n, want, eligible);
  let out = walk(head);
  if (out.length < k && want < n && head.length === want) {
    out = walk(selectTopKDesc(scores, n, n, eligible));
  }
  return out;
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
 * The centroid group for an artist named in ANY spelling, or undefined when
 * nothing of theirs is embedded.
 */
export function artistCentroid(index, artistName) {
  const key = artistKey(artistName);
  return key ? index.artists.get(key) : undefined;
}

/**
 * All artists ranked by centroid similarity to `seedArtist`'s centroid; the
 * seed is a name in any spelling. Each result carries the group's `artistKey`
 * (to look the artist up in the library) and its most frequent catalogue
 * spelling as `artist`. Null when the seed has no centroid.
 */
export function rankArtists(index, seedArtist) {
  const seedKey = artistKey(seedArtist);
  const seed = seedKey ? index.artists.get(seedKey) : undefined;
  if (!seed) { return null; }
  const out = [];
  for (const [key, a] of index.artists) {
    if (key === seedKey) { continue; }
    out.push({ artist: a.name, artistKey: key, analyzedCount: a.analyzedCount, topTags: a.topTags, similarity: dot(seed.vec, a.vec) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

/**
 * An artist's own tracks ranked by similarity to `seedVec` — the "entry
 * points" into a similar artist: where to start listening, in the context
 * of the sound the user came from. `artistName` is any spelling; every row
 * that folds to the same key counts as theirs.
 */
export function rankArtistTracks(index, artistName, seedVec) {
  const key = artistKey(artistName);
  const out = [];
  if (!key) { return out; }
  for (const e of index.entries) {
    if (artistKeyOf(e) !== key) { continue; }
    out.push({ entry: e, similarity: dot(seedVec, e.vec) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}
