// Map mStream DB rows → Audiobookshelf API shapes.
//
// These are pure functions (no DB access, no req/res). Keeping them
// pure means the unit test for "does our LibraryItem shape match what
// the mobile app expects" can run without mocking the database.
//
// Shape references throughout this file are derived from the
// Audiobookshelf OpenAPI spec at api.audiobookshelf.org — we don't
// implement every field, only what the mobile apps actually read.

// ── Identity / Library ──────────────────────────────────────────────────────

export function libraryToAudiobookshelfLibrary(library) {
  return {
    id: String(library.id),
    name: library.name,
    folders: [{
      id: `folder-${library.id}`,
      fullPath: library.root_path,
      libraryId: String(library.id),
      addedAt: 0,
    }],
    mediaType: 'book',
    provider: 'audible',
    icon: 'audiobookshelf',
    displayOrder: 1,
    createdAt: 0,
    lastUpdate: 0,
    settings: {},
  };
}

// Build the user object that the Audiobookshelf mobile apps expect.
// Shape captured verbatim from a running 2.30.0 instance — the mobile
// apps probe for each of these fields on login, and missing ones cause
// silent UI degradation (e.g. permissions checks become undefined →
// disable buttons that should work).
export function userToAudiobookshelfUser(user, audiobookLibraries) {
  const tokenPlaceholder = null; // caller (login / authorize) fills in
  return {
    id: String(user.id),
    username: user.username,
    email: null,
    type: user.admin ? 'root' : 'user',
    // The 2.30 API exposes both the legacy `token` and the newer
    // `accessToken` + `refreshToken` pair. mStream's JWT is stateless
    // so accessToken === token; refreshToken stays null (mStream
    // doesn't rotate tokens server-side).
    token: tokenPlaceholder,
    accessToken: tokenPlaceholder,
    refreshToken: null,
    // `isOldToken: true` tells the mobile app the JWT is the legacy
    // single-token format. New Audiobookshelf instances minted with
    // refresh-token support omit this; mStream sets it because we
    // never rotate.
    isOldToken: true,
    mediaProgress: [],
    seriesHideFromContinueListening: [],
    bookmarks: [],
    isActive: true,
    isLocked: false,
    lastSeen: null,
    createdAt: 0,
    permissions: {
      download: true,
      update: !!user.admin,
      delete: !!user.admin,
      upload: !!user.allow_upload,
      createEreader: !!user.admin,
      accessAllLibraries: !!user.admin,
      accessAllTags: true,
      accessExplicitContent: true,
      selectedTagsNotAccessible: false,
    },
    librariesAccessible: audiobookLibraries.map(l => String(l.id)),
    itemTagsSelected: [],
    itemTagsAccessible: [],
    hasOpenIDLink: false,
    ereaderDevices: [],
  };
}

// ── Book → LibraryItem ──────────────────────────────────────────────────────

export function bookToLibraryItem(book, audioFiles, chapters, narrators, series, author, library) {
  const libraryItemId = `book-${book.id}`;
  const totalDurationSec = (book.duration_ms || 0) / 1000;

  return {
    id: libraryItemId,
    ino: String(book.id),
    libraryId: library ? String(library.id) : String(book.library_id),
    folderId: library ? `folder-${library.id}` : `folder-${book.library_id}`,
    path: book.folder_path,
    relPath: book.rel_path,
    isFile: audioFiles.length === 1,
    mtimeMs: book.updated_at || 0,
    ctimeMs: book.added_at || 0,
    birthtimeMs: book.added_at || 0,
    addedAt: book.added_at || 0,
    updatedAt: book.updated_at || 0,
    isMissing: false,
    isInvalid: false,
    mediaType: 'book',
    media: {
      id: libraryItemId,
      libraryItemId,
      metadata: {
        title: book.title,
        subtitle: book.subtitle,
        authors: author
          ? [{ id: `author-${author.id}`, name: author.name }]
          : [],
        narrators: narrators.map(n => n.name),
        series: series
          ? [{
              id: `series-${series.id}`,
              name: series.name,
              sequence: book.series_sequence != null ? String(book.series_sequence) : null,
            }]
          : [],
        genres: [],
        publishedYear: book.published_year != null ? String(book.published_year) : null,
        publishedDate: null,
        publisher: book.publisher,
        description: book.description,
        isbn: book.isbn,
        asin: book.asin,
        language: book.language,
        explicit: !!book.explicit,
        abridged: !!book.abridged,
        // Audiobookshelf clients also expect *Name flat fields alongside
        // the structured arrays — they render quickly from the flat
        // strings on list views.
        titleIgnorePrefix: book.title,
        authorName: author ? author.name : '',
        authorNameLF: author ? author.name : '',
        narratorName: narrators.map(n => n.name).join(', '),
        seriesName: series ? series.name : '',
      },
      coverPath: book.cover_file ? `/api/items/${libraryItemId}/cover` : null,
      tags: [],
      audioFiles: audioFiles.map((af, i) => ({
        index: af.sequence ?? i,
        ino: String(af.id),
        metadata: {
          path: af.filepath,
          relPath: af.filepath,
          filename: af.filepath.split('/').pop(),
          ext: af.format ? `.${af.format}` : '',
          size: af.size_bytes,
        },
        duration: (af.duration_ms || 0) / 1000,
        bitRate: af.bitrate || 0,
        codec: af.codec,
        format: af.format,
        mimeType: af.format === 'm4b' || af.format === 'm4a' ? 'audio/mp4'
          : af.format === 'mp3' ? 'audio/mpeg'
          : af.format === 'flac' ? 'audio/flac'
          : af.format === 'ogg' ? 'audio/ogg'
          : 'audio/mpeg',
        // Audiobookshelf streams files by relative URL — the app
        // resolves these against the base server URL.
        contentUrl: `/api/items/${libraryItemId}/file/${af.id}`,
      })),
      chapters: chapters.map(c => ({
        id: c.sequence,
        start: (c.start_ms || 0) / 1000,
        end: (c.end_ms || 0) / 1000,
        title: c.title || `Chapter ${c.sequence + 1}`,
      })),
      duration: totalDurationSec,
      size: book.size_bytes || 0,
      tracks: audioFiles.map((af, i) => ({
        index: af.sequence ?? i,
        startOffset: (af.start_offset_ms || 0) / 1000,
        duration: (af.duration_ms || 0) / 1000,
        title: af.filepath.split('/').pop(),
        contentUrl: `/api/items/${libraryItemId}/file/${af.id}`,
        mimeType: af.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
        codec: af.codec,
      })),
      numTracks: audioFiles.length,
      numAudioFiles: audioFiles.length,
      numChapters: chapters.length,
    },
    size: book.size_bytes || 0,
    numFiles: audioFiles.length + (book.cover_file ? 1 : 0),
  };
}

