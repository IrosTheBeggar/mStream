// Shared iroh plumbing (@number0/iroh v1), used by every in-process iroh
// endpoint: the remote-access tunnel (src/state/iroh.js) and the federation
// endpoint (src/state/federation.js). Three groups live here:
//
//  1. The lazy native-module loader (+ the Bun-standalone .node staging) and
//     the selfTest() smoke check the build CI runs.
//  2. The byte pumps coupling an iroh QUIC bi-stream to a Node TCP socket —
//     subtle backpressure/teardown code (see the Reset(0) note on bridge())
//     that must not be duplicated per consumer.
//  3. The versioned ticket envelope `<prefix><version>:<base64url(JSON)>`
//     shared by the tunnel pairing code (`mstr1:`, docs/iroh-pairing-code.md)
//     and the federation ticket (`mstrfed1:`, docs/federation-ticket.md).
//
// --- v1 API notes ---
//  * Bind with Endpoint.bind({secretKey, alpns}); POLL endpoint.acceptNext().
//  * recv.read(limit) RETURNS a byte array (EOF == empty array); writeAll()/
//    connect() take Array<number>, NOT Buffers. reset()/stop() take bigint.

import net from 'net';
import os from 'os';
import crypto from 'crypto';
import winston from 'winston';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot, isBunStandalone } from '../util/esm-helpers.js';

export const READ_CHUNK = 64 * 1024;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Lazily import the native module exactly once. Kept out of module scope so a
// missing/unloadable binary only surfaces when a feature is actually used.
let irohMod = null;
export async function loadIroh() {
  if (!irohMod) {
    // Under a Bun `--compile` standalone binary, @number0/iroh's NAPI-RS loader
    // can't resolve its platform package from the virtual node_modules, so point
    // it at the prebuilt .node shipped next to the executable (staged into
    // bin/iroh/ by scripts/build-bun.mjs). The loader honours
    // NAPI_RS_NATIVE_LIBRARY_PATH ahead of its built-in resolution. No-op under
    // Node/Electron, where normal node_modules resolution applies.
    if (isBunStandalone && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
      try {
        const dir = join(appRoot, 'bin', 'iroh');
        const node = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.node'));
        if (node) { process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(dir, node); }
      } catch { /* fall back to the loader's default resolution */ }
    }
    irohMod = await import('@number0/iroh');
    // MSTREAM_IROH_LOG=trace|debug|info|warn turns on iroh's own tracing
    // (stderr) — the transport-level view the accept loops cannot give.
    const lvl = process.env.MSTREAM_IROH_LOG;
    if (lvl && typeof irohMod.setLogLevel === 'function') {
      const name = lvl[0].toUpperCase() + lvl.slice(1).toLowerCase();
      try { irohMod.setLogLevel(name); winston.info(`[iroh] native tracing at ${name}`); } catch (err) { winston.warn(`[iroh] setLogLevel(${name}) failed: ${err?.message}`); }
    }
  }
  return irohMod;
}

// Where an endpoint stands: its home relay and how many direct addresses it
// has learned — what a pairing code or federation ticket carries at that
// moment (mStream#940: a code handed out too early may carry too little).
export function describeAddr(ep) {
  try {
    const a = ep.addr();
    const direct = a.directAddresses();
    return `relay ${a.relayUrl() ?? 'none'}, ${direct.length} direct addr(s) [${direct.join(' ')}]`;
  } catch (err) {
    return `addr unavailable (${err?.message})`;
  }
}

// ---------------------------------------------------------------------------
// What a ticket advertises (mStream#940)
// ---------------------------------------------------------------------------
// endpoint.addr() lists every direct address iroh knows for us: the ones on
// this machine's interfaces AND the NAT-reflexive ones (the router's outside
// IP with a mapped port, learned through the relays). A phone on the SAME
// LAN that reads a ticket with both dials the public one too; the router
// hairpins that first packet back in with its own LAN address as the source,
// the reply makes it back through that NAT state, so the phone's QUIC
// handshake completes and it selects that "direct" path — and its next
// packets never arrive. The server's half of the handshake times out 30 s
// later, the phone's after 10 s, and it retries: measured 8/8 fresh
// endpoints stalling the first dial, 10/10 stalled connections arriving from
// 192.168.1.1, every success from the phone's own address. A phone outside
// the NAT cannot use the reflexive address unsolicited anyway — holepunching
// goes through the relay, which stays in the ticket — so a ticket carries
// only the addresses this machine actually has. Pure; unit-tested.
export function localDirectAddresses(directAddrs, interfaceIps) {
  const ip = (addr) => {
    const s = String(addr);
    if (s.startsWith('[')) { return s.slice(1, s.indexOf(']')); }
    const i = s.lastIndexOf(':');
    return i < 0 ? s : s.slice(0, i);
  };
  const strip = (a) => String(a).split('%')[0].toLowerCase(); // zone ids off IPv6
  const local = new Set([...interfaceIps].map(strip));
  return directAddrs.filter((a) => local.has(strip(ip(a))));
}

