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
      ['POST', 'sidecar-max-rss', { sidecarMaxRssMb: 512 }],
      ['GET', 'catalog', undefined],
      ['GET', 'activity', undefined],
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

  test('status exposes neighborIds as an array — empty with no mesh', async () => {
    // The panel's mesh map renders from this; before any peer joins (or
    // where no sidecar binary exists at all) it must be a clean [] rather
    // than absent, so the SVG math never branches on undefined.
    const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.ok(Array.isArray(s.neighborIds), 'neighborIds is always an array');
    assert.equal(s.neighborIds.length, 0, 'no mesh yet — nobody listed');
  });

  test('sidecar-max-rss: a valid ceiling saves live and reads back; junk is 400', async () => {
    const url = `${server.baseUrl}/api/v1/admin/discovery/p2p/sidecar-max-rss`;
    const post = (body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const ok = await post({ sidecarMaxRssMb: 384 });
    assert.equal(ok.status, 200);
    let s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(s.watchdog.maxRssMb, 384, 'the watchdog ceiling reflects the write immediately');

    // 0 is the documented off switch, not an error.
    assert.equal((await post({ sidecarMaxRssMb: 0 })).status, 200);
    s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(s.watchdog.maxRssMb, 0, '0 = watchdog off');

    for (const body of [{}, { sidecarMaxRssMb: -1 }, { sidecarMaxRssMb: 1.5 },
      { sidecarMaxRssMb: 'lots' }, { sidecarMaxRssMb: 100001 }]) {
      const r = await post(body);
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} should be 400`);
    }
    s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(s.watchdog.maxRssMb, 0, 'rejected writes change nothing');
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

    // The server saw the same link from its side: the peer's endpoint id
    // shows up in status.neighborIds (the panel's mesh map draws from
    // this). Event-tracked, so poll — the neighbor event may land a beat
    // after the announcement round-trips.
    const withNeighbor = await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.neighborIds.includes(peer.endpointId) ? s : null;
    }, { what: 'the peer to appear in status.neighborIds' });
    assert.ok(withNeighbor.neighbors >= 1, 'the count agrees a link exists');

    // And the Activity feed heard about it: the dedicated p2p log ring
    // carries the neighbor-up line — and ONLY prefixed discovery lines,
    // even though this server has logged plenty of non-discovery lines
    // since boot (the wash-in negative control).
    const activity = await (await fetch(api('activity'))).json();
    assert.ok(activity.entries.length > 0, 'the feed has entries');
    assert.ok(activity.entries.every((e) => /^\[(discovery-|p2p-sidecar)/.test(e.message)),
      'every feed entry is a discovery/p2p line — boot noise stays out');
    assert.ok(activity.entries.some((e) =>
      e.message.includes('mesh neighbor up') && e.message.includes(peer.endpointId.slice(0, 12))),
    'the neighbor-up event for this peer is in the feed');
    assert.ok(Number.isInteger(activity.lastSeq), 'delta-poll cursor present');

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

    // Membership metadata at first fetch, straight from the persisted
    // registry (an automatic download must arrive unpinned).
    const registryPath = path.join(server.tmpDir, 'db', 'discovery-p2p', 'peer-dbs.json');
    const reg1 = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
      .find((e) => e.endpointId === peer.endpointId);
    assert.equal(reg1.pinned, false);
    assert.ok(reg1.firstFetchedAt, 'first fetch must stamp the membership clock');

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

    // A refresh replaces the bytes, NOT the membership: the record is
    // rewritten (fetchedAt advances) but the membership clock and the pin
    // state carry over — reset either here and an actively-publishing peer
    // could never rotate (or would silently lose its pin).
    const reg2 = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
      .find((e) => e.endpointId === peer.endpointId);
    assert.notEqual(reg2.fetchedAt, reg1.fetchedAt, 'the refresh must rewrite the record');
    assert.equal(reg2.firstFetchedAt, reg1.firstFetchedAt,
      'the membership clock must survive a seq-refresh');
    assert.equal(reg2.pinned, false, 'a refresh must not invent a pin');
  });
});

// ── Space-aware auto-fetch: the storage cap picks WHICH peers, not just how
// many ───────────────────────────────────────────────────────────────────────
// A candidate whose announced size can't fit under maxPeerDbStorageMb is a
// sizing mismatch, not a fetch failure: reconcile must skip it WITHOUT
// burning its per-peer backoff and keep walking the candidate list so a
// smaller peer further down still gets downloaded. autoFetchCount=1 makes
// this a binary discriminator — a count-sliced top-up would pick only the
// big peer (it outranks on every sort key), fail its fetch forever, and
// starve the small one.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — space-aware auto-fetch', () => {
  let server;
  let bigPeer;
  let smallPeer;
  let dir;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: { MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750' },
      extraConfig: {
        discoveryP2p: { enabled: true, autoFetchCount: 1, maxPeerDbStorageMb: 10 },
      },
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-space-'));
    bigPeer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'big'));
    smallPeer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'small'));
    await Promise.all([bigPeer.ready, smallPeer.ready]);
  });
  after(async () => {
    if (bigPeer) { await bigPeer.stop(); }
    if (smallPeer) { await smallPeer.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a too-big candidate is skipped and a smaller one is fetched instead', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });

    await bigPeer.rpc('join', { bootstrap: [status.ticket] });
    await bigPeer.waitForEvent('neighbor', (e) => e.up === true);
    await smallPeer.rpc('join', { bootstrap: [status.ticket] });
    await smallPeer.waitForEvent('neighbor', (e) => e.up === true);

    // The big peer outranks the small one on every sort key (both online,
    // rowCount 999999) — but its announced 50MB can never fit the 10MB
    // cap. Fake hash on purpose: the fetch must not even be attempted.
    await bigPeer.rpc('announce', {
      payload: { hash: 'c'.repeat(64), size: 50 * 1024 * 1024, rowCount: 999999,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 3, name: 'Too Big' },
    });
    // The starvation scenario needs the big peer IN the candidate list
    // before the small one announces — wait for the catalog to hear it.
    await pollUntil(async () => {
      const c = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      return c.peers.find((p) => p.from === bigPeer.endpointId) || null;
    }, { what: 'the big announcement to reach the catalog' });

    const snap = makeSnapshotFile(path.join(dir, 'small.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Small Artist', title: 'Small Song', vec: [1, 0, 0, 0] }],
    });
    const pub = await smallPeer.rpc('publish', { path: snap });
    await smallPeer.rpc('announce', {
      payload: { hash: pub.hash, size: pub.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Small Enough' },
    });

    const shelf = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
      return s.peerDbs.find((p) => p.endpointId === smallPeer.endpointId) || null;
    }, { timeoutMs: 30000, what: 'auto-fetch to download the smaller candidate' });
    assert.equal(shelf.rowCount, 1);

    // The oversized peer is known (catalog) but never downloaded (shelf).
    const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
    assert.equal(s.peerDbs.length, 1);
    assert.ok(!s.peerDbs.some((p) => p.endpointId === bigPeer.endpointId),
      'the over-cap candidate must never land on the shelf');
  });
});

// ── Free-disk floor: the cap protects the budget, the floor protects the
// volume ─────────────────────────────────────────────────────────────────────
// With the floor overridden sky-high (no runner has 8PB free) every
// download must refuse with a clear error — and refuse BEFORE any bytes
// move: gossip still records the peer; only fetches are blocked.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — free-disk floor', () => {
  let server;
  let peer;
  let dir;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: {
        MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750',
        MSTREAM_TEST_DISCOVERY_DISK_FLOOR_BYTES: '9007199254740992',
      },
      extraConfig: { discoveryP2p: { enabled: true, autoFetch: false } },
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-disk-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a fetch is refused when free disk would drop below the floor', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    await peer.rpc('announce', {
      payload: { hash: 'd'.repeat(64), size: 4096, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Floor Peer' },
    });
    await pollUntil(async () => {
      const c = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      return c.peers.find((p) => p.from === peer.endpointId) || null;
    }, { what: 'the announcement to reach the catalog' });

    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/peer-dbs/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointId: peer.endpointId }),
    });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /free disk/i);

    // Refused up front: nothing landed on the shelf.
    const shelf = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
    assert.equal(shelf.peerDbs.length, 0);
  });
});

// ── Shelf rotation: membership cycles instead of freezing ───────────────────
// A FULL shelf (registry pre-crafted with two long-held snapshots, count=2)
// must SWAP its oldest unpinned entry for a newly announced peer — the
// count-capped top-up alone can never do this (room is 0). The registry is
// crafted BEFORE the server boots by pointing extraConfig.storage at a
// pre-seeded state dir, so ensureLoaded's first read sees the aged shelf —
// no load-order races. Rotation policy details are unit-tested
// (test/unit/discovery-peer-rotation.test.mjs); this proves the wiring:
// timer → plan → fetch → evict → ledger, live over real gossip.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — shelf rotation', () => {
  let server;
  let peer;
  let dir;
  let dbDir;
  let tenDaysAgo;
  const AGED_ID = 'a'.repeat(64);
  const PINNED_ID = 'b'.repeat(64);

  const shelfIds = async () => {
    const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
    return s.peerDbs.map((p) => p.endpointId);
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-rot-'));
    const stateDir = path.join(dir, 'state');
    dbDir = path.join(stateDir, 'db');

    // Craft the shelf: two valid snapshot files + a registry that says both
    // have been held for 10 days. One is pinned — rotation must not touch it.
    // The aged entry is deliberately OLD-FORMAT (no firstFetchedAt, no
    // pinned — what every pre-rotation install has on disk): loading must
    // backfill the membership clock from fetchedAt, which is exactly what
    // makes this entry rotation-eligible.
    const agedDb = makeSnapshotFile(path.join(dbDir, 'discovery-peers', 'aged.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Aged Artist', title: 'Old Song', vec: [1, 0, 0, 0] }],
    });
    const pinnedDb = makeSnapshotFile(path.join(dbDir, 'discovery-peers', 'pinned.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Pinned Artist', title: 'Kept Song', vec: [0, 1, 0, 0] }],
    });
    tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.join(dbDir, 'discovery-p2p'), { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'discovery-p2p', 'peer-dbs.json'), JSON.stringify([
      { // old-format: pre-rotation registries carry neither new field
        endpointId: AGED_ID, hash: 'd'.repeat(64), path: agedDb, snapshotSeq: 1,
        modelId: 'test-model', modelVersion: '1', rowCount: 1,
        sizeBytes: fs.statSync(agedDb).size, name: 'Aged Peer',
        fetchedAt: tenDaysAgo,
      },
      {
        endpointId: PINNED_ID, hash: 'e'.repeat(64), path: pinnedDb, snapshotSeq: 1,
        modelId: 'test-model', modelVersion: '1', rowCount: 1,
        sizeBytes: fs.statSync(pinnedDb).size, name: 'Pinned Peer',
        fetchedAt: tenDaysAgo, firstFetchedAt: tenDaysAgo, pinned: true,
      },
    ], null, 2));

    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: {
        MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750',
        MSTREAM_TEST_DISCOVERY_ROTATE_MS: '2000',
      },
      extraConfig: {
        // Wholesale storage override (the helper's spread replaces the
        // object) — every key must be present or state leaks to defaults.
        storage: {
          albumArtDirectory: path.join(stateDir, 'image-cache'),
          dbDirectory: dbDir,
          logsDirectory: path.join(stateDir, 'logs'),
          syncConfigDirectory: path.join(stateDir, 'sync'),
          waveformCacheDirectory: path.join(stateDir, 'waveform-cache'),
        },
        // count=2 with 2 held: the top-up has NO room — only rotation can
        // bring the new peer in. rotationDays=1 << the crafted 10-day age.
        discoveryP2p: { enabled: true, autoFetchCount: 2, rotationDays: 1 },
      },
    });
    peer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a full shelf swaps its oldest unpinned snapshot for a new peer; pinned survives', async () => {
    // The crafted registry is live: both pre-seeded snapshots on the shelf.
    assert.deepEqual((await shelfIds()).sort(), [AGED_ID, PINNED_ID]);

    // The old-format entry was backfilled on load: membership clock from
    // fetchedAt, unpinned by default — the upgrade path every pre-rotation
    // install takes on its first boot with this code.
    const shelf0 = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
    const agedRow = shelf0.peerDbs.find((p) => p.endpointId === AGED_ID);
    assert.equal(agedRow.firstFetchedAt, tenDaysAgo,
      'backfill must derive the membership clock from the old fetchedAt');
    assert.equal(agedRow.pinned, false, 'backfill must default pinned to false');

    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    const snap = makeSnapshotFile(path.join(dir, 'fresh.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Fresh Artist', title: 'New Song', vec: [0, 0, 1, 0] }],
    });
    const pub = await peer.rpc('publish', { path: snap });
    await peer.rpc('announce', {
      payload: { hash: pub.hash, size: pub.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Fresh Peer' },
    });

    // The hourly pass runs every 2s here: swap in the fresh peer, evict the
    // aged unpinned one, keep the shelf at exactly autoFetchCount.
    await pollUntil(async () => {
      const ids = await shelfIds();
      return ids.includes(peer.endpointId) && !ids.includes(AGED_ID) ? ids : null;
    }, { timeoutMs: 30000, what: 'rotation to swap the aged snapshot for the fresh peer' });

    const ids = await shelfIds();
    assert.equal(ids.length, 2, 'rotation must swap, never grow or shrink the shelf');
    assert.ok(ids.includes(PINNED_ID), 'the pinned snapshot must survive rotation');

    // The eviction is remembered (novelty preference for future passes)…
    const ledger = JSON.parse(fs.readFileSync(
      path.join(dbDir, 'discovery-p2p', 'rotation.json'), 'utf8'));
    assert.ok(ledger[AGED_ID], 'rotation must record the eviction in the ledger');
    // …and the evicted snapshot file is actually gone.
    assert.ok(!fs.existsSync(path.join(dbDir, 'discovery-peers', 'aged.db')));
  });

  test('pin route flips rotation immunity live; unknown peer is 404', async () => {
    const pinUrl = `${server.baseUrl}/api/v1/admin/discovery/p2p/peer-dbs/pin`;
    const post = (body) => fetch(pinUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const fetchedRow = async () => {
      const cat = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      return cat.peers.find((p) => p.from === peer.endpointId)?.fetched;
    };

    // The rotation-fetched peer arrives unpinned (automatic download).
    assert.equal((await fetchedRow())?.pinned, false);

    assert.equal((await post({ endpointId: peer.endpointId, pinned: true })).status, 200);
    assert.equal((await fetchedRow())?.pinned, true);
    assert.equal((await post({ endpointId: peer.endpointId, pinned: false })).status, 200);
    assert.equal((await fetchedRow())?.pinned, false);

    assert.equal((await post({ endpointId: 'f'.repeat(64), pinned: true })).status, 404,
      'pinning needs a downloaded snapshot');
  });
});

// ── Rotation, evict-first: the incoming snapshot fits only after the
// eviction ──────────────────────────────────────────────────────────────────
// Registry claims the held snapshot is 6MB under a 10MB cap; the candidate
// announces 5MB. Fetch-first would blow the cap (6+5 > 10 → fetchPeer
// throws → backoff → no swap, ever), so a completed swap is itself proof
// the executor took the evict-then-fetch branch. Announced sizes are what
// the planner trusts; the actual blob is tiny.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — rotation evict-first', () => {
  let server;
  let peer;
  let dir;
  let dbDir;
  const AGED_ID = 'a'.repeat(64);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-rotef-'));
    const stateDir = path.join(dir, 'state');
    dbDir = path.join(stateDir, 'db');
    const agedDb = makeSnapshotFile(path.join(dbDir, 'discovery-peers', 'aged.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Bulky Artist', title: 'Big Old Song', vec: [1, 0, 0, 0] }],
    });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.join(dbDir, 'discovery-p2p'), { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'discovery-p2p', 'peer-dbs.json'), JSON.stringify([{
      endpointId: AGED_ID, hash: 'd'.repeat(64), path: agedDb, snapshotSeq: 1,
      modelId: 'test-model', modelVersion: '1', rowCount: 1,
      // The lie that shapes the plan: 6MB held under a 10MB cap.
      sizeBytes: 6 * 1024 * 1024, name: 'Bulky Aged Peer',
      fetchedAt: tenDaysAgo, firstFetchedAt: tenDaysAgo, pinned: false,
    }], null, 2));

    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: {
        MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750',
        MSTREAM_TEST_DISCOVERY_ROTATE_MS: '1500',
      },
      extraConfig: {
        storage: {
          albumArtDirectory: path.join(stateDir, 'image-cache'),
          dbDirectory: dbDir,
          logsDirectory: path.join(stateDir, 'logs'),
          syncConfigDirectory: path.join(stateDir, 'sync'),
          waveformCacheDirectory: path.join(stateDir, 'waveform-cache'),
        },
        discoveryP2p: {
          enabled: true, autoFetchCount: 1, rotationDays: 1, maxPeerDbStorageMb: 10,
        },
      },
    });
    peer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the swap completes by evicting first when the incoming needs the headroom', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    const snap = makeSnapshotFile(path.join(dir, 'incoming.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Incoming Artist', title: 'New Song', vec: [0, 1, 0, 0] }],
    });
    const pub = await peer.rpc('publish', { path: snap });
    await peer.rpc('announce', {
      // Announced 5MB: over the 4MB current headroom, under the cap once
      // the 6MB evictee is gone.
      payload: { hash: pub.hash, size: 5 * 1024 * 1024, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Oversized Claim' },
    });

    const shelf = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
      const ids = s.peerDbs.map((p) => p.endpointId);
      return ids.includes(peer.endpointId) && !ids.includes(AGED_ID) ? s.peerDbs : null;
    }, { timeoutMs: 30000, what: 'the evict-first rotation swap' });

    assert.equal(shelf.length, 1);
    // The record stores what was actually downloaded, not the announced claim.
    assert.ok(shelf[0].sizeBytes < 1024 * 1024, 'real blob size, not the announced 5MB');
    const ledger = JSON.parse(fs.readFileSync(
      path.join(dbDir, 'discovery-p2p', 'rotation.json'), 'utf8'));
    assert.ok(ledger[AGED_ID], 'the eviction must be in the ledger');
  });
});

// ── Rotation, failed fetch: the evictee is never spent on a download that
// didn't happen ─────────────────────────────────────────────────────────────
// The sky-high free-disk floor makes every fetch refuse instantly, so each
// rotation pass plans the swap, tries the fetch FIRST, fails, and must keep
// the evictee — shelf unchanged, no ledger entry, across several passes.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — rotation keeps the evictee on fetch failure', () => {
  let server;
  let peer;
  let dir;
  let dbDir;
  const AGED_ID = 'a'.repeat(64);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-rotff-'));
    const stateDir = path.join(dir, 'state');
    dbDir = path.join(stateDir, 'db');
    const agedDb = makeSnapshotFile(path.join(dbDir, 'discovery-peers', 'aged.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Sturdy Artist', title: 'Kept Song', vec: [1, 0, 0, 0] }],
    });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.join(dbDir, 'discovery-p2p'), { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'discovery-p2p', 'peer-dbs.json'), JSON.stringify([{
      endpointId: AGED_ID, hash: 'd'.repeat(64), path: agedDb, snapshotSeq: 1,
      modelId: 'test-model', modelVersion: '1', rowCount: 1,
      sizeBytes: fs.statSync(agedDb).size, name: 'Sturdy Aged Peer',
      fetchedAt: tenDaysAgo, firstFetchedAt: tenDaysAgo, pinned: false,
    }], null, 2));

    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      env: {
        MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS: '750',
        MSTREAM_TEST_DISCOVERY_ROTATE_MS: '1500',
        // ~8 exabytes of required headroom: every download refuses up front.
        MSTREAM_TEST_DISCOVERY_DISK_FLOOR_BYTES: '9007199254740992',
      },
      extraConfig: {
        storage: {
          albumArtDirectory: path.join(stateDir, 'image-cache'),
          dbDirectory: dbDir,
          logsDirectory: path.join(stateDir, 'logs'),
          syncConfigDirectory: path.join(stateDir, 'sync'),
          waveformCacheDirectory: path.join(stateDir, 'waveform-cache'),
        },
        discoveryP2p: { enabled: true, autoFetchCount: 1, rotationDays: 1 },
      },
    });
    peer = new RawSidecar(SIDECAR_BIN, path.join(dir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a failed rotation fetch keeps the shelf intact and writes no ledger entry', async () => {
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    await peer.rpc('join', { bootstrap: [status.ticket] });
    await peer.waitForEvent('neighbor', (e) => e.up === true);

    const snap = makeSnapshotFile(path.join(dir, 'unreachable.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Blocked Artist', title: 'Never Arrives', vec: [0, 1, 0, 0] }],
    });
    const pub = await peer.rpc('publish', { path: snap });
    await peer.rpc('announce', {
      payload: { hash: pub.hash, size: pub.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Unfetchable Peer' },
    });
    // Candidate is definitely on the table before we watch for (non-)swaps.
    await pollUntil(async () => {
      const c = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/catalog`)).json();
      return c.peers.find((p) => p.from === peer.endpointId) || null;
    }, { what: 'the candidate announcement to reach the catalog' });

    // ≥4 rotation passes at 1.5s: the first one attempts the fetch and
    // fails on the floor; failure backoff quiets the rest. Through all of
    // it the evictee must stay put.
    await new Promise((resolve) => setTimeout(resolve, 7000));

    const s = await (await fetch(`${server.baseUrl}/api/v1/discovery/p2p/peer-dbs`)).json();
    assert.deepEqual(s.peerDbs.map((p) => p.endpointId), [AGED_ID],
      'the evictee must never be spent on a download that did not happen');
    assert.ok(!fs.existsSync(path.join(dbDir, 'discovery-p2p', 'rotation.json')),
      'no eviction happened, so no ledger entry may exist');
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
        // through the baked seed list. Re-enabling it here is safe ONLY
        // because the helper also spawns every server with
        // MSTREAM_TEST_BAKED_SEEDS='[]' — resolveBootstrap unions baked +
        // fetched, so without that env guard this suite would join the real
        // seeds alongside the stub and bridge its fake announcement into
        // real users' catalogs (the 2026-07-27 "Stranger" ghost peers).
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

    // Hermeticity tripwire: this island is seedNode + peerNode and nothing
    // else, so the server can never have more than 2 mesh neighbors. If the
    // baked-seeds env guard regresses, resolveBootstrap hands it the real
    // seed-au-1/seed-eu-1 tickets too and the neighbor set outgrows the
    // island — the exact path that leaked "Stranger" test announcements
    // into real catalogs.
    assert.ok(status.neighbors <= 2,
      `server meshed beyond the test island (${status.neighbors} neighbors) — baked-seeds guard regressed?`);
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
    // What "works" means depends on whether a sidecar binary exists here.
    //
    // WITH one, the sidecar must actually come up and be joined-or-joinable.
    // WITHOUT one there is nothing to come up, and that is now the norm in
    // CI: the binaries left git when the sidecar moved to its own repo
    // (fetch-on-first-use, pinned per release), and startServer deliberately
    // pins MSTREAM_SIDECAR_BASE to a dead port so no suite can pull one
    // mid-test. Waiting on `running` in that case can only ever time out —
    // which is exactly what it did on every OS once the binaries left, while
    // still passing for anyone with a local dev build in p2p-sidecar/target.
    //
    // Either way the invariant this suite exists for is the same, and it is
    // the weaker one: an unreachable community-seed list must not wedge the
    // boot path. So require `running` only when it is achievable, and always
    // require the status route to answer with the feature enabled.
    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      if (!SIDECAR_BIN) { return s; }
      return s.running ? s : null;
    }, {
      timeoutMs: 30000,
      what: SIDECAR_BIN ? 'sidecar up despite dead seed URL' : 'p2p status despite dead seed URL',
    });
    assert.equal(status.enabled, true);
  });
});

