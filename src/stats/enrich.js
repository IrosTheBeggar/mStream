// Stats API v2 — completing federated plays from the peer's own metadata.
//
// A play of a peer's track counts on THIS server (the peer never sees it),
// and this library has no row for the track, so the event stores whatever
// snapshot the app had at hand — often thin: a filename for a title, no
// album, no duration, and the peer's FILE hash where local counters key on
// the AUDIO hash. After the ingest commit (and once a day for whatever is
// still thin), this module asks the peer for the tracks' real metadata,
// completes the snapshot, and re-keys the play onto the canonical hash so
// the same file turning up in this library merges the plays.
//
// Best-effort, off the request path, never able to fail an ingest: a peer
// that is offline, slow, or unknown leaves the row as it came, and the
// backfill asks again next time. A peer that answers — even with "no such
// track" — settles the row for good (`enrichedAt`), so a row is asked
// about once.

import winston from 'winston';
import * as db from '../db/manager.js';
import * as fedDb from '../db/federation.js';
import * as fedClient from '../state/federation-client.js';
import { migrateHashReferences } from '../db/hash-migration.js';
import { updateEventSnapshot, thinPeerEvents } from './store.js';

export const DEADLINE_MS = 4000;          // dial included — a stopped peer answers nothing
export const PATHS_PER_CALL = 100;        // one metadata/batch call per chunk
export const BACKFILL_PER_RUN = 300;      // thin rows per daily pass, newest first

const isStr = (v) => typeof v === 'string' && v.length > 0;

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// The peer call: POST /api/v1/db/metadata/batch (on the federation
// allowlist) with the peer-side paths; answers { [path]: { filepath,
// metadata|null } }. A test points it at a local fake over plain HTTP —
// the same MSTREAM_TEST_* pattern as the Last.fm endpoint.
export async function fetchPeerMetadata(peer, filepaths, { deadlineMs = DEADLINE_MS } = {}) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filepaths) };
  const testEndpoint = process.env.MSTREAM_TEST_FED_ENRICH_ENDPOINT;
  const res = testEndpoint
    ? await fetch(`http://${testEndpoint}/api/v1/db/metadata/batch`, {
      ...opts, headers: { ...opts.headers, 'x-federation-key': peer.api_key }, signal: AbortSignal.timeout(deadlineMs),
    })
    : await withDeadline(fedClient.fedFetch(peer, '/api/v1/db/metadata/batch', opts), deadlineMs);
  if (!res.ok) { throw new Error(`http ${res.status}`); }
  const body = await res.json();
  return body && typeof body === 'object' ? body : {};
}

