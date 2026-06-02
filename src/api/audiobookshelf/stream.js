// Stream a single audio file from a book.
//
// Audiobookshelf mobile apps fetch by `/api/items/{itemId}/file/{fileId}`
// — itemId is `book-<n>`, fileId is the numeric `book_audio_files.id`.
// We translate to the absolute filesystem path and let express's
// res.sendFile() handle Range requests, ETags, conditional GETs, etc.
//
// Cover image streaming is co-located here for the same reason: it's a
// single file lookup that sendFile already handles correctly.

import path from 'path';
import fs from 'fs';
import * as db from '../../db/manager.js';
import * as config from '../../state/config.js';
import { decodeBookId } from './mappers.js';

export function setupStreamRoutes(router) {
  router.get('/api/items/:itemId/file/:fileId', (req, res) => {
    const bookId = decodeBookId(req.params.itemId);
    const fileId = Number(req.params.fileId);
    if (!bookId || !Number.isFinite(fileId)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const row = db.getDB().prepare(
      `SELECT baf.filepath, b.library_id, b.folder_path
         FROM book_audio_files baf
         JOIN books b ON b.id = baf.book_id
        WHERE baf.id = ? AND baf.book_id = ?`
    ).get(fileId, bookId);
    if (!row) { return res.status(404).json({ error: 'not found' }); }

    // Authorisation: user must have access to this audiobook library.
    if (!req.user?.audiobookLibIds?.includes(row.library_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const library = db.getLibraryById(row.library_id);
    if (!library) { return res.status(404).json({ error: 'library missing' }); }

    // book_audio_files.filepath is the path relative to the library root
    // (matches the music scanner's convention). Resolve against the
    // library's root_path to get the absolute file.
    const absolute = path.join(library.root_path, row.filepath);
    if (!absolute.startsWith(path.normalize(library.root_path))) {
      // Defence against a malformed DB row escaping the root via `..`.
      return res.status(400).json({ error: 'invalid path' });
    }
    fs.access(absolute, fs.constants.R_OK, (err) => {
      if (err) { return res.status(404).json({ error: 'file missing' }); }
      res.sendFile(absolute);
    });
  });

  router.get('/api/items/:itemId/cover', (req, res) => {
    const bookId = decodeBookId(req.params.itemId);
    if (!bookId) { return res.status(400).json({ error: 'invalid id' }); }

    const row = db.getDB().prepare(
      `SELECT cover_file, library_id FROM books WHERE id = ?`
    ).get(bookId);
    if (!row || !row.cover_file) { return res.status(404).end(); }
    if (!req.user?.audiobookLibIds?.includes(row.library_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const coverPath = path.join(config.program.storage.albumArtDirectory, row.cover_file);
    fs.access(coverPath, fs.constants.R_OK, (err) => {
      if (err) { return res.status(404).end(); }
      res.sendFile(coverPath);
    });
  });
}
