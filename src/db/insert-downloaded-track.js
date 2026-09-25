// Insert a file that landed in a library WITHOUT the scanner — a Youtube DL
// download (src/api/ytdl.js), a collection copy from a paired peer
// (src/discovery-plugins/plugins/federation-copy.js) — as a tracks row the
// way a scan would have written it, so the song plays, lists and searches
// at once instead of after the next scan.
//
// The row is identity-compatible with scanned rows: the same hash helper
// and HASH_GENERATION (a row left at the column default would re-arm the
// boot convergence pass), the V71 album consensus inputs, the V72 credit
// row, the V73 display string, and scan_id left NULL so the first scan that
// walks the file claims it normally. `source` (V36) records provenance.
//
// Genres are deliberately not written: they flow through the track_genres
// M2M the scanner populates, and the next scan picks them up.

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import mime from 'mime-types';
import winston from 'winston';
import { parseFile } from 'music-metadata';
import * as config from '../state/config.js';
import * as db from './manager.js';
import { refreshDirtyAlbums } from './album-aggregate.js';
import { refreshDirtyArtists } from './artist-aggregate.js';
import { generateThumbnails } from '../util/image-thumbs.js';

const EMPTY_TAGS = { track: { no: null, of: null }, disk: { no: null, of: null } };

/**
 * @param {object} opts
 * @param {string} opts.filePath   absolute path of the file, already in place
 * @param {string} opts.vpath      the library it landed in (libraries.name)
 * @param {string} opts.basePath   that library's root (vpath.getVPathInfo().basePath)
 * @param {string} opts.source     tracks.source provenance ('ytdl', 'federation-copy', …)
 * @param {string} [opts.format]   the format column; defaults to the extension
 * @param {object} [opts.userMeta] title / artist / album / year overrides
 *                                 (user-typed) that win over the file's tags
 * @param {string} [opts.log]      log prefix
 * @returns {Promise<{ relativePath: string, trackId: number|null, title, artist, album, year }>}
 */
