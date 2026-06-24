/**
 * Subsonic API endpoint handlers (Phase 1).
 *
 * Covers the minimum set a typical Subsonic client needs to connect, browse
 * a library, and start playback:
 *
 *   System:    ping, getLicense, getMusicFolders
 *   Browsing:  getIndexes, getMusicDirectory, getArtists, getArtist,
 *              getAlbum, getSong, getGenres
 *   Media:     getCoverArt, stream, download
 *   Search:    search3 (plus search, search2 as thin shims)
 *
 * IDs are bare numeric DB row IDs. Clients treat them as opaque strings.
 * getCoverArt routes by trying the songs → albums tables in that order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import winston from 'winston';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import * as db from '../../db/manager.js';
import * as config from '../../state/config.js';
import * as dbQueue from '../../db/task-queue.js';
import * as adminUtil from '../../util/admin.js';
import { ffmpegBin, getResolvedSource } from '../../util/ffmpeg-bootstrap.js';
import { serveAlbumArtFile } from '../album-art.js';
import * as serverPlayback from '../server-playback.js';
import { sendOk, sendError, SubErr } from './response.js';
import * as nowPlaying from './now-playing.js';
import { parseLrc, linesToPlainText, plainTextToLines } from './lrc-parser.js';
import * as lrclib from '../lyrics-lrclib.js';
import { identiconFor } from './identicon.js';
import { parseSearchQuery, buildFtsExpression } from '../../util/search-query.js';

// ── Common helpers ──────────────────────────────────────────────────────────

// Comma-separated list of leading articles Subsonic sorting ignores.
const IGNORED_ARTICLES = 'The An A Die Das Ein Eine Les Le La';

// V34 dropped the legacy `tracks.genre` flat TEXT column — the canonical
// store is now the track_genres + genres M2M. Subsonic's Song/Album
// schemas expect a single `genre` string per row, so for the per-track
// SELECTs we resolve "the primary genre" via a correlated subquery
// against the M2M, picking the row with the lowest `tg.rowid` — which
// is the genre that appeared FIRST in the track's source tag string.
//
// Why first-in-tag-string (via tg.rowid):
//   • Honours the widespread convention that the leading genre in a
//     "Rock, Pop" style ID3 tag is the user's intended primary; tools
//     like MusicBrainz Picard and beets preserve this order.
//   • Per-track stable: setTrackGenres iterates the split list
//     left-to-right and INSERT OR IGNORE assigns rowids
//     monotonically. Different worker threads scan different tracks,
//     so a given track's M2M rows always end up in the order its own
//     setTrackGenres saw them — independent of cross-track race
//     scheduling.
//   • Stable across rescans + tag edits: the scanner deletes the
//     parent track (cascading to track_genres) and re-INSERTs in
//     current tag order; replaceTrackGenres in the tag-edit handler
//     does DELETE + ordered re-INSERT inside a transaction. Both
//     produce fresh rowids in the new tag-string order.
//   • Stable across VACUUM: SQLite preserves rowids on regular
//     (non-WITHOUT-ROWID) tables since 3.1.0.
//
// `ORDER BY g.id` (the prior implementation) was REJECTED because it
// resolves against the global `genres` table insertion order, not the
// per-track tag order. A track tagged "Jazz, Fusion" could yield
// "Fusion" if the library had already seen "Fusion" via an earlier
// track, putting it at a lower id. Confusing and non-tag-faithful.
//
// `ORDER BY g.name COLLATE NOCASE` (an intermediate proposal) was
// REJECTED because it ignored tagger intent entirely — "Jazz, Fusion"
// would surface as "Fusion" (F < J) even on a fresh scan.
//
// Multi-genre tracks lose the secondary genres for now; if/when we
// want to surface them, the OpenSubsonic `genres[]` extension is the
// right place.
//
// Performance note: this is a per-row correlated subquery. Empirically
// negligible because `idx_track_genres_track` (V2) makes the inner
// `WHERE tg.track_id = t.id` an index-seek. The ORDER BY then sorts
// the small per-track result set (typically 1-3 genres) by rowid,
// which is the table's natural order — effectively free.
const TRACK_PRIMARY_GENRE_SQL =
  '(SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id ORDER BY tg.rowid LIMIT 1) AS genre';

// Album-level companion of TRACK_PRIMARY_GENRE_SQL. Picks the
// first-by-rowid genre across all tracks in this album. Approximates
// "the first genre on the first-scanned track of the album" since
// rowids in track_genres are globally monotonic. Pre-V34 used
// `MIN(t.genre)` (alphabetically-first flat string) — different
// semantics, but album-level genre fields are minor wire-shape
// items and few clients render them prominently.
//
// Uses aliases `tg2` / `t2` to avoid collisions with the outer
// query's `t` and any existing `tg` it may use. Expects the outer
// query to expose `al.id` (album id).
const ALBUM_PRIMARY_GENRE_SQL =
  '(SELECT g.name FROM track_genres tg2 JOIN tracks t2 ON t2.id = tg2.track_id JOIN genres g ON g.id = tg2.genre_id WHERE t2.album_id = al.id ORDER BY tg2.rowid LIMIT 1) AS genre';

// OpenSubsonic `genres[]` extension — full multi-genre list as an
// ordered array of ItemGenre objects (`{ name: "Rock" }`). Co-exists
// with the legacy `genre` string field: legacy clients keep working
// because we still emit the singular primary; OpenSubsonic-aware
// clients (Symfonium, play:Sub, Feishin, recent Subsonic Web UI
// builds, …) get the full list and can render genre chips properly.
//
// Order matches tg.rowid (= tag-string order from the scanner), so
// `genres[0].name === genre`. Producing the JSON in SQL via
// `json_group_array(json_object(...))` keeps the per-row cost low
// (no extra round trip + no JSON.stringify in JS for the common
// case of single-genre tracks where the array materialisation is
// trivial). songFromRow parses the string into a real array.
//
// Empty result for untagged tracks: `json_group_array` of zero rows
// returns the literal string `"[]"` — songFromRow checks for empty
// after parse and omits the field entirely (response: no `genres`
// key, matches the "absent" convention for other optional fields).
//
// The inner subquery aliases tg/g afresh; outer correlated reference
// is `t.id`. Inner ORDER BY tg.rowid preserves tag-string order in
// the materialised array.
const TRACK_GENRES_JSON_SQL =
  '(SELECT json_group_array(json_object(\'name\', name)) FROM (' +
    'SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id ' +
    'WHERE tg.track_id = t.id ORDER BY tg.rowid' +
  ')) AS genres_json';

// Album-level OpenSubsonic `genres[]`. DISTINCT genre names across
// the album's tracks (a multi-genre album where every track shares
// the same two genres should surface those two genres once, not
// twice-per-track). Ordering is "by when the genre first appeared
// in the album's M2M" (MIN(tg2.rowid)) — keeps the primary
// (ALBUM_PRIMARY_GENRE_SQL's pick) first, with secondaries trailing
// in scan-time order. Inner GROUP BY g.id collapses dupes.
//
// Aliases tg2/t2 to avoid collisions with the outer query's tg/t
// (and to mirror ALBUM_PRIMARY_GENRE_SQL's alias choice).
const ALBUM_GENRES_JSON_SQL =
  '(SELECT json_group_array(json_object(\'name\', name)) FROM (' +
    'SELECT g.name, MIN(tg2.rowid) AS first_seen ' +
    'FROM track_genres tg2 ' +
    'JOIN tracks t2 ON t2.id = tg2.track_id ' +
    'JOIN genres g ON g.id = tg2.genre_id ' +
    'WHERE t2.album_id = al.id ' +
    'GROUP BY g.id ' +
    'ORDER BY first_seen' +
  ')) AS genres_json';

// Shared parser for the `genres_json` column populated by either
// TRACK_GENRES_JSON_SQL or ALBUM_GENRES_JSON_SQL. Returns the parsed
// array of ItemGenre objects, or `undefined` for empty / missing /
// malformed input. Used in songFromRow and the album response
// shapers so both paths converge on identical "absent vs. present"
// semantics (absent → no field in response, present → ItemGenre[]).
function parseGenresJson(genresJson) {
  if (!genresJson) { return undefined; }
  try {
    const parsed = JSON.parse(genresJson);
    if (Array.isArray(parsed) && parsed.length > 0) { return parsed; }
  } catch (_) {
    // json_group_array shouldn't produce malformed output; defensive
    // swallow so a bizarre corrupted row doesn't kill the whole
    // response.
  }
  return undefined;
}

// ── ID encoding ─────────────────────────────────────────────────────────────
// Containers get type-prefixed opaque IDs so getMusicDirectory and getCoverArt
// can route correctly even when artist/album/song numeric rowids overlap.
//   mf-N  music folder (library)
//   ar-N  artist
//   al-N  album
//   N     song (bare numeric — clients commonly pass song ids through to
//         getCoverArt, stream, scrobble, etc., and bare numerics are what
//         every Subsonic client expects for those endpoints)

const encArtist = n => `ar-${n}`;
const encAlbum  = n => `al-${n}`;
const encFolder = n => `mf-${n}`;

function decodeId(str, expectedType) {
  if (str == null) { return null; }
  const s = String(str);
  // Bare numeric = song
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (expectedType && expectedType !== 'song') { return null; }
    return { type: 'song', id: n };
  }
  const m = /^(ar|al|mf)-(\d+)$/.exec(s);
  if (!m) { return null; }
  const type = m[1] === 'ar' ? 'artist' : m[1] === 'al' ? 'album' : 'folder';
  if (expectedType && expectedType !== type) { return null; }
  return { type, id: parseInt(m[2], 10) };
}

function isoUtc(d) {
  if (!d) { return undefined; }
  // DB timestamps are "YYYY-MM-DD HH:MM:SS" in UTC (SQLite default). Convert
  // to ISO 8601 which is what Subsonic clients expect.
  const s = typeof d === 'string' ? d.replace(' ', 'T') + 'Z' : new Date(d).toISOString();
  return s;
}

function suffixFor(filepath, format) {
  return (format || path.extname(filepath).slice(1) || '').toLowerCase();
}

const MIME_BY_SUFFIX = {
  mp3:  'audio/mpeg',
  flac: 'audio/flac',
  wav:  'audio/wav',
  ogg:  'audio/ogg',
  opus: 'audio/opus',
  aac:  'audio/mp4',
  m4a:  'audio/mp4',
  m4b:  'audio/mp4',
};
function contentTypeFor(suffix) {
  return MIME_BY_SUFFIX[suffix] || 'application/octet-stream';
}

// Restrict a track query to libraries this user can see. Returns a WHERE
// fragment + its params, ready to concat into a larger query.
function libraryScope(req) {
  const vpaths = req.user?.vpaths || [];
  if (vpaths.length === 0) { return { clause: '1=0', params: [] }; }
  const libs = db.getAllLibraries().filter(l => vpaths.includes(l.name));
  if (libs.length === 0) { return { clause: '1=0', params: [] }; }
  const placeholders = libs.map(() => '?').join(',');
  return { clause: `t.library_id IN (${placeholders})`, params: libs.map(l => l.id) };
}

// Look up a user's metadata row for a given track. Used by star/rating/
// scrobble handlers. Returns the row (possibly with NULL fields) or null if
// we can't even find the track.
// Return the canonical identity hash for a track. Prefers audio_hash (stable
// across tag edits) and falls back to file_hash for formats the scanner
// doesn't extract an audio region from and for rows created before the
// audio_hash column was added.
function trackFileHash(trackId) {
  const row = db.getDB().prepare(
    'SELECT file_hash, audio_hash FROM tracks WHERE id = ?'
  ).get(trackId);
  return row ? (row.audio_hash || row.file_hash) : undefined;
}

// Both identity hashes for a track: `canon` for writes, `all` for
// matching rows that may still be keyed under the legacy hash
// (bookmarks written before audio_hash existed, or by the pre-V52
// scrobble bug). Without the `all` set, deleteBookmark could never
// remove a legacy-keyed bookmark that getBookmarks happily lists.
function trackHashVariants(trackId) {
  const row = db.getDB().prepare(
    'SELECT file_hash, audio_hash FROM tracks WHERE id = ?'
  ).get(trackId);
  if (!row) { return null; }
  const all = [row.audio_hash, row.file_hash].filter(Boolean);
  if (!all.length) { return null; }
  return { canon: row.audio_hash || row.file_hash, all };
}

// SQLite caps bound variables per statement; play queues and bookmark
// lists bind every hash TWICE (audio_hash IN + file_hash IN), so a
// ~500-entry queue can blow the ceiling. Chunk size keeps each
// statement's variable count comfortably under any build's limit.
const HASH_BIND_CHUNK = 400;
function chunkedHashes(hashes) {
  const out = [];
  for (let i = 0; i < hashes.length; i += HASH_BIND_CHUNK) {
    out.push(hashes.slice(i, i + HASH_BIND_CHUNK));
  }
  return out;
}

// Upsert a user_metadata row, setting the supplied fields. Leaves other
// fields untouched — clients that only call setRating shouldn't clobber
// starred_at, and vice versa.
function upsertUserMeta(userId, trackHash, fields) {
  if (!trackHash) { return false; }
  const d = db.getDB();
  // Insert if the row doesn't exist yet; caller's SET block runs either way.
  d.prepare('INSERT OR IGNORE INTO user_metadata (user_id, track_hash) VALUES (?, ?)').run(userId, trackHash);
  const keys = Object.keys(fields);
  if (keys.length === 0) { return true; }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  d.prepare(`UPDATE user_metadata SET ${setClause} WHERE user_id = ? AND track_hash = ?`)
    .run(...vals, userId, trackHash);
  return true;
}

// Batched counterpart to trackFileHash: resolve many track ids to their
// { file_hash, audio_hash } in a single query, so scrobble / star / getBookmarks
// don't fire one SELECT per id. Returns Map<id, { file_hash, audio_hash }>.
function trackHashesByIds(ids) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) { return new Map(); }
  const ph = uniq.map(() => '?').join(',');
  const rows = db.getDB().prepare(
    `SELECT id, file_hash, audio_hash FROM tracks WHERE id IN (${ph})`
  ).all(...uniq);
  return new Map(rows.map(r => [r.id, r]));
}

// Look up the star-timestamp for a set of album or artist ids for the caller.
// Returns a Map<id, isoString>. Empty input returns an empty Map.
function albumStarMap(userId, albumIds) {
  if (!albumIds.length) { return new Map(); }
  const ph = albumIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(
    `SELECT album_id, starred_at FROM user_album_stars
     WHERE user_id = ? AND album_id IN (${ph})`
  ).all(userId, ...albumIds);
  return new Map(rows.map(r => [r.album_id, r.starred_at]));
}
function artistStarMap(userId, artistIds) {
  if (!artistIds.length) { return new Map(); }
  const ph = artistIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(
    `SELECT artist_id, starred_at FROM user_artist_stars
     WHERE user_id = ? AND artist_id IN (${ph})`
  ).all(userId, ...artistIds);
  return new Map(rows.map(r => [r.artist_id, r.starred_at]));
}

// Bulk-annotate Subsonic song objects with the current user's starred /
// rating / play-count state. Cheaper than joining user_metadata into every
// base query.
function enrichSongsWithUserMeta(req, songs) {
  if (!songs.length) { return songs; }
  const trackIds = songs
    .map(s => parseInt(s.id, 10))
    .filter(Number.isFinite);
  if (!trackIds.length) { return songs; }

  const placeholders = trackIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(`
    SELECT t.id, um.starred_at, um.rating, um.play_count
    FROM tracks t
    LEFT JOIN user_metadata um
      ON um.track_hash = COALESCE(t.audio_hash, t.file_hash) AND um.user_id = ?
    WHERE t.id IN (${placeholders})
  `).all(req.user.id, ...trackIds);

  const meta = new Map(rows.map(r => [r.id, r]));

  // OpenSubsonic: batch-fetch per-track artist arrays (V17). One query,
  // fan into a Map<track_id, [{id, name}, ...]>.
  const artistRows = db.getDB().prepare(`
    SELECT ta.track_id, ta.position, a.id, a.name
    FROM track_artists ta
    JOIN artists a ON a.id = ta.artist_id
    WHERE ta.track_id IN (${placeholders})
    ORDER BY ta.track_id, ta.position
  `).all(...trackIds);
  const artistsByTrack = new Map();
  for (const r of artistRows) {
    if (!artistsByTrack.has(r.track_id)) { artistsByTrack.set(r.track_id, []); }
    artistsByTrack.get(r.track_id).push({ id: encArtist(r.id), name: r.name });
  }

  for (const song of songs) {
    const trackId = parseInt(song.id, 10);
    const m = meta.get(trackId);
    if (m) {
      if (m.starred_at)                     { song.starred    = isoUtc(m.starred_at); }
      if (m.rating && m.rating > 0)         { song.userRating = m.rating; }
      if (m.play_count && m.play_count > 0) { song.playCount  = m.play_count; }
    }
    const artists = artistsByTrack.get(trackId);
    if (artists && artists.length) { song.artists = artists; }
  }
  return songs;
}

// Normalise a repeated query param — Express gives us an Array when it's
// passed multiple times (`id=1&id=2`) or a string when it's passed once.
// Always returns an Array (possibly empty).
function arrayParam(v) {
  if (v == null) { return []; }
  return Array.isArray(v) ? v : [v];
}

// Build a Subsonic Song object from a DB row. The query supplying `row` must
// include at minimum: t.id, t.filepath, t.title, t.track_number, t.disc_number,
// t.duration, t.format, t.file_size, t.bitrate, t.year,
// ${TRACK_PRIMARY_GENRE_SQL} (provides `genre` via the track_genres M2M
// correlated subquery — see the helper constant above),
// ${TRACK_GENRES_JSON_SQL} (provides `genres_json` for the OpenSubsonic
// `genres[]` array — optional, see emit-when-non-empty below),
// t.album_art_file, t.created_at, t.library_id, a.name AS artist_name,
// a.id AS artist_id, al.name AS album_name, al.id AS album_id.
//
// OpenSubsonic extended fields (sampleRate, channelCount, bitDepth,
// replayGain) are emitted when present — they require the query to also
// select t.sample_rate, t.channels, t.bit_depth, t.replaygain_track_db.
// Missing columns simply produce undefined entries that the XML/JSON
// renderer drops.
function songFromRow(row) {
  const suffix = suffixFor(row.filepath, row.format);
  const out = {
    id:          String(row.id),
    parent:      row.album_id != null ? encAlbum(row.album_id) : undefined,
    isDir:       false,
    title:       row.title || path.basename(row.filepath),
    album:       row.album_name || undefined,
    artist:      row.artist_name || undefined,
    track:       row.track_number || undefined,
    year:        row.year || undefined,
    genre:       row.genre || undefined,
    coverArt:    row.album_art_file ? (row.album_id != null ? encAlbum(row.album_id) : String(row.id)) : undefined,
    size:        row.file_size || undefined,
    contentType: contentTypeFor(suffix),
    suffix,
    duration:    row.duration != null ? Math.round(row.duration) : undefined,
    bitRate:     row.bitrate != null ? Math.round(row.bitrate / 1000) : undefined,
    path:        row.filepath,
    discNumber:  row.disc_number || undefined,
    created:     isoUtc(row.created_at),
    albumId:     row.album_id != null ? encAlbum(row.album_id) : undefined,
    artistId:    row.artist_id != null ? encArtist(row.artist_id) : undefined,
    type:        'music',
  };
  // OpenSubsonic optional fields — present only when the row carries them.
  if (row.sample_rate != null)          { out.samplingRate  = row.sample_rate; }
  if (row.channels != null)             { out.channelCount  = row.channels; }
  if (row.bit_depth != null)            { out.bitDepth      = row.bit_depth; }
  if (row.replaygain_track_db != null)  {
    // OpenSubsonic `replayGain` is a nested object; expose the track gain.
    // Album gain would need a second column — deferred.
    out.replayGain = { trackGain: row.replaygain_track_db };
  }
  // OpenSubsonic `genres[]` — full multi-genre list as
  // [{name: 'Rock'}, {name: 'Pop'}], ordered by tag-string position.
  // The legacy `genre` field above carries the primary (genres[0]);
  // the array gives clients that support OpenSubsonic the complete
  // set. Untagged tracks: TRACK_GENRES_JSON_SQL returns "[]" which
  // the helper treats as absent (matches the "no field in response"
  // convention).
  const genres = parseGenresJson(row.genres_json);
  if (genres) { out.genres = genres; }
  return out;
}

// ── System ──────────────────────────────────────────────────────────────────

export function ping(req, res) { sendOk(req, res); }

export function getLicense(req, res) {
  // Subsonic Premium licensing is a vestige; we always report valid.
  sendOk(req, res, {
    license: { valid: true, email: 'mstream@local', licenseExpires: '2099-12-31T00:00:00Z' },
  });
}

export function getMusicFolders(req, res) {
  const vpaths = req.user.vpaths || [];
  const libs = db.getAllLibraries().filter(l => vpaths.includes(l.name));
  sendOk(req, res, {
    musicFolders: {
      musicFolder: libs.map(l => ({ id: encFolder(l.id), name: l.name })),
    },
  });
}

// ── Browsing: artist/album/song ─────────────────────────────────────────────

// Helpful for A/B/C… indexing. Strips leading ignored articles.
function indexLetter(name) {
  if (!name) { return '#'; }
  const stripped = name.replace(new RegExp(`^(?:${IGNORED_ARTICLES.split(' ').join('|')})\\s+`, 'i'), '');
  const first = stripped.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

// V17: list every artist reachable via either track_artists OR
// album_artists, so "Various Artists" (compilation album-artist) shows
// up even though no track has it as its primary track-artist. Album
// count per artist = distinct albums where the artist appears on any
// role.
function getArtistsCore(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT a.id, a.name,
           COUNT(DISTINCT al.id) AS albumCount,
           MIN(al.album_art_file) AS coverArt
    FROM artists a
    JOIN (
      SELECT aa.artist_id AS artist_id, aa.album_id AS album_id
      FROM album_artists aa
      JOIN albums al ON al.id = aa.album_id
      JOIN tracks t  ON t.album_id = al.id
      WHERE ${clause}
      UNION
      SELECT ta.artist_id AS artist_id, t.album_id AS album_id
      FROM track_artists ta
      JOIN tracks t ON t.id = ta.track_id
      WHERE ${clause} AND t.album_id IS NOT NULL
    ) link ON link.artist_id = a.id
    JOIN albums al ON al.id = link.album_id
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE
  `).all(...params, ...params);
}

export function getArtists(req, res) {
  const artists = getArtistsCore(req);
  const buckets = new Map();
  for (const a of artists) {
    const letter = indexLetter(a.name);
    if (!buckets.has(letter)) { buckets.set(letter, []); }
    buckets.get(letter).push({
      id: encArtist(a.id),
      name: a.name,
      albumCount: a.albumCount,
      coverArt: a.coverArt ? encArtist(a.id) : undefined,
    });
  }
  const index = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));
  sendOk(req, res, {
    artists: { ignoredArticles: IGNORED_ARTICLES, index },
  });
}

// Legacy getIndexes — older clients use this instead of getArtists.
export function getIndexes(req, res) {
  const artists = getArtistsCore(req);
  const buckets = new Map();
  for (const a of artists) {
    const letter = indexLetter(a.name);
    if (!buckets.has(letter)) { buckets.set(letter, []); }
    buckets.get(letter).push({ id: encArtist(a.id), name: a.name });
  }
  const index = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));
  sendOk(req, res, {
    indexes: {
      ignoredArticles: IGNORED_ARTICLES,
      lastModified: Date.now(),
      index,
    },
  });
}

export function getArtist(req, res) {
  // Distinguish "param absent" (Subsonic error 10) from "param present
  // but doesn't decode to a known artist-shape ID" (Subsonic error 70 —
  // data not found). Conflating them as MISSING_PARAM was a regression
  // some clients react to badly: code 10 reads as "I sent a malformed
  // request, give up" while code 70 reads as "this entity went away,
  // refresh the cache". Caught by the cross-server conformance harness
  // diffing against Navidrome.
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);

  const artist = db.getDB().prepare('SELECT id, name FROM artists WHERE id = ?').get(id);
  if (!artist) { return SubErr.NOT_FOUND(req, res, 'Artist'); }

  // V17: include every album where this artist appears in any of:
  //   - albums.artist_id (primary album-artist, covers 95% case)
  //   - album_artists M2M (multi-artist ALBUMARTIST values)
  //   - track_artists M2M (compilation contributors, collab features)
  // A user clicking "Comp Artist A" expects to see the Various-Artists
  // compilation they're on, even though A isn't in album_artists.
  const albums = db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file AS coverArt,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           ${ALBUM_PRIMARY_GENRE_SQL}, ${ALBUM_GENRES_JSON_SQL}
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    WHERE (al.artist_id = ?
        OR al.id IN (SELECT album_id FROM album_artists WHERE artist_id = ?)
        OR al.id IN (SELECT t2.album_id FROM track_artists ta
                     JOIN tracks t2 ON t2.id = ta.track_id
                     WHERE ta.artist_id = ? AND t2.album_id IS NOT NULL))
      AND ${clause}
    GROUP BY al.id
    ORDER BY al.year, al.name COLLATE NOCASE
  `).all(id, id, id, ...params);

  const albumStars = albumStarMap(req.user.id, albums.map(a => a.id));
  const artistStars = artistStarMap(req.user.id, [artist.id]);

  sendOk(req, res, {
    artist: {
      id: encArtist(artist.id),
      name: artist.name,
      albumCount: albums.length,
      starred: artistStars.has(artist.id) ? isoUtc(artistStars.get(artist.id)) : undefined,
      album: albums.map(al => ({
        id:        encAlbum(al.id),
        parent:    encArtist(artist.id),
        isDir:     true,
        name:      al.name,
        title:     al.name,
        album:     al.name,
        artist:    artist.name,
        artistId:  encArtist(artist.id),
        year:      al.year || undefined,
        genre:     al.genre || undefined,
        // OpenSubsonic `genres[]` — DISTINCT names across the album's
        // tracks, ordered by when each genre first appeared in the
        // M2M (MIN(tg2.rowid)). Absent when the album is untagged.
        genres:    parseGenresJson(al.genres_json),
        coverArt:  al.coverArt ? encAlbum(al.id) : undefined,
        songCount: al.songCount,
        duration:  al.duration != null ? Math.round(al.duration) : undefined,
        created:   undefined,
        starred:   albumStars.has(al.id) ? isoUtc(albumStars.get(al.id)) : undefined,
      })),
    },
  });
}

export function getAlbum(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'album');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);

  const album = db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           al.album_artist, al.compilation,
           a.name AS artist_name
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    WHERE al.id = ?
  `).get(id);
  if (!album) { return SubErr.NOT_FOUND(req, res, 'Album'); }

  // V17: full M2M artist list for OpenSubsonic `artists[]` on the album.
  const albumArtists = db.getDB().prepare(`
    SELECT a.id, a.name
    FROM album_artists aa
    JOIN artists a ON a.id = aa.artist_id
    WHERE aa.album_id = ?
    ORDER BY aa.position, aa.role
  `).all(id).map(r => ({ id: encArtist(r.id), name: r.name }));

  const songs = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.album_id = ? AND ${clause}
    ORDER BY t.disc_number, t.track_number, t.title
  `).all(id, ...params);

  const albumStars = albumStarMap(req.user.id, [album.id]);

  sendOk(req, res, {
    album: {
      id:        encAlbum(album.id),
      name:      album.name,
      // Prefer the raw display string from the ALBUMARTIST tag — falls
      // back to the joined artist row name. So "Brian Eno & David Byrne"
      // stays as written even though the M2M splits into two artist rows.
      artist:    album.album_artist || album.artist_name || undefined,
      artistId:  album.artist_id != null ? encArtist(album.artist_id) : undefined,
      // OpenSubsonic extension — the full M2M list.
      artists:   albumArtists.length ? albumArtists : undefined,
      // OpenSubsonic spec: always emit as boolean (not undefined) so
      // clients that iterate album fields don't have to special-case the
      // missing-key shape.
      isCompilation: !!album.compilation,
      year:      album.year || undefined,
      coverArt:  album.album_art_file ? encAlbum(album.id) : undefined,
      songCount: songs.length,
      duration:  Math.round(songs.reduce((s, r) => s + (r.duration || 0), 0)),
      starred:   albumStars.has(album.id) ? isoUtc(albumStars.get(album.id)) : undefined,
      song:      enrichSongsWithUserMeta(req, songs.map(songFromRow)),
    },
  });
}

export function getSong(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const id = parsed.id;
  const { clause, params } = libraryScope(req);
  const row = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.id = ? AND ${clause}
  `).get(id, ...params);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const [song] = enrichSongsWithUserMeta(req, [songFromRow(row)]);
  sendOk(req, res, { song });
}

export function getGenres(req, res) {
  const { clause, params } = libraryScope(req);
  // V34: read from the track_genres M2M instead of the (now-dropped)
  // tracks.genre flat column. COUNT(DISTINCT t.id) is load-bearing —
  // a track tagged "Jazz, Fusion" appears as TWO rows in the join, and
  // a raw COUNT(*) would double-count it. Don't regress to COUNT(*).
  // Same applies to COUNT(DISTINCT t.album_id) — already DISTINCT in
  // the pre-V34 query, kept for the same reason.
  //
  // GROUP BY g.id (not g.name) gives stable identity even when case
  // variants exist in the genres table.
  const rows = db.getDB().prepare(`
    SELECT g.name AS value,
           COUNT(DISTINCT t.id) AS songCount,
           COUNT(DISTINCT t.album_id) AS albumCount
    FROM genres g
    JOIN track_genres tg ON tg.genre_id = g.id
    JOIN tracks t ON t.id = tg.track_id
    WHERE ${clause}
    GROUP BY g.id
    ORDER BY g.name COLLATE NOCASE
  `).all(...params);
  sendOk(req, res, { genres: { genre: rows } });
}

// getMusicDirectory is the pre-getArtists folder-style browse. The prefixed
// id tells us whether it's a music folder (mf-N), artist (ar-N) or album
// (al-N) — bare numerics are song ids, which can't be drilled into.
export function getMusicDirectory(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.NOT_FOUND(req, res); }
  const n = parsed.id;

  if (parsed.type === 'folder') {
    const lib = db.getAllLibraries().find(l => l.id === n && req.user.vpaths.includes(l.name));
    if (!lib) { return SubErr.NOT_FOUND(req, res); }
    // Library "folder": list its artists as children.
    const { clause, params } = libraryScope(req);
    const artists = db.getDB().prepare(`
      SELECT a.id, a.name
      FROM artists a
      JOIN albums al ON al.artist_id = a.id
      JOIN tracks t  ON t.album_id = al.id
      WHERE ${clause}
      GROUP BY a.id
      ORDER BY a.name COLLATE NOCASE
    `).all(...params);
    return sendOk(req, res, {
      directory: {
        id:    encFolder(n),
        name:  lib.name,
        child: artists.map(a => ({
          id:     encArtist(a.id),
          parent: encFolder(n),
          isDir:  true,
          title:  a.name,
          name:   a.name,
        })),
      },
    });
  }

  if (parsed.type === 'artist') {
    const artist = db.getDB().prepare('SELECT id, name FROM artists WHERE id = ?').get(n);
    if (!artist) { return SubErr.NOT_FOUND(req, res); }
    // Reuse getArtist logic but as getMusicDirectory shape.
    const { clause, params } = libraryScope(req);
    const albums = db.getDB().prepare(`
      SELECT al.id, al.name, al.year, al.album_art_file AS coverArt,
             COUNT(t.id) AS songCount, SUM(t.duration) AS duration
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      WHERE al.artist_id = ? AND ${clause}
      GROUP BY al.id
      ORDER BY al.year, al.name COLLATE NOCASE
    `).all(artist.id, ...params);
    return sendOk(req, res, {
      directory: {
        id:    encArtist(artist.id),
        name:  artist.name,
        child: albums.map(al => ({
          id:       encAlbum(al.id),
          parent:   encArtist(artist.id),
          isDir:    true,
          title:    al.name,
          album:    al.name,
          artist:   artist.name,
          artistId: encArtist(artist.id),
          year:     al.year || undefined,
          coverArt: al.coverArt ? encAlbum(al.id) : undefined,
        })),
      },
    });
  }

  if (parsed.type === 'album') {
    const album = db.getDB().prepare(`
      SELECT al.id, al.name, a.name AS artist_name, al.artist_id
      FROM albums al LEFT JOIN artists a ON a.id = al.artist_id WHERE al.id = ?
    `).get(n);
    if (!album) { return SubErr.NOT_FOUND(req, res); }
    const { clause, params } = libraryScope(req);
    const songs = db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
             t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
             t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
             a.id AS artist_id, a.name AS artist_name,
             al.id AS album_id, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      LEFT JOIN albums  al ON al.id = t.album_id
      WHERE t.album_id = ? AND ${clause}
      ORDER BY t.disc_number, t.track_number, t.title
    `).all(album.id, ...params);
    return sendOk(req, res, {
      directory: {
        id:     encAlbum(album.id),
        parent: album.artist_id != null ? encArtist(album.artist_id) : undefined,
        name:   album.name,
        child:  enrichSongsWithUserMeta(req, songs.map(songFromRow)),
      },
    });
  }

  SubErr.NOT_FOUND(req, res);
}

// ── Media: cover art, stream, download ──────────────────────────────────────

// getCoverArt — accepts any of: song (bare numeric), album (al-N), artist
// (ar-N). Delegates to the shared album-art handler for byte serving.
export function getCoverArt(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id);
  // Binary endpoint: replace the prior `res.status(400).end()` with a
  // proper Subsonic error envelope so clients can distinguish "you
  // gave me garbage" from "I crashed". Matches what every other
  // mStream Subsonic handler already does post the PR #592 cleanup.
  if (!parsed) { return SubErr.NOT_FOUND(req, res); }
  const size = parseInt(req.query.size, 10);

  const d = db.getDB();
  let artFile = null;
  if (parsed.type === 'song') {
    artFile = d.prepare('SELECT album_art_file FROM tracks WHERE id = ?').get(parsed.id)?.album_art_file;
  } else if (parsed.type === 'album') {
    artFile = d.prepare('SELECT album_art_file FROM albums WHERE id = ?').get(parsed.id)?.album_art_file
      || d.prepare('SELECT MIN(album_art_file) AS a FROM tracks WHERE album_id = ?').get(parsed.id)?.a;
  } else if (parsed.type === 'artist') {
    artFile = d.prepare(
      'SELECT MIN(album_art_file) AS a FROM tracks WHERE artist_id = ? AND album_art_file IS NOT NULL'
    ).get(parsed.id)?.a;
  }
  if (!artFile) { return res.status(404).end(); }

  // Delegate to serveAlbumArtFile using a synthesized req/res. Clients pass
  // pixel sizes; we have `s` (92px) and `l` (256px) cache variants.
  req.params = { file: artFile };
  if (Number.isFinite(size) && size <= 120) { req.query.compress = 's'; }
  else if (Number.isFinite(size) && size <= 300) { req.query.compress = 'l'; }
  return serveAlbumArtFile(req, res);
}

function resolveTrackForPlayback(req, id) {
  const { clause, params } = libraryScope(req);
  const row = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.format, t.bitrate, t.duration, t.library_id
    FROM tracks t
    WHERE t.id = ? AND ${clause}
  `).get(id, ...params);
  if (!row) { return null; }
  const lib = db.getAllLibraries().find(l => l.id === row.library_id);
  if (!lib) { return null; }
  const absPath = path.resolve(path.join(lib.root_path, row.filepath));
  const rootResolved = path.resolve(lib.root_path);
  if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) { return null; }
  return { row, lib, absPath };
}

const TRANSCODE_CODECS = {
  mp3:  { args: ['-c:a', 'libmp3lame'], mime: 'audio/mpeg', suffix: 'mp3',  format: 'mp3' },
  opus: { args: ['-c:a', 'libopus'],    mime: 'audio/ogg',  suffix: 'opus', format: 'ogg' },
  aac:  { args: ['-c:a', 'aac'],        mime: 'audio/mp4',  suffix: 'aac',  format: 'adts' },
};

function streamNative(req, res, track) {
  if (!fs.existsSync(track.absPath)) { return res.status(404).end(); }
  if (req.method === 'HEAD') {
    try {
      const st = fs.statSync(track.absPath);
      const suffix = suffixFor(track.row.filepath, track.row.format);
      res.status(200).set({
        'Content-Type':   contentTypeFor(suffix),
        'Content-Length': String(st.size),
        'Accept-Ranges':  'bytes',
      }).end();
    } catch { res.status(404).end(); }
    return;
  }
  res.sendFile(track.absPath, { dotfiles: 'allow' });
}

function streamTranscoded(req, res, track, codec, bitrateK, timeOffsetSec, estimateContentLength) {
  const spec = TRANSCODE_CODECS[codec];
  const args = ['-nostdin'];
  // `-ss` before `-i` uses input-seek (fast, keyframe-aligned) — good enough
  // for lossy sources where sample-accurate seek doesn't matter. ffmpeg
  // accepts fractional seconds, so keep the raw value — just clamp to a
  // safe precision.
  if (Number.isFinite(timeOffsetSec) && timeOffsetSec > 0) {
    args.push('-ss', timeOffsetSec.toFixed(3));
  }
  args.push(
    '-i', track.absPath,
    '-vn', ...spec.args, '-b:a', `${bitrateK}k`,
    '-f', spec.format, '-loglevel', 'error',
    '-',
  );

  // Send headers first. If the caller asked for an estimate, compute one from
  // the remaining duration × bitrate so clients that require Content-Length
  // (e.g. Ultrasonic) can populate their seek bar.
  const headers = {
    'Content-Type': spec.mime,
    'transferMode.dlna.org': 'Streaming',
    'Connection': 'close',
  };
  if (estimateContentLength && Number.isFinite(track.row.duration)) {
    const remaining = Math.max(0, track.row.duration - (timeOffsetSec || 0));
    headers['Content-Length'] = String(Math.floor((remaining * bitrateK * 1000) / 8));
  }

  if (req.method === 'HEAD') {
    // Don't spawn ffmpeg for a probe — headers-only response is the contract.
    res.status(200).set(headers).end();
    return;
  }

  // ffmpeg may not have resolved (download failed, no system binary). Without
  // this, spawn(ffmpegBin()=null) throws a generic TypeError caught as a 500;
  // a 503 is the honest "unavailable" signal, matching the DLNA/waveform paths.
  if (!getResolvedSource()) {
    winston.warn('[subsonic] stream: ffmpeg unavailable');
    return res.status(503).end();
  }

  let ff;
  try { ff = spawn(ffmpegBin(), args); }
  catch (err) {
    winston.error('[subsonic] stream: ffmpeg spawn failed', { stack: err });
    return res.status(500).end();
  }
  // spawn() returns an object even for paths that don't exist on disk —
  // the ENOENT surfaces on the 'error' event. If that fires before we
  // write headers, respond with 500 so the caller knows something broke
  // rather than receiving a silent 0-byte 200.
  let headersSent = false;
  ff.once('error', err => {
    winston.error('[subsonic] ffmpeg error', { stack: err });
    if (!headersSent && !res.headersSent) {
      try { res.status(500).end(); } catch { /* already closed */ }
    } else {
      try { res.end(); } catch { /* already closed */ }
    }
  });
  res.status(200).set(headers);
  headersSent = true;
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => winston.debug(`[subsonic stream] ${d.toString().trim()}`));
  const cleanup = () => { try { ff.kill('SIGKILL'); } catch { /* exited */ } };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export function stream(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const track = resolveTrackForPlayback(req, parsed.id);
  if (!track) { return res.status(404).end(); }

  // Register now-playing so getNowPlaying can surface it. HEAD is a probe,
  // not real playback — skip registration. The handle-based unregister
  // protects against a slow-closing old stream from wiping a newer one out
  // of the map when the same user has overlapping playbacks.
  if (req.method !== 'HEAD') {
    try {
      const handle = nowPlaying.register(req.user.id, req.user.username, track.row.id);
      const off = () => nowPlaying.unregister(handle);
      req.on('close', off);
      res.on('close', off);
    } catch { /* non-fatal */ }
  }

  const requestedFormat = (req.query.format || '').toLowerCase();
  // Subsonic spec: "If set to zero, no limit is imposed" — clients (DSub,
  // Symfonium) routinely send maxBitRate=0 meaning unlimited. Pre-validation
  // a 0 counted as a real limit, forcing a needless transcode of every track
  // with a known bitrate (no native streaming, no Range support, wasted CPU —
  // encoders treat `-b:a 0k` as "pick a default") and, with
  // estimateContentLength, advertising `Content-Length: 0` for a non-empty
  // body. Non-numeric and negative values also mean "no limit"; real values
  // are clamped to the encoders' workable range — libopus hard-fails on
  // absurd ones (`-b:a 999999k` → encoder init error → empty 200).
  const rawMaxBitRate = parseInt(req.query.maxBitRate, 10);
  const maxBitRateK = Number.isFinite(rawMaxBitRate) && rawMaxBitRate > 0
    ? Math.min(320, Math.max(32, rawMaxBitRate))
    : null;
  const timeOffset = parseFloat(req.query.timeOffset);
  const estimateContentLength = req.query.estimateContentLength === 'true';
  const nativeFormat = (track.row.format || '').toLowerCase();
  const nativeBitRateK = track.row.bitrate ? Math.round(track.row.bitrate / 1000) : null;

  // Native streaming only works when no seek was requested — ffmpeg is needed
  // to shift the start offset mid-stream.
  const wantsNative =
    !requestedFormat || requestedFormat === 'raw' || requestedFormat === nativeFormat;
  const bitrateOk = !maxBitRateK || !nativeBitRateK || nativeBitRateK <= maxBitRateK;
  const seekRequested = Number.isFinite(timeOffset) && timeOffset > 0;
  if (wantsNative && bitrateOk && !seekRequested) {
    return streamNative(req, res, track);
  }

  // Pick a codec. Prefer the requested one if supported; otherwise fall back
  // to the server default.
  const codec = TRANSCODE_CODECS[requestedFormat]
    ? requestedFormat
    : config.program.transcode.defaultCodec;
  const bitrateK = maxBitRateK ?? parseInt(config.program.transcode.defaultBitrate, 10);
  streamTranscoded(req, res, track, codec, bitrateK, timeOffset, estimateContentLength);
}

