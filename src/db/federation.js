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
export function createFederationKey(name, libraryIds) {
  const db = getDB();
  const key = generateFederationKey();
  db.exec('BEGIN');
  try {
    const result = db.prepare('INSERT INTO federation_keys (key, name) VALUES (?, ?)').run(key, name);
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

// All minted keys with their granted library names aggregated (UI listing).
export function getFederationKeys() {
  return getDB().prepare(`
    SELECT k.*,
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
  return getDB().prepare('SELECT * FROM federation_keys WHERE id = ?').get(id);
}

// Auth-wall lookup: the presented credential -> the key row, or undefined.
export function getFederationKeyByKey(key) {
  return getDB().prepare('SELECT * FROM federation_keys WHERE key = ?').get(key);
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

export function deleteFederationPeer(id) {
  return getDB().prepare('DELETE FROM federation_peers WHERE id = ?').run(id).changes > 0;
}