export async function insertDownloadedTrack({ filePath, vpath, basePath, source, format, userMeta = {}, log = 'download' }) {
  // A row only for what the server calls audio: the file explorer lists by
  // the same map, and a stray .html or .m3u must not become a "song".
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const supported = (config.program && config.program.supportedAudioFiles) || {};
  if (!ext || supported[ext] !== true) {
    throw new Error(`not an audio file the server plays (.${ext || '?'}) — refusing to add it to the library`);
  }
  const stat = await fs.stat(filePath);

  // Parse metadata from the file (include covers for album art)
  const skipImg = config.program.scanOptions.skipImg === true;
  let metadata;
  // The length, the way the scanner reads it (scanner.mjs). Without it the
  // row sat at NULL until a rescan rewrote it: the song showed no length and
  // its album's total ran short.
  let duration = null;
  try {
    const parsed = await parseFile(filePath, { skipCovers: skipImg });
    metadata = parsed.common;
    duration = (parsed.format && parsed.format.duration) || null;
  } catch (err) {
    winston.error(`${log}: metadata parse error`, { stack: err });
    metadata = EMPTY_TAGS;
  }

  // Compute both whole-file and audio-region hashes. The scanner uses the
  // same helper so these rows are identity-compatible with scanned rows —
  // which since V60 includes stamping hash_v with the helper's
  // HASH_GENERATION: a row left at the column default (1) would re-arm the
  // boot convergence epoch (a full re-key pass of the stale-generation
  // rows) after every download.
  const audioHashLib = await import('./audio-hash.js');
  const { fileHash: hash, audioHash } = await audioHashLib.computeHashes(filePath);
  const hashV = audioHashLib.HASH_GENERATION;

  // Build DB record matching the scanner schema. User-submitted metadata
  // overrides take priority over parsed file metadata. The path is stored
  // with forward slashes whatever the platform — that is how every lookup
  // (getVPathInfo, pullMetaData) spells it.
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
  const data = {
    title: userMeta.title || (metadata.title ? String(metadata.title) : null),
    artist: userMeta.artist || (metadata.artist ? String(metadata.artist) : null),
    year: userMeta.year ? Number(userMeta.year) : (metadata.year || null),
    album: userMeta.album || (metadata.album ? String(metadata.album) : null),
    filepath: relativePath,
    format: format || path.extname(filePath).slice(1).toLowerCase() || null,
    track: metadata.track?.no || null,
    disk: metadata.disk?.no || null,
    modified: stat.mtime.getTime(),
    hash,
    audioHash,
    aaFile: null,
    vpath,
    // Leave scan_id NULL: the scanner stamps it only when it rewrites a
    // row, and the first scan that walks this file claims the row normally
    // (the stale sweep keys on the scanner's in-memory seen tracking, not
    // this column). Provenance lives in tracks.source (V36).
    sID: null,
    replaygainTrackDb: metadata.replaygain_track_gain ? metadata.replaygain_track_gain.dB : null,
  };

  // Extract and save album art from the embedded picture
  if (!skipImg && metadata.picture && metadata.picture[0]) {
    try {
      const picData = metadata.picture[0].data;
      const picHashString = crypto.createHash('md5').update(picData.toString('utf-8')).digest('hex');
      const extension = mime.extension(metadata.picture[0].format) || 'jpg';
      data.aaFile = picHashString + '.' + extension;

      const aaDir = config.program.storage.albumArtDirectory;
      const aaFilePath = path.join(aaDir, data.aaFile);

      // Save original if it doesn't already exist in the cache
      let isNewFile = false;
      try {
        await fs.access(aaFilePath);
      } catch {
        await fs.writeFile(aaFilePath, picData);
        isNewFile = true;
      }

      // Create compressed versions for thumbnails. Off the event loop +
      // pixel-count guarded (util/image-thumbs.js): embedded covers come
      // from downloaded media, so their dimensions are not ours to trust,
      // and a pure-JS decode here stalls every other request.
      if (isNewFile && config.program.scanOptions.compressImage) {
        await generateThumbnails(picData, aaFilePath, aaDir, data.aaFile);
      }
    } catch (err) {
      winston.error(`${log}: failed to extract album art`, { stack: err });
    }
  }

  // Insert into SQLite. V34 dropped tracks.genre — genre data flows through
  // the track_genres M2M instead (the scanner populates it via
  // setTrackGenres); the next scan picks it up if the file carries one.
  const d = db.getDB();
  const lib = db.getLibraryByName(data.vpath);
  let trackId = null;
  if (d && lib) {
    const artistId = db.findOrCreateArtist(data.artist);
    const albumId = db.findOrCreateAlbum(data.album, artistId, data.year);
    // V71: tag_album / tag_compilation are the album consensus inputs the
    // scanners stamp per track; stamping them here means this row votes on
    // its album like any scanned row (no ALBUMARTIST input here, so that
    // one stays NULL).
    d.prepare(
      `INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
       disc_number, year, duration, format, file_hash, audio_hash, album_art_file, replaygain_track_db,
       modified, scan_id, source, hash_v, tag_album, tag_compilation, artist_display)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      data.filepath, lib.id, data.title || null, artistId, albumId,
      data.track, data.disk, data.year, duration, data.format, data.hash, data.audioHash || null,
      data.aaFile, data.replaygainTrackDb, data.modified, data.sID, source, hashV,
      data.album || null,
      // V73: the display string is the artist as given.
      String(data.artist || '').trim() || null
    );
    // V72: the primary-artist credit row, with the raw spelling that votes
    // on the artist's display name (the scanners write the same row from
    // the split ARTIST tag).
    if (artistId) {
      // Trimmed, like the scanners' split credits — a " Foo" vote would
      // win a 1:1 tie on BINARY order and rename the artist.
      const credit = String(data.artist).trim() || null;
      d.prepare(
        `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position, tag_name)
         VALUES ((SELECT id FROM tracks WHERE filepath = ? AND library_id = ?), ?, 'main', 0, ?)`
      ).run(data.filepath, lib.id, artistId, credit);
    }
    // The insert (and the REPLACE of any earlier row at this path) flagged
    // the affected album(s) / artist(s) through the *_agg triggers;
    // recompute them now so the album's year range / count and the
    // artist's counts reflect this track before any scan runs — the
    // album-songs API matches `year` against that range.
    refreshDirtyAlbums(d);
    refreshDirtyArtists(d);
    const row = d.prepare('SELECT id FROM tracks WHERE filepath = ? AND library_id = ?').get(data.filepath, lib.id);
    trackId = row ? row.id : null;
  }
  winston.info(`${log}: added ${relativePath} to database`);
  // `hash` = the file hash the row carries, for the plugin_downloads record
  // (src/db/plugin-downloads.js) a caller keeps beside the row.
  return { relativePath, trackId, title: data.title, artist: data.artist, album: data.album, year: data.year, hash };
}

// The inverse: a downloaded file left the library outside the scanner (its
// owner or an admin removed it). A plain DELETE is what
// the scanner's own sweep does — credits and genre links cascade, the
// tracks_ad_agg trigger flags the album / artist it leaves, and the search
// index is trigger-kept; the aggregates are recomputed here so counts are
// right before any scan runs. Hash-keyed user data (ratings, play counts)
// is deliberately untouched: it belongs to the recording, not the row.
// Returns how many rows went (0 when the scanner got there first).
export function removeDownloadedTrack({ vpath, relativePath, log = 'download' }) {
  const d = db.getDB();
  const lib = db.getLibraryByName(vpath);
  if (!d || !lib) { return 0; }
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const changes = d.prepare('DELETE FROM tracks WHERE library_id = ? AND filepath = ?').run(lib.id, rel).changes;
  if (changes > 0) {
    refreshDirtyAlbums(d);
    refreshDirtyArtists(d);
    winston.info(`${log}: removed ${vpath}/${rel} from database`);
  }
  return changes;
}
