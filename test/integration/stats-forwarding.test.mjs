/**
 * Stats API v2 — Last.fm forwarding and the now-playing routes, end to end.
 *
 * A fake Last.fm runs in this process (it answers the mobile-session login
 * and records every write); the server is pointed at it through
 * MSTREAM_TEST_LASTFM_ENDPOINT. The operator's account is the public-mode
 * sentinel, given Last.fm credentials straight in the users row between two
 * boots (scrobbler.js pre-loads them at boot). Pins:
 *   - a counted play is scrobbled with ITS OWN start time (epoch seconds),
 *     the library's artist / title / album and length, on one session;
 *   - an uncounted skip, a play older than Last.fm's 14-day window (accepted
 *     by ingest — retentionMonths is 0 here) and a track shorter than 30 s
 *     are stored but never sent; a peer play is sent with its snapshot;
 *   - a replay (all duplicates) sends nothing again;
 *   - now-playing: per-session entries with a TTL, listed back, forwarded as
 *     a Last.fm notice; unknown track / peer answered, not stored; the
 *     route is off the federation allowlist.
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
import { isFederationRouteAllowed } from '../../src/api/federation-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

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
  while (!pred()) {
    if (Date.now() - start > timeoutMs) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(50);
  }
}

// The fake Last.fm: every request is recorded as { method, params }.
function startFakeLastfm() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        calls.push({ method: 'GET', params: Object.fromEntries(new URL(req.url, 'http://fake').searchParams) });
        res.end(JSON.stringify({ session: { name: 'lfm-user', key: 'sk-test', subscriber: 0 } }));
        return;
      }
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: 'POST', params });
      res.end(JSON.stringify(params.method === 'track.scrobble'
        ? { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }
        : { nowplaying: {} }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    calls,
    scrobbles: () => calls.filter((c) => c.params.method === 'track.scrobble'),
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  })));
}

async function boot(tmpDir, musicDir, lastfmPort) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1',
    dlna: { mode: 'disabled' },
    folders: { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory: path.join(tmpDir, 'image-cache'),
      dbDirectory: path.join(tmpDir, 'db'),
      logsDirectory: path.join(tmpDir, 'logs'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
    stats: { playThresholdMs: 30000, playThresholdFraction: 0.5, retentionMonths: 0 },
  };
  for (const dir of Object.values(config.storage)) await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', MSTREAM_TEST_LASTFM_ENDPOINT: `127.0.0.1:${lastfmPort}` },
  });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForReady(baseUrl); } catch (err) { try { proc.kill('SIGKILL'); } catch { /* gone */ } throw err; }
  return { proc, baseUrl };
}
async function kill(proc) { if (proc.exitCode == null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); } }

async function call(baseUrl, method, route, body) {
  const r = await fetch(`${baseUrl}${route}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// Two real tracks, one 20-second ident, a federation peer, and the sentinel's
// Last.fm link.
function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Radiohead')").run().lastInsertRowid);
  const alid = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('OK Computer', ?, 1997)").run(aid).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, file_hash, audio_hash, duration, modified, scan_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'seed')`);
  ins.run('Let Down.flac', lib, 'Let Down', aid, alid, 'fhA', 'ahA', 299);
  ins.run('Karma Police.flac', lib, 'Karma Police', aid, alid, 'fhB', 'ahB', 264);
  ins.run('Ident.mp3', lib, 'Ident', aid, null, 'fhI', 'ahI', 20);
  const peerId = Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
  const linked = db.prepare("UPDATE users SET lastfm_user = 'lfm-user', lastfm_password = 'lfm-pass' WHERE is_anonymous_sentinel = 1").run().changes;
  assert.equal(linked, 1, 'the public-mode sentinel exists and now has a Last.fm link');
  db.close();
  return { peerId };
}

const play = (over = {}) => ({
  id: 'p1', filePath: 'testlib/Let Down.flac', playedMs: 240000, outcome: 'completed', source: 'manual', ...over,
});

