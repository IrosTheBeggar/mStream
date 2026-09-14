// Stats API v2 — the ingest core.
//
// Clients report COMPLETE plays after the fact; the server decides what
// counts. One batch in, three lists out:
//   accepted    stored; counters and the hourly rollup bumped
//   duplicates  an id this user already sent — acknowledged, nothing moved.
//               This is what makes an offline outbox safe to retry forever.
//   rejected    { id, reason } — the client should drop the play:
//               unknown-track  the path names no scanned track in a library
//                              this user can see
//               unknown-peer   peerId is not a peer this server lists
//               bad-time       startedAt / endedAt unparsable, more than five
//                              minutes ahead of the server clock, or older
//                              than the retention window
//               invalid        a peer play without its snapshot, or an id
//                              another user already owns
//
// The write itself is src/stats/store.js (recordPlayEvent), the one path
// every writer shares; this module resolves, judges and batches. The library
// resolver is injectable so the whole thing runs on an in-memory database in
// tests — the default goes through getVPathInfo, which needs the live
// manager.

import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import { recordPlayEvent } from './store.js';
import { fromSqlite, retentionFloor } from './time.js';

export { retentionFloor };

export const REASONS = Object.freeze({
  unknownTrack: 'unknown-track',
  unknownPeer: 'unknown-peer',
  badTime: 'bad-time',
  invalid: 'invalid',
});

export const MAX_BATCH = 200;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const DEFAULTS = Object.freeze({
  playThresholdMs: 30000,
  playThresholdFraction: 0.5,
  retentionMonths: 24,
});

// The play-threshold rule: at least playThresholdMs listened, or at least
// playThresholdFraction of a known duration. The verdict is stored on the
// row, so changing the config later never rewrites history.
export function decideCounted(playedMs, durationMs, cfg = DEFAULTS) {
  const thresholdMs = cfg?.playThresholdMs ?? DEFAULTS.playThresholdMs;
  const fraction = cfg?.playThresholdFraction ?? DEFAULTS.playThresholdFraction;
  if (!Number.isInteger(playedMs) || playedMs < 0) { return false; }
  if (playedMs >= thresholdMs) { return true; }
  if (Number.isInteger(durationMs) && durationMs > 0 && fraction > 0) {
    return playedMs >= durationMs * fraction;
  }
  return false;
}

