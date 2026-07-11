/**
 * Sonic-similarity Auto-DJ tests — POST /api/v1/db/random-songs with
 * `similarTo` + `minSimilarity` (src/api/random.js's sonic pool over
 * src/db/discovery-similarity.js).
 *
 * Strategy mirrors discovery-similarity.test.mjs: boot a real server
 * (discovery ON, model 'test-fake') over the scanned fixture library plus a
 * second admin-only library, then seed discovery.db with HANDCRAFTED unit
 * vectors keyed to real scanned tracks — every cosine is known in advance,
 * so pool membership is asserted exactly. Covers:
 *
 *   - 403 when discovery is off (sonic params on a default-config server).
 *   - validation: both-or-neither params, bounds, array caps.
 *   - the threshold pool: repeated picks only ever land inside it, the
 *     seed itself is never picked, poolSize/similarity report exactly.
 *   - hard-constraint semantics: the waterfall relaxes BPM inside the pool
 *     (down to the unrestricted step) but NEVER picks outside it; genre
 *     stays composed as a base filter.
 *   - multi-seed centroid math (a pool reachable only via the centroid).
 *   - distinct 400 for empty pools ("similarity range" message).
 *   - access: restricted users never receive other-library picks; their
 *     vpaths can't be used as seeds by others (404).
 *   - 400 for scanned-but-unembedded seeds, 404 for unknown paths.
 *   - plain random-songs (no sonic params) is unaffected.
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

const ROUTE = '/api/v1/db/random-songs';
const SEED_PATH = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';
const NEON_PATH = 'testlib/Vosto/Night Drive/02 - Neon.mp3';
const UNSEEDED_PATH = 'testlib/Vosto/Night Drive/03 - Static.mp3';   // scanned, never embedded
const LIB2_PATH = 'lib2/zed.mp3';

// ── handcrafted vector space (4-d, unit vectors) ────────────────────────────
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

// Cosines vs `seed` are exact: near ≈ 0.95, lib2 ≈ 0.9, mid = 0.8, far ≈ 0.5.
const V = {
  seed: vec(1, 0, 0, 0),           // Icarus — Be Somebody (genre Electronic)
  near: vec(0.95, 0.312, 0, 0),    // Icarus — Rise        (genre Electronic)
  mid: vec(0.8, 0.6, 0, 0),        // Vosto — Highway      (genre Ambient)
  far: vec(0.5, 0.866, 0, 0),      // Vosto — Neon         (genre Ambient)
  lib2: vec(0.9, 0.436, 0, 0),     // Zed — Lib2 Song      (admin-only library)
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

async function pick(body, user = 'admin') {
  const headers = { 'Content-Type': 'application/json' };
  if (tokens[user]) { headers['x-access-token'] = tokens[user]; }
  const r = await fetch(`${server.baseUrl}${ROUTE}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Repeated picks — the route returns ONE random song per call, so pool
// membership/coverage is asserted over many draws. Draws are independent:
// the server trims a fed-back ignoreList to ≤ half the pool size
// (pickRandomNonIgnored in src/api/random.js), so exclusion can't
// deterministically drain a pool. Full-coverage draw counts are therefore
// sized so a miss is astronomically unlikely —
//   P(miss) ≤ poolSize · ((poolSize-1)/poolSize)^draws
// ≈ 2e-11 for 64 draws over a 3-pool, ≈ 2e-12 for 40 over a 2-pool.
// (24 draws over a 3-pool was ~2e-4 — it flaked on CI.)
async function pickTitles(body, n, user = 'admin') {
  const titles = new Set();
  for (let i = 0; i < n; i++) {
    const { status, body: res } = await pick(body, user);
    assert.equal(status, 200, `pick ${i}: ${JSON.stringify(res)}`);
    titles.add(res.songs[0].metadata.title);
  }
  return titles;
}

before(async () => {
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-sonic-lib2-'));
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-metadata', 'artist=Zed', '-metadata', 'title=Lib2 Song', '-metadata', 'album=Zed Album',
    '-ac', '1', path.join(lib2Dir, 'zed.mp3'),
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
  // Everything not listed here (Static, Orbit, Return, …) stays un-embedded.
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const trackByTitle = (title) => mdb.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
  `).get(title);
  const rowsToSeed = [
    ['Be Somebody', V.seed],
    ['Rise', V.near],
    ['Highway', V.mid],
    ['Neon', V.far],
    ['Lib2 Song', V.lib2],
  ];
  const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
  try {
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?)
    `);
    let seq = 0;
    for (const [title, v] of rowsToSeed) {
      const t = trackByTitle(title);
      assert.ok(t?.hash, `fixture track '${title}' must exist with a hash`);
      ins.run(t.hash, ++seq, `anon:${title.replace(/\s/g, '')}`, t.artist, title, t.duration ?? 120, blob(v));
    }
    // Raw INSERTs don't bump the rowversion — only upsertDiscoveryTrack
    // does. Without this the similarity index would cache an empty view.
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

// ── gating + validation ──────────────────────────────────────────────────────

describe('sonic random-songs gating', () => {
  test('403 when discovery is disabled and sonic params are present', async () => {
    const r = await fetch(`${offServer.baseUrl}${ROUTE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ similarTo: ['x/y.mp3'], minSimilarity: 0.5 }),
    });
    assert.equal(r.status, 403);
  });

  test('plain random-songs (no sonic params) still works on the sonic server', async () => {
    const { status, body } = await pick({});
    assert.equal(status, 200);
    assert.equal(body.songs.length, 1);
    assert.ok(Array.isArray(body.ignoreList));
    assert.ok(!('sonic' in body), 'no sonic block without sonic params');
  });

  test('validation: both-or-neither + bounds', async () => {
    assert.equal((await pick({ similarTo: [SEED_PATH] })).status, 400, 'similarTo without minSimilarity');
    assert.equal((await pick({ minSimilarity: 0.5 })).status, 400, 'minSimilarity without similarTo');
    assert.equal((await pick({ similarTo: [], minSimilarity: 0.5 })).status, 400, 'empty similarTo');
    assert.equal((await pick({ similarTo: [SEED_PATH], minSimilarity: 1.5 })).status, 400, 'minSimilarity > 1');
    assert.equal((await pick({ similarTo: Array(9).fill(SEED_PATH), minSimilarity: 0.5 })).status, 400, '9 seeds > cap');
  });
});

// ── the threshold pool ───────────────────────────────────────────────────────

describe('sonic threshold pool', () => {
  test('picks only land inside the pool; the seed itself is never picked', async () => {
    // minSimilarity 0.85 → pool = {Rise 0.95, Lib2 Song 0.9}; the seed's own
    // cos of 1.0 is in range but seeds are excluded by contract.
    const body = { similarTo: [SEED_PATH], minSimilarity: 0.85 };
    const titles = await pickTitles(body, 40);
    assert.deepEqual([...titles].sort(), ['Lib2 Song', 'Rise']);

    const { body: one } = await pick(body);
    assert.equal(one.sonic.poolSize, 2, 'poolSize counts in-range tracks minus seeds');
    const expected = { 'Rise': dot(V.seed, V.near), 'Lib2 Song': dot(V.seed, V.lib2) };
    const got = one.sonic.similarity;
    assert.ok(Math.abs(got - expected[one.songs[0].metadata.title]) < 1e-3,
      `reported similarity ${got} matches the picked track's exact cosine`);
  });

  test('lower threshold widens the pool', async () => {
    // 0.75 additionally admits Highway (cos 0.8); Neon (0.5) and every
    // un-embedded track stay out. poolSize pins the boundary exactly and
    // deterministically — a leak (Neon or an un-embedded track in range)
    // or a missing member would change the count — and the draws then pin
    // WHICH three tracks the pool holds.
    const body = { similarTo: [SEED_PATH], minSimilarity: 0.75 };
    const { status, body: probe } = await pick(body);
    assert.equal(status, 200);
    assert.equal(probe.sonic.poolSize, 3,
      'exactly Rise/Lib2 Song/Highway — Neon (0.5) and un-embedded tracks stay out');
    const titles = await pickTitles(body, 64);
    assert.deepEqual([...titles].sort(), ['Highway', 'Lib2 Song', 'Rise']);
  });

  test('empty pool → 400 with the similarity-range message', async () => {
    const { status, body } = await pick({ similarTo: [SEED_PATH], minSimilarity: 0.99 });
    assert.equal(status, 400);
    assert.match(body.error, /similarity range/i);
  });
});

// ── hard constraint vs the waterfall ─────────────────────────────────────────

describe('sonic pool is never relaxed', () => {
  test('BPM waterfall falls through to unrestricted but stays inside the pool', async () => {
    // Fixtures carry no BPM tags, so every BPM-constrained step returns
    // nothing and the chain ends at the unrestricted step — which must
    // still be sonic-filtered.
    const body = {
      similarTo: [SEED_PATH], minSimilarity: 0.85,
      bpmRanges: [{ min: 900, max: 950 }],
    };
    const titles = await pickTitles(body, 12);
    for (const t of titles) {
      assert.ok(['Rise', 'Lib2 Song'].includes(t), `pick '${t}' escaped the sonic pool`);
    }
  });

  test('artist cooldown is dropped rather than starving the sonic pool', async () => {
    // Sonic pools are strongly artist-correlated: at 0.85 the pool is
    // {Rise (Icarus), Lib2 Song (Zed)}. A cooldown covering BOTH
    // artists would empty every waterfall step — the final
    // drop-cooldown step must fire so the session keeps playing
    // (cooldown is best-effort variety, mirroring step 5b).
    const { status, body } = await pick({
      similarTo: [SEED_PATH], minSimilarity: 0.85,
      ignoreArtists: ['Icarus', 'Zed'],
    });
    assert.equal(status, 200);
    assert.ok(['Rise', 'Lib2 Song'].includes(body.songs[0].metadata.title),
      'pick still comes from inside the sonic pool');

    // A cooldown that leaves part of the pool free is honored.
    const titles = await pickTitles({
      similarTo: [SEED_PATH], minSimilarity: 0.85,
      ignoreArtists: ['Icarus'],
    }, 8);
    assert.deepEqual([...titles], ['Lib2 Song'], 'partial cooldown still filters within the pool');
  });

  test('genre filter composes as a base condition inside the pool', async () => {
    // Pool at 0.85 = {Rise (Electronic), Lib2 Song (no genre)}. Whitelist
    // Electronic → only Rise survives; whitelist Ambient → intersection
    // empty → the sonic-flavoured 400.
    const only = await pickTitles({
      similarTo: [SEED_PATH], minSimilarity: 0.85,
      genres: ['Electronic'], genreMode: 'whitelist',
    }, 8);
    assert.deepEqual([...only], ['Rise']);

    const { status, body } = await pick({
      similarTo: [SEED_PATH], minSimilarity: 0.85,
      genres: ['Ambient'], genreMode: 'whitelist',
    });
    assert.equal(status, 400);
    assert.match(body.error, /similarity range/i);
  });
});

// ── multi-seed centroid ──────────────────────────────────────────────────────

describe('multi-seed centroid', () => {
  test('two seeds average into a centroid that reaches tracks neither seed reaches alone', async () => {
    // centroid(seed, far) ≈ (0.866, 0.5, 0, 0). Cosines: Highway ≈ 0.993,
    // Lib2 Song ≈ 0.997, Rise ≈ 0.979 — all above 0.97, while the
    // single-seed pool at 0.97 is empty (max non-seed cos is 0.95).
    const single = await pick({ similarTo: [SEED_PATH], minSimilarity: 0.97 });
    assert.equal(single.status, 400, 'single seed at 0.97 has an empty pool');

    const body = { similarTo: [SEED_PATH, NEON_PATH], minSimilarity: 0.97 };
    const titles = await pickTitles(body, 64);
    assert.deepEqual([...titles].sort(), ['Highway', 'Lib2 Song', 'Rise'],
      'both seeds excluded, centroid-reachable tracks included');

    const { body: one } = await pick(body);
    assert.equal(one.sonic.poolSize, 3);
  });
});

// ── access control ───────────────────────────────────────────────────────────

describe('sonic access control', () => {
  test('restricted user never receives picks from other libraries', async () => {
    const titles = await pickTitles({ similarTo: [SEED_PATH], minSimilarity: 0.85 }, 16, 'bob');
    assert.deepEqual([...titles], ['Rise'], 'Lib2 Song is in range but not in bob\'s libraries');
  });

  test("other users' vpaths are unusable as seeds (uniform 404)", async () => {
    const { status } = await pick({ similarTo: [LIB2_PATH], minSimilarity: 0.5 }, 'bob');
    assert.equal(status, 404);
  });
});

// ── seed edge cases ──────────────────────────────────────────────────────────

describe('sonic seed edge cases', () => {
  test('scanned but un-embedded seed → 400 with a distinct message', async () => {
    const { status, body } = await pick({ similarTo: [UNSEEDED_PATH], minSimilarity: 0.5 });
    assert.equal(status, 400);
    assert.match(body.error, /analyzed/i);
  });

  test('unknown seed path → 404', async () => {
    const { status } = await pick({ similarTo: ['testlib/nope/missing.mp3'], minSimilarity: 0.5 });
    assert.equal(status, 404);
  });

  test('response shape: songs envelope unchanged, ignoreList grows, sonic block present', async () => {
    const first = await pick({ similarTo: [SEED_PATH], minSimilarity: 0.75 });
    assert.equal(first.status, 200);
    const song = first.body.songs[0];
    assert.ok(song.filepath.startsWith('testlib/') || song.filepath.startsWith('lib2/'));
    assert.ok(song.metadata && typeof song.metadata.title === 'string');
    assert.equal(first.body.ignoreList.length, 1);

    const second = await pick({
      similarTo: [SEED_PATH], minSimilarity: 0.75,
      ignoreList: first.body.ignoreList,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.ignoreList.length, 2, 'server appends its pick to the returned ignoreList');
    assert.ok(second.body.sonic.similarity >= 0.75 - 1e-6, 'pick is inside the requested range');
  });
});
