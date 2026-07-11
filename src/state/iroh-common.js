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
  }
  return irohMod;
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
