/**
 * The Discover page's server half — POST /api/v1/discovery/taste and
 * GET|PUT /api/v1/discovery/taste/prefs (src/api/discovery-taste.js, over
 * src/discovery/taste-queries.js and the shared similarity / p2p /
 * federation helpers). Contract: docs/discovery-page-plan.md §2, §3.1–3.2.
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
const PREFS = '/api/v1/discovery/taste/prefs';

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

const USERS = ['admin', 'bob', 'carol', 'dave', 'erin', 'fay', 'gus', 'hal', 'ivy', 'nina', 'zoe'];
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
  // ivy: one seed and a counted skip (40 s) — Rise has a play count but
  // never seeds, so more skips change its row and not the seed set.
  await postPlays(server, tokens.ivy, [
    play(P.beSomebody, DAY, 'completed', 200000, 200000),
    play(P.rise, 2 * DAY, 'skipped', 40000, 200000),
  ]);
  // admin: one seed, to scope the library with ignoreVPaths.
  await postPlays(server, tokens.admin, [play(P.beSomebody, DAY, 'completed', 200000, 200000)]);
});

after(async () => {
  await Promise.all([server?.stop(), pubServer?.stop(), offServer?.stop()]);
  fs.rmSync(lib2Dir, { recursive: true, force: true });
});

const paths = (rows) => rows.map((r) => r.filepath);

// ── gates ────────────────────────────────────────────────────────────────

describe('discovery taste: gates', () => {
  test('403 while discovery is off (taste and prefs)', async () => {
    for (const [method, route, body] of [['POST', TASTE, {}], ['GET', PREFS], ['PUT', PREFS, {}]]) {
      const r = await call(offServer, method, route, body);
      assert.equal(r.status, 403, `${method} ${route}`);
      assert.equal(r.body.error, 'Discovery is disabled');
    }
  });

  test('401 without a token on a server with users', async () => {
    assert.equal((await call(server, 'POST', TASTE, {})).status, 401);
  });

  // A federation key never reaches the route: api/federation-auth.js's
  // allowlist wall answers 'Forbidden' before any route runs, and these
  // paths are not on it. The route's own requireAccount is defence in
  // depth behind that wall and cannot be reached over HTTP with a key.
  test('a federation key is refused (by the federation allowlist wall)', async () => {
    const mint = await call(server, 'POST', '/api/v1/admin/federation/keys', { name: 'taste-peer', vpaths: ['testlib'] }, tokens.admin);
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    for (const [method, route, body] of [['POST', TASTE, {}], ['GET', PREFS], ['PUT', PREFS, {}]]) {
      const r = await fetch(`${server.baseUrl}${route}`, {
        method, headers: { 'Content-Type': 'application/json', 'x-federation-key': mint.body.key },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(r.status, 403, `${method} ${route} answered ${r.status}`);
      assert.equal((await r.json()).error, 'Forbidden', 'the wall\'s answer');
    }
  });

  test('a jukebox session token reaches none of it (POST, GET and PUT prefs)', async () => {
    const { default: WebSocket } = await import('ws');
    const juke = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${tokens.bob}`);
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
      ws.on('error', reject);
    });
    try {
      for (const [method, route, body] of [['POST', TASTE, {}], ['GET', PREFS], ['PUT', PREFS, { window: 7 }]]) {
        const r = await call(server, method, route, body, juke.token);
        assert.equal(r.status, 403, `${method} ${route} answered ${r.status}`);
        assert.match(r.body.error, /jukebox session/);
      }
    } finally {
      juke.ws.close();
    }
    const prefs = await call(server, 'GET', PREFS, undefined, tokens.bob);
    assert.equal(prefs.body.window, 30, 'the refused PUT wrote nothing');
  });

  test('validation: caps, enums and unknown keys answer 400', async () => {
    const bad = [
      { window: 14 },
      { filter: 'hot' },
      { staleDays: 0 },
      { staleDays: 3651 },
      { sources: ['library', 'radio'] },
      { limit: { tracks: 51 } },
      { limit: { seeds: 13 } },
      { limit: { albums: 25 } },
      { limit: { network: 51 } },
      { limit: { peers: 26 } },
      { pin: Array.from({ length: 9 }, (_, i) => `testlib/x${i}.mp3`) },
      { exclude: Array.from({ length: 201 }, (_, i) => `h${i}`) },
      { exclude: ['x'.repeat(129)] },
      { surprise: true },
    ];
    for (const body of bad) {
      assert.equal((await taste('bob', body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    for (const body of [{ window: 14 }, { staleDays: 0 }, { exclude: 'h' }, { theme: 'dark' }]) {
      assert.equal((await call(server, 'PUT', PREFS, body, tokens.bob)).status, 400, JSON.stringify(body));
    }
  });
});

// ── seeds ────────────────────────────────────────────────────────────────

describe('discovery taste: seeds', () => {
  test('completed plays seed first, then mostly-listened stops; skips and short stops never seed', async () => {
    const r = await taste('bob', { sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.seedSource, 'history');
    assert.equal(b.window, 30);
    assert.equal(b.widenedFrom, null);
    assert.equal(b.fallback, false);
    assert.equal(b.notAnalyzed, false);
    assert.deepEqual(b.model, { id: 'test-fake', version: '1' });
    assert.deepEqual(paths(b.seeds), [P.beSomebody, P.stat], 'Highway (skipped last), Neon (35 s of 6 min) and Orbit (5 s skip) do not seed');
    const [first, second] = b.seeds;
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
    assert.deepEqual(paths(r.body.seeds), [P.rise, P.sketch, P.beSomebody, P.stat]);
    assert.deepEqual(r.body.seeds.map((s) => s.pinned), [true, true, false, false]);
    assert.equal(r.body.seeds[1].analyzed, false, 'a pin the worker has not reached is listed, not used');
    assert.equal(r.body.seedSource, 'history');
    assert.ok(!paths(r.body.library.tracks).includes(P.rise), 'a pinned song is never recommended back');

    const only = await taste('bob', { pin: [P.rise], limit: { seeds: 1 }, sources: ['library'] });
    assert.deepEqual(paths(only.body.seeds), [P.rise]);
    assert.equal(only.body.seedSource, 'pinned');
  });

  test('exclusions: remembered server-side, resolved for the seeds sheet, re-included by PUT', async () => {
    const plain = await taste('erin', { sources: ['library'] });
    assert.deepEqual(paths(plain.body.seeds), [P.beSomebody, P.rise]);
    const h = plain.body.seeds[0].hash;

    const dropped = await taste('erin', { exclude: [h], remember: true, window: 90, sources: ['library'] });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    assert.deepEqual(paths(dropped.body.seeds), [P.rise]);
    assert.equal(dropped.body.window, 90);
    assert.deepEqual(dropped.body.excluded.map((e) => [e.hash, e.filepath, e.metadata.title]), [[h, P.beSomebody, 'Be Somebody']]);

    const prefs = await call(server, 'GET', PREFS, undefined, tokens.erin);
    assert.equal(prefs.status, 200);
    assert.deepEqual(prefs.body, { window: 90, filter: 'fresh', staleDays: 90, exclude: [h], persisted: true });

    // The next call (any client of this account) sends nothing and agrees.
    const again = await taste('erin', { sources: ['library'] });
    assert.deepEqual(paths(again.body.seeds), [P.rise], 'the saved exclusion applies without being sent');
    assert.equal(again.body.window, 90, 'the saved window applies');
    // Under 'all', so only the exclusion can keep it out (fresh would drop
    // it anyway: erin played it yesterday).
    const all = await taste('erin', { sources: ['library'], filter: 'all' });
    const recommended = [...paths(all.body.library.tracks), ...all.body.library.albums.flatMap((a) => a.tracks)];
    assert.ok(recommended.length > 0);
    assert.ok(!recommended.includes(P.beSomebody), 'a dropped seed is not recommended back either');

    // A pin is an explicit choice: it seeds even while its song is excluded.
    const pinned = await taste('erin', { pin: [P.beSomebody], sources: ['library'] });
    assert.deepEqual(paths(pinned.body.seeds), [P.beSomebody, P.rise]);
    assert.equal(pinned.body.seeds[0].pinned, true);

    const put = await call(server, 'PUT', PREFS, { exclude: [], window: null }, tokens.erin);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body, { window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: true });
    const back = await taste('erin', { sources: ['library'] });
    assert.deepEqual(paths(back.body.seeds), [P.beSomebody, P.rise]);

    // Without remember, an exclusion lasts for the call only.
    await taste('erin', { exclude: [h], sources: ['library'] });
    assert.deepEqual((await call(server, 'GET', PREFS, undefined, tokens.erin)).body.exclude, []);
  });

  test('nothing counted at all: one random analyzed track from the caller\'s own libraries, the same all day', async () => {
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
    // Assumes no UTC date change between the two calls (the pick is salted
    // with the UTC date; taste-queries' unit suite pins the salt itself).
    const again = await taste('carol');
    assert.equal(again.body.seeds[0].hash, r.body.seeds[0].hash, 'deterministic per user per day');

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
    assert.deepEqual(r.body.library, { filter: 'fresh', tracks: [], albums: [], capped: false });
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
  const tracksOnly = (filter, extra = {}) => taste('bob', { filter, sources: ['library'], limit: { albums: 0, tracks: 50 }, ...extra });

  test('filter all: every visible analyzed song but the seeds, best match first, rows per §3.1', async () => {
    const r = await tracksOnly('all');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lib = r.body.library;
    assert.equal(lib.filter, 'all');
    assert.deepEqual(new Set(paths(lib.tracks)), new Set([P.rise, P.orbit, P.ret, P.descent, P.highway, P.neon]),
      'no seeds, no lib2 (not bob\'s), no Sketch (not analyzed)');
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
    const neon = lib.tracks.find((t) => t.filepath === P.neon);
    assert.equal(neon.playCount, 1);
    assert.match(neon.lastPlayed, /Z$/);
    assert.equal(lib.capped, false);
    assert.deepEqual(lib.albums, []);
  });

  test('filter unplayed / fresh: played and tried-and-bounced songs leave; fresh keeps the stale ones', async () => {
    const unplayed = await tracksOnly('unplayed');
    assert.deepEqual(new Set(paths(unplayed.body.library.tracks)), new Set([P.rise, P.ret, P.descent]),
      'no Orbit (5 s skip, never played), no Highway / Neon (played)');
    const fresh = await tracksOnly('fresh');
    assert.deepEqual(new Set(paths(fresh.body.library.tracks)), new Set([P.rise, P.ret, P.descent]),
      'default fresh = 90 days: everything bob played is recent');
    const stale = await tracksOnly('fresh', { staleDays: 1 });
    assert.deepEqual(new Set(paths(stale.body.library.tracks)), new Set([P.rise, P.ret, P.descent, P.neon]),
      'Neon was last played 3 days ago; Highway 12 hours ago');
  });

  test('albums before songs: unplayed cards by their best track, their songs out of the tracks list', async () => {
    const r = await taste('bob', { sources: ['library'] });
    const lib = r.body.library;
    assert.equal(lib.filter, 'fresh', 'the default');
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

    const all = await taste('bob', { filter: 'all', sources: ['library'] });
    const names = all.body.library.albums.map((a) => a.name);
    assert.ok(names.includes('Night Drive') && names.includes('Be Somebody'), names.join());
    const nd = all.body.library.albums.find((a) => a.name === 'Night Drive');
    assert.equal(nd.playedTracks, 3);
    assert.match(nd.lastPlayed, /Z$/);
  });

  test('library seed cap: only the 6 newest history seeds get a library pass', async () => {
    const r = await taste('fay', { filter: 'all', sources: ['library'], limit: { albums: 0, tracks: 50 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seeds.length, 7, 'all seven are listed');
    assert.equal(r.body.seeds[6].filepath, P.descent);
    // Neon sits closest to Descent (a near duplicate of it, even). Descent
    // is the 7th seed, so Neon is matched against the first six only.
    assert.deepEqual(paths(r.body.library.tracks), [P.neon]);
    assert.equal(r.body.library.tracks[0].seedHash, hashOf[P.ret]);
    const firstSix = new Set(r.body.seeds.slice(0, 6).map((x) => x.hash));
    assert.ok(firstSix.has(r.body.library.tracks[0].seedHash));
  });

  test('low ratings (≤ 2 stars) leave fresh / unplayed, and stay under all', async () => {
    const rate = await call(server, 'POST', '/api/v1/db/rate-song', { filepath: P.ret, rating: 4 }, tokens.gus);
    assert.equal(rate.status, 200, JSON.stringify(rate.body));
    const body = { sources: ['library'], limit: { albums: 0, tracks: 50 } };
    const unplayed = await taste('gus', { ...body, filter: 'unplayed' });
    assert.ok(!paths(unplayed.body.library.tracks).includes(P.ret), 'rated 2 stars');
    assert.ok(paths(unplayed.body.library.tracks).includes(P.descent), 'its unrated neighbour stays');
    const all = await taste('gus', { ...body, filter: 'all' });
    assert.ok(paths(all.body.library.tracks).includes(P.ret));
  });

  test('ignoreVPaths scopes the library', async () => {
    const body = { filter: 'all', sources: ['library'], limit: { albums: 0, tracks: 50 } };
    const both = await taste('admin', body);
    assert.ok(paths(both.body.library.tracks).includes(P.zed), 'lib2 is the admin\'s');
    const one = await taste('admin', { ...body, ignoreVPaths: ['lib2'] });
    assert.ok(one.body.library.tracks.length > 0);
    assert.ok(paths(one.body.library.tracks).every((p) => p.startsWith('testlib/')), paths(one.body.library.tracks).join());
  });

  test('a repeat call is served from the cache; a stats reset drops it', async () => {
    const body = { sources: ['library'], filter: 'all', limit: { albums: 0 } };
    const riseOf = (r) => r.body.library.tracks.find((t) => t.filepath === P.rise);
    const a = await taste('ivy', body);
    assert.equal(riseOf(a).playCount, 1);
    // Another counted skip: Rise's count moves, the seed set does not.
    await postPlays(server, tokens.ivy, [play(P.rise, DAY / 4, 'skipped', 40000, 200000)]);
    const b = await taste('ivy', body);
    assert.deepEqual(paths(b.body.seeds), paths(a.body.seeds));
    assert.equal(riseOf(b).playCount, 1, 'the cached answer, not a recompute (the count is 2 now)');
    assert.deepEqual(b.body.library, a.body.library);
    // A counts reset leaves the log (and so the seeds) alone, but the rows
    // carry the counts it erased: the cache must not outlive it.
    const reset = await call(server, 'POST', '/api/v1/stats/reset', { scope: 'counts' }, tokens.ivy);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const c = await taste('ivy', body);
    assert.deepEqual(paths(c.body.seeds), paths(a.body.seeds));
    assert.equal(riseOf(c).playCount, 0, 'recomputed after the reset');
  });

  test('what may be cached: never a failed section or a fan-out with an unreachable peer', async () => {
    const { cacheableSections } = await import('../../src/api/discovery-taste.js');
    const library = { filter: 'all', tracks: [], albums: [], capped: false };
    const network = { results: [], searched: { peers: 1, tracks: 3 } };
    const peers = (unreachable) => ({ peers: [], searched: { peers: 1, unreachable, mismatched: 0 } });
    assert.deepEqual(Object.keys(cacheableSections({ library, network, peers: peers(0) })), ['library', 'network', 'peers']);
    assert.deepEqual(Object.keys(cacheableSections({ library, network, peers: peers(1) })), ['library', 'network'],
      'an unreachable peer costs only the peers entry');
    assert.deepEqual(Object.keys(cacheableSections({ library, network: { ...network, failed: true } })), ['library']);
    assert.deepEqual(Object.keys(cacheableSections({ peers: { ...peers(0), failed: true } })), []);
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

// ── prefs + reset ────────────────────────────────────────────────────────

describe('discovery taste: prefs and the stats reset', () => {
  test('GET answers the defaults; PUT saves, merges and validates', async () => {
    const empty = await call(server, 'GET', PREFS, undefined, tokens.carol);
    assert.deepEqual(empty.body, { window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: true });
    const put = await call(server, 'PUT', PREFS, { filter: 'all', staleDays: 30 }, tokens.carol);
    assert.deepEqual(put.body, { window: 30, filter: 'all', staleDays: 30, exclude: [], persisted: true });
    const put2 = await call(server, 'PUT', PREFS, { window: 7 }, tokens.carol);
    assert.deepEqual(put2.body, { window: 7, filter: 'all', staleDays: 30, exclude: [], persisted: true }, 'other prefs kept');
    const r = await taste('carol', { sources: ['library'] });
    assert.equal(r.body.library.filter, 'all', 'the saved filter applies to the page');
  });

  test('a history reset clears the prefs and the counters stop seeding (random, not counters)', async () => {
    await call(server, 'PUT', PREFS, { window: 90 }, tokens.dave);
    const reset = await call(server, 'POST', '/api/v1/stats/reset', { scope: 'history' }, tokens.dave);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.scope, 'history');
    const prefs = await call(server, 'GET', PREFS, undefined, tokens.dave);
    assert.equal(prefs.body.window, 30, 'the discovery:page namespace went with the history');
    const r = await taste('dave', { sources: ['library'] });
    assert.equal(r.body.seedSource, 'random', 'pre-reset counters are not seeds');
  });
});

// ── public mode ──────────────────────────────────────────────────────────

describe('discovery taste: public mode', () => {
  test('the shared account gets a page and never persists', async () => {
    const first = await call(pubServer, 'POST', TASTE, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.seedSource, 'random');

    await postPlays(pubServer, undefined, [play(P.rise, DAY, 'completed', 200000, 200000)]);
    const r = await call(pubServer, 'POST', TASTE, { remember: true, window: 90, exclude: ['abc'], sources: ['library'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seedSource, 'history');
    assert.deepEqual(paths(r.body.seeds), [P.rise]);
    assert.equal(first.body.network, null, 'p2p is on, but a random seed sends nothing anywhere');

    const prefs = await call(pubServer, 'GET', PREFS);
    assert.deepEqual(prefs.body, { window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: false });
    const put = await call(pubServer, 'PUT', PREFS, { window: 7 });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { window: 7, filter: 'fresh', staleDays: 90, exclude: [], persisted: false });
    assert.equal((await call(pubServer, 'GET', PREFS)).body.window, 30, 'nothing stored');
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
});

// ── capability flag ──────────────────────────────────────────────────────

describe('discovery taste: the capability flag', () => {
  test('features.discoveryTaste on GET /api and discoveryTaste on ping, an integer generation', async () => {
    const api = await call(server, 'GET', '/api/', undefined, tokens.bob);
    assert.equal(api.body.features.discoveryTaste, 1);
    const ping = await call(server, 'GET', '/api/v1/ping', undefined, tokens.bob);
    assert.equal(ping.body.discoveryTaste, 1);
    // A version fact: present (and the same) with discovery off too.
    const off = await call(offServer, 'GET', '/api/v1/ping');
    assert.equal(off.body.discoveryTaste, 1);
    assert.equal(off.body.discovery, false);
  });
});
