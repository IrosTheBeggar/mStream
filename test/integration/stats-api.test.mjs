/**
 * Stats API v2 read routes (src/api/stats.js) against a real server.
 *
 * Pattern mirrors test/integration/db-stats.test.mjs: boot mStream in
 * public/no-users mode with an empty library, stop it, seed tracks and plays
 * straight into the DB through the store primitive every writer uses
 * (src/stats/store.js), boot again, hit the HTTP API. No media fixtures, so
 * no ffmpeg dependency.
 *
 * Locks in: the summary's counts and derived facts, top-N by both metrics
 * with the federated snapshot path, timezone-correct day bucketing, the
 * history cursor and its either-hash track filter, per-track counters by
 * path, the periods listing, and the
 * 400s for a bad timezone / unknown parameter.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { recordPlayEvents } from '../../src/stats/store.js';

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

async function boot(tmpDir, musicDir) {
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
  };
  for (const dir of Object.values(config.storage)) await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl);
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  return { proc, baseUrl };
}

async function kill(proc) { if (proc.exitCode == null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); } }

async function get(baseUrl, route) {
  const r = await fetch(`${baseUrl}${route}`);
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}
async function post(baseUrl, route, body) {
  const r = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// Three local tracks (C has NULL audio_hash → canonical = file_hash), one
// federated peer, six plays spread over August/September 2026 — one of them
// at 22:30Z so a Berlin day boundary can be checked against UTC.
function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 70, 'V70+ applied at boot');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist')").run().lastInsertRowid);
  const alid = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Alb', ?, 2020)").run(aid).lastInsertRowid);
  const insT = db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, file_hash, audio_hash, duration, modified, scan_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 180, ?, 'seed')`);
  const gJazz = Number(db.prepare("INSERT INTO genres (name) VALUES ('Jazz')").run().lastInsertRowid);
  const insTG = db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  const ts = 1700000000000;
  const idA = Number(insT.run('Song A.mp3', lib, 'Song A', aid, alid, 'fhA', 'ahA', ts).lastInsertRowid);
  insT.run('Song B.mp3', lib, 'Song B', aid, alid, 'fhB', 'ahB', ts + 1);
  insT.run('Song C.mp3', lib, 'Song C', aid, alid, 'fhC', null, ts + 2);
  insTG.run(idA, gJazz);
  const peer = Number(db.prepare("INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES ('Bob', 't', 'fedk_bob')").run().lastInsertRowid);
  const uid = db.prepare('SELECT id FROM users WHERE is_anonymous_sentinel = 1').get().id;

  const ev = (over) => ({
    userId: uid, libraryId: lib, outcome: 'completed', counted: true, playedMs: 180_000, durationMs: 180_000,
    source: 'manual', client: 'test', ...over,
  });
  recordPlayEvents(db, [
    ev({ eventId: 'aug-A', trackHash: 'ahA', filepath: 'Song A.mp3', startedAt: '2026-08-15 10:00:00', endedAt: '2026-08-15 10:03:00' }),
    ev({ eventId: 'sep1-A', trackHash: 'ahA', filepath: 'Song A.mp3', startedAt: '2026-09-01 10:00:00', endedAt: '2026-09-01 10:03:00' }),
    ev({ eventId: 'sep2-B', trackHash: 'ahB', filepath: 'Song B.mp3', outcome: 'skipped', counted: false, playedMs: 10_000,
      startedAt: '2026-09-02 10:05:00', endedAt: '2026-09-02 10:05:10' }),
    ev({ eventId: 'sep2-A', trackHash: 'ahA', filepath: 'Song A.mp3', startedAt: '2026-09-02 22:30:00', endedAt: '2026-09-02 22:33:00' }),
    ev({ eventId: 'sep3-C', trackHash: 'fhC', filepath: 'Song C.mp3', startedAt: '2026-09-03 10:00:00', endedAt: '2026-09-03 10:03:00' }),
    ev({ eventId: 'sep3-peer', trackHash: 'ph1', filepath: 'music/peer.flac', libraryId: null, peerId: peer,
      snapshot: { title: 'Peer Song', artist: 'Peer Artist', album: 'Peer Album', hash: 'ph1', durationMs: 240_000 },
      playedMs: 240_000, durationMs: 240_000, startedAt: '2026-09-03 11:00:00', endedAt: '2026-09-03 11:04:00' }),
  ]);
  db.close();
  return { peer };
}

const SEP = 'from=2026-09-01T00:00:00Z&to=2026-09-04T00:00:00Z';

describe('stats API v2 — reads', () => {
  let tmpDir, server, seeded;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-stats-'));
    const musicDir = path.join(tmpDir, 'music'); await fs.mkdir(musicDir, { recursive: true });
    server = await boot(tmpDir, musicDir);
    await kill(server.proc); await sleep(200);
    seeded = seed(path.join(tmpDir, 'db', 'mstream.db'));
    server = await boot(tmpDir, musicDir);
  });
  after(async () => {
    if (server?.proc) await kill(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('summary: counts, uniques, discoveries, sessions, streak, origins', async () => {
    const r = await get(server.baseUrl, `/api/v1/stats/summary?${SEP}`);
    assert.equal(r.status, 200, r.body);
    const s = r.body;
    assert.equal(s.period.from, '2026-09-01T00:00:00.000Z');
    assert.equal(s.period.tz, 'UTC');
    assert.equal(s.events, 5);
    assert.equal(s.plays, 4);
    assert.equal(s.skips, 1);
    assert.equal(s.uniqueTracks, 3);          // A, C, peer
    assert.equal(s.uniqueArtists, 2);         // Artist + Peer Artist
    assert.equal(s.uniqueAlbums, 2);
    assert.equal(s.listenedMs, 180_000 * 3 + 10_000 + 240_000);
    assert.equal(s.skipRate, 0.2);
    assert.equal(s.completionRate, 0.8);
    assert.equal(s.discoveries, 2);           // C and the peer track; A's first play was in August
    assert.equal(s.libraryCoveragePct, 66.7); // A and C of three local tracks, ever
    assert.equal(s.sessions.count, 5);
    assert.equal(s.sessions.longest.listenedMs, 240_000);
    assert.deepEqual(s.streakDays, { current: 0, longest: 3 });
    assert.equal(s.topDay.date, '2026-09-03');
    assert.equal(s.peakHour, 10);
    assert.deepEqual(s.origins, { local: { plays: 3, listenedMs: 550_000 }, peers: { plays: 1, listenedMs: 240_000 } });
  });

  test('summary: origin=local drops the peer play; a Berlin day moves the 22:30Z play', async () => {
    const local = await get(server.baseUrl, `/api/v1/stats/summary?${SEP}&origin=local`);
    assert.equal(local.body.plays, 3);
    assert.equal(local.body.uniqueTracks, 2);
    const berlin = await get(server.baseUrl, `/api/v1/stats/summary?${SEP}&tz=Europe/Berlin`);
    assert.equal(berlin.body.period.tz, 'Europe/Berlin');
    assert.equal(berlin.body.topDay.date, '2026-09-03'); // 22:30Z Sep 2 = 00:30 Sep 3 local → three plays that day
  });

  test('summary and timeseries: the calendar facts follow origin, not just the counts', async () => {
    // Only the peer play: one day, one hour — the rollup would have said three days and a 10:00 peak.
    const peers = await get(server.baseUrl, `/api/v1/stats/summary?${SEP}&origin=peers`);
    assert.equal(peers.body.events, 1);
    assert.deepEqual(peers.body.streakDays, { current: 0, longest: 1 });
    assert.equal(peers.body.topDay.date, '2026-09-03');
    assert.equal(peers.body.topDay.plays, 1);
    assert.equal(peers.body.peakHour, 11);
    const local = await get(server.baseUrl, `/api/v1/stats/summary?${SEP}&origin=local`);
    assert.equal(local.body.peakHour, 10);
    assert.deepEqual(local.body.streakDays, { current: 0, longest: 3 });
    const series = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=day&origin=peers`);
    assert.deepEqual(series.body.items, [{ bucket: '2026-09-03', events: 1, plays: 1, skips: 0, listenedMs: 240_000 }]);
    const hours = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=hourOfDay&origin=local`);
    const ten = hours.body.items.find((b) => b.bucket === '10');
    assert.deepEqual([ten.events, ten.plays, ten.skips], [3, 2, 1]); // sep2-B started at 10:05 and was skipped
    assert.equal(hours.body.items.find((b) => b.bucket === '11').plays, 0);
    // Unfiltered, the rollup still answers (identical here, nothing is pruned).
    const all = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=day`);
    assert.equal(all.body.items.reduce((n, b) => n + b.plays, 0), 4);
  });

  test('top tracks by plays, with a federated snapshot row', async () => {
    const r = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&entity=tracks&limit=10`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body.items.map((i) => i.track.metadata.title), ['Song A', 'Peer Song', 'Song C']);
    const [a, peer, c] = r.body.items;
    assert.deepEqual([a.rank, a.plays, a.origin, a.share], [1, 2, 'local', 0.5]);
    assert.equal(a.track.metadata.artist, 'Artist');
    assert.deepEqual(a.track.metadata.genres, ['Jazz']);
    assert.equal(peer.origin, 'peer');
    assert.equal(peer.peerId, seeded.peer);
    assert.equal(peer.track.metadata.artist, 'Peer Artist');
    assert.equal(peer.track.metadata.hash, 'ph1');
    assert.equal(c.track.metadata.title, 'Song C'); // file_hash canonical resolves
  });

  test('top by time, and grouped entities', async () => {
    const byTime = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&metric=time&limit=1`);
    assert.equal(byTime.body.items[0].track.metadata.title, 'Song A'); // 360 s beats the peer's 240 s
    const artists = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&entity=artists`);
    // Song B's only play was an uncounted skip, so 'Artist' has two counted tracks behind three plays.
    assert.deepEqual(artists.body.items.map((i) => [i.name, i.plays, i.tracks]), [['Artist', 3, 2], ['Peer Artist', 1, 1]]);
    const albums = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&entity=albums`);
    assert.deepEqual(albums.body.items.map((i) => [i.name, i.artist, i.plays]), [['Alb', 'Artist', 3], ['Peer Album', 'Peer Artist', 1]]);
    const genres = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&entity=genres`);
    assert.deepEqual(genres.body.items.map((i) => [i.name, i.plays]), [['Jazz', 2]]);
  });

  test('timeseries: day buckets follow the timezone; profile buckets are dense', async () => {
    const utc = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=day`);
    assert.deepEqual(utc.body.items.map((b) => [b.bucket, b.events, b.plays]),
      [['2026-09-01', 1, 1], ['2026-09-02', 2, 1], ['2026-09-03', 2, 2]]);
    const berlin = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=day&tz=Europe/Berlin`);
    assert.deepEqual(berlin.body.items.map((b) => [b.bucket, b.plays]),
      [['2026-09-01', 1], ['2026-09-02', 0], ['2026-09-03', 3]]);
    const hod = await get(server.baseUrl, `/api/v1/stats/timeseries?${SEP}&bucket=hourOfDay`);
    assert.equal(hod.body.items.length, 24);
    assert.equal(hod.body.items[10].plays, 2);
    assert.equal(hod.body.items[11].plays, 1);
    const wd = await get(server.baseUrl, `/api/v1/stats/timeseries?period=all&bucket=weekday`);
    assert.equal(wd.body.items.length, 7);
  });

  test('history: newest first, cursor pagination, track filter', async () => {
    const p1 = await get(server.baseUrl, '/api/v1/stats/history?limit=2');
    assert.equal(p1.status, 200, p1.body);
    assert.deepEqual(p1.body.items.map((i) => i.id), ['sep3-peer', 'sep3-C']);
    assert.equal(p1.body.items[0].origin, 'peer');
    assert.equal(p1.body.items[0].track.metadata.title, 'Peer Song');
    assert.equal(p1.body.items[0].startedAt, '2026-09-03T11:00:00.000Z');
    assert.ok(p1.body.next);
    const p2 = await get(server.baseUrl, `/api/v1/stats/history?limit=2&before=${encodeURIComponent(p1.body.next)}`);
    assert.deepEqual(p2.body.items.map((i) => i.id), ['sep2-A', 'sep2-B']);
    assert.equal(p2.body.items[1].counted, false);
    const p3 = await get(server.baseUrl, `/api/v1/stats/history?limit=2&before=${encodeURIComponent(p2.body.next)}`);
    assert.deepEqual(p3.body.items.map((i) => i.id), ['sep1-A', 'aug-A']);
    assert.equal(p3.body.next, null);
    const onlyA = await get(server.baseUrl, '/api/v1/stats/history?track=ahA');
    assert.deepEqual(onlyA.body.items.map((i) => i.id), ['sep2-A', 'sep1-A', 'aug-A']);
    // The file hash resolves to the same canonical key; a peer's hash has no
    // library row and filters the events directly.
    const byFileHash = await get(server.baseUrl, '/api/v1/stats/history?track=fhA');
    assert.deepEqual(byFileHash.body.items.map((i) => i.id), ['sep2-A', 'sep1-A', 'aug-A']);
    const peerOnly = await get(server.baseUrl, '/api/v1/stats/history?track=ph1');
    assert.deepEqual(peerOnly.body.items.map((i) => i.id), ['sep3-peer']);
    assert.equal(peerOnly.body.items[0].peerName, 'Bob', 'a peer row names its peer');
    assert.equal(p1.body.items[1].peerName, null);
    const bad = await get(server.baseUrl, '/api/v1/stats/history?before=not-a-cursor');
    assert.equal(bad.status, 400);
  });

  test('tracks: counters by path and by hash; unknown tracks omitted', async () => {
    const r = await post(server.baseUrl, '/api/v1/stats/tracks', { filePaths: ['testlib/Song A.mp3', 'testlib/Nope.mp3'], hashes: ['fhC', 'zzz'] });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body.items.map((i) => [i.hash, i.filePath ?? null, i.plays, i.skips]),
      [['ahA', 'testlib/Song A.mp3', 3, 0], ['fhC', null, 1, 0]]);
    assert.equal(r.body.items[0].firstPlayed, '2026-08-15T10:00:00.000Z');
    assert.equal(r.body.items[0].lastPlayed, '2026-09-02T22:30:00.000Z');
    const empty = await post(server.baseUrl, '/api/v1/stats/tracks', {});
    assert.equal(empty.status, 400);
  });

  test('tracks: a file hash finds the counters kept under the audio hash, reported under the key sent', async () => {
    const r = await post(server.baseUrl, '/api/v1/stats/tracks', { hashes: ['fhA', 'ahA', 'ph1'] });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body.items.map((i) => [i.hash, i.canonicalHash ?? null, i.plays]),
      [['fhA', 'ahA', 3], ['ahA', null, 3], ['ph1', null, 1]]);   // the peer's key is looked up as sent
    assert.equal(r.body.items[0].lastPlayed, r.body.items[1].lastPlayed);
  });

  test('periods: bounds and the presets that overlap them', async () => {
    const r = await get(server.baseUrl, '/api/v1/stats/periods?tz=Europe/Berlin');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body.earliest, '2026-08-15T10:00:00.000Z');
    assert.equal(r.body.latest, '2026-09-03T11:00:00.000Z');
    assert.ok(r.body.periods.some((p) => p.period === 'month' && p.offset === 0));
    assert.ok(r.body.periods.every((p) => new Date(p.to) > new Date(r.body.earliest)));
  });

  test('400 on an unknown timezone, an unpaired from, or an unknown parameter', async () => {
    assert.equal((await get(server.baseUrl, '/api/v1/stats/summary?tz=Nope/Zone')).status, 400);
    assert.equal((await get(server.baseUrl, '/api/v1/stats/summary?from=2026-09-01T00:00:00Z')).status, 400);
    const unknown = await get(server.baseUrl, '/api/v1/stats/summary?bogus=1');
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /bogus.* is not allowed/); // the Joi message the app's ServerCapabilities parses
  });

  test('history: an optional range scopes the log the way every other read is scoped', async () => {
    const sep = await get(server.baseUrl, `/api/v1/stats/history?${SEP}`);
    assert.equal(sep.status, 200, sep.body);
    assert.deepEqual(sep.body.items.map((i) => i.id), ['sep3-peer', 'sep3-C', 'sep2-A', 'sep2-B', 'sep1-A']);
    assert.equal(sep.body.period.from, '2026-09-01T00:00:00.000Z', 'the resolved range rides along');
    const aug = await get(server.baseUrl, '/api/v1/stats/history?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z');
    assert.deepEqual(aug.body.items.map((i) => i.id), ['aug-A']);
    const peersInSep = await get(server.baseUrl, `/api/v1/stats/history?${SEP}&origin=peers`);
    assert.deepEqual(peersInSep.body.items.map((i) => [i.id, i.peerName]), [['sep3-peer', 'Bob']]);
    const whole = await get(server.baseUrl, '/api/v1/stats/history');
    assert.equal(whole.body.items.length, 6, 'no range: the whole log, as before');
    assert.equal(whole.body.period, undefined);
    const half = await get(server.baseUrl, '/api/v1/stats/history?from=2026-09-01T00:00:00Z');
    assert.equal(half.status, 400, 'from without to');
  });

  test('top tracks name the peer behind a federated row', async () => {
    const r = await get(server.baseUrl, `/api/v1/stats/top?${SEP}&entity=tracks`);
    const peerRow = r.body.items.find((i) => i.origin === 'peer');
    assert.equal(peerRow.peerName, 'Bob');
    assert.equal(r.body.items.find((i) => i.origin === 'local').peerName, null);
  });
});
