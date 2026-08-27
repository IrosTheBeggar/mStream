// Accessors for federation_requests (SCHEMA_V67) — the in-network
// federation-request exchange tracked from both roles. Split from
// db/federation.js the way the state machine is split from
// state/federation.js: requests are a lifecycle, keys/peers are the
// durable product.
//
// Time discipline (the EXPIRED_SQL lesson from V62): every timestamp in
// this table is SQLite's canonical UTC 'YYYY-MM-DD HH:MM:SS' and every
// comparison happens IN SQL against datetime('now'), so nothing here ever
// round-trips a stored value through JS Date parsing. JS callers pass
// offsets as SECONDS and the SQL applies them with datetime('now', '+N
// seconds').

import { getDB } from './manager.js';

// Non-terminal states, per direction. The state machine itself lives in
// src/state/federation-requests.js — these lists exist so the TTL sweep
// and the due-retry query stay honest about what "still live" means.
export const ACTIVE_STATES = ['pending-delivery', 'delivered', 'received', 'accepted', 'granting'];

// States that OWE the peer a DM (see the SCHEMA_V67 comment): the retry
// queue only ever picks these up. in/granting deliberately absent — that
// row is waiting to RECEIVE, not to send.
const DM_OWING = `(
     (direction = 'out' AND state = 'pending-delivery')
  OR (direction = 'in'  AND state = 'accepted')
  OR (direction = 'out' AND state = 'granting')
)`;

export function createRequest({
  uuid, direction, peerEndpointId, peerName = null, message = null,
  offeredLibraries = [], state, ttlSeconds, nextAttemptInSeconds = null,
}) {
  const result = getDB().prepare(`
    INSERT INTO federation_requests
      (uuid, direction, peer_endpoint_id, peer_name, message,
       offered_libraries, state, next_attempt_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?,
            CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' seconds') END,
            datetime('now', '+' || ? || ' seconds'))
  `).run(uuid, direction, peerEndpointId, peerName, message,
    JSON.stringify(offeredLibraries), state,
    nextAttemptInSeconds, nextAttemptInSeconds, ttlSeconds);
  return getRequestById(Number(result.lastInsertRowid));
}

function inflate(row) {
  if (!row) { return null; }
  let offered = [];
  try { offered = JSON.parse(row.offered_libraries || '[]'); } catch (_err) { /* tolerate hand-edited rows */ }
  return { ...row, offered_libraries: Array.isArray(offered) ? offered : [] };
}

export function getRequestById(id) {
  return inflate(getDB().prepare('SELECT * FROM federation_requests WHERE id = ?').get(id));
}

export function getRequestByUuid(uuid) {
  return inflate(getDB().prepare('SELECT * FROM federation_requests WHERE uuid = ?').get(uuid));
}

// Admin listing — newest first, both directions together (the UI groups).
export function listRequests() {
  return getDB().prepare(`
    SELECT * FROM federation_requests ORDER BY created_at DESC, id DESC
  `).all().map(inflate);
}

// One-statement state advance + bookkeeping patch. Only the fields a
// transition actually owns get touched; updated_at always moves. Retry
// scheduling: nextAttemptInSeconds > 0 arms the timer, null disarms it
// (terminal states and states that owe nothing).
export function updateRequest(id, {
  state, failCount, nextAttemptInSeconds, mintedKeyId, createdPeerId,
  rejectReason, acceptTheirOffer,
} = {}) {
  const sets = [`updated_at = datetime('now')`];
  const args = [];
  if (state !== undefined) { sets.push('state = ?'); args.push(state); }
  if (failCount !== undefined) { sets.push('fail_count = ?'); args.push(failCount); }
  if (nextAttemptInSeconds !== undefined) {
    if (nextAttemptInSeconds === null) {
      sets.push('next_attempt_at = NULL');
    } else {
      sets.push(`next_attempt_at = datetime('now', '+' || ? || ' seconds')`);
      args.push(nextAttemptInSeconds);
    }
  }
  if (mintedKeyId !== undefined) { sets.push('minted_key_id = ?'); args.push(mintedKeyId); }
  if (createdPeerId !== undefined) { sets.push('created_peer_id = ?'); args.push(createdPeerId); }
  if (rejectReason !== undefined) { sets.push('reject_reason = ?'); args.push(rejectReason); }
  if (acceptTheirOffer !== undefined) { sets.push('accept_their_offer = ?'); args.push(acceptTheirOffer ? 1 : 0); }
  args.push(id);
  return getDB().prepare(`UPDATE federation_requests SET ${sets.join(', ')} WHERE id = ?`).run(...args).changes > 0;
}

