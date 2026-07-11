// Dial side of federation: read a PEER's libraries through its iroh endpoint.
//
// Shape: one lazy loopback bridge per peer. We dial the peer once
// (state/federation.js connectToPeer — from OUR bound endpoint, so the peer's
// TOFU binding sees a stable EndpointId), then run a 127.0.0.1 ephemeral-port
// net.Server whose every accepted socket becomes one QUIC bi-stream bridged
// to the peer (the proven scripts/mstream-iroh-client.mjs pattern). Plain
// fetch() against the loopback port then speaks normal HTTP to the peer —
// keep-alive, range requests for the future pull-backup worker, everything —
// and fedFetch() stamps the peer's x-federation-key header on each request.
//
// Lifecycle: bridges build on first use, tear down after 5 idle minutes
// (no open sockets), and self-heal — a dead peer connection surfaces as a
// failed fetch/openBi, which drops the cached bridge so the next call
// redials. stopAll() runs on reboot/disable next to federation.stop().

import net from 'net';
import winston from 'winston';
import { bridge } from './iroh-common.js';
import * as federation from './federation.js';
import * as fedDb from '../db/federation.js';

const IDLE_TEARDOWN_MS = 5 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 15 * 1000;

// peerId -> { port, baseUrl, server, conn, activeSockets, idleTimer }
const bridges = new Map();
// peerId -> Promise<entry> for a dial in progress, so concurrent fedFetch
// calls share one connection instead of racing two (and leaking one).
const pending = new Map();

function armIdleTimer(entry, peerId) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.activeSockets === 0) {
      winston.debug(`[federation] peer bridge ${peerId} idle — tearing down`);
      closePeerBridge(peerId);
    }
  }, IDLE_TEARDOWN_MS);
  // Never hold the process open just to keep an idle timer.
  if (entry.idleTimer.unref) { entry.idleTimer.unref(); }
}

// Ensure a live loopback bridge to the peer; resolves to { port, baseUrl }.
// Rejects when the peer is unreachable or the handshake is rejected.
export function getPeerBridge(peer) {
  const existing = bridges.get(peer.id);
  if (existing) { return existing; }
  const inFlight = pending.get(peer.id);
  if (inFlight) { return inFlight; }
  const p = buildBridge(peer).finally(() => pending.delete(peer.id));
  pending.set(peer.id, p);
  return p;
}

async function buildBridge(peer) {
  const conn = await federation.connectToPeer(peer.endpoint_ticket, peer.api_key);

  const entry = { port: 0, baseUrl: '', server: null, conn, activeSockets: 0, idleTimer: null };
  entry.server = net.createServer((socket) => {
    entry.activeSockets += 1;
    clearTimeout(entry.idleTimer);
    socket.once('close', () => {
      entry.activeSockets -= 1;
      if (entry.activeSockets === 0) { armIdleTimer(entry, peer.id); }
    });
    conn.openBi().then((bi) => {
      bridge(socket, bi);
    }).catch((err) => {
      // openBi failing is the dead-connection signal — drop the bridge so
      // the next fedFetch redials instead of hitting a zombie.
      winston.debug(`[federation] peer ${peer.id} openBi failed (${err?.message}) — dropping bridge`);
      socket.destroy();
      closePeerBridge(peer.id);
    });
  });

  await new Promise((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', resolve);
  });
  entry.port = entry.server.address().port;
  entry.baseUrl = `http://127.0.0.1:${entry.port}`;
  armIdleTimer(entry, peer.id);

  bridges.set(peer.id, entry);
  winston.info(`[federation] peer bridge up: peer ${peer.id} ('${peer.name}') on ${entry.baseUrl}`);
  return entry;
}

// fetch() against a peer, with the federation key stamped on. One transparent
// retry on a transport-level failure (dead cached connection): the failed
// bridge is dropped and rebuilt fresh before giving up.
export async function fedFetch(peer, apiPath, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const { baseUrl } = await getPeerBridge(peer);
    try {
      return await fetch(baseUrl + apiPath, {
        ...opts,
        headers: { ...(opts.headers || {}), 'x-federation-key': peer.api_key },
      });
    } catch (err) {
      closePeerBridge(peer.id);
      if (attempt >= 1) { throw err; }
      winston.debug(`[federation] fedFetch to peer ${peer.id} failed (${err?.message}) — redialing once`);
    }
  }
}

// Health-check a peer and cache the outcome on its row (the admin UI's
// status dot). Returns { ok: true, health } or { ok: false, error }.
export async function testPeer(peer) {
  try {
    const res = await fedFetch(peer, '/api/v1/federation/health', {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const summary = `http ${res.status}`;
      fedDb.updateFederationPeerStatus(peer.id, summary);
      return { ok: false, error: summary };
    }
    const health = await res.json();
    fedDb.updateFederationPeerStatus(peer.id, 'ok');
    return { ok: true, health };
  } catch (err) {
    // Trim transport noise to something the UI can show in a status cell.
    const summary = `unreachable: ${String(err?.message || err).slice(0, 120)}`;
    fedDb.updateFederationPeerStatus(peer.id, summary);
    return { ok: false, error: summary };
  }
}

export function closePeerBridge(peerId) {
  const entry = bridges.get(peerId);
  if (!entry) { return; }
  bridges.delete(peerId);
  clearTimeout(entry.idleTimer);
  try { entry.server.close(); } catch (_err) { /* already down */ }
  try { entry.conn.close(0n, Array.from(Buffer.from('bye'))); } catch (_err) { /* already gone */ }
}

export function stopAll() {
  for (const peerId of [...bridges.keys()]) {
    closePeerBridge(peerId);
  }
}
