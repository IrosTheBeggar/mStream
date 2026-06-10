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
import { migrateHashReferences as migrateHashRefsShared } from './hash-migration.js';
import { extractLyrics, sidecarMtimeCached } from './lyrics-extraction.js';
import { computeHashes } from './audio-hash.js';
import { extractArtists, chooseAlbumArtistId } from './artist-extraction.js';
import { migrateAlbumStars } from './album-migration.js';
import { cleanupOrphans, deleteStaleTracks } from './orphan-cleanup.js';
import { detectSource } from './source-detect.js';

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
  // Accepted but ignored by the JS fallback scanner — stratum-dsp
  // is a Rust crate, only the Rust scanner runs the BPM/key
  // analysis. Listed here so task-queue.js can pass the same
  // jsonLoad to either scanner without a Joi validation failure
  // (same pattern as scanThreads / generateWaveforms above).
  analyzeBpm: Joi.boolean().default(true),
  // Optional vpath-relative subtree to scan instead of the whole library.
  // Default empty string = legacy whole-vpath behaviour. When set, the
  // scan walks {directory}/{subtree} and SKIPS the stale-cleanup pass
  // (tracks outside the subtree would otherwise be deleted as "not
  // seen this scan"). See the matching field in rust-parser/src/main.rs.
  subtree: Joi.string().allow('').default(''),
  // Rust-only: directory the Rust scanner writes waveform .bin files to.
  // task-queue.js sends this to BOTH scanners (it stopped sending the
  // older `generateWaveforms` boolean). The JS fallback doesn't generate
  // waveforms, so it ignores the value — but it MUST accept the field or
  // Joi rejects the whole jsonLoad. This omission previously made the JS
  // fallback fail with "Invalid JSON Input" on every real launch.
  waveformCacheDir: Joi.string().allow('').optional(),
  // The server's SCHEMA_VERSION at spawn time. When present, the scanner
  // refuses to run against a DB whose PRAGMA user_version differs — see
  // the schema-version guard below. Optional so payloads from older
  // servers keep working.
  expectedSchemaVersion: Joi.number().integer().optional(),
})
  // Tolerate unknown keys. The Rust scanner gains config fields over
  // time (each one a separate addition to task-queue.js's jsonLoad);
  // enumerating every Rust-only field here by hand is what let
  // `waveformCacheDir` slip through and break the fallback. Accepting
  // unknowns keeps the JS fallback launchable no matter what Rust-only
  // field is added next — the fields the JS scanner actually reads are
  // still validated above.
  .unknown(true);

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
// V31 AFTER triggers on tracks/artists/albums maintain the FTS5
// index. Not strictly required for V31's design (the triggers don't
// recursively fire other user triggers), but set on as defence-in-
// depth to match initDB() in manager.js. Cheap.
db.exec('PRAGMA recursive_triggers = ON');
// synchronous = NORMAL: crash-safe in WAL — the DB never corrupts; a power
// loss can only lose recently-committed transactions (those in the WAL since
// the last checkpoint), which the next scan re-derives via the mtime/scan_id
// fast-path — and skips the per-COMMIT fsync — a big win for bulk inserts
// and the per-file scan_id bumps a re-scan does over the whole library,
// especially on the HDD/NAS storage this often runs on. Safe here because
// scanner data is re-derivable; the main server connection (manager.js)
// stays on the FULL default for user-data durability.
db.exec('PRAGMA synchronous = NORMAL');
// Keep the FTS5 index + end-of-scan cleanup working set in RAM.
db.exec('PRAGMA cache_size = -65536');   // 64 MB page cache
db.exec('PRAGMA temp_store = MEMORY');

// ── Schema-version guard ────────────────────────────────────────────────────
// Every prepared statement below assumes the server's current schema. If
// this DB isn't at the version the server expects — a half-migrated DB, two
// server instances sharing one DB file, or a scan racing a migration —
// refuse to touch it rather than write misshapen rows or run the stale
// sweep against assumptions that no longer hold. Exit 3 so task-queue's
// close handler logs the failure at error level.
const schemaVersionAtOpen = db.prepare('PRAGMA user_version').get().user_version;
if (Number.isInteger(loadJson.expectedSchemaVersion)
    && schemaVersionAtOpen !== loadJson.expectedSchemaVersion) {
  console.error(
    `Error: DB schema is V${schemaVersionAtOpen} but the server expects ` +
    `V${loadJson.expectedSchemaVersion} — refusing to scan. (Is another ` +
    'mStream instance using this DB, or did a migration race the scan?)');
  db.close();
  process.exit(3);
}

// ── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  // Capture album_id alongside the hashes so we can migrate
  // user_album_stars when a compilation collapses.
  getTrack: db.prepare(
    `SELECT id, modified, file_hash, audio_hash, album_id, lyrics_sidecar_mtime, scan_id
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
  // re-scan so subsequent tracks sharing the album don't drop them. The
  // WHERE guard makes it a no-op (0 rows matched → no row rewrite, no WAL
  // frame) when nothing actually changed — otherwise every track of a
  // shared album rewrites the album row identically. Ports the same guard
  // from the Rust scanner's find_or_create_album. Bind order:
  // display, comp, id, comp, display, display.
  updateAlbumTags: db.prepare(
    `UPDATE albums
        SET album_artist = COALESCE(?, album_artist),
            compilation  = ?
      WHERE id = ?
        AND (compilation IS NOT ? OR (? IS NOT NULL AND album_artist IS NOT ?))`
  ),
  // V34 dropped tracks.genre — the canonical store is the track_genres
  // M2M (populated below via setTrackGenres). Keep the column list AND
  // the DO UPDATE SET list in lock-step with rust-parser's commit_track
  // and the schema.js V1+V24 definitions.
  // V36: tracks.source records provenance (e.g. 'ytdl'). Extracted from
  // embedded tags by detectSource() in parseMyFile. NULL when no marker
  // is present.
  //
  // UPSERT (ON CONFLICT … DO UPDATE), not INSERT OR REPLACE: a REPLACE on
  // the UNIQUE(filepath, library_id) conflict is a DELETE + INSERT, which
  // fires both the FTS5 AFTER DELETE and AFTER INSERT triggers, cascade-
  // deletes track_genres/track_artists, allocates a new rowid, and resets
  // created_at (breaking the V43 "recently added" sort on every tag edit).
  // DO UPDATE keeps the same rowid + created_at and fires only the
  // column-scoped AFTER UPDATE trigger — less per-row work under the
  // writer lock. RETURNING id covers both branches (lastInsertRowid is not
  // updated on the UPDATE path), so insertTrack() reads it via .get().
  insertTrack: db.prepare(
    `INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
     disc_number, year, duration, format, file_hash, audio_hash, album_art_file,
     replaygain_track_db, sample_rate, channels, bit_depth,
     lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime,
     bpm, musical_key, bpm_source,
     modified, scan_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filepath, library_id) DO UPDATE SET
       title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
       track_number=excluded.track_number, disc_number=excluded.disc_number, year=excluded.year,
       duration=excluded.duration, format=excluded.format, file_hash=excluded.file_hash,
       audio_hash=excluded.audio_hash, album_art_file=excluded.album_art_file,
       replaygain_track_db=excluded.replaygain_track_db, sample_rate=excluded.sample_rate,
       channels=excluded.channels, bit_depth=excluded.bit_depth,
       lyrics_embedded=excluded.lyrics_embedded, lyrics_synced_lrc=excluded.lyrics_synced_lrc,
       lyrics_lang=excluded.lyrics_lang, lyrics_sidecar_mtime=excluded.lyrics_sidecar_mtime,
       bpm=excluded.bpm, musical_key=excluded.musical_key, bpm_source=excluded.bpm_source,
       modified=excluded.modified, scan_id=excluded.scan_id, source=excluded.source
     RETURNING id`
  ),
  // V17: M2M artist-link maintenance. Album-artists use INSERT OR IGNORE
  // so the same album getting re-walked by multiple tracks doesn't pile
  // up duplicate rows. Track-artists AND track-genres are cleared first
  // and repopulated — this is load-bearing under the UPSERT insertTrack
  // (which keeps the same track_id and so does NOT cascade-drop them the
  // way the old INSERT OR REPLACE did); without the explicit DELETEs a
  // tag edit that drops an artist/genre would leak the stale M2M row.
  insertAlbumArtist: db.prepare(
    `INSERT OR IGNORE INTO album_artists (album_id, artist_id, role, position)
     VALUES (?, ?, ?, ?)`
  ),
  deleteTrackArtists: db.prepare(
    'DELETE FROM track_artists WHERE track_id = ?'
  ),
  deleteTrackGenres: db.prepare(
    'DELETE FROM track_genres WHERE track_id = ?'
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
  // (The stale-track sweep lives in orphan-cleanup.js's deleteStaleTracks
  // — chunked, yielding, and schema-guard-aware — not a prepared
  // statement here.)
  // Used by the data-loss guard in run(): how many tracks does this
  // library have on record? A walk that yields zero files against a
  // library that still has rows is the signature of a vanished mount.
  countLibraryTracks: db.prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?'
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
    const disp = albumArtistDisplay || null;
    const comp = isCompilation ? 1 : 0;
    stmts.updateAlbumTags.run(disp, comp, row.id, comp, disp, disp);
    return row.id;
  }
  const result = stmts.insertAlbum.run(
    name, artistId, year, albumArtFile || null,
    albumArtistDisplay || null, isCompilation ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}

function setTrackGenres(trackId, genreInput) {
  if (!genreInput) { return; }
  // music-metadata returns common.genre as `string[]` always — even for a
  // single-value TCON / Vorbis GENRE tag, it's wrapped in a one-element
  // array. The Rust scanner sees a single concatenated string from
  // Lofty's tag.genre(), so it splits on `[,;/]` directly. Normalise to
  // a joined string here so both scanners produce the same track_genres
  // rows from the same input — joining with `;` keeps multi-value
  // arrays (e.g. ["Rock", "Jazz"]) round-trippable through the same
  // splitter that handles legacy single-string tags written by older
  // taggers (e.g. "Rock;Jazz" / "Rock/Jazz" / "Rock,Jazz").
  //
  // Without this normalisation a multi-genre track from music-metadata
  // would throw `genreStr.split is not a function` and the whole file
  // would log a per-file processing warning, dropping all genre rows
  // for that track silently.
  const text = Array.isArray(genreInput) ? genreInput.join(';') : String(genreInput);
  const genres = text.split(/[,;\/]/).map(g => g.trim()).filter(g => g.length > 0);
  for (const name of genres) {
    let row = stmts.findGenre.get(name);
    if (!row) {
      const result = stmts.insertGenre.run(name);
      row = { id: Number(result.lastInsertRowid) };
    }
    stmts.insertTrackGenre.run(trackId, row.id);
  }
}

// V36 provenance detection moved to src/db/source-detect.js so the
// readback helper can be imported by tests without spinning up the
// scanner's CLI-arg parser.

// File hashing moved to src/db/audio-hash.js (returns both file_hash and
// audio_hash in a single pass).

// ── Album art ───────────────────────────────────────────────────────────────

const mapOfDirectoryAlbumArt = {};

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // Check embedded picture
  if (songInfo.picture && songInfo.picture[0]) {
    // Hash the raw image bytes. The previous `.toString('utf-8')` round-
    // tripped binary data through a lossy UTF-8 decode (every invalid
    // byte sequence → U+FFFD before re-encoding), so the digest was
    // neither the true MD5 of the image nor what the Rust scanner
    // produces (it hashes raw bytes via Md5::digest). Two distinct
    // covers could collide onto one filename, and the JS and Rust
    // scanners named the same cover differently. See save_embedded_art
    // in rust-parser/src/main.rs.
    const picHashString = crypto.createHash('md5')
      .update(songInfo.picture[0].data)
      .digest('hex');
    songInfo.aaFile = picHashString + '.' + pictureExt(songInfo.picture[0].format);

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

  // Raw bytes — see the note in getAlbumArt on why .toString() was wrong.
  const picHashString = crypto.createHash('md5').update(imageBuffer).digest('hex');
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

// Map an embedded picture's MIME type to a file extension, mirroring the
// Rust scanner's mime_to_ext (rust-parser/src/main.rs) so both scanners
// name the same embedded cover identically. Note this returns 'jpeg'
// (not mime-types' 'jpg') for image/jpeg, matching lofty's MimeType→ext,
// and falls back to 'jpeg' for anything unrecognised — same as Rust.
function pictureExt(format) {
  switch (String(format || '').toLowerCase()) {
    case 'image/png':  return 'png';
    case 'image/tiff': return 'tiff';
    case 'image/bmp':  return 'bmp';
    case 'image/gif':  return 'gif';
    case 'image/jpeg':
    case 'image/jpg':
    default:           return 'jpeg';
  }
}

// ── Parse a single file ─────────────────────────────────────────────────────

async function parseMyFile(absolutePath, modified) {
  let songInfo;
  let parsedNative = null;
  try {
    const parsed = await parseFile(absolutePath, { skipCovers: loadJson.skipImg });
    parsedNative = parsed.native;
    songInfo = parsed.common;
    songInfo.duration = parsed.format?.duration || null;
    // OpenSubsonic extended audio-format fields. music-metadata exposes
    // these as part of parsed.format — store what's available; missing
    // values stay NULL and clients just don't render the corresponding
    // quality badge.
    songInfo.sampleRate = Number.isFinite(parsed.format?.sampleRate) ? parsed.format.sampleRate : null;
    songInfo.channels   = Number.isFinite(parsed.format?.numberOfChannels) ? parsed.format.numberOfChannels : null;
    songInfo.bitDepth   = Number.isFinite(parsed.format?.bitsPerSample) ? parsed.format.bitsPerSample : null;
    // V32: BPM + musical key from embedded tags. music-metadata exposes
    // TBPM / Vorbis BPM / MP4 tmpo as common.bpm (number) and TKEY /
    // INITIALKEY as common.key (string). The Rust scanner mirrors this
    // via Lofty's ItemKey::Bpm / ItemKey::InitialKey — both code paths
    // must produce the same column values for the parity test.
    songInfo.bpm = (() => {
      if (parsed.common?.bpm == null) { return null; }
      const n = Math.round(Number(parsed.common.bpm));
      // Range matches velvet's tag-extraction window. < 20 / > 300 are
      // almost certainly malformed; storing them just pollutes the
      // future BPM-continuity filter.
      return Number.isFinite(n) && n >= 20 && n <= 300 ? n : null;
    })();
    songInfo.musicalKey = (() => {
      const k = parsed.common?.key;
      if (typeof k !== 'string') { return null; }
      const trimmed = k.trim().slice(0, 12);
      return trimmed.length > 0 ? trimmed : null;
    })();
    songInfo.bpmSource = (songInfo.bpm != null || songInfo.musicalKey != null) ? 'tag' : null;
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

  // V36: provenance from embedded tags. Detected from the native tag
  // namespace (TXXX / Vorbis comments / MP4 freeform atoms), which sits
  // outside the music-metadata 'common' mapping. NULL when no marker is
  // present.
  songInfo.source = detectSource({ native: parsedNative });

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
  // .get() (not .run()) because the UPSERT carries `RETURNING id` — that's
  // the only branch-agnostic way to get the rowid (lastInsertRowid is not
  // updated on the DO UPDATE path).
  const row = stmts.insertTrack.get(
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
    // V34: tracks.genre dropped — setTrackGenres (below) populates the M2M.
    song.replaygain_track_gain?.dB || null,
    song.sampleRate || null,
    song.channels || null,
    song.bitDepth || null,
    li.lyricsEmbedded,
    li.lyricsSyncedLrc,
    li.lyricsLang,
    li.lyricsSidecarMtime,
    song.bpm ?? null,
    song.musicalKey ?? null,
    song.bpmSource ?? null,
    song.modified,
    loadJson.scanId,
    song.source ?? null
  );
  const trackId = Number(row.id);

  // Clear track_genres first — load-bearing under UPSERT (same track_id is
  // kept, so the old genres are NOT cascade-dropped). setTrackGenres only
  // INSERTs OR IGNOREs, so a removed genre would otherwise leak.
  stmts.deleteTrackGenres.run(trackId);
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

  // track_artists: clear first, then repopulate. Load-bearing under the
  // UPSERT (same track_id kept, so prior rows are NOT cascade-dropped the
  // way the old INSERT OR REPLACE did).
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

// ── Directory walk ──────────────────────────────────────────────────────────

let fileCount = 0;      // new/modified files parsed
let totalProcessed = 0; // all files SUCCESSFULLY touched (including unchanged)
let errorCount = 0;     // per-file failures — counted separately so the
                        // scanComplete filesScanned matches the Rust
                        // contract (visited = processed + unchanged +
                        // errors) while totalProcessed stays success-only
                        // for the zero-successful-files data-loss guard.
// Cadence (in files) for flushing the unchanged-file batch and refreshing
// the progress row. Lower = more responsive API writes during scans but more
// COMMIT overhead. Admin-configurable via scanCommitInterval; default (25)
// is a balanced starting point.
const COMMIT_INTERVAL = loadJson.scanCommitInterval || 25;

// Write-batch state. The cheap scan_id bumps for unchanged files are batched
// under one transaction (flushed every COMMIT_INTERVAL files) for
// throughput. A changed file's parseMyFile (read + tag parse + hash +
// album-art I/O) is slow, so processFile flushes the batch — releasing the
// single SQLite write lock — BEFORE parsing it, then writes that one track
// in its own tight transaction. This keeps the write lock free during every
// decode so a concurrent API write can't block for the length of one.
// Mirrors the Rust scanner's extract-outside-the-transaction restructure.
// BEGIN IMMEDIATE, not deferred: a batch's first statement can be a read
// (getTrack runs before the batch's first write on some paths), and a
// deferred BEGIN would pin a read snapshot that a server commit landing
// before our first write invalidates — the lock upgrade then fails with
// SQLITE_BUSY_SNAPSHOT, which bypasses the 5s busy_timeout entirely (the
// same failure class src/db/manager.js transaction() was converted to
// IMMEDIATE for). IMMEDIATE takes the write lock up front where the busy
// handler IS honored.
let batchOpen = false;
let batchStartMs = 0;
function ensureBatch() {
  if (!batchOpen) {
    db.exec('BEGIN IMMEDIATE');
    batchOpen = true;
    batchStartMs = Date.now();
  }
}
// A COMMIT failure here means the transaction is gone (SQLite auto-rolls
// back on FULL/IOERR/NOMEM) or unusable — either way batchOpen must NOT
// stay true, or every later flush throws "no transaction active" and the
// real cause gets buried under per-file warnings. Reset the flag, attempt
// a defensive ROLLBACK, and rethrow marked fatal so processFile's
// per-file catch lets it bubble to run()'s scan-failure path instead of
// swallowing it file by file.
function flushBatch() {
  if (!batchOpen) { return; }
  try {
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    batchOpen = false;
    e.fatalScanError = true;
    throw e;
  }
  batchOpen = false;
}
// Wall-clock cap on how long the fast-path batch may hold the write lock:
// getTrack + the cached sidecar probe run inside the open transaction, and
// on a degraded NAS a cold readdirSync can block for seconds per directory
// while the lock is held. Mirrors the Rust writer's COMMIT_BUDGET_MS.
const COMMIT_BUDGET_MS = 50;

// Per-scan, per-directory filename listing cache for sidecar probing.
// The fast-path probes sidecar mtime for every file on every scan; this
// cache turns ~22 statSync calls per file into one readdirSync per
// directory. Mirrors the Rust scanner's dir_file_cache / DirListing.
const dirListingCache = new Map();

// When `followSymlinks` is false (default), use lstatSync so symlink
// entries are seen AS symlinks (isFile/isDirectory both false) and
// skipped. When true, use statSync to follow symlinks to their target.
// Library root is always followed (readdirSync operates on the target
// of a root-level symlink); this only governs nested entries.
const statForWalk = loadJson.followSymlinks
  ? fs.statSync
  : fs.lstatSync;

// Real directory paths already visited — used ONLY when following
// symlinks, to break cycles (dir A → symlink → dir B → symlink → dir A).
// Without it, statSync follows the loop forever and the walk recurses
// until the stack overflows. walkdir gives the Rust scanner cycle
// detection for free; we track realpaths ourselves. null (the default
// no-follow case) means no tracking is needed — symlinks are skipped.
const visitedDirs = loadJson.followSymlinks ? new Set() : null;

// Single-pass walk: collect every supported audio file (with its
// walk-time mtime) into `out`. Replaces the old two-pass approach
// (countSupportedFiles to size the progress bar, then a second walk to
// scan), which stat'd the whole tree twice — costly on network mounts.
// The Rust scanner likewise collects its entries once and reuses them.
function collectFiles(dir, out) {
  if (visitedDirs) {
    let real;
    try { real = fs.realpathSync(dir); } catch (_e) { return; }
    if (visitedDirs.has(real)) { return; }   // symlink cycle — already walked
    visitedDirs.add(real);
  }
  let files;
  try { files = fs.readdirSync(dir); } catch (_err) { return; }
  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    // A symlink entry under lstatSync has isFile()=false AND
    // isDirectory()=false, so it falls through both branches and is
    // silently skipped — no-follow by default.
    try { stat = statForWalk(filepath); } catch (_e) { continue; }
    if (stat.isDirectory()) {
      collectFiles(filepath, out);
    } else if (stat.isFile() && loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
      out.push({ filepath, mtime: stat.mtime.getTime() });
    }
  }
}

// Is `p` an accessible directory right now? Used by the data-loss guard
// to tell a vanished mount apart from a legitimately-emptied library.
function isAccessibleDir(p) {
  try { return fs.statSync(p).isDirectory(); }
  catch (_) { return false; }
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

async function processFile(filepath, fileMtime) {
  try {
    const relativePath = path.relative(loadJson.directory, filepath).replace(/\\/g, '/');
    const existing = stmts.getTrack.get(relativePath, loadJson.libraryId);

    // Resume fast-path: a row already stamped with the CURRENT scan id was
    // re-parsed in an earlier pass of this same rescan epoch — the boot
    // migration rescan reuses one scan id across restarts (see
    // task-queue.js), so skip it without re-parsing (and without the
    // sidecar probe) so a resumed rescan stays cheap.
    const alreadyThisEpoch = existing && existing.scan_id === loadJson.scanId;

    // Fast-path: audio file unchanged. Still re-read if a sidecar
    // `.lrc` / `.txt` was edited (drift between stored mtime and
    // on-disk) — sidecars are the only lyrics source the audio
    // file's own mtime doesn't cover. The cached probe reads each
    // directory once instead of ~22 statSync calls per file; skipped
    // for resume-skip rows.
    const sidecarDrifted = alreadyThisEpoch
      ? false
      : (existing?.lyrics_sidecar_mtime || null) !== (sidecarMtimeCached(filepath, dirListingCache) || null);

    if (existing && (alreadyThisEpoch || (existing.modified === fileMtime && !loadJson.forceRescan && !sidecarDrifted))) {
      // Unchanged (mtime fast-path) or already re-parsed this epoch — just
      // (re)assert the scan id (a no-op write when it already carries it).
      // No extraction here, so batch these cheap writes for throughput —
      // but flush first if the open batch has held the lock past its
      // wall-clock budget (the sidecar probes above run inside it, and a
      // cold directory listing on slow storage isn't microseconds).
      if (batchOpen && Date.now() - batchStartMs > COMMIT_BUDGET_MS) { flushBatch(); }
      ensureBatch();
      stmts.updateScanId.run(loadJson.scanId, existing.id);
    } else {
      // New or modified file. Capture the prior identity, then FLUSH the
      // fast-path batch so the write lock is released BEFORE the slow parse
      // below — a concurrent API write must not block for a decode's length.
      //
      // NOTE: we intentionally do NOT DELETE the old tracks row before
      // calling parseMyFile. If the parse throws (malformed tags, disk
      // error, locked file), the old row stays intact and the user's
      // user_metadata / bookmarks / play-queue entries keyed off the old
      // hash are preserved. The UPSERT in insertTrack updates the old row
      // in place (same rowid and created_at; stale track_artists /
      // track_genres rows are removed by its explicit DELETEs, not a
      // REPLACE cascade) and only runs after parseMyFile has returned a
      // complete songInfo — until then, no write touches the row at all.
      const oldFileHash  = existing ? existing.file_hash  : null;
      const oldAudioHash = existing ? existing.audio_hash : null;
      const oldAlbumId   = existing ? existing.album_id   : null;

      flushBatch();
      const songInfo = await parseMyFile(filepath, fileMtime);   // no txn held

      // Write this one track in its own tight transaction: the lock is held
      // only for the synchronous DB writes, and a mid-write failure rolls
      // back just this track (no half-written row) — the JS analogue of the
      // Rust writer's per-song savepoint. IMMEDIATE for the same
      // SQLITE_BUSY_SNAPSHOT reason as ensureBatch above (insertTrack's
      // first statement is a cache-miss artist SELECT on many paths).
      db.exec('BEGIN IMMEDIATE');
      try {
        const { albumId: newAlbumId } = insertTrack(songInfo);
        // User-facing tables key on canonical hash — audio_hash when we have
        // it, file_hash otherwise. A tag edit changes file_hash but keeps
        // audio_hash stable, so most rescans have nothing to migrate.
        const oldCanon = oldAudioHash || oldFileHash;
        const newCanon = songInfo.audioHash || songInfo.hash;
        if (oldCanon && newCanon && oldCanon !== newCanon) {
          migrateHashReferences(oldCanon, newCanon);
        }
        // V17: when a compilation collapses (or any album_id change caused by
        // the album-artist semantic shift), migrate this user's album stars
        // from the old fragment to the canonical row.
        if (oldAlbumId && newAlbumId && oldAlbumId !== newAlbumId) {
          migrateAlbumStars(db, oldAlbumId, newAlbumId);
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
      fileCount++;
    }

    // Track all files (including unchanged) for progress
    totalProcessed++;

    // Periodically flush the fast-path batch (bounding how long it holds the
    // write lock) and refresh the progress row.
    if (totalProcessed % COMMIT_INTERVAL === 0) {
      flushBatch();
      try { progressStmts.update.run(totalProcessed, relativePath, loadJson.scanId); } catch (_) {}
    }
  } catch (err) {
    // A failed batch COMMIT is not a per-file problem — the transaction
    // machinery itself broke (disk full, I/O error). Let it bubble to
    // run()'s catch so the scan fails loudly instead of warning once per
    // remaining file.
    if (err.fatalScanError) { throw err; }
    errorCount++;
    console.error(`Warning: failed to process ${filepath}: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  // ── Upfront data-loss guard (mirror of rust-parser/src/main.rs) ──────
  // If the library root isn't an accessible directory, a transient
  // CIFS/NFS mount outage is the likely cause. Walking it would yield
  // zero files, and the stale-cleanup DELETE below would then wipe every
  // track for this library — cascading through albums, artists, and
  // user_album_stars. Bail before any destructive write. We check the
  // library root (not the subtree), exactly like the Rust scanner: a
  // missing subtree under a healthy root is harmless because subtree
  // scans never run the cleanup pass.
  if (!isAccessibleDir(loadJson.directory)) {
    console.error(`Scan failed: library directory not accessible: ${loadJson.directory}`);
    try { db.close(); } catch (_) {}
    process.exitCode = 1;
    return;
  }

  try {
    // Resolve the actual scan root. Subtree mode joins directory +
    // subtree (path.join handles both separators on Windows). Empty
    // subtree falls through to the whole-library root — legacy
    // behaviour preserved for every existing caller.
    const subtreeMode = typeof loadJson.subtree === 'string' && loadJson.subtree.length > 0;
    const scanRoot = subtreeMode
      ? path.join(loadJson.directory, loadJson.subtree)
      : loadJson.directory;
    if (subtreeMode) {
      console.log(`Scanning subtree ${scanRoot} (under library ${loadJson.directory})...`);
    } else {
      console.log(`Scanning ${loadJson.directory}...`);
    }

    // Single walk: collect supported files (with walk-time mtime) so we
    // don't stat the whole tree twice. files.length is the progress-bar
    // expected count.
    const files = [];
    collectFiles(scanRoot, files);
    try {
      progressStmts.insert.run(loadJson.scanId, loadJson.libraryId, loadJson.vpath || '', files.length || null);
    } catch (_) {}

    // No single transaction wraps the whole walk now: processFile batches
    // the cheap unchanged-file scan_id bumps but commits and releases the
    // write lock before parsing each changed file, so the lock is never held
    // across a slow decode. Flush the trailing fast-path batch after the
    // walk. (Mirrors the Rust scanner's extract-outside-the-transaction
    // restructure.)
    for (const f of files) {
      await processFile(f.filepath, f.mtime);
    }
    flushBatch();

    // ── Post-walk data-loss guards ──────────────────────────────────
    // (a) The walk FOUND files but not one processed successfully —
    // systemic failure (permissions flip, disk fault, broken dependency),
    // not 600 coincidentally-corrupt files. No row got its scan_id
    // bumped, so the stale sweep would delete the entire library. Skip
    // all cleanup and mark the scan failed.
    if (!subtreeMode && files.length > 0 && totalProcessed === 0) {
      console.error(
        `Error: walk found ${files.length} files but every one failed to ` +
        'process — skipping stale-track cleanup; scan marked failed.');
      process.exitCode = 1;
      return;
    }

    // (b) The upfront check passed but the walk still produced zero files
    // while the library has tracks on record — the mount most likely
    // vanished mid-scan. Re-check: gone → skip cleanup (outage); still
    // accessible → the user genuinely emptied the directory, so fall
    // through and let the stale-cleanup run. Mirrors rust-parser's
    // run_scan. SKIPPED in subtree mode (it never deletes anything).
    if (!subtreeMode && totalProcessed === 0) {
      const priorCount = stmts.countLibraryTracks.get(loadJson.libraryId)?.n || 0;
      if (priorCount > 0 && !isAccessibleDir(loadJson.directory)) {
        console.error(
          `Warning: scan processed 0 files and directory is no longer accessible ` +
          `(${loadJson.directory}). Library had ${priorCount} tracks — skipping ` +
          `cleanup to avoid data loss.`
        );
        console.log(JSON.stringify({
          event: 'scanComplete',
          filesProcessed: 0, filesUnchanged: 0, filesScanned: 0, staleEntriesRemoved: 0,
        }));
        return;
      }
    }

    // Re-check the schema version before the scan's only destructive
    // phase. If a migration ran mid-scan (a second server instance, or a
    // boot racing this scanner after its parent died), what `scan_id != ?`
    // selects may have changed under us — bail without sweeping rather
    // than delete rows under stale assumptions. deleteStaleTracks also
    // re-verifies before EVERY chunk (the sweep is many autocommit
    // transactions with deliberate yields between them).
    const schemaVersionNow = db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersionNow !== schemaVersionAtOpen) {
      console.error(
        `Error: DB schema changed mid-scan (V${schemaVersionAtOpen} -> ` +
        `V${schemaVersionNow}) — skipping stale-track cleanup.`);
      process.exitCode = 3;
      return;
    }

    // Remove tracks that weren't seen in this scan (deleted files).
    // SKIPPED in subtree mode — tracks outside the subtree share the
    // library_id but have an older scan_id, and wiping them would be a
    // data-loss bug. Stale cleanup runs only when we've actually
    // walked the whole library.
    // CHUNKED stale-track sweep (see deleteStaleTracks) so the writer lock
    // is released — with a real 10-20ms yield — between batches instead of
    // held for the whole cascade + FTS delete-trigger run. Runs in
    // autocommit here (the fast-path batch was flushed above), so each
    // chunk is its own transaction.
    const deleted = subtreeMode
      ? { changes: 0 }
      : { changes: deleteStaleTracks(db, loadJson.libraryId, loadJson.scanId, schemaVersionAtOpen) };
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
      // visited = processed + unchanged + per-file errors — same contract
      // as the Rust emitter, whose total_processed increments on the Err
      // arm too.
      filesScanned: totalProcessed + errorCount,
      staleEntriesRemoved: deleted.changes
    }));

    // Clean up orphaned artists, albums, and genres. SKIPPED in
    // subtree mode (we didn't delete any tracks, so nothing newly
    // orphaned). Whole-library scans still perform this cleanup.
    // yieldBetweenChunks: we are a dedicated scanner process, so the
    // inter-chunk sleep costs nothing and gives concurrent server
    // writes a real window during big cleanups.
    // expectedSchemaVersion: the orphan loops are the widest inter-chunk
    // windows of the whole scan (three chunked DELETEs with 10-20ms
    // yields) — re-verify per chunk for the same reason the stale sweep
    // does.
    if (!subtreeMode) {
      cleanupOrphans(db, {
        yieldBetweenChunks: true,
        expectedSchemaVersion: schemaVersionAtOpen,
      });
    }
  } catch (err) {
    console.error('Scan failed');
    console.error(err.stack);
    // Rollback any open transaction to release the write lock
    try { db.exec('ROLLBACK'); } catch (_) {}
    // A failed scan must not exit 0 — task-queue's close handler keys its
    // failure logging (and the boot-rescan resume marker) off the code.
    // The schema guard's mid-sweep abort maps to exit 3, matching the
    // at-open guard and the rust scanner.
    process.exitCode = String(err.message).startsWith('schema-version guard') ? 3 : 1;
  } finally {
    // Always clean up progress row, even on error. Both wrapped: a throw
    // from close() would reject run()'s floating promise and Node's
    // unhandled-rejection default (exit 1) would override an already-set
    // exit code 3 from the schema guard.
    try { progressStmts.remove.run(loadJson.scanId); } catch (_) { /* best-effort */ }
    try { db.close(); } catch (_) { /* already closed */ }
  }
}

run().catch(err => {
  // Backstop — run()'s own catch/finally should make this unreachable,
  // but a rejection here must never override a guard exit code with the
  // generic unhandled-rejection exit.
  console.error(err.stack || String(err));
  process.exitCode = process.exitCode || 1;
});
