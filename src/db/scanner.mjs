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
import { cleanupOrphans, cleanupStaleArt, reconcileAlbumArt, deleteStaleTracks } from './orphan-cleanup.js';
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
  // 'metadata' (default) or 'folder' — which wins when a track has both an
  // embedded picture and a folder image. task-queue.js always sends it; the
  // default keeps standalone / older invocations working.
  albumArtPriority: Joi.string().valid('metadata', 'folder').default('metadata'),
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
// the last checkpoint), which the next scan re-derives via the mtime
// fast-path — and skips the per-COMMIT fsync — a big win for bulk inserts,
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
  // user_album_stars when a compilation collapses. album_art_file/source
  // ride along so a skipImg re-parse can PRESERVE the row's current
  // default (the parse collects no art under skipImg — without this the
  // UPSERT would refresh the default to NULL while the junction rows
  // survive; the V49 forced rescan would wipe every skipImg user's art).
  getTrack: db.prepare(
    `SELECT id, modified, file_hash, audio_hash, album_id, lyrics_sidecar_mtime, scan_id,
            album_art_file, album_art_source
       FROM tracks WHERE filepath = ? AND library_id = ?`
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
    `INSERT INTO albums (name, artist_id, year, album_art_file, album_art_source, album_artist, compilation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  // album_art_source rides alongside album_art_file: when we fill a
  // previously-art-less album we also record where the art came from.
  updateAlbumArt: db.prepare(
    'UPDATE albums SET album_art_file = ?, album_art_source = ? WHERE id = ? AND album_art_file IS NULL'
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
  //
  // V48 pin-respect: album_art_file/album_art_source keep their EXISTING
  // values when the user pinned the default (album_art_pinned = 1, set by
  // the manual set-default flow) — a rescan must not re-elect over a
  // human's explicit choice. The CASE reads the pre-image row ("tracks."
  // qualifies the existing row inside DO UPDATE). album_art_pinned itself
  // is never scanner-written. Mirror of the rust UPSERT.
  insertTrack: db.prepare(
    `INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, track_number,
     disc_number, year, duration, format, file_hash, audio_hash, album_art_file, album_art_source,
     replaygain_track_db, sample_rate, channels, bit_depth, bitrate, file_size,
     track_total, disc_total,
     lyrics_embedded, lyrics_synced_lrc, lyrics_lang, lyrics_sidecar_mtime,
     bpm, musical_key, bpm_source,
     modified, scan_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filepath, library_id) DO UPDATE SET
       title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
       track_number=excluded.track_number, disc_number=excluded.disc_number, year=excluded.year,
       duration=excluded.duration, format=excluded.format, file_hash=excluded.file_hash,
       audio_hash=excluded.audio_hash,
       album_art_file=CASE WHEN tracks.album_art_pinned = 1 THEN tracks.album_art_file ELSE excluded.album_art_file END,
       album_art_source=CASE WHEN tracks.album_art_pinned = 1 THEN tracks.album_art_source ELSE excluded.album_art_source END,
       replaygain_track_db=excluded.replaygain_track_db, sample_rate=excluded.sample_rate,
       channels=excluded.channels, bit_depth=excluded.bit_depth,
       bitrate=excluded.bitrate, file_size=excluded.file_size,
       track_total=excluded.track_total, disc_total=excluded.disc_total,
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
  // ── Multi-art (V48) ──────────────────────────────────────────────────
  // art_files is deduped per kind: cached by cache_file, reference by
  // (library_id, rel_path). INSERT OR IGNORE + a follow-up SELECT resolves
  // the id whether the row is new or pre-existing. content_hash/byte_size
  // (V50) ride on the insert; healArt fills them on the OR IGNORE no-op
  // path for pre-V50 rows (IS-NULL guarded → zero WAL churn once filled).
  insertArtCached: db.prepare(
    "INSERT OR IGNORE INTO art_files (kind, cache_file, content_hash, byte_size) VALUES ('cached', ?, ?, ?)"
  ),
  findArtCached: db.prepare(
    "SELECT id FROM art_files WHERE kind = 'cached' AND cache_file = ?"
  ),
  insertArtRef: db.prepare(
    "INSERT OR IGNORE INTO art_files (kind, library_id, rel_path, content_hash, byte_size) VALUES ('reference', ?, ?, ?, ?)"
  ),
  findArtRef: db.prepare(
    "SELECT id FROM art_files WHERE kind = 'reference' AND library_id = ? AND rel_path = ?"
  ),
  healArt: db.prepare(
    `UPDATE art_files SET content_hash = ?, byte_size = COALESCE(byte_size, ?)
      WHERE id = ? AND content_hash IS NULL`
  ),
  // Cleared + repopulated per parsed track, like track_genres/track_artists
  // above — the UPSERT keeps the track_id, so stale links don't cascade away.
  deleteTrackArt: db.prepare(
    'DELETE FROM track_art WHERE track_id = ?'
  ),
  insertTrackArt: db.prepare(
    'INSERT OR IGNORE INTO track_art (track_id, art_id, source, picture_type, position) VALUES (?, ?, ?, ?, ?)'
  ),
  insertAlbumArt: db.prepare(
    'INSERT OR IGNORE INTO album_art (album_id, art_id, source, picture_type, position) VALUES (?, ?, ?, ?, ?)'
  ),
};

