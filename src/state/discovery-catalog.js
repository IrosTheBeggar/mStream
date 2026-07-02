// The local view of the discovery-network catalog: every peer we've heard a
// (signature-verified, sidecar-vetted) snapshot announcement from, newest
// announcement per peer.
//
// Gossip gives us a stream of claims, not a database — this module turns
// that stream into state. Rules:
//   - keyed by origin endpoint id (one live snapshot per server);
//   - latest-wins ordered by snapshotSeq, the announcer's app-managed
//     monotonic counter (discovery_meta.row_seq). A replayed or out-of-order
//     older announcement can never roll an entry back — this is exactly why
//     the counter exists instead of wall-clock timestamps;
//   - persisted to {dbDirectory}/discovery-p2p/catalog.json (debounced) so
//     the catalog survives restarts — peers announce every ~15s while
//     online, but a rebooted server shouldn't forget everyone who is
//     currently offline.
//
// This is deliberately NOT a table in discovery.db: that file is the
// exportable share-safe unit, and what other servers exist is internal
// state that must never travel with it.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from './config.js';
import { events } from './discovery-p2p.js';

const SAVE_DEBOUNCE_MS = 2000;

// endpointId -> { from, payload, firstSeenAt, updatedAt }
const catalog = new Map();
let loaded = false;
let saveTimer = null;

function catalogPath() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p', 'catalog.json');
}

// Lazy-load on first touch. A corrupt file logs + starts empty — the network
// re-populates it within one announce interval per live peer.
function ensureLoaded() {
  if (loaded) { return; }
  loaded = true;
  try {
    const entries = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
    for (const e of entries) {
      if (e && typeof e.from === 'string' && e.payload) { catalog.set(e.from, e); }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`discovery catalog unreadable (${err.message}) — starting empty`);
    }
  }
}

function scheduleSave() {
  if (saveTimer) { return; }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(catalogPath()), { recursive: true });
      fs.writeFileSync(catalogPath(), JSON.stringify([...catalog.values()], null, 2));
    } catch (err) {
      winston.warn(`discovery catalog save failed: ${err.message}`);
    }
  }, SAVE_DEBOUNCE_MS);
  // Don't hold the process open just to flush a catalog write.
  if (saveTimer.unref) { saveTimer.unref(); }
}

// Record one verified announcement. Returns true when it changed the catalog
// (new peer, or newer snapshotSeq / different hash for a known one).
export function record(from, payload) {
  ensureLoaded();
  const existing = catalog.get(from);
  if (existing) {
    const oldSeq = existing.payload.snapshotSeq || 0;
    const newSeq = payload.snapshotSeq || 0;
    // Same-seq re-announcements are the steady-state heartbeat; only rewrite
    // when something actually moved forward.
    if (newSeq < oldSeq) { return false; }
    if (newSeq === oldSeq && existing.payload.hash === payload.hash) {
      existing.updatedAt = new Date().toISOString();
      return false;
    }
  }
  catalog.set(from, {
    from,
    payload,
    firstSeenAt: existing ? existing.firstSeenAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  scheduleSave();
  winston.info(`[discovery-catalog] ${existing ? 'updated' : 'new'} peer ${from.slice(0, 12)}… `
    + `(${payload.rowCount} tracks, model ${payload.modelId})`);
  return true;
}

export function list() {
  ensureLoaded();
  return [...catalog.values()];
}

export function get(endpointId) {
  ensureLoaded();
  return catalog.get(endpointId) || null;
}

export function size() {
  ensureLoaded();
  return catalog.size;
}

// Wire the sidecar's event stream into the catalog. Idempotent; called once
// from server boot (and by tests).
let subscribed = false;
export function subscribe() {
  if (subscribed) { return; }
  subscribed = true;
  events.on('announcement', (msg) => {
    try {
      record(msg.from, msg.payload);
    } catch (err) {
      winston.warn(`discovery catalog failed to record announcement from ${msg.from}: ${err.message}`);
    }
  });
}
