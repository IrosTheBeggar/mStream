// /api/v1/db/search — webapp-facing search endpoint.
//
// Split out of src/api/db.js in PR3's audit follow-up so the search
// implementation stops bloating the generic DB route file. Everything
// in here is search-only: shape callbacks, per-category LIKE + FTS5
// builders, the three-value algorithm dispatcher, and the route
// registration.
//
// The pure parsing + FTS5-expression utilities stay in
// src/util/search-query.js — they're consumed by both this module
// and src/api/subsonic/handlers.js, and they have no DB dependency.
//
// Subsonic search (search3 / search2 / search v1) is NOT wired here.
// It has different envelope semantics (DB ids, full track rows for
// songFromRow, V18 M2M-aware widening, OpenSubsonic empty-query
// listing) and lives in src/api/subsonic/handlers.js. The two paths
// share the same FTS5 indexes (V31) and the same query-parser
// utility but otherwise have nothing to gain from a shared dispatcher.

import Joi from 'joi';
import path from 'path';
import winston from 'winston';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { parseSearchQuery, buildFtsExpression } from '../util/search-query.js';
import { libraryFilter } from './db.js';

// ── Search response shapers ─────────────────────────────────────────────────
//
// Four pure functions that take a raw DB row and produce one item of
// the /api/v1/db/search response envelope. The LIKE and FTS5 paths both
// route through these — envelope parity is structural, not just covered
// by tests. The four shapers expect these column names on the row:
//   - shapeArtistRow: { name, album_art_file }
//   - shapeAlbumRow:  { name, album_art_file }
//   - shapeTitleRow:  { title, album_art_file, artist_name, library_name, filepath }
//   - shapeFileRow:   { library_name, filepath, album_art_file }
//
// Per-category builders SELECT exactly these columns so the map(shape*)
// at the call site doesn't need per-row touch-up.

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

// ── Route setup ─────────────────────────────────────────────────────────────

export function setup(mstream) {
  mstream.post('/api/v1/db/search', (req, res) => {
    const schema = Joi.object({
      search: Joi.string().required(),
      noArtists: Joi.boolean().optional(),
      noAlbums: Joi.boolean().optional(),
      noTitles: Joi.boolean().optional(),
      noFiles: Joi.boolean().optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      // `algorithm`:
      //   'basic' — LIKE only (no FTS5 involved). Infix substring match,
      //             alphabetical order, pre-V31 behaviour.
      //   'fts5'  — strict FTS5. No LIKE fallback even on parse failure
      //             or SQLITE_ERROR; that category just returns []. Useful
      //             for debugging FTS5 behaviour without LIKE muddying the
      //             output.
      //   'combo' — FTS5 primary with per-category LIKE fallback when
      //             MATCH fails to parse or errors. The smart default.
      // Default is 'combo'. Unknown values are 403'd by Joi via
      // mStream's error middleware in src/server.js.
      algorithm: Joi.string().valid('basic', 'fts5', 'combo').default('combo').optional(),
    });
    // joiValidate returns the coerced value object — the `default(...)`
    // on `algorithm` only lands there, not on req.body. Read from `value`,
    // not from req.body, or the default never gets applied.
    const { value } = joiValidate(schema, req.body);

    const opts = {
      noArtists:    value.noArtists,
      noAlbums:     value.noAlbums,
      noTitles:     value.noTitles,
      noFiles:      value.noFiles,
      ignoreVPaths: value.ignoreVPaths,
    };

    // FTS5 availability override: if SQLite wasn't compiled with FTS5,
    // the fts_* tables don't exist and any MATCH or even a SELECT against
    // them would 500. Coerce any FTS-leaning algorithm down to basic.
    // The latch ensures we don't spam the log when search hits land
    // in a steady-state degraded process.
    let effective = value.algorithm;
    if (!db.FTS5_AVAILABLE && effective !== 'basic') {
      effective = 'basic';
      logFts5UnavailableOnce();
    }

    const result =
      effective === 'basic' ? runLikeSearch(req, value.search, opts) :
      effective === 'fts5'  ? runFtsSearch(req, value.search, opts, { strict: true }) :
                              runFtsSearch(req, value.search, opts, { strict: false });
    res.json(result);
  });
}
