// POST /api/v1/db/flow — flow ordering: the caller's list of songs, back in
// an order where each one flows into the next. The thin route over the pure
// orderer in src/db/flow-order.js (which holds the algorithm notes).
//
// Contract, in short:
//   • The body carries every option (the federation browse proxy forwards
//     no query string), and the schema is strict: an unknown key is a 400.
//   • The answer is a permutation of the INPUT INDICES (`order`), plus the
//     paths in that order for convenience. Indices, not paths: they keep
//     duplicates and a peer's songs unambiguous for the client.
//   • Never a per-item 404: a path this caller cannot resolve — missing,
//     in a library they lack, or escaping its library — lands in `unplaced`
//     at the tail, and the three are indistinguishable.
//   • Never a 403 when discovery is off: the songs are ordered by what they
//     have (BPM, key, moods) and `signals.sound` says false.
//   • Joining runs across servers: `returnEnd` hands back the last song's
//     features, and the next server's call passes them as `after`, as is —
//     so `after` takes everything `end` emits (null members, its `index`)
//     and `end` emits only a BPM `after` accepts. A vector from another
//     model is dropped softly (`afterIgnored: 'modelMismatch'`), as
//     federation/discovery/similar does; its BPM and key still count.
//   • One solve at a time per process, at most four waiting; a fifth waiter
//     gets a 429. Nothing else in mStream bounds a route's CPU, and a
//     1000-song solve costs up to about a second of it.
//
// A read: it records nothing, and it is scoped by the caller's libraries, so
// a federation key may call it (federation-auth.js's allowlist).

import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as sim from '../db/discovery-similarity.js';
import { NEAR_DUP } from '../db/discovery-novelty.js';
import { solveFlow, parseKey, energyOf, WEIGHT_PRESETS } from '../db/flow-order.js';
import { resolveFlowTracks } from './db.js';
import { decodeSeedVector } from './discovery.js';
import { joiValidate } from '../util/validation.js';
import { createConcurrencyGate } from '../util/concurrency-gate.js';
import WebError from '../util/web-error.js';

export const FLOW_MAX_SONGS = 1000;
const AFTER_BPM_MIN = 20;
const AFTER_BPM_MAX = 300;

// Test hook: hold the solve slot this long, so the suite can fill the queue
// deterministically. Read once at load, like MSTREAM_TEST_SIM_STALE_REBUILD_MS.
const HOLD_MS = Number(process.env.MSTREAM_TEST_FLOW_HOLD_MS) || 0;

const gate = createConcurrencyGate({
  maxActive: 1,
  maxWaiting: 4,
  busyMessage: 'Too many flow requests in progress, try again shortly',
});

const weight = () => Joi.number().min(0).max(1).required();

const flowSchema = Joi.object({
  songs: Joi.array().items(Joi.string().min(1).max(4096)).min(2).max(FLOW_MAX_SONGS).required(),
  start: Joi.number().integer().min(0).allow(null),
  end: Joi.number().integer().min(0).allow(null),
  // Null members and `index` are accepted (and ignored) so a returnEnd `end`
  // round-trips; which members must be present is checked in checkFlowBody.
  after: Joi.object({
    vector: Joi.string().base64().max(65536).allow(null),
    modelId: Joi.string().max(200).allow(null),
    bpm: Joi.number().min(AFTER_BPM_MIN).max(AFTER_BPM_MAX).allow(null),
    key: Joi.string().max(32).allow(null),
    index: Joi.number().integer().min(0).allow(null),
  }).allow(null),
  mode: Joi.string().valid('smooth', 'dj').default('smooth'),
  weights: Joi.object({ sound: weight(), tempo: weight(), key: weight(), energy: weight() }),
  arc: Joi.string().valid('steady', 'up', 'down', 'wave').default('steady'),
  tempoTolerance: Joi.number().min(0.02).max(0.25).default(0.06),
  halfDouble: Joi.boolean().default(true),
  artistGap: Joi.boolean().default(true),
  seed: Joi.number().integer().min(0).max(2147483647).allow(null),
  explain: Joi.boolean().default(false),
  returnEnd: Joi.boolean().default(false),
});

// The cross-field rules, in plain words rather than Joi's.
function checkFlowBody(body) {
  const n = body.songs.length;
  for (const k of ['start', 'end']) {
    if (body[k] != null && body[k] >= n) {
      throw new WebError(`${k} must be an index into songs (0..${n - 1})`, 400);
    }
  }
  if (body.start != null && body.start === body.end) {
    throw new WebError('start and end must be different songs', 400);
  }
  if (body.after) {
    const a = body.after;
    if (body.start != null) {
      throw new WebError('after cannot be combined with start', 400);
    }
    if (a.vector == null && a.bpm == null && a.key == null) {
      throw new WebError('after needs at least one of vector, bpm or key', 400);
    }
    if (a.vector != null && a.modelId == null) {
      throw new WebError('after.vector requires after.modelId', 400);
    }
  }
  if (body.weights) {
    const w = body.weights;
    if (w.sound + w.tempo + w.key + w.energy <= 0) {
      throw new WebError('weights must not all be zero', 400);
    }
  }
}

