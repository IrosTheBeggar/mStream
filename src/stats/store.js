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

import { toSqlite, fromSqlite, hourKey } from './time.js';

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
