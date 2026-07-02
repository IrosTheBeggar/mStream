/**
 * Integration tests for the discovery P2P layer (p2p-sidecar + its admin
 * surface):
 *
 *   GET  /api/v1/admin/discovery/p2p/status    always available, side-effect free
 *   POST /api/v1/admin/discovery/p2p/publish   seed the export snapshot as a blob
 *   POST /api/v1/admin/discovery/p2p/fetch     pull a peer's snapshot by ticket
 *
 * Two layers of coverage:
 *
 *  1. Route gating (always runs, no binary needed): the 403-until-enabled
 *     contract, Joi validation, publish's 404-until-export-built, and the
 *     side-effect-free status shape.
 *
 *  2. The real loop (runs only when a p2p-sidecar binary is present —
 *     prebuilt in bin/p2p-sidecar/ or a local cargo build): boot a server
 *     with the feature on, build a real export snapshot, publish it, then
 *     have a second, raw sidecar process (the "peer") fetch it by ticket and
 *     verify bytes — and the reverse direction, fetching a peer-published
 *     blob through the admin route. Transfers ride the tickets' direct
 *     addresses, so the loop works on loopback without external services.
 *
 * Both suites run in public mode (no users) — the admin auth gate has its
 * own suite (admin-access.test.mjs).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { resolveSidecarBinary } from '../../src/state/discovery-p2p.js';

const SIDECAR_BIN = resolveSidecarBinary();

// Minimal raw-protocol driver for a standalone "peer" sidecar — deliberately
// independent of src/state/discovery-p2p.js (which manages the SERVER's
// singleton instance) so the test exercises the wire protocol itself.
class RawSidecar {
  constructor(bin, dataDir) {
    this.proc = spawn(bin, ['--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('peer sidecar never became ready')), 30000);
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.event === 'ready') { clearTimeout(t); resolve(msg); return; }
        const w = this.pending.get(msg.id);
        if (w) { this.pending.delete(msg.id); msg.ok ? w.resolve(msg) : w.reject(new Error(msg.error)); }
      });
      this.proc.once('exit', () => reject(new Error('peer sidecar exited before ready')));
    });
  }
  rpc(cmd, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) { reject(new Error(`peer rpc timeout (${cmd})`)); }
      }, 60000).unref();
    });
  }
  async stop() {
    try { this.proc.stdin.end(); } catch (_err) { /* noop */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => { this.proc.kill(); resolve(); }, 5000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

describe('discovery p2p — route gating (no sidecar needed)', () => {
  let server;

  before(async () => {
    server = await startServer({ dlnaMode: 'disabled', waitForScan: false });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('status reports disabled + not running, without side effects', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.enabled, false);
    assert.equal(body.running, false);
    assert.equal(body.endpointId, null);
    assert.equal(typeof body.binaryFound, 'boolean');
  });

  test('publish and fetch are 403 while the feature is disabled', async () => {
    const pub = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/publish`, { method: 'POST' });
    assert.equal(pub.status, 403);
    const fetchR = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'blobAAAAAAAAAAAAAAAAAAAA' }),
    });
    assert.equal(fetchR.status, 403);
  });
});

describe('discovery p2p — enabled, pre-sidecar contract', () => {
  let server;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: { discoveryP2p: { enabled: true } },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  test('publish is 404 until an export snapshot has been built', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/publish`, { method: 'POST' });
    assert.equal(r.status, 404);
  });

  test('fetch validates the ticket body (400 on junk)', async () => {
    for (const body of [{}, { ticket: 'short' }, { ticket: 42 }]) {
      const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400);
    }
  });
});

// The real loop — needs a sidecar binary. Skips cleanly (visible in the test
// summary) on machines that have neither the prebuilt nor a local build.
(SIDECAR_BIN ? describe : describe.skip)('discovery p2p — real transfer loop', () => {
  let server;
  let peer;
  let peerDir;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false,
      extraConfig: {
        discoveryP2p: { enabled: true },
        scanOptions: { collectDiscoveryData: true },
      },
    });
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-p2p-peer-'));
    peer = new RawSidecar(SIDECAR_BIN, path.join(peerDir, 'sidecar'));
    await peer.ready;
  });
  after(async () => {
    if (peer) { await peer.stop(); }
    if (server) { await server.stop(); }
    if (peerDir) { fs.rmSync(peerDir, { recursive: true, force: true }); }
  });

  test('publish the export snapshot, peer fetches it by ticket, bytes match', async () => {
    // Build a real (empty-but-valid) export snapshot first.
    const build = await fetch(`${server.baseUrl}/api/v1/admin/db/discovery-export`, { method: 'POST' });
    assert.equal(build.status, 200);

    const pub = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/publish`, { method: 'POST' });
    assert.equal(pub.status, 200);
    const { hash, size, ticket } = await pub.json();
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(size > 0);
    assert.ok(ticket.length > 32);

    // Status now shows a live sidecar with an endpoint identity.
    const status = await (await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/status`)).json();
    assert.equal(status.running, true);
    assert.match(status.endpointId, /^[0-9a-f]{64}$/);

    // The peer pulls the snapshot by ticket (loopback direct addresses).
    const outDir = path.join(peerDir, 'fetched');
    const got = await peer.rpc('fetch', { ticket, outDir });
    assert.equal(got.hash, hash);
    assert.equal(got.size, size);

    const snapshot = path.join(server.tmpDir, 'db', 'discovery-export', 'discovery-export.db');
    assert.deepEqual(fs.readFileSync(got.path), fs.readFileSync(snapshot),
      'fetched bytes must match the published snapshot exactly');
  });

  test('server fetches a peer-published blob through the admin route', async () => {
    const blobFile = path.join(peerDir, 'peer-snapshot.db');
    fs.writeFileSync(blobFile, Buffer.from('peer discovery data ' + 'x'.repeat(4096)));
    const pub = await peer.rpc('publish', { path: blobFile });

    const r = await fetch(`${server.baseUrl}/api/v1/admin/discovery/p2p/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: pub.ticket }),
    });
    assert.equal(r.status, 200);
    const got = await r.json();
    assert.equal(got.hash, pub.hash);
    assert.ok(got.path.includes('discovery-peers'));
    assert.deepEqual(fs.readFileSync(got.path), fs.readFileSync(blobFile));
  });
});
