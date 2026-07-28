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
// Flow per request: resolve the local seed track, pull ITS embedding from
// discovery.db, fan the raw vector out to every peer with use_discovery on
// (POST /api/v1/federation/discovery/similar via fedFetch, bounded by a
// per-peer timeout), then merge: caller-side novelty chain
// (db/discovery-novelty.js), cross-peer dedupe, sort, cap.
//
// Privacy note, stated where the code sends it: the seed VECTOR leaves the
// machine, to peers the admin explicitly paired with — that is the deal the
// per-peer use_discovery toggle governs. The public-network contract
// ("queries never leave the machine", api/discovery-p2p.js) is unchanged.

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as fedDb from '../db/federation.js';
import { localIdentitySets, isNovel, norm } from '../db/discovery-novelty.js';
import { resolveSeedTrack } from './discovery.js';
import { joiValidate } from '../util/validation.js';
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

export function setup(mstream) {
  // Similar-but-not-owned tracks across the federated peers.
  //   filePath        the local seed track ("<vpath>/<relpath>")
  //   limit           max results (default 10, cap 50)
  //   newArtistsOnly  also drop artists the local library already has
  mstream.post('/api/v1/discovery/federation/similar', async (req, res) => {
    if (config.program.federation.enabled !== true) {
      throw new WebError('federation is disabled (config: federation.enabled)', 403);
    }
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      newArtistsOnly: Joi.boolean().default(false),
    });
    const { value: { filePath, limit, newArtistsOnly } } = joiValidate(schema, req.body);

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
    const peers = fedDb.getFederationPeers().filter((p) => p.use_discovery === 1);
    if (peers.length === 0) {
      return res.json({ query, searched: { peers: 0, unreachable: 0, mismatched: 0 }, results: [] });
    }

    const payload = JSON.stringify({
      embedding: Buffer.from(seed.embedding.buffer, seed.embedding.byteOffset, seed.embedding.byteLength).toString('base64'),
      modelId: seed.model_id,
      limit: Math.min(PEER_LIMIT_CAP, limit * HEADROOM),
    });

    // Loaded lazily like the admin routes do — federation-client pulls in
    // the iroh machinery, which stays cold until a peer is actually dialed.
    const fedClient = await import('../state/federation-client.js');
    const answers = await Promise.allSettled(peers.map(async (peer) => {
      const r = await fedFetchWithDeadline(fedClient, peer, '/api/v1/federation/discovery/similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        // Still useful: bounds the response-body read once headers arrive.
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      }, PEER_TIMEOUT_MS);
      if (!r.ok) { throw new Error(`http ${r.status}`); }
      return r.json();
    }));

    const searched = { peers: 0, unreachable: 0, mismatched: 0 };
    const exclude = localIdentitySets();
    const merged = [];
    for (const [i, outcome] of answers.entries()) {
      const peer = peers[i];
      if (outcome.status === 'rejected') {
        searched.unreachable += 1;
        winston.warn(`discovery federation similar: peer '${peer.name}' (id=${peer.id}) failed: ${outcome.reason?.message}`);
        continue;
      }
      if (outcome.value.modelMismatch) { searched.mismatched += 1; continue; }
      searched.peers += 1;
      for (const r of outcome.value.results || []) {
        if (!isNovel(exclude, {
          artist: r.artist,
          title: r.title,
          recordingMbid: r.recordingMbid,
          similarityVsSeed: r.similarity,
        }, { newArtistsOnly })) { continue; }
        merged.push({
          artist: r.artist,
          title: r.title,
          duration: r.duration,
          similarity: r.similarity,
          genreTags: r.genreTags,
          recordingMbid: r.recordingMbid,
          // filepath is the PEER's vpath-form path — the handle a future
          // stream proxy plays, and provenance the panel can show today.
          filepath: r.filepath,
          peer: { id: peer.id, name: peer.name },
        });
      }
    }

    // Cross-peer dedupe: two peers holding the same song should surface it
    // once (highest similarity wins — walk in sorted order). Keyed by MBID
    // when present AND normalized artist+title, so a tagged copy on one
    // peer dedupes an untagged copy on another whenever the names agree.
    merged.sort((a, b) => b.similarity - a.similarity);
    const seen = new Set();
    const results = [];
    for (const r of merged) {
      if (results.length >= limit) { break; }
      const keys = [`a:${norm(r.artist)} ${norm(r.title)}`];
      if (r.recordingMbid) { keys.push(`m:${r.recordingMbid}`); }
      if (keys.some((k) => seen.has(k))) { continue; }
      for (const k of keys) { seen.add(k); }
      results.push(r);
    }

    res.json({ query, searched, results });
  });
}
