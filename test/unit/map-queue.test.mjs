/**
 * The music map's queue wiring (src/db/task-queue.js; docs/music-map-plan.md
 * §3.3).
 *
 *   - mapPayload: never emits null or Infinity (an unset cap and force are
 *     omitted), takes the smaller of the configured and the latched cap,
 *     and its JSON passes the worker's own Joi (the worker is spawned on it
 *     and must get past validation to its schema guard).
 *   - classifyMapExit: exit 5 latches floor(nFitTried / 2) (at least 1,000)
 *     with one retry per boot, a second is a failure; an unexplained kill
 *     latches from the fit size; a deliberate kill does nothing; the
 *     timeout and exit 1 are failures; exit 3 is not counted; three
 *     failures in a row close the latch.
 *   - Through the real queue, in process, with real worker forks: a pass
 *     runs and lands in the status entry the map routes read (lastRun
 *     counts without the layout id); the memory guard (the worker's
 *     MSTREAM_TEST_MAP_FORCE_GUARD seam) retries once with a halved cap,
 *     then counts; three failures latch the pass off ('failing', which the
 *     routes' mapState reads as failed) and nothing enqueues while latched;
 *     the admin entry point clears the latch and rebuilds.
 *   - The hash-transition applier and a map worker never overlap, nor does
 *     a map worker run ahead of a ledger the applier has yet to apply: a
 *     pass dies with a map pass queued behind it while re-keyed files wait
 *     in the ledger — once with a non-enrichment task also queued (it keeps
 *     the drain away), once alone (the close dispatches, then drains). The
 *     applier finishes before any map pass starts, and every re-keyed song
 *     keeps its point: same layout, same position, still a landmark.
 *   - A ledger the applier fails on: every pass waits for an attempt of its
 *     own and runs past only that attempt's failure, so a failing ledger
 *     never holds the map back, and once the cause clears the next pass
 *     waits for the ledger to apply. A pass let past a failure that waits
 *     behind another task is dispatched by that task's close, whose drain
 *     leaves the applier alone until the pass has finished.
 *   - The applier deletes only the ledger rows it read: rows committed while
 *     it runs survive it, and the next apply takes them.
 *   - After a failed apply, a map pass queued behind a real scan still waits
 *     for the ledger that scan wrote (here at its close, with an after-scan
 *     backup dispatching the next task before the close drains); so does the
 *     pass a failed apply would let past, when a scan started after that
 *     attempt.
 *
 * mapState's rows and mapRev live with the routes (test/unit/
 * map-routes.test.mjs). No assertion depends on timing: the waits poll the
 * queue's own state.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import winston from 'winston';

import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { mulberry32 } from '../../src/db/map-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(__dirname, '..', '..', 'src', 'db', 'map-layout.mjs');

let testRoot;
let config;
let dbManager;
let discoveryDb;
let taskQueue;

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-map-queue-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake', analyzeBpm: false, autoAlbumArt: false },
    port: 0,
  }, null, 2));
  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  discoveryDb = await import('../../src/db/discovery-db.js');
  taskQueue = await import('../../src/db/task-queue.js');
});

after(async () => {
  delete process.env.MSTREAM_TEST_MAP_FORCE_GUARD;
  if (taskQueue) { await waitForIdle(); }
  try { discoveryDb?.closeDiscoveryDb(); } catch (_e) { /* not open */ }
  try { dbManager?.close(); } catch (_e) { /* not open */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
  setImmediate(() => process.exit(0));   // module-level timers (manager), like the other queue suites
});

async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return true; }
    await sleep(intervalMs);
  }
  return false;
}

async function waitForIdle() {
  const ok = await waitFor(() => taskQueue.getQueueLength() === 0 && taskQueue.getAdminStats().activeTaskKind === null);
  if (!ok) { throw new Error('the task queue did not drain within 60 s'); }
}

const mapEntry = () => taskQueue.getEnrichmentStatus().find((p) => p.pass === 'map');

// No null, undefined or non-finite number anywhere in a payload.
function assertJsonClean(obj) {
  for (const [key, v] of Object.entries(obj)) {
    assert.notEqual(v, null, `${key} is null`);
    assert.notEqual(v, undefined, `${key} is undefined`);
    if (typeof v === 'number') { assert.ok(Number.isFinite(v), `${key} is ${v}`); }
    assert.ok(!Array.isArray(v), `${key} is an array: the payload carries no vectors or lists`);
  }
}

// ── mapPayload ──────────────────────────────────────────────────────────────

