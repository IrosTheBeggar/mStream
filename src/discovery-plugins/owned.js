// A song this library already has — the check every acquire plug-in makes
// before it fetches anything (by artist + album + title, from the
// recommendation) and again before it files what it fetched (by file hash
// and audio hash), so a second copy of a song never lands. Answers where the
// existing file is, or null.
//
// Two things keep the check honest. It looks only into the libraries the
// asking user may see (`libraryIds`, libraryIdsFor(user)): a match in a
// library hidden from them is not a song they have, and its path is not
// theirs to read. And the tag arm is a match on the recording, not the
// name: two tracks of one album that share a title ("Interlude" twice, the
// movements of a box set) are told apart by their track and disc numbers
// and their length, whichever of those both sides know.

import * as db from '../db/manager.js';
import { nameKey } from '../db/name-key.js';

// Two recordings of one song rarely differ by more than this; two songs
// that share a title on one album usually do.
export const DURATION_TOLERANCE_SEC = 5;

// The ids of the libraries a user may see, for `libraryIds`. Null (no
// scope) for a user the server does not scope — a caller without vpaths.
export function libraryIdsFor(user) {
  if (!user || !Array.isArray(user.vpaths)) { return null; }
  return db.getAllLibraries().filter((l) => user.vpaths.includes(l.name)).map((l) => l.id);
}

function scopeClause(libraryIds) {
  if (!Array.isArray(libraryIds)) { return { sql: '', params: [] }; }
  return { sql: ` AND t.library_id IN (${libraryIds.map(() => '?').join(',') || 'NULL'})`, params: libraryIds };
}

// Does a tag match describe the same recording as the peer's or the
// recommendation's song? Unknown on either side means no objection.
function sameRecording(row, { track, disk, duration }) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const t = num(track); const rt = num(row.track_number);
  if (t != null && rt != null && t !== rt) { return false; }
  const d = num(disk); const rd = num(row.disc_number);
  if (d != null && rd != null && d !== rd) { return false; }
  const s = num(duration); const rs = num(row.duration);
  if (s != null && rs != null && Number.isFinite(s) && Number.isFinite(rs) && Math.abs(s - rs) > DURATION_TOLERANCE_SEC) { return false; }
  return true;
}

export function ownedTrack({ hash, audioHash, artist, title, album, track, disk, duration, libraryIds }, database = db.getDB()) {
  if (!database) { return null; }
  if (Array.isArray(libraryIds) && libraryIds.length === 0) { return null; }
  const scope = scopeClause(libraryIds);
  const found = (row) => (row ? { vpath: row.vpath, filepath: `${row.vpath}/${row.filepath}`, by: row.by } : null);
  if (hash) {
    const row = database.prepare(`
      SELECT t.filepath, l.name AS vpath, 'hash' AS by FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.file_hash = ?${scope.sql} LIMIT 1`).get(hash, ...scope.params);
    if (row) { return found(row); }
  }
  if (audioHash) {
    const row = database.prepare(`
      SELECT t.filepath, l.name AS vpath, 'audio-hash' AS by FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.audio_hash = ?${scope.sql} LIMIT 1`).get(audioHash, ...scope.params);
    if (row) { return found(row); }
  }
  if (artist && title && album) {
    const rows = database.prepare(`
      SELECT t.filepath, l.name AS vpath, t.track_number, t.disc_number, t.duration, 'tags' AS by FROM tracks t
        JOIN libraries l ON l.id = t.library_id
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
       WHERE lower(t.title) = lower(?) AND lower(a.name) = lower(?) AND lower(al.name) = lower(?)${scope.sql}
       ORDER BY t.id LIMIT 25`)
      .all(String(title), String(artist), String(album), ...scope.params);
    const row = rows.find((r) => sameRecording(r, { track, disk, duration }));
    if (row) { return found(row); }
  }
  return null;
}

// The albums this library already has by an artist — as its primary album
// artist or an album credit — as normalised name keys (src/db/name-key.js),
// for "what you're missing": an album whose key the set holds is not asked
// for again. Within the user's libraries when `libraryIds` is given, like
// ownedTrack. An album row with no songs left (the Downloads view's Remove
// deletes tracks, not the album row) is not an album the library has.
// `opts` may be null (no database → nothing owned), as the tests pass it.
export function ownedAlbumKeys(artist, opts = {}) {
  const database = opts === null ? null : (opts && opts.database !== undefined ? opts.database : db.getDB());
  const libraryIds = opts && Array.isArray(opts.libraryIds) ? opts.libraryIds : null;
  if (!database || !artist) { return new Set(); }
  if (libraryIds && libraryIds.length === 0) { return new Set(); }
  const scope = scopeClause(libraryIds);
  const key = nameKey(artist);
  const rows = database.prepare(`
    SELECT DISTINCT al.name FROM albums al
     WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id${scope.sql})
       AND (al.artist_id IN (SELECT id FROM artists WHERE name_key = ?)
            OR al.id IN (SELECT aa.album_id FROM album_artists aa
                          WHERE aa.artist_id IN (SELECT id FROM artists WHERE name_key = ?)))`).all(...scope.params, key, key);
  return new Set(rows.map((r) => nameKey(r.name)).filter(Boolean));
}
