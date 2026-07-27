// POST /api/v1/db/random-songs — the Auto-DJ picker.
//
// Two operating modes selected per-request from the body:
//
//   • Simple mode (no BPM/key params, no body) — same observable
//     behaviour as the pre-V32 random-songs route (uniform pick over
//     the in-scope set, cooldown against recent picks), but served by
//     a bounded SQL sample: the cooldown ids are excluded in SQL and
//     ORDER BY RANDOM() LIMIT keeps only a small pool, so the whole
//     library is never materialised into JS.
//
//   • Continuity mode (any of bpmRanges / bpmRangesWide / musicalKeys /
//     requireBpm / requireMusicalKey set) — runs a fallback waterfall
//     that progressively relaxes the BPM/key constraints until at least
//     one track matches, then applies a tier filter so an in-range pick
//     wins over an unknown-tag pick wins over a known-wrong pick. The
//     waterfall keeps its full candidate sets — the tier filter needs
//     every row to classify, and the filters already bound the set.
//
// The `ignoreList` the client round-trips holds the last-served TRACK
// IDS (newest last). Pre-rework lists held candidate-set INDICES, which
// pointed at different tracks on every call as filters and the library
// changed; ids make the cooldown actually mean "don't repeat these
// songs". The client treats the list as opaque (persist + send back —
// see webapp/alpha/auto-dj.js), so the change is wire-compatible, and a
// session carrying an old index-based list self-heals: stale values
// match no candidate row and age out of the capped list within a few
// picks.
//
// This is step B of the Auto-DJ velvet port. Similar-artists support
// (the `artists` / `ignoreArtists` filters) is step D and lands in a
// separate PR — there's no library-aware Last.fm proxy yet, so wiring
// it here would only test the SQL path.

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as sim from '../db/discovery-similarity.js';
import { renderMetadataObj, libraryFilter, trackQuery, fetchGenresForTrack } from './db.js';
import { requireIndex, resolveSeedTrack } from './discovery.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// ── Camelot → raw-key name expansion ────────────────────────────────────────
//
// Clients send Camelot codes (1A, 8B, etc.) because that's what the
// velvet UI sends and what most DJ-tagged libraries use as the user-
// facing key notation. The DB stores whatever the scanner found
// verbatim — TKEY frames in the wild are a mix of Camelot codes and
// raw key names ("A minor", "C major"), with enharmonic spellings
// ("Ab" vs "G#") thrown in. This map covers all three forms so a
// `musicalKeys: ['8A']` filter matches "A minor" / "Am" / "Amin" /
// raw "8A" alike.
//
// Mirrors velvet's _CAMELOT_TO_KEYS in src/db/sqlite-backend.js — keep
// in sync if either tree updates the table.
export const CAMELOT_TO_KEYS = Object.freeze({
  '1A':  ['1A', 'Ab minor', 'Abmin', 'G# minor', 'G#min', 'Abm', 'G#m'],
  '1B':  ['1B', 'B major',  'Bmaj',  'B'],
  '2A':  ['2A', 'Eb minor', 'Ebmin', 'D# minor', 'D#min', 'Ebm', 'D#m'],
  '2B':  ['2B', 'F# major', 'F#maj', 'Gb major', 'Gbmaj', 'F#', 'Gb'],
  '3A':  ['3A', 'Bb minor', 'Bbmin', 'A# minor', 'A#min', 'Bbm', 'A#m'],
  '3B':  ['3B', 'Db major', 'Dbmaj', 'C# major', 'C#maj', 'Db', 'C#'],
  '4A':  ['4A', 'F minor',  'Fmin',  'Fm'],
  '4B':  ['4B', 'Ab major', 'Abmaj', 'G# major', 'G#maj', 'Ab', 'G#'],
  '5A':  ['5A', 'C minor',  'Cmin',  'Cm'],
  '5B':  ['5B', 'Eb major', 'Ebmaj', 'D# major', 'D#maj', 'Eb', 'D#'],
  '6A':  ['6A', 'G minor',  'Gmin',  'Gm'],
  '6B':  ['6B', 'Bb major', 'Bbmaj', 'A# major', 'A#maj', 'Bb', 'A#'],
  '7A':  ['7A', 'D minor',  'Dmin',  'Dm'],
  '7B':  ['7B', 'F major',  'Fmaj',  'F'],
  '8A':  ['8A', 'A minor',  'Amin',  'Am'],
  '8B':  ['8B', 'C major',  'Cmaj',  'C'],
  '9A':  ['9A', 'E minor',  'Emin',  'Em'],
  '9B':  ['9B', 'G major',  'Gmaj',  'G'],
  '10A': ['10A', 'B minor', 'Bmin',  'Bm'],
  '10B': ['10B', 'D major', 'Dmaj',  'D'],
  '11A': ['11A', 'F# minor','F#min', 'Gb minor', 'Gbmin', 'F#m', 'Gbm'],
  '11B': ['11B', 'A major', 'Amaj',  'A'],
  '12A': ['12A', 'C# minor','C#min', 'Db minor', 'Dbmin', 'C#m', 'Dbm'],
  '12B': ['12B', 'E major', 'Emaj',  'E'],
});

