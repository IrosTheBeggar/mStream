import path from 'path';
import { DatabaseSync } from 'node:sqlite';

let db;

export function init(dbDirectory) {
  db = new DatabaseSync(path.join(dbDirectory, 'mstream.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, disk INTEGER,
      modified REAL, hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
      ts INTEGER, sID TEXT, replaygainTrackDb REAL, genre TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_files_filepath_vpath ON files(filepath, vpath);
    CREATE INDEX IF NOT EXISTS idx_files_vpath ON files(vpath);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_ts ON files(ts);

    CREATE TABLE IF NOT EXISTS user_metadata (
      hash TEXT NOT NULL, user TEXT NOT NULL,
      rating INTEGER, pc INTEGER DEFAULT 0, lp INTEGER,
      UNIQUE(hash, user)
    );
    CREATE INDEX IF NOT EXISTS idx_um_user ON user_metadata(user);

    CREATE TABLE IF NOT EXISTS playlists (
      name TEXT NOT NULL, filepath TEXT,
      user TEXT NOT NULL, live INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pl_user_name ON playlists(user, name);

    CREATE TABLE IF NOT EXISTS shared_playlists (
      playlistId TEXT NOT NULL UNIQUE,
      playlist TEXT NOT NULL,
      user TEXT NOT NULL, expires INTEGER, token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sp_expires ON shared_playlists(expires);
  `);
}

export function close() {
  if (db) { db.close(); }
}

// Save operations (no-ops for SQLite - writes are immediate)
export function saveFilesDB() {}
export function saveUserDB() {}
export function saveShareDB() {}

// Helper: build IN clause for variable-length arrays
function vpathFilter(vpaths, ignoreVPaths) {
  const filtered = [];
  for (const v of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(v)) {
      continue;
    }
    filtered.push(v);
  }
  return filtered;
}

function inClause(column, values) {
  if (values.length === 0) { return { sql: '1=0', params: [] }; }
  const placeholders = values.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: values };
}

// File Operations
export function findFileByPath(filepath, vpath) {
  const row = db.prepare('SELECT rowid AS id, * FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  return row || null;
}

export function updateFileScanId(file, scanId) {
  db.prepare('UPDATE files SET sID = ? WHERE filepath = ? AND vpath = ?').run(scanId, file.filepath, file.vpath);
}

export function insertFile(fileData) {
  const stmt = db.prepare(`INSERT INTO files (title, artist, year, album, filepath, format, track, disk, modified, hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(
    fileData.title ?? null, fileData.artist ?? null, fileData.year ?? null, fileData.album ?? null,
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    fileData.ts ?? null, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null
  );
  return { ...fileData, id: Number(result.lastInsertRowid) };
}

export function removeFileByPath(filepath, vpath) {
  db.prepare('DELETE FROM files WHERE filepath = ? AND vpath = ?').run(filepath, vpath);
}

export function removeStaleFiles(vpath, scanId) {
  db.prepare('DELETE FROM files WHERE vpath = ? AND sID != ?').run(vpath, scanId);
}

export function removeFilesByVpath(vpath) {
  db.prepare('DELETE FROM files WHERE vpath = ?').run(vpath);
}

export function countFilesByVpath(vpath) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ?').get(vpath);
  return row.cnt;
}

// Metadata Queries
export function getFileWithMetadata(filepath, vpath, username) {
  const row = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.filepath = ? AND f.vpath = ?
  `).get(username, filepath, vpath);

  if (!row) { return null; }
  return mapFileRow(row);
}

function mapFileRow(row) {
  return {
    ...row,
    'replaygain-track-db': row.replaygainTrackDb
  };
}

export function getArtists(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`SELECT DISTINCT artist FROM files WHERE ${vIn.sql} AND artist IS NOT NULL ORDER BY artist COLLATE NOCASE`).all(...vIn.params);
  return rows.map(r => r.artist);
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`
    SELECT DISTINCT album AS name, year, aaFile AS album_art_file
    FROM files
    WHERE ${vIn.sql} AND artist = ?
    ORDER BY year DESC
  `).all(...vIn.params, String(artist));

  // Deduplicate like Loki backend does (by album+year combo)
  const albums = [];
  const store = {};
  for (const row of rows) {
    if (row.name === null) {
      if (!store[null]) {
        albums.push({ name: null, year: null, album_art_file: row.album_art_file || null });
        store[null] = true;
      }
    } else if (!store[`${row.name}${row.year}`]) {
      albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null });
      store[`${row.name}${row.year}`] = true;
    }
  }
  return albums;
}

export function getAlbums(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`
    SELECT DISTINCT album AS name, aaFile AS album_art_file, year
    FROM files
    WHERE ${vIn.sql} AND album IS NOT NULL
    ORDER BY album COLLATE NOCASE
  `).all(...vIn.params);

  const albums = [];
  const store = {};
  for (const row of rows) {
    if (!store[`${row.name}${row.year}`]) {
      albums.push({ name: row.name, album_art_file: row.album_art_file, year: row.year });
      store[`${row.name}${row.year}`] = true;
    }
  }
  return albums;
}

export function getAlbumSongs(album, vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}
  `;
  const params = [username, ...vIn.params];

  if (album === null) {
    sql += ' AND f.album IS NULL';
  } else {
    sql += ' AND f.album = ?';
    params.push(album);
  }

  if (opts.artist) {
    sql += ' AND f.artist = ?';
    params.push(opts.artist);
  }

  if (opts.year) {
    sql += ' AND f.year = ?';
    params.push(Number(opts.year));
  }

  sql += ' ORDER BY f.disk, f.track, f.filepath';

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const validCols = ['artist', 'album', 'filepath', 'title'];
  if (!validCols.includes(searchCol)) { return []; }

  const vIn = inClause('vpath', filtered);
  const sql = `SELECT rowid AS id, * FROM files WHERE ${vIn.sql} AND ${searchCol} LIKE '%' || ? || '%' COLLATE NOCASE`;
  const rows = db.prepare(sql).all(...vIn.params, String(searchTerm));
  return rows.map(mapFileRow);
}

export function getRatedSongs(vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.rating > 0 AND ${vIn.sql}
    ORDER BY um.rating DESC
  `).all(username, ...vIn.params);
  return rows.map(mapFileRow);
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND f.ts > 0
    ORDER BY f.ts DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
  return rows.map(mapFileRow);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.lp > 0 AND ${vIn.sql}
    ORDER BY um.lp DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
  return rows.map(mapFileRow);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.pc > 0 AND ${vIn.sql}
    ORDER BY um.pc DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
  return rows.map(mapFileRow);
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}
  `;
  const params = [username, ...vIn.params];

  const minRating = Number(opts.minRating);
  if (minRating && typeof minRating === 'number' && minRating <= 10 && !(minRating < 1)) {
    sql += ' AND um.rating >= ?';
    params.push(opts.minRating);
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// User Metadata
export function findUserMetadata(hash, username) {
  const row = db.prepare('SELECT rowid AS id, * FROM user_metadata WHERE hash = ? AND user = ?').get(hash, username);
  return row || null;
}

export function insertUserMetadata(obj) {
  db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, lp) VALUES (?, ?, ?, ?, ?)').run(
    obj.hash, obj.user, obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null
  );
}

export function updateUserMetadata(obj) {
  db.prepare('UPDATE user_metadata SET rating = ?, pc = ?, lp = ? WHERE hash = ? AND user = ?').run(
    obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null, obj.hash, obj.user
  );
}

export function removeUserMetadataByUser(username) {
  db.prepare('DELETE FROM user_metadata WHERE user = ?').run(username);
}

// Playlists
export function getUserPlaylists(username) {
  return db.prepare('SELECT name FROM playlists WHERE user = ? AND filepath IS NULL').all(username);
}

export function findPlaylist(username, playlistName) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? LIMIT 1').get(username, playlistName);
  return row || null;
}

export function createPlaylistEntry(entry) {
  db.prepare('INSERT INTO playlists (name, filepath, user, live) VALUES (?, ?, ?, ?)').run(
    entry.name, entry.filepath ?? null, entry.user, entry.live ? 1 : 0
  );
}

export function deletePlaylist(username, playlistName) {
  db.prepare('DELETE FROM playlists WHERE user = ? AND name = ?').run(username, playlistName);
}

export function getPlaylistEntryById(id) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE rowid = ?').get(id);
  return row || null;
}

export function removePlaylistEntryById(id) {
  db.prepare('DELETE FROM playlists WHERE rowid = ?').run(id);
}

export function loadPlaylistEntries(username, playlistName) {
  return db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? AND filepath IS NOT NULL').all(username, playlistName);
}

export function removePlaylistsByUser(username) {
  db.prepare('DELETE FROM playlists WHERE user = ?').run(username);
}

// Shared Playlists
export function findSharedPlaylist(playlistId) {
  const row = db.prepare('SELECT rowid AS id, * FROM shared_playlists WHERE playlistId = ?').get(playlistId);
  if (!row) { return null; }
  row.playlist = JSON.parse(row.playlist);
  return row;
}

export function insertSharedPlaylist(item) {
  db.prepare('INSERT INTO shared_playlists (playlistId, playlist, user, expires, token) VALUES (?, ?, ?, ?, ?)').run(
    item.playlistId, JSON.stringify(item.playlist), item.user, item.expires ?? null, item.token
  );
}

export function getAllSharedPlaylists() {
  const rows = db.prepare('SELECT rowid AS id, * FROM shared_playlists').all();
  return rows.map(r => ({ ...r, playlist: JSON.parse(r.playlist) }));
}

export function removeSharedPlaylistById(playlistId) {
  db.prepare('DELETE FROM shared_playlists WHERE playlistId = ?').run(playlistId);
}

export function removeExpiredSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(Math.floor(Date.now() / 1000));
}

export function removeEternalSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NULL').run();
}

export function removeSharedPlaylistsByUser(username) {
  db.prepare('DELETE FROM shared_playlists WHERE user = ?').run(username);
}
