// Audiobook library scanner.
//
// Invoked by scanner.mjs when the libraries.type column is 'audio-books'.
// The unit of work is a *book*, not a *file*: each subfolder of the
// vpath root is treated as one book, and every supported audio file
// inside that folder is one entry in book_audio_files, ordered by
// natural sort. Chapters span the concatenated timeline so a 5-MP3
// book has chapters that index into "the whole thing", not per-file.
//
// This matches Audiobookshelf's data model so the /api/* adapter can
// map books → LibraryItem rows with minimal massaging.
//
// Files in the vpath root (no subfolder) are treated as single-file
// books — common for M4B downloads.

import { parseFile } from 'music-metadata';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Jimp } from 'jimp';
import mime from 'mime-types';
import { computeHashes } from './audio-hash.js';
import { extractEmbeddedChapters } from './chapter-parsers/embedded.js';
import { parseCueFile } from './chapter-parsers/cue.js';
import { parseTxtChaptersFile } from './chapter-parsers/txt.js';

// ── Natural sort for multi-file ordering ────────────────────────────────────
// "Track 1.mp3" < "Track 2.mp3" < "Track 10.mp3" — not lexicographic.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ── Album-art helpers (audiobook cover detection) ───────────────────────────
// Audiobookshelf convention: a cover.{jpg,png} sibling in the book folder
// wins over any embedded picture. We mirror this so users who replace the
// generic embedded cover with a curated image don't get it overwritten on
// rescan.
const COVER_FILENAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png'];

function findSidecarCover(bookFolderAbs) {
  let entries;
  try { entries = fs.readdirSync(bookFolderAbs); } catch (_) { return null; }
  const lower = new Map(entries.map(n => [n.toLowerCase(), n]));
  for (const candidate of COVER_FILENAMES) {
    if (lower.has(candidate)) {
      return path.join(bookFolderAbs, lower.get(candidate));
    }
  }
  return null;
}

async function persistCover(buffer, ext, ctx) {
  const hash = crypto.createHash('md5').update(buffer).digest('hex');
  const filename = `${hash}.${ext}`;
  const fullPath = path.join(ctx.albumArtDirectory, filename);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, buffer);
    if (ctx.compressImage) {
      try {
        const img = await Jimp.fromBuffer(buffer);
        await img.scaleToFit({ w: 256, h: 256 }).write(path.join(ctx.albumArtDirectory, 'zl-' + filename));
        await img.scaleToFit({ w: 92, h: 92 }).write(path.join(ctx.albumArtDirectory, 'zs-' + filename));
      } catch (err) {
        // Image decode failed — keep the original, skip compression.
        // Worth a warning but not fatal.
        console.error(`Warning: cover compression failed: ${err.message}`);
      }
    }
  }
  return filename;
}

// ── Tag-extraction helpers ──────────────────────────────────────────────────
//
// Audiobook taggers don't agree on much, so we look in several places:
// - Title:   prefer the `album` tag (Audiobookshelf convention), fall back
//            to the folder name, then to the first file's `title`.
// - Author:  `albumartist` or `artist`.
// - Narrator: `composer` is the de-facto tag for narrator (the field is
//             ID3v2's de-facto reuse of TCOM). Also look for TXXX:NARRATOR.
// - Series:  TXXX:SERIES / TXXX:GROUPING / Vorbis SERIES tag. Sequence is
//            often TXXX:SERIES-PART or grouping with a trailing `, Book N`.

// Coerce a music-metadata `common.<key>` value to a plain string or
// number, suitable for binding to a SQLite parameter. music-metadata
// sometimes returns rich shapes for tags that look scalar:
//   - `common.comment` on m4b/mp4: Array<{ text: string, descriptor?: string }>
//   - `common.year` is always a number, but year-of-recording variants
//     can be strings
// The fallback chain unwraps arrays, then peels `.text` / `.value` /
// `.description` off objects. Anything else becomes null rather than
// being bound as `[object Object]`.
function tagValue(parsedCommon, key) {
  return scalarize(parsedCommon?.[key]);
}