describe('mapPayload', () => {
  const env = { discoveryDbPath: '/d/discovery.db', libraryDbPath: '/d/mstream.db', parentRssBytes: 123456789.4 };
  const opts = (over = {}) => ({ discoveryModel: 'test-fake', ...over });

  test('an unset cap and no force are omitted, never null or Infinity', () => {
    const p = taskQueue.mapPayload(opts(), null, { task: 'map' }, env);
    assert.deepEqual(Object.keys(p).sort(), ['budgetSec', 'discoveryDbPath', 'expectedSchemaVersion', 'libraryDbPath',
      'model', 'parentRssBytes', 'settled']);
    assertJsonClean(p);
    assert.equal(p.model, 'test-fake');
    assert.equal(p.expectedSchemaVersion, SCHEMA_VERSION);
    assert.equal(p.parentRssBytes, 123456789, 'an integer: the worker validates one');
    assert.equal(p.settled, false);
    assert.equal(p.budgetSec, 120);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p, 'the JSON round trip loses nothing');
    assert.doesNotMatch(JSON.stringify(p), /null|Infinity/);
  });

  test('the cap is the smaller of the configured and the latched one; force and settled ride along', () => {
    assert.equal(taskQueue.mapPayload(opts({ mapMaxFitTracks: 5000 }), null, {}, env).maxFitTracks, 5000);
    assert.equal(taskQueue.mapPayload(opts(), 3000, {}, env).maxFitTracks, 3000);
    assert.equal(taskQueue.mapPayload(opts({ mapMaxFitTracks: 5000 }), 3000, {}, env).maxFitTracks, 3000);
    assert.equal(taskQueue.mapPayload(opts({ mapMaxFitTracks: 2000 }), 3000, {}, env).maxFitTracks, 2000);
    const p = taskQueue.mapPayload(opts(), 1000, { force: 'rebuild', settled: true }, env);
    assert.equal(p.force, 'rebuild');
    assert.equal(p.settled, true);
    assertJsonClean(p);
  });

  test('its JSON passes the worker\'s Joi — the worker gets as far as its schema guard', () => {
    const dir = fs.mkdtempSync(path.join(testRoot, 'joi-'));
    const paths = { discoveryDbPath: path.join(dir, 'discovery.db'), libraryDbPath: path.join(dir, 'mstream.db'), parentRssBytes: 1 };
    const spawnWorker = (payload) => spawnSync(process.execPath, [WORKER, JSON.stringify(payload)], { encoding: 'utf8' });
    for (const p of [
      taskQueue.mapPayload(opts(), null, {}, paths),
      taskQueue.mapPayload(opts({ mapMaxFitTracks: 20000 }), 1000, { force: 'rebuild', settled: true }, paths),
    ]) {
      const r = spawnWorker(p);
      assert.doesNotMatch(r.stderr, /Invalid JSON Input/, r.stderr);
      // An empty library file is V0, not the expected schema: exit 3 proves
      // validation passed and the worker opened its databases.
      assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
    }
    // The control: what the payload rule exists to prevent.
    const bad = spawnWorker({ ...taskQueue.mapPayload(opts(), null, {}, paths), maxFitTracks: null });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid JSON Input/);
  });
});

// ── classifyMapExit ─────────────────────────────────────────────────────────