// A client instant: ISO 8601, the stored SQLite text, or epoch milliseconds.
export function parseInstant(v) {
  if (v instanceof Date) { return Number.isNaN(v.getTime()) ? null : v; }
  if (Number.isInteger(v)) { return v >= 0 ? new Date(v) : null; }
  if (typeof v === 'string' && v.length > 0) {
    const d = fromSqlite(v) || new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// The start instant, or null when it is unparsable, more than futureSkewMs
// ahead of the server clock, or before the retention floor.
export function checkStartedAt(value, {
  now = new Date(), retentionMonths = DEFAULTS.retentionMonths, futureSkewMs = FUTURE_SKEW_MS,
} = {}) {
  const d = parseInstant(value);
  if (!d) { return null; }
  if (d.getTime() > now.getTime() + futureSkewMs) { return null; }
  if (d.getTime() < retentionFloor(now, retentionMonths).getTime()) { return null; }
  return d;
}

const stripSlash = (p) => (typeof p === 'string' && p.startsWith('/') ? p.slice(1) : p);

// A scanned track by (library, relative path): the canonical key (audio
// hash, else file hash), the library id, the path, the library's own
// duration for when the client sent none, and the title / artist / album
// strings the Last.fm forwarder needs. A row with no hash at all (a failed
// parse) resolves with trackHash null — the event is kept for history, but
// there is no counter row to bump.
export function lookupTrack(d, libraryId, relativePath) {
  const row = d.prepare(`SELECT t.audio_hash, t.file_hash, t.duration, t.title,
                                a.name AS artist, al.name AS album
                           FROM tracks t
                           LEFT JOIN artists a ON a.id = t.artist_id
                           LEFT JOIN albums al ON al.id = t.album_id
                          WHERE t.filepath = ? AND t.library_id = ?`)
    .get(relativePath, libraryId);
  if (!row) { return null; }
  return {
    trackHash: row.audio_hash || row.file_hash || null,
    libraryId,
    filepath: relativePath,
    durationMs: typeof row.duration === 'number' && row.duration > 0 ? Math.round(row.duration * 1000) : null,
    title: row.title ?? null,
    artist: row.artist ?? null,
    album: row.album ?? null,
  };
}

// The production resolver: a vpath-prefixed path, scoped to the user's
// libraries by getVPathInfo (which also refuses dot-segments).
export function resolveLocalTrack(d, filePath, user) {
  let info;
  try { info = getVPathInfo(filePath, user); } catch (_) { return null; }
  const lib = db.getLibraryByName(info.vpath);
  if (!lib) { return null; }
  return lookupTrack(d, lib.id, info.relativePath);
}

// Ingest one validated batch for [user]. Rejections are per play; the
// accepted plays commit together, so a database failure rolls the whole
// batch back and throws. Options: config (the `stats` block), now, peers
// (this server's federation_peers rows), client (stored on every row),
// resolveLocal (injectable for tests), onStored — called once AFTER the
// commit with the plays that were actually inserted, as [{ event, track }]
// (the stored event and the resolved track it was matched to), never for a
// duplicate or a rejection; the Last.fm forwarder hangs off it. It is not
// called when nothing was inserted.
export function ingestPlays(d, user, body, {
  config = DEFAULTS, now = new Date(), peers = [], client = null, resolveLocal = resolveLocalTrack,
  onStored = null,
} = {}) {
  const accepted = [];
  const duplicates = [];
  const rejected = [];
  const seen = new Set();
  const prepared = [];
  const stored = [];
  const retentionMonths = config?.retentionMonths ?? DEFAULTS.retentionMonths;

  for (const play of body?.plays || []) {
    const id = play.id;
    if (seen.has(id)) { duplicates.push(id); continue; }
    seen.add(id);

    const startedAt = checkStartedAt(play.startedAt, { now, retentionMonths });
    if (!startedAt) { rejected.push({ id, reason: REASONS.badTime }); continue; }
    let endedAt = null;
    if (play.endedAt != null) {
      endedAt = parseInstant(play.endedAt);
      if (!endedAt) { rejected.push({ id, reason: REASONS.badTime }); continue; }
    }
    if (!endedAt || endedAt < startedAt) {
      endedAt = new Date(startedAt.getTime() + (play.playedMs || 0));
    }

    let track;
    if (play.peerId != null) {
      if (!peers.some((p) => p.id === play.peerId)) { rejected.push({ id, reason: REASONS.unknownPeer }); continue; }
      if (!play.track || typeof play.track !== 'object') { rejected.push({ id, reason: REASONS.invalid }); continue; }
      const snap = play.track;
      track = {
        trackHash: typeof snap.hash === 'string' && snap.hash.length > 0 ? snap.hash : null,
        libraryId: null,
        peerId: play.peerId,
        filepath: stripSlash(play.filePath),
        snapshot: snap,
        durationMs: play.durationMs ?? (Number.isInteger(snap.durationMs) ? snap.durationMs : null),
      };
    } else {
      const t = resolveLocal(d, play.filePath, user);
      if (!t) { rejected.push({ id, reason: REASONS.unknownTrack }); continue; }
      track = { ...t, peerId: null, snapshot: null, durationMs: play.durationMs ?? t.durationMs ?? null };
    }

    prepared.push({
      id,
      track,
      event: {
        eventId: id,
        userId: user.id,
        trackHash: track.trackHash,
        filepath: track.filepath,
        libraryId: track.libraryId,
        peerId: track.peerId,
        snapshot: track.snapshot,
        client,
        sessionId: play.sessionId ?? null,
        source: play.source ?? null,
        outcome: play.outcome,
        counted: decideCounted(play.playedMs, track.durationMs, config),
        playedMs: play.playedMs,
        durationMs: track.durationMs,
        pauseCount: play.pauseCount ?? 0,
        startedAt,
        endedAt,
      },
    });
  }

  if (prepared.length > 0) {
    d.exec('BEGIN IMMEDIATE');
    try {
      const owner = d.prepare('SELECT user_id FROM play_events WHERE event_id = ?');
      for (const { id, event, track } of prepared) {
        const existing = owner.get(id);
        if (existing) {
          if (existing.user_id === user.id) { duplicates.push(id); } else { rejected.push({ id, reason: REASONS.invalid }); }
          continue;
        }
        recordPlayEvent(d, event);
        accepted.push(id);
        stored.push({ event, track });
      }
      d.exec('COMMIT');
    } catch (err) {
      try { d.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    }
  }
  if (onStored && stored.length > 0) { onStored(stored); }
  return { accepted, duplicates, rejected };
}
