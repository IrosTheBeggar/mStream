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

// Escape SQL LIKE special chars so user-supplied prefix strings match
// literally. Paired with ESCAPE '\' in the LIKE clause.
function _escapeLike(s) {
  return String(s).replace(/[\\%_]/g, c => '\\' + c);
}

// Build library filter clause for user access.
//
// Signature stays backward-compatible: (user, ignoreVPaths) is what every
// existing caller passes. The optional third `options` arg adds filepath-
// prefix filtering that the Velvet UI relies on for audio-book exclusions
// and "Albums Only" scoping. Callers that don't pass options get identical
// behaviour to the pre-extension version.
//
// Options:
//   includeFilepathPrefixes: Array<{vpath, prefix}>
//     Whitelist per vpath. For each listed vpath, rows only pass if their
//     filepath starts with one of that vpath's prefixes. Rows in a vpath
//     NOT listed pass through unaffected. Empty → no-op.
//
//   excludeFilepathPrefixes: Array<{vpath, prefix}>
//     Blacklist per vpath. For each listed vpath, rows whose filepath
//     starts with the prefix are dropped. Rows in other vpaths unaffected.
//
//   filepathPrefix: string
//     Unconditional prefix. Every row must start with this. Simpler shape
//     the UI uses for the single-parent Auto-DJ scoping path.
export function libraryFilter(user, ignoreVPaths, options = {}) {
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

  const clauses = [`t.library_id IN (${libIds.map(() => '?').join(',')})`];
  const params = [...libIds];

  // ── includeFilepathPrefixes — per-vpath whitelist ─────────────────────────
  const incl = Array.isArray(options.includeFilepathPrefixes) ? options.includeFilepathPrefixes : [];
  if (incl.length > 0) {
    // Group prefixes by library id so we can OR them per vpath.
    const byLibId = new Map();
    for (const entry of incl) {
      if (!entry || typeof entry !== 'object') continue;
      const { vpath, prefix } = entry;
      if (typeof vpath !== 'string' || typeof prefix !== 'string' || !prefix) continue;
      const lib = db.getLibraryByName(vpath);
      if (!lib || !libIds.includes(lib.id)) continue;
      if (!byLibId.has(lib.id)) byLibId.set(lib.id, []);
      byLibId.get(lib.id).push(prefix);
    }
    for (const [libId, prefixes] of byLibId) {
      const orClause = prefixes.map(() => `t.filepath LIKE ? ESCAPE '\\'`).join(' OR ');
      clauses.push(`(t.library_id != ? OR (${orClause}))`);
      params.push(libId);
      for (const p of prefixes) { params.push(_escapeLike(p) + '%'); }
    }
  }

  // ── excludeFilepathPrefixes — per-vpath blacklist ─────────────────────────
  const excl = Array.isArray(options.excludeFilepathPrefixes) ? options.excludeFilepathPrefixes : [];
  for (const entry of excl) {
    if (!entry || typeof entry !== 'object') continue;
    const { vpath, prefix } = entry;
    if (typeof vpath !== 'string' || typeof prefix !== 'string' || !prefix) continue;
    const lib = db.getLibraryByName(vpath);
    if (!lib || !libIds.includes(lib.id)) continue;
    clauses.push(`(t.library_id != ? OR t.filepath NOT LIKE ? ESCAPE '\\')`);
    params.push(lib.id);
    params.push(_escapeLike(prefix) + '%');
  }

  // ── filepathPrefix — single unconditional prefix ──────────────────────────
  if (typeof options.filepathPrefix === 'string' && options.filepathPrefix) {
    clauses.push(`t.filepath LIKE ? ESCAPE '\\'`);
    params.push(_escapeLike(options.filepathPrefix) + '%');
  }

  return {
    clause: clauses.join(' AND '),
    params
  };
}

// Convenience: pull the three prefix-filter options out of a request body in
// one shot so each handler doesn't repeat the same three property reads.
function _prefixOpts(body) {
  if (!body || typeof body !== 'object') return {};
  return {
    includeFilepathPrefixes: body.includeFilepathPrefixes,
    excludeFilepathPrefixes: body.excludeFilepathPrefixes,
    filepathPrefix: body.filepathPrefix,
  };
}

