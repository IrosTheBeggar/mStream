// Read/write queries behind the Discover page (POST /api/v1/discovery/taste,
// GET|PUT …/taste/prefs — the routes live in src/api/discovery-taste.js).
//
// What it answers, in the order the route asks:
//   historySeeds      the songs the user finished or mostly listened to,
//                     from play_events (window → all time)
//   counterSeeds      the next fallback: user_metadata counters, newest first
//   randomVisibleSeed the last fallback: one analyzed track the caller can see
//   albumCards        per Album card, how much of it this user has played
//   *TastePrefs       the per-user page prefs in user_settings `discovery:page`
//
// Every function takes the DB handle explicitly (node:sqlite, or the Bun
// adapter — the same prepare().all()/get()/run() surface), like
// src/stats/store.js, so the db tests drive it on an in-memory database.
//
// Library scope: every read is limited to the caller's visible libraries —
// the SAME scope the stats routes use (eventScope → libraryFilter: grants,
// public mode, federation keys, ignoreVPaths). A function resolves it from
// `ignoreVPaths` itself, or takes `libIds` already resolved (tasteScope), so
// a route resolves it once per request and every query in one call agrees.
// `libIds` is null when the caller sees every library, else a Set (possibly
// empty) of library ids.
//
// Planner rules (measured on a 25k-track library, see the comments at each
// query): tracks are never probed with COALESCE(audio_hash, file_hash) = ?
// or a flat OR, and a probe that carries a library clause pins its hash
// index with INDEXED BY — without ANALYZE stats SQLite otherwise serves
// `t.library_id IN (…)` from idx_tracks_library, a whole-library scan per
// chunk. Positional parameters only (the Bun adapter refuses named ones).

import { createHash } from 'node:crypto';
import { eventScope } from '../stats/queries.js';
import { ALBUM_ITEM_COLUMNS, ALBUM_ITEM_GROUP } from '../api/db.js';
import { toSqlite, isoDate } from '../stats/time.js';

// ── Contract constants (plan §3.1 / §3.2; S5's Joi reads these) ──────────

export const WINDOWS = Object.freeze([7, 30, 90, 0]);   // days; 0 = all time
export const DEFAULT_WINDOW = 30;
export const FILTERS = Object.freeze(['fresh', 'unplayed', 'all']);
export const DEFAULT_FILTER = 'fresh';
export const DEFAULT_STALE_DAYS = 90;
export const STALE_DAYS_MIN = 1;
export const STALE_DAYS_MAX = 3650;
export const EXCLUDE_CAP = 200;        // remembered dropped seeds per user
export const HASH_MAX = 128;           // Joi.string().max(128) for a seed hash
export const PIN_CAP = 8;
export const SEED_CAP = 12;            // limit.seeds ceiling (pins count toward it)
export const LIBRARY_SEED_CAP = 6;     // history seeds that get a per-seed library pass
export const SEED_OVERFETCH = 4;       // history rows read per seed wanted
export const LIMIT_DEFAULTS = Object.freeze({ seeds: 12, tracks: 24, albums: 8, network: 12, peers: 12 });
export const LIMIT_CAPS = Object.freeze({ seeds: 12, tracks: 50, albums: 24, network: 50, peers: 25 });
export const PREFS_NAMESPACE = 'discovery:page';

// Hashes (or album ids) per probe: both UNION ALL branches bind the chunk,
// so 800 variables plus the library IN-list twice — under SQLite's old
// 999-variable floor for any realistic library count.
const PROBE_CHUNK = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

// A positive integer option, else its default (a NaN would reach LIMIT ?).
const posInt = (v, dflt) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt);

function asSet(v) {
  if (v == null) { return null; }
  if (v instanceof Set) { return v; }
  return new Set(Array.isArray(v) ? v : [v]);
}

// ── Scope ────────────────────────────────────────────────────────────────

// The caller's visible library ids: null = every library, else a Set. Read
// off eventScope so the page and the stats routes can never disagree about
// which libraries a user's history covers.
export function tasteScope(user, ignoreVPaths) {
  return eventScope(user, ignoreVPaths).libIds;
}