// Convert Camelot codes to the flat list of raw-key names the DB
// might contain. Codes are case-folded ('8a' == '8A') — hand-typed
// or third-party clients shouldn't silently lose a filter to casing.
// Unknown codes (anything not in the map) are dropped silently —
// clients sending a typo just get a no-match for that code, not a
// 400 (unless ALL codes are unrecognised; the route's Joi custom
// check catches that).
export function expandCamelotCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) { return []; }
  const out = new Set();
  for (const c of codes) {
    const expansion = CAMELOT_TO_KEYS[String(c).trim().toUpperCase()];
    if (!expansion) { continue; }
    for (const k of expansion) { out.add(k); }
  }
  return [...out];
}

// ── BPM / key SQL fragment builder ──────────────────────────────────────────
//
// Returns a {clauses, params} pair the caller AND's onto the base
// random-songs WHERE. Each opts field can be `undefined` / `null` /
// empty-array, which short-circuits its branch.
//
// Mirrors velvet's filter shape in src/db/sqlite-backend.js's
// _buildRandomWhere — same column references (t.bpm, t.musical_key),
// same NULL-exclusion rule (any filter implicitly requires the column
// to be non-null), same `bpmRanges` OR-fanout. The only structural
// difference is t.* vs files.* because of the normalised schema.
export function buildBpmKeyFilter(opts) {
  const clauses = [];
  const params = [];

  if (Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0) {
    const inner = opts.bpmRanges.map(() => '(t.bpm >= ? AND t.bpm <= ?)').join(' OR ');
    clauses.push(`t.bpm IS NOT NULL AND (${inner})`);
    for (const r of opts.bpmRanges) { params.push(Number(r.min), Number(r.max)); }
  } else if (opts.requireBpm) {
    clauses.push('t.bpm IS NOT NULL');
  }

  if (opts.requireMusicalKey) {
    clauses.push('t.musical_key IS NOT NULL');
  }
  if (Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0) {
    const rawKeys = expandCamelotCodes(opts.musicalKeys);
    if (rawKeys.length > 0) {
      const placeholders = rawKeys.map(() => '?').join(',');
      clauses.push(`t.musical_key IS NOT NULL AND t.musical_key IN (${placeholders})`);
      params.push(...rawKeys);
    }
  }

  return { clauses, params };
}

// ── Genre filter (whitelist / blacklist) ────────────────────────────────────
//
// Two-axis filter: a list of genre names + a mode that flips the
// matching operator between EXISTS (whitelist — track must have at
// least one listed genre) and NOT EXISTS (blacklist — track must
// have none of the listed genres).
//
// Untagged tracks (zero track_genres rows) come out:
//   • BLOCKED under whitelist — EXISTS returns false.
//   • ALLOWED under blacklist — NOT EXISTS returns true (no overlap
//     with the blocklist by definition).
//
// That asymmetry is the intended semantic: "only these genres" is a
// stricter promise than "anything except these genres."
//
// The match itself is ANY (a track passes whitelist if ANY of its
// genres are in the list; a track fails blacklist if ANY of its
// genres are in the list). COLLATE NOCASE makes the comparison
// case-insensitive — symmetric with src/api/db.js's getGenres
// handler which already returns ORDER BY g.name COLLATE NOCASE.
//
// Composed at the BASE-CONDITIONS layer of runRandomSongs (not
// inside runWaterfallQuery), so it applies through simple-mode AND
// every waterfall step without per-step plumbing. The filter is
// "always on" — the waterfall never relaxes it.
//
// Empty / missing `genres` → no-op regardless of mode.
export function buildGenreFilter(opts) {
  const clauses = [];
  const params = [];

  if (Array.isArray(opts.genres) && opts.genres.length > 0) {
    const operator = opts.mode === 'blacklist' ? 'NOT EXISTS' : 'EXISTS';
    const ph = opts.genres.map(() => '?').join(',');
    // COLLATE NOCASE on the LEFT of IN (not after the closing paren).
    // SQLite's parser attaches a trailing `... IN (...) COLLATE NOCASE`
    // to the surrounding expression rather than to each in-list
    // comparison, so the case-fold gets silently skipped. Verified via
    // direct query — `name IN ('MUSIC') COLLATE NOCASE` against a row
    // stored as 'Music' returns 0 rows; `name COLLATE NOCASE IN (...)`
    // returns the expected match.
    clauses.push(`${operator} (
      SELECT 1 FROM track_genres tg
       JOIN genres g ON g.id = tg.genre_id
       WHERE tg.track_id = t.id AND g.name COLLATE NOCASE IN (${ph})
    )`);
    params.push(...opts.genres);
  }

  return { clauses, params };
}

