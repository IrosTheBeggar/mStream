// mStream music map worker — child process forked by src/db/task-queue.js
// (role 'map'; a Bun standalone binary re-invokes itself with
// --mstream-worker=map, src/util/worker-process.js).
//
// Turns the active model's embeddings (discovery.db discovery_tracks) into
// the Atlas layout the map routes serve (src/api/discovery-map.js; the plan
// is docs/music-map-plan.md §3.4): PCA-50 on a stored basis; UMAP (umap-js,
// through map-umap.js) on at most nFitMax songs — the fit set, the lowest
// audio hashes; kNN placement of the rest against that fit set; rotated
// near-square, flipped by a data-anchored rule and boxed into [0,1]²;
// near-duplicate dots; towns (k-means on map positions) and provinces
// (generated genres) with stable keys and hues; place mixes; land rings.
// Every algorithm lives in the pure map-lib.js — this file is I/O, ordering
// and crash safety.
//
// What a run does is decided from the data (map-lib decideMapMode, first
// match wins): empty | mirror | rebuild | refit | place. Rebuilds and refits
// write a NEW layout (state 'building' until complete), mirror it into
// mstream.db track_map as a new, invisible generation in ≤ 2,000-row
// transactions (map-sync.js), then flip track_map_meta in one tiny
// transaction. Place and mirror runs change the serving layout in place:
// point chunks first (dirty = 1 while they are ahead of the region update),
// then one region transaction. Recovery at start handles every interruption
// point, so cancelling is killing the process — the kill queue, the
// parent's 30-minute timer, or the boot reaper for an orphan.
//
// Never touches row_seq or index_epoch (the P2P auto-publish and the
// similarity index key on them) and never imports the model registry,
// config state, manager.js or genre-sync.js: the model id, paths and memory
// facts come in the payload, the embedding dimension from the blobs.
// Positional parameters and paged reads only: under Bun the driver is the
// bun:sqlite shim (no iterate(), no named parameters).
//
// CLI input — single argv entry, JSON-encoded (task-queue.js mapPayload):
//   { discoveryDbPath, libraryDbPath, model, expectedSchemaVersion,
//     parentRssBytes, maxFitTracks?, force?: 'rebuild', settled, budgetSec }
//
// stdout protocol — line-buffered single-line JSON events:
//   { event: 'mapProgress', phase, attempted, total }
//       phase: inventory | pca | fit | place | regions | land | write |
//       mirror. Each phase opens with attempted 0; the fit phase's opening
//       event carries total = |F|, the songs in the fit (its later events
//       count epochs).
//   { event: 'mapComplete', mode, layoutId, method, fitted, placed, removed,
//     dots, regions, nFitTried, ms, peakRssMB, hitCap }
//   { event: 'error', message, nFitTried? }   ← always followed by a non-zero
//       exit; a memory-guard exit always carries nFitTried
//
// Exit codes: 0 done; 1 fatal (bad input, DB open, an algorithm throw);
// 3 library schema-version guard; 5 memory guard (the queue halves the fit
// cap and retries once per boot).
//
// Test seams (environment, inert unless set):
//   MSTREAM_TEST_MAP_HOLD=<phase>   block at the start of that phase until
//                                   killed; 'flip' blocks right after the
//                                   pointer flip of a rebuild or refit
//   MSTREAM_TEST_MAP_RELEASE=<file> with HOLD: the hold ends once that file
//                                   exists (a hold the test resumes)
//   MSTREAM_TEST_MAP_NOW_MS         replaces Date.now() in the mode decision
//   MSTREAM_TEST_MAP_PLACE_MAX      replaces placeMax
//   MSTREAM_TEST_MAP_FIT_FLOOR      lowers FIT_FLOOR
//   MSTREAM_TEST_MAP_FORCE_GUARD    trips the memory guard at the fit

import fs from 'node:fs';
import os from 'node:os';
import Joi from 'joi';
import winston from 'winston';
import { DatabaseSync } from './sqlite-driver.js';
import {
  initDiscoveryDb, getMeta, bumpMapVersion, reserveMapKeys, initMapRecentAfter,
} from './discovery-db.js';
import {
  reconcileTrackMap, flipTrackMap, clearTrackMapPointer, deleteTrackMapGenerations,
  readTrackMapPointer, mapPointerValid,
} from './map-sync.js';
// Static on purpose: the bundle smoke (`--mstream-worker=map '{}'`) proves
// umap-js is embedded because this import runs before input validation.
import { fitUmap } from './map-umap.js';
import {
  MAP_LAYOUT_VERSION, MAP_NEAR_DUP, MAP_PCA_NEAR_DUP_BOUND, FIT_FLOOR, FIT_CEIL, PLACE_MAX,
  PLACE_CHECK_EVERY, PCA_SAMPLE_MAX, UMAP_PARAMS, UMAP_REFIT, UMAP_MIN_FIT, KNN_PLACE_K,
  GRID_CELL_SHARE, MIX_MAX, MiB,
  compareHash, hashSeed32, cosine, mapMethod, decideMapMode, mapFitBudget, fitFitsBudget,
  rssOverBudget, parseMemAvailable, parseCgroupLimit, parseCgroupUsage, pcaComponents,
  randomizedPCA, basisF32, projectInto, rowsOf, pcaInit, pca2Raw, rawSpan, applyAffine,
  invertAffine, layoutAffine, needsBoxRefit, refitAffine, procrustes, applySimilarity, knnPlace,
  displacementField, knnGraphPairs, gridCandidates, groupNearDuplicates, groupsOf, townCount,
  kmeansPP, lloyd, resizeCentres, assignNearest, compactClusters, topStyle, buildRegions,
  assignToTowns, refreshRegionGeometry, centrality, regionMix, landSigma, buildLand,
  landAdjacency, assignHues, f32ToBytes, f32FromBytes,
} from './map-lib.js';

const SCHEMA_GUARD_EXIT = 3;
const MEMORY_GUARD_EXIT = 5;

// Keyset page for row reads; IN-list chunk; rows per write transaction
// (≈ 100 ms of lock, the house rule); rows per cleanup DELETE; embedding
// rows per rowid page while projecting (5 KB each at 1280-d).
const PAGE = 5000;
const IN_CHUNK = 500;
const WRITE_CHUNK = 2000;
const DELETE_CHUNK = 5000;
const VECTOR_PAGE = 2000;
// Placement progress events, every this many songs.
const PLACE_REPORT_EVERY = 1000;

// discovery-db.js logs through winston; a forked child has no transports
// configured, and winston prints a noisy meta-warning per call in that
// state. Route warn+ to stderr (task-queue forwards it) and drop info.
winston.configure({
  transports: [new winston.transports.Console({ level: 'warn', stderrLevels: ['error', 'warn'] })],
});

// ── Test seams ───────────────────────────────────────────────────────────────

function envPositiveInt(name) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : null;
}
// Lowered only: a fit below UMAP_MIN_FIT cannot run at all.
const fitFloor = Math.max(UMAP_MIN_FIT, Math.min(FIT_FLOOR, envPositiveInt('MSTREAM_TEST_MAP_FIT_FLOOR') ?? FIT_FLOOR));
const placeMax = envPositiveInt('MSTREAM_TEST_MAP_PLACE_MAX') ?? PLACE_MAX;
const modeNowMs = envPositiveInt('MSTREAM_TEST_MAP_NOW_MS') ?? Date.now();
const holdAt = process.env.MSTREAM_TEST_MAP_HOLD || null;
const holdRelease = process.env.MSTREAM_TEST_MAP_RELEASE || null;
const forceGuard = !!process.env.MSTREAM_TEST_MAP_FORCE_GUARD;

// ── Parse + validate CLI input ───────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1]);
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  discoveryDbPath: Joi.string().required(),
  libraryDbPath: Joi.string().required(),
  // The configured model id. The worker never imports the model registry:
  // the dimension comes from the blobs.
  model: Joi.string().required(),
  // Guard against the LIBRARY db being mid-migration under us (same contract
  // as the other enrichment workers).
  expectedSchemaVersion: Joi.number().integer().required(),
  // The server's RSS at fork: the memory budget leaves room for it.
  parentRssBytes: Joi.number().integer().min(0).required(),
  // Cap on the fit set (scanOptions.mapMaxFitTracks, or the queue's halved
  // cap after a memory-guard exit). Absent = derived from the machine.
  maxFitTracks: Joi.number().integer().min(fitFloor).max(FIT_CEIL).optional(),
  // An admin rebuild: rebuild from the current vectors whatever the data says.
  force: Joi.string().valid('rebuild').optional(),
  // The embedding backlog just drained: lets a model switch rebuild.
  settled: Joi.boolean().default(false),
  // Wall-clock budget for one run's placements.
  budgetSec: Joi.number().integer().min(1).max(3600).default(120),
});

const { error: validationError, value: cfg } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

// ── Output and exits ─────────────────────────────────────────────────────────

function emit(event) { process.stdout.write(`${JSON.stringify(event)}\n`); }

// A deliberate stop with an exit code and the event that explains it.
class WorkerExit extends Error {
  constructor(code, event) {
    super(event.message);
    this.code = code;
    this.event = event;
  }
}

// The memory guard (§3.4.6): exit 5, carrying the fit size that was tried.
class MemoryGuardError extends Error {
  constructor(message, nFitTried) {
    super(message);
    this.nFitTried = nFitTried;
  }
}

let mdb = null;
let ddb = null;

function closeAll() {
  try { mdb?.close(); } catch (_e) { /* best-effort */ }
  try { ddb?.close(); } catch (_e) { /* best-effort */ }
}

