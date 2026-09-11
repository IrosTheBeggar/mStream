/**
 * Stats API v2 — the admin's listening-history settings: GET /api/v1/admin/stats
 * (config + log facts), the live retention and threshold edits (saved to the
 * config file, applied to the next sweep / the next batch), prune-now, the
 * enrichment pass with no peers, validation, and the admin gate.
 *
 * Same harness as stats-lifecycle.test.mjs: mStream boots in public/no-users
 * mode (the sentinel user is admin) with an empty library, is stopped, tracks
 * are seeded straight into the database, and it boots again.
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
  const configPath = path.join(tmpDir, 'config.json');
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch { config = null; }
  if (!config) {
    config = {
      port, address: '127.0.0.1',
      dlna: { mode: 'disabled' },
      folders: { testlib: { root: musicDir } },
      storage: { albumArtDirectory: path.join(tmpDir, 'image-cache'), dbDirectory: path.join(tmpDir, 'db'), logsDirectory: path.join(tmpDir, 'logs') },
      scanOptions: { bootScanDelay: 9999, scanInterval: 0, autoAlbumArt: false },
      stats: { playThresholdMs: 30000, playThresholdFraction: 0.5, retentionMonths: 24 },
    };
    for (const dir of Object.values(config.storage)) await fs.mkdir(dir, { recursive: true });
  } else {
    config.port = port;
  }
  await fs.writeFile(configPath, JSON.stringify(config));
  const proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForReady(baseUrl); } catch (err) { try { proc.kill('SIGKILL'); } catch { /* gone */ } throw err; }
  return { proc, baseUrl, configPath };
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
  db.prepare(`INSERT INTO tracks (filepath, library_id, title, artist_id, file_hash, audio_hash, duration, modified, scan_id)
              VALUES ('Song A.flac', ?, 'Song A', ?, 'fhA', 'ahA', 200, 1, 'seed')`).run(lib, aid);
  db.close();
}
const play = (id, startedAt, over = {}) => ({ id, filePath: 'testlib/Song A.flac', startedAt, playedMs: 150000, outcome: 'completed', source: 'manual', ...over });
const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };

