// Audiobookshelf-compatible REST API.
//
// Mounted at /api/* when config.program.audiobookshelf.enabled === true.
// Co-exists with mStream's native /api/v1/* surface because Express
// routes match by exact path — `/api/login` and `/api/v1/auth/login`
// don't collide.
//
// What we DO implement (v1):
//   - auth (login, me, refresh)
//   - libraries (list, detail, items, authors, series, search)
//   - items (detail, cover, file stream, play session start/sync)
//   - me/progress (get/patch/delete per-book; batch update)
//   - listening-sessions / listening-stats (synthesised from book_progress)
//
// What returns 501 (deferred to v2 / out of scope):
//   - /api/items/:id/match  (metadata matching: Google Books / Audible scrape)
//   - /api/podcasts/*       (podcast subscriptions)
//   - /api/backups/*        (backups via Audiobookshelf — mStream has its own)
//   - /api/notifications/*  (email/push notifications)
//   - /api/opml/*           (podcast OPML import)
//
// Progress sync to a second device happens in socket.js — when a PATCH
// here updates a row, it emits `media_progress_update` on the socket so
// the user's other connections refresh without polling.

import express from 'express';
import * as db from '../../db/manager.js';
import { authMiddleware, verifyCredentials, issueToken } from './auth.js';
import {
  libraryToAudiobookshelfLibrary,
  userToAudiobookshelfUser,
  bookToLibraryItem,
  bookToMinifiedLibraryItem,
  bookProgressToMediaProgress,
  authorToAudiobookshelfAuthor,
  seriesToAudiobookshelfSeries,
  decodeBookId,
  decodeLibraryId,
  decodeAuthorId,
  decodeSeriesId,
} from './mappers.js';
import { setupStreamRoutes } from './stream.js';

// Socket.IO emitter (set by socket.js attach). Letting the REST handler
// emit without a hard dependency on the socket module keeps the
// router unit-testable in isolation.
let _emitProgressUpdate = () => {};
export function setProgressEmitter(fn) { _emitProgressUpdate = fn; }

// Paths the Audiobookshelf adapter owns and requires auth for. The
// gating middleware (see createAudiobookshelfRouter) consults this
// list to decide whether to enforce the Bearer token. Anything not
// matching falls through to subsequent Express middleware (mStream's
// /api/v1/* native API + its cookie/JWT auth wall).
const OWNED_AUTHED_PATHS = [
  /^\/api\/me(?:\/.*)?$/,
  /^\/api\/authorize$/,
  /^\/api\/libraries(?:\/.*)?$/,
  /^\/api\/items(?:\/.*)?$/,
  /^\/api\/sessions?(?:\/.*)?$/,
  /^\/api\/authors(?:\/.*)?$/,
  /^\/api\/series(?:\/.*)?$/,
  /^\/api\/podcasts(?:\/.*)?$/,
  /^\/api\/backups(?:\/.*)?$/,
  /^\/api\/notifications(?:\/.*)?$/,
  /^\/api\/opml(?:\/.*)?$/,
];

