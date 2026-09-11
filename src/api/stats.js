// Stats API v2.
//
//   POST /api/v1/stats/plays       record a batch of complete plays (the write side)
//   GET  /api/v1/stats/summary     the period's numbers (the old Wrapped view, as data)
//   GET  /api/v1/stats/top         ranked tracks / artists / albums / genres
//   GET  /api/v1/stats/timeseries  plays and listening time per bucket, in the caller's zone
//   GET  /api/v1/stats/history     the listening log, newest first, cursor-paginated,
//                                  filterable by any hash a client knows a track by
//   POST /api/v1/stats/tracks      per-track counters for a batch of paths / hashes
//   GET  /api/v1/stats/periods     which periods have data
//   DELETE /api/v1/stats/plays/:id  forget one play (counters and rollup follow)
//   DELETE /api/v1/stats/plays?from=&to=  forget every play in a range
//   POST /api/v1/stats/reset       zero the counters, drop the log, or both
//   GET  /api/v1/stats/export      the whole log as NDJSON
//   POST /api/v1/admin/stats/rebuild  recompute the hourly rollup from the log
//   POST /api/v1/stats/now-playing what the caller is playing right now (no row)
//   GET  /api/v1/stats/now-playing the caller's own current plays
//
// Write side: clients (the mobile app's outbox, the web player) send plays
// AFTER they happen, with their own ids and start times. The server resolves
// each path to a track, decides whether it counts (config
// `stats.playThreshold*`), and answers per play — accepted / duplicates /
// rejected with a reason — so an outbox knows what to drop and what to
// retry. Rules in src/stats/ingest.js, the write in src/stats/store.js.
// After the commit, a linked Last.fm account gets each counted play as a
// scrobble with the play's own start time (src/stats/forward.js) — queued,
// best-effort, never in the response's path.
//
// Read side: every read is scoped to the caller — their events, their
// visible libraries (`ignoreVPaths` narrows further), and their timezone
// (`tz`, an IANA name, default UTC — day, week and month boundaries follow
// it). A range is either a preset `period` (+ `offset` ≤ 0) or an explicit
// `from` / `to` pair of ISO instants; `origin` keeps local plays, federated
// plays, or both. Queries in src/stats/queries.js, period arithmetic in
// src/stats/time.js.
//
// Never reachable with a federation key or a guest token: the wall's
// allowlist does not carry these routes, and the synthetic user those tokens
// build has no id to record against or read for. The surface is advertised
// as `features.stats` (src/api/server-info.js); clients gate on that, never
// on the version string.

import Joi from 'joi';
import winston from 'winston';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as config from '../state/config.js';
import WebError from '../util/web-error.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';
import * as q from '../stats/queries.js';
import { ingestPlays, resolveLocalTrack, MAX_BATCH } from '../stats/ingest.js';
import { forwarder, planScrobbles } from '../stats/forward.js';
import { nowPlayingAt } from './scrobbler.js';
import {
  OUTCOMES, SOURCES, RESET_SCOPES, deletePlayEvents, resetStats, rebuildHourStats,
} from '../stats/store.js';
import {
  isValidTimeZone, isBucket, periodRange, customRange, toSqlite, fromSqlite, toIso,
} from '../stats/time.js';

const d = () => db.getDB();

// ── Write side ────────────────────────────────────────────────────────────

const instant = Joi.alternatives().try(Joi.string().isoDate(), Joi.number().integer().min(0));

// 'legacy' is reserved for the server's own scrobble-by-filepath route — a
// legacy route kept for older clients — so a client can never claim it.
const CLIENT_SOURCES = [...SOURCES].filter((s) => s !== 'legacy');

// What a client knows about a track this library can't look up — required
// for a federated peer's track, ignored for a local one (the library is the
// truth there).
const trackSnapshot = Joi.object({
  title: Joi.string().max(512).allow(''),
  artist: Joi.string().max(512).allow(''),
  album: Joi.string().max(512).allow(''),
  durationMs: Joi.number().integer().min(0),
  hash: Joi.string().max(128),
  artFile: Joi.string().max(512),
});

