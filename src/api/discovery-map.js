// The music map's HTTP side (Atlas; docs/music-map-plan.md §3.8): six
// routes over the layout the map worker (src/db/map-layout.mjs) builds.
//
//   GET  /api/v1/discovery/map              the map: regions and every visible dot
//   GET  /api/v1/discovery/map/overlay      a mood bitset or plays bytes, in the map's point order
//   POST /api/v1/discovery/map/tracks       ids → lite rows · filepaths → representative ids
//   POST /api/v1/discovery/map/search       title / artist / album matches → ids
//   POST /api/v1/discovery/map/region       a place's centre and its mix
//   POST /api/v1/discovery/map/neighbours   a song's nearest placed dots
//
// Contract, in short:
//   • Local library only. 403 'Discovery is disabled' while discovery or
//     scanOptions.musicMap is off, while discovery.db cannot be opened, and
//     while nothing could ever be drawn here (no layout, no vector, and the
//     embedding pass off for an environment reason) — one message, so a
//     probe cannot tell configuration from failure. 403 'Forbidden' for a
//     federation key: these routes are never on federation-auth.js's
//     allowlist, and the handlers refuse one again behind it.
//   • One identity everywhere: a dot's REPRESENTATIVE id for the caller —
//     MIN(tracks.id) over the dot's tracks the caller can see. Copies and
//     near-duplicates share a dot; clients join every answer to the map by
//     id (the points are sorted by it).
//   • GET /map carries a strong ETag (`rev`) built from persistent state
//     only — never PRAGMA data_version, which is per connection and blind
//     to this process's own writes — and answers 304 before building
//     anything. Two callers who see the same libraries share bytes and tag;
//     no per-user data rides in it.
//   • Only the overlay is coupled to the point order: it names the `rev` it
//     was asked for and answers 409 'Map changed' when that is stale. Every
//     other answer is ids.
//   • No vectors on the hot paths. /neighbours alone uses the similarity
//     index (requireIndex: a cold build costs ~1.5 s at 25k tracks);
//     everything else reads track_map (mstream.db V81, the worker's
//     mirror: it carries tracks.id, so libraryFilter applies in SQL),
//     track_map_meta (the serving pointer) and discovery.db's map tables.
//
// The serving layout is the pointer's, and only while it is valid: its
// map_epoch equals discovery_meta.map_epoch (a pointer from a replaced
// discovery.db or a map-table reset never reads new layout ids) and its
// layout is 'ready' (map-sync.js mapPointerValid). Every track_map query
// filters on that layout id: a rebuild's next generation is written beside
// it, invisible until one tiny transaction flips the pointer.

import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as discoveryDb from '../db/discovery-db.js';
import * as sim from '../db/discovery-similarity.js';
import * as dbQueue from '../db/task-queue.js';
import { readTrackMapPointer, mapPointerValid } from '../db/map-sync.js';
import {
  encodePointsColsV1, encodeBitset, quantU16, utcMidnightDaysAgo, sqliteUtcToSec,
  REGION_NONE, MAP_FLAG_RECENT, MAP_RECENT_DAYS,
} from '../db/map-lib.js';
import { joiValidate } from '../util/validation.js';
import { createConcurrencyGate } from '../util/concurrency-gate.js';
import { parseSearchQuery, buildFtsExpression } from '../util/search-query.js';
import WebError from '../util/web-error.js';
import { libraryFilter, renderMetadataByIds, toLiteMetadata, resolveFlowTracks } from './db.js';
import { matchesEtag } from './sync.js';
import { requireIndex, considerBudget } from './discovery.js';
import { parseMoodsQuery, applicableMoods, moodPredicate } from './mood-filter.js';

export const POINTS_FORMAT = 'cols-v1';
export const LAND_FORMAT = 'land-v1';
// land-v1 with no rings at any level: three u16 zero counts. A province
// whose land was never stored still sends a decodable blob.
const EMPTY_LAND_V1 = Buffer.alloc(6).toString('base64');

// Base-cache scan page (§3.8.2): a few milliseconds of SQLite each, with a
// setImmediate between pages so a 100k-track build never holds the event
// loop for its whole length.
export const BASE_PAGE = 5000;
// Serialised per-visibility bodies kept, keyed by rev.
export const PAYLOAD_LRU = 8;

export const TRACKS_MAX = 500;
export const SEARCH_TITLES_MAX = 2000;
export const SEARCH_ARTISTS_MAX = 50;
export const SEARCH_ALBUMS_MAX = 100;
// Artist and album matches are wide nets: two characters match half a
// library, so they start at three. Titles start at two (Joi's floor).
export const SEARCH_WIDE_MIN = 3;
// The track set is capped before any grouping, the answer after.
export const SEARCH_HITS_MAX = 20000;
export const SEARCH_IDS_MAX = 5000;
export const REGION_SONGS_MAX = 50;
export const NEIGHBOURS_MAX = 16;
// Ranked candidates resolved to dots per query (§3.8.8).
const NEIGHBOUR_CHUNK = 64;

// The discovery pass's environment reasons (task-queue enrichmentGate): no
// embedding can be made on this install until the operator fixes them.
const ENVIRONMENT_OFF = new Set(['runtime-unavailable', 'no-ffmpeg']);

// Clients debounce search at 300 ms; this caps bursts. The search yields
// between its phases, so two can be in flight and eight wait (FIFO); a
// caller past that gets a 429.
const searchGate = createConcurrencyGate({
  maxActive: 2,
  maxWaiting: 8,
  busyMessage: 'Too many map searches in progress, try again shortly',
});

const yieldToLoop = () => new Promise((resolve) => { setImmediate(resolve); });

// Prepared-statement memo, per handle then per SQL text (the pattern of
// api/discovery.js). Every variable-length set binds as ONE JSON array
// through json_each (random.js's precedent), so the texts vary only with
// the caller's grant count — a handful per process.
const stmtCache = new WeakMap();
function prep(handle, sql) {
  let bySql = stmtCache.get(handle);
  if (!bySql) { bySql = new Map(); stmtCache.set(handle, bySql); }
  let stmt = bySql.get(sql);
  if (!stmt) { stmt = handle.prepare(sql); bySql.set(sql, stmt); }
  return stmt;
}

