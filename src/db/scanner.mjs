// mStream File Scanner
// Scans a directory for audio files and writes metadata directly to SQLite.
// Spawned as a child process by task-queue.js.

import { parseFile } from 'music-metadata';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import { Jimp } from 'jimp';
import mime from 'mime-types';
import { migrateHashReferences as migrateHashRefsShared } from './hash-migration.js';
import { extractLyrics, sidecarMtime as probeLyricsSidecarMtime } from './lyrics-extraction.js';
import { computeHashes } from './audio-hash.js';
import { extractArtists, chooseAlbumArtistId } from './artist-extraction.js';
import { migrateAlbumStars } from './album-migration.js';

// ── Parse CLI input ─────────────────────────────────────────────────────────

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error('Warning: failed to parse JSON input');
  process.exit(1);
}

const schema = Joi.object({
  dbPath: Joi.string().required(),
  libraryId: Joi.number().integer().required(),
  vpath: Joi.string().allow('').optional(),
  directory: Joi.string().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  compressImage: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  scanCommitInterval: Joi.number().integer().min(1).default(25),
  forceRescan: Joi.boolean().default(false),
  // Accepted but ignored by the JS fallback scanner — only the Rust
  // scanner actually parallelises. Listed here so task-queue.js can
  // pass the same jsonLoad to either scanner without a Joi validation
  // failure.
  scanThreads: Joi.number().integer().min(0).default(0),
  // The JS fallback scanner doesn't generate waveforms anyway (Rust
  // binary handles that path). Accept the field for schema parity
  // with task-queue.js's jsonLoad.
  generateWaveforms: Joi.boolean().default(true),
  // Per-library flag from the libraries row (V21). false (default)
  // = use lstatSync and skip symlink entries; true = use statSync
  // (follows symlinks to their target, matching pre-v6.5 JS-scanner
  // behaviour). Resolved in task-queue.js from `library.follow_symlinks`.
  followSymlinks: Joi.boolean().default(false),
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error('Invalid JSON Input');
  console.log(validationError);
  process.exit(1);
}

// ── Open SQLite database ────────────────────────────────────────────────────

const db = new DatabaseSync(loadJson.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Wait up to 5s when another connection holds the write lock (e.g. the
// main server's shared-playlist cleanup or any API-triggered write).
// Without this, the scanner fails immediately with "database is locked".
db.exec('PRAGMA busy_timeout = 5000');

// ── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  // Capture album_id alongside the hashes so we can migrate
  // user_album_stars when a compilation collapses.
  getTrack: db.prepare(
    `SELECT id, modified, file_hash, audio_hash, album_id, lyrics_sidecar_mtime
       FROM tracks WHERE filepath = ? AND library_id = ?`
  ),
  updateScanId: db.prepare(
    'UPDATE tracks SET scan_id = ? WHERE id = ?'
  ),
  findArtist: db.prepare(
    'SELECT id FROM artists WHERE name = ?'
  ),
  insertArtist: db.prepare(
    'INSERT INTO artists (name) VALUES (?)'
  ),
  findAlbum: db.prepare(
    'SELECT id FROM albums WHERE name = ? AND artist_id IS ? AND year IS ?'
  ),
  insertAlbum: db.prepare(
    `INSERT INTO albums (name, artist_id, year, album_art_file, album_artist, compilation)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  updateAlbumArt: db.prepare(
    'UPDATE albums SET album_art_file = ? WHERE id = ? AND album_art_file IS NULL'
  ),
  // Keep the album_artist display string + compilation flag fresh on
  // re-scan so subsequent tracks sharing the album don't drop them.
  updateAlbumTags: db.prepare(
    `UPDATE albums
        SET album_artist = COALESCE(?, album_artist),
            compilation  = ?
      WHERE id = ?`
  ),
  insertTrack: db.prepare(
    `INSERT OR REPLACE INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
     disc_number, year, duration, format, file_hash, audio_hash, album_art_file, genre,
     replaygain_track_db, sample_rate, channels, bit_depth,
     lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime,
     modified, scan_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  // V17: M2M artist-link maintenance. Album-artists use INSERT OR IGNORE
  // so the same album getting re-walked by multiple tracks doesn't pile
  // up duplicate rows. Track-artists are cleared first (track_id was
  // just re-INSERTed so any stale CASCADE-dropped rows are already gone
  // — this DELETE is a belt-and-braces for partial-run edge cases).
  insertAlbumArtist: db.prepare(
    `INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position)
     VALUES (?, ?, ?, ?)`
  ),
  deleteTrackArtists: db.prepare(
    'DELETE FROM track_artists WHERE track_id = ?'
  ),
  insertTrackArtist: db.prepare(
    `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
     VALUES (?, ?, ?, ?)`
  ),
  // One-shot lookup of the seeded "Various Artists" row id. Used when
  // the album-artist fallback chain hits the compilation branch.
  findVariousArtists: db.prepare(
    `SELECT id FROM artists WHERE name = 'Various Artists' LIMIT 1`
  ),
  deleteOldTracks: db.prepare(
    'DELETE FROM tracks WHERE library_id = ? AND scan_id != ?'
  ),
  findGenre: db.prepare(
    'SELECT id FROM genres WHERE name = ?'
  ),
  insertGenre: db.prepare(
    'INSERT INTO genres (name) VALUES (?)'
  ),
  insertTrackGenre: db.prepare(
    'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
  ),
};

// Cached VA-row id — looked up once per scan, seeded by migration V17.
const variousArtistsId = stmts.findVariousArtists.get()?.id || null;

// ── User-data hash migration ───────────────────────────────────────────────
// Delegates to the shared helper in ./hash-migration.js so the same logic
// is exercised by the unit test there without needing a scanner subprocess.
// See that file for the rationale.
function migrateHashReferences(oldHash, newHash) {
  migrateHashRefsShared(db, oldHash, newHash);
}

// ── Artist / Album helpers ──────────────────────────────────────────────────

function findOrCreateArtist(name) {
  if (!name) { return null; }
  const row = stmts.findArtist.get(name);
  if (row) { return row.id; }
  const result = stmts.insertArtist.run(name);
  return Number(result.lastInsertRowid);
}

function findOrCreateAlbum(name, artistId, year, albumArtFile, albumArtistDisplay, isCompilation) {
  if (!name) { return null; }
  const row = stmts.findAlbum.get(name, artistId, year);
  if (row) {
    // Re-asserting album metadata on every scan keeps the display string
    // and compilation flag fresh if the user edits the tag and rescans.
    if (albumArtFile) { stmts.updateAlbumArt.run(albumArtFile, row.id); }
    stmts.updateAlbumTags.run(albumArtistDisplay || null, isCompilation ? 1 : 0, row.id);
    return row.id;
  }
  const result = stmts.insertAlbum.run(
    name, artistId, year, albumArtFile || null,
    albumArtistDisplay || null, isCompilation ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}

function setTrackGenres(trackId, genreStr) {
  if (!genreStr) { return; }
  const genres = genreStr.split(/[,;\/]/).map(g => g.trim()).filter(g => g.length > 0);
  for (const name of genres) {
    let row = stmts.findGenre.get(name);
    if (!row) {
      const result = stmts.insertGenre.run(name);
      row = { id: Number(result.lastInsertRowid) };
    }
    stmts.insertTrackGenre.run(trackId, row.id);
  }
}

// File hashing moved to src/db/audio-hash.js (returns both file_hash and
// audio_hash in a single pass).

// ── Album art ───────────────────────────────────────────────────────────────

const mapOfDirectoryAlbumArt = {};

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // Check embedded picture
  if (songInfo.picture && songInfo.picture[0]) {
    const picHashString = crypto.createHash('md5')
      .update(songInfo.picture[0].data.toString('utf-8'))
      .digest('hex');
    songInfo.aaFile = picHashString + '.' + mime.extension(songInfo.picture[0].format);

    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
      originalFileBuffer = songInfo.picture[0].data;
    }
  } else {
    originalFileBuffer = checkDirectoryForAlbumArt(songInfo);
  }

  if (originalFileBuffer) {
    await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }

  const img = await Jimp.fromBuffer(buff);
  await img.scaleToFit({ w: 256, h: 256 }).write(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await img.scaleToFit({ w: 92, h: 92 }).write(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
}

function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return;
  }
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  let files;
  try { files = fs.readdirSync(directory); } catch (_err) { return; }

  const imageArray = [];
  for (const file of files) {
    const filepath = path.join(directory, file);
    let stat;
    try { stat = fs.statSync(filepath); } catch (_e) { continue; }
    if (!stat.isFile()) { continue; }
    if (!['png', 'jpg'].includes(getFileType(file))) { continue; }
    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    mapOfDirectoryAlbumArt[directory] = false;
    return;
  }

  let imageBuffer;
  let picFormat;
  let newFileFlag = false;

  for (let i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (['folder.jpg', 'cover.jpg', 'album.jpg', 'folder.png', 'cover.png', 'album.png'].includes(imgMod)) {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
      picFormat = getFileType(imageArray[i]);
      break;
    }
  }

  if (!imageBuffer) {
    imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
    picFormat = getFileType(imageArray[0]);
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer.toString('utf8')).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;

  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;
  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split('.').pop();
}

// ── Parse a single file ─────────────────────────────────────────────────────

async function parseMyFile(absolutePath, modified) {
  let songInfo;
  try {
    const parsed = await parseFile(absolutePath, { skipCovers: loadJson.skipImg });
    songInfo = parsed.common;
    songInfo.duration = parsed.format?.duration || null;
    // OpenSubsonic extended audio-format fields. music-metadata exposes
    // these as part of parsed.format — store what's available; missing
    // values stay NULL and clients just don't render the corresponding
    // quality badge.
    songInfo.sampleRate = Number.isFinite(parsed.format?.sampleRate) ? parsed.format.sampleRate : null;
    songInfo.channels   = Number.isFinite(parsed.format?.numberOfChannels) ? parsed.format.numberOfChannels : null;
    songInfo.bitDepth   = Number.isFinite(parsed.format?.bitsPerSample) ? parsed.format.bitsPerSample : null;
    // Multi-artist / compilation extraction — see src/db/artist-extraction.js
    // for the rules. Stored as a sub-object so `insertTrack` can pull it
    // without re-parsing.
    songInfo.artistInfo = extractArtists(parsed.common);
    // V19: lyrics from embedded tags + sibling sidecars. Returns the
    // four tracks.lyrics_* column values flat; insertTrack binds them
    // directly. Kept in a sub-object for the same reason as artistInfo.
    songInfo.lyricsInfo = extractLyrics(parsed.common, absolutePath);
  } catch (err) {
    console.error(`Warning: metadata parse error on ${absolutePath}: ${err.message}`);
    songInfo = { track: { no: null, of: null }, disk: { no: null, of: null }, duration: null,
                 sampleRate: null, channels: null, bitDepth: null,
                 artistInfo: { trackArtists: [], albumArtists: [], isCompilation: false,
                               trackArtistDisplay: '', albumArtistDisplay: null } };
    // Intentionally do NOT set lyricsInfo on the error path — the
    // fallback below re-runs the extractor so a `.lrc` sidecar still
    // gets picked up even when the audio file's tag frames are too
    // broken for music-metadata to read. Setting it to an all-null
    // default here (as an earlier revision did) made the fallback
    // unreachable.
  }
  // Run extractLyrics if we didn't already get a result above. The
  // extractor tolerates a null/empty `common` gracefully — it'll
  // skip pass 1 (embedded tags) and fall through to the sidecar
  // probe, so `foo.flac` with corrupt tags + `foo.lrc` still works.
  if (!songInfo.lyricsInfo) {
    songInfo.lyricsInfo = extractLyrics(songInfo, absolutePath);
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, absolutePath).replace(/\\/g, '/');
  songInfo.format = getFileType(absolutePath);
  // Compute both hashes in one pass. file_hash is whole-file MD5 (stable
  // identity for a specific byte sequence); audio_hash strips tag regions
  // so stars / bookmarks / play-queue entries survive tag-only edits. For
  // formats the extractor doesn't cover (ogg, opus, m4a, wav, aac)
  // audioHash is null and user_* callers fall back to file_hash.
  const { fileHash, audioHash } = await computeHashes(absolutePath);
  songInfo.hash = fileHash;
  songInfo.audioHash = audioHash;
  await getAlbumArt(songInfo);

  return songInfo;
}

// ── Insert a track into the database ────────────────────────────────────────
//
// Resolves artist rows, picks the album-artist (with the ALBUMARTIST →
// COMPILATION-Various-Artists → track-artist fallback), finds/creates
// the album row keyed on album-artist, inserts the track, then
// populates the M2M album_artists and track_artists tables. Returns
// the newly-inserted tracks.id so the caller can run downstream
// cleanups (hash migration, album-stars migration).

function insertTrack(song) {
  const ai = song.artistInfo || {
    trackArtists: [], albumArtists: [], isCompilation: false,
    trackArtistDisplay: song.artist || '', albumArtistDisplay: null,
  };

  // tracks.artist_id stays as the PRIMARY track artist (first in the
  // list). For a collab "A feat. B", trackArtists is ["A", "B"]; we
  // store A's id here and list B in track_artists with role='featured'.
  const primaryTrackArtistName = ai.trackArtists[0] || (song.artist ? String(song.artist) : null);
  const primaryTrackArtistId = findOrCreateArtist(primaryTrackArtistName);

  // Resolve all album-artist names to ids (idempotent).
  const albumArtistIds = ai.albumArtists.map(n => findOrCreateArtist(n)).filter(Number.isFinite);

  // Pick the album.artist_id per the fallback chain.
  const primaryAlbumArtistId = chooseAlbumArtistId({
    albumArtistIds,
    isCompilation: ai.isCompilation,
    variousArtistsId,
    primaryTrackArtistId,
  });

  const albumId = findOrCreateAlbum(
    song.album ? String(song.album) : null,
    primaryAlbumArtistId,
    song.year || null,
    song.aaFile || null,
    ai.albumArtistDisplay,
    ai.isCompilation,
  );

  const li = song.lyricsInfo || {
    lyricsEmbedded: null, lyricsSyncedLrc: null,
    lyricsLang: null, lyricsSidecarMtime: null,
  };
  const result = stmts.insertTrack.run(
    song.filePath,
    loadJson.libraryId,
    song.title ? String(song.title) : null,
    primaryTrackArtistId,
    albumId,
    song.track?.no || null,
    song.disk?.no || null,
    song.year || null,
    song.duration || null,
    song.format,
    song.hash,
    song.audioHash || null,
    song.aaFile || null,
    song.genre || null,
    song.replaygain_track_gain?.dB || null,
    song.sampleRate || null,
    song.channels || null,
    song.bitDepth || null,
    li.lyricsEmbedded,
    li.lyricsSyncedLrc,
    li.lyricsLang,
    li.lyricsSidecarMtime,
    song.modified,
    loadJson.scanId
  );
  const trackId = Number(result.lastInsertRowid);

  setTrackGenres(trackId, song.genre);

  // ── V17 M2M population ──────────────────────────────────────────────
  // album_artists: idempotent across multiple tracks sharing one album.
  // If ALBUMARTIST yielded nothing, fall back to whatever we stored in
  // albums.artist_id so the M2M row isn't empty (keeps the "union via
  // album_artists OR albums.artist_id" query shape from needing two
  // branches for the legacy single-artist case).
  const albumArtistsForM2M = albumArtistIds.length ? albumArtistIds : (primaryAlbumArtistId ? [primaryAlbumArtistId] : []);
  for (let i = 0; i < albumArtistsForM2M.length; i++) {
    stmts.insertAlbumArtist.run(albumId, albumArtistsForM2M[i], 'main', i);
  }

  // track_artists: the track row was just (INSERT OR REPLACE)'d so any
  // prior rows CASCADE-dropped. But the REPLACE path keeps the same id
  // when (filepath, library_id) collides — clear first to be safe.
  stmts.deleteTrackArtists.run(trackId);
  const trackArtistIds = ai.trackArtists.map(n => findOrCreateArtist(n)).filter(Number.isFinite);
  // Fall back to the primary track artist if the extractor returned
  // nothing (edge case: file with no ARTIST tag at all).
  if (!trackArtistIds.length && primaryTrackArtistId) { trackArtistIds.push(primaryTrackArtistId); }
  for (let i = 0; i < trackArtistIds.length; i++) {
    stmts.insertTrackArtist.run(trackId, trackArtistIds[i], i === 0 ? 'main' : 'featured', i);
  }

  return { trackId, albumId };
}

// ── Recursive directory scan ────────────────────────────────────────────────

let fileCount = 0;      // new/modified files parsed
let totalProcessed = 0; // all files touched (including unchanged — for progress)
// Commit cadence: doubles as progress-update cadence and write-lock release.
// Lower = more responsive API writes during scans but more COMMIT/BEGIN overhead.
// Admin-configurable via scanCommitInterval; default (25) is a balanced starting point.
const COMMIT_INTERVAL = loadJson.scanCommitInterval || 25;

// ── Fast file counter (no metadata parsing) ────────────────────────────────

// When `followSymlinks` is false (default), use lstatSync so symlink
// entries are seen AS symlinks (isFile/isDirectory both false) and
// skipped. When true, use statSync to follow symlinks to their target.
// Library root is always followed (readdirSync operates on the target
// of a root-level symlink); this only governs nested entries.
const statForWalk = loadJson.followSymlinks
  ? fs.statSync
  : fs.lstatSync;

function countSupportedFiles(dir) {
  let count = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const file of files) {
    try {
      const fp = path.join(dir, file);
      const stat = statForWalk(fp);
      if (stat.isDirectory()) {
        count += countSupportedFiles(fp);
      } else if (stat.isFile() && loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
        count++;
      }
    } catch (_) {}
  }
  return count;
}

// ── Scan progress tracking ─────────────────────────────────────────────────

const progressStmts = {
  insert: db.prepare(
    'INSERT OR REPLACE INTO scan_progress (scan_id, library_id, vpath, scanned, expected) VALUES (?, ?, ?, 0, ?)'
  ),
  update: db.prepare(
    'UPDATE scan_progress SET scanned = ?, current_file = ? WHERE scan_id = ?'
  ),
  remove: db.prepare(
    'DELETE FROM scan_progress WHERE scan_id = ?'
  ),
};

async function recursiveScan(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_err) { return; }

  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    // statForWalk picks between statSync (follows symlinks) and
    // lstatSync (doesn't) per the `followSymlinks` config flag. A
    // symlink entry under lstatSync has isFile()=false AND
    // isDirectory()=false, so it falls through both branches below
    // and is silently skipped — no-follow by default.
    try { stat = statForWalk(filepath); } catch (_e) { continue; }

    if (stat.isDirectory()) {
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      try {
        if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
          continue;
        }

        const relativePath = path.relative(loadJson.directory, filepath).replace(/\\/g, '/');
        const existing = stmts.getTrack.get(relativePath, loadJson.libraryId);

        // Fast-path: audio file unchanged. Still re-read if a sidecar
        // `.lrc` / `.txt` was edited (drift between stored mtime and
        // on-disk) — sidecars are the only lyrics source the audio
        // file's own mtime doesn't cover.
        const sidecarCurrentMtime = probeLyricsSidecarMtime(filepath);
        const sidecarDrifted =
          (existing?.lyrics_sidecar_mtime || null) !== (sidecarCurrentMtime || null);

        if (existing && existing.modified === stat.mtime.getTime() && !loadJson.forceRescan && !sidecarDrifted) {
          // File unchanged — just update the scan ID
          stmts.updateScanId.run(loadJson.scanId, existing.id);
        } else {
          // New or modified file — parse and insert.
          //
          // NOTE: we intentionally do NOT DELETE the old tracks row
          // before calling parseMyFile. If the parse throws (malformed
          // tags, disk error, locked file), the old row stays intact
          // and the user's user_metadata / bookmarks / play-queue
          // entries keyed off the old hash are preserved. The INSERT
          // below uses `INSERT OR REPLACE`, which atomically drops the
          // old row (cascading track_artists/track_genres) and inserts
          // the new one only after parseMyFile has returned a complete
          // songInfo. Earlier revisions pre-DELETEd here; inside the
          // scanner's batch transaction a mid-parse throw would commit
          // the DELETE without a matching INSERT on the next 25-file
          // flush, orphaning user state on the next scan.
          const oldFileHash  = existing ? existing.file_hash  : null;
          const oldAudioHash = existing ? existing.audio_hash : null;
          const oldAlbumId   = existing ? existing.album_id   : null;
          const songInfo = await parseMyFile(filepath, stat.mtime.getTime());
          const { albumId: newAlbumId } = insertTrack(songInfo);
          // User-facing tables key on canonical hash — audio_hash when we
          // have it, file_hash otherwise. A tag edit changes file_hash but
          // keeps audio_hash stable, so most rescans have nothing to do.
          // The migration runs when the canonical key actually changed
          // (content edit, first-time audio_hash populate for an existing
          // track, or format we can't extract an audio region from).
          const oldCanon = oldAudioHash || oldFileHash;
          const newCanon = songInfo.audioHash || songInfo.hash;
          if (oldCanon && newCanon && oldCanon !== newCanon) {
            migrateHashReferences(oldCanon, newCanon);
          }
          // V17: when a compilation collapses (or any album_id change
          // caused by the album-artist semantic shift), migrate this
          // user's album stars from the old fragment to the canonical
          // row BEFORE the stale-fragment sweep runs.
          if (oldAlbumId && newAlbumId && oldAlbumId !== newAlbumId) {
            migrateAlbumStars(db, oldAlbumId, newAlbumId);
          }
          fileCount++;
        }

        // Track all files (including unchanged) for progress
        totalProcessed++;

        // Periodically commit and report progress so the API can
        // see updates between batches. This also serves as the batch
        // commit for insert performance.
        if (totalProcessed % COMMIT_INTERVAL === 0) {
          db.exec('COMMIT');
          try { progressStmts.update.run(totalProcessed, relativePath, loadJson.scanId); } catch (_) {}
          db.exec('BEGIN');
        }
      } catch (err) {
        console.error(`Warning: failed to process ${filepath}: ${err.message}`);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

// Per-chunk row cap for the end-of-scan orphan cleanup. Each
// chunkedOrphanDelete iteration runs as its own autocommit DELETE,
// releasing the writer lock between batches so concurrent API writes
// (main server, backup worker) don't hit busy_timeout. 500 is a balance
// between per-chunk lock duration (well under SQLite's 5s busy_timeout)
// and per-iteration overhead (each iteration re-runs the candidate-id
// subselect, which is the slow part on big libraries).
const ORPHAN_CHUNK_SIZE = 500;

// Repeatedly DELETE up to ORPHAN_CHUNK_SIZE rows from `table` whose
// ids match `selectIdsSql`, until no rows remain. SQLite's bundled
// build doesn't ship with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so the
// LIMIT goes on a subselect rather than the DELETE itself.
//
// Loop terminates when a chunk reports zero changes, which means the
// candidate query found no more orphans. On a small library this is
// a single DELETE that handles everything plus one trivial no-op
// confirmation; on a large one it's many small DELETEs that cooperate
// with concurrent writers instead of starving them.
function chunkedOrphanDelete(table, selectIdsSql) {
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE id IN (${selectIdsSql} LIMIT ${ORPHAN_CHUNK_SIZE})`,
  );
  while (true) {
    const r = stmt.run();
    if (r.changes === 0) { break; }
  }
}

async function run() {
  try {
    console.log(`Scanning ${loadJson.directory}...`);

    // Fast pre-count of audio files for progress reporting
    const expectedFiles = countSupportedFiles(loadJson.directory);
    try {
      progressStmts.insert.run(loadJson.scanId, loadJson.libraryId, loadJson.vpath || '', expectedFiles || null);
    } catch (_) {}

    // Use explicit transactions for batch performance.
    // Without this, SQLite does a disk fsync per INSERT (~50 files/sec).
    // With transactions, it batches fsyncs (~5000+ files/sec).
    db.exec('BEGIN');
    await recursiveScan(loadJson.directory);
    db.exec('COMMIT');

    // Remove tracks that weren't seen in this scan (deleted files)
    const deleted = stmts.deleteOldTracks.run(loadJson.libraryId, loadJson.scanId);
    // Structured end-of-scan event — parsed by task-queue.js to decide whether
    // to run the waveform post-processor and to print a human-readable summary.
    // Field shapes mirror the rust-parser's emitter:
    //   filesProcessed       New / modified rows actually written.
    //   filesUnchanged       Cache-hit fast-path skips (file existed in DB and
    //                        mtime matched; only scan_id was bumped).
    //   filesScanned         Total supported files visited (processed +
    //                        unchanged + per-file errors).
    //   staleEntriesRemoved  Tracks deleted because the file disappeared.
    console.log(JSON.stringify({
      event: 'scanComplete',
      filesProcessed: fileCount,
      filesUnchanged: Math.max(0, totalProcessed - fileCount),
      filesScanned: totalProcessed,
      staleEntriesRemoved: deleted.changes
    }));

    // Clean up orphaned artists, albums, and genres. Keep artists referenced
    // by tracks.artist_id, albums.artist_id, OR either M2M table
    // (track_artists, album_artists). Without the M2M checks, featured /
    // co-credited artists (V17) whose only reference is the M2M row would
    // be deleted, and CASCADE on artist_id would drop the M2M row too —
    // silently eating the second entry of a "A feat. B" split.
    //
    // CHUNKED, not one big DELETE: on libraries with hundreds of thousands
    // of tracks and a long tail of one-track artists, the artists DELETE's
    // 4-way NOT IN can run past 5 seconds. Run as one autocommit DELETE
    // it holds the SQLite writer lock for that whole window, and any
    // concurrent API write (scrobble, star, play event from the main
    // server, or a backup worker's history-row update) hits busy_timeout
    // (5000ms) and fails with SQLITE_BUSY. Chunking releases the writer
    // between batches so other processes can squeeze in.
    chunkedOrphanDelete('albums',
      'SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)');
    chunkedOrphanDelete('artists',
      `SELECT id FROM artists
        WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks         WHERE artist_id IS NOT NULL)
          AND id NOT IN (SELECT DISTINCT artist_id FROM albums         WHERE artist_id IS NOT NULL)
          AND id NOT IN (SELECT DISTINCT artist_id FROM track_artists)
          AND id NOT IN (SELECT DISTINCT artist_id FROM album_artists)`);
    chunkedOrphanDelete('genres',
      'SELECT id FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM track_genres)');
  } catch (err) {
    console.error('Scan failed');
    console.error(err.stack);
    // Rollback any open transaction to release the write lock
    try { db.exec('ROLLBACK'); } catch (_) {}
  } finally {
    // Always clean up progress row, even on error
    try { progressStmts.remove.run(loadJson.scanId); } catch (_) {}
    db.close();
  }
}

run();
