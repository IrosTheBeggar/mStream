// POST /api/v1/db/random-songs — the Auto-DJ picker.
//
// Two operating modes selected per-request from the body:
//
//   • Simple mode (no BPM/key params, no body) — behaviour identical to
//     the pre-V32 random-songs route: load all rows that match the
//     library filter + minRating, pick a random index, return it.
//
//   • Continuity mode (any of bpmRanges / bpmRangesWide / musicalKeys /
//     requireBpm / requireMusicalKey set) — runs a fallback waterfall
//     that progressively relaxes the BPM/key constraints until at least
//     one track matches, then applies a tier filter so an in-range pick
//     wins over an unknown-tag pick wins over a known-wrong pick.
//
// This is step B of the Auto-DJ velvet port. Similar-artists support
// (the `artists` / `ignoreArtists` filters) is step D and lands in a
// separate PR — there's no library-aware Last.fm proxy yet, so wiring
// it here would only test the SQL path.

import Joi from 'joi';
import * as db from '../db/manager.js';
import { renderMetadataObj, libraryFilter, trackQuery, fetchGenresForTrack } from './db.js';
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
// might contain. Unknown codes (anything not in the map) are dropped
// silently — clients sending a typo just get a no-match for that
// code, not a 400.
export function expandCamelotCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) { return []; }
  const out = new Set();
  for (const c of codes) {
    const expansion = CAMELOT_TO_KEYS[String(c).trim()];
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
function runWaterfallQuery(d, baseSql, baseParams, filterOpts) {
  const bpm = buildBpmKeyFilter(filterOpts);
  const art = buildArtistFilter(filterOpts);
  const clauses = [...bpm.clauses, ...art.clauses];
  const params  = [...bpm.params,  ...art.params];
  const sql = clauses.length > 0
    ? `${baseSql} AND ${clauses.join(' AND ')}`
    : baseSql;
  return d.prepare(sql).all(...baseParams, ...params);
}

function pickRandomNonIgnored(rowCount, ignoreList) {
  // Trim ignoreList when it grows too large — pre-V32 behaviour.
  const trimmed = [...ignoreList];
  while (trimmed.length > rowCount * 0.5) { trimmed.shift(); }
  if (trimmed.length >= rowCount) {
    // Every slot is ignored — reset, pick freely.
    trimmed.length = 0;
  }
  const ignoreSet = new Set(trimmed);
  let idx;
  let attempts = 0;
  const cap = rowCount * 4;
  do {
    idx = Math.floor(Math.random() * rowCount);
    attempts++;
  } while (ignoreSet.has(idx) && attempts < cap);
  return { idx, trimmedIgnore: trimmed };
}

export function runRandomSongs(req, body) {
  const d = db.getDB();
  if (!d) { throw new WebError('Database not ready', 400); }

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
    const rows = d.prepare(baseSql).all(...baseParams);
    if (rows.length === 0) {
      throw new WebError('No songs that match criteria', 400);
    }
    return finalisePick(rows, body);
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
    steps.push({
      name: 'similar+tightBPM',
      gate: () => hasBpm,
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
  steps.push({
    name: 'any+tightBPM',
    gate: () => hasBpm,
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

  let rows = [];
  for (const step of steps) {
    if (!step.gate()) { continue; }
    rows = runWaterfallQuery(d, baseSql, baseParams, step.opts());
    if (rows.length > 0) { break; }
  }

  if (rows.length === 0) {
    throw new WebError('No songs that match criteria', 400);
  }

  // Apply tier filter against the ORIGINAL request constraints so that
  // even after the chain drops the SQL filter, in-range rows still win.
  rows = applyTierFilter(rows, {
    bpmRanges: body.bpmRanges,
    musicalKeys: body.musicalKeys,
  });

  return finalisePick(rows, body);
}

function finalisePick(rows, body) {
  const count = rows.length;
  const ignoreList = Array.isArray(body.ignoreList) ? body.ignoreList : [];
  const { idx, trimmedIgnore } = pickRandomNonIgnored(count, ignoreList);
  trimmedIgnore.push(idx);

  // Enrich the picked row with `genres_concat` so renderMetadataObj
  // emits a populated `metadata.genres` field. The candidate-set
  // query above skipped the LEFT JOIN aggregation for speed; this
  // single targeted SELECT costs ~10µs and keeps the wire shape
  // contractually identical.
  const picked = rows[idx];
  const { genres_concat } = fetchGenresForTrack(db.getDB(), picked.id);
  picked.genres_concat = genres_concat;

  return {
    songs: [renderMetadataObj(picked)],
    ignoreList: trimmedIgnore,
  };
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  mstream.post('/api/v1/db/random-songs', (req, res) => {
    // bpmRanges items: require min/max numeric AND min <= max. A
    // backwards range ({min:200, max:50}) is the most common typo and
    // produces an SQL clause that matches nothing — silently breaks
    // the user's Auto-DJ for the duration of the session. Better to
    // 403 it at the boundary than have the route silently fail.
    const bpmRangeItem = Joi.object({
      min: Joi.number().required(),
      max: Joi.number().required(),
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
    //   • ignoreList:    DJ session never grows beyond ~50 picks before
    //                    the server-side trim halves it. 500 is 10×
    //                    that ceiling.
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
    });
    const { value } = joiValidate(schema, req.body || {});

    res.json(runRandomSongs(req, value));
  });
}
