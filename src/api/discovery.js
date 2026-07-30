// Music-discovery similarity API — the first consumer of the embeddings the
// discovery worker builds (discovery.db). Two endpoints, shaped for the
// webapp player (results carry the standard {filepath, metadata} envelope so
// they queue without translation):
//
//   POST /api/v1/discovery/local/similar/tracks   tracks similar to a seed track
//   POST /api/v1/discovery/local/similar/artists  artists similar to a seed artist
//   POST /api/v1/discovery/local/path             a smooth "journey" between two tracks
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
import { renderMetadataObj, toLiteMetadata, trackQuery, libraryFilter, fetchGenresForTrack } from './db.js';
import { getVPathInfo } from '../util/vpath.js';

const d = () => db.getDB();

// Prepared-statement memo: per DB handle (the handle is replaced on e.g. a
// backup restore, and a WeakMap lets the old handle's statements be
// collected with it), then per SQL text. The text varies only with uid
// presence and the caller's library-filter shape (grant-count IN-list
// length) — a handful of variants per process, so the inner Map stays
// small. Re-preparing per candidate was measured at ~75–80% of the probe
// cost: a full 25k-index visibility walk is ~6 s re-preparing vs ~0.3 s
// prepared once.
const stmtCache = new WeakMap();
function prep(sql) {
  const handle = d();
  let bySql = stmtCache.get(handle);
  if (!bySql) { bySql = new Map(); stmtCache.set(handle, bySql); }
  let stmt = bySql.get(sql);
  if (!stmt) { stmt = handle.prepare(sql); bySql.set(sql, stmt); }
  return stmt;
}

// Bounded candidate consideration for the ranked loops below. Rankings are
// similarity-ordered, so entries thousands deep are dissimilar noise —
// walking them buys latency, not relevance. Results may legitimately come
// up short for users who can see few of the ranked tracks; responses carry
// `capped: true` when that happened so clients can tell "short because the
// pool ran out" from "short because we stopped looking".
const considerBudget = (limit) => Math.max(limit * 50, 2000);

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
  // includeGenres:false + single-track enrichment: the default tg_agg join
  // materialises a GROUP_CONCAT over the whole track_genres table to fetch
  // ONE row (~70 ms at 25k tracks, per request). Same trap as resolveVisible.
  const seedRow = prep(`
    ${trackQuery(uid, { includeGenres: false })}
    WHERE t.filepath = ? AND t.library_id = ?
    LIMIT 1
  `).get(...seedParams);
  if (!seedRow) { throw new WebError('Track not found', 404); }
  Object.assign(seedRow, fetchGenresForTrack(d(), seedRow.id));
  return seedRow;
}

// Resolve a canonical hash to a track row THIS user may see. Returns null
// when every copy of that audio lives outside the user's libraries.
// Exported for the federation vector-seed route (api/federation-discovery.js),
// which scopes a peer's results the same way.
//
// This runs once per RANKED CANDIDATE inside the routes' loops, so its cost
// is the whole feature's cost. Two traps, both measured on a 25k-track DB
// (2026-07 audit — the same planner failure class as the scan/status
// incident):
//   • The probe must NOT be phrased `COALESCE(t.audio_hash, t.file_hash) = ?`
//     — an expression, so neither hash index applies and SQLite (no ANALYZE
//     stats) falls back to idx_tracks_library = a full library scan per
//     candidate (~74 ms; minutes per request under filter starvation). The
//     flat OR rewrite (`t.audio_hash = ? OR ...`) does NOT fix the plan
//     either; the UNION ALL id-subquery below does (~0.07 ms, ~1000×).
//   • trackQuery's default includeGenres:true materialises a GROUP_CONCAT
//     over the ENTIRE track_genres table per call. Resolved rows instead get
//     the indexed single-track lookup, preserving metadata.genres for every
//     caller (renderMetadataObj reads genres_concat).
export function resolveVisible(uid, filter, canonHash, { withGenres = true } = {}) {
  const params = uid
    ? [uid, canonHash, canonHash, ...filter.params]
    : [canonHash, canonHash, ...filter.params];
  const row = prep(`
    ${trackQuery(uid, { includeGenres: false })}
    WHERE t.id IN (
            SELECT id FROM tracks WHERE audio_hash = ?
            UNION ALL
            SELECT id FROM tracks WHERE file_hash = ? AND audio_hash IS NULL
          )
      AND ${filter.clause}
    LIMIT 1
  `).get(...params);
  // withGenres:false for callers that post-filter or never render genres
  // (similar/tracks rejects on bpm/artist AFTER resolving; federation's
  // response carries no track genres) — they enrich accepted rows
  // themselves, so rejected candidates never pay the lookup.
  if (row && withGenres) { Object.assign(row, fetchGenresForTrack(d(), row.id)); }
  return row;
}

