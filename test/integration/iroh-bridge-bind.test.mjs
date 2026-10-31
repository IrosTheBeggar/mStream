/**
 * Quick Connect on a server whose public listener cannot take a bridged
 * stream: the end-to-end regression for mStream#1101. The tunnel's streams
 * used to be bridged to 127.0.0.1:<port>, which a server bound to another
 * interface refuses and a server with SSL on answers in TLS, so the pairing
 * worked and every request through the tunnel died ("Connection closed
 * before full header was received" on the phone). They now go to the
 * loopback bridge listener, whatever the public bind and SSL setting.
 *
 * Real native module, real server (on Node and on Bun, which the desktop
 * bundles run), real tunnel. Skips without an @number0/iroh binary for this
 * platform; the bind case without an address other than 127.0.0.1 to listen
 * on, the SSL case without openssl to make its certificate.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as iroh from '../../src/state/iroh.js';
import { compareVersions } from '../../src/util/update-shared.js';
import { startServer } from '../helpers/server.mjs';
import { BUN_BIN, noBun, bunVersion } from '../helpers/bun.mjs';
import { connectOutcome, otherInterfaceAddress } from '../helpers/net.mjs';

let available = true;
try { await import('@number0/iroh'); } catch { available = false; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bun before 1.4.4 ignores Connection: close (and HTTP/1.0) when a response
// ends a tick after its request, as every mStream response does: the
// connection stays open, so a bridged stream never ends. 1.3.14 does this;
// 1.4.4, which CI and the bundles run, closes like Node.
const bunKeepsConnectionsOpen = !noBun && compareVersions(bunVersion, '1.4.4') < 0;

// Whether plain HTTP to host:port gets an HTTP answer at all.
function answersPlainHttp(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/', agent: false, timeout: 5000 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// A throwaway self-signed certificate for the SSL case, or null.
function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-bridge-tls-'));
  const files = { dir, key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem') };
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', files.key, '-out', files.cert,
  ], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) { return files; }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
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

const lan = available ? await otherInterfaceAddress() : null;
const tls = available ? selfSignedCert() : null;
if (tls) {
  // The harness's readiness check and the status reads below fetch over
  // HTTPS from that server, whose certificate nothing here can vouch for.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  after(() => fs.rmSync(tls.dir, { recursive: true, force: true }));
}

// Each way a public listener turns a bridged stream away, with the #1101
// precondition that shows it does.
const CASES = [
  {
    name: 'bound to an interface other than 127.0.0.1',
    skip: !lan && 'no address other than 127.0.0.1 to listen on',
    extraConfig: { address: lan },
    precondition: async (port) => assert.equal(await connectOutcome('127.0.0.1', port), 'ECONNREFUSED'),
  },
  {
    name: 'with SSL on',
    skip: !tls && 'no openssl to make a certificate with',
    extraConfig: tls && { ssl: { key: tls.key, cert: tls.cert } },
    precondition: async (port) => assert.equal(await answersPlainHttp('127.0.0.1', port), false),
  },
];

function scenario(execPath, { extraConfig, precondition }) {
  let server;
  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled', waitForScan: false, execPath,
      extraConfig: { ...extraConfig, iroh: { enabled: true } },
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

  test('the public port turns a bridged stream away, and the bridge check passes anyway', async () => {
    await precondition(server.port);
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

describe('Quick Connect on a server that turns bridged streams away', { skip: !available && 'no @number0/iroh binary for this platform' }, () => {
  for (const c of CASES) {
    describe(c.name, { skip: c.skip }, () => {
      describe('node', () => scenario(process.execPath, c));
      describe('bun', { skip: noBun }, () => scenario(BUN_BIN, c));
    });
  }
});
