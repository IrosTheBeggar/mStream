/**
 * /api/v1/lyrics — non-Subsonic endpoint for the Velvet UI's lyric
 * pane. Reads from the same V19 tracks columns that Subsonic's
 * getLyrics / getLyricsBySongId serve; only the response envelope is
 * different.
 *
 * Response shape (matches Velvet's existing client code in
 * webapp/velvet/app.js `fetchAndRenderLyrics`):
 *
 *   { notFound: true }
 *   { synced: true,  lines: [{ time, text }, ...] }  // time in seconds
 *   { synced: false, lines: [{ time: null, text }, ...] }
 *
 * The `time` field is SECONDS (floating-point), matching what Velvet's
 * DOM clock uses — NOT milliseconds like the OpenSubsonic variant.
 * Conversion happens in this module so our shared LRC parser (which
 * yields `time_ms`) stays canonical and the Subsonic path doesn't
 * have to do its own conversion.
 *
 * Lookup precedence (all scoped to the user's visible libraries):
 *   1. `filepath` query param — exact match on tracks.filepath.
 *      The Velvet UI always supplies this when a track has known
 *      metadata; it's the authoritative key.
 *   2. `artist` + `title` params — fallback for yt-dl / raw-file
 *      plays where only the filename is known. Case-insensitive
 *      substring match (same rules as the Subsonic `getLyrics`
 *      artist/title match).
 *   3. None matched → `{ notFound: true }`.
 *
 * Auth: sits behind the main mStream auth wall (same as the rest of
 * /api/v1). Callers MUST have a valid JWT cookie or x-access-token
 * header; the middleware populates req.user.vpaths before we get here.
 */

import * as db from '../db/manager.js';
import { parseLrc, plainTextToLines } from './subsonic/lrc-parser.js';
import * as lrclib from './lyrics-lrclib.js';

function libraryScopeClause(req) {
  const vpaths = req.user?.vpaths || [];
  if (vpaths.length === 0) { return { clause: '1=0', params: [] }; }
  const libs = db.getAllLibraries().filter(l => vpaths.includes(l.name));
  if (libs.length === 0) { return { clause: '1=0', params: [] }; }
  const placeholders = libs.map(() => '?').join(',');
  return {
    clause: `t.library_id IN (${placeholders})`,
    params: libs.map(l => l.id),
  };
}

function lookupByFilepath(req, filepath) {
  const { clause, params } = libraryScopeClause(req);
  // Velvet historically passed a `<vpath>/<relpath>` joined string.
  // Accept either shape: exact match on the stored relative path, or
  // a path whose first segment is the vpath.
  const stored = filepath.replace(/^\/+/, '');
  const alt = stored.includes('/') ? stored.slice(stored.indexOf('/') + 1) : stored;
  return db.getDB().prepare(`
    SELECT t.id, t.title, t.duration, t.audio_hash, t.file_hash,
           t.lyrics_embedded, t.lyrics_synced_lrc, t.lyrics_lang,
           a.name AS artist_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    WHERE ${clause}
      AND (t.filepath = ? OR t.filepath = ?)
    LIMIT 1
  `).get(...params, stored, alt);
}

function lookupByArtistTitle(req, artist, title) {
  if (!artist && !title) { return null; }
  const { clause, params } = libraryScopeClause(req);
  // A track with empty lyrics columns is still queryable — it may carry
  // a read-only `lyrics_cache` hit (written by the proactive backfill
  // for a duplicate-hash twin). Tracks that DO have local lyrics sort
  // first so repeated calls are stable.
  return db.getDB().prepare(`
    SELECT t.id, t.title, t.duration, t.audio_hash, t.file_hash,
           t.lyrics_embedded, t.lyrics_synced_lrc, t.lyrics_lang,
           a.name AS artist_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    WHERE ${clause}
      AND LOWER(COALESCE(a.name, '')) LIKE '%' || LOWER(?) || '%'
      AND LOWER(t.title)              LIKE '%' || LOWER(?) || '%'
    ORDER BY
      CASE WHEN LOWER(a.name)  = LOWER(?) THEN 0 ELSE 1 END,
      CASE WHEN LOWER(t.title) = LOWER(?) THEN 0 ELSE 1 END,
      CASE WHEN t.lyrics_embedded IS NOT NULL
             OR t.lyrics_synced_lrc IS NOT NULL THEN 0 ELSE 1 END,
      t.id
    LIMIT 1
  `).get(...params, artist || '', title || '', artist || '', title || '');
}

