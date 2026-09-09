// Stats API v2 — the write side.
//
//   POST /api/v1/stats/plays   record a batch of complete plays
//
// Clients (the mobile app's outbox, the web player) send plays AFTER they
// happen, with their own ids and start times. The server resolves each path
// to a track, decides whether it counts (config `stats.playThreshold*`), and
// answers per play — accepted / duplicates / rejected with a reason — so an
// outbox knows what to drop and what to retry. Rules in src/stats/ingest.js,
// the write in src/stats/store.js.
//
// Never reachable with a federation key or a guest token: the wall's
// allowlist does not carry this route, and the synthetic user those tokens
// build has no id to record against. The read side (summary, top,
// timeseries, history) follows in its own change; nothing advertises the
// route in `features` until the surface is complete.

import Joi from 'joi';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as config from '../state/config.js';
import WebError from '../util/web-error.js';
import { joiValidate } from '../util/validation.js';
import { ingestPlays, MAX_BATCH } from '../stats/ingest.js';
import { OUTCOMES, SOURCES } from '../stats/store.js';

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

export function setup(mstream) {
  mstream.post('/api/v1/stats/plays', (req, res) => {
    if (!req.user?.id || req.user.federation) { throw new WebError('Forbidden', 403); }
    const { value } = joiValidate(bodySchema, req.body || {});
    const result = ingestPlays(db.getDB(), req.user, value, {
      config: config.program.stats,
      now: new Date(),
      peers: fedDb.getFederationPeers(),
      client: clientLabel(value.client),
    });
    res.json(result);
  });
}
