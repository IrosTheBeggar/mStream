/**
 * Discovery-over-federation, peer side (phase 1):
 * POST /api/v1/federation/discovery/similar + the /federation/health
 * discovery capability block (src/api/federation-discovery.js).
 *
 * Strategy (the discovery-similarity playbook): boot a real server with
 * federation enabled and discovery ON under the 'test-fake' model, two
 * libraries — 'shared' (granted to the federation key) and the fixture
 * 'testlib' (NOT granted) — then seed discovery.db with handcrafted 4-d
 * unit vectors keyed to real scanned tracks so every cosine is exact.
 *
 * The scoping assertion is the sharp one: the single highest-cosine vector
 * in the whole index belongs to the UNGRANTED library and must never
 * appear in the key's results, while an admin JWT (whose vpaths span both
 * libraries) sees it at rank 1 through the very same route.
 *
 * A second server (federation on, discovery off) pins the gating: health
 * advertises discovery:null and the similar route is 403.
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

const ADMIN = { username: 'admin', password: 'pw-admin' };

// ── handcrafted vector space (4-d, unit vectors) ────────────────────────────
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const b64 = (v) => blob(v).toString('base64');

const Q = vec(1, 0, 0, 0);                    // the peer's query vector
const V = {
  ungranted: vec(0.98, 0.199, 0, 0),          // testlib — Be Somebody   cos ≈ 0.98 (index top!)
  alpha: vec(0.9, 0.436, 0, 0),               // shared  — Alpha Song    cos ≈ 0.9
  beta: vec(0.6, 0.8, 0, 0),                  // shared  — Beta Song     cos = 0.6
};

let server;      // federation + discovery on, seeded
let offServer;   // federation on, discovery off
let sharedDir;
let fedKey;      // granted ['shared'] on `server`
let offKey;      // any key on `offServer`
let adminToken;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

async function makeTrack(dir, file, freq, artist, title) {
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
    '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${artist} Album`,
    '-ac', '1', path.join(dir, file),
  ]);
}

async function loginAdmin(srv) {
  const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  return (await r.json()).token;
}

async function mintKey(srv, token, vpaths) {
  const r = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'Peer', vpaths }),
  });
  assert.equal(r.status, 200);
  const { key } = await r.json();
  assert.match(key, /^fedk_/);
  return key;
}

const fedHeaders = (key) => ({ 'x-federation-key': key, 'Content-Type': 'application/json' });

async function similar(srv, headers, body) {
  const r = await fetch(`${srv.baseUrl}/api/v1/federation/discovery/similar`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('federation discovery similar (peer side)', () => {
  before(async () => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-feddisc-'));
    await makeTrack(sharedDir, 'alpha.mp3', 440, 'Ana', 'Alpha Song');
    await makeTrack(sharedDir, 'beta.mp3', 880, 'Ben', 'Beta Song');

    [server, offServer] = await Promise.all([
      startServer({
        dlnaMode: 'disabled',
        extraConfig: {
          federation: { enabled: true },
          scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
        },
        extraFolders: { shared: sharedDir },
        users: [{ ...ADMIN, admin: true, vpaths: ['testlib', 'shared'] }],
      }),
      startServer({
        dlnaMode: 'disabled',
        waitForScan: false,
        extraConfig: { federation: { enabled: true } },
        users: [{ ...ADMIN, admin: true, vpaths: ['testlib'] }],
      }),
    ]);

    adminToken = await loginAdmin(server);
    fedKey = await mintKey(server, adminToken, ['shared']);
    offKey = await mintKey(offServer, await loginAdmin(offServer), ['testlib']);

    // Seed discovery.db with the crafted vectors, keyed to real scanned rows.
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
    const trackByTitle = (title) => mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
      FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
    `).get(title);
    const rowsToSeed = [
      ['Be Somebody', V.ungranted, null, null],
      ['Alpha Song', V.alpha, 'mbid-alpha-123', ['Test---StyleA', 'Test---StyleB']],
      ['Beta Song', V.beta, null, null],
    ];
    const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
    try {
      const ins = ddb.prepare(`
        INSERT INTO discovery_tracks
          (audio_hash, updated_at, export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding, genre_tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)
      `);
      let seq = 0;
      for (const [title, v, mbid, tags] of rowsToSeed) {
        const t = trackByTitle(title);
        assert.ok(t?.hash, `fixture track '${title}' must exist with a hash`);
        ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, mbid, t.artist, title, t.duration ?? 120,
          blob(v), tags ? JSON.stringify(tags) : null);
      }
      ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
      ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
    } finally {
      ddb.close();
      mdb.close();
    }
  });

  after(async () => {
    await Promise.all([server?.stop(), offServer?.stop()]);
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  test('health advertises the discovery capability block', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(fedKey) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.libraries, ['shared']);
    assert.deepEqual(j.discovery, { modelId: 'test-fake', modelVersion: '1', dim: 4, analyzedCount: 3 });
  });

  test('ranks by exact cosines within the granted library only', async () => {
    const { status, body } = await similar(server, fedHeaders(fedKey), { embedding: b64(Q), modelId: 'test-fake' });
    assert.equal(status, 200);
    assert.deepEqual(body.model, { id: 'test-fake', version: '1' });
    assert.ok(!body.modelMismatch);

    const titles = body.results.map((r) => r.title);
    assert.deepEqual(titles, ['Alpha Song', 'Beta Song'], 'granted-library tracks in descending cosine order');
    assert.ok(!titles.includes('Be Somebody'), 'the index-topping UNGRANTED track must never appear');

    for (const [i, expected] of [dot(Q, V.alpha), dot(Q, V.beta)].entries()) {
      assert.ok(Math.abs(body.results[i].similarity - expected) < 1e-3,
        `result ${i}: ${body.results[i].similarity} ≈ ${expected}`);
    }
    for (const r of body.results) {
      assert.ok(r.filepath.startsWith('shared/'), `filepath ${r.filepath} stays inside the grant`);
      assert.ok(typeof r.duration === 'number');
    }
    assert.equal(body.results[0].artist, 'Ana');
    assert.equal(body.results[0].recordingMbid, 'mbid-alpha-123');
    assert.deepEqual(body.results[0].genreTags, ['Test---StyleA', 'Test---StyleB']);
    assert.equal(body.results[1].recordingMbid, null);
    assert.equal(body.results[1].genreTags, null);
  });

  test('respects limit', async () => {
    const { body } = await similar(server, fedHeaders(fedKey), { embedding: b64(Q), modelId: 'test-fake', limit: 1 });
    assert.deepEqual(body.results.map((r) => r.title), ['Alpha Song']);
  });

  test('normalizes a scaled query vector defensively', async () => {
    const scaled = new Float32Array([7, 0, 0, 0]);   // same direction as Q, magnitude 7
    const { status, body } = await similar(server, fedHeaders(fedKey), { embedding: b64(scaled), modelId: 'test-fake' });
    assert.equal(status, 200);
    assert.ok(Math.abs(body.results[0].similarity - dot(Q, V.alpha)) < 1e-3,
      'similarity is cosine, not a raw dot product against the scaled vector');
  });

  test('model mismatch is a soft 200 answer', async () => {
    const { status, body } = await similar(server, fedHeaders(fedKey), { embedding: b64(Q), modelId: 'some-other-model' });
    assert.equal(status, 200);
    assert.equal(body.modelMismatch, true);
    assert.deepEqual(body.results, []);
    assert.equal(body.model.id, 'test-fake', 'the answer names this server\'s model space');
  });

  test('malformed vectors are 400s', async () => {
    const cases = [
      { embedding: b64(new Float32Array([1, 0, 0])), modelId: 'test-fake' },        // 12 bytes ≠ dim×4
      { embedding: b64(new Float32Array([NaN, 0, 0, 0])), modelId: 'test-fake' },   // non-finite
      { embedding: b64(new Float32Array([0, 0, 0, 0])), modelId: 'test-fake' },     // zero vector
      { embedding: '!!!not-base64!!!', modelId: 'test-fake' },                      // Joi base64
      { embedding: b64(Q) },                                                        // missing modelId
    ];
    for (const body of cases) {
      const r = await similar(server, fedHeaders(fedKey), body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  test('a regular admin JWT sees its own broader scope through the same route', async () => {
    const { status, body } = await similar(server,
      { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      { embedding: b64(Q), modelId: 'test-fake' });
    assert.equal(status, 200);
    assert.deepEqual(body.results.map((r) => r.title), ['Be Somebody', 'Alpha Song', 'Beta Song'],
      'admin vpaths span both libraries, so the testlib track leads');
  });

  test('discovery-off server: health capability null, similar 403', async () => {
    const health = await fetch(`${offServer.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(offKey) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).discovery, null);

    const r = await similar(offServer, fedHeaders(offKey), { embedding: b64(Q), modelId: 'test-fake' });
    assert.equal(r.status, 403);
  });
});