function scalarize(v) {
  if (v == null) { return null; }
  if (Array.isArray(v)) { return scalarize(v[0]); }
  if (typeof v === 'object') {
    // music-metadata shapes: `{ text }` for comments, `{ value }` for
    // some custom tags, `{ description }` for TXXX-style.
    return v.text ?? v.value ?? v.description ?? null;
  }
  return v;
}

// music-metadata exposes TXXX/Vorbis custom tags via parsed.native[fmt][].
// `id` is the frame ID (e.g. 'TXXX:NARRATOR' or 'NARRATOR' for Vorbis),
// and `value` is either a string or `{ description, text }` for TXXX.
function nativeTagValues(parsed, names) {
  const wanted = new Set(names.map(n => n.toUpperCase()));
  const hits = [];
  if (!parsed?.native) { return hits; }
  for (const fmt of Object.keys(parsed.native)) {
    for (const entry of parsed.native[fmt]) {
      const rawId = String(entry.id || '').toUpperCase();
      const txxxDesc = (entry.value && typeof entry.value === 'object' && entry.value.description)
        ? String(entry.value.description).toUpperCase()
        : null;
      if (wanted.has(rawId) || (txxxDesc && wanted.has(txxxDesc))) {
        const text = (entry.value && typeof entry.value === 'object')
          ? (entry.value.text ?? entry.value.description ?? null)
          : entry.value;
        if (text != null) { hits.push(String(text)); }
      }
    }
  }
  return hits;
}

function splitMulti(s) {
  if (!s) { return []; }
  return String(s).split(/\s*[,;/]\s*|\s+(?:and|&)\s+/i)
    .map(p => p.trim()).filter(p => p.length > 0);
}

function extractNarrators(parsed) {
  const composer = tagValue(parsed?.common, 'composer');
  const txxx     = nativeTagValues(parsed, ['NARRATOR', 'TXXX:NARRATOR', 'PERFORMER']);
  const combined = [
    ...splitMulti(composer),
    ...txxx.flatMap(splitMulti),
  ];
  // Dedupe preserving first-seen order
  const seen = new Set();
  const out = [];
  for (const name of combined) {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out;
}

function extractSeriesInfo(parsed) {
  const series = nativeTagValues(parsed, ['SERIES', 'TXXX:SERIES', 'MVNM', 'SHOWMOVEMENT'])[0]
    || tagValue(parsed?.common, 'grouping')
    || null;
  if (!series) { return { name: null, sequence: null }; }

  const partRaw = nativeTagValues(parsed, ['SERIES-PART', 'TXXX:SERIES-PART', 'MVIN', 'PART_NUMBER', 'TXXX:PART_NUMBER'])[0]
    || null;
  const sequence = partRaw != null && Number.isFinite(Number(partRaw))
    ? Number(partRaw)
    : null;
  return { name: String(series).trim(), sequence };
}

// ── Book detection ──────────────────────────────────────────────────────────
//
// Walk the vpath root one level deep: every subfolder containing at least
// one supported audio file is a book. Audio files at the root level are
// each their own single-file book.
//
// Two-level Audiobookshelf layout is also supported: when a top-level
// subdirectory contains ONLY subdirectories (no audio files), it's
// treated as an author folder and each child subdirectory becomes a
// book. This matches the canonical AB convention
// (Library/Author/Title/audio.m4b) so a fixture or production library
// laid out that way scans correctly.

function discoverBooks(rootDir, supportedFiles) {
  const books = [];
  let rootEntries;
  try { rootEntries = fs.readdirSync(rootDir); } catch (_) { return books; }

  for (const entry of rootEntries.sort(naturalCompare)) {
    const abs = path.join(rootDir, entry);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.isFile()) {
      if (supportedFiles[ext(entry)]) {
        books.push({ folderAbs: rootDir, files: [abs], singleFile: true, relPath: entry });
      }
      continue;
    }
    if (!stat.isDirectory()) { continue; }

    const files = collectAudioFiles(abs, supportedFiles);
    if (files.length > 0) {
      // Directory contains audio directly → it's a book folder.
      books.push({ folderAbs: abs, files, singleFile: false, relPath: entry });
      continue;
    }

    // No audio at this level — probe one level deeper. If we find
    // subfolders with audio, treat the top folder as an author
    // grouping and each nested folder as a book.
    let subEntries;
    try { subEntries = fs.readdirSync(abs); } catch (_) { continue; }
    for (const subEntry of subEntries.sort(naturalCompare)) {
      const subAbs = path.join(abs, subEntry);
      let subStat;
      try { subStat = fs.statSync(subAbs); } catch (_) { continue; }
      if (!subStat.isDirectory()) { continue; }
      const subFiles = collectAudioFiles(subAbs, supportedFiles);
      if (subFiles.length > 0) {
        books.push({
          folderAbs: subAbs,
          files: subFiles,
          singleFile: false,
          relPath: path.join(entry, subEntry),
        });
      }
    }
  }
  return books;
}