// Compact list-view shape used by /api/libraries/:id/items. Same data,
// less of it — the mobile app doesn't need chapters/audioFiles when it's
// just rendering a grid.
export function bookToMinifiedLibraryItem(book, audioFiles, narrators, series, author, library) {
  const libraryItemId = `book-${book.id}`;
  return {
    id: libraryItemId,
    ino: String(book.id),
    libraryId: library ? String(library.id) : String(book.library_id),
    folderId: library ? `folder-${library.id}` : `folder-${book.library_id}`,
    path: book.folder_path,
    relPath: book.rel_path,
    isFile: audioFiles.length === 1,
    mtimeMs: book.updated_at || 0,
    ctimeMs: book.added_at || 0,
    birthtimeMs: book.added_at || 0,
    addedAt: book.added_at || 0,
    updatedAt: book.updated_at || 0,
    isMissing: false,
    isInvalid: false,
    mediaType: 'book',
    media: {
      id: libraryItemId,
      metadata: {
        title: book.title,
        subtitle: book.subtitle,
        authorName: author ? author.name : '',
        authorNameLF: author ? author.name : '',
        narratorName: narrators.map(n => n.name).join(', '),
        seriesName: series ? series.name : '',
        publishedYear: book.published_year != null ? String(book.published_year) : null,
        explicit: !!book.explicit,
      },
      coverPath: book.cover_file ? `/api/items/${libraryItemId}/cover` : null,
      tags: [],
      numTracks: audioFiles.length,
      numAudioFiles: audioFiles.length,
      duration: (book.duration_ms || 0) / 1000,
      size: book.size_bytes || 0,
    },
    size: book.size_bytes || 0,
    numFiles: audioFiles.length,
  };
}

// ── Progress ────────────────────────────────────────────────────────────────

export function bookProgressToMediaProgress(row, book) {
  const currentSec = (row.current_time_ms || 0) / 1000;
  const durationSec = (row.duration_ms || (book?.duration_ms ?? 0)) / 1000;
  const progress = durationSec > 0 ? Math.min(1, currentSec / durationSec) : 0;
  return {
    id: `progress-${row.book_id}`,
    libraryItemId: `book-${row.book_id}`,
    episodeId: null,
    duration: durationSec,
    progress,
    currentTime: currentSec,
    isFinished: !!row.is_finished,
    hideFromContinueListening: false,
    lastUpdate: row.last_update || 0,
    startedAt: row.started_at || 0,
    finishedAt: row.finished_at || null,
  };
}

// ── Author / Series ─────────────────────────────────────────────────────────

export function authorToAudiobookshelfAuthor(artistRow, bookCount) {
  return {
    id: `author-${artistRow.id}`,
    name: artistRow.name,
    description: null,
    imagePath: null,
    addedAt: 0,
    updatedAt: 0,
    numBooks: bookCount ?? 0,
  };
}

export function seriesToAudiobookshelfSeries(seriesRow, books) {
  return {
    id: `series-${seriesRow.id}`,
    name: seriesRow.name,
    description: null,
    addedAt: 0,
    updatedAt: 0,
    books: books ? books.map(b => ({ id: `book-${b.id}`, sequence: b.series_sequence })) : [],
    numBooks: books ? books.length : 0,
  };
}

// ── ID decode helpers ──────────────────────────────────────────────────────

export function decodeBookId(libraryItemId) {
  const m = /^book-(\d+)$/.exec(libraryItemId || '');
  return m ? Number(m[1]) : null;
}

export function decodeLibraryId(s) {
  // We accept both bare numeric ids and "folder-N" form.
  if (s == null) { return null; }
  const m1 = /^(\d+)$/.exec(String(s));
  if (m1) { return Number(m1[1]); }
  const m2 = /^folder-(\d+)$/.exec(String(s));
  return m2 ? Number(m2[1]) : null;
}

export function decodeAuthorId(s) {
  const m = /^author-(\d+)$/.exec(s || '');
  return m ? Number(m[1]) : null;
}

export function decodeSeriesId(s) {
  const m = /^series-(\d+)$/.exec(s || '');
  return m ? Number(m[1]) : null;
}
