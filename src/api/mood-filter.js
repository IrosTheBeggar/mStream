// Mood filters over track_moods (V80 — src/db/mood-sync.js mirrors the
// discovery model's mood heads into it): the one definition of what a
// "relaxed", "neutral" or "vocals" song is, shared by the browse lists
// (/db/albums, /db/artists), the song lists (/db/rated, /db/recent/added),
// the Discover page (/discovery/taste) and the peer side of its federation
// fan-out (/federation/discovery/similar).
//
// A filter is an object of up to four groups. A group left out does not
// filter:
//   valence  'happy' | 'neutral' | 'sad'
//   energy   'relaxed' | 'neutral' | 'aggressive'
//   voice    'instrumental' | 'vocals'
//   tags     any of 'acoustic', 'party', 'danceable' — every one must hold
// A song matches when every group the filter names holds for it. The two
// scales pair opposite heads, and every analysed song is exactly one of
// their three values: happy when its happy score reaches the threshold and
// is at least its sad score, sad when sad reaches it and beats happy,
// neutral when neither reaches it (relaxed / aggressive alike). A song with
// no track_moods row (not analysed yet) matches no filter.
//
// Albums and artists match when MORE than half of their analysed songs
// match — "most of it is relaxed" — counted over the songs the caller can
// see. The subqueries are non-correlated `id IN (… GROUP BY … HAVING …)`
// sets, one pass over the visible analysed tracks: a correlated EXISTS per
// album or artist re-scans the library per row (see getArtists in db.js).

import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

// The mood heads' tagThreshold (discovery-features-lib.js): the score at
// which a head's label is exported, and here the score at which it holds.
export const MOOD_THRESHOLD = 0.5;

export const VALENCE = Object.freeze(['happy', 'neutral', 'sad']);
export const ENERGY = Object.freeze(['relaxed', 'neutral', 'aggressive']);
export const VOICE = Object.freeze(['instrumental', 'vocals']);
export const MOOD_TAGS = Object.freeze(['acoustic', 'party', 'danceable']);

// Strict: a group this server does not know is refused, never ignored — a
// caller must not take an unfiltered answer for a filtered one.
export const moodFilterSchema = Joi.object({
  valence: Joi.string().valid(...VALENCE),
  energy: Joi.string().valid(...ENERGY),
  voice: Joi.string().valid(...VOICE),
  tags: Joi.array().items(Joi.string().valid(...MOOD_TAGS)).unique().max(MOOD_TAGS.length),
});

/**
 * The canonical form of a validated filter: only the groups that filter,
 * tags in MOOD_TAGS order — or null when nothing does.
 */
export function normalizeMoods(value) {
  if (!value || typeof value !== 'object') { return null; }
  const out = {};
  if (value.valence) { out.valence = value.valence; }
  if (value.energy) { out.energy = value.energy; }
  if (value.voice) { out.voice = value.voice; }
  const tags = MOOD_TAGS.filter((t) => Array.isArray(value.tags) && value.tags.includes(t));
  if (tags.length) { out.tags = tags; }
  return Object.keys(out).length ? out : null;
}

/** Validate + normalize a request's filter (undefined/null → null). */
export function parseMoods(raw) {
  if (raw === undefined || raw === null) { return null; }
  const { value } = joiValidate(moodFilterSchema.required(), raw);
  return normalizeMoods(value);
}

/**
 * The federation responder's form: a JSON object in the `moods` query
 * parameter (its body schema is strict, and a peer older than the filter
 * must keep answering — it ignores the query string). 400 on anything that
 * is not one valid filter.
 */
export function parseMoodsQuery(raw) {
  if (raw === undefined) { return null; }
  if (typeof raw !== 'string' || raw.length > 512) { throw new WebError('Invalid moods parameter', 400); }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_e) {
    throw new WebError('Invalid moods parameter', 400);
  }
  return parseMoods(obj);
}

/**
 * Whether this server can filter by mood RIGHT NOW: the heads are on and
 * at least one song has scores. Answers that can carry a filter say so by
 * echoing it (applicableMoods); a client shows its filters on that echo,
 * or on server-info's `moodFilters` flag for the local Discover page and
 * the song lists (bare arrays, with no room for an echo).
 */
export function moodFiltersReady() {
  if (config.program.scanOptions?.analyzeMoods === false) { return false; }
  return !!db.getDB().prepare('SELECT 1 FROM track_moods LIMIT 1').get();
}

/**
 * What a route does with a parsed filter: `moods` is the filter to apply
 * (null = none), `echo` the `moods` key its answer carries — the filter it
 * applied, {} when none. While this server has no scores to filter by,
 * nothing is applied and `echo` is undefined: the key is left out, exactly
 * as every server older than the filter answers, so a client reads both
 * the same way (hide the filters, drop the request's).
 */
export function applicableMoods(requested) {
  if (!moodFiltersReady()) { return { moods: null, echo: undefined }; }
  return { moods: requested, echo: requested || {} };
}

