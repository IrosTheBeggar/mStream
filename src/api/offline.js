/**
 * Offline playback sync endpoints.
 *
 * Produces a filtered SQLite snapshot of the authenticated user's accessible
 * library metadata for the Electron client to store locally. Uses a decoupled
 * export schema (not a raw dump of the server DB) so that:
 *   - Sensitive fields (absolute filepaths, password hashes, other users' data)
 *     are never shipped.
 *   - Server schema changes don't silently break older clients; export schema
 *     is versioned independently via the schema_info table.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { nanoid } from 'nanoid';
import winston from 'winston';
import * as db from '../db/manager.js';

const EXPORT_SCHEMA_VERSION = 1;

const EXPORT_SCHEMA_SQL = `
  CREATE TABLE schema_info (
    version INTEGER NOT NULL,
    server_time TEXT NOT NULL
  );

  CREATE TABLE vpaths (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL
  );

  CREATE TABLE artists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort_name TEXT
  );

  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    artist_id INTEGER,
    year INTEGER
  );

  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    vpath TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_hash TEXT,
    file_size INTEGER,
    modified REAL,
    title TEXT,
    artist_id INTEGER,
    album_id INTEGER,
    track_number INTEGER,
    disc_number INTEGER,
    year INTEGER,
    duration REAL,
    bitrate INTEGER,
    format TEXT,
    genre TEXT
  );

  CREATE INDEX idx_tracks_vpath ON tracks(vpath);
  CREATE INDEX idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX idx_tracks_album ON tracks(album_id);
  CREATE INDEX idx_tracks_hash ON tracks(file_hash);
  CREATE INDEX idx_albums_artist ON albums(artist_id);
`;

export function setup(mstream) {
  mstream.get('/api/v1/offline/snapshot', (req, res) => {
    const tmpPath = path.join(os.tmpdir(), `mstream-snapshot-${nanoid()}.db`);
    let exportDb = null;

    const cleanup = () => {
      if (exportDb) {
        try { exportDb.close(); } catch { /* already closed */ }
        exportDb = null;
      }
      fs.unlink(tmpPath, () => {});
    };

    try {
      const vpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
      const libs = vpaths.map(n => db.getLibraryByName(n)).filter(Boolean);
      if (libs.length === 0) {
        return res.status(403).json({ error: 'No accessible libraries' });
      }
      const libIds = libs.map(l => l.id);
      const placeholders = libIds.map(() => '?').join(',');
      const vpathByLibId = new Map(libs.map(l => [l.id, l.name]));

      exportDb = new DatabaseSync(tmpPath);
      exportDb.exec(EXPORT_SCHEMA_SQL);

      exportDb.prepare('INSERT INTO schema_info (version, server_time) VALUES (?, ?)')
        .run(EXPORT_SCHEMA_VERSION, new Date().toISOString());

      const vpathInsert = exportDb.prepare('INSERT INTO vpaths (name, type) VALUES (?, ?)');
      for (const lib of libs) {
        vpathInsert.run(lib.name, lib.type || 'music');
      }

      const sourceDb = db.getDB();
      exportDb.exec('BEGIN');

      // Artists referenced by any of the user's tracks
      const artistsInsert = exportDb.prepare(
        'INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES (?, ?, ?)'
      );
      const artistRows = sourceDb.prepare(`
        SELECT DISTINCT a.id, a.name, a.sort_name
        FROM artists a
        INNER JOIN tracks t ON t.artist_id = a.id
        WHERE t.library_id IN (${placeholders})
      `).all(...libIds);
      for (const r of artistRows) {
        artistsInsert.run(r.id, r.name, r.sort_name);
      }

      // Albums referenced by any of the user's tracks
      const albumsInsert = exportDb.prepare(
        'INSERT OR IGNORE INTO albums (id, name, artist_id, year) VALUES (?, ?, ?, ?)'
      );
      const albumRows = sourceDb.prepare(`
        SELECT DISTINCT al.id, al.name, al.artist_id, al.year
        FROM albums al
        INNER JOIN tracks t ON t.album_id = al.id
        WHERE t.library_id IN (${placeholders})
      `).all(...libIds);
      for (const r of albumRows) {
        albumsInsert.run(r.id, r.name, r.artist_id, r.year);
      }

      // Tracks — filepath is already relative to the library root; library_id
      // is mapped to the vpath name so clients never see internal IDs.
      const tracksInsert = exportDb.prepare(`
        INSERT INTO tracks
          (id, vpath, relative_path, file_hash, file_size, modified,
           title, artist_id, album_id, track_number, disc_number,
           year, duration, bitrate, format, genre)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const trackRows = sourceDb.prepare(`
        SELECT id, library_id, filepath, file_hash, file_size, modified,
               title, artist_id, album_id, track_number, disc_number,
               year, duration, bitrate, format, genre
        FROM tracks
        WHERE library_id IN (${placeholders})
      `).all(...libIds);
      for (const r of trackRows) {
        tracksInsert.run(
          r.id,
          vpathByLibId.get(r.library_id),
          r.filepath,
          r.file_hash,
          r.file_size,
          r.modified,
          r.title,
          r.artist_id,
          r.album_id,
          r.track_number,
          r.disc_number,
          r.year,
          r.duration,
          r.bitrate,
          r.format,
          r.genre
        );
      }

      exportDb.exec('COMMIT');
      exportDb.close();
      exportDb = null;

      res.download(tmpPath, 'mstream-snapshot.db', (err) => {
        if (err && !res.headersSent) {
          winston.warn('Offline snapshot download failed', { stack: err });
        }
        fs.unlink(tmpPath, () => {});
      });
    } catch (err) {
      winston.error('Offline snapshot build failed', { stack: err });
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Snapshot build failed' });
      }
    }
  });
}
