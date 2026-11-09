// The P2P side of the discovery API: find music you DON'T have, on servers
// in the discovery network, that sounds like music you DO have.
//
// Namespace contract (deliberate split, mirrored by the admin surface):
//   /api/v1/discovery/local/*   similarity within YOUR library
//                               (src/api/discovery.js — in-memory index)
//   /api/v1/discovery/p2p/*     similarity across FETCHED PEER snapshots
//                               (this file — the auto-fetch shelf)
//
// Everything here queries LOCAL copies of peer snapshots (fetched by
// discovery-peer-dbs.js) — no query ever leaves this machine, so what a
// user searches for is private; peers only ever observe snapshot fetches.
// Responses are metadata-only (artist/title/similarity/which-peer): the
// network shares knowledge about music, never the music itself.
//
// Similarity = cosine over the per-track embeddings. The vectors are
// L2-normalized at write time (declared in the snapshot meta), so cosine is
// a plain dot product. Vectors only compare within ONE model space — the
// search filters peer rows to the query track's model_id, so a network mid
// model-migration degrades to fewer results, never to garbage rankings.
//
// The novelty filter (the point of the feature) lives in
// src/db/discovery-novelty.js — shared with the discovery-over-federation
// aggregator (api/discovery-federation.js), which runs the exact same
// caller-side chain over live peer answers instead of fetched snapshots.

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as discoveryP2p from '../state/discovery-p2p.js';
import * as discoveryCatalog from '../state/discovery-catalog.js';
import * as peerDbs from '../state/discovery-peer-dbs.js';
import { buildPeerView } from '../state/discovery-peer-view.js';
import { peerAdder } from '../state/discovery-peer-add.js';
import { localIdentitySets, isNovel } from '../db/discovery-novelty.js';
import { resolveSeedTrack } from './discovery.js';
import { refuseJukebox } from './discovery-plugin-jobs.js';
import { joiValidate } from '../util/validation.js';
import { requireAccount } from '../util/require-account.js';
import { isAdminAllowed } from '../util/admin-network.js';
import WebError from '../util/web-error.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function requireP2p() {
  if (!config.program.discoveryP2p.enabled) {
    throw new WebError('discovery P2P is disabled (config: discoveryP2p.enabled)', 403);
  }
}

// ── The shelf search ─────────────────────────────────────────────────────────
// Shared by the per-song route below and the history-seeded Discover page
// (api/discovery-taste.js), which asks with a centroid of several recent
// songs instead of one track's embedding — the walk cannot tell the two
// apart, so both get the same novelty chain and the same limits.

// The query as a Float32Array whatever the caller holds: the similarity
// index's entry.vec (already one — used as-is, a subarray view is fine), a
// discovery_tracks BLOB (a Buffer under Bun, a Uint8Array under node:sqlite;
// copied, because a BLOB's byteOffset need not be 4-aligned), or a plain
// array of numbers. Callers pass a UNIT vector: cosine == dot product only
// holds for L2-normalized vectors, and the near-dup cut (NEAR_DUP) reads
// the dot as a cosine. Not re-normalized here — the per-song route has
// always searched with the stored vector verbatim.
export function toQueryVector(vec) {
  if (vec instanceof Float32Array) { return vec; }
  if (vec instanceof Uint8Array) {
    if (vec.byteLength === 0 || vec.byteLength % 4 !== 0) {
      throw new TypeError(`embedding BLOB must hold whole float32 values, got ${vec.byteLength} bytes`);
    }
    return new Float32Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
  }
  if (Array.isArray(vec)) { return Float32Array.from(vec); }
  throw new TypeError('query vector must be a Float32Array, an embedding BLOB or an array of numbers');
}

// The best `cap` NOVEL rows seen so far, best first, in exactly the order a
// stable sort of every novel row by similarity would give them: ties keep
// walk order (shelf order, then row order), so an equal score ranks after
// every row already held. Bounding the window lets the walk skip the
// novelty chain for every row that can no longer make the cut — that chain
// (two NFKD + regex normalizations per row) measured ~200 ms over 150k peer
// rows, more than the 1280-d dot products themselves (~150 ms), and the old
// collect-everything-then-sort shape paid it on every row. A row only
// enters after it passes the chain, so the window equals the head of the
// old sorted list, never a superset that a later filter would thin out.
function novelWindow(cap) {
  const rows = [];   // { space, i, dot }
  return {
    rows,
    admits: (dot) => rows.length < cap || dot > rows[rows.length - 1].dot,
    add(space, i, dot) {
      let at = rows.length;
      while (at > 0 && rows[at - 1].dot < dot) { at--; }
      rows.splice(at, 0, { space, i, dot });
      if (rows.length > cap) { rows.pop(); }
    },
  };
}

function dotAt(q, matrix, off) {
  let dot = 0;
  for (let k = 0; k < q.length; k++) { dot += q[k] * matrix[off + k]; }
  return dot;
}

