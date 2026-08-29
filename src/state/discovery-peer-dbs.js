// Fetched peer snapshots: the local shelf of other servers' discovery DBs.
//
// The catalog (discovery-catalog.js) knows who EXISTS; this module knows
// what we've actually DOWNLOADED — one snapshot file per peer under
// {dbDirectory}/discovery-peers/, tracked in peer-dbs.json, opened read-only
// for the similarity API (src/api/discovery.js).
//
// Auto-fetch turns the catalog into a working library shelf without admin
// babysitting: on boot (and as announcements arrive) reconcile() downloads
// as many of the most useful peers as fit — model-compatible only (see
// modelCompatible; incompatible snapshots are unsearchable dead weight
// unless the config opts back in), then online-now first, then biggest —
// and re-fetches a peer whose announced snapshotSeq moved past our copy.
// The monotonic seq (not wall clocks) is what makes "is our copy stale?" a
// safe comparison. Guardrails: peer-count target, total-storage cap, a
// free-disk floor, the blockedPeers config list, and a per-fetch byte
// ceiling that treats the announced size as a claim, not a fact.
//
// Rotation (rotatePeerDbs, hourly) keeps the shelf's MEMBERSHIP fresh once
// it's full: swap the least-useful long-held snapshot (rotationDays age,
// offline-longest first) for the most-novel catalog peer we don't hold.
// Swap-only, one per pass, `pinned` entries immune (manual admin downloads
// pin themselves). Decision logic is pure — discovery-peer-rotation.js.
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
import * as discoveryDb from '../db/discovery-db.js';
import * as discoveryP2p from './discovery-p2p.js';
import * as discoveryCatalog from './discovery-catalog.js';
import { candidateOrder, modelCompatible, planRotation } from './discovery-peer-rotation.js';

const REGISTRY_FILE = 'peer-dbs.json';
const SNAPSHOT_FORMAT_VERSION = 1; // must match discovery-export.js
// Debounce after a burst of announcements. The env override exists for the
// integration tests (waiting 30 real seconds per assertion is unkind);
// production installs should never set it.
const RECONCILE_DEBOUNCE_MS =
  Number(process.env.MSTREAM_TEST_DISCOVERY_DEBOUNCE_MS) || 30 * 1000;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
// Rotation cadence: hourly is plenty — the shelf only changes as
// announcements arrive, and churn is capped at one swap per pass anyway.
// Env override for the integration tests, like the debounce above.
const ROTATE_INTERVAL_MS =
  Number(process.env.MSTREAM_TEST_DISCOVERY_ROTATE_MS) || 60 * 60 * 1000;
// Rotated-out ledger cap — enough history to prefer never-held candidates
// on any realistic catalog without the file growing forever.
const ROTATION_LEDGER_MAX = 200;
// Real-disk guard: however generous maxPeerDbStorageMb is, a snapshot
// download must never run the volume itself near zero — after the download
// at least this much must remain free. The env override exists for the
// integration tests (faking a full disk beats filling one); production
// installs should never set it.
const DISK_FREE_FLOOR_BYTES =
  Number(process.env.MSTREAM_TEST_DISCOVERY_DISK_FLOOR_BYTES) || 500 * 1024 * 1024;
// Cache of parsed embedding matrices — sized to the peer set, evicted LRU.
//
// The old shape (fixed cap of 4, FIFO eviction, no touch-on-read) sat BELOW
// the default autoFetchCount of 6: the p2p similar route walks every held
// peer in a stable order, so each request evicted exactly the matrices it
// would need next — a 0% hit rate re-reading ~50 MB per peer per request
// (audit H4: ~3.2 s/request where ~370 ms is inherent). The cap now tracks
// autoFetchCount so steady-state holds every held peer, reads refresh
// recency, and a byte budget stays as the memory backstop for huge peers on
// small boxes (a Pi shouldn't pin gigabytes of vectors; past it, LRU keeps
// the hottest peers and the rest re-read like before).
const MATRIX_CACHE_MAX_BYTES =
  Number(process.env.MSTREAM_TEST_MATRIX_CACHE_BYTES) || 512 * 1024 * 1024;
