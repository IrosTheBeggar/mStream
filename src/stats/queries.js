// Read queries for the stats API (src/api/stats.js).
//
// Every function takes the DB handle and a RESOLVED request — the user, a
// [from, to) range as stored text, the caller's library scope, an origin
// filter — and returns plain data. Period arithmetic lives in ./time.js,
// validation and rendering in the HTTP layer.
//
// Two sources, deliberately:
//   play_events      lists, top-N, uniques, discoveries, sessions — anything
//                    that needs the track or the outcome. Scoped by library
//                    and origin. Bounded by raw retention.
//   user_hour_stats  the time-series, streaks, peak hour / weekday, top day.
//                    Per-user totals re-bucketed into the caller's zone;
//                    NOT library- or origin-scoped (a rollup has neither),
//                    and the part of the history that outlives pruning.

import { libraryFilter, renderMetadataByIds, enrichRowsWithGenres } from '../api/db.js';
import { fromSqlite, toIso, hourKey, bucketKeyFor, localDay, dayKeyPlus } from './time.js';

export const SESSION_GAP_MS = 30 * 60 * 1000;
const GENRE_SEP = String.fromCharCode(31);

// ── Scoping ──────────────────────────────────────────────────────────────

// Library scope for EVENT rows. A play of a local track counts when its
// library is visible to the caller (and not ignored); a federated play
// always passes — it has no local library, and it is the caller's own play.
export function eventScope(user, ignoreVPaths) {
  const f = libraryFilter(user, ignoreVPaths);
  if (f.coversAllLibraries) { return { clause: '', params: [], libIds: null }; }
  if (f.params.length === 0) { return { clause: 'pe.peer_id IS NOT NULL', params: [], libIds: new Set() }; }
  return {
    clause: `(pe.peer_id IS NOT NULL OR pe.library_id IN (${f.params.map(() => '?').join(',')}))`,
    params: f.params,
    libIds: new Set(f.params),
  };
}

function whereEvents({ userId, from = null, to = null, scope = null, origin = 'all', extra = [] }) {
  const clauses = ['pe.user_id = ?'];
  const params = [userId];
  if (from != null) { clauses.push('pe.started_at >= ?'); params.push(from); }
  if (to != null) { clauses.push('pe.started_at < ?'); params.push(to); }
  if (origin === 'local') { clauses.push('pe.peer_id IS NULL'); }
  else if (origin === 'peers') { clauses.push('pe.peer_id IS NOT NULL'); }
  if (scope?.clause) { clauses.push(scope.clause); params.push(...scope.params); }
  for (const [clause, ...p] of extra) { clauses.push(clause); params.push(...p); }
  return { sql: clauses.join(' AND '), params };
}

// ── Track resolution ─────────────────────────────────────────────────────

// hash → the track row it names (the lowest id when a library holds the
// same audio twice), restricted to [libIds] when given. Two index-driven
// probes (idx_tracks_audio_hash, idx_tracks_hash) rather than a COALESCE
// join the planner can't seek. Chunked under SQLite's bind-variable limit.
export function resolveTracks(d, hashes, libIds = null) {
  const out = new Map();
  const uniq = [...new Set(hashes.filter((h) => typeof h === 'string' && h.length > 0))];
  const lib = libIds ? [...libIds] : null;
  const libClause = lib ? ` AND t.library_id IN (${lib.map(() => '?').join(',')})` : '';
  const CHUNK = 400;
  const cols = `t.id, t.library_id, t.artist_id, t.album_id, t.audio_hash, t.file_hash,
                t.title, a.name AS artist, al.name AS album`;
  const joins = 'FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id';
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = d.prepare(`
      SELECT ${cols} ${joins} WHERE t.audio_hash IN (${ph})${libClause}
      UNION ALL
      SELECT ${cols} ${joins} WHERE t.file_hash IN (${ph}) AND t.audio_hash IS NULL${libClause}
      ORDER BY 1`).all(...slice, ...(lib || []), ...slice, ...(lib || []));
    for (const r of rows) {
      const h = r.audio_hash ?? r.file_hash;
      if (!out.has(h)) { out.set(h, r); }
    }
  }
  return out;
}