// ── N3: seeder beacons + swarm failover ─────────────────────────────────────
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — seeders + swarm (N3)', () => {
  let server;
  let p1;
  let p2;
  let tmpDir;
  // The chicken-and-egg of protocol work: whatever sidecar binary this
  // machine has (a fetched pinned release, an operator-placed prebuilt, or
  // a nested-clone cargo build — see bin/p2p-sidecar/README.md) may predate
  // a protocol addition under test. Probe the capability in before() and
  // skip with a reason — the server does the same probe in production (the
  // sidecar repo's README calls this the compatibility contract).
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

// ── Runtime enable/disable — the admin-UI onboarding path ───────────────────
// A factory-defaults server (no discovery config at all) must be able to
// join the network through ONE admin call and leave it the same way, no
// reboot anywhere. The route runs the same stack boot does; the helper's
// hermetic seed keys (dead list URL + useCommunitySeeds:false) apply to the
// runtime path exactly like the boot path, so this can never touch the
// real network.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — runtime enable/disable', () => {
  let server;
  const api = (p) => `${server.baseUrl}/api/v1/admin/discovery/p2p/${p}`;
  const post = (route, body) => fetch(api(route), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(server.tmpDir, 'config.json'), 'utf8'));

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      // Factory defaults: NO discoveryP2p.enabled, NO collectDiscoveryData.
      // test-fake model so a forced-on collection pass never downloads
      // real weights if it runs during the test window.
      extraConfig: { scanOptions: { discoveryModel: 'test-fake' } },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('enable: one call forces collection on, persists both flags, and starts the stack', async () => {
    // Precondition: everything off, catalog gated.
    assert.equal((await fetch(api('catalog'))).status, 403);
    const before = await (await fetch(`${server.baseUrl}/api/v1/ping`)).json();
    assert.equal(before.discoveryP2p, false);
    assert.equal(before.discovery, false);

    const r = await post('enabled', { enabled: true });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.enabled, true);
    assert.equal(body.collectForced, true, 'collection was off — enabling the network must force it on');

    // Both flags persisted to the config FILE (not just in-memory) — a
    // reboot must come back in the same state.
    const conf = readConfig();
    assert.equal(conf.discoveryP2p.enabled, true);
    assert.equal(conf.scanOptions.collectDiscoveryData, true);
    // The forced enable initializes the separate discovery DB immediately.
    assert.ok(fs.existsSync(path.join(server.tmpDir, 'db', 'discovery.db')));

    // The stack is actually up: sidecar running with a dialable ticket.
    const status = await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.running && s.ticket ? s : null;
    }, { timeoutMs: 30000, what: 'runtime-enabled sidecar to come up' });
    assert.match(status.endpointId, /^[0-9a-f]{64}$/);

    // Every live gate flipped without a reboot.
    assert.equal((await fetch(api('catalog'))).status, 200);
    const ping = await (await fetch(`${server.baseUrl}/api/v1/ping`)).json();
    assert.equal(ping.discoveryP2p, true);
    assert.equal(ping.discovery, true, 'forced collection must reveal the Discover panel too');
  });

  test('name edits save live and validate like the description', async () => {
    const r = await post('name', { name: '  Runtime Lab  ' });
    assert.equal(r.status, 200);
    const status = await (await fetch(api('status'))).json();
    assert.equal(status.serverName, 'Runtime Lab', 'saved trimmed');

    for (const name of ['evil|pipe', '', 'x'.repeat(65), '   ']) {
      const bad = await post('name', { name });
      assert.equal(bad.status, 400, `${JSON.stringify(name)} should be 400`);
    }
    // Rejections must not have clobbered the saved name.
    assert.equal((await (await fetch(api('status'))).json()).serverName, 'Runtime Lab');
  });

  test('max-storage saves live, persists, validates, and the catalog reports the new cap', async () => {
    const r = await post('max-storage', { maxPeerDbStorageMb: 1234 });
    assert.equal(r.status, 200);

    // Status + catalog both reflect it immediately (the fetch paths read
    // config live, so this is also the enforcement value from now on).
    const status = await (await fetch(api('status'))).json();
    assert.equal(status.maxPeerDbStorageMb, 1234);
    const cat = await (await fetch(api('catalog'))).json();
    assert.equal(cat.storage.capBytes, 1234 * 1024 * 1024);
    // And it survives a reboot: persisted to the config file.
    assert.equal(readConfig().discoveryP2p.maxPeerDbStorageMb, 1234);

    for (const bad of [9, 100001, 12.5, 'many', null]) {
      const rej = await post('max-storage', { maxPeerDbStorageMb: bad });
      assert.equal(rej.status, 400, `${JSON.stringify(bad)} should be 400`);
    }
    assert.equal((await (await fetch(api('status'))).json()).maxPeerDbStorageMb, 1234,
      'rejections must not clobber the saved cap');
  });

  test('auto-fetch-count saves live, persists, and validates (0 = paused is legal)', async () => {
    const r = await post('auto-fetch-count', { autoFetchCount: 11 });
    assert.equal(r.status, 200);

    // Status reflects it immediately (reconcile reads the config live, so
    // this is also the enforcement value from the next pass on) — and it
    // survives a reboot: persisted to the config file.
    const status = await (await fetch(api('status'))).json();
    assert.equal(status.autoFetchCount, 11);
    assert.equal(readConfig().discoveryP2p.autoFetchCount, 11);

    // 0 is a real setting (pause automatic downloads), not a rejection.
    assert.equal((await post('auto-fetch-count', { autoFetchCount: 0 })).status, 200);
    assert.equal((await (await fetch(api('status'))).json()).autoFetchCount, 0);

    for (const bad of [-1, 51, 2.5, 'six', null]) {
      const rej = await post('auto-fetch-count', { autoFetchCount: bad });
      assert.equal(rej.status, 400, `${JSON.stringify(bad)} should be 400`);
    }
    assert.equal((await (await fetch(api('status'))).json()).autoFetchCount, 0,
      'rejections must not clobber the saved value');
  });

  test('rotation saves live, persists, and validates (0 = off is legal)', async () => {
    const r = await post('rotation', { rotationDays: 21 });
    assert.equal(r.status, 200);

    const status = await (await fetch(api('status'))).json();
    assert.equal(status.rotationDays, 21);
    assert.equal(readConfig().discoveryP2p.rotationDays, 21);

    // 0 turns rotation off — a real setting, not a rejection.
    assert.equal((await post('rotation', { rotationDays: 0 })).status, 200);
    assert.equal((await (await fetch(api('status'))).json()).rotationDays, 0);

    for (const bad of [-1, 3651, 1.5, 'week', null]) {
      const rej = await post('rotation', { rotationDays: bad });
      assert.equal(rej.status, 400, `${JSON.stringify(bad)} should be 400`);
    }
    assert.equal((await (await fetch(api('status'))).json()).rotationDays, 0,
      'rejections must not clobber the saved value');
  });

  test('disable: stack stops, gates close, collection deliberately stays on', async () => {
    const r = await post('enabled', { enabled: false });
    assert.equal(r.status, 200);

    await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.running === false ? s : null;
    }, { timeoutMs: 15000, what: 'sidecar to stop' });

    assert.equal((await fetch(api('catalog'))).status, 403);
    const ping = await (await fetch(`${server.baseUrl}/api/v1/ping`)).json();
    assert.equal(ping.discoveryP2p, false);

    const conf = readConfig();
    assert.equal(conf.discoveryP2p.enabled, false);
    assert.equal(conf.scanOptions.collectDiscoveryData, true,
      'leaving the network must not turn off local discovery features');
    assert.equal(ping.discovery, true);
  });

  test('re-enable: the stack survives a full stop/start cycle', async () => {
    const r = await post('enabled', { enabled: true });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).collectForced, false, 'collection was already on this time');

    const status = await pollUntil(async () => {
      const s = await (await fetch(api('status'))).json();
      return s.running && s.ticket ? s : null;
    }, { timeoutMs: 30000, what: 'sidecar to come back up' });
    assert.match(status.endpointId, /^[0-9a-f]{64}$/);
    assert.equal((await fetch(api('catalog'))).status, 200);

    // Idempotence: enabling while enabled is a clean no-op.
    assert.equal((await post('enabled', { enabled: true })).status, 200);
  });
});