function collectAudioFiles(folderAbs, supportedFiles) {
  let entries;
  try { entries = fs.readdirSync(folderAbs); } catch (_) { return []; }
  const out = [];
  for (const name of entries) {
    const abs = path.join(folderAbs, name);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.isFile() && supportedFiles[ext(name)]) {
      out.push(abs);
    }
  }
  return out.sort(naturalCompare);
}

function ext(filename) {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
}

// ── Chapter extraction (priority cascade) ───────────────────────────────────
//
// Per-book: try embedded chapters in the first file, then look for a
// sidecar .cue, then a chapters.txt / .chapters.txt / <basename>.chapters.txt.
// Fallback: every audio file becomes one chapter, named after its file.
//
// totalDurationMs is the concatenated book duration. embedded chapters
// from a single-file M4B are already in that file's timeline; for a
// multi-file book we don't currently look for cross-file embedded
// chapters (rare; would require parsing each file and concatenating).

function extractChaptersForBook(book, firstFileParsed, totalDurationMs) {
  // 1. Embedded chapters (single-file M4B is the common case)
  if (book.singleFile) {
    const embedded = extractEmbeddedChapters(firstFileParsed, totalDurationMs);
    if (embedded) {
      return embedded.map((c, i) => ({ ...c, sequence: i, source: 'embedded' }));
    }
  }

  // 2. .cue sidecar in the book folder
  const sidecars = listSidecars(book.folderAbs);
  const cuePath = sidecars.find(s => s.toLowerCase().endsWith('.cue'));
  if (cuePath) {
    const cue = parseCueFile(cuePath, totalDurationMs);
    if (cue) {
      return cue.map((c, i) => ({ ...c, sequence: i, source: 'cue' }));
    }
  }

  // 3. chapters.txt / *.chapters.txt
  const txtPath = sidecars.find(s => /(?:^|\W)chapters\.txt$/i.test(s));
  if (txtPath) {
    const txt = parseTxtChaptersFile(txtPath, totalDurationMs);
    if (txt) {
      return txt.map((c, i) => ({ ...c, sequence: i, source: 'txt' }));
    }
  }

  // 4. Fallback: one chapter per audio file. For single-file books with
  //    no chapter source at all, we emit a single chapter covering the
  //    whole book.
  return null;
}

function listSidecars(folderAbs) {
  let entries;
  try { entries = fs.readdirSync(folderAbs); } catch (_) { return []; }
  return entries.map(n => path.join(folderAbs, n));
}

// ── Main scan entry point ───────────────────────────────────────────────────