function scopeOf(user, { libIds, ignoreVPaths } = {}) {
  if (libIds !== undefined) { return libIds == null ? null : asSet(libIds); }
  return tasteScope(user, ignoreVPaths);
}

// ── Visibility probe ─────────────────────────────────────────────────────

// hash → the track row it names inside [libIds] (null = any library): the
// lowest id when a library holds the same audio twice, as resolveTracks
// picks. The same two disjoint branches as resolveTracks (audio-canonical,
// file-canonical with NULL audio — together exactly COALESCE(audio_hash,
// file_hash)), but each pinned to its hash index with INDEXED BY: with a
// library clause beside an IN-list SQLite (no ANALYZE stats) picks
// idx_tracks_library instead and scans the whole library per chunk —
// measured 4.75 ms → 0.55 ms per 400-hash chunk at 20k tracks in the
// library. INDEXED BY also makes the query fail loudly, rather than
// regress to a scan, if a migration ever drops either hash index.
//
// Returns Map<hash, { id, libraryId, albumId }>. Exported because the route
// needs the same probe for its album pass over the ranked pool.
export function visibleTracksByHash(d, hashes, libIds = null) {
  const out = new Map();
  const lib = libIds == null ? null : [...libIds];
  if (lib && lib.length === 0) { return out; }
  const uniq = [...new Set((hashes || []).filter((h) => typeof h === 'string' && h.length > 0))];
  const libClause = lib ? ` AND t.library_id IN (${placeholders(lib.length)})` : '';
  const libParams = lib || [];
  for (let i = 0; i < uniq.length; i += PROBE_CHUNK) {
    const slice = uniq.slice(i, i + PROBE_CHUNK);
    const ph = placeholders(slice.length);
    const rows = d.prepare(`
      SELECT t.id AS id, t.library_id AS library_id, t.album_id AS album_id, t.audio_hash AS hash
        FROM tracks t INDEXED BY idx_tracks_audio_hash
       WHERE t.audio_hash IN (${ph})${libClause}
      UNION ALL
      SELECT t.id, t.library_id, t.album_id, t.file_hash
        FROM tracks t INDEXED BY idx_tracks_hash
       WHERE t.file_hash IN (${ph}) AND t.audio_hash IS NULL${libClause}
       ORDER BY 1`).all(...slice, ...libParams, ...slice, ...libParams);
    for (const r of rows) {
      if (!out.has(r.hash)) { out.set(r.hash, { id: r.id, libraryId: r.library_id, albumId: r.album_id }); }
    }
  }
  return out;
}

// ── History seeds (plan §2.1, §2.2) ──────────────────────────────────────

// A play seeds when the server counted it AND the user either finished it or
// stopped past half of it. `counted = 1` is required because a seek to the
// end still classifies as completed; a tab closed 35 s into a 6-minute song
// is counted (≥ 30 s) but stopped under 50 %, so it does not seed. A NULL
// duration_ms makes the stopped half unknowable — it does not seed either.
const SEED_PLAY = `pe.track_hash IS NOT NULL AND pe.peer_id IS NULL AND pe.counted = 1
       AND (pe.outcome = 'completed' OR (pe.outcome = 'stopped' AND pe.played_ms >= 0.5 * pe.duration_ms))`;

