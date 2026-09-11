/**
 * Stats API v2 — federated plays completed from the peer (src/stats/enrich.js),
 * end to end: a play of a peer's track arrives with a thin snapshot, the
 * server asks the peer's metadata/batch route after the commit, the row
 * renders with the peer's strings and is re-keyed onto the audio hash (its
 * counters move), a track the peer does not know is settled as it came, a
 * peer that answers 500 leaves its row for the admin/daily pass, and local
 * plays never trigger a call.
 *
 * The peer is a fake HTTP server in this process; MSTREAM_TEST_FED_ENRICH_ENDPOINT
 * points the server's enrichment call at it — the same pattern as the Last.fm
 * forwarding test.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
async function waitForReady(baseUrl, timeoutMs = 90_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${baseUrl}/api/`); if (r.status < 500) return; } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`, { cause: lastErr });
}
async function waitFor(pred, what, timeoutMs = 15_000) {
  const start = Date.now();
  let last;
  while (!(last = await pred())) {
    if (Date.now() - start > timeoutMs) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(100);
  }
  return last;
}
async function boot(tmpDir, musicDir, env = {}) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1',
    dlna: { mode: 'disabled' },
    folders: { testlib: { root: musicDir } },
    storage: { albumArtDirectory: path.join(tmpDir, 'image-cache'), dbDirectory: path.join(tmpDir, 'db'), logsDirectory: path.join(tmpDir, 'logs') },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
    stats: { playThresholdMs: 30000, playThresholdFraction: 0.5, retentionMonths: 0 },
  };
  for (const dir of Object.values(config.storage)) await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test', ...env } });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForReady(baseUrl); } catch (err) { try { proc.kill('SIGKILL'); } catch { /* gone */ } throw err; }
  return { proc, baseUrl };
}
async function kill(proc) { if (proc.exitCode == null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); } }

const H = { 'Content-Type': 'application/json' };
async function call(baseUrl, method, route, body, headers = {}) {
  const r = await fetch(`${baseUrl}${route}`, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json ?? text, text };
}

