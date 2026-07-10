/**
 * Dial side of federation, end-to-end over real iroh:
 *
 * Server A = a real spawned mStream (startServer helper) with federation
 * enabled and a key minted over its admin API. Server B = THIS test process,
 * bootstrapped with the canonical config.setup + initDB harness and its own
 * federation endpoint. B adds A's ticket as a peer, then reads A through the
 * loopback bridge: health (grant list), scoped db browse, and a /media file —
 * all over QUIC with the x-federation-key header stamped by fedFetch.
 *
 * Also pins: bridge reuse (second fetch, same conn), testPeer's status
 * caching, and closePeerBridge + redial self-healing.
 *
 * Skips when @number0/iroh has no prebuilt binary here (both sides need it).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

describe('federation dial side (B reads A over iroh)', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  let tmpDir, srvA, sharedDir;
  let federation, fedClient, fedDb;
  let peer;

  before(async () => {
    // ── Server A: real mStream with a shared library + minted key ──
    sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-dial-shared-'));
    await fs.writeFile(path.join(sharedDir, 'hello.txt'), 'hello over iroh', 'utf8');

    srvA = await startServer({
      extraFolders: { shared: sharedDir },
      extraConfig: { federation: { enabled: true } },
    });

    // Public mode on A — mint without a token.
    const mint = await fetch(`${srvA.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'server-b', vpaths: ['shared'] }),
    });
    assert.equal(mint.status, 200);
    const minted = await mint.json();
    assert.ok(minted.ticket, "server A should issue a ticket (endpoint up — binary was importable here)");

    // ── Server B: this process ──
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-dial-b-'));
    fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory:       path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory:     path.join(tmpDir, 'logs'),
      },
      port: 0,
    }, null, 2));
    const config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    const dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    federation = await import('../../src/state/federation.js');
    fedClient = await import('../../src/state/federation-client.js');
    fedDb = await import('../../src/db/federation.js');

    // B's own endpoint — dials must come from a stable bound identity.
    const irohCommon = await import('../../src/state/iroh-common.js');
    await federation.start({ targetPort: 1, secretKey: irohCommon.generateSecretKey(), awaitOnline: false });

    // B stores A as a peer, exactly as the add-peer admin route would.
    const parsed = federation.parseFederationTicket(minted.ticket);
    peer = fedDb.addFederationPeer({
      name: parsed.name || 'server-a',
      endpointTicket: parsed.endpointTicket,
      apiKey: parsed.apiKey,
    });
  });

  after(async () => {
    fedClient?.stopAll();
    await federation?.stop();
    await srvA?.stop();
    for (const d of [tmpDir, sharedDir]) {
      if (d) { try { fsSync.rmSync(d, { recursive: true, force: true }); } catch { /* windows locks */ } }
    }
    setImmediate(() => process.exit(0));
  });

  test('health over the bridge reports the granted libraries', async () => {
    const res = await fedClient.fedFetch(peer, '/api/v1/federation/health');
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.deepEqual(health.libraries, ['shared']);
  });

  test('db browse and /media work through the same bridge (reuse)', async () => {
    const browse = await fedClient.fedFetch(peer, '/api/v1/db/artists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(browse.status, 200);
    assert.deepEqual((await browse.json()).artists, []); // fixture artists live in ungranted testlib

    const file = await fedClient.fedFetch(peer, '/media/shared/hello.txt');
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'hello over iroh');

    const ungranted = await fedClient.fedFetch(peer, '/media/testlib/');
    assert.equal(ungranted.status, 404);
  });

  test('testPeer caches ok status on the row', async () => {
    const result = await fedClient.testPeer(peer);
    assert.equal(result.ok, true);
    assert.deepEqual(result.health.libraries, ['shared']);
    const row = fedDb.getFederationPeerById(peer.id);
    assert.equal(row.last_status, 'ok');
    assert.ok(row.last_seen);
  });

  test('a dropped bridge self-heals on the next fetch', async () => {
    fedClient.closePeerBridge(peer.id);
    const res = await fedClient.fedFetch(peer, '/api/v1/federation/health');
    assert.equal(res.status, 200);
  });

  test('a peer with a revoked key reports unreachable and caches the failure', async () => {
    const bogus = fedDb.addFederationPeer({
      name: 'bogus',
      endpointTicket: peer.endpoint_ticket, // A's real endpoint...
      apiKey: 'fedk_never-minted',          // ...but a key A doesn't know
    });
    const result = await fedClient.testPeer(bogus);
    assert.equal(result.ok, false);
    const row = fedDb.getFederationPeerById(bogus.id);
    assert.match(row.last_status, /unreachable/);
    assert.equal(row.last_seen, null, 'never-reachable peer has no last_seen');
  });
});
