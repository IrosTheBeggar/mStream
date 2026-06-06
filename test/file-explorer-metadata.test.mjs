/**
 * Integration tests for file-explorer metadata loading
 * (src/util/file-explorer.js getDirectoryContents, via POST /api/v1/file-explorer).
 *
 * When a client asks for `pullMetadata: true`, the directory listing used to
 * resolve metadata one DB query per file — and each query re-materialised
 * trackQuery's whole-table genre GROUP_CONCAT, so browsing a folder with N
 * tracks cost N full-table scans (the same N+1 fixed for playlist load). It
 * now resolves the whole folder in one batched query (pullMetaDataBatch).
 * These tests lock in the per-file response shape the optimization must
 * preserve: the `{ filepath, metadata }` wrapper for known files, the
 * null-metadata wrapper for files not in the DB, non-audio files excluded,
 * and no `metadata` key at all when pullMetadata is off.
 *
 * Pattern mirrors test/playlist-load.test.mjs: boot a real mStream in
 * public/no-users mode, put dummy files on disk (file-explorer only stats
 * them), seed the DB directly, hit the HTTP API. Avoids the ffmpeg fixture
 * dependency in test/helpers/server.mjs.
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
    scanOptions: { bootScanDelay: 9999, scanInterval: 0 },
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

// Two audio tracks under Artist/Album with distinct artist/album/genres.
// DB filepaths are the library-relative paths the scanner would store.
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const lib = db.prepare("SELECT id FROM libraries WHERE name = 'testlib'").get().id;
  const aA = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist A')").run().lastInsertRowid);
  const aB = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist B')").run().lastInsertRowid);
  const alX = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('Album X', ?, 2003)").run(aA).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        duration, file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'mp3', ?, ?, ?, ?, 'seed')
  `);
  const tA = Number(insT.run('Artist/Album/01 - Song A.mp3', lib, 'Song A', aA, alX, 2003, 200, 'hA', 'aA', 1700000000001).lastInsertRowid);
  const tB = Number(insT.run('Artist/Album/02 - Song B.mp3', lib, 'Song B', aB, alX, 2003, 210, 'hB', 'aB', 1700000000002).lastInsertRowid);

  const insG = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const gJazz = Number(insG.run('Jazz').lastInsertRowid);
  const gFunk = Number(insG.run('Funk').lastInsertRowid);
  const gRock = Number(insG.run('Rock').lastInsertRowid);
  const insTG = db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  insTG.run(tA, gJazz); insTG.run(tA, gFunk);   // Song A: Jazz + Funk
  insTG.run(tB, gRock);                          // Song B: Rock

  db.close();
}

async function explore(baseUrl, body) {
  const r = await fetch(`${baseUrl}/api/v1/file-explorer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

describe('file-explorer — batched metadata resolution', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fileexp-'));
    const albumDir = path.join(tmpDir, 'music', 'Artist', 'Album');
    await fs.mkdir(path.join(albumDir, 'Subfolder'), { recursive: true });
    // Dummy files on disk — file-explorer only readdir/stats them; metadata
    // comes from the seeded DB. ghost.mp3 exists on disk but not in the DB;
    // cover.jpg is a non-audio file that must be excluded from `files`.
    for (const name of ['01 - Song A.mp3', '02 - Song B.mp3', 'ghost.mp3', 'cover.jpg']) {
      await fs.writeFile(path.join(albumDir, name), 'x');
    }

    server = await bootMstream(tmpDir, path.join(tmpDir, 'music'));
    await killProc(server.proc);
    await sleep(200);
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, path.join(tmpDir, 'music'));
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('lists audio files (sorted) + subdirectories, excludes non-audio', async () => {
    const r = await explore(server.baseUrl, { directory: '/testlib/Artist/Album', pullMetadata: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.path, '/testlib/Artist/Album/');
    assert.deepEqual(r.body.directories, [{ name: 'Subfolder' }]);
    assert.deepEqual(
      r.body.files.map(f => f.name),
      ['01 - Song A.mp3', '02 - Song B.mp3', 'ghost.mp3'], // cover.jpg excluded
    );
    for (const f of r.body.files) { assert.equal(f.type, 'mp3'); }
  });

  test('attaches full { filepath, metadata } wrapper for known files', async () => {
    const r = await explore(server.baseUrl, { directory: '/testlib/Artist/Album', pullMetadata: true });
    const songA = r.body.files.find(f => f.name === '01 - Song A.mp3');
    // Old per-file code assigned the whole pullMetaData wrapper to .metadata,
    // so the nested shape (metadata.metadata.*) must be preserved exactly.
    assert.equal(songA.metadata.metadata.title, 'Song A');
    assert.equal(songA.metadata.metadata.artist, 'Artist A');
    assert.equal(songA.metadata.metadata.album, 'Album X');
    assert.deepEqual([...songA.metadata.metadata.genres].sort(), ['Funk', 'Jazz']);
    assert.equal(songA.metadata.filepath, 'testlib/Artist/Album/01 - Song A.mp3');

    const songB = r.body.files.find(f => f.name === '02 - Song B.mp3');
    assert.equal(songB.metadata.metadata.title, 'Song B');
    assert.deepEqual(songB.metadata.metadata.genres, ['Rock']);
  });

  test('file on disk but absent from DB gets a null-metadata wrapper', async () => {
    const r = await explore(server.baseUrl, { directory: '/testlib/Artist/Album', pullMetadata: true });
    const ghost = r.body.files.find(f => f.name === 'ghost.mp3');
    assert.equal(ghost.metadata.metadata, null);            // miss, not a thrown error
    assert.equal(ghost.metadata.filepath, '/testlib/Artist/Album/ghost.mp3');
  });

  test('pullMetadata omitted → no metadata key on files', async () => {
    const r = await explore(server.baseUrl, { directory: '/testlib/Artist/Album' });
    assert.equal(r.status, 200);
    for (const f of r.body.files) {
      assert.equal('metadata' in f, false, `${f.name} should have no metadata`);
    }
  });
});
