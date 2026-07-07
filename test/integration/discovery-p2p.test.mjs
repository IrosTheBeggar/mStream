/**
 * Integration tests for the discovery P2P layer (p2p-sidecar + its admin
 * surface):
 *
 *   GET  /api/v1/admin/discovery/p2p/status     always available, side-effect free
 *   GET  /api/v1/admin/discovery/p2p/catalog    peers heard via gossip
 *   POST /api/v1/admin/discovery/p2p/publish    seed the export snapshot as a blob
 *   POST /api/v1/admin/discovery/p2p/announce   publish + broadcast signed announcement
 *   POST /api/v1/admin/discovery/p2p/join       add a bootstrap peer at runtime
 *   POST /api/v1/admin/discovery/p2p/fetch      pull a snapshot by ticket or endpointId
 *   POST /api/v1/admin/discovery/p2p/description  edit the announced blurb (live)
 *
 * Three layers of coverage:
 *
 *  1. Route gating (always runs, no binary needed): the 403-until-enabled
 *     contract, Joi validation, publish/announce 404-until-export-built.
 *
 *  2. The blob loop (needs a p2p-sidecar binary — prebuilt in
 *     bin/p2p-sidecar/ or a local cargo build): publish → a raw peer
 *     sidecar fetches by ticket → bytes identical, and the reverse through
 *     the admin route.
 *
 *  3. The gossip loop (same binary requirement): the server joins the
 *     catalog topic at boot; a raw peer bootstraps off the server's
 *     endpoint ticket; announcements flow BOTH ways (signed in Rust,
 *     verified in Rust, recorded by the Node catalog); the peer fetches by
 *     {hash, provider} with no ticket, and the server fetches by bare
 *     endpointId straight from its catalog.
 *
 * Everything rides the tickets' direct addresses, so the whole suite works
 * on loopback without external services. Public mode (no users) — the admin
 * auth gate has its own suite (admin-access.test.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { startServer } from '../helpers/server.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';
import { mergeSeedLists } from '../../src/state/discovery-seeds.js';
import { signSeedList } from '../../src/state/discovery-seeds-verify.js';

const SIDECAR_BIN = resolveSidecarBinary();

// Serialize a unit vector as the little-endian float32 BLOB the schema stores.
function embeddingBlob(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

// Build a synthetic peer snapshot file with the exact P0 export format
// (user_version marker, meta + tracks tables) — what fetchPeer() validates
// and the similarity search reads. Lets the whole N4a query path be tested
// without any network or sidecar.
function makeSnapshotFile(filePath, { modelId = 'test-model', tracks = [] } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.rmSync(filePath, { force: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tracks (
      export_id TEXT NOT NULL, recording_mbid TEXT, acoustid_id TEXT,
      artist TEXT, title TEXT, duration REAL,
      model_id TEXT, model_version TEXT, embedding BLOB,
      bpm INTEGER, musical_key TEXT, danceability REAL,
      genre_tags TEXT, mood_tags TEXT
    );
  `);
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('format', 'mstream-discovery-snapshot');
  meta.run('format_version', '1');
  meta.run('embedding_model_id', modelId);
  meta.run('embedding_model_version', '1');
  meta.run('row_count', String(tracks.length));
  const ins = db.prepare(`
    INSERT INTO tracks (export_id, recording_mbid, artist, title, duration, model_id, model_version, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of tracks) {
    ins.run(t.exportId || `anon:${t.title}`, t.mbid || null, t.artist, t.title,
      t.duration || 180, t.modelId || modelId, '1',
      t.vec ? embeddingBlob(t.vec) : null);
  }
  db.close();
  return filePath;
}

async function pollUntil(fn, { timeoutMs = 15000, everyMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Minimal raw-protocol driver for a standalone "peer" sidecar — deliberately
// independent of src/state/discovery-p2p.js (which manages the SERVER's
// singleton instance) so the test exercises the wire protocol itself.
class RawSidecar {
  constructor(bin, dataDir) {
    this.proc = spawn(bin, ['--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.events = [];   // every unsolicited event, in arrival order
    this.endpointId = null;
    this.ticket = null;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('peer sidecar never became ready')), 30000);
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.event === 'ready') {
          clearTimeout(t);
          this.endpointId = msg.endpointId;
          this.ticket = msg.ticket;
          resolve(msg);
          return;
        }
        if (msg.event) { this.events.push(msg); return; }
        const w = this.pending.get(msg.id);
        if (w) { this.pending.delete(msg.id); msg.ok ? w.resolve(msg) : w.reject(new Error(msg.error)); }
      });
      this.proc.once('exit', () => reject(new Error('peer sidecar exited before ready')));
    });
  }
  rpc(cmd, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) { reject(new Error(`peer rpc timeout (${cmd})`)); }
      }, 60000).unref();
    });
  }
  waitForEvent(type, predicate = () => true, timeoutMs = 20000) {
    return pollUntil(
      () => this.events.find((e) => e.event === type && predicate(e)),
      { timeoutMs, what: `sidecar event '${type}'` },
    );
  }
  async stop() {
    try { this.proc.stdin.end(); } catch (_err) { /* noop */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => { this.proc.kill(); resolve(); }, 5000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

