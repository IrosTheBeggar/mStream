// Accessors for the federation tables (SCHEMA_V57): keys this server minted
// for read-only peers, their per-key library grants, and the remote peers
// this server can read. Tables live in mstream.db (admin-managed operational
// state FK'd to libraries, same reasoning as backup_destinations), so
// everything goes through db/manager.js's handle.
//
// Key format: 'fedk_' + 32 random bytes base64url. The prefix makes keys
// self-identifying in logs and unambiguous vs JWTs at the auth wall.

import crypto from 'crypto';
import { getDB } from './manager.js';

export const FEDERATION_KEY_PREFIX = 'fedk_';

export function generateFederationKey() {
  return FEDERATION_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// ── Minted keys (inbound grants) ─────────────────────────────────────────────

// Mint a key granting read-only access to the given library ids. The insert
// and its grants are one transaction so a failed grant can't leave a key with
// access to nothing (or worse, everything a later bug assumes).
// `limits` are the V62 bandwidth caps; 0 (the default) means unlimited.
// `expiresAt` is an ISO datetime or null (= never); datetime(?) normalizes
// it to SQLite's canonical UTC form so the stored value compares
// lexicographically against datetime('now').
export function createFederationKey(name, libraryIds, limits = {}, expiresAt = null) {
  const db = getDB();
  const key = generateFederationKey();
  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO federation_keys (key, name, stream_kbps, daily_mb, max_streams, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime(?))
    `).run(key, name, limits.streamKbps || 0, limits.dailyMb || 0, limits.maxStreams || 0, expiresAt);
    const keyId = Number(result.lastInsertRowid);
    const grant = db.prepare('INSERT INTO federation_key_libraries (key_id, library_id) VALUES (?, ?)');
    for (const libId of libraryIds) { grant.run(keyId, libId); }
    db.exec('COMMIT');
    return { id: keyId, key, name };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

export function setFederationKeyLimits(id, { streamKbps, dailyMb, maxStreams }) {
  return getDB().prepare(`
    UPDATE federation_keys SET stream_kbps = ?, daily_mb = ?, max_streams = ? WHERE id = ?
  `).run(streamKbps || 0, dailyMb || 0, maxStreams || 0, id).changes > 0;
}

// Set or clear (null = never) a key's expiry. Setting a future date on an
// already-expired key is the renewal path — nothing else needs resetting.
export function setFederationKeyExpiry(id, expiresAt) {
  return getDB().prepare(`
    UPDATE federation_keys SET expires_at = datetime(?) WHERE id = ?
  `).run(expiresAt ?? null, id).changes > 0;
}

// Every key read carries a computed `expired` (0/1). The comparison lives
// in SQL on purpose: both sides are datetime('now')-format UTC strings, so
// it's chronologically correct — JS Date.parse would read the stored
// format as LOCAL time and drift the cutoff by the machine's UTC offset.
const EXPIRED_SQL = `(expires_at IS NOT NULL AND expires_at <= datetime('now')) AS expired`;

// All minted keys with their granted library names aggregated (UI listing).
export function getFederationKeys() {
  return getDB().prepare(`
    SELECT k.*, ${EXPIRED_SQL},
           (SELECT json_group_array(l.name)
              FROM federation_key_libraries kl
              JOIN libraries l ON l.id = kl.library_id
             WHERE kl.key_id = k.id) AS library_names_json
      FROM federation_keys k
     ORDER BY k.created_at, k.id
  `).all().map((row) => ({
    ...row,
    library_names: JSON.parse(row.library_names_json || '[]'),
  }));
}

export function getFederationKeyById(id) {
  return getDB().prepare(`SELECT *, ${EXPIRED_SQL} FROM federation_keys WHERE id = ?`).get(id);
}

// Auth-wall lookup: the presented credential -> the key row, or undefined.
export function getFederationKeyByKey(key) {
  return getDB().prepare(`SELECT *, ${EXPIRED_SQL} FROM federation_keys WHERE key = ?`).get(key);
}

// The libraries a key grants, as [{ id, name }] (auth wall + UI).
export function getFederationKeyLibraries(keyId) {
  return getDB().prepare(`
    SELECT l.id, l.name
      FROM federation_key_libraries kl
      JOIN libraries l ON l.id = kl.library_id
     WHERE kl.key_id = ?
     ORDER BY l.name
  `).all(keyId);
}

export function deleteFederationKey(id) {
  return getDB().prepare('DELETE FROM federation_keys WHERE id = ?').run(id).changes > 0;
}

// TOFU: bind the key to the first endpoint that redeems it. Guarded WHERE so
// a concurrent handshake can't re-bind an already-bound key — the caller must
// re-read the row and reject on mismatch when this returns false.
export function bindFederationKeyEndpoint(id, endpointId) {
  return getDB().prepare(`
    UPDATE federation_keys
       SET bound_endpoint_id = ?, bound_at = datetime('now')
     WHERE id = ? AND bound_endpoint_id IS NULL
  `).run(endpointId, id).changes > 0;
}

// Admin "friend reinstalled" escape hatch: clear the TOFU binding without
// re-minting (the next successful handshake re-binds).
export function resetFederationKeyBinding(id) {
  return getDB().prepare(`
    UPDATE federation_keys
       SET bound_endpoint_id = NULL, bound_at = NULL
     WHERE id = ?
  `).run(id).changes > 0;
}

// last_used touch, throttled in-process so the auth wall doesn't write a row
// per request — one update per key per minute is plenty for a UI freshness
// indicator.
const LAST_USED_THROTTLE_MS = 60 * 1000;
const lastTouched = new Map(); // keyId -> epoch ms of last write
export function touchFederationKeyLastUsed(id) {
  const now = Date.now();
  const prev = lastTouched.get(id);
  if (prev !== undefined && now - prev < LAST_USED_THROTTLE_MS) { return; }
  lastTouched.set(id, now);
  getDB().prepare(`UPDATE federation_keys SET last_used = datetime('now') WHERE id = ?`).run(id);
}

// ── Usage counters (per key, per UTC day) ────────────────────────────────────
// Written by api/federation-limits.js's throttled accumulator, never per
// request. `day` is 'YYYY-MM-DD' (UTC) everywhere.

export function recordFederationKeyUsage(keyId, day, bytes, requests) {
  getDB().prepare(`
    INSERT INTO federation_key_usage (key_id, day, bytes, requests) VALUES (?, ?, ?, ?)
    ON CONFLICT (key_id, day) DO UPDATE SET bytes = bytes + excluded.bytes,
                                            requests = requests + excluded.requests
  `).run(keyId, day, bytes, requests);
}

export function getFederationKeyUsage(keyId, day) {
  return getDB().prepare(`
    SELECT bytes, requests FROM federation_key_usage WHERE key_id = ? AND day = ?
  `).get(keyId, day) || { bytes: 0, requests: 0 };
}

// One day's usage for every key at once (admin key-list decoration).
export function getFederationUsageForDay(day) {
  const rows = getDB().prepare(`
    SELECT key_id, bytes, requests FROM federation_key_usage WHERE day = ?
  `).all(day);
  return new Map(rows.map((r) => [r.key_id, { bytes: r.bytes, requests: r.requests }]));
}

// Quota history has no value past the admin's "recent traffic" window; the
// flusher calls this at most once a day.
export function pruneFederationKeyUsage(keepDays = 90) {
  return getDB().prepare(`
    DELETE FROM federation_key_usage WHERE day < date('now', ?)
  `).run(`-${keepDays} days`).changes;
}

// ── Peers (outbound: servers we can read) ────────────────────────────────────

export function addFederationPeer({ name, endpointTicket, apiKey }) {
  const result = getDB().prepare(`
    INSERT INTO federation_peers (name, endpoint_ticket, api_key) VALUES (?, ?, ?)
  `).run(name, endpointTicket, apiKey);
  return getFederationPeerById(Number(result.lastInsertRowid));
}

export function getFederationPeers() {
  return getDB().prepare('SELECT * FROM federation_peers ORDER BY added_at, id').all();
}

export function getFederationPeerById(id) {
  return getDB().prepare('SELECT * FROM federation_peers WHERE id = ?').get(id);
}

// Cache the latest health-check outcome for the admin UI. status 'ok' also
// stamps last_seen; a failure only updates last_status so last_seen keeps
// showing when the peer was last actually reachable.
export function updateFederationPeerStatus(id, status) {
  if (status === 'ok') {
    return getDB().prepare(`
      UPDATE federation_peers SET last_status = 'ok', last_seen = datetime('now') WHERE id = ?
    `).run(id).changes > 0;
  }
  return getDB().prepare('UPDATE federation_peers SET last_status = ? WHERE id = ?').run(status, id).changes > 0;
}

// The outbound discovery-over-federation opt-out (V58): whether OUR Discover
// panel may send this peer similarity queries. See api/discovery-federation.js.
export function setFederationPeerUseDiscovery(id, enabled) {
  return getDB().prepare('UPDATE federation_peers SET use_discovery = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id).changes > 0;
}

export function deleteFederationPeer(id) {
  return getDB().prepare('DELETE FROM federation_peers WHERE id = ?').run(id).changes > 0;
}