function modelBlock(index) {
  return { id: index.modelId, version: index.modelVersion };
}

export function setup(mstream) {

  mstream.post('/api/v1/discovery/local/similar/tracks', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(100).default(10),
      excludeSameArtist: Joi.boolean().default(false),
      excludeSameAlbum: Joi.boolean().default(false),
      bpmRange: Joi.array().items(Joi.number().min(0).max(1000)).length(2).optional(),
    });
    const { value: body } = joiValidate(schema, req.body);

    const index = requireIndex();

    const seedRow = resolveSeedTrack(req, body.filePath, 'discovery/local/similar/tracks');
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
    const maxConsidered = considerBudget(body.limit);
    let considered = 0;
    let capped = false;
    for (const { entry, similarity } of ranked) {
      if (results.length >= body.limit) { break; }
      if (++considered > maxConsidered) { capped = true; break; }
      const row = resolveVisible(uid, filter, entry.hash, { withGenres: false });
      if (!row) { continue; }   // no copy visible to this user
      if (body.excludeSameArtist && row.artist_name && row.artist_name === seedRow.artist_name) { continue; }
      if (body.excludeSameAlbum && row.album_name && row.album_name === seedRow.album_name
        && row.artist_name === seedRow.artist_name) { continue; }
      if (body.bpmRange && !(row.bpm >= body.bpmRange[0] && row.bpm <= body.bpmRange[1])) { continue; }

      // Enrich only rows that survived the filters — rejected candidates
      // never pay the genre lookup.
      Object.assign(row, fetchGenresForTrack(d(), row.id));
      const rendered = renderMetadataObj(row);
      results.push({
        filepath: rendered.filepath,
        similarity: Math.round(similarity * 10000) / 10000,
        metadata: toLiteMetadata(rendered.metadata),
        genreTags: entry.genreTags,
      });
    }

    res.json({ seed, model: modelBlock(index), notAnalyzed: false, capped, results });
  });

  // A smooth "journey" between two tracks: `length - 2` waypoints evenly
  // spaced along the great-circle arc between the seeds' embeddings, each
  // snapped to the nearest visible track (discovery-similarity.js
  // #pathBetween). `length` counts the TOTAL rows returned including both
  // seeds, so the playable queue is exactly what the client asked for —
  // possibly shorter when the pool runs dry (tiny/mostly-invisible
  // libraries), never an error. Rows are the standard {filepath, metadata}
  // envelope plus `t` (arc position) and `similarity` vs the row's own
  // waypoint. Feature-detect via the ping's `discoveryPath` flag — the
  // flag's real payload is "this server VERSION has the route".
  mstream.post('/api/v1/discovery/local/path', (req, res) => {
    const schema = Joi.object({
      startFilePath: Joi.string().required(),
      endFilePath: Joi.string().required(),
      length: Joi.number().integer().min(4).max(32).default(14),
    });
    const { value: body } = joiValidate(schema, req.body);

    const index = requireIndex();
    const uid = req.user?.id;

    const startRow = resolveSeedTrack(req, body.startFilePath, 'discovery/local/path');
    const endRow = resolveSeedTrack(req, body.endFilePath, 'discovery/local/path');

    const startHash = startRow.audio_hash || startRow.file_hash;
    const endHash = endRow.audio_hash || endRow.file_hash;
    const startEntry = startHash ? index.byHash.get(startHash) : null;
    const endEntry = endHash ? index.byHash.get(endHash) : null;

    const renderSeed = (row, entry) => {
      const rendered = renderMetadataObj(row);
      return {
        filepath: rendered.filepath,
        metadata: toLiteMetadata(rendered.metadata),
        genreTags: entry?.genreTags ?? null,
      };
    };
    const start = renderSeed(startRow, startEntry);
    const end = renderSeed(endRow, endEntry);

    // Per-end notAnalyzed (gentler than random.js's 400): the client can
    // hint WHICH end is still waiting on the discovery worker.
    const notAnalyzed = { start: !startEntry, end: !endEntry };
    if (!startEntry || !endEntry) {
      return res.json({ start, end, model: modelBlock(index), notAnalyzed, results: [] });
    }

    const seedRes = (seed, t) => ({
      filepath: seed.filepath, similarity: 1, t,
      metadata: seed.metadata, genreTags: seed.genreTags,
    });

    // Same canonical audio (identical file or a duplicate copy): nothing to
    // interpolate — the seeds alone are the journey.
    if (startHash === endHash) {
      return res.json({
        start, end, model: modelBlock(index), notAnalyzed,
        results: [seedRes(start, 0), seedRes(end, 1)],
      });
    }

    // Lazy visibility gate with a row cache: pathBetween consults it
    // best-candidate-first, and the rows it admits are exactly the ones we
    // render below — one main-DB lookup per considered hash, ever.
    const filter = libraryFilter(req.user);
    const rowCache = new Map();
    const visible = (hash) => {
      if (!rowCache.has(hash)) { rowCache.set(hash, resolveVisible(uid, filter, hash) || null); }
      return rowCache.get(hash) !== null;
    };

    const waypoints = sim.pathBetween(index, startHash, endHash, body.length - 2, visible);

    const results = [seedRes(start, 0)];
    for (const wp of waypoints) {
      const rendered = renderMetadataObj(rowCache.get(wp.hash));
      results.push({
        filepath: rendered.filepath,
        similarity: Math.round(wp.similarity * 10000) / 10000,
        t: Math.round(wp.t * 10000) / 10000,
        metadata: toLiteMetadata(rendered.metadata),
        genreTags: index.byHash.get(wp.hash)?.genreTags ?? null,
      });
    }
    results.push(seedRes(end, 1));

    res.json({ start, end, model: modelBlock(index), notAnalyzed, results });
  });

  mstream.post('/api/v1/discovery/local/similar/artists', (req, res) => {
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
    // Same bounded-consideration rule as similar/tracks: a user who can see
    // none of the ranked artists must not walk the whole ranking.
    const maxConsidered = considerBudget(body.limit);
    let considered = 0;
    let capped = false;
    for (const cand of ranked) {
      if (results.length >= body.limit) { break; }
      if (++considered > maxConsidered) { capped = true; break; }
      if (!artistVisible.get(cand.artist, ...filter.params)) { continue; }

      // Entry points: the candidate's tracks closest to the SEED's sound —
      // playable doorways that continue the vibe the user came from.
      // Bounded too: an artist with a large embedded-but-invisible catalog
      // shouldn't cost hundreds of probes for two doorways. 200 cached-
      // statement probes ≈ single-digit ms; real artists exhaust well first.
      const entryPoints = [];
      let epConsidered = 0;
      for (const { entry } of sim.rankArtistTracks(index, cand.artist, seedCentroid.vec)) {
        if (entryPoints.length >= 2 || ++epConsidered > 200) { break; }
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

    res.json({ seed, model: modelBlock(index), notAnalyzed: false, capped, results });
  });
}
