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
      'sample-rate': row.sample_rate ?? null,
      channels: row.channels ?? null,
      'bit-depth': row.bit_depth ?? null,
      'file-size': row.file_size ?? null,
      // ── Existing tracks columns not previously surfaced — pure column
      // maps (trackQuery already SELECTs t.*, so no extra query). ────────
      // `audio-hash` is the V14 audio-payload hash: the PREFERRED stable
      // identity (survives tag edits, album-art changes, ReplayGain
      // rewrites), unlike `hash` above which covers the whole file.
      // Both are full MD5s below the 25MB sampling threshold and
      // sampled digests above it (V60 — see src/db/audio-hash.js), so
      // neither is a byte-exact checksum for big files. Added as a new
      // field; `hash` is left untouched for back-compat.
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
      // Lyrics availability flags. The lyrics TEXT (and its language) are
      // intentionally NOT inlined here — they would bloat every list
      // response; fetch them via the dedicated lyrics endpoint
      // (GET /api/v1/lyrics).
      'has-lyrics': !!(row.lyrics_embedded || row.lyrics_synced_lrc),
      'has-synced-lyrics': !!row.lyrics_synced_lrc,
      // V43: track/disc totals from embedded tags (both scanners).
      // `track-total` / `disc-total` pair with the existing `track` / `disk`
      // (i.e. track N "of" total). NULL until a post-V43 force-rescan.
      // (Composer deferred to the role-based contributors follow-up.)
      'track-total': row.track_total ?? null,
      'disc-total': row.disc_total ?? null,
      // V55: external-service identifiers read from embedded tags (and, in a
      // later pass, derived for untagged files via acoustic fingerprinting).
      // `musicbrainz-recording-id` is the stable cross-release per-file key;
      // `musicbrainz-track-id` is the release-specific track MBID. `mbz-id-
      // source` ('tag' vs future 'acoustid') is the provenance companion,
      // mirroring `bpm-source`. NULL on rows whose tags carried none.
      'musicbrainz-recording-id': row.mbz_recording_id || null,
      'musicbrainz-track-id': row.mbz_release_track_id || null,
      'acoustid-id': row.acoustid_id || null,
      isrc: row.isrc || null,
      'mbz-id-source': row.mbz_id_source || null,
    }
  };
}

// ── Lite metadata projection ────────────────────────────────────────────────
//
// LITE_METADATA_FIELDS is the subset of renderMetadataObj's keys that large
// list responses (e.g. /api/v1/db/search) carry instead of the full object:
// everything needed to render a list row, drive the now-playing card, and feed
// Auto-DJ — WITHOUT the fidelity / diagnostic / identity / stats fields that
// only the on-demand detail view needs (those come from /api/v1/db/metadata).
//
// It is a STRICT SUBSET of the full object — same keys, same kebab-casing — so
// any consumer reading these fields works on either shape. Today both ride
// under the same `metadata` key; the lite-vs-full distinction will be named
// explicitly in the v2 API.
export const LITE_METADATA_FIELDS = [
  'title', 'artist', 'album', 'album-art', 'year', 'track', 'disk',
  'duration', 'rating', 'bpm', 'musical-key', 'genres',
  'has-lyrics', 'has-synced-lyrics', 'replaygain-track',
];

// Project a full renderMetadataObj `metadata` object down to the lite subset.
// Returns null for a null/absent input (preserving the `metadata: null` slot a
// missing track row produces). Picks exact values — arrays/booleans/0 survive.
export function toLiteMetadata(metadata) {
  if (!metadata) { return null; }
  const lite = {};
  for (const key of LITE_METADATA_FIELDS) { lite[key] = metadata[key]; }
  return lite;
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

  if (libIds.length === 0) { return { clause: '1=0', params: [], coversAllLibraries: false }; }

  // Does this filter actually filter anything? When the caller can see every
  // library the clause is a no-op, and a couple of hot read paths drop it
  // entirely — which lets SQLite satisfy their ORDER BY / GROUP BY straight
  // from an index instead of probing idx_tracks_library across the whole
  // visible set and sorting the result in a temp b-tree.
  //
  // ONLY safe as a no-op shortcut. Forcing that index-ordered plan while a
  // real filter is in play regresses badly: a user who can see one small
  // library of old tracks would walk the entire created_at index to fill a
  // page (measured 0.05 ms → 13.7 ms at 25k tracks).
  //
  // Compared as a set rather than by length: a federation key supplies
  // `user.libraryIds` directly (see getUserLibraryIds) and could repeat an id
  // or name one that no longer exists.
  const visible = new Set(libIds);
  const allLibs = db.getAllLibraries();
  const coversAllLibraries = allLibs.length > 0 && allLibs.every(l => visible.has(l.id));

  return {
    clause: `t.library_id IN (${libIds.map(() => '?').join(',')})`,
    params: libIds,
    coversAllLibraries
  };
}