describe('discovery p2p — route gating (no sidecar needed)', () => {
  let server;

  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('status reports disabled + not running, without side effects', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.enabled, false);
    assert.equal(body.running, false);
    assert.equal(body.endpointId, null);
    assert.equal(typeof body.binaryFound, 'boolean');
  });

  test('ping reports discoveryP2p:false so the webapp never probes', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/ping`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).discoveryP2p, false);
  });

  test('user-facing discovery routes are 403 while the feature is disabled', async () => {
    const similar = await fetch(`${server.baseUrl}/api/v1/discovery/p2p/similar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'testlib/x.mp3' }),
    });
    assert.equal(similar.status, 403);
    const shelf = await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`);
    assert.equal(shelf.status, 403);
  });

  test('all mutating + catalog routes are 403 while the feature is disabled', async () => {
    for (const [method, route, body] of [
      ['POST', 'publish', undefined],
      ['POST', 'announce', undefined],
      ['POST', 'join', { peer: 'endpointAAAAAAAAAAAAAAAA' }],
      ['POST', 'fetch', { ticket: 'blobAAAAAAAAAAAAAAAAAAAA' }],
      ['POST', 'peer-dbs/fetch', { endpointId: 'a'.repeat(64) }],
      ['POST', 'peer-dbs/remove', { endpointId: 'a'.repeat(64) }],
      ['POST', 'description', { description: 'nope' }],
      ['GET', 'catalog', undefined],
    ]) {
      const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/${route}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(r.status, 403, `${method} ${route} should be 403 when disabled`);
    }
  });
});

describe('discovery p2p — enabled, validation contract', () => {
  let server;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: { discoveryP2p: { enabled: true } },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('ping reports discoveryP2p:true — the flag that reveals the network UI', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/ping`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).discoveryP2p, true);
  });

  test('publish and announce are 404 until an export snapshot has been built', async () => {
    for (const route of ['publish', 'announce']) {
      const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/${route}`, { method: 'POST' });
      assert.equal(r.status, 404, `${route} should 404 before an export exists`);
    }
  });

  test('fetch validates addressing (400 on junk / both / neither)', async () => {
    for (const body of [
      {},
      { ticket: 'short' },
      { ticket: 42 },
      { endpointId: 'not-hex' },
      { ticket: 'blobAAAAAAAAAAAAAAAAAAAA', endpointId: 'a'.repeat(64) }, // xor
    ]) {
      const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} should be 400`);
    }
  });

  test('fetch by endpointId 404s for a peer the catalog has never heard of', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointId: 'a'.repeat(64) }),
    });
    assert.equal(r.status, 404);
  });

  test('join validates the peer body', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peer: 'x' }),
    });
    assert.equal(r.status, 400);
  });

  test('description validates: 180-char cap, no pipe, no control chars', async () => {
    const post = (body) => fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/description`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    for (const body of [
      {},                                      // missing key
      { description: 42 },                     // not a string
      { description: 'é'.repeat(181) },        // over the char cap
      { description: 'come get it | free' },   // signing separator
      { description: 'line\nbreak' },          // control character
    ]) {
      const r = await post(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} should be 400`);
    }
    // Exactly 180 chars is the documented maximum.
    assert.equal((await post({ description: 'é'.repeat(180) })).status, 200);
  });

  test('description saves live and reads back from status; no export → announced:false', async () => {
    const text = 'Mostly jazz and electronic — 500 tracks, well tagged';
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/description`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: text }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).announced, false, 'nothing published yet — nothing to re-announce');

    const status = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(status.serverDescription, text);
    assert.equal(typeof status.serverName, 'string', 'status also exposes the announce name for the admin UI');
  });
});

// The real loops — need a sidecar binary. Skip cleanly (visible in the test
// summary) on machines that have neither the prebuilt nor a local build.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — blob + gossip loops', () => {
  let server;
  let peer;
  let peerDir;
  const api = (p) => `${server.baseUrl}/api/v1/admin/discovery/p2p/${p}`;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'Gossip Test Server' },
        scanOptions: { collectDiscoveryData: true },
      },
    });
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-peer-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(peerDir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (peerDir) { fs.rmSync(peerDir, { recursive: true, force: true }); }
  });

  test('boot wiring auto-starts the sidecar and joins the topic', async () => {
    // discoveryP2p.enabled was on at boot, so the server should already be
    // running its sidecar (or come up within the poll window).
    const status = await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot + join' });
    assert.match(status.endpointId, /^[0-9a-f]{64}$/);
    assert.ok(status.ticket.length > 32, 'status must expose the bootstrap ticket');
  });

  test('blob loop: publish → peer fetches by ticket → bytes match', async () => {
    const build = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' });
    assert.equal(build.status, 200);

    const pub = await fetch(api('publish'), { method: 'POST' });
    assert.equal(pub.status, 200);
    const { hash, size, ticket } = await pub.json();
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(size > 0);

    const outDir = path.join(peerDir, 'fetched');
    const got = await peer.rpc('fetch', { ticket, outDir });
    assert.equal(got.hash, hash);
    assert.equal(got.size, size);

    const snapshot = path.join(server.tmpDir, 'db', 'discovery-export', 'discovery-export.db');
    assert.deepEqual(fs.readFileSync(got.path), fs.readFileSync(snapshot),
      'fetched bytes must match the published snapshot exactly');
  });

  test('gossip loop: announcements flow both ways; fetch works ticketless', async () => {
    const serverStatus = await (await fetch(api('status'))).json();

    // Peer bootstraps off the server's endpoint ticket (loopback direct
    // addresses — no external discovery involved).
    await peer.rpc('join', { bootstrap: [serverStatus.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    // Server → peer: re-announce now that the mesh is up (gossip has no
    // history, so the peer wouldn't hear anything until the next periodic
    // re-broadcast otherwise).
    const ann = await (await fetch(api('announce'), { method: 'POST' })).json();
    assert.equal(ann.announced, true);
    assert.equal(ann.broadcast, true, 'server must already be joined (boot wiring)');

    const heard = await peer.waitForEvent('announcement', (e) => e.from === serverStatus.endpointId);
    assert.equal(heard.payload.hash, ann.hash);
    assert.equal(heard.payload.name, 'Gossip Test Server');
    assert.ok(Number.isInteger(heard.payload.snapshotSeq));

    // Ticketless fetch: hash + provider from the announcement, address
    // resolution via the peer's memory lookup (seeded by the join ticket).
    const outDir = path.join(peerDir, 'fetched-gossip');
    const got = await peer.rpc('fetch', {
      hash: heard.payload.hash, provider: heard.from, outDir,
    });
    assert.equal(got.hash, heard.payload.hash);

    // Peer → server: peer publishes + announces its own blob; the server's
    // catalog should record it, then fetch by bare endpointId.
    const blobFile = path.join(peerDir, 'peer-snapshot.db');
    fs.writeFileSync(blobFile, Buffer.from('peer discovery data ' + 'x'.repeat(4096)));
    const peerPub = await peer.rpc('publish', { path: blobFile });
    await peer.rpc('announce', {
      payload: {
        hash: peerPub.hash, size: peerPub.size, rowCount: 42,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Peer',
      },
    });

    const catalogEntry = await pollUntil(async () => {
      const c = await (await fetch(api('catalog'))).json();
      return c.peers.find((p) => p.from === peer.endpointId) || null;
    }, { what: "peer's announcement in the server catalog" });
    assert.equal(catalogEntry.payload.hash, peerPub.hash);
    assert.equal(catalogEntry.payload.rowCount, 42);
    assert.equal(catalogEntry.payload.name, 'Peer');

    const fetched = await fetch(api('fetch'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointId: peer.endpointId }),
    });
    assert.equal(fetched.status, 200);
    const gotPeer = await fetched.json();
    assert.equal(gotPeer.hash, peerPub.hash);
    assert.deepEqual(fs.readFileSync(gotPeer.path), fs.readFileSync(blobFile));

    // And the catalog survives on disk for the next boot.
    const persisted = path.join(server.tmpDir, 'db', 'discovery-p2p', 'catalog.json');
    await pollUntil(() => fs.existsSync(persisted), { what: 'catalog.json to persist' });
  });
});

// ── N4a: the similarity search over fetched peer snapshots ─────────────────
// Entirely synthetic — no sidecar, no network. Peer snapshot files are built
// with the exact P0 export format and placed on the shelf (registry +
// discovery-peers/) by hand; the local seed embedding is inserted straight
// into the server's discovery.db, following the discovery-export test's
// precedent for direct seeding.
describe('discovery p2p — similarity search + novelty filter', () => {
  let server;
  let trackA;      // local seed: has an embedding, artist known locally
  let trackB;      // local track whose artist+title a peer duplicates
  let trackC;      // local track with NO discovery row (404 case)
  const MODEL = 'test-model';
  const PEER_X = 'a'.repeat(64);
  const PEER_Y = 'b'.repeat(64);

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: true,
      extraConfig: {
        discoveryP2p: { enabled: true, autoFetch: false },
        scanOptions: { collectDiscoveryData: true },
      },
    });

    // Three real scanned tracks with distinct non-null artists.
    const mdb = new DatabaseSync(path.join(server.tmpDir, 'db', 'mstream.db'), { readOnly: true });
    const rows = mdb.prepare(`
      SELECT t.filepath, t.audio_hash, a.name AS artist, t.title AS title
      FROM tracks t JOIN artists a ON a.id = t.artist_id
      WHERE t.audio_hash IS NOT NULL AND t.title IS NOT NULL
      ORDER BY t.filepath LIMIT 3
    `).all();
    mdb.close();
    assert.ok(rows.length === 3, 'fixture library must yield 3 tagged tracks');
    [trackA, trackB, trackC] = rows;

    // Local embedding for track A (unit vector [1,0,0,0]) + an owned MBID.
    const ddb = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
    ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, source_mtime, updated_at, export_id, recording_mbid,
         artist, title, model_id, model_version, embedding)
      VALUES (?, 1, 1, ?, ?, ?, ?, ?, '1', ?)
    `).run(trackA.audio_hash, 'anon:seed', 'mbid-owned', trackA.artist,
      trackA.title, MODEL, embeddingBlob([1, 0, 0, 0]));
    ddb.close();

    // Peer X: the novelty-filter menagerie in the matching model space.
    const peerDir = path.join(server.tmpDir, 'db', 'discovery-peers');
    makeSnapshotFile(path.join(peerDir, 'x'.repeat(64) + '.db'), {
      modelId: MODEL,
      tracks: [
        // near-duplicate of the query itself -> excluded (same recording)
        { artist: 'Dup Artist', title: 'Same Recording', vec: [1, 0, 0, 0] },
        // MBID the local library owns -> excluded
        { artist: 'Mbid Artist', title: 'Owned Song', mbid: 'mbid-owned', vec: [0.7, 0.7141, 0, 0] },
        // artist+title collides with local track B -> excluded
        { artist: trackB.artist, title: trackB.title, vec: [0.8, 0.6, 0, 0] },
        // known artist, new song -> kept (dropped by newArtistsOnly)
        { artist: trackA.artist, title: 'Brand New Song', vec: [0.6, 0.8, 0, 0] },
        // brand-new artist -> kept, ranks first
        { artist: 'Totally New Artist', title: 'Fresh Cut', vec: [0.9, 0.43589, 0, 0] },
        // another new artist, orthogonal -> kept, ranks last
        { artist: 'Another New Artist', title: 'Distant Sound', vec: [0, 1, 0, 0] },
        // no embedding -> never part of the search space
        { artist: 'Null Artist', title: 'No Vector', vec: null },
        // wrong model space -> never part of the search space
        { artist: 'Wrong Model', title: 'Alien Vector', vec: [1, 0, 0, 0], modelId: 'other-model' },
      ],
    });
    // Peer Y: nothing in the query's model space at all.
    makeSnapshotFile(path.join(peerDir, 'y'.repeat(64) + '.db'), {
      modelId: 'other-model',
      tracks: [{ artist: 'Other Space', title: 'Unreachable', vec: [1, 0, 0, 0], modelId: 'other-model' }],
    });

    // Hand-write the shelf registry the peer-db module lazy-loads.
    const p2pDir = path.join(server.tmpDir, 'db', 'discovery-p2p');
    fs.mkdirSync(p2pDir, { recursive: true });
    fs.writeFileSync(path.join(p2pDir, 'peer-dbs.json'), JSON.stringify([
      { endpointId: PEER_X, hash: 'x'.repeat(64), path: path.join(peerDir, 'x'.repeat(64) + '.db'),
        snapshotSeq: 1, modelId: MODEL, rowCount: 8, sizeBytes: 8192, name: 'Peer X', fetchedAt: new Date().toISOString() },
      { endpointId: PEER_Y, hash: 'y'.repeat(64), path: path.join(peerDir, 'y'.repeat(64) + '.db'),
        snapshotSeq: 1, modelId: 'other-model', rowCount: 1, sizeBytes: 4096, name: 'Peer Y', fetchedAt: new Date().toISOString() },
    ]));
  });
  after(async () => { if (server) { await server.stop(); } });

  const similar = (body) => fetch(`${server.baseUrl}/api/v1/discovery/p2p/similar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('filter chain: same-recording/mbid/artist+title excluded, rest ranked by cosine', async () => {
    const r = await similar({ filePath: `testlib/${trackA.filepath}` });
    assert.equal(r.status, 200);
    const body = await r.json();

    assert.equal(body.query.modelId, MODEL);
    // Peer Y has zero rows in the model space -> only Peer X is searched.
    assert.equal(body.searched.peers, 1);
    assert.equal(body.searched.tracks, 6, 'null-embedding and wrong-model rows are outside the space');

    const titles = body.results.map((x) => x.title);
    assert.deepEqual(titles, ['Fresh Cut', 'Brand New Song', 'Distant Sound'],
      'exclusions applied and ranking is cosine-descending');
    assert.ok(Math.abs(body.results[0].similarity - 0.9) < 0.001);
    assert.equal(body.results[0].peer.endpointId, PEER_X);
    assert.equal(body.results[0].peer.name, 'Peer X');
  });

  test('newArtistsOnly also drops artists the local library knows', async () => {
    const r = await similar({ filePath: `testlib/${trackA.filepath}`, newArtistsOnly: true });
    const body = await r.json();
    assert.deepEqual(body.results.map((x) => x.title), ['Fresh Cut', 'Distant Sound']);
  });

  test('limit caps the result list', async () => {
    const r = await similar({ filePath: `testlib/${trackA.filepath}`, limit: 1 });
    const body = await r.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, 'Fresh Cut');
  });

  test('a track without an embedding is a clear 404, not an empty result', async () => {
    const r = await similar({ filePath: `testlib/${trackC.filepath}` });
    assert.equal(r.status, 404);
  });

  test('unknown filepath is 404; junk body is 400', async () => {
    assert.equal((await similar({ filePath: 'testlib/does-not-exist.mp3' })).status, 404);
    assert.equal((await similar({})).status, 400);
    assert.equal((await similar({ filePath: `testlib/${trackA.filepath}`, limit: 0 })).status, 400);
  });

  test('the shelf route lists both fetched snapshots', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.peerDbs.length, 2);
    const x = body.peerDbs.find((p) => p.endpointId === PEER_X);
    assert.equal(x.name, 'Peer X');
  });

  test('admin catalog reports shelf state + storage', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.storage.usedBytes > 0);
    assert.equal(body.autoFetch, false);
  });
});

// ── N4a: auto-fetch — announcements turn into downloaded snapshots ─────────
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — auto-fetch loop', () => {
  let server;
  let peer;
  let peerDir;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750' },
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'AutoFetch Server' },
        scanOptions: { collectDiscoveryData: true },
      },
    });
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-af-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(peerDir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (peerDir) { fs.rmSync(peerDir, { recursive: true, force: true }); }
  });

  test('an announced snapshot is fetched automatically and refreshed on seq bump', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });

    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    // Publish + announce a REAL snapshot-format file (auto-fetch validates it).
    const v1 = makeSnapshotFile(path.join(peerDir, 'snap-v1.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Net Artist', title: 'Net Song', vec: [1, 0, 0, 0] }],
    });
    const pub1 = await peer.rpc('publish', { path: v1 });
    await peer.rpc('announce', {
      payload: { hash: pub1.hash, size: pub1.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 5, name: 'AutoPeer' },
    });

    // Debounced reconcile (750ms in this test) should pull it down unprompted.
    const shelf1 = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
      return s.peerDbs.find((p) => p.endpointId === peer.endpointId) || null;
    }, { timeoutMs: 30000, what: 'auto-fetch to download the announced snapshot' });
    assert.equal(shelf1.rowCount, 1);
    assert.equal(shelf1.modelId, 'test-model');

    // Bump: new snapshot content + higher monotonic seq -> auto-refresh.
    const v2 = makeSnapshotFile(path.join(peerDir, 'snap-v2.db'), {
      modelId: 'test-model',
      tracks: [
        { artist: 'Net Artist', title: 'Net Song', vec: [1, 0, 0, 0] },
        { artist: 'Second Artist', title: 'Second Song', vec: [0, 1, 0, 0] },
      ],
    });
    const pub2 = await peer.rpc('publish', { path: v2 });
    await peer.rpc('announce', {
      payload: { hash: pub2.hash, size: pub2.size, rowCount: 2,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 6, name: 'AutoPeer' },
    });

    await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
      const entry = s.peerDbs.find((p) => p.endpointId === peer.endpointId);
      return entry && entry.rowCount === 2 ? entry : null;
    }, { timeoutMs: 30000, what: 'auto-fetch to refresh the stale snapshot' });
  });
});

// ── Community seeds: merge logic (pure, no server) ──────────────────────────
describe('discovery seeds — mergeSeedLists', () => {
  const T = (n) => `endpointticket${'x'.repeat(16)}${n}`;
  const ID_A = 'a'.repeat(64);

  test('merges baked + remote + user peers, deduped, in order', () => {
    const out = mergeSeedLists(
      [{ name: 's1', ticket: T(1) }],
      [{ name: 's2', ticket: T(2) }, { name: 'dup', ticket: T(1) }],
      [T(3), T(2)],
      [],
    );
    assert.deepEqual(out, [T(1), T(2), T(3)]);
  });

  test('blocklist removes seeds by endpointId and bare-id user peers', () => {
    const out = mergeSeedLists(
      [{ name: 'blocked-seed', endpointId: ID_A, ticket: T(1) }],
      [{ name: 'ok', ticket: T(2) }],
      [ID_A, T(3)],
      [ID_A],
    );
    assert.deepEqual(out, [T(2), T(3)]);
  });

  test('malformed entries are dropped, never thrown on', () => {
    const out = mergeSeedLists(
      [null, {}, { ticket: 42 }, { ticket: 'short' }, { name: 'ok', ticket: T(1) }],
      [{ ticket: T(2), endpointId: 'NOT-HEX' }],
      [123, null],
      [],
    );
    assert.deepEqual(out, [T(1)]);
  });
});

// ── Community seeds: the full boot path against a stub list server ──────────
// A local HTTP server plays the role of raw.githubusercontent.com; a raw
// sidecar plays the community seed. The mStream server must fetch the list,
// cache it, bootstrap off the listed ticket, and hear announcements through
// the mesh — the complete PR-2 behavior with zero real infrastructure.
(SIDECAR_BIN ? describe : describe.skip)('discovery seeds — boot joins via fetched seed list', () => {
  let server;
  let seedNode;      // raw sidecar acting as the community seed (relay only)
  let peerNode;      // raw sidecar acting as another mStream server
  let listServer;
  let listUrl;
  let listHits = 0;
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-seeds-'));
    seedNode = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'seed'));
    await seedNode.ready;
    // The seed joins with no bootstrap — it IS the first node.
    await seedNode.rpc('join', { bootstrap: [] });

    // Stub "GitHub raw" endpoint serving a v1 seed list with the seed's
    // ticket. Lists are signature-checked now, so the stub signs with a
    // throwaway key and the spawned server trusts it via the test-only
    // pubkey override.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const testPubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const signedList = signSeedList({
      version: 1,
      seq: 1,
      seeds: [{ name: 'test-seed', endpointId: seedNode.endpointId, ticket: seedNode.ticket }],
    }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const http = await import('node:http');
    listServer = http.createServer((req, res) => {
      listHits += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(signedList));
    });
    await new Promise((r) => listServer.listen(0, '127.0.0.1', r));
    listUrl = `http://127.0.0.1:${listServer.address().port}/discovery-seeds.json`;

    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_SEEDS_PUBKEY: testPubB64 },
      extraConfig: {
        // useCommunitySeeds must be re-enabled explicitly: the test helper
        // forces it off so ordinary suites can never join the real network
        // through the baked seed list.
        discoveryP2p: { enabled: true, serverName: 'Seed Test Server', seedListUrl: listUrl, useCommunitySeeds: true },
        scanOptions: { collectDiscoveryData: true },
      },
    });

    peerNode = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'peer'));
    await peerNode.ready;
  });
  after(async () => {
    if (peerNode) { await peerNode.stop(); }
    if (seedNode) { await seedNode.stop(); }
    if (server) { await server.stop(); }
    if (listServer) { listServer.close(); }
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  test('server fetches the list, caches it, and meshes through the seed', async () => {
    // The boot path must have pulled the stub list at least once and written
    // the on-disk cache next to the catalog.
    await pollUntil(() => listHits > 0, { what: 'seed list to be fetched' });
    const cache = path.join(server.tmpDir, 'db', 'discovery-p2p', 'seeds-cache.json');
    await pollUntil(() => fs.existsSync(cache), { what: 'seed list cache on disk' });
    assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).seeds[0].name, 'test-seed');

    // A peer that knows ONLY the seed announces; the server (which also knows
    // only the seed) must hear it through the mesh — the strangers-meeting
    // scenario community seeds exist for.
    await peerNode.rpc('join', { bootstrap: [seedNode.ticket] });
    await peerNode.waitForEvent('neighbor', (e) => e.up === true);
    await peerNode.rpc('announce', {
      payload: { hash: 'c'.repeat(64), size: 4096, rowCount: 7,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Stranger' },
    });

    const entry = await pollUntil(async () => {
      const c = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      return c.peers.find((p) => p.from === peerNode.endpointId) || null;
    }, { timeoutMs: 30000, what: "stranger's announcement via the seed mesh" });
    assert.equal(entry.payload.name, 'Stranger');

    // The status route surfaces the community-seeds mode for the admin UI.
    const status = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(status.communitySeeds, true);
  });
});

