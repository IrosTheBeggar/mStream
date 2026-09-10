// The one write path into the listening log.
//
// Every writer — the Stats API v2 ingest route, the legacy scrobble shim,
// test seeding — records a play through here, so the three stores can never
// disagree:
//   play_events      the event itself; its client id is the idempotency key
//   user_hour_stats  the per-user UTC-hour rollup the time-series reads
//   user_metadata    the per-track counters every metadata join surfaces
// Takes the DB handle explicitly (node:sqlite, or the Bun adapter — the same
// prepare().run() surface) so db tests can drive it on an in-memory database.
//
// Resolution — a filePath into a track_hash + library_id, a peer id into a
// peer row, the play-threshold verdict — is the INGEST route's job. This
// module trusts a fully-resolved event and only guarantees the bookkeeping.

import { toSqlite, fromSqlite, hourKey, retentionFloor } from './time.js';

export const OUTCOMES = new Set(['completed', 'skipped', 'stopped']);
export const SOURCES = new Set(['manual', 'shuffle', 'autodj', 'playlist',
  'smart-playlist', 'auto', 'carplay', 'cast', 'legacy', 'other']);
const SNAPSHOT_KEYS = new Set(['title', 'artist', 'album', 'durationMs', 'hash', 'artFile']);

const isInt = (v) => Number.isInteger(v);

function asStoredTime(value, name) {
  if (value instanceof Date) { return toSqlite(value); }
  if (typeof value === 'string') {
    const d = fromSqlite(value) || new Date(value);
    if (!Number.isNaN(d.getTime())) { return toSqlite(d); }
  }
  if (isInt(value)) { return toSqlite(new Date(value)); }
  throw new TypeError(`${name} must be a Date, epoch ms, or a datetime string`);
}

// Validate + shape one event into a play_events row. Throws TypeError on a
// contract violation — callers that take client input validate first (Joi)
// and treat this as a programming-error backstop.
export function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') { throw new TypeError('event must be an object'); }
  const {
    eventId, userId, trackHash = null, filepath, libraryId = null, peerId = null,
    snapshot = null, client = null, sessionId = null, source = null, outcome,
    counted = false, playedMs = 0, durationMs = null, pauseCount = 0, startedAt, endedAt = null,
  } = ev;
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) { throw new TypeError('eventId'); }
  if (!isInt(userId) || userId <= 0) { throw new TypeError('userId'); }
  if (trackHash != null && typeof trackHash !== 'string') { throw new TypeError('trackHash'); }
  if (typeof filepath !== 'string') { throw new TypeError('filepath'); }
  if (libraryId != null && !isInt(libraryId)) { throw new TypeError('libraryId'); }
  if (peerId != null && !isInt(peerId)) { throw new TypeError('peerId'); }
  if (!OUTCOMES.has(outcome)) { throw new TypeError('outcome'); }
  if (source != null && !SOURCES.has(source)) { throw new TypeError('source'); }
  if (!isInt(playedMs) || playedMs < 0) { throw new TypeError('playedMs'); }
  if (durationMs != null && (!isInt(durationMs) || durationMs < 0)) { throw new TypeError('durationMs'); }
  if (!isInt(pauseCount) || pauseCount < 0) { throw new TypeError('pauseCount'); }
  let snapshotJson = null;
  if (snapshot != null) {
    if (typeof snapshot !== 'object') { throw new TypeError('snapshot'); }
    const clean = {};
    for (const k of Object.keys(snapshot)) {
      if (SNAPSHOT_KEYS.has(k) && snapshot[k] != null) { clean[k] = snapshot[k]; }
    }
    snapshotJson = JSON.stringify(clean);
  }
  return {
    event_id: eventId,
    user_id: userId,
    track_hash: trackHash,
    filepath,
    library_id: libraryId,
    peer_id: peerId,
    snapshot: snapshotJson,
    client: client == null ? null : String(client).slice(0, 128),
    session_id: sessionId == null ? null : String(sessionId).slice(0, 128),
    source,
    outcome,
    counted: counted ? 1 : 0,
    played_ms: playedMs,
    duration_ms: durationMs,
    pause_count: pauseCount,
    started_at: asStoredTime(startedAt, 'startedAt'),
    ended_at: endedAt == null ? null : asStoredTime(endedAt, 'endedAt'),
  };
}