export function download(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const track = resolveTrackForPlayback(req, parsed.id);
  if (!track) { return res.status(404).end(); }
  if (!fs.existsSync(track.absPath)) { return res.status(404).end(); }
  res.sendFile(track.absPath, { dotfiles: 'allow' });
}

// ── Search ──────────────────────────────────────────────────────────────────
//
// Subsonic endpoints internally use the `combo` algorithm (FTS5 primary
// with per-category LIKE fallback). The strict `fts5` mode and the
// `algorithm` request param are webapp-only — Subsonic clients send a
// fixed param set and want results, not pedantry. If FTS5 isn't compiled
// in, the same global override (db.FTS5_AVAILABLE) demotes Subsonic
// search to LIKE-only.

function normalizeQueryFragment(q) {
  // SQL wildcards (% _) survived from the pre-FTS5 era when the search
  // path was straight LIKE — stripping them prevented users from
  // injecting wildcards into the LIKE pattern. Even though FTS5 doesn't
  // honour those characters, the LIKE fallback for combo mode still
  // does, so we keep the strip. Lowercase is harmless: unicode61
  // tokenizes case-insensitively. We DO NOT strip * or " here any more
  // — buildFtsExpression handles them safely via escapeFts, and the FTS
  // parser's syntax doesn't expose them to user input directly.
  return String(q || '').trim().replace(/[%_]/g, '').toLowerCase();
}

