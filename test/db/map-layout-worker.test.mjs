/**
 * The music map worker (src/db/map-layout.mjs; docs/music-map-plan.md §3.4).
 *
 * Spawned the way task-queue forks it (argv JSON, stdout events, exit
 * codes) against temp DB pairs: a fully migrated mstream.db and a
 * discovery.db seeded with synthetic 64-d vectors under model_id
 * 'test-fake' — four genres of six artists each, so provinces and towns
 * are real and a layout has structure to keep across a refit; the
 * dimension comes from the blobs (the registry says 8). Covers:
 *
 *   - events and exit codes: `{}` → Invalid JSON Input (1); a null
 *     maxFitTracks → 1 (the payload rule); a wrong schema version → 3.
 *   - modes: 0 dots → empty; 1, 2, 30 → pca2 with finite coordinates; 600 →
 *     a umap rebuild (fit set, genre provinces, land, near-duplicate dots,
 *     copies); a rerun → mirror with rev unchanged; +30 → place; +100 seven
 *     hours after the fit → a warm refit within the old-point p95 bound;
 *     +800 (more than |P| = 730) → rebuild.
 *   - the fit-set cap (MSTREAM_TEST_MAP_FIT_FLOOR=100, maxFitTracks 200):
 *     |F| = 200 with 400 placed; a refit with 300 new keeps |F| ≤ 200; a
 *     place run fits nothing (perf guard 5: no fit ever exceeds the cap).
 *   - landmarks that leave: a fit set that leaves a little at a time (each
 *     pass under the per-pass thresholds) is refitted once 15 % of it has
 *     gone since the fit; when every landmark leaves within 6 h of the fit
 *     a warm refit (same basis, survivors within a p95 bound) restores the
 *     fit set instead of pruning the last of them, and new songs still place
 *     afterwards; a layout with no landmarks at all refits from its every
 *     point instead of failing.
 *   - batches (MSTREAM_TEST_MAP_PLACE_MAX=50): hitCap, and repeated runs
 *     finish — as place runs, never a rebuild loop.
 *   - a model switch: the old layout keeps serving and the mirror stays
 *     put until settled; then a rebuild under the new model keeps genre
 *     keys and hues.
 *   - dirty: a place run killed at its regions phase leaves dirty = 1; the
 *     rerun recomputes regions and land.
 *   - the hash-transition applier beside a place run (parked at its write
 *     phase, MSTREAM_TEST_MAP_RELEASE resumes it): a point re-keyed after
 *     the inventory read is not pruned, stays where it was, and dirty stays
 *     1 so the next run counts its dot again.
 *   - recovery: a kill before the flip leaves the old layout serving and
 *     the next run deletes the unflipped one; a kill after the flip serves
 *     the new layout and the old rows go at the next start; 'building'
 *     leftovers and orphans go; a pointer with a stale map_epoch adopts the
 *     newest ready layout and writes its generation.
 *   - the memory guard: MSTREAM_TEST_MAP_FORCE_GUARD → exit 5 with
 *     nFitTried on the error event, nothing written.
 *   - safety, after every run: row_seq and index_epoch unchanged; no event
 *     carries a vector.
 *   - a bun leg: the rebuild and place cases under Bun (bun:sqlite).
 *
 * No assertion depends on timing: kill and pause points come from the
 * MSTREAM_TEST_MAP_HOLD seam (a progress event, or the pointer flip, says
 * the worker is parked), the refit's clock from MSTREAM_TEST_MAP_NOW_MS.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import winston from 'winston';

import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { BUN_BIN, noBun } from '../helpers/bun.mjs';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import { initDiscoveryDb, closeDiscoveryDb, applyHashTransitionGroups } from '../../src/db/discovery-db.js';
import { mulberry32, decodeLandV1, HUE_GAP, MIX_MAX } from '../../src/db/map-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(__dirname, '..', '..', 'src', 'db', 'map-layout.mjs');
const DIM = 64;
const GENRES = ['Rock---Indie Rock', 'Jazz---Hard Bop', 'Electronic---Techno', 'Hip Hop---Boom Bap'];
const PROVINCE_KEYS = ['g:Electronic', 'g:Hip Hop', 'g:Jazz', 'g:Rock'];
const ARTISTS = 6;
const HOUR = 60 * 60 * 1000;

// initDiscoveryDb logs its migrations through winston; nothing to see here.
winston.configure({ transports: [new winston.transports.Console({ silent: true })] });

let scratch;
before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-map-worker-')); });
after(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_e) { /* win file locks */ }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function unit(v) {
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}

function makeFixture(seed) {
  const dir = fs.mkdtempSync(path.join(scratch, 'fx-'));
  const libraryDbPath = path.join(dir, 'mstream.db');
  const discoveryDbPath = path.join(dir, 'discovery.db');
  const mdb = new DatabaseSync(libraryDbPath);
  mdb.exec('PRAGMA journal_mode = WAL');
  mdb.exec('PRAGMA foreign_keys = ON');
  mdb.exec('PRAGMA busy_timeout = 5000');
  applyAllMigrations(mdb);
  mdb.exec("INSERT INTO libraries (id, name, root_path) VALUES (1, 'lib', '/music')");
  // The real schema (migrations, map tables), then a plain handle.
  initDiscoveryDb(discoveryDbPath);
  closeDiscoveryDb();
  const ddb = new DatabaseSync(discoveryDbPath);
  ddb.exec('PRAGMA journal_mode = WAL');
  ddb.exec('PRAGMA busy_timeout = 5000');
  ddb.exec("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('row_seq', '17'), ('index_epoch', '9')");
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  // Genre > artist > track, the shape real libraries have: artists are
  // sub-clusters of their genre, tracks scatter around their artist.
  const artists = GENRES.map(() => {
    const genre = unit(Array.from({ length: DIM }, gauss));
    return Array.from({ length: ARTISTS }, () => {
      const offset = unit(Array.from({ length: DIM }, gauss));
      return unit(genre.map((c, i) => c + 0.45 * offset[i]));
    });
  });
  return { dir, libraryDbPath, discoveryDbPath, mdb, ddb, gauss, artists, seq: 0 };
}

function closeFixture(fx) {
  try { fx.mdb.close(); } catch (_e) { /* closed */ }
  try { fx.ddb.close(); } catch (_e) { /* closed */ }
}

// Hashes spread over the key space (the fit set is the lowest hashes).
const hashOf = (s) => (Math.imul(s, 2654435761) >>> 0).toString(16).padStart(8, '0') + s.toString(16).padStart(24, '0');