// One pass over one peer matrix into the window.
function scanSpace(top, space, q, sets, newArtistsOnly) {
  const dim = q.length;
  for (let i = 0; i < space.count; i++) {
    // L2-normalized vectors: cosine == dot product.
    const dot = dotAt(q, space.matrix, i * dim);
    // A snapshot is untrusted bytes: a NaN float makes a NaN score that
    // compares false both ways and would wedge the window's cut. (An
    // Infinity is already a "near-dup" to the chain below.)
    if (Number.isNaN(dot)) { continue; }
    if (!top.admits(dot)) { continue; }
    if (!isNovel(sets, {
      artist: space.artists[i],
      title: space.titles[i],
      recordingMbid: space.mbids[i],
      similarityVsSeed: dot,
    }, { newArtistsOnly })) { continue; }
    top.add(space, i, dot);
  }
}

// Which of `seeds` (unit vectors) a peer row sits closest to — how the
// Discover page says "because you finished X" about a centroid's result.
// Only the few rows that made the cut pay for it.
function nearestSeed(seeds, matrix, off, dim) {
  let best = -1;
  let bestDot = -Infinity;
  for (const [s, v] of seeds.entries()) {
    if (v.length !== dim) { continue; }   // another model space: never "closest"
    const dot = dotAt(v, matrix, off);
    if (dot > bestDot) { best = s; bestDot = dot; }
  }
  return best === -1 ? null : best;
}

/**
 * Search handcrafted or shelf peer spaces (the readEmbeddings() shape) for
 * rows that sound like `queryVec` and are new to this library. The walk
 * behind searchPeers, exported so tests can feed spaces without a shelf.
 * `spaces` is any iterable; null entries and other-dim spaces are skipped
 * (not counted as searched). Yields to the event loop between spaces: each
 * pass is ~25 ms of dot products per 25k rows at 1280-d, plus the matrix
 * read when the cache is cold, and a full shelf runs several back to back.
 */
export async function searchSpaces(spaces, queryVec, {
  excludeSets, newArtistsOnly = false, limit = DEFAULT_LIMIT, headroom = 1, seedVecs = null,
} = {}) {
  const q = toQueryVector(queryVec);
  const dim = q.length;
  const sets = excludeSets || localIdentitySets();
  const want = Math.ceil(limit * headroom);
  const top = novelWindow(want >= 1 ? want : 1);
  const seeds = Array.isArray(seedVecs) && seedVecs.length > 0 ? seedVecs.map(toQueryVector) : null;
  const searched = { peers: 0, tracks: 0 };

  for (const space of spaces) {
    if (!space || space.dim !== dim) { continue; }   // no rows in this model space
    searched.peers += 1;
    searched.tracks += space.count;
    scanSpace(top, space, q, sets, newArtistsOnly);
    // After the pass, not before the next: pulling the next space is what
    // reads its matrix (shelfSpaces), so this puts the read in a new tick.
    await new Promise(setImmediate);
  }

  const results = top.rows.map(({ space, i, dot }) => {
    const row = {
      artist: space.artists[i],
      title: space.titles[i],
      // Catalogue fields (discovery.db V3) — null from peers whose
      // snapshot predates them or whose file carries no such tag.
      album: space.albums[i],
      year: space.years[i],
      isrc: space.isrcs[i],
      releaseGroupMbid: space.releaseGroupMbids[i],
      duration: space.durations[i],
      similarity: dot,
      recordingMbid: space.mbids[i],
      exportId: space.ids[i],
      peer: { endpointId: space.endpointId, name: space.peerName },
    };
    if (seeds) { row.seedIndex = nearestSeed(seeds, space.matrix, i * dim, dim); }
    return row;
  });
  return { results, searched };
}

// The held shelf in one model space, read lazily — one peer matrix per pull,
// so searchSpaces' yields also separate the cold-cache SQLite reads. A
// blocked peer is never walked (the block route drops its snapshot; this
// covers a block that lands mid-walk), `only` (a Set of endpoint ids, or
// null for the whole shelf) narrows the walk to some peers, and
// `stats.held` counts the peers walked, whatever their model space.
function* shelfSpaces(modelId, only, stats) {
  for (const peer of peerDbs.list()) {
    if (peerDbs.isBlocked(peer.endpointId)) { continue; }
    if (only && !only.has(peer.endpointId)) { continue; }
    stats.held += 1;
    try {
      yield peerDbs.readEmbeddings(peer.endpointId, modelId);
    } catch (err) {
      winston.warn(`discovery p2p similar: peer DB ${peer.endpointId.slice(0, 12)}… unreadable: ${err.message}`);
    }
  }
}