// ── Artist-scope filter (similar-artists + cooldown) ────────────────────────
//
// `artists` is the inclusion set — typically resolved Last.fm
// similar-artists names. The filter widens through V18 M2M tables so
// a track matches when the artist appears as:
//   • the tracks.artist_id (primary track artist)
//   • a track_artists.artist_id (featured / collaborator)
//   • an album_artists.artist_id (album credit — catches the
//     compilation/various-artists case where tracks belong to many
//     artists but the album is credited to one named artist)
// This is the same widening pattern V18 introduced for the Subsonic
// artist-search route, applied here so DJ similar-artists picks
// include collaborations and featured-on appearances.
//
// `ignoreArtists` is the cooldown set — names to EXCLUDE so the
// last N played artists don't immediately reappear. The exclusion
// is symmetric across the same three M2M tables (a track is dropped
// if any of its credits match the cooldown). Without that symmetry
// "Foo feat. Bar" would slip past a Bar cooldown.
//
// Both lists are name-strings (canonical library spellings as
// returned by db.resolveArtistNamesForDJ). Empty arrays / undefined
// are no-ops.
export function buildArtistFilter(opts) {
  const clauses = [];
  const params = [];

  if (Array.isArray(opts.artists) && opts.artists.length > 0) {
    const ph = opts.artists.map(() => '?').join(',');
    // Three-way widening — see comment block above. Each sub-clause
    // references the SAME parameter list, so we push the names once
    // and bind them three times via repeated placeholders.
    clauses.push(`(
      t.artist_id IN (SELECT id FROM artists WHERE name IN (${ph}))
      OR t.id IN (
        SELECT track_id FROM track_artists
         WHERE artist_id IN (SELECT id FROM artists WHERE name IN (${ph}))
      )
      OR t.album_id IN (
        SELECT album_id FROM album_artists
         WHERE artist_id IN (SELECT id FROM artists WHERE name IN (${ph}))
      )
    )`);
    params.push(...opts.artists, ...opts.artists, ...opts.artists);
  }

  if (Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const ph = opts.ignoreArtists.map(() => '?').join(',');
    // De Morgan applied: a row is excluded if ANY of its credits is in
    // the cooldown set. Equivalently, KEEP a row only when NONE of
    // them match — which is what we encode below. NULL artist_id /
    // album_id rows pass through the NOT IN check by SQL semantics
    // (NOT IN with a non-empty subquery returns NULL on NULL → falsy
    // in WHERE), but the V18 fallback chain ensures most tracks have
    // at least one credit set anyway.
    clauses.push(`
      COALESCE(t.artist_id, -1) NOT IN (SELECT id FROM artists WHERE name IN (${ph}))
      AND NOT EXISTS (
        SELECT 1 FROM track_artists ta
         WHERE ta.track_id = t.id
           AND ta.artist_id IN (SELECT id FROM artists WHERE name IN (${ph}))
      )
      AND NOT EXISTS (
        SELECT 1 FROM album_artists aa
         WHERE aa.album_id = t.album_id
           AND aa.artist_id IN (SELECT id FROM artists WHERE name IN (${ph}))
      )
    `);
    params.push(...opts.ignoreArtists, ...opts.ignoreArtists, ...opts.ignoreArtists);
  }

  return { clauses, params };
}

// ── Predicates for the post-fallback tier classification ────────────────────
//
// "Known-good" = the row's value is present AND inside the requested set.
// "Known-wrong" = the row's value is present BUT outside the requested set.
// "Unknown" = the row's value is NULL.
//
// A row that's known-good on at least one dimension and not known-wrong
// on the other is Tier 0. A row that's unknown on at least one dimension
// and not known-wrong on the other is Tier 1. Everything else is Tier 2.
//
// This matters because the waterfall may have dropped the BPM/key
// constraint at the SQL layer — the returned rows can still be filtered
// in JS so an in-range row wins over an unknown row wins over a wrong
// row. Without this, "drop constraint" steps would feed garbage picks
// to the client.
function classifyRow(row, opts) {
  const bpmRanges = opts.bpmRanges;
  const keySet    = opts.keySet;

  const bpmStatus = (() => {
    if (!bpmRanges || bpmRanges.length === 0) { return 'na'; }
    if (row.bpm == null) { return 'unknown'; }
    const inRange = bpmRanges.some(r => row.bpm >= r.min && row.bpm <= r.max);
    return inRange ? 'good' : 'wrong';
  })();

  const keyStatus = (() => {
    if (!keySet || keySet.size === 0) { return 'na'; }
    if (row.musical_key == null) { return 'unknown'; }
    return keySet.has(row.musical_key) ? 'good' : 'wrong';
  })();

  // Tier 0: at least one dimension is good, neither is wrong.
  if ((bpmStatus === 'good' && keyStatus !== 'wrong') ||
      (keyStatus === 'good' && bpmStatus !== 'wrong')) {
    return 0;
  }
  // Tier 1: neither is wrong (so at most unknown / na).
  if (bpmStatus !== 'wrong' && keyStatus !== 'wrong') {
    return 1;
  }
  // Tier 2: at least one is wrong.
  return 2;
}

export function applyTierFilter(rows, opts) {
  const haveBpm = Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0;
  const haveKey = Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0;
  // No active constraint → no filtering needed.
  if (!haveBpm && !haveKey) { return rows; }

  const keySet = haveKey ? new Set(expandCamelotCodes(opts.musicalKeys)) : null;
  const classifyOpts = { bpmRanges: opts.bpmRanges, keySet };

  const tier0 = [];
  const tier1 = [];
  const tier2 = [];
  for (const row of rows) {
    const t = classifyRow(row, classifyOpts);
    if (t === 0) { tier0.push(row); }
    else if (t === 1) { tier1.push(row); }
    else { tier2.push(row); }
  }
  if (tier0.length > 0) { return tier0; }
  if (tier1.length > 0) { return tier1; }
  return tier2;
}