function insertSong(fx, vec, genre, { model = 'test-fake' } = {}) {
  const s = ++fx.seq;
  const h = hashOf(s);
  fx.mdb.prepare('INSERT INTO tracks (filepath, library_id, title, audio_hash, created_at) VALUES (?, 1, ?, ?, ?)')
    .run(`song-${s}.mp3`, `Song ${s}`, h, '2026-10-01 00:00:00');
  fx.ddb.prepare(`INSERT INTO discovery_tracks (audio_hash, updated_at, export_id, model_id, model_version, embedding, genre_tags)
                  VALUES (?, 1, ?, ?, '1', ?, ?)`)
    .run(h, `anon:${h}`, model, new Uint8Array(Float32Array.from(vec).buffer), JSON.stringify([GENRES[genre]]));
  return h;
}

// `n` songs round-robin over the genres and their artists (cos ≈ 0.96
// within an artist: close, never near-duplicates).
function addSongs(fx, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = fx.seq + 1;
    const g = s % GENRES.length;
    const artist = fx.artists[g][Math.floor(s / GENRES.length) % ARTISTS];
    out.push(insertSong(fx, unit(artist.map((c) => c + 0.2 * fx.gauss() / Math.sqrt(DIM))), g));
  }
  return out;
}

function vectorOf(fx, hash) {
  const blob = fx.ddb.prepare('SELECT embedding FROM discovery_tracks WHERE audio_hash = ?').get(hash).embedding;
  return Array.from(new Float32Array(new Uint8Array(blob).buffer));
}

// A near-duplicate of `hash` (cos ≈ 0.997: a re-encode, say).
function addNearDuplicate(fx, hash) {
  const base = vectorOf(fx, hash);
  const noise = unit(base.map(() => fx.gauss()));
  return insertSong(fx, unit(base.map((x, i) => x + 0.07 * noise[i])), GENRES.indexOf(JSON.parse(
    fx.ddb.prepare('SELECT genre_tags FROM discovery_tracks WHERE audio_hash = ?').get(hash).genre_tags)[0]));
}

// A second file with the same audio: same hash, no new discovery row.
function addCopy(fx, hash) {
  const s = ++fx.seq;
  return Number(fx.mdb.prepare('INSERT INTO tracks (filepath, library_id, title, audio_hash, created_at) VALUES (?, 1, ?, ?, ?)')
    .run(`copy-${s}.mp3`, `Copy ${s}`, hash, '2026-10-02 00:00:00').lastInsertRowid);
}

// ── the worker ───────────────────────────────────────────────────────────────

let releases = 0;

// Spawn the worker. `killAt` parks it at that phase (MSTREAM_TEST_MAP_HOLD)
// and kills it once the phase's opening event arrives; `killWhen` polls a
// predicate instead (the flip has no event of its own). `pauseAt` parks it
// at that phase instead, runs `whilePaused()` once the phase's opening
// event arrives, then lets it go on (MSTREAM_TEST_MAP_RELEASE).
function runWorker(fx, extra = {}, {
  env = {}, killAt = null, killWhen = null, pauseAt = null, whilePaused = null, bin = process.execPath, rawArg = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = {
      discoveryDbPath: fx.discoveryDbPath, libraryDbPath: fx.libraryDbPath, model: 'test-fake',
      expectedSchemaVersion: SCHEMA_VERSION, parentRssBytes: 50_000_000, ...extra,
    };
    const childEnv = { ...process.env, ...env };
    if (killAt) { childEnv.MSTREAM_TEST_MAP_HOLD = killAt; }
    const release = pauseAt ? path.join(fx.dir, `release-${++releases}`) : null;
    if (pauseAt) { Object.assign(childEnv, { MSTREAM_TEST_MAP_HOLD: pauseAt, MSTREAM_TEST_MAP_RELEASE: release }); }
    const p = spawn(bin, [WORKER, rawArg ?? JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let stdout = '', stderr = '', killed = false, paused = false, pauseError = null;
    const kill = () => { if (!killed) { killed = true; p.kill('SIGKILL'); } };
    const hang = setTimeout(kill, 120_000);   // a hung worker fails the test instead of the suite
    const poll = killWhen ? setInterval(() => { try { if (killWhen()) { kill(); } } catch (_e) { /* busy: next tick */ } }, 20) : null;
    p.stdout.on('data', (d) => {
      stdout += d.toString();
      if (killAt && !killWhen && stdout.includes(`"phase":"${killAt}"`)) { kill(); }
      if (pauseAt && !paused && stdout.includes(`"phase":"${pauseAt}"`)) {
        paused = true;
        try { whilePaused?.(); } catch (err) { pauseError = err; } finally { fs.writeFileSync(release, ''); }
      }
    });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      clearTimeout(hang);
      if (poll) { clearInterval(poll); }
      if (pauseError) { reject(pauseError); return; }
      // Event lines only (a Joi failure prints its error object to stdout too).
      const lines = [], events = [];
      for (const l of stdout.split('\n').map((x) => x.trim())) {
        if (!l.startsWith('{')) { continue; }
        try { events.push(JSON.parse(l)); lines.push(l); } catch (_e) { /* not an event */ }
      }
      resolve({
        code, signal, lines, events, stdout, stderr,
        complete: events.find((e) => e.event === 'mapComplete') ?? null,
        error: events.find((e) => e.event === 'error') ?? null,
        fitTotal: events.find((e) => e.event === 'mapProgress' && e.phase === 'fit')?.total ?? null,
      });
    });
  });
}

// ── reading the result ───────────────────────────────────────────────────────

const meta = (fx, key) => fx.ddb.prepare('SELECT value FROM discovery_meta WHERE key = ?').get(key)?.value ?? null;
const pointer = (fx) => ({ ...fx.mdb.prepare('SELECT active_layout, map_epoch, rev, added_max FROM track_map_meta WHERE id = 1').get() });
const layoutRow = (fx, id) => {
  const row = fx.ddb.prepare('SELECT * FROM map_layouts WHERE id = ?').get(id);
  return row ? { ...row, params: JSON.parse(row.params) } : null;
};
const layoutIds = (fx) => fx.ddb.prepare('SELECT id FROM map_layouts ORDER BY id').all().map((r) => r.id);
const points = (fx, id) => fx.ddb.prepare(
  'SELECT audio_hash, dot, x, y, placed, region0, region1, central0, central1 FROM map_points WHERE layout_id = ? ORDER BY audio_hash').all(id);