// Resolution precedence (same as the Subsonic path): local lyrics on
// the track win; else a read-only `lyrics_cache` hit (written by the
// proactive backfill worker for a duplicate-hash twin it hasn't copied
// onto this row yet); else nothing. No request-triggered fetch — the
// backfill is proactive (src/db/lyrics-backfill.mjs). Kept inline here
// (not imported from handlers.js) because the Velvet response shape is
// different enough that sharing the build step adds more indirection
// than it removes.
function resolve(row) {
  if (!row) { return { plain: null, syncedLrc: null, lang: null }; }
  const hasLocal = row.lyrics_embedded || row.lyrics_synced_lrc;
  if (hasLocal) {
    return {
      plain:     row.lyrics_embedded   || null,
      syncedLrc: row.lyrics_synced_lrc || null,
      lang:      row.lyrics_lang       || null,
    };
  }

  const canonHash = row.audio_hash || row.file_hash || null;
  const cached = canonHash ? lrclib.getCached(canonHash) : null;
  if (cached && cached.status === 'hit') {
    return {
      plain:     cached.plain      || null,
      syncedLrc: cached.synced_lrc || null,
      lang:      cached.lang       || row.lyrics_lang || null,
    };
  }
  return { plain: null, syncedLrc: null, lang: null };
}

// Build the Velvet-shaped response from a tracks row + its resolved
// lyrics. Returns `{notFound: true}` when neither local nor cached
// lyrics are available.
function buildResponse(row) {
  const resolved = resolve(row);

  if (resolved.syncedLrc) {
    const parsed = parseLrc(resolved.syncedLrc);
    if (parsed.lines.length && parsed.synced) {
      return {
        synced: true,
        // Velvet UI reads `time` in seconds; its lyric-scroll loop
        // compares against `audioEl.currentTime`.
        lines: parsed.lines.map(l => ({
          time: l.time_ms / 1000,
          text: l.text || '',
        })),
      };
    }
  }

  const text = resolved.plain || resolved.syncedLrc;
  if (text && text.trim()) {
    const plain = plainTextToLines(text);
    return {
      synced: false,
      lines: plain.lines.map(l => ({ time: null, text: l.text || '' })),
    };
  }

  return { notFound: true };
}

export function setup(mstream) {
  mstream.get('/api/v1/lyrics', (req, res) => {
    const filepath = req.query.filepath ? String(req.query.filepath).trim() : '';
    const artist   = req.query.artist   ? String(req.query.artist).trim()   : '';
    let   title    = req.query.title    ? String(req.query.title).trim()    : '';

    // Velvet passes the raw filename when the DB has no metadata yet
    // (e.g. yt-dl drop-in). Strip the extension and attempt a
    // "Artist - Title" parse so artist+title lookup still works.
    // Kept verbatim from the Velvet fork (aroundmyroom/mStream
    // src/api/lyrics.js).
    const AUDIO_EXT_RE = /\.(mp3|flac|ogg|m4a|aac|wav|opus|wma|aiff?|dsf|dsd)$/i;
    let effectiveArtist = artist;
    if (AUDIO_EXT_RE.test(title)) {
      const bare = title.replace(AUDIO_EXT_RE, '').trim();
      const sep  = bare.indexOf(' - ');
      if (sep > 0 && !effectiveArtist) {
        effectiveArtist = bare.slice(0, sep).trim();
        title           = bare.slice(sep + 3).trim();
      } else {
        title = bare;
      }
    }

    let row = null;
    if (filepath) { row = lookupByFilepath(req, filepath); }
    if (!row)     { row = lookupByArtistTitle(req, effectiveArtist, title); }

    return res.json(buildResponse(row));
  });
}
