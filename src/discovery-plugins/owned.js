// A song this library already has — the check every acquire plug-in makes
// before it fetches anything (by artist + album + title, from the
// recommendation) and again before it files what it fetched (by file hash
// and audio hash), so a second copy of a song never lands. Answers where the
// existing file is, or null.

import * as db from '../db/manager.js';

export function ownedTrack({ hash, audioHash, artist, title, album }, database = db.getDB()) {
  if (!database) { return null; }
  const found = (row) => (row ? { vpath: row.vpath, filepath: `${row.vpath}/${row.filepath}`, by: row.by } : null);
  if (hash) {
    const row = database.prepare(`
      SELECT t.filepath, l.name AS vpath, 'hash' AS by FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.file_hash = ? LIMIT 1`).get(hash);
    if (row) { return found(row); }
  }
  if (audioHash) {
    const row = database.prepare(`
      SELECT t.filepath, l.name AS vpath, 'audio-hash' AS by FROM tracks t JOIN libraries l ON l.id = t.library_id
       WHERE t.audio_hash = ? LIMIT 1`).get(audioHash);
    if (row) { return found(row); }
  }
  if (artist && title && album) {
    const row = database.prepare(`
      SELECT t.filepath, l.name AS vpath, 'tags' AS by FROM tracks t
        JOIN libraries l ON l.id = t.library_id
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
       WHERE lower(t.title) = lower(?) AND lower(a.name) = lower(?) AND lower(al.name) = lower(?) LIMIT 1`)
      .get(String(title), String(artist), String(album));
    if (row) { return found(row); }
  }
  return null;
}
