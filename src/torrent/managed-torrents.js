// Query helpers for the `managed_torrents` table (V37). The table is
// the join key between Transmission's view of the world (keyed by
// info_hash) and mStream's: rows exist for torrents added through the
// mStream UI, and are absent for torrents added directly via
// Transmission's own clients.
//
// `inPlaceholders` is reused from db/manager to build a `?, ?, ?` list
// matching `hashes.length` — better than building a string by hand and
// safe against injection because the values still bind through
// prepare()/run().

import * as db from '../db/manager.js';

/**
 * Look up rows by info_hash, scoped to a single client type. Returns a
 * `Map<infoHash, {userId, username, vpath, addedAt}>` (entries omitted
 * for hashes with no row).
 *
 * Why scope by client: V38 lets the same hash exist twice in the table
 * — once per client — so an unscoped lookup would return rows for
 * BOTH backends and the list endpoint would happily say "this is
 * mStream-managed" against a Transmission torrent that's actually
 * only known to qBittorrent. The active-client filter prevents that
 * cross-contamination.
 *
 * The list endpoint pre-collects every hash the active client knows
 * about and asks for them all in one shot — faster than N point
 * lookups, and the typical user has O(10–100) torrents so the
 * `IN (?, ?, …)` placeholder list stays comfortably below SQLite's
 * 32k-binding ceiling.
 */
export function getByHashes(hashes, clientType) {
  const out = new Map();
  if (!Array.isArray(hashes) || hashes.length === 0) { return out; }
  if (typeof clientType !== 'string' || clientType.length === 0) {
    // Caller forgot to pass a client; refusing here surfaces the bug
    // loudly rather than silently returning cross-client matches.
    throw new Error('getByHashes: clientType is required');
  }

  const normalised = hashes
    .filter(h => typeof h === 'string' && h.length > 0)
    .map(h => h.toLowerCase());
  if (normalised.length === 0) { return out; }

  const placeholders = db.inPlaceholders(normalised);
  const rows = db.getDB().prepare(`
    SELECT m.info_hash AS info_hash,
           m.user_id   AS user_id,
           m.vpath     AS vpath,
           m.added_at  AS added_at,
           u.username  AS username
    FROM managed_torrents m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.client_type = ?
      AND m.info_hash IN ${placeholders}
  `).all(clientType, ...normalised);

  for (const r of rows) {
    out.set(r.info_hash, {
      userId:   r.user_id,
      username: r.username || null,
      vpath:    r.vpath || null,
      addedAt:  r.added_at,
    });
  }
  return out;
}