const playSchema = Joi.object({
  id: Joi.string().min(1).max(128).required(),
  filePath: Joi.string().min(1).max(2048).required(),
  peerId: Joi.number().integer().min(1),
  startedAt: instant.required(),
  endedAt: instant,
  playedMs: Joi.number().integer().min(0).required(),
  durationMs: Joi.number().integer().min(0),
  outcome: Joi.string().valid(...OUTCOMES).required(),
  source: Joi.string().valid(...CLIENT_SOURCES),
  sessionId: Joi.string().max(128),
  pauseCount: Joi.number().integer().min(0).default(0),
  track: trackSnapshot,
});

const bodySchema = Joi.object({
  client: Joi.object({
    name: Joi.string().min(1).max(64).required(),
    version: Joi.string().max(32).allow(''),
    instanceId: Joi.string().max(64),
  }),
  plays: Joi.array().items(playSchema).min(1).max(MAX_BATCH).required(),
});
// The wire contract, for the tests of the clients that post here (the
// webapp's play sessions validate what they build against it).
export const playsBodySchema = bodySchema;

// `name/version`, the form stored on every row and shown in history.
export function clientLabel(c) {
  if (!c) { return null; }
  return `${c.name}${c.version ? `/${c.version}` : ''}`.slice(0, 128);
}

// ── Now playing ───────────────────────────────────────────────────────────
//
// What a client is playing right now: per user, in memory, gone after
// NOW_PLAYING_TTL_MS unless the client posts again (a track longer than that
// is re-announced by its player). Writes no row — the play itself arrives
// through /stats/plays once it is over. A linked Last.fm account gets the
// now-playing notice. Keyed by the client's sessionId, so two players of the
// same user show as two entries and a re-post replaces its own.
export const NOW_PLAYING_TTL_MS = 10 * 60 * 1000;
const nowPlaying = new Map();   // userId → Map(sessionId → entry)

function liveNowPlaying(userId, nowMs) {
  const mine = nowPlaying.get(userId);
  if (!mine) { return null; }
  for (const [k, e] of mine) { if (e.expiresMs <= nowMs) { mine.delete(k); } }
  if (mine.size === 0) { nowPlaying.delete(userId); return null; }
  return mine;
}

const nowPlayingSchema = Joi.object({
  filePath: Joi.string().min(1).max(2048).required(),
  peerId: Joi.number().integer().min(1),
  sessionId: Joi.string().min(1).max(128).required(),
  track: trackSnapshot,
});

// ── Read side ─────────────────────────────────────────────────────────────

const PERIOD_VALUES = ['week', 'month', 'quarter', 'half', 'year', 'all'];
const ORIGIN_VALUES = ['all', 'local', 'peers'];

// Express parses a repeated key into an array; a single value arrives as a
// string, which may itself be a comma list. Both shapes are accepted.
const ignoreVPathsSchema = Joi.alternatives().try(
  Joi.array().items(Joi.string().max(256)).max(100),
  Joi.string().max(4096));
