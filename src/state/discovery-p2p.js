// Node-side client for the p2p-sidecar — the Rust companion process that
// gives the music-discovery network its iroh-blobs transport (and, next
// phase, its iroh-gossip catalog).
//
// WHY A SIDECAR (and not @number0/iroh): the NAPI binding exposes only the
// connection layer — no iroh-blobs, no iroh-gossip — and n0 has deprioritized
// FFI parity. n0's guidance is an app-specific Rust wrapper; ours lives at
// p2p-sidecar/ and ships like rust-parser: per-platform prebuilt binaries in
// bin/p2p-sidecar/, rebuilt + committed by CI (never hand-committed).
//
// SHAPE: the sidecar is a LONG-RUNNING child (unlike the run-and-exit
// rust-parser) speaking line-delimited JSON-RPC over stdio; see
// p2p-sidecar/src/main.rs for the protocol. It exits on stdin EOF, so this
// process dying can never leave an orphan. Its identity keypair lives at
// {dbDirectory}/discovery-p2p/identity.key — deliberately SEPARATE from the
// remote-access tunnel's key (config.program.iroh.secretKey) so the public
// discovery persona is unlinkable to the private paired-access endpoint.
//
// GRACEFUL DEGRADATION: importing this module never throws and never spawns.
// start() resolves the binary lazily (prebuilt → local cargo build) and
// fails with an actionable error when neither exists — callers surface that
// to the admin instead of crashing the server.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import winston from 'winston';
import { appRoot } from '../util/esm-helpers.js';
import * as config from './config.js';

const ext = process.platform === 'win32' ? '.exe' : '';
// musl detection mirrors task-queue.js's rust-parser resolution.
const isMusl = process.platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
const libcSuffix = isMusl ? '-musl' : '';

const RPC_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // cross-network blob pulls can be slow
const READY_TIMEOUT_MS = 30000;
const SHUTDOWN_GRACE_MS = 5000;

let proc = null;          // live child process (null when stopped)
let endpointId = null;    // from the sidecar's ready event
let readyPromise = null;  // in-flight start() so concurrent callers share one spawn
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

// Prebuilt binary (CI-committed) or a local `npm run build-p2p-sidecar`
// output. Returns null when neither exists — deliberately NO implicit
// `cargo build` fallback here (unlike the scanner): this resolves inside
// admin HTTP requests, and a surprise 10-minute compile inside a request
// is worse than a clear error.
export function resolveSidecarBinary() {
  const prebuilt = path.join(appRoot, `bin/p2p-sidecar/p2p-sidecar-${process.platform}-${process.arch}${libcSuffix}${ext}`);
  const localBuild = path.join(appRoot, 'p2p-sidecar', 'target', 'release', `p2p-sidecar${ext}`);
  // Local build first: during development it may be newer than the prebuilt.
  if (fs.existsSync(localBuild)) { return localBuild; }
  if (fs.existsSync(prebuilt)) {
    try { fs.chmodSync(prebuilt, 0o755); } catch (_err) { /* zip extraction can strip +x; spawn will surface real failures */ }
    return prebuilt;
  }
  return null;
}

export function dataDir() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p');
}

export function isRunning() { return proc !== null && endpointId !== null; }

export function getEndpointId() { return endpointId; }

// Start the sidecar (idempotent; concurrent callers await the same spawn).
// Resolves once the sidecar's ready event arrives. Rejects with an
// actionable message when the binary is missing or the process dies first.
export function start() {
  if (isRunning()) { return Promise.resolve({ endpointId }); }
  if (readyPromise) { return readyPromise; }

  const bin = resolveSidecarBinary();
  if (!bin) {
    return Promise.reject(new Error(
      'p2p-sidecar binary not found — expected a prebuilt at bin/p2p-sidecar/ ' +
      'or a local build at p2p-sidecar/target/release/ (run `npm run build-p2p-sidecar`)'));
  }

  readyPromise = new Promise((resolve, reject) => {
    fs.mkdirSync(dataDir(), { recursive: true });
    const child = spawn(bin, ['--data-dir', dataDir()], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc = child;

    const readyTimer = setTimeout(() => {
      reject(new Error('p2p-sidecar did not become ready in time'));
      try { child.kill(); } catch (_err) { /* already gone */ }
    }, READY_TIMEOUT_MS);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_err) {
        winston.warn(`[p2p-sidecar] unparseable output line: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.event === 'ready') {
        clearTimeout(readyTimer);
        endpointId = msg.endpointId;
        winston.info(`[p2p-sidecar] ready — endpointId=${endpointId}`);
        resolve({ endpointId });
        return;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) { return; }
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) { waiter.resolve(msg); } else { waiter.reject(new Error(msg.error || 'sidecar error')); }
    });

    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      winston.debug(`[p2p-sidecar] ${line}`);
    });

    child.on('error', (err) => {
      clearTimeout(readyTimer);
      teardown(`spawn failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      const why = `exited (code=${code} signal=${signal})`;
      // Unexpected death after ready: log at warn — an admin action will
      // surface the failure on its next rpc() call, and start() can respawn.
      if (endpointId) { winston.warn(`[p2p-sidecar] ${why}`); }
      teardown(why);
      reject(new Error(`p2p-sidecar ${why}`));
    });
  }).finally(() => { readyPromise = null; });

  return readyPromise;
}

function teardown(why) {
  proc = null;
  endpointId = null;
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`p2p-sidecar ${why}`));
  }
  pending.clear();
}

// Send one request; resolves with the sidecar's response object.
export function rpc(cmd, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  if (!proc) { return Promise.reject(new Error('p2p-sidecar is not running')); }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`p2p-sidecar request timed out (${cmd})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n', (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// Publish a file as a content-addressed blob. Returns { hash, size, ticket }.
export async function publish(filePath) {
  await start();
  return rpc('publish', { path: filePath });
}

// Fetch a blob by ticket into outDir. Returns { hash, size, path }.
export async function fetch(ticket, outDir) {
  await start();
  return rpc('fetch', { ticket, outDir }, FETCH_TIMEOUT_MS);
}

export async function status() {
  await start();
  return rpc('status');
}

// Graceful stop: ask politely, then close stdin (the sidecar's EOF exit
// path), then SIGKILL as the last resort.
export async function stop() {
  if (!proc) { return; }
  const child = proc;
  try { await rpc('shutdown', {}, SHUTDOWN_GRACE_MS); } catch (_err) { /* it may already be gone */ }
  try { child.stdin.end(); } catch (_err) { /* noop */ }
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_err) { /* noop */ }
      resolve();
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
  });
  teardown('stopped');
}
