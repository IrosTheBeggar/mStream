import Joi from 'joi';
import path from 'path';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import { joiValidate, dualId } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { parseSearchQuery, buildFtsExpression } from '../util/search-query.js';

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

// ── FTS5-unavailable log latch ──────────────────────────────────────────────
//
// Module-scoped boolean so the WARN about FTS5 not being compiled in
// fires once per process — not once per search request. initDB() in
// db/manager.js already prints a louder ERROR at boot, but most
// operators only watch the warning stream once the server's been up
// for a while, so a second log surface here is worth the latch.
let _fts5UnavailableLogged = false;
function logFts5UnavailableOnce() {
  if (_fts5UnavailableLogged) return;
  _fts5UnavailableLogged = true;
  winston.warn(
    '[search] FTS5 not available — search algorithm "fts5"/"combo" is being ' +
    'force-downgraded to "basic" (LIKE) for the lifetime of this process. ' +
    'See the boot-time ERROR for details.'
  );
}

// ── Per-category LIKE builders ──────────────────────────────────────────────
//
// Each function runs ONE category's pre-V31 LIKE query and returns the
// raw rows (un-shaped). Extracted so:
//   - runLikeSearch can call all four (basic algorithm).
//   - runFtsSearch can call ONE as a per-category fallback when the
//     corresponding FTS MATCH fails to parse or throws SQLITE_ERROR.
// Pure functions — no req/user reads, all access is via the
// pre-resolved (d, filter) handle.

