/**
 * GET /api/v1/lyrics — default mStream lyrics endpoint.
 *
 * Looks up a track by its filepath (the canonical mStream v1 key — the
 * same `<vpath>/<relpath>` the player already streams via /media) and
 * returns the lyrics stored on that track. Reads only what's on the track
 * row (populated by the scanner + the proactive backfill worker); it never
 * fetches.
 *
 * (Replaces the old Velvet-shaped handler — that UI is being retired. The
 * response is intentionally forward-looking: lyrics are grouped into two
 * typed containers — plain `lyrics` and timed `syncedLyrics` — each a
 * `{ default, lyrics: [] }` list of variants, so we can carry multiple
 * sources / translations per type later without a breaking change. Today
 * each container holds 0 or 1 entry.)
 *
 * Response (200):
 *   {
 *     lyrics:       { default: 0, lyrics: [ { lang, source, data } ] },  // plain text
 *     syncedLyrics: { default: 0, lyrics: [ { lang, source, data } ] },  // raw LRC
 *   }
 *   - each entry's `data` is the raw stored content; the container tells
 *     the client whether to render it as plain text or parse it as LRC.
 *   - `default` indexes the preferred entry; an empty container is `[]`.
 *   - `lang` / `source` are per-entry provenance (track-level today).
 *
 * 400 — missing `path` query param.
 * 404 — { error: 'No lyrics found' } when the track has no lyrics of
 *       either type (or no track matches the path in the caller's libraries).
 *
 * Auth: behind the main mStream auth wall (req.user). The lookup is scoped
 * to the user's visible libraries (vpaths); a path outside them resolves to
 * no row → 404.
 */

import * as db from '../db/manager.js';
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

// Resolve a track by its `<vpath>/<relpath>` (or bare relpath) filepath,
// scoped to the caller's libraries. Parameterized + library-scoped — this
// is a DB key lookup, it never touches the filesystem.
function lookupByFilepath(req, filepath) {
  const { clause, params } = libraryScopeClause(req);
  // Accept either shape the client might send: the stored relative path,
  // or a `<vpath>/<relpath>` joined string whose first segment is the vpath.
  const stored = filepath.replace(/^\/+/, '');
  const alt = stored.includes('/') ? stored.slice(stored.indexOf('/') + 1) : stored;
  return db.getDB().prepare(`
    SELECT t.id, t.audio_hash, t.file_hash,
           t.lyrics_embedded, t.lyrics_synced_lrc, t.lyrics_lang, t.lyrics_source
    FROM tracks t
    WHERE ${clause}
      AND (t.filepath = ? OR t.filepath = ?)
    LIMIT 1
  `).get(...params, stored, alt);
}

// Resolve the lyric strings + provenance for a track row. Precedence:
// local lyrics on the row → a read-only `lyrics_cache` 'hit' (a duplicate-
// hash twin the backfill cached but hasn't copied across) → nothing.
function resolveTrackLyrics(row) {
  if (row.lyrics_embedded || row.lyrics_synced_lrc) {
    return {
      plain:     row.lyrics_embedded   || null,
      syncedLrc: row.lyrics_synced_lrc || null,
      lang:      row.lyrics_lang       || null,
      source:    row.lyrics_source     || null,
    };
  }
  const canonHash = row.audio_hash || row.file_hash || null;
  const cached = canonHash ? lrclib.getCached(canonHash) : null;
  if (cached && cached.status === 'hit') {
    return {
      plain:     cached.plain      || null,
      syncedLrc: cached.synced_lrc || null,
      lang:      cached.lang       || row.lyrics_lang || null,
      source:    cached.source     || null,
    };
  }
  return { plain: null, syncedLrc: null, lang: null, source: null };
}

// Build the forward-looking response from a track row. Returns null when
// the track has no lyrics of either type (→ caller answers 404).
function buildLyricsResponse(row) {
  const r = resolveTrackLyrics(row);
  const entry = (data) => ({ lang: r.lang || null, source: r.source || null, data });
  const plain  = r.plain     ? [entry(r.plain)]     : [];
  const synced = r.syncedLrc ? [entry(r.syncedLrc)] : [];
  if (plain.length === 0 && synced.length === 0) { return null; }
  return {
    lyrics:       { default: 0, lyrics: plain },
    syncedLyrics: { default: 0, lyrics: synced },
  };
}

export function setup(mstream) {
  mstream.get('/api/v1/lyrics', (req, res) => {
    const filepath = req.query.path ? String(req.query.path).trim() : '';
    if (!filepath) {
      return res.status(400).json({ error: 'Missing required query param: path' });
    }
    const row = lookupByFilepath(req, filepath);
    const body = row ? buildLyricsResponse(row) : null;
    if (!body) {
      return res.status(404).json({ error: 'No lyrics found' });
    }
    return res.json(body);
  });
}
