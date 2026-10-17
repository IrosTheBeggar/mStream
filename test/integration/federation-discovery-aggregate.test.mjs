/**
 * Discovery-over-federation, caller side (phase 2), end-to-end over real
 * iroh: POST /api/v1/discovery/federation/similar.
 *
 * Server A (remote peer): federation + discovery ON ('test-fake'), one
 * 'shared' library whose tracks carry handcrafted 4-d vectors chosen to
 * exercise every caller-side filter at once:
 *   'Remote Hit'    by Nova     cos 0.9    → the novel result (the one
 *                                            track with an embedded cover:
 *                                            its rows name A's albumArt)
 *   'Be Somebody'   by Icarus   cos 0.8    → artist+title B owns → dropped
 *   'Brand New Cut' by Vosto    cos 0.7    → novel, but Vosto is a B artist
 *                                            → dropped under newArtistsOnly
 *   'Dup Encode'    by Copycat  cos ≈0.999 → near-dup of the seed → dropped
 *
 * Server B (caller): federation + discovery ON, default fixture testlib,
 * its 'Be Somebody' seeded as the query vector's owner. B adds A TWICE
 * (two minted keys → two peer rows, same endpoint), so the cross-peer
 * dedupe is proven end-to-end: searched.peers = 2, every song once.
 *
 * Also pins: the ping `federationDiscovery` flag contract, the per-peer
 * use_discovery toggle round-trip, and the federation-disabled 403 (done
 * LAST — it flips B's live config off).
 *
 * Skips when @number0/iroh has no prebuilt binary here (both sides need it).
 *
 * Two in-process blocks run everywhere (no iroh, no server): the merge every
 * fan-out goes through (mergePeerAnswers — per-peer outcomes for the
 * Discover page, the merged ranking for this route) and the throttled
 * federation_peers status writer the Discover page passes as onPeerStatus.
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
import { mergePeerAnswers, createPeerStatusRecorder, recordPeerStatus } from '../../src/api/discovery-federation.js';
import { isNovel, norm } from '../../src/db/discovery-novelty.js';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

// ── handcrafted vector space (4-d unit vectors; cosines vs SEED are exact) ──
const vec = (...xs) => {
  const v = new Float32Array(xs);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const blob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const SEED = vec(1, 0, 0, 0);                       // B's 'Be Somebody'
const REMOTE = [
  // [title, artist, vector, mbid, tags]
  ['Remote Hit', 'Nova', vec(0.9, 0.436, 0, 0), 'mbid-remote-hit', ['Test---StyleZ']],
  ['Be Somebody', 'Icarus', vec(0.8, 0.6, 0, 0), null, null],
  ['Brand New Cut', 'Vosto', vec(0.7, 0.714, 0, 0), null, null],
  ['Dup Encode', 'Copycat', vec(0.999, 0.0447, 0, 0), null, null],
];

const SEED_PATH = 'testlib/Icarus/Be Somebody/01 - Be Somebody.mp3';

let srvA, srvB, sharedDir;
const peerIds = [];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-200)}`)));
  });
}

// Both servers run PUBLIC mode (no users) — admin routes need no token.
async function api(srv, method, route, body) {
  const r = await fetch(`${srv.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const aggregate = (body) => api(srvB, 'POST', '/api/v1/discovery/federation/similar', body);

function seedDiscoveryDb(srv, rows) {
  const mdb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'mstream.db'), { readOnly: true });
  const trackByTitle = (title) => mdb.prepare(`
    SELECT COALESCE(t.audio_hash, t.file_hash) AS hash, a.name AS artist, t.duration
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id WHERE t.title = ?
  `).get(title);
  const ddb = new DatabaseSync(path.join(srv.tmpDir, 'db', 'discovery.db'));
  try {
    const ins = ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'test-fake', '1', ?, ?)
    `);
    let seq = 0;
    for (const [title, v, mbid, tags] of rows) {
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
}

// ── The merge behind every fan-out (mergePeerAnswers), in-process ──────────
// No iroh: handcrafted Promise.allSettled outcomes. The per-song route shows
// the merged ranking's first `limit` rows; the Discover page shows the
// per-peer groups. Both come from one walk, pinned here against the route's
// original single-list merge.
describe('discovery federation — merging peer answers (no iroh)', () => {
  const none = () => ({ mbids: new Set(), artistTitles: new Set(), artists: new Set() });
  const peerRow = (id, name, lastSeen = null) => ({ id, name, last_seen: lastSeen, use_discovery: 1 });
  const ok = (results, at = Date.parse('2026-10-05T12:00:00Z')) => ({ status: 'fulfilled', value: { body: { results }, at } });
  const down = (msg = 'no answer within 4000ms (dial included)') => ({ status: 'rejected', reason: new Error(msg) });
  const song = (artist, title, similarity, extra = {}) => ({
    artist, title, similarity, filepath: `shared/${title}.mp3`, duration: 120, genreTags: null, recordingMbid: null, ...extra,
  });

  // The route's merge as it was before the refactor (answers fulfilled with
  // the peer's JSON itself back then).
  function singleListMerge(peers, answers, exclude, { newArtistsOnly = false, limit }) {
    const searched = { peers: 0, unreachable: 0, mismatched: 0 };
    const merged = [];
    for (const [i, outcome] of answers.entries()) {
      const peer = peers[i];
      if (outcome.status === 'rejected') { searched.unreachable += 1; continue; }
      const body = outcome.value.body;
      if (body.modelMismatch) { searched.mismatched += 1; continue; }
      searched.peers += 1;
      for (const r of body.results || []) {
        if (!isNovel(exclude, { artist: r.artist, title: r.title, recordingMbid: r.recordingMbid, similarityVsSeed: r.similarity },
          { newArtistsOnly })) { continue; }
        merged.push({
          artist: r.artist, title: r.title, album: r.album ?? null, year: r.year ?? null, isrc: r.isrc ?? null,
          // albumArt joined the row later (2026-10-16); the walk is unchanged.
          releaseGroupMbid: r.releaseGroupMbid ?? null, albumArt: r.albumArt ?? null, duration: r.duration, similarity: r.similarity,
          genreTags: r.genreTags, recordingMbid: r.recordingMbid, filepath: r.filepath, peer: { id: peer.id, name: peer.name },
        });
      }
    }
    merged.sort((a, b) => b.similarity - a.similarity);
    const seen = new Set();
    const results = [];
    for (const r of merged) {
      if (results.length >= limit) { break; }
      const keys = [`a:${norm(r.artist)} ${norm(r.title)}`];
      if (r.recordingMbid) { keys.push(`m:${r.recordingMbid}`); }
      if (keys.some((k) => seen.has(k))) { continue; }
      for (const k of keys) { seen.add(k); }
      results.push(r);
    }
    return { searched, results };
  }

  test('every peer gets an outcome, in peer order: answered, unreachable, other model space', () => {
    const peers = [peerRow(1, 'Sam'), peerRow(2, 'Ari', '2026-09-01 08:30:00'), peerRow(3, 'Kim'), peerRow(4, 'Lee', '2026-10-01 10:00:00')];
    const answers = [
      ok([song('Nova', 'Remote Hit', 0.9)], Date.parse('2026-10-05T12:00:01Z')),
      down(),
      { status: 'fulfilled', value: { body: { modelMismatch: true, results: [] }, at: Date.parse('2026-10-05T12:00:02Z') } },
      ok([]),
    ];
    const out = mergePeerAnswers(peers, answers, { excludeSets: none(), limit: 10 });
    assert.deepEqual(out.searched, { peers: 2, unreachable: 1, mismatched: 1 });
    assert.deepEqual(out.peers.map((p) => [p.id, p.name, p.reachable, p.mismatched, p.results.length]),
      [[1, 'Sam', true, false, 1], [2, 'Ari', false, false, 0], [3, 'Kim', true, true, 0], [4, 'Lee', true, false, 0]]);
    assert.deepEqual(Object.keys(out.peers[0]), ['id', 'name', 'lastSeen', 'reachable', 'mismatched', 'results']);
    assert.equal(out.peers[0].lastSeen, '2026-10-05T12:00:01.000Z', 'an answer in this call is the freshest sighting');
    assert.equal(out.peers[1].lastSeen, '2026-09-01T08:30:00.000Z', 'unreachable: the stored last_seen, as ISO');
    assert.equal(out.peers[2].lastSeen, '2026-10-05T12:00:02.000Z', 'a model-mismatch answer is still an answer');
    assert.equal(mergePeerAnswers([peerRow(9, 'New')], [down()], { excludeSets: none(), limit: 5 }).peers[0].lastSeen, null,
      'never seen → null');
    assert.deepEqual(out.peers[0].results[0].peer, { id: 1, name: 'Sam' });
    assert.equal(out.peers[0].results[0].filepath, 'shared/Remote Hit.mp3', 'the peer-side path rides along for the stream proxy');
  });

  test('a song two peers hold shows once, under the peer where it ranks highest', () => {
    const peers = [peerRow(1, 'A'), peerRow(2, 'B')];
    const out = mergePeerAnswers(peers, [
      ok([song('Nova', 'Same Song', 0.8), song('Vosto', 'Only A', 0.7)]),
      ok([song('NOVA', 'same song!', 0.79), song('Iko', 'Only B', 0.6)]),
    ], { excludeSets: none(), limit: 10 });
    assert.deepEqual(out.peers.map((p) => p.results.map((r) => r.title)), [['Same Song', 'Only A'], ['Only B']]);
    assert.deepEqual(out.results.map((r) => [r.title, r.peer.id]), [['Same Song', 1], ['Only A', 1], ['Only B', 2]]);
  });

  test('limit caps each peer; a song its full peer cannot show surfaces under another peer', () => {
    const peers = [peerRow(1, 'A'), peerRow(2, 'B')];
    const out = mergePeerAnswers(peers, [
      ok([song('Nova', 'Top', 0.9), song('Iko', 'Shared', 0.8)]),
      ok([song('Iko', 'Shared', 0.75), song('Vosto', 'B Own', 0.5)]),
    ], { excludeSets: none(), limit: 1 });
    assert.deepEqual(out.peers.map((p) => p.results.map((r) => r.title)), [['Top'], ['Shared']]);
    assert.equal(out.peers[1].results[0].similarity, 0.75, 'B\'s own copy, B\'s own score');
    assert.deepEqual(out.results.slice(0, 1).map((r) => r.title), ['Top'], 'the per-song route still shows one row in total');
  });

  test('the per-song route\'s answer is unchanged: first `limit` merged rows == the original single-list merge', () => {
    let compared = 0;
    for (let seed = 1; seed <= 80; seed++) {
      let a = seed;
      const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
      const nPeers = 1 + Math.floor(rnd() * 4);
      const peers = Array.from({ length: nPeers }, (_v, i) => peerRow(i + 1, `P${i + 1}`));
      const answers = peers.map(() => {
        const roll = rnd();
        if (roll < 0.15) { return down(); }
        if (roll < 0.25) { return { status: 'fulfilled', value: { body: { modelMismatch: true, results: [] }, at: 1 } }; }
        return ok(Array.from({ length: Math.floor(rnd() * 20) }, () => song(
          `Artist ${Math.floor(rnd() * 5)}`, `Title ${Math.floor(rnd() * 8)}`,
          Math.round(rnd() * 10) / 10,   // coarse scores → plenty of exact ties
          { recordingMbid: rnd() < 0.3 ? `mbid-${Math.floor(rnd() * 6)}` : null })));
      });
      const exclude = { mbids: new Set(['mbid-2']), artistTitles: new Set(['artist1 title3']), artists: new Set(['artist4']) };
      for (const newArtistsOnly of [false, true]) {
        for (const limit of [1, 2, 5, 10, 50]) {
          const want = singleListMerge(peers, answers, exclude, { newArtistsOnly, limit });
          const got = mergePeerAnswers(peers, answers, { excludeSets: exclude, newArtistsOnly, limit });
          assert.deepEqual(got.searched, want.searched);
          assert.deepEqual(got.results.slice(0, limit), want.results, `seed ${seed} limit ${limit}`);
          // And the grouped view is consistent with the walk.
          const keys = new Set();
          for (const g of got.peers) {
            assert.ok(g.results.length <= limit, 'per-peer cap');
            assert.ok(g.results.every((r) => r.peer.id === g.id), 'rows sit under their own peer');
            for (let i = 1; i < g.results.length; i++) { assert.ok(g.results[i - 1].similarity >= g.results[i].similarity); }
            for (const r of g.results) {
              const k = `a:${norm(r.artist)} ${norm(r.title)}`;
              assert.ok(!keys.has(k), `each song once across peers (${k})`);
              keys.add(k);
            }
          }
          compared += want.results.length;
        }
      }
    }
    assert.ok(compared > 500, `the fixture must actually merge rows (${compared})`);
  });

  test('an answer that is not the documented object answers nothing instead of failing the fan-out', () => {
    const peers = [peerRow(1, 'A'), peerRow(2, 'B'), peerRow(3, 'C'), peerRow(4, 'D')];
    const out = mergePeerAnswers(peers, [
      { status: 'fulfilled', value: { body: null, at: 1 } },
      { status: 'fulfilled', value: { body: { results: 'nope' }, at: 1 } },
      ok([null, 5, 'x', song('Nova', 'Fine', 0.5)]),
      undefined,
    ], { excludeSets: none(), limit: 10 });
    assert.deepEqual(out.results.map((r) => r.title), ['Fine']);
    assert.deepEqual(out.searched, { peers: 3, unreachable: 1, mismatched: 0 });
  });

  test('albumArt: a peer\'s cover file name passes through; absent (an older peer) or not one plain name → null', () => {
    const out = mergePeerAnswers([peerRow(1, 'A')], [ok([
      song('Nova', 'Covered', 0.9, { albumArt: '0f3a9c.jpg' }),
      song('Nova', 'Older Peer', 0.8),
      song('Nova', 'Explicit Null', 0.7, { albumArt: null }),
      song('Iko', 'Nested', 0.6, { albumArt: 'a/b.jpg' }),
      song('Iko', 'Dotdot', 0.5, { albumArt: '..' }),
      song('Iko', 'Backslash', 0.45, { albumArt: 'a\\b.jpg' }),
      song('Iko', 'Control', 0.4, { albumArt: 'a\nb.jpg' }),
      song('Iko', 'Empty', 0.35, { albumArt: '' }),
      song('Vosto', 'Number', 0.3, { albumArt: 42 }),
      song('Vosto', 'Huge', 0.25, { albumArt: `${'x'.repeat(300)}.jpg` }),
      // What /album-art/ (sanitizeFilename) could never serve, and a client
      // splicing the name into a URL would misread: kept out entirely.
      song('Kai', 'Encoded Dots', 0.24, { albumArt: '%2e%2e' }),
      song('Kai', 'Encoded Name', 0.23, { albumArt: '%2e%2e.jpg' }),
      song('Kai', 'Query', 0.22, { albumArt: 'x?y.jpg' }),
      song('Kai', 'Fragment', 0.21, { albumArt: 'a#b.jpg' }),
      song('Kai', 'Space', 0.2, { albumArt: 'a b.jpg' }),
      song('Kai', 'Non-ASCII', 0.19, { albumArt: 'café.jpg' }),
      song('Kai', 'No Extension', 0.18, { albumArt: '0f3a9c' }),
      song('Kai', 'Long Stem', 0.17, { albumArt: `${'a'.repeat(101)}.jpg` }),
      song('Kai', 'Real Hash', 0.16, { albumArt: 'd41d8cd98f00b204e9800998ecf8427e.jpeg' }),
    ])], { excludeSets: none(), limit: 30 });
    const art = Object.fromEntries(out.peers[0].results.map((r) => [r.title, r.albumArt]));
    assert.deepEqual(art, {
      Covered: '0f3a9c.jpg', 'Older Peer': null, 'Explicit Null': null, Nested: null, Dotdot: null,
      Backslash: null, Control: null, Empty: null, Number: null, Huge: null,
      'Encoded Dots': null, 'Encoded Name': null, Query: null, Fragment: null, Space: null, 'Non-ASCII': null,
      'No Extension': null, 'Long Stem': null, 'Real Hash': 'd41d8cd98f00b204e9800998ecf8427e.jpeg',
    });
    assert.ok(out.results.every((r) => 'albumArt' in r), 'every row carries the key, so clients read one shape');
  });
});

describe('discovery federation — throttled peer status writes (no iroh)', () => {
  const MIN = 60 * 1000;
  const T0 = Date.parse('2026-10-05T12:00:00Z');

  test('an answer writes ok at most once per peer per 5 minutes; a miss never writes', () => {
    const writes = [];
    const record = createPeerStatusRecorder((id) => writes.push(id));
    const a = { id: 1 };
    const b = { id: 2 };
    assert.equal(record(a, { reachable: true }, T0), true);
    assert.equal(record(a, { reachable: true }, T0 + 1 * MIN), false, 'inside the window');
    assert.equal(record(b, { reachable: true }, T0 + 1 * MIN), true, 'windows are per peer');
    assert.equal(record(a, { reachable: false }, T0 + 6 * MIN), false, 'a 4 s deadline is not proof the peer is down');
    assert.equal(record(a, { reachable: true, mismatched: true }, T0 + 5 * MIN), true, 'window over; a mismatch answer is an answer');
    assert.equal(record(a, {}, T0 + 20 * MIN), false, 'no outcome → no write');
    assert.deepEqual(writes, [1, 2, 1]);
  });

  test('a failed write is not remembered, so the next answer retries it', () => {
    let fail = true;
    const writes = [];
    const record = createPeerStatusRecorder((id) => {
      if (fail) { throw new Error('database is locked'); }
      writes.push(id);
    });
    assert.throws(() => record({ id: 7 }, { reachable: true }, T0), /locked/);
    fail = false;
    assert.equal(record({ id: 7 }, { reachable: true }, T0 + 1000), true);
    assert.deepEqual(writes, [7]);
  });

  test('the module recorder is wired to the federation_peers writer and fits onPeerStatus', () => {
    assert.equal(typeof recordPeerStatus, 'function');
    assert.equal(recordPeerStatus({ id: 1 }, { reachable: false }), false, 'a miss returns before touching the DB');
  });
});

describe('discovery federation aggregate (B queries A over iroh)', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  before(async () => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-fedagg-'));
    let freq = 400;
    for (const [title, artist] of REMOTE) {
      // 'Remote Hit' carries an APIC cover (attached_pic), which A's scanner
      // caches and names on the track; the rest have none.
      const art = title === 'Remote Hit' ? [
        '-f', 'lavfi', '-i', 'color=color=orange:size=64x64:duration=0.1',
        '-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:v', 'mjpeg',
        '-disposition:v:0', 'attached_pic', '-id3v2_version', '3',
      ] : [];
      await runFfmpeg([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `sine=frequency=${freq += 55}:duration=2`,
        ...art,
        '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, '-metadata', `album=${artist} Album`,
        '-ac', '1', path.join(sharedDir, `${title.replace(/\s/g, '_')}.mp3`),
      ]);
    }

    [srvA, srvB] = await Promise.all([
      startServer({
        dlnaMode: 'disabled',
        extraFolders: { shared: sharedDir },
        extraConfig: {
          federation: { enabled: true },
          scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
        },
      }),
      startServer({
        dlnaMode: 'disabled',
        extraConfig: {
          federation: { enabled: true },
          scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
        },
        // The caller: a peer that misses twice while A's endpoint boots
        // sits out 1.5 s (doubling), not 60 s, so the readiness gate below
        // still converges within its ceiling.
        env: { MSTREAM_TEST_PEER_RETRY_MS: '1500' },
      }),
    ]);

    seedDiscoveryDb(srvA, REMOTE.map(([title, , v, mbid, tags]) => [title, v, mbid, tags]));
    seedDiscoveryDb(srvB, [['Be Somebody', SEED, null, null]]);

    // Two keys on A → two peer rows on B (same endpoint) = the cross-peer
    // dedupe fixture. Public mode, so minting needs no token.
    for (const name of ['peer-one', 'peer-two']) {
      const mint = await api(srvA, 'POST', '/api/v1/admin/federation/keys', { name, vpaths: ['shared'] });
      assert.equal(mint.status, 200);
      assert.ok(mint.body.ticket, 'A must issue a ticket (endpoint up)');
      const added = await api(srvB, 'POST', '/api/v1/admin/federation/peers', { ticket: mint.body.ticket, name });
      assert.equal(added.status, 200);
      peerIds.push(added.body.id);
    }

    // Readiness gate: the federation iroh endpoint boots ASYNCHRONOUSLY and
    // can lag well past HTTP-ready — measured ~9s under slow relay bootstrap
    // (2026-08-11), while the aggregate's per-peer budget (PEER_TIMEOUT_MS,
    // src/api/discovery-federation.js) is 4s with the dial included. That
    // budget is a deliberate product choice — a slow peer must not hold the
    // Discover panel hostage — so it stays; the TESTS must instead not start
    // until the peers are genuinely dialable. Poll the aggregate itself until
    // both peer rows answer: each unreachable round costs one 4s budget, and
    // the 60s ceiling matches the helper's other loaded-CI allowances. This
    // also pre-warms the B→A bridges, which is precisely the state the
    // assertions below mean to probe (reachable peers); the dead-peer test
    // still adds its own genuinely-dead row and stays meaningful.
    const ready = Date.now() + 60_000;
    for (;;) {
      const probe = await aggregate({ filePath: SEED_PATH, limit: 1 });
      if (probe.status === 200
          && probe.body?.searched?.peers === 2
          && probe.body.searched.unreachable === 0) { break; }
      assert.ok(Date.now() < ready,
        `federation peers never became reachable: last searched=${JSON.stringify(probe.body?.searched)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  after(async () => {
    await Promise.all([srvA?.stop(), srvB?.stop()]);
    fs.rmSync(sharedDir, { recursive: true, force: true });
  });

  test('ping advertises federationDiscovery while an opted-in peer exists', async () => {
    const { status, body } = await api(srvB, 'GET', '/api/v1/ping');
    assert.equal(status, 200);
    assert.equal(body.federationDiscovery, true);
    assert.equal(body.discovery, true, 'sanity: local discovery flag rides the same ping');
    // The recommendation modal's Federate row keys on /api/'s identity half
    // (ping stays a frozen flat contract); public mode = the synthetic admin.
    const info = await api(srvB, 'GET', '/api/');
    assert.equal(info.status, 200);
    assert.equal(info.body.user.admin, true, '/api/ carries the caller\'s admin flag');
  });

  test('peerId narrows the ask to one paired server; an unknown id is a 404', async () => {
    const one = await aggregate({ filePath: SEED_PATH, peerId: peerIds[0] });
    assert.equal(one.status, 200);
    assert.equal(one.body.query.peerId, peerIds[0], 'the echo names the peer asked');
    assert.equal(one.body.searched.peers, 1, 'only the named peer row is asked');
    assert.equal(one.body.searched.unreachable, 0);
    assert.ok(one.body.results.length >= 1, 'the novel remote hit still comes back');
    assert.ok(one.body.results.every((r) => r.peer.id === peerIds[0]), 'every result is that peer\'s');

    const missing = await aggregate({ filePath: SEED_PATH, peerId: 999999 });
    assert.equal(missing.status, 404);
    const bad = await aggregate({ filePath: SEED_PATH, peerId: 'peer-one' });
    assert.equal(bad.status, 400, 'peerId is an integer id, not a name');
  });

  test('aggregates, novelty-filters, and dedupes across both peer rows', async () => {
    const { status, body } = await aggregate({ filePath: SEED_PATH });
    assert.equal(status, 200);
    assert.deepEqual(body.query, { filePath: SEED_PATH, modelId: 'test-fake', newArtistsOnly: false });
    assert.deepEqual(body.searched, { peers: 2, unreachable: 0, mismatched: 0 });

    const titles = body.results.map((r) => r.title);
    assert.deepEqual(titles, ['Remote Hit', 'Brand New Cut'],
      'descending cosine; owned artist+title and the near-dup are gone; two peers, each song once');

    const hit = body.results[0];
    assert.ok(Math.abs(hit.similarity - 0.9) < 1e-3);
    assert.equal(hit.artist, 'Nova');
    assert.equal(hit.recordingMbid, 'mbid-remote-hit');
    assert.deepEqual(hit.genreTags, ['Test---StyleZ']);
    assert.ok(hit.filepath.startsWith('shared/'), 'the peer-side vpath path rides along for the future stream proxy');
    assert.ok(peerIds.includes(hit.peer.id), 'results carry which peer answered');
    assert.ok(Math.abs(body.results[1].similarity - 0.7) < 2e-3);

    // albumArt over the real wire: A's own cover file name for the covered
    // track (what A's /album-art/ serves), null for the uncovered one.
    assert.match(hit.albumArt, /^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9]{1,7}$/, 'one plain cover file name');
    assert.ok(fs.existsSync(path.join(srvA.tmpDir, 'image-cache', hit.albumArt)), 'the file is in A\'s art cache');
    assert.equal(body.results[1].albumArt, null, 'an uncovered track names none');
    const art = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${hit.peer.id}/art/${encodeURIComponent(hit.albumArt)}`);
    assert.equal(art.status, 200);
    assert.ok(Buffer.from(await art.arrayBuffer()).equals(fs.readFileSync(path.join(srvA.tmpDir, 'image-cache', hit.albumArt))),
      'B\'s art proxy serves A\'s cached cover');
  });

  test('newArtistsOnly also drops known-artist tracks', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH, newArtistsOnly: true });
    assert.deepEqual(body.results.map((r) => r.title), ['Remote Hit'],
      "Vosto is a testlib artist B already knows; Nova isn't");
  });

  test('limit caps the merged ranking', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH, limit: 1 });
    assert.deepEqual(body.results.map((r) => r.title), ['Remote Hit']);
  });

  // The Discover page's peers section (src/api/discovery-taste.js): the
  // same fan-out asked with the centroid of B's history, answered per peer.
  test('Discover page: peers grouped per server, each song once, stamped, status refreshed', async () => {
    const played = await api(srvB, 'POST', '/api/v1/stats/plays', {
      client: { name: 'fedagg-test' },
      plays: [{ id: 'fedagg-1', filePath: SEED_PATH, startedAt: new Date(Date.now() - 3600_000).toISOString(),
        playedMs: 200000, durationMs: 200000, outcome: 'completed' }],
    });
    assert.equal(played.status, 200, JSON.stringify(played.body));
    // Adding a peer already wrote 'ok' (admin-federation's background
    // testPeer), so plant a sentinel the taste call must overwrite — else
    // the status assertion below would pass with the writer unwired.
    const mdb = new DatabaseSync(path.join(srvB.tmpDir, 'db', 'mstream.db'), { timeout: 5000 });
    try {
      mdb.prepare("UPDATE federation_peers SET last_status = 'stale', last_seen = NULL").run();
    } finally {
      mdb.close();
    }
    const { status, body } = await api(srvB, 'POST', '/api/v1/discovery/taste', { sources: ['peers'] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.seedSource, 'history');
    assert.equal(body.library, null);
    assert.equal(body.network, null, 'p2p is off on B');
    assert.deepEqual(body.peers.searched, { peers: 2, unreachable: 0, mismatched: 0 });
    assert.deepEqual(body.peers.peers.map((g) => [g.id, g.reachable, g.mismatched]),
      peerIds.map((id) => [id, true, false]), 'one group per use_discovery peer, in peer order');
    const rows = body.peers.peers.flatMap((g) => g.results);
    assert.deepEqual(rows.map((r) => r.title).sort(), ['Brand New Cut', 'Remote Hit'], 'each song once across both peer rows');
    for (const g of body.peers.peers) {
      assert.match(g.lastSeen, /Z$/, 'answered in this call: an ISO time');
      for (const r of g.results) {
        assert.equal(r.source, 'federation');
        assert.equal(r.seedHash, null);
        assert.equal(r.peer.id, g.id);
        assert.ok(r.filepath.startsWith('shared/'));
      }
    }
    const peers = await api(srvB, 'GET', '/api/v1/federation/peers');
    for (const id of peerIds) {
      const row = peers.body.peers.find((p) => p.id === id);
      assert.equal(row.lastStatus, 'ok', 'the throttled status writer ran (over the sentinel)');
      assert.ok(row.lastSeen, 'and stamped last_seen');
    }
  });

  test('stream proxy pipes a peer track byte-exact, with range support', async () => {
    const { body } = await aggregate({ filePath: SEED_PATH });
    const hit = body.results.find((r) => r.title === 'Remote Hit');
    assert.ok(hit, 'aggregate supplies the streamable filepath');
    const streamUrl = `${srvB.baseUrl}/api/v1/federation/peers/${hit.peer.id}/stream/${hit.filepath}`;

    const full = await fetch(streamUrl);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type') || '', /audio|octet/);
    const bytes = Buffer.from(await full.arrayBuffer());
    const original = fs.readFileSync(path.join(sharedDir, 'Remote_Hit.mp3'));
    assert.equal(bytes.length, original.length);
    assert.ok(bytes.equals(original), 'proxied bytes match the file on the peer');

    // Seeking = range passthrough in both directions.
    const part = await fetch(streamUrl, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.match(part.headers.get('content-range') || '', /^bytes 0-99\//);
    const partBytes = Buffer.from(await part.arrayBuffer());
    assert.equal(partBytes.length, 100);
    assert.ok(partBytes.equals(original.subarray(0, 100)));
  });

  test('stream proxy: unknown peer 404s locally; ungranted library relays the peer 404', async () => {
    const unknownPeer = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/424242/stream/shared/x.mp3`);
    assert.equal(unknownPeer.status, 404);

    // testlib is NOT granted to either key — the PEER's wall answers 404
    // (unknown-or-forbidden look identical there) and we relay it.
    const ungranted = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerIds[0]}/stream/testlib/01.mp3`);
    assert.equal(ungranted.status, 404);
  });

  test('use_discovery toggle round-trips: off → skipped + flag drops, on → back', async () => {
    for (const id of peerIds) {
      const r = await api(srvB, 'POST', `/api/v1/admin/federation/peers/${id}/discovery`, { enabled: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.use_discovery, 0);
    }
    const off = await aggregate({ filePath: SEED_PATH });
    assert.deepEqual(off.body.searched, { peers: 0, unreachable: 0, mismatched: 0 });
    assert.deepEqual(off.body.results, []);
    assert.equal((await api(srvB, 'GET', '/api/v1/ping')).body.federationDiscovery, false,
      'every peer opted out → the panel gets no flag, sends no probes');

    const back = await api(srvB, 'POST', `/api/v1/admin/federation/peers/${peerIds[0]}/discovery`, { enabled: true });
    assert.equal(back.body.use_discovery, 1);
    const on = await aggregate({ filePath: SEED_PATH });
    assert.deepEqual(on.body.searched, { peers: 1, unreachable: 0, mismatched: 0 });
    assert.deepEqual(on.body.results.map((r) => r.title), ['Remote Hit', 'Brand New Cut']);
  });

  test('unknown peer id on the toggle is 404', async () => {
    assert.equal((await api(srvB, 'POST', '/api/v1/admin/federation/peers/424242/discovery', { enabled: true })).status, 404);
  });

  // SECOND-TO-LAST — kills server A for good (nothing after this dials it).
  // Regression for the 2026-07-11 WAN smoke finding: AbortSignal.timeout
  // only bounds the HTTP request through an ESTABLISHED bridge; a dead
  // peer used to stall ~29s in the iroh redial, which the aggregator's
  // Promise.all turned into a whole-panel hang. fedFetchWithDeadline races
  // the dial too, so a dead peer now costs at most the peer timeout.
  test('a dead peer resolves unreachable within the deadline, not the dial timeout', async () => {
    await srvA.stop();
    const t0 = Date.now();
    const { status, body } = await aggregate({ filePath: SEED_PATH });
    const elapsed = Date.now() - t0;
    assert.equal(status, 200);
    assert.deepEqual(body.searched, { peers: 0, unreachable: 1, mismatched: 0 });
    assert.deepEqual(body.results, []);
    assert.ok(elapsed < 8000, `answered in ${elapsed}ms — must be bounded by the 4s peer deadline, not a ~29s dial hang`);
  });

  // LAST — flips B's live federation config off.
  test('federation disabled → aggregate and stream proxy both 403', async () => {
    const off = await api(srvB, 'POST', '/api/v1/admin/federation', { enabled: false });
    assert.equal(off.status, 200);
    const r = await aggregate({ filePath: SEED_PATH });
    assert.equal(r.status, 403);
    const s = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerIds[0]}/stream/shared/Remote_Hit.mp3`);
    assert.equal(s.status, 403);
  });
});