function likeArtistsRows(d, filter, search) {
  return d.prepare(`
    SELECT DISTINCT a.name, (
      SELECT t2.album_art_file FROM tracks t2
      WHERE t2.artist_id = a.id AND t2.album_art_file IS NOT NULL
      LIMIT 1
    ) AS album_art_file
    FROM artists a JOIN tracks t ON t.artist_id = a.id
    WHERE a.name LIKE ? AND ${filter.clause}
    ORDER BY a.name COLLATE NOCASE LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

function likeAlbumsRows(d, filter, search) {
  return d.prepare(`
    SELECT DISTINCT al.name, al.album_art_file
    FROM albums al JOIN tracks t ON t.album_id = al.id
    WHERE al.name LIKE ? AND ${filter.clause}
    ORDER BY al.name COLLATE NOCASE LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

function likeTitlesRows(d, filter, search) {
  return d.prepare(`
    SELECT t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
    FROM tracks t
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.title LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

function likeFilesRows(d, filter, search) {
  return d.prepare(`
    SELECT l.name AS library_name, t.filepath, t.album_art_file
    FROM tracks t JOIN libraries l ON t.library_id = l.id
    WHERE t.filepath LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

// ── LIKE search path ────────────────────────────────────────────────────────
//
// Wraps the four per-category LIKE builders and shapes the result into
// the response envelope. Used by:
//   - The `basic` algorithm (LIKE only, no FTS5 involved).
//   - The combo algorithm's per-category fallback when an FTS MATCH
//     fails to parse or errors out — runFtsSearch invokes individual
//     like*Rows builders for that case (not runLikeSearch wholesale).
//
// opts: { noArtists, noAlbums, noTitles, noFiles, ignoreVPaths }
// search: the raw user query string (LIKE-wildcarded internally)
export function runLikeSearch(req, search, opts = {}) {
  const d = db.getDB();
  const filter = libraryFilter(req.user, opts.ignoreVPaths);

  return {
    artists: opts.noArtists ? [] : likeArtistsRows(d, filter, search).map(shapeArtistRow),
    albums:  opts.noAlbums  ? [] : likeAlbumsRows(d, filter, search).map(shapeAlbumRow),
    title:   opts.noTitles  ? [] : likeTitlesRows(d, filter, search).map(shapeTitleRow),
    files:   opts.noFiles   ? [] : likeFilesRows(d, filter, search).map(shapeFileRow),
  };
}

// ── Per-category FTS5 builders ──────────────────────────────────────────────
//
// Each takes the parsed query and produces either:
//   - rows (possibly empty)             — MATCH ran cleanly
//   - null                              — parse said the query isn't FTS-able
// SQLite-level errors (malformed MATCH expressions that survived the
// parser) propagate out as thrown Errors with code === 'ERR_SQLITE_ERROR';
// runCategory below catches those.
//
// All four SELECT exactly the column set the shape* callbacks expect,
// so the route can map(shape*) without per-row touch-up.

// Build an artists-side FTS expression. Single-token: scope to {name} for
// rank quality. Multi-token: cross-token AND, still scoped to name.
function ftsArtistsRows(d, filter, parsed) {
  const expr = buildFtsExpression({
    column: 'name',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  return d.prepare(`
    SELECT a.name, (
      SELECT t2.album_art_file FROM tracks t2
      WHERE t2.artist_id = a.id AND t2.album_art_file IS NOT NULL
      LIMIT 1
    ) AS album_art_file
    FROM fts_artists fa
    JOIN artists a ON a.id = fa.rowid
    WHERE fa.fts_artists MATCH ?
      AND a.id IN (SELECT artist_id FROM tracks t WHERE ${filter.clause})
    ORDER BY rank LIMIT 30
  `).all(expr, ...filter.params);
}

function ftsAlbumsRows(d, filter, parsed) {
  const expr = buildFtsExpression({
    column: 'name',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  return d.prepare(`
    SELECT al.name, al.album_art_file
    FROM fts_albums fa
    JOIN albums al ON al.id = fa.rowid
    WHERE fa.fts_albums MATCH ?
      AND al.id IN (SELECT album_id FROM tracks t WHERE ${filter.clause})
    ORDER BY rank LIMIT 30
  `).all(expr, ...filter.params);
}

// Title category: scope MATCH to fts_tracks.{title} only. A multi-word
// query column-scopes every positive token to title (mode='all-words'),
// so "comfortably numb" finds "Comfortably Numb" — same column, both
// tokens must match.
function ftsTitlesRows(d, filter, parsed) {
  const expr = buildFtsExpression({
    column: 'title',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  return d.prepare(`
    SELECT t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
    FROM fts_tracks ft
    JOIN tracks t ON t.id = ft.rowid
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE ft.fts_tracks MATCH ?
      AND ${filter.clause}
    ORDER BY rank LIMIT 30
  `).all(expr, ...filter.params);
}

// Files category: scope MATCH to fts_tracks.{filepath}. Useful when the
// user remembers a folder/name fragment but not the title tag.
function ftsFilesRows(d, filter, parsed) {
  const expr = buildFtsExpression({
    column: 'filepath',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  return d.prepare(`
    SELECT l.name AS library_name, t.filepath, t.album_art_file
    FROM fts_tracks ft
    JOIN tracks t ON t.id = ft.rowid
    JOIN libraries l ON t.library_id = l.id
    WHERE ft.fts_tracks MATCH ?
      AND ${filter.clause}
    ORDER BY rank LIMIT 30
  `).all(expr, ...filter.params);
}

// ── FTS5 search path ────────────────────────────────────────────────────────
//
// Runs the four per-category FTS5 builders. On parse failure (builder
// returns null) or SQLite error (malformed MATCH expression that
// survived the JS-side parser), behaviour depends on `strict`:
//   - strict=false (combo): fall back to that category's LIKE builder.
//     Other categories' FTS results are unaffected.
//   - strict=true  (fts5):  return [] for that category. No LIKE involved.
//
// The runCategory helper is the single point where the strict/combo
// branch lives — keeps the per-category code paths byte-identical
// except for that one knob. Same shape* callbacks as runLikeSearch →
// envelope parity is structural, not just covered by tests.
//
// opts: { noArtists, noAlbums, noTitles, noFiles, ignoreVPaths }
// search: the raw user query string (parsed internally)
export function runFtsSearch(req, search, opts = {}, { strict = false } = {}) {
  const d = db.getDB();
  const filter = libraryFilter(req.user, opts.ignoreVPaths);
  const parsed = parseSearchQuery(search);

  function runCategory(name, ftsBuilder, likeBuilder) {
    let rows;
    try {
      rows = ftsBuilder();
    } catch (err) {
      // node:sqlite raises Error with code='ERR_SQLITE_ERROR' for
      // malformed MATCH expressions that slip past parseSearchQuery /
      // buildFtsExpression. Anything else (TypeError from a wiring
      // bug, etc.) is a real programming error and must propagate.
      if (err?.code !== 'ERR_SQLITE_ERROR') throw err;
      if (strict) {
        winston.debug(`[search:fts-strict] ${name} MATCH threw: ${err.message}`);
        return [];
      }
      winston.debug(`[search:combo] ${name} fell back to LIKE on MATCH error: ${err.message}`);
      return likeBuilder();
    }
    if (rows === null) {
      // Parse-time refusal — query had no usable tokens for FTS5.
      if (strict) return [];
      return likeBuilder();
    }
    return rows;
  }

  return {
    artists: opts.noArtists ? [] :
      runCategory('artists',
        () => ftsArtistsRows(d, filter, parsed),
        () => likeArtistsRows(d, filter, search),
      ).map(shapeArtistRow),
    albums: opts.noAlbums ? [] :
      runCategory('albums',
        () => ftsAlbumsRows(d, filter, parsed),
        () => likeAlbumsRows(d, filter, search),
      ).map(shapeAlbumRow),
    title: opts.noTitles ? [] :
      runCategory('title',
        () => ftsTitlesRows(d, filter, parsed),
        () => likeTitlesRows(d, filter, search),
      ).map(shapeTitleRow),
    files: opts.noFiles ? [] :
      runCategory('files',
        () => ftsFilesRows(d, filter, parsed),
        () => likeFilesRows(d, filter, search),
      ).map(shapeFileRow),
  };
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