// Cached VA-row id — looked up once per scan, seeded by migration V17.
const variousArtistsId = stmts.findVariousArtists.get()?.id || null;

// V50: rel_path → content_hash for this library's reference art rows,
// snapshotted at scan start (mirror of the rust scanner's
// load_reference_hashes). A folder image whose hash is already known is
// never re-read — repeat scans only pay file reads for NEW images (and
// for pre-V50 NULL rows, which heal once). NULL hashes are stored as
// absent so the read path retries them.
const knownRefHashes = new Map(
  db.prepare(
    "SELECT rel_path, content_hash FROM art_files WHERE kind = 'reference' AND library_id = ?",
  ).all(loadJson.libraryId)
    .filter((r) => r.content_hash != null)
    .map((r) => [r.rel_path, r.content_hash]));

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

function findOrCreateAlbum(name, artistId, year, albumArtFile, albumArtSource, albumArtistDisplay, isCompilation) {
  if (!name) { return null; }
  const row = stmts.findAlbum.get(name, artistId, year);
  if (row) {
    // Re-asserting album metadata on every scan keeps the display string
    // and compilation flag fresh if the user edits the tag and rescans.
    if (albumArtFile) { stmts.updateAlbumArt.run(albumArtFile, albumArtSource || null, row.id); }
    const disp = albumArtistDisplay || null;
    const comp = isCompilation ? 1 : 0;
    stmts.updateAlbumTags.run(disp, comp, row.id, comp, disp, disp);
    return row.id;
  }
  const result = stmts.insertAlbum.run(
    name, artistId, year, albumArtFile || null, albumArtSource || null,
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

// Multi-art (V48): a track can carry many images. We capture ALL of them —
// every embedded picture (CACHED, extracted to albumArtDirectory since it has
// no standalone file) and every image in the track's folder (REFERENCE: we
// point at the file in place, never copy it). One image is elected the DEFAULT
// per albumArtPriority; the default is always CACHED (a folder default gets a
// cached copy) so it serves fast + thumbnailed and feeds the denormalized
// tracks/albums.album_art_file pointer every reader uses. getAlbumArt builds
// songInfo.artList (descriptors) + sets aaFile/aaSource; linkArt() writes the
// art_files + junction rows from insertTrack.
//
// Pinned-default survival across rescans is a Phase-3 concern (nothing pins
// art yet) — this scanner re-elects the default on every scan.

const FOLDER_PRIORITY = ['folder.jpg', 'cover.jpg', 'album.jpg', 'front.jpg', 'folder.png', 'cover.png', 'album.png', 'front.png'];
// Per-directory image listing, cached so every track in a folder reuses it.
const folderImagesByDir = {};

function folderType(fileName) {
  const base = fileName.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  if (['front', 'cover', 'folder', 'album'].includes(base)) { return 'front'; }
  if (base === 'back') { return 'back'; }
  if (base.startsWith('artist')) { return 'artist'; }
  return null;
}

// Mirrors normalize_pic_type in rust-parser: front / back / artist (APIC
// types 7, 8, 10, 19 via music-metadata's labels) / 'other' for everything
// else INCLUDING an absent type — lofty always reports a type (Other when
// the tag carried none, e.g. every m4a covr atom), so 'other' here keeps
// the parity snapshot identical.
function normEmbeddedType(t) {
  if (!t) { return 'other'; }
  if (/front/i.test(t)) { return 'front'; }
  if (/back/i.test(t)) { return 'back'; }
  if (/artist|performer|band/i.test(t)) { return 'artist'; }
  return 'other';
}

// All jpg/png images in absDir, priority-cover names first (in priority order),
// then the rest alphabetically — so [0] is the best default candidate.
// `relDir` is the library-relative directory ('' at the root) — each entry
// carries its relPath (the reference identity) and, V50, its content hash:
// taken from the scan-start snapshot when a previous scan already hashed
// this rel_path, read+hashed once otherwise (read failure → null, fail
// open). Per-directory cache means once per directory per scan.
function listFolderImages(absDir, relDir) {
  if (folderImagesByDir[absDir]) { return folderImagesByDir[absDir]; }
  let files;
  try { files = fs.readdirSync(absDir); } catch (_e) { folderImagesByDir[absDir] = []; return folderImagesByDir[absDir]; }
  const imgs = [];
  for (const fileName of files) {
    let stat;
    try { stat = fs.statSync(path.join(absDir, fileName)); } catch (_e) { continue; }
    if (!stat.isFile()) { continue; }
    // Lowercase the extension filter so FOLDER.JPG / Cover.PNG aren't
    // silently dropped (same case-sensitivity bug master fixed in the
    // old single-art path).
    if (!['png', 'jpg'].includes(getFileType(fileName).toLowerCase())) { continue; }
    const relPath = (relDir && relDir !== '.' ? relDir + '/' : '') + fileName;
    let contentHash = knownRefHashes.get(relPath) ?? null;
    let byteSize = null;
    if (!contentHash) {
      try {
        const data = fs.readFileSync(path.join(absDir, fileName));
        contentHash = crypto.createHash('md5').update(data).digest('hex');
        byteSize = data.length;
      } catch (_e) { /* fail open — a later scan heals it */ }
    }
    imgs.push({ fileName, relPath, contentHash, byteSize, type: folderType(fileName) });
  }
  // Cover-named first (priority order), then by LOWERCASED name in plain
  // codepoint order with a raw-name tiebreak. NOT localeCompare: [0]
  // elects the default and the rust scanner must sort identically —
  // ICU collation and rust's byte order disagree for case-straddling
  // names ('Zebra.jpg' vs 'apple.jpg'), which made the two scanners
  // elect DIFFERENT covers. Lowercased-codepoint order agrees between
  // String.prototype.toLowerCase and rust str::to_lowercase.
  imgs.sort((a, b) => {
    const ai = FOLDER_PRIORITY.indexOf(a.fileName.toLowerCase());
    const bi = FOLDER_PRIORITY.indexOf(b.fileName.toLowerCase());
    if (ai !== bi) { return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi); }
    const al = a.fileName.toLowerCase();
    const bl = b.fileName.toLowerCase();
    if (al !== bl) { return al < bl ? -1 : 1; }
    return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  });
  folderImagesByDir[absDir] = imgs;
  return imgs;
}

async function getAlbumArt(songInfo) {
  songInfo.artList = [];
  songInfo.aaFile = undefined;
  songInfo.aaSource = undefined;
  if (loadJson.skipImg === true) { return; }

  const aaDir = loadJson.albumArtDirectory;
  const relDir = path.dirname(songInfo.filePath);
  const absDir = path.join(loadJson.directory, relDir);

  // Embedded pictures (all) — each must be cached. Hash the RAW image
  // bytes (a lossy .toString('utf-8') round-trip used to corrupt the
  // digest — every invalid byte sequence → U+FFFD — so two distinct
  // covers could collide and the JS/Rust scanners named the same cover
  // differently), and name via pictureExt so both scanners cache the
  // same picture identically (see cache_art_bytes in rust-parser).
  const embedded = [];
  for (const pic of (Array.isArray(songInfo.picture) ? songInfo.picture : [])) {
    if (!pic || !pic.data) { continue; }
    const hash = crypto.createHash('md5').update(pic.data).digest('hex');
    embedded.push({
      cacheFile: hash + '.' + pictureExt(pic.format),
      contentHash: hash,
      data: pic.data,
      pictureType: normEmbeddedType(pic.type),
      isFront: /front/i.test(pic.type || ''),
    });
  }

  // Folder images (all) — referenced, except the elected default.
  const folderImgs = listFolderImages(absDir, relDir);

  // Elect the default: best candidate of each source, priority decides.
  const embDef = embedded.find(e => e.isFront) || embedded[0] || null;
  const folDef = folderImgs[0] || null;
  const preferFolder = loadJson.albumArtPriority === 'folder';
  const defaultIsFolder = preferFolder ? !!folDef : (!embDef && !!folDef);
  const defaultIsEmbedded = preferFolder ? (!folDef && !!embDef) : !!embDef;

  // Cache every embedded picture → cached descriptor. A picture whose
  // cache write FAILS is dropped from the set entirely and can't be the
  // default — mirrors the rust scanner, where cache_art_bytes returning
  // None skips both (a default whose file doesn't exist would 404).
  const cachedOk = new Set();
  for (const e of embedded) {
    const p = path.join(aaDir, e.cacheFile);
    let ok = fs.existsSync(p);
    if (!ok) { try { fs.writeFileSync(p, e.data); ok = true; } catch (_e) { /* drop on failed write */ } }
    if (!ok) { continue; }
    cachedOk.add(e.cacheFile);
    songInfo.artList.push({ kind: 'cached', cacheFile: e.cacheFile, source: 'embedded', pictureType: e.pictureType,
      contentHash: e.contentHash, byteSize: e.data.length });
  }

  // Folder images: the elected default is cached (a copy); the rest are
  // references pointing at the file in place. An elected default whose
  // read or cache write fails falls back to a plain reference with no
  // default elected — same as the rust scanner's !cached_default path.
  let defaultBuf = null;
  for (const f of folderImgs) {
    let cachedDefault = false;
    if (defaultIsFolder && f === folDef) {
      let buf = null;
      try { buf = fs.readFileSync(path.join(absDir, f.fileName)); } catch (_e) { /* fall through to reference */ }
      if (buf) {
        // Raw bytes + lowercased extension: same content-addressed cache
        // filename as the rust scanner and across rescans of Folder.JPG.
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        const cacheFile = hash + '.' + getFileType(f.fileName).toLowerCase();
        const p = path.join(aaDir, cacheFile);
        let ok = fs.existsSync(p);
        if (!ok) { try { fs.writeFileSync(p, buf); ok = true; } catch (_e) { /* fall through */ } }
        if (ok) {
          songInfo.artList.push({ kind: 'cached', cacheFile, source: 'folder', pictureType: f.type,
            contentHash: hash, byteSize: buf.length });
          songInfo.aaFile = cacheFile;
          songInfo.aaSource = 'folder';
          defaultBuf = buf;
          cachedDefault = true;
        }
      }
    }
    if (!cachedDefault) {
      songInfo.artList.push({ kind: 'reference', relPath: f.relPath, source: 'folder', pictureType: f.type,
        contentHash: f.contentHash, byteSize: f.byteSize });
    }
  }

  // Embedded default (when a folder image didn't win) — only if its cache
  // write succeeded above.
  if (defaultIsEmbedded && embDef && cachedOk.has(embDef.cacheFile)) {
    songInfo.aaFile = embDef.cacheFile;
    songInfo.aaSource = 'embedded';
    defaultBuf = embDef.data;
  }

  // Promote the default: generate its s/m/l thumbnails.
  if (songInfo.aaFile && defaultBuf) {
    await compressAlbumArt(defaultBuf, songInfo.aaFile);
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }
  // Once per cache file, not once per parsed track: the name is
  // content-addressed, so existing thumbnails are always current. Without
  // this gate every (re)parsed track re-decodes + re-resizes its elected
  // default — an album of N tracks sharing a cover pays N rounds per
  // scan, and the V49 forced rescan would re-encode the whole library.
  if (fs.existsSync(path.join(loadJson.albumArtDirectory, 'zl-' + imgName))) { return; }

  const img = await Jimp.fromBuffer(buff);
  await img.scaleToFit({ w: 256, h: 256 }).write(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await img.scaleToFit({ w: 92, h: 92 }).write(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
}

// Write a track's art set (built by getAlbumArt) into art_files + the
// track_art / album_art junctions. Resolves each descriptor to an art_files
// id (dedup), then links it. The caller (insertTrack) clears this track's
// old links first — the UPSERT keeps the same track_id, so stale rows no
// longer cascade away the way they did under INSERT OR REPLACE. album_art
// uses INSERT OR IGNORE so tracks sharing an album don't pile up duplicates;
// stale album_art (art no longer present) is reaped by the orphan-cleanup pass.
function linkArt(trackId, albumId, artList) {
  if (!Array.isArray(artList) || artList.length === 0) { return; }
  for (let i = 0; i < artList.length; i++) {
    const a = artList[i];
    let artId;
    if (a.kind === 'cached') {
      stmts.insertArtCached.run(a.cacheFile, a.contentHash || null, a.byteSize ?? null);
      artId = stmts.findArtCached.get(a.cacheFile)?.id;
    } else {
      stmts.insertArtRef.run(loadJson.libraryId, a.relPath, a.contentHash || null, a.byteSize ?? null);
      artId = stmts.findArtRef.get(loadJson.libraryId, a.relPath)?.id;
    }
    if (!artId) { continue; }
    // V50 healing: pre-existing rows (the OR IGNORE no-op path) with a
    // NULL hash get ours; the IS-NULL guard in healArt makes this a
    // 0-row no-op once filled.
    if (a.contentHash) { stmts.healArt.run(a.contentHash, a.byteSize ?? null, artId); }
    stmts.insertTrackArt.run(trackId, artId, a.source || null, a.pictureType || null, i);
    if (albumId) { stmts.insertAlbumArt.run(albumId, artId, a.source || null, a.pictureType || null, i); }
  }
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
    // bitrate: music-metadata reports parsed.format.bitrate in bits/sec.
    // Round to whole kbps (then back to bps) so the JS scanner emits the SAME
    // quantised value as the Rust scanner, which derives bitrate from lofty
    // audio_bitrate() — integer kbps — times 1000. Without this the JS path
    // kept sub-kbps precision, so a library scanned by JS vs Rust could show
    // different bitrates for the same file. Header-reported bitrates (CBR,
    // Xing/Info VBR) now match exactly; computed estimates may still differ
    // by ~1 kbps between the two libraries, which is inherent.
    songInfo.bitrate    = Number.isFinite(parsed.format?.bitrate)
      ? Math.round(parsed.format.bitrate / 1000) * 1000 : null;
    // file_size: on-disk byte size. music-metadata doesn't surface it, so
    // stat the file (guarded — it may vanish mid-scan).
    songInfo.fileSize   = (() => { try { return fs.statSync(absolutePath).size; } catch { return null; } })();
    // V45: track / disc totals (common.track.of / common.disk.of).
    // Composer is deferred — it belongs in the track_artists M2M as
    // role='composer' (a follow-up on top of this work).
    songInfo.trackTotal = Number.isFinite(parsed.common?.track?.of) ? parsed.common.track.of : null;
    songInfo.discTotal  = Number.isFinite(parsed.common?.disk?.of)  ? parsed.common.disk.of  : null;
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
    song.aaSource || null,
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
    song.aaSource || null,
    // V34: tracks.genre dropped — setTrackGenres (below) populates the M2M.
    song.replaygain_track_gain?.dB || null,
    song.sampleRate || null,
    song.channels || null,
    song.bitDepth || null,
    song.bitrate ?? null,
    song.fileSize ?? null,
    song.trackTotal ?? null,
    song.discTotal ?? null,
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

  // Multi-art (V48): clear first, then write the full art set + junctions —
  // load-bearing under the UPSERT for the same reason as genres/artists
  // above (a removed embedded picture or renamed folder image must drop its
  // link on re-parse). Skipped wholesale under skipImg: an art-less scan
  // shouldn't strip art data it never collected. The default is already in
  // tracks/albums.album_art_file (set above + via findOrCreateAlbum).
  if (loadJson.skipImg !== true) {
    stmts.deleteTrackArt.run(trackId);
    linkArt(trackId, albumId, song.artList);
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
// Cadence (in files) for refreshing the progress row. Lower = more
// frequent progress updates but more write overhead. Admin-configurable
// via scanCommitInterval; default (25) is a balanced starting point.
const COMMIT_INTERVAL = loadJson.scanCommitInterval || 25;

// Library-relative paths of files this scan accounted for: unchanged
// fast-path hits plus successfully committed (new/modified) files. The
// stale sweep's candidates are the scan-start snapshot rows whose
// filepath is NOT in this set — replacing the old per-row `UPDATE
// tracks SET scan_id = ?` marker, which made a no-op rescan of a
// stable library rewrite EVERY tracks row through the single WAL
// writer just to mark "seen" (and dragged a whole write-batching
// machinery along to make those useless writes cheap enough). With the
// batch gone, an unchanged file's getTrack + sidecar probes run with
// no transaction open and take no writer lock at all.
//
// Keyed by PATH, not row id: processFile reads its row LIVE (getTrack)
// while the sweep candidates come from the scan-start snapshot, and a
// row REPLACEd mid-scan by another writer (a ytdl re-download of an
// existing file) gets a fresh rowid — id-keying would orphan the
// snapshot id and emit a spurious missed-but-alive warning. filepath
// is UNIQUE per library and is the identity the walk actually visits.
// (The rust scanner's seen_ids is id-keyed because its fast-path reads
// from the SAME snapshot map its candidates derive from — ids there
// are consistent by construction.)
//
// Errored files are deliberately NOT marked seen: their rows fall to
// the sweep, whose verify-absence check finds the file on disk and
// keeps them — same outcome as the old unstamped-row path, warning
// included.
const seenPaths = new Set();

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
//
// Walk errors are RECORDED, not silently dropped: an unreadable
// subdirectory (permissions flip, antivirus lock, a mount dying
// mid-walk) means every file under it never reaches `out`, their rows
// never land in the seen-set, and the stale sweep would treat them as
// deleted. Each failed directory becomes a sweep-skip prefix — its rows
// are exempt from this scan's cleanup — so one permanently unreadable
// #recycle-style dir can't freeze cleanup for the rest of the library
// forever. ENOENT failures are benign races (the dir was
// deleted mid-walk; its rows SHOULD sweep) and are not recorded. Detail
// logging is capped; the count always reports. Mirrors the Rust
// scanner's walk-error classification.
let walkErrors = 0;
let walkErrorLogs = 0;
const failedWalkPrefixes = [];
function recordWalkError(dir, err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') { return; } // deletion race — sweepable
  walkErrors++;
  failedWalkPrefixes.push(
    path.relative(loadJson.directory, dir).replace(/\\/g, '/'));
  if (walkErrorLogs < 20) {
    console.error(`Warning: directory walk error (subtree shielded from cleanup): ${dir}: ${err.message}`);
  } else if (walkErrorLogs === 20) {
    console.error('Warning: suppressing further walk-error detail (count continues)');
  }
  walkErrorLogs++;
}
function collectFiles(dir, out) {
  if (visitedDirs) {
    let real;
    try { real = fs.realpathSync(dir); } catch (err) { recordWalkError(dir, err); return; }
    if (visitedDirs.has(real)) { return; }   // symlink cycle — already walked
    visitedDirs.add(real);
  }
  let files;
  try { files = fs.readdirSync(dir); } catch (err) {
    recordWalkError(dir, err);
    return;
  }
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
      // Math.trunc(mtimeMs), NOT stat.mtime.getTime(): Node builds the
      // Date by ROUNDING the fractional ms (dateFromMs adds 0.5) while
      // the Rust scanner's as_millis() TRUNCATES — so getTime() disagrees
      // with Rust by 1ms on ~half of all files, and every Rust↔JS scanner
      // alternation re-parsed half the library off that phantom drift.
      out.push({ filepath, mtime: Math.trunc(stat.mtimeMs) });
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
      // Unchanged (mtime fast-path) or already re-parsed this epoch — no
      // DB write at all: seen-ness lives in the in-memory set the stale
      // sweep consults, so a no-op rescan never takes the writer lock
      // except for the periodic progress updates below.
      seenPaths.add(relativePath);
    } else {
      // New or modified file. Capture the prior identity before the slow
      // parse below — which runs with no transaction open, so a
      // concurrent API write never blocks for a decode's length.
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

      const songInfo = await parseMyFile(filepath, fileMtime);   // no txn held

      // V48: under skipImg the parse collects no art — preserve the row's
      // current default rather than letting the UPSERT refresh it to NULL
      // (mirror of the rust scanner's snapshot-preserve; insertTrack's
      // junction clear is skipImg-gated for the same consistency).
      if (loadJson.skipImg === true && existing) {
        songInfo.aaFile = existing.album_art_file;
        songInfo.aaSource = existing.album_art_source;
      }

      // Write this one track in its own tight transaction: the lock is held
      // only for the synchronous DB writes, and a mid-write failure rolls
      // back just this track (no half-written row) — the JS analogue of the
      // Rust writer's per-song savepoint. IMMEDIATE, not deferred:
      // insertTrack's first statement is a cache-miss artist SELECT on
      // many paths, which would pin a read snapshot before the first
      // write — a server commit landing in that window fails the lock
      // upgrade with SQLITE_BUSY_SNAPSHOT, bypassing the 5s busy_timeout
      // entirely. Same convention as src/db/manager.js transaction().
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
      // A successfully committed file is accounted for; without this the
      // sweep would re-list its directory and warn about a "missed" row.
      // (For brand-new files this is a no-op against the snapshot —
      // unless the snapshot held a REPLACEd row for the same path.)
      seenPaths.add(relativePath);
      fileCount++;
    }

    // Track all files (including unchanged) for progress
    totalProcessed++;

    // Periodically refresh the progress row — on a no-op rescan this
    // autocommit UPDATE is the scan's only writer-lock acquisition.
    if (totalProcessed % COMMIT_INTERVAL === 0) {
      try { progressStmts.update.run(totalProcessed, relativePath, loadJson.scanId); } catch (_) {}
    }
  } catch (err) {
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

    // Scan-start snapshot for the stale sweep: every (id, filepath) this
    // library had BEFORE the walk. Sweep candidates are the snapshot
    // rows whose filepath the walk did not account for — the in-memory
    // replacement for the old per-row scan_id marker. Taken before the
    // walk so rows other writers insert mid-scan (ytdl downloads, which
    // land with scan_id NULL) can never become candidates. (PRE-existing
    // NULL-scan_id rows are a deliberate delta: the old `!=` predicate
    // could never select them, so a ytdl row whose file was deleted
    // leaked in the DB forever — they now converge out like ordinary
    // rows once verify-absence proves the file gone.) Tens of bytes of
    // RAM per track; the Rust scanner already holds a strictly larger
    // per-row snapshot for its mtime fast-path. Subtree scans never
    // sweep, so they skip the snapshot.
    const preScanRows = subtreeMode
      ? []
      : db.prepare(
          'SELECT id, filepath FROM tracks WHERE library_id = ? ORDER BY id'
        ).all(loadJson.libraryId);

    // Single walk: collect supported files (with walk-time mtime) so we
    // don't stat the whole tree twice. files.length is the progress-bar
    // expected count.
    const files = [];
    collectFiles(scanRoot, files);
    try {
      progressStmts.insert.run(loadJson.scanId, loadJson.libraryId, loadJson.vpath || '', files.length || null);
    } catch (_) {}

    // No transaction wraps the walk: an unchanged file writes nothing at
    // all (seen-ness is in-memory) and each changed file is written in
    // its own tight transaction, so the writer lock is never held across
    // a slow decode — and on a no-op rescan it is barely taken at all.
    // (Mirrors the Rust scanner's writer restructure.)
    for (const f of files) {
      await processFile(f.filepath, f.mtime);
    }

    // ── Post-walk data-loss guards ──────────────────────────────────
    // (a) The walk FOUND files but not one processed successfully —
    // systemic failure (permissions flip, disk fault, broken dependency),
    // not 600 coincidentally-corrupt files. Nothing landed in the
    // seen-set, so the stale sweep would treat the entire library as
    // candidates. Skip all cleanup and mark the scan failed.
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
    // boot racing this scanner after its parent died), the table contents
    // our scan-start snapshot was read from may have changed under us —
    // bail without sweeping rather than delete rows under stale
    // assumptions. deleteStaleTracks also re-verifies before EVERY chunk
    // (the sweep is many autocommit transactions with deliberate yields
    // between them).
    const schemaVersionNow = db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersionNow !== schemaVersionAtOpen) {
      console.error(
        `Error: DB schema changed mid-scan (V${schemaVersionAtOpen} -> ` +
        `V${schemaVersionNow}) — skipping stale-track cleanup.`);
      process.exitCode = 3;
      return;
    }

    // (c) Walk errors no longer veto the whole destructive phase: the
    // sweep shields candidates under the failed-walk prefixes
    // individually, and its listing-based presence check fails closed
    // for everything else — so one permanently unreadable directory
    // can't freeze cleanup for the rest of the library forever.
    if (walkErrors > 0 && !subtreeMode) {
      console.error(
        `Warning: ${walkErrors} directory enumeration error(s) during the walk — ` +
        'rows under the affected subtrees are shielded from this scan\'s cleanup');
    }

    // Remove tracks that weren't seen in this scan (deleted files).
    // SKIPPED in subtree mode — tracks outside the subtree share the
    // library_id but were never walked (absent from the seen-set), and
    // wiping them would be a data-loss bug. Stale cleanup runs only when
    // we've actually walked the whole library.
    // Candidates = snapshot rows the walk did not account for, already
    // in id order (the snapshot SELECT orders by id) so chunk boundaries
    // are deterministic. On a no-op rescan of a stable library this set
    // is EMPTY and the sweep does no DB work at all.
    // CHUNKED stale-track sweep (see deleteStaleTracks) so the writer lock
    // is released — with a real 10-20ms yield — between batches instead of
    // held for the whole cascade + FTS delete-trigger run. Each chunk is
    // its own autocommit transaction. libraryRoot/followSymlinks/
    // failedWalkPrefixes feed the verify-absence check: only rows whose
    // file is provably gone get deleted; unseen-but-alive rows are kept;
    // unverifiable rows are left untouched.
    const deleted = subtreeMode
      ? { changes: 0 }
      : { changes: deleteStaleTracks(db,
          preScanRows.filter((r) => !seenPaths.has(r.filepath)), schemaVersionAtOpen,
          { libraryRoot: loadJson.directory, followSymlinks: !!loadJson.followSymlinks,
            failedWalkPrefixes, supportedFiles: loadJson.supportedFiles }) };
    // Structured end-of-scan event — parsed by task-queue.js to decide whether
    // to run the waveform post-processor and to print a human-readable summary.
    // Field shapes mirror the rust-parser's emitter:
    //   filesProcessed       New / modified rows actually written.
    //   filesUnchanged       Cache-hit fast-path skips (file existed in DB and
    //                        mtime matched; no row was written).
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
      staleEntriesRemoved: deleted.changes,
      // Subtrees the scan could not see (their rows were shielded from
      // cleanup) — surfaced so a permanently unreadable directory is
      // operator-visible in the scan summary, not just a stderr line.
      walkErrors
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
      // V48 multi-art: reap art_files rows whose image is verifiably gone
      // from disk (disk is truth — an unlinked image that still exists is
      // KEPT). Runs regardless of skipImg: reaping is about rows whose
      // files vanished, not about capturing new art. The global cached
      // pass only runs on force-rescans (see cleanupStaleArt's
      // includeCacheDir rationale — it would tax every no-op rescan).
      cleanupStaleArt(db, {
        libraryId: loadJson.libraryId,
        libraryRoot: loadJson.directory,
        albumArtDirectory: loadJson.albumArtDirectory,
        includeCacheDir: !!loadJson.forceRescan,
        yieldBetweenChunks: true,
        expectedSchemaVersion: schemaVersionAtOpen,
      });
      // ...and drop album_art links no longer backed by any of the
      // album's tracks (replaced covers — their cache file legitimately
      // stays on disk, so the reaper above can't be the one to do this).
      reconcileAlbumArt(db, {
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
