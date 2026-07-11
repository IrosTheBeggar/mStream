/**
 * In-process federation endpoint: the key handshake gates the pipe, TOFU
 * binds a key to its first redeemer, and authorized streams bridge plain
 * HTTP to the backend. Exercises the lazy native load + accept/auth loop +
 * the shared byte pumps against a real iroh endpoint.
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

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

describe('federation endpoint handshake', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  let tmpDir, stub, stubPort;
  let federation, fedDb, iroh; // modules
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

    const config = await import('../../src/state/config.js');
    await config.setup(path.join(tmpDir, 'config.json'));
    const dbManager = await import('../../src/db/manager.js');
    dbManager.initDB();
    fedDb = await import('../../src/db/federation.js');
    federation = await import('../../src/state/federation.js');
    iroh = await import('../../src/state/iroh-common.js');

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