export async function runAudiobookScan(ctx) {
  const { db, loadJson } = ctx;

  const stmts = prepareStatements(db);
  ctx.stmts = stmts;

  console.log(`Scanning audiobook library at ${loadJson.directory}...`);

  const books = discoverBooks(loadJson.directory, loadJson.supportedFiles);
  console.log(`Discovered ${books.length} candidate book(s).`);

  let processedBooks = 0;

  db.exec('BEGIN');
  try {
    for (const book of books) {
      try {
        await processBook(book, ctx);
        processedBooks++;
      } catch (err) {
        console.error(`Warning: failed to process book at ${book.folderAbs}: ${err.message}`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    // Best-effort rollback. SQLite raises if no tx is open; we swallow
    // because the surrounding throw is the real error to propagate.
    try { db.exec('ROLLBACK'); } catch (_rollbackErr) { /* no tx open */ }
    throw err;
  }

  // Remove books whose folder no longer exists (scan_id mismatch).
  const deleted = stmts.deleteStaleBooks.run(loadJson.libraryId, loadJson.scanId);
  // Sweep orphaned narrators / series that no longer have any book.
  db.exec(`
    DELETE FROM narrators WHERE id NOT IN (SELECT DISTINCT narrator_id FROM book_narrators);
    DELETE FROM series    WHERE id NOT IN (SELECT DISTINCT series_id     FROM books WHERE series_id IS NOT NULL);
  `);

  console.log(JSON.stringify({
    event: 'scanComplete',
    filesProcessed: processedBooks,
    filesUnchanged: 0,
    filesScanned: books.length,
    staleEntriesRemoved: deleted.changes,
  }));
}

function prepareStatements(db) {
  return {
    findBook: db.prepare(
      `SELECT id, updated_at FROM books WHERE library_id = ? AND folder_path = ?`
    ),
    upsertBook: db.prepare(
      `INSERT INTO books
         (library_id, folder_path, rel_path, title, subtitle, description, author_id,
          publisher, published_year, isbn, asin, language, series_id, series_sequence,
          cover_file, duration_ms, size_bytes, explicit, abridged, added_at, updated_at, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, folder_path) DO UPDATE SET
         rel_path = excluded.rel_path,
         title = excluded.title,
         subtitle = excluded.subtitle,
         description = excluded.description,
         author_id = excluded.author_id,
         publisher = excluded.publisher,
         published_year = excluded.published_year,
         isbn = excluded.isbn,
         asin = excluded.asin,
         language = excluded.language,
         series_id = excluded.series_id,
         series_sequence = excluded.series_sequence,
         cover_file = excluded.cover_file,
         duration_ms = excluded.duration_ms,
         size_bytes = excluded.size_bytes,
         explicit = excluded.explicit,
         abridged = excluded.abridged,
         updated_at = excluded.updated_at,
         scan_id = excluded.scan_id
       RETURNING id`
    ),
    deleteAudioFiles: db.prepare(`DELETE FROM book_audio_files WHERE book_id = ?`),
    insertAudioFile: db.prepare(
      `INSERT INTO book_audio_files
         (book_id, filepath, sequence, duration_ms, start_offset_ms,
          bitrate, codec, format, size_bytes, file_hash, audio_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deleteChapters: db.prepare(`DELETE FROM chapters WHERE book_id = ?`),
    insertChapter: db.prepare(
      `INSERT INTO chapters (book_id, sequence, title, start_ms, end_ms, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    deleteBookNarrators: db.prepare(`DELETE FROM book_narrators WHERE book_id = ?`),
    findNarrator: db.prepare(`SELECT id FROM narrators WHERE name = ?`),
    insertNarrator: db.prepare(`INSERT INTO narrators (name) VALUES (?)`),
    insertBookNarrator: db.prepare(
      `INSERT OR IGNORE INTO book_narrators (book_id, narrator_id, position) VALUES (?, ?, ?)`
    ),
    findArtist: db.prepare(`SELECT id FROM artists WHERE name = ?`),
    insertArtist: db.prepare(`INSERT INTO artists (name) VALUES (?)`),
    findSeries: db.prepare(`SELECT id FROM series WHERE name = ? AND author_id IS ?`),
    insertSeries: db.prepare(`INSERT INTO series (name, author_id) VALUES (?, ?)`),
    deleteStaleBooks: db.prepare(
      `DELETE FROM books WHERE library_id = ? AND (scan_id IS NULL OR scan_id != ?)`
    ),
  };
}

async function processBook(book, ctx) {
  const { loadJson, stmts } = ctx;

  // Parse the first file to extract book-level metadata. We DO parse
  // each subsequent file (for duration + hashing) but only use the
  // first one's tags as the book's metadata source — multi-file books
  // typically have identical tags across files.
  const firstFile = book.files[0];
  let firstParsed;
  try {
    firstParsed = await parseFile(firstFile, { skipCovers: loadJson.skipImg });
  } catch (err) {
    throw new Error(`first-file parse error: ${err.message}`, { cause: err });
  }

  const common = firstParsed.common || {};
  const folderBasename = path.basename(book.folderAbs === loadJson.directory ? book.relPath : book.folderAbs);

  const title = tagValue(common, 'album') || folderBasename;
  const subtitle = tagValue(common, 'subtitle') || null;
  const description = tagValue(common, 'comment')
    || nativeTagValues(firstParsed, ['DESCRIPTION', 'TXXX:DESCRIPTION'])[0]
    || null;
  const authorName = tagValue(common, 'albumartist') || tagValue(common, 'artist') || null;
  const publisher = tagValue(common, 'label')
    || nativeTagValues(firstParsed, ['PUBLISHER', 'TXXX:PUBLISHER'])[0]
    || null;
  const publishedYear = common.year ?? null;
  const isbn = nativeTagValues(firstParsed, ['ISBN', 'TXXX:ISBN'])[0] || null;
  const asin = nativeTagValues(firstParsed, ['ASIN', 'TXXX:ASIN'])[0] || null;
  const language = tagValue(common, 'language') || null;

  // Author → artists row reuse
  const authorId = authorName ? findOrCreateArtist(stmts, authorName) : null;

  // Series
  const seriesInfo = extractSeriesInfo(firstParsed);
  const seriesId = seriesInfo.name ? findOrCreateSeries(stmts, seriesInfo.name, authorId) : null;

  // Audio files: parse + hash each, accumulate duration and size.
  const audioFiles = [];
  let cumulativeOffsetMs = 0;
  let totalSizeBytes = 0;

  for (let i = 0; i < book.files.length; i++) {
    const filePath = book.files[i];
    const parsed = i === 0 ? firstParsed : await safeParseFile(filePath, loadJson);
    const durationMs = Math.round((parsed?.format?.duration || 0) * 1000);
    const stat = fs.statSync(filePath);
    const { fileHash, audioHash } = await computeHashes(filePath);

    audioFiles.push({
      filepath: path.relative(loadJson.directory, filePath).replace(/\\/g, '/'),
      sequence: i,
      duration_ms: durationMs,
      start_offset_ms: cumulativeOffsetMs,
      bitrate: parsed?.format?.bitrate ?? null,
      codec: parsed?.format?.codec ?? null,
      format: ext(filePath) || null,
      size_bytes: stat.size,
      file_hash: fileHash,
      audio_hash: audioHash,
    });

    cumulativeOffsetMs += durationMs;
    totalSizeBytes += stat.size;
  }

  const totalDurationMs = cumulativeOffsetMs;

  // Cover art: sidecar first, embedded second.
  let coverFile = null;
  if (!loadJson.skipImg) {
    const sidecar = findSidecarCover(book.folderAbs);
    if (sidecar) {
      const buf = fs.readFileSync(sidecar);
      const extName = ext(sidecar);
      coverFile = await persistCover(buf, extName, loadJson);
    } else if (firstParsed.common?.picture?.[0]) {
      const pic = firstParsed.common.picture[0];
      const extName = mime.extension(pic.format) || 'jpg';
      coverFile = await persistCover(pic.data, extName, loadJson);
    }
  }

  // Chapters
  const chapters = extractChaptersForBook(book, firstParsed, totalDurationMs);

  // Narrators
  const narrators = extractNarrators(firstParsed);

  // Upsert book row
  const now = Date.now();
  const upsertResult = stmts.upsertBook.get(
    loadJson.libraryId,
    book.folderAbs,
    book.relPath,
    title,
    subtitle,
    description,
    authorId,
    publisher,
    publishedYear,
    isbn,
    asin,
    language,
    seriesId,
    seriesInfo.sequence,
    coverFile,
    totalDurationMs,
    totalSizeBytes,
    0, // explicit (no reliable tag)
    0, // abridged (no reliable tag)
    now, // added_at — set to now on first insert; preserved on UPDATE via ON CONFLICT
    now, // updated_at
    loadJson.scanId,
  );
  const bookId = upsertResult.id;

  // Replace audio files / chapters / narrators (idempotent rescan).
  stmts.deleteAudioFiles.run(bookId);
  for (const af of audioFiles) {
    stmts.insertAudioFile.run(
      bookId,
      af.filepath,
      af.sequence,
      af.duration_ms,
      af.start_offset_ms,
      af.bitrate,
      af.codec,
      af.format,
      af.size_bytes,
      af.file_hash,
      af.audio_hash,
    );
  }

  stmts.deleteChapters.run(bookId);
  const effectiveChapters = chapters || synthesizeChapters(audioFiles, totalDurationMs);
  for (const c of effectiveChapters) {
    stmts.insertChapter.run(bookId, c.sequence, c.title, c.start_ms, c.end_ms, c.source || 'fallback');
  }

  stmts.deleteBookNarrators.run(bookId);
  for (let i = 0; i < narrators.length; i++) {
    const narratorId = findOrCreateNarrator(stmts, narrators[i]);
    stmts.insertBookNarrator.run(bookId, narratorId, i);
  }
}

function synthesizeChapters(audioFiles, totalDurationMs) {
  // Fallback: one chapter per file. For a single-file book with no
  // chapter sources, we emit one chapter spanning the whole timeline.
  if (audioFiles.length === 1) {
    return [{
      sequence: 0,
      title: 'Chapter 1',
      start_ms: 0,
      end_ms: totalDurationMs || (audioFiles[0].duration_ms || 1000),
      source: 'fallback',
    }];
  }
  return audioFiles.map((af, i) => ({
    sequence: i,
    title: path.basename(af.filepath, path.extname(af.filepath)),
    start_ms: af.start_offset_ms,
    end_ms: af.start_offset_ms + af.duration_ms,
    source: 'fallback',
  }));
}

function findOrCreateArtist(stmts, name) {
  const trimmed = String(name).trim();
  if (!trimmed) { return null; }
  const row = stmts.findArtist.get(trimmed);
  if (row) { return row.id; }
  return Number(stmts.insertArtist.run(trimmed).lastInsertRowid);
}

function findOrCreateNarrator(stmts, name) {
  const trimmed = String(name).trim();
  const row = stmts.findNarrator.get(trimmed);
  if (row) { return row.id; }
  return Number(stmts.insertNarrator.run(trimmed).lastInsertRowid);
}

function findOrCreateSeries(stmts, name, authorId) {
  const row = stmts.findSeries.get(name, authorId ?? null);
  if (row) { return row.id; }
  return Number(stmts.insertSeries.run(name, authorId ?? null).lastInsertRowid);
}

async function safeParseFile(filePath, loadJson) {
  try {
    return await parseFile(filePath, { skipCovers: loadJson.skipImg });
  } catch (err) {
    console.error(`Warning: metadata parse error on ${filePath}: ${err.message}`);
    return { common: {}, format: {} };
  }
}
