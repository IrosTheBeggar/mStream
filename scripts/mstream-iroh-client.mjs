#!/usr/bin/env node
/**
 * Standalone mStream Iroh tunnel CLIENT (for PC2) — @number0/iroh v1.
 *
 * Dials an mStream "Remote Access" tunnel using the composite pairing code shown
 * in the admin panel (or printed by `iroh-poc.mjs serve`), proves the shared
 * secret via a handshake, and exposes the server as a local HTTP origin.
 *
 *   node mstream-iroh-client.mjs <code>                 # the code from the admin panel
 *   node mstream-iroh-client.mjs <code> --local 3010
 *
 * Only dependency: @number0/iroh@^1.0.0 (prebuilt native binary; Node >= 20.3).
 */

import net from 'net';
import { Endpoint, EndpointTicket } from '@number0/iroh';

const TUNNEL_ALPN = Array.from(Buffer.from('mstream/tunnel/2'));
const READ_CHUNK = 64 * 1024;

// Composite code = base64url(JSON{ t: EndpointTicket, s: connectSecret base64 }).
function parseCode(code) {
  const p = JSON.parse(Buffer.from(String(code), 'base64url').toString('utf8'));
  if (!p || typeof p.t !== 'string' || typeof p.s !== 'string') { throw new Error('Invalid pairing code'); }
  return { ticket: p.t, secret: Buffer.from(p.s, 'base64') };
}

async function pumpRecvToSocket(recv, socket) {
  for (;;) {
    const chunk = await recv.read(READ_CHUNK);
    if (chunk.length === 0) { break; }
    if (!socket.write(Buffer.from(chunk))) {
      await new Promise((resolve) => {
        const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
        socket.once('drain', done); socket.once('close', done);
      });
    }
    if (socket.destroyed || socket.writableEnded) { break; }
  }
  if (!socket.destroyed) { socket.end(); }
}
async function pumpSocketToSend(socket, send) {
  for await (const chunk of socket) { await send.writeAll(Array.from(chunk)); }
  await send.finish();
}
function bridge(socket, bi) {
  let disposed = false;
  const dispose = () => {
    if (disposed) { return; }
    disposed = true;
    try { socket.destroy(); } catch (_e) { /* already gone */ }
    bi.recv.stop(0n).catch(() => {});
    bi.send.reset(0n).catch(() => {});
  };
  socket.once('error', dispose);
  pumpRecvToSocket(bi.recv, socket).catch(dispose);
  pumpSocketToSend(socket, bi.send).catch(dispose);
}

(async () => {
  const argv = process.argv.slice(2);
  const code = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : null;
  if (!code) {
    console.error('usage: node mstream-iroh-client.mjs <pairing-code> [--local <port>]');
    console.error('Get the code from the mStream admin panel → Remote Access (Copy code).');
    process.exit(2);
  }
  const li = argv.indexOf('--local');
  const localPort = Number(li !== -1 && argv[li + 1] ? argv[li + 1] : 3010);
  const { ticket, secret } = parseCode(code);

  console.log('[client] starting Iroh endpoint…');
  const client = await Endpoint.bind({});
  // Cross-network: establish our own home relay BEFORE dialing.
  console.log('[client] waiting for home relay…');
  await Promise.race([client.online().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);

  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  console.log(`[client] dialing ${addr.id().toString()}…`);
  const conn = await Promise.race([
    client.connect(addr, TUNNEL_ALPN),
    new Promise((_r, rej) => setTimeout(() => rej(new Error('connect timed out after 25s — server down or code stale')), 25000)),
  ]);

  // Secret handshake on the first bi-stream.
  const authBi = await conn.openBi();
  await authBi.send.writeAll(Array.from(secret));
  await authBi.send.finish();
  const resp = Buffer.from(await authBi.recv.readToEnd(8)).toString('utf8');
  if (resp !== 'OK') { console.error('[client] handshake rejected — pairing code is wrong or was rotated.'); process.exit(1); }
  console.log('[client] connected ✅');

  const proxy = net.createServer((socket) => {
    conn.openBi().then((bi) => bridge(socket, bi)).catch((err) => { console.log(`[client] openBi failed: ${err.message}`); socket.destroy(); });
  });
  proxy.listen(localPort, '127.0.0.1', () => {
    console.log('\n========================================================');
    console.log(` mStream is now reachable at  http://127.0.0.1:${localPort}`);
    console.log(`   curl http://127.0.0.1:${localPort}/api/`);
    console.log('========================================================\n');
  });

  process.on('SIGINT', async () => { proxy.close(); try { await client.close(); } catch (_e) { /* noop */ } process.exit(0); });
})().catch((err) => { console.error('[client] fatal:', err.message); process.exit(1); });