function matrixCacheMaxEntries() {
  const autoFetch = Number(config.program?.discoveryP2p?.autoFetchCount) || 0;
  return Math.max(4, autoFetch);
}

// endpointId -> { endpointId, hash, path, snapshotSeq, modelId, modelVersion,
//                 rowCount, sizeBytes, name, fetchedAt }
const registry = new Map();
let loaded = false;

// endpointId -> open read-only DatabaseSync (invalidated on hash change/remove)
const connections = new Map();
// endpointId -> { hash, modelId, ids, artists, titles, durations, mbids, matrix }
const matrixCache = new Map();

let reconcileTimer = null;
let rotateTimer = null;
let debounceTimer = null;
let reconcileInFlight = false;
let rotateInFlight = false;
let wired = false;

// endpointId -> evictedAt ISO: who rotation dropped and when, so candidate
// selection can prefer never-held peers. Lazily loaded; null = not yet.
let rotationLedger = null;

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
      if (e && e.endpointId && e.path && fs.existsSync(e.path)) {
        // Backfill pre-rotation registries: the membership clock starts at
        // whatever fetch we knew about, and nothing is pinned until an
        // admin says so.
        if (!e.firstFetchedAt) { e.firstFetchedAt = e.fetchedAt || new Date().toISOString(); }
        if (typeof e.pinned !== 'boolean') { e.pinned = false; }
        registry.set(e.endpointId, e);
      }
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