// Latch + log so a misconfigured server (FTS5 not compiled in) doesn't
// spam the warning stream on every search request. The boot-time ERROR
// in db/manager.js fires once at startup; this is the runtime echo for
// operators tailing logs.
let _fts5UnavailableLoggedSubsonic = false;
function _logFts5UnavailableOnceSubsonic() {
  if (_fts5UnavailableLoggedSubsonic) return;
  _fts5UnavailableLoggedSubsonic = true;
  winston.warn(
    '[subsonic-search] FTS5 not available — Subsonic search downgraded to LIKE for this process.'
  );
}

// Per-category combo-mode runner: try the FTS5 path, fall back to the
// LIKE path on parse failure (builder returned null) or SQLITE_ERROR.
// Same semantics as runCategory in src/api/db.js but lives here because
// the Subsonic SELECTs use a different column set (DB ids, full track
// rows for songFromRow).
function _subsonicCategory(name, ftsBuilder, likeBuilder) {
  let rows;
  try {
    rows = ftsBuilder();
  } catch (err) {
    if (err?.code !== 'ERR_SQLITE_ERROR') throw err;
    winston.debug(`[subsonic-search] ${name} fell back to LIKE on MATCH error: ${err.message}`);
    return likeBuilder();
  }
  if (rows === null) return likeBuilder();
  return rows;
}

// Resolve the optional musicFolderId param into a scope clause + params.
// Returns null when the param refers to a folder the user can't see
// (caller treats that as an empty payload, matching pre-PR3 behaviour).
function _searchScope(req) {
  const { clause, params } = libraryScope(req);
  const folder = decodeId(req.query.musicFolderId, 'folder');
  if (!folder) return { clause, params: [...params] };
  if (!req.user.vpaths.some(name => db.getAllLibraries().some(l => l.id === folder.id && l.name === name))) {
    return null;
  }
  return { clause: `${clause} AND t.library_id = ?`, params: [...params, folder.id] };
}

// Parse a Subsonic count/offset query param. `parseInt(x, 10) || N` is
// NOT a valid "default if absent" idiom: the `||` swallows a legitimate
// `0` and substitutes the default. For count params (artistCount,
// albumCount, songCount) `0` is a meaningful "return zero of these"
// signal — Navidrome and other reference servers respect it — so we
// need an explicit NaN check.
function parseCount(value, defaultValue) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

// Empty-query OpenSubsonic listing — search3 only. Returns the same
// {artist, album, song} payload shape buildSearchPayload produces for a
// non-empty query, just with name-ordered rows and no MATCH involved.
// The spec says "A blank query will return everything"; we paginate
// via the existing artistCount/albumCount/songCount/Offset params.
function _buildEmptyListingPayload(req) {
  const artistCount  = parseCount(req.query.artistCount,  20);
  const albumCount   = parseCount(req.query.albumCount,   20);
  const songCount    = parseCount(req.query.songCount,    20);
  const artistOffset = parseCount(req.query.artistOffset,  0);
  const albumOffset  = parseCount(req.query.albumOffset,   0);
  const songOffset   = parseCount(req.query.songOffset,    0);

  const scope = _searchScope(req);
  if (!scope) return { empty: true };

  const d = db.getDB();
  // ── Widening parity with buildSearchPayload's populated query ────────
  //
  // Use the same V17/V18 widening as the populated path: an artist
  // surfaces here iff they have at least one row in track_artists OR
  // album_artists scoped to a track the user can see. We INTENTIONALLY
  // do NOT add a third OR-clause against `tracks.artist_id` directly —
  // that would let an artist seeded only as a primary FK (no
  // track_artists row) appear in the empty listing while staying
  // invisible to named search3?query=... requests, which is the kind
  // of asymmetry that drove the PR3 audit. The scanner is the source
  // of truth and always writes a 'main' track_artists row for every
  // track's primary artist, so any path that bypasses that invariant
  // (DB-direct bulk import, hand-edits) gets the same "invisible
  // artist" behaviour on both surfaces — easier to diagnose than two
  // surfaces disagreeing about the library's contents.
  //
  // Qualify artist_id in each subquery: track_artists and album_artists
  // and tracks all have an artist_id column, so SQLite errors with
  // "ambiguous column name: artist_id" if the qualifier is dropped.
  const artists = d.prepare(`
    SELECT DISTINCT a.id, a.name
    FROM artists a
    WHERE a.id IN (SELECT ta.artist_id FROM track_artists ta JOIN tracks t ON t.id = ta.track_id WHERE ${scope.clause})
       OR a.id IN (SELECT aa.artist_id FROM album_artists aa JOIN albums al ON al.id = aa.album_id JOIN tracks t ON t.album_id = al.id WHERE ${scope.clause})
    ORDER BY a.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...scope.params, ...scope.params, artistCount, artistOffset);

  const albums = d.prepare(`
    SELECT DISTINCT al.id, al.name, al.year, al.album_art_file, al.artist_id,
                    a.name AS artist_name
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    WHERE ${scope.clause}
    GROUP BY al.id
    ORDER BY al.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...scope.params, albumCount, albumOffset);

  const songs = d.prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${scope.clause}
    ORDER BY t.title COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...scope.params, songCount, songOffset);

  return _shapePayload(req, artists, albums, songs);
}

// Final payload assembly — shared by both the populated-query and the
// empty-query OpenSubsonic listing paths. Encodes IDs and runs songs
// through the user-meta enrichment used elsewhere in this file.
function _shapePayload(req, artists, albums, songs) {
  return {
    artist: artists.map(a => ({
      id: encArtist(a.id), name: a.name, coverArt: encArtist(a.id),
    })),
    album: albums.map(al => ({
      id:       encAlbum(al.id),
      name:     al.name,
      title:    al.name,
      artist:   al.artist_name || undefined,
      artistId: al.artist_id != null ? encArtist(al.artist_id) : undefined,
      year:     al.year || undefined,
      coverArt: al.album_art_file ? encAlbum(al.id) : undefined,
    })),
    song: enrichSongsWithUserMeta(req, songs.map(songFromRow)),
  };
}