// One pass over [from, now) (from = null: all time). Leads with
// pe.user_id = ? AND pe.started_at >= ? so idx_play_events_user_time serves
// the window (all time rides idx_play_events_user_hash, which also hands
// GROUP BY its order). The skip check runs once per GROUP (HAVING) and is
// PINNED to idx_play_events_user_hash — the user's own plays of one song.
// Left to itself the planner serves the subquery from
// idx_play_events_user_time, re-reading every event in the window for every
// group: measured 12 s for an all-time pass over 20k events; pinned, an
// all-time pass over 40k events takes ~45 ms and a 30-day window ~3 ms.
function seedRows(d, userId, { from, libIds, exclude, limit }) {
  const clauses = ['pe.user_id = ?'];
  const params = [userId];
  if (from != null) { clauses.push('pe.started_at >= ?'); params.push(from); }
  clauses.push(SEED_PLAY);
  if (libIds) {
    clauses.push(`pe.library_id IN (${placeholders(libIds.size)})`);
    params.push(...libIds);
  }
  if (exclude && exclude.size > 0) {
    clauses.push(`pe.track_hash NOT IN (${placeholders(exclude.size)})`);
    params.push(...exclude);
  }
  // The hash's LATEST event in the window — any outcome, any origin or
  // library, counted or not — must not be a skip: finishing a song and then
  // skipping it later says the taste moved on. id breaks a same-millisecond
  // tie in insertion order.
  const skipParams = [userId];
  let skipWindow = '';
  if (from != null) { skipWindow = ' AND s.started_at >= ?'; skipParams.push(from); }
  return d.prepare(`
    SELECT pe.track_hash AS hash,
           MAX(pe.started_at) AS last_played,
           COUNT(*) AS plays,
           MAX(CASE WHEN pe.outcome = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM play_events pe
     WHERE ${clauses.join('\n       AND ')}
     GROUP BY pe.track_hash
    HAVING (SELECT s.outcome FROM play_events s INDEXED BY idx_play_events_user_hash
             WHERE s.user_id = ? AND s.track_hash = pe.track_hash${skipWindow}
             ORDER BY s.started_at DESC, s.id DESC LIMIT 1) IS NOT 'skipped'
     ORDER BY completed DESC, last_played DESC, hash
     LIMIT ?`).all(...params, ...skipParams, limit);
}

// The distinct songs that seed the page, completed ahead of stopped, then
// newest. Returns { hashes, window, widenedFrom }:
//   hashes       [{ hash, lastPlayed (stored SQLite text), plays (seeding
//                plays of it in the window), outcome: 'completed'|'stopped' }]
//   window       the window the hashes came from (0 after widening)
//   widenedFrom  the requested window when it held nothing and the pass
//                widened to all time (set even when all time is empty too,
//                so the route can report it on a counters/random answer)
//
// Without `accept` the over-fetched candidates come back as read
// (overfetch × limit, the route then keeps those in index.byHash AND
// visible). With `accept(hash) → bool` the module applies that filter
// itself, keeps at most `limit`, and widens when nothing was ACCEPTED —
// so a window full of un-analyzed songs widens instead of going random.
// `exclude` (Set or array of hashes: the user's dropped seeds) is applied in
// SQL, so exclusions never eat into the over-fetch.
export function historySeeds(d, user, {
  windowDays = DEFAULT_WINDOW, limit = SEED_CAP, ignoreVPaths, libIds, overfetch = SEED_OVERFETCH,
  exclude = null, accept = null, now = new Date(),
} = {}) {
  const userId = user?.id;
  const requested = Number(windowDays) > 0 ? Number(windowDays) : 0;
  const scope = scopeOf(user, { libIds, ignoreVPaths });
  const ex = asSet(exclude);
  const want = posInt(limit, SEED_CAP);
  const read = want * posInt(overfetch, SEED_OVERFETCH);

  const pass = (days) => {
    if (userId == null || (scope && scope.size === 0)) { return []; }
    const from = days > 0 ? toSqlite(new Date(now.getTime() - days * DAY_MS)) : null;
    const rows = seedRows(d, userId, { from, libIds: scope, exclude: ex, limit: read });
    const out = [];
    for (const r of rows) {
      if (accept && !accept(r.hash)) { continue; }
      out.push({ hash: r.hash, lastPlayed: r.last_played, plays: r.plays, outcome: r.completed ? 'completed' : 'stopped' });
      if (accept && out.length >= want) { break; }
    }
    return out;
  };

  const first = pass(requested);
  if (first.length > 0 || requested === 0) {
    return { hashes: first, window: requested, widenedFrom: null };
  }
  return { hashes: pass(0), window: 0, widenedFrom: requested };
}