// ── Waterfall ───────────────────────────────────────────────────────────────
//
// Returns the first non-empty result-set encountered while progressively
// relaxing constraints. Throws WebError(400) if every step is empty
// (no songs at all, even with no filter).
//
// Step order with similar-artists active (PR D — `artists` is set):
//
//   1.  similar + tight BPM + key
//   2.  similar + wide BPM + key
//   3.  similar + tight BPM (drop key)
//   4.  similar + wide BPM (drop key)
//   5.  similar only (drop BPM/key entirely)
//   5b. similar (drop ignoreArtists cooldown — only fires if cooldown set)
//   6.  any artist + tight BPM + key (similar exhausted)
//   7.  any artist + wide BPM + key
//   8.  any artist + tight BPM (drop key)
//   9.  any artist + wide BPM (drop key)
//   10. unrestricted random
//
// Without similar-artists (`artists` empty / missing), the chain
// collapses to steps 6–10 only.
//
// Each step only fires if its inputs are present — e.g. step 2 only
// runs when bpmRangesWide is set; step 5b only runs when ignoreArtists
// is non-empty; step 10 always runs as a final guarantee that SOMETHING
// comes back if any rows exist in scope.
function runWaterfallQuery(d, baseSql, baseParams, filterOpts, bounded) {
  const bpm = buildBpmKeyFilter(filterOpts);
  const art = buildArtistFilter(filterOpts);
  const clauses = [...bpm.clauses, ...art.clauses];
  const params  = [...bpm.params,  ...art.params];
  const sql = clauses.length > 0
    ? `${baseSql} AND ${clauses.join(' AND ')}`
    : baseSql;
  if (!bounded) { return d.prepare(sql).all(...baseParams, ...params); }

  // Bounded step (request has no BPM/key constraints, no sonic pool —
  // see runRandomSongs): sample a small random pool instead of
  // materialising every match. The id cooldown is excluded in SQL
  // first; when that alone empties the step, retry the SAME step
  // without it, so cooldown exhaustion falls back to repeats WITHIN
  // this step's constraints (matching finalisePick's fallback) instead
  // of advancing the waterfall and silently relaxing an artist
  // constraint the pool could still satisfy.
  const { ignoreIds } = bounded;
  const attempt = (excludeIgnored) => {
    const exclude = excludeIgnored && ignoreIds.length > 0
      ? ` AND t.id NOT IN (${ignoreIds.map(() => '?').join(',')})`
      : '';
    return d.prepare(`${sql}${exclude} ORDER BY RANDOM() LIMIT ${SIMPLE_POOL_LIMIT}`)
      .all(...baseParams, ...params, ...(exclude ? ignoreIds : []));
  };
  const rows = attempt(true);
  if (rows.length > 0 || ignoreIds.length === 0) { return rows; }
  return attempt(false);
}

// ── Sonic similarity pool (discovery embeddings) ────────────────────────────
//
// `similarTo` + `minSimilarity` constrain Auto-DJ picks to tracks whose
// embedding cosine vs the seed is at least the threshold. Multiple seed
// paths average into a session centroid (mean + L2, same math as the
// artist centroids) — the client sends its recent DJ picks so the session
// gravitates toward its own center instead of drifting song-by-song.
//
// The pool is a HARD base constraint, same contract as the genre filter:
// the waterfall never relaxes it — BPM/key/artist steps relax WITHIN the
// sonic pool, and even the final unrestricted step stays inside it. That's
// the whole point of the user-facing promise ("only songs within X of the
// vibe"); when nothing survives, the route fails loud rather than playing
// something outside the range.
//
// Inherent consequence: tracks the discovery worker hasn't embedded yet
// have no vector, so they can never be "within the range" — sonic mode
// restricts the pool to analyzed tracks.
//
// Errors mirror the /api/v1/discovery routes: 403 feature-off/store-dead
// (requireIndex), 404 unknown/forbidden seed path (resolveSeedTrack),
// 400 with a distinct message for a seed that exists but has no embedding
// yet (transient — the client can toast "pick a different seed").
function buildSonicPool(req, body) {
  const index = requireIndex();

  const vecs = [];
  const seedHashes = [];
  for (const p of body.similarTo) {
    const row = resolveSeedTrack(req, p, 'random-songs sonic');
    const canonHash = row.audio_hash || row.file_hash;
    const entry = canonHash ? index.byHash.get(canonHash) : null;
    if (!entry) {
      throw new WebError('Sonic seed track has not been analyzed yet', 400);
    }
    vecs.push(entry.vec);
    seedHashes.push(canonHash);
  }

  const seedVec = sim.centroidOf(vecs);
  const allowed = sim.hashesWithinThreshold(index, seedVec, body.minSimilarity);
  // The seeds are the session's recent picks (rolling anchor) or the
  // currently-playing song (locked anchor) — Auto-DJ must never answer
  // "what's next" with "the song you just played".
  for (const h of seedHashes) { allowed.delete(h); }
  return { index, seedVec, allowed };
}