// id → energy proxy, from the mood heads' mirror (track_moods).
function readFlowEnergies(ids) {
  const out = new Map();
  if (!ids.length) { return out; }
  const d = db.getDB();
  if (!d) { return out; }
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = d.prepare(`
      SELECT track_id AS id, aggressive, party, danceable, relaxed
        FROM track_moods
       WHERE track_id IN (${slice.map(() => '?').join(',')})
    `).all(...slice);
    for (const r of rows) {
      const e = energyOf(r);
      if (e != null) { out.set(r.id, e); }
    }
  }
  return out;
}

function vectorBase64(vec) {
  // entry.vec is a view into the index's shared matrix — copy its bytes
  // rather than handing Buffer a view over the whole thing.
  return Buffer.from(Buffer.from(vec.buffer, vec.byteOffset, vec.length * 4)).toString('base64');
}

async function runFlow(user, body) {
  // Sound vectors only while discovery is switched on: getIndex() alone
  // would still serve a switched-off server whose store exists. An index
  // that fails to load costs the sound signal, never the request.
  let index = null;
  if (config.program.scanOptions.collectDiscoveryData === true) {
    try {
      index = sim.getIndex();
    } catch (err) {
      winston.warn(`[flow] similarity index unavailable, ordering without sound: ${err.message}`);
      index = null;
    }
  }
  const usable = !!index && index.dim != null && index.dim > 0;

  const rows = resolveFlowTracks(body.songs, user);

  const ids = [...new Set(rows.filter(Boolean).map((r) => r.id))];
  const energies = config.program.scanOptions.analyzeMoods !== false ? readFlowEnergies(ids) : new Map();

  const entries = rows.map((row) => (usable && row?.hash ? index.byHash.get(row.hash) ?? null : null));
  const items = rows.map((row, i) => {
    if (!row) { return null; }
    const entry = entries[i];
    return {
      rankKey: `${row.hash ?? ''}\u0000${body.songs[i]}`,
      vec: entry?.vec ?? null,
      bpm: row.bpm,
      key: row.musicalKey,
      energy: energies.get(row.id) ?? null,
      artistId: row.artistId,
      albumId: row.albumId,
      hash: row.hash,
      recKey: entry ? sim.entryNameKey(entry) : null,
    };
  });

  // `after`: the song before this list, when it lives elsewhere. Its vector
  // counts only when it comes from this server's model; otherwise it is
  // dropped softly and said so. A server with no model is a mismatch too.
  let after = null;
  let afterIgnored;
  if (body.after) {
    let vec = null;
    if (body.after.vector != null) {
      if (index && body.after.modelId === index.modelId) {
        // Same model but nothing embedded yet: no width to check against,
        // and nothing to compare with — dropped without a word.
        if (usable) { vec = decodeSeedVector(index, body.after.vector); }
      } else {
        afterIgnored = 'modelMismatch';
      }
    }
    after = { vec, bpm: body.after.bpm ?? null, key: body.after.key ?? null };
  }

  const result = await solveFlow(items, {
    start: body.start ?? null,
    end: body.end ?? null,
    after,
    weights: body.weights ?? WEIGHT_PRESETS[body.mode],
    arc: body.arc,
    tempoTolerance: body.tempoTolerance,
    halfDouble: body.halfDouble,
    artistGap: body.artistGap,
    seed: body.seed ?? null,
    explain: body.explain,
    nearDup: NEAR_DUP,
  });

  const out = {
    order: result.order,
    songs: result.order.map((i) => body.songs[i]),
    unplaced: result.unplaced,
    unanalysed: result.unanalysed,
    signals: result.signals,
    arc: result.arc,
    model: index ? { id: index.modelId, version: index.modelVersion } : null,
    seed: body.seed ?? null,
    solver: result.solver,
    stats: result.stats,
  };
  if (body.explain) { out.transitions = result.transitions; }
  if (body.returnEnd) {
    const i = result.endIndex;
    if (i == null) {
      out.end = null;
    } else {
      const row = rows[i];
      // Only a BPM the next call's `after` accepts, so `end` round-trips.
      const bpm = Number.isFinite(row.bpm) && row.bpm >= AFTER_BPM_MIN && row.bpm <= AFTER_BPM_MAX ? row.bpm : null;
      out.end = { index: i, bpm, key: parseKey(row.musicalKey) };
      if (entries[i]?.vec) {
        out.end.vector = vectorBase64(entries[i].vec);
        out.end.modelId = index.modelId;
      }
      // Placed only by a BPM out of that range: nothing to join on.
      if (out.end.bpm == null && out.end.key == null && out.end.vector == null) { out.end = null; }
    }
  }
  if (afterIgnored) { out.afterIgnored = afterIgnored; }
  return out;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function setup(mstream) {
  mstream.post('/api/v1/db/flow', async (req, res) => {
    const { value: body } = joiValidate(flowSchema, req.body ?? {});
    checkFlowBody(body);
    // After validation, before any work: a 429 costs nothing.
    const release = await gate.acquire();
    try {
      if (HOLD_MS > 0) { await sleep(HOLD_MS); }
      res.json(await runFlow(req.user, body));
    } finally {
      release();
    }
  });
}
