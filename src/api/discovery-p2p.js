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
// The novelty filter (the point of the feature) is a chain, because no
// single identity signal covers every library:
//   1. recording MBID match        exact, when both sides are tagged
//   2. normalized artist+title     the pragmatic fallback
//   3. near-duplicate embedding    cosine ≥ NEAR_DUP vs the QUERY track
//                                  catches untagged re-encodes of it
// plus opt-in `newArtistsOnly`, which drops every artist the local library
// already knows — the "introduce me to someone new" mode.

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as peerDbs from '../state/discovery-peer-dbs.js';
import { resolveSeedTrack } from './discovery.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const NEAR_DUP = 0.99;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function requireP2p() {
  if (!config.program.discoveryP2p.enabled) {
    throw new WebError('discovery P2P is disabled (config: discoveryP2p.enabled)', 403);
  }
}

// "The Beatles" / "beatles" / "The  Beatles!" all collide — good enough for
// an exclusion filter (false positives here just hide a result, never rank
// a wrong one).
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The local library's identity sets for the novelty filter. Built per
// request — two indexed scans over a 10k-track library are a few ms, and a
// live cache would need scanner invalidation hooks for marginal gain.
function localIdentitySets() {
  const sets = { mbids: new Set(), artistTitles: new Set(), artists: new Set() };
  const rows = db.getDB().prepare(`
    SELECT a.name AS artist, t.title AS title
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
  `).all();
  for (const r of rows) {
    const artist = norm(r.artist);
    if (artist) { sets.artists.add(artist); }
    sets.artistTitles.add(`${artist} ${norm(r.title)}`);
  }
  // MBIDs live in discovery.db (populated by tagging/analysis passes).
  if (discoveryDb.openDiscoveryDbIfExists()) {
    const mbids = discoveryDb.getDiscoveryDb().prepare(
      'SELECT recording_mbid FROM discovery_tracks WHERE recording_mbid IS NOT NULL'
    ).all();
    for (const r of mbids) { sets.mbids.add(r.recording_mbid); }
  }
  return sets;
}

export function setup(mstream) {
  // Similar-but-not-owned tracks across the fetched peer shelf.
  //   filePath        the local seed track ("<vpath>/<relpath>")
  //   limit           max results (default 25, cap 100)
  //   newArtistsOnly  also drop artists the local library already has
  mstream.post('/api/v1/discovery/p2p/similar', (req, res) => {
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

    const dim = seed.embedding.byteLength / 4;
    const q = new Float32Array(seed.embedding.buffer.slice(
      seed.embedding.byteOffset, seed.embedding.byteOffset + dim * 4));

    const exclude = localIdentitySets();
    const results = [];
    let searchedPeers = 0;
    let searchedTracks = 0;

    for (const peer of peerDbs.list()) {
      let space;
      try {
        space = peerDbs.readEmbeddings(peer.endpointId, seed.model_id);
      } catch (err) {
        winston.warn(`discovery p2p similar: peer DB ${peer.endpointId.slice(0, 12)}… unreadable: ${err.message}`);
        continue;
      }
      if (!space || space.dim !== dim) { continue; } // no rows in this model space
      searchedPeers += 1;
      searchedTracks += space.count;

      for (let i = 0; i < space.count; i++) {
        // L2-normalized vectors: cosine == dot product.
        let dot = 0;
        const off = i * dim;
        for (let k = 0; k < dim; k++) { dot += q[k] * space.matrix[off + k]; }

        if (dot >= NEAR_DUP) { continue; } // same recording, different encode
        const artist = norm(space.artists[i]);
        if (space.mbids[i] && exclude.mbids.has(space.mbids[i])) { continue; }
        if (exclude.artistTitles.has(`${artist} ${norm(space.titles[i])}`)) { continue; }
        if (newArtistsOnly && artist && exclude.artists.has(artist)) { continue; }

        results.push({
          artist: space.artists[i],
          title: space.titles[i],
          duration: space.durations[i],
          similarity: dot,
          recordingMbid: space.mbids[i],
          exportId: space.ids[i],
          peer: { endpointId: space.endpointId, name: space.peerName },
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    res.json({
      query: { filePath, modelId: seed.model_id, newArtistsOnly },
      searched: { peers: searchedPeers, tracks: searchedTracks },
      results: results.slice(0, limit),
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
      })),
    });
  });
}