const b64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * The map's state for a caller (§3.8.3), from the serving pointer, the
 * enrichment status (task-queue getEnrichmentStatus(): `map` = the map
 * pass's entry, `discovery` = the embedding pass's, either null when
 * absent) and one index-only probe (`vectors`: any current-model
 * embedding). First match wins:
 *   ready     a valid serving layout exists;
 *   disabled  none, no vector, and the embedding pass is off for an
 *             environment reason — the routes answer 403 (§3.8.1);
 *   building  none, and a map pass is queued or running, or vectors exist
 *             and no map pass has finished since boot;
 *   failed    none, vectors exist, and the last map pass this process
 *             lifetime did not complete, or the pass is latched off
 *             ('failing');
 *   empty     otherwise: nothing analysed yet, and analysis can run here.
 */
export function mapState({ serving = false, vectors = false, map = null, discovery = null } = {}) {
  if (serving) { return 'ready'; }
  if (!vectors && ENVIRONMENT_OFF.has(discovery?.disabledReason)) { return 'disabled'; }
  const active = map?.state === 'queued' || map?.state === 'running';
  if (active || (vectors && !map?.lastRun)) { return 'building'; }
  if (vectors && (map?.disabledReason === 'failing' || map?.lastRun?.outcome !== 'completed')) { return 'failed'; }
  return 'empty';
}

/**
 * The map's revision — its ETag, and the overlay's coupling key (§3.8.2).
 * Every part is persistent state:
 *   mapEpoch     discovery_meta.map_epoch: a replaced discovery.db or a
 *                map-table reset (layout ids alone repeat after a DROP);
 *   layoutId,    the pointer and its counter: every worker write to the
 *   rev          serving generation moves rev in the same transaction;
 *   n            the generation's row count: a deleted track cascades out
 *                of track_map with no worker write;
 *   mapVersion   place-mode region updates in discovery.db;
 *   libraryIds   the caller's grants (sorted, so equal sets share a tag);
 *   recent part  the 30-day window's day, but only while some mirrored song
 *                (addedMax) is newer than both the baseline (recentAfter)
 *                and the cutoff — a library with nothing new keeps its tag
 *                across midnights instead of re-sending the map daily. No
 *                baseline yet rings nothing, so the day is left out;
 *   state        a non-ready answer changes with it (building → failed)
 *                while the pointer stands still.
 * `nowMs` sets the day; strings compare as tracks.created_at's
 * 'YYYY-MM-DD HH:MM:SS' does.
 */
export function mapRev({
  mapEpoch = null, layoutId = null, rev = 0, n = 0, mapVersion = null, libraryIds = [],
  addedMax = null, recentAfter = null, nowMs = Date.now(), state = 'ready',
} = {}) {
  const cutoff = utcMidnightDaysAgo(MAP_RECENT_DAYS, nowMs);
  const recentPart = addedMax && recentAfter != null && addedMax > recentAfter && addedMax > cutoff
    ? cutoff.slice(0, 10) : '-';
  const libs = [...libraryIds].sort((a, b) => a - b).join('.');
  const text = ['m1', mapEpoch ?? '-', layoutId ?? 0, rev ?? 0, n, mapVersion ?? 0, libs, recentPart, state].join('|');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * The recent window as epoch seconds (§3.8.3): a dot is recent when the
 * first time the caller could see it (its visible members' minimum
 * created_at) is after both the baseline (discovery_meta.map_recent_after,
 * set once by the first ready layout) and 00:00 UTC thirty days ago. No
 * baseline → nothing is recent (a fresh server rings nothing).
 */
export function recentWindow(recentAfter, nowMs = Date.now()) {
  return {
    afterSec: sqliteUtcToSec(recentAfter) ?? Infinity,
    cutoffSec: sqliteUtcToSec(utcMidnightDaysAgo(MAP_RECENT_DAYS, nowMs)),
  };
}

/**
 * One caller's view of a base cache (§3.8.2), in one JS pass: the visible
 * members only; a dot's representative is its first visible member in
 * track-id order (= MIN(id): the base is id-ordered), so the points come
 * out sorted by representative id. `filter` is libraryFilter()'s shape
 * ({params, coversAllLibraries}); `recent` is recentWindow()'s.
 *
 * Returns the cols-v1 columns plus `pos` (base dot index → point index, −1
 * when invisible) and the visible dots per region id (`sizes0` provinces,
 * `sizes1` towns; REGION_NONE is never counted).
 */
export function derivePayload(base, filter, recent) {
  const all = filter?.coversAllLibraries === true;
  const libs = all ? null : new Set(filter?.params ?? []);
  const nDots = base.nDots;
  const pos = new Int32Array(nDots).fill(-1);
  const added = new Float64Array(nDots).fill(Infinity);
  const order = [];   // base dot indices in point order
  const reps = [];
  for (let i = 0; i < base.n; i++) {
    if (libs && !libs.has(base.libId[i])) { continue; }
    const d = base.trackDot[i];
    if (pos[d] < 0) { pos[d] = order.length; order.push(d); reps.push(base.trackId[i]); }
    if (base.created[i] < added[d]) { added[d] = base.created[i]; }
  }
  const n = order.length;
  const out = {
    n,
    ids: Uint32Array.from(reps),
    x: new Uint16Array(n), y: new Uint16Array(n),
    region0: new Uint8Array(n), region1: new Uint8Array(n), flags: new Uint8Array(n),
    pos,
    sizes0: new Uint32Array(256), sizes1: new Uint32Array(256),
  };
  const afterSec = recent?.afterSec ?? Infinity;
  const cutoffSec = recent?.cutoffSec ?? Infinity;
  for (let j = 0; j < n; j++) {
    const d = order[j];
    out.x[j] = base.dotX[d];
    out.y[j] = base.dotY[d];
    const r0 = base.dotR0[d];
    const r1 = base.dotR1[d];
    out.region0[j] = r0;
    out.region1[j] = r1;
    if (r0 !== REGION_NONE) { out.sizes0[r0]++; }
    if (r1 !== REGION_NONE) { out.sizes1[r1]++; }
    if (added[d] > afterSec && added[d] > cutoffSec) { out.flags[j] = MAP_FLAG_RECENT; }
  }
  return out;
}

// ── The base cache: the serving generation, independent of visibility ──────

const regionU8 = (v) => (Number.isInteger(v) && v >= 0 && v < REGION_NONE ? v : REGION_NONE);
const u16 = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : quantU16(Number(v) / 65535));