describe('Stats API v2 — admin listening-history settings', () => {
  let tmpDir, server, dbPath;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-stats-admin-'));
    const musicDir = path.join(tmpDir, 'music'); await fs.mkdir(musicDir);
    server = await boot(tmpDir, musicDir);
    await kill(server.proc);
    dbPath = path.join(tmpDir, 'db', 'mstream.db');
    seed(dbPath);
    server = await boot(tmpDir, musicDir);
  });
  after(async () => {
    if (server) await kill(server.proc);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('GET: the live config block and the shape of an empty log', async () => {
    const r = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.retentionMonths, 24);
    assert.equal(r.body.playThresholdMs, 30000);
    assert.equal(r.body.playThresholdFraction, 0.5);
    assert.deepEqual(r.body.log, { total: 0, oldest: null, newest: null, users: 0, peerEvents: 0, thinPeerEvents: 0 });
    const floor = new Date(r.body.retention.floor);
    assert.ok(Math.abs(floor.getTime() - new Date(monthsAgo(24)).getTime()) < 36 * 3600_000, 'floor ≈ 24 months back');
    assert.equal(r.body.retention.lastSweep, null, 'the boot sweep waits a minute');
    assert.deepEqual(r.body.enrichment, { enriched: 0, rekeyed: 0, unknown: 0, failed: 0, lastRunAt: null, lastError: null, pending: 0 });
  });

  test('retention: saved to the config file, applied by prune-now, reported by GET', async () => {
    const posted = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', {
      client: { name: 'test', version: '1' },
      plays: [play('old', monthsAgo(3)), play('fresh', new Date(Date.now() - 60_000).toISOString())],
    });
    assert.deepEqual(posted.body.accepted, ['old', 'fresh']);
    let g = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.equal(g.body.log.total, 2);
    assert.equal(g.body.log.users, 1);

    const set = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/retention', { retentionMonths: 1 });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body, { retentionMonths: 1 });
    const onDisk = JSON.parse(await fs.readFile(server.configPath, 'utf8'));
    assert.equal(onDisk.stats.retentionMonths, 1, 'persisted for the next boot');
    g = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.equal(g.body.retentionMonths, 1);
    assert.ok(new Date(g.body.retention.floor).getTime() > Date.now() - 45 * 86400_000, 'floor moved to a month back');

    const sweep = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/sweep', {});
    assert.equal(sweep.status, 200, sweep.text);
    assert.equal(sweep.body.deleted, 1);
    assert.ok(sweep.body.cutoff);
    g = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.equal(g.body.log.total, 1);
    assert.equal(g.body.retention.lastSweep.deleted, 1);
    assert.ok(g.body.retention.lastSweep.at);
    const h = await call(server.baseUrl, 'GET', '/api/v1/stats/history?limit=5');
    assert.deepEqual(h.body.items.map((i) => i.id), ['fresh']);
  });

  test('thresholds: saved, and the next batch of plays is judged by them', async () => {
    const before = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', {
      client: { name: 'test', version: '1' },
      plays: [play('short-before', new Date(Date.now() - 50_000).toISOString(), { playedMs: 12000, outcome: 'skipped' })],
    });
    assert.deepEqual(before.body.accepted, ['short-before']);
    let h = await call(server.baseUrl, 'GET', '/api/v1/stats/history?track=ahA&limit=1');
    assert.equal(h.body.items[0].counted, false, '12 s of a 200 s track: under both defaults');

    const set = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/thresholds', { playThresholdMs: 10000, playThresholdFraction: 0.25 });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body, { playThresholdMs: 10000, playThresholdFraction: 0.25 });
    const onDisk = JSON.parse(await fs.readFile(server.configPath, 'utf8'));
    assert.deepEqual([onDisk.stats.playThresholdMs, onDisk.stats.playThresholdFraction], [10000, 0.25]);

    const after = await call(server.baseUrl, 'POST', '/api/v1/stats/plays', {
      client: { name: 'test', version: '1' },
      plays: [play('short-after', new Date(Date.now() - 40_000).toISOString(), { playedMs: 12000, outcome: 'skipped' })],
    });
    assert.deepEqual(after.body.accepted, ['short-after']);
    h = await call(server.baseUrl, 'GET', '/api/v1/stats/history?track=ahA&limit=1');
    assert.equal(h.body.items[0].id, 'short-after');
    assert.equal(h.body.items[0].counted, true, '12 s clears the new 10 s rule');
    const g = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.deepEqual([g.body.playThresholdMs, g.body.playThresholdFraction], [10000, 0.25]);
  });

  test('the enrichment pass with no peers queues nothing', async () => {
    const r = await call(server.baseUrl, 'POST', '/api/v1/admin/stats/enrich', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.queued, 0);
    assert.equal(r.body.pending, 0);
  });

  test('validation: out-of-range or malformed settings are refused', async () => {
    for (const [route, body] of [
      ['/api/v1/admin/stats/retention', { retentionMonths: -1 }],
      ['/api/v1/admin/stats/retention', { retentionMonths: 'x' }],
      ['/api/v1/admin/stats/retention', {}],
      ['/api/v1/admin/stats/thresholds', { playThresholdMs: 1000, playThresholdFraction: 1.5 }],
      ['/api/v1/admin/stats/thresholds', { playThresholdMs: -5, playThresholdFraction: 0.5 }],
      ['/api/v1/admin/stats/thresholds', { playThresholdMs: 1000 }],
    ]) {
      const r = await call(server.baseUrl, 'POST', route, body);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} → ${r.status}`);
    }
    const g = await call(server.baseUrl, 'GET', '/api/v1/admin/stats');
    assert.deepEqual([g.body.retentionMonths, g.body.playThresholdMs, g.body.playThresholdFraction], [1, 10000, 0.25], 'nothing changed');
  });

  test('a non-admin user is refused on every admin route (ends public mode — last)', async () => {
    const mk = await call(server.baseUrl, 'PUT', '/api/v1/admin/users', { username: 'plain', password: 'plain-pw', vpaths: ['testlib'], admin: false });
    assert.equal(mk.status, 200, mk.text);
    const login = await call(server.baseUrl, 'POST', '/api/v1/auth/login', { username: 'plain', password: 'plain-pw' });
    const token = login.body.token;
    assert.ok(token);
    for (const [method, route, body] of [
      ['GET', '/api/v1/admin/stats', undefined],
      ['POST', '/api/v1/admin/stats/retention', { retentionMonths: 2 }],
      ['POST', '/api/v1/admin/stats/thresholds', { playThresholdMs: 1, playThresholdFraction: 0 }],
      ['POST', '/api/v1/admin/stats/sweep', {}],
      ['POST', '/api/v1/admin/stats/enrich', {}],
    ]) {
      const r = await call(server.baseUrl, method, route, body, { 'x-access-token': token });
      assert.equal(r.status, 403, `${method} ${route} → ${r.status}`);
    }
  });
});
