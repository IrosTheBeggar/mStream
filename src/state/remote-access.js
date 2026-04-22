import axios from 'axios';
import winston from 'winston';
import NatAPI from 'nat-api';
import * as killQueue from './kill-list.js';
import * as config from './config.js';

let client;
let renewTimer;
let killHookRegistered = false;
let crashGuardInstalled = false;
// Reject fn of whichever nat-api call is currently pending. The crash guard
// uses this to forcibly fail the awaiter when the library throws mid-op.
let pendingReject;

const OP_TIMEOUT_MS = 15_000;

const state = {
  enabled: false,
  protocol: null,
  publicIp: null,
  publicPort: null,
  leaseExpiresAt: null,
  lastError: null,
};

export function getStatus() {
  const opts = config.program.remoteAccess;
  return {
    enabled: state.enabled,
    protocol: state.protocol,
    publicIp: state.publicIp,
    publicPort: state.publicPort,
    leaseExpiresAt: state.leaseExpiresAt,
    lastError: state.lastError,
    configured: {
      enabled: opts.enabled,
      protocol: opts.protocol,
      publicPort: opts.publicPort || config.program.port,
      leaseSeconds: opts.leaseSeconds,
    },
  };
}

function clearRenewTimer() {
  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = undefined;
  }
}

function destroyClient() {
  if (!client) { return; }
  try {
    client.destroy();
  } catch (err) {
    winston.warn('Remote Access: failed to destroy NAT client cleanly', { stack: err });
  }
  client = undefined;
}

function mapPort(privatePort, publicPort, ttl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) { return; }
      settled = true;
      pendingReject = undefined;
      clearTimeout(timer);
      if (err) { return reject(err); }
      resolve();
    };
    const timer = setTimeout(() => done(new Error(`map timeout after ${OP_TIMEOUT_MS}ms`)), OP_TIMEOUT_MS);
    pendingReject = done;
    // protocol: 'TCP' — HTTP only needs TCP; omitting would also map UDP.
    client.map({ publicPort, privatePort, ttl, protocol: 'TCP' }, done);
  });
}

function unmapPort(publicPort) {
  return new Promise((resolve, reject) => {
    if (!client) { return resolve(); }
    let settled = false;
    const done = (err) => {
      if (settled) { return; }
      settled = true;
      pendingReject = undefined;
      clearTimeout(timer);
      if (err) {
        winston.warn(`Remote Access: unmap reported error: ${err.message}`);
        return reject(err);
      }
      resolve();
    };
    const timer = setTimeout(() => done(new Error(`unmap timeout after ${OP_TIMEOUT_MS}ms`)), OP_TIMEOUT_MS);
    pendingReject = done;
    client.unmap(publicPort, done);
  });
}

function getExternalIpFromClient() {
  return new Promise((resolve) => {
    if (!client || typeof client.externalIp !== 'function') { return resolve(null); }
    client.externalIp((err, ip) => {
      if (err || !ip) { return resolve(null); }
      resolve(ip);
    });
  });
}

async function getExternalIpFallback() {
  try {
    const res = await axios.get(config.program.remoteAccess.publicIpCheckUrl, { timeout: 5000 });
    const ip = typeof res.data === 'string' ? res.data.trim() : null;
    return ip || null;
  } catch (err) {
    winston.warn(`Remote Access: public IP check failed: ${err.message}`);
    return null;
  }
}

async function establishMapping() {
  const opts = config.program.remoteAccess;
  const privatePort = config.program.port;
  const publicPort = opts.publicPort || privatePort;
  const ttl = opts.leaseSeconds;

  // nat-api always tries UPnP; `enablePMP` opts into NAT-PMP as a fallback.
  // PMP has a known crash bug in this library (malformed datagrams throw
  // inside a UDP message handler), so we gate it behind an explicit opt-in:
  // only `protocol === 'nat-pmp'` enables PMP. 'auto' and 'upnp' stay on
  // UPnP only, which is the safe default for consumer routers.
  if (!client) {
    const ctorOpts = {
      autoUpdate: false,
      enablePMP: opts.protocol === 'nat-pmp',
      description: 'mStream Remote Access',
    };
    client = new NatAPI(ctorOpts);
  }

  await mapPort(privatePort, publicPort, ttl);
  const externalIp = await getExternalIpFromClient() || await getExternalIpFallback();

  state.enabled = true;
  state.protocol = opts.protocol;
  state.publicIp = externalIp;
  state.publicPort = publicPort;
  state.leaseExpiresAt = ttl > 0 ? Date.now() + (ttl * 1000) : null;
  state.lastError = null;

  winston.info(`Remote Access: mapped ${privatePort} \u2192 ${publicPort}${externalIp ? ` (public IP ${externalIp})` : ''}`);
}