describe('classifyMapExit', () => {
  const classify = (exit, state) => taskQueue.classifyMapExit(exit, state);

  test('a clean exit resets the failure count', () => {
    const v = classify({ code: 0, signal: null }, { retryUsed: true, failures: 2 });
    assert.equal(v.kind, 'completed');
    assert.equal(v.failures, 0);
    assert.equal(v.capLatched, null);
    assert.equal(v.latch, false);
  });

  test('exit 5 latches half the tried fit (never under 1,000) and retries once per boot', () => {
    const first = classify({ code: 5, signal: null, errorEvt: { nFitTried: 6000 } }, { retryUsed: false, failures: 1 });
    assert.deepEqual([first.kind, first.capLatched, first.retry, first.retryUsed, first.failures], ['memory', 3000, true, true, 1],
      'the retry is not a failure');
    const second = classify({ code: 5, signal: null, errorEvt: { nFitTried: 3000 } }, { retryUsed: true, failures: 1 });
    assert.deepEqual([second.kind, second.capLatched, second.retry, second.failures], ['memory', 1500, false, 2],
      'after the retry it counts');
    assert.equal(classify({ code: 5, errorEvt: { nFitTried: 1500 } }).capLatched, 1000, 'the floor');
    assert.equal(classify({ code: 5, errorEvt: { nFitTried: 0 } }).capLatched, 1000);
  });

  test('an unexplained death latches from the fit size; a deliberate kill does nothing', () => {
    const oom = classify({ code: null, signal: 'SIGKILL', fitSize: 4000 });
    assert.deepEqual([oom.kind, oom.capLatched, oom.retry], ['memory', 2000, true], 'the OOM killer');
    assert.equal(classify({ code: null, signal: 'SIGKILL' }).capLatched, 1000, 'no fit size: half of 2,000');
    const win = classify({ code: 0xC0000005, signal: null, fitSize: 8000 });
    assert.deepEqual([win.kind, win.capLatched], ['memory', 4000], 'a Windows NTSTATUS crash');
    const killed = classify({ code: null, signal: 'SIGTERM', killedByUs: true, fitSize: 8000 }, { retryUsed: false, failures: 2 });
    assert.deepEqual([killed.kind, killed.capLatched, killed.retry, killed.failures, killed.latch], ['killed', null, false, 2, false]);
  });

  test('the timeout, exit 1 and a failed start are failures; exit 3 is not counted', () => {
    const t = classify({ code: null, signal: 'SIGTERM', killedByUs: true, timedOut: true }, { failures: 0 });
    assert.deepEqual([t.kind, t.failures, t.capLatched], ['timeout', 1, null]);
    assert.deepEqual([classify({ code: 1 }, { failures: 1 }).kind, classify({ code: 1 }, { failures: 1 }).failures], ['failed', 2]);
    assert.equal(classify({ code: -1 }).kind, 'failed');
    const schema = classify({ code: 3 }, { failures: 2 });
    assert.deepEqual([schema.kind, schema.failures, schema.latch], ['schema', 2, false]);
  });

  test('three failures in a row close the latch; a clean run in between resets', () => {
    let state = { retryUsed: false, failures: 0 };
    const step = (exit) => { const v = classify(exit, state); state = { retryUsed: v.retryUsed, failures: v.failures }; return v; };
    assert.equal(step({ code: 1 }).latch, false);
    assert.equal(step({ code: 1 }).latch, false);
    assert.equal(step({ code: 0 }).failures, 0);
    assert.equal(step({ code: 1 }).latch, false);
    assert.equal(step({ code: null, signal: 'SIGTERM', killedByUs: true, timedOut: true }).latch, false);
    const third = step({ code: 1 });
    assert.equal(third.failures, 3);
    assert.equal(third.latch, true);
  });
});

// ── through the real queue ──────────────────────────────────────────────────

// 80 analysed songs in two genre clusters (64-d, test-fake): enough for a
// UMAP fit (≥ 50), seconds of work.
function seedLibrary(n = 80) {
  const mdb = dbManager.getDB();
  const ddb = discoveryDb.getDiscoveryDb();
  mdb.prepare("INSERT INTO libraries (name, root_path, type) VALUES ('maplib', ?, 'music')").run(path.join(testRoot, 'music'));
  const libId = mdb.prepare("SELECT id FROM libraries WHERE name = 'maplib'").get().id;
  const rand = mulberry32(5);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const centres = [0, 1].map(() => Array.from({ length: 64 }, gauss));
  const insT = mdb.prepare('INSERT INTO tracks (filepath, library_id, title, audio_hash) VALUES (?, ?, ?, ?)');
  const insD = ddb.prepare(`INSERT INTO discovery_tracks (audio_hash, updated_at, export_id, model_id, embedding, genre_tags)
                            VALUES (?, 1, ?, 'test-fake', ?, ?)`);
  for (let i = 0; i < n; i++) {
    const g = i % 2;
    const v = centres[g].map((c) => c + 0.3 * gauss());
    let norm = 0;
    for (const x of v) { norm += x * x; }
    const f = Float32Array.from(v, (x) => x / Math.sqrt(norm));
    const h = i.toString(16).padStart(32, 'a');
    insT.run(`song-${i}.mp3`, libId, `Song ${i}`, h);
    insD.run(h, `anon:${h}`, new Uint8Array(f.buffer), JSON.stringify([g ? 'Jazz---Hard Bop' : 'Rock---Indie Rock']));
  }
}

