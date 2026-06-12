/**
 * Integration tests for playlist metadata loading (src/api/db.js).
 *
 * /api/v1/playlist/load used to resolve metadata one DB query per track, and
 * each query re-materialised trackQuery's whole-table genre GROUP_CONCAT — so
 * loading a 100-track playlist did ~100 full-table aggregations and took
 * seconds on a large library. It now resolves every track in one batched query
 * (pullMetaDataBatch). These tests lock in the *behaviour* that batching must
 * preserve: order, per-track metadata (incl. genres), duplicate handling, and
 * the empty-metadata slot for unresolvable entries. The same helper backs
 * /api/v1/db/metadata/batch, exercised here too.
 *
 * Pattern mirrors test/random-route.test.mjs: boot a real mStream in
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
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 30_000) {
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
    port, address: '127.0.0.1', ui: 'default',
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
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
  await waitForReady(baseUrl);
  return { proc, baseUrl, port };
}

async function killProc(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGKILL');
  await new Promise(r => proc.once('exit', r));
}

// Two tracks with distinct artist/album/genres. relpaths are what the
// scanner would store; the playlist references them as "<vpath>/<relpath>".
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

describe('playlist/load + metadata/batch — batched metadata resolution', () => {
  let tmpDir;
  let server;

  // The playlist mixes valid tracks, a duplicate, and a "ghost" path whose
  // file is no longer in the DB — every shape the batched resolver must handle.
  const PLAYLIST = [
    'testlib/a.flac',       // Song A
    'testlib/b.flac',       // Song B
    'testlib/a.flac',       // duplicate of Song A
    'testlib/ghost.flac',   // not in DB -> empty metadata
  ];

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-playlist-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    // Boot once to build schema + library row, kill, seed, reboot.
    server = await bootMstream(tmpDir, musicDir);
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, musicDir);

    const saved = await api(server.baseUrl, '/api/v1/playlist/save', { title: 'test', songs: PLAYLIST });
    assert.equal(saved.status, 200);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('returns every entry in saved order, with stable filepaths and dual ids', async () => {
    const r = await api(server.baseUrl, '/api/v1/playlist/load', { playlistname: 'test' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 4);
    assert.deepEqual(r.body.map(x => x.filepath), PLAYLIST);
    for (const item of r.body) {
      assert.ok(Number.isInteger(item.id), 'item has integer id');
      assert.equal(item.lokiId, item.id, 'lokiId mirrors id for legacy UI');
    }
  });

  test('resolves full metadata (artist, album, genres) for known tracks', async () => {
    const r = await api(server.baseUrl, '/api/v1/playlist/load', { playlistname: 'test' });
    const a = r.body[0].metadata;
    assert.equal(a.title, 'Song A');
    assert.equal(a.artist, 'Artist A');
    assert.equal(a.album, 'Album A');
    assert.equal(a.year, 2001);
    assert.equal(a.duration, 180);
    assert.deepEqual([...a.genres].sort(), ['Funk', 'Jazz']);

    const b = r.body[1].metadata;
    assert.equal(b.title, 'Song B');
    assert.equal(b.artist, 'Artist B');
    assert.deepEqual(b.genres, ['Rock']);
  });

  test('duplicate entries each resolve to the same metadata', async () => {
    const r = await api(server.baseUrl, '/api/v1/playlist/load', { playlistname: 'test' });
    assert.deepEqual(r.body[2].metadata, r.body[0].metadata); // index 2 is the dup of Song A
  });

  test('unresolvable entry keeps its slot with empty metadata', async () => {
    const r = await api(server.baseUrl, '/api/v1/playlist/load', { playlistname: 'test' });
    assert.equal(r.body[3].filepath, 'testlib/ghost.flac');
    assert.deepEqual(r.body[3].metadata, {});
  });

  test('loading a non-existent playlist returns []', async () => {
    const r = await api(server.baseUrl, '/api/v1/playlist/load', { playlistname: 'nope' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('metadata/batch returns pullMetaData-shaped wrappers keyed by filepath', async () => {
    const r = await api(server.baseUrl, '/api/v1/db/metadata/batch', PLAYLIST);
    assert.equal(r.status, 200);
    // Known track: wrapper with populated metadata.
    assert.equal(r.body['testlib/a.flac'].metadata.title, 'Song A');
    assert.deepEqual([...r.body['testlib/a.flac'].metadata.genres].sort(), ['Funk', 'Jazz']);
    // Ghost: wrapper present, metadata null (matches pullMetaData miss).
    assert.equal(r.body['testlib/ghost.flac'].metadata, null);
    assert.equal(r.body['testlib/ghost.flac'].filepath, 'testlib/ghost.flac');
  });
});