const regions = (fx, id) => fx.ddb.prepare('SELECT * FROM map_regions WHERE layout_id = ? ORDER BY level, id').all(id);
const mirrorRows = (fx, id) => fx.mdb.prepare('SELECT * FROM track_map WHERE layout_id = ? ORDER BY track_id').all(id);
const mirrorGenerations = (fx) => fx.mdb.prepare('SELECT DISTINCT layout_id FROM track_map ORDER BY layout_id').all().map((r) => r.layout_id);

// After every run: map writes never touch row_seq or index_epoch, and no
// event carries a vector (small lines, no long number arrays).
function assertSafe(fx, r) {
  assert.equal(meta(fx, 'row_seq'), '17', 'row_seq untouched');
  assert.equal(meta(fx, 'index_epoch'), '9', 'index_epoch untouched');
  for (const line of r.lines) { assert.ok(line.length < 1024, `an event line of ${line.length} bytes`); }
  for (const e of r.events) {
    for (const v of Object.values(e)) { assert.ok(!Array.isArray(v), `an array in ${JSON.stringify(e)}`); }
  }
}

function assertOk(r, mode) {
  assert.equal(r.code, 0, `exit ${r.code} ${r.signal ?? ''}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.complete, 'a mapComplete event');
  if (mode) { assert.equal(r.complete.mode, mode, JSON.stringify(r.complete)); }
  return r.complete;
}

// The pointer names a ready layout of these tables, and the mirror is
// exact: one row per track whose canonical hash has a point, holding the
// point's (its dot's) values.
function assertServing(fx) {
  const p = pointer(fx);
  assert.ok(Number.isInteger(p.active_layout), 'a serving layout');
  assert.equal(p.map_epoch, meta(fx, 'map_epoch'));
  assert.equal(layoutRow(fx, p.active_layout).state, 'ready');
  const pts = new Map(points(fx, p.active_layout).map((pt) => [pt.audio_hash, pt]));
  const tracks = fx.mdb.prepare('SELECT id, COALESCE(audio_hash, file_hash) AS h FROM tracks').all();
  const rows = new Map(mirrorRows(fx, p.active_layout).map((r) => [r.track_id, r]));
  let expected = 0;
  for (const t of tracks) {
    const pt = pts.get(t.h);
    if (!pt) { assert.ok(!rows.has(t.id), `track ${t.id} has no point but a mirror row`); continue; }
    expected++;
    const row = rows.get(t.id);
    assert.ok(row, `track ${t.id} has a point but no mirror row`);
    assert.equal(row.dot, pt.dot);
    assert.equal(row.x, Math.round(Math.min(1, Math.max(0, pt.x)) * 65535));
  }
  assert.equal(rows.size, expected);
  return p;
}

function assertFinite(pts) {
  for (const pt of pts) {
    for (const v of [pt.x, pt.y, pt.central0, pt.central1]) { assert.ok(Number.isFinite(v), `${pt.audio_hash}: ${v}`); }
  }
}

function percentile(values, p) {
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ── events and exit codes ────────────────────────────────────────────────────

describe('map-layout worker: input and exit codes', () => {
  let fx;
  before(() => { fx = makeFixture(11); });
  after(() => closeFixture(fx));

  test('{} → Invalid JSON Input, exit 1', async () => {
    const r = await runWorker(fx, {}, { rawArg: '{}' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid JSON Input/);
  });

  test('a null maxFitTracks → exit 1 (the payload rule: optional keys are omitted, never null)', async () => {
    const r = await runWorker(fx, { maxFitTracks: null });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid JSON Input/);
  });

  test('a library at another schema version → exit 3, nothing written', async () => {
    const r = await runWorker(fx, { expectedSchemaVersion: SCHEMA_VERSION - 1 });
    assert.equal(r.code, 3);
    assert.match(r.error.message, /schema-version guard/);
    assert.equal(pointer(fx).rev, 0);
  });
});

// ── modes ────────────────────────────────────────────────────────────────────

describe('map-layout worker: modes', () => {
  let fx;
  const dupPairs = [];
  let copy = null;
  before(() => { fx = makeFixture(1); });
  after(() => closeFixture(fx));

  test('0 dots → empty', async () => {
    const r = await runWorker(fx);
    assertOk(r, 'empty');
    assert.deepEqual([r.complete.layoutId, r.complete.dots], [null, 0]);
    assert.equal(pointer(fx).active_layout, null);
    assert.deepEqual(layoutIds(fx), []);
    assertSafe(fx, r);
  });

  test('1, 2 and 30 dots → pca2, every coordinate finite', async () => {
    for (const [add, total] of [[1, 1], [1, 2], [28, 30]]) {
      addSongs(fx, add);
      const r = await runWorker(fx);
      const c = assertOk(r, 'rebuild');
      assert.deepEqual([c.method, c.dots, c.fitted, c.nFitTried], ['pca2', total, total, 0]);
      const p = assertServing(fx);
      const pts = points(fx, p.active_layout);
      assert.equal(pts.length, total);
      assertFinite(pts);
      for (const pt of pts) { assert.equal(pt.placed, 'pca2'); }
      if (total === 1) {
        assert.deepEqual([pts[0].x, pts[0].y], [0.5, 0.5], 'one song sits in the middle');
        assert.equal(meta(fx, 'map_recent_after'), '2026-10-01 00:00:00', 'the first ready layout sets the recent baseline');
      }
      const L = layoutRow(fx, p.active_layout);
      assert.ok(Number.isFinite(L.aspect) && L.aspect > 0);
      assert.ok(regions(fx, p.active_layout).some((g) => g.level === 0), 'a province');
      assertSafe(fx, r);
    }
  });

  test('600 dots → a umap rebuild: fit set, genre provinces, land, near-duplicate dots, copies', async () => {
    addSongs(fx, 564);
    for (const h of addSongs(fx, 3)) { dupPairs.push([h, addNearDuplicate(fx, h)]); }   // 30 + 564 + 6 = 600 hashes
    copy = { hash: dupPairs[0][0], id: addCopy(fx, dupPairs[0][0]) };
    const r = await runWorker(fx);
    const c = assertOk(r, 'rebuild');
    assert.deepEqual([c.method, c.fitted, c.placed, c.nFitTried, c.hitCap], ['umap', 600, 0, 600, false]);
    assert.equal(r.fitTotal, 600, 'the fit phase opens with |F|');
    const p = assertServing(fx);
    assert.equal(c.layoutId, p.active_layout);
    const pts = points(fx, p.active_layout);
    assert.equal(pts.length, 600);
    assertFinite(pts);
    for (const pt of pts) {
      assert.equal(pt.placed, 'fit');
      assert.ok(pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1, 'a rebuild boxes into [0,1]²');
    }
    const dotOf = new Map(pts.map((pt) => [pt.audio_hash, pt]));
    for (const [a, b] of dupPairs) {
      assert.equal(dotOf.get(a).dot, dotOf.get(b).dot, 'near-duplicates share one dot');
      assert.equal(dotOf.get(a).x, dotOf.get(b).x, 'and its position');
    }
    assert.equal(c.dots, 597);
    assert.equal(new Set(pts.map((pt) => pt.dot)).size, 597);
    const copyRows = fx.mdb.prepare('SELECT track_id, dot FROM track_map WHERE layout_id = ? AND hash = ?').all(p.active_layout, copy.hash);
    assert.equal(copyRows.length, 2, 'both files of one recording are mirrored');
    assert.equal(copyRows[0].dot, copyRows[1].dot);

    const regs = regions(fx, p.active_layout);
    const provinces = regs.filter((g) => g.level === 0), towns = regs.filter((g) => g.level === 1);
    assert.deepEqual(provinces.map((g) => g.key).sort(), PROVINCE_KEYS);
    assert.deepEqual(provinces.map((g) => g.label).sort(), ['Electronic', 'Hip Hop', 'Jazz', 'Rock']);
    assert.ok(towns.length >= provinces.length);
    for (const t of towns) {
      assert.ok(['Indie Rock', 'Hard Bop', 'Techno', 'Boom Bap'].includes(t.label), t.label);
      assert.equal(t.hue, provinces[t.parent].hue, 'towns take their province\'s hue');
    }
    assert.equal(provinces.reduce((s, g) => s + g.size, 0), 597, 'sizes count dots');
    assert.equal(towns.reduce((s, g) => s + g.size, 0), 597);
    const labels = new Set(pts.map((pt) => pt.dot));
    for (const g of regs) {
      assert.ok(!(g.hue >= HUE_GAP[0] && g.hue <= HUE_GAP[1]), `hue ${g.hue} sits in the accent gap`);
      const mix = JSON.parse(g.mix);
      assert.ok(mix.length > 0 && mix.length <= MIX_MAX);
      for (const d of mix) { assert.ok(labels.has(d), 'a mix holds dot labels'); }
      if (g.level === 0) {
        const land = decodeLandV1(g.land);
        assert.ok(land[0].length > 0, `${g.key} has a coast`);
      } else {
        assert.equal(g.land, null);
      }
    }
    const L = layoutRow(fx, p.active_layout);
    assert.deepEqual([L.method, L.n_fit, L.n_points, L.dirty, L.k], ['umap', 600, 600, 0, 50]);
    assert.equal(L.params.layoutVersion, 1);
    assert.equal(L.params.nU, 600);
    assert.equal(meta(fx, 'map_recent_after'), '2026-10-01 00:00:00', 'the baseline stays where the first layout set it');
    assertSafe(fx, r);
  });

  test('a rerun with nothing changed → mirror, rev unchanged', async () => {
    const before = pointer(fx);
    const version = meta(fx, 'map_version');
    const r = await runWorker(fx);
    assertOk(r, 'mirror');
    assert.deepEqual(pointer(fx), before, 'rev and the pointer stand still');
    assert.equal(meta(fx, 'map_version'), version);
    assertSafe(fx, r);
  });

  test('+30 dots → place', async () => {
    const before = pointer(fx);
    const version = Number(meta(fx, 'map_version') ?? 0);
    const added = addSongs(fx, 30);
    const r = await runWorker(fx);
    const c = assertOk(r, 'place');
    assert.deepEqual([c.layoutId, c.placed, c.fitted, c.removed, c.hitCap], [before.active_layout, 30, 0, 0, false]);
    assert.equal(r.fitTotal, null, 'a place run fits nothing');
    const p = assertServing(fx);
    assert.equal(p.active_layout, before.active_layout);
    assert.ok(p.rev > before.rev, 'the serving generation changed in place');
    assert.equal(Number(meta(fx, 'map_version')), version + 1, 'the region update bumped map_version');
    const L = layoutRow(fx, p.active_layout);
    assert.deepEqual([L.n_points, L.dirty], [630, 0]);
    const pts = new Map(points(fx, p.active_layout).map((pt) => [pt.audio_hash, pt]));
    for (const h of added) { assert.equal(pts.get(h).placed, 'knn'); }
    assertFinite([...pts.values()]);
    const provinces = regions(fx, p.active_layout).filter((g) => g.level === 0);
    assert.equal(provinces.reduce((s, g) => s + g.size, 0), c.dots);
    assertSafe(fx, r);
  });

  test('+100 dots seven hours after the fit → a warm refit within the old p95 bound', async (t) => {
    const before = pointer(fx);
    const old = layoutRow(fx, before.active_layout);
    const oldPts = new Map(points(fx, old.id).map((pt) => [pt.audio_hash, pt]));
    const oldHues = new Map(regions(fx, old.id).filter((g) => g.level === 0).map((g) => [g.key, g.hue]));
    addSongs(fx, 100);
    const r = await runWorker(fx, {}, { env: { MSTREAM_TEST_MAP_NOW_MS: String(old.fitted_at + 7 * HOUR) } });
    const c = assertOk(r, 'refit');
    assert.deepEqual([c.method, c.fitted, c.nFitTried], ['umap', 730, 730]);
    const p = assertServing(fx);
    assert.notEqual(p.active_layout, old.id, 'a new layout id');
    const L = layoutRow(fx, p.active_layout);
    assert.equal(L.params.warmFrom, old.id);
    assert.equal(L.k, old.k, 'the same basis');
    assert.deepEqual(L.pca_axes, old.pca_axes);
    // Movement of the old songs, as a share of the old layout's diagonal
    // (the map-umap test's measure). The p95 bound is the plan's; p50 has
    // too thin a margin across runtimes to assert (map-umap.test.mjs pins
    // it on its own data), and the maximum is deliberately unbounded.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const o of oldPts.values()) {
      x0 = Math.min(x0, o.x); x1 = Math.max(x1, o.x); y0 = Math.min(y0, o.y); y1 = Math.max(y1, o.y);
    }
    const diag = Math.hypot(x1 - x0, y1 - y0);
    const moved = [];
    for (const pt of points(fx, p.active_layout)) {
      const o = oldPts.get(pt.audio_hash);
      if (o) { moved.push(Math.hypot(pt.x - o.x, pt.y - o.y) / diag); }
    }
    assert.equal(moved.length, 630);
    t.diagnostic(`old songs moved: p50 ${percentile(moved, 0.5).toFixed(4)}, p95 ${percentile(moved, 0.95).toFixed(4)} of the diagonal`);
    assert.ok(percentile(moved, 0.95) <= 0.08, `old-point p95 ${percentile(moved, 0.95).toFixed(4)} of the diagonal`);
    const regs = regions(fx, p.active_layout).filter((g) => g.level === 0);
    assert.deepEqual(regs.map((g) => g.key).sort(), PROVINCE_KEYS, 'genre keys hold by construction');
    for (const g of regs) { assert.equal(g.hue, oldHues.get(g.key), `${g.key} keeps its hue`); }
    assert.deepEqual(layoutIds(fx), [old.id, p.active_layout], 'the previous layout stays until the next run starts');
    assert.deepEqual(mirrorGenerations(fx), [p.active_layout], 'the old generation\'s mirror rows went after the flip');
    assertSafe(fx, r);
  });

  test('+800 dots (more than |P| = 730) → rebuild', async () => {
    const before = layoutRow(fx, pointer(fx).active_layout);
    addSongs(fx, 800);
    const r = await runWorker(fx);
    const c = assertOk(r, 'rebuild');
    assert.deepEqual([c.method, c.fitted], ['umap', 1530]);
    const p = assertServing(fx);
    const L = layoutRow(fx, p.active_layout);
    assert.equal(L.frame, before.frame + 1, 'a rebuild is a new frame');
    assert.equal(L.params.warmFrom, null);
    assert.deepEqual(layoutIds(fx), [before.id, p.active_layout]);
    assertSafe(fx, r);
  });
});

// ── the fit-set cap (perf guard 5) ───────────────────────────────────────────

describe('map-layout worker: the fit-set cap', () => {
  let fx;
  const env = { MSTREAM_TEST_MAP_FIT_FLOOR: '100' };
  const cap = { maxFitTracks: 200 };
  before(() => { fx = makeFixture(2); });
  after(() => closeFixture(fx));

  const fitCount = (id) => fx.ddb.prepare("SELECT COUNT(*) AS n FROM map_points WHERE layout_id = ? AND placed = 'fit'").get(id).n;

  test('600 dots → |F| = 200, the other 400 placed against it', async () => {
    addSongs(fx, 600);
    const r = await runWorker(fx, cap, { env });
    const c = assertOk(r, 'rebuild');
    assert.deepEqual([c.fitted, c.placed, c.nFitTried, c.hitCap], [200, 400, 200, false]);
    assert.equal(r.fitTotal, 200);
    const p = assertServing(fx);
    assert.equal(fitCount(p.active_layout), 200);
    assert.equal(layoutRow(fx, p.active_layout).n_fit, 200);
    assert.equal(layoutRow(fx, p.active_layout).params.nFitMax, 200);
    // The fit set is the 200 lowest hashes.
    const fit = fx.ddb.prepare("SELECT audio_hash FROM map_points WHERE layout_id = ? AND placed = 'fit' ORDER BY audio_hash").all(p.active_layout).map((x) => x.audio_hash);
    const all = points(fx, p.active_layout).map((x) => x.audio_hash);
    assert.deepEqual(fit, all.slice(0, 200));
    assertFinite(points(fx, p.active_layout));
    assertSafe(fx, r);
  });

  test('a refit with 300 new keeps |F| ≤ 200', async () => {
    const old = layoutRow(fx, pointer(fx).active_layout);
    addSongs(fx, 300);
    const r = await runWorker(fx, cap, { env: { ...env, MSTREAM_TEST_MAP_NOW_MS: String(old.fitted_at + 7 * HOUR) } });
    const c = assertOk(r, 'refit');
    assert.ok(c.fitted <= 200 && r.fitTotal <= 200, `fitted ${c.fitted}, fit total ${r.fitTotal}`);
    const p = assertServing(fx);
    assert.ok(fitCount(p.active_layout) <= 200);
    assert.equal(points(fx, p.active_layout).length, 900, 'every song positioned in one run');
    assertFinite(points(fx, p.active_layout));
    assertSafe(fx, r);
  });

  test('a place run fits nothing; a forced rebuild fits the cap again', async () => {
    addSongs(fx, 10);
    const placed = await runWorker(fx, cap, { env });
    assertOk(placed, 'place');
    assert.equal(placed.complete.fitted, 0);
    assert.equal(placed.fitTotal, null);
    const forced = await runWorker(fx, { ...cap, force: 'rebuild' }, { env });
    const c = assertOk(forced, 'rebuild');
    assert.equal(c.fitted, 200);
    assert.ok(fitCount(assertServing(fx).active_layout) <= 200);
    assertSafe(fx, forced);
  });
});

// ── landmarks that leave the library ─────────────────────────────────────────

describe('map-layout worker: landmarks that leave the library', () => {
  const fitRows = (fx, id) => fx.ddb.prepare("SELECT COUNT(*) AS n FROM map_points WHERE layout_id = ? AND placed = 'fit'").get(id).n;
  const removeSongs = (fx, hashes) => {
    const del = fx.mdb.prepare('DELETE FROM tracks WHERE audio_hash = ?');
    for (const h of hashes) { del.run(h); }
  };

  test('a fit set that leaves a little at a time is refitted before it erodes', async () => {
    const fx = makeFixture(12);
    try {
      const songs = addSongs(fx, 100);
      assertOk(await runWorker(fx), 'rebuild');
      const first = layoutRow(fx, pointer(fx).active_layout);
      assert.equal(first.n_fit, 100);
      const later = { env: { MSTREAM_TEST_MAP_NOW_MS: String(first.fitted_at + 7 * HOUR) } };
      // 10 % leave (under the per-pass 15 %): a place run prunes their landmarks.
      removeSongs(fx, songs.slice(0, 10));
      const pruned = await runWorker(fx, {}, later);
      assert.deepEqual([assertOk(pruned, 'place').removed, fitRows(fx, first.id)], [10, 90]);
      // 10 more (10 of the 90 left, still under 15 % per pass), but 20 % of the
      // fit set has now left since the fit: a refit restores a full fit set.
      removeSongs(fx, songs.slice(10, 20));
      const refitted = await runWorker(fx, {}, later);
      const c = assertOk(refitted, 'refit');
      assert.deepEqual([c.fitted, c.removed], [80, 10]);
      const p = assertServing(fx);
      assert.notEqual(p.active_layout, first.id);
      assert.deepEqual([layoutRow(fx, p.active_layout).n_fit, fitRows(fx, p.active_layout)], [80, 80]);
      assertSafe(fx, refitted);
    } finally { closeFixture(fx); }
  });

  test('when every landmark leaves within 6 h of the fit, a warm refit restores the fit set and keeps the survivors in place', async () => {
    const fx = makeFixture(13);
    try {
      const originals = addSongs(fx, 100);
      assertOk(await runWorker(fx), 'rebuild');
      addSongs(fx, 60);
      assertOk(await runWorker(fx), 'place');   // 60 placed against the 100 landmarks
      const old = layoutRow(fx, pointer(fx).active_layout);
      const oldPts = new Map(points(fx, old.id).map((pt) => [pt.audio_hash, pt]));
      removeSongs(fx, originals);
      const r = await runWorker(fx);
      const c = assertOk(r, 'refit');
      assert.deepEqual([c.method, c.fitted, c.placed, c.removed], ['umap', 60, 0, 100]);
      const p = assertServing(fx);
      const L = layoutRow(fx, p.active_layout);
      assert.equal(L.params.warmFrom, old.id, 'warm, from the old layout');
      assert.deepEqual(L.pca_axes, old.pca_axes, 'the same basis');
      assert.equal(fitRows(fx, p.active_layout), 60);
      // The 60 survivors stay where they were, as a share of the old
      // layout's diagonal (a cold rebuild moves them about 0.6 of it).
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const o of oldPts.values()) {
        x0 = Math.min(x0, o.x); x1 = Math.max(x1, o.x); y0 = Math.min(y0, o.y); y1 = Math.max(y1, o.y);
      }
      const diag = Math.hypot(x1 - x0, y1 - y0);
      const moved = points(fx, p.active_layout).map((pt) => Math.hypot(pt.x - oldPts.get(pt.audio_hash).x, pt.y - oldPts.get(pt.audio_hash).y) / diag);
      assert.equal(moved.length, 60);
      assert.ok(percentile(moved, 0.95) <= 0.2, `survivors moved p95 ${percentile(moved, 0.95).toFixed(4)} of the diagonal`);
      assertSafe(fx, r);
      // New songs still place: the layout has landmarks to measure against.
      addSongs(fx, 10);
      const placed = await runWorker(fx);
      assert.equal(assertOk(placed, 'place').placed, 10);
      assertServing(fx);
      assertSafe(fx, placed);
    } finally { closeFixture(fx); }
  });

  test('a layout with no landmarks left at all refits from its every point instead of failing', async () => {
    const fx = makeFixture(14);
    try {
      addSongs(fx, 100);
      assertOk(await runWorker(fx), 'rebuild');
      const old = pointer(fx).active_layout;
      // No pass leaves a umap layout without landmarks (a place run never
      // prunes a live one, and too few send the pass to a refit first), so
      // make one; the new songs join the fit set, starting from kNN
      // placements against the layout's points.
      fx.ddb.prepare("UPDATE map_points SET placed = 'knn' WHERE layout_id = ?").run(old);
      addSongs(fx, 10);
      const r = await runWorker(fx);
      const c = assertOk(r, 'refit');
      assert.deepEqual([c.fitted, c.placed, c.removed], [110, 0, 0]);
      const p = assertServing(fx);
      assert.equal(layoutRow(fx, p.active_layout).params.warmFrom, old);
      assert.equal(fitRows(fx, p.active_layout), 110);
      assertFinite(points(fx, p.active_layout));
      assertSafe(fx, r);
    } finally { closeFixture(fx); }
  });
});

// ── batches ──────────────────────────────────────────────────────────────────

describe('map-layout worker: placement batches', () => {
  let fx;
  before(() => { fx = makeFixture(3); });
  after(() => closeFixture(fx));

  test('placeMax 50 → hitCap, and repeated runs finish as place runs', async () => {
    addSongs(fx, 300);
    const env = { MSTREAM_TEST_MAP_FIT_FLOOR: '100', MSTREAM_TEST_MAP_PLACE_MAX: '50' };
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const r = await runWorker(fx, { maxFitTracks: 100 }, { env });
      assertOk(r);
      assertSafe(fx, r);
      runs.push([r.complete.mode, r.complete.fitted, r.complete.placed, r.complete.hitCap]);
      if (!r.complete.hitCap && r.complete.mode === 'mirror') { break; }
    }
    // The capped rebuild's catch-up stays in place mode: the library did
    // not double, the rebuild just placed part of it.
    assert.deepEqual(runs, [
      ['rebuild', 100, 50, true],
      ['place', 0, 50, true],
      ['place', 0, 50, true],
      ['place', 0, 50, false],
      ['mirror', 0, 0, false],
    ]);
    const p = assertServing(fx);
    assert.equal(points(fx, p.active_layout).length, 300);
    assert.equal(layoutRow(fx, p.active_layout).n_points, 300);
  });
});

// ── a model switch ───────────────────────────────────────────────────────────

describe('map-layout worker: a model switch', () => {
  let fx;
  before(() => { fx = makeFixture(4); });
  after(() => closeFixture(fx));

  test('the old layout serves until settled, then a rebuild under the new model keeps keys and hues', async () => {
    addSongs(fx, 200);
    assertOk(await runWorker(fx), 'rebuild');
    const before = pointer(fx);
    const oldRegions = regions(fx, before.active_layout).filter((g) => g.level === 0);
    const mirrorBefore = mirrorRows(fx, before.active_layout).length;
    // Half the library re-embedded under the new model so far (split on
    // the hash, which says nothing about the genre).
    fx.ddb.exec("UPDATE discovery_tracks SET model_id = 'model-b' WHERE substr(audio_hash, 1, 1) < '8'");
    const nB = fx.ddb.prepare("SELECT COUNT(*) AS n FROM discovery_tracks WHERE model_id = 'model-b'").get().n;
    assert.ok(nB >= 60 && nB < 0.9 * 200, `${nB} re-embedded: under the 90 % rule, enough for a umap rebuild`);

    const pending = await runWorker(fx, { model: 'model-b' });
    assertOk(pending, 'mirror');
    assert.deepEqual(pointer(fx), before, 'the old layout keeps serving, the mirror unchanged');
    assert.equal(layoutRow(fx, before.active_layout).model_id, 'test-fake');
    assert.equal(mirrorRows(fx, before.active_layout).length, mirrorBefore);
    assertSafe(fx, pending);

    const settled = await runWorker(fx, { model: 'model-b', settled: true });
    const c = assertOk(settled, 'rebuild');
    assert.equal(c.method, 'umap');
    const p = assertServing(fx);
    assert.notEqual(p.active_layout, before.active_layout);
    assert.equal(layoutRow(fx, p.active_layout).model_id, 'model-b');
    assert.equal(points(fx, p.active_layout).length, nB, 'built from the new model\'s vectors');
    const now = regions(fx, p.active_layout).filter((g) => g.level === 0);
    assert.deepEqual(now.map((g) => g.key).sort(), oldRegions.map((g) => g.key).sort(), 'genre keys kept');
    for (const g of now) { assert.equal(g.hue, oldRegions.find((o) => o.key === g.key).hue, `${g.key} keeps its hue`); }
    assertSafe(fx, settled);
  });
});

// ── dirty ────────────────────────────────────────────────────────────────────

describe('map-layout worker: an interrupted place run', () => {
  let fx;
  before(() => { fx = makeFixture(5); });
  after(() => closeFixture(fx));

  test('killed at its regions phase it leaves dirty = 1; the rerun recomputes regions and land', async () => {
    addSongs(fx, 120);
    assertOk(await runWorker(fx), 'rebuild');
    const id = pointer(fx).active_layout;
    const landBefore = regions(fx, id).filter((g) => g.level === 0).map((g) => Buffer.from(g.land).toString('hex'));
    const version = Number(meta(fx, 'map_version') ?? 0);
    addSongs(fx, 40);
    const killed = await runWorker(fx, {}, { killAt: 'regions' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(layoutRow(fx, id).dirty, 1, 'point chunks are ahead of the region update');
    assert.equal(points(fx, id).length, 160);
    assert.equal(regions(fx, id).filter((g) => g.level === 0).reduce((s, g) => s + g.size, 0), 120, 'regions are stale');
    assert.equal(Number(meta(fx, 'map_version') ?? 0), version, 'nothing the routes read changed yet');

    const r = await runWorker(fx);
    const c = assertOk(r, 'place');
    assert.equal(c.placed, 0);
    assert.equal(layoutRow(fx, id).dirty, 0);
    assert.equal(regions(fx, id).filter((g) => g.level === 0).reduce((s, g) => s + g.size, 0), 160, 'region sizes recomputed');
    const landAfter = regions(fx, id).filter((g) => g.level === 0).map((g) => Buffer.from(g.land).toString('hex'));
    assert.notDeepEqual(landAfter, landBefore, 'land recomputed');
    assert.equal(Number(meta(fx, 'map_version')), version + 1);
    assertServing(fx);
    assertSafe(fx, r);
  });
});

// ── the hash-transition applier beside a place run ───────────────────────────

describe('map-layout worker: the hash-transition applier beside a place run', () => {
  test('a point the applier re-keys after the inventory read is never pruned; the regions catch up next run', async () => {
    const fx = makeFixture(16);
    try {
      const songs = addSongs(fx, 100);
      assertOk(await runWorker(fx), 'rebuild');
      const id = pointer(fx).active_layout;
      const oldHash = songs[0];
      const newHash = `${oldHash.slice(0, 24)}ffffffff`;
      const before = points(fx, id).find((pt) => pt.audio_hash === oldHash);
      assert.equal(before.placed, 'fit');
      // The scan's half of a re-key: the track carries the new hash while the
      // vector and the point still carry the old one, so the run's inventory
      // takes the song for a gone one and plans to prune its point.
      fx.mdb.prepare('UPDATE tracks SET audio_hash = ? WHERE audio_hash = ?').run(newHash, oldHash);
      let seqAfterApply = null;
      const r = await runWorker(fx, {}, {
        pauseAt: 'write',
        // The applier's half, while the run waits to write: the vector and
        // the point follow the track. (The queue never lets this happen; the
        // worker's conditional delete is the backstop.)
        whilePaused: () => {
          initDiscoveryDb(fx.discoveryDbPath);
          try {
            const moved = applyHashTransitionGroups([{ target: newHash, sources: [oldHash] }]);
            assert.deepEqual([moved.moved, moved.pointsMoved], [1, 1]);
          } finally { closeDiscoveryDb(); }
          seqAfterApply = meta(fx, 'row_seq');
        },
      });
      const c = assertOk(r, 'place');
      assert.deepEqual([c.removed, c.placed], [0, 0]);
      const after = points(fx, id);
      assert.equal(after.length, 100);
      assert.equal(after.some((pt) => pt.audio_hash === oldHash), false);
      assert.deepEqual({ ...after.find((pt) => pt.audio_hash === newHash), audio_hash: oldHash }, { ...before },
        'the point lives on under the new hash, unmoved and still a landmark');
      assert.deepEqual([layoutRow(fx, id).n_points, layoutRow(fx, id).dirty], [100, 1],
        'the regions were computed without that dot, so dirty stays for the next run');
      assertServing(fx);
      assert.equal(meta(fx, 'row_seq'), seqAfterApply, 'the map run itself never touches row_seq');
      // The next run recomputes the regions from the points.
      const rerun = await runWorker(fx);
      const c2 = assertOk(rerun, 'place');
      assert.deepEqual([c2.removed, c2.placed, c2.dots], [0, 0, 100]);
      assert.equal(layoutRow(fx, id).dirty, 0);
      assert.equal(regions(fx, id).filter((g) => g.level === 0).reduce((n, g) => n + g.size, 0), 100, 'every dot counted again');
      assertServing(fx);
    } finally { closeFixture(fx); }
  });
});

// ── recovery ─────────────────────────────────────────────────────────────────

describe('map-layout worker: recovery at start', () => {
  let fx;
  before(() => { fx = makeFixture(6); });
  after(() => closeFixture(fx));

  test('a kill before the flip: the old layout serves; the next run deletes the unflipped one', async () => {
    addSongs(fx, 80);
    assertOk(await runWorker(fx), 'rebuild');
    const before = pointer(fx);
    const killed = await runWorker(fx, { force: 'rebuild' }, { killAt: 'mirror' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.deepEqual(pointer(fx), before, 'the pointer never moved');
    const ids = layoutIds(fx);
    assert.equal(ids.length, 2, 'the new layout was written, unflipped');
    assert.deepEqual(mirrorGenerations(fx), [before.active_layout]);
    const r = await runWorker(fx);
    assertOk(r, 'mirror');
    assert.deepEqual(layoutIds(fx), [before.active_layout]);
    assert.deepEqual(pointer(fx), before);
    assertServing(fx);
    assertSafe(fx, r);
  });

  test('a kill after the flip: the new layout serves; the old rows go at the next start', async () => {
    const before = pointer(fx);
    const killed = await runWorker(fx, { force: 'rebuild' }, {
      killAt: 'flip', killWhen: () => pointer(fx).active_layout !== before.active_layout,
    });
    assert.equal(killed.signal, 'SIGKILL');
    const flipped = assertServing(fx);
    assert.notEqual(flipped.active_layout, before.active_layout);
    assert.deepEqual(layoutIds(fx), [before.active_layout, flipped.active_layout]);
    assert.deepEqual(mirrorGenerations(fx), [before.active_layout, flipped.active_layout], 'the old generation was not deleted yet');
    const r = await runWorker(fx);
    assertOk(r, 'mirror');
    assert.deepEqual(layoutIds(fx), [flipped.active_layout]);
    assert.deepEqual(mirrorGenerations(fx), [flipped.active_layout]);
    assert.equal(pointer(fx).active_layout, flipped.active_layout);
    assertSafe(fx, r);
  });

  test('a layout left building and orphaned rows are deleted', async () => {
    const serving = pointer(fx).active_layout;
    const building = Number(fx.ddb.prepare(`
      INSERT INTO map_layouts (state, model_id, method, params, dim, k, pca_mean, pca_axes, affine, frame, aspect,
                               land_levels, n_fit, n_points, created_at, fitted_at)
      VALUES ('building', 'test-fake', 'umap', '{}', 64, 1, x'', x'', '[1,0,0,0,1,0]', 1, 1, '{}', 0, 0, 0, 0)`).run().lastInsertRowid);
    const insPoint = fx.ddb.prepare(`INSERT INTO map_points (layout_id, audio_hash, dot, x, y, placed, region0, region1, central0, central1, pca)
                                     VALUES (?, ?, ?, 0.5, 0.5, 'fit', 0, 0, 0, 0, x'')`);
    insPoint.run(building, 'b1', 'b1');
    insPoint.run(9999, 'o1', 'o1');
    fx.ddb.prepare(`INSERT INTO map_regions (layout_id, level, id, key, hue, x, y, anchor_x, anchor_y, extent, size, mix)
                    VALUES (9999, 0, 0, 'g:Orphan', 0, 0, 0, 0, 0, 0, 0, '[]')`).run();
    const r = await runWorker(fx);
    assertOk(r, 'mirror');
    assert.deepEqual(layoutIds(fx), [serving]);
    assert.equal(fx.ddb.prepare('SELECT COUNT(*) AS n FROM map_points WHERE layout_id <> ?').get(serving).n, 0);
    assert.equal(fx.ddb.prepare('SELECT COUNT(*) AS n FROM map_regions WHERE layout_id <> ?').get(serving).n, 0);
    assertSafe(fx, r);
  });

  test('a pointer with a stale map_epoch adopts the newest ready layout and writes its generation', async () => {
    const before = pointer(fx);
    // An mstream.db restored from before the last reset: an epoch these
    // tables never had, and no mirror rows.
    fx.mdb.exec("UPDATE track_map_meta SET map_epoch = 'stale0000000000'");
    fx.mdb.exec('DELETE FROM track_map');
    const r = await runWorker(fx);
    assertOk(r, 'mirror');
    const p = assertServing(fx);
    assert.equal(p.active_layout, before.active_layout, 'adopted');
    assert.equal(p.map_epoch, meta(fx, 'map_epoch'));
    assert.ok(p.rev > before.rev);
    assert.equal(mirrorRows(fx, p.active_layout).length, 80);
    assertSafe(fx, r);
  });
});

// ── the memory guard ─────────────────────────────────────────────────────────

describe('map-layout worker: the memory guard', () => {
  let fx;
  before(() => { fx = makeFixture(7); });
  after(() => closeFixture(fx));

  test('MSTREAM_TEST_MAP_FORCE_GUARD → exit 5 with nFitTried on the error event, nothing written', async () => {
    addSongs(fx, 60);
    const r = await runWorker(fx, {}, { env: { MSTREAM_TEST_MAP_FORCE_GUARD: '1' } });
    assert.equal(r.code, 5, r.stderr);
    assert.equal(r.error.nFitTried, 60);
    assert.match(r.error.message, /memory guard/);
    assert.equal(r.complete, null);
    assert.deepEqual(layoutIds(fx), []);
    assert.equal(pointer(fx).active_layout, null);
    assertSafe(fx, r);
  });
});

// ── under Bun ────────────────────────────────────────────────────────────────

describe('bun', { skip: noBun }, () => {
  let fx;
  before(() => { fx = makeFixture(8); });
  after(() => closeFixture(fx));

  test('the rebuild and place cases under Bun (bun:sqlite)', async () => {
    addSongs(fx, 120);
    const rebuilt = await runWorker(fx, {}, { bin: BUN_BIN });
    const c = assertOk(rebuilt, 'rebuild');
    assert.deepEqual([c.method, c.fitted], ['umap', 120]);
    const p = assertServing(fx);
    assertFinite(points(fx, p.active_layout));
    assert.equal(layoutRow(fx, p.active_layout).params.runtime, 'bun');
    assert.deepEqual(regions(fx, p.active_layout).filter((g) => g.level === 0).map((g) => g.key).sort(), PROVINCE_KEYS);
    assertSafe(fx, rebuilt);

    const added = addSongs(fx, 20);
    const placed = await runWorker(fx, {}, { bin: BUN_BIN });
    const pc = assertOk(placed, 'place');
    assert.deepEqual([pc.layoutId, pc.placed], [p.active_layout, 20]);
    const pts = new Map(points(fx, p.active_layout).map((pt) => [pt.audio_hash, pt]));
    for (const h of added) { assert.equal(pts.get(h).placed, 'knn'); }
    assertServing(fx);
    assertSafe(fx, placed);
  });
});