export function parseSnapshot(value) {
  if (value == null) { return {}; }
  if (typeof value === 'object') { return { ...value }; }
  try { const v = JSON.parse(value); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

// The completed snapshot: the peer's library is authoritative for its own
// track, so its strings win; the app's stay where the peer had none. The
// hash becomes the canonical key (audio hash, else file hash).
export function mergeSnapshot(snapshot, metadata, nowMs = Date.now()) {
  const snap = parseSnapshot(snapshot);
  const m = metadata && typeof metadata === 'object' ? metadata : null;
  if (m) {
    if (isStr(m.title)) { snap.title = m.title; }
    if (isStr(m.artist)) { snap.artist = m.artist; }
    if (isStr(m.album)) { snap.album = m.album; }
    if (Number.isFinite(m.duration) && m.duration > 0) { snap.durationMs = Math.round(m.duration * 1000); }
    if (isStr(m['album-art'])) { snap.artFile = m['album-art']; }
    const canonical = isStr(m['audio-hash']) ? m['audio-hash'] : (isStr(m.hash) ? m.hash : null);
    if (canonical) { snap.hash = canonical; }
  }
  snap.enrichedAt = nowMs;
  return snap;
}

// One row, one answer (metadata or null): store the completed snapshot
// and, when the key changed, move the play — and every other row and
// counter under the old key — onto the canonical one.
export function applyEnrichment(d, row, metadata, nowMs = Date.now()) {
  const snap = mergeSnapshot(row.snapshot, metadata, nowMs);
  updateEventSnapshot(d, row.event_id, snap);
  const canonical = isStr(snap.hash) ? snap.hash : null;
  let rekeyed = false;
  if (canonical && row.track_hash && canonical !== row.track_hash) {
    migrateHashReferences(d, row.track_hash, canonical);
    rekeyed = true;
  } else if (canonical && !row.track_hash) {
    d.prepare('UPDATE play_events SET track_hash = ? WHERE event_id = ?').run(canonical, row.event_id);
    rekeyed = true;
  }
  return { rekeyed, snapshot: snap };
}

// Ingest hands over its event objects; the backfill hands over rows. Both
// become the row shape here.
export function toRow(e) {
  return {
    event_id: e.event_id ?? e.eventId,
    user_id: e.user_id ?? e.userId ?? null,
    track_hash: e.track_hash ?? e.trackHash ?? null,
    filepath: e.filepath,
    peer_id: e.peer_id ?? e.peerId ?? null,
    snapshot: e.snapshot ?? null,
  };
}

const needsEnrichment = (row) => row.peer_id != null && row.event_id && parseSnapshot(row.snapshot).enrichedAt == null;

// Injectable for tests: the peer call, the peer list, the database, the
// logger, the clock.
export function createEnricher({
  fetchPeer = fetchPeerMetadata,
  getPeers = () => fedDb.getFederationPeers(),
  getDb = () => db.getDB(),
  logger = winston,
  now = () => Date.now(),
  deadlineMs = DEADLINE_MS,
} = {}) {
  const pending = new Map();   // event_id -> row
  let draining = null;         // the in-flight drain, for flush()
  const stats = { enriched: 0, rekeyed: 0, unknown: 0, failed: 0, lastRunAt: null, lastError: null };

  async function drainOnce() {
    const d = getDb();
    if (!d || pending.size === 0) { return; }
    const rows = [...pending.values()];
    pending.clear();
    stats.lastRunAt = new Date(now()).toISOString();
    const peers = new Map((getPeers() || []).map((p) => [p.id, p]));
    const byPeer = new Map();
    for (const row of rows) {
      if (!byPeer.has(row.peer_id)) { byPeer.set(row.peer_id, []); }
      byPeer.get(row.peer_id).push(row);
    }
    for (const [peerId, peerRows] of byPeer) {
      const peer = peers.get(peerId);
      if (!peer) { stats.failed += peerRows.length; continue; }   // peer gone since — the row can never be completed
      const paths = [...new Set(peerRows.map((r) => r.filepath).filter(isStr))];
      const answers = new Map();
      try {
        for (let i = 0; i < paths.length; i += PATHS_PER_CALL) {
          const chunk = paths.slice(i, i + PATHS_PER_CALL);
          const body = await fetchPeer(peer, chunk, { deadlineMs });
          for (const p of chunk) {
            const entry = body[p];
            answers.set(p, entry && typeof entry === 'object' ? (entry.metadata ?? null) : null);
          }
        }
      } catch (err) {
        stats.failed += peerRows.length;
        stats.lastError = `${peer.name || peerId}: ${err.message}`;
        logger.debug(`[stats] enrichment: peer ${peerId} ('${peer.name}') not answered — ${err.message}; ${peerRows.length} row(s) left for the backfill`);
        continue;
      }
      d.exec('BEGIN IMMEDIATE');
      try {
        for (const row of peerRows) {
          const metadata = answers.get(row.filepath) ?? null;
          const r = applyEnrichment(d, row, metadata, now());
          if (metadata) { stats.enriched++; } else { stats.unknown++; }
          if (r.rekeyed) { stats.rekeyed++; }
        }
        d.exec('COMMIT');
      } catch (err) {
        try { d.exec('ROLLBACK'); } catch (_) { /* already out of the transaction */ }
        stats.failed += peerRows.length;
        stats.lastError = err.message;
        logger.warn(`[stats] enrichment: applying peer ${peerId}'s answers failed: ${err.message}`);
      }
    }
  }

  function schedule() {
    if (draining) { return draining; }
    draining = new Promise((resolve) => setImmediate(resolve))
      .then(async () => { while (pending.size > 0) { await drainOnce(); } })
      .catch((err) => { stats.lastError = err.message; logger.warn(`[stats] enrichment pass failed: ${err.message}`); })
      .finally(() => { draining = null; });
    return draining;
  }

  return {
    // Rows or ingest events; only federated rows not yet completed are kept.
    enqueue(items) {
      let added = 0;
      for (const item of items || []) {
        const row = toRow(item);
        if (!needsEnrichment(row) || pending.has(row.event_id)) { continue; }
        pending.set(row.event_id, row);
        added++;
      }
      if (added > 0) { schedule(); }
      return added;
    },
    // Whatever is still thin in the log, newest first, bounded per run.
    backfill({ limit = BACKFILL_PER_RUN } = {}) {
      const d = getDb();
      if (!d) { return Promise.resolve(0); }
      const added = this.enqueue(thinPeerEvents(d, { limit }));
      return this.flush().then(() => added);
    },
    flush() { return draining || Promise.resolve(); },
    pending() { return pending.size; },
    stats() { return { ...stats, pending: pending.size }; },
  };
}

// The process-wide enricher the routes and the daily sweep use.
let shared = null;
export function enricher() {
  if (!shared) { shared = createEnricher(); }
  return shared;
}
