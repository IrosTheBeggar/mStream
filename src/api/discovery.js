// Music-discovery similarity API — the first consumer of the embeddings the
// discovery worker builds (discovery.db). Two endpoints, shaped for the
// webapp player (results carry the standard {filepath, metadata} envelope so
// they queue without translation):
//
//   POST /api/v1/discovery/local/similar          tracks similar to a seed track
//   POST /api/v1/discovery/local/similar-artists  artists similar to a seed artist
//
// Semantics:
//   - 403 while scanOptions.collectDiscoveryData is off (house convention
//     for disabled features).
//   - notAnalyzed:true + empty results when the seed exists but the worker
//     hasn't embedded it yet — a transient state, not an error.
//   - 404 for unknown seeds (or seeds outside the user's libraries).
//   - One result per canonical audio hash (duplicate files share one
//     vector), resolved to a file THIS user can access; users never see
//     tracks outside their vpaths.
//   - `metadata` is the live-library lite envelope (includes bpm /
//     musical-key / file-tag genres); `genreTags` alongside it is the
//     MODEL's style predictions — different sources, deliberately separate.
//   - bpmRange filters on live tracks.bpm (fresher than the discovery
//     snapshot, which exists for exports/network, not local queries).

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as sim from '../db/discovery-similarity.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { renderMetadataObj, toLiteMetadata, trackQuery, libraryFilter } from './db.js';
import { getVPathInfo } from '../util/vpath.js';

const d = () => db.getDB();

// Feature gate + index. 403 when the feature is off; 403 (generic) when the
// store is unavailable despite the flag (boot init failed) — same status so
// probing can't distinguish configuration from failure. Exported for other
// routes that compose with the similarity index (the Auto-DJ picker's
// sonic filter in random.js).
export function requireIndex() {
  if (config.program.scanOptions.collectDiscoveryData !== true) {
    throw new WebError('Discovery is disabled', 403);
  }
  const index = sim.getIndex();
  if (!index) { throw new WebError('Discovery is disabled', 403); }
  return index;
}

// Resolve a client-supplied file path to the track row THIS user may see.
// The vpath check throws on unknown/forbidden library names — surfaced as
// a uniform 404 so probing can't map another user's library names. The
// rejection is logged (rejected vpaths are a probing signal).
export function resolveSeedTrack(req, filePath, routeTag) {
  let info;
  try {
    info = getVPathInfo(filePath, req.user);
  } catch (err) {
    winston.warn(`${routeTag}: rejected seed path '${filePath}' for '${req.user?.username}': ${err.message}`);
    throw new WebError('Track not found', 404);
  }
  const lib = db.getLibraryByName(info.vpath);
  if (!lib) { throw new WebError('Track not found', 404); }
  const uid = req.user?.id;
  const seedParams = uid ? [uid, info.relativePath, lib.id] : [info.relativePath, lib.id];
  const seedRow = d().prepare(`
    ${trackQuery(uid)}
    WHERE t.filepath = ? AND t.library_id = ?
    LIMIT 1
  `).get(...seedParams);
  if (!seedRow) { throw new WebError('Track not found', 404); }
  return seedRow;
}

// Resolve a canonical hash to a track row THIS user may see. Returns null
// when every copy of that audio lives outside the user's libraries.
function resolveVisible(uid, filter, canonHash) {
  const params = uid ? [uid, canonHash, ...filter.params] : [canonHash, ...filter.params];
  return d().prepare(`
    ${trackQuery(uid)}
    WHERE COALESCE(t.audio_hash, t.file_hash) = ? AND ${filter.clause}
    LIMIT 1
  `).get(...params);
}

function modelBlock(index) {
  return { id: index.modelId, version: index.modelVersion };
}

