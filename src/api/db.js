import Joi from 'joi';
import path from 'path';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import { joiValidate, dualId } from '../util/validation.js';
import WebError from '../util/web-error.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function renderMetadataObj(row) {
  const lib = db.getLibraryByName(row.library_name || '');
  const fullPath = lib
    ? path.join(lib.name, row.filepath).replace(/\\/g, '/')
    : row.filepath;

  return {
    filepath: fullPath,
    metadata: {
      artist: row.artist_name || null,
      hash: row.file_hash || null,
      album: row.album_name || null,
      track: row.track_number || null,
      disk: row.disc_number || null,
      title: row.title || null,
      year: row.year || null,
      'album-art': row.album_art_file || null,
      rating: row.rating || null,
      'play-count': row.play_count || null,
      'last-played': row.last_played || null,
      'replaygain-track': row.replaygain_track_db || null
    }
  };
}

// Build library filter clause for user access
export function libraryFilter(user, ignoreVPaths) {
  let libIds = db.getUserLibraryIds(user);

  // Filter out ignored libraries by name (matches v5.16 ignoreVPaths behavior)
  if (Array.isArray(ignoreVPaths) && ignoreVPaths.length > 0) {
    const allLibs = db.getAllLibraries();
    const ignoredIds = new Set(
      allLibs.filter(l => ignoreVPaths.includes(l.name)).map(l => l.id)
    );
    libIds = libIds.filter(id => !ignoredIds.has(id));
  }

  if (libIds.length === 0) { return { clause: '1=0', params: [] }; }
  return {
    clause: `t.library_id IN (${libIds.map(() => '?').join(',')})`,
    params: libIds
  };
}

// Base query: tracks joined with artists, albums, library, and optionally user_metadata
export function trackQuery(userId) {
  return `
    SELECT t.*, a.name AS artist_name, al.name AS album_name,
           l.name AS library_name,
           um.rating, um.play_count, um.last_played
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN libraries l ON t.library_id = l.id
    LEFT JOIN user_metadata um ON COALESCE(t.audio_hash, t.file_hash) = um.track_hash AND um.user_id = ${userId ? '?' : 'NULL'}
  `;
}

// ── Exported metadata lookup (used by other modules) ────────────────────────

// ── Search response shapers ─────────────────────────────────────────────────
//
// Four pure functions that take a raw DB row and produce one item of
// the /api/v1/db/search response envelope. Extracted so PR3's FTS path
// emits envelopes byte-identical to the LIKE path — same keys, same
// types, same `filepath: false` sentinel on artist/album items. The
// envelope-parity test in PR3 imports these directly to assert that
// both algorithm paths run through the same shape callbacks.
//
// All four shapers expect these column names on the row:
//   - shapeArtistRow: { name, album_art_file }
//   - shapeAlbumRow:  { name, album_art_file }
//   - shapeTitleRow:  { title, album_art_file, artist_name, library_name, filepath }
//   - shapeFileRow:   { library_name, filepath, album_art_file }
//
// LIKE and FTS queries SELECT exactly those columns so callers don't
// need to reshape twice.

export function shapeArtistRow(r) {
  return {
    name: r.name,
    album_art_file: r.album_art_file || null,
    filepath: false,
  };
}

export function shapeAlbumRow(r) {
  return {
    name: r.name,
    album_art_file: r.album_art_file || null,
    filepath: false,
  };
}

export function shapeTitleRow(r) {
  const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
  return {
    name: r.artist_name ? `${r.artist_name} - ${r.title}` : r.title,
    album_art_file: r.album_art_file || null,
    filepath: fp,
  };
}

export function shapeFileRow(r) {
  const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
  return {
    name: fp,
    album_art_file: r.album_art_file || null,
    filepath: fp,
  };
}