function interfaceIps() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) { if (i?.address) { out.add(i.address); } }
  }
  return out;
}

// The EndpointAddr a ticket is built from: the endpoint's own, with the
// reflexive direct addresses removed. Keeps everything when the filter would
// leave nothing (interfaces unreadable) — never worse than before.
export function ticketAddr(irohMod, ep) {
  const a = ep.addr();
  let all = [];
  try { all = a.directAddresses(); } catch (_err) { return a; }
  const keep = localDirectAddresses(all, interfaceIps());
  if (keep.length === all.length || keep.length === 0) { return a; }
  const dropped = all.filter((x) => !keep.includes(x));
  winston.info(`[iroh] ticket carries ${keep.length} of ${all.length} direct addresses (not the NAT-reflexive ${dropped.join(' ')})`);
  return new irohMod.EndpointAddr(a.id(), a.relayUrl(), keep);
}

// Per-connection handshake trace for the accept loops (mStream#940). Stage
// lines print only under MSTREAM_IROH_TRACE=1; a handshake still in flight
// after STALL_WARN_MS warns regardless, naming the stage it sits in — the
// phone's dials time out at 10 s and the server used to say nothing at all.
const TRACE = process.env.MSTREAM_IROH_TRACE === '1';
const STALL_WARN_MS = 5000;
export function handshakeTrace(tag) {
  const t0 = Date.now();
  let stage = 'accept';
  let remote = '?';
  let done = false;
  const timer = setTimeout(() => {
    if (!done) { winston.warn(`${tag} handshake from ${remote} still at '${stage}' after ${Date.now() - t0}ms`); }
  }, STALL_WARN_MS);
  return {
    stage(name, r) {
      stage = name;
      if (r) { remote = r; }
      if (TRACE) { winston.info(`${tag} handshake ${remote}: ${name} +${Date.now() - t0}ms`); }
    },
    end(outcome, level = 'info') {
      done = true;
      clearTimeout(timer);
      winston[level](`${tag} handshake ${remote}: ${outcome} at '${stage}' after ${Date.now() - t0}ms`);
    },
  };
}

// Smoke check for the `iroh-selftest` worker (build CI + local build
// verification). Forces the native binding to load and confirms it's the real
// addon: a failed dlopen makes loadIroh() throw, so reaching the export check
// proves THIS binary loaded the shipped .node.
export async function selfTest() {
  const iroh = await loadIroh();
  const exports = Object.keys(iroh).length;
  if (exports === 0) { throw new Error('iroh module loaded but exposed no exports'); }
  return {
    exports,
    nativePath: process.env.NAPI_RS_NATIVE_LIBRARY_PATH || '(default resolution)',
  };
}

// Normalize a secret given as a Buffer/Uint8Array/Array or a base64 string.
export function asBuffer(secret) {
  if (typeof secret === 'string') { return Buffer.from(secret, 'base64'); }
  return Buffer.from(secret);
}

// Generate a fresh 32-byte secret (endpoint identity keys, pipe secrets).
// Returns a Buffer.
export function generateSecretKey() {
  return crypto.randomBytes(32);
}

// ---------------------------------------------------------------------------
// Generic byte pumps bridging an Iroh bi-stream <-> a Node TCP socket.
// ---------------------------------------------------------------------------

// Drain an Iroh recv stream into a TCP socket. v1 read(limit) returns a byte
// array; an empty array signals clean EOF. On clean EOF we half-close the socket
// (socket.end — NOT destroy) so an in-flight response keeps flowing. Errors
// propagate so bridge() can tear down the partner direction.
export async function pumpRecvToSocket(recv, socket) {
  for (;;) {
    const chunk = await recv.read(READ_CHUNK);
    if (chunk.length === 0) { break; }
    if (!socket.write(Buffer.from(chunk))) {
      await new Promise((resolve) => {
        const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
        socket.once('drain', done);
        socket.once('close', done);
      });
    }
    if (socket.destroyed || socket.writableEnded) { break; }
  }
  if (!socket.destroyed) { socket.end(); }
}