// ── Counter seeds (plan §2.2: the fallback after all-time events) ────────

const COUNTER_MAX_PAGES = 8;

// The user's played counters, newest play first, kept to tracks in the
// caller's libraries. Seeks idx_user_metadata_user_lastplayed (user_id,
// last_played) backwards — pinned, because `play_count > 0` alone tempts the
// planner onto idx_user_metadata_user_playcount plus a sort. Pages until
// `limit` hashes resolve or the counters run out (bounded: a user whose
// counters mostly name tracks in libraries they lost stops after
// COUNTER_MAX_PAGES pages rather than walking every row).
//
// After a `POST /stats/reset` of history (onStatsReset's marker), counters
// last bumped before the reset are pre-reset listening the user asked to
// forget, so they are skipped; undated legacy counters (play_count > 0,
// last_played NULL — pre-V70 installs) sort last and are skipped too then.
//
// Returns { hashes: [{ hash, lastPlayed, plays, outcome: null, trackId }] }.
export function counterSeeds(d, user, {
  limit = SEED_CAP, ignoreVPaths, libIds, overfetch = SEED_OVERFETCH, exclude = null, accept = null,
} = {}) {
  const out = [];
  const userId = user?.id;
  if (userId == null) { return { hashes: out }; }
  const scope = scopeOf(user, { libIds, ignoreVPaths });
  if (scope && scope.size === 0) { return { hashes: out }; }
  const ex = asSet(exclude);
  const want = posInt(limit, SEED_CAP);
  const page = Math.max(want * posInt(overfetch, SEED_OVERFETCH), 50);
  const since = historyResetAt(d, userId);
  const sinceClause = since ? ' AND last_played >= ?' : '';
  const stmt = d.prepare(`
    SELECT track_hash AS hash, play_count AS plays, last_played
      FROM user_metadata INDEXED BY idx_user_metadata_user_lastplayed
     WHERE user_id = ? AND play_count > 0${sinceClause}
     ORDER BY last_played DESC, id DESC
     LIMIT ? OFFSET ?`);
  for (let p = 0; p < COUNTER_MAX_PAGES; p++) {
    const rows = stmt.all(...(since ? [userId, since] : [userId]), page, p * page);
    if (rows.length === 0) { break; }
    const candidates = rows.filter((r) => !(ex && ex.has(r.hash)));
    const vis = visibleTracksByHash(d, candidates.map((r) => r.hash), scope);
    for (const r of candidates) {
      const t = vis.get(r.hash);
      if (!t) { continue; }
      if (accept && !accept(r.hash)) { continue; }
      out.push({ hash: r.hash, lastPlayed: r.last_played, plays: r.plays, outcome: null, trackId: t.id });
      if (out.length >= want) { return { hashes: out }; }
    }
    if (rows.length < page) { break; }
  }
  return { hashes: out };
}

// ── Random seed (plan §2.8: nothing counted at all) ──────────────────────

function digest32(text) {
  const h = createHash('sha256').update(text).digest();
  return [h.readUInt32BE(0), h.readUInt32BE(4)];
}

