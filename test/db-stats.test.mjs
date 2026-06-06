/**
 * Integration tests for the homepage-stats endpoints (src/api/db.js):
 *   POST /api/v1/db/rated, /stats/most-played, /stats/recently-played.
 *
 * These were restructured to drive FROM user_metadata via the V44 composite
 * indexes + an OR/COALESCE canonical-hash join, with genres batched per page.
 * This locks in the behaviour that restructure must preserve: correct ordering,
 * the per-user filter, the limit, multi-genre arrays, and resolution of tracks
 * whose canonical hash is the file_hash (NULL audio_hash) via the COALESCE join.
 *
 * Pattern mirrors test/playlist-load.test.mjs: boot a real mStream in
 * public/no-users mode, seed the DB directly, hit the HTTP API.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${baseUrl}/api/`); if (r.status < 500) return; } catch { /* not ready yet — keep polling */ }
    await sleep(150);
  }
  throw new Error('server not ready');
}
async function boot(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port, address: '127.0.0.1', ui: 'default', dlna: { mode: 'disabled' }, subsonic: { mode: 'disabled' },
    folders: { testlib: { root: musicDir } },
    storage: { albumArtDirectory: path.join(tmpDir, 'img'), dbDirectory: path.join(tmpDir, 'db'), logsDirectory: path.join(tmpDir, 'logs'), syncConfigDirectory: path.join(tmpDir, 'sync') },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0 },
  };
  for (const dir of Object.values(config.storage)) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify(config));
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', path.join(tmpDir, 'config.json')],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return { proc, baseUrl };
}
async function kill(proc) { if (proc.exitCode == null) { proc.kill('SIGKILL'); await new Promise(r => proc.once('exit', r)); } }
async function post(baseUrl, route, body) {
  const r = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

// 4 tracks. Track C has NULL audio_hash (canonical = file_hash) to exercise the
// COALESCE join. Track D is unrated/unplayed and must never appear.
function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 44, 'V44 applied at boot');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist')").run().lastInsertRowid);
  const alid = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Alb', ?, 2020)").run(aid).lastInsertRowid);
  const insT = db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, file_hash, audio_hash, duration, modified, scan_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 180, ?, 'seed')`);
  const insG = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const gJazz = Number(insG.run('Jazz').lastInsertRowid);
  const gFunk = Number(insG.run('Funk').lastInsertRowid);
  const insTG = db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  const sentinel = db.prepare('SELECT id FROM users WHERE is_anonymous_sentinel = 1').get().id;
  const insM = db.prepare('INSERT INTO user_metadata (user_id, track_hash, rating, play_count, last_played) VALUES (?,?,?,?,?)');
  // [title, file_hash, audio_hash|null, rating, play_count, last_played, genres]
  const rows = [
    ['Song A', 'fhA', 'ahA', 9, 80, '2024-06-03 00:00:00', [gJazz, gFunk]],
    ['Song B', 'fhB', 'ahB', 7, 50, '2024-06-02 00:00:00', [gFunk]],
    ['Song C', 'fhC', null, 3, 10, '2024-06-01 00:00:00', []],   // NULL audio_hash → canonical = file_hash
    ['Song D', 'fhD', 'ahD', 0, 0, null, []],                    // unrated/unplayed → excluded
  ];
  let ts = 1700000000000;
  for (const [title, fh, ah, rating, pc, lp, genres] of rows) {
    const id = Number(insT.run(`${title}.mp3`, lib, title, aid, alid, fh, ah, ts++).lastInsertRowid);
    for (const g of genres) insTG.run(id, g);
    const canonical = ah || fh;
    if (rating || pc || lp) insM.run(sentinel, canonical, rating, pc, lp);
  }
  db.close();
}

describe('homepage stats — rated / most-played / recently-played', () => {
  let tmpDir, server;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-dbstats-'));
    const musicDir = path.join(tmpDir, 'music'); await fs.mkdir(musicDir, { recursive: true });
    server = await boot(tmpDir, musicDir);
    await kill(server.proc); await sleep(200);
    seed(path.join(tmpDir, 'db', 'mstream.db'));
    server = await boot(tmpDir, musicDir);
  });
  after(async () => {
    if (server?.proc) await kill(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('/rated returns rated tracks in rating DESC, excludes unrated', async () => {
    const r = await post(server.baseUrl, '/api/v1/db/rated', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(x => x.metadata.title), ['Song A', 'Song B', 'Song C']);
    assert.equal(r.body[0].metadata.rating, 9);
    assert.equal(r.body[0].metadata.artist, 'Artist');
  });

  test('batched genres resolve per row (multi-genre + empty)', async () => {
    const r = await post(server.baseUrl, '/api/v1/db/rated', {});
    const a = r.body.find(x => x.metadata.title === 'Song A');
    const c = r.body.find(x => x.metadata.title === 'Song C');
    assert.deepEqual([...a.metadata.genres].sort(), ['Funk', 'Jazz']);
    assert.deepEqual(c.metadata.genres, []);
  });

  test('Song C (NULL audio_hash → file_hash canonical) resolves via COALESCE join', async () => {
    const r = await post(server.baseUrl, '/api/v1/db/stats/most-played', { limit: 10 });
    assert.ok(r.body.some(x => x.metadata.title === 'Song C'), 'Song C missing from most-played');
  });

  test('/stats/most-played orders by play_count DESC + honours limit', async () => {
    const all = await post(server.baseUrl, '/api/v1/db/stats/most-played', { limit: 10 });
    assert.deepEqual(all.body.map(x => x.metadata.title), ['Song A', 'Song B', 'Song C']);
    const lim = await post(server.baseUrl, '/api/v1/db/stats/most-played', { limit: 2 });
    assert.deepEqual(lim.body.map(x => x.metadata.title), ['Song A', 'Song B']);
  });

  test('/stats/recently-played orders by last_played DESC', async () => {
    const r = await post(server.baseUrl, '/api/v1/db/stats/recently-played', { limit: 10 });
    assert.deepEqual(r.body.map(x => x.metadata.title), ['Song A', 'Song B', 'Song C']);
  });
});