// ── Community seeds: dead URL must not break boot or friend-to-friend ───────
describe('discovery seeds — unreachable list degrades gracefully', () => {
  let server;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: {
        discoveryP2p: {
          enabled: true,
          // Nothing listens here — the fetch fails fast and falls back.
          seedListUrl: 'http://127.0.0.1:9/discovery-seeds.json',
        },
        scanOptions: { collectDiscoveryData: true },
      },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('server boots, joins the topic, and the p2p surface works', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running ? s : null;
    }, { timeoutMs: 30000, what: 'sidecar up despite dead seed URL' });
    // With the binary present the sidecar must still be running and joined-
    // or-joinable; without it the route still answers. Either way the dead
    // URL must not have prevented the boot path from completing.
    assert.equal(status.enabled, true);
  });
});

// ── N3: seeder beacons + swarm failover ─────────────────────────────────────
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — seeders + swarm (N3)', () => {
  let server;
  let p1;
  let p2;
  let tmpDir;
  // The chicken-and-egg of protocol PRs: CI runs whatever prebuilt sidecar
  // master last shipped (bin/p2p-sidecar/), which by definition predates
  // the protocol additions in the PR under review — local dev always has a
  // fresh cargo build, so this only bites CI. Probe the capability in
  // before() and skip with a reason; the post-merge binaries rebuild makes
  // CI cover this suite automatically from the next PR on.
  let sidecarHasN3 = false;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750' },
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'Swarm Server' },
        scanOptions: { collectDiscoveryData: true },
      },
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-n3-'));
    p1 = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'p1'));
    p2 = new RawSidecar(SIDECAR_BIN, path.join(tmpDir, 'p2'));
    await p1.ready; await p2.ready;
    try {
      await p1.rpc('setHolds', { hashes: [] });
      sidecarHasN3 = true;
    } catch (_err) {
      sidecarHasN3 = false; // old binary: "unknown command: setHolds"
    }
  });
  after(async () => {
    if (p1) { await p1.stop(); }
    if (p2) { await p2.stop(); }
    if (server) { await server.stop(); }
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  test('holds beacons produce seeder counts; snapshots survive their author', async (t) => {
    if (!sidecarHasN3) {
      return t.skip('prebuilt sidecar predates the N3 protocol — rebuilt binaries land after this PR merges');
    }
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar up' });

    await p1.rpc('join', { bootstrap: [status.ticket] });
    await p1.waitForEvent('neighbor', (e) => e.up === true);
    await p2.rpc('join', { bootstrap: [status.ticket] });
    await p2.waitForEvent('neighbor', (e) => e.up === true);

    // P1 authors a snapshot, announces it, and beacons that it holds it.
    const snap = makeSnapshotFile(path.join(tmpDir, 'p1-snap.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Swarm Artist', title: 'Swarm Song', vec: [1, 0, 0, 0] }],
    });
    const pub = await p1.rpc('publish', { path: snap });
    await p1.rpc('announce', {
      payload: { hash: pub.hash, size: pub.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 3, name: 'SwarmAuthor' },
    });
    await p1.rpc('setHolds', { hashes: [pub.hash] });

    // The server aggregates P1's signed beacon into a live seeder count.
    const entry = await pollUntil(async () => {
      const c = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      const e = c.peers.find((p) => p.from === p1.endpointId);
      return e && e.seeders >= 1 ? e : null;
    }, { timeoutMs: 30000, what: 'seeder count from holds beacon' });
    assert.ok(entry.seeders >= 1, `expected >=1 seeder, got ${entry.seeders}`);

    // Server fetches the snapshot -> becomes a holder -> its own holds
    // beacon must now list the hash (observed by P2 = the network's view).
    const fetched = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointId: p1.endpointId }),
    });
    assert.equal(fetched.status, 200);
    const serverHolds = await p2.waitForEvent('holds',
      (e) => e.from === status.endpointId && e.holds.includes(pub.hash), 90000);
    assert.ok(serverHolds, 'P2 must hear the server beacon that it now holds the snapshot');

    // THE HEADLINE: kill the author. The snapshot must remain fetchable
    // from the surviving holder (the server) via the provider list.
    await p1.stop();
    const got = await p2.rpc('fetch', {
      hash: pub.hash,
      providers: [p1.endpointId, status.endpointId],
      outDir: path.join(tmpDir, 'p2-fetched'),
    });
    assert.equal(got.hash, pub.hash);
    assert.deepEqual(fs.readFileSync(got.path), fs.readFileSync(snap),
      'bytes fetched from a non-author holder must match the original exactly');
  });
});

