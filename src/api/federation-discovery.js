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
import { requireIndex, resolveVisible } from './discovery.js';
import { renderMetadataObj, libraryFilter } from './db.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

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

    const raw = Buffer.from(body.embedding, 'base64');
    if (raw.length !== index.dim * 4) {
      throw new WebError(`embedding must be ${index.dim} float32 values (little-endian), got ${raw.length} bytes`, 400);
    }
    // Aligned copy — a Buffer's byteOffset isn't guaranteed 4-byte aligned.
    const ab = new ArrayBuffer(raw.length);
    new Uint8Array(ab).set(raw);
    const q = new Float32Array(ab);

    let sumSq = 0;
    for (let i = 0; i < q.length; i++) {
      if (!Number.isFinite(q[i])) { throw new WebError('embedding contains non-finite values', 400); }
      sumSq += q[i] * q[i];
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0) { throw new WebError('embedding is a zero vector', 400); }
    // The index vectors are L2-normalized at write time; "similarity" below
    // only means cosine if the query is normalized too. Callers should send
    // unit vectors, but a scaled one costs nothing to fix here.
    for (let i = 0; i < q.length; i++) { q[i] /= norm; }

    const filter = libraryFilter(req.user);
    const uid = req.user?.id;
    // recording_mbid isn't part of the in-memory index; PK lookups for the
    // few rows that make the cut are cheap. The caller's novelty chain
    // (MBID → artist+title → near-dup) wants it.
    const ddb = discoveryDb.openDiscoveryDbIfExists() ? discoveryDb.getDiscoveryDb() : null;
    const mbidStmt = ddb ? ddb.prepare('SELECT recording_mbid FROM discovery_tracks WHERE audio_hash = ?') : null;

    const results = [];
    for (const { entry, similarity } of sim.rankTracks(index, q, null)) {
      if (results.length >= body.limit) { break; }
      const row = resolveVisible(uid, filter, entry.hash);
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

    res.json({ model, results });
  });
}
