// Discovery-over-federation, peer side (mounted behind the auth wall).
//
// POST /api/v1/federation/discovery/similar is machine-facing: a federated
// peer sends the raw embedding vector of one of ITS tracks and this server
// answers with its most similar tracks, scoped to the caller's granted
// libraries. No novelty filtering happens here — this server cannot know
// what the caller's library holds, and shipping the caller's identity sets
// over would leak it — so the response is a plain top-K ranking the caller
// filters on its side.
//
// Vectors only compare within one model space, so the request declares the
// caller's model id. A mismatch is a soft 200 `modelMismatch` answer, not an
// error: the caller fans out to several peers and treats a mismatched peer
// as "no results", while its admin UI can still surface why.
//
// Grant scoping is the same machinery the local similar routes use —
// libraryFilter(req.user) + resolveVisible(). The federation wall's
// synthetic user carries the key's granted libraryIds, so a key granted
// library A never sees a ranked track whose only copy lives in library B.
// Regular logged-in users may also call this; they get results scoped to
// their own vpaths, which /discovery/local/* already gives them anyway.

import Joi from 'joi';
import * as sim from '../db/discovery-similarity.js';
import * as discoveryDb from '../db/discovery-db.js';
import { requireIndex, resolveVisible, decodeSeedVector } from './discovery.js';
import { renderMetadataObj, libraryFilter } from './db.js';
import { joiValidate } from '../util/validation.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function setup(mstream) {
  mstream.post('/api/v1/federation/discovery/similar', (req, res) => {
    const schema = Joi.object({
      // Base64 of dim × float32 little-endian (dim advertised in the
      // /federation/health discovery block).
      embedding: Joi.string().base64().required(),
      modelId: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    });
    const { value: body } = joiValidate(schema, req.body);

    const index = requireIndex();   // 403 while discovery is off/unavailable
    const model = { id: index.modelId, version: index.modelVersion };

    if (body.modelId !== index.modelId) {
      return res.json({ model, modelMismatch: true, results: [] });
    }

    // Index exists but holds zero vectors (nothing embedded yet): a valid
    // empty answer — and there is no dim to validate the query against.
    if (index.dim === null) {
      return res.json({ model, results: [] });
    }

    const q = decodeSeedVector(index, body.embedding);

    const filter = libraryFilter(req.user);
    const uid = req.user?.id;
    // recording_mbid isn't part of the in-memory index; PK lookups for the
    // few rows that make the cut are cheap. The caller's novelty chain
    // (MBID → artist+title → near-dup) wants it.
    const ddb = discoveryDb.openDiscoveryDbIfExists() ? discoveryDb.getDiscoveryDb() : null;
    const mbidStmt = ddb ? ddb.prepare('SELECT recording_mbid FROM discovery_tracks WHERE audio_hash = ?') : null;

    const results = [];
    // Bounded like the local similarity routes (2026-07 review): a starved
    // grant (key scoped to a library with few embedded tracks) would
    // otherwise walk the ENTIRE ranking — a full-index visibility sweep of
    // synchronous main-thread SQL per request, on a machine-facing route.
    // withGenres:false — this response never renders track genres.
    const maxConsidered = Math.max(body.limit * 50, 2000);
    let considered = 0;
    let capped = false;
    // topK = the walk's cap (see the local similar/tracks route — audit M9).
    for (const { entry, similarity } of sim.rankTracks(index, q, null, maxConsidered)) {
      if (results.length >= body.limit) { break; }
      if (++considered > maxConsidered) { capped = true; break; }
      const row = resolveVisible(uid, filter, entry.hash, { withGenres: false });
      if (!row) { continue; }   // no copy inside the caller's granted libraries
      results.push({
        filepath: renderMetadataObj(row).filepath,
        artist: row.artist_name || null,
        title: row.title || null,
        duration: row.duration ?? null,
        similarity: Math.round(similarity * 10000) / 10000,
        genreTags: entry.genreTags,
        recordingMbid: mbidStmt ? (mbidStmt.get(entry.hash)?.recording_mbid || null) : null,
      });
    }

    res.json({ model, capped, results });
  });
}