// process.exit() can drop a pipe write still in flight (stdout is
// asynchronous on macOS and Windows pipes), and the queue reads nFitTried
// from the error event: exit once stdout has taken the last line. The
// timer is a backstop for a stdout that never drains.
function emitThenExit(event, code) {
  closeAll();
  const done = () => process.exit(code);
  setTimeout(done, 3000);
  process.stdout.write(`${JSON.stringify(event)}\n`, done);
}

// MSTREAM_TEST_MAP_HOLD: park here until the test kills the process, or with
// MSTREAM_TEST_MAP_RELEASE until that file exists. The interval keeps the
// event loop alive; a bare pending promise would not.
function holdHere() {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (holdRelease && fs.existsSync(holdRelease)) { clearInterval(timer); resolve(); }
    }, holdRelease ? 20 : 60 * 1000);
  });
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// ── Memory ───────────────────────────────────────────────────────────────────

const runtime = process.versions.bun ? 'bun' : 'node';
let budget = null;       // the live memory budget, once a mode needs one
let fitTried = 0;        // |F| of the fit in hand (the guard's nFitTried)
let peakRss = 0;
let phaseName = null;

function rssNow() {
  const rss = typeof process.memoryUsage.rss === 'function' ? process.memoryUsage.rss() : process.memoryUsage().rss;
  if (rss > peakRss) { peakRss = rss; }
  return rss;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_e) { return null; }
}

// The readings mapFitBudget takes. Linux adds MemAvailable and the cgroup
// (v2, else v1), read the same way under Node and Bun; never os.freemem()
// or process.availableMemory(), which disagree wildly between runtimes.
function memoryReadings() {
  const out = { totalMemBytes: os.totalmem(), constrainedBytes: 0, cgroupLimitBytes: 0, cgroupUsageBytes: 0, memAvailableBytes: null };
  try { out.constrainedBytes = Number(process.constrainedMemory?.()) || 0; } catch (_e) { /* not offered here */ }
  if (process.platform === 'linux') {
    out.memAvailableBytes = parseMemAvailable(readText('/proc/meminfo'));
    const v2 = readText('/sys/fs/cgroup/memory.max');
    if (v2 !== null) {
      out.cgroupLimitBytes = parseCgroupLimit(v2);
      out.cgroupUsageBytes = parseCgroupUsage(readText('/sys/fs/cgroup/memory.current'));
    } else {
      out.cgroupLimitBytes = parseCgroupLimit(readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
      out.cgroupUsageBytes = parseCgroupUsage(readText('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
    }
  }
  return out;
}

function liveBudget(nEmbedded, dim) {
  return mapFitBudget({
    runtime, ...memoryReadings(), parentRssBytes: cfg.parentRssBytes, nEmbedded, dim: dim || 0,
    override: cfg.maxFitTracks, fitFloor,
  });
}

const mb = (bytes) => Math.round(bytes / MiB);

// Between phases, every 25 epochs and between placement reports: the RSS
// threshold is absolute (budget + 64 MiB), whatever the fit size.
function guardMemory() {
  const rss = rssNow();
  if (budget && rssOverBudget(rss, budget)) {
    throw new MemoryGuardError(`memory guard: ${mb(rss)} MB in use against a ${mb(budget.budget)} MB budget (${phaseName ?? 'start'})`, fitTried);
  }
}

// Right before a UMAP fit, with live readings: the dominant peak is inside
// umap-js's single synchronous initializeFit, where no check can run.
function preFitCheck(nFit, nEmbedded, dim) {
  budget = liveBudget(nEmbedded, dim);
  fitTried = nFit;
  if (forceGuard || !fitFitsBudget(budget, nFit)) {
    throw new MemoryGuardError(`memory guard: a fit of ${nFit} songs needs about `
      + `${mb(budget.base + budget.perPoint * nFit)} MB, the budget is ${mb(budget.budget)} MB`, nFit);
  }
}

async function enterPhase(name, total = null) {
  phaseName = name;
  emit({ event: 'mapProgress', phase: name, attempted: 0, total });
  guardMemory();
  if (holdAt === name) { await holdHere(); }
}

// ── Small DB helpers ─────────────────────────────────────────────────────────

function txImmediate(handle, fn) {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch (_e) { /* not in a transaction */ }
    throw err;
  }
}

// IN-list statements, cached by list length (a run needs two or three).
const inStatements = new Map();
function inStatement(head, n) {
  const key = `${head}#${n}`;
  let stmt = inStatements.get(key);
  if (!stmt) {
    stmt = ddb.prepare(`${head} (${new Array(n).fill('?').join(',')})`);
    inStatements.set(key, stmt);
  }
  return stmt;
}

// Current-model vectors of `hashes` with the right dimension, handed to
// onVec(hash, Float32Array) one IN chunk at a time (never all in memory).
function forEachVector(hashes, dim, onVec) {
  for (let i = 0; i < hashes.length; i += IN_CHUNK) {
    const chunk = hashes.slice(i, i + IN_CHUNK);
    const stmt = inStatement(
      'SELECT audio_hash, embedding FROM discovery_tracks WHERE model_id = ? AND embedding IS NOT NULL AND audio_hash IN',
      chunk.length);
    for (const r of stmt.all(cfg.model, ...chunk)) {
      if (!r.embedding || r.embedding.byteLength !== 4 * dim) { continue; }
      onVec(r.audio_hash, f32FromBytes(r.embedding));
    }
  }
}

// `hashes` projected with `basis`, input order kept; hashes with no
// readable current-model vector are left out.
function projectHashes(hashes, basis) {
  const { k } = basis;
  const at = new Map();
  hashes.forEach((h, i) => at.set(h, i));
  const z = new Float32Array(hashes.length * k);
  const got = new Uint8Array(hashes.length);
  forEachVector(hashes, basis.dim, (h, v) => {
    const i = at.get(h);
    projectInto(v, 0, basis, z, i * k);
    got[i] = 1;
  });
  const keep = [];
  for (let i = 0; i < hashes.length; i++) { if (got[i]) { keep.push(i); } }
  return { hashes: keep.map((i) => hashes[i]), z: gatherRows(z, keep, k) };
}

function genreTagsOf(hashes) {
  const out = new Map();
  for (let i = 0; i < hashes.length; i += IN_CHUNK) {
    const chunk = hashes.slice(i, i + IN_CHUNK);
    const stmt = inStatement('SELECT audio_hash, genre_tags FROM discovery_tracks WHERE audio_hash IN', chunk.length);
    for (const r of stmt.all(...chunk)) { out.set(r.audio_hash, r.genre_tags ?? null); }
  }
  return out;
}

// Which of `hashes` still have a discovery_tracks row (the write re-check).
function discoveryHashesPresent(hashes) {
  const out = new Set();
  for (let i = 0; i < hashes.length; i += IN_CHUNK) {
    const chunk = hashes.slice(i, i + IN_CHUNK);
    const stmt = inStatement('SELECT audio_hash FROM discovery_tracks WHERE audio_hash IN', chunk.length);
    for (const r of stmt.all(...chunk)) { out.add(r.audio_hash); }
  }
  return out;
}

function gatherRows(z, idx, k) {
  const out = new Float32Array(idx.length * k);
  for (let j = 0; j < idx.length; j++) {
    const o = idx[j] * k;
    for (let t = 0; t < k; t++) { out[j * k + t] = z[o + t]; }
  }
  return out;
}

function gatherXY(xy, idx) {
  const out = new Float64Array(2 * idx.length);
  for (let j = 0; j < idx.length; j++) {
    out[2 * j] = xy[2 * idx[j]];
    out[2 * j + 1] = xy[2 * idx[j] + 1];
  }
  return out;
}

function pointsXY(pts) {
  const out = new Float64Array(2 * pts.length);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = pts[i].x;
    out[2 * i + 1] = pts[i].y;
  }
  return out;
}

// ── Layout rows ──────────────────────────────────────────────────────────────

function parseJson(text) {
  try { return JSON.parse(text); } catch (_e) { return null; }
}

function parseLayout(row) {
  if (!row) { return null; }
  const parsed = parseJson(row.params);
  const params = parsed && typeof parsed === 'object' ? parsed : {};
  const affine = parseJson(row.affine);
  const usable = Array.isArray(affine) && affine.length === 6 && affine.every(Number.isFinite)
    && affine[0] * affine[4] - affine[1] * affine[3] !== 0;
  return { ...row, params, affine: usable ? affine : null };
}

function basisOf(S) {
  return {
    k: S.k, dim: S.dim,
    mean: f32FromBytes(S.pca_mean, S.dim),
    axes: f32FromBytes(S.pca_axes, S.k * S.dim),
  };
}

// A layout always goes points → regions → row (foreign keys are never on in
// discovery.db). Points go in chunks: a big layout must not hold the lock.
function deleteLayout(id) {
  const delPoints = ddb.prepare(
    `DELETE FROM map_points WHERE id IN (SELECT id FROM map_points WHERE layout_id = ? LIMIT ${DELETE_CHUNK})`);
  for (let n = DELETE_CHUNK; n === DELETE_CHUNK;) { n = delPoints.run(id).changes; }
  ddb.prepare('DELETE FROM map_regions WHERE layout_id = ?').run(id);
  ddb.prepare('DELETE FROM map_layouts WHERE id = ?').run(id);
}

function deleteOrphans() {
  const points = ddb.prepare(`
    DELETE FROM map_points WHERE id IN (
      SELECT id FROM map_points WHERE layout_id NOT IN (SELECT id FROM map_layouts) LIMIT ${DELETE_CHUNK})`);
  for (let n = DELETE_CHUNK; n === DELETE_CHUNK;) { n = points.run().changes; }
  const regions = ddb.prepare(`
    DELETE FROM map_regions WHERE rowid IN (
      SELECT rowid FROM map_regions WHERE layout_id NOT IN (SELECT id FROM map_layouts) LIMIT ${DELETE_CHUNK})`);
  for (let n = DELETE_CHUNK; n === DELETE_CHUNK;) { n = regions.run().changes; }
}

function loadPoints(layoutId, k) {
  const rows = [];
  const page = ddb.prepare(`
    SELECT id, audio_hash, dot, x, y, placed, region0, region1, central0, central1, pca
      FROM map_points NOT INDEXED
     WHERE layout_id = ? AND id > ?
     ORDER BY id
     LIMIT ${PAGE}
  `);
  for (let after = -1; ;) {
    const part = page.all(layoutId, after);
    for (const r of part) { rows.push(r); }
    if (part.length < PAGE) { break; }
    after = part[part.length - 1].id;
  }
  rows.sort((a, b) => compareHash(a.audio_hash, b.audio_hash));
  const z = new Float32Array(rows.length * k);
  const pts = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (k > 0) { z.set(f32FromBytes(r.pca, k), i * k); }
    pts[i] = {
      id: r.id, hash: r.audio_hash, dot: r.dot, x: r.x, y: r.y, placed: r.placed,
      r0: r.region0, r1: r.region1, c0: r.central0, c1: r.central1,
    };
  }
  return { pts, z };
}

