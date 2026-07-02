/**
 * Similarity API tests — POST /api/v1/discovery/similar and
 * /api/v1/discovery/similar-artists (src/api/discovery.js +
 * src/db/discovery-similarity.js).
 *
 * Strategy: boot a real server (discovery ON, model 'test-fake') over the
 * scanned fixture library plus a second restricted library, then seed
 * discovery.db with HANDCRAFTED unit vectors keyed to real scanned tracks —
 * so every cosine in the ranking is known in advance and assertions are
 * exact, no ML involved. Covers:
 *
 *   - 403 when the feature is off (separate default-config server).
 *   - ranking order + similarity values match the handcrafted vectors.
 *   - result shape: {filepath, similarity, metadata(lite incl. bpm), genreTags}.
 *   - notAnalyzed for scanned-but-unembedded seeds (track AND artist).
 *   - 404 for unknown seed paths/artists (and other users' vpaths).
 *   - library access: users only see results (and entry points) from their
 *     own vpaths; hashes whose only copy is elsewhere are skipped.
 *   - excludeSameArtist + bpmRange (filters on LIVE tracks.bpm).
 *   - artist centroids, entryPoints ordering, topTags aggregation.
 *   - index invalidation via the row_seq rowversion.
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
const BOB = { username: 'bob', password: 'pw-bob' };   // testlib only

// ── handcrafted vector space (4-d, unit vectors) ────────────────────────────
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

// Seeded tracks (fixture titles → vectors). Cosines vs SEED are exact.
const V = {
  seed: vec(1, 0, 0, 0),           // Icarus — Be Somebody
  near: vec(0.95, 0.312, 0, 0),    // Icarus — Rise          cos ≈ 0.9500
  mid: vec(0.8, 0.6, 0, 0),        // Vosto — Highway        cos = 0.8
  far: vec(0.5, 0.866, 0, 0),      // Vosto — Neon           cos ≈ 0.5
  lib2: vec(0.9, 0.436, 0, 0),     // Zed — Lib2 Song        cos ≈ 0.9 (admin-only library)
};

let offServer;   // discovery disabled
let server;      // discovery enabled, seeded
const tokens = {};
let lib2Dir;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

async function api(route, body, user = 'admin') {
  const headers = { 'Content-Type': 'application/json' };
  if (tokens[user]) { headers['x-access-token'] = tokens[user]; }
  const r = await fetch(`${server.baseUrl}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function openDiscovery() {
  return new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
}

before(async () => {
  // Second library visible only to admin.
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-sim-lib2-'));
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-metadata', 'artist=Zed', '-metadata', 'title=Lib2 Song', '-metadata', 'album=Zed Album',
    '-ac', '1', path.join(lib2Dir, 'zed.mp3'),
  ]);
  // A second lib2 artist that never gets a discovery row — the
  // "artist exists but nothing embedded yet" case.
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-metadata', 'artist=Wex', '-metadata', 'title=Wex Song', '-metadata', 'album=Wex Album',
    '-ac', '1', path.join(lib2Dir, 'wex.mp3'),
  ]);

  [offServer, server] = await Promise.all([
    startServer({ dlnaMode: 'disabled', waitForScan: false }),
    startServer({
      dlnaMode: 'disabled',
      extraConfig: { scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' } },
      extraFolders: { lib2: lib2Dir },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'lib2'] },
        { ...BOB, admin: false, vpaths: ['testlib'] },
      ],
    }),
  ]);

  for (const u of [ADMIN, BOB]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
    });
    tokens[u.username] = (await r.json()).token;
  }

  // Seed discovery.db with handcrafted vectors keyed to REAL scanned tracks.
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const trackByTitle = (title) => mdb.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
  `).get(title);
  const rowsToSeed = [
    ['Be Somebody', V.seed, null],
    ['Rise', V.near, ['Test---StyleA', 'Test---StyleB']],
    ['Highway', V.mid, ['Test---StyleC']],
    ['Neon', V.far, ['Test---StyleC']],
    ['Lib2 Song', V.lib2, null],
  ];
  const ddb = openDiscovery();
  try {
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)
    `);
    let seq = 0;
    for (const [title, v, tags] of rowsToSeed) {
      const t = trackByTitle(title);
      assert.ok(t?.hash, `fixture track '${title}' must exist with a hash`);
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, t.artist, title, t.duration ?? 120,
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
  await Promise.all([offServer?.stop(), server?.stop()]);
  fs.rmSync(lib2Dir, { recursive: true, force: true });
});

// ── feature gating ───────────────────────────────────────────────────────────

describe('similarity API gating', () => {
  test('403 on both endpoints while discovery is disabled', async () => {
    for (const [route, body] of [
      ['/api/v1/discovery/similar', { filePath: 'testlib/x.mp3' }],
      ['/api/v1/discovery/similar-artists', { artist: 'Icarus' }],
    ]) {
      const r = await fetch(`${offServer.baseUrl}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(r.status, 403, route);
    }
  });

  test('validation: missing seed → 400', async () => {
    assert.equal((await api('/api/v1/discovery/similar', {})).status, 400);
    assert.equal((await api('/api/v1/discovery/similar-artists', {})).status, 400);
  });
});

// ── /discovery/similar ───────────────────────────────────────────────────────

describe('POST /api/v1/discovery/similar', () => {
  const seedPath = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';

  test('ranks by the handcrafted cosines, excludes the seed itself', async () => {
    const { status, body } = await api('/api/v1/discovery/similar', { filePath: seedPath });
    assert.equal(status, 200);
    assert.equal(body.notAnalyzed, false);
    assert.equal(body.model.id, 'test-fake');
    assert.equal(body.seed.filepath, seedPath);
    assert.ok(body.seed.metadata.title === 'Be Somebody');

    const titles = body.results.map((r) => r.metadata.title);
    assert.deepEqual(titles, ['Rise', 'Lib2 Song', 'Highway', 'Neon'],
      'descending cosine order: 0.95, 0.9, 0.8, 0.5');
    // Exact similarity values from the constructed vectors.
    for (const [i, expected] of [dot(V.seed, V.near), dot(V.seed, V.lib2), dot(V.seed, V.mid), dot(V.seed, V.far)].entries()) {
      assert.ok(Math.abs(body.results[i].similarity - expected) < 1e-3,
        `result ${i}: ${body.results[i].similarity} ≈ ${expected}`);
    }
  });

  test('result shape: lite metadata (with bpm key), model tags top-level', async () => {
    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath, limit: 1 });
    const r = body.results[0];
    assert.equal(r.metadata.title, 'Rise');
    assert.ok('bpm' in r.metadata, 'lite metadata carries live bpm');
    assert.ok('album-art' in r.metadata, 'lite metadata carries album-art');
    assert.ok(!('hash' in r.metadata), 'identity fields are detail-view only (LITE subset)');
    assert.ok(!('bpm' in r), 'no top-level bpm (lives in metadata)');
    assert.deepEqual(r.genreTags, ['Test---StyleA', 'Test---StyleB'], 'model tags surface top-level');
    assert.ok(r.filepath.startsWith('testlib/'), 'playable vpath-prefixed filepath');
  });

  test('limit caps results', async () => {
    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath, limit: 2 });
    assert.equal(body.results.length, 2);
  });

  test('library access: bob never sees lib2 results', async () => {
    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath }, 'bob');
    const titles = body.results.map((r) => r.metadata.title);
    assert.deepEqual(titles, ['Rise', 'Highway', 'Neon'], 'Lib2 Song skipped for bob');
  });

  test('excludeSameArtist drops the Icarus results', async () => {
    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath, excludeSameArtist: true });
    const artists = body.results.map((r) => r.metadata.artist);
    assert.ok(!artists.includes('Icarus'), `got ${artists}`);
    assert.ok(artists.includes('Vosto'));
  });

  test('bpmRange filters on LIVE tracks.bpm; null bpm excluded', async () => {
    // Give 'Rise' a live bpm inside the range and 'Highway' one outside.
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    try {
      mdb.prepare("UPDATE tracks SET bpm = 120 WHERE title = 'Rise'").run();
      mdb.prepare("UPDATE tracks SET bpm = 60 WHERE title = 'Highway'").run();
    } finally { mdb.close(); }

    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath, bpmRange: [100, 140] });
    const titles = body.results.map((r) => r.metadata.title);
    assert.ok(titles.includes('Rise'), 'in-range bpm kept');
    assert.ok(!titles.includes('Highway'), 'out-of-range bpm dropped');
    assert.ok(!titles.includes('Neon'), 'NULL bpm dropped when filter present');
    assert.equal(body.results.find((r) => r.metadata.title === 'Rise').metadata.bpm, 120,
      'metadata carries the live bpm the filter ran against');
  });

  test('scanned but not embedded → notAnalyzed, empty results', async () => {
    const { status, body } = await api('/api/v1/discovery/similar',
      { filePath: 'testlib/Icarus/Be Somebody/03 - Orbit.mp3' });
    assert.equal(status, 200);
    assert.equal(body.notAnalyzed, true);
    assert.deepEqual(body.results, []);
    assert.equal(body.seed.metadata.title, 'Orbit');
  });

  test('unknown path → 404; other users\' vpaths → 404', async () => {
    assert.equal((await api('/api/v1/discovery/similar', { filePath: 'testlib/nope/missing.mp3' })).status, 404);
    assert.equal((await api('/api/v1/discovery/similar', { filePath: 'lib2/zed.mp3' }, 'bob')).status, 404,
      'bob probing lib2 gets 404, not 403 (no vpath-name oracle)');
  });
});

// ── /discovery/similar-artists ───────────────────────────────────────────────

describe('POST /api/v1/discovery/similar-artists', () => {
  test('ranks artists by centroid similarity with tags and entry points', async () => {
    const { status, body } = await api('/api/v1/discovery/similar-artists', { artist: 'Icarus' });
    assert.equal(status, 200);
    assert.equal(body.notAnalyzed, false);
    assert.equal(body.seed.artist, 'Icarus');
    assert.equal(body.seed.analyzedCount, 2, 'two Icarus tracks seeded');
    assert.ok(body.seed.trackCount >= 5, 'live library count (all Icarus fixtures)');

    const names = body.results.map((r) => r.artist);
    assert.deepEqual(names, ['Zed', 'Vosto'],
      'Zed centroid (single 0.9-ish vector) beats Vosto centroid (mean of 0.8/0.5 vectors)');

    const vosto = body.results.find((r) => r.artist === 'Vosto');
    assert.equal(vosto.analyzedCount, 2);
    assert.deepEqual(vosto.genreTags, ['Test---StyleC'], 'most frequent model tags for the artist');

    // Entry points: Vosto tracks ordered by closeness to the ICARUS centroid
    // (Highway cos 0.8 > Neon cos 0.5 vs the near-seed centroid).
    const entryTitles = vosto.entryPoints.map((e) => e.metadata.title);
    assert.deepEqual(entryTitles, ['Highway', 'Neon']);
    assert.ok(vosto.entryPoints[0].filepath.startsWith('testlib/'));
  });

  test('library access: bob does not see Zed (lib2-only artist)', async () => {
    const { body } = await api('/api/v1/discovery/similar-artists', { artist: 'Icarus' }, 'bob');
    assert.deepEqual(body.results.map((r) => r.artist), ['Vosto']);
  });

  test('artist with tracks but no embeddings → notAnalyzed', async () => {
    // 'Wex' exists in lib2 but was never given a discovery row.
    const { status, body } = await api('/api/v1/discovery/similar-artists', { artist: 'Wex' });
    assert.equal(status, 200);
    assert.equal(body.notAnalyzed, true);
    assert.equal(body.seed.analyzedCount, 0);
    assert.equal(body.seed.trackCount, 1);
    assert.deepEqual(body.results, []);
  });

  test('unknown artist → 404', async () => {
    assert.equal((await api('/api/v1/discovery/similar-artists', { artist: 'No Such Band' })).status, 404);
  });
});

// ── index invalidation ───────────────────────────────────────────────────────

describe('similarity index invalidation', () => {
  test('a new row + row_seq bump is visible on the next request', async () => {
    const seedPath = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';
    // Embed 'Orbit' (previously notAnalyzed) very close to the seed.
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
    let orbit;
    try {
      orbit = mdb.prepare(`
        SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist
        FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = 'Orbit'
      `).get();
    } finally { mdb.close(); }

    const ddb = openDiscovery();
    try {
      ddb.prepare(`
        INSERT INTO discovery_tracks
          (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding)
        VALUES (?, 99, 'anon:orbit', ?, 'Orbit', 120, 'test-fake', '1', ?)
      `).run(orbit.hash, orbit.artist, blob(vec(0.99, 0.141, 0, 0)));
      ddb.prepare("UPDATE discovery_meta SET value = '99' WHERE key = 'row_seq'").run();
    } finally { ddb.close(); }

    const { body } = await api('/api/v1/discovery/similar', { filePath: seedPath, limit: 1 });
    assert.equal(body.results[0].metadata.title, 'Orbit',
      'freshly embedded track (cos 0.99) tops the ranking — index rebuilt');
  });
});