// Head-score conditions, one per group value, over a track_moods alias.
// The threshold is a constant, not a bound parameter, so every caller can
// splice the predicate anywhere (CASE WHEN, a WHERE, a HAVING).
function scale(tm, value, [lo, hi]) {
  const t = MOOD_THRESHOLD;
  if (value === 'neutral') { return `(${tm}.${lo} < ${t} AND ${tm}.${hi} < ${t})`; }
  if (value === lo) { return `(${tm}.${lo} >= ${t} AND ${tm}.${lo} >= ${tm}.${hi})`; }
  return `(${tm}.${hi} >= ${t} AND ${tm}.${hi} > ${tm}.${lo})`;
}

/** The SQL condition a song's track_moods row (alias `tm`) must meet. */
export function moodPredicate(moods, tm = 'tm') {
  const parts = [];
  if (moods.valence) { parts.push(scale(tm, moods.valence, ['happy', 'sad'])); }
  if (moods.energy) { parts.push(scale(tm, moods.energy, ['relaxed', 'aggressive'])); }
  if (moods.voice === 'instrumental') { parts.push(`${tm}.instrumental >= ${MOOD_THRESHOLD}`); }
  if (moods.voice === 'vocals') { parts.push(`${tm}.instrumental < ${MOOD_THRESHOLD}`); }
  for (const tag of moods.tags || []) { parts.push(`${tm}.${tag} >= ${MOOD_THRESHOLD}`); }
  return parts.length ? parts.join(' AND ') : '1=1';
}

// The ids (of `col` — album_id / artist_id) whose visible analysed songs
// mostly match. `filter` is a libraryFilter() over alias t.
function majoritySet(col, moods, filter) {
  return {
    sql: `SELECT t.${col} FROM tracks t JOIN track_moods tm ON tm.track_id = t.id
           WHERE t.${col} IS NOT NULL AND ${filter.clause}
           GROUP BY t.${col}
          HAVING 2 * SUM(CASE WHEN ${moodPredicate(moods)} THEN 1 ELSE 0 END) > COUNT(*)`,
    params: [...filter.params],
  };
}

/** `EXISTS (…)` — the song `${t}.id` matches (one PK probe; a song not
 * analysed yet never does). The song lists' clause. */
export function trackMoodClause(moods, t = 't') {
  return `EXISTS (SELECT 1 FROM track_moods tm WHERE tm.track_id = ${t}.id AND ${moodPredicate(moods)})`;
}

/** `al.id IN (…)` — albums most of whose visible analysed songs match. */
export function albumMoodClause(moods, filter) {
  const s = majoritySet('album_id', moods, filter);
  return { sql: `al.id IN (${s.sql})`, params: s.params };
}

/** `a.id IN (…)` — artists most of whose visible analysed songs (as the
 * track's primary artist) match. */
export function artistMoodClause(moods, filter) {
  const s = majoritySet('artist_id', moods, filter);
  return { sql: `a.id IN (${s.sql})`, params: s.params };
}

const CHUNK = 500;

/** The ids among `ids` whose songs match, as a Set — chunked IN probes. */
export function matchingTrackIds(d, moods, ids) {
  const out = new Set();
  const pred = moodPredicate(moods);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = d.prepare(`SELECT tm.track_id AS id FROM track_moods tm
      WHERE tm.track_id IN (${slice.map(() => '?').join(',')}) AND ${pred}`).all(...slice);
    for (const r of rows) { out.add(r.id); }
  }
  return out;
}

/**
 * The album ids among `albumIds` most of whose analysed songs in the given
 * libraries (any iterable of ids; null = every library) match — the
 * Discover page's album cards.
 */
export function matchingAlbumIds(d, moods, albumIds, libIds = null) {
  const out = new Set();
  const libs = libIds == null ? null : [...libIds];
  if (libs && libs.length === 0) { return out; }
  const lib = libs ? ` AND t.library_id IN (${libs.map(() => '?').join(',')})` : '';
  for (let i = 0; i < albumIds.length; i += CHUNK) {
    const slice = albumIds.slice(i, i + CHUNK);
    const rows = d.prepare(`SELECT t.album_id AS id FROM tracks t JOIN track_moods tm ON tm.track_id = t.id
      WHERE t.album_id IN (${slice.map(() => '?').join(',')})${lib}
      GROUP BY t.album_id
     HAVING 2 * SUM(CASE WHEN ${moodPredicate(moods)} THEN 1 ELSE 0 END) > COUNT(*)`).all(...slice, ...(libs || []));
    for (const r of rows) { out.add(r.id); }
  }
  return out;
}

/** (trackId) => whether that song matches — one PK lookup per call. */
export function trackMatcher(d, moods) {
  const stmt = d.prepare(`SELECT 1 FROM track_moods tm WHERE tm.track_id = ? AND ${moodPredicate(moods)}`);
  return (trackId) => !!stmt.get(trackId);
}

/**
 * (canonical hash) => whether that song matches. Every copy of a song
 * carries the same scores (mood-sync writes them per canonical hash), so
 * any copy answers for all of them.
 */
export function hashMatcher(d, moods) {
  const stmt = d.prepare(`SELECT 1 FROM track_moods tm
    WHERE tm.track_id IN (
            SELECT id FROM tracks WHERE audio_hash = ?
            UNION ALL
            SELECT id FROM tracks WHERE file_hash = ? AND audio_hash IS NULL
          )
      AND ${moodPredicate(moods)}
    LIMIT 1`);
  return (hash) => !!stmt.get(hash, hash);
}