function gcd(a, b) {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// One analyzed track (an index entry) the caller can see, the same one all
// day: the walk order is an affine permutation of the index seeded by
// (user id, daySalt = UTC date), and the first visible entry along it wins.
// A permutation rather than a seeded offset + linear walk: libraries sit in
// long contiguous runs of the index, and a linear walk from a random offset
// would land on the FIRST track of the caller's run almost every day. The
// visibility probe is chunked (visibleTracksByHash), so a caller who sees a
// tenth of the index pays about one chunk.
//
// Returns { hash, entry, trackId, libraryId } or null when the caller can
// see no analyzed track (or the index is empty).
export function randomVisibleSeed(d, user, index, {
  ignoreVPaths, libIds, daySalt = null, exclude = null, now = new Date(),
} = {}) {
  const entries = index?.entries;
  const n = entries?.length || 0;
  if (n === 0) { return null; }
  const scope = scopeOf(user, { libIds, ignoreVPaths });
  if (scope && scope.size === 0) { return null; }
  const ex = asSet(exclude);
  const salt = daySalt ?? isoDate(now);
  const [a, b] = digest32(`${user?.id ?? 'public'}|${salt}`);
  const start = a % n;
  let step = n > 1 ? 1 + (b % (n - 1)) : 1;
  while (gcd(step, n) !== 1) { step = step % (n - 1) + 1; }
  for (let k = 0; k < n; k += PROBE_CHUNK) {
    const batch = [];
    for (let j = k; j < Math.min(n, k + PROBE_CHUNK); j++) {
      const e = entries[(start + j * step) % n];
      if (e && !(ex && ex.has(e.hash))) { batch.push(e); }
    }
    const vis = visibleTracksByHash(d, batch.map((e) => e.hash), scope);
    for (const e of batch) {
      const t = vis.get(e.hash);
      if (t) { return { hash: e.hash, entry: e, trackId: t.id, libraryId: t.libraryId }; }
    }
  }
  return null;
}

// ── Album cards (plan §2.6) ──────────────────────────────────────────────

// The Album card identity /db/albums groups by (ALBUM_ITEM_GROUP in
// src/api/db.js: al.name, al.year, al.album_art_file), as one string. Takes
// a SQL row (album_art_file) or a card key / wire item (albumArtFile).
// Art normalises like albumItems does (`|| null`), so a key built from a
// wire item equals the key of the row it was rendered from.
export function albumCardKey(row) {
  const art = row.album_art_file !== undefined ? row.album_art_file : row.albumArtFile;
  return JSON.stringify([row.name ?? null, row.year ?? null, art || null]);
}

// Every Album card the given album ids belong to, as ALBUM_ITEM_COLUMNS
// rows (+ `key`, `albumIds`) — feed them to albumItems(d, rows) for the
// /db/albums wire shape and to albumCards as card keys. A card spans every
// album row sharing its identity (an untagged album split across two
// artists is one card), restricted like /db/albums to rows with a track
// in the caller's libraries; the group join rides idx_albums_name, IS makes
// null years and art match themselves (the artists-albums route's shape).
export function albumCardRows(d, user, albumIds, { ignoreVPaths, libIds } = {}) {
  const scope = scopeOf(user, { libIds, ignoreVPaths });
  if (scope && scope.size === 0) { return []; }
  const ids = [...new Set((albumIds || []).filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) { return []; }
  const lib = scope ? [...scope] : null;
  const visible = lib ? `t.library_id IN (${placeholders(lib.length)})` : '1=1';
  const byKey = new Map();
  for (let i = 0; i < ids.length; i += PROBE_CHUNK) {
    const slice = ids.slice(i, i + PROBE_CHUNK);
    const rows = d.prepare(`
      WITH reach AS (
        SELECT DISTINCT name, year, album_art_file FROM albums WHERE id IN (${placeholders(slice.length)})
      )
      SELECT ${ALBUM_ITEM_COLUMNS}
        FROM reach r
        JOIN albums al ON al.name = r.name AND al.year IS r.year AND al.album_art_file IS r.album_art_file
        LEFT JOIN artists pa ON pa.id = al.artist_id
       WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${visible})
       ${ALBUM_ITEM_GROUP}`).all(...slice, ...(lib || []));
    for (const r of rows) {
      const key = albumCardKey(r);
      if (byKey.has(key)) { continue; }
      r.key = key;
      r.albumIds = String(r.ids).split(',').map(Number).sort((x, y) => x - y);
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

// Per card: how much of it the caller can see and has played.
//   scopedTracks  tracks of the card in the caller's libraries (the album
//                 item's track_count keeps its all-libraries meaning)
//   playedTracks  of those, tracks whose counter says play_count > 0
//   lastPlayed    the newest last_played among them (stored SQLite text)
//   unplayed      playedTracks === 0
//   stale         played, and lastPlayed < staleCutoff (stored text or a
//                 Date; false without a cutoff, and false for an undated
//                 legacy counter — when it was played is unknown)
// `fresh` for the route is `unplayed || stale`.
//
// cardKeys: [{ name, year, albumArtFile, albumIds }] (albumCardRows rows
// work as they are). Returns one result per card key, in input order,
// each { key, scopedTracks, playedTracks, lastPlayed, unplayed, stale }.
//
// ONE query per chunk of album ids, tracks-driven: the card's tracks are
// read anyway, so each one probes user_metadata through its UNIQUE
// (user_id, track_hash) index by the canonical hash — the shape random.js's
// candidate query uses. idx_tracks_album is pinned: beside a library
// IN-list the planner would otherwise walk idx_tracks_library.
export function albumCards(d, user, cardKeys, { ignoreVPaths, libIds, staleCutoff = null } = {}) {
  const cards = (cardKeys || []).map((c) => ({
    key: albumCardKey(c),
    albumIds: [...new Set((c.albumIds || []).filter((id) => Number.isInteger(id)))],
  }));
  const scope = scopeOf(user, { libIds, ignoreVPaths });
  const perAlbum = new Map();
  const allIds = [...new Set(cards.flatMap((c) => c.albumIds))];
  if (!(scope && scope.size === 0) && allIds.length > 0) {
    const lib = scope ? [...scope] : null;
    const libClause = lib ? ` AND t.library_id IN (${placeholders(lib.length)})` : '';
    for (let i = 0; i < allIds.length; i += PROBE_CHUNK) {
      const slice = allIds.slice(i, i + PROBE_CHUNK);
      const rows = d.prepare(`
        SELECT t.album_id AS album_id,
               COUNT(*) AS scoped,
               SUM(CASE WHEN um.play_count > 0 THEN 1 ELSE 0 END) AS played,
               MAX(CASE WHEN um.play_count > 0 THEN um.last_played END) AS last_played
          FROM tracks t INDEXED BY idx_tracks_album
          LEFT JOIN user_metadata um
                 ON um.user_id = ? AND um.track_hash = COALESCE(t.audio_hash, t.file_hash)
         WHERE t.album_id IN (${placeholders(slice.length)})${libClause}
         GROUP BY t.album_id`).all(user?.id ?? null, ...slice, ...(lib || []));
      for (const r of rows) { perAlbum.set(r.album_id, r); }
    }
  }
  const cutoff = staleCutoff instanceof Date ? toSqlite(staleCutoff) : staleCutoff;
  return cards.map((c) => {
    let scopedTracks = 0;
    let playedTracks = 0;
    let lastPlayed = null;
    for (const id of c.albumIds) {
      const r = perAlbum.get(id);
      if (!r) { continue; }
      scopedTracks += r.scoped || 0;
      playedTracks += r.played || 0;
      if (r.last_played != null && (lastPlayed == null || r.last_played > lastPlayed)) { lastPlayed = r.last_played; }
    }
    return {
      key: c.key,
      scopedTracks,
      playedTracks,
      lastPlayed,
      unplayed: playedTracks === 0,
      stale: playedTracks > 0 && cutoff != null && lastPlayed != null && lastPlayed < cutoff,
    };
  });
}

// ── Page prefs (plan §3.2) ───────────────────────────────────────────────
//
// user_settings, namespace PREFS_NAMESPACE (passes user-settings.js's key
// regex; cascades on user delete like `discovery:collection`). One key per
// pref, so saving one field never rewrites the others:
//   window     7 | 30 | 90 | 0
//   filter     'fresh' | 'unplayed' | 'all'
//   staleDays  1..3650
//   exclude    [{ hash, at }] oldest first, `at` = epoch ms of the drop. An
//              array of objects, not parallel arrays: a damaged row can't
//              misalign hashes and ages, and the order IS the trim order.
//   resetAt    NOT a pref — the stats-reset marker (onStatsReset). A PUT
//              that sets prefs back to null never touches it, so resetting
//              prefs never resurrects pre-reset counters as seeds.
// The SQL mirrors setUserSetting/deleteUserSetting in src/db/user-settings.js,
// which bind to the live manager handle and so cannot take an explicit one.
// Unset prefs read as null — the route applies the defaults, so a saved
// pref and a default can be told apart.

const RESET_KEY = 'resetAt';

function readNamespace(d, userId) {
  const out = {};
  if (userId == null) { return out; }
  for (const row of d.prepare('SELECT key, value FROM user_settings WHERE user_id = ? AND namespace = ?')
    .all(userId, PREFS_NAMESPACE)) {
    try { out[row.key] = JSON.parse(row.value); } catch (_e) { /* unreadable: treated as unset */ }
  }
  return out;
}

function writeSetting(d, userId, key, value) {
  d.prepare(`
    INSERT INTO user_settings (user_id, namespace, key, value, secret, updated_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id, namespace, key) DO UPDATE SET
      value = excluded.value, secret = 0, updated_at = excluded.updated_at
  `).run(userId, PREFS_NAMESPACE, key, JSON.stringify(value), Date.now());
}

function deleteSetting(d, userId, key) {
  return Number(d.prepare('DELETE FROM user_settings WHERE user_id = ? AND namespace = ? AND key = ?')
    .run(userId, PREFS_NAMESPACE, key).changes);
}

// SAVEPOINT rather than BEGIN: atomic on its own, and still legal when a
// caller already holds a transaction.
function atomically(d, name, fn) {
  d.exec(`SAVEPOINT ${name}`);
  try {
    const r = fn();
    d.exec(`RELEASE ${name}`);
    return r;
  } catch (err) {
    try { d.exec(`ROLLBACK TO ${name}`); d.exec(`RELEASE ${name}`); } catch (_) { /* already gone */ }
    throw err;
  }
}

const isHash = (h) => typeof h === 'string' && h.length > 0 && h.length <= HASH_MAX;
const cleanWindow = (v) => (WINDOWS.includes(v) ? v : null);
const cleanFilter = (v) => (FILTERS.includes(v) ? v : null);
const cleanStaleDays = (v) => (Number.isInteger(v) && v >= STALE_DAYS_MIN && v <= STALE_DAYS_MAX ? v : null);

// Stored exclusions, defensively: well-formed entries only, first copy of a
// hash wins, never more than the cap (newest kept).
function cleanExclude(v) {
  if (!Array.isArray(v)) { return []; }
  const seen = new Set();
  const out = [];
  for (const e of v) {
    if (!e || !isHash(e.hash) || seen.has(e.hash)) { continue; }
    seen.add(e.hash);
    out.push({ hash: e.hash, at: Number.isFinite(e.at) ? e.at : 0 });
  }
  return out.length > EXCLUDE_CAP ? out.slice(out.length - EXCLUDE_CAP) : out;
}

// { window, filter, staleDays, exclude: [hash] } — nulls for unset prefs,
// exclusions oldest first.
export function getTastePrefs(d, userId) {
  const raw = readNamespace(d, userId);
  return {
    window: cleanWindow(raw.window),
    filter: cleanFilter(raw.filter),
    staleDays: cleanStaleDays(raw.staleDays),
    exclude: cleanExclude(raw.exclude).map((e) => e.hash),
  };
}

// Save a partial update and return the merged prefs (getTastePrefs shape).
// A key left undefined keeps its stored value; null deletes it (back to the
// default). `exclude` MERGES by default — new hashes are appended with
// at = now, hashes already excluded keep their age — which is what a taste
// call with `remember: true` wants. `replaceExclude: true` makes the given
// list THE list (PUT …/prefs: the seeds sheet re-including a seed sends the
// list without it); a hash that stays keeps its original age. Either way the
// list is trimmed oldest-first at EXCLUDE_CAP. Throws TypeError on a value
// the contract does not allow — the route validates with Joi first, so this
// is a backstop, not the user-facing check.
export function setTastePrefs(d, userId, patch = {}, { replaceExclude = false, now = Date.now() } = {}) {
  if (!Number.isInteger(userId) || userId <= 0) { throw new TypeError('userId'); }
  const p = patch || {};
  const checks = { window: cleanWindow, filter: cleanFilter, staleDays: cleanStaleDays };
  for (const [key, clean] of Object.entries(checks)) {
    if (p[key] != null && clean(p[key]) == null) { throw new TypeError(key); }
  }
  if (p.exclude != null && (!Array.isArray(p.exclude) || p.exclude.length > EXCLUDE_CAP || !p.exclude.every(isHash))) {
    throw new TypeError('exclude');
  }
  return atomically(d, 'taste_prefs_set', () => {
    for (const key of Object.keys(checks)) {
      if (p[key] === undefined) { continue; }
      if (p[key] === null) { deleteSetting(d, userId, key); } else { writeSetting(d, userId, key, p[key]); }
    }
    if (p.exclude === null) {
      deleteSetting(d, userId, 'exclude');
    } else if (p.exclude !== undefined) {
      const stored = cleanExclude(readNamespace(d, userId).exclude);
      const ageOf = new Map(stored.map((e) => [e.hash, e.at]));
      let list;
      if (replaceExclude) {
        list = [...new Set(p.exclude)].map((hash) => ({ hash, at: ageOf.get(hash) ?? now }));
        list.sort((x, y) => x.at - y.at); // stable: new drops keep their given order, after the old
      } else {
        list = stored.slice();
        for (const hash of new Set(p.exclude)) {
          if (!ageOf.has(hash)) { list.push({ hash, at: now }); }
        }
      }
      if (list.length > EXCLUDE_CAP) { list = list.slice(list.length - EXCLUDE_CAP); }
      if (list.length === 0) { deleteSetting(d, userId, 'exclude'); } else { writeSetting(d, userId, 'exclude', list); }
    }
    return getTastePrefs(d, userId);
  });
}

// ── Stats reset hook ─────────────────────────────────────────────────────
//
// resetStats (src/stats/store.js) leaves no trace: after a `history` reset
// the log is empty and the counters still hold every pre-reset play, which
// is exactly what a fresh install upgraded from a pre-V70 release looks like
// too (legacy counters, no events). So "log empty + counters > 0" cannot
// tell "the user asked to forget" from "the user never had a log", and the
// page would seed from the history the user just erased. The simplest
// correct rule is an explicit marker: the reset route calls this hook, a
// `history`/`all` reset clears the page's namespace (plan §2.2) and stamps
// `resetAt`, and counterSeeds ignores counters last bumped before it. A
// `counts` reset needs nothing — the zeroed counters drop out on their own,
// and the log (the page's primary source) is untouched.
//
// The reset route (POST /api/v1/stats/reset, src/api/stats.js) calls it
// right after resetStats and before answering:
//   const out = resetStats(d(), uid, scope); onStatsReset(d(), uid, scope);
// Returns { cleared (keys deleted), marked }.
export function onStatsReset(d, userId, scope, { now = new Date() } = {}) {
  if (userId == null || (scope !== 'history' && scope !== 'all')) { return { cleared: 0, marked: false }; }
  return atomically(d, 'taste_reset', () => {
    const cleared = Number(d.prepare('DELETE FROM user_settings WHERE user_id = ? AND namespace = ?')
      .run(userId, PREFS_NAMESPACE).changes);
    writeSetting(d, userId, RESET_KEY, toSqlite(now));
    return { cleared, marked: true };
  });
}

// The stored text of the last history reset, or null. Compares as TEXT
// against user_metadata.last_played / play_events.started_at (one format).
export function historyResetAt(d, userId) {
  if (userId == null) { return null; }
  const row = d.prepare('SELECT value FROM user_settings WHERE user_id = ? AND namespace = ? AND key = ?')
    .get(userId, PREFS_NAMESPACE, RESET_KEY);
  if (!row) { return null; }
  try {
    const v = JSON.parse(row.value);
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? v : null;
  } catch (_e) { return null; }
}