// Server-side cooldown ceiling for the round-tripped ignoreList. Deep
// enough that a real session never hears a repeat it would notice, small
// enough that the SQL exclusion in simple mode stays a short IN list.
// (The Joi wire cap of 500 stays as defense-in-depth headroom.)
const IGNORE_COOLDOWN_MAX = 50;

// Candidate-pool size for the bounded simple-mode query. The pick is one
// song; 50 keeps the pool comfortably larger than the cooldown so
// consecutive picks stay varied even right after a fallback.
const SIMPLE_POOL_LIMIT = 50;

// Sanitize the client's round-tripped ignoreList to track ids we can bind
// into SQL / compare against rows. Joi already enforces integers >= 0;
// this guards the internal callers that bypass the route schema.
function ignoreIdsFrom(body) {
  const list = Array.isArray(body.ignoreList) ? body.ignoreList : [];
  return list.filter((n) => Number.isInteger(n) && n >= 0);
}

export function runRandomSongs(req, body) {
  const d = db.getDB();
  if (!d) { throw new WebError('Database not ready', 400); }

  // Sonic pool first — it can 403/404/400 on its own and there's no point
  // running SQL when the seed itself is bad.
  const sonic = (Array.isArray(body.similarTo) && body.similarTo.length > 0)
    ? buildSonicPool(req, body)
    : null;
  const sonicFilter = sonic
    ? (rows) => rows.filter((r) => sonic.allowed.has(r.audio_hash || r.file_hash))
    : (rows) => rows;

  const filter = libraryFilter(req.user, body.ignoreVPaths);
  const baseConditions = [filter.clause];
  const baseParams = [...(req.user?.id ? [req.user.id] : []), ...filter.params];

  if (body.minRating && Number(body.minRating) > 0) {
    baseConditions.push('um.rating >= ?');
    baseParams.push(Number(body.minRating));
  }

  // Genre filter is an ALWAYS-ON base condition (never relaxed by the
  // waterfall). Whitelist mode BLOCKS tracks with zero track_genres
  // rows; blacklist mode ALLOWS them (no overlap with the blocklist).
  // Empty `genres` array → no-op regardless of mode.
  const genre = buildGenreFilter({ genres: body.genres, mode: body.genreMode });
  if (genre.clauses.length > 0) {
    baseConditions.push(...genre.clauses);
    baseParams.push(...genre.params);
  }

  // Skip the trackQuery `tg_agg` aggregation for the candidate-set
  // query — only the picked row's genres survive to the response, and
  // SQLite MATERIALIZEs the aggregation over the full tracks table
  // before applying the WHERE clause. finalisePick enriches the
  // chosen row via fetchGenresForTrack so `metadata.genres` is still
  // populated on the wire. Measured ~80% SQL speedup on the smoke DB
  // (52 rows) and extrapolates to ~460ms saved per request at 100k
  // tracks.
  const baseSql = `${trackQuery(req.user?.id, { includeGenres: false })} WHERE ${baseConditions.join(' AND ')}`;

  // Decide which waterfall steps fire.
  const hasBpm = (Array.isArray(body.bpmRanges) && body.bpmRanges.length > 0)
               || body.requireBpm === true;
  const hasBpmWide = Array.isArray(body.bpmRangesWide) && body.bpmRangesWide.length > 0;
  const hasKey = (Array.isArray(body.musicalKeys) && body.musicalKeys.length > 0)
               || body.requireMusicalKey === true;
  const hasArtists = Array.isArray(body.artists) && body.artists.length > 0;
  const hasIgnoreArtists = Array.isArray(body.ignoreArtists) && body.ignoreArtists.length > 0;

  // Simple mode — no BPM/key/artists filters at all. Skip the waterfall.
  // (ignoreArtists alone counts as a filter — cooldown without any
  // other constraint still goes through the waterfall so we get the
  // step-5b "drop cooldown" fallback if the user pruned themselves
  // into an empty pool.)
  if (!hasBpm && !hasBpmWide && !hasKey && !hasArtists && !hasIgnoreArtists) {
    if (!sonic) {
      // Bounded pick: exclude the cooldown ids in SQL and let SQLite keep
      // only a small random pool — the whole in-scope library is never
      // materialised into JS. (Sonic mode below still needs the full
      // in-scope set: the allowed-hash intersection happens in JS, and
      // sampling before intersecting could empty a pool that actually
      // has matches.)
      const ignoreIds = ignoreIdsFrom(body);
      const bounded = (excludeIgnored) => {
        const exclude = excludeIgnored && ignoreIds.length > 0
          ? ` AND t.id NOT IN (${ignoreIds.map(() => '?').join(',')})`
          : '';
        return d.prepare(
          `${baseSql}${exclude} ORDER BY RANDOM() LIMIT ${SIMPLE_POOL_LIMIT}`
        ).all(...baseParams, ...(exclude ? ignoreIds : []));
      };
      let rows = bounded(true);
      if (rows.length === 0 && ignoreIds.length > 0) {
        // Cooldown covers everything in scope — allow repeats rather
        // than stalling the session (same contract as the waterfall's
        // drop-cooldown steps).
        rows = bounded(false);
      }
      if (rows.length === 0) {
        throw new WebError('No songs that match criteria', 400);
      }
      return finalisePick(rows, body, null);
    }

    const rows = sonicFilter(d.prepare(baseSql).all(...baseParams));
    if (rows.length === 0) {
      throw new WebError('No songs within the similarity range match criteria', 400);
    }
    return finalisePick(rows, body, sonic);
  }

  // Helper: build the constraint object passed to runWaterfallQuery.
  // `artists` and `ignoreArtists` carry through unless we explicitly
  // drop them (steps 6+ drop similar, step 5b drops the cooldown).
  const make = (overrides) => ({
    bpmRanges: body.bpmRanges,
    bpmRangesWide: body.bpmRangesWide,
    requireBpm: body.requireBpm,
    musicalKeys: body.musicalKeys,
    requireMusicalKey: body.requireMusicalKey,
    artists: body.artists,
    ignoreArtists: body.ignoreArtists,
    ...overrides,
  });

  // The step list — declared up-front so the loop below stays terse
  // and the order is grep-friendly. Steps whose `gate` returns false
  // are skipped (e.g. "wide BPM" steps are skipped when bpmRangesWide
  // is absent).
  const steps = [];

  if (hasArtists) {
    // Similar-artists-prioritised chain.
    steps.push({
      name: 'similar+tightBPM+key',
      gate: () => hasBpm || hasKey,
      opts: () => make({}),
    });
    steps.push({
      name: 'similar+wideBPM+key',
      gate: () => hasBpmWide && hasKey,
      opts: () => make({ bpmRanges: body.bpmRangesWide }),
    });
    // "Drop key" only relaxes anything when a key filter exists —
    // without one this step would re-run the exact SQL step 1 just
    // proved empty. (The wide variant below is NOT gated on hasKey:
    // when key is absent the wide+key step was skipped, so wide-no-key
    // is the first wide attempt, not a repeat.)
    steps.push({
      name: 'similar+tightBPM',
      gate: () => hasBpm && hasKey,
      opts: () => make({ musicalKeys: undefined, requireMusicalKey: undefined }),
    });
    steps.push({
      name: 'similar+wideBPM',
      gate: () => hasBpmWide,
      opts: () => make({
        bpmRanges: body.bpmRangesWide,
        musicalKeys: undefined,
        requireMusicalKey: undefined,
      }),
    });
    steps.push({
      name: 'similar-only',
      gate: () => true,
      opts: () => make({
        bpmRanges: undefined, bpmRangesWide: undefined,
        requireBpm: undefined,
        musicalKeys: undefined, requireMusicalKey: undefined,
      }),
    });
    // Step 5b — drop cooldown but keep similar. Only fires if the
    // user set ignoreArtists at all; otherwise step 5 already covered
    // the "similar only" case.
    if (hasIgnoreArtists) {
      steps.push({
        name: 'similar-drop-cooldown',
        gate: () => true,
        opts: () => make({
          bpmRanges: undefined, bpmRangesWide: undefined,
          requireBpm: undefined,
          musicalKeys: undefined, requireMusicalKey: undefined,
          ignoreArtists: undefined,
        }),
      });
    }
  }

  // Non-similar fallback chain — runs whether or not `artists` was
  // set. When similar is absent these are the only steps.
  steps.push({
    name: 'any+tightBPM+key',
    gate: () => hasBpm || hasKey,
    opts: () => make({ artists: undefined }),
  });
  steps.push({
    name: 'any+wideBPM+key',
    gate: () => hasBpmWide && hasKey,
    opts: () => make({ artists: undefined, bpmRanges: body.bpmRangesWide }),
  });
  // Gated on hasKey for the same reason as similar+tightBPM: with no
  // key filter to drop, this is byte-identical to any+tightBPM+key.
  steps.push({
    name: 'any+tightBPM',
    gate: () => hasBpm && hasKey,
    opts: () => make({
      artists: undefined,
      musicalKeys: undefined, requireMusicalKey: undefined,
    }),
  });
  steps.push({
    name: 'any+wideBPM',
    gate: () => hasBpmWide,
    opts: () => make({
      artists: undefined,
      bpmRanges: body.bpmRangesWide,
      musicalKeys: undefined, requireMusicalKey: undefined,
    }),
  });
  steps.push({
    name: 'unrestricted',
    gate: () => true,
    opts: () => make({
      artists: undefined,
      bpmRanges: undefined, bpmRangesWide: undefined,
      requireBpm: undefined,
      musicalKeys: undefined, requireMusicalKey: undefined,
    }),
  });
  // Final resort: drop the artist cooldown too. Mirrors step 5b's
  // semantics (the cooldown is best-effort variety, never worth
  // stalling the session over) for the non-similar chain — which
  // matters in practice under the sonic constraint: similarity pools
  // are strongly artist-correlated, so a tight threshold plus a
  // cooldown that covers the pool's artists would otherwise 400 every
  // pick. Also closes the pre-existing (if unlikely) plain case where
  // the cooldown covers every artist in a small library.
  if (hasIgnoreArtists) {
    steps.push({
      name: 'unrestricted-drop-cooldown',
      gate: () => true,
      opts: () => make({
        artists: undefined,
        bpmRanges: undefined, bpmRangesWide: undefined,
        requireBpm: undefined,
        musicalKeys: undefined, requireMusicalKey: undefined,
        ignoreArtists: undefined,
      }),
    });
  }

  // With no BPM/key constraints anywhere on the request, the post-chain
  // tier filter has nothing to classify, and without sonic there is no
  // JS-side pool intersection — so every step's query can be bounded the
  // same way simple mode is. This is the shape real alpha DJ sessions
  // take: the client sends ignoreArtists from pick #2 onward (artist
  // cooldown has no off switch), which routes them through the waterfall
  // even when BPM/key/similar features are all disabled.
  const bounded = (!hasBpm && !hasBpmWide && !hasKey && !sonic)
    ? { ignoreIds: ignoreIdsFrom(body) }
    : null;

  let rows = [];
  for (const step of steps) {
    if (!step.gate()) { continue; }
    // The sonic pool intersects EVERY step's result before the emptiness
    // check that drives relaxation — the waterfall relaxes BPM/key/artist
    // constraints WITHIN the pool and never relaxes the pool itself
    // (including the final unrestricted step).
    rows = sonicFilter(runWaterfallQuery(d, baseSql, baseParams, step.opts(), bounded));
    if (rows.length > 0) { break; }
  }

  if (rows.length === 0) {
    throw new WebError(sonic
      ? 'No songs within the similarity range match criteria'
      : 'No songs that match criteria', 400);
  }

  // Apply tier filter against the ORIGINAL request constraints so that
  // even after the chain drops the SQL filter, in-range rows still win.
  rows = applyTierFilter(rows, {
    bpmRanges: body.bpmRanges,
    musicalKeys: body.musicalKeys,
  });

  return finalisePick(rows, body, sonic);
}