// Core search — shared by search2 and search3. Returns the assembled
// {artist, album, song} payload; callers wrap it in the envelope name
// their spec variant wants (searchResult2 vs searchResult3). Clients
// dispatch on that wrapper name, so emitting the wrong one makes
// results invisible to the caller — search2 used to forward to
// search3 and returned a searchResult3 envelope that older clients
// (DSub, Subsonic 6.x desktop, Airsonic classic) silently ignored.
//
// `listOnEmpty=true` (passed by search3) honours the OpenSubsonic
// "blank query returns everything" convention and routes empty queries
// through _buildEmptyListingPayload. search2 and search (v1) preserve
// pre-PR3 behaviour: empty query → empty envelope.
function buildSearchPayload(req, { listOnEmpty = false } = {}) {
  const q = normalizeQueryFragment(req.query.query);
  const artistCount  = parseCount(req.query.artistCount,  20);
  const albumCount   = parseCount(req.query.albumCount,   20);
  const songCount    = parseCount(req.query.songCount,    20);
  const artistOffset = parseCount(req.query.artistOffset,  0);
  const albumOffset  = parseCount(req.query.albumOffset,   0);
  const songOffset   = parseCount(req.query.songOffset,    0);

  if (!q) {
    return listOnEmpty ? _buildEmptyListingPayload(req) : { empty: true };
  }

  const scope = _searchScope(req);
  if (!scope) return { empty: true };

  // FTS5 availability override: if SQLite wasn't compiled with FTS5,
  // the fts_* tables don't exist and any MATCH would 500. Fall through
  // to the LIKE path for the entire request. Same latch model as the
  // webapp route in src/api/db.js.
  if (!db.FTS5_AVAILABLE) {
    _logFts5UnavailableOnceSubsonic();
    return _shapePayload(req,
      _likeArtistsRowsSubsonic(scope, q, artistCount, artistOffset),
      _likeAlbumsRowsSubsonic(scope, q, albumCount, albumOffset),
      _likeSongsRowsSubsonic(scope, q, songCount, songOffset),
    );
  }

  const parsed = parseSearchQuery(q);

  // Per-category combo runners. Each FTS builder may return null
  // (parse-time refusal) or throw SQLITE_ERROR (a query that survived
  // the JS parser but tripped FTS5 syntax); _subsonicCategory falls back
  // to LIKE in either case. BM25 ranks results within each category.
  const artists = _subsonicCategory('artists',
    () => _ftsArtistsRowsSubsonic(scope, parsed, artistCount, artistOffset),
    () => _likeArtistsRowsSubsonic(scope, q, artistCount, artistOffset),
  );
  const albums = _subsonicCategory('albums',
    () => _ftsAlbumsRowsSubsonic(scope, parsed, albumCount, albumOffset),
    () => _likeAlbumsRowsSubsonic(scope, q, albumCount, albumOffset),
  );
  const songs = _subsonicCategory('songs',
    () => _ftsSongsRowsSubsonic(scope, parsed, songCount, songOffset),
    () => _likeSongsRowsSubsonic(scope, q, songCount, songOffset),
  );

  return _shapePayload(req, artists, albums, songs);
}

// ── Subsonic-side FTS5 builders ─────────────────────────────────────────────
//
// Distinct from the webapp builders in src/api/db.js because Subsonic
// needs DB ids (a.id, al.id, full track row for songFromRow) instead of
// the slim envelope columns the webapp uses.
//
// The artist match preserves the V18 M2M-aware widening so featured
// track collaborators and compilation album-artists surface even when
// they're not the primary artist_id on any track. FTS5 narrows the
// candidate artists; the M2M IN-clauses then filter to the user's
// visible library set.

