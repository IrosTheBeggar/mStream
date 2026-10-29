/**
 * The Discover page's server half — POST /api/v1/discovery/taste
 * (src/api/discovery-taste.js, over src/discovery/taste-queries.js and the
 * shared similarity / p2p / federation helpers). Contract:
 * docs/discovery-page-plan.md §2, §3.1. The call is stateless: the seeds are
 * a random batch of the user's finished songs every time, so a seed list
 * is asserted as a SET when the window holds no more candidates than the
 * seed limit (the batch is the whole pool), and as a subset of the right
 * size — differing across repeated calls — when it holds more.
 *
 * Strategy (the discovery-similarity suite's): a real server with discovery
 * ON (model 'test-fake') over the fixture library plus an admin-only second
 * library, discovery.db seeded with HANDCRAFTED 4-d unit vectors so every
 * similarity is known, and play history posted through the real ingest
 * route (POST /api/v1/stats/plays) — one account per scenario, so histories
 * never bleed into each other. A second server runs in public mode (no
 * users), a third with discovery off.
 *
 * Every fixture track gets a vector EXCEPT 'Sketch 1' — the "scan pending"
 * track for the notAnalyzed cases.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const TASTE = '/api/v1/discovery/taste';
const PREFS = '/api/v1/discovery/taste/prefs';   // removed: answers 404

const P = {
  beSomebody: 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3',
  rise: 'testlib/Icarus/Be Somebody/02 - Rise.mp3',
  orbit: 'testlib/Icarus/Be Somebody/03 - Orbit.mp3',
  ret: 'testlib/Icarus/Later Works/01 - Return.mp3',
  descent: 'testlib/Icarus/Later Works/02 - Descent.mp3',
  highway: 'testlib/Vosto/Night Drive/01 - Highway.mp3',
  stat: 'testlib/Vosto/Night Drive/03 - Static.mp3',
  neon: 'testlib/Vosto/Night Drive/02 - Neon.mp3',
  sketch: 'testlib/Vosto/Untitled EP/01 - Sketch 1.mp3',
  zed: 'lib2/zed.mp3',
};

// ── handcrafted vector space (4-d, unit vectors) ────────────────────────────
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const VECTORS = [
  ['Be Somebody', vec(1, 0, 0, 0)],
  ['Rise', vec(0.95, 0.312, 0, 0)],
  ['Orbit', vec(0.9, 0.436, 0, 0)],
  ['Return', vec(0.7, 0.714, 0, 0)],
  ['Descent', vec(0.6, 0.8, 0, 0)],
  ['Highway', vec(0, 1, 0, 0)],
  ['Static', vec(0.2, 0.98, 0, 0)],
  ['Neon', vec(0.5, 0.866, 0, 0)],
  ['Lib2 Song', vec(0.98, 0.199, 0, 0)],
  // 'Sketch 1' deliberately has none.
];

const USERS = ['admin', 'bob', 'carol', 'dave', 'erin', 'fay', 'gus', 'hal', 'ivy', 'kim', 'lou', 'max', 'moe', 'nina', 'pat', 'quin', 'ray', 'zoe'];
const VPATHS = { admin: ['testlib', 'lib2'], zoe: ['lib2'] };

let server;     // discovery on, users, federation on (for the key test)
let pubServer;  // discovery on, public mode (no users)
let offServer;  // discovery off
let lib2Dir;
const tokens = {};
const hashOf = {};   // fixture path → canonical hash

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`))));
  });
}

async function call(srv, method, route, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['x-access-token'] = token; }
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const taste = (user, body = {}) => call(server, 'POST', TASTE, body, tokens[user]);

// Hand-seed discovery.db with the vectors above, keyed to the scanned rows.
function seedVectors(srv) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const ddb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'discovery.db'));
  try {
    const byTitle = mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?`);
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)`);
    let seq = 0;
    for (const [title, v] of VECTORS) {
      const t = byTitle.get(title);
      if (!t) { continue; }   // lib2 is not mounted on every server
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, t.artist, title, t.duration ?? 120,
        blob(v), JSON.stringify([`Test---${title}`]));
    }
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
}

// A peer snapshot in the exact export format (the discovery-p2p suite's
// makeSnapshotFile, original layout) and the shelf registry that lists it.
function makeSnapshot(filePath, tracks) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sdb = new DatabaseSync(filePath);
  try {
    sdb.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tracks (
        export_id TEXT NOT NULL, recording_mbid TEXT, acoustid_id TEXT,
        artist TEXT, title TEXT, duration REAL,
        model_id TEXT, model_version TEXT, embedding BLOB,
        bpm INTEGER, musical_key TEXT, danceability REAL,
        genre_tags TEXT, mood_tags TEXT
      );`);
    const meta = sdb.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of [['format', 'mstream-discovery-snapshot'], ['format_version', '1'],
      ['source_schema_version', '2'], ['embedding_model_id', 'test-fake'], ['embedding_model_version', '1'],
      ['row_count', String(tracks.length)]]) { meta.run(k, v); }
    const ins = sdb.prepare(`
      INSERT INTO tracks (export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding)
      VALUES (?, NULL, ?, ?, 180, 'test-fake', '1', ?)`);
    for (const t of tracks) { ins.run(`anon:${t.title}`, t.artist, t.title, blob(vec(...t.vec))); }
  } finally {
    sdb.close();
  }
}

const SHELF = { x: 'a'.repeat(64), y: 'b'.repeat(64) };
function stageShelf(srv) {
  const peerDir = path.join(srv.tmpDir, 'db', 'discovery-peers');
  makeSnapshot(path.join(peerDir, 'x.db'), [
    { artist: 'Icarus', title: 'Rise', vec: [0.95, 0.312, 0, 0] },        // owned here → never a lead
    { artist: 'Shelf Artist', title: 'New One', vec: [0.9, 0.3, 0.3, 0] },
    { artist: 'Shelf Artist', title: 'Far Away', vec: [0, 0, 0, 1] },
  ]);
  makeSnapshot(path.join(peerDir, 'y.db'), [
    { artist: 'shelf artist', title: 'new one', vec: [0.8, 0.2, 0.5, 0] }, // the same song, worse match
  ]);
  const p2pDir = path.join(srv.tmpDir, 'db', 'discovery-p2p');
  fs.mkdirSync(p2pDir, { recursive: true });
  const entry = (id, file, rows, name) => ({
    endpointId: id, hash: id, path: path.join(peerDir, file), snapshotSeq: 1, modelId: 'test-fake',
    rowCount: rows, sizeBytes: 4096, name, fetchedAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(p2pDir, 'peer-dbs.json'), JSON.stringify([
    entry(SHELF.x, 'x.db', 3, 'Peer X'), entry(SHELF.y, 'y.db', 1, 'Peer Y'),
  ]));
}

function readHashes(srv) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  try {
    const rows = mdb.prepare(`
      SELECT l.name || '/' || t.filepath AS p, COALESCE(t.audio_hash, t.file_hash) AS hash
        FROM tracks t JOIN libraries l ON l.id = t.library_id`).all();
    for (const r of rows) { hashOf[r.p.replace(/\\/g, '/')] = r.hash; }
  } finally {
    mdb.close();
  }
}

const DAY = 24 * 60 * 60 * 1000;
let playSeq = 0;
const play = (filePath, ago, outcome, playedMs, durationMs) => ({
  id: `taste-${++playSeq}`, filePath, startedAt: new Date(Date.now() - ago).toISOString(),
  playedMs, durationMs, outcome,
});
async function postPlays(srv, token, plays) {
  const r = await call(srv, 'POST', '/api/v1/stats/plays', { client: { name: 'taste-test' }, plays }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accepted.length, plays.length, JSON.stringify(r.body));
}

before(async () => {
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-lib2-'));
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-metadata', 'artist=Zed', '-metadata', 'title=Lib2 Song', '-metadata', 'album=Zed Album',
    '-ac', '1', path.join(lib2Dir, 'zed.mp3'),
  ]);

  const discoveryOn = { scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' } };
  [server, pubServer, offServer] = await Promise.all([
    startServer({
      dlnaMode: 'disabled',
      // Federation on only so a minted key can be shown the door; there
      // are no peers, so the peers source stays unadvertised.
      extraConfig: { ...discoveryOn, federation: { enabled: true } },
      extraFolders: { lib2: lib2Dir },
      users: USERS.map((u) => ({ username: u, password: `pw-${u}`, admin: u === 'admin', vpaths: VPATHS[u] || ['testlib'] })),
    }),
    // p2p on with a hand-staged shelf (no sidecar, no network): the
    // network section's real path.
    startServer({ dlnaMode: 'disabled', extraConfig: { ...discoveryOn, discoveryP2p: { enabled: true, autoFetch: false } } }),
    startServer({ dlnaMode: 'disabled', waitForScan: false }),
  ]);

  for (const u of USERS) {
    const r = await call(server, 'POST', '/api/v1/auth/login', { username: u, password: `pw-${u}` });
    tokens[u] = r.body.token;
  }
  seedVectors(server);
  seedVectors(pubServer);
  stageShelf(pubServer);
  readHashes(server);

  // bob: the main history.
  await postPlays(server, tokens.bob, [
    play(P.beSomebody, 2 * DAY, 'completed', 200000, 200000),
    // 4 of 6 minutes, then the tab closed: listened to → seeds.
    play(P.stat, 4 * DAY, 'stopped', 240000, 360000),
    // 35 s of 6 minutes: counted (≥ 30 s), but under half → no seed.
    play(P.neon, 3 * DAY, 'stopped', 35000, 360000),
    // Finished once, then skipped later: the latest event is a skip.
    play(P.highway, 10 * DAY, 'completed', 200000, 200000),
    play(P.highway, DAY / 2, 'skipped', 40000, 200000),
    // A 5 s skip: never counted — "tried and bounced".
    play(P.orbit, DAY, 'skipped', 5000, 200000),
  ]);
  // dave: one song, 20 days ago (outside a 7-day window).
  await postPlays(server, tokens.dave, [play(P.beSomebody, 20 * DAY, 'completed', 200000, 200000)]);
  // erin: two songs, for exclusions.
  await postPlays(server, tokens.erin, [
    play(P.beSomebody, DAY, 'completed', 200000, 200000),
    play(P.rise, 2 * DAY, 'completed', 200000, 200000),
  ]);
  // nina: only the un-analyzed song.
  await postPlays(server, tokens.nina, [play(P.sketch, DAY, 'completed', 200000, 200000)]);
  // fay: seven finished songs (every analyzed testlib song but Neon), the
  // oldest Descent — Neon's nearest seed, outside the library seed cap.
  await postPlays(server, tokens.fay, [P.beSomebody, P.rise, P.orbit, P.ret, P.highway, P.stat, P.descent]
    .map((p, i) => play(p, (i + 1) * DAY, 'completed', 200000, 200000)));
  // gus: one seed, for the rating rule.
  await postPlays(server, tokens.gus, [play(P.beSomebody, DAY, 'completed', 200000, 200000)]);
  // hal: one seed that a history reset will take away.
  await postPlays(server, tokens.hal, [play(P.rise, 3 * DAY, 'completed', 200000, 200000)]);
  // ivy: one seed; a later counted skip takes a song out of her library.
  await postPlays(server, tokens.ivy, [play(P.beSomebody, DAY, 'completed', 200000, 200000)]);
  // kim: one seed, Neon finished 100 days ago (outside the 30-day window,
  // past the 90-day library cutoff), Highway finished 10 days ago (inside
  // the window, so a seed too).
  await postPlays(server, tokens.kim, [
    play(P.beSomebody, DAY, 'completed', 200000, 200000),
    play(P.neon, 100 * DAY, 'completed', 200000, 200000),
    play(P.highway, 10 * DAY, 'completed', 200000, 200000),
  ]);
  // lou and max: one seed each, and Neon — the only play of the Night Drive
  // album — finished outside the 30-day window: 100 days ago for lou (past
  // the fixed 90-day cutoff), 60 days ago for max (inside it).
  await postPlays(server, tokens.lou, [
    play(P.beSomebody, DAY, 'completed', 200000, 200000),
    play(P.neon, 100 * DAY, 'completed', 200000, 200000),
  ]);
  await postPlays(server, tokens.max, [
    play(P.beSomebody, DAY, 'completed', 200000, 200000),
    play(P.neon, 60 * DAY, 'completed', 200000, 200000),
  ]);
  // admin: one seed, to scope the library with ignoreVPaths.
  await postPlays(server, tokens.admin, [play(P.beSomebody, DAY, 'completed', 200000, 200000)]);
});

after(async () => {
  await Promise.all([server?.stop(), pubServer?.stop(), offServer?.stop()]);
  fs.rmSync(lib2Dir, { recursive: true, force: true });
});

const paths = (rows) => rows.map((r) => r.filepath);
const pathSet = (rows) => new Set(paths(rows));

// ── gates ────────────────────────────────────────────────────────────────

describe('discovery taste: gates', () => {
  test('403 while discovery is off', async () => {
    const r = await call(offServer, 'POST', TASTE, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Discovery is disabled');
  });

  test('401 without a token on a server with users', async () => {
    assert.equal((await call(server, 'POST', TASTE, {})).status, 401);
  });

  // A federation key never reaches the route: api/federation-auth.js's
  // allowlist wall answers 'Forbidden' before any route runs, and this
  // path is not on it. The route's own requireAccount is defence in depth
  // behind that wall and cannot be reached over HTTP with a key.
  test('a federation key is refused (by the federation allowlist wall)', async () => {
    const mint = await call(server, 'POST', '/api/v1/admin/federation/keys', { name: 'taste-peer', vpaths: ['testlib'] }, tokens.admin);
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    const r = await fetch(`${server.baseUrl}${TASTE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-federation-key': mint.body.key }, body: '{}',
    });
    assert.equal(r.status, 403, `answered ${r.status}`);
    assert.equal((await r.json()).error, 'Forbidden', 'the wall\'s answer');
  });

  test('a jukebox session token is refused', async () => {
    const { default: WebSocket } = await import('ws');
    const juke = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${tokens.bob}`);
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
      ws.on('error', reject);
    });
    try {
      const r = await call(server, 'POST', TASTE, {}, juke.token);
      assert.equal(r.status, 403, `answered ${r.status}`);
      assert.match(r.body.error, /jukebox session/);
    } finally {
      juke.ws.close();
    }
  });

  test('validation: caps, enums, unknown keys and the removed keys answer 400', async () => {
    const bad = [
      { window: 14 },
      { sources: ['library', 'radio'] },
      { limit: { tracks: 51 } },
      { limit: { seeds: 13 } },
      { limit: { albums: 25 } },
      { limit: { network: 51 } },
      { limit: { peers: 26 } },
      { pin: Array.from({ length: 13 }, (_, i) => `testlib/x${i}.mp3`) },
      { exclude: Array.from({ length: 201 }, (_, i) => `h${i}`) },
      { exclude: ['x'.repeat(129)] },
      { surprise: true },
      // Removed with the saved prefs: nothing is remembered, and the
      // library rule is fixed.
      { remember: false },
      { filter: 'fresh' },
      { staleDays: 90 },
    ];
    for (const body of bad) {
      assert.equal((await taste('bob', body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    // PIN_CAP = the seed cap: a client can pin a whole 12-seed batch.
    const twelve = await taste('bob', { pin: Array.from({ length: 12 }, (_, i) => `testlib/x${i}.mp3`), sources: ['library'] });
    assert.equal(twelve.status, 200, JSON.stringify(twelve.body));
    assert.equal(twelve.body.dropped, 12);
  });

  test('the prefs routes are gone (404)', async () => {
    for (const [method, body] of [['GET'], ['PUT', { window: 7 }]]) {
      const r = await call(server, method, PREFS, body, tokens.bob);
      assert.equal(r.status, 404, `${method} answered ${r.status}`);
    }
  });
});

// ── seeds ────────────────────────────────────────────────────────────────

describe('discovery taste: seeds', () => {
  test('completed plays and mostly-listened stops seed; skips and short stops never do', async () => {
    const r = await taste('bob', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.seedSource, 'history');
    assert.equal(b.window, 30, 'the default window');
    assert.equal(b.widenedFrom, null);
    assert.equal(b.fallback, false);
    assert.equal(b.notAnalyzed, false);
    assert.deepEqual(b.model, { id: 'test-fake', version: '1' });
    // Two candidates, a limit of 12: the batch is the whole pool, in a
    // random order.
    assert.deepEqual(pathSet(b.seeds), new Set([P.beSomebody, P.stat]),
      'Highway (skipped last), Neon (35 s of 6 min) and Orbit (5 s skip) do not seed');
    const first = b.seeds.find((x) => x.filepath === P.beSomebody);
    const second = b.seeds.find((x) => x.filepath === P.stat);
    assert.equal(first.outcome, 'completed');
    assert.equal(second.outcome, 'stopped');
    assert.equal(first.hash, hashOf[P.beSomebody]);
    assert.equal(first.plays, 1);
    assert.equal(first.pinned, false);
    assert.equal(first.analyzed, true);
    assert.match(first.lastPlayed, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO, through toIso');
    assert.equal(first.metadata.title, 'Be Somebody', 'the lite envelope');
    assert.ok(!('hash' in first.metadata) && !('play-count' in first.metadata), 'lite, not full');
    assert.deepEqual(b.excluded, []);
    assert.equal(b.dropped, 0);
  });

  test('a random batch: the whole pool when it fits the limit, a changing subset when it does not', async () => {
    const fay = [P.beSomebody, P.rise, P.orbit, P.ret, P.highway, P.stat, P.descent];
    const whole = await taste('fay', { sources: ['library'] });
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    assert.equal(whole.body.seeds.length, 7);
    assert.deepEqual(pathSet(whole.body.seeds), new Set(fay));

    // Seven candidates, three slots: C(7,3) = 35 batches, so 20 calls all
    // drawing the same one would be a (1/35)^19 fluke — or no randomness.
    const batches = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await taste('fay', { sources: [], limit: { seeds: 3 } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.seedSource, 'history');
      const got = paths(r.body.seeds);
      assert.equal(got.length, 3);
      assert.equal(new Set(got).size, 3, 'distinct songs');
      for (const p of got) { assert.ok(fay.includes(p), p); }
      batches.add([...got].sort().join('|'));
    }
    assert.ok(batches.size > 1, 'every call drew the same seeds');
  });

  test('an empty window widens to all time and says so', async () => {
    const narrow = await taste('dave', { window: 7, sources: ['library'] });
    assert.equal(narrow.status, 200);
    assert.equal(narrow.body.seedSource, 'history');
    assert.equal(narrow.body.window, 0);
    assert.equal(narrow.body.widenedFrom, 7);
    assert.deepEqual(paths(narrow.body.seeds), [P.beSomebody]);
    const wide = await taste('dave', { window: 30, sources: ['library'] });
    assert.equal(wide.body.window, 30);
    assert.equal(wide.body.widenedFrom, null);
  });

  test('pins seed first and count toward limit.seeds; unknown and forbidden paths are dropped alike', async () => {
    const r = await taste('bob', { pin: [P.rise, P.zed, 'testlib/nope.mp3', P.sketch], sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dropped, 2, 'lib2 is not bob\'s; nope.mp3 does not exist — one count, no difference');
    assert.deepEqual(paths(r.body.seeds.slice(0, 2)), [P.rise, P.sketch], 'the pins, in the order sent');
    assert.deepEqual(pathSet(r.body.seeds.slice(2)), new Set([P.beSomebody, P.stat]));
    assert.deepEqual(r.body.seeds.map((s) => s.pinned), [true, true, false, false]);
    assert.equal(r.body.seeds[1].analyzed, false, 'a pin the worker has not reached is listed, not used');
    assert.equal(r.body.seedSource, 'history');
    assert.ok(!paths(r.body.library.tracks).includes(P.rise), 'a pinned song is never recommended back');

    const only = await taste('bob', { pin: [P.rise], limit: { seeds: 1 }, sources: ['library'] });
    assert.deepEqual(paths(only.body.seeds), [P.rise]);
    assert.equal(only.body.seedSource, 'pinned');
  });

  test('exclude leaves songs out of this call only, and lists them back', async () => {
    const plain = await taste('erin', { sources: ['library'] });
    assert.deepEqual(pathSet(plain.body.seeds), new Set([P.beSomebody, P.rise]));
    const h = hashOf[P.beSomebody];

    // lib2's song is a real track, in a library erin cannot see: its row
    // (path, metadata) must not come back to her.
    assert.ok(hashOf[P.zed], 'the lib2 fixture is indexed');
    const left = await taste('erin', { exclude: [h, 'no-such-hash', hashOf[P.zed]], window: 90, sources: ['library'] });
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.deepEqual(paths(left.body.seeds), [P.rise], 'the pool shrank');
    assert.equal(left.body.window, 90);
    assert.deepEqual(left.body.excluded.map((e) => [e.hash, e.filepath, e.metadata.title]), [[h, P.beSomebody, 'Be Somebody']],
      'the rows of the hashes this call left out (an unknown hash and another library\'s track are not listed)');

    // Nothing is remembered: the next call draws from the whole pool again.
    const again = await taste('erin', { sources: ['library'] });
    assert.deepEqual(pathSet(again.body.seeds), new Set([P.beSomebody, P.rise]));
    assert.equal(again.body.window, 30, 'the default window, not the last one sent');
    assert.deepEqual(again.body.excluded, []);

    // A pin is an explicit choice: it seeds even while its song is excluded.
    const pinned = await taste('erin', { pin: [P.beSomebody], exclude: [h], sources: ['library'] });
    assert.deepEqual(paths(pinned.body.seeds), [P.beSomebody, P.rise]);
    assert.equal(pinned.body.seeds[0].pinned, true);
  });

  test('nothing counted at all: one random analyzed track from the caller\'s own libraries, drawn per call', async () => {
    const r = await taste('carol');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'random');
    assert.equal(r.body.fallback, true);
    assert.equal(r.body.seeds.length, 1);
    assert.ok(r.body.seeds[0].filepath.startsWith('testlib/'), r.body.seeds[0].filepath);
    assert.equal(r.body.seeds[0].analyzed, true);
    assert.equal(r.body.network, null, 'no fan-outs for a random seed');
    assert.equal(r.body.peers, null);
    // Nothing played: every card is an unplayed album, so the songs sit
    // under their albums — all of them inside carol's own library.
    const recommended = [...paths(r.body.library.tracks), ...r.body.library.albums.flatMap((a) => a.tracks)];
    assert.ok(recommended.length > 0);
    for (const p of recommended) { assert.ok(p.startsWith('testlib/'), p); }
    // A plain re-ask (nothing excluded) draws again on the default RNG path:
    // within a bounded run a different song comes back. carol has at least
    // two visible analyzed songs, so a false failure needs 39 repeats in a
    // row (at most 2^-39).
    const plain = new Set([r.body.seeds[0].hash]);
    for (let i = 0; i < 40 && plain.size < 2; i++) {
      const again = await taste('carol', { sources: ['library'] });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.seedSource, 'random');
      plain.add(again.body.seeds[0].hash);
    }
    assert.ok(plain.size >= 2, 'a plain re-ask gives another song (no day salt, no pinned RNG)');

    // "Another pick": a re-ask with the picks shown in `exclude` gets a new
    // song every time, until none is left — then no seed and notAnalyzed
    // (the client clears its list and starts over). Set membership only:
    // the order of the draws is random.
    const shown = [r.body.seeds[0].hash];
    let last = null;
    for (let i = 0; i < 40; i++) {
      last = await taste('carol', { exclude: shown, sources: ['library'] });
      assert.equal(last.status, 200, JSON.stringify(last.body));
      if (last.body.seeds.length === 0) { break; }
      assert.equal(last.body.seedSource, 'random');
      const h = last.body.seeds[0].hash;
      assert.ok(!shown.includes(h), `${last.body.seeds[0].filepath} was shown already`);
      assert.ok(last.body.seeds[0].filepath.startsWith('testlib/'), last.body.seeds[0].filepath);
      shown.push(h);
    }
    assert.ok(shown.length >= 2, 'carol sees more than one analyzed song');
    assert.deepEqual(last.body.seeds, [], `still picking after ${shown.length}`);
    assert.equal(last.body.notAnalyzed, true, 'no pick left reads as nothing to show');
    assert.equal(last.body.seedSource, 'random');

    // An excluded song is neither the random pick nor recommended back.
    const ex = r.body.seeds[0].hash === hashOf[P.rise] ? P.orbit : P.rise;
    const without = await taste('carol', { exclude: [hashOf[ex]] });
    assert.notEqual(without.body.seeds[0].hash, hashOf[ex]);
    const back = [...paths(without.body.library.tracks), ...without.body.library.albums.flatMap((a) => a.tracks)];
    assert.ok(back.length > 0);
    assert.ok(!back.includes(ex), `${ex} came back`);

    // zoe sees lib2 only: the one analyzed track there is the only choice.
    const zoe = await taste('zoe');
    assert.deepEqual(paths(zoe.body.seeds), [P.zed]);
    assert.deepEqual(zoe.body.library.tracks, [], 'nothing else analyzed is visible to her');
  });

  test('counted plays but none analyzed: listed with notAnalyzed, never a random stand-in', async () => {
    const r = await taste('nina');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.notAnalyzed, true);
    assert.equal(r.body.seedSource, 'history');
    assert.equal(r.body.fallback, false);
    assert.deepEqual(paths(r.body.seeds), [P.sketch]);
    assert.equal(r.body.seeds[0].analyzed, false);
    // The seed came from the requested 30-day window, not from a widening
    // (the analyzed-only pass widened and found nothing).
    assert.equal(r.body.window, 30);
    assert.equal(r.body.widenedFrom, null);
    assert.deepEqual(r.body.library, { tracks: [], albums: [], capped: false });
  });

  test('counters seed when the log has nothing to give (after a history reset, post-reset counters only)', async () => {
    const reset = await call(server, 'POST', '/api/v1/stats/reset', { scope: 'history' }, tokens.hal);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    // A counted skip: no seed in the log (its latest event is a skip), but a
    // counter bumped after the reset marker.
    await postPlays(server, tokens.hal, [play(P.orbit, 0, 'skipped', 40000, 200000)]);
    const r = await taste('hal', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'counters');
    assert.deepEqual(paths(r.body.seeds), [P.orbit], 'Rise\'s pre-reset counter does not seed');
    assert.equal(r.body.fallback, false);
  });
});

// ── library ──────────────────────────────────────────────────────────────

describe('discovery taste: library', () => {
  const tracksOnly = (user, extra = {}) => taste(user, { sources: ['library'], limit: { albums: 0, tracks: 50 }, ...extra });

  test('songs you have not played lately, best match first, rows per §3.1', async () => {
    const r = await tracksOnly('bob');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lib = r.body.library;
    assert.deepEqual(Object.keys(lib).sort(), ['albums', 'capped', 'tracks'], 'no filter field: the rule is fixed');
    assert.deepEqual(pathSet(lib.tracks), new Set([P.rise, P.ret, P.descent]),
      'no seeds, no lib2 (not bob\'s), no Sketch (not analyzed), no Highway / Neon (played lately), no Orbit (tried and bounced)');
    const sims = lib.tracks.map((t) => t.similarity);
    assert.deepEqual(sims, [...sims].sort((a, b) => b - a));
    const rise = lib.tracks.find((t) => t.filepath === P.rise);
    assert.equal(rise.seedHash, hashOf[P.beSomebody], 'Rise is because of Be Somebody');
    assert.equal(rise.similarity, 0.9501, 'cos of the normalized vectors, 4 decimals');
    assert.deepEqual(rise.genreTags, ['Test---Rise'], 'the model\'s tags from the index');
    assert.equal(rise.metadata.title, 'Rise');
    assert.equal(rise.playCount, 0);
    assert.equal(rise.lastPlayed, null);
    const descent = lib.tracks.find((t) => t.filepath === P.descent);
    assert.equal(descent.seedHash, hashOf[P.stat], 'Descent sits closer to Static');
    assert.equal(lib.capped, false);
    assert.deepEqual(lib.albums, []);
  });

  test('a song last played more than 90 days ago comes back', async () => {
    const r = await tracksOnly('kim');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(pathSet(r.body.seeds), new Set([P.beSomebody, P.highway]), 'Neon is outside the 30-day window');
    const got = paths(r.body.library.tracks);
    assert.ok(got.includes(P.neon), got.join());
    const neon = r.body.library.tracks.find((t) => t.filepath === P.neon);
    assert.equal(neon.playCount, 1);
    assert.match(neon.lastPlayed, /Z$/);
    // Highway is a seed here (seeds never come back); Static (never
    // played) stays.
    assert.ok(got.includes(P.stat));
  });

  test('the 90-day cutoff is fixed: a non-seed song played 60 days ago stays out, one played 100 days ago comes back', async () => {
    // Neon is no seed for either (outside the 30-day window) — only the
    // library rule decides it.
    const recent = await tracksOnly('max');
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.deepEqual(paths(recent.body.seeds), [P.beSomebody]);
    const gotRecent = paths(recent.body.library.tracks);
    assert.ok(!gotRecent.includes(P.neon), `played 60 days ago: ${gotRecent.join()}`);
    assert.ok(gotRecent.includes(P.stat) && gotRecent.includes(P.highway), 'its never-played album mates stay');

    const stale = await tracksOnly('lou');
    assert.deepEqual(paths(stale.body.seeds), [P.beSomebody]);
    assert.ok(paths(stale.body.library.tracks).includes(P.neon), 'played 100 days ago');
  });

  test('album cards follow the same cutoff: last played 100 days ago is a card, 60 days ago is not', async () => {
    const lou = await taste('lou', { sources: ['library'] });
    assert.equal(lou.status, 200, JSON.stringify(lou.body));
    const night = lou.body.library.albums.find((a) => a.name === 'Night Drive');
    assert.ok(night, JSON.stringify(lou.body.library.albums.map((a) => a.name)));
    assert.equal(night.playedTracks, 1);
    assert.equal(night.scopedTracks, 3);
    assert.match(night.lastPlayed, /Z$/);
    assert.ok(Date.now() - Date.parse(night.lastPlayed) > 90 * DAY, night.lastPlayed);
    assert.ok(night.tracks.includes(P.neon));
    assert.ok(!paths(lou.body.library.tracks).includes(P.neon), 'listed under its album, not in tracks');

    const max = await taste('max', { sources: ['library'] });
    assert.equal(max.status, 200, JSON.stringify(max.body));
    const names = max.body.library.albums.map((a) => a.name);
    assert.ok(!names.includes('Night Drive'), `played 60 days ago: ${names.join()}`);
    assert.ok(names.includes('Later Works'), 'the unplayed card stays');
    assert.ok(!paths(max.body.library.tracks).includes(P.neon));
  });

  test('albums before songs: unplayed cards by their best track, their songs out of the tracks list', async () => {
    const r = await taste('bob', { sources: ['library'] });
    const lib = r.body.library;
    assert.equal(lib.albums.length, 1, JSON.stringify(lib.albums.map((a) => a.name)));
    const [album] = lib.albums;
    assert.equal(album.name, 'Later Works');
    assert.equal(album.scopedTracks, 2);
    assert.equal(album.playedTracks, 0);
    assert.equal(album.lastPlayed, null);
    assert.equal(album.track_count, 2, 'the /db/albums item, unchanged');
    assert.deepEqual(album.artists, ['Icarus']);
    assert.deepEqual(album.tracks, [P.descent, P.ret], 'its matched songs, best first');
    assert.equal(album.similarity, 0.9038);
    assert.equal(album.seedHash, hashOf[P.stat]);
    assert.deepEqual(paths(lib.tracks), [P.rise], 'Return and Descent are listed under their album');
    assert.ok(!lib.albums.some((a) => a.name === 'Night Drive'), 'played lately: not a card');
  });

  test('library seed cap: only the first 6 seeds of the batch get a library pass', async () => {
    // Neon is the one song fay has not played, and a near duplicate of
    // Descent (cos 0.993 ≥ NEAR_DUP): with Descent among the six seeds that
    // get a library pass it is dropped as "the seed song again"; with
    // Descent 7th (outside the cap) it comes back, matched against the
    // other six. The batch order is random, so every answer is checked
    // against whichever case it drew. Descent lands 7th with p = 1/7 per
    // call; 60 calls reach that (cap-proving) branch in all but ~1e-4 of
    // runs ((6/7)^60) — the route has no RNG hook to pin the order.
    for (let i = 0; i < 60; i++) {
      const r = await tracksOnly('fay');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.seeds.length, 7, 'all seven are listed');
      const firstSix = r.body.seeds.slice(0, 6);
      if (firstSix.some((x) => x.filepath === P.descent)) {
        assert.deepEqual(r.body.library.tracks, [], 'Descent ranked: Neon is its near duplicate');
      } else {
        assert.deepEqual(paths(r.body.library.tracks), [P.neon], 'Descent is 7th: not ranked');
        assert.ok(firstSix.some((x) => x.hash === r.body.library.tracks[0].seedHash));
      }
    }
  });

  test('low ratings (≤ 2 stars) leave the library', async () => {
    const rate = await call(server, 'POST', '/api/v1/db/rate-song', { filepath: P.ret, rating: 4 }, tokens.gus);
    assert.equal(rate.status, 200, JSON.stringify(rate.body));
    const r = await tracksOnly('gus');
    assert.ok(!paths(r.body.library.tracks).includes(P.ret), 'rated 2 stars');
    assert.ok(paths(r.body.library.tracks).includes(P.descent), 'its unrated neighbour stays');
  });

  test('ignoreVPaths scopes the library', async () => {
    const both = await tracksOnly('admin');
    assert.ok(paths(both.body.library.tracks).includes(P.zed), 'lib2 is the admin\'s');
    const one = await tracksOnly('admin', { ignoreVPaths: ['lib2'] });
    assert.ok(one.body.library.tracks.length > 0);
    assert.ok(paths(one.body.library.tracks).every((p) => p.startsWith('testlib/')), paths(one.body.library.tracks).join());
  });

  test('every call computes: a song played since the last call leaves the next answer', async () => {
    const a = await tracksOnly('ivy');
    assert.ok(paths(a.body.library.tracks).includes(P.orbit));
    // A counted skip: Orbit is played now (and, its latest play a skip,
    // still not a seed).
    await postPlays(server, tokens.ivy, [play(P.orbit, DAY / 4, 'skipped', 40000, 200000)]);
    const b = await tracksOnly('ivy');
    assert.deepEqual(paths(b.body.seeds), [P.beSomebody]);
    assert.ok(!paths(b.body.library.tracks).includes(P.orbit), 'not a cached answer');
  });

  test('a history reset: the pre-reset counters stop seeding (random, not counters)', async () => {
    const reset = await call(server, 'POST', '/api/v1/stats/reset', { scope: 'history' }, tokens.dave);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.scope, 'history');
    const r = await taste('dave', { sources: ['library'] });
    assert.equal(r.body.seedSource, 'random', 'pre-reset counters are not seeds');
  });
});

// ── network / peers ──────────────────────────────────────────────────────

describe('discovery taste: network and peers', () => {
  test('null when the source is not advertised (p2p off, no discovery peers)', async () => {
    const r = await taste('bob');
    assert.equal(r.body.network, null);
    assert.equal(r.body.peers, null);
    const lib = await taste('bob', { sources: ['peers'] });
    assert.equal(lib.body.library, null, 'not asked for');
  });

  test('source stamping, seedHash and recommendationKey dedupe (stampNetworkRows / peersSection)', async () => {
    const { stampNetworkRows, peersSection } = await import('../../src/api/discovery-taste.js');
    const seeds = [{ hash: 'h0' }, { hash: 'h1' }];
    const row = (artist, title, seedIndex, similarity) => ({
      artist, title, album: null, year: null, isrc: null, releaseGroupMbid: null, duration: 200,
      similarity, recordingMbid: null, exportId: `anon:${title}`, peer: { endpointId: 'e1', name: 'P' }, seedIndex,
    });
    const out = stampNetworkRows([
      row('A', 'One', 1, 0.9), row('a', 'one', 0, 0.8), row('B', 'Two', null, 0.7), row('C', 'Three', 0, 0.6),
    ], seeds, 2);
    assert.deepEqual(out.map((r) => [r.title, r.source, r.seedHash]), [['One', 'p2p', 'h1'], ['Two', 'p2p', null]],
      'the second "one" is the same song; capped at the limit after dedupe');
    assert.ok(out.every((r) => !('seedIndex' in r)), 'seedIndex never reaches the wire');

    const fan = {
      peers: [{ id: 1, name: 'Sam', lastSeen: null, reachable: true, mismatched: false, results: [{ title: 'X', filepath: 'm/x.mp3', peer: { id: 1, name: 'Sam' } }] }],
      searched: { peers: 1, unreachable: 0, mismatched: 0 },
    };
    const peers = peersSection(fan);
    assert.deepEqual(peers.peers[0].results[0], { title: 'X', filepath: 'm/x.mp3', peer: { id: 1, name: 'Sam' }, source: 'federation', seedHash: null });
    assert.deepEqual(peers.searched, fan.searched);
    assert.equal(fan.peers[0].results[0].source, undefined, 'the fan-out result is not mutated');
  });
});

// ── public mode ──────────────────────────────────────────────────────────

describe('discovery taste: public mode', () => {
  test('the shared account gets a page', async () => {
    const first = await call(pubServer, 'POST', TASTE, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.seedSource, 'random');
    assert.equal(first.body.network, null, 'p2p is on, but a random seed sends nothing anywhere');

    await postPlays(pubServer, undefined, [play(P.rise, DAY, 'completed', 200000, 200000)]);
    const r = await call(pubServer, 'POST', TASTE, { window: 90, exclude: ['abc'], sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'history');
    assert.equal(r.body.window, 90);
    assert.deepEqual(paths(r.body.seeds), [P.rise]);
    assert.deepEqual(r.body.excluded, [], 'an exclusion that names no track is not listed');
  });

  test('network: shelf leads stamped as p2p recommendations, owned songs out, one row per song', async () => {
    // Pinned, so this test seeds on its own whatever ran before it.
    const r = await call(pubServer, 'POST', TASTE, { sources: ['network'], pin: [P.rise] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.library, null);
    assert.equal(r.body.peers, null, 'federation is off');
    const net = r.body.network;
    assert.deepEqual(net.searched, { peers: 2, tracks: 4 });
    assert.deepEqual(net.results.map((x) => [x.title, x.peer.name]), [['New One', 'Peer X'], ['Far Away', 'Peer X']],
      'Rise is owned; Peer Y\'s copy of New One is the same song, ranked lower');
    for (const row of net.results) {
      assert.equal(row.source, 'p2p');
      assert.equal(row.seedHash, hashOf[P.rise], 'the only seed');
      assert.ok(!('seedIndex' in row));
    }
    const limited = await call(pubServer, 'POST', TASTE, { sources: ['network'], pin: [P.rise], limit: { network: 1 } });
    assert.deepEqual(limited.body.network.results.map((x) => x.title), ['New One']);
  });

  test('network while the scan is pending: an empty section, not null (null = not available here)', async () => {
    const r = await call(pubServer, 'POST', TASTE, { sources: ['library', 'network'], pin: [P.sketch], limit: { seeds: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.notAnalyzed, true);
    assert.equal(r.body.seedSource, 'pinned');
    assert.deepEqual(r.body.network, { results: [], searched: { peers: 0, tracks: 0 } });
    assert.equal(r.body.peers, null, 'federation is off: not advertised');
    assert.deepEqual(r.body.library.tracks, []);
  });

  test('a peer row the recommendation schema would refuse is dropped, so a batch lookup never 400s on it', async () => {
    const { stampNetworkRows, peersSection } = await import('../../src/api/discovery-taste.js');
    const { recommendationSchema } = await import('../../src/discovery-plugins/index.js');
    const ok = { artist: 'A', title: 'Fine', duration: 200, similarity: 0.9, exportId: 'anon:fine', peer: { endpointId: 'e1', name: 'P' }, seedIndex: 0 };
    const rows = stampNetworkRows([
      ok,
      { ...ok, title: 'x'.repeat(600), exportId: 'anon:long' },
      { ...ok, artist: 42, title: 'Typed', exportId: 'anon:typed' },
    ], [{ hash: 'h0' }], 10);
    assert.deepEqual(rows.map((r) => r.title), ['Fine']);
    const fed = peersSection({
      peers: [{ id: 1, name: 'S', lastSeen: null, reachable: true, mismatched: false, results: [
        { title: 'Good', artist: 'B', filepath: 'm/g.mp3', peer: { id: 1, name: 'S' } },
        { title: 'Bad', artist: 'B', filepath: 'p'.repeat(3000), peer: { id: 1, name: 'S' } },
      ] }],
      searched: { peers: 1, unreachable: 0, mismatched: 0 },
    });
    assert.deepEqual(fed.peers[0].results.map((r) => r.title), ['Good']);
    // What the batch lookup validates as one array: every row passes.
    for (const rec of [...rows, ...fed.peers[0].results]) {
      assert.equal(recommendationSchema.validate(rec).error, undefined, rec.title);
    }
  });

  test('a peer row with a malformed OPTIONAL fact is kept with that fact nulled, network and peers alike (2026-10-19)', async () => {
    const { stampNetworkRows, peersSection } = await import('../../src/api/discovery-taste.js');
    const { recommendationSchema } = await import('../../src/discovery-plugins/index.js');
    const ok = { artist: 'A', title: 'Fine', duration: 200, similarity: 0.9, exportId: 'anon:fine', peer: { endpointId: 'e1', name: 'P' }, seedIndex: 0 };
    const rows = stampNetworkRows([
      ok,
      { ...ok, title: 'Hyphens', isrc: 'US-RC1-76-07839', exportId: 'anon:hyphens' },
      { ...ok, title: 'Far Future', year: 99999, exportId: 'anon:future' },
    ], [{ hash: 'h0' }], 10);
    assert.deepEqual(rows.map((r) => [r.title, r.isrc ?? null, r.year ?? null, r.seedHash]),
      [['Fine', null, null, 'h0'], ['Hyphens', null, null, 'h0'], ['Far Future', null, null, 'h0']]);
    const fed = peersSection({
      peers: [{ id: 1, name: 'S', lastSeen: null, reachable: true, mismatched: false, results: [
        { title: 'Odd Year', artist: 'B', album: 'Comp', albumArtist: 'Various Artists', year: 99999, isrc: 'US-RC1-76-07839', filepath: 'm/o.mp3', peer: { id: 1, name: 'S' }, similarity: 0.8 },
      ] }],
      searched: { peers: 1, unreachable: 0, mismatched: 0 },
    });
    const [kept] = fed.peers[0].results;
    assert.deepEqual([kept.title, kept.year, kept.isrc, kept.album, kept.albumArtist, kept.similarity, kept.source],
      ['Odd Year', null, null, 'Comp', 'Various Artists', 0.8, 'federation'], 'only the bad facts go; the rest rides along');
    for (const rec of [...rows, kept]) {
      assert.equal(recommendationSchema.validate(rec).error, undefined, rec.title);
    }
  });
});

// ── mood filter ──────────────────────────────────────────────────────────

// `moods` (src/api/mood-filter.js): seeds prefer songs that match it, the
// library's songs all match it, and an album card needs most of the
// album's analysed songs to. Scores go straight into track_moods for this
// block only (the mood sync's table): Descent and Sketch 1 get none.
//   aggressive: Be Somebody, Rise, Static   relaxed: Orbit, Return, Highway, Neon
describe('discovery taste: mood filter', () => {
  const RELAXED = new Set([P.orbit, P.ret, P.highway, P.neon]);
  const SCORES = [
    ['Be Somebody', false], ['Rise', false], ['Static', false],
    ['Orbit', true], ['Return', true], ['Highway', true], ['Neon', true],
  ];
  const withDb = (fn) => {
    const db = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { timeout: 5000 });
    try { fn(db); } finally { db.close(); }
  };
  before(async () => {
    withDb((db) => {
      const ins = db.prepare(`INSERT INTO track_moods (track_id, relaxed, aggressive)
        SELECT id, ?, ? FROM tracks WHERE title = ?`);
      for (const [title, relaxed] of SCORES) { ins.run(relaxed ? 0.9 : 0.1, relaxed ? 0.1 : 0.9, title); }
    });
    // moe: one aggressive song, 20 days ago — this block's own history.
    await postPlays(server, tokens.moe, [play(P.beSomebody, 20 * DAY, 'completed', 200000, 200000)]);
  });
  after(() => withDb((db) => db.exec('DELETE FROM track_moods')));

  test('the answer echoes the filter; an unfiltered call says it could filter', async () => {
    const r = await taste('moe', { sources: ['library'], moods: { energy: 'aggressive' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moods, { energy: 'aggressive' });
    assert.deepEqual((await taste('moe', { sources: ['library'] })).body.moods, {});
  });

  test('songs all match; an album card needs most of its album to', async () => {
    const plain = await taste('moe', { sources: ['library'] });
    assert.ok(plain.body.library.albums.some((a) => a.name === 'Night Drive'), 'unfiltered, Night Drive has a card');

    const r = await taste('moe', { sources: ['library'], moods: { energy: 'aggressive' } });
    assert.deepEqual(pathSet(r.body.seeds), new Set([P.beSomebody]), 'moe\'s one song matches: it seeds');
    assert.deepEqual(pathSet(r.body.library.tracks), new Set([P.rise, P.stat]));
    assert.deepEqual(r.body.library.albums, [], 'Night Drive: Static is 1 of 3 aggressive songs');
  });

  test('no matching history: the usual seeds, filtered results — and whole-album cards', async () => {
    const r = await taste('moe', { sources: ['library'], moods: { energy: 'relaxed' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(pathSet(r.body.seeds), new Set([P.beSomebody]), 'nothing relaxed in moe\'s history');
    // Later Works: Return is its one analysed song. Night Drive: 2 of 3.
    // Be Somebody: Orbit alone (1 of 3) — no card, so Orbit stays a song.
    assert.deepEqual(new Set(r.body.library.albums.map((a) => a.name)), new Set(['Later Works', 'Night Drive']));
    for (const a of r.body.library.albums) {
      for (const t of a.tracks) { assert.ok(RELAXED.has(t), `${a.name}: ${t}`); }
    }
    assert.deepEqual(paths(r.body.library.tracks), [P.orbit]);
  });

  test('seeds come from the history songs that match, when there are any', async () => {
    const r = await taste('bob', { sources: ['library'], moods: { energy: 'relaxed' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.seeds.length > 0);
    for (const s of r.body.seeds) { assert.ok(RELAXED.has(s.filepath), s.filepath); }
    for (const t of r.body.library.tracks) { assert.ok(RELAXED.has(t.filepath), t.filepath); }
  });

  test('a filtered call leaves the network out; a bad filter is a 400', async () => {
    const r = await taste('moe', { moods: { energy: 'aggressive' } });
    assert.equal(r.body.network, null);
    assert.equal((await taste('moe', { moods: { valence: 'angry' } })).status, 400);
    assert.equal((await taste('moe', { moods: 'relaxed' })).status, 400);
  });
});

// ── capability flag ──────────────────────────────────────────────────────

describe('discovery taste: the capability flag', () => {
  test('features.discoveryTaste on GET /api and discoveryTaste on ping, an integer generation', async () => {
    // 2: the body takes `moods` (test/integration/mood-filters.test.mjs).
    const api = await call(server, 'GET', '/api/', undefined, tokens.bob);
    assert.equal(api.body.features.discoveryTaste, 2);
    const ping = await call(server, 'GET', '/api/v1/ping', undefined, tokens.bob);
    assert.equal(ping.body.discoveryTaste, 2);
    // A version fact: present (and the same) with discovery off too.
    const off = await call(offServer, 'GET', '/api/v1/ping');
    assert.equal(off.body.discoveryTaste, 2);
    assert.equal(off.body.discovery, false);
  });
});

// ── a long-gone history (last: it grows the index) ──────────────────────

// A user whose history is mostly songs since deleted or moved: finished
// plays of ANALYZED songs that no longer resolve, many times more than one
// step of the seed choice may probe and miss (VISIBLE_MISS_CAP, 96) — so a
// pending step that probed analyzed songs too would usually run out before
// it reached the one song it lists. Written straight into the server's
// databases (the ingest route only takes paths it can resolve) as
// finished, counted plays in testlib with a vector each, orthogonal to the
// fixture's so no other answer ranks them. Last in the file, so no earlier
// test sees the bigger index. `analyzed: false` writes the plays alone:
// songs gone before the scan reached them, which only the pending steps
// probe.
const GONE = 600;
function seedGoneHistory(username, { analyzed = true } = {}) {
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { timeout: 5000 });
  const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'), { timeout: 5000 });
  // One transaction per database: 1200 autocommit inserts per user are
  // ~1200 fsyncs with this process's loop blocked — long past the server's
  // 5 s keep-alive idle timeout on a slow runner disk, after which the next
  // fetch reuses a pooled socket the server has closed (ECONNRESET on
  // Windows; the dlna-surface flake, #1043, was the same mechanism).
  mdb.exec('BEGIN');
  ddb.exec('BEGIN');
  try {
    const userId = mdb.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
    const libraryId = mdb.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
    const playIns = mdb.prepare(`
      INSERT INTO play_events
        (event_id, user_id, track_hash, filepath, library_id, outcome, counted, played_ms, duration_ms, started_at)
      VALUES (?, ?, ?, ?, ?, 'completed', 1, 200000, 200000, ?)`);
    const vecIns = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, 'Gone', ?, 200, 'test-fake', '1', ?, NULL)`);
    for (let i = 0; i < GONE; i++) {
      const hash = `gone-${username}-${i}`;
      const at = new Date(Date.now() - (1 + (i % 20)) * DAY).toISOString().replace('T', ' ').replace('Z', '');
      playIns.run(`taste-${hash}`, userId, hash, `testlib/Gone/${i}.mp3`, libraryId, at);
      if (analyzed) { vecIns.run(hash, 1000 + i, `anon:${hash}`, `Gone ${username} ${i}`, blob(vec(0, 0, 1, 0))); }
    }
    if (!analyzed) { return; }
    // A new index key, so the server's in-memory index rebuilds with them.
    const seq = Number(ddb.prepare("SELECT value FROM discovery_meta WHERE key = 'row_seq'").get().value) + GONE;
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key IN ('row_seq', 'index_epoch')").run(String(seq));
  } finally {
    ddb.exec('COMMIT');
    mdb.exec('COMMIT');
    ddb.close();
    mdb.close();
  }
}

describe('discovery taste: a long-gone history does not starve the later seed steps', () => {
  before(() => {
    seedGoneHistory('pat');
    seedGoneHistory('quin');
    seedGoneHistory('ray', { analyzed: false });
  });

  test('its finished songs not analyzed yet are listed (notAnalyzed), not swapped for a random seed', async () => {
    // pat also finished the one song the scan has not reached.
    await postPlays(server, tokens.pat, [play(P.sketch, DAY, 'completed', 200000, 200000)]);
    const r = await taste('pat', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'history', 'not random: pat has counted plays');
    assert.equal(r.body.fallback, false);
    assert.equal(r.body.notAnalyzed, true);
    assert.deepEqual(paths(r.body.seeds), [P.sketch]);
    assert.equal(r.body.seeds[0].analyzed, false);
    assert.equal(r.body.window, 30);
    assert.equal(r.body.widenedFrom, null);
  });

  test('an analyzed song its counters hold still seeds (the counters step has a cap of its own)', async () => {
    // quin's one visible song: 35 s of 6 minutes — counted, so a counter,
    // but under half, so no history seed.
    await postPlays(server, tokens.quin, [play(P.neon, DAY, 'stopped', 35000, 360000)]);
    const r = await taste('quin', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'counters');
    assert.equal(r.body.fallback, false);
    assert.equal(r.body.notAnalyzed, false);
    assert.deepEqual(paths(r.body.seeds), [P.neon]);
    assert.equal(r.body.seeds[0].analyzed, true);
    assert.ok(r.body.library.tracks.length + r.body.library.albums.length > 0, 'and the page ranks from it');
  });

  test('a history gone before the scan reached it leaves the pending counters walk its own probes', async () => {
    // ray's 600 gone songs were never analyzed, so the analyzed steps pass
    // them by and the pending history draw spends its misses on them. ray's
    // one visible song is not analyzed either, and only a counter: 35 s of
    // 6 minutes, so no history seed.
    await postPlays(server, tokens.ray, [play(P.sketch, DAY, 'stopped', 35000, 360000)]);
    const r = await taste('ray', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'counters', 'not random: ray has counted plays');
    assert.equal(r.body.fallback, false);
    assert.equal(r.body.notAnalyzed, true);
    assert.deepEqual(paths(r.body.seeds), [P.sketch]);
    assert.equal(r.body.seeds[0].analyzed, false);
  });
});
