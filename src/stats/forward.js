// Stats API v2 — forwarding counted plays to Last.fm.
//
// Ingest stores a play first (src/stats/ingest.js); after the commit the
// route hands the stored plays here, and for a user who linked a Last.fm
// account (admin panel → users → Last.fm) each COUNTED play becomes a
// scrobble carrying the play's own start time — the point of reporting
// plays after the fact is that an offline afternoon lands on the right day.
// Last.fm's own rules are applied here so nothing it would ignore is sent:
//   - the timestamp must fall within the last 14 days, and never ahead of now
//   - artist and track are required: a local play's strings come from the
//     library (ingest's resolved track), a peer play's from its snapshot
//   - a track shorter than 30 seconds is never scrobbled
// Best-effort by construction: one queue drained a request at a time with a
// gap between sends (Last.fm allows about five requests per second per IP,
// and an outbox may hand over two hundred plays at once), failures logged
// and dropped, and no HTTP request ever in the ingest response's path.
// The legacy scrobble shim (src/api/scrobbler.js) keeps its own direct call
// — it never goes through ingest, so nothing is forwarded twice.

import winston from 'winston';
import { scrobbleAt } from '../api/scrobbler.js';

export const LASTFM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const LASTFM_MIN_TRACK_MS = 30000;
export const DEFAULT_SPACING_MS = 250;
export const DEFAULT_MAX_QUEUE = 1000;

const str = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

// The Last.fm scrobble for one stored play, or null when Last.fm would not
// take it. `event` is the stored event (counted, startedAt, durationMs,
// peerId, snapshot); `track` is ingest's resolved track, which carries
// title / artist / album for a local play.
export function scrobbleFor(event, track, now = new Date()) {
  if (!event?.counted) { return null; }
  const started = event.startedAt instanceof Date ? event.startedAt : new Date(event.startedAt);
  if (Number.isNaN(started.getTime())) { return null; }
  const age = now.getTime() - started.getTime();
  if (age < 0 || age > LASTFM_WINDOW_MS) { return null; }
  const src = event.peerId != null ? (event.snapshot || {}) : (track || {});
  const artist = str(src.artist);
  const title = str(src.title);
  if (!artist || !title) { return null; }
  const durationMs = Number.isInteger(event.durationMs) && event.durationMs > 0 ? event.durationMs : null;
  if (durationMs != null && durationMs < LASTFM_MIN_TRACK_MS) { return null; }
  const song = {
    artist,
    track: title,
    album: str(src.album) || undefined,
    timestamp: Math.floor(started.getTime() / 1000),
  };
  if (durationMs != null) { song.duration = Math.round(durationMs / 1000); }
  return song;
}

// The scrobbles for a batch of stored plays ({ event, track } each).
export function planScrobbles(stored, now = new Date()) {
  const out = [];
  for (const s of stored || []) {
    const song = scrobbleFor(s.event, s.track, now);
    if (song) { out.push(song); }
  }
  return out;
}

// A forwarding queue. `send(user, song)` resolves { ok, error } and never
// throws in production (scrobbleAt); the queue guards against it anyway.
// Injectable for tests: send, the gap, the cap, the logger, the sleeper.
export function createForwarder({
  send = scrobbleAt,
  spacingMs = DEFAULT_SPACING_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
  log = winston,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const queue = [];
  const stats = { sent: 0, failed: 0, dropped: 0 };
  let draining = null;

  async function drain() {
    while (queue.length > 0) {
      const { user, song } = queue.shift();
      let r;
      try { r = await send(user, song); } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
      const what = `${song.artist} — ${song.track} @${song.timestamp} for ${user.lastfm_user}`;
      if (r?.ok) {
        stats.sent++;
        log.debug(`[stats] last.fm: scrobbled ${what}`);
      } else {
        stats.failed++;
        log.debug(`[stats] last.fm: scrobble of ${what} failed: ${r?.error || 'unknown'}`);
      }
      if (queue.length > 0 && spacingMs > 0) { await sleep(spacingMs); }
    }
    draining = null;
  }

  return {
    // Queue every song for [user]. Returns how many were queued — 0 when
    // the account has no Last.fm credentials. Only what a send needs is
    // kept: the account's id and its Last.fm credentials.
    enqueue(user, songs) {
      if (!user?.lastfm_user || !user?.lastfm_password || !songs?.length) { return 0; }
      const account = { id: user.id, lastfm_user: user.lastfm_user, lastfm_password: user.lastfm_password };
      let dropped = 0;
      for (const song of songs) {
        if (queue.length >= maxQueue) { queue.shift(); dropped++; }
        queue.push({ user: account, song });
      }
      if (dropped > 0) {
        stats.dropped += dropped;
        log.warn(`[stats] last.fm: forwarding queue full, dropped the ${dropped} oldest scrobble(s)`);
      }
      if (!draining) { draining = drain(); }
      return songs.length;
    },
    // Resolves once the queue has drained — for tests and shutdown.
    idle() { return draining || Promise.resolve(); },
    get pending() { return queue.length; },
    stats,
  };
}

// The process-wide queue the routes use.
let shared = null;
export function forwarder() {
  if (!shared) { shared = createForwarder(); }
  return shared;
}
