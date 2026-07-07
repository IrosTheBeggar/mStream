// Fetched peer snapshots: the local shelf of other servers' discovery DBs.
//
// The catalog (discovery-catalog.js) knows who EXISTS; this module knows
// what we've actually DOWNLOADED — one snapshot file per peer under
// {dbDirectory}/discovery-peers/, tracked in peer-dbs.json, opened read-only
// for the similarity API (src/api/discovery.js).
//
// Auto-fetch turns the catalog into a working library shelf without admin
// babysitting: on boot (and as announcements arrive) reconcile() downloads
// the top-N most useful peers — online-now first, then biggest — and
// re-fetches a peer whose announced snapshotSeq moved past our copy. The
// monotonic seq (not wall clocks) is what makes "is our copy stale?" a safe
// comparison. Guardrails: peer-count target, total-storage cap, and the
// blockedPeers config list.
//
// Every snapshot is validated before it's accepted onto the shelf — a peer
// hands us an arbitrary SQLite file, so we check the snapshot format marker
// and schema shape before ever querying it, and open it with a fresh
// read-only connection afterwards.

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { DatabaseSync } from '../db/sqlite-driver.js';
import * as config from './config.js';
import * as discoveryP2p from './discovery-p2p.js';
import * as discoveryCatalog from './discovery-catalog.js';

const REGISTRY_FILE = 'peer-dbs.json';
const SNAPSHOT_FORMAT_VERSION = 1; // must match discovery-export.js
// Debounce after a burst of announcements. The env override exists for the
// integration tests (waiting 30 real seconds per assertion is unkind);
// production installs should never set it.
const RECONCILE_DEBOUNCE_MS =
  Number(process.env.MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS) || 30 * 1000;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
// A peer is "online" when we heard a re-announcement recently. Announcers
// re-broadcast every ~15s; 90s tolerates a few missed rounds.
const ONLINE_WINDOW_MS = 90 * 1000;
// Cache of parsed embedding matrices (they're a few MB each) — keep the
// working set small so a Pi isn't holding every peer's vectors forever.
const MATRIX_CACHE_MAX = 4;

// endpointId -> { endpointId, hash, path, snapshotSeq, modelId, modelVersion,
//                 rowCount, sizeBytes, name, fetchedAt }
const registry = new Map();
let loaded = false;

// endpointId -> open read-only DatabaseSync (invalidated on hash change/remove)
const connections = new Map();
// endpointId -> { hash, modelId, ids, artists, titles, durations, mbids, matrix }
const matrixCache = new Map();

let reconcileTimer = null;
let debounceTimer = null;
let reconcileInFlight = false;
let wired = false;

export function peerDbDir() {
  return path.join(config.program.storage.dbDirectory, 'discovery-peers');
}

function registryPath() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p', REGISTRY_FILE);
}

function ensureLoaded() {
  if (loaded) { return; }
  loaded = true;
  try {
    for (const e of JSON.parse(fs.readFileSync(registryPath(), 'utf8'))) {
      // Drop registry entries whose file has vanished (manual cleanup etc.).
      if (e && e.endpointId && e.path && fs.existsSync(e.path)) { registry.set(e.endpointId, e); }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`discovery peer-db registry unreadable (${err.message}) — starting empty`);
    }
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify([...registry.values()], null, 2));
  } catch (err) {
    winston.warn(`discovery peer-db registry save failed: ${err.message}`);
  }
}

export function list() {
  ensureLoaded();
  return [...registry.values()];
}

export function get(endpointId) {
  ensureLoaded();
  return registry.get(endpointId) || null;
}

export function totalBytes() {
  ensureLoaded();
  return [...registry.values()].reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
}

function storageCapBytes() {
  return config.program.discoveryP2p.maxPeerDbStorageMb * 1024 * 1024;
}

function isBlocked(endpointId) {
  return config.program.discoveryP2p.blockedPeers.includes(endpointId);
}

// Validate + read identity facts from a freshly fetched snapshot. The file
// comes from an untrusted peer: confirm it IS a discovery snapshot before
// anything else queries it. Returns { modelId, modelVersion, rowCount }.
function inspectSnapshot(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get();
    const userVersion = Number(Object.values(version)[0]);
    if (userVersion !== SNAPSHOT_FORMAT_VERSION) {
      throw new Error(`not a discovery snapshot (user_version=${userVersion})`);
    }
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','tracks')"
    ).all();
    if (tables.length !== 2) { throw new Error('snapshot is missing the meta/tracks tables'); }
    const meta = {};
    for (const row of db.prepare('SELECT key, value FROM meta').all()) { meta[row.key] = row.value; }
    const rowCount = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    return {
      modelId: meta.embedding_model_id || null,
      modelVersion: meta.embedding_model_version || null,
      rowCount,
    };
  } finally {
    db.close();
  }
}

