/**
 * Quick Connect on a server that does not listen on loopback: the end-to-end
 * regression for mStream#1101. The tunnel's streams used to be bridged to
 * 127.0.0.1:<port>, which a server bound to one LAN interface refuses, so the
 * pairing worked and every request through the tunnel died ("Connection
 * closed before full header was received" on the phone). They now go to the
 * loopback bridge listener, whatever the public bind is.
 *
 * Real native module, real server (on Node and on Bun, which the desktop
 * bundles run), real tunnel. Skips without an @number0/iroh binary for this
 * platform or a non-loopback IPv4 here.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import * as iroh from '../../src/state/iroh.js';
import { startServer } from '../helpers/server.mjs';
import { BUN_BIN, noBun, bunVersion } from '../helpers/bun.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const lan = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connectOutcome = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', (err) => resolve(err.code));
});

// Bun before 1.4.4 ignores Connection: close (and HTTP/1.0) when a response
// ends a tick after its request, as every mStream response does: the
// connection stays open, so a bridged stream never ends. 1.3.14 does this;
// 1.4.4, which CI and the bundles run, closes like Node.
const bunKeepsConnectionsOpen = !noBun && olderThan(bunVersion, [1, 4, 4]);

function olderThan(version, than) {
  const parts = String(version).split('.').map((p) => parseInt(p, 10));
  for (let i = 0; i < than.length; i++) {
    if (parts[i] !== than[i]) { return parts[i] < than[i]; }
  }
  return false;
}

// One HTTP response off a tunnel stream: the head, then Content-Length bytes
// of body. Not until EOF, which an old Bun never sends (see above).
async function readResponse(recv) {
  let buf = Buffer.alloc(0);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    const length = end < 0 ? NaN : Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
    if (buf.length >= end + 4 + length) { return buf.toString('utf8'); }
    const chunk = await recv.read(65536);
    if (chunk.length === 0) { return buf.toString('utf8'); }
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
  }
}

const skip = !available ? 'no @number0/iroh binary for this platform'
  : !lan ? 'no non-loopback IPv4 on this machine' : false;

function scenario(execPath) {
  let server;
  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false, execPath,
      extraConfig: { address: lan, iroh: { enabled: true } },
    });
  });
  after(async () => { if (server) { await server.stop(); } });

  // The admin status once the tunnel runs and its bridge probe has answered.
  async function tunnelStatus() {
    for (const deadline = Date.now() + 40_000; ;) {
      const s = await (await fetch(`${server.baseUrl}/api/v1/admin/iroh`)).json();
      if (s.running && s.bridgeOk !== null) { return s; }
      if (Date.now() > deadline) { throw new Error(`the tunnel never reported its bridge: ${JSON.stringify(s)}`); }
      await sleep(250);
    }
  }

  test('nothing answers on 127.0.0.1:<port>, and the bridge check passes anyway', async () => {
    assert.equal(await connectOutcome('127.0.0.1', server.port), 'ECONNREFUSED', 'the #1101 precondition');
    const s = await tunnelStatus();
    assert.equal(s.bridgeOk, true, s.bridgeError);
  });

  test('a request through the tunnel is answered', { timeout: 60_000 }, async () => {
    const { qr } = await tunnelStatus();
    const { client, conn } = await iroh.connectTunnel(qr, { awaitOnline: false });
    try {
      const bi = await conn.openBi();
      // No finish() before the answer, like a real client: it would reach the
      // web server as a FIN, on which Node's http server aborts a request
      // still in flight (httpAllowHalfOpen is off).
      await bi.send.writeAll(Array.from(Buffer.from('GET /api/v1/ping HTTP/1.0\r\n\r\n')));
      const resp = await readResponse(bi.recv);
      assert.match(resp, /^HTTP\/1\.1 200 /);
      assert.match(resp, /"vpaths":\["testlib"\]/);
    } finally {
      await client.close();
    }
  });

  test('a WebSocket upgrade through the tunnel reaches the /remote socket', { timeout: 60_000 }, async () => {
    const { qr } = await tunnelStatus();
    const { client, conn } = await iroh.connectTunnel(qr, { awaitOnline: false });
    try {
      const bi = await conn.openBi();
      await bi.send.writeAll(Array.from(Buffer.from([
        'GET /?code=bridge-test HTTP/1.1', 'Host: tunnel', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'))));
      let head = '';
      while (!head.includes('\r\n\r\n')) {
        const chunk = await bi.recv.read(65536);
        if (chunk.length === 0) { break; }
        head += Buffer.from(chunk).toString('latin1');
      }
      assert.match(head, /^HTTP\/1\.1 101 /);
    } finally {
      await client.close();
    }
  });

  test('the stream ends when the web server closes the connection', {
    timeout: 60_000,
    skip: execPath === BUN_BIN && bunKeepsConnectionsOpen && `Bun ${bunVersion} keeps the connection open (fixed by 1.4.4)`,
  }, async () => {
    const { qr } = await tunnelStatus();
    const { client, conn } = await iroh.connectTunnel(qr, { awaitOnline: false });
    try {
      const bi = await conn.openBi();
      await bi.send.writeAll(Array.from(Buffer.from('GET /api/v1/ping HTTP/1.1\r\nHost: tunnel\r\nConnection: close\r\n\r\n')));
      let resp = '';
      for (;;) {
        const chunk = await bi.recv.read(65536);
        if (chunk.length === 0) { break; }
        resp += Buffer.from(chunk).toString('utf8');
      }
      assert.match(resp, /^HTTP\/1\.1 200 /);
      assert.match(resp, /\r\nConnection: close\r\n/i);
    } finally {
      await client.close();
    }
  });
}

describe('Quick Connect on a server bound to one LAN interface', { skip }, () => {
  describe('node', () => scenario(process.execPath));
  describe('bun', { skip: noBun }, () => scenario(BUN_BIN));
});