// Rows whose owed DM is due. LIMIT keeps one sweep from monopolising the
// process after a long offline stretch — the next sweep picks up the rest.
export function getDueRetries(limit = 10) {
  return getDB().prepare(`
    SELECT * FROM federation_requests
     WHERE ${DM_OWING}
       AND next_attempt_at IS NOT NULL
       AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at
     LIMIT ?
  `).all(limit).map(inflate);
}

// Presence kick: a peer we owe a DM just announced — pull its rows forward
// so the next sweep (or the caller) retries immediately instead of waiting
// out a 6-hour backoff rung.
export function markPeerAttemptsDue(peerEndpointId) {
  return getDB().prepare(`
    UPDATE federation_requests
       SET next_attempt_at = datetime('now'), updated_at = datetime('now')
     WHERE peer_endpoint_id = ?
       AND ${DM_OWING}
       AND next_attempt_at IS NOT NULL
       AND next_attempt_at > datetime('now')
  `).run(peerEndpointId).changes;
}

// ── Inbound abuse-control queries ───────────────────────────────────────────

// Whether ANY exchange is still live, either direction — the DM transport
// must accept while replies are expected, whatever the inbox setting says
// (see pushAcceptPolicy in state/federation-requests.js).
export function hasActiveRequests() {
  return getDB().prepare(`
    SELECT 1 FROM federation_requests
     WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')})
     LIMIT 1
  `).get(...ACTIVE_STATES) !== undefined;
}

export function countPendingInbound() {
  return getDB().prepare(`
    SELECT COUNT(*) AS n FROM federation_requests
     WHERE direction = 'in' AND state = 'received'
  `).get().n;
}

export function hasActiveFromPeer(peerEndpointId) {
  return getDB().prepare(`
    SELECT 1 FROM federation_requests
     WHERE direction = 'in' AND peer_endpoint_id = ?
       AND state IN ('received', 'accepted', 'granting')
     LIMIT 1
  `).get(peerEndpointId) !== undefined;
}

// The 7-day tombstone: a peer we rejected recently gets auto-refused
// without troubling the inbox again.
export function recentlyRejectedPeer(peerEndpointId, days = 7) {
  return getDB().prepare(`
    SELECT 1 FROM federation_requests
     WHERE direction = 'in' AND peer_endpoint_id = ? AND state = 'rejected'
       AND updated_at > datetime('now', '-' || ? || ' days')
     LIMIT 1
  `).get(peerEndpointId, days) !== undefined;
}

// TTL sweep: any live row past its expires_at goes terminal. Returns the
// count plus the minted keys the expiry orphans — rows dying in a state
// that still OWED the credential-bearing DM (in/accepted owes the accept
// ticket, out/granting owes the grant ticket) never confirmed delivery, so
// their minted keys reached nobody and the caller revokes them.
export function expireOverdueRequests() {
  const db = getDB();
  const orphanKeyIds = db.prepare(`
    SELECT minted_key_id FROM federation_requests
     WHERE ${DM_OWING}
       AND state IN ('accepted', 'granting')
       AND minted_key_id IS NOT NULL
       AND expires_at <= datetime('now')
  `).all().map((r) => r.minted_key_id);
  const expired = db.prepare(`
    UPDATE federation_requests
       SET state = 'expired', next_attempt_at = NULL, updated_at = datetime('now')
     WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')})
       AND expires_at <= datetime('now')
  `).run(...ACTIVE_STATES).changes;
  return { expired, orphanKeyIds };
}

export function deleteRequest(id) {
  return getDB().prepare('DELETE FROM federation_requests WHERE id = ?').run(id).changes > 0;
}