function normIgnore(v) {
  if (v == null) { return undefined; }
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

const rangeKeys = {
  period: Joi.string().valid(...PERIOD_VALUES),
  offset: Joi.number().integer().max(0).min(-1000).default(0),
  from: Joi.string().isoDate(),
  to: Joi.string().isoDate(),
  tz: Joi.string().max(64).default('UTC'),
  ignoreVPaths: ignoreVPathsSchema,
  origin: Joi.string().valid(...ORIGIN_VALUES).default('all'),
};

function resolveRange(v) {
  if (!isValidTimeZone(v.tz)) { throw new WebError(`Unknown timezone '${v.tz}'`, 400); }
  if ((v.from == null) !== (v.to == null)) { throw new WebError('from and to must be given together', 400); }
  let r;
  try {
    r = v.from != null
      ? customRange(v.from, v.to)
      : periodRange({ period: v.period || 'month', offset: v.offset, tz: v.tz });
  } catch (err) {
    throw new WebError(err.message, 400);
  }
  return { ...r, tz: v.tz, fromText: toSqlite(r.from), toText: toSqlite(r.to) };
}

const periodOut = (r) => ({ label: r.label, from: r.from.toISOString(), to: r.to.toISOString(), tz: r.tz });

// History cursor: opaque to clients, (started_at, id) underneath so a page
// boundary inside one second stays exact.
function encodeCursor(next) {
  return next ? Buffer.from(JSON.stringify({ s: next.startedAt, i: next.id })).toString('base64url') : null;
}
function decodeCursor(text) {
  if (text == null) { return null; }
  try {
    const v = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    if (typeof v?.s !== 'string' || !fromSqlite(v.s) || !Number.isInteger(v?.i)) { throw new Error('shape'); }
    return { startedAt: v.s, id: v.i };
  } catch (_) {
    throw new WebError('Invalid cursor', 400);
  }
}

// The canonical per-track key for a library path, as user_metadata keys it.
function hashForPath(filePath, user) {
  let info;
  try { info = getVPathInfo(filePath, user); } catch (_) { return null; }
  const lib = db.getLibraryByName(info.vpath);
  if (!lib) { return null; }
  const row = d().prepare('SELECT audio_hash, file_hash FROM tracks WHERE filepath = ? AND library_id = ?')
    .get(info.relativePath, lib.id);
  return row ? (row.audio_hash || row.file_hash || null) : null;
}

// A federation key or a guest token builds a user with no id; stats are
// never recorded against or read for one.
function requireAccount(req) {
  if (!req.user?.id || req.user.federation) { throw new WebError('Forbidden', 403); }
}

export function setup(mstream) {
  mstream.post('/api/v1/stats/plays', (req, res) => {
    requireAccount(req);
    const { value } = joiValidate(bodySchema, req.body || {});
    const now = new Date();
    const result = ingestPlays(db.getDB(), req.user, value, {
      config: config.program.stats,
      now,
      peers: fedDb.getFederationPeers(),
      client: clientLabel(value.client),
      // After the commit: the counted plays go on to Last.fm for a linked
      // account, with their own start times. Queued — never in the
      // response's path, and never able to fail the request.
      onStored: (stored) => {
        try { forwarder().enqueue(req.user, planScrobbles(stored, now)); }
        catch (err) { winston.warn(`[stats] last.fm forwarding skipped: ${err.message}`); }
      },
    });
    res.json(result);
  });

  mstream.post('/api/v1/stats/now-playing', (req, res) => {
    requireAccount(req);
    const { value } = joiValidate(nowPlayingSchema, req.body || {});
    const nowMs = Date.now();
    let track;
    if (value.peerId != null) {
      if (!fedDb.getFederationPeers().some((p) => p.id === value.peerId)) {
        return res.json({ accepted: false, reason: 'unknown-peer' });
      }
      if (!value.track) { return res.json({ accepted: false, reason: 'invalid' }); }
      const snap = value.track;
      track = {
        title: snap.title ?? null, artist: snap.artist ?? null, album: snap.album ?? null,
        durationMs: snap.durationMs ?? null, hash: snap.hash ?? null,
      };
    } else {
      const t = resolveLocalTrack(d(), value.filePath, req.user);
      if (!t) { return res.json({ accepted: false, reason: 'unknown-track' }); }
      track = { title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, hash: t.trackHash };
    }
    const expiresMs = nowMs + NOW_PLAYING_TTL_MS;
    const entry = {
      sessionId: value.sessionId,
      filePath: value.filePath,
      peerId: value.peerId ?? null,
      track,
      since: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      expiresMs,
    };
    const mine = liveNowPlaying(req.user.id, nowMs) || new Map();
    mine.set(entry.sessionId, entry);
    nowPlaying.set(req.user.id, mine);
    res.json({ accepted: true, expiresAt: entry.expiresAt });

    // The Last.fm notice, after the response and best-effort.
    if (req.user.lastfm_user && req.user.lastfm_password && track.artist && track.title) {
      const song = { artist: track.artist, track: track.title, album: track.album || undefined };
      if (Number.isInteger(track.durationMs) && track.durationMs > 0) { song.duration = Math.round(track.durationMs / 1000); }
      nowPlayingAt(req.user, song)
        .then((r) => { if (!r.ok) { winston.debug(`[stats] last.fm: now-playing notice failed: ${r.error}`); } })
        .catch((err) => winston.debug(`[stats] last.fm: now-playing notice failed: ${err.message}`));
    }
  });

  mstream.get('/api/v1/stats/now-playing', (req, res) => {
    requireAccount(req);
    const mine = liveNowPlaying(req.user.id, Date.now());
    const entries = mine ? [...mine.values()].map(({ expiresMs: _e, ...e }) => e) : [];
    res.json({ entries });
  });

  mstream.get('/api/v1/stats/summary', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object(rangeKeys), req.query);
    const r = resolveRange(v);
    const body = q.summary(d(), {
      user: req.user,
      from: r.fromText, to: r.toText, fromDate: r.from, toDate: r.to,
      tz: r.tz, origin: v.origin, ignoreVPaths: normIgnore(v.ignoreVPaths),
    });
    res.json({ period: periodOut(r), ...body });
  });

  mstream.get('/api/v1/stats/top', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({
      ...rangeKeys,
      entity: Joi.string().valid('tracks', 'artists', 'albums', 'genres').default('tracks'),
      metric: Joi.string().valid('plays', 'time').default('plays'),
      limit: Joi.number().integer().min(1).max(200).default(20),
    }), req.query);
    const r = resolveRange(v);
    const args = {
      user: req.user, userId: req.user.id,
      from: r.fromText, to: r.toText,
      scope: q.eventScope(req.user, normIgnore(v.ignoreVPaths)),
      origin: v.origin, metric: v.metric, limit: v.limit, entity: v.entity,
    };
    const items = v.entity === 'tracks' ? q.topTracks(d(), args) : q.topGroups(d(), args);
    res.json({ period: periodOut(r), entity: v.entity, metric: v.metric, items });
  });

  mstream.get('/api/v1/stats/timeseries', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({
      ...rangeKeys,
      bucket: Joi.string().valid('hour', 'day', 'week', 'month', 'hourOfDay', 'weekday').default('day'),
    }), req.query);
    const r = resolveRange(v);
    if (!isBucket(v.bucket)) { throw new WebError('Unknown bucket', 400); }
    const rows = q.scopedHourRows(d(), {
      user: req.user, from: r.fromText, to: r.toText, fromDate: r.from, toDate: r.to,
      origin: v.origin, ignoreVPaths: normIgnore(v.ignoreVPaths),
    });
    res.json({ period: periodOut(r), bucket: v.bucket, items: q.rebucket(rows, v.bucket, r.tz) });
  });

  mstream.get('/api/v1/stats/history', (req, res) => {
    requireAccount(req);
    // The range is optional here: without one, the whole log, newest first.
    const { value: v } = joiValidate(Joi.object({
      ...rangeKeys,
      before: Joi.string().max(512),
      limit: Joi.number().integer().min(1).max(200).default(50),
      track: Joi.string().max(128),
    }), req.query);
    const r = (v.period != null || v.from != null) ? resolveRange(v) : null;
    const { items, next } = q.history(d(), {
      user: req.user, origin: v.origin, ignoreVPaths: normIgnore(v.ignoreVPaths),
      from: r ? r.fromText : null, to: r ? r.toText : null,
      trackHash: v.track ?? null, before: decodeCursor(v.before), limit: v.limit,
    });
    res.json({ items, next: encodeCursor(next), ...(r ? { period: periodOut(r) } : {}) });
  });

  mstream.post('/api/v1/stats/tracks', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({
      filePaths: Joi.array().items(Joi.string().max(2048)).max(500),
      hashes: Joi.array().items(Joi.string().max(128)).max(500),
    }).or('filePaths', 'hashes'), req.body || {});
    // Resolve every path to its canonical hash first, so one lookup answers
    // both lists and a path is reported under the key the client sent.
    const byPath = new Map();
    for (const p of v.filePaths || []) { byPath.set(p, hashForPath(p, req.user)); }
    const wanted = [...new Set([...(v.hashes || []), ...[...byPath.values()].filter(Boolean)])];
    const stats = q.trackStats(d(), req.user.id, wanted);
    const render = (hash, filePath) => {
      const s = stats.get(hash);
      if (!s) { return null; }
      return {
        hash,
        ...(filePath != null ? { filePath } : {}),
        plays: s.play_count || 0,
        skips: s.skip_count || 0,
        listenedMs: s.listened_ms || 0,
        firstPlayed: toIso(s.first_played),
        lastPlayed: toIso(s.last_played),
      };
    };
    const items = [];
    for (const [p, h] of byPath) { const it = h && render(h, p); if (it) { items.push(it); } }
    for (const h of v.hashes || []) { const it = render(h); if (it) { items.push(it); } }
    res.json({ items });
  });

  // ── Management ──

  mstream.delete('/api/v1/stats/plays/:id', (req, res) => {
    requireAccount(req);
    const { value } = joiValidate(Joi.object({ id: Joi.string().min(1).max(128).required() }), req.params);
    const r = deletePlayEvents(d(), req.user.id, { eventIds: [value.id] });
    if (r.deleted === 0) { throw new WebError('No such play', 404); }
    res.json(r);
  });

  mstream.delete('/api/v1/stats/plays', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({
      from: Joi.string().isoDate().required(),
      to: Joi.string().isoDate().required(),
    }), req.query);
    let r;
    try { r = customRange(v.from, v.to); } catch (err) { throw new WebError(err.message, 400); }
    res.json(deletePlayEvents(d(), req.user.id, { from: toSqlite(r.from), to: toSqlite(r.to) }));
  });

  mstream.post('/api/v1/stats/reset', (req, res) => {
    requireAccount(req);
    const { value } = joiValidate(Joi.object({
      scope: Joi.string().valid(...RESET_SCOPES).required(),
    }), req.body || {});
    res.json({ scope: value.scope, ...resetStats(d(), req.user.id, value.scope) });
  });

  // The whole log, one JSON object per line, oldest first — a backup, a
  // migration, or a client rebuilding its local copy. Streamed in keyset
  // pages so a long history never sits in memory at once.
  mstream.get('/api/v1/stats/export', (req, res) => {
    requireAccount(req);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="listening-history.ndjson"');
    const page = d().prepare(`
      SELECT pe.*, l.name AS library_name
        FROM play_events pe LEFT JOIN libraries l ON l.id = pe.library_id
       WHERE pe.user_id = ? AND pe.id > ?
       ORDER BY pe.id LIMIT 500`);
    let after = 0;
    for (;;) {
      const rows = page.all(req.user.id, after);
      if (rows.length === 0) { break; }
      for (const r of rows) {
        let snapshot = null;
        if (r.snapshot) { try { snapshot = JSON.parse(r.snapshot); } catch (_) { snapshot = null; } }
        res.write(`${JSON.stringify({
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
          filePath: r.peer_id == null && r.library_name ? `${r.library_name}/${r.filepath}` : r.filepath,
          peerId: r.peer_id ?? null,
          trackHash: r.track_hash,
          snapshot,
        })}\n`);
        after = r.id;
      }
    }
    res.end();
  });

  // Recompute the hourly rollup from the events on hand (every hour that
  // still has events; older rows are kept — see rebuildHourStats). Admin
  // only; optional userId narrows it.
  mstream.post('/api/v1/admin/stats/rebuild', (req, res) => {
    if (!req.user?.admin) { throw new WebError('Forbidden', 403); }
    const { value } = joiValidate(Joi.object({ userId: Joi.number().integer().min(1) }), req.body || {});
    res.json(rebuildHourStats(d(), { userId: value.userId ?? null }));
  });

  mstream.get('/api/v1/stats/periods', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({ tz: Joi.string().max(64).default('UTC') }), req.query);
    if (!isValidTimeZone(v.tz)) { throw new WebError(`Unknown timezone '${v.tz}'`, 400); }
    const b = q.bounds(d(), req.user.id);
    const periods = [];
    if (b.earliest) {
      const earliest = new Date(b.earliest);
      const now = new Date();
      for (const [period, maxBack] of [['week', 12], ['month', 12], ['quarter', 8], ['half', 6], ['year', 5]]) {
        for (let offset = 0; offset >= -maxBack; offset--) {
          const r = periodRange({ period, offset, tz: v.tz, now });
          if (r.to <= earliest) { break; }
          periods.push({ period, offset, label: r.label, from: r.from.toISOString(), to: r.to.toISOString() });
        }
      }
    }
    res.json({ ...b, tz: v.tz, periods });
  });
}
