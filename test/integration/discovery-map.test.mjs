/**
 * The music map routes — src/api/discovery-map.js (docs/music-map-plan.md
 * §3.8, §3.12) — against real spawned servers.
 *
 * Four servers:
 *   off     discovery off (default config)                → 403 on all six
 *   mapOff  discovery on, scanOptions.musicMap false       → 403, flag 0
 *   seed    discovery on (test-fake), federation on, the fixture library plus
 *           `lib2`; the map tables, a track_map generation and its pointer
 *           are written DIRECTLY through test handles, so every route is
 *           tested on its own, independent of the worker
 *   worker  the same libraries; the map is built by the real worker through
 *           POST /api/v1/admin/discovery/map/rebuild and polled on
 *           /api/v1/scan/status — the end-to-end path
 *
 * lib2 = six short sine tracks (the "Jazz" cluster) plus a byte copy of the
 * fixture's Be Somebody (same audio, so the same hash and the same dot).
 * Users: admin sees both libraries, bob testlib only, carol lib2 only — so
 * the shared dot's representative is the lower copy id for admin, the
 * testlib copy for bob and the lib2 copy for carol.
 *
 * Every track is under 30 s, below the discovery pass's window: no
 * embedding pass races the seeding, and the boot drain forks no map worker
 * (no vectors exist yet). Vectors are handcrafted 8-d unit vectors: the
 * testlib tracks (and the copy) form one cluster ('Rock---Indie Rock'), the
 * lib2-only tracks another ('Jazz---Hard Bop').
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { ensureFixtures } from '../helpers/fixtures.mjs';
import {
  decodePointsColsV1, decodeLandV1, encodeLandV1, quantU16, bitsetGet, MAP_FLAG_RECENT,
} from '../../src/db/map-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'admin', password: 'pw-admin' };   // testlib + lib2
const BOB = { username: 'bob', password: 'pw-bob' };         // testlib only
const CAROL = { username: 'carol', password: 'pw-carol' };   // lib2 only
const USERS = [
  { ...ADMIN, admin: true, vpaths: ['testlib', 'lib2'] },
  { ...BOB, admin: false, vpaths: ['testlib'] },
  { ...CAROL, admin: false, vpaths: ['lib2'] },
];

const MAP = '/api/v1/discovery/map';
const OVERLAY = '/api/v1/discovery/map/overlay';
const TRACKS = '/api/v1/discovery/map/tracks';
const SEARCH = '/api/v1/discovery/map/search';
const REGION = '/api/v1/discovery/map/region';
const NEIGHBOURS = '/api/v1/discovery/map/neighbours';

const JAZZ = [
  { file: 'j1.mp3', title: 'Blue Hour', freq: 500 },
  { file: 'j2.mp3', title: 'Smoke Ring', freq: 560 },
  { file: 'j3.mp3', title: 'Late Set', freq: 620 },
  { file: 'j4.mp3', title: 'Bop City', freq: 680 },
  { file: 'j5.mp3', title: 'Night Owl', freq: 740 },
  { file: 'j6.mp3', title: 'Last Call', freq: 800 },
];

// ── handcrafted vectors (8-d, unit) ─────────────────────────────────────────
function unit(...xs) {
  let s = 0;
  for (const x of xs) { s += x * x; }
  const n = Math.sqrt(s);
  return Float32Array.from(xs, (x) => x / n);
}
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const ROCK = ['Rock---Indie Rock'];
const JAZZ_TAGS = ['Jazz---Hard Bop'];
// Cosines to Be Somebody: Static 0.998 (never placed), Rise 0.972, Return
// 0.891, Descent 0.876, Highway 0.844, Neon 0.809, Sketch 1 0.773, Orbit
// 0.696, every Jazz track ~0. Distinct songs stay under the 0.99
// near-duplicate bound except Static, which the worker never sees placed.
const VECTORS = {
  'testlib:Be Somebody': [unit(1, 0, 0.35, 0, 0, 0, 0, 0), ROCK],
  'testlib:Static': [unit(1, 0, 0.30, 0.05, 0, 0, 0, 0), ROCK],
  'testlib:Rise': [unit(1, 0, 0.2, 0.2, 0, 0, 0, 0), ROCK],
  'testlib:Return': [unit(1, 0, 0, 0.35, 0, 0, 0, 0), ROCK],
  'testlib:Descent': [unit(1, 0, 0, 0, 0.4, 0, 0, 0), ROCK],
  'testlib:Highway': [unit(1, 0, 0, 0, 0, 0.5, 0, 0), ROCK],
  'testlib:Neon': [unit(1, 0, 0, 0, 0, 0, 0.6, 0), ROCK],
  'testlib:Sketch 1': [unit(1, 0, 0, 0, 0, 0, 0, 0.7), ROCK],
  'testlib:Orbit': [unit(1, 0, -0.5, 0, 0, 0, 0, 0), ROCK],
  'lib2:Blue Hour': [unit(0, 1, 0.35, 0, 0, 0, 0, 0), JAZZ_TAGS],
  'lib2:Smoke Ring': [unit(0, 1, 0, 0.35, 0, 0, 0, 0), JAZZ_TAGS],
  'lib2:Late Set': [unit(0, 1, 0, 0, 0.35, 0, 0, 0), JAZZ_TAGS],
  'lib2:Bop City': [unit(0, 1, 0, 0, 0, 0.35, 0, 0), JAZZ_TAGS],
  'lib2:Night Owl': [unit(0, 1, 0, 0, 0, 0, 0.35, 0), JAZZ_TAGS],
  'lib2:Last Call': [unit(0, 1, 0, 0, 0, 0, 0, 0.35), JAZZ_TAGS],
};

let offServer;      // discovery off
let mapOffServer;   // discovery on, musicMap off
let seedServer;     // the map written directly
let workerServer;   // the map built by the worker
let lib2Dir;
const tokens = { seed: {}, worker: {} };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`))));
  });
}

async function call(server, method, route, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) { h['Content-Type'] = 'application/json'; }
  if (token) { h['x-access-token'] = token; }
  const r = await fetch(`${server.baseUrl}${route}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, body: json };
}
const getMap = (server, token, headers) => call(server, 'GET', MAP, { token, headers });
const getOverlay = (server, token, params) => call(server, 'GET', `${OVERLAY}?${new URLSearchParams(params)}`, { token });
const post = (server, route, body, token) => call(server, 'POST', route, { body, token });

function decodePoints(body) {
  const bytes = Buffer.from(body.points.data, 'base64');
  return decodePointsColsV1(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), body.points.n);
}
const b64Bytes = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};

function openMain(server, { readOnly = false } = {}) {
  const h = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), readOnly ? { readOnly: true } : {});
  if (!readOnly) { h.exec('PRAGMA busy_timeout = 5000'); }
  return h;
}
function openDiscovery(server) {
  const h = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
  h.exec('PRAGMA busy_timeout = 5000');
  return h;
}

// Every library track, keyed '<library>:<title>' (the lib2 copy of Be
// Somebody is 'lib2:Be Somebody').
function readTracks(server) {
  const mdb = openMain(server, { readOnly: true });
  try {
    const out = {};
    for (const r of mdb.prepare(`
      SELECT t.id AS id, t.title AS title, t.filepath AS filepath, l.name AS lib,
             COALESCE(t.audio_hash, t.file_hash) AS hash
        FROM tracks t JOIN libraries l ON l.id = t.library_id
    `).all()) {
      out[`${r.lib}:${r.title}`] = { ...r, path: `${r.lib}/${r.filepath.replace(/\\/g, '/')}` };
    }
    return out;
  } finally { mdb.close(); }
}

function seedVectors(server, keys) {
  const T = readTracks(server);
  const ddb = openDiscovery(server);
  try {
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, NULL, ?, 1, 'test-fake', '1', ?, ?)
      ON CONFLICT(audio_hash) DO UPDATE SET embedding = excluded.embedding, model_id = excluded.model_id
    `);
    let seq = Number(ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'row_seq'").get()?.value ?? 0);
    for (const key of keys) {
      const t = T[key];
      assert.ok(t?.hash, `track '${key}' must exist with a hash`);
      const [v, tags] = VECTORS[key];
      ins.run(t.hash, ++seq, `anon:map-${seq}`, t.title, blob(v), JSON.stringify(tags));
    }
    // The batch-writer contract: move the rowversion AND publish the index
    // epoch, so the similarity index sees the rows on its next request.
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('index_epoch', ?)").run(`map-${seq}`);
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally { ddb.close(); }
}

async function login(server, user) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user),
  });
  assert.equal(r.status, 200, `login ${user.username}`);
  return (await r.json()).token;
}

// A jukebox session token for `token`'s user (the WebSocket handshake hands
// it out); the socket must stay open while the token is used.
async function openJukebox(server, token) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${token}`);
    ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
    ws.on('error', reject);
  });
}

// The map pass's /scan/status entry once it has finished a run after
// `after` (ms) and is neither queued nor running.
async function waitForMapPass(server, token, after = 0, timeoutMs = 120_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const r = await call(server, 'GET', '/api/v1/scan/status', { token });
    if (r.status === 200) {
      last = r.body.enrichment.find((p) => p.pass === 'map') ?? null;
      if (last?.lastRun && last.lastRun.finishedAt > after && last.state !== 'running' && last.state !== 'queued') {
        return last;
      }
    }
    await sleep(100);
  }
  throw new Error(`the map pass did not finish within ${timeoutMs} ms; last seen: ${JSON.stringify(last)}`);
}

// Before a server stops: let a running map worker finish (Windows rmSync
// hits EBUSY on a live worker's files).
async function settleMapPass(server, token, timeoutMs = 60_000) {
  if (!server) { return; }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await call(server, 'GET', '/api/v1/scan/status', { token }).catch(() => null);
    const pass = r?.body?.enrichment?.find((p) => p.pass === 'map');
    if (!pass || (pass.state !== 'running' && pass.state !== 'queued')) { return; }
    await sleep(200);
  }
}

before(async () => {
  const musicDir = await ensureFixtures();
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-map-lib2-'));
  for (const j of JAZZ) {
    await runFfmpeg([
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${j.freq}:duration=2`,
      '-metadata', 'artist=Zed Quartet', '-metadata', `title=${j.title}`, '-metadata', 'album=Smoke Rooms',
      '-ac', '1', path.join(lib2Dir, j.file),
    ]);
  }
  // Same bytes, so the same audio hash: one dot with a member per library.
  fs.copyFileSync(path.join(musicDir, 'Icarus', 'Be Somebody', '01 - Be Somebody.mp3'), path.join(lib2Dir, 'bs-copy.mp3'));

  const mapConfig = {
    scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
    // On, so a minted key reaches the wall (api-server-info.test.mjs:94).
    federation: { enabled: true },
  };
  [offServer, mapOffServer, seedServer, workerServer] = await Promise.all([
    startServer({ dlnaMode: 'disabled', waitForScan: false }),
    startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: { scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake', musicMap: false } },
    }),
    startServer({ dlnaMode: 'disabled', extraConfig: mapConfig, extraFolders: { lib2: lib2Dir }, users: USERS }),
    startServer({ dlnaMode: 'disabled', extraConfig: mapConfig, extraFolders: { lib2: lib2Dir }, users: USERS }),
  ]);
  for (const [name, server] of [['seed', seedServer], ['worker', workerServer]]) {
    for (const u of [ADMIN, BOB, CAROL]) { tokens[name][u.username] = await login(server, u); }
  }
  // The seed server gets every vector now (Static included: a vector with
  // no point). The worker server gets its own in its suite, so the gate
  // suite can see it empty first.
  seedVectors(seedServer, Object.keys(VECTORS));
});

after(async () => {
  await settleMapPass(workerServer, tokens.worker.admin);
  await Promise.all([offServer?.stop(), mapOffServer?.stop(), seedServer?.stop(), workerServer?.stop()]);
  if (lib2Dir) { fs.rmSync(lib2Dir, { recursive: true, force: true }); }
});

// ── gates, flags and states before any map exists ───────────────────────────

const SIX = [
  ['GET', MAP, undefined],
  ['GET', `${OVERLAY}?layer=mood&rev=x`, undefined],
  ['POST', TRACKS, { ids: [1] }],
  ['POST', SEARCH, { q: 'neon' }],
  ['POST', REGION, { key: 'g:Rock' }],
  ['POST', NEIGHBOURS, { id: 1 }],
];

describe('music map: gates and flags', () => {
  test('403 on all six while discovery is off', async () => {
    for (const [method, route, body] of SIX) {
      const r = await call(offServer, method, route, { body });
      assert.equal(r.status, 403, `${method} ${route}`);
      assert.equal(r.body.error, 'Discovery is disabled');
    }
  });

  test('403 on all six while scanOptions.musicMap is off — and the flag reads 0', async () => {
    for (const [method, route, body] of SIX) {
      const r = await call(mapOffServer, method, route, { body });
      assert.equal(r.status, 403, `${method} ${route}`);
      assert.equal(r.body.error, 'Discovery is disabled');
    }
    const api = await call(mapOffServer, 'GET', '/api/');
    assert.equal(api.body.features.discovery, true);
    assert.equal(api.body.features.discoveryMap, 0);
    assert.equal((await call(mapOffServer, 'GET', '/api/v1/ping')).body.discoveryMap, 0);
  });

  test('the flag is 1 on ping and /api/ while the map is on', async () => {
    const api = await call(seedServer, 'GET', '/api/', { token: tokens.seed.bob });
    assert.equal(api.body.features.discoveryMap, 1);
    const ping = await call(seedServer, 'GET', '/api/v1/ping', { token: tokens.seed.bob });
    assert.equal(ping.body.discoveryMap, 1);
    // A version fact: on with discovery off too; clients gate on both.
    const off = await call(offServer, 'GET', '/api/');
    assert.equal(off.body.features.discovery, false);
    assert.equal(off.body.features.discoveryMap, 1);
  });

  test('the auth wall answers first: 401 without a token', async () => {
    assert.equal((await getMap(seedServer)).status, 401);
    assert.equal((await post(seedServer, TRACKS, { ids: [1] })).status, 401);
  });

  test('validation: 400 on bad bodies and queries', async () => {
    const t = tokens.seed.admin;
    for (const [route, body] of [
      [TRACKS, {}],
      [TRACKS, { ids: [1], filepaths: ['testlib/x.mp3'] }],
      [TRACKS, { ids: [] }],
      [TRACKS, { ids: [0] }],
      [TRACKS, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
      [TRACKS, { ids: [1], extra: true }],
      [SEARCH, { q: 'a' }],
      [SEARCH, { q: '  a  ' }],
      [SEARCH, { q: 'x'.repeat(129) }],
      [REGION, {}],
      [REGION, { key: 'g:Rock', limit: 51 }],
      [NEIGHBOURS, { id: 1, limit: 17 }],
      [NEIGHBOURS, {}],
    ]) {
      const r = await post(seedServer, route, body, t);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body).slice(0, 60)}`);
    }
    for (const params of [
      { layer: 'mood' },
      { layer: 'heat', rev: 'x' },
      { layer: 'mood', rev: 'x'.repeat(33) },
      { layer: 'mood', rev: 'x', moods: '{"energy":' },
      { layer: 'mood', rev: 'x', moods: '{"energy":"sleepy"}' },
      { layer: 'mood', rev: 'x', surprise: '1' },
    ]) {
      const r = await getOverlay(seedServer, t, params);
      assert.equal(r.status, 400, JSON.stringify(params));
    }
  });

  test('vectors but no layout yet: building, with an ETag of its own', async () => {
    const r = await getMap(seedServer, tokens.seed.admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'building');
    assert.equal(r.body.model, null);
    assert.equal(r.body.layout, null);
    assert.deepEqual(r.body.regions, []);
    assert.deepEqual(r.body.points, { n: 0, format: 'cols-v1', data: '' });
    assert.match(r.body.rev, /^[0-9a-f]{16}$/);
    assert.equal(r.headers.get('etag'), `"${r.body.rev}"`);
    assert.equal(r.headers.get('cache-control'), 'private, no-cache');
    const again = await getMap(seedServer, tokens.seed.admin, { 'If-None-Match': `"${r.body.rev}"` });
    assert.equal(again.status, 304);
  });

  test('no vectors and nothing analysed: empty', async () => {
    const r = await getMap(workerServer, tokens.worker.admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'empty');
    assert.equal(r.body.layout, null);
  });

  test('no layout: lookups answer empty, regions and seeds 404, ids still render', async () => {
    const t = tokens.seed.admin;
    const T = readTracks(seedServer);
    assert.deepEqual((await post(seedServer, SEARCH, { q: 'neon' }, t)).body, { ids: [], best: null, capped: false });
    assert.equal((await post(seedServer, REGION, { key: 'g:Rock' }, t)).status, 404);
    assert.equal((await post(seedServer, NEIGHBOURS, { id: T['testlib:Neon'].id }, t)).status, 404);
    const paths = await post(seedServer, TRACKS, { filepaths: [T['testlib:Neon'].path] }, t);
    assert.deepEqual(paths.body, { ids: [null] });
    const rows = await post(seedServer, TRACKS, { ids: [T['testlib:Neon'].id] }, t);
    assert.equal(rows.body.tracks[0].metadata.title, 'Neon', 'an id lookup needs no layout');
  });
});

// ── the map written directly: every route on its own ────────────────────────

// The direct layout. Dots in walk/centrality order; every member row carries
// its dot's values. Static has a vector and no point.
const ROCK_DOTS = [
  { name: 'D1', members: ['testlib:Be Somebody', 'lib2:Be Somebody'], xy: [0.20, 0.30], c: -0.10 },
  { name: 'D4', members: ['testlib:Return', 'testlib:Descent'], xy: [0.25, 0.32], c: -0.15 },
  { name: 'D2', members: ['testlib:Rise'], xy: [0.22, 0.40], c: -0.20 },
  { name: 'D3', members: ['testlib:Orbit'], xy: [0.30, 0.35], c: -0.30 },
  { name: 'D5', members: ['testlib:Highway'], xy: [0.18, 0.45], c: -0.50 },
  { name: 'D6', members: ['testlib:Neon'], xy: [0.28, 0.48], c: -0.60 },
  { name: 'D7', members: ['testlib:Sketch 1'], xy: [0.33, 0.42], c: -0.70 },
];
const JAZZ_DOTS = JAZZ.map((j, i) => ({
  name: `J${i + 1}`, members: [`lib2:${j.title}`], xy: [0.70 + 0.03 * i, 0.60 + 0.02 * i], c: -0.1 * (i + 1),
}));

const ring = (pts) => pts.flatMap(([x, y]) => [quantU16(x), quantU16(y)]);
const square = (x0, y0, x1, y1) => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

describe('music map: routes on a directly seeded layout', () => {
  let T;          // tracks by '<lib>:<title>'
  let dots;       // name → { label, ids, lib per id, u16 xy, r0, r1, c }
  let layoutId;
  const visibleLibs = { admin: ['testlib', 'lib2'], bob: ['testlib'], carol: ['lib2'] };

  // The representative a user should see for a dot, or undefined.
  const repFor = (user, d) => {
    let rep;
    for (const k of d.members) {
      if (visibleLibs[user].includes(k.split(':')[0]) && (rep === undefined || T[k].id < rep)) { rep = T[k].id; }
    }
    return rep;
  };
  const allDots = () => [...ROCK_DOTS, ...JAZZ_DOTS].map((d) => dots[d.name]);

  before(() => {
    T = readTracks(seedServer);
    dots = {};
    for (const [list, r] of [[ROCK_DOTS, 0], [JAZZ_DOTS, 1]]) {
      for (const d of list) {
        const hashes = d.members.map((k) => T[k].hash);
        dots[d.name] = {
          ...d,
          label: [...hashes].sort()[0],
          u16: [quantU16(d.xy[0]), quantU16(d.xy[1])],
          r0: r, r1: r,
        };
      }
    }

    const ddb = openDiscovery(seedServer);
    const mdb = openMain(seedServer);
    try {
      const now = Date.now();
      const zeros = (n) => Buffer.alloc(4 * n);
      layoutId = Number(ddb.prepare(`
        INSERT INTO map_layouts (state, model_id, model_version, method, params, dim, k, pca_mean, pca_axes,
                                 affine, frame, aspect, land_levels, n_fit, n_points, dirty, created_at, fitted_at)
        VALUES ('ready', 'test-fake', '1', 'pca2', '{"layoutVersion":1}', 8, 2, ?, ?,
                '[1,0,0,0,1,0]', 3, 1.25, '{"sigma":0.02,"coast":0.45,"mid":1,"high":2}', 13, 13, 0, ?, ?)
      `).run(zeros(8), zeros(16), now, now).lastInsertRowid);

      const land = (x0, y0, x1, y1) => Buffer.from(encodeLandV1([
        [square(x0, y0, x1, y1)],
        [square(x0 + 0.02, y0 + 0.02, x1 - 0.02, y1 - 0.02)],
        [square(x0 + 0.04, y0 + 0.04, x1 - 0.04, y1 - 0.04)],
      ]));
      const labels = (names) => JSON.stringify(names.map((n) => dots[n].label));
      const insRegion = ddb.prepare(`
        INSERT INTO map_regions (layout_id, level, id, key, parent, label, style, hue, x, y, anchor_x, anchor_y, extent, size, mix, land)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.1, ?, ?, ?)
      `);
      // The province's mix names three dots: the route tops up the rest by centrality.
      insRegion.run(layoutId, 0, 0, 'g:Rock', null, 'Rock', 'Rock', 200, 0.25, 0.4, 0.22, 0.38, 7,
        labels(['D1', 'D4', 'D2']), land(0.1, 0.2, 0.4, 0.55));
      insRegion.run(layoutId, 0, 1, 'g:Jazz', null, 'Jazz', 'Jazz', 300, 0.77, 0.65, 0.76, 0.64, 6,
        labels(JAZZ_DOTS.map((d) => d.name)), land(0.6, 0.5, 0.95, 0.8));
      insRegion.run(layoutId, 1, 0, 't:0', 0, 'Indie Rock', 'Rock---Indie Rock', 200, 0.25, 0.4, 0.22, 0.38, 7,
        labels(ROCK_DOTS.map((d) => d.name)), null);
      // Walk order is the worker's, not the centrality order: reversed here.
      insRegion.run(layoutId, 1, 1, 't:1', 1, 'Hard Bop', 'Jazz---Hard Bop', 300, 0.77, 0.65, 0.76, 0.64, 6,
        labels(JAZZ_DOTS.map((d) => d.name).reverse()), null);

      const insRow = mdb.prepare(`
        INSERT INTO track_map (layout_id, track_id, hash, dot, x, y, region0, region1, central0, central1)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      mdb.exec('BEGIN IMMEDIATE');
      for (const d of allDots()) {
        for (const k of d.members) {
          insRow.run(layoutId, T[k].id, T[k].hash, d.label, d.u16[0], d.u16[1], d.r0, d.r1, d.c, d.c);
        }
      }
      mdb.exec('COMMIT');
      // Be Somebody's testlib copy arrived long ago; its lib2 copy now.
      mdb.prepare("UPDATE tracks SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(T['testlib:Be Somebody'].id);
      const addedMax = mdb.prepare(`
        SELECT MAX(t.created_at) AS m FROM track_map m JOIN tracks t ON t.id = m.track_id WHERE m.layout_id = ?
      `).get(layoutId).m;
      // The baseline the worker sets at the first flip: nothing rings yet,
      // and the rev holds still across midnight.
      ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('map_recent_after', ?)").run(addedMax);
      const epoch = ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'map_epoch'").get().value;
      mdb.prepare('UPDATE track_map_meta SET active_layout = ?, map_epoch = ?, rev = rev + 1, added_max = ? WHERE id = 1')
        .run(layoutId, epoch, addedMax);

      // Moods (the overlay and /db/recent/added must agree) and plays.
      const mood = mdb.prepare('INSERT INTO track_moods (track_id, relaxed, aggressive, happy, sad) VALUES (?, ?, ?, ?, ?)');
      for (const [k, relaxed, aggressive] of [
        ['testlib:Be Somebody', 0.9, 0.1], ['lib2:Be Somebody', 0.9, 0.1], ['testlib:Rise', 0.2, 0.8],
        ['testlib:Return', 0.8, 0.1], ['testlib:Descent', 0.3, 0.6], ['lib2:Blue Hour', 0.95, 0.05],
        ['lib2:Smoke Ring', 0.4, 0.7],
      ]) {
        mood.run(T[k].id, relaxed, aggressive, 0.5, 0.2);
      }
      const uid = (name) => mdb.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
      const play = mdb.prepare('INSERT INTO user_metadata (user_id, track_hash, play_count) VALUES (?, ?, ?)');
      for (const [k, n] of [
        ['testlib:Be Somebody', 3], ['testlib:Return', 2], ['testlib:Descent', 5], ['testlib:Rise', 300],
        ['lib2:Blue Hour', 1], ['testlib:Static', 9],
      ]) {
        play.run(uid('admin'), T[k].hash, n);
      }
      play.run(uid('bob'), T['lib2:Blue Hour'].hash, 4);
      play.run(uid('bob'), T['testlib:Be Somebody'].hash, 1);
    } finally {
      ddb.close();
      mdb.close();
    }
  });

  // Every point of `body` is `user`'s view of one seeded dot.
  function assertView(body, user) {
    const expected = allDots()
      .map((d) => ({ d, id: repFor(user, d) }))
      .filter((e) => e.id !== undefined)
      .sort((a, b) => a.id - b.id);
    const p = decodePoints(body);
    assert.deepEqual([...p.ids], expected.map((e) => e.id), `${user}: one point per visible dot, ascending ids`);
    for (let i = 0; i < expected.length; i++) {
      const { d } = expected[i];
      assert.deepEqual([p.x[i], p.y[i], p.region0[i], p.region1[i]], [...d.u16, d.r0, d.r1], `${user}: ${d.name}`);
    }
    return p;
  }

  test('GET /map: the shape, the layout block and the points (admin)', async () => {
    const r = await getMap(seedServer, tokens.seed.admin);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.state, 'ready');
    assert.deepEqual(b.model, { id: 'test-fake', version: '1' });
    assert.deepEqual(b.layout, { id: layoutId, method: 'pca2', frame: 3, aspect: 1.25, landFormat: 'land-v1' });
    assert.equal(b.points.format, 'cols-v1');
    assert.equal(b.points.n, 13);
    assert.equal(r.headers.get('etag'), `"${b.rev}"`);
    assert.equal(r.headers.get('cache-control'), 'private, no-cache');
    assert.match(r.headers.get('content-type'), /application\/json/);
    const p = assertView(b, 'admin');
    assert.ok(p.flags.every((f) => (f & MAP_FLAG_RECENT) === 0), 'nothing newer than the baseline');

    assert.deepEqual(b.regions.map((x) => [x.key, x.level, x.id, x.parent, x.label, x.hue, x.size]), [
      ['g:Rock', 0, 0, null, 'Rock', 200, 7],
      ['g:Jazz', 0, 1, null, 'Jazz', 300, 6],
      ['t:0', 1, 0, 0, 'Indie Rock', 200, 7],
      ['t:1', 1, 1, 1, 'Hard Bop', 300, 6],
    ]);
    const rock = b.regions[0];
    assert.deepEqual(rock.anchor, [quantU16(0.22), quantU16(0.38)]);
    const levels = decodeLandV1(b64Bytes(rock.land));
    assert.equal(levels.length, 3, 'coast, mid, high');
    assert.deepEqual([...levels[0][0]], square(0.1, 0.2, 0.4, 0.55));
    assert.ok(!('land' in b.regions[2]), 'towns carry no land');
  });

  test('the shared dot: the lower copy for admin, the testlib copy for bob, the lib2 copy for carol', async () => {
    const bs = T['testlib:Be Somebody'].id;
    const copy = T['lib2:Be Somebody'].id;
    const ids = async (user) => [...decodePoints((await getMap(seedServer, tokens.seed[user])).body).ids];
    assert.ok((await ids('admin')).includes(Math.min(bs, copy)));
    assert.ok(!(await ids('admin')).includes(Math.max(bs, copy)), 'one point for both copies');
    assert.ok((await ids('bob')).includes(bs));
    assert.ok((await ids('carol')).includes(copy));
    assert.ok(!(await ids('carol')).includes(bs));
  });

  test('bob sees no lib2 dot and only Rock\'s regions; carol only what lib2 holds', async () => {
    const bob = await getMap(seedServer, tokens.seed.bob);
    const lib2Ids = new Set(Object.values(T).filter((t) => t.lib === 'lib2').map((t) => t.id));
    const p = assertView(bob.body, 'bob');
    assert.ok([...p.ids].every((id) => !lib2Ids.has(id)), 'no lib2 id reaches bob');
    assert.deepEqual(bob.body.regions.map((x) => [x.key, x.size]), [['g:Rock', 7], ['t:0', 7]]);

    const carol = await getMap(seedServer, tokens.seed.carol);
    assertView(carol.body, 'carol');
    assert.deepEqual(carol.body.regions.map((x) => [x.key, x.size]), [['g:Rock', 1], ['g:Jazz', 6], ['t:0', 1], ['t:1', 6]],
      'a province seen in part keeps its land but counts only visible dots');
    assert.ok(carol.body.regions[0].land, 'its coast shapes are the library-wide ones');

    const admin = await getMap(seedServer, tokens.seed.admin);
    assert.notEqual(bob.body.rev, admin.body.rev, 'different grants, different revs');
  });

  test('ETag: 304 for a matching If-None-Match, before anything is built', async () => {
    const first = await getMap(seedServer, tokens.seed.bob);
    const tag = first.headers.get('etag');
    const again = await getMap(seedServer, tokens.seed.bob, { 'If-None-Match': tag });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), tag);
    assert.equal(again.headers.get('cache-control'), 'private, no-cache');
    const listed = await getMap(seedServer, tokens.seed.bob, { 'If-None-Match': `"nope", W/${tag}` });
    assert.equal(listed.status, 304, 'a list with a weak copy of our tag matches');
    const stale = await getMap(seedServer, tokens.seed.bob, { 'If-None-Match': '"0000000000000000"' });
    assert.equal(stale.status, 200);
  });

  test('two users with the same libraries share the tag and the bytes', async () => {
    // bob and the admin differ; a jukebox session of bob sees bob's libraries.
    const juke = await openJukebox(seedServer, tokens.seed.bob);
    try {
      const a = await getMap(seedServer, tokens.seed.bob);
      const b = await getMap(seedServer, juke.token);
      assert.equal(b.status, 200, 'a jukebox session may read the map');
      assert.equal(b.headers.get('etag'), a.headers.get('etag'));
      assert.equal(b.body.points.data, a.body.points.data);
    } finally { juke.ws.close(); }
  });

  test('mood overlay: the bitset equals membership in /db/recent/added {moods}', async () => {
    for (const user of ['admin', 'bob', 'carol']) {
      const token = tokens.seed[user];
      const map = (await getMap(seedServer, token)).body;
      const ids = [...decodePoints(map).ids];
      const moods = { energy: 'relaxed' };
      const r = await getOverlay(seedServer, token, { layer: 'mood', rev: map.rev, moods: JSON.stringify(moods) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.rev, map.rev);
      assert.equal(r.body.layer, 'mood');
      assert.equal(r.body.n, ids.length);
      assert.deepEqual(r.body.moods, moods, 'the applied filter is echoed');
      const bits = b64Bytes(r.body.data);
      assert.equal(bits.length, Math.ceil(ids.length / 8));

      const list = await post(seedServer, '/api/v1/db/recent/added', { limit: 1000, moods }, token);
      assert.equal(list.status, 200);
      const byPath = new Map(Object.values(T).map((t) => [t.path, t.id]));
      const kept = new Set(list.body.map((row) => byPath.get(row.filepath)));
      for (let i = 0; i < ids.length; i++) {
        assert.equal(bitsetGet(bits, i), kept.has(ids[i]) ? 1 : 0, `${user}: point ${i} (id ${ids[i]})`);
      }
      if (user === 'admin') {
        assert.ok(ids.some((id, i) => bitsetGet(bits, i) === 1) && ids.some((id, i) => bitsetGet(bits, i) === 0),
          'the filter keeps some dots and dims others');
      }
    }
  });

  test('mood overlay: no filter is all ones with an empty echo', async () => {
    const map = (await getMap(seedServer, tokens.seed.admin)).body;
    const r = await getOverlay(seedServer, tokens.seed.admin, { layer: 'mood', rev: map.rev });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moods, {});
    const bits = b64Bytes(r.body.data);
    for (let i = 0; i < map.points.n; i++) { assert.equal(bitsetGet(bits, i), 1); }
  });

  test('plays overlay: summed per dot, capped at 255, invisible dots skipped', async () => {
    const check = async (user, expected) => {
      const map = (await getMap(seedServer, tokens.seed[user])).body;
      const ids = [...decodePoints(map).ids];
      const r = await getOverlay(seedServer, tokens.seed[user], { layer: 'plays', rev: map.rev });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.layer, 'plays');
      assert.equal(r.body.n, ids.length);
      const data = b64Bytes(r.body.data);
      assert.equal(data.length, ids.length);
      const got = {};
      for (let i = 0; i < ids.length; i++) { if (data[i]) { got[ids[i]] = data[i]; } }
      assert.deepEqual(got, expected, user);
    };
    const rep = (name, user) => repFor(user, dots[name]);
    await check('admin', {
      [rep('D1', 'admin')]: 3,
      [rep('D4', 'admin')]: 7,     // Return 2 + Descent 5: near-duplicates are summed
      [rep('D2', 'admin')]: 255,   // 300 plays
      [rep('J1', 'admin')]: 1,
      // Static's 9 plays: no dot, no byte.
    });
    await check('bob', { [rep('D1', 'bob')]: 1 });   // his Blue Hour plays sit on a dot he cannot see
    await check('carol', {});

    // End to end: a play recorded through the stats API heats its dot, and
    // the map's own rev does not move (no per-user data in it).
    const before = (await getMap(seedServer, tokens.seed.carol)).body.rev;
    const rec = await post(seedServer, '/api/v1/stats/plays', {
      plays: [{
        id: 'map-plays-1', filePath: T['lib2:Late Set'].path, startedAt: new Date(Date.now() - 60_000).toISOString(),
        playedMs: 2000, durationMs: 2000, outcome: 'completed',
      }],
    }, tokens.seed.carol);
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal((await getMap(seedServer, tokens.seed.carol)).body.rev, before);
    await check('carol', { [rep('J3', 'carol')]: 1 });
  });

  test('overlay: 409 on a stale rev; plays refused to a jukebox session, moods allowed', async () => {
    const r = await getOverlay(seedServer, tokens.seed.admin, { layer: 'mood', rev: 'deadbeefdeadbeef' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'Map changed');
    const juke = await openJukebox(seedServer, tokens.seed.bob);
    try {
      const map = (await getMap(seedServer, juke.token)).body;
      const plays = await getOverlay(seedServer, juke.token, { layer: 'plays', rev: map.rev });
      assert.equal(plays.status, 403);
      assert.match(plays.body.error, /jukebox session/);
      const mood = await getOverlay(seedServer, juke.token, { layer: 'mood', rev: map.rev });
      assert.equal(mood.status, 200);
    } finally { juke.ws.close(); }
  });

  test('tracks: ids → lite rows, aligned; no leak across libraries', async () => {
    const neon = T['testlib:Neon'].id;
    const blue = T['lib2:Blue Hour'].id;
    const ids = [neon, blue, 999999, neon];
    const admin = await post(seedServer, TRACKS, { ids }, tokens.seed.admin);
    assert.equal(admin.status, 200);
    assert.equal(admin.body.tracks.length, 4);
    assert.equal(admin.body.tracks[0].id, neon);
    assert.equal(admin.body.tracks[0].filepath, T['testlib:Neon'].path);
    assert.equal(admin.body.tracks[0].metadata.title, 'Neon');
    assert.ok(!('hash' in admin.body.tracks[0].metadata), 'lite metadata');
    assert.equal(admin.body.tracks[1].metadata.title, 'Blue Hour');
    assert.equal(admin.body.tracks[2], null, 'unknown');
    assert.deepEqual(admin.body.tracks[3], admin.body.tracks[0], 'duplicates repeat');

    const bob = await post(seedServer, TRACKS, { ids }, tokens.seed.bob);
    assert.equal(bob.body.tracks[0].metadata.title, 'Neon');
    assert.equal(bob.body.tracks[1], null, 'a lib2 id is the same null as an unknown one for bob');
    assert.equal(bob.body.tracks[2], null);
  });

  test('tracks: filepaths → representative ids, with or without a leading slash', async () => {
    const neon = T['testlib:Neon'];
    const copy = T['lib2:Be Somebody'];
    const paths = [neon.path, `/${neon.path}`, copy.path, T['testlib:Static'].path, 'testlib/nope/missing.mp3', T['testlib:Descent'].path];
    const admin = await post(seedServer, TRACKS, { filepaths: paths }, tokens.seed.admin);
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.ids, [
      neon.id, neon.id,
      repFor('admin', dots.D1),    // the lib2 copy maps to its dot's representative
      null,                        // Static: a vector, no point
      null,                        // no such file
      repFor('admin', dots.D4),    // a near-duplicate member maps to its dot's
    ]);
    const carol = await post(seedServer, TRACKS, { filepaths: [copy.path, neon.path] }, tokens.seed.carol);
    assert.deepEqual(carol.body.ids, [copy.id, null], 'carol\'s representative is her copy; testlib is not hers');
  });

  test('search: titles, artists and albums, as visible representative ids', async () => {
    const reps = (user, names) => names.map((n) => repFor(user, dots[n])).sort((a, b) => a - b);
    const run = async (q, user) => {
      const r = await post(seedServer, SEARCH, { q }, tokens.seed[user]);
      assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    assert.deepEqual(await run('Neon', 'admin'), { ids: reps('admin', ['D6']), best: repFor('admin', dots.D6), capped: false });
    assert.deepEqual(await run('Icarus', 'admin'), { ids: reps('admin', ['D1', 'D2', 'D3', 'D4']), best: null, capped: false },
      'an artist: its songs as dots (Return and Descent share one)');
    assert.deepEqual(await run('Night Drive', 'admin'), { ids: reps('admin', ['D5', 'D6']), best: null, capped: false },
      'an album: Static matches too but has no dot');
    assert.deepEqual(await run('smoke', 'admin'),
      { ids: reps('admin', JAZZ_DOTS.map((d) => d.name)), best: repFor('admin', dots.J2), capped: false },
      'album "Smoke Rooms" plus the title "Smoke Ring", which is the best match');
    assert.deepEqual(await run('smoke', 'bob'), { ids: [], best: null, capped: false }, 'nothing of lib2 for bob');
    assert.deepEqual(await run('Icarus', 'carol'), { ids: [T['lib2:Be Somebody'].id], best: null, capped: false });
    assert.deepEqual(await run('Ic', 'admin'), { ids: [], best: null, capped: false },
      'artists and albums start at three characters');
    assert.deepEqual((await run('  neon ', 'admin')).ids, reps('admin', ['D6']), 'the query is trimmed');
  });

  test('region: centre and mix only visible, walk order kept, topped up by centrality', async () => {
    const lite = (rows) => rows.map((r) => r.id);
    const admin = await post(seedServer, REGION, { key: 'g:Rock' }, tokens.seed.admin);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.deepEqual(admin.body.region, { key: 'g:Rock', level: 0, label: 'Rock' });
    assert.equal(admin.body.centre.id, repFor('admin', dots.D1));
    assert.equal(admin.body.centre.metadata.title, 'Be Somebody');
    assert.ok(admin.body.centre.filepath);
    assert.deepEqual(lite(admin.body.songs), ['D1', 'D4', 'D2', 'D3', 'D5', 'D6', 'D7'].map((n) => repFor('admin', dots[n])),
      'the stored mix (D1, D4, D2) first, then the rest by centrality');
    assert.ok(admin.body.songs.every((s) => s.metadata && s.filepath), 'rows queue without translation');

    const two = await post(seedServer, REGION, { key: 'g:Rock', limit: 2 }, tokens.seed.admin);
    assert.deepEqual(lite(two.body.songs), [repFor('admin', dots.D1), repFor('admin', dots.D4)]);

    const town = await post(seedServer, REGION, { key: 't:1' }, tokens.seed.admin);
    assert.equal(town.body.centre.id, repFor('admin', dots.J1), 'the most central');
    assert.deepEqual(lite(town.body.songs), JAZZ_DOTS.map((d) => repFor('admin', d)).reverse(), 'the walk order, not the centrality order');

    const carol = await post(seedServer, REGION, { key: 'g:Rock' }, tokens.seed.carol);
    assert.equal(carol.body.centre.id, T['lib2:Be Somebody'].id);
    assert.deepEqual(lite(carol.body.songs), [T['lib2:Be Somebody'].id]);

    for (const [key, user] of [['g:Jazz', 'bob'], ['t:1', 'bob'], ['g:Nope', 'admin']]) {
      const r = await post(seedServer, REGION, { key }, tokens.seed[user]);
      assert.equal(r.status, 404, `${user} ${key}`);
      assert.equal(r.body.error, 'Region not found');
    }
  });

  test('neighbours: distinct placed dots, the seed excluded, an unplaced candidate skipped', async () => {
    const admin = await post(seedServer, NEIGHBOURS, { id: T['testlib:Be Somebody'].id, limit: 6 }, tokens.seed.admin);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.notAnalyzed, false);
    assert.equal(admin.body.seed.id, T['testlib:Be Somebody'].id);
    assert.equal(admin.body.seed.metadata.title, 'Be Somebody');
    // Static ranks first (cos 0.998) but has no point; Descent shares D4 with Return.
    assert.deepEqual(admin.body.neighbours.map((n) => n.id), ['D2', 'D4', 'D5', 'D6', 'D7', 'D3'].map((n) => repFor('admin', dots[n])));
    assert.equal(admin.body.capped, false);
    const sims = admin.body.neighbours.map((n) => n.similarity);
    assert.deepEqual(sims, [...sims].sort((a, b) => b - a), 'rank order');
    assert.ok(sims.every((s) => Number.isFinite(s) && Math.round(s * 10000) / 10000 === s), 'four places');
    assert.ok(admin.body.neighbours.every((n) => n.metadata && n.filepath));

    // carol's seed is her copy of the same dot; only lib2's dots answer.
    const carol = await post(seedServer, NEIGHBOURS, { id: T['lib2:Be Somebody'].id }, tokens.seed.carol);
    assert.equal(carol.status, 200);
    assert.deepEqual(new Set(carol.body.neighbours.map((n) => n.id)), new Set(JAZZ_DOTS.map((d) => repFor('carol', d))));
    assert.equal(carol.body.capped, false, 'the pool ran dry; the budget did not stop it');

    assert.equal((await post(seedServer, NEIGHBOURS, { id: T['lib2:Blue Hour'].id }, tokens.seed.bob)).status, 404, 'invisible seed');
    assert.equal((await post(seedServer, NEIGHBOURS, { id: T['testlib:Static'].id }, tokens.seed.admin)).status, 404, 'seed with no dot');
    assert.equal((await post(seedServer, NEIGHBOURS, { id: 999999 }, tokens.seed.admin)).status, 404);
  });

  test('a federation key gets 403 on all six (and on the admin rebuild)', async () => {
    const mint = await post(seedServer, '/api/v1/admin/federation/keys', { name: 'map-peer', vpaths: ['testlib'] }, tokens.seed.admin);
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    const key = mint.body.key;
    for (const [method, route, body] of [...SIX, ['POST', '/api/v1/admin/discovery/map/rebuild', {}]]) {
      const r = await call(seedServer, method, route, { body, headers: { 'x-federation-key': key } });
      assert.equal(r.status, 403, `${method} ${route}`);
      assert.equal(r.body.error, 'Forbidden');
    }
  });

  test('the ETag follows the pointer\'s rev, map_version and a stale epoch', async () => {
    const tag = async () => (await getMap(seedServer, tokens.seed.admin)).headers.get('etag');
    const t0 = await tag();
    const mdb = openMain(seedServer);
    const ddb = openDiscovery(seedServer);
    try {
      mdb.prepare('UPDATE track_map_meta SET rev = rev + 1 WHERE id = 1').run();
      const t1 = await tag();
      assert.notEqual(t1, t0, 'a worker write to the serving generation');
      ddb.prepare("INSERT INTO discovery_meta (key, value) VALUES ('map_version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
      const t2 = await tag();
      assert.notEqual(t2, t1, 'a place-mode region update');

      const epoch = mdb.prepare('SELECT map_epoch FROM track_map_meta WHERE id = 1').get().map_epoch;
      mdb.prepare("UPDATE track_map_meta SET map_epoch = 'stale-epoch' WHERE id = 1").run();
      const stale = await getMap(seedServer, tokens.seed.admin);
      assert.equal(stale.body.state, 'building', 'a pointer from other map tables is never served');
      assert.equal(stale.body.layout, null);
      mdb.prepare('UPDATE track_map_meta SET map_epoch = ? WHERE id = 1').run(epoch);
      const back = await getMap(seedServer, tokens.seed.admin);
      assert.equal(back.body.state, 'ready');
      assert.equal(back.headers.get('etag'), t2, 'the same state, the same tag');
    } finally { mdb.close(); ddb.close(); }
  });

  test('recent rings: after the baseline and the 30-day cutoff, by the copy the caller sees', async () => {
    const ddb = openDiscovery(seedServer);
    let baseline;
    try {
      baseline = ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'map_recent_after'").get().value;
      ddb.prepare("UPDATE discovery_meta SET value = '2000-01-01 00:00:00' WHERE key = 'map_recent_after'").run();
    } finally { ddb.close(); }
    try {
      const flagsOf = async (user) => {
        const b = (await getMap(seedServer, tokens.seed[user])).body;
        const p = decodePoints(b);
        return new Map([...p.ids].map((id, i) => [id, p.flags[i] & MAP_FLAG_RECENT]));
      };
      const admin = await flagsOf('admin');
      assert.equal(admin.get(repFor('admin', dots.D1)), 0, 'its testlib copy arrived in 2020: older than the cutoff');
      assert.equal(admin.get(repFor('admin', dots.D6)), MAP_FLAG_RECENT, 'scanned today');
      const carol = await flagsOf('carol');
      assert.equal(carol.get(T['lib2:Be Somebody'].id), MAP_FLAG_RECENT, 'carol only ever saw the new copy');
    } finally {
      const back = openDiscovery(seedServer);
      try { back.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'map_recent_after'").run(baseline); } finally { back.close(); }
    }
  });

  // Last: it removes a seeded track for good.
  test('a deleted track cascades out of the mirror and moves the ETag with no worker write', async () => {
    const before = await getMap(seedServer, tokens.seed.admin);
    const sketch = T['testlib:Sketch 1'].id;
    assert.ok([...decodePoints(before.body).ids].includes(sketch));
    const mdb = openMain(seedServer);
    try {
      mdb.exec('PRAGMA foreign_keys = ON');
      mdb.prepare('DELETE FROM tracks WHERE id = ?').run(sketch);
      assert.equal(mdb.prepare('SELECT COUNT(*) AS n FROM track_map WHERE track_id = ?').get(sketch).n, 0, 'the FK cascade');
    } finally { mdb.close(); }
    const afterDelete = await getMap(seedServer, tokens.seed.admin, { 'If-None-Match': before.headers.get('etag') });
    assert.equal(afterDelete.status, 200, 'the old tag no longer matches');
    assert.notEqual(afterDelete.headers.get('etag'), before.headers.get('etag'));
    assert.equal(afterDelete.body.points.n, before.body.points.n - 1);
    assert.ok(![...decodePoints(afterDelete.body).ids].includes(sketch));
    assert.equal(afterDelete.body.regions.find((x) => x.key === 'g:Rock').size, 6);
  });
});

// ── the map built by the worker (end to end) ────────────────────────────────

describe('music map: a layout built by the worker', () => {
  let T;
  const bsIds = () => [T['testlib:Be Somebody'].id, T['lib2:Be Somebody'].id];

  before(async () => {
    T = readTracks(workerServer);
    // Every vector but Static's: it gets one after the build, so it is
    // embedded but never placed.
    seedVectors(workerServer, Object.keys(VECTORS).filter((k) => k !== 'testlib:Static'));
    const status = await call(workerServer, 'GET', '/api/v1/scan/status', { token: tokens.worker.admin });
    const prior = status.body.enrichment.find((p) => p.pass === 'map')?.lastRun?.finishedAt ?? 0;
    const r = await post(workerServer, '/api/v1/admin/discovery/map/rebuild', {}, tokens.worker.admin);
    assert.equal(r.status, 200, `rebuild: ${r.status} ${JSON.stringify(r.body)}`);
    const pass = await waitForMapPass(workerServer, tokens.worker.admin, prior);
    assert.equal(pass.lastRun.outcome, 'completed', JSON.stringify(pass));
  });

  test('the pass reports a pca2 rebuild', async () => {
    const r = await call(workerServer, 'GET', '/api/v1/scan/status', { token: tokens.worker.bob });
    const pass = r.body.enrichment.find((p) => p.pass === 'map');
    assert.equal(pass.lastRun.counts.mode, 'rebuild');
    assert.equal(pass.lastRun.counts.method, 'pca2');
  });

  test('GET /map: two genre provinces with land, towns under them, every dot decodable', async () => {
    const r = await getMap(workerServer, tokens.worker.admin);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.state, 'ready');
    assert.equal(b.model.id, 'test-fake');
    assert.equal(b.layout.method, 'pca2');
    assert.equal(b.layout.landFormat, 'land-v1');
    const provinces = b.regions.filter((x) => x.level === 0);
    assert.deepEqual(provinces.map((x) => x.key).sort(), ['g:Jazz', 'g:Rock']);
    for (const pr of provinces) {
      assert.equal(decodeLandV1(b64Bytes(pr.land)).length, 3, `${pr.key} land decodes`);
      assert.ok(Number.isInteger(pr.hue) && pr.hue >= 0 && pr.hue < 360);
    }
    const provinceIds = new Set(provinces.map((x) => x.id));
    for (const town of b.regions.filter((x) => x.level === 1)) {
      assert.ok(provinceIds.has(town.parent), `${town.key} sits in a province`);
    }
    const p = decodePoints(b);
    assert.equal(p.ids.length, 14, '8 Rock dots (the two copies share one) + 6 Jazz; Static unplaced');
    assert.deepEqual([...p.ids], [...p.ids].sort((a, b2) => a - b2));
    for (let i = 0; i < p.ids.length; i++) {
      assert.ok(provinceIds.has(p.region0[i]), 'every dot in a province');
    }
    const [bs, copy] = bsIds();
    assert.ok(p.ids.includes(Math.min(bs, copy)) && !p.ids.includes(Math.max(bs, copy)), 'one dot for both copies');
    assert.ok(!p.ids.includes(T['testlib:Static'].id));
  });

  test('bob: only testlib dots, and Rock with its towns', async () => {
    const b = (await getMap(workerServer, tokens.worker.bob)).body;
    const lib2Ids = new Set(Object.values(T).filter((t) => t.lib === 'lib2').map((t) => t.id));
    const p = decodePoints(b);
    assert.equal(p.ids.length, 8);
    assert.ok([...p.ids].every((id) => !lib2Ids.has(id)));
    assert.ok(p.ids.includes(T['testlib:Be Somebody'].id));
    const rock = b.regions.find((x) => x.key === 'g:Rock');
    assert.ok(rock, 'Rock is visible to bob');
    assert.ok(b.regions.every((x) => x.key === 'g:Rock' || (x.level === 1 && x.parent === rock.id)),
      `only Rock and its towns: ${b.regions.map((x) => x.key)}`);
  });

  test('ETag: 304 on revalidation', async () => {
    const first = await getMap(workerServer, tokens.worker.admin);
    const again = await getMap(workerServer, tokens.worker.admin, { 'If-None-Match': first.headers.get('etag') });
    assert.equal(again.status, 304);
  });

  test('lookups agree with the payload', async () => {
    const [bs, copy] = bsIds();
    const paths = await post(workerServer, TRACKS, { filepaths: [T['lib2:Be Somebody'].path] }, tokens.worker.admin);
    assert.deepEqual(paths.body.ids, [Math.min(bs, copy)], 'the lib2 copy maps to its dot\'s representative');
    const rock = await post(workerServer, REGION, { key: 'g:Rock' }, tokens.worker.bob);
    assert.equal(rock.status, 200);
    assert.ok(rock.body.songs.length > 0 && rock.body.songs.length <= 50);
    assert.equal((await post(workerServer, REGION, { key: 'g:Jazz' }, tokens.worker.bob)).status, 404, 'invisible to bob');
    const search = await post(workerServer, SEARCH, { q: 'Neon' }, tokens.worker.admin);
    assert.deepEqual(search.body, { ids: [T['testlib:Neon'].id], best: T['testlib:Neon'].id, capped: false });
  });

  test('neighbours skip a ranked candidate that has a vector but no point', async () => {
    seedVectors(workerServer, ['testlib:Static']);   // cos 0.998 to the seed, never placed
    const r = await post(workerServer, NEIGHBOURS, { id: T['testlib:Be Somebody'].id, limit: 5 }, tokens.worker.admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.neighbours.map((n) => n.id);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, 'distinct dots');
    const [bs, copy] = bsIds();
    assert.ok(!ids.includes(T['testlib:Static'].id), 'Static has no point');
    assert.ok(!ids.includes(bs) && !ids.includes(copy), 'the seed\'s dot is excluded');
    assert.equal(ids[0], T['testlib:Rise'].id, 'Rise is the nearest placed song');
  });
});
