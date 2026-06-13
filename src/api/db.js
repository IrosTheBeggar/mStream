import Joi from 'joi';
import path from 'path';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import { joiValidate, dualId } from '../util/validation.js';

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
      // Track length in seconds. The webapp player uses this for the progress
      // bar and to map a seek-bar click to a time offset — a chunked transcode
      // stream gives the browser no usable audio.duration to work from.
      duration: row.duration ?? null,
      year: row.year || null,
      'album-art': row.album_art_file || null,
      rating: row.rating || null,
      'play-count': row.play_count || null,
      'last-played': row.last_played || null,
      'replaygain-track': row.replaygain_track_db || null,
      // V32 columns surfaced for client-side Auto-DJ. The webapp uses
      // these to display "128 BPM · A minor (8A)" pills and to drive
      // the BPM-continuity / harmonic-mixing toggles (build a request
      // body for /api/v1/db/random-songs from the currently-playing
      // song's tag values). NULL on rows whose tags didn't carry BPM
      // or musical key — the client falls back to no-anchor behaviour.
      //
      // Note the kebab-case `musical-key` on the wire. The DB column
      // stays snake_case (SQL convention) but every multi-word field
      // in this output object uses kebab-case to match the existing
      // shape (`album-art`, `play-count`, `last-played`,
      // `replaygain-track`).
      bpm: row.bpm ?? null,
      'musical-key': row.musical_key ?? null,
      // V35 (planned): multi-genre list surfaced for the client-side
      // Auto-DJ genre filter (whitelist / blacklist `songBlocked`
      // branch). Always emitted, even when empty — caller null-coalesce
      // checks against `metadata.genres.length === 0` rather than
      // `=== undefined`. Names match the order they were inserted into
      // track_genres by the scanner (typically tag order). Sourced via
      // a LEFT JOIN + GROUP_CONCAT aggregation in trackQuery() below;
      // char(31) (ASCII unit separator) is the join delimiter so no
      // legal genre name can collide with it.
      genres: row.genres_concat
        ? row.genres_concat.split(String.fromCharCode(31)).filter(Boolean)
        : [],
      // Technical / fidelity fields — raw column values straight off the
      // tracks row (trackQuery already SELECTs t.*, so no extra query).
      // These let clients render quality badges like "24/96 FLAC" or
      // "320 kbps". Units, to match the DB columns:
      //   bitrate     — bits per second (the Subsonic API reports kbps;
      //                 this is the raw value, divide by 1000 for kbps)
      //   duration    — seconds (REAL)
      //   sample-rate — Hz
      //   bit-depth   — bits
      //   file-size   — bytes
      // sample-rate / channels / bit-depth are NULL on rows scanned before
      // schema V16 until a force-rescan repopulates them. `?? null` (not
      // `|| null`) preserves a genuine 0. Multi-word keys are kebab-case on
      // the wire to match album-art / play-count / musical-key.
      //
      // bitrate + file-size are written by both scanners
      // (rust-parser/src/main.rs, src/db/scanner.mjs). Rows scanned before
      // that change stay NULL until a force-rescan. The Subsonic song
      // builder surfaces the same values (bitRate in kbps, size in bytes).
      bitrate: row.bitrate ?? null,
      format: row.format || null,
      duration: row.duration ?? null,
      'sample-rate': row.sample_rate ?? null,
      channels: row.channels ?? null,
      'bit-depth': row.bit_depth ?? null,
      'file-size': row.file_size ?? null,
      // ── Existing tracks columns not previously surfaced — pure column
      // maps (trackQuery already SELECTs t.*, so no extra query). ────────
      // `audio-hash` is the V14 audio-payload hash: the PREFERRED stable
      // identity (survives tag edits, album-art changes, ReplayGain
      // rewrites), unlike `hash` above which is the whole-file MD5. Added
      // as a new field; `hash` is left untouched for back-compat.
      'audio-hash': row.audio_hash || null,
      // When the track row was first scanned ≈ "date added to library".
      'created-at': row.created_at || null,
      // File mtime, epoch milliseconds.
      modified: row.modified ?? null,
      // Provenance from embedded tags (V36), e.g. 'ytdl'. NULL when no
      // recognised marker is present.
      source: row.source || null,
      // Where `bpm` came from ('tag' vs scanner analysis) — diagnostic
      // companion to the bpm / musical-key fields above.
      'bpm-source': row.bpm_source || null,
      // Lyrics availability flags. The lyrics TEXT is intentionally NOT
      // inlined here — it would bloat every list response; fetch it via the
      // dedicated lyrics endpoint. `lyrics-lang` is the language tag the
      // scanner captured, when present.
      'has-lyrics': !!(row.lyrics_embedded || row.lyrics_synced_lrc),
      'has-synced-lyrics': !!row.lyrics_synced_lrc,
      'lyrics-lang': row.lyrics_lang || null,
      // V43: track/disc totals from embedded tags (both scanners).
      // `track-total` / `disc-total` pair with the existing `track` / `disk`
      // (i.e. track N "of" total). NULL until a post-V43 force-rescan.
      // (Composer deferred to the role-based contributors follow-up.)
      'track-total': row.track_total ?? null,
      'disc-total': row.disc_total ?? null,
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

