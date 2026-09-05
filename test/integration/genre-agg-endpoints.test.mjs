/**
 * Genre-enrichment parity tests for the endpoints converted off trackQuery's
 * default whole-table tg_agg join (2026-07 perf audit, PR-D): the join
 * materialised a GROUP_CONCAT over the ENTIRE track_genres table per request,
 * so list/metadata endpoints scaled with the library instead of the response.
 * They now run trackQuery({ includeGenres: false }) and batch-enrich just the
 * returned rows (enrichRowsWithGenres / fetchGenresForTrack).
 *
 * These tests lock the BEHAVIOUR the conversion must preserve: every
 * converted endpoint still emits identical metadata.genres content.
 * Covered: /db/metadata (single pullMetaData), /db/genre-songs (incl. the
 * name→id-first probe + NOCASE), /db/album-songs, /db/recent/added,
 * /smart-playlists/run (genre FILTER join vs genre SELECT enrichment stay
 * independent), and the velvet stubs /db/genre/songs + /db/decade/songs.
 *
 * Pattern mirrors test/integration/playlist-load.test.mjs: boot a real
 * mStream in public/no-users mode, seed the DB directly, hit the HTTP API.
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
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 90 s, not 30: the same loaded-CI-runner ceiling test/helpers/server.mjs
// uses for this wait — a starved Windows shard has expired 30 s at boot.
async function waitForReady(baseUrl, timeoutMs = 90_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`, { cause: lastErr });
}

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    // ui:'velvet' so the velvet-gated modules (smart-playlists, velvet-stubs)
    // mount too — the core /db routes are identical under either UI.
    port, address: '127.0.0.1', ui: 'velvet',
    dlna:     { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
    },
    scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
  };
  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl);
  } catch (err) {
    // A ready-timeout must not leak the child: the server can boot late but
    // healthy on a loaded runner, and a live orphan's stdio keeps this file's
    // event loop open — the run then hangs at exit instead of reporting the
    // timeout. test/helpers/server.mjs kills on this path for the same reason.
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// Two tracks with distinct artist/album/year/genres — Song A carries TWO
// genres so single- vs multi-genre aggregation is distinguishable.
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const lib = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  const aA = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist A')").run().lastInsertRowid);
  const aB = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist B')").run().lastInsertRowid);
  const alA = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Album A', ?, 2001)").run(aA).lastInsertRowid);
  const alB = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Album B', ?, 2002)").run(aB).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        duration, file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, ?, 'seed')
  `);
  const tA = Number(insT.run('a.flac', lib, 'Song A', aA, alA, 2001, 180, 'hA', 'aA', 1700000000001).lastInsertRowid);
  const tB = Number(insT.run('b.flac', lib, 'Song B', aB, alB, 2002, 240, 'hB', 'aB', 1700000000002).lastInsertRowid);

  const insG = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const gJazz = Number(insG.run('Jazz').lastInsertRowid);
  const gFunk = Number(insG.run('Funk').lastInsertRowid);
  const gRock = Number(insG.run('Rock').lastInsertRowid);
  const insTG = db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  insTG.run(tA, gJazz); insTG.run(tA, gFunk);   // Song A: Jazz + Funk
  insTG.run(tB, gRock);                          // Song B: Rock

  db.close();
}

async function api(baseUrl, route, body) {
  const r = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

const genresOf = (item) => [...(item.metadata?.genres ?? [])].sort();

describe('genre aggregation parity across converted endpoints', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-genreagg-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    server = await bootMstream(tmpDir, musicDir);
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('/db/metadata (single pullMetaData) carries full genres', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/metadata', { filepath: 'testlib/a.flac' });
    assert.equal(r.status, 200);
    assert.deepEqual(genresOf(r.body), ['Funk', 'Jazz']);
  });

  test('/db/genre-songs matches NOCASE via the id-first probe and returns only that genre', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/genre-songs', { genre: 'jazz' });   // lowercase on purpose
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1, 'only Song A is Jazz');
    assert.equal(r.body[0].metadata.title, 'Song A');
    assert.deepEqual(genresOf(r.body[0]), ['Funk', 'Jazz'], 'full genre list, not just the matched one');
  });

  test('/db/genre-songs with an unknown genre returns []', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/genre-songs', { genre: 'Polka' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('/db/album-songs carries genres', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/album-songs', { album: 'Album B' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.deepEqual(genresOf(r.body[0]), ['Rock']);
  });

  test('/db/recent/added carries genres for every row', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/recent/added', { limit: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
    const byTitle = Object.fromEntries(r.body.map((x) => [x.metadata.title, genresOf(x)]));
    assert.deepEqual(byTitle, { 'Song A': ['Funk', 'Jazz'], 'Song B': ['Rock'] });
  });

  test('smart-playlists/run: genre FILTER join and genre SELECT enrichment stay independent', async () => {
    // Filter on Jazz — the response row must still carry BOTH of Song A's
    // genres (the filter join must not become the source of the genre list).
    const r = await api(server.baseUrl, '/api/v1/smart-playlists/run',
      { filters: { genres: ['Jazz'] }, sort: 'artist', limit: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.body.songs.length, 1);
    assert.equal(r.body.songs[0].metadata.title, 'Song A');
    assert.deepEqual(genresOf(r.body.songs[0]), ['Funk', 'Jazz']);
  });

  test('velvet stubs /db/genre/songs + /db/decade/songs carry genres', async () => {
    const g = await api(server.baseUrl, '/api/v1/db/genre/songs', { genre: 'ROCK' });
    assert.equal(g.status, 200);
    assert.equal(g.body.length, 1);
    assert.deepEqual(genresOf(g.body[0]), ['Rock']);

    const d = await api(server.baseUrl, '/api/v1/db/decade/songs', { decade: 2000 });
    assert.equal(d.status, 200);
    assert.equal(d.body.length, 2);
    for (const item of d.body) { assert.ok(genresOf(item).length > 0, 'decade rows keep genres'); }
  });
});