export default function createAudiobookshelfRouter() {
  const router = express.Router();
  router.use(express.json());

  // ── Server status (unauthenticated) ───────────────────────────────────────
  //
  // Audiobookshelf mobile apps hit /status before login to learn about
  // first-run state, available auth methods, and server identity. mStream
  // is never in an "uninitialised" state (users are created via the music
  // admin path), so isInit is always true here.

  router.get('/status', (_req, res) => {
    res.json({
      app: 'audiobookshelf',
      serverVersion: '2.30.0',
      isInit: true,
      language: 'en-us',
      authMethods: ['local'],
      authFormData: { authLoginCustomMessage: null },
      // Mirror Audiobookshelf's response shape — these field names are
      // what the mobile apps key off of.
      ConfigPath: '/config',
      MetadataPath: '/metadata',
    });
  });

  // ── Auth (unauthenticated) ────────────────────────────────────────────────
  //
  // /login and /logout are mounted at the SITE ROOT in Audiobookshelf
  // (not under /api). mStream matches the same paths so the mobile apps
  // work without modification.

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const user = await verifyCredentials(username, password);
    if (!user) {
      // Same 800ms delay mStream's main login uses to slow brute force.
      return setTimeout(() => res.status(401).json({ error: 'invalid credentials' }), 800);
    }
    const token = issueToken(username);
    const libIds = db.getUserLibraryIds(user);
    const audiobookLibs = db.getAllLibraries().filter(l => libIds.includes(l.id) && l.type === 'audio-books');
    const userShape = userToAudiobookshelfUser({ ...user, admin: user.is_admin === 1 }, audiobookLibs);
    userShape.token = token;
    userShape.accessToken = token;
    res.json({
      user: userShape,
      userDefaultLibraryId: audiobookLibs[0] ? String(audiobookLibs[0].id) : null,
      // serverSettings shape mirrors Audiobookshelf's response so the
      // mobile apps' settings-driven UI elements behave consistently.
      // Values are best-effort: feature-gated booleans default to the
      // safe/quiet choice (no external metadata calls, no scanner
      // automation).
      serverSettings: {
        id: 'server-settings',
        scannerFindCovers: false,
        scannerCoverProvider: 'google',
        scannerParseSubtitle: false,
        scannerPreferMatchedMetadata: false,
        scannerDisableWatcher: true,
        storeCoverWithItem: false,
        storeMetadataWithItem: false,
        metadataFileFormat: 'json',
        rateLimitLoginRequests: 10,
        rateLimitLoginWindow: 600000,
        allowIframe: false,
        backupPath: '',
        backupSchedule: false,
        backupsToKeep: 2,
        maxBackupSize: 1,
        loggerDailyLogsToKeep: 7,
        loggerScannerLogsToKeep: 2,
        homeBookshelfView: 1,
        bookshelfView: 1,
        podcastEpisodeSchedule: '0 * * * *',
        sortingIgnorePrefix: false,
        sortingPrefixes: ['the', 'a'],
        chromecastEnabled: false,
        dateFormat: 'MM/dd/yyyy',
        timeFormat: 'HH:mm',
        language: 'en-us',
        allowedOrigins: [],
        logLevel: 2,
        version: '2.30.0',
        buildNumber: 1,
        authLoginCustomMessage: null,
        authActiveAuthMethods: ['local'],
        authOpenIDIssuerURL: null,
        authOpenIDAuthorizationURL: null,
        authOpenIDTokenURL: null,
        authOpenIDUserInfoURL: null,
        authOpenIDJwksURL: null,
        authOpenIDLogoutURL: null,
        authOpenIDTokenSigningAlgorithm: 'RS256',
        authOpenIDButtonText: 'Login with OpenId',
        authOpenIDAutoLaunch: false,
        authOpenIDAutoRegister: false,
        authOpenIDMatchExistingBy: null,
      },
      ereaderDevices: [],
      Source: 'mstream',
    });
  });

  // /logout is at site root and intentionally unauth-gated — Audiobookshelf
  // returns 200 here even without a token (the client just forgets the
  // token locally; JWTs have no server-side revocation).
  router.post('/logout', (_req, res) => {
    res.json({});
  });

  // Auth-gate everything we own under /api. CRITICAL: only run the
  // bearer-token check for paths that match one of OUR routes — the
  // router is mounted at `/` and sees every request, including
  // mStream's native /api/v1/* (which has its own JWT-cookie auth).
  // A blanket `router.use(authMiddleware)` would 401 those before
  // they reached the mStream auth wall. The pattern list below
  // enumerates exactly the paths the adapter answers.
  router.use((req, res, next) => {
    if (OWNED_AUTHED_PATHS.some(re => re.test(req.path))) {
      return authMiddleware(req, res, next);
    }
    return next();
  });

  router.get('/api/me', (req, res) => {
    const audiobookLibs = req.user.audiobookLibs || [];
    const userShape = userToAudiobookshelfUser(req.user, audiobookLibs);
    userShape.token = req.token;
    userShape.accessToken = req.token;
    res.json(userShape);
  });

  router.post('/api/authorize', (req, res) => {
    // Audiobookshelf clients call /api/authorize to validate a stored token
    // and refresh user info. We piggy-back on authMiddleware — if we
    // got here, the token is valid.
    const audiobookLibs = req.user.audiobookLibs || [];
    const userShape = userToAudiobookshelfUser(req.user, audiobookLibs);
    userShape.token = req.token;
    userShape.accessToken = req.token;
    res.json({ user: userShape });
  });

  // ── Libraries ─────────────────────────────────────────────────────────────

  router.get('/api/libraries', (req, res) => {
    const libs = req.user.audiobookLibs || [];
    res.json({ libraries: libs.map(libraryToAudiobookshelfLibrary) });
  });

  router.get('/api/libraries/:id', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const lib = db.getLibraryById(libId);
    res.json(libraryToAudiobookshelfLibrary(lib));
  });

  router.get('/api/libraries/:id/items', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const lib = db.getLibraryById(libId);
    const limit = clampInt(req.query.limit, 0, 1000, 0);
    const page = clampInt(req.query.page, 0, 1e6, 0);
    const total = db.getDB().prepare(`SELECT COUNT(*) AS c FROM books WHERE library_id = ?`).get(libId).c;
    const rows = listBooks(libId, limit, page);
    const results = rows.map(b => attachAndMinify(b, lib));
    res.json({ results, total, limit, page, sortBy: 'title', sortDesc: false });
  });

  router.get('/api/libraries/:id/personalized', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const lib = db.getLibraryById(libId);
    // Two simple shelves: continue-listening (in-progress books for this
    // user) and recently-added. The Audiobookshelf home screen reads
    // whatever shelves we return — empty is fine.
    const continueRows = db.getDB().prepare(`
      SELECT b.* FROM books b
        JOIN book_progress bp ON bp.book_id = b.id
       WHERE b.library_id = ? AND bp.user_id = ? AND bp.is_finished = 0
       ORDER BY bp.last_update DESC LIMIT 20
    `).all(libId, req.user.id);
    const recentRows = db.getDB().prepare(`
      SELECT * FROM books WHERE library_id = ? ORDER BY added_at DESC LIMIT 20
    `).all(libId);
    res.json([
      { id: 'continue-listening', label: 'Continue Listening', type: 'book',
        entities: continueRows.map(b => attachAndMinify(b, lib)) },
      { id: 'recently-added', label: 'Recently Added', type: 'book',
        entities: recentRows.map(b => attachAndMinify(b, lib)) },
    ]);
  });

  router.get('/api/libraries/:id/authors', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const rows = db.getDB().prepare(`
      SELECT a.id, a.name, COUNT(b.id) AS num_books
        FROM artists a
        JOIN books b ON b.author_id = a.id
       WHERE b.library_id = ?
       GROUP BY a.id ORDER BY a.name COLLATE NOCASE
    `).all(libId);
    res.json({ authors: rows.map(r => authorToAudiobookshelfAuthor(r, r.num_books)) });
  });

  router.get('/api/libraries/:id/series', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const rows = db.getDB().prepare(`
      SELECT s.* FROM series s
       WHERE EXISTS (SELECT 1 FROM books b WHERE b.series_id = s.id AND b.library_id = ?)
       ORDER BY s.name COLLATE NOCASE
    `).all(libId);
    // Audiobookshelf returns the paginated envelope here (NOT
    // { series: [...] } like /authors). Match the same shape so the
    // mobile app's series-list view binds correctly.
    res.json({
      results: rows.map(r => seriesToAudiobookshelfSeries(r, [])),
      total: rows.length,
      limit: 0,
      page: 0,
      sortDesc: false,
      minified: false,
      include: '',
    });
  });

  router.get('/api/libraries/:id/search', (req, res) => {
    const libId = decodeLibraryId(req.params.id);
    if (!req.user.audiobookLibIds?.includes(libId)) {
      return res.status(404).json({ error: 'library not found' });
    }
    const lib = db.getLibraryById(libId);
    const q = (req.query.q || '').toString().trim();
    if (!q) { return res.json({ book: [], podcast: [], tags: [], authors: [], series: [] }); }
    // FTS5 query — quote the term to keep the FTS tokeniser happy with
    // user input that may contain special chars.
    const ftsTerm = q.replace(/"/g, '""');
    const rows = db.getDB().prepare(`
      SELECT b.* FROM books b
        JOIN fts_books f ON f.rowid = b.id
       WHERE f.fts_books MATCH ? AND b.library_id = ?
       ORDER BY b.title COLLATE NOCASE LIMIT 50
    `).all(`"${ftsTerm}"*`, libId);
    res.json({
      book: rows.map(b => ({ libraryItem: attachAndMinify(b, lib), matchKey: 'title', matchText: b.title })),
      podcast: [], tags: [], authors: [], series: [],
    });
  });

  // ── Items ────────────────────────────────────────────────────────────────

  router.get('/api/items/:id', (req, res) => {
    const bookId = decodeBookId(req.params.id);
    const book = bookId ? db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(bookId) : null;
    if (!book) { return res.status(404).json({ error: 'item not found' }); }
    if (!req.user.audiobookLibIds?.includes(book.library_id)) {
      return res.status(404).json({ error: 'item not found' });
    }
    res.json(hydrateBook(book));
  });

  // Match endpoint — deferred to v2. Returning 501 keeps the Audiobookshelf
  // app's "Match metadata" button from crashing; it just stays as a no-op.
  router.post('/api/items/:id/match', (_req, res) => {
    res.status(501).json({ error: 'metadata matching not implemented in mStream v1' });
  });

  // Playback session lifecycle. Audiobookshelf mobile apps POST `/play`
  // to start a session, then PATCH `/sessions/:sid/sync` periodically
  // with currentTime updates. We treat the session as transient and
  // mirror the currentTime into book_progress on every sync.
  router.post('/api/items/:id/play', (req, res) => {
    const bookId = decodeBookId(req.params.id);
    const book = bookId ? db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(bookId) : null;
    if (!book) { return res.status(404).json({ error: 'item not found' }); }
    if (!req.user.audiobookLibIds?.includes(book.library_id)) {
      return res.status(404).json({ error: 'item not found' });
    }
    // Session id is a generated string the client echoes back. We don't
    // persist sessions in v1 — book_progress is the single source of
    // truth — so any unique-enough token works.
    const sessionId = `sess-${bookId}-${Date.now().toString(36)}`;
    const hydrated = hydrateBook(book);
    res.json({
      id: sessionId,
      userId: String(req.user.id),
      libraryId: String(book.library_id),
      libraryItemId: `book-${book.id}`,
      mediaType: 'book',
      mediaMetadata: hydrated.media.metadata,
      chapters: hydrated.media.chapters,
      audioTracks: hydrated.media.tracks,
      currentTime: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      duration: hydrated.media.duration,
      displayTitle: book.title,
      displayAuthor: hydrated.media.metadata.authorName,
      coverPath: hydrated.media.coverPath,
    });
  });

  router.post('/api/session/:sid/sync', (req, res) => {
    syncSession(req, res);
  });
  // Audiobookshelf docs use both singular and plural — accept both.
  router.post('/api/sessions/:sid/sync', (req, res) => {
    syncSession(req, res);
  });
  router.post('/api/session/:sid/close', (_req, res) => {
    res.json({});
  });
  router.post('/api/sessions/:sid/close', (_req, res) => {
    res.json({});
  });

  function syncSession(req, res) {
    const { currentTime, duration } = req.body || {};
    const m = /^sess-(\d+)-/.exec(req.params.sid || '');
    if (!m) { return res.status(400).json({ error: 'invalid session id' }); }
    const bookId = Number(m[1]);
    upsertProgress(req.user.id, bookId, currentTime, duration, false);
    res.json({});
  }

  // ── Progress ─────────────────────────────────────────────────────────────

  router.get('/api/me/progress/:itemId', (req, res) => {
    const bookId = decodeBookId(req.params.itemId);
    if (!bookId) { return res.status(404).json({ error: 'not found' }); }
    const row = db.getDB().prepare(
      `SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?`
    ).get(req.user.id, bookId);
    if (!row) { return res.status(404).json({ error: 'no progress' }); }
    const book = db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(bookId);
    res.json(bookProgressToMediaProgress(row, book));
  });

  router.patch('/api/me/progress/:itemId', (req, res) => {
    const bookId = decodeBookId(req.params.itemId);
    if (!bookId) { return res.status(404).json({ error: 'not found' }); }
    const book = db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(bookId);
    if (!book) { return res.status(404).json({ error: 'not found' }); }
    if (!req.user.audiobookLibIds?.includes(book.library_id)) {
      return res.status(404).json({ error: 'not found' });
    }
    const { currentTime, isFinished, duration } = req.body || {};
    const row = upsertProgress(req.user.id, bookId, currentTime, duration ?? book.duration_ms / 1000, isFinished);
    res.json(bookProgressToMediaProgress(row, book));
  });

  router.delete('/api/me/progress/:itemId', (req, res) => {
    const bookId = decodeBookId(req.params.itemId);
    if (!bookId) { return res.status(404).json({ error: 'not found' }); }
    db.getDB().prepare(`DELETE FROM book_progress WHERE user_id = ? AND book_id = ?`).run(req.user.id, bookId);
    res.json({});
  });

  router.patch('/api/me/progress/batch/update', (req, res) => {
    const items = Array.isArray(req.body) ? req.body : (req.body?.batch || []);
    for (const it of items) {
      const bookId = decodeBookId(it.libraryItemId);
      if (!bookId) { continue; }
      const book = db.getDB().prepare(`SELECT * FROM books WHERE id = ?`).get(bookId);
      if (!book) { continue; }
      if (!req.user.audiobookLibIds?.includes(book.library_id)) { continue; }
      upsertProgress(req.user.id, bookId, it.currentTime, it.duration ?? book.duration_ms / 1000, it.isFinished);
    }
    res.json({});
  });

  router.get('/api/me/listening-sessions', (req, res) => {
    // Listening sessions, synthesised one-per-progress-row. The mobile
    // client mainly wants this for the "recent listening" view; full
    // fidelity (multiple sessions per book) isn't required to satisfy
    // the UI.
    const rows = db.getDB().prepare(`
      SELECT bp.*, b.title, b.cover_file
        FROM book_progress bp
        JOIN books b ON b.id = bp.book_id
       WHERE bp.user_id = ?
       ORDER BY bp.last_update DESC LIMIT 50
    `).all(req.user.id);
    res.json({
      total: rows.length,
      sessions: rows.map(r => ({
        id: `sess-history-${r.book_id}`,
        userId: String(req.user.id),
        libraryItemId: `book-${r.book_id}`,
        mediaType: 'book',
        displayTitle: r.title,
        currentTime: (r.current_time_ms || 0) / 1000,
        duration: (r.duration_ms || 0) / 1000,
        startedAt: r.started_at || 0,
        updatedAt: r.last_update || 0,
      })),
    });
  });

  router.get('/api/me/listening-stats', (req, res) => {
    const totals = db.getDB().prepare(`
      SELECT COUNT(*) AS books_in_progress,
             SUM(current_time_ms) / 1000 AS total_listening_seconds
        FROM book_progress
       WHERE user_id = ?
    `).get(req.user.id);
    res.json({
      totalTime: Number(totals.total_listening_seconds || 0),
      booksInProgress: totals.books_in_progress || 0,
      items: {},
    });
  });

  // ── Authors / Series ─────────────────────────────────────────────────────

  router.get('/api/authors/:id', (req, res) => {
    const authorId = decodeAuthorId(req.params.id);
    if (!authorId) { return res.status(404).json({ error: 'not found' }); }
    const author = db.getDB().prepare(`SELECT * FROM artists WHERE id = ?`).get(authorId);
    if (!author) { return res.status(404).json({ error: 'not found' }); }
    const userLibs = req.user.audiobookLibIds || [];
    if (userLibs.length === 0) { return res.status(404).json({ error: 'not found' }); }
    const placeholders = userLibs.map(() => '?').join(',');
    const books = db.getDB().prepare(`
      SELECT b.* FROM books b
       WHERE b.author_id = ? AND b.library_id IN (${placeholders})
       ORDER BY b.series_sequence, b.title
    `).all(authorId, ...userLibs);
    res.json({
      ...authorToAudiobookshelfAuthor(author, books.length),
      libraryItems: books.map(b => attachAndMinify(b, null)),
    });
  });

  router.get('/api/series/:id', (req, res) => {
    const seriesId = decodeSeriesId(req.params.id);
    if (!seriesId) { return res.status(404).json({ error: 'not found' }); }
    const ser = db.getDB().prepare(`SELECT * FROM series WHERE id = ?`).get(seriesId);
    if (!ser) { return res.status(404).json({ error: 'not found' }); }
    const userLibs = req.user.audiobookLibIds || [];
    if (userLibs.length === 0) { return res.status(404).json({ error: 'not found' }); }
    const placeholders = userLibs.map(() => '?').join(',');
    const books = db.getDB().prepare(`
      SELECT * FROM books WHERE series_id = ? AND library_id IN (${placeholders})
       ORDER BY series_sequence, title
    `).all(seriesId, ...userLibs);
    res.json({
      ...seriesToAudiobookshelfSeries(ser, books),
      libraryItems: books.map(b => attachAndMinify(b, null)),
    });
  });

  // ── Streaming + cover (delegated) ────────────────────────────────────────

  setupStreamRoutes(router);

  // ── 501 stubs for unimplemented features (v1) ────────────────────────────

  const unimplemented = (req, res) => res.status(501).json({
    error: 'not implemented in mStream v1',
    path: req.originalUrl,
  });
  // Express 5's path-to-regexp v8 requires named wildcards. `*rest`
  // captures anything after the prefix into req.params.rest — we
  // don't read it, but the parameter name is mandatory syntax.
  router.all('/api/podcasts/*rest', unimplemented);
  router.all('/api/podcasts', unimplemented);
  router.all('/api/backups/*rest', unimplemented);
  router.all('/api/backups', unimplemented);
  router.all('/api/notifications/*rest', unimplemented);
  router.all('/api/notifications', unimplemented);
  router.all('/api/opml/*rest', unimplemented);
  router.all('/api/opml', unimplemented);

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) { return dflt; }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function listBooks(libId, limit, page) {
  if (limit === 0) {
    return db.getDB().prepare(
      `SELECT * FROM books WHERE library_id = ? ORDER BY title COLLATE NOCASE`
    ).all(libId);
  }
  return db.getDB().prepare(
    `SELECT * FROM books WHERE library_id = ? ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(libId, limit, limit * page);
}

function attachAndMinify(book, library) {
  const audioFiles = db.getDB().prepare(
    `SELECT * FROM book_audio_files WHERE book_id = ? ORDER BY sequence`
  ).all(book.id);
  const narrators = db.getDB().prepare(`
    SELECT n.* FROM narrators n
      JOIN book_narrators bn ON bn.narrator_id = n.id
     WHERE bn.book_id = ? ORDER BY bn.position
  `).all(book.id);
  const series = book.series_id
    ? db.getDB().prepare(`SELECT * FROM series WHERE id = ?`).get(book.series_id)
    : null;
  const author = book.author_id
    ? db.getDB().prepare(`SELECT * FROM artists WHERE id = ?`).get(book.author_id)
    : null;
  return bookToMinifiedLibraryItem(book, audioFiles, narrators, series, author, library);
}

function hydrateBook(book) {
  const audioFiles = db.getDB().prepare(
    `SELECT * FROM book_audio_files WHERE book_id = ? ORDER BY sequence`
  ).all(book.id);
  const chapters = db.getDB().prepare(
    `SELECT * FROM chapters WHERE book_id = ? ORDER BY sequence`
  ).all(book.id);
  const narrators = db.getDB().prepare(`
    SELECT n.* FROM narrators n
      JOIN book_narrators bn ON bn.narrator_id = n.id
     WHERE bn.book_id = ? ORDER BY bn.position
  `).all(book.id);
  const series = book.series_id
    ? db.getDB().prepare(`SELECT * FROM series WHERE id = ?`).get(book.series_id)
    : null;
  const author = book.author_id
    ? db.getDB().prepare(`SELECT * FROM artists WHERE id = ?`).get(book.author_id)
    : null;
  const library = db.getLibraryById(book.library_id);
  return bookToLibraryItem(book, audioFiles, chapters, narrators, series, author, library);
}

function upsertProgress(userId, bookId, currentTimeSec, durationSec, isFinished) {
  const now = Date.now();
  const currentMs = Math.max(0, Math.round((currentTimeSec || 0) * 1000));
  const durationMs = Math.max(0, Math.round((durationSec || 0) * 1000));
  const finishedFlag = isFinished ? 1 : 0;
  const finishedAt = isFinished ? now : null;

  const existing = db.getDB().prepare(
    `SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?`
  ).get(userId, bookId);

  if (existing) {
    db.getDB().prepare(`
      UPDATE book_progress
         SET current_time_ms = ?, duration_ms = ?, is_finished = ?,
             finished_at = COALESCE(?, finished_at),
             last_update = ?
       WHERE id = ?
    `).run(currentMs, durationMs || existing.duration_ms, finishedFlag, finishedAt, now, existing.id);
  } else {
    db.getDB().prepare(`
      INSERT INTO book_progress
        (user_id, book_id, current_time_ms, duration_ms, is_finished,
         started_at, finished_at, last_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, bookId, currentMs, durationMs, finishedFlag, now, finishedAt, now);
  }

  const row = db.getDB().prepare(
    `SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?`
  ).get(userId, bookId);

  // Push the update to any other connected sockets for this user. If
  // the socket layer isn't attached (config off, or unit test), the
  // emitter is a no-op and this is harmless.
  try { _emitProgressUpdate(userId, row); } catch (_emitErr) { /* socket layer not attached */ }

  return row;
}
