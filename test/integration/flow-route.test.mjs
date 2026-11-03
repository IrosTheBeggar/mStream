/**
 * POST /api/v1/db/flow — flow ordering over HTTP (src/api/flow.js over the
 * pure orderer in src/db/flow-order.js).
 *
 * Three servers:
 *   - `server`: discovery ON (model 'test-fake'), federation ON, the fixture
 *     library plus an admin-only `lib2`; BPM / key / moods / handcrafted
 *     4-d vectors are planted straight into the databases after the scan,
 *     so every expectation is known in advance.
 *   - `offServer`: defaults (discovery off, public mode) with BPM / key
 *     only — flow must still order, never 403.
 *   - `gateServer`: holds each solve for 500 ms (MSTREAM_TEST_FLOW_HOLD_MS)
 *     so the one-at-a-time gate and its 429 can be filled deterministically.
 *
 * Covers the response shape, duplicates, uniform `unplaced` (unknown file,
 * forbidden library, path escape), discovery-off ordering with why-codes and
 * `end`, the 400s, `after` (vector, model mismatch keeping BPM and key, BPM),
 * `returnEnd` with a vector and a seed, `end` fed back as `after` (null
 * members, an out-of-range BPM), determinism, the federation allowlist on
 * both the wall and the outbound proxy screen, the feature flag, and the 429
 * with its one-at-a-time spacing.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'admin', password: 'pw-admin' };
const BOB = { username: 'bob', password: 'pw-bob' };   // testlib only
const ROUTE = '/api/v1/db/flow';

const P = {
  'Be Somebody': 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3',
  Rise: 'testlib/Icarus/Be Somebody/02 - Rise.mp3',
  Orbit: 'testlib/Icarus/Be Somebody/03 - Orbit.mp3',
  Return: 'testlib/Icarus/Later Works/01 - Return.mp3',
  Descent: 'testlib/Icarus/Later Works/02 - Descent.mp3',
  Highway: 'testlib/Vosto/Night Drive/01 - Highway.mp3',
  Neon: 'testlib/Vosto/Night Drive/02 - Neon.mp3',
  Static: 'testlib/Vosto/Night Drive/03 - Static.mp3',
  'Sketch 1': 'testlib/Vosto/Untitled EP/01 - Sketch 1.mp3',
};
const TESTLIB = Object.values(P);
const LIB2_PATH = 'lib2/zed.mp3';

const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const b64 = (v) => blob(v).toString('base64');

// Planted on `server`. Sketch 1 gets nothing (so it is unanalysed).
const BPM_KEY = {
  'Be Somebody': [124, '8A'],
  Rise: [125, 'Am'],
  Orbit: [128, '9A'],
  Return: [70, 'C major'],
  Descent: [140, 'A minor'],
  Highway: [62, 'G minor'],
  Neon: [124, '8B'],
  Static: [170, 'junk'],
  'Lib2 Song': [120, '8A'],
};
const MOODS = {   // aggressive, party, danceable, relaxed
  'Be Somebody': [0.7, 0.9, 0.9, 0.2],
  Rise: [0.8, 0.8, 0.8, 0.1],
  Orbit: [0.1, 0.1, 0.6, 0.8],
  Return: [0.1, 0, 0.1, 0.7],
  Highway: [0, 0, 0.2, 0.9],
  Neon: [0.3, 0, 0.7, 0.6],
};
const VECS = {
  'Be Somebody': vec(1, 0, 0, 0),
  Rise: vec(0.95, 0.312, 0, 0),
  Orbit: vec(0.8, 0.6, 0, 0),
  Return: vec(0, 1, 0, 0),
  Descent: vec(0, 0, 1, 0),
  Highway: vec(0.5, 0.866, 0, 0),
  'Lib2 Song': vec(0.9, 0.436, 0, 0),
};
// Planted on `offServer` (BPM and key only). Orbit's and Return's BPMs are
// outside what `after` accepts (20–300), so `end` must not hand them on.
const OFF_BPM_KEY = {
  'Be Somebody': [124, '8A'],
  Static: [170, '2B'],
  Neon: [124, 'Am'],
  Highway: [62, 'A minor'],
  Orbit: [400, '8A'],
  Return: [10, null],
};

let server;
let offServer;
let gateServer;
let lib2Dir;
const tokens = {};

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`))));
  });
}

async function flow(srv, body, { user = 'admin', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (user && tokens[user] && srv === server) { h['x-access-token'] = tokens[user]; }
  const r = await fetch(`${srv.baseUrl}${ROUTE}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function plantBpmKey(srv, table) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'));
  try {
    const upd = mdb.prepare('UPDATE tracks SET bpm = ?, musical_key = ? WHERE title = ?');
    for (const [title, [bpm, key]] of Object.entries(table)) {
      assert.equal(Number(upd.run(bpm, key, title).changes), 1, `fixture track '${title}'`);
    }
  } finally {
    mdb.close();
  }
}

before(async () => {
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-flow-lib2-'));
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-metadata', 'artist=Zed', '-metadata', 'title=Lib2 Song', '-metadata', 'album=Zed Album',
    '-ac', '1', path.join(lib2Dir, 'zed.mp3'),
  ]);

  [server, offServer, gateServer] = await Promise.all([
    startServer({
      dlnaMode: 'disabled',
      extraConfig: {
        federation: { enabled: true },
        scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
      },
      extraFolders: { lib2: lib2Dir },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'lib2'] },
        { ...BOB, admin: false, vpaths: ['testlib'] },
      ],
    }),
    startServer({ dlnaMode: 'disabled' }),
    startServer({ dlnaMode: 'disabled', waitForScan: false, env: { MSTREAM_TEST_FLOW_HOLD_MS: '500' } }),
  ]);

  for (const u of [ADMIN, BOB]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
    });
    tokens[u.username] = (await r.json()).token;
  }

  plantBpmKey(server, BPM_KEY);
  plantBpmKey(offServer, OFF_BPM_KEY);

  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
  const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
  try {
    const moods = mdb.prepare(`
      INSERT INTO track_moods (track_id, aggressive, party, danceable, relaxed, happy, sad, acoustic, instrumental)
      SELECT id, ?, ?, ?, ?, 0, 0, 0, 0 FROM tracks WHERE title = ?
    `);
    for (const [title, m] of Object.entries(MOODS)) {
      assert.equal(Number(moods.run(...m, title).changes), 1, `moods for '${title}'`);
    }

    const trackByTitle = (title) => mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
    `).get(title);
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?)
    `);
    let seq = 0;
    for (const [title, v] of Object.entries(VECS)) {
      const t = trackByTitle(title);
      assert.ok(t?.hash, `fixture track '${title}' must exist with a hash`);
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, t.artist, title, t.duration ?? 120, blob(v));
    }
    // Raw INSERTs don't bump the rowversion; the index would cache an empty view.
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
});

after(async () => {
  await Promise.all([server?.stop(), offServer?.stop(), gateServer?.stop()]);
  if (lib2Dir) { fs.rmSync(lib2Dir, { recursive: true, force: true }); }
});

const isPerm = (order, n) => Array.isArray(order) && order.length === n && new Set(order).size === n
  && order.every((i) => Number.isInteger(i) && i >= 0 && i < n);

describe('flow: the answer', () => {
  test('shape: a permutation from the pinned start, every signal, the model', async () => {
    const { status, body } = await flow(server, { songs: TESTLIB, start: 0 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(isPerm(body.order, TESTLIB.length));
    assert.equal(body.order[0], 0);
    body.order.forEach((i, k) => assert.equal(body.songs[k], TESTLIB[i]));
    assert.deepEqual(body.signals, { sound: true, tempo: true, key: true, energy: true });
    assert.deepEqual(body.model, { id: 'test-fake', version: '1' });
    assert.equal(body.seed, null);
    assert.equal(body.arc, 'steady');
    assert.ok(['complete', 'budget'].includes(body.solver), body.solver);
    assert.deepEqual(body.unanalysed, [TESTLIB.indexOf(P['Sketch 1'])]);
    assert.deepEqual(body.unplaced, []);
    assert.equal(body.order[body.order.length - 1], TESTLIB.indexOf(P['Sketch 1']), 'unanalysed after the run');
    for (const k of ['transitions', 'end', 'afterIgnored']) { assert.ok(!(k in body), `no ${k} unless asked`); }
    for (const k of ['transitions', 'meanCost', 'meanSound', 'tempoOk', 'keyOk', 'keyClash', 'artistRepeats', 'worst']) {
      assert.ok(k in body.stats.before && k in body.stats.after, k);
    }
    assert.ok(body.stats.after.meanCost <= body.stats.before.meanCost);
  });

  test('duplicates: both copies placed, each index exactly once', async () => {
    const songs = [P['Be Somebody'], P['Be Somebody'], P.Rise, P.Orbit, P.Return];
    const { status, body } = await flow(server, { songs });
    assert.equal(status, 200);
    assert.ok(isPerm(body.order, 5));
    assert.equal(body.order.filter((i) => i === 0 || i === 1).length, 2);
    assert.deepEqual(body.unplaced, []);
  });

  test('unplaced is uniform: a forbidden library, an unknown file, an unknown library and a path escape', async () => {
    const songs = [P['Be Somebody'], P.Rise, LIB2_PATH, 'testlib/nope.mp3', 'nolib/x.mp3', 'testlib/../../etc/passwd'];
    const bob = await flow(server, { songs }, { user: 'bob' });
    assert.equal(bob.status, 200, JSON.stringify(bob.body));
    assert.deepEqual(bob.body.unplaced, [2, 3, 4, 5]);
    assert.deepEqual(bob.body.order.slice(2), [2, 3, 4, 5]);
    const admin = await flow(server, { songs });
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.unplaced, [3, 4, 5], 'the same lib2 path is placed for a user who has it');
  });

  test('discovery off: still ordered by BPM and key, never a 403', async () => {
    const songs = [P['Be Somebody'], P.Static, P.Neon, P.Highway];
    const { status, body } = await flow(offServer, { songs, start: 0, explain: true, returnEnd: true });
    assert.equal(status, 200, JSON.stringify(body));
    // Path costs by hand (tempo 4/7, key 3/7, +0.10 same artist):
    // 0→2→3→1 = 1.217, the runner-up 0→3→2→1 = 1.234.
    assert.deepEqual(body.order, [0, 2, 3, 1]);
    assert.deepEqual(body.signals, { sound: false, tempo: true, key: true, energy: false });
    assert.equal(body.model, null);
    assert.deepEqual(body.transitions.map((t) => [t.from, t.to]), [[0, 2], [2, 3], [3, 1]]);
    assert.deepEqual(body.transitions.map((t) => t.why), [
      ['sameKey', 'tempoMatch'],
      ['sameKey', 'halfTime', 'sameArtist'],
      ['keyClash', 'tempoJump', 'sameArtist'],
    ]);
    assert.deepEqual(body.end, { index: 1, bpm: 170, key: '2B' });
    assert.ok(body.stats.after.meanCost < body.stats.before.meanCost);
  });
});

describe('flow: validation', () => {
  test('400s', async () => {
    const two = [P['Be Somebody'], P.Rise];
    const cases = [
      [{ songs: two, shuffle: true }, 'unknown key'],
      [{ songs: [P.Rise] }, 'one song'],
      [{ songs: Array.from({ length: 1001 }, (_, i) => `testlib/x${i}.mp3`) }, '1001 songs'],
      [{ songs: two, start: 9 }, 'start out of range'],
      [{ songs: two, start: 1, end: 1 }, 'start === end'],
      [{ songs: two, start: 0, after: { bpm: 120 } }, 'after with start'],
      [{ songs: two, weights: { sound: 0, tempo: 0, key: 0, energy: 0 } }, 'all-zero weights'],
      [{ songs: two, after: { vector: b64(vec(1, 0, 0, 0)) } }, 'vector without modelId'],
      [{ songs: two, after: { vector: b64(new Float32Array([1, 0, 0])), modelId: 'test-fake' } }, 'wrong vector width'],
    ];
    for (const [body, label] of cases) {
      const r = await flow(server, body);
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    }
  });
});

describe('flow: joining runs', () => {
  const songs = [P['Be Somebody'], P.Return, P.Descent, P.Highway];

  // A vector between Return's and Highway's (cos 0.95 / 0.98, under the
  // same-recording cut). Without `after` the run starts at an end of
  // Descent–Return–Highway–Be Somebody (≈1.10 either way round); after this
  // vector, alone, the cheapest path is Return → Highway → Be Somebody →
  // Descent (≈1.73; the runner-up, from Be Somebody, ≈1.80).
  const nearHighway = b64(vec(0.3, 0.954, 0, 0));
  const VECTOR_ORDER = [1, 3, 0, 2];

  test('after: a vector from this model, a vector from another, BPM and key alone', async () => {
    const none = await flow(server, { songs });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.notDeepEqual(none.body.order, VECTOR_ORDER, 'the fixture: the vector must change the answer');

    const same = await flow(server, { songs, after: { vector: nearHighway, modelId: 'test-fake' } });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual(same.body.order, VECTOR_ORDER, 'flows out of the vector (Return, Highway, …)');
    assert.ok(!('afterIgnored' in same.body));

    // The whole path counts, not just the first step: after 124/8A the
    // cheapest path starts at Be Somebody (124/8A) and costs ≈1.36; the
    // next best start (Descent) ≈1.56.
    const bpm = await flow(server, { songs, after: { bpm: 124, key: '8A' } });
    assert.equal(bpm.status, 200);
    assert.equal(bpm.body.order[0], 0, 'flows out of the 124 BPM / 8A song (Be Somebody)');
    assert.ok(!('afterIgnored' in bpm.body));

    // A foreign model's vector is dropped, but its BPM and key still steer.
    const other = await flow(server, { songs, after: { vector: nearHighway, modelId: 'other-model', bpm: 124, key: '8A' } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.afterIgnored, 'modelMismatch');
    assert.equal(other.body.order[0], 0, 'the BPM / key answer, not the vector\'s');
    assert.deepEqual(other.body.order, bpm.body.order);
  });

  test('returnEnd round-trips: `end` passed as is as the next call\'s `after`', async () => {
    const next = [P['Be Somebody'], P.Return, P.Descent, P.Highway];

    // Static: BPM 170, a junk key (null), no embedding → { index, bpm, key: null }.
    const a = await flow(server, { songs: [P['Be Somebody'], P.Rise, P.Static], end: 2, returnEnd: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.end, { index: 2, bpm: 170, key: null });
    const a2 = await flow(server, { songs: next, after: a.body.end });
    assert.equal(a2.status, 200, JSON.stringify(a2.body));

    // Discovery off, a stored BPM out of range (400): bpm null, the key kept;
    // joined onto the other server, as a cross-server run would be.
    const b = await flow(offServer, { songs: [P['Be Somebody'], P.Neon, P.Orbit], end: 2, returnEnd: true });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual(b.body.end, { index: 2, bpm: null, key: '8A' });
    const b2 = await flow(server, { songs: next, after: b.body.end });
    assert.equal(b2.status, 200, JSON.stringify(b2.body));

    // Placed only by an out-of-range BPM (10, no key): nothing to join on.
    const c = await flow(offServer, { songs: [P['Be Somebody'], P.Neon, P.Return], end: 2, returnEnd: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.end, null);

    // The shape `end` takes for an embedded song with no tags: the vector
    // alone still steers — the answer is the vector's, not the one without
    // `after`.
    const d = await flow(server, { songs: next, after: { index: 4, bpm: null, key: null, vector: nearHighway, modelId: 'test-fake' } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const none = await flow(server, { songs: next });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual(d.body.order, VECTOR_ORDER, 'the vector still steers');
    assert.notDeepEqual(d.body.order, none.body.order);

    for (const bad of [{ bpm: null, key: null }, { index: 1, modelId: 'test-fake' }, { vector: nearHighway, modelId: null, bpm: 120 }]) {
      const r = await flow(server, { songs: next, after: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
    }
  });

  test('returnEnd carries the last song\'s vector; a seed is echoed and reproduces its order', async () => {
    const list = [P['Be Somebody'], P.Rise, P.Orbit, P.Return, P.Descent, P.Highway];
    const titles = ['Be Somebody', 'Rise', 'Orbit', 'Return', 'Descent', 'Highway'];
    const a = await flow(server, { songs: list, seed: 42, returnEnd: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.seed, 42);
    assert.equal(a.body.end.index, a.body.order[a.body.order.length - 1]);
    assert.equal(a.body.end.modelId, 'test-fake');
    const raw = Buffer.from(a.body.end.vector, 'base64');
    const got = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    assert.deepEqual(Array.from(got), Array.from(VECS[titles[a.body.end.index]]));
    const [bpm, key] = BPM_KEY[titles[a.body.end.index]];
    assert.equal(a.body.end.bpm, bpm);
    assert.ok(typeof a.body.end.key === 'string' || (key === 'junk' && a.body.end.key === null));

    const b = await flow(server, { songs: list, seed: 42, returnEnd: true });
    assert.deepEqual(b.body.order, a.body.order);
  });

  test('determinism: shuffled input, and a rerun on its own output, give the same sequence', async () => {
    const shuffled = [5, 2, 8, 0, 7, 3, 1, 6, 4].map((i) => TESTLIB[i]);
    const a = await flow(server, { songs: TESTLIB });
    const b = await flow(server, { songs: shuffled });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.songs, a.body.songs);
    const c = await flow(server, { songs: a.body.songs });
    assert.deepEqual(c.body.songs, a.body.songs);
  });
});

describe('flow: federation', () => {
  test('a federation key may call it, scoped to its grants; the outbound proxy screen passes it', async () => {
    const mint = await fetch(`${server.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({ name: 'Peer', vpaths: ['testlib'] }),
    });
    assert.equal(mint.status, 200);
    const { key } = await mint.json();
    assert.match(key, /^fedk_/);

    const r = await flow(server, { songs: [P['Be Somebody'], P.Rise, LIB2_PATH] }, { user: null, headers: { 'x-federation-key': key } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.unplaced, [2]);

    const proxied = await fetch(`${server.baseUrl}/api/v1/federation/peers/424242/api${ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({ songs: [P.Rise, P.Orbit] }),
    });
    assert.equal(proxied.status, 404, 'past the screen; the peer is unknown');
    const offList = await fetch(`${server.baseUrl}/api/v1/federation/peers/424242/api/api/v1/db/rated`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': tokens.admin },
      body: JSON.stringify({}),
    });
    assert.equal(offList.status, 403, 'an off-list route is refused before the peer lookup');
  });
});

describe('flow: flag', () => {
  test('features.flowOrder and ping.flowOrder, with discovery on and off', async () => {
    for (const [srv, h] of [[server, { 'x-access-token': tokens.admin }], [offServer, {}]]) {
      const api = await (await fetch(`${srv.baseUrl}/api/`, { headers: h })).json();
      assert.equal(api.features.flowOrder, 1);
      const ping = await (await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: h })).json();
      assert.equal(ping.flowOrder, 1);
    }
  });
});

describe('flow: concurrency', () => {
  test('one solve at a time, four waiting, a 429 past that', async () => {
    const HOLD_MS = 500;   // gateServer's MSTREAM_TEST_FLOW_HOLD_MS
    const body = { songs: ['testlib/nope-1.mp3', 'testlib/nope-2.mp3'] };
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 6 }, async () => {
      const r = await flow(gateServer, body);
      return { ...r, at: performance.now() - t0 };
    }));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], JSON.stringify(results));
    // Serialised, not merely capped: each 200 lands a full hold after the
    // one before it (several slots at once would land some together).
    const done = results.filter((r) => r.status === 200).map((r) => r.at).sort((x, y) => x - y);
    for (let k = 1; k < done.length; k++) {
      assert.ok(done[k] - done[k - 1] >= HOLD_MS * 0.8, `200s ${k - 1}→${k} only ${Math.round(done[k] - done[k - 1])} ms apart: ${done.map(Math.round)}`);
    }
    const late = await flow(gateServer, body);
    assert.equal(late.status, 200);
  });
});

// The webapp's runner (webapp/alpha/queue-flow.js) against the real route:
// `server` stands in for this server and `offServer` for a peer (7).
describe('flow: the webapp runner', () => {
  const QUEUEFLOW = createRequire(import.meta.url)('../../webapp/alpha/queue-flow.js');
  const httpCall = (target) => async (srv, body) => {
    const r = await flow(target(srv), body);
    if (r.status !== 200) { throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: r.body }); }
    return r.body;
  };

  test('a pinned run joined onto a second server by its end; the foreign vector is dropped softly', async () => {
    const answers = [];
    const sent = [];
    const call = httpCall((srv) => (srv === null ? server : offServer));
    const items = [
      QUEUEFLOW.item(null, `/${P.Rise}`, {}), QUEUEFLOW.item(7, P.Static, {}), QUEUEFLOW.item(null, P.Orbit, {}),
      QUEUEFLOW.item(7, P.Neon, {}), QUEUEFLOW.item(null, P.Return, {}), QUEUEFLOW.item(7, P.Highway, {}),
      QUEUEFLOW.item(null, P.Descent, {}),
    ];
    const res = await QUEUEFLOW.flowRuns(items, {
      lead: QUEUEFLOW.item(null, P['Be Somebody'], { bpm: 124 }),
      call: async (srv, body, signal) => { sent.push({ srv, body }); const a = await call(srv, body, signal); answers.push(a); return a; },
    });
    assert.equal(res.failed, false, String(res.error && res.error.message));
    assert.equal(res.calls, 2);
    assert.ok(isPerm(res.order, items.length), JSON.stringify(res.order));
    assert.deepEqual(sent.map((c) => c.srv), [null, 7]);
    assert.equal(sent[0].body.start, 0);
    assert.equal(sent[0].body.songs[0], P['Be Somebody']);
    assert.equal(sent[0].body.returnEnd, true);
    assert.equal(sent[1].body.after.modelId, 'test-fake');
    assert.equal(typeof sent[1].body.after.vector, 'string');
    assert.equal(answers[1].afterIgnored, 'modelMismatch');
    // the local run first, then the peer's
    assert.deepEqual(res.order.slice(0, 4).map((i) => items[i].server), [null, null, null, null]);
    assert.deepEqual(res.order.slice(4).map((i) => items[i].server), [7, 7, 7]);
  });

  test('a server whose solve queue is full answers 429 and the runner fails', async () => {
    const body = { songs: ['testlib/nope-1.mp3', 'testlib/nope-2.mp3'] };
    const held = Array.from({ length: 5 }, () => flow(gateServer, body));
    await new Promise((r) => { setTimeout(r, 150); });
    const res = await QUEUEFLOW.flowRuns(
      [QUEUEFLOW.item(null, 'testlib/nope-1.mp3'), QUEUEFLOW.item(null, 'testlib/nope-2.mp3')],
      { call: httpCall(() => gateServer) },
    );
    assert.equal(res.failed, true);
    assert.equal(res.error.status, 429);
    assert.deepEqual((await Promise.all(held)).map((r) => r.status), [200, 200, 200, 200, 200]);
  });
});