// Pump a TCP socket into an Iroh send stream (backpressure via async iteration).
// v1 writeAll wants Array<number>. Errors propagate so bridge() disposes the partner.
export async function pumpSocketToSend(socket, send) {
  for await (const chunk of socket) {
    await send.writeAll(Array.from(chunk));
  }
  await send.finish();
}

// Couple a connected TCP socket and an Iroh bi-stream into a full-duplex tunnel.
// If EITHER direction errors, dispose() force-tears-down both halves so the
// partner can't park. dispose() is idempotent and also runs once both settle.
export function bridge(socket, bi) {
  let disposed = false;
  const dispose = () => {
    if (disposed) { return; }
    disposed = true;
    try { socket.destroy(); } catch (_err) { /* already gone */ }
    bi.recv.stop(0n).catch(() => {});
    bi.send.reset(0n).catch(() => {});
  };
  // dispose() is the ABNORMAL-teardown path only. On clean completion each pump
  // closes its own half gracefully (recv EOF -> socket.end(); socket EOF ->
  // send.finish()), and we must NOT then reset()/stop() the streams: a reset
  // racing the peer's final read surfaces as a spurious "Reset(0)" on the other
  // end (truncating/erroring an otherwise-complete response). So only dispose
  // when a direction ERRORS — that tears down the partner so it can't park.
  socket.once('error', (err) => { winston.debug(`[iroh] tunnel socket error: ${err.message}`); dispose(); });
  pumpRecvToSocket(bi.recv, socket).catch((err) => { winston.debug(`[iroh] recv->socket pump ended: ${err?.message}`); dispose(); });
  pumpSocketToSend(socket, bi.send).catch((err) => { winston.debug(`[iroh] socket->send pump ended: ${err?.message}`); dispose(); });
}

// Wire one accepted Iroh bi-stream to a fresh TCP connection to the backend.
export function bridgeStreamToBackend(bi, targetHost, targetPort) {
  const socket = net.connect({ host: targetHost, port: targetPort });
  let started = false;
  socket.once('connect', () => { started = true; bridge(socket, bi); });
  socket.once('error', (err) => {
    if (started) { return; } // bridge() now owns teardown
    winston.warn(`[iroh] backend connect failed (${targetHost}:${targetPort}): ${err.message}`);
    bi.send.reset(0n).catch(() => {});
    bi.recv.stop(0n).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Versioned ticket envelope: "<prefix><version>:<base64url(JSON payload)>".
// ---------------------------------------------------------------------------

// Build an envelope string. The payload is any JSON-serializable object;
// field validation is the caller's job (each ticket type owns its fields).
export function buildEnvelope(prefix, version, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${prefix}${version}:${body}`;
}

// Parse an envelope -> { version, payload }. Pure (no native module needed).
//   prefix     required literal prefix, e.g. 'mstr' or 'mstrfed'.
//   maxVersion highest version this build understands; newer is rejected with
//              an actionable error.
//   allowBare  accept a bare base64url(JSON) body with no prefix as implicit
//              v1 (the tunnel pairing code's legacy form). Default false.
//   label      human label used in error messages, e.g. 'pairing code'.
// Callers validate the payload's required fields and throw their own
// `Invalid <label> (missing fields)` so the error wording stays per-ticket.
export function parseEnvelope(code, { prefix, maxVersion, allowBare = false, label = 'ticket' } = {}) {
  const str = String(code).trim();
  let version = 1;
  let body = str;
  const m = str.match(new RegExp(`^${prefix}(\\d+):(.*)$`, 's'));
  if (m) {
    version = Number(m[1]);
    body = m[2];
  } else if (!allowBare) {
    throw new Error(`Invalid ${label}`);
  }
  if (version > maxVersion) {
    throw new Error(`${label.charAt(0).toUpperCase()}${label.slice(1)} is version ${version}; this build supports up to v${maxVersion}. Update to a newer version.`);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid ${label}`, { cause: err });
  }
  return { version, payload };
}
