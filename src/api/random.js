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
//     wins over an unknown-tag pick wins over a known-wrong pick. Every
//     step's query is bounded the same way simple mode is: the SQL ORDER
//     BY sorts by a tier expression mirroring the JS classifier before
//     the RANDOM() tiebreak, so the small pool always contains the best
//     tier present in scope and the tier filter keeps its authority
//     (audit M5 — any BPM/key param used to disable bounding, and the
//     terminal step then materialised the whole library per pick).
//
// Orthogonal to both modes are the ALWAYS-ON base conditions — the
// genre filter, the mood filter, the sonic-similarity pool, and the
// duration window.
// The waterfall relaxes BPM/key/artist constraints WITHIN them and
// never relaxes them, so an over-narrow one 400s rather than serving
// a pick outside the user's stated promise.
//
// Beside the always-on conditions there is exactly one SOFT term: the
// negative seeds (`lessLike` / `lessLikeVectors`, the "less like this"
// section below). Songs within the negative threshold of ANY negative are
// ranked behind the clean ones in every candidate query and in
// finalisePick — never removed — sitting behind the BPM/key tier, with
// only the just-served window (the last few picks, like a skip or not)
// ranking after them, so a skip can steer a session but can never empty
// its pool or add a way for a pick to 400.
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
// `limit` (default 1, capped at PICK_LIMIT_MAX) asks for a batch instead
// of a single pick. A batch is served from the same bounded pool a pick
// is: distinct rows, best tier first, fresh (not in the cooldown) before
// repeats, repeats oldest first, and every song served advances the
// ignoreList. It can fall short of `limit` — when fewer candidates are in
// scope, or when the waterfall step that wins holds fewer matches. The
// chain deliberately does NOT cascade into a more relaxed step to fill the
// remainder: the tail of the batch would then break the constraint its
// head satisfied, and the caller couldn't tell which songs are which.
//
// This is step B of the Auto-DJ velvet port. Similar-artists support
// (the `artists` / `ignoreArtists` filters) is step D and lands in a
// separate PR — there's no library-aware Last.fm proxy yet, so wiring
// it here would only test the SQL path.

import { createHash } from 'node:crypto';

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as sim from '../db/discovery-similarity.js';
import { renderMetadataObj, libraryFilter, trackQuery, fetchGenresForTrack, fetchCreditsForTrack } from './db.js';
import { PERFORMER_ROLES_SQL } from '../db/artist-roles.js';
import { requireIndex, optionalIndex, resolveSeedTrack, seedHashForPath, decodeSeedVector } from './discovery.js';
import { joiValidate } from '../util/validation.js';
import { parseMoods, applicableMoods, trackMoodClause } from './mood-filter.js';
import { nameKey } from '../db/name-key.js';
import WebError from '../util/web-error.js';

// ── Camelot → raw-key name expansion ────────────────────────────────────────
//
// Clients send Camelot codes (1A, 8B, etc.) because that's what the
// Auto-DJ panel sends (a habit inherited from the velvet fork's UI) and
// what most DJ-tagged libraries use as the user-
// facing key notation. The DB stores whatever the scanner found
// verbatim — TKEY frames in the wild are a mix of Camelot codes and
// raw key names ("A minor", "C major"), with enharmonic spellings
// ("Ab" vs "G#") thrown in. This map covers all three forms so a
// `musicalKeys: ['8A']` filter matches "A minor" / "Am" / "Amin" /
// raw "8A" alike.
//
// Ported from _CAMELOT_TO_KEYS in the velvet fork (aroundmyroom/mStream,
// its src/db/sqlite-backend.js — a file this tree never had). The fork is
// no longer tracked, so this table is the only copy to maintain.
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
// Mirrors the filter shape of the velvet fork's _buildRandomWhere (its
// src/db/sqlite-backend.js) — same column references (t.bpm, t.musical_key),
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
// `source` ('tag' | 'model', V79 track_genres.source) narrows which links
// count: only the files' own tags, or only the discovery model's genres
// (src/db/genre-sync.js) — the same choice /db/genres and /db/genre-songs
// take. Omitted, every link counts, as before. Under blacklist it narrows
// what is skipped: skipping the model's "Rock" keeps a song tagged Rock.
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
       WHERE tg.track_id = t.id AND g.name COLLATE NOCASE IN (${ph})${opts.source ? ' AND tg.source = ?' : ''}
    )`);
    params.push(...opts.genres);
    if (opts.source) params.push(opts.source);
  }

  return { clauses, params };
}

// ── Duration filter (track-length window) ───────────────────────────────────
//
// `minDuration` / `maxDuration` are SECONDS, matching the units of
// tracks.duration (REAL) and the `duration` field renderMetadataObj
// puts on the wire. Both bounds are independent and optional — a
// request can send one, both, or neither.
//
// Composed at the BASE-CONDITIONS layer of runRandomSongs alongside
// the genre filter, so it applies through simple mode AND every
// waterfall step. Like the genre filter it is "always on" — the
// waterfall never relaxes it. That's deliberate: "don't play anything
// under two minutes" is a hard promise (skip interludes, skit tracks,
// silent outros) in the same way "only these genres" is, and a filter
// that quietly lapsed on the terminal step would hand the user the
// exact 30-second interlude they excluded. When nothing survives the
// route 400s rather than playing out of range.
//
// NULL handling is the `allowUnknownDuration` axis:
//   • false / absent (DEFAULT) — NULL-duration rows are EXCLUDED. A
//     track whose length the scanner couldn't read can't be shown to
//     satisfy the bound, and the same reasoning already governs
//     buildBpmKeyFilter (any BPM/key filter implicitly requires the
//     column non-null) and the genre whitelist (untagged tracks are
//     blocked).
//   • true — NULL-duration rows are ALLOWED through as a third
//     alternative alongside the range. For libraries the scanner only
//     partially covers, excluding unknowns can shrink the pool far
//     more than the user intended; this opts back into "unknown is
//     fine, just keep the ones I know are wrong out".
//
// Both bounds missing → no-op regardless of allowUnknownDuration (an
// "allow unknowns" flag with no window to apply it to constrains
// nothing).
//
// ── There is deliberately NO index on tracks.duration ───────────────────────
//
// The obvious companion to this filter is `CREATE INDEX ... ON
// tracks(duration)`, mirroring V33's idx_tracks_bpm. It was built,
// measured against the real route at 100k tracks, and REJECTED —
// it makes the common case slower. Two runs, phase order reversed the
// second time to rule out cache warming, median of 25 picks:
//
//   window                        with idx   without   ratio
//   broad  2-6 min   (~86% pass)    99 ms      41 ms    0.41x  ← slower
//   broad + allowUnknown            99 ms      40 ms    0.40x  ← slower
//   narrow <60s      (~5% pass)      6.5 ms    15.6 ms  2.41x
//   very narrow >20m (~1% pass)      1.8 ms    12.4 ms  6.85x
//
// The route ends every candidate query in `ORDER BY [tier,] RANDOM()
// LIMIT n`, which must visit every row passing WHERE. For a selective
// window the index skips most of the table and wins big; for a broad
// one the planner still takes it (ANALYZE run, stats present) and pays
// ~86k index seeks plus row lookups where a sequential scan would do.
//
// The trade is backwards: it optimises windows that are already fast in
// absolute terms (12 ms → 2 ms, on a once-per-song call — worth nothing)
// and pessimises the slowest, most likely setting. "2 to 6 minutes" is
// the default mental model for "normal songs". 41 ms unindexed at 100k
// tracks is fine; 99 ms indexed is a regression for no user-visible gain.
//
// If you are about to add that index: re-run the measurement first.
export function buildDurationFilter(opts) {
  const clauses = [];
  const params = [];

  const hasMin = Number.isFinite(Number(opts.minDuration)) && Number(opts.minDuration) > 0;
  const hasMax = Number.isFinite(Number(opts.maxDuration)) && Number(opts.maxDuration) > 0;
  if (!hasMin && !hasMax) { return { clauses, params }; }

  const range = [];
  if (hasMin) { range.push('t.duration >= ?'); }
  if (hasMax) { range.push('t.duration <= ?'); }
  // `t.duration IS NOT NULL AND` is redundant in front of a >=/<=
  // comparison (NULL >= x is NULL, which WHERE treats as false), but
  // it is kept explicit so the exclude-unknowns intent is readable in
  // the emitted SQL and in EXPLAIN output.
  const inRange = `t.duration IS NOT NULL AND ${range.join(' AND ')}`;

  clauses.push(opts.allowUnknownDuration === true
    ? `(t.duration IS NULL OR (${inRange}))`
    : `(${inRange})`);
  if (hasMin) { params.push(Number(opts.minDuration)); }
  if (hasMax) { params.push(Number(opts.maxDuration)); }

  return { clauses, params };
}

