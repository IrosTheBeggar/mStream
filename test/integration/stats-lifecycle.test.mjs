/**
 * Stats API v2 lifecycle against a real server: the capability flag, the
 * scrobble shim through the shared write, the management routes, the
 * export stream, the admin rebuild and its gate.
 *
 * Same pattern as stats-api.test.mjs: boot mStream in public/no-users mode
 * with an empty library, stop it, seed tracks straight into the DB, boot
 * again, drive HTTP. The last test creates a user, which ends public mode,
 * so it stays last.
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
    storage: { albumArtDirectory: path.join(tmpDir, 'image-cache'), dbDirectory: path.join(tmpDir, 'db'), logsDirectory: path.join(tmpDir, 'logs') },
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

function seed(dbPath) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys = ON');
  const lib = db.prepare("SELECT id FROM libraries WHERE name='testlib'").get().id;
  const aid = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist')").run().lastInsertRowid);
  const ins = db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, file_hash, audio_hash, duration, modified, scan_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed')`);
  ins.run('Song A.flac', lib, 'Song A', aid, 'fhA', 'ahA', 200);
  ins.run('Song B.flac', lib, 'Song B', aid, 'fhB', 'ahB', 180);
  db.close();
}

const play = (id, filePath, startedAt, over = {}) => ({ id, filePath, startedAt, playedMs: 150000, outcome: 'completed', source: 'manual', ...over });

describe('Stats API v2 — lifecycle', () => {
  let tmpDir, server;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-stats-life-'));
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

  test('the capability flag is advertised', async () => {
    const r = await call(server.baseUrl, 'GET', '/api/');
    assert.equal(r.status, 200);
    assert.equal(r.body.features.stats, 2);
  });

  test('the scrobble shim records a counted legacy event through the shared write, once', async () => {
    const r = await call(server.baseUrl, 'POST', '/api/v1/lastfm/scrobble-by-filepath', { filePath: 'testlib/Song B.flac' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, {});
    const h = await call(server.baseUrl, 'GET', '/api/v1/stats/history?track=ahB');
    assert.equal(h.body.items.length, 1);
    const e = h.body.items[0];
    assert.equal(e.source, 'legacy');
    assert.equal(e.client, 'legacy');
    assert.equal(e.counted, true);
    assert.equal(e.playedMs, 30000);
    assert.equal(e.durationMs, 180000);
    const m = await call(server.baseUrl, 'POST', '/api/v1/db/metadata', { filepath: 'testlib/Song B.flac' });
    assert.equal(m.body.metadata['play-count'], 1);
    const unknown = await call(server.baseUrl, 'POST', '/api/v1/lastfm/scrobble-by-filepath', { filePath: 'testlib/Nope.flac' });
    assert.deepEqual(unknown.body, { scrobble: false });
  });

  test('delete one play, then a range; counters follow', async () => {
    const ing = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', { plays: [
      play('a1', 'testlib/Song A.flac', '2026-09-01T10:00:00Z'),
      play('a2', 'testlib/Song A.flac', '2026-09-02T10:00:00Z'),
      play('a3', 'testlib/Song A.flac', '2026-09-03T10:00:00Z'),
    ] });
    assert.deepEqual(ing.body.accepted, ['a1', 'a2', 'a3']);
    const one = await call(server.baseUrl, 'DELETE', '/api/v1/stats/plays/a2');
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(one.body, { deleted: 1 });
    assert.equal((await call(server.baseUrl, 'DELETE', '/api/v1/stats/plays/a2')).status, 404);
    let m = await call(server.baseUrl, 'POST', '/api/v1/db/metadata', { filepath: 'testlib/Song A.flac' });
    assert.equal(m.body.metadata['play-count'], 2);
    assert.equal(m.body.metadata['last-played'], '2026-09-03 10:00:00.000');
    const range = await call(server.baseUrl, 'DELETE', '/api/v1/stats/plays?from=2026-09-03T00:00:00Z&to=2026-09-04T00:00:00Z');
    assert.deepEqual(range.body, { deleted: 1 });
    m = await call(server.baseUrl, 'POST', '/api/v1/db/metadata', { filepath: 'testlib/Song A.flac' });
    assert.equal(m.body.metadata['play-count'], 1);
    assert.equal(m.body.metadata['last-played'], '2026-09-01 10:00:00.000');
    assert.equal((await call(server.baseUrl, 'DELETE', '/api/v1/stats/plays?from=2026-09-04T00:00:00Z&to=2026-09-03T00:00:00Z')).status, 400);
    assert.equal((await call(server.baseUrl, 'DELETE', '/api/v1/stats/plays')).status, 400);
  });

  test('export streams the log as NDJSON, oldest first', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/stats/export`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.id).slice(-1), ['a1']);
    const a1 = lines.find((l) => l.id === 'a1');
    assert.equal(a1.filePath, 'testlib/Song A.flac');
    assert.equal(a1.trackHash, 'ahA');
    assert.equal(a1.startedAt, '2026-09-01T10:00:00.000Z');
    assert.equal(a1.counted, true);
    const legacy = lines.find((l) => l.source === 'legacy');
    assert.ok(legacy, 'the shim event is in the export');
  });

  test('reset: history keeps counters, counts keeps history, all clears both', async () => {
    const hist = await call(server.baseUrl, 'POST', '/api/v1/stats/reset', { scope: 'history' });
    assert.equal(hist.status, 200, hist.text);
    assert.equal(hist.body.scope, 'history');
    assert.ok(hist.body.events >= 2);
    assert.equal((await call(server.baseUrl, 'GET', '/api/v1/stats/history')).body.items.length, 0);
    let m = await call(server.baseUrl, 'POST', '/api/v1/db/metadata', { filepath: 'testlib/Song A.flac' });
    assert.equal(m.body.metadata['play-count'], 1);
    const counts = await call(server.baseUrl, 'POST', '/api/v1/stats/reset', { scope: 'counts' });
    assert.ok(counts.body.tracks >= 1);
    m = await call(server.baseUrl, 'POST', '/api/v1/db/metadata', { filepath: 'testlib/Song A.flac' });
    assert.equal(m.body.metadata['play-count'], null);
    assert.equal((await call(server.baseUrl, 'POST', '/api/v1/stats/reset', { scope: 'everything' })).status, 400);
    assert.equal((await call(server.baseUrl, 'POST', '/api/v1/stats/reset', {})).status, 400);
  });

  test('admin rebuild rewrites the rollup; public mode is admin', async () => {
    await call(server.baseUrl, 'POST', '/api/v1/stats/plays', { plays: [play('r1', 'testlib/Song A.flac', '2026-09-05T10:00:00Z')] });
    const r = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/rebuild', {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { hours: 1 });
    const ts = await call(server.baseUrl, 'GET', '/api/v1/stats/timeseries?from=2026-09-05T00:00:00Z&to=2026-09-06T00:00:00Z&bucket=day');
    assert.deepEqual(ts.body.items.map((i) => [i.bucket, i.plays]), [['2026-09-05', 1]]);
  });

  test('none of the lifecycle routes is on the federation allowlist', () => {
    for (const [m, p] of [['DELETE', '/api/v1/stats/plays'], ['DELETE', '/api/v1/stats/plays/x'], ['POST', '/api/v1/stats/reset'],
      ['GET', '/api/v1/stats/export'], ['POST', '/api/v1/admin/stats/rebuild']]) {
      assert.equal(isFederationRouteAllowed(m, p), false, `${m} ${p}`);
    }
  });

  test('a non-admin user cannot rebuild, and still sees the flag (ends public mode — last)', async () => {
    const mk = await call(server.baseUrl, 'PUT', '/api/v1/admin/users', { username: 'plain', password: 'plain-pw', vpaths: ['testlib'], admin: false });
    assert.equal(mk.status, 200, mk.text);
    const login = await call(server.baseUrl, 'POST', '/api/v1/auth/login', { username: 'plain', password: 'plain-pw' });
    const token = login.body.token;
    assert.ok(token);
    const denied = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/rebuild', {}, { 'x-access-token': token });
    assert.equal(denied.status, 403);
    const api = await call(server.baseUrl, 'GET', '/api/', undefined, { 'x-access-token': token });
    assert.equal(api.body.features.stats, 2);
    assert.equal((await call(server.baseUrl, 'GET', '/api/v1/stats/export')).status, 401);
  });
});