function finalisePick(rows, body, sonic) {
  const sent = ignoreIdsFrom(body);
  const ignoreSet = new Set(sent);
  // Cooldown: prefer candidates not served recently. When the cooldown
  // covers the whole candidate set (tiny library / narrow filters / long
  // session), fall back to the full set — repeats beat stalling the
  // session. Simple mode already excluded the ids in SQL, so the filter
  // is a no-op there; waterfall and sonic sets are filtered here.
  const fresh = rows.filter((r) => !ignoreSet.has(r.id));
  const pool = fresh.length > 0 ? fresh : rows;
  const picked = pool[Math.floor(Math.random() * pool.length)];

  // Move-to-end + trim: newest last, bounded, no duplicate of the pick.
  // Stale entries (deleted tracks, a pre-rework index-based list) age
  // out through the cap as new picks append.
  const nextIgnore = sent.filter((id) => id !== picked.id);
  nextIgnore.push(picked.id);
  while (nextIgnore.length > IGNORE_COOLDOWN_MAX) { nextIgnore.shift(); }

  // Enrich the picked row with `genres_concat` so renderMetadataObj
  // emits a populated `metadata.genres` field. The candidate-set
  // query above skipped the LEFT JOIN aggregation for speed; this
  // single targeted SELECT costs ~10µs and keeps the wire shape
  // contractually identical.
  const { genres_concat } = fetchGenresForTrack(db.getDB(), picked.id);
  picked.genres_concat = genres_concat;

  const out = {
    songs: [renderMetadataObj(picked)],
    ignoreList: nextIgnore,
  };

  // Sonic mode: report the pick's actual cosine vs the seed/centroid (UI
  // display + slider tuning) and how many analyzed tracks are inside the
  // range at all (before the other filters cut it down further).
  if (sonic) {
    const similarity = sim.similarityToHash(
      sonic.index, sonic.seedVec, picked.audio_hash || picked.file_hash);
    out.sonic = {
      similarity: similarity === null ? null : Math.round(similarity * 10000) / 10000,
      poolSize: sonic.allowed.size,
    };
  }

  return out;
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  mstream.post('/api/v1/db/random-songs', (req, res) => {
    // bpmRanges items: require min/max numeric, within [0, 1000], AND
    // min <= max. A backwards range ({min:200, max:50}) is the most
    // common typo and produces an SQL clause that matches nothing —
    // silently breaks the user's Auto-DJ for the duration of the
    // session. Better to reject it at the boundary than have the
    // route silently fail. The numeric bounds reject garbage
    // (negative / absurd BPM) on the same loud-beats-silent
    // principle; the webapp already clamps its ranges to [20, 300]
    // (AUTODJ.buildBpmRanges), so 0-1000 is generous headroom for
    // other clients.
    const bpmRangeItem = Joi.object({
      min: Joi.number().min(0).max(1000).required(),
      max: Joi.number().min(0).max(1000).required(),
    }).custom((v, helpers) => {
      if (v.min > v.max) {
        return helpers.error('any.custom', { message: 'bpm range min must be <= max' });
      }
      return v;
    }, 'bpm range ordering');

    // Array-length caps are defense-in-depth against accidental or
    // malicious payloads that would generate thousands of SQL
    // placeholders (the artist-filter widens 3×, so `artists: [...N]`
    // → 3N placeholders). SQLite's default SQLITE_MAX_VARIABLE_NUMBER
    // is 32766 on modern builds — we're nowhere near it under the
    // limits below, but a stray client that sends an entire library
    // history would otherwise pre-eat that budget.
    //
    // The caps are generous relative to expected use:
    //   • ignoreList:    track ids of recent picks; the server caps the
    //                    returned list at IGNORE_COOLDOWN_MAX (50), so
    //                    500 is 10× that ceiling.
    //   • ignoreVPaths:  one entry per vpath; users have <20.
    //   • artists/ignoreArtists: Last.fm's `artist.getSimilar` returns
    //                    at most 50 candidates; 100 covers the unioned
    //                    case where multiple callers want extra slack.
    //   • bpmRanges (and Wide): velvet's UI sends 3 (normal+half+double);
    //                    16 is room for future tolerance-window UIs.
    //   • musicalKeys:   24 possible Camelot codes; the cap matches.
    const schema = Joi.object({
      ignoreList: Joi.array().items(Joi.number().integer().min(0)).max(500).optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).max(50).optional(),
      // minRating accepts 0..10 — the alpha-UI rating dropdown
      // (webapp/alpha/m.js's autoDjPanel) uses 0 as the "Disabled"
      // option and every autoDJ() call sends that value by default,
      // even when no filter is intended (see
      // webapp/assets/js/mstream.player.js:71). The runRandomSongs
      // body below treats `0` (falsy) as no-filter, matching the
      // pre-V32 route's behaviour. Rejecting 0 at the Joi layer would
      // break every call from the existing webapp.
      minRating: Joi.number().integer().min(0).max(10).optional(),
      // BPM filters — bpmRanges is the canonical form; bpmRangesWide
      // is the relaxation step 2/4 of the waterfall falls back to.
      bpmRanges: Joi.array().items(bpmRangeItem).max(16).optional(),
      bpmRangesWide: Joi.array().items(bpmRangeItem).max(16).optional(),
      requireBpm: Joi.boolean().optional(),
      // Key filters — musicalKeys are Camelot codes ('1A'..'12B').
      // Per-item shape is intentionally loose (no `valid(...)`) so
      // future code-set expansions (sharp/flat variants) don't need
      // a Joi update — unrecognised codes are dropped silently by
      // expandCamelotCodes. The .custom() check below catches the
      // all-typos case so the user doesn't get a silently-disabled
      // harmonic filter with no error signal.
      musicalKeys: Joi.array().items(Joi.string()).max(24)
        .custom((codes, helpers) => {
          if (codes.length > 0 && expandCamelotCodes(codes).length === 0) {
            return helpers.error('any.custom', { message: 'no recognised Camelot codes (expected 1A..12B)' });
          }
          return codes;
        }, 'camelot-codes parseable')
        .optional(),
      requireMusicalKey: Joi.boolean().optional(),
      // PR D — similar-artists scope and cooldown.
      //   • artists:       canonical library names (typically the output
      //                    of GET /api/v1/lastfm/similar-artists). When
      //                    set, the waterfall prioritises tracks whose
      //                    primary / featured / album-credited artist
      //                    matches.
      //   • ignoreArtists: canonical library names recently played, to
      //                    exclude. Symmetric V18 widening so a cooldown
      //                    on "Foo" also drops "Foo feat. Bar". The
      //                    chain has a "drop cooldown" fallback so a
      //                    user who blacklisted themselves into an
      //                    empty pool still gets a pick.
      artists: Joi.array().items(Joi.string()).max(100).optional(),
      ignoreArtists: Joi.array().items(Joi.string()).max(100).optional(),
      // Genre filter (V35 plan). `genres` is the list, `genreMode` flips
      // the operator: whitelist (EXISTS, default) plays only matching
      // tracks; blacklist (NOT EXISTS) skips them. Per-item 1-200 chars
      // matches the longest real genre name in the wild (some MB long
      // forms run ~80 chars; 200 is comfortable headroom). The 200-item
      // list cap suits even very tag-rich libraries — real-world ceilings
      // top out around 500 distinct genres, of which the user typically
      // selects a small subset.
      genres: Joi.array().items(Joi.string().min(1).max(200)).max(200).optional(),
      genreMode: Joi.string().valid('whitelist', 'blacklist').default('whitelist'),
      // Sonic similarity (discovery embeddings) — both-or-neither, enforced
      // by the .and() below.
      //   • similarTo:     1-8 file paths. One = plain seed; several average
      //                    into a session centroid (the client sends its
      //                    recent DJ picks as a rolling anchor — 8 is
      //                    headroom over the expected 5-deep ring buffer).
      //   • minSimilarity: raw cosine threshold 0..1. The pool is a hard
      //                    base constraint — never relaxed by the waterfall.
      //                    (EffNet reality: same-artist ≈ .6-.9, cross ≈
      //                    .3-.7 — the client maps a perceptual slider onto
      //                    this; the API takes the raw value.)
      similarTo: Joi.array().items(Joi.string()).min(1).max(8).optional(),
      minSimilarity: Joi.number().min(0).max(1).optional(),
    }).and('similarTo', 'minSimilarity');
    const { value } = joiValidate(schema, req.body || {});

    res.json(runRandomSongs(req, value));
  });
}