// ── Zero-touch auto-publish ─────────────────────────────────────────────────
// The live-run polish headline: a fresh server with collection + p2p enabled
// must appear on the network — export built, snapshot announced — with ZERO
// admin steps. This suite never POSTs discovery-export or announce; the
// announcement must arrive purely from scan → embed → auto-publish.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — zero-touch auto-publish', () => {
  let server;
  let peer;
  let peerDir;
  let musicDir;

  // Minimal PCM WAV writer (8kHz mono 16-bit sine) — the shared fixtures are
  // all shorter than the worker's 30s eligibility floor, and generating
  // audio in JS keeps this hermetic (no encoder needed; the worker's ffmpeg
  // decode is already a prereq of the other discovery-worker suites).
  function writeSineWav(filePath, seconds) {
    const rate = 8000;
    const n = rate * seconds;
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, data]));
  }

  before(async () => {
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-zerotouch-lib-'));
    writeSineWav(path.join(musicDir, 'long-tone.wav'), 35);
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: true,
      extraFolders: { zerotouch: musicDir },
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'Zero Touch' },
        scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
      },
    });
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-zt-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(peerDir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    for (const d of [peerDir, musicDir]) {
      if (d) { fs.rmSync(d, { recursive: true, force: true }); }
    }
  });

  test('scan → embed → export + announce, with no admin calls', async (t) => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'sidecar to boot' });

    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    // The announcement arrives on its own: the embedding pass drains,
    // auto-publish rebuilds the export and announces, and the sidecar's
    // 15s re-broadcast loop covers the join-after-publish ordering.
    const heard = await peer.waitForEvent('announcement',
      (e) => e.from === status.endpointId && (e.payload.rowCount || 0) > 0, 90000);
    assert.equal(heard.payload.name, 'Zero Touch');
    assert.equal(heard.payload.rowCount, 1, 'exactly the one eligible (≥30s) track');
    assert.ok(heard.payload.snapshotSeq > 0, 'announces the app-managed row_seq');

    // The export the announcement points at exists and carries the
    // freshness watermark auto-publish keys off.
    const manifest = await (await fetch(
      `${server.baseUrl}/api/v1/admin/db/discovery-export/manifest`)).json();
    assert.equal(manifest.rowCount, 1);
    assert.equal(Number(manifest.sourceRowSeq), heard.payload.snapshotSeq,
      'manifest sourceRowSeq must match the announced snapshotSeq');

    // And the payload is really fetchable — the network got a usable blob.
    const got = await peer.rpc('fetch', {
      hash: heard.payload.hash, provider: heard.from,
      outDir: path.join(peerDir, 'fetched'),
    });
    assert.equal(got.hash, heard.payload.hash);
    t.diagnostic(`zero-touch announce heard; snapshot ${got.size} bytes`);
  });
});

