// Discovery-over-federation, caller side: find music you DON'T have on the
// servers you PAIRED with, that sounds like music you DO have — and unlike
// the public p2p network's metadata-only leads, every result lives inside a
// library the peer granted us, so it is streamable over the same bridge.
//
// Namespace contract (by data source, like the rest of the discovery API):
//   /api/v1/discovery/local/*        your own library (in-memory index)
//   /api/v1/discovery/p2p/*          fetched public-network snapshots
//   /api/v1/discovery/federation/*   live queries to federated peers (this)
//
// Flow per request: resolve the query vector, fan it out to every peer with
// use_discovery on (POST /api/v1/federation/discovery/similar via fedFetch,
// bounded by a per-peer deadline), then merge: caller-side novelty chain
// (db/discovery-novelty.js), cross-peer dedupe, sort, cap. The fan-out
// (fanOutFederation) is shared by the per-song route below, whose query is
// one local track's embedding, and the history-seeded Discover page
// (api/discovery-taste.js), whose query is a centroid of the page's seeds.
//
// Privacy note, stated where the code sends it: the query VECTOR leaves the
// machine, to peers the admin explicitly paired with — that is the deal the
// per-peer use_discovery toggle governs. It is one track's embedding from
// the per-song route, or, from the Discover page, a centroid of a random
// batch of up to 12 songs the user finished in the chosen window (all time
// with window 0) plus any songs they pinned: one
// averaged vector, never the songs' names, paths or hashes, but still
// derived from what this user listens to.
// The public-network contract ("queries never leave the machine",
// api/discovery-p2p.js) is unchanged.

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as fedDb from '../db/federation.js';
import { localIdentitySets, isNovel, norm } from '../db/discovery-novelty.js';
import { resolveSeedTrack } from './discovery.js';
import { joiValidate } from '../util/validation.js';
import { toIso } from '../stats/time.js';
import WebError from '../util/web-error.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
// Ask each peer for more than we'll show: the novelty chain and cross-peer
// dedupe run AFTER the peers answer, so headroom keeps a heavily-filtered
// answer from coming up short. Capped at the peer endpoint's own MAX_LIMIT.
const HEADROOM = 3;
const PEER_LIMIT_CAP = 100;
// A slow peer must not hold the Discover panel hostage; unreachable peers
// surface in `searched.unreachable`, not as an error.
const PEER_TIMEOUT_MS = 4000;
// How often a peer's answer may refresh its federation_peers status row.
// The Discover page fans out on every open; the admin UI's "last seen" only
// needs minute-grained truth, not a write per query per peer.
const STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;

let fedClientModule = null;   // state/federation-client.js, once a fan-out loaded it