/**
 * Similar-but-not-owned rows across the fetched peer shelf: one pass per held
 * peer matrix in `modelId`'s space, the caller-side novelty chain
 * (db/discovery-novelty.js), ranked by cosine.
 *
 *   queryVec        unit vector — Float32Array (index entry.vec, a centroid)
 *                   or a discovery_tracks embedding BLOB
 *   excludeSets     localIdentitySets(), read here when omitted
 *   newArtistsOnly  also drop artists the local library already has
 *   limit           rows wanted
 *   headroom        return up to ceil(limit × headroom) rows (default 1), for
 *                   a caller that filters again afterwards (the Discover
 *                   page's cross-peer recommendation-key dedupe)
 *   seedVecs        optional unit vectors; when given, every row also
 *                   carries `seedIndex` (the closest one, null if none share
 *                   the dim) — never set by the per-song route, whose rows
 *                   keep their exact shape
 *   peers           optional endpoint ids: walk only these shelf peers (the
 *                   Peer Recommendations page's peer tab); ids not on the
 *                   shelf match nothing
 *
 * Resolves to { results, searched: { peers, tracks }, held } — results in
 * the p2p similar route's row shape, best first; `held` = the shelf peers
 * the walk could take (unblocked, inside `peers`), before the model filter
 * that `searched.peers` applies, so a caller can tell an empty shelf from
 * an incompatible one. (A plain function returning a promise: it never
 * throws synchronously, a bad query vector rejects.)
 */
export async function searchPeers(queryVec, modelId, { peers = null, ...opts } = {}) {
  const stats = { held: 0 };
  const found = await searchSpaces(shelfSpaces(modelId, peers ? new Set(peers) : null, stats), queryVec, opts);
  return { ...found, held: stats.held };
}

export function setup(mstream) {
  // Similar-but-not-owned tracks across the fetched peer shelf.
  //   filePath        the local seed track ("<vpath>/<relpath>")
  //   limit           max results (default 25, cap 100)
  //   newArtistsOnly  also drop artists the local library already has
  mstream.post('/api/v1/discovery/p2p/similar', async (req, res) => {
    requireP2p();
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      newArtistsOnly: Joi.boolean().default(false),
    });
    const { value: { filePath, limit, newArtistsOnly } } = joiValidate(schema, req.body);

    // Same resolution + uniform-404 + probe logging as the local routes.
    const seedRow = resolveSeedTrack(req, filePath, 'discovery/p2p/similar');
    const canonHash = seedRow.audio_hash || seedRow.file_hash;

    if (!discoveryDb.openDiscoveryDbIfExists()) {
      throw new WebError('discovery data collection has never been enabled — no embeddings to search with', 404);
    }
    const seed = discoveryDb.getDiscoveryDb().prepare(`
      SELECT embedding, model_id, artist, title FROM discovery_tracks WHERE audio_hash = ?
    `).get(canonHash);
    if (!seed || !seed.embedding) {
      throw new WebError('track has no embedding yet — the analysis pass has not processed it', 404);
    }

    const { results, searched } = await searchPeers(seed.embedding, seed.model_id, {
      excludeSets: localIdentitySets(), newArtistsOnly, limit,
    });
    res.json({
      query: { filePath, modelId: seed.model_id, newArtistsOnly },
      searched,
      results,
    });
  });

  // The fetched shelf — what the p2p similar route is currently searching
  // over. Read-only and metadata-only, so it sits with the user-facing
  // routes (the player UI needs it to explain result provenance).
  mstream.get('/api/v1/discovery/p2p/peer-dbs', (req, res) => {
    requireP2p();
    res.json({
      peerDbs: peerDbs.list().map((e) => ({
        endpointId: e.endpointId,
        name: e.name,
        rowCount: e.rowCount,
        modelId: e.modelId,
        sizeBytes: e.sizeBytes,
        fetchedAt: e.fetchedAt,
        // Shelf-membership provenance: how long this snapshot has been the
        // library we search (rotation's aging clock) and whether it's
        // rotation-immune.
        firstFetchedAt: e.firstFetchedAt,
        pinned: e.pinned === true,
      })),
    });
  });

  // The Peer Recommendations page's peer strip: the shelf peers its leads
  // come from, for every account, and — for a caller who may use the admin
  // API — the catalog peers an Add could bring in, each with its Add state
  // (src/state/discovery-peer-view.js buildPeerView has the row rules).
  // Blocked and incompatible-model peers are nobody's to see. In memory
  // only, so no requireIndex: it answers during a scan. no-store, because
  // clients poll it (every 15 s, every 3 s while an Add runs).
  mstream.use('/api/v1/discovery/p2p/peers', refuseJukebox);
  mstream.get('/api/v1/discovery/p2p/peers', (req, res) => {
    requireP2p();
    requireAccount(req);
    // The admin guard's three gates (api/admin.js), so a "+" is offered only
    // to a caller whose Add would not be refused.
    const canAdd = req.user.admin === true && config.program.lockAdmin !== true && isAdminAllowed(req);
    const view = buildPeerView({
      shelf: peerDbs.list(),
      catalog: discoveryCatalog.list(),
      localModel: discoveryDb.openDiscoveryDbIfExists() ? discoveryDb.getMeta('embedding_model_id') : null,
      now: Date.now(),
      onlineWindowMs: peerDbs.onlineWindowMs(),
      isBlocked: peerDbs.isBlocked,
      seederCountOf: (hash) => discoveryCatalog.seederCount(hash),
      addStateOf: (endpointId) => peerAdder.stateOf(endpointId),
      canAdd,
      running: discoveryP2p.isRunning(),
    });
    res.set('Cache-Control', 'no-store').json(view);
  });
}