/**
 * Scan one track_map generation into the base cache's columns: per track
 * (track-id order) its id, library, created_at as epoch seconds (−Infinity
 * when unreadable: never recent) and dot index; per dot its u16 position and
 * region ids. Keyset-paged, the statement prepared once per build whatever
 * the size, `yieldFn` awaited between pages. The dot-label map exists only
 * during the build: everything after it works on indices.
 */
export async function buildBaseCache(mdb, layoutId, { pageSize = BASE_PAGE, yieldFn = yieldToLoop } = {}) {
  const page = mdb.prepare(`
    SELECT m.track_id AS track_id, t.library_id AS library_id, t.created_at AS created_at,
           m.dot AS dot, m.x AS x, m.y AS y, m.region0 AS region0, m.region1 AS region1
      FROM track_map m JOIN tracks t ON t.id = m.track_id
     WHERE m.layout_id = ? AND m.track_id > ?
     ORDER BY m.track_id
     LIMIT ?
  `);
  const trackId = [];
  const libId = [];
  const created = [];
  const trackDot = [];
  const dotX = [];
  const dotY = [];
  const dotR0 = [];
  const dotR1 = [];
  const dotOf = new Map();
  for (let after = 0; ;) {
    const rows = page.all(layoutId, after, pageSize);
    for (const r of rows) {
      let d = dotOf.get(r.dot);
      if (d === undefined) {
        // Every member row carries its dot's values (§3.4.4 step 7): the
        // first one seen speaks for the dot.
        d = dotX.length;
        dotOf.set(r.dot, d);
        dotX.push(u16(r.x));
        dotY.push(u16(r.y));
        dotR0.push(regionU8(r.region0));
        dotR1.push(regionU8(r.region1));
      }
      trackId.push(r.track_id);
      libId.push(r.library_id);
      created.push(sqliteUtcToSec(r.created_at) ?? -Infinity);
      trackDot.push(d);
    }
    if (rows.length < pageSize) { break; }
    after = rows[rows.length - 1].track_id;
    await yieldFn();
  }
  return {
    layoutId,
    n: trackId.length,
    trackId: Uint32Array.from(trackId),
    libId: Int32Array.from(libId),
    created: Float64Array.from(created),
    trackDot: Uint32Array.from(trackDot),
    nDots: dotX.length,
    dotX: Uint16Array.from(dotX),
    dotY: Uint16Array.from(dotY),
    dotR0: Uint8Array.from(dotR0),
    dotR1: Uint8Array.from(dotR1),
  };
}