// Base query: tracks joined with artists, albums, library, optionally
// user_metadata, and (when `includeGenres` is set) a track_genres
// aggregation.
//
// `includeGenres` controls whether the `tg_agg` LEFT JOIN runs:
//
//   • true (default) — adds a GROUP_CONCAT subquery over track_genres
//     so `renderMetadataObj` can emit `metadata.genres: string[]`
//     without per-row follow-ups. Use this for response-shaped queries
//     (velvet-stubs list endpoints, smart-playlists, pullMetaData).
//
//   • false — skip the join. Use for candidate-set queries where only
//     ONE row will actually be rendered (the random-songs picker
//     loads the candidate pool, picks one index, then enriches just
//     that row via fetchGenresForTrack below). SQLite has to
//     MATERIALIZE tg_agg before applying the WHERE clause, so the
//     cost scales with the full tracks table, not the filtered
//     candidate set — skipping it cuts the picker's SQL time by ~80%
//     on a smoke-sized DB and avoids ~460ms of overhead extrapolated
//     to a 100k-track library.
//
// char(31) (ASCII unit separator) is the join delimiter so no legal
// genre name can collide with it.
export function trackQuery(userId, { includeGenres = true } = {}) {
  const aggJoin = includeGenres ? `
    LEFT JOIN (
      SELECT tg.track_id, GROUP_CONCAT(g.name, char(31)) AS genres_concat
        FROM track_genres tg
        JOIN genres g ON g.id = tg.genre_id
       GROUP BY tg.track_id
    ) tg_agg ON tg_agg.track_id = t.id` : '';
  const aggCol = includeGenres ? ', tg_agg.genres_concat' : '';
  return `
    SELECT t.*, a.name AS artist_name, al.name AS album_name,
           l.name AS library_name,
           um.rating, um.play_count, um.last_played${aggCol}
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN libraries l ON t.library_id = l.id
    LEFT JOIN user_metadata um ON COALESCE(t.audio_hash, t.file_hash) = um.track_hash AND um.user_id = ${userId ? '?' : 'NULL'}${aggJoin}
  `;
}