function _ftsArtistsRowsSubsonic(scope, parsed, limit, offset) {
  const expr = buildFtsExpression({
    column: 'name',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  const d = db.getDB();
  // fts_artists is the driving table so SQLite uses the FTS5 index scan
  // and we can ORDER BY rank (BM25) cheaply. The widening IN-clauses
  // are existence checks against scoped tracks, mirroring the pre-PR3
  // V17/V18 SQL.
  return d.prepare(`
    SELECT a.id, a.name
    FROM fts_artists fa
    JOIN artists a ON a.id = fa.rowid
    WHERE fa.fts_artists MATCH ?
      AND (
        a.id IN (SELECT aa.artist_id FROM album_artists aa
                 JOIN albums al ON al.id = aa.album_id
                 JOIN tracks t  ON t.album_id = al.id
                 WHERE ${scope.clause})
        OR a.id IN (SELECT ta.artist_id FROM track_artists ta
                    JOIN tracks t ON t.id = ta.track_id
                    WHERE ${scope.clause})
      )
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).all(expr, ...scope.params, ...scope.params, limit, offset);
}

function _ftsAlbumsRowsSubsonic(scope, parsed, limit, offset) {
  const expr = buildFtsExpression({
    column: 'name',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  const d = db.getDB();
  return d.prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name
    FROM fts_albums fa
    JOIN albums al ON al.id = fa.rowid
    LEFT JOIN artists a ON a.id = al.artist_id
    WHERE fa.fts_albums MATCH ?
      AND al.id IN (SELECT t.album_id FROM tracks t WHERE ${scope.clause} AND t.album_id IS NOT NULL)
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).all(expr, ...scope.params, limit, offset);
}

// Song match scopes to fts_tracks.{title}. The cross-field denormalised
// columns (artist_name, album_name) are also indexed by V31; we could
// expose an unscoped multi-word search here, but the per-category UI
// in Subsonic clients (artists tab + songs tab + albums tab) means
// users expect "songs" results to be title-keyed. Cross-field smart
// search lands in PR3's webapp /api/v1/db/search instead.
function _ftsSongsRowsSubsonic(scope, parsed, limit, offset) {
  const expr = buildFtsExpression({
    column: 'title',
    positive: parsed.positive,
    negative: parsed.negative,
  });
  if (expr === null) return null;
  const d = db.getDB();
  return d.prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM fts_tracks ft
    JOIN tracks t ON t.id = ft.rowid
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ft.fts_tracks MATCH ?
      AND ${scope.clause}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).all(expr, ...scope.params, limit, offset);
}

// ── Subsonic-side LIKE builders (fallback path) ─────────────────────────────
//
// Used when:
//   - FTS5 isn't compiled in (process-wide fallback).
//   - A per-category MATCH threw SQLITE_ERROR or refused to parse.
// Same SQL the pre-PR3 buildSearchPayload used inline; preserved
// verbatim including the V18 M2M widening on the artists query.

function _likeArtistsRowsSubsonic(scope, q, limit, offset) {
  const like = `%${q}%`;
  const d = db.getDB();
  return d.prepare(`
    SELECT DISTINCT a.id, a.name
    FROM artists a
    WHERE LOWER(a.name) LIKE ?
      AND (
        a.id IN (SELECT aa.artist_id FROM album_artists aa
                 JOIN albums al ON al.id = aa.album_id
                 JOIN tracks t  ON t.album_id = al.id
                 WHERE ${scope.clause})
        OR a.id IN (SELECT ta.artist_id FROM track_artists ta
                    JOIN tracks t ON t.id = ta.track_id
                    WHERE ${scope.clause})
      )
    ORDER BY a.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(like, ...scope.params, ...scope.params, limit, offset);
}

function _likeAlbumsRowsSubsonic(scope, q, limit, offset) {
  const like = `%${q}%`;
  const d = db.getDB();
  return d.prepare(`
    SELECT DISTINCT al.id, al.name, al.year, al.album_art_file, al.artist_id,
                    a.name AS artist_name
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    WHERE ${scope.clause} AND LOWER(al.name) LIKE ?
    GROUP BY al.id
    ORDER BY al.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...scope.params, like, limit, offset);
}

function _likeSongsRowsSubsonic(scope, q, limit, offset) {
  const like = `%${q}%`;
  const d = db.getDB();
  return d.prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${scope.clause} AND LOWER(t.title) LIKE ?
    ORDER BY t.title COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...scope.params, like, limit, offset);
}

export function search3(req, res) {
  // OpenSubsonic spec: blank query returns everything (paginated).
  const p = buildSearchPayload(req, { listOnEmpty: true });
  sendOk(req, res, { searchResult3: p.empty ? {} : p });
}

// search2 shares the payload shape with search3 but clients dispatch on
// the wrapper name — returning `searchResult3` here makes search2
// responses invisible to the caller. Every remaining search2 user
// (DSub, older Airsonic/Subsonic desktop, Jamstash) will accept the
// search3 artist shape (id/name/coverArt) inside a searchResult2 wrapper.
//
// Pre-PR3 behaviour preserved: blank query returns the empty envelope,
// not the OpenSubsonic listing — the listing semantics are search3-only.
export function search2(req, res) {
  const p = buildSearchPayload(req);
  sendOk(req, res, { searchResult2: p.empty ? {} : p });
}

// search (v1, Subsonic 1.0): different query shape entirely — `any`
// instead of `query`, plus a completely different response envelope
// with a flat `match` array of song-like entries. Modern clients never
// call this; we forward to search3 so at least the OPEN-SUBSONIC auth
// path keeps working if some ancient client probes it.
export function search(req, res)  { search3(req, res); }

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 — scrobble, favourites, playlists, album lists
// ════════════════════════════════════════════════════════════════════════════

// ── Scrobble ────────────────────────────────────────────────────────────────

// Subsonic `scrobble` is called in two modes:
//   submission=false → "now playing" (we're about to/just started playing)
//   submission=true  → "completed play" (update stats)
// We only increment counts on submission=true.
export function scrobble(req, res) {
  // Spec: both `id` and `time` are repeatable for bulk scrobble. When
  // `time` is shorter than `id` (or missing entirely), unmatched entries
  // fall back to "now". submission=false is the "now playing" hint and
  // never bumps play counts.
  const rawIds = arrayParam(req.query.id);
  if (!rawIds.length) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const songIds = rawIds.map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  // All ids were present but none decoded to an mStream song — same
  // distinction we make in getArtist/getAlbum/etc (param present but
  // not found vs param absent).
  if (!songIds.length) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  const times = arrayParam(req.query.time).map(v => parseInt(v, 10));
  const submission = req.query.submission !== 'false';

  // submission=false (now-playing): Subsonic spec says a scrobble without
  // submission shouldn't register more than one track. We honour the
  // last id in the list (matching the fork behaviour documented in the
  // spec's "reference implementation").
  if (!submission) {
    const lastId = songIds[songIds.length - 1];
    nowPlaying.register(req.user.id, req.user.username, lastId);
    return sendOk(req, res);
  }

  const d = db.getDB();
  const insert = d.prepare('INSERT OR IGNORE INTO user_metadata (user_id, track_hash) VALUES (?, ?)');
  const update = d.prepare(`
    UPDATE user_metadata
    SET play_count = COALESCE(play_count, 0) + 1,
        last_played = COALESCE(?, datetime('now'))
    WHERE user_id = ? AND track_hash = ?
  `);

  // Resolve every id's hash in one query, then record the plays in a single
  // transaction (one fsync for the whole batch instead of one per track).
  const hashById = trackHashesByIds(songIds);
  let anyResolved = false;
  db.transaction(() => {
    for (let i = 0; i < songIds.length; i++) {
      const hr = hashById.get(songIds[i]);
      const hash = hr && (hr.audio_hash || hr.file_hash);
      if (!hash) { continue; }
      anyResolved = true;
      const ms = times[i];
      const when = Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null;
      insert.run(req.user.id, hash);
      update.run(when, req.user.id, hash);
    }
  });

  // If EVERY id was unresolvable, return 70 Not Found (songIds is non-empty
  // here — guarded above). A mixed batch still returns ok — clients get the
  // successfully-recorded ones.
  if (!anyResolved) {
    return SubErr.NOT_FOUND(req, res, 'Song');
  }
  sendOk(req, res);
}

// ── Star / unstar / setRating / getStarred{,2} ─────────────────────────────

// Starring is per-user and tracked in three tables:
//
//   user_metadata.starred_at  — song stars (set alongside ratings)
//   user_album_stars          — album stars
//   user_artist_stars         — artist stars
//
// Earlier phases synthesised album/artist stars by flagging every child track,
// which lost information (unstarring a track unstarred "the album"). Phase 3
// stores each grain independently.

function collectIds(req) {
  return {
    songIds:   arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite),
    albumIds:  arrayParam(req.query.albumId).map(v => decodeId(v, 'album')?.id).filter(Number.isFinite),
    artistIds: arrayParam(req.query.artistId).map(v => decodeId(v, 'artist')?.id).filter(Number.isFinite),
  };
}

// Song stars resolve each id's canonical hash (batched) then upsert
// user_metadata; album/artist stars write directly by id. Each helper batches
// its writes into one transaction (one fsync for a "star all" of N items).
function starSongs(userId, songIds) {
  if (!songIds.length) { return; }
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const hashById = trackHashesByIds(songIds);
  db.transaction(() => {
    for (const id of songIds) {
      const hr = hashById.get(id);
      const hash = hr && (hr.audio_hash || hr.file_hash);
      if (hash) { upsertUserMeta(userId, hash, { starred_at: nowIso }); }
    }
  });
}
function unstarSongs(userId, songIds) {
  if (!songIds.length) { return; }
  const hashById = trackHashesByIds(songIds);
  // UPDATE-only (no upsert): un-starring a never-starred song must not
  // mint an all-null user_metadata row — those are dead weight no
  // reader can use (V52 swept the legacy ones).
  const stmt = db.getDB().prepare(
    'UPDATE user_metadata SET starred_at = NULL WHERE user_id = ? AND track_hash = ?'
  );
  db.transaction(() => {
    for (const id of songIds) {
      const hr = hashById.get(id);
      const hash = hr && (hr.audio_hash || hr.file_hash);
      if (hash) { stmt.run(userId, hash); }
    }
  });
}
function starAlbums(userId, albumIds) {
  if (!albumIds.length) { return; }
  const stmt = db.getDB().prepare(
    `INSERT INTO user_album_stars (user_id, album_id) VALUES (?, ?)
     ON CONFLICT(user_id, album_id) DO UPDATE SET starred_at = datetime('now')`
  );
  db.transaction(() => { for (const id of albumIds) { stmt.run(userId, id); } });
}
function unstarAlbums(userId, albumIds) {
  if (!albumIds.length) { return; }
  const stmt = db.getDB().prepare('DELETE FROM user_album_stars WHERE user_id = ? AND album_id = ?');
  db.transaction(() => { for (const id of albumIds) { stmt.run(userId, id); } });
}
function starArtists(userId, artistIds) {
  if (!artistIds.length) { return; }
  const stmt = db.getDB().prepare(
    `INSERT INTO user_artist_stars (user_id, artist_id) VALUES (?, ?)
     ON CONFLICT(user_id, artist_id) DO UPDATE SET starred_at = datetime('now')`
  );
  db.transaction(() => { for (const id of artistIds) { stmt.run(userId, id); } });
}
function unstarArtists(userId, artistIds) {
  if (!artistIds.length) { return; }
  const stmt = db.getDB().prepare('DELETE FROM user_artist_stars WHERE user_id = ? AND artist_id = ?');
  db.transaction(() => { for (const id of artistIds) { stmt.run(userId, id); } });
}

// Returns true iff none of the id-shaped query params (id / albumId /
// artistId) were present at all. Used by star/unstar to distinguish
// "client called us with no ids" (MISSING_PARAM) from "client gave
// us ids but none decoded" (NOT_FOUND).
function noIdParamsPresent(req) {
  return !arrayParam(req.query.id).length
      && !arrayParam(req.query.albumId).length
      && !arrayParam(req.query.artistId).length;
}

export function star(req, res) {
  if (noIdParamsPresent(req)) {
    return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId');
  }
  const { songIds, albumIds, artistIds } = collectIds(req);
  if (!songIds.length && !albumIds.length && !artistIds.length) {
    // Every id we got was undecodable.
    return SubErr.NOT_FOUND(req, res);
  }
  starSongs(req.user.id, songIds);
  starAlbums(req.user.id, albumIds);
  starArtists(req.user.id, artistIds);
  sendOk(req, res);
}

export function unstar(req, res) {
  if (noIdParamsPresent(req)) {
    return SubErr.MISSING_PARAM(req, res, 'id / albumId / artistId');
  }
  const { songIds, albumIds, artistIds } = collectIds(req);
  if (!songIds.length && !albumIds.length && !artistIds.length) {
    return SubErr.NOT_FOUND(req, res);
  }
  unstarSongs(req.user.id, songIds);
  unstarAlbums(req.user.id, albumIds);
  unstarArtists(req.user.id, artistIds);
  sendOk(req, res);
}

export function setRating(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const rating = parseInt(req.query.rating, 10);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    // Subsonic spec says rating must be 0..5; a value outside that range
    // is a missing/invalid parameter (code 10) rather than a server error (0).
    return SubErr.GENERIC_CODE(req, res, 10, 'rating must be 0..5');
  }
  const hash = trackFileHash(parsed.id);
  if (!hash) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  upsertUserMeta(req.user.id, hash, { rating: rating === 0 ? null : rating });
  sendOk(req, res);
}

// Fetch a user's starred-song rows, optionally library-scoped.
function starredSongRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash) AND um.user_id = ?
    WHERE ${clause} AND um.starred_at IS NOT NULL
    ORDER BY um.starred_at DESC
  `).all(req.user.id, ...params);
}

// Starred albums for the caller, scoped to their libraries via the existing
// album-list machinery. We reuse buildAlbumListQuery's select shape by going
// direct — the 'starred' type used to synthesise from child tracks, which
// this replaces.
function starredAlbumRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           ${ALBUM_PRIMARY_GENRE_SQL}, ${ALBUM_GENRES_JSON_SQL}, MIN(t.created_at) AS created_at,
           s.starred_at AS starred_at
    FROM user_album_stars s
    JOIN albums al ON al.id = s.album_id
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    WHERE s.user_id = ? AND ${clause}
    GROUP BY al.id
    HAVING songCount > 0
    ORDER BY s.starred_at DESC
  `).all(req.user.id, ...params);
}

function starredArtistRows(req) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT a.id, a.name, s.starred_at,
           COUNT(DISTINCT al.id) AS albumCount,
           MIN(al.album_art_file) AS coverArt
    FROM user_artist_stars s
    JOIN artists a ON a.id = s.artist_id
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    WHERE s.user_id = ? AND ${clause}
    GROUP BY a.id
    HAVING albumCount > 0
    ORDER BY s.starred_at DESC
  `).all(req.user.id, ...params);
}

function artistFromStarredRow(a) {
  return {
    id:         encArtist(a.id),
    name:       a.name,
    albumCount: a.albumCount,
    coverArt:   a.coverArt ? encArtist(a.id) : undefined,
    starred:    a.starred_at ? isoUtc(a.starred_at) : undefined,
  };
}

export function getStarred2(req, res) {
  const songs = enrichSongsWithUserMeta(req, starredSongRows(req).map(songFromRow));
  const albums = starredAlbumRows(req).map(albumFromListRow);
  const artists = starredArtistRows(req).map(artistFromStarredRow);
  sendOk(req, res, {
    starred2: { artist: artists, album: albums, song: songs },
  });
}

// v1 getStarred. Shape is almost identical to getStarred2 but under the
// `starred` key. Clients that predate ID3-based browsing use this.
export function getStarred(req, res) {
  const songs = enrichSongsWithUserMeta(req, starredSongRows(req).map(songFromRow));
  const albums = starredAlbumRows(req).map(albumFromListRow);
  const artists = starredArtistRows(req).map(artistFromStarredRow);
  sendOk(req, res, {
    starred: { artist: artists, album: albums, song: songs },
  });
}

// ── Album lists ────────────────────────────────────────────────────────────

// Shared album-list query: returns albums ordered by the given SQL tail
// (ORDER BY + LIMIT/OFFSET), scoped to the caller's libraries. `type` decides
// which ordering we synthesize.
function buildAlbumListQuery(req, type, params = {}) {
  const size   = Math.min(Math.max(parseInt(params.size, 10) || 10, 1), 500);
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);
  const { clause, params: libParams } = libraryScope(req);

  // Base select + join schema used by every type. user_album_stars is joined
  // at the album level so the `starred` column reflects proper album-level
  // star state (not "any one track is starred" — fixed in Phase 3).
  const base = `
    SELECT al.id, al.name, al.year, al.album_art_file, al.artist_id,
           a.name AS artist_name,
           COUNT(t.id) AS songCount, SUM(t.duration) AS duration,
           ${ALBUM_PRIMARY_GENRE_SQL}, ${ALBUM_GENRES_JSON_SQL}, MIN(t.created_at) AS created_at,
           uas.starred_at AS starred_at,
           MAX(um.rating) AS rating_max,
           SUM(COALESCE(um.play_count, 0)) AS plays,
           MAX(um.last_played) AS last_played
    FROM albums al
    LEFT JOIN artists a ON a.id = al.artist_id
    JOIN tracks t ON t.album_id = al.id
    LEFT JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash) AND um.user_id = ?
    LEFT JOIN user_album_stars uas ON uas.album_id = al.id AND uas.user_id = ?
    WHERE ${clause}
  `;
  const tailParams = [req.user.id, req.user.id, ...libParams];

  let where   = '';           // row-level filter (WHERE clause tail)
  let having  = 'songCount > 0'; // group-level filter (HAVING clause)
  let order   = 'al.name COLLATE NOCASE';

  switch (type) {
    case 'newest':    order = 'MIN(t.created_at) DESC'; break;
    case 'recent':    having += ' AND MAX(um.last_played) IS NOT NULL'; order = 'MAX(um.last_played) DESC'; break;
    case 'frequent':  having += ' AND plays > 0';                        order = 'plays DESC'; break;
    case 'highest':   having += ' AND rating_max IS NOT NULL';           order = 'rating_max DESC'; break;
    case 'starred':   having += ' AND uas.starred_at IS NOT NULL';       order = 'uas.starred_at DESC'; break;
    case 'random':    order = 'RANDOM()'; break;
    case 'byYear': {
      const from = parseInt(params.fromYear, 10);
      const to   = parseInt(params.toYear, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) { return null; }
      where = 'AND al.year BETWEEN ? AND ?';
      tailParams.push(Math.min(from, to), Math.max(from, to));
      order = from <= to ? 'al.year ASC' : 'al.year DESC';
      break;
    }
    case 'byGenre': {
      if (!params.genre) { return null; }
      // V34: filter via M2M with case-insensitive comparison. Folds in
      // the case-sensitivity fix flagged in the genre scout — pre-V34
      // this query rejected case-mismatched names (Subsonic clients
      // pass back exactly what they got from getGenres, so this was
      // mostly cosmetic, but the fix makes the surface uniform).
      where = `AND EXISTS (
        SELECT 1 FROM track_genres tg
        JOIN genres g ON g.id = tg.genre_id
        WHERE tg.track_id = t.id AND g.name COLLATE NOCASE = ?
      )`;
      tailParams.push(params.genre);
      // order stays at the default alphabetical
      break;
    }
    case 'alphabeticalByArtist': order = 'a.name COLLATE NOCASE, al.name COLLATE NOCASE'; break;
    case 'alphabeticalByName':
    default:
      order = 'al.name COLLATE NOCASE';
  }

  tailParams.push(size, offset);
  return {
    sql: `${base} ${where} GROUP BY al.id HAVING ${having} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: tailParams,
  };
}

function albumFromListRow(al) {
  return {
    id:        encAlbum(al.id),
    parent:    al.artist_id != null ? encArtist(al.artist_id) : undefined,
    isDir:     true,
    name:      al.name,
    title:     al.name,
    album:     al.name,
    artist:    al.artist_name || undefined,
    artistId:  al.artist_id != null ? encArtist(al.artist_id) : undefined,
    year:      al.year || undefined,
    genre:     al.genre || undefined,
    // OpenSubsonic `genres[]` — see parseGenresJson + ALBUM_GENRES_JSON_SQL.
    genres:    parseGenresJson(al.genres_json),
    coverArt:  al.album_art_file ? encAlbum(al.id) : undefined,
    songCount: al.songCount,
    duration:  al.duration != null ? Math.round(al.duration) : undefined,
    created:   isoUtc(al.created_at),
    starred:   al.starred_at ? isoUtc(al.starred_at) : undefined,
    playCount: al.plays > 0 ? al.plays : undefined,
  };
}

export function getAlbumList2(req, res) {
  const type = String(req.query.type || 'alphabeticalByName');
  const query = buildAlbumListQuery(req, type, req.query);
  if (!query) { return SubErr.MISSING_PARAM(req, res, type === 'byYear' ? 'fromYear/toYear' : 'genre'); }
  const rows = db.getDB().prepare(query.sql).all(...query.params);
  sendOk(req, res, { albumList2: { album: rows.map(albumFromListRow) } });
}

// v1 client path. Same payload under the older tag.
export function getAlbumList(req, res) {
  const type = String(req.query.type || 'alphabeticalByName');
  const query = buildAlbumListQuery(req, type, req.query);
  if (!query) { return SubErr.MISSING_PARAM(req, res, type === 'byYear' ? 'fromYear/toYear' : 'genre'); }
  const rows = db.getDB().prepare(query.sql).all(...query.params);
  sendOk(req, res, { albumList: { album: rows.map(albumFromListRow) } });
}

// ── Random songs / songs by genre ──────────────────────────────────────────

export function getRandomSongs(req, res) {
  const size   = Math.min(Math.max(parseInt(req.query.size, 10) || 10, 1), 500);
  const fromY  = parseInt(req.query.fromYear, 10);
  const toY    = parseInt(req.query.toYear, 10);
  const genre  = req.query.genre || null;
  const folder = decodeId(req.query.musicFolderId, 'folder');

  const { clause, params } = libraryScope(req);
  const where = [clause];
  const args  = [...params];
  // V34: genre filter via M2M EXISTS, case-insensitive — see getGenres
  // rewrite for the same pattern.
  if (genre) {
    where.push(`EXISTS (
      SELECT 1 FROM track_genres tg
      JOIN genres g ON g.id = tg.genre_id
      WHERE tg.track_id = t.id AND g.name COLLATE NOCASE = ?
    )`);
    args.push(genre);
  }
  if (Number.isFinite(fromY))   { where.push('t.year >= ?'); args.push(fromY); }
  if (Number.isFinite(toY))     { where.push('t.year <= ?'); args.push(toY); }
  if (folder)                   { where.push('t.library_id = ?'); args.push(folder.id); }

  const rows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${where.join(' AND ')}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...args, size);

  sendOk(req, res, {
    randomSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

export function getSongsByGenre(req, res) {
  const genre  = req.query.genre;
  if (!genre) { return SubErr.MISSING_PARAM(req, res, 'genre'); }
  const count  = Math.min(Math.max(parseInt(req.query.count,  10) || 10, 1), 500);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const folder = decodeId(req.query.musicFolderId, 'folder');

  // V34: case-insensitive genre filter via M2M.
  const { clause, params } = libraryScope(req);
  const where = [clause, `EXISTS (
    SELECT 1 FROM track_genres tg
    JOIN genres g ON g.id = tg.genre_id
    WHERE tg.track_id = t.id AND g.name COLLATE NOCASE = ?
  )`];
  const args  = [...params, genre];
  if (folder) { where.push('t.library_id = ?'); args.push(folder.id); }

  const rows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.name COLLATE NOCASE, al.name COLLATE NOCASE, t.disc_number, t.track_number
    LIMIT ? OFFSET ?
  `).all(...args, count, offset);

  sendOk(req, res, {
    songsByGenre: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

// ── Playlists ──────────────────────────────────────────────────────────────
// mStream stores playlist_tracks.filepath as "<vpath>/<relpath>". Subsonic
// clients pass song IDs; we translate between the two on insert/retrieval.

// Resolve many track ids to their "<vpath>/<relpath>" form in one query.
// Returns Map<id, filepath>; ids with no matching track are absent.
function filepathsForSongs(songIds) {
  const uniq = [...new Set(songIds)];
  if (!uniq.length) { return new Map(); }
  const ph = uniq.map(() => '?').join(',');
  const rows = db.getDB().prepare(`
    SELECT t.id AS id, l.name || '/' || t.filepath AS fp
    FROM tracks t JOIN libraries l ON l.id = t.library_id
    WHERE t.id IN (${ph})
  `).all(...uniq);
  return new Map(rows.map(r => [r.id, r.fp]));
}

// Fetch a single playlist. Visibility: the owner always sees it;
// other users only see playlists flagged public (added in V15).
function playlistMeta(playlistId, userId) {
  return db.getDB().prepare(`
    SELECT p.id, p.name, p.created_at, p.user_id, p.public, u.username,
           (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS songCount,
           (SELECT COALESCE(SUM(t.duration), 0) FROM playlist_tracks pt
              JOIN libraries l ON l.name =
                CASE WHEN INSTR(pt.filepath, '/') > 0
                     THEN SUBSTR(pt.filepath, 1, INSTR(pt.filepath, '/') - 1)
                     ELSE pt.filepath END
              JOIN tracks t ON t.library_id = l.id AND t.filepath =
                CASE WHEN INSTR(pt.filepath, '/') > 0
                     THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
                     ELSE '' END
              WHERE pt.playlist_id = p.id) AS duration
    FROM playlists p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND (p.user_id = ? OR p.public = 1)
  `).get(playlistId, userId);
}

function playlistSummary(row) {
  return {
    id:        `pl-${row.id}`,
    name:      row.name,
    owner:     row.username,
    public:    !!row.public,
    songCount: row.songCount,
    duration:  Math.round(row.duration || 0),
    created:   isoUtc(row.created_at),
    changed:   isoUtc(row.created_at),
  };
}

function decodePlaylistId(raw) {
  const s = String(raw || '');
  const m = /^(?:pl-)?(\d+)$/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

export function getPlaylists(req, res) {
  // Show the caller's own playlists plus any playlist flagged public.
  // Subsonic's semantics are user-global for public, so every user sees
  // every public playlist regardless of owner.
  const rows = db.getDB().prepare(`
    SELECT p.id, p.name, p.created_at, p.user_id, p.public, u.username,
           (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS songCount,
           0 AS duration
    FROM playlists p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? OR p.public = 1
    ORDER BY p.name COLLATE NOCASE
  `).all(req.user.id);
  sendOk(req, res, { playlists: { playlist: rows.map(playlistSummary) } });
}

export function getPlaylist(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const id = decodePlaylistId(req.query.id);
  if (id == null) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  const meta = playlistMeta(id, req.user.id);
  if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }

  // Resolve tracks by splitting pt.filepath at the first `/`.
  const tracks = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM playlist_tracks pt
    JOIN libraries l ON l.name = CASE
        WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, 1, INSTR(pt.filepath, '/') - 1)
        ELSE pt.filepath END
    JOIN tracks t ON t.library_id = l.id AND t.filepath = CASE
        WHEN INSTR(pt.filepath, '/') > 0 THEN SUBSTR(pt.filepath, INSTR(pt.filepath, '/') + 1)
        ELSE '' END
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).all(id);

  sendOk(req, res, {
    playlist: {
      ...playlistSummary(meta),
      entry: enrichSongsWithUserMeta(req, tracks.map(songFromRow)),
    },
  });
}

// Append songs to a playlist. Resolves all filepaths in one batched query and
// does NOT open its own transaction, so callers can wrap delete+insert in one.
function addSongsToPlaylist(playlistId, songIds, startPosition) {
  const fpById = filepathsForSongs(songIds);
  const stmt = db.getDB().prepare(
    'INSERT INTO playlist_tracks (playlist_id, filepath, position) VALUES (?, ?, ?)'
  );
  let pos = startPosition;
  for (const sid of songIds) {
    const fp = fpById.get(sid);
    if (fp) { stmt.run(playlistId, fp, pos++); }
  }
}

export function createPlaylist(req, res) {
  const name = String(req.query.name || '').trim();
  const updatePlaylistId = decodePlaylistId(req.query.playlistId);
  const songIds = arrayParam(req.query.songId).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  const d = db.getDB();

  if (updatePlaylistId != null) {
    // Subsonic overloads createPlaylist: passing playlistId replaces contents.
    // Only the owner can mutate — public-playlist visibility (V15) doesn't
    // grant edit rights.
    const meta = playlistMeta(updatePlaylistId, req.user.id);
    if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
    if (meta.user_id !== req.user.id) { return SubErr.NOT_AUTHORIZED(req, res); }
    // Replace contents atomically — DELETE + re-insert in one transaction so a
    // concurrent reader never sees a half-emptied playlist and the insert loop
    // costs a single fsync.
    db.transaction(() => {
      d.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(updatePlaylistId);
      addSongsToPlaylist(updatePlaylistId, songIds, 0);
      if (name) { d.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, updatePlaylistId); }
    });
    return getPlaylist({ ...req, query: { ...req.query, id: `pl-${updatePlaylistId}` } }, res);
  }

  if (!name) { return SubErr.MISSING_PARAM(req, res, 'name'); }
  const newId = db.transaction(() => {
    const result = d.prepare('INSERT INTO playlists (name, user_id) VALUES (?, ?)').run(name, req.user.id);
    const id = Number(result.lastInsertRowid);
    addSongsToPlaylist(id, songIds, 0);
    return id;
  });
  return getPlaylist({ ...req, query: { ...req.query, id: `pl-${newId}` } }, res);
}