// The pointer and its generation's row count, read together: the identity
// of a base cache and part of rev.
function readSnapshot(mdb) {
  const p = readTrackMapPointer(mdb);
  const n = p.active_layout == null ? 0
    : prep(mdb, 'SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(p.active_layout).n;
  return { mapEpoch: p.map_epoch, layoutId: p.active_layout, rev: p.rev, n };
}

const snapKey = (s) => `${s.mapEpoch ?? '-'}|${s.layoutId ?? 0}|${s.rev}|${s.n}`;

/**
 * The two caches of §3.8.2 behind one object (the routes use one; tests
 * make their own):
 *   getBase(mdb, snap)    the serving generation's rows for snapshot `snap`
 *                         ({mapEpoch, layoutId, rev, n}): one entry, one
 *                         build in flight shared by every caller. After a
 *                         scan the pointer and n are re-read; when either
 *                         moved the build is discarded and retried once (a
 *                         worker writes in bursts), and a build that still
 *                         saw movement is served but not kept.
 *   getPayload(rev, make) a caller's serialised map, an LRU keyed by rev;
 *                         concurrent misses for one rev share one make().
 */
export function createMapCache({ pageSize = BASE_PAGE, yieldFn = yieldToLoop, lruSize = PAYLOAD_LRU } = {}) {
  let base = null;
  let building = null;
  const payloads = new Map();   // rev → entry, oldest first
  const pending = new Map();    // rev → promise of an entry
  const stats = { baseBuilds: 0, payloadBuilds: 0 };

  async function buildFor(mdb, snap) {
    let want = snap;
    for (let attempt = 0; ; attempt++) {
      const scanned = await buildBaseCache(mdb, want.layoutId, { pageSize, yieldFn });
      stats.baseBuilds++;
      const now = readSnapshot(mdb);
      scanned.key = snapKey(want);
      if (snapKey(now) === scanned.key) { base = scanned; return scanned; }
      // The pointer moved under the scan. A label older than its content
      // heals itself (the next request computes the new rev), so after one
      // retry the newest rows are served — just not cached.
      if (attempt >= 1 || now.layoutId == null) { return scanned; }
      want = now;
    }
  }

  return {
    stats,
    getBase(mdb, snap) {
      const key = snapKey(snap);
      if (base && base.key === key) { return Promise.resolve(base); }
      if (building && building.key === key) { return building.promise; }
      const promise = buildFor(mdb, snap).finally(() => {
        if (building && building.promise === promise) { building = null; }
      });
      building = { key, promise };
      return promise;
    },
    getPayload(rev, make) {
      const hit = payloads.get(rev);
      if (hit) {
        payloads.delete(rev);
        payloads.set(rev, hit);
        return Promise.resolve(hit);
      }
      let p = pending.get(rev);
      if (!p) {
        p = (async () => {
          const entry = await make();
          stats.payloadBuilds++;
          payloads.set(rev, entry);
          while (payloads.size > lruSize) { payloads.delete(payloads.keys().next().value); }
          return entry;
        })().finally(() => { pending.delete(rev); });
        pending.set(rev, p);
      }
      return p;
    },
  };
}

const caches = createMapCache();

// ── The gate, the state and the rev ─────────────────────────────────────────

function metaOf(ddb, key) {
  return prep(ddb, 'SELECT value FROM discovery_meta WHERE key = ?').get(key)?.value ?? null;
}

function hasCurrentVectors(ddb, modelId) {
  // Index-only: idx_discovery_tracks_embedded_model_mood (partial on
  // embedding IS NOT NULL) serves it.
  return !!prep(ddb, 'SELECT 1 AS one FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? LIMIT 1').get(modelId);
}

/**
 * Every route's gate (§3.8.1). Returns the request's context: the two
 * handles, the pointer as read, the state and, when ready, the serving
 * layout id. Never builds the similarity index (§3.8.1: only /neighbours
 * pays for it).
 */
function requireMap(req) {
  if (req.user?.federation) { throw new WebError('Forbidden', 403); }
  const o = config.program.scanOptions;
  if (o.collectDiscoveryData !== true || o.musicMap === false) {
    throw new WebError('Discovery is disabled', 403);
  }
  const ddb = discoveryDb.openDiscoveryDbIfExists();
  const mdb = db.getDB();
  if (!ddb || !mdb) { throw new WebError('Discovery is disabled', 403); }
  const pointer = readTrackMapPointer(mdb);
  if (mapPointerValid(pointer, ddb)) {
    return { mdb, ddb, pointer, state: 'ready', layoutId: pointer.active_layout };
  }
  const passes = dbQueue.getEnrichmentStatus();
  const state = mapState({
    serving: false,
    vectors: hasCurrentVectors(ddb, o.discoveryModel),
    map: passes.find((p) => p.pass === 'map') ?? null,
    discovery: passes.find((p) => p.pass === 'discovery') ?? null,
  });
  if (state === 'disabled') { throw new WebError('Discovery is disabled', 403); }
  return { mdb, ddb, pointer, state, layoutId: null };
}

// The caller's visibility as SQL over alias t — dropped when the caller
// sees every library (libraryFilter's no-op case), so SQLite drives from
// the map's own indexes.
function visibility(user) {
  const filter = libraryFilter(user);
  return {
    filter,
    sql: filter.coversAllLibraries ? '' : ` AND ${filter.clause}`,
    params: filter.coversAllLibraries ? [] : filter.params,
  };
}

// The caller's rev, read now. The pointer row comes first and the count
// alone after it (a PK-prefix COUNT, no MIN/MAX mixed in); if the worker
// commits in between, the content read later is newer than its label,
// which the next request corrects.
function revFor(ctx, vis, nowMs) {
  const ready = ctx.state === 'ready';
  const layoutId = ready ? ctx.pointer.active_layout : null;
  const n = ready ? prep(ctx.mdb, 'SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(layoutId).n : 0;
  const rev = mapRev({
    mapEpoch: ready ? ctx.pointer.map_epoch : null,
    layoutId,
    rev: ctx.pointer.rev,
    n,
    mapVersion: metaOf(ctx.ddb, 'map_version'),
    libraryIds: vis.filter.params,
    addedMax: ready ? ctx.pointer.added_max : null,
    recentAfter: metaOf(ctx.ddb, 'map_recent_after'),
    nowMs,
    state: ctx.state,
  });
  return { rev, n };
}

function notReadyBody(state, rev) {
  return {
    state,
    model: null,
    rev,
    layout: null,
    regions: [],
    points: { n: 0, format: POINTS_FORMAT, data: '' },
  };
}

// The point-order facts a non-ready map's overlay answers from.
const EMPTY_ENTRY = Object.freeze({
  n: 0, ids: new Uint32Array(0), pos: new Int32Array(0),
  trackId: new Uint32Array(0), trackDot: new Uint32Array(0), layoutId: null,
});

// The regions a caller sees (§3.8.3, decision 1): `size` is the visible
// dots; a region none of whose dots is visible is dropped, and so is a
// town whose province was. A province keeps its library-wide land.
function regionsFor(ddb, layoutId, payload) {
  const rows = prep(ddb, `
    SELECT level, id, key, parent, label, hue, anchor_x, anchor_y, land
      FROM map_regions WHERE layout_id = ? ORDER BY level, id
  `).all(layoutId);
  const out = [];
  for (const r of rows) {
    const province = r.level === 0;
    const size = province ? payload.sizes0[r.id] : payload.sizes1[r.id];
    if (!size) { continue; }
    if (!province && r.parent != null && !payload.sizes0[r.parent]) { continue; }
    const region = {
      key: r.key,
      level: r.level,
      id: r.id,
      parent: province ? null : (r.parent ?? null),
      label: r.label ?? null,
      hue: r.hue,
      anchor: [quantU16(r.anchor_x), quantU16(r.anchor_y)],
      size,
    };
    if (province) { region.land = r.land ? b64(r.land) : EMPTY_LAND_V1; }
    out.push(region);
  }
  return out;
}

/**
 * The caller's map entry for `rev`: the serialised 200 body plus the point
 * order the overlays answer in. From the LRU, else derived from the base
 * cache (built when the serving generation moved).
 */
function mapPayload(cache, ctx, { rev, n }, vis, nowMs) {
  return cache.getPayload(rev, async () => {
    const snap = { mapEpoch: ctx.pointer.map_epoch, layoutId: ctx.pointer.active_layout, rev: ctx.pointer.rev, n };
    const base = await cache.getBase(ctx.mdb, snap);
    // The base's own layout, not the request's: after a retried build it
    // can be newer, and its regions must match its points.
    const layout = prep(ctx.ddb, `
      SELECT id, model_id, model_version, method, frame, aspect FROM map_layouts WHERE id = ? AND state = 'ready'
    `).get(base.layoutId);
    if (!layout) {
      // Deleted between the pointer read and now (the next worker run's
      // recovery): answered as building; the next request has a new rev.
      return { ...EMPTY_ENTRY, body: JSON.stringify(notReadyBody('building', rev)) };
    }
    const p = derivePayload(base, vis.filter, recentWindow(metaOf(ctx.ddb, 'map_recent_after'), nowMs));
    const body = JSON.stringify({
      state: 'ready',
      model: { id: layout.model_id, version: layout.model_version ?? null },
      rev,
      layout: { id: layout.id, method: layout.method, frame: layout.frame, aspect: layout.aspect, landFormat: LAND_FORMAT },
      regions: regionsFor(ctx.ddb, base.layoutId, p),
      points: { n: p.n, format: POINTS_FORMAT, data: b64(encodePointsColsV1(p)) },
    });
    return {
      body, n: p.n, ids: p.ids, pos: p.pos,
      trackId: base.trackId, trackDot: base.trackDot, layoutId: base.layoutId,
    };
  });
}

// ── Lookups shared by the POST routes ───────────────────────────────────────

// track id → its dot in the serving layout, for the ids given (primary-key
// probes; ids with no row are absent).
function dotsOfTracks(ctx, trackIds) {
  const out = new Map();
  if (!trackIds.length) { return out; }
  for (const r of prep(ctx.mdb, `
    SELECT track_id, dot FROM track_map
     WHERE layout_id = ? AND track_id IN (SELECT value FROM json_each(?))
  `).all(ctx.layoutId, JSON.stringify(trackIds))) {
    out.set(r.track_id, r.dot);
  }
  return out;
}

// dot label → the caller's representative id, for the labels given (in
// one statement over idx_track_map_dot; labels with no visible member are
// absent).
function representatives(ctx, vis, dots) {
  const out = new Map();
  if (!dots.length) { return out; }
  const rows = prep(ctx.mdb, `
    SELECT m.dot AS dot, MIN(t.id) AS id
      FROM track_map m JOIN tracks t ON t.id = m.track_id
     WHERE m.layout_id = ? AND m.dot IN (SELECT value FROM json_each(?))${vis.sql}
     GROUP BY m.dot
  `).all(ctx.layoutId, JSON.stringify(dots), ...vis.params);
  for (const r of rows) { out.set(r.dot, r.id); }
  return out;
}

// The lite `{id, filepath, metadata}` rows for ids already known visible.
// renderMetadataByIds checks nothing (§3.8.5): every caller passes it ids
// that went through the caller's visibility first. A row that vanished
// since is absent from the map.
function liteRows(ids, user) {
  const rendered = renderMetadataByIds(ids, user);
  const out = new Map();
  for (const id of ids) {
    const r = rendered.get(id);
    if (r) { out.set(id, { id, filepath: r.filepath, metadata: toLiteMetadata(r.metadata) }); }
  }
  return out;
}

function lookupTracks(ctx, vis, user, ids) {
  const uniq = [...new Set(ids)];
  const visible = prep(ctx.mdb, `
    SELECT t.id AS id FROM tracks t
     WHERE t.id IN (SELECT value FROM json_each(?))${vis.sql}
  `).all(JSON.stringify(uniq), ...vis.params).map((r) => r.id);
  const rows = liteRows(visible, user);
  // Unknown and invisible ids are the same null.
  return ids.map((id) => rows.get(id) ?? null);
}

function lookupPaths(ctx, vis, user, filepaths) {
  const out = new Array(filepaths.length).fill(null);
  if (ctx.state !== 'ready') { return out; }
  // Aligned, vpath- and library-checked; a leading '/' is accepted.
  const resolved = resolveFlowTracks(filepaths, user);
  const trackIds = [...new Set(resolved.filter(Boolean).map((r) => r.id))];
  if (!trackIds.length) { return out; }
  const dotOf = dotsOfTracks(ctx, trackIds);
  const reps = representatives(ctx, vis, [...new Set(dotOf.values())]);
  for (let i = 0; i < resolved.length; i++) {
    const dot = resolved[i] ? dotOf.get(resolved[i].id) : undefined;
    // No dot (not analysed, or not placed yet): null, never a 404 — a batch.
    out[i] = dot === undefined ? null : (reps.get(dot) ?? null);
  }
  return out;
}

// ── Search ─────────────────────────────────────────────────────────────────

// One category, FTS5 first and the LIKE form when the parser refuses the
// query or MATCH errors (search.js runFtsSearch's rule), LIKE alone without
// FTS5.
function searchCategory(name, fts, like) {
  if (!db.FTS5_AVAILABLE) { return like(); }
  let rows;
  try {
    rows = fts();
  } catch (err) {
    if (err?.code !== 'ERR_SQLITE_ERROR') { throw err; }
    winston.debug(`[map:search] ${name} fell back to LIKE on MATCH error: ${err.message}`);
    return like();
  }
  return rows === null ? like() : rows;
}

const idsOf = (rows) => rows.map((r) => r.id);

function titleIds(mdb, vis, parsed, q) {
  return searchCategory('title', () => {
    const expr = buildFtsExpression({ column: 'title', positive: parsed.positive, negative: parsed.negative });
    if (expr === null) { return null; }
    return idsOf(prep(mdb, `
      SELECT t.id AS id FROM fts_tracks ft JOIN tracks t ON t.id = ft.rowid
       WHERE ft.fts_tracks MATCH ?${vis.sql}
       ORDER BY rank LIMIT ${SEARCH_TITLES_MAX}
    `).all(expr, ...vis.params));
  }, () => idsOf(prep(mdb, `
    SELECT t.id AS id FROM tracks t WHERE t.title LIKE ?${vis.sql} LIMIT ${SEARCH_TITLES_MAX}
  `).all(`%${q}%`, ...vis.params)));
}

// Artists and albums with at least one visible song (an EXISTS probe per
// candidate, as search.js does, never a whole-library IN set).
function artistIds(mdb, vis, parsed, q) {
  return searchCategory('artists', () => {
    const expr = buildFtsExpression({ column: 'name', positive: parsed.positive, negative: parsed.negative });
    if (expr === null) { return null; }
    return idsOf(prep(mdb, `
      SELECT a.id AS id FROM fts_artists fa JOIN artists a ON a.id = fa.rowid
       WHERE fa.fts_artists MATCH ?
         AND EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id${vis.sql})
       ORDER BY rank LIMIT ${SEARCH_ARTISTS_MAX}
    `).all(expr, ...vis.params));
  }, () => idsOf(prep(mdb, `
    SELECT a.id AS id FROM artists a
     WHERE a.name LIKE ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id${vis.sql})
     ORDER BY a.name COLLATE NOCASE LIMIT ${SEARCH_ARTISTS_MAX}
  `).all(`%${q}%`, ...vis.params)));
}

function albumIds(mdb, vis, parsed, q) {
  return searchCategory('albums', () => {
    const expr = buildFtsExpression({ column: 'name', positive: parsed.positive, negative: parsed.negative });
    if (expr === null) { return null; }
    return idsOf(prep(mdb, `
      SELECT al.id AS id FROM fts_albums fa JOIN albums al ON al.id = fa.rowid
       WHERE fa.fts_albums MATCH ?
         AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id${vis.sql})
       ORDER BY rank LIMIT ${SEARCH_ALBUMS_MAX}
    `).all(expr, ...vis.params));
  }, () => idsOf(prep(mdb, `
    SELECT al.id AS id FROM albums al
     WHERE al.name LIKE ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id${vis.sql})
     ORDER BY al.name COLLATE NOCASE LIMIT ${SEARCH_ALBUMS_MAX}
  `).all(`%${q}%`, ...vis.params)));
}

/**
 * Title, artist and album matches as dots (§3.8.6). The track set — titles
 * in rank order, then the matched artists' and albums' songs — is capped at
 * SEARCH_HITS_MAX before any grouping; its dots come back in first-hit
 * order, cut at SEARCH_IDS_MAX, and answer as ascending representative ids.
 * `best` is the first visible title match with a dot.
 */
async function mapSearch(ctx, vis, q) {
  if (ctx.state !== 'ready') { return { ids: [], best: null, capped: false }; }
  const { mdb } = ctx;
  const parsed = parseSearchQuery(q);
  const titles = titleIds(mdb, vis, parsed, q);
  const wide = q.length >= SEARCH_WIDE_MIN;
  const artists = wide ? artistIds(mdb, vis, parsed, q) : [];
  const albums = wide ? albumIds(mdb, vis, parsed, q) : [];
  await yieldToLoop();

  const hits = [];
  const seen = new Set();
  const push = (id) => { if (!seen.has(id)) { seen.add(id); hits.push(id); } };
  for (const id of titles) { push(id); }
  const nTitles = hits.length;
  for (const [col, set] of [['artist_id', artists], ['album_id', albums]]) {
    if (!set.length || hits.length > SEARCH_HITS_MAX) { continue; }
    // MATERIALIZED so the library filter cannot be pushed down: left to
    // itself (no ANALYZE stats) SQLite walks idx_tracks_library across the
    // whole visible library instead of the artist / album index.
    const rows = prep(mdb, `
      WITH s AS MATERIALIZED (
        SELECT t.id AS id, t.library_id AS library_id FROM tracks t
         WHERE t.${col} IN (SELECT value FROM json_each(?)))
      SELECT t.id AS id FROM s t WHERE 1 = 1${vis.sql}
       ORDER BY t.id LIMIT ${SEARCH_HITS_MAX + 1}
    `).all(JSON.stringify(set), ...vis.params);
    for (const r of rows) { push(r.id); }
  }
  let capped = false;
  if (hits.length > SEARCH_HITS_MAX) { capped = true; hits.length = SEARCH_HITS_MAX; }
  if (!hits.length) { return { ids: [], best: null, capped }; }
  await yieldToLoop();

  // Two index-driven statements rather than one grouped join (whose plan
  // walked the whole layout once per hit): each hit's dot by primary key,
  // the first hit's index per dot here, then each dot's representative
  // over ALL its visible members (not just the hits) by idx_track_map_dot.
  const dotOf = dotsOfTracks(ctx, hits);
  const order = [];       // dots in first-hit order
  const firstHit = new Map();
  for (let k = 0; k < hits.length; k++) {
    const dot = dotOf.get(hits[k]);
    if (dot !== undefined && !firstHit.has(dot)) { firstHit.set(dot, k); order.push(dot); }
  }
  const reps = representatives(ctx, vis, order);
  const found = order.filter((dot) => reps.has(dot));
  const best = found.length && firstHit.get(found[0]) < nTitles ? reps.get(found[0]) : null;
  if (found.length > SEARCH_IDS_MAX) { capped = true; found.length = SEARCH_IDS_MAX; }
  return { ids: found.map((dot) => reps.get(dot)).sort((a, b) => a - b), best, capped };
}

// ── Overlays ────────────────────────────────────────────────────────────────

// Mood: the songs mood-filter.js's own predicate keeps, as a Set, then one
// bit per point for its representative. Unscored songs are 0, as they drop
// out of filtered lists.
function moodBits(mdb, moods, entry) {
  const keep = new Set();
  // The predicate's bars are spliced numbers (mood-filter.js bars()), so
  // the text varies per filter: prepared per call, never memoised.
  for (const r of mdb.prepare(`SELECT tm.track_id AS id FROM track_moods tm WHERE ${moodPredicate(moods, 'tm')}`).all()) {
    keep.add(r.id);
  }
  return encodeBitset(entry.n, (i) => keep.has(entry.ids[i]));
}

// Index of `id` in an ascending Uint32Array, or −1.
function findSorted(arr, id) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === id) { return mid; }
    if (v < id) { lo = mid + 1; } else { hi = mid - 1; }
  }
  return -1;
}

