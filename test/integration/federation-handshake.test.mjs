/**
 * In-process federation endpoint: the key handshake gates the pipe, TOFU
 * binds a key to its first redeemer, and authorized streams bridge plain
 * HTTP to the backend. Exercises the lazy native load + accept/auth loop +
 * the shared byte pumps against a real iroh endpoint.
 *
 * Guest tokens (state/federation-guest.js) take the same first bi-stream:
 * a signed token opens the pipe from ANY endpoint (no TOFU — expiry is the
 * bound), never disturbs the key's binding, dies with the key, and its
 * live pipes are severed with the key's.
 *
 * Needs a real DB for the key lookups, so it bootstraps the canonical
 * config.setup + initDB harness into a temp dir (and process.exit()s in
 * teardown like the other DB-backed suites).
 *
 * Skips automatically if @number0/iroh has no prebuilt binary here.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

describe('federation endpoint handshake', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  let tmpDir, stub, stubPort;
  let federation, fedDb, iroh, guest, config; // modules
  let endpointTicketStr;
  let keyGood; // { id, key }
  const clients = []; // throwaway dial endpoints to close in teardown

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fed-hs-'));
    fsSync.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      storage: {
        dbDirectory:       path.join(tmpDir, 'db'),
        albumArtDirectory: path.join(tmpDir, 'art'),
        logsDirectory:     path.join(tmpDir, 'logs'),
      },
      port: 0,
    }, null, 2));

    config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    const dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    fedDb = await import('../../src/db/federation.js');
    federation = await import('../../src/state/federation.js');
    iroh = await import('../../src/state/iroh-common.js');
    guest = await import('../../src/state/federation-guest.js');

    const d = dbManager.getDB();
    const libId = Number(d.prepare("INSERT INTO libraries (name, root_path) VALUES ('music', '/music')").run().lastInsertRowid);
    keyGood = fedDb.createFederationKey('good-peer', [libId]);

    stub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    stubPort = stub.address().port;

    await federation.start({
      targetPort: stubPort,
      secretKey: iroh.generateSecretKey(),
      awaitOnline: false,
    });
    endpointTicketStr = federation.getEndpointTicket();
    assert.ok(endpointTicketStr, 'endpoint ticket available once started');
  });

  after(async () => {
    for (const c of clients) { try { await c.close(); } catch { /* gone */ } }
    await federation?.stop();
    if (stub) { stub.close(); }
    try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    // config.setup + initDB leave module-level timers running; exit like the
    // other DB-backed suites.
    setImmediate(() => process.exit(0));
  });

  // Dial the endpoint from a fresh throwaway client and run the key
  // handshake. Returns { client, conn, resp } — resp is '' when the server
  // closed instead of replying. Mirrors the tunnel client's wrapped read.
  async function dial(key) {
    const { Endpoint, EndpointTicket } = await import('@number0/iroh');
    const client = await Endpoint.bind({});
    clients.push(client);
    const addr = EndpointTicket.fromString(endpointTicketStr).endpointAddr();
    const conn = await client.connect(addr, federation.FEDERATION_ALPN);
    const authBi = await conn.openBi();
    await authBi.send.writeAll(Array.from(Buffer.from(key)));
    await authBi.send.finish();
    let resp = '';
    try {
      resp = Buffer.from(await authBi.recv.readToEnd(8)).toString('utf8');
    } catch { /* server closed the connection — treated as a rejection */ }
    return { client, conn, resp };
  }

  test('correct key completes the handshake, TOFU-binds, and tunnels HTTP', async () => {
    const { client, conn, resp } = await dial(keyGood.key);
    assert.equal(resp, 'OK');

    // TOFU: the key row is now bound to THIS client's endpoint id.
    const row = fedDb.getFederationKeyById(keyGood.id);
    assert.equal(row.bound_endpoint_id, client.id().toString());

    // A subsequent bi-stream is a plain HTTP bridge to the stub backend.
    const bi = await conn.openBi();
    await bi.send.writeAll(Array.from(Buffer.from('GET /probe HTTP/1.0\r\nConnection: close\r\n\r\n')));
    await bi.send.finish();
    const chunks = [];
    for (;;) { const c = await bi.recv.read(65536); if (c.length === 0) { break; } chunks.push(Buffer.from(c)); }
    const httpResp = Buffer.concat(chunks).toString('utf8');
    assert.match(httpResp, /200/);
    assert.match(httpResp, /\/probe/);
  });

  test('the same key from a different endpoint is rejected (TOFU)', async () => {
    const { resp } = await dial(keyGood.key); // dial() binds a NEW endpoint every time
    assert.notEqual(resp, 'OK');
  });

  test('an unknown key is rejected', async () => {
    const { resp } = await dial('fedk_does-not-exist');
    assert.notEqual(resp, 'OK');
  });

  test('a revoked key is rejected at the pipe', async () => {
    const revoked = fedDb.createFederationKey('revoked-peer', []);
    fedDb.deleteFederationKey(revoked.id);
    const { resp } = await dial(revoked.key);
    assert.notEqual(resp, 'OK');
  });

  test('an expired key is rejected before TOFU can bind; renewal re-arms it', async () => {
    const expired = fedDb.createFederationKey('expired-peer', [], {},
      new Date(Date.now() - 60_000).toISOString());
    const { resp } = await dial(expired.key);
    assert.notEqual(resp, 'OK');
    // The expiry check runs BEFORE the TOFU block: a dead ticket must not
    // claim a binding on its way out.
    assert.equal(fedDb.getFederationKeyById(expired.id).bound_endpoint_id, null);

    // Renewal (a new future date) is all it takes — same key, same ticket.
    fedDb.setFederationKeyExpiry(expired.id, new Date(Date.now() + 3600_000).toISOString());
    const again = await dial(expired.key);
    assert.equal(again.resp, 'OK');
  });

  test('a guest token opens the pipe from any endpoint and bridges HTTP, without touching the binding', async () => {
    const boundTo = fedDb.getFederationKeyById(keyGood.id).bound_endpoint_id;
    assert.ok(boundTo, 'the key was bound by the first test');
    const { token } = guest.mintGuestToken(keyGood);

    // Two DIFFERENT throwaway endpoints (dial() binds a new one each time):
    // a key would be rejected on the second (TOFU); a guest is not bound.
    for (let i = 0; i < 2; i++) {
      const { conn, resp } = await dial(token);
      assert.equal(resp, 'OK', `guest dial #${i + 1}`);
      const bi = await conn.openBi();
      await bi.send.writeAll(Array.from(Buffer.from('GET /guest HTTP/1.0\r\nConnection: close\r\n\r\n')));
      await bi.send.finish();
      const chunks = [];
      for (;;) { const c = await bi.recv.read(65536); if (c.length === 0) { break; } chunks.push(Buffer.from(c)); }
      assert.match(Buffer.concat(chunks).toString('utf8'), /200[\s\S]*\/guest/);
    }
    assert.equal(fedDb.getFederationKeyById(keyGood.id).bound_endpoint_id, boundTo,
      'a guest handshake must not rebind the key');
  });

  test('a guest of a revoked, expired or unknown key is rejected; so are forged and user tokens', async () => {
    const revoked = fedDb.createFederationKey('revoked-host', []);
    const { token: orphan } = guest.mintGuestToken(revoked);
    fedDb.deleteFederationKey(revoked.id);
    assert.notEqual((await dial(orphan)).resp, 'OK', 'guest of a deleted key');

    const expiredKey = fedDb.createFederationKey('expired-host', [], {},
      new Date(Date.now() - 60_000).toISOString());
    const { token: ofExpired } = guest.mintGuestToken(expiredKey);
    assert.notEqual((await dial(ofExpired)).resp, 'OK', 'guest of an expired key');

    const expiredToken = jwt.sign(
      { federationGuest: true, federationKeyId: keyGood.id, exp: Math.floor(Date.now() / 1000) - 60 },
      config.program.secret,
    );
    assert.notEqual((await dial(expiredToken)).resp, 'OK', 'expired guest token');

    const forged = jwt.sign({ federationGuest: true, federationKeyId: keyGood.id }, 'wrong-secret');
    assert.notEqual((await dial(forged)).resp, 'OK', 'foreign signature');

    const userToken = jwt.sign({ username: 'alice' }, config.program.secret);
    assert.notEqual((await dial(userToken)).resp, 'OK', 'an ordinary user JWT is not a pipe credential');
  });

  test('closeConnectionsForKey severs a live guest pipe along with the key\'s', async () => {
    const host = fedDb.createFederationKey('host-with-guests', []);
    const viaKey = await dial(host.key);
    assert.equal(viaKey.resp, 'OK');
    const { token } = guest.mintGuestToken(host);
    const viaGuest = await dial(token);
    assert.equal(viaGuest.resp, 'OK');

    assert.equal(federation.closeConnectionsForKey(host.id), 2, 'the key pipe AND its guest pipe');
    await assert.rejects(async () => {
      const bi = await viaGuest.conn.openBi();
      await bi.send.writeAll(Array.from(Buffer.from('GET / HTTP/1.0\r\n\r\n')));
      await bi.send.finish();
      await bi.recv.readToEnd(64);
    });
  });

  test('closeConnectionsForKey severs a live authorized pipe', async () => {
    const fresh = fedDb.createFederationKey('sever-me', []);
    const { conn, resp } = await dial(fresh.key);
    assert.equal(resp, 'OK');

    const closed = federation.closeConnectionsForKey(fresh.id);
    assert.equal(closed, 1);

    // The severed connection can't carry new streams: opening/using one must
    // fail (surface differs by timing — openBi may throw, or the stream
    // errors on first use).
    await assert.rejects(async () => {
      const bi = await conn.openBi();
      await bi.send.writeAll(Array.from(Buffer.from('GET / HTTP/1.0\r\n\r\n')));
      await bi.send.finish();
      await bi.recv.readToEnd(64);
    });
  });
});
