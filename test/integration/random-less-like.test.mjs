/**
 * Auto-DJ "less like this" over HTTP — POST /api/v1/db/random-songs with
 * `lessLike` / `lessLikeVectors` / `lessLikeModelId` (src/api/random.js),
 * plus the `autoDj` capability flag on GET /api/, ping and
 * /federation/health.
 *
 * Strategy mirrors random-sonic.test.mjs: one real server (discovery ON,
 * model 'test-fake') over the scanned fixture library plus an admin-only
 * second library, seeded with the same 6-d unit vectors the DB-level file
 * (test/db/autodj-less-like.test.mjs) uses, so every cosine is known.
 * Covers what only the route can show:
 *
 *   - Joi: the new keys, the 1..8 per-array and 8-in-total caps, the
 *     vectors-need-a-model-id pairing, base64, and the strict schema's
 *     "is not allowed" for anything else; `lessLikeModelId` alone passes;
 *   - no `lessLike` echo without negatives, an echo whenever they are sent;
 *   - SOFT ordering through the Express handler, simple mode and waterfall,
 *     and that a fully like-a-skip pool still answers 200;
 *   - the just-served window: the song served last never comes straight
 *     back — not even through a client's run of rejected retries, the
 *     webapp's at limit 1 or the phone's five batches of four (over a
 *     dj-only third library sized for that loop) — while older clean
 *     repeats still beat fresh like-a-skip songs;
 *   - the waterfall's first non-empty step wins as without negatives: a
 *     tighter step's like-a-skip rows beat a relaxed step's clean ones
 *     (artist cooldown and BPM tier), flagged `avoided`;
 *   - the threshold under a sonic seed, the ceiling, the conflict guard
 *     (and that it never produces the similarity-range 400), paths and
 *     vectors together, and ignore counting per user scope;
 *   - negatives never mask a positive seed's own 404 / 400;
 *   - the flag on all three routes.
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

const ADMIN = { username: 'admin', password: 'pw-admin' };   // testlib + lib2
const BOB = { username: 'bob', password: 'pw-bob' };         // testlib only
const DJ = { username: 'dj', password: 'pw-dj' };            // lib3 only (the phone-loop rig)

const ROUTE = '/api/v1/db/random-songs';
const BS = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';
const RISE = 'testlib/Icarus/Be Somebody/02 - Rise.mp3';
const ORBIT = 'testlib/Icarus/Be Somebody/03 - Orbit.mp3';
const DESCENT = 'testlib/Icarus/Later Works/02 - Descent.mp3';
const HIGHWAY = 'testlib/Vosto/Night Drive/01 - Highway.mp3';
const STATIC = 'testlib/Vosto/Night Drive/03 - Static.mp3';   // scanned, never embedded
const LIB2 = 'lib2/zed.mp3';
const DJ_SKIP = 'lib3/skip.mp3';

// ── the vector space (6-d, unit vectors; the DB-level file's) ───────────────
const S = Math.sqrt(1 - 0.85 ** 2);
const around = (c) => {
  const k = (c - 0.7225) / 0.2775;
  return [0.85, S * k, S * Math.sqrt(1 - k * k), 0, 0, 0];
};
const f32 = (xs) => {
  const v = Float32Array.from(xs);
  let n = 0;
  for (const x of v) { n += x * x; }
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const b64 = (v) => blob(v).toString('base64');
// Lib2 Song sits in the e1-e2 plane at cosine .81 from Rise (N) and .38
// from Be Somebody (P): close enough to count as like Rise, far enough to
// stay OUT of every pool seeded from Be Somebody, so the poolSize numbers
// below are the bob-visible ones.
const lib2Angle = Math.atan2(S, 0.85) + Math.acos(0.81);
const V = {
  P: f32([1, 0, 0, 0, 0, 0]),                  // Be Somebody
  N: f32([0.85, S, 0, 0, 0, 0]),               // Rise
  X1: f32(around(0.97)),                       // Orbit
  X2: f32(around(0.87)),                       // Return
  X3: f32(around(0.76)),                       // Descent
  F: f32([0.85, -S, 0, 0, 0, 0]),              // Highway
  G1: f32([0, 0, 0, 0, 1, 0]),                 // Neon
  G2: f32([0, 0, 0, 0, 0, 1]),                 // Sketch 1
  L: f32([Math.cos(lib2Angle), Math.sin(lib2Angle), 0, 0, 0, 0]),   // Lib2 Song
};

// Bob's plain [RISE] sets at T = .8.
const BLOCKED = ['Rise', 'Orbit', 'Return', 'Be Somebody'];
const FREE = ['Descent', 'Highway', 'Neon', 'Sketch 1', 'Static'];

// lib3, dj's own library for the phone-loop replay (I14c): the skipped
// song and four fresh songs exactly like it on e3, and twenty clean songs
// — the playing batch P1..P4 and the sixteen K songs the client rejects —
// spread around e4, all at cosine 0 to the skip and to every seed the
// other tests use (so no pool and no like-a-skip set elsewhere changes).
// [file, title, artist, vector]
const LIB3 = [
  ['skip', 'DJ Skip', 'Zeta', f32([0, 0, 1, 0, 0, 0])],
  ...[1, 2, 3, 4].map((i) => [`l${i}`, `DJ L${i}`, 'Zeta', f32([0, 0, 1, 0, 0, 0])]),
  ...[1, 2, 3, 4].map((i) => [`p${i}`, `DJ P${i}`, 'Alpha', f32([0, 0, 0, 1, 0.02 * i, 0.01 * i])]),
  ...Array.from({ length: 16 }, (_, k) => [`k${k + 1}`, `DJ K${k + 1}`, 'Beta', f32([0, 0, 0, 1, 0.02 * (k + 5), 0.01 * (k + 5)])]),
];

let server;
const tokens = {};
let lib2Dir;
let lib3Dir;
const ids = {};   // title -> track id (the ignoreList's currency)

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

async function pick(body, user = 'bob') {
  const headers = { 'Content-Type': 'application/json' };
  if (tokens[user]) { headers['x-access-token'] = tokens[user]; }
  const r = await fetch(`${server.baseUrl}${ROUTE}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const titles = (body) => body.songs.map((s) => s.metadata.title);

// Free titles first, `avoided` aligned, the echo as expected.
function assertSplit(body, blocked, { used = 1, ignored = 0, threshold = 0.8 } = {}) {
  const got = titles(body);
  const firstBlocked = got.findIndex((t) => blocked.includes(t));
  const lastFree = got.reduce((acc, t, i) => (blocked.includes(t) ? acc : i), -1);
  if (firstBlocked !== -1) { assert.ok(lastFree < firstBlocked, `free titles first: ${got.join(' | ')}`); }
  assert.deepEqual(body.lessLike.avoided, got.map((t) => blocked.includes(t)), `avoided aligned: ${got.join(' | ')}`);
  const { avoided: _a, ...echo } = body.lessLike;
  assert.deepEqual(echo, { used, ignored, threshold });
}

before(async () => {
  lib2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-lesslike-lib2-'));
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-metadata', 'artist=Zed', '-metadata', 'title=Lib2 Song', '-metadata', 'album=Zed Album',
    '-ac', '1', path.join(lib2Dir, 'zed.mp3'),
  ]);
  // lib3: a distinct tone per file, so every track gets its own audio hash.
  lib3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-lesslike-lib3-'));
  for (let i = 0; i < LIB3.length; i += 5) {
    await Promise.all(LIB3.slice(i, i + 5).map(([file, title, artist], j) => runFfmpeg([
      '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=${300 + 11 * (i + j)}:duration=1`,
      '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', 'album=DJ Album',
      '-ac', '1', path.join(lib3Dir, `${file}.mp3`),
    ])));
  }

  server = await startServer({
    dlnaMode: 'disabled',
    extraConfig: { scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' } },
    extraFolders: { lib2: lib2Dir, lib3: lib3Dir },
    users: [
      { ...ADMIN, admin: true, vpaths: ['testlib', 'lib2'] },
      { ...BOB, admin: false, vpaths: ['testlib'] },
      { ...DJ, admin: false, vpaths: ['lib3'] },
    ],
  });

  for (const u of [ADMIN, BOB, DJ]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
    });
    tokens[u.username] = (await r.json()).token;
  }

  // Seed discovery.db with the crafted vectors keyed to REAL scanned tracks.
  // Static stays un-embedded.
  const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  for (const r of mdb.prepare('SELECT id, title FROM tracks').all()) { ids[r.title] = r.id; }
  const trackByTitle = (title) => mdb.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
  `).get(title);
  const rowsToSeed = [
    ['Be Somebody', V.P], ['Rise', V.N], ['Orbit', V.X1], ['Return', V.X2], ['Descent', V.X3],
    ['Highway', V.F], ['Neon', V.G1], ['Sketch 1', V.G2], ['Lib2 Song', V.L],
    ...LIB3.map(([, title, , v]) => [title, v]),
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
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
});

after(async () => {
  await server?.stop();
  fs.rmSync(lib2Dir, { recursive: true, force: true });
  if (lib3Dir) { fs.rmSync(lib3Dir, { recursive: true, force: true }); }
});

// ── validation + echo presence ──────────────────────────────────────────────

describe('less-like validation', () => {
  test('I1: the schema — caps, pairing, base64, strictness', async () => {
    const vec = b64(V.G1);
    const bad = [
      [{ lessLike: [] }, 'empty lessLike'],
      [{ lessLike: Array(9).fill(RISE) }, '9 paths'],
      [{ lessLikeVectors: [vec] }, 'vectors without a model id'],
      [{ lessLikeVectors: ['!!!not-base64!!!'], lessLikeModelId: 'test-fake' }, 'non-base64 vector'],
      [{ lessLike: 'x' }, 'lessLike is not an array'],
    ];
    for (const [body, why] of bad) { assert.equal((await pick(body)).status, 400, why); }
    const over = await pick({ lessLike: Array(5).fill(RISE), lessLikeVectors: Array(4).fill(vec), lessLikeModelId: 'test-fake' });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /at most 8/);
    const unknown = await pick({ lessLikeX: [RISE] });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, '"lessLikeX" is not allowed');

    const full = await pick({ lessLike: Array(4).fill(RISE), lessLikeVectors: Array(4).fill(vec), lessLikeModelId: 'test-fake' });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    const idOnly = await pick({ lessLikeModelId: 'test-fake' });
    assert.equal(idOnly.status, 200);
    assert.ok(!('lessLike' in idOnly.body), 'a bare model id sends nothing to echo');
    const withVectorSeed = await pick({
      similarToVector: b64(V.P), similarToModelId: 'test-fake', minSimilarity: 0.5, lessLike: [RISE],
    });
    assert.equal(withVectorSeed.status, 200, JSON.stringify(withVectorSeed.body));
    assert.ok('lessLike' in withVectorSeed.body);
  });

  test('I2: no negatives, no lessLike key — plain and sonic', async () => {
    const plain = await pick({});
    assert.equal(plain.status, 200);
    assert.ok(!('lessLike' in plain.body));
    const sonic = await pick({ similarTo: [BS], minSimilarity: 0.5 });
    assert.equal(sonic.status, 200);
    assert.ok(!('lessLike' in sonic.body));
  });
});

// ── the soft ordering ───────────────────────────────────────────────────────

describe('less-like ordering', () => {
  test('I3: plain [RISE] — free songs first, avoided aligned, echo', async () => {
    for (let i = 0; i < 5; i++) {
      const { status, body } = await pick({ lessLike: [RISE], limit: 25 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(titles(body).sort(), [...BLOCKED, ...FREE].sort());
      assertSplit(body, BLOCKED);
    }
    // Admin also sees Lib2 Song (cos .81 to Rise): in the blocked half.
    const admin = await pick({ lessLike: [RISE], limit: 25 }, 'admin');
    assert.equal(admin.status, 200);
    assert.ok(titles(admin.body).includes('Lib2 Song'));
    assertSplit(admin.body, [...BLOCKED, 'Lib2 Song']);
  });

  test('I4: the waterfall keeps the order', async () => {
    for (const extra of [{ ignoreArtists: ['Nobody At All'] }, { bpmRanges: [{ min: 900, max: 950 }] }]) {
      const { status, body } = await pick({ ...extra, lessLike: [RISE], limit: 25 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(titles(body).sort(), [...BLOCKED, ...FREE].sort());
      assertSplit(body, BLOCKED);
    }
  });

  test('I5: not-like-a-skip beats fresh — a cooled free song wins over a fresh like-a-skip one', async () => {
    // Bob's nine songs served once, free first. As admin the same list
    // leaves one fresh song, Lib2 Song (like Rise), and its oldest entry
    // sits past the just-served window (8 at limit 1): that free song, a
    // clean older repeat, beats the fresh like-a-skip one...
    const { body: first } = await pick({ lessLike: [RISE], limit: 25 });
    assert.equal(first.ignoreList.length, 9);
    assert.deepEqual(first.lessLike.avoided.slice(0, FREE.length), Array(FREE.length).fill(false));
    const { status, body } = await pick({ lessLike: [RISE], ignoreList: first.ignoreList, limit: 1 }, 'admin');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(titles(body), [titles(first)[0]]);
    assert.deepEqual(body.lessLike.avoided, [false]);
    // ...where without negatives the fresh song is simply the pick.
    const plain = await pick({ ignoreList: first.ignoreList, limit: 1 }, 'admin');
    assert.deepEqual(titles(plain.body), ['Lib2 Song']);
    // With every free song inside the window (bob's first eight entries:
    // the five free songs and three like-a-skip ones) the fresh song wins
    // even though it is like a skip.
    const inWindow = await pick({ lessLike: [RISE], ignoreList: first.ignoreList.slice(0, 8), limit: 1 });
    assert.deepEqual(titles(inWindow.body), [titles(first)[8]]);
    assert.deepEqual(inWindow.body.lessLike.avoided, [true]);
  });

  test('I6: a pool that is entirely like a skip still plays', async () => {
    // Electronic = the five Icarus songs, every one within .8 of Rise or
    // Descent.
    const all = await pick({ genres: ['Electronic'], lessLike: [RISE, DESCENT], limit: 25 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.songs.length, 5);
    assert.deepEqual(all.body.lessLike.avoided, [true, true, true, true, true]);
    const one = await pick({ genres: ['Electronic'], lessLike: [RISE, DESCENT], limit: 1 });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.lessLike.avoided, [true]);
  });

  test('I14: the song just served never comes straight back — just-served repeats rank behind fresh like-a-skip songs', async () => {
    // Electronic with [RISE] skipped: Descent (.76 from Rise) is the one
    // clean song; Orbit, Return and Be Somebody are like the skip.
    const base = { genres: ['Electronic'], lessLike: [RISE], limit: 1 };
    const likeRise = ['Orbit', 'Return', 'Be Somebody'];
    for (const extra of [{}, { ignoreArtists: ['Nobody At All'] }]) {   // simple mode, then the waterfall
      // Rise was served (and skipped), then Descent played through: the
      // next pick is a fresh like-a-skip song, not Descent again.
      let ignoreList = [ids.Rise, ids.Descent];
      const first = await pick({ ...base, ...extra, ignoreList });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.ok(likeRise.includes(titles(first.body)[0]), `not Descent again: ${titles(first.body)}`);
      assert.deepEqual(first.body.lessLike.avoided, [true]);
      // A session from there: no pick repeats the one before it.
      let prev = titles(first.body)[0];
      ignoreList = first.body.ignoreList;
      for (let i = 0; i < 8; i++) {
        const { status, body } = await pick({ ...base, ...extra, ignoreList });
        assert.equal(status, 200);
        const [t] = titles(body);
        assert.notEqual(t, prev, `pick ${i} served ${t} twice running`);
        prev = t;
        ignoreList = body.ignoreList;
      }
    }
    // An OLDER clean repeat still outranks a fresh like-a-skip song:
    // Descent served nine picks ago — admin's session played under another
    // genre filter in between, and those ids count toward the window like
    // any entry — wins over the fresh Be Somebody...
    const elsewhere = ['Highway', 'Neon', 'Sketch 1', 'Static', 'Lib2 Song'].map((t) => ids[t]);
    const older = await pick({ ...base, ignoreList: [ids.Descent, ...elsewhere, ids.Rise, ids.Orbit, ids.Return] }, 'admin');
    assert.deepEqual(titles(older.body), ['Descent']);
    assert.deepEqual(older.body.lessLike.avoided, [false]);
    // ...but Descent within the newest eight entries does not.
    const recent = await pick({ ...base, ignoreList: [ids.Rise, ids.Orbit, ids.Descent] });
    assert.ok(['Return', 'Be Somebody'].includes(titles(recent.body)[0]), titles(recent.body).join());
    assert.deepEqual(recent.body.lessLike.avoided, [true]);
    // A batch: the fresh Be Somebody leads, then the just-served songs
    // purely oldest first — Descent (clean) happens to be the oldest, and
    // the skipped Rise comes before Orbit because it was served earlier.
    const batch = await pick({ ...base, limit: 4, ignoreList: [ids.Descent, ids.Rise, ids.Orbit, ids.Return] });
    assert.deepEqual(titles(batch.body), ['Be Somebody', 'Descent', 'Rise', 'Orbit']);
    assert.deepEqual(batch.body.lessLike.avoided, [true, false, true, true]);
    // Inside the window age is all that counts: with Descent served last
    // the like-a-skip Rise, oldest, comes back before it.
    const aged = await pick({ ...base, limit: 4, ignoreList: [ids.Rise, ids.Orbit, ids.Return, ids.Descent] });
    assert.deepEqual(titles(aged.body), ['Be Somebody', 'Rise', 'Orbit', 'Return']);
  });

  test('I14b: a client\'s rejected retries never bring the playing song back while a fresh like-a-skip song exists', async () => {
    // The webapp's loop (mstream.player.js _autoDjRunOnce, MAX_RETRIES 5):
    // Rise was skipped, Descent is playing, and a client-side guard rejects
    // every answer, feeding each ignoreList into the next attempt. The four
    // other free songs go first; the fifth attempt finds only like-a-skip
    // songs fresh and serves one of them — not Descent, which four rejected
    // picks have not pushed out of the just-served window.
    const likeRise = ['Orbit', 'Return', 'Be Somebody'];
    const free = FREE.filter((t) => t !== 'Descent');
    for (const extra of [{}, { ignoreArtists: ['Nobody At All'] }]) {   // simple mode, then the waterfall
      let ignoreList = [ids.Rise, ids.Descent];
      const served = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const { status, body } = await pick({ ...extra, lessLike: [RISE], ignoreList, limit: 1 });
        assert.equal(status, 200, JSON.stringify(body));
        const [t] = titles(body);
        assert.notEqual(t, 'Descent', `attempt ${attempt} served the playing song`);
        served.push(t);
        ignoreList = body.ignoreList;
        if (attempt === 4) { assert.deepEqual(body.lessLike.avoided, [true]); }
      }
      assert.deepEqual(served.slice(0, 4).sort(), [...free].sort(), served.join(' | '));
      assert.ok(likeRise.includes(served[4]), served.join(' | '));
    }
  });

  test('I14c: the phone\'s loop — batches of four retried five times never bring the playing batch back while a fresh like-a-skip song exists', async () => {
    // The phone's loop (mstream_music lib/media/audio_stuff.dart: batches
    // of four, up to 5 attempts, each feeding the answer's ignoreList into
    // the next) over dj's library: DJ Skip was skipped, the clean batch
    // P1..P4 is playing, and a client-side filter rejects every clean
    // fresh song. The sixteen clean K songs feed four rejected batches;
    // the fifth attempt finds only the like-a-skip L songs fresh and serves
    // those — never a song of the playing batch, which sixteen rejected
    // entries have not pushed out of the just-served window (the newest
    // max(4 × 5, 8) = 20 entries of a list then 21 long). A window of three
    // batches would have dropped P1..P4 after the third rejected batch,
    // and they came back as clean older repeats ahead of the L songs.
    const P = ['DJ P1', 'DJ P2', 'DJ P3', 'DJ P4'];
    const L = ['DJ L1', 'DJ L2', 'DJ L3', 'DJ L4'];
    const K = Array.from({ length: 16 }, (_, i) => `DJ K${i + 1}`);
    for (const extra of [{}, { ignoreArtists: ['Nobody At All'] }]) {   // simple mode, then the waterfall
      let ignoreList = [ids['DJ Skip'], ...P.map((t) => ids[t])];
      const rejected = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const freshLikeSkip = L.filter((t) => !ignoreList.includes(ids[t]));
        assert.ok(freshLikeSkip.length > 0, `attempt ${attempt}: the rig keeps a fresh like-a-skip song for every attempt`);
        // The fifth attempt carries the skip, the playing batch and four
        // rejected batches: 21 entries, one more than the window.
        if (attempt === 4) { assert.equal(ignoreList.length, 21); }
        const { status, body } = await pick({ ...extra, lessLike: [DJ_SKIP], ignoreList, limit: 4 }, 'dj');
        assert.equal(status, 200, JSON.stringify(body));
        const got = titles(body);
        assert.equal(got.length, 4, got.join(' | '));
        assert.ok(!got.some((t) => P.includes(t)), `attempt ${attempt} served the playing batch: ${got.join(' | ')}`);
        if (attempt < 4) {
          // Clean fresh songs lead while any remain: a batch of K songs.
          assert.ok(got.every((t) => K.includes(t)), `attempt ${attempt}: ${got.join(' | ')}`);
          assert.deepEqual(body.lessLike.avoided, [false, false, false, false]);
          rejected.push(...got);
        } else {
          // Nothing clean is fresh any more: the fresh like-a-skip songs,
          // flagged, not the playing batch.
          assert.deepEqual([...got].sort(), L, got.join(' | '));
          assert.deepEqual(body.lessLike.avoided, [true, true, true, true]);
        }
        ignoreList = body.ignoreList;
      }
      assert.deepEqual([...rejected].sort(), [...K].sort());
      assert.equal(ignoreList.length, 25);   // every lib3 song served once, all under the 50 cap
    }
  });

  test('I15: the first non-empty step wins — a tighter step\'s like-a-skip rows beat a relaxed step\'s clean ones', async () => {
    // (a) The artist cooldown. The pool from Be Somebody at .5: Rise, Orbit,
    // Return, Descent (Icarus) and Highway (Vosto). With Rise and Descent
    // skipped, Highway is the one clean song — and the artist cooldown
    // covers it. The step enforcing the cooldown holds the Icarus songs,
    // all like a skip, and it wins as it would without negatives: the
    // cooldown holds and the pick is flagged.
    const icarus = ['Rise', 'Orbit', 'Return', 'Descent'];
    const body = { similarTo: [BS], minSimilarity: 0.5, ignoreArtists: ['Vosto'], lessLike: [RISE, DESCENT], limit: 1 };
    for (let i = 0; i < 4; i++) {
      const { status, body: out } = await pick(body);
      assert.equal(status, 200, JSON.stringify(out));
      assert.ok(icarus.includes(titles(out)[0]), titles(out).join());
      assert.deepEqual(out.lessLike.avoided, [true]);
      assert.equal(out.sonic.poolSize, 5);
    }
    const plain = await pick({ similarTo: [BS], minSimilarity: 0.5, ignoreArtists: ['Vosto'], limit: 1 });
    assert.ok(icarus.includes(titles(plain.body)[0]), titles(plain.body).join());
    // Lift the cooldown and Highway, clean, leads.
    const lifted = await pick({ ...body, ignoreArtists: undefined });
    assert.deepEqual(titles(lifted.body), ['Highway']);
    assert.deepEqual(lifted.body.lessLike.avoided, [false]);

    // (b) The BPM tier. Tag Rise and Orbit — both like Rise — at 120 bpm:
    // the strict-range step holds exactly those two, so with [RISE] skipped
    // a pick serves one of them, flagged, over the clean off-range songs a
    // relaxed step would offer; a batch of three stops at the two in-range
    // songs rather than cascading to a clean off-range tail.
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'));
    mdb.exec('PRAGMA busy_timeout = 5000');
    const setBpm = (bpm) => mdb.prepare('UPDATE tracks SET bpm = ? WHERE id IN (?, ?)').run(bpm, ids.Rise, ids.Orbit);
    try {
      setBpm(120);
      const inRange = { bpmRanges: [{ min: 110, max: 130 }], lessLike: [RISE] };
      for (let i = 0; i < 4; i++) {
        const { status, body: out } = await pick({ ...inRange, limit: 1 });
        assert.equal(status, 200, JSON.stringify(out));
        assert.ok(['Rise', 'Orbit'].includes(titles(out)[0]), titles(out).join());
        assert.deepEqual(out.lessLike.avoided, [true]);
      }
      const batch = await pick({ ...inRange, limit: 3 });
      assert.deepEqual(titles(batch.body).sort(), ['Orbit', 'Rise']);
      assert.deepEqual(batch.body.lessLike.avoided, [true, true]);
      // The same songs the request serves without negatives.
      const same = await pick({ bpmRanges: [{ min: 110, max: 130 }], limit: 3 });
      assert.deepEqual(titles(same.body).sort(), ['Orbit', 'Rise']);
    } finally {
      setBpm(null);
      mdb.close();
    }
  });
});

// ── with a sonic seed ───────────────────────────────────────────────────────

describe('less-like with a sonic seed', () => {
  test('I7: the threshold follows minSimilarity', async () => {
    const tight = await pick({ similarTo: [BS], minSimilarity: 0.8, lessLike: [RISE], limit: 25 });
    assert.equal(tight.status, 200, JSON.stringify(tight.body));
    assert.equal(tight.body.sonic.poolSize, 5);
    assertSplit(tight.body, ['Rise', 'Orbit'], { threshold: 0.9 });
    assert.ok(titles(tight.body).includes('Return'), 'Return (.87 from Rise) is below .9');
    const loose = await pick({ similarTo: [BS], minSimilarity: 0.5, lessLike: [RISE], limit: 25 });
    assert.equal(loose.status, 200);
    assertSplit(loose.body, ['Rise', 'Orbit', 'Return'], { threshold: 0.8 });
  });

  test('I8: the ceiling — a fully like-a-skip pool is a 200, never the similarity-range error', async () => {
    const { status, body } = await pick({
      similarToVector: b64(V.N), similarToModelId: 'test-fake', minSimilarity: 0.9, lessLike: [ORBIT], limit: 25,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(titles(body).sort(), ['Orbit', 'Rise']);
    assert.deepEqual(body.lessLike.avoided, [true, true]);
    assert.equal(body.lessLike.threshold, 0.95);
  });

  test('I9: the conflict guard', async () => {
    const guarded = await pick({ similarTo: [BS, RISE], minSimilarity: 0.8, lessLike: [RISE], limit: 25 });
    assert.equal(guarded.status, 200, JSON.stringify(guarded.body));
    assert.equal(guarded.body.sonic.poolSize, 4, 'the centroid is Be Somebody alone');
    for (const s of guarded.body.sonic.similarities) { assert.ok(Math.abs(s - 0.85) < 1e-3, `similarity ${s}`); }
    assert.ok(!titles(guarded.body).includes('Rise'));
    assert.equal(guarded.body.lessLike.used, 1);
    const plain = await pick({ similarTo: [BS, RISE], minSimilarity: 0.8, limit: 25 });
    assert.equal(plain.body.sonic.poolSize, 3);

    // The only positive is also the negative: the positive wins, the
    // negative is ignored, and the pool is exactly the no-negative one —
    // Rise's cone at .8 minus Rise itself: Orbit, Return, Be Somebody and
    // the index-wide Lib2 Song (.81), which bob cannot be served.
    const self = await pick({ similarTo: [RISE], minSimilarity: 0.8, lessLike: [RISE], limit: 25 });
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.deepEqual({ used: self.body.lessLike.used, ignored: self.body.lessLike.ignored }, { used: 0, ignored: 1 });
    assert.equal(self.body.sonic.poolSize, 4);
    assert.ok(self.body.lessLike.avoided.every((x) => x === false));
    const selfPlain = await pick({ similarTo: [RISE], minSimilarity: 0.8, limit: 25 });
    assert.equal(selfPlain.body.sonic.poolSize, self.body.sonic.poolSize);
  });

  test('I16: the conflict guard never turns a working pick into the similarity-range 400', async () => {
    // Rise + Orbit at .9 reach Return (.922 from their centroid). Skipping
    // Orbit would leave Rise alone, within .9 of nothing but Orbit itself:
    // the guard gives way — the positives win, the negative is ignored.
    const plain = await pick({ similarTo: [RISE, ORBIT], minSimilarity: 0.9, limit: 25 });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.deepEqual(titles(plain.body), ['Return']);
    const guarded = await pick({ similarTo: [RISE, ORBIT], minSimilarity: 0.9, lessLike: [ORBIT], limit: 25 });
    assert.equal(guarded.status, 200, JSON.stringify(guarded.body));
    assert.deepEqual(titles(guarded.body), ['Return']);
    const { avoided, ...echo } = guarded.body.lessLike;
    assert.deepEqual(echo, { used: 0, ignored: 1, threshold: 0.95 });
    assert.deepEqual(avoided, [false]);
    assert.equal(guarded.body.sonic.poolSize, plain.body.sonic.poolSize);
    // A bar nothing meets is the plain 400 with or without the negative.
    const tooStrict = await pick({ similarTo: [RISE, ORBIT], minSimilarity: 0.99, lessLike: [ORBIT] });
    assert.equal(tooStrict.status, 400);
    assert.match(tooStrict.body.error, /similarity range/);
  });
});

// ── mixed forms, ignore counting, positives' own errors ─────────────────────

describe('less-like resolution', () => {
  test('I10: paths and vectors together', async () => {
    const { status, body } = await pick({ lessLike: [RISE], lessLikeVectors: [b64(V.G1)], lessLikeModelId: 'test-fake', limit: 25 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.lessLike.used, 2);
    assertSplit(body, [...BLOCKED, 'Neon'], { used: 2 });
  });

  test('I11: unusable negatives are ignored and counted in the caller\'s scope', async () => {
    const mixed = await pick({
      lessLike: ['testlib/nope/missing.mp3', LIB2, STATIC, RISE],
      lessLikeVectors: [b64(f32([1, 0, 0, 0])), b64(V.G1)], lessLikeModelId: 'test-fake',
      limit: 25,
    });
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    assert.deepEqual({ used: mixed.body.lessLike.used, ignored: mixed.body.lessLike.ignored }, { used: 2, ignored: 4 });

    const foreign = await pick({ lessLikeVectors: [b64(V.G1), b64(V.G2)], lessLikeModelId: 'other', limit: 25 });
    assert.equal(foreign.status, 200);
    assert.deepEqual({ used: foreign.body.lessLike.used, ignored: foreign.body.lessLike.ignored }, { used: 0, ignored: 2 });

    const admin = await pick({ lessLike: [LIB2], limit: 25 }, 'admin');
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.lessLike.used, 1);
    assert.equal(admin.body.lessLike.avoided[titles(admin.body).indexOf('Rise')], true);
  });

  test('I12: negatives never mask the positive seed\'s own errors', async () => {
    const missing = await pick({ similarTo: ['testlib/nope.mp3'], minSimilarity: 0.5, lessLike: [RISE] });
    assert.equal(missing.status, 404);
    const unembedded = await pick({ similarTo: [STATIC], minSimilarity: 0.5, lessLike: [RISE] });
    assert.equal(unembedded.status, 400);
    assert.match(unembedded.body.error, /analyzed/);
    const empty = await pick({ similarTo: [BS], minSimilarity: 0.99, lessLike: [RISE] });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /similarity range/);
  });
});

// ── the flag ────────────────────────────────────────────────────────────────

describe('autoDj flag', () => {
  test('I13: GET /api/ features, ping and /federation/health all say 1', async () => {
    const headers = { 'x-access-token': tokens.bob };
    const api = await (await fetch(`${server.baseUrl}/api/`, { headers })).json();
    assert.equal(api.features.autoDj, 1);
    const ping = await (await fetch(`${server.baseUrl}/api/v1/ping`, { headers })).json();
    assert.equal(ping.autoDj, 1);
    const health = await fetch(`${server.baseUrl}/api/v1/federation/health`, { headers });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).autoDj, 1);
  });
});
