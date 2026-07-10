/**
 * Tests for the two DB-backed helpers torrent code consumes:
 *
 *   - src/torrent/managed-torrents.js — getByHashes / getByInfoHash /
 *     deleteOne / deleteByVpath. These back the admin list endpoint,
 *     the delete-torrent route, and the orphan-cleanup on library
 *     removal.
 *   - src/torrent/vpath-access-cache.js — upsert / getOne / getAllForClient /
 *     markPending / deleteByVpath, with the MANUAL-wins invariant.
 *
 * Bootstraps a temp SQLite DB with every migration applied, points
 * src/db/manager.js at it, then exercises the helpers in-process.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir, db;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-torrent-db-'));
  fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory:         path.join(tmpDir, 'db'),
      albumArtDirectory:   path.join(tmpDir, 'art'),
      logsDirectory:       path.join(tmpDir, 'logs'),
    },
    port: 0,
  }, null, 2));
  // Use the canonical bootstrap path — config.setup, then initDB.
  // This is what every other DB-backed test does (see test/task-
  // queue.test.mjs); it runs the migration loop in src/db/manager.js
  // so we don't have to keep test schema in lock-step manually.
  const config = await import('../../src/state/config.js');
  await config.setup(path.join(tmpDir, 'config.json'));
  const dbManager = await import('../../src/db/manager.js');
  dbManager.initDB();
  db = dbManager;
});

after(async () => {
  try { db.getDB()?.close?.(); } catch { /* may not expose close */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
  // Force exit — config.setup pulls in modules with module-level
  // intervals (winston rotation timer, etc.) that keep the event
  // loop alive past the test run. The test runner waits for the
  // process to exit on its own, which adds ~30s of dead time per
  // file. Other DB-backed tests (task-queue.test.mjs) hit the same
  // case and accept the trailing delay; we exit explicitly to keep
  // the suite fast.
  setImmediate(() => process.exit(0));
});

// Seed a known library + user that the helpers can FK against.
beforeEach(() => {
  const d = db.getDB();
  d.exec("DELETE FROM managed_torrents");
  d.exec("DELETE FROM torrent_client_vpath_access");
  d.exec("DELETE FROM users WHERE username != '__mstream_anonymous__'");
  d.exec("DELETE FROM libraries");
  d.prepare(
    "INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, 'music', 0)"
  ).run('music', '/tmp/music-fixture');
  d.prepare(
    "INSERT INTO libraries (name, root_path, type, follow_symlinks) VALUES (?, ?, 'music', 0)"
  ).run('testlib', '/tmp/testlib-fixture');
  d.prepare(
    "INSERT INTO users (username, password, salt, is_admin) VALUES ('tester', 'x', 'y', 1)"
  ).run();
});