// Look up the genres list for a single track. Used by callers that
// run `trackQuery(..., { includeGenres: false })` to keep the
// candidate-set query lean (random-songs picker) and then enrich
// just the chosen row before response. Returns the row in the same
// shape the LEFT JOIN aggregation produces — `{ genres_concat: <str>|null }`
// — so callers can splat it onto the picked row and feed it to
// renderMetadataObj unchanged.
export function fetchGenresForTrack(d, trackId) {
  return d.prepare(`
    SELECT GROUP_CONCAT(g.name, char(31)) AS genres_concat
      FROM track_genres tg
      JOIN genres g ON g.id = tg.genre_id
     WHERE tg.track_id = ?
  `).get(trackId) || { genres_concat: null };
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

// Batched equivalent of pullMetaData: resolve metadata for many
// "<vpath>/<relpath>" filepaths in ONE query instead of one query per path.
// Returns a Map<filepath, { filepath, metadata }> whose entries match
// pullMetaData exactly (same wrapper, same `metadata: null` on miss/denied),
// so `batch.get(fp)` is a drop-in for `pullMetaData(fp, user)`.
//
// Why it exists: pullMetaData runs trackQuery, whose genre GROUP_CONCAT is
// MATERIALISED over the entire track_genres table on every call (see
// trackQuery's note). Calling it in a loop (playlist load, /metadata/batch)
// re-did that whole-table aggregation per track, so latency scaled with
// library size × list length — measured ~2.6s (5k tracks), ~8.7s (20k) and
// ~31s (50k) to load a 100-track playlist. Here the heavy query runs once
// with genres skipped, and genres are added per matched row via an indexed
// point-lookup (the same trick the random-songs picker uses), so latency
// scales with the list, not the library (~20ms regardless of library size).
export function pullMetaDataBatch(filepaths, user) {
  const d = db.getDB();
  const miss = (fp) => ({ filepath: fp, metadata: null });
  const result = new Map();
  if (!d) {
    for (const fp of filepaths) { result.set(fp, miss(fp)); }
    return result;
  }

  // Resolve each path to (library_id, relativePath) up front — cached lib
  // lookup, no SQL. getVPathInfo applies the same per-vpath access check
  // pullMetaData did; anything that fails it (revoked vpath, unknown library)
  // gets the null wrapper now and is never queried. Distinct paths that
  // normalise to the same track are grouped so the query stays minimal and
  // duplicates in the list all resolve to the same row.
  const keyOf = (libraryId, rel) => `${libraryId} ${rel}`;
  const pending = new Map();   // key -> { library_id, rel, fps: [filepath, ...] }
  for (const fp of filepaths) {
    let info;
    try { info = vpath.getVPathInfo(fp, user); } catch (_e) { result.set(fp, miss(fp)); continue; }
    const lib = db.getLibraryByName(info.vpath);
    if (!lib) { result.set(fp, miss(fp)); continue; }
    const key = keyOf(lib.id, info.relativePath);
    const entry = pending.get(key) || { library_id: lib.id, rel: info.relativePath, fps: [] };
    entry.fps.push(fp);
    pending.set(key, entry);
  }

  // One batched query per chunk. Row-value IN keeps it to a single statement
  // even when the list spans libraries; the (filepath, library_id) index makes
  // it an indexed search, not a scan. 500 pairs/chunk (≤1001 bound params:
  // the user id + 2 per pair) stays well under SQLite's parameter limit even
  // for very large playlists.
  const userIdParams = user?.id ? [user.id] : [];
  const entries = [...pending.values()];
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values = slice.map(() => '(?,?)').join(',');
    const rows = d.prepare(
      `${trackQuery(user?.id, { includeGenres: false })} WHERE (t.library_id, t.filepath) IN (VALUES ${values})`
    ).all(...userIdParams, ...slice.flatMap(e => [e.library_id, e.rel]));

    for (const row of rows) {
      Object.assign(row, fetchGenresForTrack(d, row.id));
      const entry = pending.get(keyOf(row.library_id, row.filepath));
      if (!entry) { continue; }
      const rendered = renderMetadataObj(row);
      for (const fp of entry.fps) { result.set(fp, rendered); }
    }
  }

  // Resolved paths with no matching track row (e.g. file deleted since it was
  // added) get the same null wrapper a pullMetaData miss would return.
  for (const fp of filepaths) {
    if (!result.has(fp)) { result.set(fp, miss(fp)); }
  }
  return result;
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
    const batch = pullMetaDataBatch(req.body, req.user);
    const returnThis = {};
    req.body.forEach(f => {
      returnThis[f] = batch.get(f);
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

    // V34: case-insensitive name match — uniform with the post-V34
    // case-folded vocabulary getGenres now returns. Pre-V34 this
    // would silently miss "Jazz" vs "jazz" if the M2M had both rows
    // (the "1247 jazz tracks shown but only 800 returned" bug).
    const rows = d().prepare(`
      ${trackQuery(req.user?.id)}
      JOIN track_genres tg ON tg.track_id = t.id
      JOIN genres g ON g.id = tg.genre_id
      WHERE g.name COLLATE NOCASE = ? AND ${filter.clause}
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
  // /api/v1/db/search lives in src/api/search.js. server.js calls
  // searchApi.setup(mstream) separately. Kept out of this file so
  // the search implementation can grow without bloating the generic
  // DB route module.

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
      ORDER BY t.created_at DESC, t.id DESC
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
  // Route lives in src/api/random.js — it owns the BPM/key fallback
  // waterfall + Camelot expansion + tier filter. Registered from
  // src/server.js as randomApi.setup(mstream).

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

    // Resolve every track's metadata in one batched query (see
    // pullMetaDataBatch) rather than a query per track. Order is preserved by
    // mapping over `tracks`; entries with no metadata (deleted file, revoked
    // vpath) keep their slot with `metadata: {}`, exactly as the old loop did.
    const batch = pullMetaDataBatch(tracks.map(pt => pt.filepath), req.user);
    const returnThis = tracks.map(pt => ({
      ...dualId(pt.id),
      filepath: pt.filepath,
      metadata: batch.get(pt.filepath)?.metadata || {}
    }));

    res.json(returnThis);
  });
}