// AbortSignal.timeout on the fetch only bounds the HTTP request THROUGH an
// established bridge — a dead peer stalls in the iroh DIAL that rebuilds
// the bridge first, which the signal never covers (measured ~29s against a
// stopped peer in the 2026-07-11 WAN smoke). Race the whole fedFetch call
// against a deadline instead; a dial that eventually succeeds in the
// background still warms the bridge for the next query.
export async function fedFetchWithDeadline(fedClient, peer, apiPath, opts, ms) {
  let timer;
  try {
    return await Promise.race([
      fedClient.fedFetch(peer, apiPath, opts),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms (dial included)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The wire form of the query: base64 of dim × float32 little-endian, which
// is exactly a discovery_tracks BLOB's bytes and exactly a Float32Array's
// (index entry.vec — a subarray view, hence byteOffset — or a centroid).
function vectorBase64(vec) {
  const v = Array.isArray(vec) ? Float32Array.from(vec) : vec;
  if (!(v instanceof Float32Array || v instanceof Uint8Array) || v.byteLength === 0) {
    throw new TypeError('query vector must be a Float32Array, an embedding BLOB or an array of numbers');
  }
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

/**
 * A throttled "this peer answered" writer: stamps federation_peers
 * last_status 'ok' + last_seen (updateFederationPeerStatus) at most once per
 * peer per `intervalMs`. Failures are never written — a 4 s deadline missed
 * by a peer still dialing is not proof the peer is down, and last_status is
 * what the admin UI shows as the peer's health; only the admin's own
 * test-connection (federation-client testPeer) records a failure.
 * Usable as fanOutFederation's `onPeerStatus`. Returns whether it wrote.
 */
export function createPeerStatusRecorder(write, { intervalMs = STATUS_WRITE_INTERVAL_MS } = {}) {
  const lastWrite = new Map();   // peer id → ms of the last write
  return function recordPeerStatus(peer, { reachable } = {}, now = Date.now()) {
    if (!reachable) { return false; }
    const last = lastWrite.get(peer.id);
    if (last !== undefined && now - last < intervalMs) { return false; }
    write(peer.id);
    lastWrite.set(peer.id, now);   // after the write: a failed write retries next answer
    return true;
  };
}

export const recordPeerStatus = createPeerStatusRecorder(
  (id) => fedDb.updateFederationPeerStatus(id, 'ok'));

/**
 * Pure merge of the peers' answers — no I/O, so it is unit-tested with
 * handcrafted answers. `answers[i]` is peers[i]'s Promise.allSettled outcome,
 * fulfilled with { body, at } (the peer's JSON and when it arrived).
 *
 * Every peer gets an entry, in `peers` order, whatever happened to it.
 * Novel rows from every answering peer are ranked together (similarity desc;
 * ties keep peer order, then the peer's own order), and the cross-peer
 * dedupe walks that ranking: two peers holding the same song surface it
 * once, under the peer where it ranks highest. Each peer's list holds at
 * most `limit` rows; a row that finds its peer's list full does not claim
 * its song, so another peer that holds it can still show it.
 *
 * `results` is that walk as one list. Its first `limit` rows are exactly the
 * per-song route's answer: no peer's list can fill before `limit` rows were
 * accepted in total, so up to there the walk is the old single-cap walk.
 */
export function mergePeerAnswers(peers, answers, { excludeSets, newArtistsOnly = false, limit = DEFAULT_LIMIT }) {
  const searched = { peers: 0, unreachable: 0, mismatched: 0 };
  const groups = [];
  const merged = [];   // { group, row }
  for (const [i, peer] of peers.entries()) {
    const outcome = answers[i];
    const group = {
      id: peer.id,
      name: peer.name,
      // When this call heard from it, else the stored last_seen (stale: only
      // the admin's tests and recordPeerStatus write it).
      lastSeen: toIso(peer.last_seen),
      reachable: false,
      mismatched: false,
      results: [],
    };
    groups.push(group);
    if (!outcome || outcome.status !== 'fulfilled') { searched.unreachable += 1; continue; }
    group.reachable = true;
    if (Number.isFinite(outcome.value?.at)) { group.lastSeen = new Date(outcome.value.at).toISOString(); }
    // A peer is untrusted: a body that isn't the documented object answers
    // nothing rather than throwing the whole fan-out away.
    const body = outcome.value?.body || {};
    if (body.modelMismatch) { group.mismatched = true; searched.mismatched += 1; continue; }
    searched.peers += 1;
    for (const r of Array.isArray(body.results) ? body.results : []) {
      if (!r || typeof r !== 'object') { continue; }
      if (!isNovel(excludeSets, {
        artist: r.artist,
        title: r.title,
        recordingMbid: r.recordingMbid,
        similarityVsSeed: r.similarity,
      }, { newArtistsOnly })) { continue; }
      merged.push({
        group,
        row: {
          artist: r.artist,
          title: r.title,
          // Catalogue fields — absent (null) from peers older than the
          // discovery.db V3 responder; every field here is optional.
          album: r.album ?? null,
          year: r.year ?? null,
          isrc: r.isrc ?? null,
          releaseGroupMbid: r.releaseGroupMbid ?? null,
          duration: r.duration,
          similarity: r.similarity,
          genreTags: r.genreTags,
          recordingMbid: r.recordingMbid,
          // filepath is the PEER's vpath-form path — what the federation
          // stream proxy plays, and provenance the panel can show.
          filepath: r.filepath,
          peer: { id: peer.id, name: peer.name },
        },
      });
    }
  }

  // Cross-peer dedupe: two peers holding the same song should surface it
  // once (highest similarity wins — walk in sorted order). Keyed by MBID
  // when present AND normalized artist+title, so a tagged copy on one
  // peer dedupes an untagged copy on another whenever the names agree.
  merged.sort((a, b) => b.row.similarity - a.row.similarity);
  const seen = new Set();
  const results = [];
  for (const { group, row } of merged) {
    if (group.results.length >= limit) { continue; }
    const keys = [`a:${norm(row.artist)} ${norm(row.title)}`];
    if (row.recordingMbid) { keys.push(`m:${row.recordingMbid}`); }
    if (keys.some((k) => seen.has(k))) { continue; }
    for (const k of keys) { seen.add(k); }
    group.results.push(row);
    results.push(row);
  }
  return { peers: groups, searched, results };
}

// The federation client, loaded once. Exported so the Discover page can
// load it BEFORE it starts a fan-out: on the first call in a process the
// import is real I/O, and a fan-out that awaited it inside would only dial
// after the page's synchronous library pass.
export async function loadFederationClient() {
  if (!fedClientModule) { fedClientModule = await import('../state/federation-client.js'); }
  return fedClientModule;
}

/**
 * Ask the paired servers (federation_peers with use_discovery on) for songs
 * like `vec`, keeping each peer's outcome.
 *
 *   vec             unit vector — Float32Array (index entry.vec, a centroid)
 *                   or a discovery_tracks embedding BLOB; sent as-is
 *   modelId         the vector's model space (a peer in another answers
 *                   modelMismatch)
 *   peerId          ask that one peer only; 404 when it is unknown or has
 *                   use_discovery off
 *   limit           rows per peer (and the per-song route's total cap)
 *   newArtistsOnly  also drop artists the local library already has
 *   headroom        each peer is asked for limit × headroom rows (default 3,
 *                   capped at the peer route's 100) — the novelty chain and
 *                   dedupe run after it answers
 *   onPeerStatus    optional (peer row, { reachable, mismatched }) callback,
 *                   once per peer after the fan-out settles; pass
 *                   recordPeerStatus to refresh last_seen (throttled)
 *
 * Resolves to { peers: [{ id, name, lastSeen, reachable, mismatched,
 * results }], searched: { peers, unreachable, mismatched }, results } — see
 * mergePeerAnswers. Each peer costs at most PEER_TIMEOUT_MS, dial included;
 * an unreachable peer is an outcome, never an error.
 */
export async function fanOutFederation(vec, modelId, {
  peerId, limit = DEFAULT_LIMIT, newArtistsOnly = false, headroom = HEADROOM, onPeerStatus,
} = {}) {
  let peers = fedDb.getFederationPeers().filter((p) => p.use_discovery === 1);
  if (peerId !== undefined) {
    peers = peers.filter((p) => p.id === peerId);
    if (peers.length === 0) { throw new WebError('Peer not found or not searchable', 404); }
  }
  if (peers.length === 0) {
    return { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 }, results: [] };
  }

  const payload = JSON.stringify({
    embedding: vectorBase64(vec),
    modelId,
    // An integer within the peer route's Joi bounds, or the peer 400s.
    limit: Math.max(1, Math.min(PEER_LIMIT_CAP, Math.ceil(limit * headroom))),
  });

  // Loaded lazily like the admin routes do — federation-client pulls in
  // the iroh machinery, which stays cold until a peer is actually dialed.
  // Kept once loaded: an `await import()` defers even a cached module to a
  // later job, and the Discover page starts this fan-out BEFORE its
  // synchronous library pass precisely so the peer requests are already
  // on their way (it awaits them last).
  const fedClient = fedClientModule || await loadFederationClient();
  const answers = await Promise.allSettled(peers.map(async (peer) => {
    const r = await fedFetchWithDeadline(fedClient, peer, '/api/v1/federation/discovery/similar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      // Still useful: bounds the response-body read once headers arrive.
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    }, PEER_TIMEOUT_MS);
    if (!r.ok) { throw new Error(`http ${r.status}`); }
    const body = await r.json();
    return { body, at: Date.now() };
  }));

  for (const [i, outcome] of answers.entries()) {
    if (outcome.status === 'rejected') {
      const peer = peers[i];
      winston.warn(`discovery federation similar: peer '${peer.name}' (id=${peer.id}) failed: ${outcome.reason?.message}`);
    }
  }

  const out = mergePeerAnswers(peers, answers, {
    excludeSets: localIdentitySets(), newArtistsOnly, limit,
  });

  if (typeof onPeerStatus === 'function') {
    for (const [i, peer] of peers.entries()) {
      const { reachable, mismatched } = out.peers[i];
      // Bookkeeping must never cost the user their results.
      try { onPeerStatus(peer, { reachable, mismatched }); } catch (err) {
        winston.warn(`discovery federation: status update for peer id=${peer.id} failed: ${err.message}`);
      }
    }
  }
  return out;
}

export function setup(mstream) {
  // Similar-but-not-owned tracks across the federated peers.
  //   filePath        the local seed track ("<vpath>/<relpath>")
  //   limit           max results (default 10, cap 50)
  //   newArtistsOnly  also drop artists the local library already has
  //   peerId          ask ONE paired server only (the recommendation
  //                   modal's "more like this on <peer>"); 404 when that
  //                   peer is unknown or has opted out of discovery
  mstream.post('/api/v1/discovery/federation/similar', async (req, res) => {
    if (config.program.federation.enabled !== true) {
      throw new WebError('federation is disabled (config: federation.enabled)', 403);
    }
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      newArtistsOnly: Joi.boolean().default(false),
      peerId: Joi.number().integer().min(1).optional(),
    });
    const { value: { filePath, limit, newArtistsOnly, peerId } } = joiValidate(schema, req.body);

    // Same resolution + uniform-404 + probe logging as the local/p2p routes.
    const seedRow = resolveSeedTrack(req, filePath, 'discovery/federation/similar');
    const canonHash = seedRow.audio_hash || seedRow.file_hash;

    if (!discoveryDb.openDiscoveryDbIfExists()) {
      throw new WebError('discovery data collection has never been enabled — no embeddings to search with', 404);
    }
    const seed = discoveryDb.getDiscoveryDb().prepare(`
      SELECT embedding, model_id FROM discovery_tracks WHERE audio_hash = ?
    `).get(canonHash);
    if (!seed || !seed.embedding) {
      throw new WebError('track has no embedding yet — the analysis pass has not processed it', 404);
    }

    const query = { filePath, modelId: seed.model_id, newArtistsOnly };
    if (peerId !== undefined) { query.peerId = peerId; }
    // No status write here: this route answers on every song change, and
    // the throttled refresh is the Discover page's (recordPeerStatus).
    const { searched, results } = await fanOutFederation(seed.embedding, seed.model_id, {
      peerId, limit, newArtistsOnly,
    });
    // One ranked list across peers, capped at `limit` in total.
    res.json({ query, searched, results: results.slice(0, limit) });
  });
}
