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

// Prepared once per DB handle and SQL text: a list asks these hundreds of
// times in one request (api/discovery-owned.js), and preparing was most of
// the cost. The text varies only with the scope clause's length, so the
// map stays small; a replaced handle (a restore) takes its statements
// with it.
const stmtCache = new WeakMap();
function prep(database, sql) {
  let bySql = stmtCache.get(database);
  if (!bySql) { bySql = new Map(); stmtCache.set(database, bySql); }
  let stmt = bySql.get(sql);
  if (!stmt) { stmt = database.prepare(sql); bySql.set(sql, stmt); }
  return stmt;
}

function scopedDatabase(opts) {
  const database = opts === null ? null : (opts && opts.database !== undefined ? opts.database : db.getDB());
  const libraryIds = opts && Array.isArray(opts.libraryIds) ? opts.libraryIds : null;
  return { database, libraryIds };
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
  // Both hash arms are pinned to their index: with the library scope in the
  // WHERE and no ANALYZE stats, the planner serves the lookup from
  // idx_tracks_library instead — a whole-library scan per song, ~1 ms each
  // on a 36k-track index against 0.05 ms pinned (the same trap api/db.js
  // documents for the stat rows). INDEXED BY errors loudly should a
  // migration ever drop the index, rather than regressing to the scan.
  if (hash) {
    const row = prep(database, `
      SELECT t.filepath, l.name AS vpath, 'hash' AS by FROM tracks t INDEXED BY idx_tracks_hash JOIN libraries l ON l.id = t.library_id
       WHERE t.file_hash = ?${scope.sql} LIMIT 1`).get(hash, ...scope.params);
    if (row) { return found(row); }
  }
  if (audioHash) {
    const row = prep(database, `
      SELECT t.filepath, l.name AS vpath, 'audio-hash' AS by FROM tracks t INDEXED BY idx_tracks_audio_hash JOIN libraries l ON l.id = t.library_id
       WHERE t.audio_hash = ?${scope.sql} LIMIT 1`).get(audioHash, ...scope.params);
    if (row) { return found(row); }
  }
  if (artist && title && album) {
    // The artist first, by its identity key (indexed — the scanner's own
    // find-or-create key, so a spelling that folds to the same artist
    // resolves), then that artist's tracks by album and title; the old
    // way compared lower(title) over every track in the library.
    const rows = prep(database, `
      SELECT t.filepath, l.name AS vpath, t.track_number, t.disc_number, t.duration, 'tags' AS by FROM tracks t
        JOIN artists a ON a.id = t.artist_id
        JOIN libraries l ON l.id = t.library_id
        JOIN albums al ON al.id = t.album_id
       WHERE a.name_key = ? AND lower(al.name) = lower(?) AND lower(t.title) = lower(?)${scope.sql}
       ORDER BY t.id LIMIT 25`)
      .all(nameKey(artist), String(album), String(title), ...scope.params);
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
  const { database, libraryIds } = scopedDatabase(opts);
  if (!database || !artist) { return new Set(); }
  if (libraryIds && libraryIds.length === 0) { return new Set(); }
  const scope = scopeClause(libraryIds);
  const key = nameKey(artist);
  const rows = prep(database, `
    SELECT DISTINCT al.name FROM albums al
     WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id${scope.sql})
       AND (al.artist_id IN (SELECT id FROM artists WHERE name_key = ?)
            OR al.id IN (SELECT aa.album_id FROM album_artists aa
                          WHERE aa.artist_id IN (SELECT id FROM artists WHERE name_key = ?)))`).all(...scope.params, key, key);
  return new Set(rows.map((r) => nameKey(r.name)).filter(Boolean));
}

// An album this library has: with the album's own credit (an album card's
// album_artist, or the track artist standing in), the artist scopes' own
// comparison — the artist by its identity key, the album by normalised
// name (ownedAlbumKeys); without a credit, any album of that name, compared
// as the tag arm compares. Only while it still has a track in the user's
// libraries. For the batched lookup (api/discovery-owned.js).
export function ownedAlbum({ album, artist = null, albumArtist = null } = {}, opts = {}) {
  const { database, libraryIds } = scopedDatabase(opts);
  if (!database || !album) { return false; }
  if (libraryIds && libraryIds.length === 0) { return false; }
  const credit = albumArtist || artist;
  if (credit) { return ownedAlbumKeys(credit, { database, libraryIds }).has(nameKey(album)); }
  const scope = scopeClause(libraryIds);
  const row = prep(database, `
    SELECT al.id FROM albums al
     WHERE lower(al.name) = lower(?)
       AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id${scope.sql})
     LIMIT 1`).get(String(album).trim(), ...scope.params);
  return !!row;
}

// What this library has of an artist: whether it has them at all — a track
// of theirs, or an album credited to them, in the user's libraries — and,
// when the asker names the artist's albums as a peer lists them, how many
// of those it holds and which it lacks, by normalised name (the copy
// plug-in's own rule for "what you're missing"). For the batched lookup.
export function ownedArtist(name, opts = {}) {
  const { database, libraryIds } = scopedDatabase(opts);
  const albums = (opts && Array.isArray(opts.albums) ? opts.albums : []).filter((n) => typeof n === 'string' && n.trim());
  const none = { owned: false, have: 0, missing: [...albums] };
  if (!database || !name || !String(name).trim()) { return none; }
  if (libraryIds && libraryIds.length === 0) { return none; }
  const scope = scopeClause(libraryIds);
  const key = nameKey(name);
  const hit = prep(database, `
    SELECT 1 FROM artists a
     WHERE a.name_key = ?
       AND (EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id${scope.sql})
            OR EXISTS (SELECT 1 FROM albums al JOIN tracks t ON t.album_id = al.id WHERE al.artist_id = a.id${scope.sql})
            OR EXISTS (SELECT 1 FROM album_artists aa JOIN tracks t ON t.album_id = aa.album_id WHERE aa.artist_id = a.id${scope.sql}))
     LIMIT 1`).get(key, ...scope.params, ...scope.params, ...scope.params);
  if (!hit) { return none; }
  const keys = albums.length ? ownedAlbumKeys(name, { database, libraryIds }) : new Set();
  const missing = albums.filter((n) => !keys.has(nameKey(n)));
  return { owned: true, have: albums.length - missing.length, missing };
}
