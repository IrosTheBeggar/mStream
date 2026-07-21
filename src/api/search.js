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
import { libraryFilter, renderMetadataByIds, toLiteMetadata } from './db.js';

// ── Search response shapers ─────────────────────────────────────────────────
//
// Five pure functions that take a raw DB row and produce one item of
// the /api/v1/db/search response envelope. The LIKE and FTS5 paths both
// route through these — envelope parity is structural, not just covered
// by tests. The shapers expect these column names on the row:
//   - shapeArtistRow: { name, album_art_file }
//   - shapeAlbumRow:  { name, album_art_file }
//   - shapeTitleRow:  { id, title, album_art_file, artist_name, library_name, filepath }
//   - shapeFileRow:   { id, library_name, filepath, album_art_file }
//   - shapeLyricsRow: { id, title, album_art_file, artist_name, library_name, filepath, snippet }
//
// Per-category builders SELECT exactly these columns so the map(shape*)
// at the call site doesn't need per-row touch-up.
//
// The three TRACK-level shapers (title/files/lyrics) also accept a
// `metaMap` — a Map<track id, { metadata }> from renderMetadataByIds — and
// emit a LITE subset of the canonical metadata object (via toLiteMetadata:
// display/playback/Auto-DJ fields only, not the heavy fidelity/diagnostic
// fields — fetch /api/v1/db/metadata for those) under a `metadata` key, looked
// up by row.id. This is ADDITIVE: the legacy name/album_art_file/filepath
// fields stay put for back-compat, so existing clients are unaffected. metaMap
// is optional — callers without one (or a row whose id missed the batch) get
// metadata:null. artists/albums are name aggregations with no single track row,
// so they have no metadata object and keep the minimal `filepath:false`
// group sentinel.

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

export function shapeTitleRow(r, metaMap) {
  const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
  return {
    name: r.artist_name ? `${r.artist_name} - ${r.title}` : r.title,
    album_art_file: r.album_art_file || null,
    filepath: fp,
    metadata: toLiteMetadata(metaMap?.get(r.id)?.metadata),
  };
}

export function shapeFileRow(r, metaMap) {
  const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
  return {
    name: fp,
    album_art_file: r.album_art_file || null,
    filepath: fp,
    metadata: toLiteMetadata(metaMap?.get(r.id)?.metadata),
  };
}

