/**
 * The Discover page's peers section — POST /api/v1/discovery/taste with
 * sources including 'peers' (src/api/discovery-taste.js over the fan-out in
 * src/api/discovery-federation.js and the responder in
 * src/api/federation-discovery.js; contract: docs/discovery-page-plan.md
 * §3.1) — end to end over REAL iroh, against a real paired server.
 *
 * Server A (the caller): users, federation + discovery ON ('test-fake'),
 * the default fixture testlib with four songs on the four axes of a
 * handcrafted 4-d space (Be Somebody = x, Highway = y, Return = z,
 * Descent = w). 'lena' finished all four, so a call with limit.seeds 2
 * seeds from a random pair of axes and the centroid it sends is the
 * normalized mean of those two axes.
 *
 * Server B (the peer): public mode, federation + discovery ON, serverName
 * 'Bee Peer', a 'peerlib' library built with ffmpeg (the songs A does NOT
 * own) — two songs leaning on each axis, plus two copies of songs A DOES
 * own ('Be Somebody' by Icarus, and 'RISE!' by 'icarus', which
 * normalizes onto A's 'Rise'). B mints a key granted peerlib only; A adds
 * it from the ticket, so the peer row carries B's own name.
 *
 * Every similarity is known in advance (expectedOrder computes the cosines
 * the responder will), and the vectors keep every ranking's neighbours at
 * least 0.002 apart for every centroid used here — far above float32 noise
 * and the responder's 4-decimal rounding — so the orders asserted are exact.
 *
 * "The server asks no peer" is observed on B: its federation usage counter
 * (federation_key_usage.requests, flushed every 100 ms here via
 * MSTREAM_TEST_FED_FLUSH_MS) counts every request a key makes, so the
 * count for A's key standing still across a call means A sent B nothing.
 *
 * Skips when @number0/iroh has no prebuilt binary here (both sides need it).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const TASTE = '/api/v1/discovery/taste';
const PEER_NAME = 'Bee Peer';

// ── handcrafted vector space (4-d) ──────────────────────────────────────────
const unit = (xs) => {
  const n = Math.hypot(...xs) || 1;
  return xs.map((x) => x / n);
};
const blob = (xs) => {
  const v = Float32Array.from(unit(xs));
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
};
const AXES = { x: [1, 0, 0, 0], y: [0, 1, 0, 0], z: [0, 0, 1, 0], w: [0, 0, 0, 1] };

// A's analyzed songs: one per axis.
const A_SONGS = {
  'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3': { title: 'Be Somebody', axis: 'x' },
  'testlib/Vosto/Night Drive/01 - Highway.mp3': { title: 'Highway', axis: 'y' },
  'testlib/Icarus/Later Works/01 - Return.mp3': { title: 'Return', axis: 'z' },
  'testlib/Icarus/Later Works/02 - Descent.mp3': { title: 'Descent', axis: 'w' },
};

// B's peerlib: [file, title, artist, vector, axis it leans on (null: owned)].
const B_SONGS = [
  ['X1', 'X One', 'Peer Xan', [0.9, 0.1, 0.15, 0.05], 'x'],
  ['X2', 'X Two', 'Peer Xan', [0.75, 0.2, 0.1, 0.35], 'x'],
  ['Y1', 'Y One', 'Peer Yuki', [0.1, 0.92, 0.05, 0.12], 'y'],
  ['Y2', 'Y Two', 'Peer Yuki', [0.25, 0.7, 0.3, 0.1], 'y'],
  ['Z1', 'Z One', 'Peer Zia', [0.05, 0.12, 0.88, 0.2], 'z'],
  ['Z2', 'Z Two', 'Peer Zia', [0.3, 0.1, 0.72, 0.25], 'z'],
  ['W1', 'W One', 'Peer Wren', [0.15, 0.05, 0.1, 0.95], 'w'],
  ['W2', 'W Two', 'Peer Wren', [0.2, 0.3, 0.25, 0.78], 'w'],
  // Songs A owns: they rank on B (≈ 0.7 vs every two-axis centroid) and
  // must never reach A's answer.
  ['O1', 'Be Somebody', 'Icarus', [0.5, 0.5, 0.5, 0.5], null],
  ['O2', 'RISE!', 'icarus', [0.45, 0.55, 0.48, 0.52], null],
];
// B's album covers, embedded in every song of the album (one colour per
// album, so each album caches ONE file). Peer Wren's album and the owned
// copies have none: their rows must say so (albumArt null).
const COVERS = { 'Peer Xan': 'red', 'Peer Yuki': 'green', 'Peer Zia': 'blue' };
const OWNED_TITLES = new Set(B_SONGS.filter((s) => s[4] === null).map((s) => s[1]));
const bByTitle = new Map(B_SONGS.map((s) => [s[1], s]));

// The centroid A sends for a set of seed axes (sim.centroidOf: the mean,
// normalized).
const centroidOf = (axes) => unit([0, 1, 2, 3].map((i) => axes.reduce((s, a) => s + AXES[a][i], 0) / axes.length));
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// What A's peers section must list for these seed axes: B's songs A does
// not own, best match first, capped.
function expectedOrder(axes, limit) {
  const c = centroidOf(axes);
  return B_SONGS
    .filter((s) => s[4] !== null)
    .map((s) => ({ title: s[1], sim: cosine(unit(s[3]), c) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}

let srvA, srvB, peerDir;
let peerId;          // B's row in A's federation_peers
let keyIdOnB;        // the key A holds, as B knows it
let probeKey;        // a second B key, for asking B's responder directly
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

async function call(srv, method, route, body, { token, fedKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers['x-access-token'] = token; }
  if (fedKey) { headers['x-federation-key'] = fedKey; }
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const taste = (user, body = {}) => call(srvA, 'POST', TASTE, body, { token: tokens[user] });

// Hand-seed a server's discovery.db: rows = [[library, relative filepath, vector]].
function seedVectors(srv, rows) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const ddb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'discovery.db'));
  try {
    const byPath = mdb.prepare(`
      SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.title, t.duration
        FROM tracks t JOIN libraries l ON l.id = t.library_id LEFT JOIN artists a ON a.id = t.artist_id
       WHERE l.name = ? AND REPLACE(t.filepath, '\\', '/') = ?`);
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, NULL)`);
    let seq = 0;
    for (const [lib, rel, v] of rows) {
      const t = byPath.get(lib, rel);
      assert.ok(t?.hash, `fixture track '${lib}/${rel}' must be scanned with a hash`);
      ins.run(t.hash, ++seq, `anon:${lib}-${seq}`, t.artist, t.title, t.duration ?? 120, blob(v));
    }
    ddb.prepare("UPDATE discovery_meta SET value = ? WHERE key = 'row_seq'").run(String(seq));
    ddb.prepare("INSERT OR REPLACE INTO discovery_meta (key, value) VALUES ('embedding_model_version', '1')").run();
  } finally {
    ddb.close();
    mdb.close();
  }
}

// Requests B has counted for A's key (every request the key makes, flushed
// every 100 ms).
function requestsFromA() {
  const mdb = new DatabaseSync(path.join(srvB.tmpDir, 'db', 'mstream.db'), { readOnly: true, timeout: 5000 });
  try {
    return mdb.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM federation_key_usage WHERE key_id = ?')
      .get(keyIdOnB).n;
  } finally {
    mdb.close();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The count once nothing is in flight: two reads, several flushes apart, agree.
async function settledRequestsFromA() {
  let last = requestsFromA();
  const until = Date.now() + 10_000;
  for (;;) {
    await sleep(400);
    const now = requestsFromA();
    if (now === last) { return now; }
    assert.ok(Date.now() < until, 'B\'s usage counter for A\'s key never settled');
    last = now;
  }
}

const seedAxes = (body) => body.seeds.map((s) => {
  const song = A_SONGS[s.filepath];
  assert.ok(song, `seed ${s.filepath} is one of the four analyzed songs`);
  return song.axis;
});
const titles = (group) => group.results.map((r) => r.title);
const onlyGroup = (body) => {
  assert.equal(body.peers.peers.length, 1, 'one use_discovery peer → one group');
  return body.peers.peers[0];
};

const DAY = 24 * 60 * 60 * 1000;

describe('discovery taste over federation: the peers section from a real paired server', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-taste-fed-'));
    let freq = 300;
    for (const [file, title, artist] of B_SONGS) {
      // A cover rides as an APIC picture (attached_pic), which the scanner
      // caches under album-art/ and names on the track.
      const cover = COVERS[artist];
      const art = cover ? [
        '-f', 'lavfi', '-i', `color=color=${cover}:size=64x64:duration=0.1`,
        '-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:v', 'mjpeg',
        '-disposition:v:0', 'attached_pic', '-id3v2_version', '3',
      ] : [];
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq += 45}:duration=2`,
        ...art,
        '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${artist} Album`,
        '-ac', '1', path.join(peerDir, `${file}.mp3`),
      ]);
    }

    const discoveryOn = { collectDiscoveryData: true, discoveryModel: 'test-fake' };
    [srvA, srvB] = await Promise.all([
      startServer({
        dlnaMode: 'disabled',
        extraConfig: { federation: { enabled: true }, scanOptions: discoveryOn },
        // A peer that misses twice sits out 1.5 s (doubling), not 60 s: the
        // readiness gate below converges while B's endpoint boots, and the
        // last test watches the cool-down end.
        env: { MSTREAM_TEST_PEER_RETRY_MS: '1500' },
        users: [
          { username: 'boss', password: 'pw-boss', admin: true, vpaths: ['testlib'] },
          { username: 'lena', password: 'pw-lena', admin: false, vpaths: ['testlib'] },
          { username: 'fresh', password: 'pw-fresh', admin: false, vpaths: ['testlib'] },
        ],
      }),
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { peerlib: peerDir },
        extraConfig: { federation: { enabled: true, serverName: PEER_NAME }, scanOptions: discoveryOn },
        env: { MSTREAM_TEST_FED_FLUSH_MS: '100' },
      }),
    ]);

    for (const u of ['boss', 'lena', 'fresh']) {
      const r = await call(srvA, 'POST', '/api/v1/auth/login', { username: u, password: `pw-${u}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      tokens[u] = r.body.token;
    }

    seedVectors(srvA, Object.entries(A_SONGS).map(([p, s]) => ['testlib', p.slice('testlib/'.length), AXES[s.axis]]));
    seedVectors(srvB, B_SONGS.map(([file, , , v]) => ['peerlib', `${file}.mp3`, v]));

    // B → A: a key granted peerlib only; A adds it from the ticket alone,
    // so the peer row is named by B (federation.serverName).
    const mint = await call(srvB, 'POST', '/api/v1/admin/federation/keys', { name: 'for-a', vpaths: ['peerlib'] });
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    assert.ok(mint.body.ticket, 'B must issue a ticket (endpoint up)');
    keyIdOnB = mint.body.id;
    const added = await call(srvA, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket }, { token: tokens.boss });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.name, PEER_NAME);
    peerId = added.body.id;

    const probe = await call(srvB, 'POST', '/api/v1/admin/federation/keys', { name: 'probe', vpaths: ['peerlib'] });
    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    probeKey = probe.body.key;

    // lena finished all four axis songs.
    const plays = Object.keys(A_SONGS).map((filePath, i) => ({
      id: `taste-fed-${i}`, filePath, startedAt: new Date(Date.now() - (i + 1) * DAY).toISOString(),
      playedMs: 200000, durationMs: 200000, outcome: 'completed',
    }));
    const posted = await call(srvA, 'POST', '/api/v1/stats/plays', { client: { name: 'taste-fed-test' }, plays }, { token: tokens.lena });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.accepted.length, plays.length, JSON.stringify(posted.body));

    // Readiness gate (the aggregate suite's): the iroh endpoint boots
    // asynchronously and can lag HTTP-ready by seconds, while a peer gets
    // 4 s (dial included) per call. Ask until B answers; this also warms
    // the A → B bridge the assertions below mean to probe.
    const ready = Date.now() + 60_000;
    for (;;) {
      const r = await taste('lena', { sources: ['peers'] });
      if (r.status === 200 && r.body?.peers?.searched?.peers === 1 && r.body.peers.searched.unreachable === 0) { break; }
      assert.ok(Date.now() < ready, `B never became reachable: last ${r.status} ${JSON.stringify(r.body?.peers?.searched)}`);
      await sleep(500);
    }
  });

  after(async () => {
    await Promise.all([srvA?.stop(), srvB?.stop()]);
    if (peerDir) { fs.rmSync(peerDir, { recursive: true, force: true }); }
  });

  test('B\'s rows, grouped under B by name, reachable, stamped federation with no seedHash, best match first', async () => {
    const { status, body } = await taste('lena');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.seedSource, 'history');
    assert.deepEqual(seedAxes(body).sort(), ['w', 'x', 'y', 'z'], 'all four finished songs seed (the pool fits the limit)');
    assert.equal(body.network, null, 'p2p is off on A');
    assert.ok(body.library, 'the library section rides along');
    assert.deepEqual(body.peers.searched, { peers: 1, unreachable: 0, mismatched: 0 });

    const g = onlyGroup(body);
    assert.deepEqual(Object.keys(g), ['id', 'name', 'lastSeen', 'reachable', 'mismatched', 'results']);
    assert.equal(g.id, peerId);
    assert.equal(g.name, PEER_NAME, 'the name B put in its ticket');
    assert.equal(g.reachable, true);
    assert.equal(g.mismatched, false);
    assert.match(g.lastSeen, /^\d{4}-\d\d-\d\dT.*Z$/, 'answered in this call: an ISO time');

    // Against this four-axis centroid the owned copies O1/O2 score ≥ 0.99,
    // so the caller's NEAR_DUP filter (src/db/discovery-novelty.js) drops
    // them before ownership is even asked — this test pins the rows and
    // their order; the owned-song filter itself is pinned by the two-axis
    // calls in 'songs A owns never appear'.
    const c4 = centroidOf(['x', 'y', 'z', 'w']);
    for (const s of B_SONGS.filter((b) => b[4] === null)) {
      assert.ok(cosine(unit(s[3]), c4) >= 0.99, `${s[1]} is a near-duplicate of the four-axis centroid`);
    }
    const want = expectedOrder(['x', 'y', 'z', 'w'], 12);
    assert.deepEqual(titles(g), want.map((w) => w.title), 'every B song outside the near-duplicate band, by cosine vs the centroid');
    for (const [i, r] of g.results.entries()) {
      assert.equal(r.source, 'federation');
      assert.equal(r.seedHash, null, 'asked with the centroid: no row is "because of" one seed');
      assert.deepEqual(r.peer, { id: peerId, name: PEER_NAME });
      assert.equal(r.filepath, `peerlib/${bByTitle.get(r.title)[0]}.mp3`, 'the peer-side vpath path');
      assert.equal(r.artist, bByTitle.get(r.title)[2]);
      assert.ok(Math.abs(r.similarity - want[i].sim) < 1e-3, `${r.title}: ${r.similarity} vs ${want[i].sim}`);
    }
  });

  test('rows carry B\'s cover file name, and A\'s art proxy serves it', async () => {
    const { body } = await taste('lena', { sources: ['peers'] });
    const rows = onlyGroup(body).results;
    assert.ok(rows.length >= 6, `enough rows to cover covered and uncovered albums (${rows.length})`);
    const artByArtist = new Map();
    for (const r of rows) {
      if (!COVERS[r.artist]) {
        assert.equal(r.albumArt, null, `${r.title}: no embedded cover → no albumArt`);
        continue;
      }
      assert.match(r.albumArt, /^[^/\\]+\.(jpe?g|png)$/, `${r.title}: one cached file name`);
      // One cover per album: every song of it names the same file.
      if (artByArtist.has(r.artist)) { assert.equal(r.albumArt, artByArtist.get(r.artist)); }
      artByArtist.set(r.artist, r.albumArt);
    }
    assert.ok(artByArtist.size >= 2, 'covered albums are in the answer');
    assert.equal(new Set(artByArtist.values()).size, artByArtist.size, 'distinct albums, distinct covers');
    assert.ok(rows.some((r) => r.albumArt === null), 'an uncovered album is in the answer too');

    // The name is B's own: its browse metadata for the same file says so.
    const covered = rows.find((r) => r.albumArt);
    const meta = await call(srvB, 'POST', '/api/v1/db/metadata', { filepath: covered.filepath }, { fedKey: probeKey });
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    assert.equal(meta.body.metadata['album-art'], covered.albumArt);

    // Through A, as every client builds it (with and without ?compress=s),
    // byte-for-byte against B's cache: the full answer is the original, the
    // ?compress=s answer is B's zs- thumbnail. /album-art/ falls back to the
    // original when a variant is missing, so only the bytes prove the
    // thumbnail path (A forwarding `compress`, B having generated it).
    const cache = path.join(srvB.tmpDir, 'image-cache');
    const original = fs.readFileSync(path.join(cache, covered.albumArt));
    const thumbPath = path.join(cache, `zs-${covered.albumArt}`);
    assert.ok(fs.existsSync(thumbPath), 'B\'s scan wrote the small thumbnail');
    const thumb = fs.readFileSync(thumbPath);
    assert.ok(!thumb.equals(original), 'the thumbnail is not the original');
    for (const [q, want, what] of [['', original, 'the original'], ['?compress=s', thumb, 'the zs- thumbnail']]) {
      const r = await fetch(`${srvA.baseUrl}/api/v1/federation/peers/${covered.peer.id}/art/${encodeURIComponent(covered.albumArt)}${q}`,
        { headers: { 'x-access-token': tokens.lena } });
      assert.equal(r.status, 200, `art proxy${q}`);
      assert.match(r.headers.get('content-type') || '', /^image\//, `art proxy${q} content type`);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(want), `art proxy${q} answers B's ${what}`);
    }
  });

  test('a row is playable through A\'s stream proxy, byte-exact', async () => {
    const { body } = await taste('lena', { sources: ['peers'] });
    const row = onlyGroup(body).results[0];
    const r = await fetch(`${srvA.baseUrl}/api/v1/federation/peers/${row.peer.id}/stream/${row.filepath}`,
      { headers: { 'x-access-token': tokens.lena } });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    const original = fs.readFileSync(path.join(peerDir, path.basename(row.filepath)));
    assert.ok(bytes.equals(original), 'the proxied bytes are the file on B');
  });

  test('songs A owns never appear, though B ranks them', async () => {
    for (let i = 0; i < 4; i++) {
      const { body } = await taste('lena', { sources: ['peers'], limit: { seeds: 2 } });
      const axes = seedAxes(body);
      assert.equal(axes.length, 2);
      // B's own answer for the same centroid, asked directly with a key
      // granted the same library: the owned copies are in it.
      const raw = await call(srvB, 'POST', '/api/v1/federation/discovery/similar', {
        embedding: Buffer.from(Float32Array.from(centroidOf(axes)).buffer).toString('base64'),
        modelId: 'test-fake',
        limit: 36,
      }, { fedKey: probeKey });
      assert.equal(raw.status, 200, JSON.stringify(raw.body));
      const rawTitles = raw.body.results.map((r) => r.title);
      for (const t of OWNED_TITLES) { assert.ok(rawTitles.includes(t), `B ranks '${t}' for ${axes}`); }
      assert.ok(raw.body.results.every((r) => r.filepath.startsWith('peerlib/')), 'B answers within the grant');

      const got = titles(onlyGroup(body));
      for (const t of OWNED_TITLES) { assert.ok(!got.includes(t), `'${t}' (owned on A) must not reach A's answer`); }
      assert.deepEqual(got, expectedOrder(axes, 12).map((w) => w.title));
    }
  });

  test('limit.peers caps the group', async () => {
    const two = await taste('lena', { sources: ['peers'], limit: { peers: 2 } });
    assert.deepEqual(titles(onlyGroup(two.body)), expectedOrder(['x', 'y', 'z', 'w'], 2).map((w) => w.title));
    const one = await taste('lena', { sources: ['peers'], limit: { peers: 1 } });
    assert.deepEqual(titles(onlyGroup(one.body)), expectedOrder(['x', 'y', 'z', 'w'], 1).map((w) => w.title));
  });

  test('a mood filter reaches B: only its matching rows come back — and a B with no scores answers unfiltered, so its rows are dropped', async () => {
    // Scores straight into track_moods, the way the mood sync writes them:
    // on B the x and y songs are relaxed, the z and w songs aggressive. A
    // needs scores of its own too — a server without any takes no filter.
    const relaxed = new Set(['X One', 'X Two', 'Y One', 'Y Two']);
    const writeMoods = (srv, rows) => {
      const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { timeout: 5000 });
      try {
        const ins = db.prepare(`INSERT OR REPLACE INTO track_moods (track_id, relaxed, aggressive)
          SELECT id, ?, ? FROM tracks WHERE title = ?`);
        for (const [title, isRelaxed] of rows) { ins.run(isRelaxed ? 0.9 : 0.1, isRelaxed ? 0.1 : 0.9, title); }
      } finally {
        db.close();
      }
    };
    const clearMoods = (srv) => {
      const db = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { timeout: 5000 });
      try { db.exec('DELETE FROM track_moods'); } finally { db.close(); }
    };
    try {
      writeMoods(srvA, [['Be Somebody', true]]);
      writeMoods(srvB, B_SONGS.filter((s) => s[4] !== null).map((s) => [s[1], relaxed.has(s[1])]));
      const r = await taste('lena', { sources: ['peers'], limit: { peers: 8 }, moods: { energy: 'relaxed' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.moods, { energy: 'relaxed' });
      const group = onlyGroup(r.body);
      assert.deepEqual(new Set(titles(group)), relaxed, 'every relaxed song, and only those');
      assert.equal('moodsUnsupported' in group, false);
      assert.deepEqual(r.body.peers.searched, { peers: 1, unreachable: 0, mismatched: 0, moodsUnsupported: 0 });

      clearMoods(srvB);
      const off = await taste('lena', { sources: ['peers'], limit: { peers: 8 }, moods: { energy: 'relaxed' } });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      const dropped = onlyGroup(off.body);
      assert.equal(dropped.reachable, true);
      assert.equal(dropped.moodsUnsupported, true);
      assert.deepEqual(dropped.results, [], 'an unfiltered answer is never shown as a filtered one');
      assert.equal(off.body.peers.searched.moodsUnsupported, 1);
    } finally {
      clearMoods(srvA);
      clearMoods(srvB);
    }
  });

  test('a peers-only call pinned to the main answer\'s batch returns that batch\'s rows', async () => {
    for (let i = 0; i < 3; i++) {
      // The page's main call: a random pair of lena's four songs.
      const main = await taste('lena', { limit: { seeds: 2, peers: 3 } });
      assert.equal(main.status, 200, JSON.stringify(main.body));
      assert.equal(main.body.seedSource, 'history');
      const axes = seedAxes(main.body);
      assert.equal(axes.length, 2);
      const want = expectedOrder(axes, 3).map((w) => w.title);
      const mainRows = onlyGroup(main.body).results;
      assert.deepEqual(mainRows.map((r) => r.title), want);
      // Every row of a two-axis batch leans on one of ITS axes.
      assert.ok(mainRows.every((r) => axes.includes(bByTitle.get(r.title)[4])), `rows for ${axes}: ${want}`);

      // The follow-up: the same batch, peers only.
      const pin = main.body.seeds.map((s) => s.filepath);
      const pinned = await taste('lena', { sources: ['peers'], pin, limit: { seeds: pin.length, peers: 3 } });
      assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
      assert.equal(pinned.body.seedSource, 'pinned');
      assert.deepEqual(pinned.body.seeds.map((s) => s.filepath), pin, 'the batch, in order, nothing added');
      assert.ok(pinned.body.seeds.every((s) => s.pinned));
      assert.equal(pinned.body.library, null, 'peers only');
      assert.deepEqual(pinned.body.peers.searched, { peers: 1, unreachable: 0, mismatched: 0 });
      assert.deepEqual(onlyGroup(pinned.body).results, mainRows, 'the same centroid, the same rows');
    }
  });

  test('null when the main answer is the random fallback or sources leave peers out — and B is never asked', async () => {
    const before = await settledRequestsFromA();
    // Control: a history call does reach B.
    const history = await taste('lena', { sources: ['peers'] });
    assert.equal(history.body.peers.searched.peers, 1);
    const afterHistory = await settledRequestsFromA();
    assert.ok(afterHistory > before, `a history call is counted on B (${before} → ${afterHistory})`);

    const random = await taste('fresh');
    assert.equal(random.status, 200, JSON.stringify(random.body));
    assert.equal(random.body.seedSource, 'random');
    assert.equal(random.body.fallback, true);
    assert.equal(random.body.seeds.length, 1);
    assert.equal(random.body.peers, null, 'a random song is not this user\'s taste: no peer is asked');
    assert.ok(random.body.library, 'the library still answers');

    const noPeers = await taste('lena', { sources: ['library', 'network'] });
    assert.equal(noPeers.status, 200);
    assert.equal(noPeers.body.seedSource, 'history');
    assert.equal(noPeers.body.peers, null);

    assert.equal(await settledRequestsFromA(), afterHistory, 'neither call sent B a request');
  });

  // The public contract only: the federation wall (src/api/federation-auth.js
  // ALLOWED_EXACT does not list the taste route) answers this 403 before the
  // route's own requireAccount guard runs, so this test does NOT pin that
  // guard (nor the guest-token path it also covers).
  test('a federation key calling A\'s taste route gets 403', async () => {
    const mint = await call(srvA, 'POST', '/api/v1/admin/federation/keys', { name: 'taste-caller', vpaths: ['testlib'] }, { token: tokens.boss });
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    const r = await call(srvA, 'POST', TASTE, {}, { fedKey: mint.body.key });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'Forbidden');
  });

  test('A\'s answer never carries B\'s absolute paths', async () => {
    const { body } = await taste('lena');
    const text = JSON.stringify(body);
    const roots = new Set([peerDir, srvB.tmpDir, os.tmpdir()]);
    for (const p of [...roots]) {
      try { roots.add(fs.realpathSync(p)); } catch { /* gone */ }
    }
    for (const root of roots) {
      assert.ok(!text.includes(root), `the answer leaks ${root}`);
      assert.ok(!text.includes(root.replace(/\\/g, '\\\\')), `the answer leaks ${root} (escaped)`);
    }
    const rows = onlyGroup(body).results;
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.match(r.filepath, /^peerlib\/[^/]+\.mp3$/, 'the peer-relative path the stream proxy takes');
    }
  });

  // LAST — stops B for good. A runs with MSTREAM_TEST_PEER_RETRY_MS 1500:
  // the first cool-down is 1.5 s, the next 3 s.
  test('B unreachable: unreachable within the deadline, then — after two misses — skipped at once until its cool-down ends', async (t) => {
    await srvB.stop();
    const timedTaste = async () => {
      const t0 = Date.now();
      const r = await taste('lena');
      const elapsed = Date.now() - t0;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.peers.searched, { peers: 0, unreachable: 1, mismatched: 0 });
      const g = onlyGroup(r.body);
      assert.equal(g.id, peerId);
      assert.equal(g.name, PEER_NAME);
      assert.equal(g.reachable, false);
      assert.deepEqual(g.results, []);
      assert.ok(r.body.library, 'the library section is unaffected');
      return elapsed;
    };
    const elapsed = [];

    // Call 1, miss 1: bounded by the 4 s peer deadline.
    elapsed.push(await timedTaste());
    assert.ok(elapsed[0] < 8000, `call 1 answered in ${elapsed[0]}ms — bounded by the 4 s peer deadline`);
    // Call 2, miss 2: one miss is not proof, so B is dialed again.
    elapsed.push(await timedTaste());
    assert.ok(elapsed[1] >= 3000 && elapsed[1] < 8000, `call 2 dialed B and waited out the deadline (${elapsed[1]}ms)`);
    // Call 3: B is parked — reported unreachable without a dial.
    elapsed.push(await timedTaste());
    assert.ok(elapsed[2] < 1000, `call 3 skipped B in its cool-down (${elapsed[2]}ms)`);

    // The 1.5 s cool-down ends: call 4 dials again (miss 3 → parked 3 s).
    await sleep(1700);
    elapsed.push(await timedTaste());
    assert.ok(elapsed[3] >= 3000 && elapsed[3] < 8000, `call 4 dialed B again after the cool-down (${elapsed[3]}ms)`);
    // Call 5: parked again, for twice as long.
    elapsed.push(await timedTaste());
    assert.ok(elapsed[4] < 1000, `call 5 skipped B again (${elapsed[4]}ms)`);
    t.diagnostic(`cool-down timings (ms): ${elapsed.join(', ')}`);
  });
});
