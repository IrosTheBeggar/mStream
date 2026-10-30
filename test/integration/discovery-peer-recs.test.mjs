/**
 * The Peer Recommendations page's server half, end to end with no sidecar:
 *
 *   GET  /api/v1/discovery/p2p/peers                 the peer strip (members read it)
 *   POST /api/v1/admin/discovery/p2p/peer-dbs/add    the async Add (admins)
 *   POST /api/v1/admin/discovery/p2p/peer-dbs/fetch  the admin panel's sync fetch, as an Add
 *   POST /api/v1/discovery/taste                     generation 3: networkPeers,
 *                                                    networkOnRandomSeed, network.reason,
 *                                                    peer.label and tile on leads
 *   features.discoveryTaste 3 / discoveryP2pPeers 1   on /api/ and ping
 *
 * Contract: docs/peer-recommendations-plan.md §3. The numbered tests are its
 * §3.8 list, cases 1–23, in order.
 *
 * Strategy: real servers over the fixture library with discovery ON
 * ('test-fake', 4-d HANDCRAFTED vectors as in the taste suite), and the
 * whole network hand-staged BEFORE boot (test/helpers/p2p-shelf.mjs): peer
 * snapshot files, the shelf registry and the catalog in a state dir the
 * server is pointed at (extraConfig.storage), plus blobs a fake fetch
 * serves. Three test switches stand in for the network, so this runs in CI,
 * which has no sidecar binary:
 *   MSTREAM_TEST_P2P_NO_SIDECAR=1             nothing spawns, even on a machine
 *                                             that holds a binary (shelf.running
 *                                             stays false)
 *   MSTREAM_TEST_P2P_FAKE_FETCH_DIR           a download copies <hash>.db from a
 *                                             local dir (<hash>.delay-ms holds it
 *                                             open, <hash>.fail rejects it)
 *   MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS   one day, so a catalog written once
 *                                             reads online (heard now) or offline
 *                                             (two days ago) for the whole run
 * test/helpers/server.mjs keeps MSTREAM_SIDECAR_BASE dead as well.
 *
 * Servers:
 *   A  p2p on (autoFetch off), federation on (for a key to refuse), users
 *      admin / mia (member, two finished songs) / neo (member, no plays).
 *      Shelf (cap 10 MB, 8 MB held): Kitchen Radio K (online, 2 MB), 'mStream'
 *      M (offline, 1 MB), Quarry Q (another model, 1 MB), Attic Tapes OLD
 *      (unpinned, offline the longest, 4 MB). Catalog: those, plus K2 (K's
 *      name, 7 MB: no room until something goes), Lighthouse L (3 MB: one
 *      eviction, OLD; its songs are all owned here), Rooftop R (.fail),
 *      Static S (delay-ms), Dusty (offline, no seeders) and a blocked id. A
 *      second blocked id is in no catalog at all.
 *   B  p2p on, empty shelf (public mode).
 *   C  p2p off (public mode).
 *   D  admin, then lockAdmin (adminAccess 'none', flipped live).
 *   E  admin, then outside the IP gate (a whitelist without loopback).
 *   F  admin, a full shelf of one, for the two cases that end a server's
 *      run: a SIGKILL mid-Add with a reboot on the same state dir (15), and
 *      p2p switched off mid-download (16), which no-sidecar cannot undo.
 *
 * The A cases share one shelf and build on each other in file order.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import {
  stagePeers, stageFakeBlob, hashOf, shelfDir, registryPath,
} from '../helpers/p2p-shelf.mjs';
import { leadTile } from '../../src/state/discovery-peer-view.js';

const PEERS = '/api/v1/discovery/p2p/peers';
const ADD = '/api/v1/admin/discovery/p2p/peer-dbs/add';
const FETCH = '/api/v1/admin/discovery/p2p/peer-dbs/fetch';
const PIN = '/api/v1/admin/discovery/p2p/peer-dbs/pin';
const SHELF = '/api/v1/discovery/p2p/peer-dbs';
const TASTE = '/api/v1/discovery/taste';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// How long a delayed fake download stays open: long enough to watch it run.
const SLOW_MS = 3000;
const NOW = Date.now();
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Endpoint ids: 64 hex, distinct in their first 4 (the label suffix) and
// first 6 (the hue).
const id = (prefix) => prefix + prefix.slice(-1).repeat(64 - prefix.length);
const K = id('1a2b');
const K2 = id('2b3c');
const M = id('3f9a');
const Q = id('4c4d');
const OLD = id('5e5f');
const L = id('7a7b');
const R = id('8c8d');
const S = id('9e9f');
const DUSTY = id('b0b1');
const BLOCKED = id('dead');
const BLOCKED_UNHEARD = id('deaf');
const ATTIC = id('a7c0');
const UNKNOWN = 'ab'.repeat(32);

const P = {
  beSomebody: 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3',
  rise: 'testlib/Icarus/Be Somebody/02 - Rise.mp3',
  sketch: 'testlib/Vosto/Untitled EP/01 - Sketch 1.mp3',
};

// The library's vector space (the taste suite's): every fixture track but
// 'Sketch 1', the scan-pending song.
const LIBRARY_VECTORS = [
  ['Be Somebody', [1, 0, 0, 0]],
  ['Rise', [0.95, 0.312, 0, 0]],
  ['Orbit', [0.9, 0.436, 0, 0]],
  ['Return', [0.7, 0.714, 0, 0]],
  ['Descent', [0.6, 0.8, 0, 0]],
  ['Highway', [0, 1, 0, 0]],
  ['Static', [0.2, 0.98, 0, 0]],
  ['Neon', [0.5, 0.866, 0, 0]],
];

// Peer songs. The leads sit off the library's plane (a z part), so none is a
// near-duplicate of any seed, the random pick included.
const T = {
  signalFires: { artist: 'Paper Lantern', album: 'Night Ferry', title: 'Signal Fires', vec: [0.9, 0.3, 0.3, 0] },
  harborLights: { artist: 'Paper Lantern', album: 'Night Ferry', title: 'Harbor Lights', vec: [0.85, 0.3, 0.35, 0.1] },
  sundayWire: { artist: 'Okra Bloom', album: 'Porchlight', title: 'Sunday Wire', vec: [0.8, 0.4, 0.4, 0] },
  dustyReel: { artist: 'Attic Choir', album: 'Lofts', title: 'Dusty Reel', vec: [0.7, 0.5, 0.5, 0] },
  arcadeRain: { artist: 'Juniper Static', album: 'Neon Psalms', title: 'Arcade Rain', vec: [0.88, 0.2, 0.42, 0] },
  longExposure: { artist: 'Marlowe Fields', album: 'Daylight Savings', title: 'Long Exposure', vec: [0.86, 0.3, 0.4, 0.1] },
  otherSpace: { artist: 'Quarry Five', title: 'Other Space', vec: [1, 0, 0, 0] },
  // Songs this library owns: never a lead.
  rise: { artist: 'Icarus', album: 'Be Somebody', title: 'Rise', vec: [0.95, 0.312, 0, 0] },
  highway: { artist: 'Vosto', album: 'Night Drive', title: 'Highway', vec: [0, 1, 0, 0] },
};

const A_PEERS = [
  { id: K, name: 'Kitchen Radio', shelf: { tracks: [T.signalFires, T.harborLights], sizeBytes: 2 * MB } },
  { id: M, name: 'mStream', heardAgoMs: 2 * DAY, shelf: { tracks: [T.sundayWire], sizeBytes: MB } },
  { id: Q, name: 'Quarry', modelId: 'other-model', shelf: { tracks: [T.otherSpace], sizeBytes: MB } },
  { id: OLD, name: 'Attic Tapes', heardAgoMs: 10 * DAY, shelf: { tracks: [T.dustyReel], sizeBytes: 4 * MB } },
  { id: K2, name: 'Kitchen Radio', size: 7 * MB, rowCount: 900, blob: { tracks: [T.longExposure], delayMs: SLOW_MS } },
  { id: L, name: 'Lighthouse Tapes', size: 3 * MB, rowCount: 700, blob: { tracks: [T.rise, T.highway] } },
  { id: R, name: 'Rooftop FM', size: MB, rowCount: 500, blob: { fail: true } },
  { id: S, name: 'Static Garden', size: 3 * MB, rowCount: 300, blob: { tracks: [T.arcadeRain], delayMs: SLOW_MS } },
  // A dial would land this one: an Add that answers at once never dialed.
  { id: DUSTY, name: 'Dusty Shelf', heardAgoMs: 2 * DAY, rowCount: 100, blob: { tracks: [T.dustyReel] } },
  { id: BLOCKED, name: 'Spam Station', blocked: true, rowCount: 10000 },
  { id: BLOCKED_UNHEARD, blocked: true, heardAgoMs: null },
];

const USERS = ['admin', 'mia', 'neo'];
const QUIET_SCAN = { generateWaveforms: false };
const DISCOVERY_ON = { ...QUIET_SCAN, collectDiscoveryData: true, discoveryModel: 'test-fake' };

let root;           // every state dir and fake-fetch dir of the run
let A, B, C, D, E, F;
let stateA, stateF;
let fakeA, fakeF;
const tok = {};     // A's users
let tokD, tokE, tokF;
let fedKey;         // a federation key minted on A
const hashOfTrack = {};   // A: fixture title → canonical hash

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(srv, method, route, body, token, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) { h['x-access-token'] = token; }
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

async function login(srv, username) {
  const r = await call(srv, 'POST', '/api/v1/auth/login', { username, password: `pw-${username}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

async function pollUntil(fn, { timeoutMs = 20000, everyMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(everyMs);
  }
}

// A negative needs a window: `fn` must hold on every look until `forMs` ran out.
async function holdsFor(fn, { forMs, everyMs = 100, what }) {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    assert.ok(await fn(), what);
    await sleep(everyMs);
  }
  assert.ok(await fn(), what);
}

async function peersView(srv, token, headers) {
  const r = await call(srv, 'GET', PEERS, undefined, token, headers);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const rowOf = (view, endpointId) => view.peers.find((p) => p.endpointId === endpointId) || null;
const addState = async (srv, token, endpointId) => rowOf(await peersView(srv, token), endpointId)?.add ?? null;
const addPeer = (srv, token, endpointId) => call(srv, 'POST', ADD, { endpointId }, token);
const setPinned = async (srv, token, endpointId, pinned) => {
  const r = await call(srv, 'POST', PIN, { endpointId, pinned }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
async function shelfOf(srv, token) {
  const r = await call(srv, 'GET', SHELF, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.peerDbs;
}
const shelfIds = async (srv, token) => (await shelfOf(srv, token)).map((e) => e.endpointId).sort();

// The p2p activity feed's messages (the [discovery-…] log lines), oldest first.
async function activity(srv, token) {
  const r = await call(srv, 'GET', '/api/v1/admin/discovery/p2p/activity', undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.entries.map((e) => e.message);
}
const tag = (endpointId) => `${endpointId.slice(0, 12)}…`;
const linesWith = (lines, text) => lines.filter((l) => l.includes(text));

const taste = (user, body) => call(A, 'POST', TASTE, body, tok[user]);

// A server's state dir: the network staged in it before boot, and the
// storage keys that point the server at it.
function stateDir(name, { peers = [], fakeDir = null } = {}) {
  const dir = path.join(root, name);
  const dbDir = path.join(dir, 'db');
  const { blockedPeers } = stagePeers({ dbDir, fakeDir, peers, now: NOW });
  return {
    dbDir,
    blockedPeers,
    // Wholesale (the helper's spread replaces the object): every key, or
    // state leaks to the defaults.
    storage: {
      albumArtDirectory: path.join(dir, 'image-cache'),
      dbDirectory: dbDir,
      logsDirectory: path.join(dir, 'logs'),
      waveformCacheDirectory: path.join(dir, 'waveform-cache'),
    },
  };
}

const switches = (fakeDir) => ({
  MSTREAM_TEST_P2P_NO_SIDECAR: '1',
  MSTREAM_TEST_DISCOVERY_ONLINE_WINDOW_MS: String(DAY),
  ...(fakeDir ? { MSTREAM_TEST_P2P_FAKE_FETCH_DIR: fakeDir } : {}),
});

const adminOnly = [{ username: 'admin', password: 'pw-admin', admin: true }];

// F boots twice on one state dir (case 15). The second boot finds its admin
// in the database, so it cannot wait for the scan: the helper polls the
// scan status without a token, which a server with users answers 401.
function bootF({ users, waitForScan }) {
  return startServer({
    dlnaMode: 'disabled',
    users,
    waitForScan,
    env: switches(fakeF),
    extraConfig: {
      storage: stateF.storage,
      scanOptions: QUIET_SCAN,
      discoveryP2p: { enabled: true, autoFetch: false, maxPeerDbStorageMb: 10 },
    },
  });
}

// Hand-seed discovery.db with LIBRARY_VECTORS, keyed to the scanned rows,
// and the model facts the embedding worker records (the fixture songs are
// too short for it to run): the peers route and the Add read the local
// model from embedding_model_id.
function seedVectors(dbDir, hashes = {}) {
  const mdb = new DatabaseSync(path.join(dbDir, 'mstream.db'), { readOnly: true });
  const ddb = new DatabaseSync(path.join(dbDir, 'discovery.db'));
  try {
    const byTitle = mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?`);
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?)`);
    let seq = 0;
    for (const [title, v] of LIBRARY_VECTORS) {
      const t = byTitle.get(title);
      hashes[title] = t.hash;
      const n = Math.hypot(...v);
      const f = new Float32Array(v.map((x) => x / n));
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, t.artist, title, t.duration ?? 120,
        Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    const meta = ddb.prepare('INSERT OR REPLACE INTO discovery_meta (key, value) VALUES (?, ?)');
    meta.run('embedding_model_id', 'test-fake');
    meta.run('embedding_model_version', '1');
  } finally {
    ddb.close();
    mdb.close();
  }
}

async function postPlays(srv, token, filePaths) {
  let n = 0;
  const plays = filePaths.map((filePath) => ({
    id: `peer-recs-${++n}`, filePath, startedAt: new Date(NOW - n * DAY).toISOString(),
    playedMs: 200000, durationMs: 200000, outcome: 'completed',
  }));
  const r = await call(srv, 'POST', '/api/v1/stats/plays', { client: { name: 'peer-recs-test' }, plays }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accepted.length, plays.length, JSON.stringify(r.body));
}

// A jukebox session token for `token`'s account (the taste suite's way).
async function jukeboxSession(srv, token) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.baseUrl.replace(/^http/, 'ws')}/?token=${token}`);
    ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
    ws.on('error', reject);
  });
}

// What a kill does: no shutdown, no flush. On Windows a kill reaches only
// the direct child, which is all there is here (F runs no scan or
// enrichment children once booted).
async function crash(srv) {
  const exited = new Promise((r) => srv.proc.once('exit', r));
  srv.proc.kill('SIGKILL');
  await exited;
  await srv.stop();   // releases the pipes; the state dir is ours, not its tmpDir
}

const readRegistry = (dbDir) => JSON.parse(fs.readFileSync(registryPath(dbDir), 'utf8'));
const shelfFiles = (dbDir) => fs.readdirSync(shelfDir(dbDir)).filter((f) => f.endsWith('.db')).sort();

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-peer-recs-'));
  fakeA = path.join(root, 'fake-a');
  fakeF = path.join(root, 'fake-f');
  stateA = stateDir('a', { peers: A_PEERS, fakeDir: fakeA });
  stateF = stateDir('f', {
    fakeDir: fakeF,
    peers: [
      { id: ATTIC, name: 'Attic Tapes', heardAgoMs: 10 * DAY, shelf: { tracks: [T.dustyReel], sizeBytes: 8 * MB } },
      // Held open far past any kill, until case 15 rewrites the marker.
      { id: S, name: 'Static Garden', size: 5 * MB, blob: { tracks: [T.arcadeRain], delayMs: 120000 } },
    ],
  });
  const gated = (name) => stateDir(name, { peers: [{ id: L, name: 'Lighthouse Tapes', size: 3 * MB }] });
  const stateD = gated('d');
  const stateE = gated('e');

  [A, B, C, D, E, F] = await Promise.all([
    startServer({
      dlnaMode: 'disabled',
      users: USERS.map((u) => ({ username: u, password: `pw-${u}`, admin: u === 'admin' })),
      env: switches(fakeA),
      extraConfig: {
        storage: stateA.storage,
        scanOptions: DISCOVERY_ON,
        federation: { enabled: true },
        discoveryP2p: {
          enabled: true, autoFetch: false, maxPeerDbStorageMb: 10, blockedPeers: stateA.blockedPeers,
        },
      },
    }),
    startServer({
      dlnaMode: 'disabled',
      env: switches(null),
      extraConfig: { scanOptions: DISCOVERY_ON, discoveryP2p: { enabled: true, autoFetch: false } },
    }),
    startServer({ dlnaMode: 'disabled', waitForScan: false, extraConfig: { scanOptions: QUIET_SCAN } }),
    ...[stateD, stateE].map((state) => startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      users: adminOnly,
      env: switches(null),
      extraConfig: {
        storage: state.storage, scanOptions: QUIET_SCAN, discoveryP2p: { enabled: true, autoFetch: false },
      },
    })),
    bootF({ users: adminOnly, waitForScan: true }),
  ]);

  for (const u of USERS) { tok[u] = await login(A, u); }
  [tokD, tokE, tokF] = await Promise.all([login(D, 'admin'), login(E, 'admin'), login(F, 'admin')]);

  seedVectors(stateA.dbDir, hashOfTrack);
  seedVectors(path.join(B.tmpDir, 'db'));
  await postPlays(A, tok.mia, [P.beSomebody, P.rise]);

  const mint = await call(A, 'POST', '/api/v1/admin/federation/keys', { name: 'peer-recs', vpaths: ['testlib'] }, tok.admin);
  assert.equal(mint.status, 200, JSON.stringify(mint.body));
  fedKey = mint.body.key;

  // D: the admin API switched off. E: the admin outside the IP gate.
  const lock = await call(D, 'POST', '/api/v1/admin/config/admin-access', { mode: 'none' }, tokD);
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  const gate = await call(E, 'POST', '/api/v1/admin/config/admin-access',
    { mode: 'whitelist', whitelist: ['10.9.0.0/16'] }, tokE);
  assert.equal(gate.status, 200, JSON.stringify(gate.body));
});

after(async () => {
  await Promise.all([A, B, C, D, E, F].map((srv) => srv?.stop()));
  if (root) { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── the peers route ──────────────────────────────────────────────────────

describe('peer recs: the peers route', () => {
  const ROW_KEYS = ['add', 'endpointId', 'hue', 'label', 'monogram', 'name', 'onShelf', 'online', 'pinned', 'rowCount'];

  test('1. a member: shelf rows only, add null, canAdd false; Q and the blocked id absent', async () => {
    const r = await call(A, 'GET', PEERS, undefined, tok.mia);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const v = r.body;
    assert.equal(v.canAdd, false);
    assert.deepEqual(v.shelf, { held: 4, searchable: 3, running: false },
      'held counts Q (another model); searchable does not; no sidecar runs');
    assert.deepEqual(v.peers.map((p) => p.endpointId).sort(), [K, M, OLD].sort());
    for (const p of v.peers) {
      assert.deepEqual(Object.keys(p).sort(), ROW_KEYS);
      assert.equal(p.onShelf, true);
      assert.equal(p.pinned, false);
      assert.equal(p.add, null);
    }
    assert.deepEqual(v.peers.map((p) => [p.endpointId, p.online, p.rowCount]).sort(),
      [[K, true, 2], [M, false, 1], [OLD, false, 1]].sort());
    for (const hidden of [Q, BLOCKED, BLOCKED_UNHEARD, K2, L]) {
      assert.equal(rowOf(v, hidden), null, `${tag(hidden)} is not a member's row`);
    }
  });

  test('2. an admin: the shelf rows plus the addable ones (online, unheld, compatible, unblocked)', async () => {
    const v = await peersView(A, tok.admin);
    assert.equal(v.canAdd, true);
    assert.deepEqual(v.shelf, { held: 4, searchable: 3, running: false });
    assert.deepEqual(v.peers.map((p) => p.endpointId).sort(), [K, M, OLD, K2, L, R, S].sort());
    for (const addable of [K2, L, R, S]) {
      const p = rowOf(v, addable);
      assert.deepEqual(Object.keys(p).sort(), ROW_KEYS);
      assert.deepEqual([p.onShelf, p.online, p.pinned, p.add], [false, true, false, null], tag(addable));
    }
    assert.deepEqual([K2, L, R, S].map((x) => rowOf(v, x).rowCount), [900, 700, 500, 300], 'the announced row counts');
    assert.equal(rowOf(v, DUSTY), null, 'offline and carrying no Add state: not offered');
    assert.equal(rowOf(v, Q), null);
    assert.equal(rowOf(v, BLOCKED), null);
  });

  test('3. labels: the default name and every shared name carry the id', async () => {
    const v = await peersView(A, tok.admin);
    const label = (x) => rowOf(v, x).label;
    assert.equal(label(M), 'mStream · 3f9a');
    assert.equal(label(K), 'Kitchen Radio · 1a2b');
    assert.equal(label(K2), 'Kitchen Radio · 2b3c');
    assert.deepEqual([OLD, L, R, S].map(label), ['Attic Tapes', 'Lighthouse Tapes', 'Rooftop FM', 'Static Garden']);
    assert.deepEqual([rowOf(v, K).name, rowOf(v, M).name], ['Kitchen Radio', 'mStream'], 'the name stays bare');
    // K2 is no member's row, but it is in the universe: K's label is the same for everyone.
    const member = await peersView(A, tok.mia);
    assert.equal(rowOf(member, K).label, 'Kitchen Radio · 1a2b');
  });

  test('4. hue = the id\'s first 6 hex mod 360; monogram from the label', async () => {
    const v = await peersView(A, tok.admin);
    for (const p of v.peers) {
      assert.equal(p.hue, parseInt(p.endpointId.slice(0, 6), 16) % 360, tag(p.endpointId));
    }
    assert.equal(rowOf(v, K).hue, 91, '0x1a2bbb % 360');
    assert.deepEqual([K, K2, M, OLD, L, R, S].map((x) => rowOf(v, x).monogram),
      ['KR', 'KR', 'mS', 'AT', 'LT', 'RF', 'SG']);
  });

  test('5. order: shelf rows online first, then by label; then addable rows by seeders, row count, id', async () => {
    const v = await peersView(A, tok.admin);
    assert.deepEqual(v.peers.map((p) => p.endpointId), [
      K,             // online shelf
      OLD, M,        // offline shelf: 'Attic Tapes' < 'mStream · 3f9a'
      K2, L, R, S,   // addable: no seeders here, so by announced rows
    ]);
    const member = await peersView(A, tok.mia);
    assert.deepEqual(member.peers.map((p) => p.endpointId), [K, OLD, M]);
  });

  test('6. 403 with p2p off, for a federation key and for a jukebox session; 401 without a token', async () => {
    const off = await call(C, 'GET', PEERS);
    assert.equal(off.status, 403);
    assert.match(off.body.error, /discovery P2P is disabled/);

    // The federation allowlist wall answers before any route runs.
    const key = await call(A, 'GET', PEERS, undefined, null, { 'x-federation-key': fedKey });
    assert.equal(key.status, 403, JSON.stringify(key.body));
    assert.equal(key.body.error, 'Forbidden');

    const juke = await jukeboxSession(A, tok.mia);
    try {
      const r = await call(A, 'GET', PEERS, undefined, juke.token);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.match(r.body.error, /jukebox session/);
    } finally {
      juke.ws.close();
    }

    assert.equal((await call(A, 'GET', PEERS)).status, 401);
  });

  test('7. an admin under lockAdmin (D) or outside the IP gate (E) gets canAdd false and no addable rows', async () => {
    for (const [srv, token, what] of [[D, tokD, 'lockAdmin'], [E, tokE, 'IP gate']]) {
      const v = await peersView(srv, token);
      assert.equal(v.canAdd, false, what);
      assert.deepEqual(v.peers, [], `${what}: Lighthouse is online and unheld, but not offered`);
    }
  });
});

// ── the Add ──────────────────────────────────────────────────────────────

describe('peer recs: the Add', () => {
  test('8. refusals: member 403, lockAdmin 405, IP gate 403, bad id 400, unknown 404, blocked and incompatible 409', async () => {
    const member = await addPeer(A, tok.mia, L);
    assert.deepEqual([member.status, member.body.error], [403, 'Admin access required']);
    assert.equal((await addPeer(D, tokD, L)).status, 405);
    const gated = await addPeer(E, tokE, L);
    assert.deepEqual([gated.status, gated.body.error], [403, 'Admin access restricted to local network']);
    assert.equal((await addPeer(C, null, L)).status, 403, 'p2p off');

    for (const body of [{}, { endpointId: 'zz' }, { endpointId: L.slice(1) }, { endpointId: 'g'.repeat(64) }, { endpointId: L, pinned: true }]) {
      assert.equal((await call(A, 'POST', ADD, body, tok.admin)).status, 400, JSON.stringify(body));
    }

    const unknown = await addPeer(A, tok.admin, UNKNOWN);
    assert.deepEqual([unknown.status, unknown.body], [404, { error: 'not-in-catalog' }]);
    for (const blocked of [BLOCKED, BLOCKED_UNHEARD]) {
      const r = await addPeer(A, tok.admin, blocked);
      assert.deepEqual([r.status, r.body], [409, { error: 'blocked' }],
        `${tag(blocked)}: blocked is checked before the catalog lookup`);
    }
    const incompatible = await addPeer(A, tok.admin, Q);
    assert.deepEqual([incompatible.status, incompatible.body], [409, { error: 'incompatible' }]);

    // Refusals store nothing and touch nothing.
    const v = await peersView(A, tok.admin);
    assert.ok(v.peers.every((p) => p.add === null), JSON.stringify(v.peers.map((p) => p.add)));
    assert.deepEqual(await shelfIds(A, tok.admin), [K, M, Q, OLD].sort());
  });

  test('9. happy path: 202, then on the shelf unpinned; Old (the longest-silent unpinned) swapped out', async () => {
    const oldFile = (await shelfOf(A, tok.admin)).find((e) => e.endpointId === OLD);
    assert.ok(oldFile, 'Old is held before the Add');
    const oldPath = path.join(shelfDir(stateA.dbDir), `${hashOf(OLD).slice(0, 16)}.db`);
    assert.ok(fs.existsSync(oldPath));

    // Any case is accepted; the answer is lower-case.
    const r = await addPeer(A, tok.admin, L.toUpperCase());
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual([r.body.endpointId, r.body.state, r.body.code], [L, 'adding', null]);
    assert.match(r.body.at, ISO);

    const landed = await pollUntil(async () => {
      const p = rowOf(await peersView(A, tok.admin), L);
      return p?.onShelf ? p : null;
    }, { what: 'Lighthouse on the shelf' });
    assert.equal(landed.pinned, false, 'a page Add never pins');
    assert.deepEqual([landed.add.state, landed.add.code], ['done', null]);
    assert.match(landed.add.at, ISO);

    assert.deepEqual(await shelfIds(A, tok.admin), [K, M, Q, L].sort(), 'exactly one eviction: Old');
    assert.ok(!fs.existsSync(oldPath), 'the evicted snapshot file is gone');

    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `add ${tag(L)} (Lighthouse Tapes) by 'admin'`).length, 1, lines.join('\n'));
    assert.equal(linesWith(lines, `add ${tag(L)} swapped out ${tag(OLD)}`).length, 1, lines.join('\n'));
    assert.equal(linesWith(lines, `add ${tag(L)} landed (2 tracks, `).length, 1, lines.join('\n'));
  });

  test('10. two POSTs share one download', async () => {
    const [first, second] = await Promise.all([addPeer(A, tok.admin, S), addPeer(A, tok.admin, S)]);
    assert.deepEqual([first.status, second.status], [202, 202], JSON.stringify([first.body, second.body]));
    assert.deepEqual(second.body, first.body, 'the second press reads the running Add');
    assert.equal(first.body.state, 'adding');

    await pollUntil(async () => rowOf(await peersView(A, tok.admin), S)?.onShelf,
      { what: 'Static on the shelf' });
    const again = await addPeer(A, tok.admin, S);
    assert.deepEqual([again.status, again.body.state], [200, 'done']);

    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `add ${tag(S)} (Static Garden) by 'admin'`).length, 1, lines.join('\n'));
    assert.equal(linesWith(lines, `fetched ${tag(S)} (`).length, 1, 'one download');
    assert.equal(linesWith(lines, `add ${tag(S)} landed`).length, 1, lines.join('\n'));
    assert.equal(linesWith(lines, `add ${tag(S)} swapped out`).length, 0, 'it fit without a swap');
  });

  test('11. Rooftop fails offline; a retry is adding again; neither moves its row', async () => {
    const order = async () => (await peersView(A, tok.admin)).peers.map((p) => p.endpointId);
    const before = await order();

    const r = await addPeer(A, tok.admin, R);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const failed = await pollUntil(async () => {
      const add = await addState(A, tok.admin, R);
      return add?.state === 'failed' ? add : null;
    }, { what: 'Rooftop failed' });
    assert.equal(failed.code, 'offline');
    assert.deepEqual(await order(), before, 'an Add state never reorders a row');

    const retry = await addPeer(A, tok.admin, R);
    assert.deepEqual([retry.status, retry.body.state, retry.body.code], [202, 'adding', null]);
    await pollUntil(async () => (await addState(A, tok.admin, R))?.state === 'failed', { what: 'the retry failing' });
    assert.deepEqual(await order(), before);

    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `add ${tag(R)} failed (offline): fetch failed: dial timed out`).length, 2,
      lines.join('\n'));
    assert.deepEqual(await shelfIds(A, tok.admin), [K, M, Q, L, S].sort());
  });

  test('12. every snapshot pinned: 200 failed/no-room, nothing evicted; an unpin clears it', async () => {
    const held = await shelfOf(A, tok.admin);
    for (const e of held) { await setPinned(A, tok.admin, e.endpointId, true); }
    const files = shelfFiles(stateA.dbDir);

    const r = await addPeer(A, tok.admin, K2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.endpointId, r.body.state, r.body.code], [K2, 'failed', 'no-room']);
    assert.match(r.body.at, ISO);
    assert.deepEqual(await shelfOf(A, tok.admin), held.map((e) => ({ ...e, pinned: true })), 'nothing evicted');
    assert.deepEqual(shelfFiles(stateA.dbDir), files);
    assert.deepEqual(await addState(A, tok.admin, K2), { state: 'failed', code: 'no-room', at: r.body.at });
    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `add ${tag(K2)} failed (no-room)`).length, 1, lines.join('\n'));

    await setPinned(A, tok.admin, S, false);
    assert.equal(await addState(A, tok.admin, K2), null, 'a pin change drops every failed state');
  });

  test('13. an offline peer nobody seeds: offline at once, without dialing', async () => {
    const r = await addPeer(A, tok.admin, DUSTY);
    // A download always answers 202: a 200 means none started.
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.state, r.body.code], ['failed', 'offline']);
    const row = rowOf(await peersView(A, tok.admin), DUSTY);
    assert.ok(row, 'a row carrying an Add state stays offered while its peer is offline');
    assert.deepEqual([row.online, row.onShelf, row.add.state, row.add.code], [false, false, 'failed', 'offline']);
    assert.ok(!(await shelfIds(A, tok.admin)).includes(DUSTY));
    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `add ${tag(DUSTY)} failed (offline): not heard from lately`).length, 1,
      lines.join('\n'));
  });

  test('14. the sync peer-dbs/fetch: adding meanwhile, the record back pinned; a cap failure stores failed, never no-room', async () => {
    // Static's blob holds the download open SLOW_MS.
    const fetching = call(A, 'POST', FETCH, { endpointId: S }, tok.admin);
    await pollUntil(async () => (await addState(A, tok.admin, S))?.state === 'adding',
      { what: 'Static adding while the sync fetch runs' });
    const r = await fetching;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.endpointId, S);
    assert.equal(r.body.hash, hashOf(S));
    assert.equal(r.body.pinned, true, 'the admin panel\'s fetch still pins');
    assert.equal(r.body.rowCount, 1);
    const row = rowOf(await peersView(A, tok.admin), S);
    assert.deepEqual([row.onShelf, row.pinned, row.add.state], [true, true, 'done']);

    // K2's 7 MB cannot fit beside 4 MB held, and this fetch never swaps.
    const full = await call(A, 'POST', FETCH, { endpointId: K2 }, tok.admin);
    assert.equal(full.status, 500, JSON.stringify(full.body));
    assert.match(full.body.error, /^fetch failed: fetch would exceed the peer-DB storage cap/);
    const add = await addState(A, tok.admin, K2);
    assert.deepEqual([add.state, add.code], ['failed', 'failed']);
    const lines = await activity(A, tok.admin);
    assert.equal(linesWith(lines, `[discovery-peer-dbs] fetch failed for admin 'admin' (peer ${tag(K2)})`).length, 1,
      lines.join('\n'));
    assert.ok(!(await shelfIds(A, tok.admin)).includes(K2));
  });
});

// ── an Add across a kill, and across a stop (server F) ──────────────────

describe('peer recs: an Add across a kill and a stop', () => {
  const sHash = hashOf(S);
  const sFile = () => path.join(shelfDir(stateF.dbDir), `${sHash.slice(0, 16)}.db`);
  const storage = async () => {
    const r = await call(F, 'GET', '/api/v1/admin/discovery/p2p/catalog', undefined, tokF);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.storage;
  };

  test('15. SIGKILL mid-Add, reboot on the same state dir: add null, under the cap, no orphan .db, a re-POST works', async () => {
    const r = await addPeer(F, tokF, S);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const mid = rowOf(await peersView(F, tokF), S);
    assert.deepEqual([mid.onShelf, mid.add.state], [false, 'adding']);

    await crash(F);
    // What a kill between the sidecar's export and the registry write leaves:
    // the snapshot file, named by nothing.
    fs.copyFileSync(path.join(fakeF, `${sHash}.db`), sFile());

    F = await bootF({ users: [], waitForScan: false });
    tokF = await login(F, 'admin');
    const v = await peersView(F, tokF);
    const row = rowOf(v, S);
    assert.deepEqual([row.onShelf, row.add], [false, null], 'nothing survives a restart');
    assert.equal(rowOf(v, ATTIC)?.onShelf, true, 'the planned evictee leaves only when the newcomer lands');
    assert.ok(!fs.existsSync(sFile()), 'the orphan was swept');
    assert.deepEqual(shelfFiles(stateF.dbDir), readRegistry(stateF.dbDir).map((e) => path.basename(e.path)).sort(),
      'every snapshot file is a shelf entry');
    const at = await storage();
    assert.ok(at.usedBytes <= at.capBytes, JSON.stringify(at));
    assert.equal(at.usedBytes, 8 * MB);
    const lines = await activity(F, tokF);
    assert.equal(linesWith(lines, `removed ${path.basename(sFile())}: no shelf entry names it`).length, 1,
      lines.join('\n'));

    stageFakeBlob(fakeF, sHash, { delayMs: 0 });
    const again = await addPeer(F, tokF, S);
    assert.deepEqual([again.status, again.body.state], [202, 'adding'], JSON.stringify(again.body));
    await pollUntil(async () => rowOf(await peersView(F, tokF), S)?.onShelf, { what: 'Static on F\'s shelf' });
    assert.deepEqual(await shelfIds(F, tokF), [S], 'Attic swapped out');
    const after = await storage();
    assert.ok(after.usedBytes <= after.capBytes, JSON.stringify(after));
    assert.equal(linesWith(await activity(F, tokF), `add ${tag(S)} swapped out ${tag(ATTIC)}`).length, 1);
  });

  test('16. p2p switched off during a fake copy: the registry is not written', async () => {
    const removed = await call(F, 'POST', '/api/v1/admin/discovery/p2p/peer-dbs/remove', { endpointId: S }, tokF);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const before = readRegistry(stateF.dbDir);
    assert.deepEqual(before, []);
    stageFakeBlob(fakeF, sHash, { delayMs: SLOW_MS });

    const r = await addPeer(F, tokF, S);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const off = await call(F, 'POST', '/api/v1/admin/discovery/p2p/enabled', { enabled: false }, tokF);
    assert.deepEqual([off.status, off.body], [200, { enabled: false }]);

    // The copy still runs to its end; nothing may land from it.
    await holdsFor(() => JSON.stringify(readRegistry(stateF.dbDir)) === JSON.stringify(before),
      { forMs: SLOW_MS + 3000, what: 'peer-dbs.json unchanged' });
    await pollUntil(() => !fs.existsSync(sFile()), { what: 'the abandoned copy discarded' });
    assert.deepEqual(shelfFiles(stateF.dbDir), []);
  });
});

// ── taste, generation 3 ──────────────────────────────────────────────────

describe('peer recs: taste generation 3', () => {
  const LEAD_KEYS = ['album', 'artist', 'duration', 'exportId', 'isrc', 'peer', 'recordingMbid',
    'releaseGroupMbid', 'seedHash', 'similarity', 'source', 'tile', 'title', 'year'];

  test('17. networkPeers narrows the walk; an id not on the shelf reads not-on-shelf; [] is a 400', async () => {
    const r = await taste('mia', { sources: ['network'], networkPeers: [K.toUpperCase()] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const net = r.body.network;
    assert.deepEqual(net.results.map((x) => x.title).sort(), ['Harbor Lights', 'Signal Fires']);
    assert.ok(net.results.every((x) => x.peer.endpointId === K));
    assert.equal(net.searched.peers, 1);
    assert.equal(net.reason, null);

    for (const ids of [[UNKNOWN], [K2, BLOCKED]]) {
      const miss = await taste('mia', { sources: ['network'], networkPeers: ids });
      assert.equal(miss.status, 200, JSON.stringify(miss.body));
      assert.deepEqual(miss.body.network, { results: [], searched: { peers: 0, tracks: 0 }, reason: 'not-on-shelf' },
        'unknown, unheld and blocked ids match nothing');
    }

    for (const body of [{ networkPeers: [] }, { networkPeers: ['zz'] }, { networkPeers: [K, K] }]) {
      assert.equal((await taste('mia', { sources: ['network'], ...body })).status, 400, JSON.stringify(body));
    }
  });

  test('18. reasons: empty-shelf, no-compatible, nothing-new, scan-pending', async () => {
    const empty = await call(B, 'POST', TASTE, { sources: ['network'], pin: [P.rise] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.network, { results: [], searched: { peers: 0, tracks: 0 }, reason: 'empty-shelf' });

    const other = await taste('mia', { sources: ['network'], networkPeers: [Q] });
    assert.deepEqual([other.body.network.reason, other.body.network.searched.peers], ['no-compatible', 0]);

    // Lighthouse holds only songs this library owns.
    const owned = await taste('mia', { sources: ['network'], networkPeers: [L] });
    assert.deepEqual(owned.body.network.results, []);
    assert.deepEqual([owned.body.network.reason, owned.body.network.searched], ['nothing-new', { peers: 1, tracks: 2 }]);

    const pending = await taste('mia', { sources: ['network'], pin: [P.sketch], limit: { seeds: 1 } });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.notAnalyzed, true);
    assert.deepEqual(pending.body.network, { results: [], searched: { peers: 0, tracks: 0 }, reason: 'scan-pending' });
  });

  test('19. no finished songs: network null without the key; leads off the random pick with networkOnRandomSeed', async () => {
    const plain = await taste('neo', { sources: ['network'] });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.seedSource, 'random');
    assert.equal(plain.body.network, null);

    const r = await taste('neo', { sources: ['network'], networkOnRandomSeed: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'random');
    assert.equal(r.body.seeds.length, 1);
    const pick = r.body.seeds[0].hash;
    assert.ok(Object.values(hashOfTrack).includes(pick), 'the pick is an analyzed library song');
    const net = r.body.network;
    assert.equal(net.reason, null);
    assert.ok(net.results.length > 0, JSON.stringify(net));
    for (const lead of net.results) { assert.equal(lead.seedHash, pick, lead.title); }
  });

  test('20. leads carry the peers route\'s label and their leadTile, and forward unchanged to lookup and resolve', async () => {
    const labels = new Map((await peersView(A, tok.mia)).peers.map((p) => [p.endpointId, p.label]));
    const r = await taste('mia', { sources: ['network'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'history');
    const leads = r.body.network.results;
    assert.deepEqual(leads.map((x) => x.title).sort(), ['Arcade Rain', 'Harbor Lights', 'Signal Fires', 'Sunday Wire']);
    for (const lead of leads) {
      assert.deepEqual(Object.keys(lead).sort(), LEAD_KEYS, lead.title);
      assert.deepEqual(Object.keys(lead.peer).sort(), ['endpointId', 'label', 'name']);
      assert.equal(lead.source, 'p2p');
      assert.equal(lead.peer.label, labels.get(lead.peer.endpointId), lead.title);
      assert.deepEqual(lead.tile, leadTile(lead), lead.title);
    }
    const byTitle = new Map(leads.map((x) => [x.title, x]));
    assert.equal(byTitle.get('Sunday Wire').peer.label, 'mStream · 3f9a');
    assert.equal(byTitle.get('Signal Fires').peer.label, 'Kitchen Radio · 1a2b');
    // The plan's §5.1 vector: one album, one tile.
    assert.deepEqual(byTitle.get('Signal Fires').tile, { key: 'paper lantern|night ferry', hue: 39, letter: 'P' });
    assert.deepEqual(byTitle.get('Harbor Lights').tile, byTitle.get('Signal Fires').tile);

    const look = await call(A, 'POST', '/api/v1/discovery/plugin-jobs/lookup/batch', { recommendations: leads }, tok.mia);
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.results.length, leads.length);
    for (const lead of leads) {
      const res = await call(A, 'POST', '/api/v1/discovery/plugins/links/resolve', { recommendation: lead }, tok.mia);
      assert.equal(res.status, 200, `${lead.title}: ${JSON.stringify(res.body)}`);
    }
  });

  test('21. taste calls while an Add swaps a snapshot out: every one answers 200', async () => {
    const logs = await call(A, 'GET', '/api/v1/admin/logs/recent', undefined, tok.admin);
    const since = logs.body.lastSeq;
    // K2 (7 MB) fits once Kitchen Radio's 2 MB go: unpin it, and K2 swaps it out.
    await setPinned(A, tok.admin, K, false);
    const r = await addPeer(A, tok.admin, K2);
    assert.equal(r.status, 202, JSON.stringify(r.body));

    let calls = 0;
    await pollUntil(async () => {
      const t = await taste('mia', { sources: ['network'] });
      calls += 1;
      assert.equal(t.status, 200, JSON.stringify(t.body));
      assert.notEqual(t.body.network.reason, 'error');
      return (await shelfIds(A, tok.admin)).includes(K2);
    }, { everyMs: 20, what: 'K2 on the shelf' });
    assert.ok(calls > 1, `the walks ran while the download did (${calls})`);
    assert.deepEqual(await shelfIds(A, tok.admin), [K2, M, Q, L, S].sort());
    assert.equal(linesWith(await activity(A, tok.admin), `add ${tag(K2)} swapped out ${tag(K)}`).length, 1);

    const t = await taste('mia', { sources: ['network'] });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const titles = t.body.network.results.map((x) => x.title);
    assert.ok(titles.includes('Long Exposure'), titles.join(', '));
    assert.ok(!titles.includes('Signal Fires'), 'Kitchen Radio\'s copy is gone');

    const recent = await call(A, 'GET', `/api/v1/admin/logs/recent?since=${since}`, undefined, tok.admin);
    const bad = recent.body.entries.filter((e) => /unreadable|shelf search failed/.test(e.message));
    assert.deepEqual(bad, []);
  });

  test('22. Discover\'s body (no generation-2 key) answers as before', async () => {
    const GEN1 = ['dropped', 'excluded', 'fallback', 'library', 'model', 'network', 'notAnalyzed', 'peers',
      'seedSource', 'seeds', 'widenedFrom', 'window'];
    // Pinned in one order, so the centroid is the same bits every call.
    const discover = { window: 30, pin: [P.beSomebody, P.rise] };
    const r = await taste('mia', discover);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), GEN1);
    assert.deepEqual(Object.keys(r.body.network).sort(), ['reason', 'results', 'searched']);
    assert.ok(r.body.network.results.length > 0);
    assert.equal(r.body.network.reason, null);
    assert.equal(r.body.peers, null, 'no connected servers here');
    // No networkPeers = the whole shelf.
    const all = await taste('mia', { ...discover, networkPeers: await shelfIds(A, tok.admin) });
    assert.deepEqual(r.body.network, all.body.network);

    // A random seed still walks nothing without the key.
    const neo = await taste('neo', { window: 30 });
    assert.equal(neo.status, 200, JSON.stringify(neo.body));
    assert.equal(neo.body.seedSource, 'random');
    assert.equal(neo.body.network, null);
    assert.deepEqual(Object.keys(neo.body).sort(), GEN1);
  });
});

// ── the flags ────────────────────────────────────────────────────────────

describe('peer recs: the flags', () => {
  test('23. discoveryTaste 3 and discoveryP2pPeers 1 on /api/ and on ping, version facts', async () => {
    const api = await call(A, 'GET', '/api/', undefined, tok.mia);
    assert.equal(api.body.features.discoveryTaste, 3);
    assert.equal(api.body.features.discoveryP2pPeers, 1);
    const ping = await call(A, 'GET', '/api/v1/ping', undefined, tok.mia);
    assert.equal(ping.body.discoveryTaste, 3);
    assert.equal(ping.body.discoveryP2pPeers, 1);
    // The same with p2p off: the gate is discoveryP2p, not the generation.
    const off = await call(C, 'GET', '/api/v1/ping');
    assert.deepEqual([off.body.discoveryP2p, off.body.discoveryTaste, off.body.discoveryP2pPeers], [false, 3, 1]);
  });
});