// Lyrics category: shaped like a title hit, but carries a `snippet` — the
// matching lyric excerpt from FTS5 snippet() (null on the LIKE path) — so the
// UI can show WHY it matched (the half-remembered line).
//   - shapeLyricsRow: { id, title, album_art_file, artist_name, library_name, filepath, snippet }
//
// Since V59 the index stores timestamp-stripped text, so snippets are
// normally already clean. cleanSnippet is belt-and-braces for the one path
// stamps can still ride in on: lyrics_embedded that itself contains LRC-ish
// content (a tagger that stuffed timed text into USLT alongside a real SYLT
// — extraction keeps it on the plain slot when the synced slot is taken).
// Fragment-level only: complete `[mm:ss.xx]` / `<mm:ss.xx>` stamps are
// dropped; a stamp the snippet window clipped mid-way stays (harmless, and
// only reachable in that same corner case).
const SNIPPET_STAMP_RE = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]|<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
function cleanSnippet(snippet) {
  if (!snippet) { return null; }
  const cleaned = snippet.replace(SNIPPET_STAMP_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return cleaned || null;
}

export function shapeLyricsRow(r, metaMap) {
  const fp = path.join(r.library_name, r.filepath).replace(/\\/g, '/');
  return {
    name: r.artist_name ? `${r.artist_name} - ${r.title}` : r.title,
    album_art_file: r.album_art_file || null,
    filepath: fp,
    snippet: cleanSnippet(r.snippet),
    metadata: toLiteMetadata(metaMap?.get(r.id)?.metadata),
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
    SELECT t.id, t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
    FROM tracks t
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE t.title LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

function likeFilesRows(d, filter, search) {
  return d.prepare(`
    SELECT t.id, l.name AS library_name, t.filepath, t.album_art_file
    FROM tracks t JOIN libraries l ON t.library_id = l.id
    WHERE t.filepath LIKE ? AND ${filter.clause}
    LIMIT 30
  `).all(`%${search}%`, ...filter.params);
}

// LIKE over the track's searchable lyrics: embedded plain text preferred,
// else the timestamp-stripped rendition of the synced LRC (V59's
// lyrics_search_text — matching raw lyrics_synced_lrc here would let a
// numeric query hit `[mm:ss.xx]` stamp digits). Same COALESCE the FTS
// index stores. No FTS snippet on this path — `snippet` comes back NULL.
function likeLyricsRows(d, filter, search) {
  return d.prepare(`
    SELECT t.id, t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath,
           NULL AS snippet
    FROM tracks t
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE COALESCE(t.lyrics_embedded, t.lyrics_search_text) LIKE ? AND ${filter.clause}
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

  // Gather the track-level row sets first so their ids enrich in a single
  // batched metadata pass (see enrichTrackRows). artists/albums stay minimal.
  const titleRows  = opts.noTitles  ? [] : likeTitlesRows(d, filter, search);
  const fileRows   = opts.noFiles   ? [] : likeFilesRows(d, filter, search);
  const lyricsRows = opts.noLyrics  ? [] : likeLyricsRows(d, filter, search);
  const metaMap = enrichTrackRows(req.user, [titleRows, fileRows, lyricsRows]);

  return {
    artists: opts.noArtists ? [] : likeArtistsRows(d, filter, search).map(shapeArtistRow),
    albums:  opts.noAlbums  ? [] : likeAlbumsRows(d, filter, search).map(shapeAlbumRow),
    title:   titleRows.map(r => shapeTitleRow(r, metaMap)),
    files:   fileRows.map(r => shapeFileRow(r, metaMap)),
    lyrics:  lyricsRows.map(r => shapeLyricsRow(r, metaMap)),
  };
}

// ── Track-level metadata enrichment ─────────────────────────────────────────
//
// Collect track ids from the gathered track-level row sets (title/files/
// lyrics) and resolve them ALL to the canonical metadata object in one batched
// pass (two id-indexed queries, see renderMetadataByIds). Returns a
// Map<id, { filepath, metadata }> the shapers look up by row.id. Order doesn't
// matter here — the shapers iterate their own rank-ordered rows against the
// map. artists/albums are not track-level and never pass through here.
function enrichTrackRows(user, rowGroups) {
  const ids = [];
  for (const rows of rowGroups) {
    for (const r of rows) { ids.push(r.id); }
  }
  return renderMetadataByIds(ids, user);
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
    SELECT t.id, t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath
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
    SELECT t.id, l.name AS library_name, t.filepath, t.album_art_file
    FROM fts_tracks ft
    JOIN tracks t ON t.id = ft.rowid
    JOIN libraries l ON t.library_id = l.id
    WHERE ft.fts_tracks MATCH ?
      AND ${filter.clause}
    ORDER BY rank LIMIT 30
  `).all(expr, ...filter.params);
}

// Lyrics category: scope MATCH to fts_tracks.{lyrics} (denormalised in V53;
// since V59 it indexes COALESCE(lyrics_embedded, lyrics_search_text), the
// timestamp-stripped rendition — raw LRC stamp digits used to be tokens).
// snippet(fts_tracks, 4, …) returns the matching excerpt — column
// index 4 is `lyrics` (title=0, artist_name=1, album_name=2, filepath=3,
// lyrics=4). fts_tracks is left un-aliased here so snippet()/rank reference it
// directly. This is the "find a song by a half-remembered line" path.
function ftsLyricsRows(d, filter, parsed) {
  const expr = buildFtsExpression({
    column: 'lyrics',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  return d.prepare(`
    SELECT t.id, t.title, t.album_art_file, a.name AS artist_name, l.name AS library_name, t.filepath,
           snippet(fts_tracks, 4, '', '', '…', 12) AS snippet
    FROM fts_tracks
    JOIN tracks t ON t.id = fts_tracks.rowid
    JOIN libraries l ON t.library_id = l.id
    LEFT JOIN artists a ON t.artist_id = a.id
    WHERE fts_tracks MATCH ?
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

  // Gather the track-level row sets first (preserving each category's rank
  // order) so their ids enrich in a single batched metadata pass. The shapers
  // then map over these rank-ordered rows — the metaMap is a pure id lookup,
  // so the `t.id IN (...)` reshuffle inside renderMetadataByIds never disturbs
  // FTS ordering. artists/albums stay minimal.
  const titleRows = opts.noTitles ? [] :
    runCategory('title',
      () => ftsTitlesRows(d, filter, parsed),
      () => likeTitlesRows(d, filter, search),
    );
  const fileRows = opts.noFiles ? [] :
    runCategory('files',
      () => ftsFilesRows(d, filter, parsed),
      () => likeFilesRows(d, filter, search),
    );
  const lyricsRows = opts.noLyrics ? [] :
    runCategory('lyrics',
      () => ftsLyricsRows(d, filter, parsed),
      () => likeLyricsRows(d, filter, search),
    );
  const metaMap = enrichTrackRows(req.user, [titleRows, fileRows, lyricsRows]);

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
    title:  titleRows.map(r => shapeTitleRow(r, metaMap)),
    files:  fileRows.map(r => shapeFileRow(r, metaMap)),
    lyrics: lyricsRows.map(r => shapeLyricsRow(r, metaMap)),
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
      noLyrics: Joi.boolean().optional(),
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
      noLyrics:     value.noLyrics,
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
