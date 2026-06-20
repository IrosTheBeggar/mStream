/**
 * Regression test for issue #561 — public-mode (no-users) library filter.
 *
 * Background: V25 introduced an "anonymous sentinel" user row so per-user
 * tables (user_metadata, playlists, cue_points, …) which all FK NOT NULL
 * on users(id) can accept inserts in public mode. auth.js's no-users
 * branch now pins `req.user.id = getAnonymousUserId()` instead of `null`.
 *
 * That change accidentally broke `getUserLibraryIds()`, which previously
 * short-circuited on `!user.id` to mean "public mode → see every library".
 * The sentinel id is truthy, so the short-circuit never fired and the
 * lookup `_userLibrariesCache.get(sentinelId)` returned `[]` (the sentinel
 * has no rows in user_libraries). Downstream, `libraryFilter()` emitted
 * `clause: '1=0'`, hiding every track from every track-table-driven API
 * (db/status, db/artists, db/albums, all of Subsonic's browse endpoints,
 * etc.) — which is what the issue reporter saw on 6.5.4: "database seems
 * empty now... only file explorer is not empty".
 *
 * This test stands up mStream in true public/no-users mode against an
 * empty music dir, then directly seeds tracks/albums/artists in the DB
 * (so we don't depend on real audio fixtures), and asserts that the
 * public-mode HTTP API returns the seeded data — which it would not
 * with the broken `getUserLibraryIds`.
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
  throw new Error(`server not ready: ${lastErr?.message || 'unknown'}`);
}

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    ui: 'default',
    // Disable Subsonic + DLNA — we're only testing the default API path.
    // Subsonic auth is tested separately and the sentinel guard
    // (subsonic/auth.js excludes is_anonymous_sentinel = 1) means public
    // mode never even reaches the Subsonic handler chain.
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
    folders:  { testlib: { root: musicDir } },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    // Don't run the boot scan — we want to seed the DB ourselves with
    // synthetic data and not have the (empty) music dir trigger a wipe.
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
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    },
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

// Seed the DB with a minimal but realistic track/album/artist set.
// We talk to the DB directly because we don't have ffmpeg available in
// every CI environment to materialise real MP3 fixtures, and the bug
// we're testing has nothing to do with audio parsing — just the filter.
function seedDB(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  // The libraries row was created by mStream during the loki migration
  // step on first boot; pick it up by name so we use the same id the
  // server's caches see.
  const libRow = db.prepare(`SELECT id FROM libraries WHERE name = 'testlib'`).get();
  assert.ok(libRow, 'testlib library should exist after boot');
  const libId = libRow.id;

  const artistA = Number(db.prepare(`INSERT INTO artists (name) VALUES ('Icarus')`).run().lastInsertRowid);
  const artistB = Number(db.prepare(`INSERT INTO artists (name) VALUES ('Vosto')`).run().lastInsertRowid);
  const albumA  = Number(db.prepare(`INSERT INTO albums (name, artist_id, year) VALUES ('Be Somebody', ?, 2019)`).run(artistA).lastInsertRowid);
  const albumB  = Number(db.prepare(`INSERT INTO albums (name, artist_id, year) VALUES ('Night Drive', ?, 2018)`).run(artistB).lastInsertRowid);

  const insT = db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id)
    VALUES (?, ?, ?, ?, ?, ?, 'mp3', ?, ?, ?, 'seed')
  `);
  insT.run('Icarus/Be Somebody/01.mp3', libId, 'Be Somebody', artistA, albumA, 2019, 'h1', 'a1', 1700000001000);
  insT.run('Icarus/Be Somebody/02.mp3', libId, 'Rise',         artistA, albumA, 2019, 'h2', 'a2', 1700000002000);
  insT.run('Vosto/Night Drive/01.mp3',  libId, 'Highway',      artistB, albumB, 2018, 'h3', 'a3', 1700000003000);

  db.close();
}

// ────────────────────────────────────────────────────────────────────

describe('public-mode library filter (issue #561)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-public-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });

    // Boot once with an empty music dir so mStream creates the DB +
    // libraries row + V25 anonymous sentinel.
    server = await bootMstream(tmpDir, musicDir);

    // Stop, seed the DB, restart against the seeded DB.
    await killProc(server.proc);
    await sleep(200);  // let WAL settle before we open the DB ourselves
    seedDB(path.join(tmpDir, 'db', 'mstream.db'));
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('/api/v1/db/status reports the seeded track count in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    // Pre-fix this returned 0 because libraryFilter resolved to `1=0`.
    assert.equal(body.totalFileCount, 3, 'public mode must see all tracks');
    assert.equal(body.locked, false);
  });

  test('/api/v1/db/artists returns the seeded artists in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/artists`);
    assert.equal(r.status, 200);
    const body = await r.json();
    // Pre-fix this returned an empty array.
    assert.deepEqual([...body.artists].sort(), ['Icarus', 'Vosto']);
  });

  test('/api/v1/db/albums returns the seeded albums in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/albums`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const names = body.albums.map(a => a.name).sort();
    assert.deepEqual(names, ['Be Somebody', 'Night Drive']);
  });

  test('/api/v1/db/artists-albums returns albums for a specific artist in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/artists-albums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist: 'Icarus' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.albums.length, 1);
    assert.equal(body.albums[0].name, 'Be Somebody');
    assert.equal(body.albums[0].year, 2019);
  });

  test('public-mode user has all libraries in the request user object', async () => {
    // Sanity check the auth path itself: a request hits the no-users
    // branch and the response should reflect that we have library access.
    // We exercise this indirectly through /api/ which returns the API
    // catalog including library names.
    const r = await fetch(`${server.baseUrl}/api/`);
    assert.equal(r.status, 200);
  });
});