// ────────────────────────────────────────────────────────────────────
// managed-torrents.js
// ────────────────────────────────────────────────────────────────────
describe('managed_torrents helpers', () => {
  let mt;
  before(async () => { mt = await import('../../src/torrent/managed-torrents.js'); });

  function seed(hash, clientType = 'deluge', vpath = 'music') {
    const u = db.getDB().prepare("SELECT id FROM users WHERE username = 'tester'").get();
    db.getDB().prepare(`
      INSERT INTO managed_torrents (info_hash, client_type, user_id, vpath, added_at, download_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hash, clientType, u.id, vpath, 1000, `/downloads/${vpath}/${hash.slice(0,8)}`);
  }

  test('getByInfoHash returns null when nothing seeded', () => {
    assert.equal(mt.getByInfoHash('aa'.repeat(20)), null);
  });
  test('getByInfoHash returns the row when present', () => {
    const hash = '08ada5a7a6183aae1e09d831df6748d566095a10';
    seed(hash, 'deluge', 'music');
    const r = mt.getByInfoHash(hash);
    assert.equal(r.infoHash, hash);
    assert.equal(r.clientType, 'deluge');
    assert.equal(r.vpath, 'music');
    assert.match(r.downloadPath, /^\/downloads\/music\//);
  });
  test('getByInfoHash is case-insensitive on input', () => {
    const hash = 'aa11bb22cc33dd44ee55ff66aabbccddeeff0011';
    seed(hash);
    assert.equal(mt.getByInfoHash(hash.toUpperCase())?.infoHash, hash);
  });

  test('getByHashes batches per-client', () => {
    seed('aa'.repeat(20), 'deluge', 'music');
    seed('bb'.repeat(20), 'deluge', 'music');
    seed('cc'.repeat(20), 'qbittorrent', 'music');  // cross-client; must NOT match
    const out = mt.getByHashes(['aa'.repeat(20), 'bb'.repeat(20), 'cc'.repeat(20)], 'deluge');
    assert.equal(out.size, 2);
    assert.ok(out.has('aa'.repeat(20)));
    assert.ok(out.has('bb'.repeat(20)));
    assert.equal(out.has('cc'.repeat(20)), false, 'cross-client lookups must not bleed');
  });
  test('getByHashes throws when clientType is missing', () => {
    assert.throws(() => mt.getByHashes(['x'], ''), /clientType is required/);
  });

  test('deleteOne removes only the (hash, client) pair', () => {
    seed('aa'.repeat(20), 'deluge');
    seed('aa'.repeat(20), 'transmission');  // same hash, different client
    assert.equal(mt.deleteOne('aa'.repeat(20), 'deluge'), 1);
    // Transmission row survives
    assert.equal(mt.deleteOne('aa'.repeat(20), 'transmission'), 1);
    // Second delete is a no-op
    assert.equal(mt.deleteOne('aa'.repeat(20), 'deluge'), 0);
  });

  test('deleteByVpath drops all rows for the vpath', () => {
    seed('aa'.repeat(20), 'deluge', 'music');
    seed('bb'.repeat(20), 'deluge', 'music');
    seed('cc'.repeat(20), 'deluge', 'testlib');
    assert.equal(mt.deleteByVpath('music'), 2);
    assert.equal(mt.getByInfoHash('cc'.repeat(20))?.vpath, 'testlib');
  });
  test('deleteByVpath returns 0 for unknown vpath', () => {
    assert.equal(mt.deleteByVpath('nonexistent'), 0);
  });
});

// ────────────────────────────────────────────────────────────────────
// vpath-access-cache.js
// ────────────────────────────────────────────────────────────────────
describe('vpath-access-cache', () => {
  let cache;
  before(async () => { cache = await import('../../src/torrent/vpath-access-cache.js'); });

  function makeResult(opts = {}) {
    return {
      confidence:      opts.confidence || 'inferred',
      method:          opts.method     || 'test-method',
      verified:        opts.verified   ?? true,
      daemonPath:      opts.daemonPath || '/downloads/music',
      mstreamWritable: opts.mstreamWritable ?? true,
      reason:          opts.reason || null,
      source:          opts.source || undefined,
    };
  }

  test('upsert + getOne round-trip', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult(), source: 'auto',
    });
    const r = cache.getOne('deluge', 'music');
    assert.equal(r.confidence, 'inferred');
    assert.equal(r.daemonPath, '/downloads/music');
    assert.equal(r.source, 'auto');
  });

  test('getOne returns null when absent', () => {
    assert.equal(cache.getOne('deluge', 'never-seen'), null);
  });

  test('MANUAL-wins: auto write cannot overwrite manual row', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult({ daemonPath: '/manual/path' }),
      source: 'manual',
    });
    const before = cache.getOne('deluge', 'music');
    assert.equal(before.source, 'manual');
    // Auto-sweep arrives next; should NOT overwrite the manual row.
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult({ daemonPath: '/auto/path' }),
      source: 'auto',
    });
    const after = cache.getOne('deluge', 'music');
    assert.equal(after.source, 'manual', 'manual entry must persist');
    assert.equal(after.daemonPath, '/manual/path');
  });

  test('manual-over-manual DOES overwrite (operator update wins)', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult({ daemonPath: '/v1' }), source: 'manual',
    });
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult({ daemonPath: '/v2' }), source: 'manual',
    });
    assert.equal(cache.getOne('deluge', 'music').daemonPath, '/v2');
  });

  test('markPending: writes a pending row preserving prior daemon_path', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult({ daemonPath: '/downloads/music' }),
      source: 'auto',
    });
    cache.markPending('deluge', 'music');
    const r = cache.getOne('deluge', 'music');
    assert.equal(r.confidence, 'pending');
    assert.equal(r.daemonPath, '/downloads/music', 'prior path should survive the pending write');
    assert.equal(r.lastError, null);
  });

  test('markPending is a no-op against a manual row', () => {
    cache.upsert({
      clientType: 'deluge', vpathName: 'music',
      result: makeResult(), source: 'manual',
    });
    cache.markPending('deluge', 'music');
    const r = cache.getOne('deluge', 'music');
    assert.equal(r.confidence, 'inferred', 'manual stickiness defeats pending');
  });

  test('getAllForClient returns every row for a client', () => {
    cache.upsert({ clientType: 'deluge', vpathName: 'music',   result: makeResult(), source: 'auto' });
    cache.upsert({ clientType: 'deluge', vpathName: 'testlib', result: makeResult({ daemonPath: '/downloads/testlib' }), source: 'auto' });
    cache.upsert({ clientType: 'transmission', vpathName: 'music', result: makeResult(), source: 'auto' });
    const out = cache.getAllForClient('deluge');
    assert.equal(Object.keys(out).length, 2);
    assert.ok(out.music);
    assert.ok(out.testlib);
  });

  test('deleteByVpath drops every row for a vpath across clients', () => {
    cache.upsert({ clientType: 'deluge',       vpathName: 'music', result: makeResult(), source: 'auto' });
    cache.upsert({ clientType: 'transmission', vpathName: 'music', result: makeResult(), source: 'auto' });
    cache.upsert({ clientType: 'deluge',       vpathName: 'testlib', result: makeResult(), source: 'auto' });
    cache.deleteByVpath('music');
    assert.equal(cache.getOne('deluge', 'music'), null);
    assert.equal(cache.getOne('transmission', 'music'), null);
    assert.ok(cache.getOne('deluge', 'testlib'), 'unrelated vpaths must survive');
  });
});