describe('through the real queue', () => {
  before(async () => {
    discoveryDb.initDiscoveryDb();
    const fresh = mapEntry();
    assert.deepEqual([fresh.enabled, fresh.disabledReason, fresh.state, fresh.lastRun], [true, null, 'idle', null]);
    // A forced pass on the empty library: the worker answers 'empty'. Its
    // close is also this process's first drain (bootModelSyncPending),
    // whose own map enqueue finds nothing mapped or mappable and forks
    // nothing — so the passes below run alone.
    taskQueue.requestMapRebuild();
    await waitForIdle();
    assert.equal(mapEntry().lastRun.counts.mode, 'empty');
    seedLibrary();
  });

  test('a pass runs, mirrors the layout and lands in the status entry the routes read', async () => {
    const idle = mapEntry();
    assert.deepEqual([idle.enabled, idle.disabledReason, idle.state, idle.lastRun.outcome], [true, null, 'idle', 'completed']);
    taskQueue.maybeEnqueueMap('test');
    assert.ok(['queued', 'running'].includes(mapEntry().state), 'enqueued at once: the queue was idle');
    await waitForIdle();
    const e = mapEntry();
    assert.equal(e.state, 'idle');
    assert.equal(e.lastRun.outcome, 'completed', JSON.stringify(e.lastRun));
    assert.equal(typeof e.lastRun.finishedAt, 'number');
    assert.equal(e.lastRun.hitCap, false);
    assert.deepEqual(Object.keys(e.lastRun.counts).sort(),
      ['dots', 'fitted', 'method', 'mode', 'ms', 'peakRssMB', 'placed', 'regions', 'removed'],
      'the plan\'s counts: no layout id, no fit attempt');
    assert.deepEqual([e.lastRun.counts.mode, e.lastRun.counts.method, e.lastRun.counts.fitted], ['rebuild', 'umap', 80]);
    const mdb = dbManager.getDB();
    const pointer = mdb.prepare('SELECT active_layout, map_epoch FROM track_map_meta WHERE id = 1').get();
    assert.ok(pointer.active_layout > 0);
    assert.equal(pointer.map_epoch, discoveryDb.getMeta('map_epoch'));
    assert.equal(mdb.prepare('SELECT COUNT(*) AS n FROM track_map WHERE layout_id = ?').get(pointer.active_layout).n, 80);
    assert.equal(fs.existsSync(path.join(testRoot, 'db', '.scanner.pid.json')), false, 'the reaper pidfile is cleared');
    // Nothing changed: an unforced pass only mirrors.
    taskQueue.maybeEnqueueMap('test again');
    await waitForIdle();
    assert.equal(mapEntry().lastRun.counts.mode, 'mirror');
  });

  test('the memory guard retries once with a halved cap, then counts; three failures latch the pass off', async () => {
    process.env.MSTREAM_TEST_MAP_FORCE_GUARD = '1';   // the forked worker inherits the environment
    try {
      taskQueue.maybeEnqueueMap('guard 1', { force: 'rebuild' });
      await waitForIdle();
      // The guard exit and the automatic retry both ran (the retry kept
      // the force); the retry's exit is failure 1.
      assert.equal(mapEntry().lastRun.outcome, 'failed');
      assert.equal(mapEntry().enabled, true, 'one failure does not latch');
      taskQueue.maybeEnqueueMap('guard 2', { force: 'rebuild' });
      await waitForIdle();
      assert.equal(mapEntry().enabled, true, 'two failures do not latch');
      taskQueue.maybeEnqueueMap('guard 3', { force: 'rebuild' });
      await waitForIdle();
      const latched = mapEntry();
      assert.deepEqual([latched.enabled, latched.disabledReason, latched.state], [false, 'failing', 'disabled']);
      assert.equal(latched.lastRun.outcome, 'failed');
      // The routes read exactly this entry (discovery-map.js mapState).
      const { mapState } = await import('../../src/api/discovery-map.js');
      assert.equal(mapState({ serving: false, vectors: true, map: latched }), 'failed');
      assert.equal(mapState({ serving: true, vectors: true, map: latched }), 'ready', 'a layout still serving keeps serving');
      // Latched: nothing enqueues.
      taskQueue.maybeEnqueueMap('while latched', { force: 'rebuild' });
      assert.equal(taskQueue.getQueueLength(), 0);
      assert.equal(taskQueue.getAdminStats().activeTaskKind, null);
    } finally {
      delete process.env.MSTREAM_TEST_MAP_FORCE_GUARD;
    }
    // The admin rebuild clears the latch and rebuilds.
    taskQueue.requestMapRebuild();
    assert.equal(mapEntry().enabled, true);
    await waitForIdle();
    const e = mapEntry();
    assert.deepEqual([e.enabled, e.disabledReason, e.lastRun.outcome, e.lastRun.counts.mode], [true, null, 'completed', 'rebuild']);
  });

  test('the switch and collection gate the enqueue; another model still reconciles the map', async () => {
    const opts = config.program.scanOptions;
    const lastFinished = mapEntry().lastRun.finishedAt;
    try {
      opts.musicMap = false;
      taskQueue.maybeEnqueueMap('switched off');
      taskQueue.requestMapRebuild();
      assert.equal(taskQueue.getQueueLength(), 0);
      opts.musicMap = true;
      opts.collectDiscoveryData = false;
      taskQueue.maybeEnqueueMap('collection off');
      assert.equal(taskQueue.getQueueLength(), 0);
      opts.collectDiscoveryData = true;
      // Another model: no vector of it, but the map still has rows — one
      // pass may run to reconcile (here a switch-pending mirror).
      opts.discoveryModel = 'another-model';
      taskQueue.maybeEnqueueMap('another model');
      await waitForIdle();
      assert.equal(mapEntry().lastRun.counts.mode, 'mirror', 'the old layout keeps serving');
    } finally {
      opts.musicMap = true;
      opts.collectDiscoveryData = true;
      opts.discoveryModel = 'test-fake';
    }
    assert.notEqual(mapEntry().lastRun.finishedAt, lastFinished);
  });

  // What a scan leaves for its drain when files re-key: the tracks carry the
  // new hash, the ledger says old → new, and discovery.db (vectors and map
  // points) still has the old one until the applier runs. The songs are the
  // seeded library's, `limit` of them from the `offset`-th in id order.
  function reKeyTracks(suffix, { limit = -1, offset = 0 } = {}) {
    const mdb = dbManager.getDB();
    const moved = [];
    mdb.exec('BEGIN');
    try {
      const upd = mdb.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?');
      const ledger = mdb.prepare('INSERT INTO hash_transitions (old_hash, new_hash) VALUES (?, ?)');
      const songs = mdb.prepare(`SELECT id, audio_hash FROM tracks WHERE library_id = (SELECT id FROM libraries WHERE name = 'maplib')
                                  ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset);
      for (const { id, audio_hash: h } of songs) {
        upd.run(`${h}${suffix}`, id);
        ledger.run(h, `${h}${suffix}`);
        moved.push([h, `${h}${suffix}`]);
      }
      mdb.exec('COMMIT');
    } catch (err) {
      mdb.exec('ROLLBACK');
      throw err;
    }
    return moved;
  }

  const servingPoints = () => {
    const layout = dbManager.getDB().prepare('SELECT active_layout FROM track_map_meta WHERE id = 1').get().active_layout;
    const rows = discoveryDb.getDiscoveryDb().prepare('SELECT audio_hash, x, y, placed FROM map_points WHERE layout_id = ?').all(layout);
    return { layout, points: new Map(rows.map((r) => [r.audio_hash, { x: r.x, y: r.y, placed: r.placed }])) };
  };
  const ledgerRows = () => dbManager.getDB().prepare('SELECT COUNT(*) AS n FROM hash_transitions').get().n;
  const idle = () => taskQueue.getQueueLength() === 0 && taskQueue.getAdminStats().activeTaskKind === null;

  // The queue's info and warn lines from now until restore(), in order;
  // `onLine` sees each one as it is logged (the state of the moment).
  function captureLog(onLine = null) {
    const lines = [];
    const real = { info: winston.info, warn: winston.warn };
    for (const level of ['info', 'warn']) {
      winston[level] = function capture(msg, ...rest) {
        lines.push(String(msg));
        onLine?.(String(msg));
        return real[level].call(this, msg, ...rest);
      };
    }
    return { lines, restore: () => { winston.info = real.info; winston.warn = real.warn; } };
  }
  const indexOf = (lines, re, from = 0) => {
    const i = lines.slice(from).findIndex((l) => re.test(l));
    return i < 0 ? -1 : from + i;
  };
  const APPLIED = /^Applied \d+ hash transition/;
  const APPLY_FAILED = /^Hash-transition apply failed/;
  const PASS_STARTED = /^Music map pass started/;
  const PASS_DONE = /^Music map: \w+ \(\w+\) — /;

  // Every re-keyed song kept its point: same layout, same position, same
  // placement (a landmark is still one).
  function assertPointsKept(start, moved) {
    const now = servingPoints();
    assert.equal(now.layout, start.layout);
    for (const [oldHash, newHash] of moved) {
      assert.deepEqual(now.points.get(newHash), start.points.get(oldHash), `${oldHash} → ${newHash}`);
      assert.equal(now.points.has(oldHash), false);
    }
  }

  // Pass A parks at its first phase; `queueBehind` queues work behind it,
  // then the files re-key and A's worker dies — "a task closes" with that
  // work queued and a ledger waiting for the drain. Returns the info lines
  // logged from the kill on, once the queue has settled (the ledger applied
  // and a map pass completed after A).
  async function closeWithLedger(suffix, queueBehind) {
    process.env.MSTREAM_TEST_MAP_HOLD = 'inventory';   // the forked worker inherits it
    try { taskQueue.maybeEnqueueMap(`pass A ${suffix ?? ''}`); } finally { delete process.env.MSTREAM_TEST_MAP_HOLD; }
    assert.ok(await waitFor(() => mapEntry().state === 'running' && mapEntry().progress !== null), 'pass A parked');
    queueBehind();
    const moved = suffix ? reKeyTracks(suffix) : [];
    const log = captureLog();
    try {
      const before = mapEntry().lastRun.finishedAt;
      const { pid } = JSON.parse(fs.readFileSync(path.join(testRoot, 'db', '.scanner.pid.json'), 'utf8'));
      process.kill(pid, 'SIGKILL');   // pass A's worker, forked by this process's queue
      assert.ok(await waitFor(() => idle() && ledgerRows() === 0
        && mapEntry().lastRun.outcome === 'completed' && mapEntry().lastRun.finishedAt > before),
      'the ledger was applied and a map pass completed');
    } finally {
      log.restore();
    }
    return { moved, lines: log.lines };
  }

  // The applier's line comes before any map pass starts, and every re-keyed
  // song kept its point: same layout, same position, still a landmark.
  function assertKeptThroughReKey(start, { moved, lines }) {
    const applied = indexOf(lines, APPLIED);
    const started = indexOf(lines, PASS_STARTED);
    assert.ok(applied >= 0, lines.join('\n'));
    assert.ok(started > applied, `a map pass started before the applier finished:\n${lines.join('\n')}`);
    assertPointsKept(start, moved);
    const counts = mapEntry().lastRun.counts;
    assert.deepEqual([counts.mode, counts.removed, counts.placed], ['mirror', 0, 0]);
  }

  test('a map pass never runs ahead of a ledger the applier has yet to apply, nor beside the applier', async () => {
    taskQueue.maybeEnqueueMap('before the re-keys');
    await waitForIdle();
    const start = servingPoints();
    assert.equal(start.points.size, 80);

    // Pass B and a non-enrichment task (a backup of a destination that does
    // not exist: it no-ops at dispatch, standing in for a queued scan) wait
    // behind A. A's close dispatches B while the backup still keeps the drain
    // — and with it the applier — away: B must wait for the ledger.
    const first = await closeWithLedger('-v2', () => {
      taskQueue.maybeEnqueueMap('pass B');
      assert.equal(taskQueue.addBackupTask(987654321, 'test'), true);
      assert.equal(taskQueue.getQueueLength(), 2);
    });
    assertKeptThroughReKey(start, first);

    // Only B behind A: the close dispatches B, then drains (and the drain
    // starts the applier). B must not fork before the applier has finished.
    const second = await closeWithLedger('-v3', () => {
      taskQueue.maybeEnqueueMap('pass B again');
      assert.equal(taskQueue.getQueueLength(), 1);
    });
    assertKeptThroughReKey({ ...start, points: new Map(Array.from(start.points, ([h, p]) => [`${h}-v2`, p])) }, second);
  });

  test('a ledger the applier fails on: each pass waits for an attempt of its own and runs past only that one\'s failure', async () => {
    taskQueue.maybeEnqueueMap('before the failing ledger');
    await waitForIdle();
    const [[, failedNew]] = reKeyTracks('-v4', { limit: 1 });
    // The applier fails on that ledger: the server's discovery connection is
    // held inside a transaction, so the applier's BEGIN throws.
    const ddb = discoveryDb.getDiscoveryDb();
    const log = captureLog();
    try {
      ddb.exec('BEGIN');
      try {
        // The queue is idle, so each request starts the applier, which
        // fails; the pass it parked then runs all the same instead of
        // waiting forever. The second request gets a fresh attempt: one
        // failure lets past only the pass that waited for it.
        for (const n of [1, 2]) {
          const mark = log.lines.length;
          const before = mapEntry().lastRun.finishedAt;
          taskQueue.maybeEnqueueMap(`past a failing ledger ${n}`);
          assert.ok(await waitFor(() => idle() && mapEntry().lastRun.finishedAt > before), `pass ${n} ran`);
          assert.equal(mapEntry().lastRun.outcome, 'completed');
          assert.equal(ledgerRows(), 1, 'the ledger stays for the next attempt');
          const failed = indexOf(log.lines, APPLY_FAILED, mark);
          const started = indexOf(log.lines, new RegExp(`^Music map pass started \\(past a failing ledger ${n}\\)`), mark);
          assert.ok(failed >= 0 && started > failed,
            `pass ${n} ran without an apply attempt of its own:\n${log.lines.slice(mark).join('\n')}`);
        }
      } finally {
        ddb.exec('ROLLBACK');
      }
      // The cause has cleared (a passing lock, say). The next pass still
      // waits for an attempt, which now applies the ledger first: a song
      // re-keyed since keeps its point. (The song in the failed ledger lost
      // its point to the passes that ran past it; it comes back placed.)
      const start = servingPoints();
      const moved = reKeyTracks('-v5', { limit: 1, offset: 1 });
      const mark = log.lines.length;
      const before = mapEntry().lastRun.finishedAt;
      taskQueue.maybeEnqueueMap('after the failure cleared');
      assert.ok(await waitFor(() => idle() && ledgerRows() === 0 && mapEntry().lastRun.finishedAt > before),
        'the ledger was applied and a map pass completed');
      const applied = indexOf(log.lines, /^Applied 2 hash transition/, mark);
      const started = indexOf(log.lines, PASS_STARTED, mark);
      assert.ok(applied >= 0 && started > applied,
        `a map pass ran past a ledger that would apply:\n${log.lines.slice(mark).join('\n')}`);
      assertPointsKept(start, moved);
      assert.equal(servingPoints().points.get(failedNew)?.placed, 'knn');
      const counts = mapEntry().lastRun.counts;
      assert.deepEqual([counts.mode, counts.removed, counts.placed], ['place', 0, 1]);
    } finally {
      log.restore();
    }
  });

  test('a pass let past a failed apply waits behind another task; the drain dispatching it leaves the applier alone', async () => {
    taskQueue.maybeEnqueueMap('before the backup');
    await waitForIdle();
    // The backup's source is the seeded library's root (a backup refuses an empty one).
    fs.mkdirSync(path.join(testRoot, 'music'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'music', 'cover.jpg'), Buffer.alloc(64));
    const dest = dbManager.addBackupDestination({
      libraryId: dbManager.getDB().prepare("SELECT id FROM libraries WHERE name = 'maplib'").get().id,
      destPath: path.join(testRoot, 'backup-dest'),
      triggerType: 'manual', dailyAtHour: null, retentionDays: 7, enabled: true, excludeGlobs: [], interFileDelayMs: 0,
    });
    reKeyTracks('-v6', { limit: 1, offset: 2 });
    const ddb = discoveryDb.getDiscoveryDb();
    let ledgerAtStart = null;
    const log = captureLog((line) => { if (/^Music map pass started \(pass P\)/.test(line)) { ledgerAtStart = ledgerRows(); } });
    try {
      const before = mapEntry().lastRun.finishedAt;
      ddb.exec('BEGIN');
      try {
        // Idle: this starts the applier, which fails before the call returns.
        // Its tail has yet to run when a backup takes the slot, so the pass
        // it lets past the failure queues behind the backup.
        taskQueue.maybeEnqueueMap('pass P');
        assert.equal(taskQueue.addBackupTask(dest, 'test'), true);
        assert.equal(taskQueue.getAdminStats().activeTaskKind, 'backup');
      } finally {
        ddb.exec('ROLLBACK');   // the cause clears before the backup's close dispatches P, and drains
      }
      assert.ok(await waitFor(() => idle() && ledgerRows() === 0 && mapEntry().lastRun.finishedAt > before
        && indexOf(log.lines, APPLIED) >= 0), 'P ran, then the ledger was applied');
      const started = indexOf(log.lines, /^Music map pass started \(pass P\)/);
      assert.ok(started >= 0, log.lines.join('\n'));
      assert.equal(ledgerAtStart, 1, 'P forked past a pending ledger (its own attempt had failed)');
      const finished = indexOf(log.lines, PASS_DONE, started);
      const applied = indexOf(log.lines, APPLIED);
      assert.ok(finished > started && applied > finished, `the applier ran beside pass P:\n${log.lines.join('\n')}`);
    } finally {
      log.restore();
    }
  });

  test('the applier drops only the ledger rows it read: rows committed while it runs wait for the next apply', async () => {
    taskQueue.maybeEnqueueMap('before the re-keys');
    await waitForIdle();
    const start = servingPoints();
    const first = reKeyTracks('-v7', { limit: 10, offset: 10 });
    let late = [];
    const ledgerAtApplied = [];
    const log = captureLog((line) => { if (APPLIED.test(line)) { ledgerAtApplied.push(ledgerRows()); } });
    try {
      const before = mapEntry().lastRun.finishedAt;
      // Idle: this starts the applier, which reads the ledger, re-keys its
      // one chunk and yields. The immediate queued right behind that yield
      // runs while the applier awaits its waveform-cache read — after its
      // ledger read, before its ledger delete — and commits more re-keys, as
      // a scan dispatched beside the applier (it is not a task) would.
      taskQueue.maybeEnqueueMap('after the re-keys');
      setImmediate(() => { late = reKeyTracks('-v8', { limit: 5, offset: 20 }); });
      assert.ok(await waitFor(() => idle() && ledgerRows() === 0 && mapEntry().lastRun.finishedAt > before),
        'the ledger was applied and a map pass completed');
      assert.equal(late.length, 5);
      assert.deepEqual(ledgerAtApplied, [5, 0], 'the late rows outlived the first apply, and the second applied them');
      const appliedLate = indexOf(log.lines, /^Applied 5 hash transition/);
      assert.ok(appliedLate >= 0 && indexOf(log.lines, PASS_STARTED) > appliedLate, log.lines.join('\n'));
      assertPointsKept(start, [...first, ...late]);
      const counts = mapEntry().lastRun.counts;
      assert.deepEqual([counts.mode, counts.removed, counts.placed], ['mirror', 0, 0]);
    } finally {
      log.restore();
    }
  });

  test('after a failed apply, a map pass behind a scan still waits for the ledger that scan wrote', async () => {
    taskQueue.maybeEnqueueMap('before the scans');
    await waitForIdle();
    // A library for real scans (the rust scanner, or the JS one without it);
    // its files are not audio, so a scan re-keys nothing itself. What a scan
    // writes comes at its close instead: `reKey()` re-keys songs with their
    // ledger rows, and the after-scan backup the backup manager enqueues
    // there dispatches the next queued task before the close drains.
    const scanDir = path.join(testRoot, 'scanlib');
    fs.mkdirSync(scanDir, { recursive: true });
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(scanDir, `track-${i}.mp3`), Buffer.alloc(2048, i)); }
    dbManager.getDB().prepare("INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES ('scanlib', ?, 'music', 0)")
      .run(scanDir);
    dbManager.invalidateCache();
    const ddb = discoveryDb.getDiscoveryDb();
    // `act()` starts the scan; once a map pass has completed after the ledger
    // emptied, the applier must have come first and every re-keyed song
    // (`reKey()`'s and `alsoMoved`) kept its point. Returns the log lines.
    async function throughScan(reKey, act, { alsoMoved = [] } = {}) {
      const start = servingPoints();
      let moved = [];
      taskQueue.setOnScanCompleteCallback(() => {
        moved = reKey();
        taskQueue.addBackupTask(987654321, 'after-scan');   // no such destination: it no-ops at dispatch
      });
      const log = captureLog();
      try {
        const before = mapEntry().lastRun.finishedAt;
        act();
        assert.equal(taskQueue.getAdminStats().activeTaskKind, 'scan');
        assert.ok(await waitFor(() => idle() && ledgerRows() === 0 && mapEntry().lastRun.finishedAt > before
          && indexOf(log.lines, PASS_STARTED) >= 0, { timeoutMs: 120_000 }), 'the ledger was applied and a map pass completed');
      } finally {
        taskQueue.setOnScanCompleteCallback(null);
        log.restore();
      }
      assert.match(log.lines.join('\n'), /File scan completed with code 0/);
      assert.ok(moved.length > 0);
      const applied = indexOf(log.lines, APPLIED);
      const started = indexOf(log.lines, PASS_STARTED);
      assert.ok(applied >= 0 && started > applied, `a map pass ran past the scan's ledger:\n${log.lines.join('\n')}`);
      assertPointsKept(start, [...moved, ...alsoMoved]);
      return log.lines;
    }

    // A. An apply fails and the pass that waited for it runs past it; then a
    //    scan runs with a map pass queued behind it.
    reKeyTracks('-v9', { limit: 1, offset: 30 });
    const before = mapEntry().lastRun.finishedAt;
    ddb.exec('BEGIN');
    try {
      taskQueue.maybeEnqueueMap('past a failing ledger');
      assert.ok(await waitFor(() => idle() && mapEntry().lastRun.finishedAt > before), 'the pass ran');
    } finally {
      ddb.exec('ROLLBACK');
    }
    assert.equal(ledgerRows(), 1);
    const a = await throughScan(() => reKeyTracks('-v10', { limit: 20, offset: 40 }), () => {
      taskQueue.scanVPath('scanlib');
      taskQueue.maybeEnqueueMap('M, behind the scan');
    });
    assert.ok(indexOf(a, /^Applied 21 hash transition/) >= 0, a.join('\n'));

    // B. An apply fails, and before it lets the pass that waited for it past
    //    the failure, a scan starts: that scan may write rows the failed
    //    attempt never saw, so the pass waits for an attempt at them instead.
    const waited = reKeyTracks('-v11', { limit: 1, offset: 60 });
    const b = await throughScan(() => reKeyTracks('-v12', { limit: 10, offset: 61 }), () => {
      ddb.exec('BEGIN');
      try {
        taskQueue.maybeEnqueueMap('P, past a failing ledger');
        taskQueue.scanVPath('scanlib');
      } finally {
        ddb.exec('ROLLBACK');
      }
    }, { alsoMoved: waited });
    const failed = indexOf(b, APPLY_FAILED);
    assert.ok(failed >= 0 && indexOf(b, /^Applied 11 hash transition/) > failed, b.join('\n'));
  });
});