function loadRegions(layoutId) {
  return ddb.prepare(`
    SELECT level, id, key, parent, label, style, hue, x, y, anchor_x, anchor_y, extent, size, mix
      FROM map_regions WHERE layout_id = ? ORDER BY level, id
  `).all(layoutId);
}

// The previous layout's regions as buildRegions takes them: members are
// the hashes of its points (keys are matched by audio-hash membership,
// which no model switch changes).
function previousRegionsOf(regionRows, points) {
  const townMembers = new Map(), provinceMembers = new Map();
  for (const p of points) {
    if (!townMembers.has(p.r1)) { townMembers.set(p.r1, []); }
    townMembers.get(p.r1).push(p.hash);
    if (!provinceMembers.has(p.r0)) { provinceMembers.set(p.r0, []); }
    provinceMembers.get(p.r0).push(p.hash);
  }
  const towns = [], provinces = [];
  for (const r of regionRows) {
    const members = (r.level === 1 ? townMembers : provinceMembers).get(r.id) ?? [];
    (r.level === 1 ? towns : provinces).push({ key: r.key, label: r.label, style: r.style, hue: r.hue, members });
  }
  return { towns, provinces };
}

function checkSchemaGuard(context) {
  const v = mdb.prepare('PRAGMA user_version').get().user_version;
  if (v !== cfg.expectedSchemaVersion) {
    throw new WorkerExit(SCHEMA_GUARD_EXIT, {
      event: 'error',
      message: `schema-version guard: library DB is V${v}, expected V${cfg.expectedSchemaVersion} (${context})`,
    });
  }
}

// The canonical hash is still some track's (the gone re-check): an indexed
// probe of each hash column, the COALESCE rule spelled out.
let trackProbe = null;
function trackHasHash(hash) {
  trackProbe ??= {
    audio: mdb.prepare('SELECT 1 FROM tracks WHERE audio_hash = ? LIMIT 1'),
    file: mdb.prepare('SELECT 1 FROM tracks WHERE file_hash = ? AND audio_hash IS NULL LIMIT 1'),
  };
  return !!(trackProbe.audio.get(hash) || trackProbe.file.get(hash));
}

// ── Recovery at start (§3.4.3) ───────────────────────────────────────────────

function recover() {
  // 1. A layout still 'building' is a crashed rebuild or refit; orphans are
  //    what an interrupted delete left.
  for (const { id } of ddb.prepare("SELECT id FROM map_layouts WHERE state = 'building'").all()) { deleteLayout(id); }
  deleteOrphans();
  // 2–3. S = the valid pointer's layout, else the newest ready one (adopted
  //      after an mstream.db restore or a map-table reset), else none.
  const pointer = readTrackMapPointer(mdb);
  const valid = mapPointerValid(pointer, ddb);
  const S = valid
    ? parseLayout(ddb.prepare('SELECT * FROM map_layouts WHERE id = ?').get(pointer.active_layout))
    : parseLayout(ddb.prepare("SELECT * FROM map_layouts WHERE state = 'ready' ORDER BY id DESC LIMIT 1").get());
  // 4. Ready layouts other than S: the previous one survives a flip until
  //    here, so a route that read the old pointer could still read it.
  for (const { id } of ddb.prepare("SELECT id FROM map_layouts WHERE state = 'ready' AND id <> ?").all(S?.id ?? -1)) {
    deleteLayout(id);
  }
  // 5. An invalid pointer goes NULL first (a rev bump), then every mirror
  //    generation but S's: leftovers of a crash mid-write or mid-delete.
  if (!valid) { clearTrackMapPointer(mdb); }
  deleteTrackMapGenerations(mdb, { keep: S?.id ?? null });
  return { S, adopted: !valid && S !== null };
}

// ── Inventory (§3.4.4 step 1) ────────────────────────────────────────────────

function readInventory(S) {
  const embedded = [];   // current-model hashes, index order
  const P = [];          // S's points: { hash, dot, r0, r1, fit }
  let dimBytes;
  // One read transaction: one WAL snapshot for both sides of discovery.db.
  ddb.exec('BEGIN');
  try {
    const uPage = ddb.prepare(`
      SELECT audio_hash FROM discovery_tracks
       WHERE embedding IS NOT NULL AND model_id = ? AND audio_hash > ?
       ORDER BY audio_hash LIMIT ${PAGE}
    `);
    for (let after = ''; ;) {
      const part = uPage.all(cfg.model, after);
      for (const r of part) { embedded.push(r.audio_hash); }
      if (part.length < PAGE) { break; }
      after = part[part.length - 1].audio_hash;
    }
    if (S) {
      const pPage = ddb.prepare(`
        SELECT id, audio_hash, dot, region0, region1, placed FROM map_points NOT INDEXED
         WHERE layout_id = ? AND id > ? ORDER BY id LIMIT ${PAGE}
      `);
      for (let after = -1; ;) {
        const part = pPage.all(S.id, after);
        for (const r of part) {
          P.push({ hash: r.audio_hash, dot: r.dot, r0: r.region0, r1: r.region1, fit: r.placed === 'fit' });
        }
        if (part.length < PAGE) { break; }
        after = part[part.length - 1].id;
      }
    }
    dimBytes = ddb.prepare(
      'SELECT length(embedding) AS len FROM discovery_tracks WHERE embedding IS NOT NULL AND model_id = ? LIMIT 1'
    ).get(cfg.model)?.len ?? null;
    ddb.exec('COMMIT');
  } catch (err) {
    try { ddb.exec('ROLLBACK'); } catch (_e) { /* not in a transaction */ }
    throw err;
  }
  // The library side, once: canonical hashes present in tracks.
  const L = new Set();
  for (const r of mdb.prepare(
    'SELECT DISTINCT COALESCE(audio_hash, file_hash) AS h FROM tracks WHERE audio_hash IS NOT NULL OR file_hash IS NOT NULL'
  ).all()) { L.add(r.h); }

  const dim = Number.isInteger(dimBytes) && dimBytes > 0 && dimBytes % 4 === 0 ? dimBytes / 4 : null;
  const U = dim === null ? [] : embedded.filter((h) => L.has(h)).sort(compareHash);
  const Pset = new Set();
  const dots = new Set();
  let gone = 0, fitLive = 0;
  for (const p of P) {
    Pset.add(p.hash);
    dots.add(p.dot);
    if (!L.has(p.hash)) { gone++; } else if (p.fit) { fitLive++; }
  }
  const newHashes = U.filter((h) => !Pset.has(h));
  return {
    U, L, P, dim, newHashes, gone, nPinL: P.length - gone, nEmbedded: embedded.length, nDotsS: dots.size,
    // S's landmarks whose songs are still in the library (place runs prune
    // the others): decideMapMode refits before they run out.
    nFitLive: fitLive,
  };
}

// ── Mirror helpers ───────────────────────────────────────────────────────────

function libraryAddedMax() {
  return mdb.prepare('SELECT MAX(created_at) AS m FROM tracks').get()?.m ?? null;
}

// After a rebuild, a refit or an adopted layout: the pointer flips to
// `layoutId`, the other generations' mirror rows go in chunks, and the
// first ready layout ever sets the recent baseline.
async function flipTo(layoutId, addedMax) {
  flipTrackMap(mdb, { layoutId, mapEpoch: getMeta('map_epoch'), addedMax });
  if (holdAt === 'flip') { await holdHere(); }
  deleteTrackMapGenerations(mdb, { keep: layoutId });
  initMapRecentAfter(libraryAddedMax(), ddb);
}

// ── Near-duplicate dots (§3.4.4 step 7) ──────────────────────────────────────

// Union-find over the candidate pairs, verified on the exact current-model
// vectors (cos ≥ MAP_NEAR_DUP). Only the vectors a verification can need
// are read: the candidates', plus the members of previous groups when they
// are re-verified.
function groupDots(pairs, previous, hashes, { keepLabels, dim }) {
  const want = new Set();
  for (const [a, b] of pairs) { want.add(a); want.add(b); }
  if (previous && !keepLabels) {
    const inLayout = new Set(hashes);
    const byDot = new Map();
    for (const [h, dot] of previous) {
      if (!inLayout.has(h)) { continue; }
      if (!byDot.has(dot)) { byDot.set(dot, []); }
      byDot.get(dot).push(h);
    }
    for (const members of byDot.values()) {
      if (members.length > 1) { for (const h of members) { want.add(h); } }
    }
  }
  const vecs = new Map();
  if (dim) { forEachVector(Array.from(want).sort(compareHash), dim, (h, v) => vecs.set(h, v)); }
  const verify = (a, b) => {
    const va = vecs.get(a), vb = vecs.get(b);
    return !!va && !!vb && cosine(va, vb) >= MAP_NEAR_DUP;
  };
  return groupNearDuplicates(pairs, verify, previous, { hashes, keepLabels, reverify: true });
}

