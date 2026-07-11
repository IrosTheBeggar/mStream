/**
 * Public-mode contract for per-user data + credential leakage tests.
 *
 * The V25 anonymous sentinel was added so per-user tables (which all FK
 * NOT NULL on users(id)) can accept inserts when no real users are
 * configured. auth.js's no-users branch pins `req.user.id` to the
 * sentinel, and that's the design intent: the sentinel acts as the
 * persistent identity for an operator running mStream in public mode
 * (the common single-user docker pattern).
 *
 * That means most "per-user state" endpoints SHOULD work in public mode
 * — bookmarks, UI prefs, the saved play queue, smart playlists, play
 * counts, "wrapped" stats — all of them just write to / read from the
 * sentinel's row. The contract this file pins down is:
 *
 *   1. State APIs (cuepoints, user-settings, smart-playlists, wrapped,
 *      log-play) accept writes in public mode and the sentinel-keyed
 *      row is what comes back on subsequent reads.
 *
 *   2. Credential APIs (ListenBrainz, Last.fm) STAY blocked. A token /
 *      password landing on the sentinel row would mean every anonymous
 *      session inherits the same scrobbling identity, broadcasting
 *      whoever the operator linked to ListenBrainz / Last.fm. That's a
 *      different class of bug than "shared bookmarks across anons" —
 *      it's a third-party-attribution leak — so it stays guarded by
 *      `db.isPublicMode(req.user)` everywhere in those modules.
 *
 *   3. The library filter (issue #561's showstopper) is covered in the
 *      sibling file `public-mode-library-filter.test.mjs`.
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
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) return;
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('server not ready');
}

async function bootMstream(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    // The state APIs we're verifying (listenbrainz, smart-playlists,
    // wrapped, user-settings, cuepoints, velvet-stubs) are mounted only
    // when `ui === 'velvet'` — see src/server.js. The default UI doesn't
    // route to any of them, so we boot in velvet mode here.
    ui: 'velvet',
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
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

function dbValue(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(sql).get(...params);
  db.close();
  return row;
}

function dbCount(dbPath, table, where = '1=1', params = []) {
  return dbValue(dbPath, `SELECT COUNT(*) c FROM ${table} WHERE ${where}`, params).c;
}

function getSentinelId(dbPath) {
  return dbValue(dbPath, `SELECT id FROM users WHERE is_anonymous_sentinel = 1`).id;
}

// Seed a single track so endpoints that key off filepath have something
// to look up. Keeps fixture cost minimal — we don't need real audio for
// the V25/sentinel contract this file is pinning down.
function seedOneTrack(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const lib = db.prepare(`SELECT id FROM libraries WHERE name = 'testlib'`).get();
  assert.ok(lib, 'testlib library should exist');
  const aid = Number(db.prepare(`INSERT INTO artists (name) VALUES ('Test Artist')`).run().lastInsertRowid);
  const albid = Number(db.prepare(`INSERT INTO albums (name, artist_id, year) VALUES ('Test Album', ?, 2020)`).run(aid).lastInsertRowid);
  db.prepare(`
    INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, year, format,
                        file_hash, audio_hash, modified, scan_id, duration)
    VALUES ('test/song.mp3', ?, 'Test Song', ?, ?, 2020, 'mp3', 'hh', 'aa', 1700000000000, 'seed', 180.0)
  `).run(lib.id, aid, albid);
  db.close();
}

// ────────────────────────────────────────────────────────────────────

describe('public-mode contract: per-user state APIs work under the sentinel', () => {
  let tmpDir;
  let server;
  let dbPath;
  let sentinelId;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-state-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    dbPath = path.join(tmpDir, 'db', 'mstream.db');

    server = await bootMstream(tmpDir, musicDir);
    await killProc(server.proc);
    await sleep(200);
    seedOneTrack(dbPath);
    sentinelId = getSentinelId(dbPath);
    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Cuepoints: write under sentinel, read back ────────────────────

  test('Cuepoint POST + GET round-trip in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/cuepoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filepath: 'testlib/test/song.mp3', position: 30, label: 'drop' }),
    });
    assert.equal(r.status, 200, 'public mode should accept the write under the sentinel');
    const { id } = await r.json();
    assert.ok(id > 0);

    // Row landed against the sentinel — that's the V25 design intent.
    const row = dbValue(dbPath, 'SELECT user_id, position, label FROM cue_points WHERE id = ?', [id]);
    assert.equal(row.user_id, sentinelId);
    assert.equal(row.position, 30);
    assert.equal(row.label, 'drop');

    // GET returns it for the same anon-pinned request.
    const g = await fetch(`${server.baseUrl}/api/v1/db/cuepoints?fp=${encodeURIComponent('testlib/test/song.mp3')}`);
    assert.equal(g.status, 200);
    const body = await g.json();
    assert.equal(body.cuepoints.length, 1);
    assert.equal(body.cuepoints[0].t, 30);
    assert.equal(body.cuepoints[0].title, 'drop');

    // Cleanup so other tests start fresh.
    await fetch(`${server.baseUrl}/api/v1/db/cuepoints/${id}`, { method: 'DELETE' });
  });

  // ── User settings: write under sentinel, read back ────────────────

  test('User settings POST + GET round-trip in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: { theme: 'dark', volume: '0.7' } }),
    });
    assert.equal(r.status, 200);

    const cnt = dbCount(dbPath, 'user_settings', 'user_id = ?', [sentinelId]);
    assert.equal(cnt, 2, 'both prefs rows should land under the sentinel');

    const g = await fetch(`${server.baseUrl}/api/v1/user/settings`);
    assert.equal(g.status, 200);
    const body = await g.json();
    assert.equal(body.prefs.theme, 'dark');
    assert.equal(body.prefs.volume, '0.7');

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare('DELETE FROM user_settings WHERE user_id = ?').run(sentinelId);
    sdb.close();
  });

  // ── Smart playlists: full CRUD under sentinel ─────────────────────

  test('Smart playlists CRUD under sentinel in public mode', async () => {
    const create = await fetch(`${server.baseUrl}/api/v1/smart-playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Workout', filters: { genre: 'electronic' }, sort: 'random', limit: 25 }),
    });
    assert.equal(create.status, 200);
    const { id } = await create.json();
    assert.ok(id > 0);

    const row = dbValue(dbPath, 'SELECT user_id, name FROM smart_playlists WHERE id = ?', [id]);
    assert.equal(row.user_id, sentinelId);
    assert.equal(row.name, 'Workout');

    const list = await fetch(`${server.baseUrl}/api/v1/smart-playlists`);
    const body = await list.json();
    assert.ok(body.playlists.some(p => p.id === id && p.name === 'Workout'));

    const del = await fetch(`${server.baseUrl}/api/v1/smart-playlists/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(dbCount(dbPath, 'smart_playlists', 'id = ?', [id]), 0);
  });

  // ── Wrapped events: persist + read back stats ─────────────────────

  test('Wrapped /play-start persists an event under the sentinel', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/wrapped/play-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'testlib/test/song.mp3', sessionId: 's1', source: 'web' }),
    });
    assert.equal(r.status, 200);
    const { eventId } = await r.json();
    assert.ok(eventId, 'event id should be issued');

    const row = dbValue(dbPath, 'SELECT user_id, filepath FROM play_events WHERE event_id = ?', [eventId]);
    assert.equal(row.user_id, sentinelId);
    assert.equal(row.filepath, 'test/song.mp3');

    // Mark complete so /user/wrapped sees it.
    const end = await fetch(`${server.baseUrl}/api/v1/wrapped/play-end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, playedMs: 180000 }),
    });
    assert.equal(end.status, 200);

    // The aggregate view should now show the play.
    const stats = await fetch(`${server.baseUrl}/api/v1/user/wrapped`);
    assert.equal(stats.status, 200);
    const sb = await stats.json();
    assert.ok(sb.total_plays >= 1, `wrapped view should reflect the sentinel's plays (got ${sb.total_plays})`);

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare('DELETE FROM play_events WHERE user_id = ?').run(sentinelId);
    sdb.close();
  });

  // ── /db/stats/log-play: writes user_metadata under sentinel ───────

  test('/db/stats/log-play writes a user_metadata row under the sentinel', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/db/stats/log-play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'testlib/test/song.mp3' }),
    });
    assert.equal(r.status, 200);

    const row = dbValue(
      dbPath,
      'SELECT user_id, play_count, last_played FROM user_metadata WHERE user_id = ? AND track_hash = ?',
      [sentinelId, 'aa']
    );
    assert.equal(row.user_id, sentinelId);
    assert.equal(row.play_count, 1);
    assert.ok(row.last_played, 'last_played should be set');

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare('DELETE FROM user_metadata WHERE user_id = ?').run(sentinelId);
    sdb.close();
  });

  // ── Smart playlist /run preview still works ───────────────────────

  test('Smart playlist /run preview returns catalog rows in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/smart-playlists/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, sort: 'artist', limit: 100 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.songs));
    assert.equal(body.songs.length, 1, 'seeded track should be returned');
  });
});

// ────────────────────────────────────────────────────────────────────

describe('public-mode contract: sentinel-as-operator for third-party scrobbling', () => {
  // Public-mode operators (single-user docker setups) link a
  // ListenBrainz token or Last.fm account, and from then on plays go
  // out under that identity — same model as sentinel-backed playlists,
  // ratings, and play counts. The credential-management endpoints
  // (/connect, /disconnect) are admin-gated so a viewer in adminLocked
  // public mode can't overwrite the operator's stored credentials.

  let tmpDir;
  let server;
  let dbPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-creds-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    dbPath = path.join(tmpDir, 'db', 'mstream.db');

    server = await bootMstream(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── ListenBrainz: sentinel-stored token IS reported as linked ────

  test('ListenBrainz /status reports linked=true when the sentinel has a token', async () => {
    {
      const sdb = new DatabaseSync(dbPath);
      sdb.prepare(
        `UPDATE users SET listenbrainz_token = 'op-token' WHERE is_anonymous_sentinel = 1`
      ).run();
      sdb.close();
    }
    db_invalidateCacheViaHTTP(); // see helper below
    // We can't trigger db.invalidateCache() from outside the process,
    // so /status's `SELECT … FROM users WHERE id = ?` is the canonical
    // read here — it goes straight to the DB and sidesteps the cache.

    const r = await fetch(`${server.baseUrl}/api/v1/listenbrainz/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.linked, true, 'sentinel-stored token must surface as linked');

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare(`UPDATE users SET listenbrainz_token = NULL WHERE is_anonymous_sentinel = 1`).run();
    sdb.close();
  });

  // ── Last.fm: /connect saves creds to the sentinel for the operator ────

  test('Last.fm /connect persists creds to the sentinel in public mode', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastfmUser: 'op-account', lastfmPassword: 'op-pw' }),
    });
    assert.equal(r.status, 200, 'admin operator (public mode + adminLocked=false) should be able to link Last.fm');

    const u = dbValue(dbPath, 'SELECT lastfm_user, lastfm_password FROM users WHERE is_anonymous_sentinel = 1');
    assert.equal(u.lastfm_user, 'op-account');
    assert.equal(u.lastfm_password, 'op-pw');

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare(`UPDATE users SET lastfm_user = NULL, lastfm_password = NULL WHERE is_anonymous_sentinel = 1`).run();
    sdb.close();
  });
});

// Helper: place-holder no-op (the sentinel's listenbrainz_token is read
// straight from the DB by the handler — we only need to keep the test
// body readable about the cache-vs-DB distinction).
function db_invalidateCacheViaHTTP() { /* no-op — handler reads DB */ }