// Base query: tracks joined with artists, albums, library, optionally
// user_metadata, and (when `includeGenres` is set) a track_genres
// aggregation.
//
// `includeGenres` controls whether the `tg_agg` LEFT JOIN runs — and it
// DEFAULTS TO FALSE. The join materialises a GROUP_CONCAT over the ENTIRE
// track_genres table before the WHERE applies, so its cost scales with the
// library, not the query (~460ms extrapolated at 100k tracks, paid per
// request). Every caller in the tree was converted off it (2026-07 audit):
// render your rows first, then attach genres to JUST those rows via
// enrichRowsWithGenres (lists) or fetchGenresForTrack (single row) below.
// includeGenres:true survives only for a hypothetical caller that truly
// wants the whole-table aggregation inline — as of the conversion there are
// none, and new code should not become the first without measuring.
//
// char(31) (ASCII unit separator) is the join delimiter so no legal
// genre name can collide with it.
export function trackQuery(userId, { includeGenres = false } = {}) {
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

// Batched genre lookup for a SET of track ids — the multi-row companion to
// fetchGenresForTrack. Returns Map<track_id, genres_concat>. ONE indexed query
// over track_genres, filtered by the id set (not the whole table), so cost
// scales with the id set, not library size. Lets renderMetadataByIds enrich a
// whole search-result page without N per-row point-lookups.
function fetchGenresForTracks(d, ids) {
  const out = new Map();
  if (ids.length === 0) { return out; }
  const placeholders = ids.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT tg.track_id, GROUP_CONCAT(g.name, char(31)) AS genres_concat
      FROM track_genres tg
      JOIN genres g ON g.id = tg.genre_id
     WHERE tg.track_id IN (${placeholders})
     GROUP BY tg.track_id
  `).all(...ids);
  for (const r of rows) { out.set(r.track_id, r.genres_concat); }
  return out;
}

// Enrich trackQuery({ includeGenres: false }) rows with their genre
// aggregation in ONE indexed batch, in place — the companion every
// response-shaped list endpoint uses instead of the default tg_agg join
// (which materialises over the ENTIRE track_genres table, so a list
// endpoint's cost scaled with the library, not the response — see
// trackQuery's note). Returns `rows` with genres_concat set,
// renderMetadataObj-ready. Exported for the trackQuery callers that live
// outside this file (smart-playlists, velvet-stubs).
export function enrichRowsWithGenres(d, rows) {
  // Chunked like renderMetadataByIds/pullMetaDataBatch above: one IN() per
  // 500 ids keeps huge responses (whole-genre / whole-decade listings) under
  // SQLite's bound-variable limit — an unchunked list threw 'too many SQL
  // variables' past ~32k rows. Ids are de-duped first: join-shaped callers
  // (the smart-playlist genre filter) can hand the same track twice.
  const uniq = [...new Set(rows.map((r) => r.id))];
  const genres = new Map();
  const CHUNK = 500;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    for (const [id, gc] of fetchGenresForTracks(d, uniq.slice(i, i + CHUNK))) {
      genres.set(id, gc);
    }
  }
  for (const row of rows) { row.genres_concat = genres.get(row.id) || null; }
  return rows;
}

// Batched metadata render keyed on track id. Returns Map<id, { filepath, metadata }>
// (the exact renderMetadataObj wrapper) for every id that still resolves to a
// track row; ids whose row vanished since the caller queried are simply absent
// from the map — the caller decides how to degrade.
//
// Built for the /api/v1/db/search enrichment path: the search builders hand
// back rank-ordered track ids (≤30 per category, ≤90 total) and need the full
// canonical metadata object without one query per hit. Mirrors
// pullMetaDataBatch's strategy — trackQuery with includeGenres:false so the
// heavy whole-table genre GROUP_CONCAT never runs (it would cost ~460ms at
// 100k tracks on EVERY search), then ONE batched genre lookup over just these
// ids. Two queries total per chunk regardless of result-set size, and both are
// id-indexed, so this stays flat as the library grows.
//
// Deliberately a lookup MAP, not an ordered list: `t.id IN (...)` does not
// preserve order, but the caller iterates its own rank-ordered id list against
// this map, so FTS rank ordering is never disturbed.
export function renderMetadataByIds(ids, user) {
  const d = db.getDB();
  const result = new Map();
  if (!d || !Array.isArray(ids) || ids.length === 0) { return result; }

  // De-dupe: the same track can match in more than one search category
  // (title + files + lyrics), so resolve the union once.
  const uniq = [...new Set(ids)];
  const userIdParams = user?.id ? [user.id] : [];
  const CHUNK = 500;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    // trackQuery's user_metadata join carries the only other bind param (the
    // user id, when present); it precedes the IN list, matching userIdParams
    // first — same ordering pullMetaDataBatch relies on.
    const rows = d.prepare(
      `${trackQuery(user?.id, { includeGenres: false })} WHERE t.id IN (${placeholders})`
    ).all(...userIdParams, ...slice);

    const genres = fetchGenresForTracks(d, slice);
    for (const row of rows) {
      row.genres_concat = genres.get(row.id) || null;
      result.set(row.id, renderMetadataObj(row));
    }
  }
  return result;
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

  // includeGenres:false + point enrichment: the default tg_agg join
  // materialises the whole track_genres table to fetch ONE row (~69 ms at
  // 25k tracks) — and the no-login shared-playlist page fires this once per
  // track. Same conversion pullMetaDataBatch made long ago; this was the
  // single-row straggler.
  const row = d.prepare(`
    ${trackQuery(user?.id, { includeGenres: false })}
    WHERE t.filepath = ? AND t.library_id = ?
  `).get(...(user?.id ? [user.id] : []), pathInfo.relativePath, lib.id);

  if (!row) { return { filepath: filepath, metadata: null }; }
  row.genres_concat = fetchGenresForTrack(d, row.id).genres_concat ?? null;
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
    // Shape matters here, not just the predicates. Written as an OR of three
    // album-id tests AND-ed to a tracks join, SQLite drove the whole thing
    // from tracks — SEARCH t USING idx_tracks_library across the entire
    // visible library, once per artist click, on the hottest default-UI path
    // (2026-07 audit). Collapsing the three sources into one UNION ALL id set
    // gives the planner a single small candidate list to seek albums by, and
    // the visibility test becomes an EXISTS probe per candidate instead of a
    // driving scan: 21.8 ms → 0.05 ms at 25k tracks.
    //
    // UNION ALL, not UNION: duplicates across the three sources are harmless
    // (`al.id IN (…)` is a membership test) and deduping them would cost a
    // temp b-tree. The outer DISTINCT is retained from the original — two
    // distinct album rows can share (name, year, art), e.g. the same album
    // present in two libraries, and the original collapsed those.
    //
    // The name tiebreak exists because `ORDER BY al.year DESC` alone leaves
    // same-year order to the plan, the old and new plans disagree on it, and
    // the UI renders response order — without it, an artist's same-year
    // albums would visibly reshuffle on upgrade (25k-fixture sweep: 200 of
    // 653 artists). Pinning ties alphabetically is deterministic across
    // plans and SQLite versions; the sort b-tree already exists, so it's
    // free.
    const albumRows = d().prepare(`
      SELECT DISTINCT al.name, al.year, al.album_art_file
      FROM albums al
      WHERE al.id IN (
        SELECT id FROM albums WHERE artist_id IN (SELECT id FROM artists WHERE name = ?)
        UNION ALL
        SELECT album_id FROM album_artists
          WHERE artist_id IN (SELECT id FROM artists WHERE name = ?)
        UNION ALL
        SELECT t2.album_id FROM track_artists ta
          JOIN tracks t2 ON t2.id = ta.track_id
          WHERE ta.artist_id IN (SELECT id FROM artists WHERE name = ?)
            AND t2.album_id IS NOT NULL
      )
      AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${filter.clause})
      ORDER BY al.year DESC, al.name COLLATE NOCASE
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

    // Same no-op shortcut as recent/added: with every library visible the
    // tracks join exists only to enforce a filter that excludes nothing, so
    // the count comes straight off the M2M (19.8 ms → 2.8 ms at 25k tracks).
    // Equivalent because track_genres is PRIMARY KEY (track_id, genre_id) —
    // no duplicate pairs, so COUNT(*) per genre IS COUNT(DISTINCT track_id) —
    // and track_id is a CASCADE foreign key, so there are no orphan rows to
    // over-count. DISTINCT is kept for the same reason the original had it:
    // legacy data can hold two vocabulary rows with the same name.
    const rows = filter.coversAllLibraries
      ? d().prepare(`
          SELECT DISTINCT g.name, COUNT(*) AS track_count
          FROM track_genres tg
          JOIN genres g ON g.id = tg.genre_id
          GROUP BY g.id
          ORDER BY g.name COLLATE NOCASE
        `).all()
      : d().prepare(`
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
    // `limit`/`offset` are optional and default to "everything", so the
    // existing full-list contract is untouched. They exist because a
    // dominant genre returns the whole library in one response (measured
    // 10,500 rows / 3.5 MB for a 42%-share genre at 25k tracks, 2026-07
    // audit M8) and there was previously no way for a client to ask for a
    // page. This is the server half only — nothing gets faster until a
    // caller opts in.
    // `.unknown(true)` on purpose: this route has never had a schema, and it
    // is reachable from clients this repo does not contain (the Flutter app,
    // federated peers — see federation-auth's allow-list). Rejecting fields
    // that used to be ignored would be a breaking change smuggled into a
    // perf PR. The new paging fields are still validated.
    const schema = Joi.object({
      genre: Joi.string().required(),
      limit: Joi.number().integer().min(1).max(10000).optional(),
      offset: Joi.number().integer().min(0).optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    }).unknown(true);
    // Use the COERCED value, not req.body: Joi turns `limit: "50"` into a
    // number, and binding a string into LIMIT would be a different query.
    const { value: query } = joiValidate(schema, req.body);

    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);

    // V34: case-insensitive name match — uniform with the post-V34
    // case-folded vocabulary getGenres now returns. Pre-V34 this
    // would silently miss "Jazz" vs "jazz" if the M2M had both rows
    // (the "1247 jazz tracks shown but only 800 returned" bug).
    //
    // Name → id(s) resolved FIRST so the M2M probe drives
    // idx_track_genres_genre instead of walking every track_genres row
    // (the name-join form scanned the whole M2M regardless of how small
    // the genre was). NOCASE can hit multiple vocabulary rows on
    // pre-V34-shaped data; joining every matched id reproduces the old
    // name-join's row multiplicity exactly.
    const genreIds = d().prepare('SELECT id FROM genres WHERE name COLLATE NOCASE = ?')
      .all(String(req.body.genre)).map((r) => r.id);
    if (genreIds.length === 0) { return res.json([]); }
    const idPh = genreIds.map(() => '?').join(',');
    const allParams = req.user?.id
      ? [req.user.id, ...genreIds, ...filter.params]
      : [...genreIds, ...filter.params];

    // SQLite treats LIMIT -1 as "no limit", and OFFSET is meaningless without
    // one — so the unpaged call keeps exactly its old plan and result.
    const pageSql = (query.limit != null || query.offset != null)
      ? 'LIMIT ? OFFSET ?' : '';
    const pageParams = pageSql
      ? [query.limit ?? -1, query.offset ?? 0] : [];

    const rows = d().prepare(`
      ${trackQuery(req.user?.id, { includeGenres: false })}
      JOIN track_genres tg ON tg.track_id = t.id AND tg.genre_id IN (${idPh})
      WHERE ${filter.clause}
      ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.disc_number, t.track_number
      ${pageSql}
    `).all(...allParams, ...pageParams);

    res.json(enrichRowsWithGenres(d(), rows).map(renderMetadataObj));
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
      ${trackQuery(req.user?.id, { includeGenres: false })}
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.disc_number, t.track_number, t.filepath
    `).all(...allParams);

    res.json(enrichRowsWithGenres(d(), rows).map(renderMetadataObj));
  });

  // ── Search ──────────────────────────────────────────────────────────────
  // /api/v1/db/search lives in src/api/search.js. server.js calls
  // searchApi.setup(mstream) separately. Kept out of this file so
  // the search implementation can grow without bloating the generic
  // DB route module.

  // Homepage stats (rated / recently-played / most-played) used to be
  // tracks-driven: trackQuery LEFT JOIN user_metadata scanned and sorted the
  // whole tracks table (plus its whole-table genre materialisation) just to
  // surface the handful of rows this user has rated/played. They now seek
  // those rows FROM user_metadata via the V61 (user_id, <stat>) composite
  // indexes and resolve each to its track by canonical hash (~450x at 20k
  // tracks). The ordered ids are then rendered through the same batched
  // trackQuery path search uses (renderMetadataByIds), so the response shape
  // stays identical to the old queries — and picks up future metadata fields
  // automatically.
  function userStatRows(user, statColumn, statFilter, filter, limit) {
    // The natural OR-form hash join (audio_hash = h OR file_hash = h) is a
    // trap here: without ANALYZE stats the planner serves it — and the
    // pushed-down library filter — from idx_tracks_library, i.e. a whole-
    // library scan per user_metadata row. So the join is split into disjoint
    // UNION ALL branches (audio-canonical vs file-canonical-with-NULL-audio,
    // which together reproduce COALESCE(audio_hash, file_hash) = track_hash
    // exactly), each pinned to its hash index with INDEXED BY, inside a
    // MATERIALIZED CTE so the library filter cannot be pushed back down.
    // The filter then runs over the handful of resolved rows. INDEXED BY is
    // deliberate: if a migration ever drops either hash index this query
    // errors loudly instead of silently regressing to a scan (the
    // db-stats integration test asserts the plan).
    const sql = `
      WITH c AS (SELECT track_hash, ${statColumn} AS stat
                   FROM user_metadata
                  WHERE user_id = ? AND ${statFilter}),
      resolved AS MATERIALIZED (
        SELECT tr.id AS id, tr.library_id AS library_id, c.stat AS stat
          FROM c JOIN tracks tr INDEXED BY idx_tracks_audio_hash
            ON tr.audio_hash = c.track_hash
        UNION ALL
        SELECT tr.id, tr.library_id, c.stat
          FROM c JOIN tracks tr INDEXED BY idx_tracks_hash
            ON tr.file_hash = c.track_hash
         WHERE tr.audio_hash IS NULL
      )
      SELECT t.id
      FROM resolved t
      WHERE ${filter.clause}
      ORDER BY t.stat DESC${limit != null ? '\n      LIMIT ?' : ''}
    `;
    const params = [user.id, ...filter.params];
    if (limit != null) { params.push(limit); }
    const ids = d().prepare(sql).all(...params).map(r => r.id);
    const rendered = renderMetadataByIds(ids, user);
    return ids.map((id) => rendered.get(id)).filter(Boolean);
  }

  // ── Rated Songs ─────────────────────────────────────────────────────────

  function getRatedSongs(req) {
    if (!req.user?.id) { return []; }
    const filter = libraryFilter(req.user, req.body?.ignoreVPaths);
    return userStatRows(req.user, 'rating', 'rating > 0', filter, null);
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
    if (!lib) { throw new WebError('Library not found', 404); }

    const track = d().prepare(
      'SELECT file_hash, audio_hash FROM tracks WHERE filepath = ? AND library_id = ?'
    ).get(pathInfo.relativePath, lib.id);
    if (!track) { throw new WebError('File Not Found', 404); }
    // Hashless row (failed parse): track_hash is NOT NULL — binding
    // null would surface as a 500 constraint throw.
    if (!track.audio_hash && !track.file_hash) { throw new WebError('File Not Found', 404); }

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
    // With every library visible the scope clause excludes nothing, and
    // dropping it is what lets SQLite walk idx_tracks_created_at and stop at
    // LIMIT — otherwise it probes idx_tracks_library for the entire visible
    // set and sorts that in a temp b-tree (45.6 ms → 0.2 ms at 25k tracks).
    // See libraryFilter for why this is gated on the no-op case only.
    const scopeSql = filter.coversAllLibraries ? '' : `WHERE ${filter.clause}`;
    const scopeParams = filter.coversAllLibraries ? [] : filter.params;
    const allParams = req.user?.id ? [req.user.id, ...scopeParams] : scopeParams;

    const rows = d().prepare(`
      ${trackQuery(req.user?.id, { includeGenres: false })}
      ${scopeSql}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ?
    `).all(...allParams, req.body.limit);

    res.json(enrichRowsWithGenres(d(), rows).map(renderMetadataObj));
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
    res.json(userStatRows(req.user, 'last_played', 'last_played IS NOT NULL', filter, req.body.limit));
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
    res.json(userStatRows(req.user, 'play_count', 'play_count > 0', filter, req.body.limit));
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