// Reusable Joi fragments for the prefix-filter fields — keep schemas DRY
// across the handfull of endpoints that now accept these.
const _prefixItem = Joi.object({
  vpath: Joi.string().required(),
  prefix: Joi.string().required(),
});
const _prefixOptFields = {
  includeFilepathPrefixes: Joi.array().items(_prefixItem).optional(),
  excludeFilepathPrefixes: Joi.array().items(_prefixItem).optional(),
  filepathPrefix: Joi.string().optional(),
};

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
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      ..._prefixOptFields,
    });
    joiValidate(schema, req.body);

    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));
    const searchPattern = `%${req.body.search}%`;

    const artists = req.body.noArtists ? [] : d().prepare(`
      SELECT DISTINCT a.name, (
        SELECT t2.album_art_file FROM tracks t2
        WHERE t2.artist_id = a.id AND t2.album_art_file IS NOT NULL
        LIMIT 1
      ) AS album_art_file
      FROM artists a JOIN tracks t ON t.artist_id = a.id
      WHERE a.name LIKE ? AND ${filter.clause}
      ORDER BY a.name COLLATE NOCASE LIMIT 30
    `).all(searchPattern, ...filter.params).map(r => ({
      name: r.name,
      // `variants` is an array of name spellings that all canonicalise to
      // the same artist — the Velvet UI uses it to submit a multi-name
      // artists-albums-multi query so compilation/collab appearances of a
      // renamed artist aren't missed. We don't track aliases today, so
      // emit a single-element array containing the canonical name. The UI
      // handles that case fine (it passes [name] to viewArtistAlbums).
      variants: [r.name],
      album_art_file: r.album_art_file || null,
      filepath: false
    }));

    const albums = req.body.noAlbums ? [] : d().prepare(`
      SELECT DISTINCT al.name, al.album_art_file
      FROM albums al JOIN tracks t ON t.album_id = al.id
      WHERE al.name LIKE ? AND ${filter.clause}
      ORDER BY al.name COLLATE NOCASE LIMIT 30
    `).all(searchPattern, ...filter.params).map(r => ({
      name: r.name,
      album_art_file: r.album_art_file || null,
      filepath: false
    }));

    const title = req.body.noTitles ? [] : d().prepare(`
      SELECT t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
      FROM tracks t
      JOIN libraries l ON t.library_id = l.id
      LEFT JOIN artists a ON t.artist_id = a.id
      WHERE t.title LIKE ? AND ${filter.clause}
      LIMIT 30
    `).all(searchPattern, ...filter.params).map(r => {
      const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
      return {
        name: r.artist_name ? `${r.artist_name} - ${r.title}` : r.title,
        album_art_file: r.album_art_file || null,
        filepath: fp
      };
    });

    const files = req.body.noFiles ? [] : d().prepare(`
      SELECT l.name AS library_name, t.filepath, t.album_art_file
      FROM tracks t JOIN libraries l ON t.library_id = l.id
      WHERE t.filepath LIKE ? AND ${filter.clause}
      LIMIT 30
    `).all(searchPattern, ...filter.params).map(r => {
      const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
      return {
        name: fp,
        album_art_file: r.album_art_file || null,
        filepath: fp
      };
    });

    // Folders — distinct parent directories whose path contains the search
    // term. Pulled raw then deduped in JS because SQLite's string ops for
    // "take everything before the last slash" are awkward. Cap the raw pull
    // well above the 30-item folder cap so we don't truncate before dedup.
    let folders = [];
    if (!req.body.noFiles) {
      const rawRows = d().prepare(`
        SELECT l.name AS library_name, t.filepath
        FROM tracks t JOIN libraries l ON t.library_id = l.id
        WHERE t.filepath LIKE ? AND ${filter.clause}
        LIMIT 500
      `).all(searchPattern, ...filter.params);

      const seen = new Set();
      for (const r of rawRows) {
        const lastSlash = r.filepath.lastIndexOf('/');
        if (lastSlash <= 0) { continue; } // tracks at the library root have no parent folder
        const parent = r.filepath.slice(0, lastSlash);
        // Only keep folders whose NAME (or any ancestor segment) contains the
        // term — otherwise "stairway" matches every track in every folder.
        if (!parent.toLowerCase().includes(req.body.search.toLowerCase())) { continue; }
        const browsePath = `${r.library_name}/${parent}`;
        if (seen.has(browsePath)) { continue; }
        seen.add(browsePath);
        const folderName = parent.slice(parent.lastIndexOf('/') + 1);
        folders.push({ browse_path: browsePath, folder_name: folderName });
        if (folders.length >= 30) { break; }
      }
    }

    res.json({ artists, albums, title, files, folders });
  });

  // ── Rated Songs ─────────────────────────────────────────────────────────

  function getRatedSongs(req) {
    if (!req.user?.id) { return []; }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      ..._prefixOptFields,
    });
    joiValidate(schema, req.body);

    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      ..._prefixOptFields,
    });
    joiValidate(schema, req.body);

    if (!req.user?.id) { return res.json([]); }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));

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
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      ..._prefixOptFields,
    });
    joiValidate(schema, req.body);

    if (!req.user?.id) { return res.json([]); }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));

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
    // libraryFilter now honours filepathPrefix / include- / excludeFilepathPrefixes;
    // random-songs additionally supports artists whitelist and ignoreArtists
    // blacklist so Auto-DJ can implement its similar-artists bias and the
    // 15-song artist-repeat cooldown without client-side filtering.
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths, _prefixOpts(req.body));
    const conditions = [filter.clause];
    const params = [...(req.user?.id ? [req.user.id] : []), ...filter.params];

    if (req.body.minRating && Number(req.body.minRating) > 0) {
      conditions.push('um.rating >= ?');
      params.push(Number(req.body.minRating));
    }

    // artists: whitelist of artist names. At least one must match for a row
    // to survive. Case-insensitive match against artists.name since Last.fm
    // and local tag case don't always agree.
    if (Array.isArray(req.body.artists) && req.body.artists.length > 0) {
      const names = req.body.artists.filter(n => typeof n === 'string' && n);
      if (names.length > 0) {
        conditions.push(`a.name COLLATE NOCASE IN (${names.map(() => '?').join(',')})`);
        params.push(...names);
      }
    }

    // ignoreArtists: blacklist of artist names. Drop rows whose artist is in
    // the list. Auto-DJ's 15-song sliding cooldown passes the recent-artist
    // queue here so the next pick won't repeat within the window.
    if (Array.isArray(req.body.ignoreArtists) && req.body.ignoreArtists.length > 0) {
      const names = req.body.ignoreArtists.filter(n => typeof n === 'string' && n);
      if (names.length > 0) {
        conditions.push(`(a.name IS NULL OR a.name COLLATE NOCASE NOT IN (${names.map(() => '?').join(',')}))`);
        params.push(...names);
      }
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