export function setup(mstream) {

  mstream.post('/api/v1/discovery/local/similar', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(100).default(10),
      excludeSameArtist: Joi.boolean().default(false),
      excludeSameAlbum: Joi.boolean().default(false),
      bpmRange: Joi.array().items(Joi.number().min(0).max(1000)).length(2).optional(),
    });
    const { value: body } = joiValidate(schema, req.body);

    const index = requireIndex();

    const seedRow = resolveSeedTrack(req, body.filePath, 'discovery/similar');
    const uid = req.user?.id;

    const seedRendered = renderMetadataObj(seedRow);
    const canonHash = seedRow.audio_hash || seedRow.file_hash;
    const seedEntry = canonHash ? index.byHash.get(canonHash) : null;

    const seed = {
      filepath: seedRendered.filepath,
      metadata: toLiteMetadata(seedRendered.metadata),
      genreTags: seedEntry?.genreTags ?? null,
    };

    if (!seedEntry) {
      return res.json({ seed, model: modelBlock(index), notAnalyzed: true, results: [] });
    }

    const filter = libraryFilter(req.user);
    const ranked = sim.rankTracks(index, seedEntry.vec, canonHash);
    const results = [];
    for (const { entry, similarity } of ranked) {
      if (results.length >= body.limit) { break; }
      const row = resolveVisible(uid, filter, entry.hash);
      if (!row) { continue; }   // no copy visible to this user
      if (body.excludeSameArtist && row.artist_name && row.artist_name === seedRow.artist_name) { continue; }
      if (body.excludeSameAlbum && row.album_name && row.album_name === seedRow.album_name
        && row.artist_name === seedRow.artist_name) { continue; }
      if (body.bpmRange && !(row.bpm >= body.bpmRange[0] && row.bpm <= body.bpmRange[1])) { continue; }

      const rendered = renderMetadataObj(row);
      results.push({
        filepath: rendered.filepath,
        similarity: Math.round(similarity * 10000) / 10000,
        metadata: toLiteMetadata(rendered.metadata),
        genreTags: entry.genreTags,
      });
    }

    res.json({ seed, model: modelBlock(index), notAnalyzed: false, results });
  });

  mstream.post('/api/v1/discovery/local/similar-artists', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(100).default(10),
    });
    const { value: body } = joiValidate(schema, req.body);

    const index = requireIndex();
    const uid = req.user?.id;
    const filter = libraryFilter(req.user);

    // Live library facts about the seed artist — also the access check:
    // an artist with no tracks visible to this user doesn't exist for them.
    const seedStats = d().prepare(`
      SELECT COUNT(*) AS n FROM tracks t
      JOIN artists a ON a.id = t.artist_id
      WHERE a.name = ? AND ${filter.clause}
    `).get(body.artist, ...filter.params);
    if (!seedStats || seedStats.n === 0) { throw new WebError('Artist not found', 404); }

    const seedCentroid = index.artists.get(body.artist);
    const seed = {
      artist: body.artist,
      trackCount: seedStats.n,
      analyzedCount: seedCentroid?.analyzedCount ?? 0,
      genreTags: seedCentroid?.topTags ?? null,
    };

    if (!seedCentroid) {
      return res.json({ seed, model: modelBlock(index), notAnalyzed: true, results: [] });
    }

    const artistVisible = d().prepare(`
      SELECT 1 FROM tracks t
      JOIN artists a ON a.id = t.artist_id
      WHERE a.name = ? AND ${filter.clause}
      LIMIT 1
    `);

    const ranked = sim.rankArtists(index, body.artist);
    const results = [];
    for (const cand of ranked) {
      if (results.length >= body.limit) { break; }
      if (!artistVisible.get(cand.artist, ...filter.params)) { continue; }

      // Entry points: the candidate's tracks closest to the SEED's sound —
      // playable doorways that continue the vibe the user came from.
      const entryPoints = [];
      for (const { entry } of sim.rankArtistTracks(index, cand.artist, seedCentroid.vec)) {
        if (entryPoints.length >= 2) { break; }
        const row = resolveVisible(uid, filter, entry.hash);
        if (!row) { continue; }
        const rendered = renderMetadataObj(row);
        entryPoints.push({ filepath: rendered.filepath, metadata: toLiteMetadata(rendered.metadata) });
      }

      results.push({
        artist: cand.artist,
        similarity: Math.round(cand.similarity * 10000) / 10000,
        analyzedCount: cand.analyzedCount,
        genreTags: cand.topTags,
        entryPoints,
      });
    }

    res.json({ seed, model: modelBlock(index), notAnalyzed: false, results });
  });
}