// The fake peer: answers POST /api/v1/db/metadata/batch from KNOWN, records
// every call, and can be taken down (500) for the failure case.
const KNOWN = {
  'music/peer.flac': { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', duration: 240.4, hash: 'pfh1', 'audio-hash': 'pah1', 'album-art': 'art.jpg' },
  'music/fail.flac': { title: 'Fail Song', artist: 'Peer Artist', duration: 100, hash: 'pfh3', 'audio-hash': 'pah3' },
};
function startFakePeer() {
  const calls = [];
  const state = { down: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST' || req.url !== '/api/v1/db/metadata/batch') { res.statusCode = 404; res.end('{}'); return; }
      const paths = JSON.parse(body);
      calls.push({ paths, key: req.headers['x-federation-key'] });
      if (state.down) { res.statusCode = 500; res.end('{}'); return; }
      res.end(JSON.stringify(Object.fromEntries(paths.map((p) => [p, { filepath: p, metadata: KNOWN[p] ?? null }]))));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ calls, state, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist')").run().lastInsertRowid);
  db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, file_hash, audio_hash, duration, modified, scan_id)
              VALUES ('Song A.flac', ?, 'Song A', ?, 'fhA', 'ahA', 200, 1, 'seed')`).run(lib, aid);
  const peer = Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
  db.close();
  return { peer };
}
const snapshotOf = (dbPath, id) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { const r = db.prepare('SELECT snapshot, track_hash FROM play_events WHERE event_id = ?').get(id); return { ...JSON.parse(r.snapshot || '{}'), _hash: r.track_hash }; }
  finally { db.close(); }
};
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

describe('Stats API v2 — peer snapshot enrichment', () => {
  let tmpDir, server, peer, fake, dbPath;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-stats-enrich-'));
    const musicDir = path.join(tmpDir, 'music'); await fs.mkdir(musicDir);
    fake = await startFakePeer();
    server = await boot(tmpDir, musicDir);
    await kill(server.proc);
    dbPath = path.join(tmpDir, 'db', 'mstream.db');
    ({ peer } = seed(dbPath));
    server = await boot(tmpDir, musicDir, { MSTREAM_TEST_FED_ENRICH_ENDPOINT: `127.0.0.1:${fake.port}` });
  });
  after(async () => {
    if (server) await kill(server.proc);
    if (fake) await fake.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const postPlays = (plays) => call(server.baseUrl, 'POST', '/api/v1/stats/plays', { client: { name: 'test', version: '1' }, plays });
  const adminStats = async () => (await call(server.baseUrl, 'GET', '/api/v1/admin/stats')).body;

  test('a thin federated play is completed from the peer and re-keyed onto the audio hash', async () => {
    const r = await postPlays([{ id: 'p1', filePath: 'music/peer.flac', peerId: peer, track: { title: 'peer.flac', hash: 'pfh1' },
      startedAt: ago(600), playedMs: 200_000, outcome: 'completed', source: 'manual' }]);
    assert.deepEqual(r.body.accepted, ['p1'], r.text);
    const h = await waitFor(async () => {
      const x = await call(server.baseUrl, 'GET', '/api/v1/stats/history?track=pah1');
      return x.body.items?.[0]?.id === 'p1' ? x.body : null;
    }, 'the play to turn up under the audio hash');
    const m = h.items[0].track.metadata;
    assert.deepEqual([m.title, m.artist, m.album, m.duration, m['album-art'], m.hash], ['Peer Song', 'Peer Artist', 'Peer Album', 240.4, 'art.jpg', 'pah1']);
    assert.equal(h.items[0].origin, 'peer');
    assert.equal(h.items[0].peerName, 'Bob');
    assert.deepEqual(fake.calls, [{ paths: ['music/peer.flac'], key: 'fedk_bob' }]);
    const snap = snapshotOf(dbPath, 'p1');
    assert.equal(snap._hash, 'pah1');
    assert.ok(snap.enrichedAt > 0);
    assert.equal(snap.durationMs, 240400);
    // the counters followed the key: nothing left under the file hash
    const c = await call(server.baseUrl, 'POST', '/api/v1/stats/tracks', { hashes: ['pah1', 'pfh1'] });
    assert.deepEqual(c.body.items.map((i) => [i.hash, i.plays]), [['pah1', 1]]);
    const s = await adminStats();
    assert.deepEqual([s.enrichment.enriched, s.enrichment.rekeyed, s.log.peerEvents, s.log.thinPeerEvents], [1, 1, 1, 0]);
  });

  test('a track the peer does not know is settled as it came, and not asked about again', async () => {
    const r = await postPlays([{ id: 'p2', filePath: 'music/gone.flac', peerId: peer, track: { title: 'gone.flac', hash: 'pfh2' },
      startedAt: ago(500), playedMs: 100_000, outcome: 'completed', source: 'manual' }]);
    assert.deepEqual(r.body.accepted, ['p2']);
    const s = await waitFor(async () => { const x = await adminStats(); return x.enrichment.unknown === 1 ? x : null; }, 'the unknown answer');
    assert.equal(s.log.thinPeerEvents, 0);
    const snap = snapshotOf(dbPath, 'p2');
    assert.equal(snap.title, 'gone.flac');
    assert.equal(snap._hash, 'pfh2');
    assert.ok(snap.enrichedAt > 0);
    const before = fake.calls.length;
    const pass = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/enrich', {});
    assert.equal(pass.body.queued, 0, 'settled rows are not part of the backfill');
    assert.equal(fake.calls.length, before);
  });

  test('a peer that answers 500 leaves its row thin; the admin pass completes it once the peer is back', async () => {
    fake.state.down = true;
    const r = await postPlays([{ id: 'p3', filePath: 'music/fail.flac', peerId: peer, track: { title: 'fail.flac', hash: 'pfh3' },
      startedAt: ago(400), playedMs: 90_000, outcome: 'completed', source: 'manual' }]);
    assert.deepEqual(r.body.accepted, ['p3']);
    const s = await waitFor(async () => { const x = await adminStats(); return x.enrichment.failed >= 1 ? x : null; }, 'the failed call');
    assert.match(s.enrichment.lastError, /Bob: http 500/);
    assert.equal(s.log.thinPeerEvents, 1);
    assert.equal(snapshotOf(dbPath, 'p3').enrichedAt, undefined);
    assert.equal(snapshotOf(dbPath, 'p3')._hash, 'pfh3');

    fake.state.down = false;
    const pass = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/enrich', {});
    assert.equal(pass.status, 200, pass.text);
    assert.equal(pass.body.queued, 1);
    const done = await waitFor(async () => { const x = await adminStats(); return x.log.thinPeerEvents === 0 ? x : null; }, 'the backfill');
    assert.equal(done.enrichment.enriched, 2);
    assert.equal(snapshotOf(dbPath, 'p3').title, 'Fail Song');
    assert.equal(snapshotOf(dbPath, 'p3')._hash, 'pah3');
    const h = await call(server.baseUrl, 'GET', '/api/v1/stats/history?track=pah3');
    assert.deepEqual(h.body.items.map((i) => [i.id, i.track.metadata.title]), [['p3', 'Fail Song']]);
  });

  test('a local play never asks a peer', async () => {
    const before = fake.calls.length;
    const r = await postPlays([{ id: 'l1', filePath: 'testlib/Song A.flac', startedAt: ago(300), playedMs: 150_000, outcome: 'completed', source: 'manual' }]);
    assert.deepEqual(r.body.accepted, ['l1']);
    await sleep(500);
    assert.equal(fake.calls.length, before);
    const s = await adminStats();
    assert.deepEqual([s.log.total, s.log.peerEvents, s.log.thinPeerEvents], [4, 3, 0]);
  });
});