// Free bytes on the volume snapshots land on, or null when the platform
// can't say (the caller treats unknown as "don't block"). Statfs'd via the
// dbDirectory: discovery-peers/ lives under it, and the parent is
// guaranteed to exist even before the first fetch creates the subdir.
async function diskFreeBytes() {
  try {
    const st = await fs.promises.statfs(config.program.storage.dbDirectory);
    return Number(st.bavail) * Number(st.bsize);
  } catch (err) {
    winston.debug(`[discovery-peer-dbs] free-disk check unavailable (${err.message})`);
    return null;
  }
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
// put it on the shelf. Manual (admin route) and automatic (reconcile/
// rotation) fetches both come through here — blocklist, storage cap, and
// disk floor always apply. `pinned: true` (the manual route) marks the
// entry rotation-immune: an admin's explicit download must not silently
// vanish a week later. Pinning is sticky — a refresh or re-download never
// UNpins; only the pin route does.
export async function fetchPeer(endpointId, { pinned = false } = {}) {
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

  // The cap budgets what WE may use; this checks what the VOLUME can give.
  // A replacement downloads before the old file is deleted, so the announced
  // size is the true transient need either way. Best-effort: statfs support
  // varies by platform/filesystem, and an unanswerable question must not
  // block every fetch — only a confident "too little" refuses.
  const freeBytes = await diskFreeBytes();
  if (freeBytes !== null && freeBytes < announcedSize + DISK_FREE_FLOOR_BYTES) {
    throw new Error(`not enough free disk for this snapshot `
      + `(${Math.round(freeBytes / 1048576)}MB free, need `
      + `${Math.round((announcedSize + DISK_FREE_FLOOR_BYTES) / 1048576)}MB to keep headroom)`);
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
  // Byte ceiling for the transfer itself. Everything above trusted the
  // ANNOUNCED size, which the announcer controls — the blob behind the hash
  // can be arbitrarily larger, and the sidecar's blob store lives on the
  // same volume as everything else, so an uncapped transfer is a disk-fill
  // handed to any catalog peer (this box already died of a full disk once).
  // An honest announcement is byte-exact (it's the stat of the published
  // file), so the announced size IS the cap; a legacy size-less
  // announcement falls back to the storage headroom this fetch was
  // admitted under. Sidecars ≥ v1.0.4 abort the transfer at the ceiling;
  // v1.0.3 ignores the extra param, which is why the on-disk re-check
  // below stays load-bearing.
  const maxFetchBytes = announcedSize > 0
    ? announcedSize
    : storageCapBytes() - (totalBytes() - (existing ? existing.sizeBytes : 0));
  const fetched = await discoveryP2p.fetch(
    providers.length > 1
      ? { hash: entry.payload.hash, providers }
      : { hash: entry.payload.hash, provider: endpointId },
    peerDbDir(),
    maxFetchBytes,
  );

  // The bytes on disk are the only size that counts. Re-run the admission
  // checks against them: an over-announced blob (actual > claimed) is a
  // lying peer, and an actual total past the storage cap must not be kept
  // no matter what the claim was. Same-blob refreshes are exempt from the
  // delete (fetched.path IS the held file when the hash didn't change —
  // removing it would orphan the live registry entry).
  let actualBytes;
  try {
    actualBytes = fs.statSync(fetched.path).size;
  } catch (_statErr) {
    actualBytes = Number(fetched.size) || 0;
  }
  const overAnnounced = announcedSize > 0 && actualBytes > announcedSize;
  const projectedActual = totalBytes() - (existing ? existing.sizeBytes : 0) + actualBytes;
  if (overAnnounced || projectedActual > storageCapBytes()) {
    if (!(existing && existing.hash === fetched.hash)) {
      try { fs.rmSync(fetched.path, { force: true }); } catch (_rmErr) { /* best effort */ }
      discoveryP2p.forget(fetched.hash)
        .catch((err) => winston.debug(`[discovery-peer-dbs] forget oversized blob: ${err.message}`));
    }
    throw new Error(overAnnounced
      ? `peer announced ${announcedSize} bytes but sent ${actualBytes} — rejecting the snapshot`
      : `snapshot is ${actualBytes} bytes on disk — over the peer-DB storage cap; rejecting`);
  }

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
    sizeBytes: actualBytes,
    name: entry.payload.name || '',
    fetchedAt: new Date().toISOString(),
    // The MEMBERSHIP clock (rotation's aging signal) — carried over on a
    // refresh, because a refresh replaces the bytes, not the membership.
    // Resetting it here would make an actively-publishing peer immortal.
    firstFetchedAt: existing?.firstFetchedAt || new Date().toISOString(),
    pinned: existing?.pinned === true || pinned === true,
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

// Rotation immunity, admin-controlled. Returns false for a peer with no
// fetched snapshot (nothing to pin).
export function setPinned(endpointId, pinned) {
  ensureLoaded();
  const entry = registry.get(endpointId);
  if (!entry) { return false; }
  entry.pinned = pinned === true;
  save();
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
  if (cached && cached.hash === entry.hash && cached.modelId === modelId) {
    // Touch-on-read: Map iteration order is insertion order, so re-inserting
    // makes eviction genuinely LRU instead of FIFO.
    matrixCache.delete(endpointId);
    matrixCache.set(endpointId, cached);
    return cached;
  }

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
  // Evict least-recently-used past the entry cap or the byte budget (never
  // the entry just inserted — a single over-budget peer still gets served,
  // it just won't pin the cache).
  const maxEntries = matrixCacheMaxEntries();
  const totalBytes = () =>
    [...matrixCache.values()].reduce((s, m) => s + m.matrix.byteLength, 0);
  while (matrixCache.size > 1
    && (matrixCache.size > maxEntries || totalBytes() > MATRIX_CACHE_MAX_BYTES)) {
    matrixCache.delete(matrixCache.keys().next().value);
  }
  return result;
}

// ── Auto-fetch ───────────────────────────────────────────────────────────────

// Candidate/eviction ordering and the rotation decision itself live in
// discovery-peer-rotation.js — pure functions, unit-tested without a server.

// Failure backoff: a peer whose fetch keeps failing (unreachable, invalid
// snapshot, disk trouble) must not be retried on every 30s reconcile
// forever — that's a warn-spam firehose and pointless network churn.
// Exponential per-peer cooldown, reset by any success (including a manual
// admin fetch, which deliberately bypasses the backoff). In-memory only:
// a reboot retrying immediately is fine.
//
// The cap must sit WELL ABOVE the hourly rotation interval. It used to be
// exactly 60min — equal to ROTATE_INTERVAL_MS — so a failing peer's backoff
// had always just expired when the next rotation pass ran: the "backoff"
// retried every hour forever (333 warns in two weeks on one production
// server, the noise floor that buried the #880 outage). At 24h, a peer that
// keeps failing walks the ladder to roughly one attempt a day; any success,
// or a reboot, starts it fresh.
const FETCH_BACKOFF_BASE_MS = 2 * 60 * 1000;
const FETCH_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
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
  if (!config.program.discoveryP2p.autoFetch || reconcileInFlight || rotateInFlight) { return; }
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

    // Top-up: best candidates we don't hold yet, as many as fit under BOTH
    // caps. "Announced size doesn't fit" is a sizing fact, not a fetch
    // failure — skip the candidate without burning its backoff and keep
    // walking, because a smaller peer further down the list may still fit.
    // (fetchPeer re-checks the cap at download time; this pre-filter is
    // what keeps one oversized peer from eating a retry slot forever.)
    const room = config.program.discoveryP2p.autoFetchCount - registry.size;
    if (room > 0) {
      const localModel = discoveryDb.openDiscoveryDbIfExists()
        ? discoveryDb.getMeta('embedding_model_id') : null;
      const allowIncompat = config.program.discoveryP2p.autoFetchIncompatibleModels;
      const capBytes = storageCapBytes();
      let projectedBytes = totalBytes();
      let picked = 0;
      let skippedForSpace = 0;
      let skippedForModel = 0;
      for (const c of discoveryCatalog.list()
        .filter((x) => !registry.has(x.from) && !isBlocked(x.from))
        .sort(candidateOrder(localModel))) {
        if (picked >= room) { break; }
        // Auto-fetch only, not a fetch failure: an incompatible snapshot is
        // unsearchable here, so skipping it burns no backoff and the manual
        // admin fetch stays available. (Stale-refreshes above are exempt —
        // what's already ON the shelf keeps refreshing until removed.)
        if (!modelCompatible(c.payload, localModel, allowIncompat)) { skippedForModel += 1; continue; }
        const announced = c.payload.size || 0;
        if (projectedBytes + announced > capBytes) { skippedForSpace += 1; continue; }
        projectedBytes += announced;
        picked += 1;
        targets.push(c.from);
      }
      if (skippedForSpace > 0) {
        winston.debug(`[discovery-peer-dbs] skipped ${skippedForSpace} catalog peer(s) whose announced `
          + `size does not fit under the ${config.program.discoveryP2p.maxPeerDbStorageMb}MB cap`);
      }
      if (skippedForModel > 0) {
        winston.debug(`[discovery-peer-dbs] skipped ${skippedForModel} catalog peer(s) announcing a `
          + `different embedding model (autoFetchIncompatibleModels is off)`);
      }
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

// ── Rotation ─────────────────────────────────────────────────────────────────
//
// The anti-calcification pass: hourly, swap the least-useful long-held
// snapshot for the most-novel catalog peer we don't hold, so the shelf's
// MEMBERSHIP cycles instead of freezing on the first N peers ever heard.
// Policy (who/whether) is pure and lives in discovery-peer-rotation.js;
// this half only executes the swap. Also the only path that ever breaks a
// dead peer's grip: a silent peer on the shelf is exempt from catalog
// retention (the #751 pin-set), so without rotation it would be listed —
// and searched — forever.

function rotationLedgerPath() {
  return path.join(config.program.storage.dbDirectory, 'discovery-p2p', 'rotation.json');
}

function ensureRotationLedger() {
  if (rotationLedger) { return rotationLedger; }
  rotationLedger = {};
  try {
    const raw = JSON.parse(fs.readFileSync(rotationLedgerPath(), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, at] of Object.entries(raw)) {
        if (typeof at === 'string') { rotationLedger[id] = at; }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      winston.warn(`discovery rotation ledger unreadable (${err.message}) — starting empty`);
    }
  }
  return rotationLedger;
}

function recordEviction(endpointId) {
  const ledger = ensureRotationLedger();
  ledger[endpointId] = new Date().toISOString();
  // Cap by dropping the oldest evictions — recent history is what prevents
  // ping-pong; ancient history only grows the file.
  const entries = Object.entries(ledger);
  if (entries.length > ROTATION_LEDGER_MAX) {
    entries.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
    rotationLedger = Object.fromEntries(entries.slice(entries.length - ROTATION_LEDGER_MAX));
  }
  try {
    fs.mkdirSync(path.dirname(rotationLedgerPath()), { recursive: true });
    fs.writeFileSync(rotationLedgerPath(), JSON.stringify(rotationLedger, null, 2));
  } catch (err) {
    winston.warn(`discovery rotation ledger save failed: ${err.message}`);
  }
}

// One rotation pass: at most one swap, and only a swap — never an eviction
// without a replacement in hand. Returns the executed plan (or null).
// Serialized against itself AND against reconcile: both mutate the shelf,
// and interleaved awaits would double-count storage headroom.
export async function rotatePeerDbs() {
  if (rotateInFlight || reconcileInFlight) { return null; }
  rotateInFlight = true;
  try {
    ensureLoaded();
    const cfg = config.program.discoveryP2p;
    const localModel = discoveryDb.openDiscoveryDbIfExists()
      ? discoveryDb.getMeta('embedding_model_id') : null;
    const plan = planRotation({
      shelf: [...registry.values()],
      catalog: discoveryCatalog.list(),
      ledger: ensureRotationLedger(),
      localModel,
      now: Date.now(),
      rotationDays: cfg.rotationDays,
      autoFetch: cfg.autoFetch,
      autoFetchCount: cfg.autoFetchCount,
      capBytes: storageCapBytes(),
      allowIncompatibleModels: cfg.autoFetchIncompatibleModels,
      isBlocked,
      inBackoff: inFetchBackoff,
      seederCountOf: (hash) => discoveryCatalog.seederCount(hash),
    });
    if (!plan) { return null; }

    const evictee = registry.get(plan.evictId);
    const heldSince = evictee?.firstFetchedAt || evictee?.fetchedAt || 'unknown';
    if (plan.evictFirst) {
      // The incoming snapshot needs the evictee's bytes gone first. If the
      // fetch then fails, the shelf runs one short until the next
      // reconcile/rotation pass — logged, bounded, accepted.
      removePeerDb(plan.evictId);
      recordEviction(plan.evictId);
      try {
        await fetchPeer(plan.fetchId);
      } catch (err) {
        recordFetchFailure(plan.fetchId);
        winston.warn(`[discovery-peer-dbs] rotation fetch of ${plan.fetchId.slice(0, 12)}… failed `
          + `after evicting ${plan.evictId.slice(0, 12)}… — shelf runs one short until the next pass: ${err.message}`);
        return plan;
      }
    } else {
      // Fetch-first: a failed download costs nothing — keep the evictee.
      try {
        await fetchPeer(plan.fetchId);
      } catch (err) {
        recordFetchFailure(plan.fetchId);
        winston.warn(`[discovery-peer-dbs] rotation fetch of ${plan.fetchId.slice(0, 12)}… failed `
          + `— keeping ${plan.evictId.slice(0, 12)}… on the shelf: ${err.message}`);
        return null;
      }
      removePeerDb(plan.evictId);
      recordEviction(plan.evictId);
    }
    winston.info(`[discovery-peer-dbs] rotated ${plan.evictId.slice(0, 12)}… `
      + `(held since ${heldSince}) out for ${plan.fetchId.slice(0, 12)}…`);
    return plan;
  } finally {
    rotateInFlight = false;
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
  // Rotation: interval-only by design — the first pass runs one full
  // interval after boot, never during startup (boot already reconciles;
  // rotating before the catalog has re-filled would evict on stale info).
  rotateTimer = setInterval(() => {
    rotatePeerDbs().catch((err) => winston.warn(`[discovery-peer-dbs] rotation failed: ${err.message}`));
  }, ROTATE_INTERVAL_MS);
  if (rotateTimer.unref) { rotateTimer.unref(); }
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
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
}
