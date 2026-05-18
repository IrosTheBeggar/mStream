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

/**
 * Single-row lookup. Returns `{infoHash, clientType, userId, vpath,
 * addedAt, downloadPath}` or `null`. Used by the delete-torrent
 * endpoint to find out which client we need to dispatch against
 * before the row is removed. Scoped across clients because the
 * caller doesn't know which client owns the torrent — the row's
 * client_type IS the answer.
 */
export function getByInfoHash(infoHash) {
  if (typeof infoHash !== 'string' || infoHash.length === 0) { return null; }
  const r = db.getDB().prepare(`
    SELECT info_hash, client_type, user_id, vpath, added_at, download_path
    FROM managed_torrents
    WHERE info_hash = ?
    LIMIT 1
  `).get(infoHash.toLowerCase());
  if (!r) { return null; }
  return {
    infoHash:     r.info_hash,
    clientType:   r.client_type,
    userId:       r.user_id,
    vpath:        r.vpath || null,
    addedAt:      r.added_at,
    downloadPath: r.download_path || null,
  };
}

/**
 * Drop the managed_torrents row for a single (info_hash, client_type)
 * pair. Used after the daemon-side remove succeeds (or after we
 * decide a daemon-remove failure isn't worth blocking on). Returns
 * the number of rows deleted — 0 means the row was already gone,
 * which the caller can treat as success.
 */
export function deleteOne(infoHash, clientType) {
  const info = db.getDB().prepare(`
    DELETE FROM managed_torrents
    WHERE info_hash = ? AND client_type = ?
  `).run(infoHash.toLowerCase(), clientType);
  return info.changes;
}

/**
 * Drop every managed_torrents row tied to a vpath name. Called when
 * the library is removed via admin.removeDirectory — the rows would
 * otherwise persist as dangling references to a vpath that no longer
 * exists, polluting the admin list with "external" badges.
 *
 * The TEXT vpath column isn't a foreign key (see PR design notes
 * for why), so this explicit helper is the cleanup path. Returns the
 * number of rows removed for logging.
 */
export function deleteByVpath(vpathName) {
  if (typeof vpathName !== 'string' || vpathName.length === 0) { return 0; }
  const info = db.getDB().prepare(`
    DELETE FROM managed_torrents WHERE vpath = ?
  `).run(vpathName);
  return info.changes;
}