describe('Last.fm forwarding + now-playing', () => {
  let tmpDir, server, fake, peerId;
  before(async () => {
    fake = await startFakeLastfm();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fwd-'));
    const musicDir = path.join(tmpDir, 'music'); await fs.mkdir(musicDir, { recursive: true });
    server = await boot(tmpDir, musicDir, fake.port);
    await kill(server.proc); await sleep(200);
    ({ peerId } = seed(path.join(tmpDir, 'db', 'mstream.db')));
    server = await boot(tmpDir, musicDir, fake.port);
  });
  after(async () => {
    if (server?.proc) await kill(server.proc);
    if (fake) await fake.close();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('counted plays are scrobbled with their own start time; skips, old plays and short tracks are not; a replay sends nothing', async () => {
    const now = Date.now();
    const t1 = now - 3_600_000;
    const t4 = now - 7_200_000;
    const plays = [
      play({ id: 'p1', startedAt: iso(t1) }),
      play({ id: 'p2', filePath: 'testlib/Karma Police.flac', playedMs: 8000, outcome: 'skipped', startedAt: iso(now - 3_000_000) }),
      play({ id: 'p3', startedAt: iso(now - 20 * 86_400_000) }),
      play({ id: 'p4', peerId, filePath: 'remote/song.mp3', playedMs: 150000, startedAt: iso(t4),
        track: { title: 'Remote Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'ph1', durationMs: 200000 } }),
      play({ id: 'p5', filePath: 'testlib/Ident.mp3', playedMs: 20000, startedAt: iso(now - 600_000) }),
    ];
    const r = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', { client: { name: 'test', version: '1' }, plays });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body.accepted, ['p1', 'p2', 'p3', 'p4', 'p5'], 'ingest keeps all five — forwarding is a separate judgement');

    await waitFor(() => fake.scrobbles().length >= 2, 'two scrobbles');
    await sleep(800);   // room for anything extra to arrive
    const byTrack = Object.fromEntries(fake.scrobbles().map((c) => [c.params.track, c.params]));
    assert.deepEqual(Object.keys(byTrack).sort(), ['Let Down', 'Remote Song'],
      'the skip, the 20-day-old play and the 20-second ident never reach Last.fm');

    assert.equal(byTrack['Let Down'].timestamp, String(Math.floor(t1 / 1000)), "the play's own start, not the request time");
    assert.equal(byTrack['Let Down'].artist, 'Radiohead');
    assert.equal(byTrack['Let Down'].album, 'OK Computer');
    assert.equal(byTrack['Let Down'].duration, '299');
    assert.equal(byTrack['Let Down'].sk, 'sk-test');
    assert.equal(byTrack['Let Down'].format, 'json');
    assert.equal(byTrack['Remote Song'].timestamp, String(Math.floor(t4 / 1000)));
    assert.equal(byTrack['Remote Song'].artist, 'Peer Artist', 'a peer play carries its snapshot');
    assert.equal(byTrack['Remote Song'].album, 'Peer Album');
    assert.equal(byTrack['Remote Song'].duration, '200');
    assert.equal(fake.calls.filter((c) => c.method === 'GET').length, 1, 'one login, one session');
    assert.equal(fake.calls[0].params.username, 'lfm-user', "the sentinel's linked account");

    const again = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', { client: { name: 'test', version: '1' }, plays });
    assert.equal(again.body.accepted.length, 0);
    assert.equal(again.body.duplicates.length, 5);
    await sleep(800);
    assert.equal(fake.scrobbles().length, 2, 'a replay is never scrobbled twice');
  });

  test('now-playing: per-session entries with a TTL, listed back, forwarded as a notice; unknowns answered, not stored', async () => {
    const NP = '/api/v1/stats/now-playing';
    const mark = fake.calls.length;
    const r = await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Let Down.flac', sessionId: 's1' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body.accepted, true);
    assert.ok(Date.parse(r.body.expiresAt) > Date.now() + 9 * 60_000, 'ten-minute TTL');

    const g = await call(server.baseUrl, 'GET', NP);
    assert.equal(g.body.entries.length, 1);
    const e = g.body.entries[0];
    assert.equal(e.sessionId, 's1');
    assert.equal(e.filePath, 'testlib/Let Down.flac');
    assert.equal(e.peerId, null);
    assert.deepEqual(e.track, { title: 'Let Down', artist: 'Radiohead', album: 'OK Computer', durationMs: 299000, hash: 'ahA' });
    assert.ok(e.since && e.expiresAt);
    assert.equal(e.expiresMs, undefined, 'the internal deadline stays internal');

    await waitFor(() => fake.calls.slice(mark).some((c) => c.params.method === 'track.updateNowPlaying'), 'the now-playing notice');
    const np = fake.calls.slice(mark).find((c) => c.params.method === 'track.updateNowPlaying').params;
    assert.equal(np.artist, 'Radiohead');
    assert.equal(np.track, 'Let Down');
    assert.equal(np.album, 'OK Computer');
    assert.equal(np.duration, '299');

    // A second player is a second entry; the first player re-posting replaces its own.
    await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Karma Police.flac', sessionId: 's2' });
    await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Karma Police.flac', sessionId: 's1' });
    const g2 = await call(server.baseUrl, 'GET', NP);
    assert.deepEqual(g2.body.entries.map((x) => [x.sessionId, x.track.title]).sort(), [['s1', 'Karma Police'], ['s2', 'Karma Police']]);

    // Unknowns are answered, never stored; a peer needs its snapshot.
    assert.deepEqual((await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Nope.flac', sessionId: 's9' })).body,
      { accepted: false, reason: 'unknown-track' });
    assert.deepEqual((await call(server.baseUrl, 'POST', NP, { filePath: 'remote/x.mp3', peerId: 999, sessionId: 's9', track: { title: 'x' } })).body,
      { accepted: false, reason: 'unknown-peer' });
    assert.deepEqual((await call(server.baseUrl, 'POST', NP, { filePath: 'remote/x.mp3', peerId, sessionId: 's9' })).body,
      { accepted: false, reason: 'invalid' });
    const remote = await call(server.baseUrl, 'POST', NP, { filePath: 'remote/x.mp3', peerId, sessionId: 's3', track: { title: 'Remote', artist: 'Peer' } });
    assert.equal(remote.body.accepted, true);
    const g3 = await call(server.baseUrl, 'GET', NP);
    assert.equal(g3.body.entries.length, 3, 's9 was never stored; s3 was');
    assert.deepEqual(g3.body.entries.find((x) => x.sessionId === 's3').track,
      { title: 'Remote', artist: 'Peer', album: null, durationMs: null, hash: null });

    // Validation: the path and the session id are required, unknown keys refused.
    assert.equal((await call(server.baseUrl, 'POST', NP, { sessionId: 's1' })).status, 400);
    assert.equal((await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Let Down.flac' })).status, 400);
    assert.equal((await call(server.baseUrl, 'POST', NP, { filePath: 'testlib/Let Down.flac', sessionId: 's1', bogus: 1 })).status, 400);
  });

  test('never reachable through federation', () => {
    assert.equal(isFederationRouteAllowed('POST', '/api/v1/stats/now-playing'), false);
    assert.equal(isFederationRouteAllowed('GET', '/api/v1/stats/now-playing'), false);
  });
});