function dropConnection(endpointId) {
  const conn = connections.get(endpointId);
  if (conn) {
    try { conn.close(); } catch (_err) { /* already closed */ }
    connections.delete(endpointId);
  }
  matrixCache.delete(endpointId);
}

// Download one peer's current snapshot (per its catalog announcement) and
// put it on the shelf. Manual (admin route) and automatic (reconcile) fetches
// both come through here — blocklist and storage cap always apply.
export async function fetchPeer(endpointId) {
  ensureLoaded();
  const entry = discoveryCatalog.get(endpointId);
  if (!entry) { throw new Error('peer is not in the catalog (no announcement heard)'); }
  if (isBlocked(endpointId)) { throw new Error('peer is blocked (config: discoveryP2p.blockedPeers)'); }

  const existing = registry.get(endpointId);
  const announcedSize = entry.payload.size || 0;
  const projected = totalBytes() - (existing ? existing.sizeBytes : 0) + announcedSize;
  if (projected > storageCapBytes()) {
    throw new Error(`fetch would exceed the peer-DB storage cap `
      + `(${Math.round(projected / 1048576)}MB > ${config.program.discoveryP2p.maxPeerDbStorageMb}MB)`);
  }

  // Swarm fetch: any live holder of the hash is a valid source (content
  // addressing makes them interchangeable), so offer the sidecar's
  // downloader every provider we know — the author plus everyone whose
  // signed holds beacon lists this hash. A snapshot stays fetchable while
  // ANY holder is online, not just its author.
  const blocked = new Set(config.program.discoveryP2p.blockedPeers);
  const providerSet = new Set([endpointId, ...discoveryCatalog.holdersOf(entry.payload.hash)]);
  providerSet.delete(discoveryP2p.getEndpointId());
  const providers = [...providerSet].filter((p) => !blocked.has(p));
  const fetched = await discoveryP2p.fetch(
    providers.length > 1
      ? { hash: entry.payload.hash, providers }
      : { hash: entry.payload.hash, provider: endpointId },
    peerDbDir(),
  );

  let inspected;
  try {
    inspected = inspectSnapshot(fetched.path);
  } catch (err) {
    // Failed validation = not a snapshot we can use; don't leave it around.
    try { fs.rmSync(fetched.path, { force: true }); } catch (_rmErr) { /* best effort */ }
    throw new Error(`peer sent an invalid snapshot: ${err.message}`, { cause: err });
  }

  // Replace-on-update: a peer has ONE live snapshot; drop the old file AND
  // unpin the old blob so the sidecar store's GC reclaims it.
  if (existing && existing.path !== fetched.path) {
    dropConnection(endpointId);
    try { fs.rmSync(existing.path, { force: true }); } catch (_err) { /* best effort */ }
    if (existing.hash && existing.hash !== fetched.hash) {
      discoveryP2p.forget(existing.hash)
        .catch((err) => winston.debug(`[discovery-peer-dbs] forget replaced blob: ${err.message}`));
    }
  }

  const record = {
    endpointId,
    hash: fetched.hash,
    path: fetched.path,
    snapshotSeq: entry.payload.snapshotSeq || 0,
    modelId: inspected.modelId,
    modelVersion: inspected.modelVersion,
    rowCount: inspected.rowCount,
    sizeBytes: fetched.size,
    name: entry.payload.name || '',
    fetchedAt: new Date().toISOString(),
  };
  registry.set(endpointId, record);
  save();
  const sizeLabel = record.sizeBytes >= 1048576
    ? `${Math.round(record.sizeBytes / 1048576)}MB` : `${Math.round(record.sizeBytes / 1024)}KB`;
  winston.info(`[discovery-peer-dbs] fetched ${endpointId.slice(0, 12)}… `
    + `(${record.rowCount} tracks, ${sizeLabel})`);
  // Any success (auto or manual admin fetch) resets the failure backoff.
  clearFetchBackoff(endpointId);
  // We now hold (and therefore seed) this snapshot — tell the network.
  pushHolds();
  return record;
}