const INSERT_EVENT = `
  INSERT OR IGNORE INTO play_events
    (event_id, user_id, track_hash, filepath, library_id, peer_id, snapshot, client,
     session_id, source, outcome, counted, played_ms, duration_ms, pause_count, started_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const BUMP_HOUR = `
  INSERT INTO user_hour_stats (user_id, hour, events, plays, skips, listened_ms)
  VALUES (?, ?, 1, ?, ?, ?)
  ON CONFLICT (user_id, hour) DO UPDATE SET
    events = events + 1,
    plays = plays + excluded.plays,
    skips = skips + excluded.skips,
    listened_ms = listened_ms + excluded.listened_ms`;

// last_played / first_played move only on a COUNTED play — a two-second
// skip is not "the last time I played this". Listened time and skips
// accumulate for every event. MAX/MIN over the stored text is exact: one
// format, lexicographically ordered.
const BUMP_TRACK = `
  INSERT INTO user_metadata (user_id, track_hash, play_count, last_played, first_played, listened_ms, skip_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, track_hash) DO UPDATE SET
    play_count = play_count + excluded.play_count,
    last_played = CASE WHEN excluded.play_count > 0
                       THEN MAX(COALESCE(last_played, ''), excluded.last_played)
                       ELSE last_played END,
    first_played = CASE WHEN excluded.play_count > 0
                        THEN MIN(COALESCE(first_played, excluded.first_played), excluded.first_played)
                        ELSE first_played END,
    listened_ms = listened_ms + excluded.listened_ms,
    skip_count = skip_count + excluded.skip_count`;

// Insert one event and bump the derived stores. True when the row was new;
// false when event_id already existed, in which case NOTHING else moves —
// that is what makes an outbox replay safe. Not transactional on its own:
// wrap a batch in recordPlayEvents (or manager.transaction) so a mid-batch
// failure can't leave an event without its rollup.
export function recordPlayEvent(d, ev) {
  const row = normalizeEvent(ev);
  const r = d.prepare(INSERT_EVENT).run(
    row.event_id, row.user_id, row.track_hash, row.filepath, row.library_id, row.peer_id,
    row.snapshot, row.client, row.session_id, row.source, row.outcome, row.counted,
    row.played_ms, row.duration_ms, row.pause_count, row.started_at, row.ended_at);
  if (Number(r.changes) === 0) { return false; }
  const skipped = row.outcome === 'skipped' ? 1 : 0;
  d.prepare(BUMP_HOUR).run(row.user_id, hourKey(fromSqlite(row.started_at)), row.counted, skipped, row.played_ms);
  if (row.track_hash) {
    const when = row.counted ? row.started_at : null;
    d.prepare(BUMP_TRACK).run(row.user_id, row.track_hash, row.counted, when, when, row.played_ms, skipped);
  }
  return true;
}

// Record a batch atomically. Returns { inserted, duplicates }. Pass
// transactional:false from inside an outer transaction (manager.transaction).
export function recordPlayEvents(d, events, { transactional = true } = {}) {
  let inserted = 0;
  let duplicates = 0;
  const run = () => {
    for (const ev of events) {
      if (recordPlayEvent(d, ev)) { inserted++; } else { duplicates++; }
    }
  };
  if (!transactional) { run(); return { inserted, duplicates }; }
  d.exec('BEGIN IMMEDIATE');
  try {
    run();
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
  return { inserted, duplicates };
}

// ── Removal ──────────────────────────────────────────────────────────────
//
// Deleting an event subtracts exactly what recording it added: its hour row
// (dropped once it holds no events) and its track's counters. A track's
// first/last played are then recomputed from the counted events that
// remain; when none remain but plays predate the log (play_count still
// above zero — the legacy count routes never wrote events) the dates are
// left as they are, since the log cannot say when those plays were; and
// when the count is zero they are cleared.

const EVENT_COLS = 'id, event_id, user_id, track_hash, outcome, counted, played_ms, started_at';

function subtractEvent(d, ev) {
  const skipped = ev.outcome === 'skipped' ? 1 : 0;
  const hour = hourKey(fromSqlite(ev.started_at));
  d.prepare(`
    UPDATE user_hour_stats
       SET events = MAX(events - 1, 0), plays = MAX(plays - ?, 0),
           skips = MAX(skips - ?, 0), listened_ms = MAX(listened_ms - ?, 0)
     WHERE user_id = ? AND hour = ?`).run(ev.counted, skipped, ev.played_ms, ev.user_id, hour);
  d.prepare('DELETE FROM user_hour_stats WHERE user_id = ? AND hour = ? AND events <= 0').run(ev.user_id, hour);
  if (ev.track_hash) {
    d.prepare(`
      UPDATE user_metadata
         SET play_count = MAX(play_count - ?, 0), skip_count = MAX(skip_count - ?, 0),
             listened_ms = MAX(listened_ms - ?, 0)
       WHERE user_id = ? AND track_hash = ?`).run(ev.counted, skipped, ev.played_ms, ev.user_id, ev.track_hash);
  }
}

function refreshTrackTimes(d, userId, trackHash) {
  const um = d.prepare('SELECT play_count FROM user_metadata WHERE user_id = ? AND track_hash = ?').get(userId, trackHash);
  if (!um) { return; }
  const r = d.prepare(`
    SELECT MIN(started_at) AS first, MAX(started_at) AS last, COUNT(*) AS n
      FROM play_events WHERE user_id = ? AND track_hash = ? AND counted = 1`).get(userId, trackHash);
  if (r.n > 0) {
    d.prepare('UPDATE user_metadata SET first_played = ?, last_played = ? WHERE user_id = ? AND track_hash = ?')
      .run(r.first, r.last, userId, trackHash);
  } else if (!(um.play_count > 0)) {
    d.prepare('UPDATE user_metadata SET first_played = NULL, last_played = NULL WHERE user_id = ? AND track_hash = ?')
      .run(userId, trackHash);
  }
}

// Delete [userId]'s events by id list, or every event that started in
// [from, to) (stored-text bounds). Atomic. Returns { deleted }.
export function deletePlayEvents(d, userId, { eventIds = null, from = null, to = null } = {}) {
  let rows;
  if (Array.isArray(eventIds)) {
    if (eventIds.length === 0) { return { deleted: 0 }; }
    rows = d.prepare(`SELECT ${EVENT_COLS} FROM play_events WHERE user_id = ? AND event_id IN (${eventIds.map(() => '?').join(',')})`)
      .all(userId, ...eventIds);
  } else if (from != null && to != null) {
    rows = d.prepare(`SELECT ${EVENT_COLS} FROM play_events WHERE user_id = ? AND started_at >= ? AND started_at < ?`)
      .all(userId, from, to);
  } else {
    throw new TypeError('deletePlayEvents needs eventIds or a from/to range');
  }
  if (rows.length === 0) { return { deleted: 0 }; }
  d.exec('BEGIN IMMEDIATE');
  try {
    const hashes = new Set();
    const del = d.prepare('DELETE FROM play_events WHERE id = ?');
    for (const ev of rows) {
      subtractEvent(d, ev);
      del.run(ev.id);
      if (ev.track_hash) { hashes.add(ev.track_hash); }
    }
    for (const h of hashes) { refreshTrackTimes(d, userId, h); }
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
  return { deleted: rows.length };
}

// ── Reset ────────────────────────────────────────────────────────────────
//
// 'counts' zeroes the per-track counters (stars and ratings stay); 'history'
// drops the log and its hourly rollup; 'all' does both. Counts without
// history is the legacy reset — the log then says more than the counters,
// which is what the user asked for.
export const RESET_SCOPES = new Set(['counts', 'history', 'all']);

export function resetStats(d, userId, scope) {
  if (!RESET_SCOPES.has(scope)) { throw new TypeError('scope'); }
  const out = { tracks: 0, events: 0 };
  d.exec('BEGIN IMMEDIATE');
  try {
    if (scope === 'counts' || scope === 'all') {
      out.tracks = Number(d.prepare(`
        UPDATE user_metadata
           SET play_count = 0, skip_count = 0, listened_ms = 0, first_played = NULL, last_played = NULL
         WHERE user_id = ?`).run(userId).changes);
    }
    if (scope === 'history' || scope === 'all') {
      out.events = Number(d.prepare('DELETE FROM play_events WHERE user_id = ?').run(userId).changes);
      d.prepare('DELETE FROM user_hour_stats WHERE user_id = ?').run(userId);
    }
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
  return out;
}

// ── Rebuild ──────────────────────────────────────────────────────────────
//
// Recompute the hourly rollup from the events on hand: every hour that
// still has events is rewritten exactly; an hour with none keeps its row,
// because it may be older than retention — the rollup is the part of the
// history that outlives the raw events, so a rebuild must never erase it.
export function rebuildHourStats(d, { userId = null } = {}) {
  const where = userId != null ? 'WHERE user_id = ?' : '';
  const params = userId != null ? [userId] : [];
  const r = d.prepare(`
    INSERT INTO user_hour_stats (user_id, hour, events, plays, skips, listened_ms)
    SELECT user_id, strftime('%Y-%m-%dT%H', started_at), COUNT(*), SUM(counted),
           SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END), SUM(played_ms)
      FROM play_events ${where}
     GROUP BY 1, 2
    ON CONFLICT (user_id, hour) DO UPDATE SET
      events = excluded.events, plays = excluded.plays,
      skips = excluded.skips, listened_ms = excluded.listened_ms`).run(...params);
  return { hours: Number(r.changes) };
}

// ── Retention ────────────────────────────────────────────────────────────
//
// Prune raw events that started before the retention floor. Counters and
// the hourly rollup are deliberately untouched: the totals survive, only
// the per-play rows go. Returns { deleted, cutoff }.
export function sweepRetention(d, { retentionMonths, now = new Date() } = {}) {
  if (!(retentionMonths > 0)) { return { deleted: 0, cutoff: null }; }
  const cutoff = toSqlite(retentionFloor(now, retentionMonths));
  const r = d.prepare('DELETE FROM play_events WHERE started_at < ?').run(cutoff);
  return { deleted: Number(r.changes), cutoff };
}

