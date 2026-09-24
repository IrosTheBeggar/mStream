// Data access for plugin_downloads (V75): the record of every song a plug-in
// brought into a library — which plug-in, for whom, from where, filed
// where, when — and of its removal.
//
// It is its own table because neither neighbour can hold it. The track row
// is rewritten by every rescan from the file's tags (a byte-for-byte copy
// carries no provenance marker, so its `source` would go blank), and the
// job row is pruned after discoveryJobs.retentionDays and dropped by "Clear
// finished". A record keys on the library path the file was filed at and
// keeps the file hash beside it. At most one LIVE record per path: a new
// file at a path an earlier download once had (removed, then fetched again)
// retires the earlier record rather than sitting beside it.
//
// `present` is not stored: a list joins the current track row, so a file a
// scan removed reads as gone without anyone telling this table.

import winston from 'winston';
import * as manager from './manager.js';

const d = () => manager.getDB();

// The joined shape every read returns: the record, the account's name, and
// whether the track row still exists at that path.
const SELECT = `
  SELECT p.*, u.username AS username, t.id AS track_id, (t.id IS NOT NULL) AS present
    FROM plugin_downloads p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN libraries l ON l.name = p.vpath
    LEFT JOIN tracks t ON t.library_id = l.id AND t.filepath = p.filepath`;

export function rowToDownload(row) {
  if (!row) { return null; }
  return {
    id: row.id,
    plugin: row.plugin,
    userId: row.user_id,
    username: row.username == null ? null : row.username,
    jobId: row.job_id,
    vpath: row.vpath,
    // The full library path, spelled the way every other API spells a song.
    filepath: `${row.vpath}/${row.filepath}`,
    relativePath: row.filepath,
    fileHash: row.file_hash,
    origin: row.origin,
    title: row.title,
    artist: row.artist,
    album: row.album,
    bytes: row.bytes,
    downloadedAt: row.downloaded_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
    present: row.present === 1,
    trackId: row.track_id == null ? null : row.track_id,
  };
}

export function get(id) {
  return rowToDownload(d().prepare(`${SELECT} WHERE p.id = ?`).get(id));
}

// A song a plug-in just filed. Called right after the track row is
// inserted; `relativePath` is the row's path (forward slashes, no leading
// slash). Throws on a database error — writers that must not fail the
// download they just finished use recordQuietly().
export function record({ plugin, userId = null, jobId = null, vpath, relativePath, fileHash = null, origin = null, title = null, artist = null, album = null, bytes = null, at = Date.now() }) {
  if (!plugin || !vpath || !relativePath) { throw new Error('record: plugin, vpath and relativePath are required'); }
  const rel = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const db = d();
  // The path is this file's now; an earlier record there is history.
  db.prepare(`
    UPDATE plugin_downloads SET removed_at = ?, removed_by = NULL
     WHERE vpath = ? AND filepath = ? AND removed_at IS NULL
  `).run(at, vpath, rel);
  const res = db.prepare(`
    INSERT INTO plugin_downloads
      (plugin, user_id, job_id, vpath, filepath, file_hash, origin, title, artist, album, bytes, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(plugin), userId, jobId, vpath, rel, fileHash, origin, title, artist, album, bytes, at);
  return get(Number(res.lastInsertRowid));
}

export function recordQuietly(fields) {
  try {
    return record(fields);
  } catch (err) {
    winston.warn(`plugin downloads: could not record ${fields && fields.vpath}/${fields && fields.relativePath} (${err.message}); the song is in the library regardless`);
    return null;
  }
}

// Newest first. `userId` undefined = every account (the admin's view), null
// = the anonymous account's. Removed records are history and hidden unless
// asked for. `before` = an id, for paging.
export function list({ userId, includeRemoved = false, limit = 100, before = null } = {}) {
  const where = [];
  const params = [];
  if (userId !== undefined) { where.push('p.user_id IS ?'); params.push(userId); }
  if (!includeRemoved) { where.push('p.removed_at IS NULL'); }
  if (Number.isInteger(before) && before > 0) { where.push('p.id < ?'); params.push(before); }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  return d().prepare(`${SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.downloaded_at DESC, p.id DESC
    LIMIT ?`).all(...params).map(rowToDownload);
}

// The record behind a library path, live or not (newest).
export function findByPath(vpath, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return rowToDownload(d().prepare(`${SELECT} WHERE p.vpath = ? AND p.filepath = ? ORDER BY p.removed_at IS NOT NULL, p.id DESC`).get(vpath, rel));
}

// The download left the library (the remove route, or nothing was there
// to remove). Returns the record as it now stands; null for an unknown id.
export function markRemoved(id, { by = null, at = Date.now() } = {}) {
  const res = d().prepare('UPDATE plugin_downloads SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL').run(at, by, id);
  return res.changes === 1 ? get(id) : null;
}

// For the admin panel: live records by plug-in, and how many bytes.
export function summary() {
  const rows = d().prepare(`
    SELECT plugin, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM plugin_downloads
     WHERE removed_at IS NULL GROUP BY plugin ORDER BY plugin
  `).all();
  return rows.map((r) => ({ plugin: r.plugin, count: Number(r.n), bytes: Number(r.bytes) }));
}