// Plays: the caller's played rows, each driven to one track of its hash in
// the serving generation (idx_track_map_hash; user_metadata(user_id,
// play_count) V61), then to that track's dot in the entry's point order.
// Near-duplicate members are summed; a dot the caller cannot see is
// skipped; data[i] = min(255, plays).
function playsBytes(mdb, userId, entry) {
  const out = new Uint8Array(entry.n);
  if (!entry.n) { return out; }
  const rows = prep(mdb, `
    SELECT um.play_count AS plays,
           (SELECT m.track_id FROM track_map m WHERE m.layout_id = ? AND m.hash = um.track_hash LIMIT 1) AS tid
      FROM user_metadata um
     WHERE um.user_id = ? AND um.play_count > 0
  `).all(entry.layoutId, userId);
  const sums = new Float64Array(entry.n);
  for (const r of rows) {
    if (r.tid == null) { continue; }
    const ti = findSorted(entry.trackId, r.tid);
    if (ti < 0) { continue; }
    const p = entry.pos[entry.trackDot[ti]];
    if (p >= 0) { sums[p] += r.plays; }
  }
  for (let i = 0; i < entry.n; i++) { out[i] = sums[i] > 255 ? 255 : sums[i]; }
  return out;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const overlaySchema = Joi.object({
  layer: Joi.string().valid('mood', 'plays').required(),
  rev: Joi.string().min(1).max(32).required(),
  // A MoodFilter as JSON, parsed by parseMoodsQuery (≤ 512 characters).
  moods: Joi.string(),
});

const tracksSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().min(1)).min(1).max(TRACKS_MAX),
  filepaths: Joi.array().items(Joi.string().min(1).max(4096)).min(1).max(TRACKS_MAX),
}).xor('ids', 'filepaths');