// ── Catalog descriptions — the signed blurb next to each server's name ──────
// Descriptions ride the signed announcement payload (appended to the signing
// string only when non-empty, so blank-description announcements stay
// compatible with pre-description binaries). Same capability-gate dance as
// N3: CI runs master's prebuilt sidecar until this PR's binaries land.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — catalog descriptions', () => {
  const SERVER_DESC = 'Mostly jazz — 500 well-tagged tracks';
  let server;
  let peer;
  let peerDir;
  let sidecarHasDescription = false;
  const api = (p) => `${server.baseUrl}/api/v1/admin/discovery/p2p/${p}`;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'Description Server', serverDescription: SERVER_DESC },
        scanOptions: { collectDiscoveryData: true },
      },
    });
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-desc-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(peerDir, 'sidecar'));
    await peer.ready;
    // Probe: a NEW sidecar rejects a pipe in the description; an OLD one
    // doesn't know the field exists and silently drops it (serde ignores
    // unknown payload keys) — acceptance means "no description support".
    try {
      await peer.rpc('announce', {
        payload: { hash: 'a'.repeat(64), size: 1, rowCount: 1, modelId: 'm',
          modelVersion: '1', snapshotSeq: 1, name: 'probe', description: 'x|y' },
      });
      sidecarHasDescription = false;
    } catch (_err) {
      sidecarHasDescription = true;
    }
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (peerDir) { fs.rmSync(peerDir, { recursive: true, force: true }); }
  });

  test('descriptions travel signed, live-edit, and update the catalog on same-seq re-announce', async (t) => {
    if (!sidecarHasDescription) {
      return t.skip('prebuilt sidecar predates the description field — rebuilt binaries land after this PR merges');
    }
    const status = await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    assert.equal(status.serverDescription, SERVER_DESC, 'status exposes the configured blurb');

    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    // Server → peer: the configured description arrives inside the
    // signature-verified announcement.
    assert.equal((await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(api('announce'), { method: 'POST' })).status, 200);
    const heard = await peer.waitForEvent('announcement',
      (e) => e.from === status.endpointId, 30000);
    assert.equal(heard.payload.description, SERVER_DESC);
    assert.equal(heard.payload.name, 'Description Server');

    // Live edit: POST /description re-announces; the peer hears the new
    // text (immediately, or via the 15s re-broadcast loop if the flood
    // guard swallows the instant one).
    const edited = 'Now with vinyl rips and live sets';
    const r = await fetch(api('description'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: edited }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).announced, true, 'a published snapshot means the edit broadcasts');
    await peer.waitForEvent('announcement',
      (e) => e.from === status.endpointId && e.payload.description === edited, 45000);

    // Peer → server: a described announcement lands in the catalog…
    const blobFile = path.join(peerDir, 'peer-snapshot.db');
    fs.writeFileSync(blobFile, Buffer.from('peer discovery data ' + 'x'.repeat(4096)));
    const pub = await peer.rpc('publish', { path: blobFile });
    const payload = { hash: pub.hash, size: pub.size, rowCount: 9, modelId: 'test-model',
      modelVersion: '1', snapshotSeq: 3, name: 'DescPeer', description: 'first blurb' };
    await peer.rpc('announce', { payload });
    const entry = await pollUntil(async () => {
      const c = await (await fetch(api('catalog'))).json();
      const e = c.peers.find((p) => p.from === peer.endpointId);
      return e && e.payload.description === 'first blurb' ? e : null;
    }, { timeoutMs: 30000, what: "peer's description in the catalog" });
    assert.equal(entry.payload.name, 'DescPeer');

    // …and an edited description under the SAME snapshotSeq + hash still
    // updates the entry — text changes count as news, not heartbeat (the
    // discovery-catalog change-detection this feature depends on).
    await peer.rpc('announce', { payload: { ...payload, description: 'second blurb' } });
    await pollUntil(async () => {
      const c = await (await fetch(api('catalog'))).json();
      const e = c.peers.find((p) => p.from === peer.endpointId);
      return e && e.payload.description === 'second blurb' ? e : null;
    }, { timeoutMs: 45000, what: 'same-seq description edit to reach the catalog' });
  });

  test('the sidecar refuses an oversized description at the announce RPC', async (t) => {
    if (!sidecarHasDescription) {
      return t.skip('prebuilt sidecar predates the description field');
    }
    await assert.rejects(
      peer.rpc('announce', {
        payload: { hash: 'b'.repeat(64), size: 1, rowCount: 1, modelId: 'm',
          modelVersion: '1', snapshotSeq: 1, name: 'x', description: 'y'.repeat(181) },
      }),
      /description/i,
      'a 181-char description must be rejected before it is ever signed',
    );
  });
});
