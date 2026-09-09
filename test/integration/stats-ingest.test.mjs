/**
 * POST /api/v1/stats/plays against a real server (src/api/stats.js).
 *
 * Pattern mirrors test/integration/db-stats.test.mjs: boot mStream in
 * public/no-users mode with an empty library, stop it, seed tracks straight
 * into the DB, boot again, hit the HTTP API. No media fixtures, so no ffmpeg.
 *
 * Locks in: the per-play answer shape, that counted plays reach the legacy
 * most-played / recently-played reads (the counters they run on), that a
 * replay is acknowledged and inert, that a short skip is kept without
 * counting, the Joi 400s (unknown key, empty batch, bad enum), and that the
 * route is not on the federation allowlist.
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

import { isFederationRouteAllowed } from '../../src/api/federation-auth.js';

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
    stats: { playThresholdMs: 30000, playThresholdFraction: 0.5, retentionMonths: 0 },
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

async function post(baseUrl, route, body) {
  const r = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 70, 'V70+ applied at boot');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Radiohead')").run().lastInsertRowid);
  const alid = Number(db.prepare("INSERT INTO albums (name, artist_id, year) VALUES ('OK Computer', ?, 1997)").run(aid).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, file_hash, audio_hash, duration, modified, scan_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'seed')`);
  ins.run('Let Down.flac', lib, 'Let Down', aid, alid, 'fhA', 'ahA', 299);
  ins.run('Karma Police.flac', lib, 'Karma Police', aid, alid, 'fhB', 'ahB', 264);
  db.close();
}

const play = (over = {}) => ({
  id: 'p1', filePath: 'testlib/Let Down.flac', startedAt: '2026-09-09T11:00:00Z',
  playedMs: 240000, outcome: 'completed', source: 'manual', ...over,
});

describe('POST /api/v1/stats/plays', () => {
  let tmpDir, server;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-ingest-'));
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

  test('a batch is answered per play and reaches the counters the legacy reads run on', async () => {
    const r = await post(server.baseUrl, '/api/v1/stats/plays', {
      client: { name: 'mstream-music', version: '0.36.0' },
      plays: [
        play(),
        play({ id: 'p2', filePath: 'testlib/Karma Police.flac', playedMs: 8000, outcome: 'skipped', startedAt: '2026-09-09T11:05:00Z' }),
        play({ id: 'p3', startedAt: '2026-09-09T11:06:00Z' }),
        play({ id: 'p4', filePath: 'testlib/Nope.flac' }),
      ],
    });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body, { accepted: ['p1', 'p2', 'p3'], duplicates: [], rejected: [{ id: 'p4', reason: 'unknown-track' }] });

    const most = await post(server.baseUrl, '/api/v1/db/stats/most-played', { limit: 10 });
    assert.equal(most.status, 200, most.body);
    assert.deepEqual(most.body.map((x) => [x.metadata.title, x.metadata['play-count']]), [['Let Down', 2]]);
    const recent = await post(server.baseUrl, '/api/v1/db/stats/recently-played', { limit: 10 });
    assert.deepEqual(recent.body.map((x) => x.metadata.title), ['Let Down']); // the skip never set last_played
    assert.equal(recent.body[0].metadata['last-played'], '2026-09-09 11:06:00.000');
  });

  test('a replay is acknowledged and moves nothing', async () => {
    const r = await post(server.baseUrl, '/api/v1/stats/plays', { plays: [play({ playedMs: 1 }), play({ id: 'p3' })] });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.body, { accepted: [], duplicates: ['p1', 'p3'], rejected: [] });
    const most = await post(server.baseUrl, '/api/v1/db/stats/most-played', { limit: 10 });
    assert.equal(most.body[0].metadata['play-count'], 2);
  });

  test('validation: an unknown key, an empty batch and a bad enum are 400s the app can parse', async () => {
    const unknown = await post(server.baseUrl, '/api/v1/stats/plays', { plays: [play({ bogus: 1 })] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /bogus.* is not allowed/);
    assert.equal((await post(server.baseUrl, '/api/v1/stats/plays', { plays: [] })).status, 400);
    assert.equal((await post(server.baseUrl, '/api/v1/stats/plays', { plays: [play({ outcome: 'vanished' })] })).status, 400);
    assert.equal((await post(server.baseUrl, '/api/v1/stats/plays', { plays: [play({ source: 'legacy' })] })).status, 400);
    assert.equal((await post(server.baseUrl, '/api/v1/stats/plays', {})).status, 400);
  });

  test('the route is not on the federation allowlist', () => {
    assert.equal(isFederationRouteAllowed('POST', '/api/v1/stats/plays'), false);
  });
});