// ── Artist-scope filter (similar-artists + cooldown) ────────────────────────
//
// `artists` is the inclusion set — typically resolved Last.fm
// similar-artists names. The filter widens through V18 M2M tables so
// a track matches when the artist appears as:
//   • the tracks.artist_id (primary track artist)
//   • a track_artists.artist_id in a PERFORMER role (main / featured) —
//     V73 added composer / conductor / remixer / lyricist credits, which
//     are not songs BY that artist
//   • an album_artists.artist_id (album credit — catches the
//     compilation/various-artists case where tracks belong to many
//     artists but the album is credited to one named artist)
// This is the same widening pattern V18 introduced for artist search,
// applied here so DJ similar-artists picks
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
      t.artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
      OR t.id IN (
        SELECT track_id FROM track_artists
         WHERE artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
           AND role IN (${PERFORMER_ROLES_SQL})
      )
      OR t.album_id IN (
        SELECT album_id FROM album_artists
         WHERE artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
      )
    )`);
    // V72: names match on their normalised key (src/db/name-key.js).
    const keys = opts.artists.map(nameKey);
    params.push(...keys, ...keys, ...keys);
  }

  if (Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const ph = opts.ignoreArtists.map(() => '?').join(',');
    // De Morgan applied: a row is excluded if ANY of its credits is in
    // the cooldown set. Equivalently, KEEP a row only when NONE of
    // them match — which is what we encode below.
    //
    // Encoded as ONE non-correlated set: the ids of every track one of
    // the three legs credits to a cooled artist, built once per
    // statement (each branch is an index seek from the cooled artists'
    // ids) and probed once per scanned track. The M2M legs used to be
    // correlated NOT EXISTS probes (`ta.track_id = t.id`,
    // `aa.album_id = t.album_id`), re-run for every scanned row — and a
    // pick walks the whole visible library (ORDER BY RANDOM()), so at
    // 25k tracks a 15-artist cooldown (the webapp's steady state) cost
    // ~110 ms of a ~125 ms pick. One rowid probe also beats three
    // per-leg NOT IN probes (~25%, measured).
    //
    // Same rows as the per-leg form, by construction (pinned row-for-row
    // by test/db/autodj-cooldown.test.mjs). NULL is the trap in
    // `x NOT IN (subquery)`: a NULL on either side makes it NULL and
    // WHERE drops the row. Here the left side is t.id (the rowid) and
    // every branch yields a rowid or track_artists.track_id (NOT NULL,
    // schema V18), so no NULL can reach the comparison. A track with a
    // NULL artist_id / album_id simply never enters those branches —
    // KEPT, exactly as `COALESCE(t.artist_id, -1)` and
    // `aa.album_id = t.album_id` (never true for NULL) kept it.
    clauses.push(`
      t.id NOT IN (
        SELECT tr.id FROM tracks tr
         WHERE tr.artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
        UNION ALL
        SELECT track_id FROM track_artists
         WHERE role IN (${PERFORMER_ROLES_SQL})
           AND artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
        UNION ALL
        SELECT tr.id FROM tracks tr
         WHERE tr.album_id IN (
           SELECT album_id FROM album_artists
            WHERE artist_id IN (SELECT id FROM artists WHERE name_key IN (${ph}))
         )
      )
    `);
    const ignoreKeys = opts.ignoreArtists.map(nameKey);
    params.push(...ignoreKeys, ...ignoreKeys, ...ignoreKeys);
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
//
// Exported for tests — the SQL twin (buildTierOrderExpr) is checked
// row-for-row against this classifier.
export function classifyRow(row, opts) {
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

// Stable sort by tier against the ORIGINAL request constraints: Tier 0
// rows first, then Tier 1, then Tier 2, each keeping its input order.
// The waterfall may have dropped the BPM/key constraint at the SQL layer,
// so a batch is handed out from the front of this ranking — in-range
// rows before unknown-tag rows before known-wrong rows — and a single
// pick takes the best row present, exactly as the old best-tier-only
// filter did. Input order carries the fresh-before-cooled, oldest-repeat-
// first priority (see finalisePick), which the stable sort preserves
// within a tier.
export function rankByTier(rows, opts) {
  const haveBpm = Array.isArray(opts.bpmRanges) && opts.bpmRanges.length > 0;
  const haveKey = Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0;
  // No active constraint → nothing to rank on.
  if (!haveBpm && !haveKey) { return rows; }

  const keySet = haveKey ? new Set(expandCamelotCodes(opts.musicalKeys)) : null;
  const classifyOpts = { bpmRanges: opts.bpmRanges, keySet };

  const tiers = [[], [], []];
  for (const row of rows) {
    tiers[classifyRow(row, classifyOpts)].push(row);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

// SQL twin of classifyRow, built against the ORIGINAL request constraints
// (exactly what the JS rankByTier call in finalisePick classifies with —
// tight ranges + expanded key names). Used as the leading ORDER BY term of
// every bounded waterfall query: rows sort best-tier-first before the
// RANDOM() tiebreak, so a LIMIT-sized pool provably contains the best tier
// present in scope and sampling can't starve the tier ranking. The JS
// ranking stays the authority — this only shapes what gets sampled.
//
// Emission order matters: params are pushed by the emit* helpers as the
// template literal evaluates left-to-right, keeping placeholder order and
// bind order in lockstep by construction. BPM bounds are Joi-validated
// numbers (0-1000, min<=max) and are inlined as literals; key names are
// strings and stay parameterised.
//
// Exported for tests.
export function buildTierOrderExpr(body) {
  const haveBpm = Array.isArray(body.bpmRanges) && body.bpmRanges.length > 0;
  const haveKey = Array.isArray(body.musicalKeys) && body.musicalKeys.length > 0;
  if (!haveBpm && !haveKey) { return null; }

  const params = [];
  const ranges = haveBpm
    ? body.bpmRanges.map((r) => `(t.bpm BETWEEN ${Number(r.min)} AND ${Number(r.max)})`).join(' OR ')
    : null;
  const keys = haveKey ? expandCamelotCodes(body.musicalKeys) : null;
  const keyPh = haveKey ? keys.map(() => '?').join(',') : null;

  // 'good' = present AND inside the set; 'wrong' = present AND outside.
  // A missing dimension is neither (classifyRow's 'na').
  const bpm = (negate) => {
    if (!haveBpm) { return '0'; }
    return `(t.bpm IS NOT NULL AND ${negate ? 'NOT ' : ''}(${ranges}))`;
  };
  const key = (negate) => {
    if (!haveKey) { return '0'; }
    params.push(...keys);
    return `(t.musical_key IS NOT NULL AND t.musical_key ${negate ? 'NOT ' : ''}IN (${keyPh}))`;
  };

  const expr = `CASE
    WHEN (${bpm(false)} AND NOT ${key(true)}) OR (${key(false)} AND NOT ${bpm(true)}) THEN 0
    WHEN NOT ${bpm(true)} AND NOT ${key(true)} THEN 1
    ELSE 2 END`;
  return { expr, params };
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

  // Every step samples a small pool instead of materialising every match
  // (audit M5 — the terminal step used to ship the entire in-scope library
  // to JS per pick). When the request carries BPM/key constraints,
  // `tierOrder` leads the ORDER BY so the pool always contains the best
  // tier present (see buildTierOrderExpr); the id cooldown is excluded in
  // SQL first, and when that alone leaves the step short of `limit` fresh
  // rows (with one song asked: empty), the SAME step retries without it so
  // cooldown exhaustion falls back to repeats WITHIN this step's
  // constraints (matching finalisePick's fallback). The fresh rows stay in
  // front of the merged result so the repeats only fill what's left.
  //
  // The retry is skipped for artist-cooldown-ENFORCING steps
  // (allowRepeatRetry false) that came back with NO fresh row: their
  // all-cooled rows would be rejected by the step loop's id-fresh rule
  // anyway (see runRandomSongs), so returning empty lets the waterfall
  // advance toward the drop-cooldown step without paying for a query
  // whose result is discarded. An enforcing step that has SOME fresh rows
  // wins regardless, so its batch is topped up like any other step's.
  //
  // With negative seeds in play (`lessLike`), the `ll` result column (see
  // runRandomSongs) sorts like-a-skip rows behind the rest of their tier —
  // an alias, so it adds no bind parameter — and the top-up counts only
  // rows that are NOT like a skip: a fresh pool made only of like-a-skip
  // rows still fetches the repeats that are not (tier > not like a skip >
  // fresh > oldest repeat, see finalisePick).
  const { ignoreIds, allowRepeatRetry, tierOrder, limit, lessLike } = bounded;
  const orderBy = 'ORDER BY ' + [tierOrder?.expr, lessLike ? 'll' : null, 'RANDOM()'].filter(Boolean).join(', ');
  const tierParams = tierOrder ? tierOrder.params : [];
  const attempt = (excludeIgnored) => {
    const exclude = excludeIgnored && ignoreIds.length > 0
      ? ` AND t.id NOT IN (${ignoreIds.map(() => '?').join(',')})`
      : '';
    return d.prepare(`${sql}${exclude} ${orderBy} LIMIT ${SIMPLE_POOL_LIMIT}`)
      .all(...baseParams, ...params, ...(exclude ? ignoreIds : []), ...tierParams);
  };
  const rows = attempt(true);
  if (cleanCount(rows, lessLike) >= limit || ignoreIds.length === 0) { return rows; }
  if (rows.length === 0 && !allowRepeatRetry) { return rows; }
  return mergeRows(rows, attempt(false));
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
//
// `negHashes` (the hashes behind the request's path NEGATIVES, see the
// less-like section) is the conflict guard: a positive path seed that is
// also a negative is dropped before the centroid — the client's rolling
// anchor can still hold the song the user just skipped. When that would
// leave no positive at all (the user skipped the locked pin), the positives
// win: all are kept and those negatives are reported back as ignored. The
// same happens when the guarded centroid's pool comes back EMPTY (the
// surviving seed alone has no neighbour above the bar the full centroid
// had), and — `conflictGuard` false — when the pick that used a guarded
// pool found nothing in scope (pickSongs re-runs once with the guard off):
// a negative never turns a working request into the "similarity range" 400.
// `guarded` on the result says the centroid left seeds out. The pool still
// drops EVERY sent path seed, dropped-from-centroid or not, so "the seeds
// are never played" and `poolSize` keep their meaning.
// Computed pools cached per (index identity, seed set, threshold). A
// locked-anchor session and the client's queue-ahead calls repeat the exact
// same key on every pick, so the full-index dot scan (audit H8's third leg)
// runs once per anchor instead of once per pick; the rolling anchor changes
// its seed set each pick and recomputes — one pass over the (now
// contiguous) matrix, cheap. WeakMap on the index: a rebuilt index drops
// every cached pool with it. Entries are shared by reference and must be
// treated as immutable by callers.
const sonicPoolCache = new WeakMap();   // index -> Map<key, {seedVec, allowed, json}>
const SONIC_POOL_CACHE_MAX = 8;

// Whether the body asks for a sonic pool at all.
function hasSonicSeed(body) {
  return (Array.isArray(body.similarTo) && body.similarTo.length > 0) || !!body.similarToVector;
}

// Resolve the positive seed(s): everything about the sonic pool that can
// 403 / 404 / 400, and nothing that scans the index. buildSonicPool starts
// here; the route handler also calls it on its own, BEFORE the negatives'
// warm-up, when a request carries both — so a bad positive fails before any
// cosine pass is paid for (a path seed then resolves twice, two indexed
// probes). Returns the index and either `vector` (the similarToVector form)
// or `seeds` ({hash, vec} per similarTo path, in request order).
function resolveSonicSeeds(req, body) {
  const index = requireIndex();

  if (body.similarToVector) {
    // A seed from somewhere this server can't see — the caller averaged the
    // vectors of what is playing (possibly across several servers) and sent
    // the result. Nothing downstream of the pool cares where a vector came
    // from, so only the decode and the model check are new.
    //
    // A mismatch is a hard 400 here, unlike the federation peer route's soft
    // `modelMismatch`. That route answers a RANKING, where "no results" is a
    // truthful empty answer; this one answers "what do I play next", and
    // comparing across model spaces would return confident nonsense — tracks
    // with no real relationship to the seed. The caller is expected to have
    // read this server's model id first and skip it when it disagrees, so
    // reaching here at all is a bug worth surfacing.
    if (body.similarToModelId !== index.modelId) {
      throw new WebError(
        `Sonic seed is from model '${body.similarToModelId}', this library is indexed with '${index.modelId}'`, 400);
    }
    if (index.dim === null) {
      throw new WebError('No tracks have been analyzed yet', 400);
    }
    return { index, vector: decodeSeedVector(index, body.similarToVector), seeds: [] };
  }

  const seeds = [];
  for (const p of body.similarTo) {
    const row = resolveSeedTrack(req, p, 'random-songs sonic');
    const canonHash = row.audio_hash || row.file_hash;
    const entry = canonHash ? index.byHash.get(canonHash) : null;
    if (!entry) {
      throw new WebError('Sonic seed track has not been analyzed yet', 400);
    }
    seeds.push({ hash: canonHash, vec: entry.vec });
  }
  return { index, vector: null, seeds };
}

function buildSonicPool(req, body, negHashes = null, conflictGuard = true) {
  const { index, vector, seeds } = resolveSonicSeeds(req, body);

  const vecs = [];
  const seedHashes = seeds.map((s) => s.hash);
  // Path negatives the conflict guard refused to honour (see above). Empty
  // for the vector form: a vector seed has no identity to compare.
  const ignoredNegatives = new Set();
  let seedKey;
  let guarded = false;

  if (vector) {
    vecs.push(vector);
    // Content-addressed so the pool cache behaves exactly as it does for the
    // filepath form: the same vector and threshold hit the same entry.
    seedKey = `vec:${createHash('sha1').update(body.similarToVector).digest('hex')}`;
  } else {
    // The conflict guard: the centroid is built from the seeds that are not
    // also negatives — unless that leaves none, or the guard is off (see
    // the header: the positives win, the clashing negatives are ignored).
    let kept = seeds;
    if (negHashes && negHashes.size > 0) {
      kept = seeds.filter((s) => !negHashes.has(s.hash));
      if (kept.length === 0 || !conflictGuard) {
        kept = seeds;
        for (const s of seeds) { if (negHashes.has(s.hash)) { ignoredNegatives.add(s.hash); } }
      }
    }
    guarded = kept.length !== seeds.length;
    for (const s of kept) { vecs.push(s.vec); }
    seedKey = kept.map((s) => s.hash).sort().join('|');
    // A guarded centroid is a different pool from the plain one over the
    // same sent seeds: the key says which seeds were dropped. Without a
    // conflict the key is exactly what it always was.
    if (guarded) {
      seedKey += `~${[...seedHashes].sort().join('|')}`;
    }
  }

  const cacheKey = `${seedKey}@${body.minSimilarity}`;
  let perIndex = sonicPoolCache.get(index);
  if (!perIndex) { perIndex = new Map(); sonicPoolCache.set(index, perIndex); }
  let entry = perIndex.get(cacheKey);
  if (entry) {
    perIndex.delete(cacheKey); perIndex.set(cacheKey, entry);   // LRU touch
  } else {
    const seedVec = sim.centroidOf(vecs);
    const allowed = sim.hashesWithinThreshold(index, seedVec, body.minSimilarity);
    // The seeds are the session's recent picks (rolling anchor) or the
    // currently-playing song (locked anchor) — Auto-DJ must never answer
    // "what's next" with "the song you just played".
    //
    // A vector seed carries no hashes, so this protection does not apply to it
    // and `ignoreList` becomes the only thing keeping the DJ off the song that
    // is playing. Callers using similarToVector MUST send one.
    for (const h of seedHashes) { allowed.delete(h); }
    // The JSON form is what the SQL pool constraint binds (json_each) —
    // stringified once here so locked-anchor picks don't re-serialize a
    // potentially many-thousand-hash set every request.
    entry = { seedVec, allowed, json: JSON.stringify([...allowed]) };
    perIndex.set(cacheKey, entry);
    while (perIndex.size > SONIC_POOL_CACHE_MAX) {
      perIndex.delete(perIndex.keys().next().value);
    }
  }

  // A guarded centroid with nothing in its pool: the request WITHOUT the
  // negatives had one (the full centroid is a different direction), so the
  // negatives must not be what empties it. Once more with the guard off.
  if (guarded && entry.allowed.size === 0) {
    return buildSonicPool(req, body, negHashes, false);
  }
  return { index, ...entry, ignoredNegatives, guarded };
}

// ── Less like this (negative seeds) ─────────────────────────────────────────
//
// `lessLike` (file paths) and `lessLikeVectors` (+ `lessLikeModelId`) carry
// the session's recent SKIPS — up to LESS_LIKE_MAX in total, paths and
// vectors mixed, with or without a sonic positive. A candidate "is like a
// skip" when its cosine to ANY single negative is at least the threshold
// T. The NEAREST negative, not a centroid: two skips on opposite sides of
// the space average to a point near neither of them (the centroid of two
// orthogonal unit vectors is 0.71 from each), so a centroid both misses
// the actual skips and blocks songs that resemble no skip at all. One
// hashesWithinThreshold pass per negative (the sonic pool's scan), union of
// the sets.
//
// Threshold: T = clamp(minSimilarity + LESS_LIKE_MARGIN, FLOOR, CEIL) while
// a sonic bar is in play, else FLOOR. The positive bar admits everything
// above `minSimilarity`; the negative bar must sit above it or every pool
// member would be like a skip. Rounded to 4 decimals so cache keys are
// stable and the echo equals the value used.
//
// SOFT, never a filter: like-a-skip rows sort LAST (the `ll` column in
// every candidate query, then finalisePick's ranking) and are still
// served when nothing else is left. So negatives never empty a pool, never
// add a 400 and never produce the sonic "similarity range" error — a
// session that skipped half its library still plays. The skip ranks below
// every hard filter and below the BPM/key tier, and above the id cooldown
// (hard filters > tier > not like a skip > fresh > oldest repeat): the
// waterfall's FIRST non-empty step wins exactly as it does without
// negatives — a tighter step whose rows are all like a skip beats a more
// relaxed step's clean rows, and the pick is flagged in the echo — while
// within the winning step, and in simple mode, finalisePick ranks a repeat
// that is not like a skip ahead of a fresh song that is. The one exception
// is the songs served in the last few picks — the newest max(limit × 5, 8)
// entries of the ignoreList (RECENT_PICKS_BATCHES / RECENT_PICKS_MIN) —
// which rank behind every fresh song, so a skip never makes the DJ play
// the song it just played again. A negative that
// cannot be used (unknown or forbidden path, not analysed, another model,
// discovery off, no index, undecodable vector) is IGNORED and counted in
// the echo, one bucket for every reason, so the count cannot be used to
// probe which paths exist.
//
// Cache: `lessLikeCache` is a WeakMap index → Map<"seed@T", Set<hash>>,
// LRU-trimmed at LESS_LIKE_CACHE_MAX. A set is a few hundred references at
// T >= 0.8, and a session repeats the same negatives on every pick, so the
// cosine pass runs once per NEW skip. The WeakMap is the invalidation:
// getIndex() hands out a new object after an epoch or library rebuild, and
// every set cached on the old one goes with it (cold again after a rescan).
//
// Cost note: plain Auto DJ never touched the index before; a plain pick
// with negatives loads it (getIndex is synchronous and holds the matrix in
// memory) on first use. Clients gate on `discoveryReady`, so the index is
// one a sonic query would have built anyway. The handler warms every cold
// (negative, T) set before the synchronous pick (warmLessLike), yielding
// between passes so eight cold skips do not block the event loop for the
// whole batch — after the positive seed's own checks, so a bad positive
// fails before any pass is paid for.
export const AUTO_DJ_GENERATION = 1;
export const LESS_LIKE_MAX = 8;
export const LESS_LIKE_CACHE_MAX = 64;
const LESS_LIKE_FLOOR = 0.80;
const LESS_LIKE_CEIL = 0.95;
const LESS_LIKE_MARGIN = 0.10;
const lessLikeCache = new WeakMap();   // index -> Map<"seedKey@T", Set<hash>>
// Sets a PICK had to compute itself (a warm-up miss, or no warm-up) — the
// route-level test reads it to prove the handler's warm-up did the work.
let lessLikeColdInPick = 0;

// With negatives in play, how many of the newest ignoreList entries count
// as "just served": max(limit × RECENT_PICKS_BATCHES, RECENT_PICKS_MIN).
// Those rank behind every fresh song in finalisePick, like a skip or not,
// and among themselves oldest first; older repeats that are not like a
// skip keep ranking ahead of fresh songs that are. The window is counted
// in list entries, and the list also holds picks the client REJECTED
// without playing them, so it has to cover a client's whole retry loop:
// the webapp retries a pick up to 5 times at its limit (MAX_RETRIES in
// webapp/assets/js/mstream.player.js, _autoDjRunOnce) and the phone asks
// batches of four and retries a blocked batch up to 5 times as well
// (mstream_music lib/media/audio_stuff.dart; the terminal player's
// DEFAULT_SONGS_PER_FETCH is four too), each feeding the answer's
// ignoreList into the next attempt. RECENT_PICKS_BATCHES is that retry
// count: five batches' worth holds the batch playing now behind the four
// batches the client rejected, so the fifth attempt still finds it in the
// window. At limit 1 the minimum applies — the webapp queues one or two
// songs ahead, so on the fifth attempt the song playing now sits behind
// two queued and four rejected entries, seven deep; eight keeps a spare.
// A window narrower than the client's retry loop let a run of rejected
// picks push the playing song out of it, where, as a clean older repeat,
// it outranked every fresh like-a-skip song and came straight back. From
// limit 10 up the window (5 × 10 = 50) covers the whole list the server
// hands back (IGNORE_COOLDOWN_MAX), so every repeat is "just served" and
// the order falls back to the plain one — fresh songs (clean before like a
// skip), then every repeat oldest first.
export const RECENT_PICKS_MIN = 8;
export const RECENT_PICKS_BATCHES = 5;

// The negative threshold for a request (see the rule above). Exported for
// tests.
export function lessLikeThreshold(minSimilarity) {
  let t = LESS_LIKE_FLOOR;
  if (typeof minSimilarity === 'number' && Number.isFinite(minSimilarity)) {
    t = Math.min(LESS_LIKE_CEIL, Math.max(LESS_LIKE_FLOOR, minSimilarity + LESS_LIKE_MARGIN));
  }
  return Math.round(t * 1e4) / 1e4;
}

// Whether the body carries any negative seed at all — the echo is sent iff
// this is true, discovery on or off.
function hasLessLike(body) {
  return (Array.isArray(body.lessLike) && body.lessLike.length > 0)
    || (Array.isArray(body.lessLikeVectors) && body.lessLikeVectors.length > 0);
}

// The negatives as sent, sanitised for internal callers that bypass Joi
// (the same defence as pickLimitFrom): strings only, the total clamped to
// LESS_LIKE_MAX, paths first.
function lessLikeInputs(body) {
  const strings = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string') : []);
  const paths = strings(body.lessLike).slice(0, LESS_LIKE_MAX);
  const vectors = strings(body.lessLikeVectors).slice(0, LESS_LIKE_MAX - paths.length);
  return { paths, vectors };
}

// Resolve the request's negatives against the index. Never throws. Returns
// the index (null when there is none to score against), how many negatives
// were sent, the usable seeds ({key, hash|null, vec}) and the set of path
// hashes (the conflict guard's input). Every reason for dropping one lands
// in the same `sent - seeds.length` bucket.
function resolveLessLike(req, body) {
  const { paths, vectors } = lessLikeInputs(body);
  const sent = paths.length + vectors.length;
  const index = optionalIndex();
  const seeds = [];
  const pathHashes = new Set();
  if (!index) { return { index: null, sent, seeds, pathHashes }; }
  for (const p of paths) {
    const hash = seedHashForPath(req, p);
    const entry = hash ? index.byHash.get(hash) : null;
    if (!entry) { continue; }
    seeds.push({ key: `hash:${hash}`, hash, vec: entry.vec });
    pathHashes.add(hash);
  }
  if (vectors.length > 0 && body.lessLikeModelId === index.modelId) {
    for (const b64 of vectors) {
      let vec;
      try { vec = decodeSeedVector(index, b64); } catch (_) { continue; }
      seeds.push({ key: `vec:${createHash('sha1').update(b64).digest('hex')}`, hash: null, vec });
    }
  }
  return { index, sent, seeds, pathHashes };
}

function lessLikeEntries(index) {
  let perIndex = lessLikeCache.get(index);
  if (!perIndex) { perIndex = new Map(); lessLikeCache.set(index, perIndex); }
  return perIndex;
}

// The hashes within T of one negative — cached per (index, seed, T), LRU.
// `inPick` marks a call from the synchronous pick (lessLikeUnion) rather
// than the handler's warm-up; a miss there is counted (lessLikeColdInPick).
function negativeSet(index, seed, threshold, inPick = false) {
  const perIndex = lessLikeEntries(index);
  const key = `${seed.key}@${threshold}`;
  const hit = perIndex.get(key);
  if (hit) {
    perIndex.delete(key); perIndex.set(key, hit);   // LRU touch
    return hit;
  }
  if (inPick) { lessLikeColdInPick++; }
  const set = sim.hashesWithinThreshold(index, seed.vec, threshold);
  perIndex.set(key, set);
  while (perIndex.size > LESS_LIKE_CACHE_MAX) {
    perIndex.delete(perIndex.keys().next().value);
  }
  return set;
}

// The request's like-a-skip set: the union over every usable negative that
// the conflict guard did not drop (`dropped` = buildSonicPool's
// ignoredNegatives, path hashes). `json` is the SQL-bound form, null when
// the union is empty so the candidate queries stay byte-identical to a
// request without negatives.
function lessLikeUnion(neg, threshold, dropped) {
  const union = new Set();
  let used = 0;
  if (neg.index) {
    for (const seed of neg.seeds) {
      if (dropped && seed.hash !== null && dropped.has(seed.hash)) { continue; }
      used++;
      for (const h of negativeSet(neg.index, seed, threshold, true)) { union.add(h); }
    }
  }
  return {
    used,
    ignored: neg.sent - used,
    threshold,
    json: union.size > 0 ? JSON.stringify([...union]) : null,
  };
}

// Compute every COLD (negative, T) set the request will need, yielding to
// the event loop between cosine passes (the rankTracksMulti pattern), so
// the synchronous pick that follows finds cache hits. Sets that are already
// cached cost nothing and no yield. `positiveHashes` are the request's
// resolved similarTo seeds (the handler checks them first, see
// resolveSonicSeeds): when every one of them is also a negative, the
// conflict guard will ignore those negatives, so they are not scored. If the
// index is rebuilt between the warm-up and the pick, runRandomSongs
// computes the missing sets itself — correct, just not yielded.
export async function warmLessLike(req, body, positiveHashes = null) {
  const neg = resolveLessLike(req, body);
  if (!neg.index) { return; }
  const threshold = lessLikeThreshold(body.minSimilarity);
  const perIndex = lessLikeEntries(neg.index);
  const guardedOut = Array.isArray(positiveHashes) && positiveHashes.length > 0
      && positiveHashes.every((h) => neg.pathHashes.has(h))
    ? new Set(positiveHashes)
    : null;
  let computed = 0;
  for (const seed of neg.seeds) {
    if (guardedOut && seed.hash !== null && guardedOut.has(seed.hash)) { continue; }
    if (perIndex.has(`${seed.key}@${threshold}`)) { continue; }
    if (computed > 0) { await new Promise((r) => setImmediate(r)); }
    negativeSet(neg.index, seed, threshold);
    computed++;
  }
}

// How many negative sets are cached against `index` — for tests.
export function lessLikeCacheSizeForTests(index) {
  return lessLikeCache.get(index)?.size ?? 0;
}

// How many negative sets picks have had to compute themselves, ever — for
// the route-level warm-up test.
export function lessLikeColdInPickForTests() {
  return lessLikeColdInPick;
}

// Server-side cooldown ceiling for the round-tripped ignoreList. Deep
// enough that a real session never hears a repeat it would notice, small
// enough that the SQL exclusion in simple mode stays a short IN list.
// (The Joi wire cap of 500 stays as defense-in-depth headroom.)
const IGNORE_COOLDOWN_MAX = 50;

// Candidate-pool size for every bounded candidate query (simple mode and
// each waterfall step). 50 keeps the pool comfortably larger than the
// cooldown so consecutive picks stay varied even right after a fallback.
// Exported for the invariant test on PICK_LIMIT_MAX.
export const SIMPLE_POOL_LIMIT = 50;

// Most songs one request may ask for (`limit`). Two invariants keep a
// batch cheap and coherent, both pinned by test/integration/random-route.test.mjs:
//   • ≤ SIMPLE_POOL_LIMIT — one bounded pool always holds a full batch,
//     so no query grows with the request, and a pool that comes back
//     short has provably shown every fresh candidate in scope.
//   • ≤ IGNORE_COOLDOWN_MAX / 2 — a maximal batch still leaves the whole
//     previous batch in the ignoreList, so back-to-back batches never
//     repeat each other.
export const PICK_LIMIT_MAX = 25;

// Sanitize the client's round-tripped ignoreList to track ids we can bind
// into SQL / compare against rows. Joi already enforces integers >= 0;
// this guards the internal callers that bypass the route schema.
function ignoreIdsFrom(body) {
  const list = Array.isArray(body.ignoreList) ? body.ignoreList : [];
  return list.filter((n) => Number.isInteger(n) && n >= 0);
}

// How many songs the request asks for. Joi defaults `limit` to 1 and caps
// it at PICK_LIMIT_MAX; the clamp here is the same defence-in-depth as
// ignoreIdsFrom for callers that bypass the route schema.
function pickLimitFrom(body) {
  const n = Number(body.limit);
  if (!Number.isInteger(n) || n < 1) { return 1; }
  return Math.min(n, PICK_LIMIT_MAX);
}

// Union of a cooldown-excluding query and its no-exclusion retry over the
// SAME candidate set: the fresh rows first, then whatever the retry added
// (all cooled — a first query that came back short of `limit` rows already
// returned every fresh row in scope, see PICK_LIMIT_MAX). Order matters:
// finalisePick hands out the front of the list, so repeats only ever fill
// what fresh rows couldn't.
function mergeRows(fresh, more) {
  const seen = new Set(fresh.map((r) => r.id));
  const out = [...fresh];
  for (const r of more) {
    if (seen.has(r.id)) { continue; }
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// How many of a candidate query's rows count toward `limit` for the repeat
// top-up: every row without negatives, else only the rows that are NOT
// like a skip (`ll` = 0). A pool whose fresh rows are all like a skip still
// fetches the repeats, because a repeat that is not like a skip outranks
// a fresh song that is (see finalisePick).
function cleanCount(rows, active) {
  if (!active) { return rows.length; }
  let n = 0;
  for (const r of rows) { if (!r.ll) { n++; } }
  return n;
}

export function runRandomSongs(req, body) {
  return pickSongs(req, body, true);
}

// The pick. `conflictGuard` is buildSonicPool's: on when runRandomSongs
// calls, off for the one re-run `exhausted` below makes when a guarded
// centroid's request found nothing in scope.
function pickSongs(req, body, conflictGuard) {
  const d = db.getDB();
  if (!d) { throw new WebError('Database not ready', 400); }

  // Batch size — every bounded query's top-up rule and the final pick
  // honour it (see the header comment).
  const limit = pickLimitFrom(body);

  // Negatives resolve first — they never throw, and the sonic pool's
  // conflict guard needs their path hashes. Their cosine passes run AFTER
  // the positive seed's own checks below (lessLikeUnion; the route handler
  // warms them in the same order, see setup), so a bad positive still
  // fails before any scan is paid for.
  const negatives = hasLessLike(body) ? resolveLessLike(req, body) : null;

  // Sonic pool next — it can 403/404/400 on its own and there's no point
  // running SQL when the seed itself is bad.
  const sonic = hasSonicSeed(body)
    ? buildSonicPool(req, body, negatives ? negatives.pathHashes : null, conflictGuard)
    : null;

  // Nothing in scope. With a GUARDED sonic pool the negatives are to blame
  // — the conflict guard built a narrower centroid than the same request
  // without them would have — so the pick runs once more with the guard
  // off (the positives win, the clashing negatives are ignored and counted)
  // rather than answer a 400 the negatives created. Everything else is the
  // same 400 as always: a filter nothing in scope meets.
  const exhausted = () => {
    if (sonic && sonic.guarded) { return pickSongs(req, body, false); }
    throw new WebError(sonic
      ? 'No songs within the similarity range match criteria'
      : 'No songs that match criteria', 400);
  };

  // The like-a-skip union (null without negatives; `json` null when nothing
  // in the index is within T of a usable negative, in which case the SQL
  // below is byte-identical to a request without negatives).
  const lessLike = negatives
    ? lessLikeUnion(negatives, lessLikeThreshold(body.minSimilarity), sonic ? sonic.ignoredNegatives : null)
    : null;
  const ll = lessLike && lessLike.json ? lessLike : null;

  // Ratings are per-user. A caller with no user id — a federation key, whose
  // synthetic user carries none — has no stars to filter on: a user_metadata
  // join on NULL could only ever empty the pool. Skip it rather than starve
  // a federated Auto DJ pick (the webapp never sends it to a peer; a stray
  // one is harmless now).
  const minRating = (body.minRating && Number(body.minRating) > 0 && req.user?.id)
    ? Number(body.minRating)
    : null;

  // A caller who sees every library gets no library clause at all — it is a
  // no-op for them (see libraryFilter), and as a WHERE term it is worse than
  // useless here: the planner serves it from idx_tracks_library, i.e. one
  // index probe plus a table seek per track, where a candidate query (which
  // visits every in-scope row anyway) wants a straight table scan. It also
  // hoists any term the index alone can answer — the artist cooldown's
  // `t.id NOT IN (...)` — ahead of the BPM/key terms that would have
  // rejected most rows first. Measured at 100k tracks (candidate query
  // alone): a selective BPM+key step under a 15-artist cooldown 32 ms →
  // 9 ms, the same cooldown without BPM/key 40 ms → 27 ms. A partial scope
  // keeps the clause (and the index): with a small visible library the
  // seek is the win.
  //
  // The user_metadata join is the only one the candidate query can need
  // (see its narrow select below), and only for minRating. Its user id
  // binds ahead of every WHERE param.
  const filter = libraryFilter(req.user, body.ignoreVPaths);
  const scoped = !filter.coversAllLibraries;
  const baseConditions = scoped ? [filter.clause] : [];
  const baseParams = [
    ...(minRating !== null ? [req.user.id] : []),
    ...(scoped ? filter.params : []),
  ];
  const ratingJoin = minRating !== null
    ? '\n    LEFT JOIN user_metadata um ON COALESCE(t.audio_hash, t.file_hash) = um.track_hash AND um.user_id = ?'
    : '';

  // An unrated track (no user_metadata row, or a NULL rating) counts as 0
  // stars, which never passes a minRating > 0 — the same rows a bare
  // `um.rating >= ?` keeps. The COALESCE is a PLAN guard, not a semantic
  // one: the bare form rejects NULL, so SQLite turns the LEFT JOIN into
  // an inner join and, with only `tracks t` beside it, drives from
  // idx_user_metadata_user_rating — then re-walks the in-scope tracks for
  // every rated row, because nothing indexes COALESCE(audio_hash,
  // file_hash). Measured 11.6 s per query at 25k tracks (vs 12.6 ms);
  // the plan is pinned by test/db/autodj-cooldown.test.mjs.
  if (minRating !== null) {
    baseConditions.push('COALESCE(um.rating, 0) >= ?');
    baseParams.push(minRating);
  }

  // Genre filter is an ALWAYS-ON base condition (never relaxed by the
  // waterfall). Whitelist mode BLOCKS tracks with zero track_genres
  // rows; blacklist mode ALLOWS them (no overlap with the blocklist).
  // Empty `genres` array → no-op regardless of mode.
  const genre = buildGenreFilter({ genres: body.genres, mode: body.genreMode, source: body.genreSource });
  if (genre.clauses.length > 0) {
    baseConditions.push(...genre.clauses);
    baseParams.push(...genre.params);
  }

  // Track-length window — the other ALWAYS-ON base condition (see
  // buildDurationFilter). Unknown-duration rows are excluded unless the
  // request opts in via allowUnknownDuration. Both bounds absent → no-op.
  const duration = buildDurationFilter({
    minDuration: body.minDuration,
    maxDuration: body.maxDuration,
    allowUnknownDuration: body.allowUnknownDuration,
  });
  if (duration.clauses.length > 0) {
    baseConditions.push(...duration.clauses);
    baseParams.push(...duration.params);
  }

  // Mood filter (api/mood-filter.js) — ALWAYS-ON like the genre filter:
  // the waterfall relaxes BPM / key / artists within it and never the
  // mood, so a filter nothing in scope meets is the 400 below rather
  // than a pick off the user's mood. `body.moods` is the route's parsed,
  // applicable filter (null while the server has no scores to filter
  // by); one track_moods probe per candidate row.
  if (body.moods) {
    baseConditions.push(trackMoodClause(body.moods));
  }

  // Playlist files indexed as tracks (supportedAudioFiles m3u) are never
  // DJ candidates — the player can't stream an .m3u, so serving one spins
  // the client's queue-ahead loop on an unplayable pick. Being artist-less,
  // such rows also survive any ignoreArtists cooldown, which made one the
  // pinned pick of an entire session (see the artistless-rows rule in the
  // step loop below). COALESCE keeps legacy NULL-format rows as candidates.
  baseConditions.push("COALESCE(t.format, '') <> 'm3u'");

  // Sonic pool as a BASE condition, enforced in SQL: the allowed hashes
  // bind as one JSON array through json_each, so every candidate query can
  // stay a bounded random sample. The old shape materialised the entire
  // in-scope library into JS per pick just to intersect it with the Set
  // (audit H8 — 420-640 ms per pick at 25k tracks), because sampling
  // BEFORE intersecting could empty a pool that had matches; intersecting
  // IN the query dissolves that objection. Same relaxation contract as
  // before: the waterfall relaxes BPM/key/artist constraints WITHIN the
  // pool and never the pool itself. (COALESCE is an expression, so no
  // tracks index applies to this clause — but the ephemeral json_each
  // table gets the index, and the bounded scan was already paying the
  // library walk; measured as the cheap side of the trade.)
  if (sonic) {
    baseConditions.push('COALESCE(t.audio_hash, t.file_hash) IN (SELECT value FROM json_each(?))');
    baseParams.push(sonic.json);
  }

  // The candidate queries select only what picking reads: `id` (the
  // id cooldown, mergeRows, the step loop's id-fresh rule) and `bpm` /
  // `musical_key` (rankByTier). Every bounded query ends in
  // `ORDER BY [tier,] RANDOM() LIMIT n`, which visits EVERY row passing
  // WHERE and carries each one's selected columns through the sorter —
  // so the old full trackQuery row (t.* plus the artists / albums /
  // libraries / user_metadata joins) was paid per in-scope track, per
  // step. finalisePick hydrates just the winners through trackQuery
  // (still without its whole-table `tg_agg` genre aggregation — see
  // trackQuery's note), so the wire shape is unchanged.
  //
  // With negatives, a fourth column `ll` (1 = like a skip) joins the
  // select: the ORDER BY alias that ranks those rows last, and what
  // finalisePick reads to keep them last. Its json_each placeholder is
  // lexically the FIRST in the statement — ahead of the rating join's user
  // id and every WHERE parameter — so its value is unshifted onto the
  // params right here, immediately before the SQL is built. (Plan: a
  // non-correlated LIST SUBQUERY over json_each, the outer loop stays the
  // tracks scan; pinned by test/db/autodj-less-like.test.mjs.)
  const llColumn = ll
    ? ', CASE WHEN COALESCE(t.audio_hash, t.file_hash) IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END AS ll'
    : '';
  if (ll) { baseParams.unshift(ll.json); }
  const baseSql = `SELECT t.id, t.bpm, t.musical_key${llColumn} FROM tracks t${ratingJoin} WHERE ${baseConditions.join(' AND ')}`;

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
    // Bounded pick — sonic or not: the pool constraint (when present) is
    // already a base condition above, so both shapes exclude the cooldown
    // ids in SQL and let SQLite keep only a small random pool. The whole
    // in-scope library is never materialised into JS.
    const ignoreIds = ignoreIdsFrom(body);
    const orderBy = ll ? 'ORDER BY ll, RANDOM()' : 'ORDER BY RANDOM()';
    const bounded = (excludeIgnored) => {
      const exclude = excludeIgnored && ignoreIds.length > 0
        ? ` AND t.id NOT IN (${ignoreIds.map(() => '?').join(',')})`
        : '';
      return d.prepare(
        `${baseSql}${exclude} ${orderBy} LIMIT ${SIMPLE_POOL_LIMIT}`
      ).all(...baseParams, ...(exclude ? ignoreIds : []));
    };
    let rows = bounded(true);
    if (cleanCount(rows, !!ll) < limit && ignoreIds.length > 0) {
      // The cooldown leaves fewer fresh songs in scope than asked for
      // (with one song asked: none at all) — fill the rest with repeats
      // rather than stalling the session (same contract as the
      // waterfall's drop-cooldown steps). Fresh rows stay in front. With
      // negatives, only fresh rows that are not like a skip count: a
      // repeat that is not like a skip outranks a fresh song that is.
      rows = mergeRows(rows, bounded(false));
    }
    if (rows.length === 0) { return exhausted(); }
    return finalisePick(req, rows, body, sonic, null, lessLike);
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

  // Every step's query is bounded the same way simple mode is. The two
  // reasons bounding used to switch off are both gone: the sonic pool is
  // now a SQL base condition (no JS-side intersection to starve), and BPM/
  // key requests lead the ORDER BY with a tier expression so the pool
  // provably contains the best tier present (buildTierOrderExpr above).
  const tierOrder = (hasBpm || hasKey) ? buildTierOrderExpr(body) : null;
  const ignoreIds = ignoreIdsFrom(body);
  const ignoreSet = new Set(ignoreIds);

  let rows = [];
  for (const step of steps) {
    if (!step.gate()) { continue; }
    const opts = step.opts();
    // Artistless-rows rule: a step that ENFORCES the artist cooldown
    // must yield at least one id-fresh row to win. Tracks with no
    // artist credits trivially survive the ignoreArtists exclusion, so
    // when the cooldown covers every artist in scope they become a
    // step's only survivors — and because the step is then never
    // empty, the drop-cooldown fallback would never fire, pinning the
    // session to those few rows forever. If every survivor is in the
    // id cooldown the pick would be a repeat anyway; taking it from
    // the drop-cooldown pool below instead restores real variety
    // (id-fresh tracks by cooled artists). The drop-cooldown step
    // always exists when ignoreArtists is set, and it accepts
    // all-cooled rows (finalisePick then repeats), so the session
    // still never stalls.
    const enforcesCooldown = Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0;
    // The sonic pool constrains EVERY step via the base conditions — the
    // waterfall relaxes BPM/key/artist constraints WITHIN the pool and
    // never relaxes the pool itself (including the final unrestricted
    // step).
    const candidate = runWaterfallQuery(
      d, baseSql, baseParams, opts,
      { ignoreIds, allowRepeatRetry: !enforcesCooldown, tierOrder, limit, lessLike: !!ll },
    );
    if (candidate.length === 0) { continue; }
    if (enforcesCooldown && candidate.every((r) => ignoreSet.has(r.id))) { continue; }
    // Negatives change nothing here: the first non-empty step wins even
    // when its every row is like a skip and a later, more relaxed step
    // holds one that is not. The step is the request's hard word (its
    // filters, its artist constraints, its BPM/key tier) and the skip is
    // advice, ranked below it — like-a-skip rows go to the back of THIS
    // step (ORDER BY ll, then finalisePick) and the echo flags the pick.
    // Advancing past the step would trade an in-range song for an
    // off-range one, and a batch would then carry a tail its head's
    // constraint does not cover.
    rows = candidate;
    break;
  }

  if (rows.length === 0) { return exhausted(); }

  // Ranked against the ORIGINAL request constraints inside finalisePick,
  // so that even after the chain drops the SQL filter, in-range rows are
  // served first.
  return finalisePick(req, rows, body, sonic, {
    bpmRanges: body.bpmRanges,
    musicalKeys: body.musicalKeys,
  }, lessLike);
}

// Turn the winning candidate rows into the response: the first `limit`
// rows in priority order, the advanced cooldown, (sonic mode) the picks'
// similarities, and (negatives sent) the less-like echo.
//
// Priority: tier > not just served > not like a skip > fresh > oldest
// repeat. The cooldown is soft — best-effort variety — while the tier
// ranking guards the BPM/key promise the request made, so a recently-served
// in-range row outranks a never-served unknown-tag row. The negatives sit
// between the tier and the cooldown: a skip is a stronger signal than
// "played a while ago" (the user said no to this sound; a repeat merely
// risks boredom), so within a tier a repeat that is not like a skip comes
// before a fresh song that is, but a like-a-skip in-range song still beats
// an off-range one, because the BPM/key promise is the request's hard word
// and the skip is advice. "Played a while ago" is the operative part: the
// songs served in the last few picks — the newest max(limit ×
// RECENT_PICKS_BATCHES, RECENT_PICKS_MIN) entries of the ignoreList, wide
// enough to hold a client's queue-ahead and the picks it rejected and
// retried (see the constants) — rank behind every fresh song, like a skip
// or not, and among themselves purely by age, so a skip can never make the
// DJ play the song it just played again (the one failure the cooldown
// exists to prevent), nor a batch repeat the batch before it, even when the
// window covers the whole candidate set (splitting the window by the skip
// would hand a pool smaller than it its one clean song twice running).
// Within the older bands, rows not served recently come first; when the
// cooldown covers the whole candidate set (tiny library / narrow filters /
// long session) the repeats fill in — they beat stalling the session —
// oldest first, by their place in the ignoreList. The song served longest
// ago comes back first and the one just served comes last, so a fully
// cooled pool cycles through itself instead of drawing at random, which
// could serve the same song twice running. Without negatives the bands
// collapse to exactly that order: fresh, then every repeat oldest first.
// Simple mode already excluded the cooled ids in SQL, so its fresh band
// only matters after a repeat top-up; the waterfall passes `tierOpts` so
// its relaxed steps still serve in-range rows first. Every query behind
// `rows` ends in RANDOM(), so while fresh rows remain the front of the
// ordering is a uniform sample and a single pick is as random as it ever
// was.
function finalisePick(req, rows, body, sonic, tierOpts = null, lessLike = null) {
  const limit = pickLimitFrom(body);
  const sent = ignoreIdsFrom(body);
  // Each cooled id's place in the list, newest last (a duplicate keeps
  // its newest place).
  const servedAt = new Map(sent.map((id, i) => [id, i]));
  // The first "just served" place: this one and every newer entry.
  const recentFrom = sent.length - Math.max(limit * RECENT_PICKS_BATCHES, RECENT_PICKS_MIN);
  // The band (see above). `ll` is undefined without negatives, so the
  // like-a-skip bands are then empty and only fresh / older / just-served
  // remain — the plain fresh-then-oldest-repeat order.
  const band = (r) => {
    const at = servedAt.get(r.id);
    if (at === undefined) { return r.ll ? 2 : 0; }   // fresh
    if (at >= recentFrom) { return 4; }              // just served, like a skip or not
    return r.ll ? 3 : 1;                             // an older repeat
  };
  // Stable sort: inside a band, repeats oldest first and fresh rows in
  // their query (RANDOM()) order; then the tier ranking — also stable — on
  // top of the whole.
  let ordered = [...rows].sort((a, b) => (band(a) - band(b))
    || ((servedAt.get(a.id) ?? -1) - (servedAt.get(b.id) ?? -1)));
  if (tierOpts) { ordered = rankByTier(ordered, tierOpts); }
  const picked = ordered.slice(0, limit);

  // Move-to-end + trim: newest last, bounded, no duplicate of any pick.
  // Stale entries (deleted tracks, a pre-rework index-based list) age
  // out through the cap as new picks append.
  const pickedIds = picked.map((r) => r.id);
  const pickedSet = new Set(pickedIds);
  const nextIgnore = sent.filter((id) => !pickedSet.has(id));
  nextIgnore.push(...pickedIds);
  while (nextIgnore.length > IGNORE_COOLDOWN_MAX) { nextIgnore.shift(); }

  // Hydrate the winners: the candidate queries carried only id / bpm /
  // musical_key, so the full trackQuery row (the shape the candidate
  // query itself used to select) is read back for just these ids, in
  // pick order. A winner deleted since its candidate query simply drops
  // out of `songs` (its id still ages out of the ignoreList like any
  // stale entry).
  const d = db.getDB();
  const full = new Map();
  if (pickedIds.length > 0) {
    const hydrated = d.prepare(
      `${trackQuery(req.user?.id, { includeGenres: false })} WHERE t.id IN (${pickedIds.map(() => '?').join(',')})`
    ).all(...(req.user?.id ? [req.user.id] : []), ...pickedIds);
    for (const row of hydrated) { full.set(row.id, row); }
  }
  const songRows = pickedIds.map((id) => full.get(id)).filter(Boolean);

  // Enrich each picked row with `genres_concat` so renderMetadataObj
  // emits a populated `metadata.genres` field. trackQuery above skips
  // its whole-table genre aggregation; these targeted SELECTs cost
  // ~10µs apiece and keep the wire shape contractually identical.
  for (const row of songRows) {
    row.genres_concat = fetchGenresForTrack(d, row.id).genres_concat;
    // V73: performer / composer credits for `metadata.artists` / `composer`.
    Object.assign(row, fetchCreditsForTrack(d, row.id));
  }

  const out = {
    songs: songRows.map((row) => renderMetadataObj(row)),
    ignoreList: nextIgnore,
  };

  // Sonic mode: report each pick's actual cosine vs the seed/centroid (UI
  // display + slider tuning) and how many analyzed tracks are inside the
  // range at all (before the other filters cut it down further).
  // `similarities` is aligned with `songs`; `similarity` stays the first
  // song's value so single-pick callers keep reading one number.
  if (sonic) {
    const similarities = songRows.map((row) => {
      const s = sim.similarityToHash(sonic.index, sonic.seedVec, row.audio_hash || row.file_hash);
      return s === null ? null : Math.round(s * 10000) / 10000;
    });
    out.sonic = {
      similarity: similarities[0],
      similarities,
      poolSize: sonic.allowed.size,
    };
  }

  // Negatives sent (usable or not): how many steered the pick, how many
  // were ignored, the threshold used, and one flag per served song saying
  // whether it is like a skip — aligned with `songs` (built from the
  // hydrated rows, so a winner deleted before hydration drops out of both).
  if (lessLike) {
    const likeIds = new Set(picked.filter((r) => r.ll).map((r) => r.id));
    out.lessLike = {
      used: lessLike.used,
      ignored: lessLike.ignored,
      threshold: lessLike.threshold,
      avoided: songRows.map((row) => likeIds.has(row.id)),
    };
  }

  return out;
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  // async: Express 5 routes a rejected handler promise to the error
  // middleware, and the handler awaits the less-like warm-up (cosine passes
  // yielding between negatives) before the synchronous pick.
  mstream.post('/api/v1/db/random-songs', async (req, res) => {
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
    //   • bpmRanges (and Wide): the Auto-DJ panel sends 3 (normal+half+double);
    //                    16 is room for future tolerance-window UIs.
    //   • musicalKeys:   24 possible Camelot codes; the cap matches.
    const schema = Joi.object({
      // How many songs to return — 1 (the default, and the pre-batch wire
      // shape) up to PICK_LIMIT_MAX. Songs in a batch are distinct, served
      // best-tier-first and fresh-before-repeats from the same bounded pool
      // a single pick uses, and every one of them advances the ignoreList.
      // `songs.length` can fall short of `limit` when fewer candidates are
      // in scope, or when the waterfall step that wins holds fewer matches
      // — the chain never cascades into a relaxed step to fill a batch.
      limit: Joi.number().integer().min(1).max(PICK_LIMIT_MAX).default(1),
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
      // Which genre links the list matches (V79 track_genres.source): 'tag'
      // (the files' own) or 'model' (the discovery model's). Omitted, both.
      genreSource: Joi.string().valid('tag', 'model').optional(),
      // Track-length window, in SECONDS (the units of tracks.duration and
      // of the `duration` field on the wire). Both bounds are independent
      // and optional; 0 means "no bound on this side" so a client can send
      // a persisted zero without meaning it. The 86400 ceiling (24h) is
      // generous headroom over the longest real audiobook chapter — like
      // the BPM bounds it exists to reject garbage loudly rather than
      // silently emit a clause that matches nothing.
      //
      // `allowUnknownDuration` flips NULL handling: absent/false excludes
      // rows the scanner couldn't read a length from, true lets them
      // through alongside the in-range rows. See buildDurationFilter.
      minDuration: Joi.number().min(0).max(86400).optional(),
      maxDuration: Joi.number().min(0).max(86400).optional(),
      allowUnknownDuration: Joi.boolean().optional(),
      // The browse lists' mood filter (api/mood-filter.js), validated —
      // strictly, a 400 on anything else — by parseMoods below.
      moods: Joi.any(),
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
      //   • similarToVector / similarToModelId: the same seed as a raw
      //                    vector, for a caller whose seed lives on a
      //                    DIFFERENT server — a filepath means nothing here,
      //                    but a vector does. Base64 of dim × float32
      //                    little-endian, same wire form the federation peer
      //                    route takes. The model id is required and must
      //                    match this library's: vectors only compare within
      //                    one model space, and a silent cross-space compare
      //                    returns confident nonsense.
      similarTo: Joi.array().items(Joi.string()).min(1).max(8).optional(),
      similarToVector: Joi.string().base64().optional(),
      similarToModelId: Joi.string().optional(),
      minSimilarity: Joi.number().min(0).max(1).optional(),
      // Less like this (negative seeds) — the SOFT counterpart of the sonic
      // seed, see the less-like section above. Paths and vectors may come
      // together, with or without a positive seed.
      //   • lessLike:        1-8 file paths of songs the session skipped
      //                      (the `similarTo` form). One that cannot be
      //                      used — unknown or forbidden, not analysed —
      //                      is ignored and counted, never a 404.
      //   • lessLikeVectors: 1-8 raw vectors (the `similarToVector` form:
      //                      base64 of dim × float32 little-endian) for
      //                      skips that live on another server; requires
      //                      lessLikeModelId. A vector of the wrong size,
      //                      zero or non-finite is ignored and counted.
      //   • lessLikeModelId: the vectors' model. A mismatch IGNORES the
      //                      vectors (unlike similarToModelId's 400): the
      //                      negatives are advice, and a session that
      //                      spans model spaces must not stall on it.
      //                      Accepted alone, where it does nothing.
      // At most LESS_LIKE_MAX negatives in total (the .custom() below).
      lessLike: Joi.array().items(Joi.string()).min(1).max(LESS_LIKE_MAX).optional(),
      lessLikeVectors: Joi.array().items(Joi.string().base64()).min(1).max(LESS_LIKE_MAX).optional(),
      lessLikeModelId: Joi.string().optional(),
      // One seed form or the other, never both — they would disagree.
      // Each form carries its own required peers; `.and()` can't express that
      // (it would demand the peers of BOTH forms at once), so this is .with()
      // one way plus an explicit check that a threshold never arrives without
      // a seed to apply it to.
    }).oxor('similarTo', 'similarToVector')
      .with('similarTo', 'minSimilarity')
      .with('similarToVector', ['similarToModelId', 'minSimilarity'])
      .with('lessLikeVectors', 'lessLikeModelId')
      .custom((v, helpers) => {
        if (v.minSimilarity !== undefined
            && v.similarTo === undefined && v.similarToVector === undefined) {
          return helpers.error('any.custom', { message: 'minSimilarity needs a seed: similarTo or similarToVector' });
        }
        return v;
      }, 'sonic seed pairing')
      // The negatives' total cap spans both forms, which a per-array max
      // cannot express. helpers.message (not helpers.error with a message
      // option, which this Joi renders as an empty reason) so the 400 says
      // what was wrong.
      .custom((v, helpers) => {
        if ((v.lessLike?.length ?? 0) + (v.lessLikeVectors?.length ?? 0) > LESS_LIKE_MAX) {
          return helpers.message({ custom: `lessLike and lessLikeVectors take at most ${LESS_LIKE_MAX} negative seeds in total` });
        }
        return v;
      }, 'less-like total')
      // Backwards duration window ({minDuration: 600, maxDuration: 60}) is
      // the same class of typo as a backwards bpmRange: it produces a
      // clause that matches nothing, and because the duration filter is
      // never relaxed by the waterfall it would 400 every pick for the
      // rest of the session with no hint as to why. Reject at the
      // boundary. Only fires when BOTH bounds are real (>0) — a lone
      // bound, or a persisted 0 meaning "no bound", constrains nothing
      // on its side and can't be backwards.
      .custom((v, helpers) => {
        if (v.minDuration > 0 && v.maxDuration > 0 && v.minDuration > v.maxDuration) {
          return helpers.error('any.custom', { message: 'minDuration must be <= maxDuration' });
        }
        return v;
      }, 'duration window ordering');
    const { value } = joiValidate(schema, req.body || {});

    // The answer echoes the filter it applied ({} when none) while this
    // server has mood scores, and leaves `moods` out otherwise — what a
    // server older than the filter answers — so a caller that asked a
    // connected server can tell an unfiltered pick from a filtered one.
    const { moods, echo } = applicableMoods(parseMoods(value.moods));
    const body = { ...value, moods };
    if (hasLessLike(body)) {
      // The positive seed's own checks come first (the 403 / 404 / 400 of
      // resolveSonicSeeds), so a bad positive fails before any negative's
      // cosine pass is paid for — the same order the pick keeps. Then every
      // cold negative set is scored, yielding between passes, so the
      // synchronous pick below only reads the cache (see warmLessLike).
      const positive = hasSonicSeed(body) ? resolveSonicSeeds(req, body) : null;
      await warmLessLike(req, body, positive ? positive.seeds.map((s) => s.hash) : null);
    }
    res.json({ ...runRandomSongs(req, body), ...(echo && { moods: echo }) });
  });
}