export function removePeerDb(endpointId) {
  ensureLoaded();
  const entry = registry.get(endpointId);
  if (!entry) { return false; }
  dropConnection(endpointId);
  try { fs.rmSync(entry.path, { force: true }); } catch (_err) { /* best effort */ }
  registry.delete(endpointId);
  save();
  // Unpin the blob for GC and stop advertising it as held.
  if (entry.hash) {
    discoveryP2p.forget(entry.hash)
      .catch((err) => winston.debug(`[discovery-peer-dbs] forget removed blob: ${err.message}`));
  }
  pushHolds();
  return true;
}

// Advertise the complete hold-set (our own published snapshot + everything
// on the shelf) via the sidecar's signed holds beacon. Fire-and-forget:
// beacons are periodic, so a missed push heals within a minute.
export function pushHolds() {
  ensureLoaded();
  const hashes = new Set();
  const own = discoveryP2p.getOwnSnapshotHash();
  if (own) { hashes.add(own); }
  for (const e of registry.values()) {
    if (e.hash) { hashes.add(e.hash); }
  }
  discoveryP2p.setHolds([...hashes])
    .catch((err) => winston.debug(`[discovery-peer-dbs] holds push failed: ${err.message}`));
}

function openPeerDb(entry) {
  let conn = connections.get(entry.endpointId);
  if (conn) { return conn; }
  conn = new DatabaseSync(entry.path, { readOnly: true });
  connections.set(entry.endpointId, conn);
  return conn;
}

// Read a peer's embedding matrix for one model space. Returns null when the
// peer has no rows in that space. Cached per (peer, snapshot hash) — the
// snapshot file is immutable by construction (content-addressed), so hash
// equality means the cache is valid.
export function readEmbeddings(endpointId, modelId) {
  ensureLoaded();
  const entry = registry.get(endpointId);
  if (!entry) { return null; }

  const cached = matrixCache.get(endpointId);
  if (cached && cached.hash === entry.hash && cached.modelId === modelId) { return cached; }

  const rows = openPeerDb(entry).prepare(`
    SELECT export_id, recording_mbid, artist, title, duration, embedding
    FROM tracks
    WHERE embedding IS NOT NULL AND model_id = ?
  `).all(modelId);
  if (rows.length === 0) { return null; }

  const dim = rows[0].embedding.byteLength / 4;
  const matrix = new Float32Array(rows.length * dim);
  const ids = new Array(rows.length);
  const mbids = new Array(rows.length);
  const artists = new Array(rows.length);
  const titles = new Array(rows.length);
  const durations = new Array(rows.length);
  let n = 0;
  for (const row of rows) {
    if (row.embedding.byteLength !== dim * 4) { continue; } // mixed-dim row: skip, don't crash
    // BLOB arrives as a Buffer whose byteOffset may not be 4-aligned — copy
    // through a fresh view instead of aliasing the pool.
    matrix.set(new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset, row.embedding.byteOffset + dim * 4)), n * dim);
    ids[n] = row.export_id;
    mbids[n] = row.recording_mbid;
    artists[n] = row.artist;
    titles[n] = row.title;
    durations[n] = row.duration;
    n += 1;
  }

  const result = {
    hash: entry.hash, modelId, dim, count: n,
    matrix: n === rows.length ? matrix : matrix.subarray(0, n * dim),
    ids, mbids, artists, titles, durations,
    peerName: entry.name, endpointId,
  };
  matrixCache.set(endpointId, result);
  // Tiny LRU: evict the oldest insertions beyond the cap.
  while (matrixCache.size > MATRIX_CACHE_MAX) {
    matrixCache.delete(matrixCache.keys().next().value);
  }
  return result;
}

// ── Auto-fetch ───────────────────────────────────────────────────────────────