// ── Catalog listing: incompatible-model peers hide by default ────────────────
// The "Stranger" filter: test networks' throwaway announcements (name
// "Stranger", modelId test-model — the 2026-07-27 ghosts, and any test agent
// still announcing) carry a model that cannot power this server's similar
// search, so the catalog listing hides them by default instead of cluttering
// every real panel. Held peers always show (they occupy the operator's
// shelf), ?includeIncompatible=1 shows everything (the blocklist needs
// eyes on the full catalog), and — covered by the suites above, where no
// local model is ever established — unknown compatibility hides nothing.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — catalog hides incompatible-model peers', () => {
  let server;
  let dir;
  let musicDir;
  let strangerNode;
  let friendNode;

  // One embed-eligible (≥30s) track, so the collect pass actually runs and
  // establishes the local model — the shared fixtures are all short tones,
  // which leaves embedding_model_id unset forever (the zero-touch suite's
  // writeSineWav precedent; the helper is scoped there, so a local copy).
  function writeLongTone(filePath, seconds) {
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
  const catalogOf = async (all) => {
    const r = await fetch(
      `${server.baseUrl}/api/v1/admin/discovery/p2p/catalog${all ? '?includeIncompatible=1' : ''}`);
    return r.json();
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-compat-'));
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-compat-lib-'));
    writeLongTone(path.join(musicDir, 'long-tone.wav'), 35);
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: true, // the scan's collect pass establishes the local model
      extraFolders: { compatlib: musicDir },
      extraConfig: {
        discoveryP2p: { enabled: true, serverName: 'Compat Filter Server' },
        scanOptions: { collectDiscoveryData: true, discoveryModel: 'test-fake' },
      },
    });
    strangerNode = new RawSidecar(SIDECAR_BIN, path.join(dir, 'stranger'));
    friendNode = new RawSidecar(SIDECAR_BIN, path.join(dir, 'friend'));
    await strangerNode.ready;
    await friendNode.ready;

    const status = await pollUntil(async () => {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
      return s.running && s.ticket ? s : null;
    }, { what: 'server sidecar to boot' });
    for (const node of [strangerNode, friendNode]) {
      await node.rpc('join', { bootstrap: [status.ticket] });
      await node.waitForEvent('neighbor', (e) => e.up === true);
    }

    // The Stranger publishes a REAL (fetchable, valid) snapshot so the
    // held-peers-always-show rule can be proven end to end below.
    const snap = makeSnapshotFile(path.join(dir, 'stranger.db'), {
      modelId: 'test-model',
      tracks: [{ artist: 'Ghost', title: 'Ghost Song', vec: [1, 0, 0, 0] }],
    });
    const pub = await strangerNode.rpc('publish', { path: snap });
    await strangerNode.rpc('announce', {
      payload: { hash: pub.hash, size: pub.size, rowCount: 1,
        modelId: 'test-model', modelVersion: '1', snapshotSeq: 1, name: 'Stranger' },
    });

    // The embed pass establishes the local model well after waitForScan
    // returns (enrichment drains in the background — the zero-touch suite's
    // 90s precedent). Read the ESTABLISHED id from the route rather than
    // assuming what test-fake stores, then announce the compatible peer
    // with exactly that id — the compatibility contract under test, free of
    // model-naming assumptions.
    const localModelId = await pollUntil(async () => (await catalogOf(true)).localModelId,
      { timeoutMs: 90000, what: 'the embed pass to establish the local model' });
    assert.notEqual(localModelId, 'test-model', 'the Stranger must be genuinely incompatible');
    await friendNode.rpc('announce', {
      payload: { hash: 'f'.repeat(64), size: 4096, rowCount: 9,
        modelId: localModelId, modelVersion: '1', snapshotSeq: 1, name: 'Friendly Peer' },
    });

    // Both announcements ingested — checked through the unfiltered view so
    // the wait cannot depend on the filter under test.
    await pollUntil(async () => {
      const names = (await catalogOf(true)).peers.map((p) => p.payload.name);
      return names.includes('Stranger') && names.includes('Friendly Peer') ? true : null;
    }, { what: 'both announcements in the catalog' });
  });

  after(async () => {
    if (strangerNode) { await strangerNode.stop(); }
    if (friendNode) { await friendNode.stop(); }
    if (server) { await server.stop(); }
    if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    if (musicDir) { fs.rmSync(musicDir, { recursive: true, force: true }); }
  });

  test('the default listing hides the incompatible peer and counts it', async () => {
    const c = await catalogOf(false);
    const names = c.peers.map((p) => p.payload.name);
    assert.ok(names.includes('Friendly Peer'), 'the compatible peer is listed');
    assert.ok(!names.includes('Stranger'), 'the incompatible peer is hidden');
    assert.equal(c.hiddenIncompatible, 1, 'and the panel is told how many it is not seeing');
  });

  test('?includeIncompatible=1 shows everything, correctly labeled', async () => {
    const c = await catalogOf(true);
    const stranger = c.peers.find((p) => p.payload.name === 'Stranger');
    const friend = c.peers.find((p) => p.payload.name === 'Friendly Peer');
    assert.ok(stranger, 'the incompatible peer is visible on request');
    assert.equal(stranger.compatible, false);
    assert.equal(friend.compatible, true);
    assert.equal(c.hiddenIncompatible, 0, 'nothing hidden in the full view');
  });

  test('a HELD incompatible peer always shows — hiding owned shelf state would mislead', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/peer-dbs/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpointId: strangerNode.endpointId }),
    });
    assert.equal(r.status, 200, `manual fetch of the Stranger snapshot failed: ${await r.text()}`);

    const c = await catalogOf(false);
    const stranger = c.peers.find((p) => p.payload.name === 'Stranger');
    assert.ok(stranger, 'held: visible despite the incompatible model');
    assert.ok(stranger.fetched, 'and marked as on the shelf');
    assert.equal(c.hiddenIncompatible, 0, 'nothing left hidden once the only incompatible peer is held');
  });
});