function scheduleRenewal() {
  clearRenewTimer();
  const ttl = config.program.remoteAccess.leaseSeconds;
  if (!ttl || ttl === 0) { return; }
  const renewMs = Math.max(30_000, Math.floor(ttl * 1000 * 0.75));
  renewTimer = setTimeout(() => {
    refresh().catch(err => {
      winston.warn(`Remote Access: scheduled refresh failed: ${err.message}`);
    });
  }, renewMs);
  if (typeof renewTimer.unref === 'function') { renewTimer.unref(); }
}

function registerKillHook() {
  if (killHookRegistered) { return; }
  killQueue.addToKillQueue(() => {
    clearRenewTimer();
    if (client && state.publicPort) {
      try { client.unmap(state.publicPort, () => {}); } catch (_err) { /* best-effort */ }
    }
    destroyClient();
  });
  killHookRegistered = true;
}

// nat-api has a known bug where malformed NAT-PMP datagrams trigger an
// unhandled TypeError inside its UDP 'message' handler, which would otherwise
// crash the whole mStream process. We install a narrow process-level guard
// that swallows only errors originating from nat-api's internal paths and
// lets every other uncaught exception fall through to Node's default handler.
function installCrashGuard() {
  if (crashGuardInstalled) { return; }
  process.on('uncaughtException', (err) => {
    const stack = (err && err.stack) ? String(err.stack) : '';
    if (stack.includes('nat-api')) {
      winston.warn(`Remote Access: nat-api threw an unhandled error, suppressed to keep server alive: ${err.message}`);
      state.enabled = false;
      state.lastError = err.message || String(err);
      clearRenewTimer();
      // Fail any pending map/unmap so awaiters don't hang forever.
      if (pendingReject) {
        try { pendingReject(err); } catch (_e) { /* ignore */ }
      }
      // Try a best-effort unmap before destroying, so the router doesn't
      // hold an orphaned mapping if UPnP succeeded before the PMP crash.
      // Ignore errors — the client may already be in a bad state.
      if (client && state.publicPort) {
        try { client.unmap(state.publicPort, () => {}); } catch (_e) { /* ignore */ }
      }
      destroyClient();
      return;
    }
    // Re-raise: preserve Node's default crash behavior for unrelated errors.
    winston.error('Uncaught exception', { stack: err });
    process.exit(1);
  });
  crashGuardInstalled = true;
}

export async function setup() {
  if (!config.program.remoteAccess || config.program.remoteAccess.enabled !== true) {
    return;
  }

  installCrashGuard();
  registerKillHook();

  try {
    await establishMapping();
    scheduleRenewal();
  } catch (err) {
    state.enabled = false;
    state.lastError = err.message || String(err);
    winston.warn(`Remote Access: failed to establish mapping: ${state.lastError}`);
    destroyClient();
  }
}

export async function refresh() {
  if (!config.program.remoteAccess || config.program.remoteAccess.enabled !== true) {
    return;
  }
  try {
    await establishMapping();
    scheduleRenewal();
  } catch (err) {
    state.lastError = err.message || String(err);
    winston.warn(`Remote Access: refresh failed: ${state.lastError}`);
  }
}

export async function teardown() {
  clearRenewTimer();
  const mappedPort = state.publicPort;
  if (client && mappedPort) {
    try { await unmapPort(mappedPort); } catch (err) {
      winston.warn(`Remote Access: unmap failed: ${err.message}`);
    }
  }
  destroyClient();
  state.enabled = false;
  state.protocol = null;
  state.publicIp = null;
  state.publicPort = null;
  state.leaseExpiresAt = null;
  state.lastError = null;
}