// Sort candidates by usefulness: peers we can hear right now first, then by
// library size. (True popularity — seeder counts — needs the N3 provider
// tracking; this proxy is honest about what we can actually observe today.)
function candidateOrder(a, b) {
  const now = Date.now();
  const aOnline = now - Date.parse(a.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
  const bOnline = now - Date.parse(b.updatedAt) < ONLINE_WINDOW_MS ? 1 : 0;
  if (aOnline !== bOnline) { return bOnline - aOnline; }
  return (b.payload.rowCount || 0) - (a.payload.rowCount || 0);
}

// Failure backoff: a peer whose fetch keeps failing (unreachable, invalid
// snapshot, disk trouble) must not be retried on every 30s reconcile
// forever — that's a warn-spam firehose and pointless network churn.
// Exponential per-peer cooldown, reset by any success (including a manual
// admin fetch, which deliberately bypasses the backoff). In-memory only:
// a reboot retrying immediately is fine.
const FETCH_BACKOFF_BASE_MS = 2 * 60 * 1000;
const FETCH_BACKOFF_MAX_MS = 60 * 60 * 1000;
const fetchFailures = new Map(); // endpointId -> { failures, nextTryMs }

function recordFetchFailure(endpointId) {
  const cur = fetchFailures.get(endpointId) || { failures: 0 };
  const failures = cur.failures + 1;
  const delay = Math.min(FETCH_BACKOFF_BASE_MS * 2 ** (failures - 1), FETCH_BACKOFF_MAX_MS);
  fetchFailures.set(endpointId, { failures, nextTryMs: Date.now() + delay });
  return delay;
}

export function clearFetchBackoff(endpointId) {
  fetchFailures.delete(endpointId);
}

function inFetchBackoff(endpointId) {
  const cur = fetchFailures.get(endpointId);
  return cur !== undefined && Date.now() < cur.nextTryMs;
}

// One reconcile pass: refresh stale shelf entries, then top up to
// autoFetchCount from the best-looking catalog peers. Serialized; failures
// log and move on (an unreachable peer must not wedge the loop).
export async function reconcile() {
  if (!config.program.discoveryP2p.autoFetch || reconcileInFlight) { return; }
  reconcileInFlight = true;
  try {
    ensureLoaded();
    const targets = [];

    // Stale refresh: the announced monotonic seq moved past our copy.
    for (const held of registry.values()) {
      const cat = discoveryCatalog.get(held.endpointId);
      if (cat && (cat.payload.snapshotSeq || 0) > (held.snapshotSeq || 0)) {
        targets.push(held.endpointId);
      }
    }

    // Top-up: best candidates we don't hold yet.
    const room = config.program.discoveryP2p.autoFetchCount - registry.size;
    if (room > 0) {
      const candidates = discoveryCatalog.list()
        .filter((c) => !registry.has(c.from) && !isBlocked(c.from))
        .sort(candidateOrder)
        .slice(0, room);
      targets.push(...candidates.map((c) => c.from));
    }

    for (const endpointId of targets) {
      if (inFetchBackoff(endpointId)) { continue; }
      try {
        await fetchPeer(endpointId); // success clears the backoff internally
      } catch (err) {
        const delayMs = recordFetchFailure(endpointId);
        winston.warn(`[discovery-peer-dbs] auto-fetch of ${endpointId.slice(0, 12)}… failed `
          + `(retry in ~${Math.round(delayMs / 60000)}min): ${err.message}`);
      }
    }
  } finally {
    reconcileInFlight = false;
  }
}

// Wire auto-fetch into the world: run soon after boot (give the catalog a
// moment to fill from gossip), re-run debounced as announcements arrive, and
// sweep periodically as a catch-all. Idempotent across server reboot()s.
// Named (not inline) so stopAutoFetch can detach it — the runtime disable
// path must leave no listener that would wake the reconciler back up.
function onAnnouncement() {
  if (debounceTimer) { return; }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reconcile().catch((err) => winston.warn(`[discovery-peer-dbs] reconcile failed: ${err.message}`));
  }, RECONCILE_DEBOUNCE_MS);
  if (debounceTimer.unref) { debounceTimer.unref(); }
}

export function startAutoFetch() {
  if (wired) { return; }
  wired = true;
  discoveryP2p.events.on('announcement', onAnnouncement);
  reconcileTimer = setInterval(() => {
    reconcile().catch((err) => winston.warn(`[discovery-peer-dbs] reconcile failed: ${err.message}`));
  }, RECONCILE_INTERVAL_MS);
  if (reconcileTimer.unref) { reconcileTimer.unref(); }
}

// The disable half: detach the listener and kill both timers so nothing
// re-touches the sidecar after the stack shuts it down. Fetched snapshots
// stay on the shelf — the similar-songs surface keeps working offline, and
// a re-enable resumes refreshing them.
export function stopAutoFetch() {
  if (!wired) { return; }
  wired = false;
  discoveryP2p.events.removeListener('announcement', onAnnouncement);
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
}