// ── LIKE search path ────────────────────────────────────────────────────────
//
// Runs the four pre-V31 LIKE queries (artists, albums, titles, files)
// and returns the search response envelope. Pure helper — extracted
// from the inline /api/v1/db/search handler in preparation for PR3,
// which will introduce an `algorithm` request param and a parallel
// FTS5 path. Both paths return the same envelope via the shape*
// callbacks above.
//
// opts: { noArtists, noAlbums, noTitles, noFiles, ignoreVPaths }
// search: the raw user query string (LIKE-wildcarded internally)
export function runLikeSearch(req, search, opts = {}) {
  const d = db.getDB();
  const filter = libraryFilter(req.user, opts.ignoreVPaths);
  const searchPattern = `%${search}%`;

  const artists = opts.noArtists ? [] : d.prepare(`
    SELECT DISTINCT a.name, (
      SELECT t2.album_art_file FROM tracks t2
      WHERE t2.artist_id = a.id AND t2.album_art_file IS NOT NULL
      LIMIT 1
    ) AS album_art_file
    FROM artists a JOIN tracks t ON t.artist_id = a.id
    WHERE a.name LIKE ? AND ${filter.clause}
    ORDER BY a.name COLLATE NOCASE LIMIT 30
  `).all(searchPattern, ...filter.params).map(shapeArtistRow);

  const albums = opts.noAlbums ? [] : d.prepare(`
    SELECT DISTINCT al.name, al.album_art_file
    FROM albums al JOIN tracks t ON t.album_id = al.id
    WHERE al.name LIKE ? AND ${filter.clause}
    ORDER BY al.name COLLATE NOCASE LIMIT 30
  `).all(searchPattern, ...filter.params).map(shapeAlbumRow);

  const title = opts.noTitles ? [] : d.prepare(`
    SELECT t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
    FROM tracks t
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.title LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(searchPattern, ...filter.params).map(shapeTitleRow);

  const files = opts.noFiles ? [] : d.prepare(`
    SELECT l.name AS library_name, t.filepath, t.album_art_file
    FROM tracks t JOIN libraries l ON t.library_id = l.id
    WHERE t.filepath LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(searchPattern, ...filter.params).map(shapeFileRow);

  return { artists, albums, title, files };
}

export function pullMetaData(filepath, user) {
  const d = db.getDB();
  if (!d) { return { filepath: filepath, metadata: null }; }

  let pathInfo;
  try { pathInfo = vpath.getVPathInfo(filepath, user); } catch (_e) {
    return { filepath: filepath, metadata: null };
  }

  const lib = db.getLibraryByName(pathInfo.vpath);
  if (!lib) { return { filepath: filepath, metadata: null }; }

  const row = d.prepare(`
    ${trackQuery(user?.id)}
    WHERE t.filepath = ? AND t.library_id = ?
  `).get(...(user?.id ? [user.id] : []), pathInfo.relativePath, lib.id);

  if (!row) { return { filepath: filepath, metadata: null }; }
  return renderMetadataObj(row);
}

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  const d = () => db.getDB();

  // ── Status ──────────────────────────────────────────────────────────────

  mstream.get('/api/v1/db/status', (req, res) => {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const row = d().prepare(
      `SELECT COUNT(*) AS total FROM tracks t WHERE ${filter.clause}`
    ).get(...filter.params);

    res.json({
      totalFileCount: row.total,
      locked: dbQueue.isScanning()
    });
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/metadata', (req, res) => {
    res.json(pullMetaData(req.body.filepath, req.user));
  });

  mstream.post('/api/v1/db/metadata/batch', (req, res) => {
    const returnThis = {};
    req.body.forEach(f => {
      returnThis[f] = pullMetaData(f, req.user);
    });
    res.json(returnThis);
  });

  // ── Artists ─────────────────────────────────────────────────────────────

  function getArtists(req) {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const rows = d().prepare(`
      SELECT DISTINCT a.name
      FROM artists a
      JOIN tracks t ON t.artist_id = a.id
      WHERE ${filter.clause}
      ORDER BY a.name COLLATE NOCASE
    `).all(...filter.params);

    return { artists: rows.map(r => r.name) };
  }

  mstream.get('/api/v1/db/artists', (req, res) => res.json(getArtists(req)));
  mstream.post('/api/v1/db/artists', (req, res) => res.json(getArtists(req)));

  // ── Artist Albums ───────────────────────────────────────────────────────

  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);

    // V17: also include albums where this artist appears in album_artists
    // or track_artists (compilation / collab appearances) — "click Artist A
    // → see every album Artist A is on" stays correct after the schema
    // change.
    const albumRows = d().prepare(`
      SELECT DISTINCT al.name, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      WHERE (
        al.artist_id IN (SELECT id FROM artists WHERE name = ?)
        OR al.id IN (SELECT album_id FROM album_artists
                     WHERE artist_id IN (SELECT id FROM artists WHERE name = ?))
        OR al.id IN (SELECT t2.album_id FROM track_artists ta
                     JOIN tracks t2 ON t2.id = ta.track_id
                     WHERE ta.artist_id IN (SELECT id FROM artists WHERE name = ?)
                       AND t2.album_id IS NOT NULL)
      ) AND ${filter.clause}
      ORDER BY al.year DESC
    `).all(String(req.body.artist), String(req.body.artist), String(req.body.artist), ...filter.params);

    const albums = albumRows.map(r => ({
      name: r.name,
      year: r.year,
      album_art_file: r.album_art_file || null
    }));

    // Check for tracks with no album (null album_id) by this artist
    const nullAlbumRow = d().prepare(`
      SELECT t.album_art_file
      FROM tracks t
      JOIN artists a ON t.artist_id = a.id
      WHERE a.name = ? AND t.album_id IS NULL AND ${filter.clause}
      LIMIT 1
    `).get(String(req.body.artist), ...filter.params);

    if (nullAlbumRow) {
      albums.push({
        name: null,
        year: null,
        album_art_file: nullAlbumRow.album_art_file || null
      });
    }

    res.json({ albums });
  });

  // ── Albums ──────────────────────────────────────────────────────────────

  function getAlbums(req) {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const rows = d().prepare(`
      SELECT DISTINCT al.name, al.year, al.album_art_file
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      WHERE ${filter.clause}
      ORDER BY al.name COLLATE NOCASE
    `).all(...filter.params);

    return { albums: rows.map(r => ({
      name: r.name,
      year: r.year,
      album_art_file: r.album_art_file || null
    }))};
  }

  mstream.get('/api/v1/db/albums', (req, res) => res.json(getAlbums(req)));
  mstream.post('/api/v1/db/albums', (req, res) => res.json(getAlbums(req)));

  // ── Genres ──────────────────────────────────────────────────────────────

  function getGenres(req) {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const rows = d().prepare(`
      SELECT DISTINCT g.name, COUNT(DISTINCT t.id) AS track_count
      FROM genres g
      JOIN track_genres tg ON tg.genre_id = g.id
      JOIN tracks t ON t.id = tg.track_id
      WHERE ${filter.clause}
      GROUP BY g.id
      ORDER BY g.name COLLATE NOCASE
    `).all(...filter.params);

    return { genres: rows.map(r => ({ name: r.name, track_count: r.track_count })) };
  }

  mstream.get('/api/v1/db/genres', (req, res) => res.json(getGenres(req)));
  mstream.post('/api/v1/db/genres', (req, res) => res.json(getGenres(req)));

  // ── Genre Songs ─────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/genre-songs', (req, res) => {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const allParams = req.user?.id
      ? [req.user.id, String(req.body.genre), ...filter.params]
      : [String(req.body.genre), ...filter.params];

    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      WHERE g.name = ? AND ${filter.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.disc_number, t.track_number
    `).all(...allParams);

    res.json(rows.map(renderMetadataObj));
  });

  // ── Album Songs ─────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const conditions = [filter.clause];
    const params = [...filter.params];

    if (req.body.album) {
      conditions.push('al.name = ?');
      params.push(String(req.body.album));
    } else {
      conditions.push('t.album_id IS NULL');
    }

    if (req.body.artist) {
      conditions.push('a.name = ?');
      params.push(String(req.body.artist));
    }

    if (req.body.year) {
      conditions.push('t.year = ?');
      params.push(Number(req.body.year));
    }

    // Add user ID for metadata join
    const allParams = req.user?.id ? [req.user.id, ...params] : params;

    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.disc_number, t.track_number, t.filepath
    `).all(...allParams);

    res.json(rows.map(renderMetadataObj));
  });

  // ── Search ──────────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/search', (req, res) => {
    const schema = Joi.object({
      search: Joi.string().required(),
      noArtists: Joi.boolean().optional(),
      noAlbums: Joi.boolean().optional(),
      noTitles: Joi.boolean().optional(),
      noFiles: Joi.boolean().optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    // Pure refactor — behaviour is identical to the inline LIKE path
    // that lived here before PR2. PR3 will add an `algorithm` request
    // param and a parallel FTS5 path; both will route through helpers
    // co-located with this one.
    res.json(runLikeSearch(req, req.body.search, {
      noArtists: req.body.noArtists,
      noAlbums: req.body.noAlbums,
      noTitles: req.body.noTitles,
      noFiles: req.body.noFiles,
      ignoreVPaths: req.body.ignoreVPaths,
    }));
  });

  // ── Rated Songs ─────────────────────────────────────────────────────────

  function getRatedSongs(req) {
    if (!req.user?.id) { return []; }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const rows = d().prepare(`
      ${trackQuery(req.user.id)}
      WHERE um.rating > 0 AND ${filter.clause}
      ORDER BY um.rating DESC
    `).all(req.user.id, ...filter.params);

    return rows.map(renderMetadataObj);
  }

  mstream.get('/api/v1/db/rated', (req, res) => res.json(getRatedSongs(req)));
  mstream.post('/api/v1/db/rated', (req, res) => res.json(getRatedSongs(req)));

  // ── Rate Song ───────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/rate-song', (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      rating: Joi.number().integer().min(0).max(10).allow(null).required()
    });
    joiValidate(schema, req.body);

    const pathInfo = vpath.getVPathInfo(req.body.filepath);
    const lib = db.getLibraryByName(pathInfo.vpath);
    if (!lib) { throw new Error('Library not found'); }

    const track = d().prepare(
      'SELECT file_hash, audio_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);
    if (!track) { throw new Error('File Not Found'); }

    d().prepare(`
      INSERT INTO user_metadata (user_id, track_hash, rating)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, track_hash) DO UPDATE SET rating = excluded.rating
    `).run(req.user.id, track.audio_hash || track.file_hash, req.body.rating);

    res.json({});
  });

  // ── Recent Added ────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/recent/added', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const allParams = req.user?.id ? [req.user.id, ...filter.params] : filter.params;

    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE ${filter.clause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(...allParams, req.body.limit);

    res.json(rows.map(renderMetadataObj));
  });

  // ── Recently Played ─────────────────────────────────────────────────────

  mstream.post('/api/v1/db/stats/recently-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    if (!req.user?.id) { return res.json([]); }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);

    const rows = d().prepare(`
      ${trackQuery(req.user.id)}
      WHERE um.last_played IS NOT NULL AND ${filter.clause}
      ORDER BY um.last_played DESC
      LIMIT ?
    `).all(req.user.id, ...filter.params, req.body.limit);

    res.json(rows.map(renderMetadataObj));
  });

  // ── Most Played ─────────────────────────────────────────────────────────

  mstream.post('/api/v1/db/stats/most-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    if (!req.user?.id) { return res.json([]); }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);

    const rows = d().prepare(`
      ${trackQuery(req.user.id)}
      WHERE um.play_count > 0 AND ${filter.clause}
      ORDER BY um.play_count DESC
      LIMIT ?
    `).all(req.user.id, ...filter.params, req.body.limit);

    res.json(rows.map(renderMetadataObj));
  });

  // ── Random Songs (Auto DJ) ──────────────────────────────────────────────

  mstream.post('/api/v1/db/random-songs', (req, res) => {
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    const conditions = [filter.clause];
    const params = [...(req.user?.id ? [req.user.id] : []), ...filter.params];

    if (req.body.minRating && Number(req.body.minRating) > 0) {
      conditions.push('um.rating >= ?');
      params.push(Number(req.body.minRating));
    }

    // Get all matching songs (needed for ignoreList index-based deduplication)
    const results = d().prepare(`
      ${trackQuery(req.user?.id)}
      WHERE ${conditions.join(' AND ')}
    `).all(...params);

    const count = results.length;
    if (count === 0) { throw new WebError('No songs that match criteria', 400); }

    // Restore v5.16 ignoreList deduplication behavior
    let ignoreList = Array.isArray(req.body.ignoreList) ? [...req.body.ignoreList] : [];
    let ignorePercentage = 0.5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number') {
      ignorePercentage = req.body.ignorePercentage;
    }

    // Trim ignoreList when it grows too large
    while (ignoreList.length > count * ignorePercentage) {
      ignoreList.shift();
    }

    // Pick a random index not in ignoreList
    let randomNumber = Math.floor(Math.random() * count);
    while (ignoreList.indexOf(randomNumber) > -1) {
      randomNumber = Math.floor(Math.random() * count);
    }

    const randomSong = results[randomNumber];
    ignoreList.push(randomNumber);

    res.json({
      songs: [renderMetadataObj(randomSong)],
      ignoreList: ignoreList
    });
  });

  // ── Load Playlist (with metadata) ───────────────────────────────────────

  mstream.post('/api/v1/playlist/load', (req, res) => {
    const playlist = String(req.body.playlistname);

    const playlistRow = d().prepare(
      'SELECT id FROM playlists WHERE name = ? AND user_id = ?'
    ).get(playlist, req.user.id);

    if (!playlistRow) { return res.json([]); }

    const tracks = d().prepare(
      'SELECT id, filepath, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position'
    ).all(playlistRow.id);

    const returnThis = [];
    for (const pt of tracks) {
      let metadata = {};
      try {
        const result = pullMetaData(pt.filepath, req.user);
        if (result.metadata) { metadata = result.metadata; }
      } catch (_e) {}

      returnThis.push({ ...dualId(pt.id), filepath: pt.filepath, metadata });
    }

    res.json(returnThis);
  });
}