export function updatePlaylist(req, res) {
  if (req.query.playlistId == null) { return SubErr.MISSING_PARAM(req, res, 'playlistId'); }
  const id = decodePlaylistId(req.query.playlistId);
  if (id == null) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  const meta = playlistMeta(id, req.user.id);
  if (!meta) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  // Public visibility doesn't grant edit rights — only the owner can mutate.
  if (meta.user_id !== req.user.id) { return SubErr.NOT_AUTHORIZED(req, res); }

  const d = db.getDB();
  // Apply every mutation (rename, visibility, remove-by-index, append) in one
  // transaction so the playlist is never observed half-updated and the append
  // loop costs a single fsync.
  db.transaction(() => {
    if (req.query.name) { d.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(String(req.query.name), id); }
    // V15 added the `public` column — honour the flag. Subsonic `comment`
    // is still accepted but dropped (no column for it).
    if ('public' in req.query) {
      const pub = req.query.public === 'true' ? 1 : 0;
      d.prepare('UPDATE playlists SET public = ? WHERE id = ?').run(pub, id);
    }

    // Remove entries by zero-based index (into current sorted position list).
    const removeIdx = arrayParam(req.query.songIndexToRemove).map(v => parseInt(v, 10)).filter(Number.isFinite);
    if (removeIdx.length) {
      const rows = d.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(id);
      const toDelete = removeIdx.filter(i => i >= 0 && i < rows.length).map(i => rows[i].id);
      if (toDelete.length) {
        const ph = toDelete.map(() => '?').join(',');
        d.prepare(`DELETE FROM playlist_tracks WHERE id IN (${ph})`).run(...toDelete);
      }
    }

    // Append new songs at the end.
    const toAdd = arrayParam(req.query.songIdToAdd).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
    if (toAdd.length) {
      const maxPos = d.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks WHERE playlist_id = ?').get(id).p;
      addSongsToPlaylist(id, toAdd, maxPos);
    }
  });

  sendOk(req, res);
}

export function deletePlaylist(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const id = decodePlaylistId(req.query.id);
  if (id == null) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  const result = db.getDB().prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (result.changes === 0) { return SubErr.NOT_FOUND(req, res, 'Playlist'); }
  sendOk(req, res);
}

// ── Phase 3: OpenSubsonic extensions manifest ─────────────────────────────
//
// Declared extensions — the client probes this to decide which optional
// features to use. Keep this list in sync with what we actually implement
// across phases. Each entry is { name, versions: [numbers] }.

const OPENSUBSONIC_EXTENSIONS = [
  { name: 'formPost',             versions: [1] },  // POST bodies accepted on every endpoint
  { name: 'apiKeyAuthentication', versions: [1] },  // `apiKey=` auth
  { name: 'transcodeOffset',      versions: [1] },  // `timeOffset` supported on stream
  { name: 'httpHeaders',          versions: [1] },  // HEAD + Content-Length estimate
  { name: 'tokenInfo',            versions: [1] },  // tokenInfo endpoint (validates API key)
  // Songs and albums emit `artists[]` arrays + compilation flag (V17).
  // Name chosen to match the OpenSubsonic "multiple artists" extension
  // used by Navidrome / Gonic.
  { name: 'songArtists',          versions: [1] },
];

export function getOpenSubsonicExtensions(req, res) {
  sendOk(req, res, { openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS });
}

// OpenSubsonic `tokenInfo`: clients use this to validate their API key
// and discover which user they're authenticated as without having to
// make a full getUser round-trip. Hit by the subsonicAuth middleware
// before we get here, so `req.user` is already populated — all we do
// is echo the identity + timestamps.
export function tokenInfo(req, res) {
  sendOk(req, res, {
    tokenInfo: {
      username: req.user.username,
    },
  });
}

// ── Phase 3: User management ───────────────────────────────────────────────
//
// Thin wrappers around src/util/admin.js so validation, hashing, and vpath
// linking happen in exactly one place. Admin-only endpoints guard with
// `req.user.admin`; self-service endpoints let users change their own data.

function userToSubsonicShape(row, libNames) {
  const isAdmin = !!row.is_admin;
  return {
    username:          row.username,
    email:             row.email || undefined,
    scrobblingEnabled: true,
    adminRole:         isAdmin,
    settingsRole:      isAdmin,
    downloadRole:      true,
    uploadRole:        !!row.allow_upload,
    playlistRole:      true,
    coverArtRole:      isAdmin,
    commentRole:       false,
    podcastRole:       false,
    streamRole:        true,
    // Server-side playback affects everyone in earshot of the rust-server-
    // audio output, so jukebox control is admin-only. Non-admins still get
    // error 50 from the handler; this flag just tells clients up-front.
    jukeboxRole:       isAdmin,
    shareRole:         true,
    videoConversionRole: false,
    folder:            libNames,
  };
}

function vpathsForUser(row) {
  const libIds = db.getUserLibraryIds(row);
  return db.getAllLibraries().filter(l => libIds.includes(l.id)).map(l => l.name);
}

export function getUser(req, res) {
  const wanted = req.query.username ? String(req.query.username) : req.user.username;
  // Non-admins can only query themselves.
  if (wanted !== req.user.username && !req.user.admin) {
    return SubErr.NOT_AUTHORIZED(req, res);
  }
  const row = db.getUserByUsername(wanted);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'User'); }
  sendOk(req, res, { user: userToSubsonicShape(row, vpathsForUser(row)) });
}

export function getUsers(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const rows = db.getAllUsers();
  sendOk(req, res, {
    users: { user: rows.map(r => userToSubsonicShape(r, vpathsForUser(r))) },
  });
}

export async function createUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  const password = String(req.query.password || '');
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (!password) { return SubErr.MISSING_PARAM(req, res, 'password'); }

  const plainPassword = password.startsWith('enc:')
    ? Buffer.from(password.slice(4), 'hex').toString('utf8')
    : password;
  const adminRole    = req.query.adminRole === 'true';
  const uploadRole   = req.query.uploadRole !== 'false';
  // Subsonic's `musicFolderId` is repeatable — map each id back to a vpath.
  const folderIds = arrayParam(req.query.musicFolderId)
    .map(v => decodeId(v, 'folder')?.id)
    .filter(Number.isFinite);
  const libs = db.getAllLibraries();
  const vpaths = folderIds.length
    ? libs.filter(l => folderIds.includes(l.id)).map(l => l.name)
    : libs.map(l => l.name); // default: grant everything

  try {
    await adminUtil.addUser(username, plainPassword, adminRole, vpaths, true, uploadRole);
    // V35: also populate the Subsonic-specific password with the same
    // value so the new user can immediately authenticate via Subsonic
    // token-auth clients (Symfonium, DSub, etc). A Subsonic admin
    // creating a user expects them to be usable via Subsonic without
    // an out-of-band "now go set a Subsonic password too" step.
    //
    // TODO: revisit once we add a way to create users without write
    // access (read-only Subsonic-only accounts). For those, setting
    // both passwords is fine; for full users, the admin may want to
    // distinguish the two via the mobile-clients panel later.
    await adminUtil.setSubsonicPassword(username, plainPassword);
    sendOk(req, res);
  } catch (err) {
    return SubErr.GENERIC(req, res, err.message || 'createUser failed');
  }
}

export async function updateUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  const row = db.getUserByUsername(username);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'User'); }

  // Only update fields the client actually sent.
  const adminRole    = 'adminRole'  in req.query ? req.query.adminRole  === 'true' : !!row.is_admin;
  const uploadRole   = 'uploadRole' in req.query ? req.query.uploadRole === 'true' : !!row.allow_upload;
  await adminUtil.editUserAccess(username, adminRole, !!row.allow_mkdir, uploadRole,
    row.allow_file_modify == null ? true : !!row.allow_file_modify);

  if ('musicFolderId' in req.query) {
    const folderIds = arrayParam(req.query.musicFolderId)
      .map(v => decodeId(v, 'folder')?.id)
      .filter(Number.isFinite);
    const libs = db.getAllLibraries();
    const vpaths = libs.filter(l => folderIds.includes(l.id)).map(l => l.name);
    await adminUtil.editUserVPaths(username, vpaths);
  }

  if (req.query.password) {
    const plain = String(req.query.password).startsWith('enc:')
      ? Buffer.from(String(req.query.password).slice(4), 'hex').toString('utf8')
      : String(req.query.password);
    await adminUtil.editUserPassword(username, plain);
    // V35: keep the Subsonic-specific password in sync with the main
    // password when changed via Subsonic. Same rationale as createUser
    // — a Subsonic admin client doesn't know about the mStream
    // dual-password model. TODO: consider read-only-user variant.
    await adminUtil.setSubsonicPassword(username, plain);
  }
  sendOk(req, res);
}

export async function deleteUser(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  const username = String(req.query.username || '').trim();
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (username === req.user.username) {
    // Self-deletion isn't a supported operation — use code 50 (not
    // authorized for this operation) rather than a generic server error.
    return SubErr.GENERIC_CODE(req, res, 50,
      'Cannot delete the currently authenticated user.');
  }
  try {
    await adminUtil.deleteUser(username);
    sendOk(req, res);
  } catch {
    return SubErr.NOT_FOUND(req, res, 'User');
  }
}

export async function changePassword(req, res) {
  const username = String(req.query.username || '').trim();
  const password = String(req.query.password || '');
  if (!username) { return SubErr.MISSING_PARAM(req, res, 'username'); }
  if (!password) { return SubErr.MISSING_PARAM(req, res, 'password'); }
  // Self-service or admin.
  if (username !== req.user.username && !req.user.admin) {
    return SubErr.NOT_AUTHORIZED(req, res);
  }
  const plain = password.startsWith('enc:')
    ? Buffer.from(password.slice(4), 'hex').toString('utf8')
    : password;
  try {
    await adminUtil.editUserPassword(username, plain);
    // V35: same dual-password sync as createUser/updateUser. A user
    // who runs `changePassword` via a Subsonic client and then tries
    // to log in via that same client expects the new password to
    // work — which requires updating the Subsonic-specific column too.
    await adminUtil.setSubsonicPassword(username, plain);
    sendOk(req, res);
  } catch {
    return SubErr.NOT_FOUND(req, res, 'User');
  }
}

// ── Phase 3: Similar songs & top songs ─────────────────────────────────────
//
// No LastFM dependency. `getTopSongs` is straight from local play counts.
// `getSimilarSongs{,2}` uses a "same artist, then shared-genre peers" local
// heuristic — good enough to make client Shuffle / recommendation features
// light up instead of showing empty state.

function songQueryBase() {
  return `
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
  `;
}

export function getTopSongs(req, res) {
  const artistName = String(req.query.artist || '').trim();
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);
  if (!artistName) { return SubErr.MISSING_PARAM(req, res, 'artist'); }

  const { clause, params } = libraryScope(req);
  const rows = db.getDB().prepare(`
    ${songQueryBase()}
    LEFT JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash) AND um.user_id = ?
    WHERE ${clause} AND a.name = ?
    ORDER BY COALESCE(um.play_count, 0) DESC, um.last_played DESC, t.title
    LIMIT ?
  `).all(req.user.id, ...params, artistName, count);

  sendOk(req, res, {
    topSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

function similarSongsFor(req, artistId, count) {
  const { clause, params } = libraryScope(req);
  // Tier 1: tracks by the same artist.
  const sameArtist = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE ${clause} AND t.artist_id = ?
    ORDER BY RANDOM() LIMIT ?
  `).all(...params, artistId, count);
  if (sameArtist.length >= count) { return sameArtist.slice(0, count); }

  // Tier 2: tracks that share at least one genre with any of this artist's
  // tracks, excluding the artist's own tracks.
  // V34: pull genres via M2M JOIN instead of the dropped flat column.
  const genres = db.getDB().prepare(`
    SELECT DISTINCT g.name FROM track_genres tg
    JOIN tracks t ON t.id = tg.track_id
    JOIN genres g ON g.id = tg.genre_id
    WHERE t.artist_id = ?
  `).all(artistId).map(r => r.name);

  if (!genres.length) { return sameArtist; }

  const genrePh = genres.map(() => '?').join(',');
  const remaining = count - sameArtist.length;
  // V34: candidate match via M2M EXISTS, case-insensitive. The genres
  // array came from this DB so case is identical, but COLLATE NOCASE
  // future-proofs us against case-variants creeping in (e.g. multi-
  // tagger source files).
  const related = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE ${clause} AND t.artist_id <> ? AND EXISTS (
      SELECT 1 FROM track_genres tg
      JOIN genres g ON g.id = tg.genre_id
      WHERE tg.track_id = t.id AND g.name COLLATE NOCASE IN (${genrePh})
    )
    ORDER BY RANDOM() LIMIT ?
  `).all(...params, artistId, ...genres, remaining);

  return [...sameArtist, ...related];
}

export function getSimilarSongs(req, res) {
  // v1 accepts any id (artist / album / song) — pick the enclosing artist.
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.NOT_FOUND(req, res); }
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);

  const artistId = (() => {
    if (parsed.type === 'artist') { return parsed.id; }
    if (parsed.type === 'album')  { return db.getDB().prepare('SELECT artist_id FROM albums WHERE id = ?').get(parsed.id)?.artist_id; }
    return db.getDB().prepare('SELECT artist_id FROM tracks WHERE id = ?').get(parsed.id)?.artist_id;
  })();
  if (!artistId) { return SubErr.NOT_FOUND(req, res, 'Artist'); }

  const rows = similarSongsFor(req, artistId, count);
  sendOk(req, res, {
    similarSongs: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

export function getSimilarSongs2(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 50, 1), 500);
  const rows = similarSongsFor(req, parsed.id, count);
  sendOk(req, res, {
    similarSongs2: { song: enrichSongsWithUserMeta(req, rows.map(songFromRow)) },
  });
}

// ── Phase 3: Now playing ───────────────────────────────────────────────────

export function getNowPlaying(req, res) {
  const snap = nowPlaying.snapshot();
  if (!snap.length) {
    return sendOk(req, res, { nowPlaying: { entry: [] } });
  }

  const trackIds = snap.map(s => s.trackId);
  const ph = trackIds.map(() => '?').join(',');
  const rows = db.getDB().prepare(`
    ${songQueryBase()}
    WHERE t.id IN (${ph})
  `).all(...trackIds);
  const byId = new Map(rows.map(r => [r.id, r]));

  const entry = snap.map(s => {
    const r = byId.get(s.trackId);
    if (!r) { return null; }
    const song = songFromRow(r);
    return {
      ...song,
      username:  s.username,
      // Seconds since this player's stream started. The spec calls this
      // `minutesAgo` — we convert.
      minutesAgo: Math.max(0, Math.floor((Date.now() - s.since) / 60000)),
      playerId:  s.userId, // stable per-user; matches Subsonic's loose usage
    };
  }).filter(Boolean);

  sendOk(req, res, { nowPlaying: { entry } });
}

// ── Phase 3: Scan status / start ───────────────────────────────────────────

export function getScanStatus(req, res) {
  // The scanner exposes its progress via dbQueue; we also report the total
  // number of tracks known so clients can display a "library size" number.
  const total = db.getDB().prepare('SELECT COUNT(*) AS n FROM tracks').get()?.n || 0;
  const scanning = typeof dbQueue.isScanning === 'function' ? !!dbQueue.isScanning() : false;
  sendOk(req, res, { scanStatus: { scanning, count: total } });
}

export function startScan(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  try { dbQueue.scanAll(); } catch { /* already scanning */ }
  // Return the fresh status so clients can immediately display progress.
  return getScanStatus(req, res);
}

// ── Phase 3: Artist/album info stubs ──────────────────────────────────────
//
// LastFM/MusicBrainz bios aren't in scope. We return the minimum shape with
// real similar-artists (computed from shared genres) so client "Info" panels
// render something useful instead of falling back to an error.

function similarArtistsFor(artistId, limit = 10) {
  const { clause: libClause, params: libParams } = { clause: '1=1', params: [] }; // libraries don't apply to artist rows
  void libClause; void libParams;
  // Artists sharing ≥1 genre with the target, scored by shared-genre count.
  // V34: read genres via the track_genres M2M instead of the dropped
  // flat column. The CTE materialises the target artist's genre ids
  // (not names — using ids avoids accidental case-fold mismatches and
  // lets the shared-count GROUP BY work without a NOCASE collation).
  return db.getDB().prepare(`
    WITH our_genres AS (
      SELECT DISTINCT g.id AS genre_id
      FROM track_genres tg
      JOIN tracks t ON t.id = tg.track_id
      JOIN genres g ON g.id = tg.genre_id
      WHERE t.artist_id = ?
    )
    SELECT a.id, a.name,
           COUNT(DISTINCT tg.genre_id) AS shared,
           COUNT(DISTINCT al.id)       AS albumCount
    FROM artists a
    JOIN albums al ON al.artist_id = a.id
    JOIN tracks t  ON t.album_id = al.id
    JOIN track_genres tg ON tg.track_id = t.id
    WHERE a.id <> ? AND tg.genre_id IN (SELECT genre_id FROM our_genres)
    GROUP BY a.id
    HAVING shared > 0
    ORDER BY shared DESC, albumCount DESC
    LIMIT ?
  `).all(artistId, artistId, limit);
}

function artistInfoPayload(artistRow) {
  const similar = similarArtistsFor(artistRow.id, 10);
  return {
    biography:      '',
    musicBrainzId:  artistRow.mbz_artist_id || undefined,
    lastFmUrl:      undefined,
    smallImageUrl:  undefined,
    mediumImageUrl: undefined,
    largeImageUrl:  undefined,
    similarArtist:  similar.map(s => ({
      id:         encArtist(s.id),
      name:       s.name,
      albumCount: s.albumCount,
    })),
  };
}

