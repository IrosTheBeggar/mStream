/**
 * Integration tests for the music-discovery data admin surface:
 *
 *   POST /api/v1/admin/db/params/collect-discovery-data   opt-in toggle;
 *                                                         ON creates discovery.db
 *   POST /api/v1/admin/db/discovery-export                build snapshot, returns manifest
 *   GET  /api/v1/admin/db/discovery-export/manifest       current manifest
 *   GET  /api/v1/admin/db/discovery-export/download       the snapshot file (Range-capable)
 *
 * Two servers: one booted with the feature at its default (OFF) to prove the
 * opt-in flow and the 404s, one booted with collectDiscoveryData already ON
 * to prove boot-time initialization and a real data round-trip (rows seeded
 * directly into discovery.db, then pulled back out through the export
 * endpoints and verified byte-for-byte).
 *
 * Both run in public mode (no users) — admin endpoints are unauthenticated
 * there, and the auth gate for /api/v1/admin/* has its own suite
 * (admin-access.test.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('discovery export — feature off by default, opt-in via admin', () => {
  let server;
  const discoveryDbFile = () => path.join(server.tmpDir, 'db', 'discovery.db');

  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('collectDiscoveryData defaults to false and no discovery.db exists', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/params`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).collectDiscoveryData, false);
    assert.ok(!fs.existsSync(discoveryDbFile()), 'no discovery.db before opt-in');
  });

  test('export surface 404s before the feature was ever enabled', async () => {
    const build = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' });
    assert.equal(build.status, 404);
    const manifest = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/manifest`);
    assert.equal(manifest.status, 404);
    const download = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/download`);
    assert.equal(download.status, 404);
  });

  test('toggle validation: non-boolean is a 400', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/params/collect-discovery-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectDiscoveryData: 'yes please' }),
    });
    assert.equal(r.status, 400);
  });

  test('enabling creates discovery.db and persists to config.json', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/params/collect-discovery-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectDiscoveryData: true }),
    });
    assert.equal(r.status, 200);

    assert.ok(fs.existsSync(discoveryDbFile()), 'discovery.db created on enable');

    const params = await (await fetch(`${server.baseUrl}/api/v1/admin/db/params`)).json();
    assert.equal(params.collectDiscoveryData, true);

    const savedConfig = JSON.parse(
      fs.readFileSync(path.join(server.tmpDir, 'config.json'), 'utf8'));
    assert.equal(savedConfig.scanOptions.collectDiscoveryData, true,
      'setting persisted for the next boot');
  });

  test('empty store exports a valid zero-row snapshot', async () => {
    const build = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' });
    assert.equal(build.status, 200);
    const manifest = await build.json();
    assert.equal(manifest.format, 'mstream-discovery-snapshot');
    assert.equal(manifest.rowCount, 0);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);

    const served = await (await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/manifest`)).json();
    assert.deepEqual(served, manifest, 'GET manifest returns what the build reported');

    const download = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, manifest.sizeBytes);
    assert.equal(sha256(bytes), manifest.sha256);
  });

  test('disabling keeps the data on disk (purge is a manual, explicit act)', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/params/collect-discovery-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectDiscoveryData: false }),
    });
    assert.equal(r.status, 200);
    const params = await (await fetch(`${server.baseUrl}/api/v1/admin/db/params`)).json();
    assert.equal(params.collectDiscoveryData, false);
    assert.ok(fs.existsSync(discoveryDbFile()), 'existing data survives disable');
  });
});

describe('discovery export — enabled at boot, real data round-trip', () => {
  let server;
  let snapshotBytes;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      extraConfig: { scanOptions: { collectDiscoveryData: true } },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('boot with the flag on initializes discovery.db', () => {
    assert.ok(fs.existsSync(path.join(server.tmpDir, 'db', 'discovery.db')));
  });

  test('seeded rows travel through export → download, cleaned and ordered', async () => {
    // Seed through a second connection, the same way any external writer
    // would; insert order deliberately differs from export_id order.
    const embedding = Buffer.from(new Float32Array([0.25, -1, 0.5]).buffer);
    const db = new DatabaseSync(path.join(server.tmpDir, 'db', 'discovery.db'));
    try {
      const ins = db.prepare(`
        INSERT INTO discovery_tracks
          (audio_hash, source_mtime, updated_at, export_id, artist, title, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      ins.run('local-hash-b', 42, 1, 'mbid:zzz-sorts-last', 'B Artist', 'B Song', null);
      ins.run('local-hash-a', 43, 2, 'anon:aaa-sorts-first', 'A Artist', 'A Song', embedding);
      db.prepare(
        'INSERT INTO discovery_lookups (audio_hash, last_attempt_at, outcome) VALUES (?, ?, ?)'
      ).run('local-hash-c', Date.now(), 'error');
    } finally {
      db.close();
    }

    const build = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' });
    assert.equal(build.status, 200);
    const manifest = await build.json();
    assert.equal(manifest.rowCount, 2);

    const download = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/download`);
    assert.equal(download.status, 200);
    snapshotBytes = Buffer.from(await download.arrayBuffer());
    assert.equal(sha256(snapshotBytes), manifest.sha256);

    // Crack the snapshot open and verify the share-safe contract.
    const snapFile = path.join(server.tmpDir, 'downloaded-snapshot.db');
    fs.writeFileSync(snapFile, snapshotBytes);
    const snap = new DatabaseSync(snapFile, { readOnly: true });
    try {
      const tables = snap.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map(r => r.name);
      assert.deepEqual(tables, ['meta', 'tracks'], 'no internal tables in the snapshot');

      const cols = snap.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
      assert.ok(!cols.includes('audio_hash'), 'raw local hash must not travel');
      assert.ok(!cols.includes('source_mtime'));
      assert.ok(!cols.includes('updated_at'));

      const rows = snap.prepare('SELECT export_id, artist, embedding FROM tracks').all();
      assert.deepEqual(rows.map(r => r.export_id),
        ['anon:aaa-sorts-first', 'mbid:zzz-sorts-last'],
        'deterministic export_id ordering regardless of insert order');
      const embOut = Uint8Array.from(rows[0].embedding);
      assert.deepEqual(Array.from(new Float32Array(embOut.buffer, 0, 3)), [0.25, -1, 0.5]);

      const metaKeys = snap.prepare('SELECT key FROM meta').all().map(r => r.key);
      assert.ok(!metaKeys.includes('export_salt'), 'salt is a secret');
    } finally {
      snap.close();
    }
  });

  test('download supports HTTP Range (resumable pulls)', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export/download`, {
      headers: { Range: 'bytes=0-99' },
    });
    assert.equal(r.status, 206);
    const part = Buffer.from(await r.arrayBuffer());
    assert.equal(part.length, 100);
    assert.deepEqual(part, snapshotBytes.subarray(0, 100),
      'partial content matches the full snapshot bytes');
  });
});