const searchSchema = Joi.object({
  q: Joi.string().trim().min(2).max(128).required(),
});

const regionSchema = Joi.object({
  key: Joi.string().min(1).max(64).required(),
  limit: Joi.number().integer().min(1).max(REGION_SONGS_MAX).default(REGION_SONGS_MAX),
});

const neighboursSchema = Joi.object({
  id: Joi.number().integer().min(1).required(),
  limit: Joi.number().integer().min(1).max(NEIGHBOURS_MAX).default(8),
});

// ── Routes ──────────────────────────────────────────────────────────────────

export function setup(mstream) {
  // The map. No query in v1; a client's cache-buster or token rides along
  // unread.
  mstream.get('/api/v1/discovery/map', async (req, res) => {
    const ctx = requireMap(req);
    const vis = visibility(req.user);
    const nowMs = Date.now();
    const { rev, n } = revFor(ctx, vis, nowMs);
    res.set('Cache-Control', 'private, no-cache');
    res.set('ETag', `"${rev}"`);
    if (matchesEtag(req.get('If-None-Match'), rev)) { return res.status(304).end(); }
    if (ctx.state !== 'ready') { return res.json(notReadyBody(ctx.state, rev)); }
    const entry = await mapPayload(caches, ctx, { rev, n }, vis, nowMs);
    // A hit sends the stored string: no JSON.stringify per request.
    res.type('json').send(entry.body);
  });

  mstream.get('/api/v1/discovery/map/overlay', async (req, res) => {
    const { value: q } = joiValidate(overlaySchema, req.query ?? {});
    const ctx = requireMap(req);
    if (q.layer === 'plays') {
      // History-derived: an account's own, never a federation key's or a
      // jukebox guest's (the requireAccount / refuseJukebox patterns).
      if (!req.user?.id) { throw new WebError('Forbidden', 403); }
      if (req.user.jukebox === true) { throw new WebError('not available in a jukebox session', 403); }
    }
    const requested = q.layer === 'mood' ? parseMoodsQuery(q.moods) : null;
    const vis = visibility(req.user);
    const nowMs = Date.now();
    const { rev, n } = revFor(ctx, vis, nowMs);
    res.set('Cache-Control', 'private, no-cache');
    if (q.rev !== rev) { throw new WebError('Map changed', 409); }
    const entry = ctx.state === 'ready' ? await mapPayload(caches, ctx, { rev, n }, vis, nowMs) : EMPTY_ENTRY;

    if (q.layer === 'mood') {
      const { moods, echo } = applicableMoods(requested);
      // No scores to filter by: neither `moods` nor `data`, and clients hide Filters.
      if (echo === undefined) { return res.json({ rev, layer: 'mood', n: entry.n }); }
      const bits = moods ? moodBits(ctx.mdb, moods, entry) : encodeBitset(entry.n, () => 1);
      return res.json({ rev, layer: 'mood', n: entry.n, moods: echo, data: b64(bits) });
    }
    res.json({ rev, layer: 'plays', n: entry.n, data: b64(playsBytes(ctx.mdb, req.user.id, entry)) });
  });

  mstream.post('/api/v1/discovery/map/tracks', (req, res) => {
    const { value: body } = joiValidate(tracksSchema, req.body ?? {});
    const ctx = requireMap(req);
    const vis = visibility(req.user);
    if (body.ids) { return res.json({ tracks: lookupTracks(ctx, vis, req.user, body.ids) }); }
    res.json({ ids: lookupPaths(ctx, vis, req.user, body.filepaths) });
  });

  mstream.post('/api/v1/discovery/map/search', async (req, res) => {
    const { value: body } = joiValidate(searchSchema, req.body ?? {});
    requireMap(req);
    // After validation and the gate, before any work: a 429 costs nothing.
    const release = await searchGate.acquire();
    try {
      // Re-read after any wait in the queue: the pointer may have moved.
      res.json(await mapSearch(requireMap(req), visibility(req.user), body.q));
    } finally {
      release();
    }
  });

  mstream.post('/api/v1/discovery/map/region', (req, res) => {
    const { value: body } = joiValidate(regionSchema, req.body ?? {});
    const ctx = requireMap(req);
    // Unknown, invisible and not-yet-built are one answer.
    const notFound = () => new WebError('Region not found', 404);
    if (ctx.state !== 'ready') { throw notFound(); }
    const vis = visibility(req.user);
    const region = prep(ctx.ddb, 'SELECT level, id, key, label, mix FROM map_regions WHERE layout_id = ? AND key = ?')
      .get(ctx.layoutId, body.key);
    if (!region) { throw notFound(); }
    const col = region.level === 0 ? 'region0' : 'region1';
    const central = region.level === 0 ? 'central0' : 'central1';

    // The most central visible song: one walk down idx_track_map_r0/_r1.
    const centre = prep(ctx.mdb, `
      SELECT t.id AS id FROM track_map m JOIN tracks t ON t.id = m.track_id
       WHERE m.layout_id = ? AND m.${col} = ?${vis.sql}
       ORDER BY m.${central} DESC, t.id LIMIT 1
    `).get(ctx.layoutId, region.id, ...vis.params);
    if (!centre) { throw notFound(); }

    // The mix: the worker's dots in walk order, as this caller's
    // representatives; topped up by centrality when fewer are visible.
    let mix = [];
    try {
      const parsed = JSON.parse(region.mix);
      if (Array.isArray(parsed)) { mix = parsed.filter((d) => typeof d === 'string'); }
    } catch (_e) { /* an unreadable mix tops up from centrality alone */ }
    const reps = representatives(ctx, vis, mix);
    const songs = [];
    const used = new Set();
    for (const dot of mix) {
      if (songs.length >= body.limit) { break; }
      const id = reps.get(dot);
      if (id === undefined || used.has(dot)) { continue; }
      used.add(dot);
      songs.push(id);
    }
    if (songs.length < body.limit) {
      // MATERIALIZED: grouped by dot, the planner would rather walk the
      // whole layout down idx_track_map_dot than this region's index.
      const more = prep(ctx.mdb, `
        WITH r AS MATERIALIZED (
          SELECT m.dot AS dot, t.id AS id, t.library_id AS library_id, m.${central} AS c
            FROM track_map m JOIN tracks t ON t.id = m.track_id
           WHERE m.layout_id = ? AND m.${col} = ?)
        SELECT t.dot AS dot, MIN(t.id) AS id, MAX(t.c) AS c FROM r t
         WHERE 1 = 1${vis.sql}
         GROUP BY t.dot
         ORDER BY c DESC, id
         LIMIT ?
      `).all(ctx.layoutId, region.id, ...vis.params, body.limit + used.size);
      for (const r of more) {
        if (songs.length >= body.limit) { break; }
        if (used.has(r.dot)) { continue; }
        used.add(r.dot);
        songs.push(r.id);
      }
    }

    // Lite rows, as the similar and path routes send: they queue without
    // translation.
    const rows = liteRows([centre.id, ...songs], req.user);
    if (!rows.has(centre.id)) { throw notFound(); }
    res.json({
      region: { key: region.key, level: region.level, label: region.label ?? null },
      centre: rows.get(centre.id),
      songs: songs.map((id) => rows.get(id)).filter(Boolean),
    });
  });

  mstream.post('/api/v1/discovery/map/neighbours', (req, res) => {
    const { value: body } = joiValidate(neighboursSchema, req.body ?? {});
    const ctx = requireMap(req);
    const notFound = () => new WebError('Track not found', 404);
    if (ctx.state !== 'ready') { throw notFound(); }
    const vis = visibility(req.user);
    // The seed: a track this caller can see, with a dot in the serving
    // layout. Resolved before the index, so an unknown id never pays for a
    // cold index build.
    const seedRow = prep(ctx.mdb, `
      SELECT m.hash AS hash, m.dot AS dot FROM track_map m JOIN tracks t ON t.id = m.track_id
       WHERE m.layout_id = ? AND m.track_id = ?${vis.sql}
    `).get(ctx.layoutId, body.id, ...vis.params);
    if (!seedRow) { throw notFound(); }
    const seedLite = liteRows([body.id], req.user).get(body.id);
    if (!seedLite) { throw notFound(); }
    const index = requireIndex();

    // During a model switch the serving layout can be the previous model's,
    // and the seed may have no vector in this model yet.
    const seedEntry = index.byHash.get(seedRow.hash);
    if (!seedEntry) { return res.json({ seed: seedLite, notAnalyzed: true, neighbours: [] }); }

    const budget = considerBudget(body.limit);
    const ranked = sim.rankTracks(index, seedEntry.vec, seedRow.hash, budget);
    const found = [];
    const seen = new Set([seedRow.dot]);
    for (let i = 0; i < ranked.length && found.length < body.limit; i += NEIGHBOUR_CHUNK) {
      const chunk = ranked.slice(i, i + NEIGHBOUR_CHUNK);
      const dotOf = new Map();
      for (const r of prep(ctx.mdb, `
        SELECT hash, dot FROM track_map
         WHERE layout_id = ? AND hash IN (SELECT value FROM json_each(?))
      `).all(ctx.layoutId, JSON.stringify(chunk.map((c) => c.entry.hash)))) {
        dotOf.set(r.hash, r.dot);
      }
      // Candidates with no dot (embedded but not placed yet, or another
      // model's layout serving) are skipped; so are the seed's dot, dots
      // already taken and dots this caller cannot see.
      const fresh = [];
      for (const c of chunk) {
        const dot = dotOf.get(c.entry.hash);
        if (dot !== undefined && !seen.has(dot) && !fresh.includes(dot)) { fresh.push(dot); }
      }
      const reps = representatives(ctx, vis, fresh);
      for (const c of chunk) {
        if (found.length >= body.limit) { break; }
        const dot = dotOf.get(c.entry.hash);
        if (dot === undefined || seen.has(dot)) { continue; }
        seen.add(dot);
        const id = reps.get(dot);
        if (id === undefined) { continue; }
        found.push({ id, similarity: Math.round(c.similarity * 10000) / 10000 });
      }
    }
    // Short because the budget stopped the walk (not because the pool ran
    // dry): the similar route's `capped` (api/discovery.js).
    const capped = found.length < body.limit && ranked.length >= budget;
    const rows = liteRows(found.map((f) => f.id), req.user);
    res.json({
      seed: seedLite,
      notAnalyzed: false,
      capped,
      neighbours: found.filter((f) => rows.has(f.id)).map((f) => ({ ...rows.get(f.id), similarity: f.similarity })),
    });
  });
}