export function getArtistInfo(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const artistId = parsed.type === 'artist' ? parsed.id
    : (parsed.type === 'album' ? db.getDB().prepare('SELECT artist_id FROM albums WHERE id = ?').get(parsed.id)?.artist_id
    : db.getDB().prepare('SELECT artist_id FROM tracks WHERE id = ?').get(parsed.id)?.artist_id);
  if (!artistId) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const row = db.getDB().prepare('SELECT id, name, mbz_artist_id FROM artists WHERE id = ?').get(artistId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  sendOk(req, res, { artistInfo: artistInfoPayload(row) });
}

export function getArtistInfo2(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'artist');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  const row = db.getDB().prepare('SELECT id, name, mbz_artist_id FROM artists WHERE id = ?').get(parsed.id);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Artist'); }
  sendOk(req, res, { artistInfo2: artistInfoPayload(row) });
}

function albumInfoPayload(albumRow) {
  return {
    notes:          '',
    musicBrainzId:  albumRow.mbz_album_id || undefined,
    lastFmUrl:      undefined,
    smallImageUrl:  undefined,
    mediumImageUrl: undefined,
    largeImageUrl:  undefined,
  };
}

export function getAlbumInfo(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id);
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  const albumId = parsed.type === 'album' ? parsed.id
    : (parsed.type === 'song' ? db.getDB().prepare('SELECT album_id FROM tracks WHERE id = ?').get(parsed.id)?.album_id : null);
  if (!albumId) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  const row = db.getDB().prepare('SELECT id, mbz_album_id FROM albums WHERE id = ?').get(albumId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  sendOk(req, res, { albumInfo: albumInfoPayload(row) });
}

export function getAlbumInfo2(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'album');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  const row = db.getDB().prepare('SELECT id, mbz_album_id FROM albums WHERE id = ?').get(parsed.id);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Album'); }
  sendOk(req, res, { albumInfo2: albumInfoPayload(row) });
}

// ── Phase 3: Avatar (identicon) ───────────────────────────────────────────

export async function getAvatar(req, res) {
  const username = String(req.query.username || req.user.username);
  try {
    const buf = await identiconFor(username, 128);
    res.status(200).set({
      'Content-Type':  'image/png',
      'Cache-Control': 'public, max-age=3600',
    }).send(buf);
  } catch (err) {
    winston.error('[subsonic] getAvatar failed', { stack: err });
    res.status(404).end();
  }
}

// ── Phase 3: Shares ───────────────────────────────────────────────────────
//
// Subsonic shares map onto mStream's existing `shared_playlists` table.
// `playlist_json` is already a JSON array of "<vpath>/<relpath>" strings,
// which is exactly what mStream's share-view webapp reads. We convert song
// IDs to that form on create and back to songs on read.

// Resolve a batch of "<vpath>/<relpath>" share entries to full track rows in
// ONE query (instead of a query per entry per share — getShares maps this over
// every share the user owns). Returns Map<entry, row> keyed by the original
// "<vpath>/<relpath>" string so callers look each entry up directly.
function resolveShareTracks(filepaths) {
  const pairs = [];
  for (const fp of new Set(filepaths)) {
    const slash = fp.indexOf('/');
    if (slash < 0) { continue; }
    pairs.push([fp.slice(0, slash), fp.slice(slash + 1)]);
  }
  const map = new Map();
  if (!pairs.length) { return map; }
  const values = pairs.map(() => '(?,?)').join(',');
  const rows = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name,
           l.name AS share_vpath
    FROM tracks t
    JOIN libraries l ON l.id = t.library_id
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE (l.name, t.filepath) IN (VALUES ${values})
  `).all(...pairs.flat());
  for (const r of rows) { map.set(`${r.share_vpath}/${r.filepath}`, r); }
  return map;
}

function shareRowToPayload(row, sharePrefix, trackByFp) {
  // Resolve each "<vpath>/<relpath>" entry against the pre-batched map.
  const songRows = [];
  for (const fp of JSON.parse(row.playlist_json || '[]')) {
    const r = trackByFp.get(fp);
    if (r) { songRows.push(r); }
  }

  return {
    id:          `sh-${row.share_id}`,
    url:         `${sharePrefix}/shared/${row.share_id}`,
    description: row.description || undefined,
    username:    row.username || undefined,
    created:     isoUtc(row.created_at),
    expires:     row.expires ? new Date(row.expires * 1000).toISOString() : undefined,
    entry:       songRows.map(songFromRow),
  };
}

function shareUrlPrefix(req) {
  const host = req.get('host') || `127.0.0.1:${config.program.port}`;
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

export function getShares(req, res) {
  const rows = db.getDB().prepare(`
    SELECT s.id, s.share_id, s.playlist_json, s.user_id, s.expires, s.created_at,
           s.description, u.username
    FROM shared_playlists s
    LEFT JOIN users u ON u.id = s.user_id
    ${req.user.admin ? '' : 'WHERE s.user_id = ?'}
    ORDER BY s.created_at DESC
  `).all(...(req.user.admin ? [] : [req.user.id]));

  const prefix = shareUrlPrefix(req);
  // Resolve every track referenced by ALL shares in one batched query instead
  // of one query per entry per share.
  const trackByFp = resolveShareTracks(rows.flatMap(r => JSON.parse(r.playlist_json || '[]')));
  sendOk(req, res, {
    shares: { share: rows.map(r => shareRowToPayload(r, prefix, trackByFp)) },
  });
}

export function createShare(req, res) {
  // Same two-stage check as scrobble/star/unstar: distinguish "no id
  // params at all" from "ids given but none decoded" so clients see
  // the right Subsonic error code.
  const rawIds = arrayParam(req.query.id);
  if (!rawIds.length) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const songIds = rawIds.map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  if (!songIds.length) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  const fpById = filepathsForSongs(songIds);
  const filepaths = songIds.map(id => fpById.get(id)).filter(Boolean);
  if (!filepaths.length) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  // Subsonic sends `expires` as ms-since-epoch. Reject past timestamps —
  // an already-expired share is a client bug we'd rather surface than
  // silently store. Null/missing/zero = no expiry.
  const expiresMs = parseInt(req.query.expires, 10);
  if (Number.isFinite(expiresMs) && expiresMs > 0 && expiresMs <= Date.now()) {
    return SubErr.GENERIC_CODE(req, res, 10, '`expires` must be in the future');
  }
  const hasExpiry = Number.isFinite(expiresMs) && expiresMs > Date.now();
  const expires = hasExpiry ? Math.floor(expiresMs / 1000) : null;
  const description = req.query.description ? String(req.query.description) : null;
  const shareId = nanoid(10);

  // The webapp share-viewer (src/api/shared.js) verifies this JWT on every
  // lookup — an empty string here would throw "jwt must be provided" and
  // break browser access. Match the shape that /api/v1/share produces so
  // both code paths yield interchangeable rows.
  const tokenData = {
    playlistId: shareId,
    shareToken: true,
    username:   req.user.username,
  };
  const jwtOptions = hasExpiry
    ? { expiresIn: Math.max(1, Math.floor((expiresMs - Date.now()) / 1000)) }
    : {};
  const token = jwt.sign(tokenData, config.program.secret, jwtOptions);

  db.getDB().prepare(`
    INSERT INTO shared_playlists (share_id, playlist_json, user_id, expires, token, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(shareId, JSON.stringify(filepaths), req.user.id, expires, token, description);

  const row = db.getDB().prepare(`
    SELECT s.*, u.username FROM shared_playlists s
    LEFT JOIN users u ON u.id = s.user_id WHERE s.share_id = ?
  `).get(shareId);
  const trackByFp = resolveShareTracks(JSON.parse(row.playlist_json || '[]'));
  sendOk(req, res, {
    shares: { share: [shareRowToPayload(row, shareUrlPrefix(req), trackByFp)] },
  });
}

export function updateShare(req, res) {
  const idRaw = String(req.query.id || '');
  const m = /^sh-(.+)$/.exec(idRaw);
  const shareId = m ? m[1] : idRaw;
  if (!shareId) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT user_id FROM shared_playlists WHERE share_id = ?').get(shareId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Share'); }
  if (row.user_id !== req.user.id && !req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }

  if ('expires' in req.query) {
    const ms = parseInt(req.query.expires, 10);
    if (Number.isFinite(ms) && ms > 0 && ms <= Date.now()) {
      return SubErr.GENERIC_CODE(req, res, 10, '`expires` must be in the future');
    }
    const expires = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
    db.getDB().prepare('UPDATE shared_playlists SET expires = ? WHERE share_id = ?').run(expires, shareId);
  }
  // V15 added the `description` column — persist what the client sent.
  if ('description' in req.query) {
    const desc = req.query.description === '' ? null : String(req.query.description);
    db.getDB().prepare('UPDATE shared_playlists SET description = ? WHERE share_id = ?').run(desc, shareId);
  }
  sendOk(req, res);
}

export function deleteShare(req, res) {
  const idRaw = String(req.query.id || '');
  const m = /^sh-(.+)$/.exec(idRaw);
  const shareId = m ? m[1] : idRaw;
  if (!shareId) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const row = db.getDB().prepare('SELECT user_id FROM shared_playlists WHERE share_id = ?').get(shareId);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Share'); }
  if (row.user_id !== req.user.id && !req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }
  db.getDB().prepare('DELETE FROM shared_playlists WHERE share_id = ?').run(shareId);
  sendOk(req, res);
}

// ── Phase 3: Bookmarks ────────────────────────────────────────────────────
//
// Keyed on track_hash to survive a rescan (same pattern as user_metadata).

function bookmarkToPayload(row, songRow) {
  return {
    entry:       songRow ? songFromRow(songRow) : undefined,
    position:    row.position_ms,
    username:    row.username || undefined,
    comment:     row.comment || undefined,
    created:     isoUtc(row.created_at),
    changed:     isoUtc(row.changed_at),
  };
}

export function getBookmarks(req, res) {
  const rows = db.getDB().prepare(`
    SELECT b.*, u.username
    FROM user_bookmarks b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.user_id = ?
    ORDER BY b.changed_at DESC
  `).all(req.user.id);

  if (!rows.length) { return sendOk(req, res, { bookmarks: { bookmark: [] } }); }

  const hashes = rows.map(r => r.track_hash);
  // Duplicate the list so a bookmark keyed on file_hash still matches a
  // track whose canonical is audio_hash (transitional rows), and vice
  // versa. COALESCE in the JOIN would be cleaner but tracks-table lookups
  // here are by hash value, not a join, so match both columns. Chunked:
  // each hash binds twice, and big bookmark lists can pass the
  // per-statement variable cap.
  const { clause, params } = libraryScope(req);
  let songRows = [];
  for (const chunk of chunkedHashes(hashes)) {
    const ph = chunk.map(() => '?').join(',');
    songRows = songRows.concat(db.getDB().prepare(`
      ${songQueryBase()}
      WHERE (t.audio_hash IN (${ph}) OR t.file_hash IN (${ph})) AND ${clause}
    `).all(...chunk, ...chunk, ...params));
  }
  // Songs don't expose hashes in songQueryBase — resolve all matched rows'
  // canonical hashes in one batched query instead of a SELECT per row.
  const hashById = trackHashesByIds(songRows.map(row => row.id));
  const byHash = new Map();
  for (const row of songRows) {
    const r = hashById.get(row.id);
    const canon = r?.audio_hash || r?.file_hash;
    if (canon) { byHash.set(canon, row); }
    // Also register the non-canonical key so a row whose bookmark hasn't
    // yet been migrated still resolves its song entry.
    if (r?.file_hash && r.file_hash !== canon) { byHash.set(r.file_hash, row); }
  }

  sendOk(req, res, {
    bookmarks: {
      bookmark: rows.map(r => bookmarkToPayload(r, byHash.get(r.track_hash))),
    },
  });
}

export function createBookmark(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const position = parseInt(req.query.position, 10);
  if (!Number.isFinite(position) || position < 0) {
    return SubErr.MISSING_PARAM(req, res, 'position');
  }
  const hashes = trackHashVariants(parsed.id);
  if (!hashes) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const comment = req.query.comment ? String(req.query.comment) : null;

  // Write under the canonical hash, and clear any legacy-keyed row for
  // the same track — otherwise getBookmarks (which matches both hashes)
  // would list the track twice with diverging positions.
  db.getDB().prepare(`
    INSERT INTO user_bookmarks (user_id, track_hash, position_ms, comment)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, track_hash) DO UPDATE SET
      position_ms = excluded.position_ms,
      comment     = excluded.comment,
      changed_at  = datetime('now')
  `).run(req.user.id, hashes.canon, position, comment);
  if (hashes.all.length > 1) {
    db.getDB().prepare(
      'DELETE FROM user_bookmarks WHERE user_id = ? AND track_hash = ? AND track_hash != ?'
    ).run(req.user.id, hashes.all[1], hashes.canon);
  }

  sendOk(req, res);
}

export function deleteBookmark(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  // Delete by EVERY identity hash: getBookmarks matches both, so a
  // legacy-keyed bookmark a canonical-only delete can't reach would be
  // visible forever and undeletable.
  const hashes = trackHashVariants(parsed.id);
  if (!hashes) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const ph = hashes.all.map(() => '?').join(',');
  db.getDB().prepare(`DELETE FROM user_bookmarks WHERE user_id = ? AND track_hash IN (${ph})`)
    .run(req.user.id, ...hashes.all);
  sendOk(req, res);
}

// ── Phase 3: Play queue ───────────────────────────────────────────────────
//
// One row per user storing their current queue as a JSON array of track
// hashes. Resolves to current track ids at read time so rescans don't break
// pointers.

export function getPlayQueue(req, res) {
  const row = db.getDB().prepare('SELECT * FROM user_play_queue WHERE user_id = ?')
    .get(req.user.id);
  if (!row) { return sendOk(req, res, { playQueue: {} }); }

  const hashes = JSON.parse(row.track_hashes_json || '[]');
  if (!hashes.length) { return sendOk(req, res, { playQueue: {} }); }

  // Match both columns — stored queue hashes may be audio_hash (new rows)
  // or file_hash (legacy rows / formats without audio-region parsing).
  // Chunked: each hash binds twice, and Subsonic clients save queues of
  // arbitrary length — a big queue can pass the per-statement variable
  // cap and 500 the restore.
  const { clause, params } = libraryScope(req);
  let songRows = [];
  for (const chunk of chunkedHashes(hashes)) {
    const ph = chunk.map(() => '?').join(',');
    songRows = songRows.concat(db.getDB().prepare(`
      SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
             t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
             t.created_at, t.library_id, t.file_hash, t.audio_hash,
             t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
             a.id AS artist_id, a.name AS artist_name,
             al.id AS album_id, al.name AS album_name
      FROM tracks t
      LEFT JOIN artists a  ON a.id = t.artist_id
      LEFT JOIN albums  al ON al.id = t.album_id
      WHERE (t.audio_hash IN (${ph}) OR t.file_hash IN (${ph})) AND ${clause}
    `).all(...chunk, ...chunk, ...params));
  }

  const byHash = new Map();
  for (const r of songRows) {
    if (r.audio_hash) { byHash.set(r.audio_hash, r); }
    if (r.file_hash)  { byHash.set(r.file_hash, r); }
  }
  // Re-order to match the stored sequence, dropping any entries whose tracks
  // were removed since save time.
  const ordered = hashes.map(h => byHash.get(h)).filter(Boolean);

  // Find current (optional) — may have moved to a different id since save.
  let current;
  if (row.current_track_hash && byHash.has(row.current_track_hash)) {
    current = String(byHash.get(row.current_track_hash).id);
  }

  sendOk(req, res, {
    playQueue: {
      current,
      position: row.position_ms || undefined,
      username: req.user.username,
      changed:  isoUtc(row.changed_at),
      changedBy: row.changed_by || undefined,
      entry:    enrichSongsWithUserMeta(req, ordered.map(songFromRow)),
    },
  });
}

export function savePlayQueue(req, res) {
  const songIds = arrayParam(req.query.id).map(v => decodeId(v, 'song')?.id).filter(Number.isFinite);
  const currentId = decodeId(req.query.current, 'song')?.id;
  // Resolve every queue id (plus the optional current id) to its canonical hash
  // in one batched query instead of a SELECT per id.
  const hashById = trackHashesByIds(currentId ? [...songIds, currentId] : songIds);
  const canonOf = (id) => { const hr = hashById.get(id); return hr ? (hr.audio_hash || hr.file_hash) : undefined; };
  const hashes = songIds.map(canonOf).filter(Boolean);
  const currentHash = currentId ? canonOf(currentId) : null;
  const position = parseInt(req.query.position, 10);
  const posMs = Number.isFinite(position) && position >= 0 ? position : null;
  const changedBy = req.query.c ? String(req.query.c) : null;

  db.getDB().prepare(`
    INSERT INTO user_play_queue
      (user_id, current_track_hash, position_ms, changed_at, changed_by, track_hashes_json)
    VALUES (?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      current_track_hash = excluded.current_track_hash,
      position_ms        = excluded.position_ms,
      changed_at         = datetime('now'),
      changed_by         = excluded.changed_by,
      track_hashes_json  = excluded.track_hashes_json
  `).run(req.user.id, currentHash, posMs, changedBy, JSON.stringify(hashes));

  sendOk(req, res);
}

