// Stats API v2.
//
//   POST /api/v1/stats/plays       record a batch of complete plays (the write side)
//   GET  /api/v1/stats/summary     the period's numbers (the old Wrapped view, as data)
//   GET  /api/v1/stats/top         ranked tracks / artists / albums / genres
//   GET  /api/v1/stats/timeseries  plays and listening time per bucket, in the caller's zone
//   GET  /api/v1/stats/history     the listening log, newest first, cursor-paginated
//   POST /api/v1/stats/tracks      per-track counters for a batch of paths / hashes
//   GET  /api/v1/stats/periods     which periods have data
//
// Write side: clients (the mobile app's outbox, the web player) send plays
// AFTER they happen, with their own ids and start times. The server resolves
// each path to a track, decides whether it counts (config
// `stats.playThreshold*`), and answers per play — accepted / duplicates /
// rejected with a reason — so an outbox knows what to drop and what to
// retry. Rules in src/stats/ingest.js, the write in src/stats/store.js.
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
// build has no id to record against or read for. Nothing advertises the
// surface in `features` until the scrobble shim and the flag land with it.

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as config from '../state/config.js';
import WebError from '../util/web-error.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';
import * as q from '../stats/queries.js';
import { ingestPlays, MAX_BATCH } from '../stats/ingest.js';
import { OUTCOMES, SOURCES } from '../stats/store.js';
import {
  isValidTimeZone, isBucket, periodRange, customRange, toSqlite, fromSqlite, toIso,
} from '../stats/time.js';

const d = () => db.getDB();

// ── Write side ────────────────────────────────────────────────────────────

const instant = Joi.alternatives().try(Joi.string().isoDate(), Joi.number().integer().min(0));

// 'legacy' is reserved for the server's own scrobble shim.
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

// `name/version`, the form stored on every row and shown in history.
export function clientLabel(c) {
  if (!c) { return null; }
  return `${c.name}${c.version ? `/${c.version}` : ''}`.slice(0, 128);
}

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
    const result = ingestPlays(db.getDB(), req.user, value, {
      config: config.program.stats,
      now: new Date(),
      peers: fedDb.getFederationPeers(),
      client: clientLabel(value.client),
    });
    res.json(result);
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
    const rows = q.hourRows(d(), { userId: req.user.id, from: r.from, to: r.to });
    res.json({ period: periodOut(r), bucket: v.bucket, items: q.rebucket(rows, v.bucket, r.tz) });
  });

  mstream.get('/api/v1/stats/history', (req, res) => {
    requireAccount(req);
    const { value: v } = joiValidate(Joi.object({
      before: Joi.string().max(512),
      limit: Joi.number().integer().min(1).max(200).default(50),
      track: Joi.string().max(128),
      origin: Joi.string().valid(...ORIGIN_VALUES).default('all'),
      ignoreVPaths: ignoreVPathsSchema,
    }), req.query);
    const { items, next } = q.history(d(), {
      user: req.user, origin: v.origin, ignoreVPaths: normIgnore(v.ignoreVPaths),
      trackHash: v.track ?? null, before: decodeCursor(v.before), limit: v.limit,
    });
    res.json({ items, next: encodeCursor(next) });
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