// Every pair of a small (pca2) library within the PCA bound: n < 50.
function pcaPairs(hashes, z, k) {
  const out = [];
  const bound2 = MAP_PCA_NEAR_DUP_BOUND * MAP_PCA_NEAR_DUP_BOUND;
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      let s = 0;
      for (let t = 0; t < k && s <= bound2; t++) { const d = z[i * k + t] - z[j * k + t]; s += d * d; }
      if (s <= bound2) { out.push([hashes[i], hashes[j]]); }
    }
  }
  return out;
}

// ── Placement (§3.4.4 step 5) ────────────────────────────────────────────────

// kNN-place qZ's rows against the reference set in batches of
// PLACE_CHECK_EVERY, stopping at `limit` or once the run's budgetSec is
// spent (checked after each batch, so a run always places something).
// `near` pairs are placed ↔ landmark near-duplicate candidates.
async function placeBatches({ refZ, refRaw, refHashes, k, qZ, qHashes, limit }) {
  const count = Math.min(limit, qHashes.length);
  const raw = new Float64Array(2 * count), pre = new Float64Array(2 * count);
  const near = [];
  if (count === 0) { return { done: 0, raw, pre, near }; }
  if (refHashes.length === 0) { throw new Error('the layout has no fit set to place against'); }
  const span = rawSpan(refRaw);   // fixed for the run: placements never depend on batch boundaries
  const started = Date.now();
  let done = 0, reported = 0;
  while (done < count) {
    const b = Math.min(PLACE_CHECK_EVERY, count - done);
    const res = knnPlace({
      refZ, refRaw, k, queryZ: qZ.subarray(done * k, (done + b) * k), hashes: qHashes.slice(done, done + b),
      span, neighbours: KNN_PLACE_K, nearBound: MAP_PCA_NEAR_DUP_BOUND,
    });
    raw.set(res.raw, 2 * done);
    pre.set(res.pre, 2 * done);
    for (const [q, r] of res.near) { near.push([qHashes[done + q], refHashes[r]]); }
    done += b;
    if (done - reported >= PLACE_REPORT_EVERY && done < count) {
      reported = done;
      emit({ event: 'mapProgress', phase: 'place', attempted: done, total: count });
      guardMemory();
      await yieldToLoop();
    }
    if (Date.now() - started > cfg.budgetSec * 1000) { break; }
  }
  return { done, raw: raw.subarray(0, 2 * done), pre: pre.subarray(0, 2 * done), near };
}

// Progress every 25 epochs, a yield every 10 so stdout flushes.
function epochReporter() {
  return (e, epochs) => {
    if (e % 25 === 0 || e === epochs) {
      emit({ event: 'mapProgress', phase: 'fit', attempted: e, total: epochs });
      guardMemory();
    }
    return e % 10 === 0 ? yieldToLoop() : null;
  };
}

// ── New layouts: rebuild and refit share the tail ────────────────────────────