// ── Phase 3: Tier 3 stubs (explicit decline / empty) ──────────────────────

export function getInternetRadioStations(req, res) {
  sendOk(req, res, { internetRadioStations: { internetRadioStation: [] } });
}
export function getPodcasts(req, res) {
  sendOk(req, res, { podcasts: { channel: [] } });
}
export function getNewestPodcasts(req, res) {
  sendOk(req, res, { newestPodcasts: { episode: [] } });
}
// Internal: resolve a track row with its lyrics columns, scoped to the
// libraries the current user can see. Returns null if the row doesn't
// exist, the user can't see it, or no `artist`/`title` match.
function lyricsRowByArtistTitle(req, artist, title) {
  if (!artist || !title) { return null; }
  const { clause, params } = libraryScope(req);
  // Case-insensitive exact match on the artist row name + title.
  // Clients (DSub, Jamstash) often send the joined-with-featuring
  // display string — tolerate a substring match on either side so
  // `"The Beatles"` finds `"the beatles"`, and `"Yesterday"` finds
  // `"Yesterday (Remastered 2009)"`.
  // The AND-on-local-lyrics filter was removed in V20: a track can gain
  // lyrics AFTER the initial row resolves — now via the proactive backfill
  // worker (which writes the track row / lyrics_cache), not the old reactive
  // fetch. So we accept any artist+title match and let resolveLyricsForTrack
  // decide between local lyrics and a read-only lyrics_cache hit; the WHERE
  // must not skip tracks that have no local lyrics yet.
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
      -- Tracks that already have lyrics sort ahead of those that don't,
      -- so a query matching five titles picks the one we can serve now.
      CASE WHEN t.lyrics_embedded IS NOT NULL
             OR t.lyrics_synced_lrc IS NOT NULL THEN 0 ELSE 1 END,
      t.id
    LIMIT 1
  `).get(...params, artist, title, artist, title);
}

function lyricsRowById(req, trackId) {
  const { clause, params } = libraryScope(req);
  return db.getDB().prepare(`
    SELECT t.id, t.title, t.duration, t.audio_hash, t.file_hash,
           t.lyrics_embedded, t.lyrics_synced_lrc, t.lyrics_lang,
           a.name AS artist_name
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    WHERE t.id = ? AND ${clause}
  `).get(trackId, ...params);
}

// Resolve the lyrics strings actually served to the client for a
// given tracks row. Precedence:
//   1. Local lyrics (embedded tag / sidecar) — always wins when
//      present. Operators who curate their library trust the tagger.
//   2. `lyrics_cache` row with status='hit' — a read-only fallback for
//      a duplicate-hash twin the proactive backfill wrote a cache row
//      for but hasn't yet copied onto this row.
//   3. Nothing → empty. No request-triggered fetch; the proactive
//      backfill worker (src/db/lyrics-backfill.mjs) fills lyric-less
//      tracks ahead of time onto tracks.lyrics_*.
//
// Returns { plain, syncedLrc, lang, fromCache: bool }. `syncedLrc`
// and `plain` may both be non-null (hit had both variants) or both
// null (unqueriable / not-yet-backfilled track).
export function resolveLyricsForTrack(row) {
  if (!row) { return { plain: null, syncedLrc: null, lang: null, fromCache: false }; }

  // Step 1: local.
  const hasLocal = row.lyrics_embedded || row.lyrics_synced_lrc;
  if (hasLocal) {
    return {
      plain:     row.lyrics_embedded   || null,
      syncedLrc: row.lyrics_synced_lrc || null,
      lang:      row.lyrics_lang       || null,
      fromCache: false,
    };
  }

  // Step 2: read-only cache fallback.
  const canonHash = row.audio_hash || row.file_hash || null;
  const cached = canonHash ? lrclib.getCached(canonHash) : null;
  if (cached && cached.status === 'hit') {
    return {
      plain:     cached.plain      || null,
      syncedLrc: cached.synced_lrc || null,
      lang:      cached.lang       || row.lyrics_lang || null,
      fromCache: true,
    };
  }

  // Step 3: nothing to serve.
  return { plain: null, syncedLrc: null, lang: null, fromCache: false };
}

// Build a Subsonic-spec `structuredLyrics` entry from the resolver's
// output. `variant` picks which side to emit:
//   'synced' → parse LRC, emit one `<line start="ms">` per line
//   'plain'  → split on \n, emit one `<line>` per line, no start attr
// Returns null when the requested variant isn't available.
function buildStructuredLyrics(row, resolved, variant) {
  if (variant === 'synced') {
    if (!resolved.syncedLrc) { return null; }
    const parsed = parseLrc(resolved.syncedLrc);
    if (!parsed.lines.length) { return null; }
    return {
      lang:          resolved.lang || row?.lyrics_lang || 'xxx',
      synced:        true,
      displayArtist: row?.artist_name || undefined,
      displayTitle:  row?.title       || undefined,
      offset:        parsed.offsetMs || undefined,
      line: parsed.lines.map(l => ({ start: l.time_ms, value: l.text || '' })),
    };
  }
  if (!resolved.plain) { return null; }
  const plain = plainTextToLines(resolved.plain);
  return {
    lang:          resolved.lang || row?.lyrics_lang || 'xxx',
    synced:        false,
    displayArtist: row?.artist_name || undefined,
    displayTitle:  row?.title       || undefined,
    line: plain.lines.map(l => ({ value: l.text })),
  };
}

// Subsonic 1.2 getLyrics. Plain-text single `<lyrics>` envelope, no
// timing info — if the track has only synced lyrics we flatten them.
export function getLyrics(req, res) {
  const artist = req.query.artist ? String(req.query.artist).trim() : '';
  const title  = req.query.title  ? String(req.query.title).trim()  : '';
  if (!title) { return SubErr.MISSING_PARAM(req, res, 'title'); }

  const row = lyricsRowByArtistTitle(req, artist, title);
  // Spec: return an empty `<lyrics/>` element if the lookup fails —
  // clients interpret that as "no lyrics available" rather than an
  // error. Matches Airsonic/Navidrome behaviour. resolveLyricsForTrack
  // serves local lyrics, falling back to a read-only lyrics_cache hit
  // (the proactive backfill worker populates both); it never fetches.
  const resolved = resolveLyricsForTrack(row);
  let value = '';
  if (resolved.plain) {
    value = resolved.plain;
  } else if (resolved.syncedLrc) {
    value = linesToPlainText(parseLrc(resolved.syncedLrc).lines);
  }
  sendOk(req, res, {
    lyrics: {
      artist: (row?.artist_name || artist) || undefined,
      title:  (row?.title       || title)  || undefined,
      value,
    },
  });
}

// OpenSubsonic getLyricsBySongId. Returns zero, one, or two
// structuredLyrics entries — one synced, one plain — in preference
// order (synced first). Clients pick whichever they can render. The
// resolver may enqueue a background LRCLib fetch for this track if
// local lyrics aren't present — the fetch completes AFTER this
// response returns, so the second call for the same track will see
// results (assuming LRCLib had anything for it).
export function getLyricsBySongId(req, res) {
  if (req.query.id == null) { return SubErr.MISSING_PARAM(req, res, 'id'); }
  const parsed = decodeId(req.query.id, 'song');
  if (!parsed) { return SubErr.NOT_FOUND(req, res, 'Song'); }
  const row = lyricsRowById(req, parsed.id);
  if (!row) { return SubErr.NOT_FOUND(req, res, 'Song'); }

  const resolved = resolveLyricsForTrack(row);
  const entries = [];
  const synced = buildStructuredLyrics(row, resolved, 'synced');
  if (synced) { entries.push(synced); }
  const plain = buildStructuredLyrics(row, resolved, 'plain');
  if (plain)  { entries.push(plain); }

  sendOk(req, res, { lyricsList: { structuredLyrics: entries } });
}

// Internal helper exported for the new /api/v1/lyrics (Velvet-compatible)
// endpoint — same SQL, same parser, different response envelope. Kept
// here so callers don't have to re-import the LRC machinery.
export { lyricsRowByArtistTitle, lyricsRowById };
// ── Phase 4: Jukebox control ──────────────────────────────────────────────
//
// Backed by the rust-server-audio subsystem (src/api/server-playback.js).
// Every Subsonic jukeboxControl action maps 1:1 to an existing HTTP
// endpoint exposed by that subsystem, so this handler is a thin
// translation layer: action-name dispatch, ID → filepath resolution,
// status envelope shape-matching.
//
// Availability: requires autoBootServerAudio = true (or an externally-
// started rust-server-audio binary). When the binary is not reachable,
// the proxy calls throw and we surface a Subsonic error. Admin-only —
// server-side playback affects anyone in earshot, so non-admin calls
// are rejected with error 50.

// Convert a Subsonic song ID to the "<vpath>/<relpath>" format expected
// by /api/v1/server-playback/play et al. Returns null if the id doesn't
// resolve or the caller can't see its library.
function songIdToVpath(req, songId) {
  const { clause, params } = libraryScope(req);
  const row = db.getDB().prepare(`
    SELECT t.filepath, l.name AS vpath
    FROM tracks t JOIN libraries l ON l.id = t.library_id
    WHERE t.id = ? AND ${clause}
  `).get(songId, ...params);
  return row ? `${row.vpath}/${row.filepath}` : null;
}

// Take the rust-server-audio status object and emit the Subsonic-shaped
// jukeboxStatus / jukeboxPlaylist inner object. Subsonic uses integer
// seconds for `position`, 0.0–1.0 gain, and `currentIndex` indexed from
// zero (undefined when the queue is empty).
function jukeboxStatusFromRust(status) {
  const out = {
    currentIndex: status.queue_length > 0 ? status.queue_index : -1,
    playing:      !!status.playing,
    gain:         typeof status.volume === 'number' ? status.volume : 1.0,
    position:     Math.max(0, Math.floor(status.position || 0)),
  };
  return out;
}

// Resolve the current queue from rust-server-audio (which returns vpath
// strings like "testlib/Icarus/01 - x.mp3") back to full Subsonic song
// objects via the tracks table.
function queueToSongEntries(req, queueVpaths) {
  if (!queueVpaths?.length) { return []; }
  // Split each vpath into { vpath, filepath } pairs, then batch-select
  // tracks that match any of them. Order of results matches the input
  // queue so clients render entries in the right order.
  const pairs = queueVpaths.map(v => {
    const slash = v.indexOf('/');
    if (slash < 0) { return null; }
    return { vpath: v.slice(0, slash), filepath: v.slice(slash + 1) };
  }).filter(Boolean);
  if (!pairs.length) { return []; }

  const { clause, params } = libraryScope(req);
  // Per-row lookup — the queue is small enough (few dozen entries at
  // most) that a prepared statement in a loop is faster than building
  // an IN (?,?,?) of tuples.
  const stmt = db.getDB().prepare(`
    SELECT t.id, t.filepath, t.title, t.track_number, t.disc_number, t.duration,
           t.format, t.file_size, t.bitrate, t.year, ${TRACK_PRIMARY_GENRE_SQL}, ${TRACK_GENRES_JSON_SQL}, t.album_art_file,
           t.created_at, t.library_id,
           t.replaygain_track_db, t.sample_rate, t.channels, t.bit_depth,
           a.id AS artist_id, a.name AS artist_name,
           al.id AS album_id, al.name AS album_name
    FROM tracks t
    JOIN libraries l ON l.id = t.library_id
    LEFT JOIN artists a  ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE l.name = ? AND t.filepath = ? AND ${clause}
  `);
  const rows = [];
  for (const p of pairs) {
    const r = stmt.get(p.vpath, p.filepath, ...params);
    if (r) { rows.push(r); }
  }
  return enrichSongsWithUserMeta(req, rows.map(songFromRow));
}

// Wrapper: call the rust-server-audio proxy and surface its failures as a
// Subsonic error envelope rather than crashing the handler.
async function proxyOrFail(req, res, method, path, body) {
  try {
    const r = await serverPlayback.proxyToRust(method, path, body);
    return r;
  } catch (err) {
    winston.warn(`[subsonic jukebox] ${method} ${path} failed: ${err.message}`);
    // Surface as error 30 ("feature requires server upgrade / not
    // available on this server") — the closest semantically to "enable
    // autoBootServerAudio first".
    sendError(req, res, 30, `Jukebox unavailable: ${err.message}`);
    return null;
  }
}

export async function jukeboxControl(req, res) {
  if (!req.user.admin) { return SubErr.NOT_AUTHORIZED(req, res); }

  const action = String(req.query.action || 'status');

  // ── Queue-mutating actions ──────────────────────────────────────────

  if (action === 'set' || action === 'add') {
    const songIds = arrayParam(req.query.id)
      .map(v => decodeId(v, 'song')?.id)
      .filter(Number.isFinite);
    const files = songIds.map(id => songIdToVpath(req, id)).filter(Boolean);
    if (!files.length && action === 'add') {
      return SubErr.MISSING_PARAM(req, res, 'id');
    }
    // Resolve to absolute paths — /queue/add-many expects what
    // server-playback's own route does: absolutes.
    const abs = [];
    for (const f of files) {
      try { abs.push(serverPlayback.resolveFilePath(f, req.user)); }
      catch { /* unresolvable — skip, don't 500 */ }
    }
    if (action === 'set') {
      // `set` = clear + add — two proxy calls in sequence.
      const r1 = await proxyOrFail(req, res, 'POST', '/queue/clear', {});
      if (!r1) { return; }
    }
    if (abs.length) {
      const r2 = await proxyOrFail(req, res, 'POST', '/queue/add-many', { files: abs });
      if (!r2) { return; }
    }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'clear') {
    const r = await proxyOrFail(req, res, 'POST', '/queue/clear', {});
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'remove') {
    const index = parseInt(req.query.index, 10);
    if (!Number.isFinite(index) || index < 0) {
      return SubErr.MISSING_PARAM(req, res, 'index');
    }
    const r = await proxyOrFail(req, res, 'POST', '/queue/remove', { index });
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  // ── Transport actions ───────────────────────────────────────────────

  if (action === 'start') {
    const r = await proxyOrFail(req, res, 'POST', '/resume', {});
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'stop') {
    const r = await proxyOrFail(req, res, 'POST', '/pause', {});
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'skip') {
    const index = parseInt(req.query.index, 10);
    if (!Number.isFinite(index) || index < 0) {
      return SubErr.MISSING_PARAM(req, res, 'index');
    }
    const r = await proxyOrFail(req, res, 'POST', '/queue/play-index', { index });
    if (!r) { return; }
    // Optional offset in seconds.
    const offset = parseFloat(req.query.offset);
    if (Number.isFinite(offset) && offset > 0) {
      await proxyOrFail(req, res, 'POST', '/seek', { position: offset });
      if (res.headersSent) { return; }
    }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'shuffle') {
    const r = await proxyOrFail(req, res, 'POST', '/shuffle', {});
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  if (action === 'setGain') {
    const gain = parseFloat(req.query.gain);
    if (!Number.isFinite(gain) || gain < 0 || gain > 1) {
      // Invalid parameter value — surface as code 10 (missing/invalid param).
      return SubErr.GENERIC_CODE(req, res, 10, 'gain must be between 0.0 and 1.0');
    }
    const r = await proxyOrFail(req, res, 'POST', '/volume', { volume: gain });
    if (!r) { return; }
    return sendJukeboxStatus(req, res);
  }

  // ── Read actions ────────────────────────────────────────────────────

  if (action === 'status') {
    return sendJukeboxStatus(req, res);
  }

  if (action === 'get') {
    return sendJukeboxPlaylist(req, res);
  }

  // Unknown `action=` — treat as invalid parameter (code 10) rather than
  // a generic server error.
  return SubErr.GENERIC_CODE(req, res, 10, `Unknown jukebox action: ${action}`);
}

async function sendJukeboxStatus(req, res) {
  const s = await proxyOrFail(req, res, 'GET', '/status');
  if (!s) { return; }
  sendOk(req, res, { jukeboxStatus: jukeboxStatusFromRust(s.data) });
}

async function sendJukeboxPlaylist(req, res) {
  const [s, q] = await Promise.all([
    proxyOrFail(req, res, 'GET', '/status'),
    proxyOrFail(req, res, 'GET', '/queue'),
  ]);
  if (!s || !q) { return; }
  // rust-server-audio returns queue entries as absolute paths; the
  // server-playback proxy layer rewrites them to vpath form before
  // returning. queueToSongEntries resolves those back to track rows.
  const queue = Array.isArray(q.data?.queue) ? q.data.queue : [];
  const entry = queueToSongEntries(req, queue);
  sendOk(req, res, {
    jukeboxPlaylist: {
      ...jukeboxStatusFromRust(s.data),
      entry,
    },
  });
}
