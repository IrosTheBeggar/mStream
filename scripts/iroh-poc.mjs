#!/usr/bin/env node
/**
 * Iroh tunnel dev harness (@number0/iroh v1) — exercises src/state/iroh.js with
 * the shared-secret handshake. Three modes:
 *
 *   node scripts/iroh-poc.mjs
 *       SELF-TEST (default). In ONE process: a stub HTTP backend, a server
 *       endpoint tunnelling to it, and a client. Dials + handshakes + sends an
 *       HTTP request through the tunnel and asserts the response. Exit 0/1.
 *       (Local direct address — does NOT exercise relay/discovery; serve/connect do.)
 *
 *   node scripts/iroh-poc.mjs serve [--target <port>] [--stub]
 *       SERVER role. Tunnels to 127.0.0.1:<port> (default 3000 = mStream;
 *       --stub starts a built-in backend). Persists identity + connect secret
 *       under save/conf/iroh-poc/. Prints the composite ticket to paste into `connect`.
 *
 *   node scripts/iroh-poc.mjs connect <ticket> [--local <port>]
 *       CLIENT role. Dials + handshakes, then opens a local TCP proxy on
 *       127.0.0.1:<port> (default 3010). curl http://127.0.0.1:3010/api/
 */

import net from 'net';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import winston from 'winston';
import {
  start as startTunnel,
  getTicket,
  stop as stopTunnel,
  bridge,
  connectTunnel,
  generateSecretKey,
} from '../src/state/iroh.js';

winston.add(new winston.transports.Console({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.printf(({ level, message }) => `[${level}] ${message}`),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const mode = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'self-test';
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
function log(...a) { console.log('[poc]', ...a); }

function startStubBackend() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'hello from behind iroh', path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Persist endpoint key + connect secret so `serve` has a stable identity/ticket.
function loadOrCreateKeys() {
  const dir = path.join(REPO_ROOT, 'save', 'conf', 'iroh-poc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'keys.json');
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { secretKey: Buffer.from(j.secretKey, 'base64'), connectSecret: Buffer.from(j.connectSecret, 'base64'), created: false };
  }
  const secretKey = generateSecretKey();
  const connectSecret = generateSecretKey();
  fs.writeFileSync(file, JSON.stringify({ secretKey: secretKey.toString('base64'), connectSecret: connectSecret.toString('base64') }), { mode: 0o600 });
  return { secretKey, connectSecret, created: true };
}

// --- SELF-TEST ---------------------------------------------------------------
async function runSelfTest() {
  const killer = setTimeout(() => { console.error('[poc] SELF-TEST TIMED OUT'); process.exit(1); }, 45000);
  killer.unref();

  const { server: stub, port: stubPort } = await startStubBackend();
  log(`stub backend on 127.0.0.1:${stubPort}`);

  const secretKey = generateSecretKey();
  const connectSecret = generateSecretKey();
  await startTunnel({ targetPort: stubPort, secretKey, connectSecret, awaitOnline: false });
  const ticket = getTicket();
  log('server up; composite ticket length ' + ticket.length);

  log('dialing + handshaking…');
  const { client, conn } = await connectTunnel(ticket, { awaitOnline: false });
  const bi = await conn.openBi();
  await bi.send.writeAll(Array.from(Buffer.from('GET /selftest HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n')));
  await bi.send.finish();
  const chunks = [];
  for (;;) { const c = await bi.recv.read(64 * 1024); if (c.length === 0) { break; } chunks.push(Buffer.from(c)); }
  const resp = Buffer.concat(chunks).toString('utf8');
  log('--- response over tunnel ---');
  console.log(resp.split('\r\n').map((l) => '    ' + l).join('\n'));

  const ok = resp.includes('200') && resp.includes('hello from behind iroh') && resp.includes('/selftest');
  await client.close();
  await stopTunnel();
  stub.close();
  clearTimeout(killer);

  if (ok) { log('SELF-TEST PASS ✅'); process.exit(0); }
  console.error('[poc] SELF-TEST FAIL ❌'); process.exit(1);
}

// --- SERVE -------------------------------------------------------------------
async function runServe() {
  const targetPort = Number(opt('target', '3000'));
  let stub = null;
  if (flag('stub')) {
    stub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'hello from behind iroh (stub)', path: req.url }));
    });
    await new Promise((r) => stub.listen(targetPort, '127.0.0.1', r));
    log(`stub backend listening on 127.0.0.1:${targetPort}`);
  } else {
    log(`tunneling to existing backend on 127.0.0.1:${targetPort} (use --stub for a built-in one)`);
  }

  const { secretKey, connectSecret, created } = loadOrCreateKeys();
  log(created ? 'generated + persisted keys' : 'loaded persisted keys');
  log('binding endpoint + waiting for home relay…');
  const { endpointId } = await startTunnel({ targetPort, secretKey, connectSecret });
  const ticket = getTicket();

  console.log('\n========================================================');
  console.log(' Iroh tunnel SERVER is up. Connect a client with:\n');
  console.log(`   node scripts/iroh-poc.mjs connect ${ticket}\n`);
  console.log(` EndpointId: ${endpointId}`);
  console.log('========================================================\n');
  log('serving — Ctrl-C to stop.');

  process.on('SIGINT', async () => { await stopTunnel(); if (stub) { stub.close(); } process.exit(0); });
}

// --- CONNECT -----------------------------------------------------------------
async function runConnect() {
  const ticket = argv[1];
  if (!ticket) {
    console.error('usage: node scripts/iroh-poc.mjs connect <ticket> [--local <port>]');
    process.exit(2);
  }
  const localPort = Number(opt('local', '3010'));

  log('dialing + handshaking…');
  const { client, conn } = await connectTunnel(ticket);
  log('connected ✅');

  const proxy = net.createServer((socket) => {
    conn.openBi().then((bi) => bridge(socket, bi)).catch((err) => { log(`openBi failed: ${err.message}`); socket.destroy(); });
  });
  proxy.listen(localPort, '127.0.0.1', () => {
    console.log('\n========================================================');
    console.log(` The remote server is now at:  http://127.0.0.1:${localPort}`);
    console.log(`   curl http://127.0.0.1:${localPort}/api/`);
    console.log('========================================================\n');
  });

  process.on('SIGINT', async () => { proxy.close(); await client.close(); process.exit(0); });
}

(async () => {
  try {
    if (mode === 'self-test') { await runSelfTest(); }
    else if (mode === 'serve') { await runServe(); }
    else if (mode === 'connect') { await runConnect(); }
    else { console.error(`unknown mode '${mode}'`); process.exit(2); }
  } catch (err) {
    console.error('[poc] fatal:', err);
    process.exit(1);
  }
})();