function parseSnapshot(text) {
  if (!text) { return {}; }
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || null;

// A Metadata-shaped object for a row this library can't join — a federated
// play, or a local track deleted since. Built from the snapshot the client
// sent at ingest, falling back to the stored filepath.
export function snapshotTrack(row) {
  const snap = parseSnapshot(row.snapshot);
  return {
    filepath: row.filepath,
    metadata: {
      title: snap.title ?? basename(row.filepath),
      artist: snap.artist ?? null,
      album: snap.album ?? null,
      hash: snap.hash ?? row.hash ?? null,
      duration: typeof snap.durationMs === 'number' ? snap.durationMs / 1000 : null,
      'album-art': snap.artFile ?? null,
      genres: [],
    },
  };
}

// Attach a `track` object to every aggregate/event row: the library's own
// metadata object for a local track that still resolves, the snapshot
// otherwise. One resolve + one render per call, however many rows.
export function attachTracks(d, rows, user, libIds) {
  const localHashes = rows.filter((r) => r.peer_id == null && r.hash).map((r) => r.hash);
  const resolved = resolveTracks(d, localHashes, libIds);
  const rendered = renderMetadataByIds([...resolved.values()].map((t) => t.id), user);
  for (const r of rows) {
    const t = r.peer_id == null && r.hash ? resolved.get(r.hash) : null;
    r.track = (t && rendered.get(t.id)) || snapshotTrack(r);
  }
  return rows;
}

// ── Aggregates over events ───────────────────────────────────────────────

// Per-track aggregates over the events in [w]. Group key: the canonical
// hash for a local row; (peer, hash-or-path) for a federated one.
function trackAggregates(d, w, { metric = 'plays', limit = null } = {}) {
  const order = metric === 'time' ? 'listened_ms DESC, plays DESC' : 'plays DESC, listened_ms DESC';
  const having = metric === 'time' ? 'listened_ms > 0' : 'plays > 0';
  return d.prepare(`
    SELECT pe.track_hash AS hash, pe.peer_id AS peer_id,
           MAX(pe.filepath) AS filepath, MAX(pe.snapshot) AS snapshot,
           SUM(pe.counted) AS plays, SUM(pe.played_ms) AS listened_ms,
           COUNT(*) AS events, MAX(pe.started_at) AS last_played
      FROM play_events pe
     WHERE ${w.sql}
     GROUP BY COALESCE(pe.peer_id, 0), COALESCE(pe.track_hash, pe.filepath)
    HAVING ${having}
     ORDER BY ${order}, last_played DESC
     ${limit != null ? 'LIMIT ?' : ''}`).all(...w.params, ...(limit != null ? [limit] : []));
}

function totalsOf(rows) {
  let plays = 0;
  let ms = 0;
  for (const r of rows) { plays += r.plays || 0; ms += r.listened_ms || 0; }
  return { plays, ms };
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

export function topTracks(d, { user, userId, from, to, scope, origin, metric, limit }) {
  const w = whereEvents({ userId, from, to, scope, origin });
  const all = trackAggregates(d, w, { metric });
  const totals = totalsOf(all);
  const rows = attachTracks(d, all.slice(0, limit), user, scope?.libIds ?? null);
  const names = peerNames(d, rows);
  return rows.map((r, i) => ({
    rank: i + 1,
    plays: r.plays,
    listenedMs: r.listened_ms,
    events: r.events,
    share: metric === 'time' ? share(r.listened_ms, totals.ms) : share(r.plays, totals.plays),
    lastPlayed: toIso(r.last_played),
    origin: r.peer_id == null ? 'local' : 'peer',
    peerId: r.peer_id ?? null,
    peerName: r.peer_id == null ? null : (names.get(r.peer_id) ?? null),
    track: r.track,
  }));
}

// The names of the peers behind [rows], read only when a peer row exists —
// a client shows "via Bob's records" without listing peers itself (that
// listing needs federation to be on).
function peerNames(d, rows) {
  const ids = [...new Set(rows.map((r) => r.peer_id).filter((id) => id != null))];
  const out = new Map();
  if (ids.length === 0) { return out; }
  for (const r of d.prepare(`SELECT id, name FROM federation_peers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    out.set(r.id, r.name);
  }
  return out;
}

// artists / albums / genres: group the per-track aggregates by the entity.
// Local rows join the library; federated rows contribute by the names in
// their snapshot (no genres there). Artists and albums merge by name across
// origins — a peer's "Radiohead" is the same artist as yours.
export function topGroups(d, { userId, from, to, scope, origin, entity, metric, limit }) {
  const w = whereEvents({ userId, from, to, scope, origin });
  const all = trackAggregates(d, w, { metric });
  const totals = totalsOf(all);
  const local = all.filter((r) => r.peer_id == null && r.hash);
  const resolved = resolveTracks(d, local.map((r) => r.hash), scope?.libIds ?? null);
  let genresById = null;
  if (entity === 'genres') {
    const idRows = [...new Set([...resolved.values()].map((t) => t.id))].map((id) => ({ id }));
    genresById = new Map(enrichRowsWithGenres(d, idRows).map((r) => [r.id, r.genres_concat]));
  }

  const groups = new Map();
  const add = (key, fields, r) => {
    let g = groups.get(key);
    if (!g) { g = { ...fields, plays: 0, listenedMs: 0, events: 0, tracks: new Set() }; groups.set(key, g); }
    g.plays += r.plays || 0;
    g.listenedMs += r.listened_ms || 0;
    g.events += r.events || 0;
    g.tracks.add(`${r.peer_id ?? 0}:${r.hash ?? r.filepath}`);
  };
  const norm = (s) => String(s ?? '').trim().toLowerCase();

  for (const r of all) {
    const t = r.peer_id == null && r.hash ? resolved.get(r.hash) : null;
    if (r.peer_id == null && !t) { continue; } // a local track that no longer resolves
    const snap = t ? null : parseSnapshot(r.snapshot);
    const artist = t ? t.artist : snap.artist;
    const album = t ? t.album : snap.album;
    switch (entity) {
      case 'artists':
        if (!artist) { break; }
        add(norm(artist), { name: artist }, r);
        break;
      case 'albums':
        if (!album) { break; }
        add(`${norm(album)}|${norm(artist)}`, { name: album, artist: artist ?? null }, r);
        break;
      case 'genres': {
        if (!t) { break; }
        const gc = genresById.get(t.id);
        if (!gc) { break; }
        for (const name of gc.split(GENRE_SEP)) { if (name) { add(norm(name), { name }, r); } }
        break;
      }
      default: break;
    }
  }

  const sorted = [...groups.values()].sort((a, b) =>
    (metric === 'time' ? b.listenedMs - a.listenedMs || b.plays - a.plays : b.plays - a.plays || b.listenedMs - a.listenedMs)
    || a.name.localeCompare(b.name));
  return sorted.slice(0, limit).map((g, i) => ({
    rank: i + 1,
    name: g.name,
    ...(entity === 'albums' ? { artist: g.artist } : {}),
    plays: g.plays,
    listenedMs: g.listenedMs,
    events: g.events,
    tracks: g.tracks.size,
    share: metric === 'time' ? share(g.listenedMs, totals.ms) : share(g.plays, totals.plays),
  }));
}

// ── Rollups ──────────────────────────────────────────────────────────────

// Rollup rows overlapping [from, to). A bound that is not on the hour (a
// half-hour zone's midnight) includes its partial hour — the rollup can't
// split it, and losing thirty minutes of listening is worse than gaining.
export function hourRows(d, { userId, from, to }) {
  const lo = hourKey(from);
  const hi = hourKey(to);
  const partial = to.getUTCMinutes() !== 0 || to.getUTCSeconds() !== 0 || to.getUTCMilliseconds() !== 0;
  return d.prepare(`
    SELECT hour, events, plays, skips, listened_ms
      FROM user_hour_stats
     WHERE user_id = ? AND hour >= ? AND hour ${partial ? '<=' : '<'} ?
     ORDER BY hour`).all(userId, lo, hi);
}

// The same rows folded from the raw log under an events filter — what a
// read scoped by origin or by ignored libraries uses, since the rollup
// carries neither. Plays pruned by retention are absent here, so an
// unfiltered read keeps the rollup (see scopedHourRows).
export function eventHourRows(d, w) {
  return d.prepare(`
    SELECT (substr(pe.started_at, 1, 10) || 'T' || substr(pe.started_at, 12, 2)) AS hour,
           COUNT(*) AS events, SUM(pe.counted) AS plays,
           SUM(CASE WHEN pe.outcome = 'skipped' THEN 1 ELSE 0 END) AS skips,
           SUM(pe.played_ms) AS listened_ms
      FROM play_events pe
     WHERE ${w.sql}
     GROUP BY hour
     ORDER BY hour`).all(...w.params);
}

// Hour rows for a read: the rollup when nothing narrows the caller's whole
// log, the raw log once origin or ignoreVPaths does.
export function scopedHourRows(d, { user, from, to, fromDate, toDate, origin = 'all', ignoreVPaths }) {
  const filtered = (origin && origin !== 'all') || (Array.isArray(ignoreVPaths) && ignoreVPaths.length > 0);
  if (!filtered) { return hourRows(d, { userId: user.id, from: fromDate, to: toDate }); }
  const scope = eventScope(user, ignoreVPaths);
  return eventHourRows(d, whereEvents({ userId: user.id, from, to, scope, origin }));
}

const range = (n) => Array.from({ length: n }, (_, i) => String(i));

// Fold UTC-hour rows into [bucket] keys in [tz]. Profile buckets (hourOfDay,
// weekday) come back dense with zeros; calendar buckets only where data is.
export function rebucket(rows, bucket, tz) {
  const acc = new Map();
  const seed = bucket === 'hourOfDay' ? range(24) : bucket === 'weekday' ? range(7) : [];
  for (const k of seed) { acc.set(k, { bucket: k, events: 0, plays: 0, skips: 0, listenedMs: 0 }); }
  for (const r of rows) {
    const k = bucketKeyFor(r.hour, bucket, tz);
    if (k == null) { continue; }
    let b = acc.get(k);
    if (!b) { b = { bucket: k, events: 0, plays: 0, skips: 0, listenedMs: 0 }; acc.set(k, b); }
    b.events += r.events || 0;
    b.plays += r.plays || 0;
    b.skips += r.skips || 0;
    b.listenedMs += r.listened_ms || 0;
  }
  const out = [...acc.values()];
  if (bucket === 'hourOfDay' || bucket === 'weekday') { out.sort((a, b) => Number(a.bucket) - Number(b.bucket)); }
  else { out.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)); }
  return out;
}

// ── Sessions ─────────────────────────────────────────────────────────────

// Sessions are runs of events with no gap over [gapMs] between one event's
// end and the next one's start. Derived, not declared: a client session id
// is a hint at best (an app process can span days), and clients that never
// send one get the same numbers. Rows must be ordered by started_at.
export function foldSessions(rows, gapMs = SESSION_GAP_MS) {
  const sessions = [];
  let cur = null;
  for (const r of rows) {
    const start = fromSqlite(r.started_at);
    if (!start) { continue; }
    const played = r.played_ms || 0;
    const end = fromSqlite(r.ended_at) || new Date(start.getTime() + played);
    if (cur && start.getTime() - cur.end.getTime() <= gapMs) {
      cur.tracks += 1;
      cur.plays += r.counted ? 1 : 0;
      cur.listenedMs += played;
      if (end > cur.end) { cur.end = end; }
    } else {
      cur = { start, end, tracks: 1, plays: r.counted ? 1 : 0, listenedMs: played };
      sessions.push(cur);
    }
  }
  return sessions;
}

// ── Streaks / days ───────────────────────────────────────────────────────

// Consecutive local days with at least one counted play. `current` is the
// run that reaches today or yesterday (a day without plays yet is not a
// broken streak); `longest` is the best run in the rows given.
export function streaks(dayKeys, todayKey) {
  const days = [...new Set(dayKeys)].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    run = prev && dayKeyPlus(prev, 1) === day ? run + 1 : 1;
    if (run > longest) { longest = run; }
    prev = day;
  }
  const last = days[days.length - 1];
  const current = last && (last === todayKey || dayKeyPlus(last, 1) === todayKey) ? run : 0;
  return { current, longest };
}

export function dayTotals(rows, tz) {
  const days = new Map();
  for (const r of rows) {
    const k = bucketKeyFor(r.hour, 'day', tz);
    if (k == null) { continue; }
    let v = days.get(k);
    if (!v) { v = { date: k, plays: 0, listenedMs: 0 }; days.set(k, v); }
    v.plays += r.plays || 0;
    v.listenedMs += r.listened_ms || 0;
  }
  return days;
}

function peakOf(items) {
  let best = null;
  for (const it of items) {
    if (it.plays > 0 && (!best || it.plays > best.plays)) { best = it; }
  }
  return best ? Number(best.bucket) : null;
}

// ── Summary ──────────────────────────────────────────────────────────────

export function summary(d, { user, from, to, fromDate, toDate, tz, origin, ignoreVPaths, now = new Date() }) {
  const userId = user.id;
  const scope = eventScope(user, ignoreVPaths);
  const w = whereEvents({ userId, from, to, scope, origin });

  const core = d.prepare(`
    SELECT COUNT(*) AS events,
           COALESCE(SUM(pe.counted), 0) AS plays,
           COALESCE(SUM(pe.played_ms), 0) AS listened_ms,
           COALESCE(SUM(CASE WHEN pe.outcome = 'skipped' THEN 1 ELSE 0 END), 0) AS skips,
           COALESCE(SUM(CASE WHEN pe.outcome = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(pe.pause_count), 0) AS pauses,
           COALESCE(SUM(CASE WHEN pe.peer_id IS NULL THEN pe.counted ELSE 0 END), 0) AS local_plays,
           COALESCE(SUM(CASE WHEN pe.peer_id IS NULL THEN pe.played_ms ELSE 0 END), 0) AS local_ms,
           COALESCE(SUM(CASE WHEN pe.peer_id IS NOT NULL THEN pe.counted ELSE 0 END), 0) AS peer_plays,
           COALESCE(SUM(CASE WHEN pe.peer_id IS NOT NULL THEN pe.played_ms ELSE 0 END), 0) AS peer_ms
      FROM play_events pe
     WHERE ${w.sql}`).get(...w.params);

  // Distinct counted tracks in range, resolved for artist / album uniques.
  const countedRows = d.prepare(`
    SELECT COALESCE(pe.peer_id, 0) AS peer, pe.track_hash AS hash, MAX(pe.snapshot) AS snapshot
      FROM play_events pe
     WHERE ${w.sql} AND pe.counted = 1
     GROUP BY COALESCE(pe.peer_id, 0), COALESCE(pe.track_hash, pe.filepath)`).all(...w.params);
  const resolved = resolveTracks(d, countedRows.filter((r) => r.peer === 0).map((r) => r.hash), scope.libIds);
  const artists = new Set();
  const albums = new Set();
  for (const r of countedRows) {
    if (r.peer === 0) {
      const t = resolved.get(r.hash);
      if (!t) { continue; }
      if (t.artist_id != null) { artists.add(`id:${t.artist_id}`); }
      if (t.album_id != null) { albums.add(`id:${t.album_id}`); }
    } else {
      const snap = parseSnapshot(r.snapshot);
      if (snap.artist) { artists.add(`name:${String(snap.artist).trim().toLowerCase()}`); }
      if (snap.album) { albums.add(`name:${String(snap.album).trim().toLowerCase()}`); }
    }
  }

  // Discoveries: tracks whose FIRST counted play ever falls in the range.
  const wAll = whereEvents({ userId, scope, origin, extra: [['pe.counted = 1']] });
  const discoveries = d.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT MIN(pe.started_at) AS first
        FROM play_events pe
       WHERE ${wAll.sql}
       GROUP BY COALESCE(pe.peer_id, 0), COALESCE(pe.track_hash, pe.filepath)
      HAVING first >= ? AND first < ?)`).get(...wAll.params, from, to)?.n || 0;

  // Library coverage: local tracks ever counted / tracks the caller can see.
  const lf = libraryFilter(user, ignoreVPaths);
  const totalTracks = d.prepare(`SELECT COUNT(*) AS n FROM tracks t WHERE ${lf.clause}`).get(...lf.params)?.n || 0;
  const everHashes = d.prepare(`
    SELECT DISTINCT pe.track_hash AS hash FROM play_events pe
     WHERE ${wAll.sql} AND pe.peer_id IS NULL AND pe.track_hash IS NOT NULL`).all(...wAll.params).map((r) => r.hash);
  const everPlayed = resolveTracks(d, everHashes, scope.libIds).size;
  const coverage = totalTracks > 0 ? Math.min(100, Math.round((everPlayed / totalTracks) * 1000) / 10) : 0;

  // Sessions from the ordered events in range.
  const sessionRows = d.prepare(`
    SELECT pe.started_at, pe.ended_at, pe.played_ms, pe.counted
      FROM play_events pe WHERE ${w.sql} ORDER BY pe.started_at, pe.id`).all(...w.params);
  const sessions = foldSessions(sessionRows);
  let longest = null;
  let totalSessionMs = 0;
  for (const s of sessions) {
    totalSessionMs += s.listenedMs;
    if (!longest || s.listenedMs > longest.listenedMs) { longest = s; }
  }

  // Calendar facts: the rollup for the whole log, the raw log under a filter.
  const rows = scopedHourRows(d, { user, from, to, fromDate, toDate, origin, ignoreVPaths });
  const days = dayTotals(rows, tz);
  const playedDays = [...days.values()].filter((v) => v.plays > 0).map((v) => v.date);
  let topDay = null;
  for (const v of days.values()) {
    if (v.listenedMs > 0 && (!topDay || v.listenedMs > topDay.listenedMs)) { topDay = v; }
  }

  const events = core?.events || 0;
  return {
    events,
    plays: core?.plays || 0,
    uniqueTracks: countedRows.length,
    uniqueArtists: artists.size,
    uniqueAlbums: albums.size,
    listenedMs: core?.listened_ms || 0,
    skips: core?.skips || 0,
    skipRate: events > 0 ? Math.round(((core?.skips || 0) / events) * 1000) / 1000 : 0,
    completionRate: events > 0 ? Math.round(((core?.completed || 0) / events) * 1000) / 1000 : 0,
    pauses: core?.pauses || 0,
    discoveries,
    libraryCoveragePct: coverage,
    sessions: {
      count: sessions.length,
      avgMs: sessions.length > 0 ? Math.round(totalSessionMs / sessions.length) : null,
      longest: longest ? {
        startedAt: longest.start.toISOString(),
        endedAt: longest.end.toISOString(),
        tracks: longest.tracks,
        plays: longest.plays,
        listenedMs: longest.listenedMs,
      } : null,
    },
    streakDays: streaks(playedDays, localDay(now, tz)),
    topDay,
    peakHour: peakOf(rebucket(rows, 'hourOfDay', tz)),
    peakWeekday: peakOf(rebucket(rows, 'weekday', tz)),
    origins: {
      local: { plays: core?.local_plays || 0, listenedMs: core?.local_ms || 0 },
      peers: { plays: core?.peer_plays || 0, listenedMs: core?.peer_ms || 0 },
    },
  };
}

// ── History ──────────────────────────────────────────────────────────────

// The key events are stored under, for any hash a client may know a track
// by. The metadata object's `audio-hash` is the canonical key, but a client
// holding only `hash` (the file hash) must still find the plays — and a
// peer's reported hash, which no local row carries, must pass through. A
// library hit resolves to its canonical key; anything else is used as sent.
// Both probes are indexed (idx_tracks_audio_hash, idx_tracks_hash).
export function canonicalHash(d, hash) {
  if (typeof hash !== 'string' || hash.length === 0) { return hash; }
  const row = d.prepare('SELECT audio_hash, file_hash FROM tracks WHERE audio_hash = ? OR file_hash = ? LIMIT 1')
    .get(hash, hash);
  return row ? (row.audio_hash || row.file_hash || hash) : hash;
}

export function history(d, { user, origin, ignoreVPaths, from = null, to = null, trackHash = null, before = null, limit }) {
  const scope = eventScope(user, ignoreVPaths);
  const extra = [];
  if (trackHash) { extra.push(['pe.track_hash = ?', canonicalHash(d, trackHash)]); }
  if (before) {
    extra.push(['(pe.started_at < ? OR (pe.started_at = ? AND pe.id < ?))', before.startedAt, before.startedAt, before.id]);
  }
  const w = whereEvents({ userId: user.id, from, to, scope, origin, extra });
  const rows = d.prepare(`
    SELECT pe.id, pe.event_id, pe.track_hash AS hash, pe.filepath, pe.library_id, pe.peer_id,
           pe.snapshot, pe.client, pe.session_id, pe.source, pe.outcome, pe.counted,
           pe.played_ms, pe.duration_ms, pe.pause_count, pe.started_at, pe.ended_at
      FROM play_events pe
     WHERE ${w.sql}
     ORDER BY pe.started_at DESC, pe.id DESC
     LIMIT ?`).all(...w.params, limit + 1);
  const more = rows.length > limit;
  if (more) { rows.pop(); }
  attachTracks(d, rows, user, scope.libIds);
  const names = peerNames(d, rows);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({
      id: r.event_id,
      startedAt: toIso(r.started_at),
      endedAt: toIso(r.ended_at),
      playedMs: r.played_ms,
      durationMs: r.duration_ms,
      outcome: r.outcome,
      counted: r.counted === 1,
      source: r.source,
      sessionId: r.session_id,
      pauseCount: r.pause_count,
      client: r.client,
      origin: r.peer_id == null ? 'local' : 'peer',
      peerId: r.peer_id ?? null,
      peerName: r.peer_id == null ? null : (names.get(r.peer_id) ?? null),
      track: r.track,
    })),
    next: more && last ? { startedAt: last.started_at, id: last.id } : null,
  };
}

// ── Per-track counters ───────────────────────────────────────────────────

// Map every hash a client holds — audio hash or file hash — to the canonical
// key the counters are stored under (audio hash, else file hash). A hash the
// library does not know passes through unchanged: a peer's key is stored as
// it came, and still resolves.
export function canonicalHashes(d, hashes) {
  const out = new Map();
  const uniq = [...new Set((hashes || []).filter((h) => typeof h === 'string' && h.length > 0))];
  for (const h of uniq) { out.set(h, h); }
  const CHUNK = 250;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const marks = slice.map(() => '?').join(',');
    const rows = d.prepare(`SELECT audio_hash, file_hash FROM tracks
                             WHERE audio_hash IN (${marks}) OR file_hash IN (${marks})`).all(...slice, ...slice);
    for (const r of rows) {
      const canonical = r.audio_hash || r.file_hash;
      if (!canonical) { continue; }
      if (r.audio_hash && out.has(r.audio_hash)) { out.set(r.audio_hash, canonical); }
      if (r.file_hash && out.has(r.file_hash)) { out.set(r.file_hash, canonical); }
    }
  }
  return out;
}

export function trackStats(d, userId, hashes) {
  const out = new Map();
  const uniq = [...new Set(hashes.filter(Boolean))];
  const CHUNK = 500;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const rows = d.prepare(`
      SELECT track_hash, play_count, skip_count, listened_ms, first_played, last_played
        FROM user_metadata
       WHERE user_id = ? AND track_hash IN (${slice.map(() => '?').join(',')})`).all(userId, ...slice);
    for (const r of rows) { out.set(r.track_hash, r); }
  }
  return out;
}

export function bounds(d, userId) {
  const r = d.prepare('SELECT MIN(started_at) AS earliest, MAX(started_at) AS latest FROM play_events WHERE user_id = ?').get(userId);
  return { earliest: toIso(r?.earliest), latest: toIso(r?.latest) };
}