// ────────────────────────────────────────────────────────────────────

describe('public-mode contract: adminLocked blocks credential changes', () => {
  // Read-only public deployments (config.lockAdmin = true) demote the
  // sentinel-pinned req.user to admin=false. The credential-management
  // endpoints reject writes in that mode so a viewer can't overwrite
  // the operator's stored Last.fm / ListenBrainz credentials.

  let tmpDir;
  let server;
  let dbPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-locked-'));
    const musicDir = path.join(tmpDir, 'music');
    await fs.mkdir(musicDir, { recursive: true });
    dbPath = path.join(tmpDir, 'db', 'mstream.db');

    server = await bootMstreamLocked(tmpDir, musicDir);
  });

  after(async () => {
    if (server?.proc) await killProc(server.proc);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Last.fm /connect rejects writes when adminLocked=true', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastfmUser: 'viewer-leak', lastfmPassword: 'viewer-leak' }),
    });
    assert.equal(r.status, 403, 'adminLocked public mode must reject credential writes');

    const u = dbValue(dbPath, 'SELECT lastfm_user, lastfm_password FROM users WHERE is_anonymous_sentinel = 1');
    assert.equal(u.lastfm_user, null);
    assert.equal(u.lastfm_password, null);
  });

  test('ListenBrainz /connect rejects writes when adminLocked=true', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/listenbrainz/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lbToken: 'viewer-leak' }),
    });
    assert.equal(r.status, 403, 'adminLocked public mode must reject credential writes');

    const u = dbValue(dbPath, 'SELECT listenbrainz_token FROM users WHERE is_anonymous_sentinel = 1');
    assert.equal(u.listenbrainz_token, null);
  });

  test('Last.fm /disconnect rejects when adminLocked=true', async () => {
    // Pre-seed creds the way an operator might have left them before
    // locking the admin API. Disconnect (which clears the column)
    // must refuse to wipe them under adminLocked.
    {
      const sdb = new DatabaseSync(dbPath);
      sdb.prepare(`UPDATE users SET lastfm_user = 'op', lastfm_password = 'op' WHERE is_anonymous_sentinel = 1`).run();
      sdb.close();
    }

    const r = await fetch(`${server.baseUrl}/api/v1/lastfm/disconnect`, { method: 'POST' });
    assert.equal(r.status, 403);

    const u = dbValue(dbPath, 'SELECT lastfm_user FROM users WHERE is_anonymous_sentinel = 1');
    assert.equal(u.lastfm_user, 'op', 'creds must survive viewer disconnect attempt');

    // Cleanup
    const sdb = new DatabaseSync(dbPath);
    sdb.prepare(`UPDATE users SET lastfm_user = NULL, lastfm_password = NULL WHERE is_anonymous_sentinel = 1`).run();
    sdb.close();
  });
});

// Variant of bootMstream that flips lockAdmin=true so the public-mode
// req.user lands with admin=false — i.e. the read-only-viewer profile.
async function bootMstreamLocked(tmpDir, musicDir) {
  const port = await findFreePort();
  const config = {
    port,
    address: '127.0.0.1',
    ui: 'velvet',
    lockAdmin: true,
    dlna:     { mode: 'disabled' },
    subsonic: { mode: 'disabled' },
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