// From positioned points to a ready layout serving through the pointer:
// dots, regions, centralities and mixes, land and hues, the discovery.db
// rows, the mirror generation and the flip. `points` arrays are sorted by
// hash: hashes, z (k per point), mapXY, isFit, checked (re-check at write:
// the hash came from this run's vectors), plus the candidate pairs.
async function finishLayout(spec) {
  const { hashes, z, k, mapXY, isFit, checked, method, layout } = spec;
  const n = hashes.length;
  const dotOf = groupDots(spec.pairs, spec.previousDots, hashes, { keepLabels: false, dim: spec.dim });
  const groups = groupsOf(dotOf);
  const idxOf = new Map();
  hashes.forEach((h, i) => idxOf.set(h, i));
  const labels = Array.from(groups.keys());
  const nDots = labels.length;
  const dotXY = new Float64Array(2 * nDots), zDots = new Float32Array(nDots * k);
  const dotFit = new Uint8Array(nDots), pointDot = new Int32Array(n);
  const reps = new Array(nDots);
  // Labels were recomputed (the smallest member hash), so the label member
  // is present; its position is the dot's.
  labels.forEach((label, d) => {
    const members = groups.get(label);
    const rep = idxOf.has(label) ? label : members[0];
    const ri = idxOf.get(rep);
    reps[d] = rep;
    dotXY[2 * d] = mapXY[2 * ri];
    dotXY[2 * d + 1] = mapXY[2 * ri + 1];
    for (let t = 0; t < k; t++) { zDots[d * k + t] = z[ri * k + t]; }
    for (const h of members) {
      const i = idxOf.get(h);
      pointDot[i] = d;
      if (isFit[i]) { dotFit[d] = 1; }
    }
  });

  // Regions (§3.5.5): towns by k-means on the fit set's dots (fresh, or
  // warm Lloyd from the previous towns moved through the refit), every dot
  // to its nearest centre; provinces by genre; keys by matching.
  await enterPhase('regions', nDots);
  const tags = genreTagsOf(reps);
  const styles = reps.map((h) => topStyle(tags.get(h) ?? null));
  const fitDots = [];
  for (let d = 0; d < nDots; d++) { if (dotFit[d]) { fitDots.push(d); } }
  const fitXY = gatherXY(dotXY, fitDots);
  const warm = spec.regionStart.kind === 'warm' && spec.regionStart.townCentres.length >= 2 ? spec.regionStart : null;
  let centres;
  if (warm) {
    const K1 = townCount(fitDots.length);
    centres = lloyd(fitXY, resizeCentres(warm.townCentres, K1, fitXY)).centres;
  } else {
    centres = kmeansPP(fitXY, townCount(fitDots.length, { small: method === 'pca2' })).centres;
  }
  const towns = compactClusters(assignNearest(dotXY, centres), centres);
  const nextKey = Number(getMeta('map_next_key') ?? 0) || 0;
  const reg = buildRegions({
    xy: dotXY, styles, members: labels.map((l) => groups.get(l)), townAssign: towns.assign,
    townCentres: towns.centres, previous: spec.previousRegions, provinceCentres: warm?.provinceCentres ?? null, nextKey,
  });
  const nProvinces = reg.provinces.length, nTowns = reg.towns.length;
  const c0 = centrality(zDots, k, reg.region0, nProvinces);
  const c1 = centrality(zDots, k, reg.region1, nTowns);
  const mixOf = (region, central) => JSON.stringify(Array.from(regionMix(region.dots, zDots, k, central, { max: MIX_MAX }), (d) => labels[d]));

  await enterPhase('land', nProvinces);
  const land = buildLand({ xy: dotXY, province: reg.region0, nProvinces, sigma: landSigma(nDots) });
  const hues = assignHues(reg.provinces.map((p) => ({ id: p.id, size: p.size, prevHue: p.prevHue })),
    landAdjacency(land.field, land.levels.coast));

  // Write (§3.4.4 step 10): invisible while 'building' and while no pointer
  // names it; every transaction BEGIN IMMEDIATE with its re-check inside.
  await enterPhase('write', n);
  const now = Date.now();
  const layoutId = Number(ddb.prepare(`
    INSERT INTO map_layouts (state, model_id, model_version, method, params, dim, k, pca_mean, pca_axes, affine,
                             frame, aspect, land_levels, n_fit, n_points, dirty, created_at, fitted_at, placed_at)
    VALUES ('building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(cfg.model, layout.modelVersion, method, JSON.stringify(layout.params), layout.dim, k, layout.pcaMean,
    layout.pcaAxes, JSON.stringify(layout.affine), layout.frame, layout.aspect, JSON.stringify(land.levels),
    layout.nFit, n, now, now, layout.placed > 0 ? now : null).lastInsertRowid);
  const insPoint = ddb.prepare(`
    INSERT INTO map_points (layout_id, audio_hash, dot, x, y, placed, region0, region1, central0, central1, pca)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let written = 0, writtenFit = 0;
  for (let s = 0; s < n; s += WRITE_CHUNK) {
    const e = Math.min(n, s + WRITE_CHUNK);
    txImmediate(ddb, () => {
      const toCheck = [];
      for (let i = s; i < e; i++) { if (checked[i]) { toCheck.push(hashes[i]); } }
      const present = discoveryHashesPresent(toCheck);
      for (let i = s; i < e; i++) {
        if (checked[i] && !present.has(hashes[i])) { continue; }   // moved or deleted since the inventory
        const d = pointDot[i];
        const kind = method === 'pca2' ? 'pca2' : (isFit[i] ? 'fit' : 'knn');
        insPoint.run(layoutId, hashes[i], labels[d], dotXY[2 * d], dotXY[2 * d + 1], kind,
          reg.region0[d], reg.region1[d], c0[d], c1[d], f32ToBytes(z.subarray(i * k, i * k + k)));
        written++;
        if (kind !== 'knn') { writtenFit++; }
      }
    });
  }
  const insRegion = ddb.prepare(`
    INSERT INTO map_regions (layout_id, level, id, key, parent, label, style, hue, x, y, anchor_x, anchor_y,
                             extent, size, mix, land)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  txImmediate(ddb, () => {
    for (const p of reg.provinces) {
      insRegion.run(layoutId, 0, p.id, p.key, null, p.label, p.style, hues[p.id], p.x, p.y, p.anchorX, p.anchorY,
        p.extent, p.size, mixOf(p, c0), land.land[p.id]);
    }
    for (const t of reg.towns) {
      insRegion.run(layoutId, 1, t.id, t.key, t.parent, t.label, t.style, hues[t.parent], t.x, t.y, t.anchorX,
        t.anchorY, t.extent, t.size, mixOf(t, c1), null);
    }
    reserveMapKeys(reg.nextKey - nextKey, ddb);
  });
  // n_fit as written: the landmarks a later run counts the lost ones against.
  ddb.prepare("UPDATE map_layouts SET state = 'ready', n_points = ?, n_fit = ? WHERE id = ?").run(written, writtenFit, layoutId);

  // Mirror and flip (§3.4.4 steps 11–12).
  await enterPhase('mirror', written);
  checkSchemaGuard('before the mirror');
  const st = reconcileTrackMap(mdb, ddb, layoutId);
  await flipTo(layoutId, st.addedMax);
  return {
    layoutId, method, fitted: spec.stats.fitted, placed: spec.stats.placed, removed: spec.stats.removed,
    dots: nDots, regions: nProvinces + nTowns, nFitTried: spec.stats.nFitTried, hitCap: spec.stats.hitCap,
  };
}

function layoutParams(method, { epochs = null, learningRate = null, warmFrom = null, nFitMax, nU }) {
  const umap = method === 'umap';
  return {
    layoutVersion: MAP_LAYOUT_VERSION,
    nNeighbors: umap ? UMAP_PARAMS.nNeighbors : null,
    minDist: umap ? UMAP_PARAMS.minDist : null,
    seed: umap ? UMAP_PARAMS.seed : null,
    epochs: umap ? epochs : null,
    learningRate: umap ? learningRate : null,
    warmFrom,
    nFitMax,
    runtime,
    // The |U| this layout was fitted for: a fit that hit placeMax places the
    // rest over the next runs, and those stay place runs (decideMapMode).
    nU,
  };
}

function modelVersion() {
  return getMeta('embedding_model_id') === cfg.model ? getMeta('embedding_model_version') : null;
}

// ── rebuild ──────────────────────────────────────────────────────────────────

// A new PCA basis and a cold fit (§3.4.4). Returns null when no current
// vector could be read after all (another dimension throughout), so the
// caller keeps S or empties the map.
async function rebuild({ inv, S }) {
  const dim = inv.dim;
  budget = liveBudget(inv.nEmbedded, dim);
  // What a guard exit before the fit reports: the fit this run is heading for.
  fitTried = Math.min(budget.nFitMax, inv.U.length);
  await enterPhase('pca', inv.U.length);
  // The sample: the ≤ 5,000 lowest hashes of U — uniform, deterministic and
  // barely changing as the library grows.
  const wanted = inv.U.slice(0, PCA_SAMPLE_MAX);
  const sampleVecs = new Map();
  forEachVector(wanted, dim, (h, v) => sampleVecs.set(h, v));
  const sample = wanted.filter((h) => sampleVecs.has(h));
  if (sample.length === 0) { return null; }
  const X = new Float32Array(sample.length * dim);
  sample.forEach((h, i) => X.set(sampleVecs.get(h), i * dim));
  sampleVecs.clear();
  // Projected with the stored f32 form, so a later place run agrees bit
  // for bit.
  const basis = basisF32(randomizedPCA(X, sample.length, dim, { k: pcaComponents(dim, sample.length) }));
  const k = basis.k;

  // Every current vector, streamed in rowid order (sequential I/O; hash
  // order over overflowing 5 KB BLOBs is random I/O on SD cards and NAS
  // disks), projected into its hash-sorted slot.
  const slot = new Map();
  inv.U.forEach((h, i) => slot.set(h, i));
  const zAll = new Float32Array(inv.U.length * k);
  const got = new Uint8Array(inv.U.length);
  const page = ddb.prepare(`
    SELECT rowid AS rid, audio_hash, embedding FROM discovery_tracks NOT INDEXED
     WHERE rowid > ? AND embedding IS NOT NULL AND model_id = ?
     ORDER BY rowid LIMIT ${VECTOR_PAGE}
  `);
  let projected = 0, reported = 0;
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const part = page.all(after, cfg.model);
    for (const r of part) {
      const i = slot.get(r.audio_hash);
      if (i === undefined || got[i] || !r.embedding || r.embedding.byteLength !== 4 * dim) { continue; }
      projectInto(f32FromBytes(r.embedding), 0, basis, zAll, i * k);
      got[i] = 1;
      projected++;
    }
    if (part.length < VECTOR_PAGE) { break; }
    after = part[part.length - 1].rid;
    if (projected - reported >= 10 * VECTOR_PAGE) {
      reported = projected;
      emit({ event: 'mapProgress', phase: 'pca', attempted: projected, total: inv.U.length });
      guardMemory();
      await yieldToLoop();
    }
  }
  slot.clear();
  const keep = [];
  for (let i = 0; i < inv.U.length; i++) { if (got[i]) { keep.push(i); } }
  if (keep.length === 0) { return null; }
  const U = keep.length === inv.U.length ? inv.U : keep.map((i) => inv.U[i]);
  const Z = keep.length === inv.U.length ? zAll : gatherRows(zAll, keep, k);
  const n = U.length;
  const method = mapMethod(n);

  // Fit set (step 3): the min(nFitMax, |U|) lowest hashes — U is sorted, so
  // a prefix. pca2 places everything by PCA.
  const fitCap = budget.nFitMax;
  const nF = method === 'pca2' ? n : Math.min(fitCap, n);
  await enterPhase('fit', nF);
  let fitRaw, fit = null;
  if (method === 'pca2') {
    fitRaw = pca2Raw(Z, k, n);
  } else {
    preFitCheck(nF, inv.nEmbedded, dim);
    if (nF < UMAP_MIN_FIT) { throw new Error(`a UMAP fit needs at least ${UMAP_MIN_FIT} songs, the fit set has ${nF}`); }
    const zF = Z.subarray(0, nF * k);
    fit = await fitUmap(rowsOf(zF, k), pcaInit(zF, k), { ...UMAP_PARAMS, onEpoch: epochReporter() });
    fitRaw = fit.raw;
  }

  // The rest, against the fit set (step 5), capped per run.
  const rest = n - nF;
  const limit = Math.min(rest, placeMax);
  await enterPhase('place', limit);
  const placed = await placeBatches({
    refZ: Z.subarray(0, nF * k), refRaw: fitRaw, refHashes: U, k,
    qZ: Z.subarray(nF * k), qHashes: U.slice(nF, nF + limit), limit,
  });
  const nL = nF + placed.done;
  const hashes = nL === n ? U : U.slice(0, nL);
  const raw = new Float64Array(2 * nL);
  raw.set(fitRaw.subarray(0, 2 * nF));
  raw.set(placed.raw, 2 * nF);
  const z = Z.subarray(0, nL * k);

  // Rotate, flip and fit into [0,1]² (step 6).
  const lay = layoutAffine(raw, { z, k });
  const mapXY = applyAffine(lay.affine, raw);
  const isFit = new Uint8Array(nL);
  isFit.fill(1, 0, nF);

  // Near-duplicate candidates: the fit's kNN graph, placed ↔ landmark pairs
  // from the placement, and placed ↔ placed pairs from a grid over the
  // pre-jitter positions (all pairs, for a pca2 library).
  let pairs;
  if (method === 'pca2') {
    pairs = pcaPairs(hashes, z, k);
  } else {
    pairs = [];
    for (const [i, j] of knnGraphPairs(fit.knnIndices, fit.knnDistances)) { pairs.push([hashes[i], hashes[j]]); }
    for (const p of placed.near) { pairs.push(p); }
    const [sx, sy] = rawSpan(fitRaw);
    for (const [i, j] of gridCandidates(placed.pre, GRID_CELL_SHARE * Math.max(sx, sy), { z: z.subarray(nF * k), k })) {
      pairs.push([hashes[nF + i], hashes[nF + j]]);
    }
  }

  const checked = new Uint8Array(nL).fill(1);
  return finishLayout({
    method, hashes, z, k, dim, mapXY, isFit, checked, pairs,
    previousDots: S ? new Map(inv.P.map((p) => [p.hash, p.dot])) : null,
    previousRegions: S ? previousRegionsOf(loadRegions(S.id), inv.P) : null,
    regionStart: { kind: 'fresh' },
    layout: {
      modelVersion: modelVersion(),
      params: layoutParams(method, { epochs: fit?.epochs ?? null, nFitMax: fitCap, nU: n }),
      dim, pcaMean: f32ToBytes(basis.mean), pcaAxes: f32ToBytes(basis.axes),
      affine: lay.affine, frame: (S?.frame ?? 0) + 1, aspect: lay.aspect, nFit: nF, placed: placed.done,
    },
    stats: { fitted: nF, placed: placed.done, removed: S ? inv.gone : 0, nFitTried: method === 'umap' ? nF : 0, hitCap: nL < n },
  });
}

// ── refit ────────────────────────────────────────────────────────────────────

// A warm UMAP over the capped fit set, under the same basis and keys
// (§3.4.4 steps 4–6): F members with a point start from their RAW
// position (the inverse affine of the stored map position), the rest from
// a kNN placement against S's fit set; the result is Procrustes-aligned
// onto the previous raw positions. S's other points follow the landmark
// displacement field; new songs are placed against the new fit set.
async function refit({ inv, S }) {
  const k = S.k, dim = S.dim;
  const basis = basisOf(S);
  const invA = invertAffine(S.affine);
  budget = liveBudget(inv.nEmbedded, dim);
  const fitCap = Math.min(budget.nFitMax, Number.isInteger(S.params.nFitMax) ? S.params.nFitMax : Infinity);
  fitTried = Math.min(fitCap, inv.U.length);
  const { pts, z: zS } = loadPoints(S.id, k);
  const sIdx = new Map();
  pts.forEach((p, i) => sIdx.set(p.hash, i));
  const sRaw = applyAffine(invA, pointsXY(pts));

  const F = inv.U.slice(0, Math.min(fitCap, inv.U.length));
  const Fset = new Set(F);
  const fNew = F.filter((h) => !sIdx.has(h));
  const newRest = inv.newHashes.filter((h) => !Fset.has(h));
  const restWanted = newRest.slice(0, placeMax);
  await enterPhase('pca', fNew.length + restWanted.length);
  const pf = projectHashes(fNew, basis);
  const pr = projectHashes(restWanted, basis);

  // S's fit set: the reference for the new F members' start positions.
  // decideMapMode refits before the landmarks run out (gone ones still
  // anchor here); a layout with none at all starts them from every point of
  // S instead of failing the pass.
  const sFit = [];
  pts.forEach((p, i) => { if (p.placed === 'fit') { sFit.push(i); } });
  if (sFit.length === 0) { for (let i = 0; i < pts.length; i++) { sFit.push(i); } }
  const sRefZ = gatherRows(zS, sFit, k), sRefRaw = gatherXY(sRaw, sFit);
  const startNew = pf.hashes.length
    ? knnPlace({ refZ: sRefZ, refRaw: sRefRaw, k, queryZ: pf.z, hashes: pf.hashes, span: rawSpan(sRefRaw), neighbours: KNN_PLACE_K }).raw
    : new Float64Array(0);

  // The fit rows, in hash order (F is sorted; pf keeps its order).
  const fHashes = [];
  const fZ = new Float32Array(F.length * k), init = new Float64Array(2 * F.length);
  const hadPoint = [];   // fit-row indices with a point in S
  let pi = 0;
  for (const h of F) {
    const si = sIdx.get(h);
    const row = fHashes.length;
    if (si !== undefined) {
      fZ.set(zS.subarray(si * k, si * k + k), row * k);
      init[2 * row] = sRaw[2 * si];
      init[2 * row + 1] = sRaw[2 * si + 1];
      hadPoint.push(row);
    } else if (pi < pf.hashes.length && pf.hashes[pi] === h) {
      fZ.set(pf.z.subarray(pi * k, pi * k + k), row * k);
      init[2 * row] = startNew[2 * pi];
      init[2 * row + 1] = startNew[2 * pi + 1];
      pi++;
    } else {
      continue;   // no readable vector
    }
    fHashes.push(h);
  }
  const nFit = fHashes.length;
  const zF = fZ.subarray(0, nFit * k);
  await enterPhase('fit', nFit);
  preFitCheck(nFit, inv.nEmbedded, dim);
  if (nFit < UMAP_MIN_FIT) { throw new Error(`a UMAP fit needs at least ${UMAP_MIN_FIT} songs, the fit set has ${nFit}`); }
  const fit = await fitUmap(rowsOf(zF, k), init.subarray(0, 2 * nFit), { ...UMAP_PARAMS, ...UMAP_REFIT, onEpoch: epochReporter() });
  const oldL = gatherXY(init, hadPoint);
  const T = procrustes(oldL, gatherXY(fit.raw, hadPoint));
  const rawF = applySimilarity(T, fit.raw);
  const newL = gatherXY(rawF, hadPoint);

  // S's songs outside the new fit set: the displacement field, no re-placement.
  const kept = [];
  let removed = 0;
  pts.forEach((p, i) => {
    if (!inv.L.has(p.hash)) { removed++; return; }
    if (!Fset.has(p.hash)) { kept.push(i); }
  });
  const keptRaw = displacementField({ oldL, newL, points: gatherXY(sRaw, kept) });

  await enterPhase('place', pr.hashes.length);
  const placed = await placeBatches({
    refZ: zF, refRaw: rawF, refHashes: fHashes, k, qZ: pr.z, qHashes: pr.hashes, limit: pr.hashes.length,
  });

  // Every point, sorted by hash.
  const nAll = nFit + kept.length + placed.done;
  const allHash = new Array(nAll);
  const allZ = new Float32Array(nAll * k), allRaw = new Float64Array(2 * nAll), allGrid = new Float64Array(2 * nAll);
  const allFit = new Uint8Array(nAll), allNew = new Uint8Array(nAll), allChecked = new Uint8Array(nAll);
  let o = 0;
  const put = (h, zSrc, zi, x, y, gx, gy, isFit, isNew, isChecked) => {
    allHash[o] = h;
    for (let t = 0; t < k; t++) { allZ[o * k + t] = zSrc[zi * k + t]; }
    allRaw[2 * o] = x; allRaw[2 * o + 1] = y;
    allGrid[2 * o] = gx; allGrid[2 * o + 1] = gy;
    allFit[o] = isFit; allNew[o] = isNew; allChecked[o] = isChecked;
    o++;
  };
  for (let r = 0; r < nFit; r++) {
    const isNew = sIdx.has(fHashes[r]) ? 0 : 1;
    put(fHashes[r], zF, r, rawF[2 * r], rawF[2 * r + 1], rawF[2 * r], rawF[2 * r + 1], 1, isNew, 1);
  }
  kept.forEach((si, j) => put(pts[si].hash, zS, si, keptRaw[2 * j], keptRaw[2 * j + 1], keptRaw[2 * j], keptRaw[2 * j + 1], 0, 0, 0));
  for (let q = 0; q < placed.done; q++) {
    put(pr.hashes[q], pr.z, q, placed.raw[2 * q], placed.raw[2 * q + 1], placed.pre[2 * q], placed.pre[2 * q + 1], 0, 1, 1);
  }
  const order = Array.from({ length: nAll }, (_, i) => i).sort((a, b) => compareHash(allHash[a], allHash[b]));
  const hashes = order.map((i) => allHash[i]);
  const z = gatherRows(allZ, order, k);
  const raw = gatherXY(allRaw, order), gridXY = gatherXY(allGrid, order);
  const isFit = Uint8Array.from(order, (i) => allFit[i]);
  const isNew = Uint8Array.from(order, (i) => allNew[i]);
  const checked = Uint8Array.from(order, (i) => allChecked[i]);

  // Keep the stored affine; re-box only when > 1 % fall outside the pad.
  let affine = S.affine, aspect = S.aspect, frame = S.frame;
  let mapXY = applyAffine(affine, raw);
  if (needsBoxRefit(mapXY)) {
    ({ affine, aspect } = refitAffine(affine, mapXY));
    frame += 1;
    mapXY = applyAffine(affine, raw);
  }

  // Candidates: the fit's graph, placed ↔ landmark, and a grid over every
  // point (fitted positions, displaced ones, pre-jitter placements) for the
  // pairs that involve a song new to this layout. Old groups seed the union.
  const pairs = [];
  for (const [i, j] of knnGraphPairs(fit.knnIndices, fit.knnDistances)) { pairs.push([fHashes[i], fHashes[j]]); }
  for (const p of placed.near) { pairs.push(p); }
  const [sx, sy] = rawSpan(rawF);
  for (const [i, j] of gridCandidates(gridXY, GRID_CELL_SHARE * Math.max(sx, sy), { z, k })) {
    if (isNew[i] || isNew[j]) { pairs.push([hashes[i], hashes[j]]); }
  }

  // Warm towns: the previous centres moved through the refit (in raw
  // frame, so a re-box is exact), then Lloyd. Unlabelled provinces warm the
  // same way.
  const sRegions = loadRegions(S.id);
  const moveCentres = (rows) => {
    const xy = new Float64Array(2 * rows.length);
    rows.forEach((r, j) => { xy[2 * j] = r.x; xy[2 * j + 1] = r.y; });
    return applyAffine(affine, displacementField({ oldL, newL, points: applyAffine(invA, xy) }));
  };
  const sTowns = sRegions.filter((r) => r.level === 1);
  const sProvinces = sRegions.filter((r) => r.level === 0);
  const unlabelled = sProvinces.length > 0 && sProvinces.every((r) => typeof r.key === 'string' && r.key.startsWith('c:'));

  return finishLayout({
    method: 'umap', hashes, z, k, dim, mapXY, isFit, checked, pairs,
    previousDots: new Map(pts.map((p) => [p.hash, p.dot])),
    previousRegions: previousRegionsOf(sRegions, pts),
    regionStart: { kind: 'warm', townCentres: moveCentres(sTowns), provinceCentres: unlabelled ? moveCentres(sProvinces) : null },
    layout: {
      modelVersion: S.model_version ?? modelVersion(),
      params: layoutParams('umap', {
        epochs: fit.epochs, learningRate: UMAP_REFIT.learningRate, warmFrom: S.id, nFitMax: fitCap, nU: inv.U.length,
      }),
      dim, pcaMean: S.pca_mean, pcaAxes: S.pca_axes, affine, frame, aspect, nFit, placed: placed.done,
    },
    stats: {
      fitted: nFit, placed: placed.done, removed, nFitTried: nFit,
      hitCap: newRest.length > restWanted.length || placed.done < pr.hashes.length,
    },
  });
}

// ── place ────────────────────────────────────────────────────────────────────

// An order-dependent fold over a region's dots (label order) and their
// representative members: equal when the dots and the rows they bring are.
function regionSignatures(labels, reps, region, nRegions) {
  const sig = new Uint32Array(nRegions), count = new Int32Array(nRegions);
  for (let d = 0; d < labels.length; d++) {
    const r = region[d];
    if (r < 0 || r >= nRegions) { continue; }
    sig[r] = (Math.imul(sig[r] ^ hashSeed32(labels[d]), 0x01000193) ^ hashSeed32(reps[d])) >>> 0;
    count[r]++;
  }
  return { sig, count };
}

// The dots of a set of points: labels (sorted), each dot's members, its
// representative (the label member when present, else the smallest), and
// its regions from any member (they all carry the dot's).
function dotsOfPoints(points) {
  const byDot = new Map();
  for (const p of points) {
    if (!byDot.has(p.dot)) { byDot.set(p.dot, []); }
    byDot.get(p.dot).push(p);
  }
  const labels = Array.from(byDot.keys()).sort(compareHash);
  const reps = [], r0 = [], r1 = [];
  for (const label of labels) {
    const members = byDot.get(label);
    let rep = members[0].hash;
    for (const m of members) { if (m.hash === label) { rep = label; break; } if (m.hash < rep) { rep = m.hash; } }
    reps.push(rep);
    r0.push(members[0].r0);
    r1.push(members[0].r1);
  }
  return { labels, reps, r0, r1 };
}

// kNN-place up to placeMax new songs against S's fit set, prune songs that
// left the library, and recompute what changed, in S (§3.4.4). Point
// chunks go first with dirty = 1; one transaction then writes the regions,
// clears dirty and bumps map_version. A crash in between leaves dirty = 1,
// and the next run recomputes regions and land from the points.
async function place({ inv, S, adopted }) {
  const k = S.k, dim = S.dim;
  const basis = basisOf(S);
  const A = S.affine, invA = invertAffine(A);
  budget = liveBudget(inv.nEmbedded, dim);
  fitTried = S.n_fit;   // what the guard reports: the fit set this run holds
  const { pts, z: zS } = loadPoints(S.id, k);
  const regionRows = loadRegions(S.id);
  const provinceRows = regionRows.filter((r) => r.level === 0);
  const townRows = regionRows.filter((r) => r.level === 1);
  const nProvinces = provinceRows.length, nTowns = townRows.length;
  const townCentres = new Float64Array(2 * nTowns);
  const townParent = new Int32Array(nTowns);
  townRows.forEach((t, j) => { townCentres[2 * j] = t.x; townCentres[2 * j + 1] = t.y; townParent[j] = t.parent; });

  // The reference set: S's fit set, every landmark (one whose song left
  // still anchors the geometry this run). decideMapMode refits before the
  // landmarks run out; a layout with none at all places against every point
  // instead of failing the pass.
  const sRaw = applyAffine(invA, pointsXY(pts));
  const fitIdx = [];
  pts.forEach((p, i) => { if (p.placed === 'fit') { fitIdx.push(i); } });
  if (fitIdx.length === 0) { for (let i = 0; i < pts.length; i++) { fitIdx.push(i); } }
  const refZ = gatherRows(zS, fitIdx, k), refRaw = gatherXY(sRaw, fitIdx);
  const refHashes = fitIdx.map((i) => pts[i].hash);

  const wanted = inv.newHashes.slice(0, placeMax);
  await enterPhase('pca', wanted.length);
  const q = projectHashes(wanted, basis);
  await enterPhase('place', q.hashes.length);
  const placed = await placeBatches({ refZ, refRaw, refHashes, k, qZ: q.z, qHashes: q.hashes, limit: q.hashes.length });
  const nNew = placed.done;
  const newHashes = q.hashes.slice(0, nNew);
  const newXY = applyAffine(A, placed.raw);
  const hitCap = inv.newHashes.length > wanted.length || nNew < q.hashes.length;

  const keptIdx = [], goneIdx = [];
  pts.forEach((p, i) => (inv.L.has(p.hash) ? keptIdx : goneIdx).push(i));
  const keptByHash = new Map();
  for (const i of keptIdx) { keptByHash.set(pts[i].hash, i); }
  const newAt = new Map();
  newHashes.forEach((h, j) => newAt.set(h, j));

  // Near-duplicates: existing groups keep their labels. Candidates are the
  // placed ↔ landmark pairs and a grid over the new songs' pre-jitter
  // positions plus the existing points near them.
  const [sx, sy] = rawSpan(refRaw);
  const cell = GRID_CELL_SHARE * Math.max(sx, sy) || 1;
  const pairs = placed.near.slice();
  if (nNew > 0) {
    const near = new Set();
    const cellKey = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (let j = 0; j < nNew; j++) {
      const cx = Math.floor(placed.pre[2 * j] / cell), cy = Math.floor(placed.pre[2 * j + 1] / cell);
      for (let dx = -2; dx <= 2; dx++) { for (let dy = -2; dy <= 2; dy++) { near.add(`${cx + dx},${cy + dy}`); } }
    }
    const nearKept = keptIdx.filter((i) => near.has(cellKey(sRaw[2 * i], sRaw[2 * i + 1])));
    const gridXY = new Float64Array(2 * (nNew + nearKept.length));
    gridXY.set(placed.pre);
    gridXY.set(gatherXY(sRaw, nearKept), 2 * nNew);
    const gridZ = new Float32Array((nNew + nearKept.length) * k);
    gridZ.set(q.z.subarray(0, nNew * k));
    gridZ.set(gatherRows(zS, nearKept, k), nNew * k);
    const gridHash = newHashes.concat(nearKept.map((i) => pts[i].hash));
    for (const [i, j] of gridCandidates(gridXY, cell, { z: gridZ, k })) {
      if (i < nNew || j < nNew) { pairs.push([gridHash[i], gridHash[j]]); }
    }
  }
  const hashesAll = keptIdx.map((i) => pts[i].hash).concat(newHashes);
  const previous = new Map(keptIdx.map((i) => [pts[i].hash, pts[i].dot]));
  const dotOf = groupDots(pairs, previous, hashesAll, { keepLabels: true, dim });
  const groups = groupsOf(dotOf);
  const labels = Array.from(groups.keys());
  const nDots = labels.length;

  // Each dot's values: a group with existing members keeps the values its
  // label carried (merged groups take the smaller label's); a group of new
  // songs takes its label member's placement and joins the nearest town.
  const dotXY = new Float64Array(2 * nDots), zDots = new Float32Array(nDots * k);
  const dotR0 = new Uint8Array(nDots), dotR1 = new Uint8Array(nDots);
  const reps = new Array(nDots);
  const freshDots = [];
  labels.forEach((label, d) => {
    const members = groups.get(label);
    let src = -1, firstKept = -1;
    for (const h of members) {
      const i = keptByHash.get(h);
      if (i === undefined) { continue; }
      if (firstKept < 0) { firstKept = i; }
      if (pts[i].dot === label) { src = i; break; }
    }
    if (src < 0) { src = firstKept; }
    if (src >= 0) {
      dotXY[2 * d] = pts[src].x;
      dotXY[2 * d + 1] = pts[src].y;
      dotR0[d] = pts[src].r0;
      dotR1[d] = pts[src].r1;
    } else {
      const j = newAt.get(label) ?? newAt.get(members[0]);
      dotXY[2 * d] = newXY[2 * j];
      dotXY[2 * d + 1] = newXY[2 * j + 1];
      freshDots.push(d);
    }
    const rep = members.includes(label) ? label : members[0];
    reps[d] = rep;
    const ki = keptByHash.get(rep);
    const zSrc = ki !== undefined ? zS : q.z, zi = ki !== undefined ? ki : newAt.get(rep);
    for (let t = 0; t < k; t++) { zDots[d * k + t] = zSrc[zi * k + t]; }
  });
  if (freshDots.length) {
    const at = assignToTowns(gatherXY(dotXY, freshDots), townCentres, townParent);
    freshDots.forEach((d, j) => { dotR0[d] = at.region0[j]; dotR1[d] = at.region1[j]; });
  }
  const c0 = centrality(zDots, k, dotR0, nProvinces);
  const c1 = centrality(zDots, k, dotR1, nTowns);
  const dotIndex = new Map();
  labels.forEach((l, d) => dotIndex.set(l, d));

  // Which regions changed (their dots, or the rows those bring), and
  // whether the land must be redrawn (a dot added or removed).
  const old = dotsOfPoints(pts);
  const oldSig0 = regionSignatures(old.labels, old.reps, old.r0, nProvinces);
  const oldSig1 = regionSignatures(old.labels, old.reps, old.r1, nTowns);
  const newSig0 = regionSignatures(labels, reps, dotR0, nProvinces);
  const newSig1 = regionSignatures(labels, reps, dotR1, nTowns);
  const changed = (a, b, r) => !!S.dirty || a.sig[r] !== b.sig[r] || a.count[r] !== b.count[r];
  const oldLabels = new Set(old.labels);
  let dotsAddedOrRemoved = labels.length !== old.labels.length;
  for (let d = 0; d < nDots && !dotsAddedOrRemoved; d++) { if (!oldLabels.has(labels[d])) { dotsAddedOrRemoved = true; } }

  // Point operations: inserts, updates of changed values, deletes.
  const ops = [];
  for (const i of keptIdx) {
    const p = pts[i];
    const d = dotIndex.get(dotOf.get(p.hash));
    const x = dotXY[2 * d], y = dotXY[2 * d + 1];
    if (p.dot !== labels[d] || p.x !== x || p.y !== y || p.r0 !== dotR0[d] || p.r1 !== dotR1[d]
        || p.c0 !== c0[d] || p.c1 !== c1[d]) {
      ops.push({ kind: 'update', id: p.id, d });
    }
  }
  for (let j = 0; j < nNew; j++) { ops.push({ kind: 'insert', j, d: dotIndex.get(dotOf.get(newHashes[j])) }); }
  for (const i of goneIdx) { ops.push({ kind: 'delete', id: pts[i].id, hash: pts[i].hash }); }

  await enterPhase('write', ops.length);
  const setDirty = ddb.prepare('UPDATE map_layouts SET dirty = 1 WHERE id = ?');
  const upd = ddb.prepare(
    'UPDATE map_points SET dot = ?, x = ?, y = ?, region0 = ?, region1 = ?, central0 = ?, central1 = ? WHERE id = ?');
  const ins = ddb.prepare(`
    INSERT INTO map_points (layout_id, audio_hash, dot, x, y, placed, region0, region1, central0, central1, pca)
    VALUES (?, ?, ?, ?, ?, 'knn', ?, ?, ?, ?, ?)
  `);
  // By id AND the hash the inventory read: a row the hash-transition applier
  // re-keyed since then (to a song still in the library) is never pruned.
  // The queue keeps the applier and a map worker apart; this is the backstop.
  const del = ddb.prepare('DELETE FROM map_points WHERE id = ? AND audio_hash = ?');
  // A planned insert or prune that does not happen leaves the regions below
  // counting a dot the points do not have, or missing one they do: dirty
  // then stays 1, and the next run (a place run, for dirty) recomputes
  // regions and land from the points.
  let removed = 0, inserted = 0, keptRows = keptIdx.length, dirtySet = !!S.dirty, regionsStale = false;
  for (let s = 0; s < ops.length; s += WRITE_CHUNK) {
    const chunk = ops.slice(s, s + WRITE_CHUNK);
    // A gone song is still absent from tracks: probed right before the
    // transaction (mstream.db), the new hashes' rows inside it.
    const stillGone = new Set();
    for (const op of chunk) { if (op.kind === 'delete' && !trackHasHash(op.hash)) { stillGone.add(op.id); } }
    txImmediate(ddb, () => {
      if (!dirtySet) { setDirty.run(S.id); dirtySet = true; }
      const present = discoveryHashesPresent(chunk.filter((op) => op.kind === 'insert').map((op) => newHashes[op.j]));
      for (const op of chunk) {
        const d = op.d;
        if (op.kind === 'update') {
          upd.run(labels[d], dotXY[2 * d], dotXY[2 * d + 1], dotR0[d], dotR1[d], c0[d], c1[d], op.id);
        } else if (op.kind === 'insert') {
          const h = newHashes[op.j];
          if (!present.has(h)) { regionsStale = true; continue; }
          ins.run(S.id, h, labels[d], dotXY[2 * d], dotXY[2 * d + 1], dotR0[d], dotR1[d], c0[d], c1[d],
            f32ToBytes(q.z.subarray(op.j * k, op.j * k + k)));
          inserted++;
        } else if (stillGone.has(op.id)) {
          const n = del.run(op.id, op.hash).changes;
          removed += n;
          if (n === 0) { keptRows++; regionsStale = true; }   // re-keyed since the inventory: it lives on under its new hash
        } else {
          keptRows++;   // back in the library since the inventory: its point stays
          regionsStale = true;
        }
      }
    });
  }

  // Regions: sizes, centroids, anchors and extents from the dots; the mixes
  // of the regions that changed; land when a dot came or went (or dirty).
  await enterPhase('regions', nDots);
  const geo = refreshRegionGeometry({ xy: dotXY, region0: dotR0, region1: dotR1, nProvinces, nTowns, townCentres, townParent });
  const mixFor = (row, g, central, isChanged) => (isChanged
    ? JSON.stringify(Array.from(regionMix(g.dots, zDots, k, central, { max: MIX_MAX }), (d) => labels[d]))
    : row.mix);
  await enterPhase('land', nProvinces);
  const land = dotsAddedOrRemoved || S.dirty
    ? buildLand({ xy: dotXY, province: dotR0, nProvinces, sigma: landSigma(nDots) })
    : null;

  await enterPhase('write', nProvinces + nTowns);
  const updProvince = ddb.prepare(`
    UPDATE map_regions SET size = ?, x = ?, y = ?, anchor_x = ?, anchor_y = ?, extent = ?, mix = ?, land = ?
     WHERE layout_id = ? AND level = 0 AND id = ?
  `);
  const updProvinceKeepLand = ddb.prepare(`
    UPDATE map_regions SET size = ?, x = ?, y = ?, anchor_x = ?, anchor_y = ?, extent = ?, mix = ?
     WHERE layout_id = ? AND level = 0 AND id = ?
  `);
  const updTown = ddb.prepare(`
    UPDATE map_regions SET size = ?, anchor_x = ?, anchor_y = ?, extent = ?, mix = ?
     WHERE layout_id = ? AND level = 1 AND id = ?
  `);
  const now = Date.now();
  txImmediate(ddb, () => {
    // Region ids are 0..n-1 per level (buildRegions), so row.id indexes
    // the geometry, the signatures and the land.
    for (const row of provinceRows) {
      const p = row.id, g = geo.provinces[p];
      const vals = [g.size, g.x ?? row.x, g.y ?? row.y, g.anchorX ?? row.anchor_x, g.anchorY ?? row.anchor_y,
        g.extent, mixFor(row, g, c0, changed(oldSig0, newSig0, p))];
      if (land) { updProvince.run(...vals, land.land[p], S.id, p); } else { updProvinceKeepLand.run(...vals, S.id, p); }
    }
    for (const row of townRows) {
      const t = row.id, g = geo.towns[t];
      updTown.run(g.size, g.anchorX ?? row.anchor_x, g.anchorY ?? row.anchor_y, g.extent,
        mixFor(row, g, c1, changed(oldSig1, newSig1, t)), S.id, t);
    }
    ddb.prepare(`
      UPDATE map_layouts SET placed_at = COALESCE(?, placed_at), n_points = ?, land_levels = COALESCE(?, land_levels), dirty = ?
       WHERE id = ?
    `).run(inserted > 0 ? now : null, keptRows + inserted, land ? JSON.stringify(land.levels) : null, regionsStale ? 1 : 0, S.id);
    bumpMapVersion(ddb);
  });

  await enterPhase('mirror', keptRows + inserted);
  checkSchemaGuard('before the mirror');
  const st = reconcileTrackMap(mdb, ddb, S.id);
  if (adopted) { await flipTo(S.id, st.addedMax); }
  return {
    layoutId: S.id, method: S.method, fitted: 0, placed: inserted, removed, dots: nDots,
    regions: nProvinces + nTowns, nFitTried: 0, hitCap,
  };
}

// ── mirror and empty ─────────────────────────────────────────────────────────

// Reconcile S's generation only (§3.4.2): nothing changed, or a model
// switch is pending and S keeps serving.
async function mirror({ inv, S, adopted }) {
  await enterPhase('mirror', inv.P.length);
  checkSchemaGuard('before the mirror');
  const st = reconcileTrackMap(mdb, ddb, S.id);
  if (adopted) { await flipTo(S.id, st.addedMax); }
  const regions = ddb.prepare('SELECT COUNT(*) AS n FROM map_regions WHERE layout_id = ?').get(S.id).n;
  return {
    layoutId: S.id, method: S.method, fitted: 0, placed: 0, removed: 0, dots: inv.nDotsS, regions,
    nFitTried: 0, hitCap: false,
  };
}

// Nothing analysed and no layout with a song in the library: the pointer
// goes NULL (a rev bump), then every mirror generation and every layout.
async function empty({ inv }) {
  await enterPhase('mirror', null);
  checkSchemaGuard('before the mirror');
  clearTrackMapPointer(mdb);
  deleteTrackMapGenerations(mdb);
  await enterPhase('write', null);
  for (const { id } of ddb.prepare('SELECT id FROM map_layouts').all()) { deleteLayout(id); }
  deleteOrphans();
  return {
    layoutId: null, method: null, fitted: 0, placed: 0, removed: inv.P.length, dots: 0, regions: 0,
    nFitTried: 0, hitCap: false,
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const started = Date.now();
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_e) { /* not permitted here */ }

  // mstream.db is a separate connection with the mstream.db worker pragmas
  // (no journal_mode: the server sets it on the header and this inherits
  // it); discovery.db opens through initDiscoveryDb (busy_timeout,
  // migrations, the map tables).
  try {
    mdb = new DatabaseSync(cfg.libraryDbPath);
    mdb.exec('PRAGMA foreign_keys = ON');
    mdb.exec('PRAGMA busy_timeout = 5000');
  } catch (err) {
    throw new WorkerExit(1, { event: 'error', message: `DB open failed: ${err.message}` });
  }
  checkSchemaGuard('at open');
  try {
    ddb = initDiscoveryDb(cfg.discoveryDbPath);
  } catch (err) {
    throw new WorkerExit(1, { event: 'error', message: `DB open failed: ${err.message}` });
  }

  const { S, adopted } = recover();
  await enterPhase('inventory', null);
  const inv = readInventory(S);
  const serving = S ? {
    modelId: S.model_id, method: S.method, dim: S.dim,
    // An unusable affine reads as another layout version: rebuild.
    layoutVersion: S.affine ? S.params.layoutVersion ?? null : null,
    fittedAt: S.fitted_at, dirty: !!S.dirty, nP: inv.P.length, nPinL: inv.nPinL,
    nU: Number.isInteger(S.params.nU) ? S.params.nU : null,
    nFit: S.n_fit, nFitLive: inv.nFitLive,
  } : null;
  const decision = decideMapMode({
    model: cfg.model, dim: inv.dim, nU: inv.U.length, serving, nNew: inv.newHashes.length, nGone: inv.gone,
    settled: cfg.settled, force: cfg.force ?? null, nowMs: modeNowMs,
  });
  const ctx = { inv, S, adopted };
  let result;
  switch (decision.mode) {
    case 'empty': result = await empty(ctx); break;
    case 'mirror': result = await mirror(ctx); break;
    case 'refit': result = await refit(ctx); break;
    case 'place': result = await place(ctx); break;
    default:
      result = await rebuild(ctx);
      if (!result) {   // no readable current vector after all
        decision.mode = S ? 'mirror' : 'empty';
        result = S ? await mirror(ctx) : await empty(ctx);
      }
      break;
  }
  rssNow();
  return {
    event: 'mapComplete', mode: decision.mode, ...result,
    ms: Date.now() - started, peakRssMB: Math.round(peakRss / MiB),
  };
}

try {
  const complete = await run();
  emitThenExit(complete, 0);
} catch (err) {
  if (err instanceof WorkerExit) {
    emitThenExit(err.event, err.code);
  } else if (err instanceof MemoryGuardError) {
    emitThenExit({ event: 'error', message: err.message, nFitTried: err.nFitTried }, MEMORY_GUARD_EXIT);
  } else {
    emitThenExit({ event: 'error', message: err?.message || String(err) }, 1);
  }
}
