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
//     currently offline;
//   - offline isn't forever: entries not heard from in
//     discoveryP2p.peerRetentionDays age out (see pruneStalePeers below).
//
// This is deliberately NOT a table in discovery.db: that file is the
// exportable share-safe unit, and what other servers exist is internal
// state that must never travel with it.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import * as config from './config.js';
import * as discoveryP2p from './discovery-p2p.js';

const { events } = discoveryP2p;

const SAVE_DEBOUNCE_MS = 2000;
// The env override exists for integration/smoke tests (waiting an hour per
// assertion is unkind); production installs should never set it.
const PRUNE_INTERVAL_MS =
  Number(process.env.MSTREAM_TEST_DISCOVERY_PRUNE_MS) || 60 * 60 * 1000;

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
  // The v1 abuse lever: blocked peers don't exist as far as the catalog is
  // concerned (their snapshots are also never fetched — see
  // discovery-peer-dbs.js).
  if (config.program.discoveryP2p.blockedPeers.includes(from)) { return false; }
  const existing = catalog.get(from);
  if (existing) {
    const oldSeq = existing.payload.snapshotSeq || 0;
    const newSeq = payload.snapshotSeq || 0;
    // Same-seq re-announcements are the steady-state heartbeat; only rewrite
    // when something actually moved forward. Name/description edits count as
    // forward — they re-announce under an unchanged snapshotSeq (the library
    // didn't move), and ignoring them would pin a peer's old blurb forever.
    if (newSeq < oldSeq) { return false; }
    const sameText = existing.payload.name === payload.name
      && (existing.payload.description || '') === (payload.description || '');
    if (newSeq === oldSeq && existing.payload.hash === payload.hash && sameText) {
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

// Manual forget: the operator's "drop this dead server now" button, the
// immediate sibling of the retention pruning below. Deleting is never
// permanent — one announcement from the peer re-creates the entry.
export function forget(endpointId) {
  ensureLoaded();
  if (!catalog.delete(endpointId)) { return false; }
  scheduleSave();
  winston.info(`[discovery-catalog] operator forgot peer ${endpointId.slice(0, 12)}…`);
  return true;
}

// ── Auto-forget (retention pruning) ──────────────────────────────────────────
// A peer that stops announcing stays in the catalog as "offline" — useful for
// a weekend outage, noise after a month. Drop entries not heard from in
// discoveryP2p.peerRetentionDays (0 = keep forever). Two exemptions:
//   - `keep` (peers whose snapshot is on the local shelf): forgetting them
//     would hide the shelf row from the UI and orphan the file on disk —
//     snapshot removal stays an explicit operator action;
//   - nothing else. Blocked peers are dropped REGARDLESS of age (unless
//     kept): record() refuses their announcements, so a pre-existing entry
//     could never refresh and would otherwise sit visible until it aged out.
// `now` is injectable for tests. Returns the dropped endpoint ids.
export function pruneStalePeers({ keep = new Set(), now = Date.now() } = {}) {
  ensureLoaded();
  const days = config.program.discoveryP2p.peerRetentionDays;
  const cutoff = days > 0 ? now - (days * 24 * 60 * 60 * 1000) : null;
  const dropped = [];
  for (const [from, entry] of catalog) {
    if (keep.has(from)) { continue; }
    const blocked = config.program.discoveryP2p.blockedPeers.includes(from);
    // An unparseable updatedAt can never refresh (record() rewrites it on
    // every announcement), so it counts as stale rather than immortal.
    const heardAt = Date.parse(entry.updatedAt);
    const stale = cutoff !== null && !(heardAt >= cutoff);
    if (!blocked && !stale) { continue; }
    catalog.delete(from);
    dropped.push(from);
  }
  if (dropped.length > 0) {
    scheduleSave();
    winston.info(`[discovery-catalog] forgot ${dropped.length} peer(s) `
      + `(${days > 0 ? `not heard in ${days}d` : 'blocked'}): `
      + dropped.map((id) => id.slice(0, 12) + '…').join(', '));
  }
  return dropped;
}

// The hourly prune pass. Only runs while the sidecar reports at least one
// live gossip neighbor: with zero neighbors we can't hear ANYONE, so silence
// is evidence of our own isolation, not of peers being gone — an offline
// server must never wake up and forget its whole catalog. (Live peers
// re-announce every ~15s, so by the first pass — an hour after start —
// everyone reachable has refreshed their in-memory updatedAt.)
async function prunePass(getPinned) {
  try {
    if (!discoveryP2p.isRunning()) { return; }
    const s = await discoveryP2p.status();
    if (!(Number(s.neighbors) > 0)) { return; }
  } catch (err) {
    winston.debug(`[discovery-catalog] prune skipped (status unavailable): ${err.message}`);
    return;
  }
  pruneStalePeers({ keep: getPinned() });
  // Persist current heartbeat timestamps while we're here: record() only
  // saves on real changes, so without this the on-disk updatedAt of a
  // stable live peer could lag reality by months. One write an hour keeps
  // the persisted catalog honest across restarts.
  scheduleSave();
}

let pruneTimer = null;

// getPinned: () => Set of endpoint ids that must never be pruned (the
// caller knows what's on the shelf; this module deliberately doesn't import
// discovery-peer-dbs — it imports us). Idempotent, like subscribe().
export function startPruning(getPinned) {
  if (pruneTimer) { return; }
  pruneTimer = setInterval(() => {
    prunePass(getPinned).catch((err) =>
      winston.warn(`[discovery-catalog] prune pass failed: ${err.message}`));
  }, PRUNE_INTERVAL_MS);
  if (pruneTimer.unref) { pruneTimer.unref(); }
}

export function stopPruning() {
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

// ── Holder tracking (N3) ─────────────────────────────────────────────────────
// Aggregated from peers' signed "holds" beacons: snapshot hash -> holders.
// This is the network's observable popularity signal (live seeder count)
// AND the provider list for multi-source fetch. In-memory only — beacons
// re-arrive every ~60s, so persistence would just preserve staleness.
const HOLDER_TTL_MS = 5 * 60 * 1000; // ~5 missed beacons = gone

// hash -> Map(endpointId -> lastSeenMs)
const holders = new Map();

export function recordHolds(from, holds) {
  const now = Date.now();
  // A beacon is the peer's COMPLETE current set: drop them from hashes
  // they no longer list (they deleted/replaced those snapshots).
  for (const [hash, byPeer] of holders) {
    if (byPeer.has(from) && !holds.includes(hash)) { byPeer.delete(hash); }
    if (byPeer.size === 0) { holders.delete(hash); }
  }
  for (const hash of holds) {
    let byPeer = holders.get(hash);
    if (!byPeer) { byPeer = new Map(); holders.set(hash, byPeer); }
    byPeer.set(from, now);
  }
}

// Live holders of one snapshot hash, freshest first. Expired entries are
// pruned on read (cheap: the maps are tiny).
export function holdersOf(hash) {
  const byPeer = holders.get(hash);
  if (!byPeer) { return []; }
  const cutoff = Date.now() - HOLDER_TTL_MS;
  for (const [peer, seen] of byPeer) {
    if (seen < cutoff) { byPeer.delete(peer); }
  }
  if (byPeer.size === 0) { holders.delete(hash); return []; }
  return [...byPeer.entries()].sort((a, b) => b[1] - a[1]).map(([peer]) => peer);
}

export function seederCount(hash) {
  return holdersOf(hash).length;
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
  events.on('holds', (msg) => {
    try {
      // Blocked peers' beacons are ignored wholesale — they can't appear
      // as seeders or providers.
      if (config.program.discoveryP2p.blockedPeers.includes(msg.from)) { return; }
      recordHolds(msg.from, Array.isArray(msg.holds) ? msg.holds : []);
    } catch (err) {
      winston.warn(`discovery catalog failed to record holds from ${msg.from}: ${err.message}`);
    }
  });
}
