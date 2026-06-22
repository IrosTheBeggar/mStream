/**
 * In-process Iroh tunnel: a request round-trips through the tunnel only after a
 * correct shared-secret handshake; a wrong secret is rejected. Exercises the
 * lazy native load + the server accept/auth loop + the byte pumps.
 *
 * Skips automatically if @number0/iroh has no prebuilt binary for this platform
 * (it's an optionalDependency).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as iroh from '../../src/state/iroh.js';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

describe('iroh tunnel handshake', { skip: available ? false : 'no @number0/iroh binary for this platform' }, () => {
  let stub;
  let stubPort;
  let secretKey;
  let connectSecret;
  let ticket;

  before(async () => {
    stub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    stubPort = stub.address().port;

    secretKey = iroh.generateSecretKey();
    connectSecret = iroh.generateSecretKey();
    await iroh.start({ targetPort: stubPort, secretKey, connectSecret, awaitOnline: false });
    ticket = iroh.getTicket();
  });

  after(async () => {
    await iroh.stop();
    if (stub) { stub.close(); }
  });

  test('correct secret tunnels an HTTP request', async () => {
    const { client, conn } = await iroh.connectTunnel(ticket, { awaitOnline: false });
    const bi = await conn.openBi();
    await bi.send.writeAll(Array.from(Buffer.from('GET /probe HTTP/1.0\r\nConnection: close\r\n\r\n')));
    await bi.send.finish();
    const chunks = [];
    for (;;) { const c = await bi.recv.read(65536); if (c.length === 0) { break; } chunks.push(Buffer.from(c)); }
    const resp = Buffer.concat(chunks).toString('utf8');
    await client.close();
    assert.match(resp, /200/);
    assert.match(resp, /\/probe/);
  });

  test('wrong secret is rejected (handshake fails)', async () => {
    // Tamper the secret in the pairing code (strip the mstr<V>: prefix first).
    const body = ticket.replace(/^mstr\d+:/, '');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.s = iroh.generateSecretKey().toString('base64');
    const badTicket = 'mstr1:' + Buffer.from(JSON.stringify(payload)).toString('base64url');

    await assert.rejects(
      iroh.connectTunnel(badTicket, { awaitOnline: false }),
      /handshake rejected/,
    );
  });
});
