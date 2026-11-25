/*
 * Auto-DJ client helpers — pure functions + a localStorage-backed
 * state model that the alpha-UI player consumes to drive BPM-continuity,
 * harmonic-mixing, and similar-artists Auto-DJ.
 *
 * This module is INTENTIONALLY UI-free: no DOM access, no fetch, no
 * iziToast. The player layer (webapp/assets/js/mstream.player.js) and
 * the panel layer (webapp/alpha/m.js's autoDjPanel) both read from
 * and write through this namespace. Keeping the logic isolated lets
 * us unit-test the tricky bits (Camelot maths, BPM-range octave
 * expansion, song-blocked tier checks) without booting a server or
 * pulling in jsdom.
 *
 * Most of the substantive logic is lifted verbatim from the velvet
 * fork's webapp/app.js (aroundmyroom/mStream — the "velvet/webapp/app.js:N"
 * citations inline point there, not at anything in this repo; the fork is
 * no longer tracked). Comments preserve the
 * original intent so divergence between the two trees is obvious to
 * anyone porting future fixes either direction.
 *
 * Browser: defines `window.AUTODJ`.
 * Node (tests): exports the same namespace via CommonJS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AUTODJ = factory();
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ── Camelot Wheel ────────────────────────────────────────────────
  //
  // Lifted verbatim from velvet/webapp/app.js:485-516. Maps every raw
  // key name the scanner might have written to the standard Camelot
  // code, then supplies the wheel-neighbour relation that "harmonic
  // mixing" uses.
  //
  // Enharmonic spellings (Ab vs G#, Bb vs A#, …) both map to the same
  // code so a file tagged "G# minor" lands on 1A just like a file
  // tagged "Ab minor".
  const CAMELOT = Object.freeze({
    'Ab minor': '1A',  'G# minor': '1A',  'B major': '1B',
    'Eb minor': '2A',  'D# minor': '2A',  'F# major': '2B', 'Gb major': '2B',
    'Bb minor': '3A',  'A# minor': '3A',  'Db major': '3B', 'C# major': '3B',
    'F minor':  '4A',  'Ab major': '4B',  'G# major': '4B',
    'C minor':  '5A',  'Eb major': '5B',  'D# major': '5B',
    'G minor':  '6A',  'Bb major': '6B',  'A# major': '6B',
    'D minor':  '7A',  'F major':  '7B',
    'A minor':  '8A',  'C major':  '8B',
    'E minor':  '9A',  'G major':  '9B',
    'B minor':  '10A', 'D major':  '10B',
    'F# minor': '11A', 'A major':  '11B',
    'C# minor': '12A', 'E major':  '12B',
  });

  // Return the Camelot code for a raw key name, or `null`.
  // Passes through values that are already Camelot codes — `toCamelot('8A')`
  // returns `'8A'`. That covers libraries tagged directly with Camelot.
  function toCamelot(musicalKey) {
    if (!musicalKey || typeof musicalKey !== 'string') { return null; }
    const trimmed = musicalKey.trim();
    if (CAMELOT[trimmed]) { return CAMELOT[trimmed]; }
    // Already a Camelot code? Accept `1A`..`12B` literally.
    if (/^([1-9]|1[0-2])[AB]$/.test(trimmed)) { return trimmed; }
    return null;
  }

  // Given a Camelot code, return the Set of "compatible" codes per the
  // standard DJ wheel: the same key, the relative major/minor, and
  // the two adjacent slots (each in both letters). Six total including
  // the code itself.
  //
  // Lifted verbatim from velvet/webapp/app.js:503-516.
  function camelotNeighbours(code) {
    if (!code) { return null; }
    const num = parseInt(code, 10);
    const letter = code.slice(-1);
    if (!Number.isFinite(num) || num < 1 || num > 12 || (letter !== 'A' && letter !== 'B')) {
      return null;
    }
    const other = letter === 'A' ? 'B' : 'A';
    const prev = ((num - 2 + 12) % 12) + 1;
    const next = (num % 12) + 1;
    return new Set([
      `${num}${letter}`,  `${num}${other}`,
      `${prev}${letter}`, `${prev}${other}`,
      `${next}${letter}`, `${next}${other}`,
    ]);
  }

  // ── BPM helpers ──────────────────────────────────────────────────
  //
  // The "anchor" is the BPM we steer the DJ session toward. It's the
  // rounded average of the last 8 DJ-played BPMs so the session doesn't
  // drift one song at a time (124 → 126 → 128 → 130 …) — natural pull
  // back toward the centre.
  //
  // Lifted from velvet/webapp/app.js:535-549. Renamed `_bpmAvg` →
  // `bpmAvg` for the public namespace.

  function bpmAvg(arr) {
    if (!arr || !arr.length) { return null; }
    let sum = 0;
    let n = 0;
    for (const v of arr) {
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    if (n === 0) { return null; }
    return Math.round(sum / n);
  }

  // Build the three OR-ed BPM windows the server's random-songs route
  // accepts: normal, half-tempo, double-tempo. Tolerance scales
  // proportionally so the relative window is the same across octaves.
  // Clamps to 20..300 to match the scanner's range validation.
  //
  // Returns either an array of `{min, max}` objects (the wire shape
  // for `bpmRanges`) or `null` if the inputs don't make sense.
  //
  // Source: velvet/webapp/app.js:1649-1656 — adapted from inline.
  function buildBpmRanges(refBpm, tolerance) {
    if (!Number.isFinite(refBpm) || refBpm < 20 || refBpm > 300) { return null; }
    const tol = Number.isFinite(tolerance) ? tolerance : 8;
    return [
      { min: refBpm - tol,         max: refBpm + tol },
      { min: refBpm / 2 - tol / 2, max: refBpm / 2 + tol / 2 },
      { min: refBpm * 2 - tol * 2, max: refBpm * 2 + tol * 2 },
    ]
      .filter(r => r.max >= 20 && r.min <= 300)
      .map(r => ({
        min: Math.max(20, Math.round(r.min)),
        max: Math.min(300, Math.round(r.max)),
      }))
      .filter(r => r.min <= r.max);
  }

  // ── Keyword-filter normaliser ────────────────────────────────────
  //
  // Lifted verbatim from velvet/webapp/app.js:1566 — lowercase +
  // collapse repeated characters so "acappella" matches "acapella"
  // and "Trax" matches "traxxx". Applied to both the haystack
  // (title+artist+album+filepath) AND each user-supplied word so
  // the comparison is symmetric.
  //
  // Module-private — not exported. The matcher in songBlocked is
  // the only consumer.
  function _normFilterWord(s) {
    return String(s || '').toLowerCase().replace(/(.)\1+/g, '$1');
  }

  // ── songBlocked — post-fetch JS guard ────────────────────────────
  //
  // After the server returns a candidate pick the client double-checks
  // it against the local anchors. The server's tier filter already
  // prefers in-range rows, but in degraded fallback cases (steps 5,
  // 10) the client can re-block + retry up to N times before settling.
  //
  // Reads from velvet/webapp/app.js:1561-1602 with one adaptation:
  //   1. Reads `musical_key` AND `musical-key` so the helper works
  //      whether the caller passes the flat velvet shape or the
  //      kebab-case wire shape from renderMetadataObj.
  //
  // `song` shape: `{ bpm, musical_key | 'musical-key', duration, title,
  // artist, album, filepath }` or any object with those fields readable.
  // Truthy `bpm` on the song means we KNOW the song's tempo; falsy
  // means unknown → pass-through, server is already filtering at the
  // SQL layer.
  //
  // Branches are evaluated in cheapest-first order so a song that
  // would be filter-word-blocked AND BPM-blocked short-circuits on
  // the first hit.
  function songBlocked(song, opts) {
    if (!song || typeof song !== 'object') { return false; }
    const o = opts || {};

    // Keyword filter — independent of BPM/harmonic toggles (a user
    // can run pure keyword filtering with nothing else on). Active
    // only when BOTH `filterEnabled` is on AND there's at least one
    // word; an empty word list with the toggle on is a no-op so the
    // user doesn't get blocked by "I turned it on but haven't typed
    // anything yet" semantics.
    if (o.filterEnabled && Array.isArray(o.filterWords) && o.filterWords.length > 0) {
      const haystack = _normFilterWord([
        song.title    || '',
        song.artist   || '',
        song.album    || '',
        song.filepath || '',
      ].join(' '));
      // Guard against bogus list entries: null, undefined, '', and
      // pure-whitespace strings. A whitespace word like '   ' would
      // normalise to ' ' which appears in almost every haystack, so
      // it would block every song — a "feature" no caller wants.
      if (o.filterWords.some(w => {
        if (typeof w !== 'string') { return false; }
        const norm = _normFilterWord(w);
        if (!norm.trim()) { return false; }
        return haystack.includes(norm);
      })) {
        return true;
      }
    }

    // Genre filter — whitelist (only allow these) or blacklist (skip
    // these). Mode flips the overlap test; the rest of the matcher is
    // identical. Empty `genres` array short-circuits the branch so a
    // "toggle on, list still empty" state doesn't block every song.
    //
    // ANY-match by design (a track passes whitelist if ANY of its
    // genres are in the list; fails blacklist if ANY are). Case-
    // insensitive to match the server's COLLATE NOCASE filter.
    //
    // Untagged tracks (song.genres is undefined / []):
    //   • whitelist mode → BLOCKED. The user asked for ONLY tracks
    //     tagged with these genres; an untagged track satisfies no
    //     intersection.
    //   • blacklist mode → ALLOWED. The user asked to skip these
    //     genres; an untagged track has no overlap with the blocklist
    //     by definition.
    //
    // Server-side enforcement (src/api/random.js's buildGenreFilter)
    // produces the identical semantic via EXISTS / NOT EXISTS, so a
    // pick that survives the server filter never lands on this branch
    // — it's purely defence-in-depth for the rescan-mid-session race
    // where the server's row matched but its track_genres changed
    // before this client read the metadata.
    if (o.genreEnabled && Array.isArray(o.genres) && o.genres.length > 0) {
      const songGenres = Array.isArray(song.genres) ? song.genres : [];
      const lc = new Set(o.genres.map(g => String(g).toLowerCase()));
      const overlap = songGenres.some(g => lc.has(String(g).toLowerCase()));
      if (o.genreMode === 'blacklist') {
        if (overlap) { return true; }
      } else {
        // whitelist (default)
        if (songGenres.length === 0 || !overlap) { return true; }
      }
    }

    // Track-length window — defence-in-depth against the server's
    // pick, mirroring the genre branch above. The server already
    // enforces this as an always-on base condition, so a survivor of
    // that filter should never block here under normal operation; the
    // case this catches is a rescan landing between the server's
    // SELECT and this client reading the metadata.
    //
    // Semantics track buildDurationFilter exactly:
    //   • bounds are SECONDS; 0 on a side means no bound there
    //   • unknown duration (null / non-finite) is BLOCKED unless
    //     `allowUnknownDuration` is on — which is why this branch does
    //     NOT follow the "untagged passes through" rule the BPM and
    //     harmonic branches below use. Those relax toward the server's
    //     own tier fallback; this one is a hard filter with no tier.
    if (o.durationEnabled) {
      const min = Number.isFinite(o.minDuration) ? o.minDuration : 0;
      const max = Number.isFinite(o.maxDuration) ? o.maxDuration : 0;
      if (min > 0 || max > 0) {
        // NOT `Number(song.duration)`: Number(null) is 0, which is
        // finite, so an unknown duration would read as a zero-second
        // track and fail every min bound instead of taking the
        // unknown branch. Same trap the player's curBpm guards
        // against. isFinite on the RAW value routes null / undefined /
        // non-numeric straight to "unknown".
        const dur = Number.isFinite(song.duration) ? song.duration : null;
        if (dur === null) {
          if (!o.allowUnknownDuration) { return true; }
        } else {
          if (min > 0 && dur < min) { return true; }
          if (max > 0 && dur > max) { return true; }
        }
      }
    }

    // BPM continuity — only block when there IS a reference BPM AND
    // the candidate actually has BPM data that falls outside all
    // octave windows. Untagged songs pass through.
    if (o.bpmContinuity && Number.isFinite(o.refBpm) && Number.isFinite(song.bpm)) {
      const tol = Number.isFinite(o.bpmTolerance) ? o.bpmTolerance : 8;
      const matchNormal = Math.abs(song.bpm - o.refBpm)       <= tol;
      const matchHalf   = Math.abs(song.bpm - o.refBpm / 2)   <= tol / 2;
      const matchDouble = Math.abs(song.bpm - o.refBpm * 2)   <= tol * 2;
      if (!matchNormal && !matchHalf && !matchDouble) { return true; }
    }

    // Harmonic mixing — only block if the candidate HAS key data AND
    // it falls outside the Camelot neighbours. Songs without a key
    // tag pass through.
    if (o.harmonicMixing && o.refNeighbours) {
      const rawKey = song.musical_key ?? song['musical-key'];
      const cand = toCamelot(rawKey);
      if (cand && !o.refNeighbours.has(cand)) { return true; }
    }

    return false;
  }

  // ── State + persistence ──────────────────────────────────────────
  //
  // Single localStorage namespace `mstream-dj-*`. Matches alpha's
  // existing kebab-case key style (`live-playlist-auto-start`,
  // `mstream-search-toggles`). No username scoping — alpha is a
  // single-user-per-browser model.
  //
  // The state object below is the live in-memory mirror; every
  // setState() writes the changed key to localStorage immediately so
  // a tab close mid-session doesn't lose toggles.
  //
  // Defaults are chosen so a fresh install with everything OFF sends
  // the same body shape to /api/v1/db/random-songs that the pre-V32
  // route accepted — i.e. zero behaviour change unless the user opts
  // into a feature.
  const LS_PREFIX = 'mstream-dj-';
  const BPM_HISTORY_LIMIT = 8;          // ring buffer cap
  // 'rolling' is Drift, 'locked' is Stay close (the seeds' two modes).
  const SONIC_ANCHOR_MODES = Object.freeze(['rolling', 'locked']);
  // The session seeds' numbers (More like / Less like; the phone's
  // lib/util/auto_dj_seeds.dart, auto_dj_wire.dart and auto_dj_skips.dart
  // at mstream_music 1fdc0f31). Each list holds at most MAX_PER_LIST rows;
  // only Stay close's one song carries More like past it, up to
  // MAX_STORED_PER_LIST. More like in Drift keeps at most ROLLING_CAP
  // unpinned rows (the old ring of five). The server takes WIRE_CAP
  // `similarTo` paths and WIRE_CAP negatives. An unpinned Less like row
  // lasts LESS_LIKE_TTL_MS of Drift time. A Next is a quick skip when the
  // song was heard QUICK_SKIP_MIN_HEARD_MS and did not count as a play
  // (PLAY_COUNT_MS, or PLAY_COUNT_SHARE of a known length: the server's
  // rule). The Skipped ring keeps RECENT_SKIPS_MAX songs; each Add song
  // section shows ADD_SECTION_MAX.
  const SEEDS = Object.freeze({
    MAX_PER_LIST: 8,
    MAX_STORED_PER_LIST: 16,
    ROLLING_CAP: 5,
    WIRE_CAP: 8,
    LESS_LIKE_TTL_MS: 1800000,
    QUICK_SKIP_MIN_HEARD_MS: 1000,
    PLAY_COUNT_MS: 30000,
    PLAY_COUNT_SHARE: 0.5,
    RECENT_SKIPS_MAX: 20,
    ADD_SECTION_MAX: 20,
  });
  const DEFAULT_SONIC_MIN_SIMILARITY = 0.55;
  const ARTIST_COOLDOWN_LIMIT = 15;     // last-N artists to exclude
  const COUNTED_FILEPATHS_LIMIT = 50;   // ring of "BPM-history-counted" filepaths
  const FILTER_WORDS_LIMIT = 50;        // sanity cap on the user-supplied skip list
  const IGNORE_LIST_LIMIT = 500;        // mirrors src/api/random.js Joi.array().max(500); defensive in case a future server bug ships an unbounded ignoreList
  const DEFAULT_BPM_TOLERANCE = 8;
  const GENRE_LIST_LIMIT = 200;         // sanity cap on the genre whitelist/blacklist (mirrors Joi)
  const DURATION_MAX_SECONDS = 86400;   // mirrors src/api/random.js Joi.number().max(86400) — 24h
  const GENRES_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min — the library's genre list (the Genres row and drawer)
  const GENRE_MODES = Object.freeze(['whitelist', 'blacklist']);
  const GENRE_KINDS = Object.freeze(['tag', 'model']);   // random-songs' genreSource values; null = Mixed (both)
  const GENRE_NAME_MAX = 200;                            // mirrors Joi: genres items are 1-200 chars
  const GENRE_SOURCE_SINCE = Object.freeze([6, 32, 2]);  // random-songs' genreSource (mStream #1102) shipped in 6.32.2
  // The mood filter's groups and values — mirrors src/api/mood-filter.js,
  // whose schema refuses anything else with a 400.
  const MOOD_SCALES = Object.freeze({
    valence: Object.freeze(['happy', 'neutral', 'sad']),
    energy: Object.freeze(['relaxed', 'neutral', 'aggressive']),
    voice: Object.freeze(['instrumental', 'vocals']),
  });
  const MOOD_TAGS = Object.freeze(['acoustic', 'party', 'danceable']);
  // How sure every group must be: the route's `threshold` (src/api/
  // mood-filter.js), Standard its default and so never sent.
  const MOOD_LEVELS = Object.freeze({ strict: 0.7, standard: 0.5, loose: 0.3 });
  const DJ_LIMIT_MAX = 25;              // mirrors src/api/random.js PICK_LIMIT_MAX — songs one fetch may ask for

  // Safe-ish localStorage shim — Node tests + private-mode browsers
  // can both end up without a real one. Returning `null` for misses
  // and silently swallowing write errors matches the same defensive
  // try/catch pattern in webapp/alpha/m.js's settings load.
  function _ls() {
    try {
      if (typeof localStorage !== 'undefined') { return localStorage; }
    } catch (_) { /* SecurityError in some iframes */ }
    return null;
  }
  function _read(key, fallback) {
    const ls = _ls();
    if (!ls) { return fallback; }
    try {
      const raw = ls.getItem(LS_PREFIX + key);
      if (raw == null) { return fallback; }
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
  function _write(key, value) {
    const ls = _ls();
    if (!ls) { return; }
    try {
      if (value === undefined || value === null) {
        ls.removeItem(LS_PREFIX + key);
      } else {
        ls.setItem(LS_PREFIX + key, JSON.stringify(value));
      }
    } catch (_) { /* quota / serialisation error */ }
  }

  // Read + coerce a numeric value with explicit NaN handling and clamp.
  // The naive `Number(x) || default` pattern collapses 0 into the
  // default, which corrupts legitimate zero-valued state (e.g.
  // djMinRating=0 is a real "Disabled" choice).
  function _readNumber(key, defaultVal, min, max) {
    const raw = _read(key, defaultVal);
    const n = Number(raw);
    if (!Number.isFinite(n)) { return defaultVal; }
    return Math.max(min, Math.min(max, n));
  }

  // Hydrate state from localStorage on module load. Every field has a
  // sensible default so a fresh install boots with everything off.
  //
  // Note there is no `enabled` field. The actual on/off truth lives
  // in MSTREAMPLAYER.playerStats.autoDJ (the existing player module's
  // own state). Mirroring it here would create two sources of truth
  // with no synchronisation path.
  function _hydrate() {
    return {
      similar:        !!_read('similar', false),
      bpmContinuity:  !!_read('bpmContinuity', false),
      harmonicMixing: !!_read('harmonicMixing', false),
      bpmTolerance:   _readNumber('bpmTolerance', DEFAULT_BPM_TOLERANCE, 1, 20),
      djMinRating:    _readNumber('djMinRating', 0, 0, 10),
      // Songs per fetch — how many songs one Auto DJ turn asks the server
      // for (`limit` on random-songs, mStream #966). A preference like
      // djMinRating, so it survives reset(). Rounded because the server's
      // Joi wants an integer: a fractional value left in LS would 400
      // every pick. The player only puts `limit` on the wire above 1, so
      // the default keeps the pre-batch request byte-identical.
      djLimit:        Math.round(_readNumber('djLimit', 1, 1, DJ_LIMIT_MAX)),
      // Vpath inclusion set — array of vpath names this DJ session is
      // allowed to pick from. Empty means "every vpath the user can
      // see"; the player computes the inverted `ignoreVPaths` payload.
      djVpaths:       Array.isArray(_read('djVpaths', null)) ? _read('djVpaths', null) : [],
      // ignoreList rotates server-side; we persist whatever the server
      // last returned so a tab reload doesn't immediately re-pick the
      // same songs. Hydration tail-trims to IGNORE_LIST_LIMIT so a
      // tampered or rogue-server localStorage value can't push the
      // next request body past the Joi.max(500) cap (which would 403).
      djIgnoreList:   (() => {
        const raw = _read('djIgnoreList', null);
        if (!Array.isArray(raw)) { return []; }
        return raw.length > IGNORE_LIST_LIMIT ? raw.slice(-IGNORE_LIST_LIMIT) : raw;
      })(),
      // Last-N artists played — used for the `ignoreArtists` cooldown.
      djArtistHistory: Array.isArray(_read('djArtistHistory', null)) ? _read('djArtistHistory', null) : [],
      // Rolling BPM history — last 8 DJ picks' BPM, used to derive
      // the anchor as a rounded average.
      bpmHistory:     Array.isArray(_read('bpmHistory', null)) ? _read('bpmHistory', null) : [],
      // Camelot anchor — locked at the first DJ pick of a session,
      // cleared on manual song pick or feature toggle.
      camelotAnchor:  (() => {
        const v = _read('camelotAnchor', null);
        return typeof v === 'string' ? v : null;
      })(),
      // Ring buffer of filepaths whose BPM has already been pushed
      // into bpmHistory. Used by the song-change handler to skip
      // re-counting when the user navigates BACK to a song the
      // player already counted (otherwise the BPM history would
      // develop duplicates from user navigation, drifting the
      // anchor). Capped at COUNTED_FILEPATHS_LIMIT — old entries
      // age out so a long DJ session doesn't grow unbounded. Same
      // persistence as bpmHistory: survives a page reload so the
      // counted-state stays consistent with the (also-persisted)
      // BPM history.
      djCountedFilepaths: Array.isArray(_read('djCountedFilepaths', null)) ? _read('djCountedFilepaths', null) : [],
      // Keyword-filter toggle + word list (velvet parity, lifted
      // from velvet/webapp/app.js:137-138). When `djFilterEnabled`
      // is true AND `djFilterWords` is non-empty, songBlocked()
      // rejects candidates whose title/artist/album/filepath
      // contains any of the words (lowercase + repeated-char
      // collapse). The toggle is independent of the word list so
      // a user can leave their word list intact while temporarily
      // disabling the feature.
      djFilterEnabled: !!_read('djFilterEnabled', false),
      djFilterWords:  Array.isArray(_read('djFilterWords', null)) ? _read('djFilterWords', null) : [],
      // Genre filter — whitelist (default) or blacklist mode plus the
      // selected genre list. `djGenreMode` is hardened against junk in
      // LS (returns the default 'whitelist' rather than whatever
      // garbage a corrupted localStorage holds) — the server's Joi
      // schema rejects unknown values, so a stale LS payload would
      // otherwise 403 every random-songs request until the user
      // re-toggled it from the UI.
      //
      // `djGenreEnabled` is no switch any more: setGenreFilter writes it
      // with the list (on exactly while genres are chosen), and "on" is
      // genreFilterOn() — the flag AND a list. It stays stored so that a
      // filter an older client switched off keeps its list, unsent, until
      // the first change in the Genres drawer.
      djGenreEnabled: !!_read('djGenreEnabled', false),
      djGenreMode:    GENRE_MODES.includes(_read('djGenreMode', null))
        ? _read('djGenreMode', null)
        : 'whitelist',
      djGenres:       Array.isArray(_read('djGenres', null)) ? _read('djGenres', null) : [],
      // Which genre links the list matches: 'model' (Generated), 'tag'
      // (Tags), or null for Mixed (every kind, and no key on the wire).
      // Hardened like djGenreMode, since the route refuses any other value.
      // A preference: reset() leaves it.
      djGenreSource:  GENRE_KINDS.includes(_read('djGenreSource', null)) ? _read('djGenreSource', null) : null,
      // Track-length window. Stored in SECONDS to match the wire units
      // (tracks.duration is REAL seconds and so is metadata.duration);
      // the panel renders and edits minutes and converts at the edge.
      //
      // 0 on either side means "no bound on this side" — the same
      // sentinel djMinRating uses for its "Any" option, and the reason
      // _readNumber exists (a naive `Number(x) || default` would eat a
      // legitimate 0). The player only puts a bound on the wire when
      // it is > 0.
      //
      // `djAllowUnknownDuration` mirrors the server's
      // allowUnknownDuration: false (default) drops tracks whose
      // duration the scanner never read, true keeps them. It is only
      // consulted when a bound is actually set.
      djDurationEnabled:      !!_read('djDurationEnabled', false),
      djMinDuration:          _readNumber('djMinDuration', 0, 0, DURATION_MAX_SECONDS),
      djMaxDuration:          _readNumber('djMaxDuration', 0, 0, DURATION_MAX_SECONDS),
      djAllowUnknownDuration: !!_read('djAllowUnknownDuration', false),
      // Mood filter (src/api/mood-filter.js) — the toggle plus the filter
      // in the server's form, a preference like the genre filter (it
      // survives reset()). Hydrated through cleanMoods: the route refuses
      // unknown groups and values, so a junk LS value would 400 every pick.
      djMoodEnabled: !!_read('djMoodEnabled', false),
      djMoods:       cleanMoods(_read('djMoods', null)) || {},
      // Strict | Standard | Loose, kept apart from the filter so it holds
      // while no mood is picked; unknown → Standard.
      djMoodLevel:   Object.keys(MOOD_LEVELS).includes(_read('djMoodLevel', null)) ? _read('djMoodLevel', null) : 'standard',
      // Sonic similarity (discovery embeddings, PR #697 server API).
      // `sonicMinSimilarity` is the RAW cosine threshold the server
      // takes; the panel slider maps a perceptual scale onto it.
      // `sonicAnchorMode` is the seeds' mode: 'rolling' is Drift (picks
      // rotate through More like, skips expire), 'locked' is Stay close
      // (both lists frozen, every row shown pinned). Writes go through
      // AUTODJ.seeds.setMode, which freezes or thaws the lists with it;
      // setState({ sonicAnchorMode }) delegates there. Hardened against LS
      // junk the same way djGenreMode is: an unknown value reads as Drift.
      sonicEnabled:       !!_read('sonicEnabled', false),
      sonicMinSimilarity: _readNumber('sonicMinSimilarity', DEFAULT_SONIC_MIN_SIMILARITY, 0, 1),
      sonicAnchorMode:    SONIC_ANCHOR_MODES.includes(_read('sonicAnchorMode', null))
        ? _read('sonicAnchorMode', null)
        : 'rolling',
      // Learn from skips (off by default): a quick skip of a DJ pick also
      // puts the song into Less like, with sonic on and a server that takes
      // negatives. Only an explicit true reads as on.
      learnFromSkips:        _read('learnFromSkips', false) === true,
      // "Clear pins when the queue is cleared" (off by default): a user's
      // clear of a queue that held a row takes the pinned seeds too.
      clearPinsOnQueueClear: _read('clearPinsOnQueueClear', false) === true,
      // Cross-server session (mStream #929): ask this server AND every
      // federated peer that shares its discovery model, seed as a vector,
      // best cosine wins. A preference like sonicEnabled; the panel only
      // offers it when the server advertises federationBrowse.
      federatedEnabled:   !!_read('federatedEnabled', false),
      // Each peer's own ignoreList, by peer id. The list is server-issued
      // track ids, meaningful only back on the server that issued it, so
      // one shared list would exclude unrelated tracks everywhere else and
      // lose the cooldown wherever the winner moved. The local list stays
      // djIgnoreList. Each list is tail-trimmed like djIgnoreList.
      djPeerIgnoreLists: (() => {
        const v = _read('djPeerIgnoreLists', null);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      })(),
    };
  }

  // A mood filter in the server's form — known values only, tags in the
  // server's order, and `level`'s threshold unless it is Standard — or
  // null when nothing filters (a level alone raises no bar).
  function cleanMoods(raw, level) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    const out = {};
    for (const [group, values] of Object.entries(MOOD_SCALES)) {
      if (values.includes(raw[group])) { out[group] = raw[group]; }
    }
    const tags = MOOD_TAGS.filter((tag) => Array.isArray(raw.tags) && raw.tags.includes(tag));
    if (tags.length > 0) { out.tags = tags; }
    if (Object.keys(out).length === 0) { return null; }
    if (Object.keys(MOOD_LEVELS).includes(level) && level !== 'standard') { out.threshold = MOOD_LEVELS[level]; }
    return out;
  }

  // Backing store for state — wrapped in a Proxy below so direct
  // mutation (e.g. `AUTODJ.state.bpmContinuity = true`) logs a
  // warning instead of silently bypassing persistence.
  const _stateRaw = _hydrate();

  // Internal flag — when setState() is mutating the backing store,
  // the Proxy's set trap must NOT warn (the trap fires on the
  // underlying assignment). Used as a tight-scope reentrancy guard.
  let _allowDirectWrite = false;

  // Live state mirror. Reads pass through to _stateRaw. Writes log
  // a console warning steering the caller toward setState() — but
  // still apply the mutation AND persist, so the bug doesn't silently
  // corrupt anything in production while signalling that the access
  // pattern is wrong.
  const state = new Proxy(_stateRaw, {
    set(target, key, value) {
      if (!_allowDirectWrite) {
        // eslint-disable-next-line no-console
        console.warn(
          `[AUTODJ] direct mutation of state.${String(key)} bypasses persistence; ` +
          `use AUTODJ.setState({ ${String(key)}: ... }) instead.`,
        );
        // Self-heal: route the assignment through setState() so the
        // localStorage write still happens. Avoids the user's bug
        // becoming a silent data-loss case.
        setState({ [key]: value });
        return true;
      }
      target[key] = value;
      return true;
    },
  });

  // Test-only: discard the in-memory mirror and re-read from
  // localStorage. Lets unit tests seed localStorage then observe the
  // hydration path. Production callers should mutate via setState();
  // calling _rehydrate at runtime would race with concurrent writers.
  function _rehydrate() {
    _allowDirectWrite = true;
    try {
      const fresh = _hydrate();
      for (const k of Object.keys(_stateRaw)) { delete _stateRaw[k]; }
      Object.assign(_stateRaw, fresh);
    } finally {
      _allowDirectWrite = false;
    }
    // The seeds are module state read from the same storage: their lists,
    // the held-aside set, the lane, the Skipped ring and the listeners
    // start over from what localStorage now holds (the migration included).
    _seedsInit();
  }

  // Single setter so persistence is automatic. Accepts a partial
  // patch. Unknown keys are dropped with a console.warn — they're
  // almost always typos (`harmoniMixing` for `harmonicMixing`), and
  // silently dropping them is the kind of footgun that takes
  // forever to track down. The warn is loud enough for dev consoles
  // but doesn't throw, so a one-off prod bug isn't catastrophic.
  //
  // Two keys reach the seeds: `sonicAnchorMode` is handed to
  // AUTODJ.seeds.setMode (which freezes or thaws the lists, and refuses
  // a value that is no mode), and a change of `sonicEnabled` or
  // `sonicMinSimilarity` gives the rows a server refused this lane
  // another go (they may be fine under the new settings).
  function setState(patch) {
    if (!patch || typeof patch !== 'object') { return; }
    let sonicChanged = false;
    _allowDirectWrite = true;
    try {
      for (const k of Object.keys(patch)) {
        if (!(k in _stateRaw)) {
          // eslint-disable-next-line no-console
          console.warn(`[AUTODJ] setState ignored unknown key: ${k}`);
          continue;
        }
        if (k === 'sonicAnchorMode') { continue; }
        if ((k === 'sonicEnabled' || k === 'sonicMinSimilarity') && _stateRaw[k] !== patch[k]) {
          sonicChanged = true;
        }
        _stateRaw[k] = patch[k];
        _write(k, patch[k]);
      }
    } finally {
      _allowDirectWrite = false;
    }
    if (sonicChanged) { _seedsSetAside.clear(); }
    if (Object.prototype.hasOwnProperty.call(patch, 'sonicAnchorMode')) {
      seedsSetMode(patch.sonicAnchorMode);
    }
  }

  // Wipe every DJ-related localStorage entry. Called when the user
  // toggles Auto-DJ off OR clicks a song manually with intent to
  // reset the session (matches velvet's `_resetDjSession` semantics).
  // Preserves user preferences (similar / bpmContinuity / harmonic /
  // tolerance / vpaths / minRating) — only session state is wiped.
  // The session seeds (AUTODJ.seeds) are left alone: their lane edges
  // say what each new queue keeps.
  function reset() {
    setState({
      djIgnoreList: [],
      djArtistHistory: [],
      bpmHistory: [],
      camelotAnchor: null,
      djCountedFilepaths: [],
      djPeerIgnoreLists: {},
      // federatedEnabled survives — like the toggles it's a choice, not
      // session state.
    });
    _federatedExcluded.clear();
  }

  // ── BPM history + anchor ─────────────────────────────────────────
  //
  // The anchor is always the rounded average of the BPM history. So
  // there's no separate `bpmAnchor` field — it's computed on demand.
  // Velvet stored it as a cached `_bpmAnchor` but the recompute is
  // trivial (8-element average) and avoids cache invalidation bugs.
  function pushBpmHistory(bpm) {
    if (!Number.isFinite(bpm)) { return; }
    const hist = [...state.bpmHistory, bpm];
    while (hist.length > BPM_HISTORY_LIMIT) { hist.shift(); }
    setState({ bpmHistory: hist });
  }

  function getBpmAnchor() {
    return bpmAvg(state.bpmHistory);
  }

  function clearBpmHistory() {
    setState({ bpmHistory: [] });
  }

  // ── Camelot anchor ──────────────────────────────────────────────

  // Set the locked Camelot anchor from a raw key tag. NO-OP on
  // unparseable input (with a console.warn) — the previous
  // behaviour of silently clearing the anchor on bad input was a
  // footgun: callers thought they were SETTING the anchor and
  // accidentally cleared a perfectly good one. To explicitly clear,
  // use `clearCamelotAnchor()`.
  function setCamelotAnchor(rawKey) {
    const code = toCamelot(rawKey);
    if (!code) {
      // eslint-disable-next-line no-console
      console.warn(`[AUTODJ] setCamelotAnchor ignored unparseable key: ${rawKey}`);
      return;
    }
    setState({ camelotAnchor: code });
  }

  function getCamelotAnchor() {
    return state.camelotAnchor;
  }

  // Returns the wheel-neighbours of the current anchor as an array
  // (callers usually need to spread into a request body). The pure
  // `camelotNeighbours()` helper still returns a Set — its
  // uniqueness/has-check semantics matter for the songBlocked
  // membership test. This convenience accessor materialises an
  // array for the caller.
  function getCamelotNeighbours() {
    if (!state.camelotAnchor) { return null; }
    const set = camelotNeighbours(state.camelotAnchor);
    return set ? [...set] : null;
  }

  function clearCamelotAnchor() {
    setState({ camelotAnchor: null });
  }

  // ── Anchor reset ─────────────────────────────────────────────────
  //
  // Called when the user manually picks a song while DJ is on: drop the
  // rolling BPM context and the locked harmonic anchor so the next DJ
  // pick gates off the new song's properties, not the old session's.
  //
  // Also clears the counted-filepath ring: a new session means the
  // user's intent has shifted, so prior "we've already counted this
  // song's BPM" markers no longer apply.
  //
  // It is continuity only. The session seeds (More like / Less like)
  // never change here: a manual song coming up is no new queue for them
  // (AUTODJ.seeds.laneEdge is, at Start, Stop and every queue clear), so
  // the user's pins and the lane's picks stay.
  function resetAnchors() {
    setState({
      bpmHistory: [],
      camelotAnchor: null,
      djCountedFilepaths: [],
    });
  }

  // Seed paths on the wire never carry a leading slash (they resolve
  // through getVPathInfo server-side); rawFilePath from some queue-add
  // paths does. Normalize once at every write/build point. Null for
  // nothing left once the slash goes.
  function _normSonicPath(p) {
    return seedWirePath(p) || null;
  }

  // ── Cross-server session (mStream #929) ─────────────────────────
  //
  // With `federatedEnabled`, the player asks this server AND every paired
  // peer that shares its discovery model. The pure parts live here so
  // they can be unit-tested; the network round trips stay in the player
  // (webapp/assets/js/mstream.player.js, _autoDjFederatedPick).
  //
  // The seed travels as a VECTOR: a filepath only names a row on the
  // server that holds it, so the anchor's embeddings are read from their
  // owning servers, averaged client-side, and sent as `similarToVector`
  // (base64 of dim × float32 little-endian — the server's wire form).

  // Peers dropped for the rest of the session — a model-space 400 from a
  // peer means its library is indexed with a different model, and only a
  // rescan changes that, so it is not re-asked every pick. Session-only,
  // deliberately not persisted; reset() clears it.
  const _federatedExcluded = new Set();

  function excludePeerForSession(peerId) {
    const id = Number(peerId);
    if (Number.isFinite(id)) { _federatedExcluded.add(id); }
  }

  function isPeerExcluded(peerId) {
    return _federatedExcluded.has(Number(peerId));
  }

  // "<owner>|<path>" keys for everything a federated pick must not answer
  // with: the anchors and the playing track. A vector seed carries no
  // hashes for a server to exclude (the filepath form's seeds are dropped
  // from the pool server-side), and ignoreList is only a soft cooldown that
  // yields to the full pool once it covers every candidate — so the guard
  // is here, and an answer that repeats is passed over for the next best.
  // The same key names a seed row (AUTODJ.seeds.keyOf): one song on one
  // server, whichever form its path came in.
  function federatedKey(peerId, path) {
    return `${peerId === null || peerId === undefined ? 'local' : Number(peerId)}|${_normSonicPath(path)}`;
  }

  // `avoidKeys`: more keys the pick passes over (the blended song the user
  // quick-skipped this lane, AUTODJ.seeds.skippedBlendKey()). An iterable
  // of keys; null and empty entries are skipped, since a lane that skipped
  // no blend has none.
  function federatedRecentKeys(anchors, currentSong, avoidKeys) {
    const keys = new Set();
    for (const a of (Array.isArray(anchors) ? anchors : [])) {
      if (a && a.path) { keys.add(federatedKey(a.peerId, a.path)); }
    }
    const curPath = _normSonicPath(currentSong && currentSong.rawFilePath);
    if (curPath) {
      const curPeer = currentSong.federation && Number.isFinite(Number(currentSong.federation.peerId))
        ? Number(currentSong.federation.peerId) : null;
      keys.add(federatedKey(curPeer, curPath));
    }
    if (avoidKeys && typeof avoidKeys[Symbol.iterator] === 'function' && typeof avoidKeys !== 'string') {
      for (const k of avoidKeys) {
        if (typeof k === 'string' && k) { keys.add(k); }
      }
    }
    return keys;
  }

  // Best answers across servers: the `n` highest reported cosines among
  // the answers that are neither blocked (keyword / genre / duration /
  // continuity — the same client-side checks the single-server loop
  // applies) nor a repeat of what is playing or anchoring, one entry per
  // distinct server|path (a server never repeats itself within one
  // answer, but two rounds of asks can offer the same song twice). Best
  // first; equal cosines keep answer order, so the local server — asked
  // first — wins ties. Empty when nothing qualifies, which sends the
  // player back to the single-server pick.
  //
  // A song its server flagged as like a Less like row (`avoided`, read
  // from the answer's `lessLike.avoided[i]`) ranks after every clean
  // song, then by cosine among the flagged: a negative steers, it never
  // blocks, so a flagged song still plays when nothing clean is left.
  //   answers: [{ peerId|null, song, res, similarity, blocked, avoided? }]
  function chooseFederatedPicks(answers, recentKeys, n) {
    const recent = recentKeys instanceof Set ? recentKeys : new Set(recentKeys || []);
    const want = Number.isInteger(n) && n > 0 ? n : 1;
    const seen = new Set();
    const eligible = [];
    for (const a of (Array.isArray(answers) ? answers : [])) {
      if (!a || !a.song || a.blocked) { continue; }
      const key = federatedKey(a.peerId, a.song.filepath);
      if (recent.has(key) || seen.has(key)) { continue; }
      seen.add(key);
      eligible.push({ ...a, similarity: Number.isFinite(a.similarity) ? a.similarity : -1 });
    }
    // stable: ties keep answer order
    eligible.sort((x, y) => (Number(x.avoided === true) - Number(y.avoided === true))
      || (y.similarity - x.similarity));
    return eligible.slice(0, want);
  }

  // The single best answer, or null — chooseFederatedPicks for one song.
  function chooseFederatedPick(answers, recentKeys) {
    return chooseFederatedPicks(answers, recentKeys, 1)[0] || null;
  }

  // Per-peer ignoreList bookkeeping (see djPeerIgnoreLists above).
  function getPeerIgnoreList(peerId) {
    const list = state.djPeerIgnoreLists[String(Number(peerId))];
    return Array.isArray(list) ? [...list] : [];
  }

  function setPeerIgnoreList(peerId, list) {
    const id = Number(peerId);
    if (!Number.isFinite(id)) { return; }
    const trimmed = !Array.isArray(list) ? []
      : (list.length > IGNORE_LIST_LIMIT ? list.slice(-IGNORE_LIST_LIMIT) : list);
    setState({ djPeerIgnoreLists: { ...state.djPeerIgnoreLists, [String(id)]: trimmed } });
  }

  // Wire vectors — base64 of dim × float32 little-endian, read and written
  // through a DataView so the bytes are the same on any host.
  function decodeWireVector(base64, dim) {
    if (typeof base64 !== 'string' || !Number.isInteger(dim) || dim <= 0) { return null; }
    let bytes;
    try {
      const bin = atob(base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    } catch (_e) {
      return null;
    }
    if (bytes.length !== dim * 4) { return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) { out[i] = view.getFloat32(i * 4, true); }
    return out;
  }

  function encodeWireVector(vector) {
    const buf = new ArrayBuffer(vector.length * 4);
    const view = new DataView(buf);
    for (let i = 0; i < vector.length; i++) { view.setFloat32(i * 4, vector[i], true); }
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
    return btoa(bin);
  }

  // The unit-length mean of the anchors' vectors, or null when there is
  // nothing to average or the mean collapses (near-opposite anchors — the
  // server would refuse a zero vector, so don't spend the round trip). A
  // vector of the wrong length is skipped rather than poisoning the sum.
  function meanUnitVector(vectors, dim) {
    if (!Number.isInteger(dim) || dim <= 0) { return null; }
    const sum = new Float64Array(dim);
    let n = 0;
    for (const v of (vectors || [])) {
      if (!v || v.length !== dim) { continue; }
      for (let i = 0; i < dim; i++) { sum[i] += v[i]; }
      n++;
    }
    if (n === 0) { return null; }
    let sumSq = 0;
    for (let i = 0; i < dim; i++) { sum[i] /= n; sumSq += sum[i] * sum[i]; }
    const norm = Math.sqrt(sumSq);
    if (!(norm > 0) || !Number.isFinite(norm)) { return null; }
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) { out[i] = sum[i] / norm; }
    return out;
  }

  // ── Counted-filepath tracking ────────────────────────────────────
  //
  // Replaces the previous `_djCounted` flag that lived on each song's
  // metadata object (a brittle in-place mutation visible to anyone
  // reading `song.metadata`). Now the "have we counted this song's
  // BPM into the rolling history?" question is answered from a
  // first-class state field, keyed by filepath.
  //
  // Ring buffer caps at COUNTED_FILEPATHS_LIMIT so a long DJ session
  // doesn't grow unbounded. Order is insertion (oldest first); when
  // the cap is hit, the oldest entry is evicted. Capacity (50) is
  // generous relative to the BPM history's 8-entry window — a song
  // is unlikely to be re-discovered after 50 picks away.
  function isFilepathCounted(filepath) {
    if (!filepath) { return false; }
    return state.djCountedFilepaths.indexOf(filepath) !== -1;
  }

  function markFilepathCounted(filepath) {
    if (!filepath) { return; }
    if (isFilepathCounted(filepath)) { return; }
    const next = [...state.djCountedFilepaths, filepath];
    while (next.length > COUNTED_FILEPATHS_LIMIT) { next.shift(); }
    setState({ djCountedFilepaths: next });
  }

  // ── Artist cooldown ─────────────────────────────────────────────
  //
  // The client cooldown ring buffer dedups via this normaliser.
  //
  // PORTED FROM SERVER — keep in lockstep with the canonical
  // normaliser at src/util/artist-normalize.js (PR #587). The two
  // sides need to agree, otherwise "Beyoncé" and "Beyonce" land as
  // two separate cooldown entries client-side but resolve to the
  // same library row server-side, wasting ring-buffer slots and
  // letting near-duplicate plays slip through. If either side
  // changes, change the other.
  //
  // Rules: NFD + strip combining marks, lowercase, strip dots and
  // slashes, fold `&` → " and ", collapse whitespace, trim.
  function _normArtist(name) {
    if (typeof name !== 'string') { return ''; }
    return name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[./]/g, '')
      .replace(/\s*&\s*/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pushArtistHistory(artist) {
    const trimmed = String(artist || '').trim();
    if (!trimmed) { return; }
    const norm = _normArtist(trimmed);
    // De-dup: remove any prior entries that normalise to the same
    // name, then push the (canonical) latest spelling.
    const filtered = state.djArtistHistory.filter(a => _normArtist(a) !== norm);
    filtered.push(trimmed);
    while (filtered.length > ARTIST_COOLDOWN_LIMIT) { filtered.shift(); }
    setState({ djArtistHistory: filtered });
  }

  function clearArtistHistory() {
    setState({ djArtistHistory: [] });
  }

  function getArtistHistory() {
    return [...state.djArtistHistory];
  }

  // ── ignoreList passthrough ──────────────────────────────────────
  //
  // The server is authoritative on what's in the ignoreList. The
  // client just persists whatever the server returns and sends it
  // back on the next call — with a tail-trim to IGNORE_LIST_LIMIT
  // so a buggy/malicious server response can't grow the localStorage
  // entry without bound or push the next request body past the
  // Joi.max(500) cap (which would 403 the next call).
  function setIgnoreList(list) {
    if (!Array.isArray(list)) {
      setState({ djIgnoreList: [] });
      return;
    }
    const trimmed = list.length > IGNORE_LIST_LIMIT ? list.slice(-IGNORE_LIST_LIMIT) : list;
    setState({ djIgnoreList: trimmed });
  }

  function getIgnoreList() {
    return [...state.djIgnoreList];
  }

  // ── Keyword filter ──────────────────────────────────────────────
  //
  // The filter-words list stores user-supplied skip terms. Match
  // semantics live in songBlocked above; the helpers here just
  // marshall the list (add with dedup + cap, remove, clear, read
  // a copy).
  //
  // Dedup uses case-insensitive comparison so "Live" and "live" are
  // treated as the same word. The stored form preserves the user's
  // casing for display in the tag pills — the matcher lowercases
  // both sides anyway, so the display casing has no effect on which
  // songs get blocked.
  //
  // Cap at FILTER_WORDS_LIMIT (50) — well above any realistic use
  // case; the cap exists purely to prevent runaway localStorage
  // growth from a script-pasted list.
  //
  // addFilterWord returns true if the word was added, false if it
  // was a dup / empty / over-cap. UI uses this to know whether to
  // clear the input field (only on success — leave the typed word
  // visible if the add failed so the user can edit and retry).
  function addFilterWord(word) {
    const trimmed = String(word || '').trim();
    if (!trimmed) { return false; }
    const lc = trimmed.toLowerCase();
    if (state.djFilterWords.some(w => w.toLowerCase() === lc)) { return false; }
    if (state.djFilterWords.length >= FILTER_WORDS_LIMIT) { return false; }
    setState({ djFilterWords: [...state.djFilterWords, trimmed] });
    return true;
  }

  function removeFilterWord(word) {
    const next = state.djFilterWords.filter(w => w !== word);
    if (next.length !== state.djFilterWords.length) {
      setState({ djFilterWords: next });
    }
  }

  function clearFilterWords() {
    setState({ djFilterWords: [] });
  }

  function getFilterWords() {
    return [...state.djFilterWords];
  }

  // ── Genre filter ────────────────────────────────────────────────
  //
  // List-of-genres + mode pair, plus the kind of genre link the list
  // matches (djGenreSource). Match semantics live in songBlocked above
  // (overlap test, inverted under blacklist mode). The Genres row and
  // drawer (the phone's Genres sheet) read genreValue / genreDraft and
  // write the whole filter at each change through setGenreFilter; the
  // filter is on exactly while genres are chosen (genreFilterOn). The
  // one-field helpers below marshal the list with the same shape as the
  // keyword filter (add with dedup + cap, remove exact-match, clear,
  // read a copy) plus a small mode getter/setter pair.
  //
  // Dedup is case-insensitive — "Hip Hop" + "hip hop" collapse to
  // the first-typed entry. Mirrors the keyword filter's policy. The
  // stored form preserves the user's casing for display; the server
  // matches COLLATE NOCASE so display casing has no effect on
  // filtering. The asymmetry on the remove side (case-sensitive
  // exact match) matches the keyword filter — the tag's data-attr
  // carries the exact stored form so click-to-remove always finds
  // its target.
  function addGenre(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) { return false; }
    const lc = trimmed.toLowerCase();
    if (state.djGenres.some(g => g.toLowerCase() === lc)) { return false; }
    if (state.djGenres.length >= GENRE_LIST_LIMIT) { return false; }
    setState({ djGenres: [...state.djGenres, trimmed] });
    return true;
  }

  function removeGenre(name) {
    const next = state.djGenres.filter(g => g !== name);
    if (next.length !== state.djGenres.length) {
      setState({ djGenres: next });
    }
  }

  function clearGenres() {
    setState({ djGenres: [] });
  }

  function getGenres() {
    return [...state.djGenres];
  }

  // Mode getter/setter — setter validates against GENRE_MODES so a
  // typo from a caller (e.g. `setGenreMode('blocklist')`) is a silent
  // no-op rather than a state corruption that ripples to the server
  // and 403s.
  function getGenreMode() {
    return state.djGenreMode;
  }

  function setGenreMode(mode) {
    if (!GENRE_MODES.includes(mode)) { return false; }
    setState({ djGenreMode: mode });
    return true;
  }

  // Genre names in the order the Genres row and drawer show them: by their
  // lowercase code units — the phone's comparator, not locale collation.
  function compareGenreNames(a, b) {
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return x < y ? -1 : (x > y ? 1 : 0);
  }

  // Whether the genre filter is on: exactly while genres are chosen. The
  // flag is written with the list (setGenreFilter); an older client's "on,
  // nothing chosen" or "off, with a list" reads off. [s]: a state (default:
  // this one).
  function genreFilterOn(s) {
    const st = s || state;
    return st.djGenreEnabled === true && Array.isArray(st.djGenres) && st.djGenres.length > 0;
  }

  // The Genres row's value: null while the filter is off, else the chosen
  // genres sorted (a copy) and whether they are skipped. [s]: as
  // genreFilterOn.
  function genreValue(s) {
    const st = s || state;
    if (!genreFilterOn(st)) { return null; }
    return { names: [...st.djGenres].sort(compareGenreNames), skip: st.djGenreMode === 'blacklist' };
  }

  // What the Genres drawer opens on (the phone's draft): the mode, the
  // chosen genres — none for a filter that is off, whose stored list stays
  // until the first change — and the kind. Copies.
  function genreDraft() {
    return {
      mode: state.djGenreMode,
      genres: genreFilterOn() ? [...state.djGenres] : [],
      source: state.djGenreSource,
    };
  }

  // The genre filter, written whole at each change in the Genres drawer:
  // Only ('whitelist') or Skip ('blacklist'; anything else keeps the stored
  // mode), the genres in tick order — strings of 1–200 characters, one per
  // name whatever its case (the first kept), at most 200: what the server's
  // Joi takes — on exactly while some are chosen, and the kind ('tag' |
  // 'model'; anything else is Mixed). One setState, so the four keys never
  // disagree. Returns what was stored (copies).
  function setGenreFilter(f) {
    const o = f && typeof f === 'object' ? f : {};
    const mode = GENRE_MODES.includes(o.mode) ? o.mode : state.djGenreMode;
    const genres = [];
    const taken = new Set();
    for (const name of (Array.isArray(o.genres) ? o.genres : [])) {
      if (genres.length >= GENRE_LIST_LIMIT) { break; }
      if (typeof name !== 'string' || name === '' || name.length > GENRE_NAME_MAX) { continue; }
      const lc = name.toLowerCase();
      if (taken.has(lc)) { continue; }
      taken.add(lc);
      genres.push(name);
    }
    const source = GENRE_KINDS.includes(o.source) ? o.source : null;
    setState({ djGenreMode: mode, djGenres: genres, djGenreEnabled: genres.length > 0, djGenreSource: source });
    return { mode, genres: [...genres], source };
  }

  // A genres answer's `sources` (how many genres of each kind the server
  // has; absent from a server older than the kinds). Without both kinds
  // there is no choice to show, so a stored Generated or Tags goes back to
  // Mixed: it can't go on narrowing picks with no switch to show it (the
  // phone's Done rule, applied as the answer arrives). True when both kinds
  // are there.
  function noteGenreSources(sources) {
    const both = !!sources && typeof sources === 'object'
      && Number(sources.tag) > 0 && Number(sources.model) > 0;
    if (!both && state.djGenreSource !== null) { setState({ djGenreSource: null }); }
    return both;
  }

  // Whether [server] ({ version }: /api/'s or a peer's federation health
  // `server`) takes random-songs' `genreSource`: an upstream number (an
  // optional leading v, major.minor[.patch], nothing after) at or above
  // 6.32.2. Unknown, or a fork's or pre-release's numbering (a -suffix),
  // can't be compared: false — a refused key would 400 every pick, and
  // nothing here learns from a refusal.
  function takesGenreSource(server) {
    const raw = server && typeof server === 'object' ? server.version : undefined;
    if (typeof raw !== 'string') { return false; }
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(raw.trim());
    if (!m) { return false; }
    const got = [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
    for (let i = 0; i < GENRE_SOURCE_SINCE.length; i++) {
      if (got[i] !== GENRE_SOURCE_SINCE[i]) { return got[i] > GENRE_SOURCE_SINCE[i]; }
    }
    return true;
  }

  // The kind of genre link to send [server]: the stored one while the filter
  // is on and narrowed to it, and the server takes the key; else null (Mixed:
  // every kind matches).
  function genreSourceFor(server) {
    if (!genreFilterOn() || !GENRE_KINDS.includes(state.djGenreSource)) { return null; }
    return takesGenreSource(server) ? state.djGenreSource : null;
  }

  // ── Track-length window ──────────────────────────────────────────
  //
  // Single commit point for both bounds, in SECONDS. Callers hand over
  // whatever the user typed and get back the pair that was actually
  // persisted, so a panel can write the clamped values straight back
  // into its inputs instead of showing something the next request
  // won't send.
  //
  // Three rules, applied in order:
  //   1. Each bound is clamped to [0, DURATION_MAX_SECONDS]. Blank /
  //      negative / non-numeric all collapse to 0, which means "no
  //      bound on this side" (same sentinel djMinRating uses for
  //      "Any"). Fractional seconds are rounded — the DB stores REAL
  //      but nobody filters on sub-second boundaries.
  //   2. A backwards window (min > max, both real) is PUSHED apart
  //      rather than rejected. `prefer` names the bound to keep: the
  //      side the user just edited. The server 403s a backwards
  //      window, and because the duration filter is never relaxed by
  //      the waterfall that 403 would break every pick for the rest
  //      of the session — repairing here means the UI can't put the
  //      session into that state at all.
  //   3. Both bounds are written together, so the pair is never
  //      momentarily inconsistent in localStorage.
  //
  // Note this does NOT touch djDurationEnabled: bounds survive the
  // toggle, matching how the keyword word-list and genre list survive
  // theirs.
  //
  // Rules 1 and 2 are durationWindow's, which stores nothing: Instant
  // Mix's Track length row (m.js) repairs its own window with it.
  function durationWindow(minSeconds, maxSeconds, prefer) {
    const clamp = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { return 0; }
      return Math.min(DURATION_MAX_SECONDS, Math.round(n));
    };
    let min = clamp(minSeconds);
    let max = clamp(maxSeconds);
    if (min > 0 && max > 0 && min > max) {
      if (prefer === 'max') { min = max; } else { max = min; }
    }
    return { min, max };
  }

  function setDurationBounds(minSeconds, maxSeconds, prefer) {
    const { min, max } = durationWindow(minSeconds, maxSeconds, prefer);
    setState({ djMinDuration: min, djMaxDuration: max });
    return { min, max };
  }

  // ── Songs per fetch ─────────────────────────────────────────────
  //
  // One place owns the rules — an integer from 1 to DJ_LIMIT_MAX — so a
  // typed "99", "0", "2.5" or "" can never reach the wire: the server's
  // Joi rejects a non-integer or out-of-range `limit` and would 400 every
  // pick until the field was fixed. Returns what was stored so the panel
  // can write it back into the input.
  function setLimit(raw) {
    const n = Math.round(Number(raw));
    const val = Number.isFinite(n) ? Math.max(1, Math.min(DJ_LIMIT_MAX, n)) : 1;
    setState({ djLimit: val });
    return val;
  }

  // ── Genres-list fetch cache ─────────────────────────────────────
  //
  // The SET of genres in the library (every kind: the Mixed list) and
  // how many genres of each kind the server has (the answer's
  // `sources`), fetched from /api/v1/db/genres as the Auto DJ panel
  // opens. It feeds the Genres row's off state (a list that is empty or
  // failed to load) and the Genres drawer's Mixed list and its
  // Generated | Tags | Mixed offer. Module-scoped, NOT persisted via
  // setState — the cache is ephemeral and ought to refresh when the
  // user reloads (e.g. after a rescan).
  //
  // 5-minute TTL: covers the "open panel, browse elsewhere, come
  // back" round-trip without making the user wait twice; short enough
  // that a rescan-during-session stale window is bounded.
  //
  // Returned arrays and objects are copies — mutating the result
  // doesn't poison the cache. invalidateGenresCache() is exported for
  // tests and as a manual refresh hook (e.g. a future post-rescan
  // event).
  let _genresListCache = null;  // { fetchedAt: number, items: string[], sources: { tag, model } | null } | null

  function _isGenresCacheFresh() {
    return _genresListCache != null
      && (Date.now() - _genresListCache.fetchedAt) < GENRES_CACHE_TTL_MS;
  }

  function getCachedGenresList() {
    return _isGenresCacheFresh() ? [..._genresListCache.items] : null;
  }

  // [sources]: the answer's { tag, model } counts, kept beside the names
  // as numbers; absent (a server older than the kinds) or not an object,
  // null.
  function setCachedGenresList(items, sources) {
    if (!Array.isArray(items)) { return; }
    const kinds = sources && typeof sources === 'object' && !Array.isArray(sources)
      ? { tag: Number(sources.tag) || 0, model: Number(sources.model) || 0 }
      : null;
    _genresListCache = { fetchedAt: Date.now(), items: [...items], sources: kinds };
  }

  // The cached answer's { tag, model }: a copy while the cache is fresh,
  // else null — and null when that answer carried none.
  function getCachedGenreSources() {
    if (!_isGenresCacheFresh() || !_genresListCache.sources) { return null; }
    return { ..._genresListCache.sources };
  }

  function invalidateGenresCache() {
    _genresListCache = null;
  }

  // ── Session seeds: More like and Less like (design E) ────────────
  //
  // The Auto DJ's two seed lists, a port of the phone's rules
  // (mstream_music 1fdc0f31: lib/util/auto_dj_seeds.dart, auto_dj_wire.dart
  // and auto_dj_skips.dart; the Dart docs there are the long form of the
  // comments below). More like is sent as random-songs' `similarTo`, Less
  // like as `lessLike`. A song is in one list at most: the server keeps a
  // positive that is also a negative and ignores the negative.
  //
  // Shapes:
  //   Facts  { owner: null | peerId, path: wire path (no leading '/'),
  //            title, artist, album, art: album-art FILE name | null,
  //            duration: seconds | null }        owner null = this server
  //   Row    Facts + { key, pinned (the user's own pin), origin: 'pick' |
  //            'opener' | 'anchor' | 'skip' | 'manual', at: ms }
  //            (+ bare: true while its facts still need a lookup)
  //   Set    { more: Row[], less: Row[], frozen, frozenAt }, each list
  //            oldest first. Immutable: every operation returns a new Set,
  //            or the very same one when nothing changed, so a caller tells
  //            a no-op by identity.
  //   List ids are 'more' and 'less' everywhere.
  //
  // Drift ('rolling', not frozen): DJ picks rotate through More like as they
  // play, at most five unpinned rows; unpinned Less like rows expire after
  // 30 minutes of Drift time. Stay close ('locked', frozen): both lists
  // hold still and every row shows pinned; a lane with nothing to stay
  // close to takes in one song to start. The user's own edits work in
  // either mode whenever the target list can take a row.

  const SEED_LISTS = Object.freeze(['more', 'less']);
  const SEED_ORIGINS = Object.freeze(['pick', 'opener', 'anchor', 'skip', 'manual']);
  // The range a Date takes, in ms on either side of the epoch.
  const MAX_EPOCH_MS = 8640000000000000;

  // ── The pure model (no state: every function takes `now` in ms) ──

  // [path] as a seed travels on the wire: without the leading slash a
  // browsed or searched queue row keeps (the server resolves seeds by
  // vpath). '' for anything that is not a string.
  function seedWirePath(path) {
    if (typeof path !== 'string') { return ''; }
    return path.charAt(0) === '/' ? path.slice(1) : path;
  }

  // A seed's identity: its server and its wire path, so '/a.mp3' and
  // 'a.mp3' are one song and the same path on two servers is two songs.
  // The federated pick's repeat guard uses the very same key.
  function seedKeyOf(owner, path) {
    return federatedKey(owner, path);
  }

  function _freezeSet(more, less, frozen, frozenAt) {
    return Object.freeze({
      more: Object.freeze(more),
      less: Object.freeze(less),
      frozen: frozen === true,
      frozenAt: frozen === true && Number.isFinite(frozenAt) ? frozenAt : null,
    });
  }

  // Both lists empty, not frozen.
  const emptySeeds = _freezeSet([], [], false, null);

  // Both lists empty, frozen from [now] when [frozen] (the stored mode is
  // Stay close).
  function freshSeeds(frozen, now) {
    return _freezeSet([], [], frozen === true, now);
  }

  function _isEmptySet(set) {
    return set.more.length === 0 && set.less.length === 0;
  }

  // [f] as clean Facts, or null for anything that is no song a server can
  // resolve (no path left once its slash goes, an owner that is no id).
  function _cleanFacts(f) {
    if (!f || typeof f !== 'object') { return null; }
    const path = seedWirePath(f.path);
    if (!path) { return null; }
    let owner = null;
    if (f.owner !== null && f.owner !== undefined) {
      const n = Number(f.owner);
      if (!Number.isFinite(n)) { return null; }
      owner = n;
    }
    const str = (v) => (typeof v === 'string' ? v : '');
    const dur = Number(f.duration);
    const out = {
      owner,
      path,
      title: str(f.title),
      artist: str(f.artist),
      album: str(f.album),
      art: typeof f.art === 'string' && f.art ? f.art : null,
      duration: f.duration !== null && f.duration !== undefined && Number.isFinite(dur) && dur > 0 ? dur : null,
    };
    if (f.bare === true) { out.bare = true; }
    return out;
  }

  function _fileName(path) {
    const s = String(path || '');
    return s.split('/').pop() || s;
  }

  // A row of [f]. It is bare (its facts wait for a lookup) when [bare] says
  // so, else when the facts say so or a song of this server has no title.
  function _row(f, { pinned = false, origin = 'manual', at, bare } = {}) {
    const isBare = bare !== undefined
      ? bare === true
      : (f.bare === true || (f.owner === null && !f.title));
    const row = {
      owner: f.owner,
      path: f.path,
      title: f.title,
      artist: f.artist,
      album: f.album,
      art: f.art,
      duration: f.duration,
      key: seedKeyOf(f.owner, f.path),
      pinned: pinned === true,
      origin: SEED_ORIGINS.includes(origin) ? origin : 'manual',
      at: Number.isFinite(at) ? at : Date.now(),
    };
    if (isBare) { row.bare = true; }
    return Object.freeze(row);
  }

  function _copy(row, changes) {
    const next = { ...row, ...changes };
    if (next.bare !== true) { delete next.bare; }
    return Object.freeze(next);
  }

  // The facts a row of a song that already has a row ([old]) takes: the
  // new ones, unless they still wait for a lookup and the old row's don't
  // (a file-browser row of a song More like already shows by its title).
  function _joinFacts(f, old) {
    const full = (x) => !!x.title && x.bare !== true;
    if (!old || full(f) || !full(old)) { return f; }
    return {
      owner: f.owner, path: f.path,
      title: old.title, artist: old.artist, album: old.album, art: old.art, duration: old.duration,
    };
  }

  function _rowsOf(set, list) {
    return list === 'more' ? set.more : set.less;
  }

  function _otherList(list) {
    return list === 'more' ? 'less' : 'more';
  }

  function _indexOf(rows, key) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].key === key) { return i; }
    }
    return -1;
  }

  function _without(rows, key) {
    return rows.filter((r) => r.key !== key);
  }

  function _same(a, b) {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { return false; }
    }
    return true;
  }

  // [set] with [more] and [less] as its lists, or [set] itself when they
  // hold the very same rows in the same order.
  function _withRows(set, more, less) {
    if (_same(more, set.more) && _same(less, set.less)) { return set; }
    return _freezeSet(more, less, set.frozen, set.frozenAt);
  }

  function _withLists(set, list, rows, other) {
    return list === 'more' ? _withRows(set, rows, other) : _withRows(set, other, rows);
  }

  // [rows] trimmed to what a list may hold. Past [cap] the oldest row whose
  // stored pin is false leaves first (the oldest of all only when every one
  // is pinned). With [rolling] (More like in Drift) the oldest unpinned rows
  // then leave until at most ROLLING_CAP remain, and never more than the
  // room the pinned rows leave of MAX_PER_LIST.
  function _fit(rows, { rolling, cap = SEEDS.MAX_PER_LIST } = {}) {
    const out = rows.slice();
    while (out.length > cap) {
      const i = out.findIndex((r) => !r.pinned);
      out.splice(i < 0 ? 0 : i, 1);
    }
    if (rolling) {
      const pinned = out.filter((r) => r.pinned).length;
      const room = Math.max(0, Math.min(SEEDS.MAX_PER_LIST - pinned, SEEDS.ROLLING_CAP));
      let unpinned = out.length - pinned;
      while (unpinned > room) {
        const i = out.findIndex((r) => !r.pinned);
        if (i < 0) { break; }
        out.splice(i, 1);
        unpinned--;
      }
    }
    return out;
  }

  // Whether the page shows [row] pinned: the user pinned it, or Stay close
  // holds every row in place.
  function shownPinned(set, row) {
    return set.frozen === true || row.pinned === true;
  }

  // Whether [list] can take one more row: fewer than eight rows, or one of
  // them shows unpinned and can make way. Eight rows all shown pinned are
  // full (Stay close at eight is full).
  function canAdd(set, list) {
    if (!SEED_LISTS.includes(list)) { return false; }
    const rows = _rowsOf(set, list);
    return rows.length < SEEDS.MAX_PER_LIST || rows.some((r) => !shownPinned(set, r));
  }

  // [facts], a DJ pick that started playing, as the newest More like row:
  // unpinned (a song already there moves to the newest place keeping its
  // pin), then the ring trims. [set] itself while frozen, for a song in
  // Less like, for a row with no path, and for a re-pick of the newest row
  // of the same origin.
  function pushPick(set, facts, { origin = 'pick', now } = {}) {
    const f = _cleanFacts(facts);
    if (set.frozen || !f) { return set; }
    const key = seedKeyOf(f.owner, f.path);
    if (_indexOf(set.less, key) >= 0) { return set; }
    const i = _indexOf(set.more, key);
    if (i >= 0 && i === set.more.length - 1 && set.more[i].origin === origin) { return set; }
    const old = i < 0 ? null : set.more[i];
    const row = _row(_joinFacts(f, old), { pinned: old ? old.pinned : false, origin, at: now });
    return _withRows(set, _fit([..._without(set.more, key), row], { rolling: true }), set.less);
  }

  // Stay close's one song: [facts] becomes the newest More like row, origin
  // 'anchor', unpinned (shown pinned while frozen), when no More like row
  // is [usable]. It ignores the freeze, never takes a row out and comes in
  // past eight up to sixteen. [set] itself when a row is usable, for a song
  // in either list, for a row with no path, and at sixteen rows.
  function admitAnchor(set, facts, { usable, now } = {}) {
    const f = _cleanFacts(facts);
    const ok = typeof usable === 'function' ? usable : () => true;
    if (!f || set.more.some(ok)) { return set; }
    const key = seedKeyOf(f.owner, f.path);
    if (_indexOf(set.less, key) >= 0 || _indexOf(set.more, key) >= 0) { return set; }
    if (set.more.length >= SEEDS.MAX_STORED_PER_LIST) { return set; }
    return _withRows(set, [...set.more, _row(f, { origin: 'anchor', at: now })], set.less);
  }

  // [facts], a DJ pick, quick-skipped: it leaves More like unless the user
  // pinned it there (then nothing at all). With [learn] it becomes the
  // newest Less like row, unpinned, its 30 minutes from [now] (a song there
  // already moves to newest with a fresh clock, keeping its pin); at eight
  // rows the oldest unpinned leaves, and eight pinned rows take no skip.
  // [set] itself while frozen.
  function quickSkip(set, facts, { learn, now } = {}) {
    const f = _cleanFacts(facts);
    if (set.frozen || !f) { return set; }
    const key = seedKeyOf(f.owner, f.path);
    const i = _indexOf(set.more, key);
    if (i >= 0 && set.more[i].pinned) { return set; }
    const more = i < 0 ? set.more : _without(set.more, key);
    let less = set.less;
    if (learn) {
      const j = _indexOf(set.less, key);
      const old = j < 0 ? null : set.less[j];
      const was = old || (i < 0 ? null : set.more[i]);
      const row = _row(_joinFacts(f, was), { pinned: old ? old.pinned : false, origin: 'skip', at: now });
      less = _fit([..._without(set.less, key), row], { rolling: false });
    }
    return _withRows(set, more, less);
  }

  // [facts] put into [list] by the user (Add song, the library pick, the
  // migrated seed): pinned, origin 'manual', the newest row, and out of the
  // other list. In Drift More like keeps the ring. Either mode. [set]
  // itself when [list] can't take a row, and for a row with no path.
  function addManual(set, list, facts, { now } = {}) {
    const f = _cleanFacts(facts);
    if (!canAdd(set, list) || !f) { return set; }
    const key = seedKeyOf(f.owner, f.path);
    const rows = _rowsOf(set, list);
    const other = _rowsOf(set, _otherList(list));
    const i = _indexOf(rows, key);
    const j = _indexOf(other, key);
    const was = i >= 0 ? rows[i] : (j >= 0 ? other[j] : null);
    const row = _row(_joinFacts(f, was), { pinned: true, origin: 'manual', at: now });
    const target = _fit([..._without(rows, key), row], { rolling: list === 'more' && !set.frozen });
    return _withLists(set, list, target, _without(other, key));
  }

  // The row [key] in [list] pinned or unpinned by the user. Unpinning a Less
  // like row starts its 30 minutes over; an unpinned More like row stays
  // until the next pick rotates the list. [set] itself while frozen, and for
  // a row that isn't there or already has that pin.
  function setPinned(set, list, key, pinned, { now } = {}) {
    if (set.frozen || !SEED_LISTS.includes(list)) { return set; }
    const rows = _rowsOf(set, list);
    const i = _indexOf(rows, key);
    if (i < 0 || rows[i].pinned === (pinned === true)) { return set; }
    const restart = pinned !== true && list === 'less';
    const next = rows.slice();
    next[i] = _copy(rows[i], { pinned: pinned === true, at: restart && Number.isFinite(now) ? now : rows[i].at });
    return _withLists(set, list, next, _rowsOf(set, _otherList(list)));
  }

  // [list] without the row [key], whatever its pin, either mode.
  function removeRow(set, list, key) {
    if (!SEED_LISTS.includes(list)) { return set; }
    const rows = _rowsOf(set, list);
    if (_indexOf(rows, key) < 0) { return set; }
    return _withLists(set, list, _without(rows, key), _rowsOf(set, _otherList(list)));
  }

  // The row [key] moved by the user to the other list ("More like this" /
  // "Less like this"): pinned, origin 'manual', the newest row, its facts
  // kept. [set] itself when neither list holds it, and when the other list
  // can't take a row.
  function moveRow(set, key, { now } = {}) {
    let from = null;
    if (_indexOf(set.more, key) >= 0) { from = 'more'; } else if (_indexOf(set.less, key) >= 0) { from = 'less'; }
    if (!from) { return set; }
    const to = _otherList(from);
    if (!canAdd(set, to)) { return set; }
    const source = _rowsOf(set, from);
    const old = source[_indexOf(source, key)];
    const row = _copy(old, { pinned: true, origin: 'manual', at: Number.isFinite(now) ? now : Date.now() });
    const target = _fit([..._rowsOf(set, to), row], { rolling: to === 'more' && !set.frozen });
    return _withLists(set, to, target, _without(source, key));
  }

  // Into Stay close at [now]: the unpinned Less like rows whose Drift time
  // ran out go first (never frozen in), then the freeze starts. The stored
  // pins stay as they are. [set] itself when frozen already, so the freeze
  // keeps the moment it began.
  function freeze(set, now) {
    if (set.frozen) { return set; }
    const live = prune(set, now);
    return _freezeSet(live.more, live.less, true, now);
  }

  // How long [row]'s clock has stood still in [set]'s freeze by [now]: since
  // the freeze began, or since the row came in when that was later.
  function _stoodStill(set, row, now) {
    const since = set.frozenAt === null ? now : set.frozenAt;
    const from = row.at > since ? row.at : since;
    const d = now - from;
    return d < 0 ? 0 : d;
  }

  // How much Drift time [row]'s clock has run in [set] by [now].
  function _ran(set, row, now) {
    if (!set.frozen) { return now - row.at; }
    const since = set.frozenAt === null ? now : set.frozenAt;
    return row.at < since ? since - row.at : 0;
  }

  // The `at` that gives a clock which has [ran] the same Drift time in a set
  // that is [frozen] since [since] (or not frozen). A clock that never ran
  // keeps its own time when it came in after the freeze began.
  function _clockAt(ran, at, { frozen, since, now }) {
    if (!frozen) { return now - ran; }
    if (ran === 0) { return at > since ? at : since; }
    return since - ran;
  }

  // Back in Drift at [now]: the user's own pins show again, each unpinned
  // Less like clock moves forward by the time it stood still, and More like
  // is trimmed to the ring, oldest unpinned first. [set] itself when not
  // frozen.
  function thaw(set, now) {
    if (!set.frozen) { return set; }
    return _freezeSet(
      _fit(set.more, { rolling: true }),
      set.less.map((r) => (r.pinned ? r : _copy(r, { at: r.at + _stoodStill(set, r, now) }))),
      false,
      null,
    );
  }

  // [set] frozen or not, as [frozen] asks.
  function inMode(set, now, frozen) {
    return frozen ? freeze(set, now) : thaw(set, now);
  }

  // [set] without the unpinned Less like rows whose 30 minutes ran out by
  // [now]: kept at 29:59, gone at 30:00. [set] itself while frozen and when
  // nothing expired.
  function prune(set, now) {
    if (set.frozen) { return set; }
    return _withRows(set, set.more, set.less.filter((r) => r.pinned || now - r.at < SEEDS.LESS_LIKE_TTL_MS));
  }

  // When the next unpinned Less like row runs out (ms), or null: none can,
  // or the set is frozen.
  function nextExpiry(set) {
    if (set.frozen) { return null; }
    let first = null;
    for (const r of set.less) {
      if (r.pinned) { continue; }
      const due = r.at + SEEDS.LESS_LIKE_TTL_MS;
      if (first === null || due < first) { first = due; }
    }
    return first;
  }

  // [set] as a new lane starts from it at [now], in the stored mode
  // ([frozen] = Stay close). Stay close keeps every row as it is (its pin,
  // its clock, the freeze); a never-armed set freezes from now. Drift keeps
  // the user's pins in both lists and every unpinned Less like row with its
  // clock; every unpinned More like row goes; a frozen set thaws.
  function carryOver(set, now, frozen) {
    if (frozen) { return inMode(set, now, true); }
    return inMode(_withRows(set, set.more.filter((r) => r.pinned), set.less), now, false);
  }

  // [live] with the held-aside set [pending] taken in: its rows come in as
  // they are, each the newest of its list, winning over the same song in
  // either live list; an unpinned Less like row keeps the Drift time it has
  // run; the caps apply, live's oldest unpinned rows making way; the result
  // is frozen when either set is, and a frozen live set past eight keeps its
  // count. [live] itself when [pending] is null or empty.
  function merge(live, pending, now) {
    if (!pending || _isEmptySet(pending)) { return live; }
    const isFrozen = live.frozen || pending.frozen;
    const since = live.frozen ? live.frozenAt : pending.frozenAt;
    let more = live.more.slice();
    let less = live.less.slice();
    for (const list of SEED_LISTS) {
      for (const p of _rowsOf(pending, list)) {
        more = _without(more, p.key);
        less = _without(less, p.key);
        let row = p;
        if (list === 'less' && !row.pinned) {
          row = _copy(row, {
            at: _clockAt(_ran(pending, row, now), row.at, { frozen: isFrozen, since: since === null ? now : since, now }),
          });
        }
        (list === 'more' ? more : less).push(row);
      }
    }
    const moreCap = isFrozen && live.more.length > SEEDS.MAX_PER_LIST ? live.more.length : SEEDS.MAX_PER_LIST;
    return _freezeSet(
      _fit(more, { rolling: !isFrozen, cap: moreCap }),
      _fit(less, { rolling: false }),
      isFrozen,
      isFrozen ? since : null,
    );
  }

  // Both lists without the rows the page shows pinned (the box's clear). In
  // Drift those are the user's pins, and the unpinned picks and skips stay;
  // in Stay close both lists empty and the set stays frozen.
  function withoutPinned(set) {
    return _withRows(
      set,
      set.more.filter((r) => !shownPinned(set, r)),
      set.less.filter((r) => !shownPinned(set, r)),
    );
  }

  // What becomes of the More like rows [keys] names that a server refused
  // as seeds: a row shown pinned is set aside, any other row is dropped.
  // Keys that name no More like row are in neither list.
  function culprits(set, keys) {
    const named = new Set(_keyList(keys));
    const drop = [];
    const setAside = [];
    for (const r of set.more) {
      if (!named.has(r.key)) { continue; }
      (shownPinned(set, r) ? setAside : drop).push(r.key);
    }
    return { drop, setAside };
  }

  function _keyList(keys) {
    if (!keys || typeof keys === 'string' || typeof keys[Symbol.iterator] !== 'function') { return []; }
    return Array.from(keys).filter((k) => typeof k === 'string' && k);
  }

  // Both lists without the rows whose key is in [keys].
  function withoutKeys(set, keys) {
    const named = new Set(_keyList(keys));
    if (named.size === 0) { return set; }
    return _withRows(set, set.more.filter((r) => !named.has(r.key)), set.less.filter((r) => !named.has(r.key)));
  }

  // The rows whose STORED pin is set, More like's first, each list oldest
  // first: [{ list, row }]. Never a row shown pinned only by the freeze.
  function pinnedRows(set) {
    return [
      ...set.more.filter((r) => r.pinned).map((row) => ({ list: 'more', row })),
      ...set.less.filter((r) => r.pinned).map((row) => ({ list: 'less', row })),
    ];
  }

  // What localStorage keeps of [set]: frozen, every row of both lists with
  // its own pin; in Drift, the user's pins only.
  function storedRows(set) {
    if (!set.frozen) { return pinnedRows(set); }
    return [
      ...set.more.map((row) => ({ list: 'more', row })),
      ...set.less.map((row) => ({ list: 'less', row })),
    ];
  }

  // One stored row as its JSON entry.
  function storedRowToJson(row, list) {
    const out = {
      list,
      owner: row.owner,
      path: row.path,
      title: row.title,
      artist: row.artist,
      album: row.album,
      art: row.art,
      duration: row.duration,
      origin: row.origin,
      pinned: row.pinned,
      at: row.at,
    };
    if (row.bare === true) { out.bare = true; }
    return out;
  }

  function _validTime(raw) {
    return Number.isInteger(raw) && raw >= -MAX_EPOCH_MS && raw <= MAX_EPOCH_MS ? raw : null;
  }

  // One JSON entry read back as { list, row }, or null for anything that
  // is none (an unknown list, no path, an owner that is no id). It never
  // throws. Only an explicit `pinned: false` reads unpinned and only
  // `bare: true` reads bare; an unknown origin reads 'manual' and a bad
  // time reads [now].
  function storedRowFromJson(json, now) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) { return null; }
    if (!SEED_LISTS.includes(json.list)) { return null; }
    const f = _cleanFacts(json);
    if (!f) { return null; }
    const at = _validTime(json.at);
    return {
      list: json.list,
      row: _row(f, {
        pinned: json.pinned !== false,
        origin: SEED_ORIGINS.includes(json.origin) ? json.origin : 'manual',
        at: at === null ? now : at,
        bare: json.bare === true,
      }),
    };
  }

  // Stored rows as one comparable value: each row's list, its own pin and
  // its key, in order. The rows are written only when this changes, so a
  // pick in Drift (an unpinned row) writes nothing.
  function storedSignature(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((e) => `${e.list}/${e.row.pinned ? 'p' : 'u'}/${e.row.key.length}/${e.row.key}`)
      .join('');
  }

  // The stored entries a load brings back, in file order: once each (a key
  // named twice keeps its last entry) and at most [perList] of each list;
  // past it the oldest stored-unpinned rows go first, then the oldest.
  function restorableRows(entries, perList = SEEDS.MAX_PER_LIST) {
    const known = (Array.isArray(entries) ? entries : []).filter((e) => e && e.row && SEED_LISTS.includes(e.list));
    const last = new Map();
    known.forEach((e, i) => { last.set(e.row.key, i); });
    const once = known.filter((e, i) => last.get(e.row.key) === i);
    const keep = once.map(() => true);
    for (const list of SEED_LISTS) {
      const idx = [];
      once.forEach((e, i) => { if (e.list === list) { idx.push(i); } });
      let over = idx.length - perList;
      for (const i of idx) {
        if (over <= 0) { break; }
        if (!once[i].row.pinned) { keep[i] = false; over--; }
      }
      for (const i of idx) {
        if (over <= 0) { break; }
        if (keep[i]) { keep[i] = false; over--; }
      }
    }
    return once.filter((_, i) => keep[i]);
  }

  // [set] with the stored rows [rows] taken back in, each with its own pin,
  // at the OLDEST end of their lists; a song [set] already holds keeps the
  // set's row. Into a frozen set, an unpinned Less like row keeps the Drift
  // time its clock had run when the stored lists froze ([storedFrozenAt]),
  // moved onto this set's own freeze. Then the caps (a frozen More like
  // keeps up to sixteen). [set] itself when nothing comes in.
  function withStoredRows(set, rows, storedFrozenAt = null) {
    const held = new Set([...set.more.map((r) => r.key), ...set.less.map((r) => r.key)]);
    const incoming = (Array.isArray(rows) ? rows : [])
      .filter((e) => e && e.row && e.row.path && !held.has(e.row.key));
    const last = new Map();
    incoming.forEach((e, i) => { last.set(e.row.key, i); });
    const since = set.frozenAt;
    const rebased = (r) => {
      if (!set.frozen || !Number.isFinite(storedFrozenAt) || since === null) { return r; }
      const ran = r.at < storedFrozenAt ? storedFrozenAt - r.at : 0;
      const at = _clockAt(ran, r.at, { frozen: true, since, now: since });
      return at === r.at ? r : _copy(r, { at });
    };
    const more = [];
    const less = [];
    incoming.forEach((e, i) => {
      if (last.get(e.row.key) !== i) { return; }
      if (e.list === 'more') { more.push(e.row); } else { less.push(e.row.pinned ? e.row : rebased(e.row)); }
    });
    if (more.length === 0 && less.length === 0) { return set; }
    return _withRows(
      set,
      _fit([...more, ...set.more], { rolling: !set.frozen, cap: set.frozen ? SEEDS.MAX_STORED_PER_LIST : SEEDS.MAX_PER_LIST }),
      _fit([...less, ...set.less], { rolling: false }),
    );
  }

  // A page load's restore of the stored entries [stored] into [live], in the
  // stored mode. Drift: only the stored pins come back, not frozen. Stay
  // close: every stored row with its own pin (More like up to sixteen) into
  // a set frozen from [frozenAt] (else [now]), never through freeze()'s
  // prune, the unpinned skip clocks rebased so time the page was closed
  // never counts as Drift time.
  function loadStored(live, stored, { frozen, frozenAt = null, now } = {}) {
    const entries = Array.isArray(stored) ? stored : [];
    if (!frozen) {
      return inMode(withStoredRows(live, restorableRows(entries.filter((e) => e.row.pinned))), now, false);
    }
    let frame;
    if (live.frozen) { frame = live; }
    else if (_isEmptySet(live)) { frame = freshSeeds(true, Number.isFinite(frozenAt) ? frozenAt : now); }
    else { frame = freeze(live, now); }
    return withStoredRows(frame, restorableRows(entries, SEEDS.MAX_STORED_PER_LIST), frozenAt);
  }

  // The newest [n] More like rows, newest first (the Seeds row's covers).
  function tiles(set, n = 3) {
    return n <= 0 ? [] : set.more.slice().reverse().slice(0, n);
  }

  // The More like rows a request can carry: the [usable] ones, oldest
  // first, at most eight. Past eight the oldest stored-unpinned row stays
  // home first (the oldest of all only when every one is pinned), so the
  // user's pins go out and Stay close's stand-in waits.
  function usableSeeds(rows, usable) {
    const ok = typeof usable === 'function' ? usable : () => true;
    const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.path && ok(r));
    while (kept.length > SEEDS.WIRE_CAP) {
      const i = kept.findIndex((r) => !r.pinned);
      kept.splice(i < 0 ? 0 : i, 1);
    }
    return kept;
  }

  // Whether a queue clear also takes the pinned rows (the box): ticked, a
  // user's clear, and the queue held a row.
  function clearsPinsOnClear({ userClear, queueHadRows, setting } = {}) {
    return !!userClear && !!queueHadRows && !!setting;
  }

  // Whether an Add song lands in the held-aside set: one is held, the DJ is
  // off, or its lane has not picked yet.
  function seedAddHeldAside({ held, armed, lanePicked } = {}) {
    return !!held || !armed || !lanePicked;
  }

  // Whether the song playing joins More like at a lane's first pick (the
  // blend): Drift, the lane's first pick, a song the route can carry, not
  // in Less like, not in More like already, and no DJ pick of this lane.
  function blendsOnLaneStart({ drift, laneStart, usable, inLessLike, alreadyMoreLike, isLanePick } = {}) {
    return !!drift && !!laneStart && !!usable && !inLessLike && !alreadyMoreLike && !isLanePick;
  }

  // Whether a quick skip of the row [key] is one of the song this lane's
  // start blended in (the user's own row, while More like holds it
  // unpinned): it leaves More like and teaches nothing.
  function quickSkipsBlend({ key, blended, isDjPick, unpinnedInMoreLike } = {}) {
    return !isDjPick && blended !== null && blended !== undefined && key === blended && !!unpinnedInMoreLike;
  }

  // Whether a play counts (the server's rule): heard 30 s, or half a known
  // length.
  function countsAsPlay(heardMs, durationMs) {
    const heard = Number(heardMs);
    if (!Number.isFinite(heard)) { return false; }
    if (heard >= SEEDS.PLAY_COUNT_MS) { return true; }
    if (durationMs === null || durationMs === undefined) { return false; }
    const dur = Number(durationMs);
    if (!Number.isFinite(dur) || dur <= 0) { return false; }
    return heard >= dur * SEEDS.PLAY_COUNT_SHARE;
  }

  // Whether a Next is a quick skip: of a DJ pick (or the blended song, which
  // the caller passes as one), to another row, heard at least a second and
  // not long enough to count as a play.
  function isQuickSkip({ djPick, heardMs, durationMs, hasNext } = {}) {
    const heard = Number(heardMs);
    return !!djPick && !!hasNext && Number.isFinite(heard)
      && heard >= SEEDS.QUICK_SKIP_MIN_HEARD_MS && !countsAsPlay(heard, durationMs);
  }

  // Facts of a song object of the queue (`rawFilePath`, `metadata`, and the
  // `federation` marker a peer row carries), or null.
  function factsFromSong(song) {
    if (!song || typeof song !== 'object') { return null; }
    const fed = song.federation;
    const owner = fed && fed.peerId !== null && fed.peerId !== undefined && Number.isFinite(Number(fed.peerId))
      ? Number(fed.peerId) : null;
    return factsFromMeta(song.rawFilePath, song.metadata, owner);
  }

  // Facts of [path] with a metadata object ([meta]: a lookupMetadata or
  // Recently played answer, a queue row's metadata), or null for no path.
  function factsFromMeta(path, meta, owner = null) {
    const m = meta && typeof meta === 'object' ? meta : {};
    return _cleanFacts({
      owner,
      path,
      title: m.title,
      artist: typeof m.artist === 'string' && m.artist ? m.artist : m['artist-display'],
      album: m.album,
      art: m['album-art'],
      duration: m.duration,
    });
  }

  // Facts of a title search hit ({ name, filepath, album_art_file, metadata
  // (lite) }): the title falls back to the hit's name.
  function factsFromSearchHit(hit) {
    if (!hit || typeof hit !== 'object') { return null; }
    const f = factsFromMeta(hit.filepath, hit.metadata, null);
    if (!f) { return null; }
    if (!f.title && typeof hit.name === 'string') { f.title = hit.name; }
    if (!f.art && typeof hit.album_art_file === 'string' && hit.album_art_file) { f.art = hit.album_art_file; }
    return f;
  }

  // Facts of a Recently played item ({ filepath, metadata }).
  function factsFromRecent(item) {
    if (!item || typeof item !== 'object') { return null; }
    return factsFromMeta(item.filepath, item.metadata, null);
  }

  function _factsOfAny(x) {
    if (!x || typeof x !== 'object') { return null; }
    return x.rawFilePath !== undefined ? factsFromSong(x) : _cleanFacts(x);
  }

  // Add song's sections for [list] (Facts[] each, at most twenty): Up next
  // (the queue after [position], queue order), Skipped (only for Less like:
  // the current queue row [current], then the ring [skips] newest first)
  // and Recently played ([recent]). This server's songs only, never one in
  // the TARGET list, each song once, in the first section that has it; a
  // song in the other list stays offered (picking it moves it).
  function addSongSections({ list, playlist, position, current, skips, recent, view } = {}) {
    const targetRows = view && list === 'less' ? view.less : (view ? view.more : null);
    const target = new Set((Array.isArray(targetRows) ? targetRows : []).map((r) => r && r.key).filter(Boolean));
    const shown = new Set();
    const take = (facts, out) => {
      if (!facts || facts.owner !== null || out.length >= SEEDS.ADD_SECTION_MAX) { return; }
      const key = seedKeyOf(facts.owner, facts.path);
      if (target.has(key) || shown.has(key)) { return; }
      shown.add(key);
      out.push(facts);
    };
    const upNext = [];
    const rows = Array.isArray(playlist) ? playlist : [];
    const pos = Number.isInteger(position) ? position : -1;
    for (let i = Math.max(0, pos + 1); i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.federation) { continue; }
      take(factsFromSong(row), upNext);
    }
    const skipped = [];
    if (list === 'less') {
      if (current && !current.federation) { take(_factsOfAny(current), skipped); }
      for (const s of (Array.isArray(skips) ? skips : [])) { take(_cleanFacts(s), skipped); }
    }
    const played = [];
    for (const r of (Array.isArray(recent) ? recent : [])) { take(_cleanFacts(r), played); }
    return { upNext, skipped, recent: played };
  }

  // Today's stored seed title ("Artist - Title — Artist", the old panel's
  // search hit name plus its artist) as { title, artist }: split at the last
  // " — ", then a leading "Artist - " dropped. A title that is only its
  // [path] (the old fallback) reads as none.
  function repairLegacyTitle(title, path) {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) { return { title: '', artist: '' }; }
    if (typeof path === 'string' && path && seedWirePath(t) === seedWirePath(path)) { return { title: '', artist: '' }; }
    const sep = ' — ';
    const i = t.lastIndexOf(sep);
    if (i < 0) { return { title: t, artist: '' }; }
    const left = t.slice(0, i).trim();
    const artist = t.slice(i + sep.length).trim();
    const prefix = `${artist} - `;
    return { title: artist && left.startsWith(prefix) ? left.slice(prefix.length) : left, artist };
  }

  // Whether [server] (MSTREAMAPI.currentServer) takes Less like negatives:
  // its ping's picker generation is at least 1 and discovery is on. The UI
  // and Learn from skips gate on it; the wire also waits for the scan.
  function takesNegatives(server) {
    return !!server && Number(server.autoDj) >= 1 && server.discovery === true;
  }

  // Whether [server]'s ping answered a picker generation below 1: Less like
  // and Learn from skips read "Needs a newer server". Before the ping
  // answers, false.
  function needsNewerServer(server) {
    return !!server && typeof server.autoDj === 'number' && server.autoDj < 1;
  }

  const SEEDS_MODEL = Object.freeze({
    seedWirePath, emptySeeds, freshSeeds, shownPinned, canAdd, pushPick, admitAnchor, quickSkip,
    addManual, setPinned, removeRow, moveRow, freeze, thaw, inMode, prune, nextExpiry, carryOver,
    merge, withoutPinned, culprits, withoutKeys, pinnedRows, storedRows, storedRowToJson,
    storedRowFromJson, storedSignature, restorableRows, withStoredRows, loadStored, tiles,
    usableSeeds, clearsPinsOnClear, seedAddHeldAside, blendsOnLaneStart, quickSkipsBlend,
    isQuickSkip, countsAsPlay, addSongSections, repairLegacyTitle,
  });

  // ── The seeds container (module state; side effects only here) ──
  //
  // The live set the lane works, the held-aside set (edits made while the
  // DJ is off or before its lane's first pick: Start and every clear start
  // a new lane, which would drop them), the lane's flags, the songs a server
  // refused this lane (set aside: never sent; a pinned row stays listed),
  // the Skipped ring and the listeners. Every mutating call persists (only
  // when what storage keeps changed) and tells the listeners; reads prune
  // expired Drift Less like rows in place but tell nobody (a Drift prune
  // changes no stored row), so a listener that renders through view()
  // can't re-enter itself.
  // No timers here: the UI schedules its own expiry redraw.

  const SEEDS_ROWS_KEY = 'seedsRows';
  const SEEDS_FROZEN_AT_KEY = 'seedsFrozenAt';
  const RECENT_SKIPS_KEY = 'djRecentSkips';
  const LEGACY_SEED_KEYS = Object.freeze(['sonicSeed', 'sonicHistory', 'sonicHistoryOwners', 'sonicLockedAnchor']);

  function _freshLane(id) {
    return {
      id,
      picked: false,
      blendKey: null,
      skippedBlendKey: null,
      stayCloseAnchored: false,
      stayCloseAdmitted: false,
      lastPushKey: null,
    };
  }

  let _seedsLive = emptySeeds;
  let _seedsPending = null;
  let _seedsArmed = false;
  let _seedsLane = _freshLane(0);
  const _seedsSetAside = new Set();
  let _seedsRing = [];
  const _seedsListeners = new Set();
  let _seedsSaved = '';

  function _seedsMode() {
    return _stateRaw.sonicAnchorMode === 'locked' ? 'locked' : 'rolling';
  }

  function _seedsView(now) {
    return merge(_seedsLive, _seedsPending, now);
  }

  function _seedsPruneSilently(now) {
    _seedsLive = prune(_seedsLive, now);
    if (_seedsPending) { _seedsPending = prune(_seedsPending, now); }
  }

  function _seedsSnap() {
    return { live: _seedsLive, pending: _seedsPending };
  }

  // What storage keeps of the view, written when its signature changed
  // since the last write (or [force]: the box's clear, a filled stored row,
  // the migration).
  function _seedsPersist(now, force) {
    const view = _seedsView(now);
    const rows = storedRows(view);
    const signature = storedSignature(rows);
    if (!force && signature === _seedsSaved) { return; }
    _seedsSaved = signature;
    _write(SEEDS_ROWS_KEY, rows.map((e) => storedRowToJson(e.row, e.list)));
    _write(SEEDS_FROZEN_AT_KEY, view.frozen ? view.frozenAt : null);
  }

  function _seedsDraw(set) {
    const draw = (list) => (r) => ({
      ...r,
      list,
      shownPinned: shownPinned(set, r),
      locked: set.frozen,
      displayTitle: r.title || _fileName(r.path),
    });
    const more = set.more.map(draw('more')).reverse();
    const less = set.less.map(draw('less')).reverse();
    return {
      mode: _seedsMode(),
      frozen: set.frozen,
      more,
      less,
      tiles: more.slice(0, 3),
      canAdd: { more: canAdd(set, 'more'), less: canAdd(set, 'less') },
    };
  }

  function _seedsNotify(now) {
    if (_seedsListeners.size === 0) { return; }
    const view = _seedsDraw(_seedsView(now));
    for (const fn of Array.from(_seedsListeners)) {
      try {
        fn(view);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[AUTODJ] a seeds listener failed', err);
      }
    }
  }

  // After a mutation: persist and notify when a set changed by identity.
  // Returns whether one did.
  function _seedsCommit(before, now, force) {
    const changed = _seedsLive !== before.live || _seedsPending !== before.pending;
    if (changed || force) { _seedsPersist(now, force === true); }
    if (changed) { _seedsNotify(now); }
    return changed;
  }

  // [edit] on each set that holds [key] in [list] (the held-aside one, the
  // live one, or both).
  function _seedsEdit(list, key, edit) {
    if (_seedsPending && _indexOf(_rowsOf(_seedsPending, list), key) >= 0) { _seedsPending = edit(_seedsPending); }
    if (_indexOf(_rowsOf(_seedsLive, list), key) >= 0) { _seedsLive = edit(_seedsLive); }
  }

  function _seedsListOf(set, key) {
    if (_indexOf(set.more, key) >= 0) { return 'more'; }
    if (_indexOf(set.less, key) >= 0) { return 'less'; }
    return null;
  }

  function _lsHas(key) {
    const ls = _ls();
    if (!ls) { return false; }
    try {
      return ls.getItem(LS_PREFIX + key) !== null;
    } catch (_) {
      return false;
    }
  }

  // Module load (and the test-only rehydrate): the stored rows come back in
  // the stored mode, the Skipped ring is read, and today's seed and anchor
  // ring migrate once: the seed (`sonicSeed`) becomes a pinned More like row
  // with its title repaired and marked bare (a lookup fills its facts), the
  // ring, its owners and the locked anchor are dropped, and all four keys
  // leave storage. The DJ is always off at a page load.
  function _seedsInit(now = Date.now()) {
    _seedsListeners.clear();
    _seedsPending = null;
    _seedsArmed = false;
    _seedsLane = _freshLane(0);
    _seedsSetAside.clear();
    const stored = [];
    const raw = _read(SEEDS_ROWS_KEY, null);
    if (Array.isArray(raw)) {
      for (const json of raw) {
        const entry = storedRowFromJson(json, now);
        if (entry) { stored.push(entry); }
      }
    }
    _seedsLive = loadStored(emptySeeds, stored, {
      frozen: _seedsMode() === 'locked',
      frozenAt: _validTime(_read(SEEDS_FROZEN_AT_KEY, null)),
      now,
    });
    _seedsSaved = storedSignature(stored);
    const ring = _read(RECENT_SKIPS_KEY, null);
    const seen = new Set();
    _seedsRing = (Array.isArray(ring) ? ring : [])
      .map((x) => _cleanFacts(x))
      .filter((f) => {
        if (!f) { return false; }
        const key = seedKeyOf(f.owner, f.path);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
      })
      .slice(0, SEEDS.RECENT_SKIPS_MAX);
    let migrated = false;
    if (LEGACY_SEED_KEYS.some(_lsHas)) {
      const seed = _read('sonicSeed', null);
      const path = seed && typeof seed === 'object' ? seedWirePath(seed.filepath) : '';
      if (path) {
        const named = repairLegacyTitle(seed.title, seed.filepath);
        _seedsLive = addManual(_seedsLive, 'more', {
          owner: null, path, title: named.title, artist: named.artist, album: '', art: null, duration: null, bare: true,
        }, { now });
      }
      for (const k of LEGACY_SEED_KEYS) { _write(k, null); }
      migrated = true;
    }
    _seedsPersist(now, migrated);
  }

  /**
   * The seeds as the page draws them: the live set merged with the held-
   * aside one, expired Drift Less like rows pruned first (silently).
   * @param {number} [now] ms
   * @returns {{ mode: 'rolling'|'locked', frozen: boolean, more: object[],
   *   less: object[], tiles: object[], canAdd: { more: boolean, less: boolean } }}
   *   more / less newest first; each row is a Row plus { list, shownPinned,
   *   locked, displayTitle }; tiles = the three newest More like rows. Read-only.
   */
  function seedsView(now = Date.now()) {
    _seedsPruneSilently(now);
    return _seedsDraw(_seedsView(now));
  }

  /**
   * Calls [fn](view) after every real change of the seeds (rows, pins, mode,
   * frozen), never for a no-op; a throwing listener is caught.
   * @param {(view: object) => void} fn
   * @returns {() => void} unsubscribe
   */
  function seedsSubscribe(fn) {
    if (typeof fn !== 'function') { return () => {}; }
    _seedsListeners.add(fn);
    return () => { _seedsListeners.delete(fn); };
  }

  /**
   * Add song (and the library pick): [facts] into [list] ('more' | 'less'),
   * pinned, the newest row, out of the other list. Held aside while the DJ
   * is off or its lane has not picked yet. Less like takes this server's
   * songs only.
   * @param {'more'|'less'} list
   * @param {object} facts
   * @param {number} [now]
   * @returns {boolean} whether the seeds changed (false when the list the
   *   page shows can't take a row)
   */
  function seedsAdd(list, facts, now = Date.now()) {
    if (!SEED_LISTS.includes(list)) { return false; }
    const f = _cleanFacts(facts);
    if (!f || (list === 'less' && f.owner !== null)) { return false; }
    _seedsPruneSilently(now);
    if (!canAdd(_seedsView(now), list)) { return false; }
    const before = _seedsSnap();
    if (seedAddHeldAside({ held: _seedsPending !== null, armed: _seedsArmed, lanePicked: _seedsLane.picked })) {
      const base = _seedsPending || freshSeeds(_seedsMode() === 'locked', now);
      const next = addManual(base, list, f, { now });
      if (next !== base) { _seedsPending = next; }
    } else {
      _seedsLive = addManual(_seedsLive, list, f, { now });
    }
    return _seedsCommit(before, now);
  }

  /**
   * A row's "More like this" / "Less like this": the row [key] to the other
   * list, pinned, the newest row, in every set that holds it.
   * @param {string} key
   * @param {number} [now]
   * @returns {boolean} false when the target can't take a row, or (into
   *   Less like) the row is a peer's
   */
  function seedsMove(key, now = Date.now()) {
    _seedsPruneSilently(now);
    const view = _seedsView(now);
    const from = _seedsListOf(view, key);
    if (!from) { return false; }
    const to = _otherList(from);
    if (!canAdd(view, to)) { return false; }
    const rows = _rowsOf(view, from);
    if (to === 'less' && rows[_indexOf(rows, key)].owner !== null) { return false; }
    const before = _seedsSnap();
    _seedsEdit(from, key, (s) => moveRow(s, key, { now }));
    return _seedsCommit(before, now);
  }

  /**
   * The pin toggle of the row [key]. A no-op while frozen (Stay close shows
   * every pin locked). Unpinning a Less like row restarts its 30 minutes.
   * @param {string} key
   * @param {boolean} pinned
   * @param {number} [now]
   * @returns {boolean} whether the seeds changed
   */
  function seedsSetPinned(key, pinned, now = Date.now()) {
    _seedsPruneSilently(now);
    const list = _seedsListOf(_seedsView(now), key);
    if (!list) { return false; }
    const before = _seedsSnap();
    _seedsEdit(list, key, (s) => setPinned(s, list, key, pinned === true, { now }));
    return _seedsCommit(before, now);
  }

  /**
   * Remove: the row [key] out of both lists of both sets, whatever its pin,
   * either mode.
   * @param {string} key
   * @returns {boolean} whether the seeds changed
   */
  function seedsRemove(key, now = Date.now()) {
    const before = _seedsSnap();
    for (const list of SEED_LISTS) { _seedsEdit(list, key, (s) => removeRow(s, list, key)); }
    return _seedsCommit(before, now);
  }

  /**
   * Drift ('rolling') or Stay close ('locked'). Stores the mode, freezes or
   * thaws both sets, re-arms the Stay close admission (into Stay close) and
   * gives the set-aside rows another go; tells the listeners once.
   * @param {'rolling'|'locked'} mode anything else is refused
   * @param {number} [now]
   * @returns {boolean} false when refused or already in that mode
   */
  function seedsSetMode(mode, now = Date.now()) {
    if (!SONIC_ANCHOR_MODES.includes(mode)) { return false; }
    if (_seedsMode() === mode) { return false; }
    _stateRaw.sonicAnchorMode = mode;
    _write('sonicAnchorMode', mode);
    const lock = mode === 'locked';
    _seedsLive = inMode(_seedsLive, now, lock);
    if (_seedsPending) { _seedsPending = inMode(_seedsPending, now, lock); }
    if (lock) {
      _seedsLane.stayCloseAnchored = false;
      _seedsLane.stayCloseAdmitted = false;
    }
    _seedsSetAside.clear();
    _seedsPersist(now, false);
    _seedsNotify(now);
    return true;
  }

  /**
   * The DJ on or off (where Add song lands, and whether a play joins).
   * @param {boolean} on
   */
  function seedsSetArmed(on) {
    _seedsArmed = on === true;
  }

  /**
   * A lane edge: DJ Start, Stop, every queue clear. With [clearPins] (the
   * box, a user's clear of a queue that held a row) the rows shown pinned go
   * first, from both sets, and storage is written. Then the carry-over
   * (Drift: pins and unpinned skips stay, picks go; Stay close: every row
   * stays) and the lane reset: a new lane id, no first pick yet, no blend,
   * no skipped blend, no Stay close flags, no set-aside rows, no push key.
   * @param {{ clearPins?: boolean, now?: number }} [opts]
   * @returns {number} the new lane id
   */
  function seedsLaneEdge({ clearPins = false, now = Date.now() } = {}) {
    const before = _seedsSnap();
    if (clearPins === true) {
      _seedsLive = withoutPinned(_seedsLive);
      if (_seedsPending) {
        const rest = withoutPinned(_seedsPending);
        _seedsPending = _isEmptySet(rest) ? null : rest;
      }
    }
    _seedsLive = carryOver(_seedsLive, now, _seedsMode() === 'locked');
    _seedsLane = _freshLane(_seedsLane.id + 1);
    _seedsSetAside.clear();
    _seedsCommit(before, now, clearPins === true);
    return _seedsLane.id;
  }

  /** @returns {number} this lane's id (DJ picks carry it as metadata._djLane) */
  function seedsLaneId() {
    return _seedsLane.id;
  }

  /**
   * A pick starts (before it reads the seeds). Prunes; at the lane's first
   * pick takes the held-aside set in, then (Drift) blends [current], the
   * current queue row, into More like, unpinned, when [route] can carry it,
   * it is in neither list and is no DJ pick of this lane
   * ([currentIsLanePick]). In Stay close with [sonicOn], until the lane is
   * anchored: no usable More like row admits [current] as the one song.
   * @param {{ current?: object|null, currentIsLanePick?: boolean,
   *   route?: 'local'|'fanout', sonicOn?: boolean, now?: number }} [opts]
   * @returns {{ first: boolean }} whether this was the lane's first pick
   */
  function seedsBeginPick({ current = null, currentIsLanePick = false, route = 'local', sonicOn = false, now = Date.now() } = {}) {
    const before = _seedsSnap();
    _seedsPruneSilently(now);
    const first = !_seedsLane.picked;
    const cur = _cleanFacts(current);
    const fanout = route === 'fanout';
    if (first) {
      if (_seedsPending) {
        _seedsLive = merge(_seedsLive, _seedsPending, now);
        _seedsPending = null;
      }
      _seedsLane.picked = true;
      if (cur) {
        const key = seedKeyOf(cur.owner, cur.path);
        if (blendsOnLaneStart({
          drift: _seedsMode() === 'rolling',
          laneStart: true,
          usable: fanout || cur.owner === null,
          inLessLike: _indexOf(_seedsLive.less, key) >= 0,
          alreadyMoreLike: _indexOf(_seedsLive.more, key) >= 0,
          isLanePick: currentIsLanePick === true,
        })) {
          const next = pushPick(_seedsLive, cur, { origin: 'opener', now });
          if (next !== _seedsLive) {
            _seedsLive = next;
            if (_indexOf(next.more, key) >= 0) { _seedsLane.blendKey = key; }
          }
        }
      }
    }
    if (sonicOn === true && _seedsMode() === 'locked' && !_seedsLane.stayCloseAnchored) {
      const usable = (r) => !_seedsSetAside.has(r.key) && (fanout || r.owner === null);
      if (_seedsLive.more.some(usable)) {
        _seedsLane.stayCloseAnchored = true;
      } else if (cur && usable({ key: seedKeyOf(cur.owner, cur.path), owner: cur.owner })) {
        const next = admitAnchor(_seedsLive, cur, { usable, now });
        if (next !== _seedsLive) {
          _seedsLive = next;
          _seedsLane.stayCloseAnchored = true;
          _seedsLane.stayCloseAdmitted = true;
        }
      }
    }
    _seedsCommit(before, now);
    return { first };
  }

  /**
   * A song started playing while the DJ is on. Once per playing row (the
   * key moves on in either mode, for every row): a DJ pick of this lane
   * ([lanePick]) joins More like, unpinned, the newest row, in Drift.
   * @param {object|null} facts
   * @param {{ lanePick?: boolean, now?: number }} [opts]
   * @returns {boolean} whether the seeds changed
   */
  function seedsOnPlay(facts, { lanePick = false, now = Date.now() } = {}) {
    const f = _cleanFacts(facts);
    if (!f) {
      _seedsLane.lastPushKey = null;
      return false;
    }
    const key = seedKeyOf(f.owner, f.path);
    if (key === _seedsLane.lastPushKey) { return false; }
    _seedsLane.lastPushKey = key;
    if (!_seedsArmed || _seedsMode() !== 'rolling' || lanePick !== true) { return false; }
    const before = _seedsSnap();
    _seedsLive = pushPick(_seedsLive, f, { now });
    return _seedsCommit(before, now);
  }

  /**
   * @param {string} key
   * @returns {boolean} true iff [key] is this lane's blended song and More
   *   like holds it UNPINNED (a quick skip of it takes it out, learns nothing)
   */
  function seedsBlendSkippable(key) {
    return quickSkipsBlend({
      key,
      blended: _seedsLane.blendKey,
      isDjPick: false,
      unpinnedInMoreLike: _seedsLive.more.some((r) => r.key === key && !r.pinned),
    });
  }

  /**
   * A quick skip (the player judged it), Drift only. [djPick]: the model's
   * quickSkip with [learn]. Otherwise only the blended song
   * (blendSkippable): it leaves More like, learns nothing, and the lane
   * passes over it from then on (skippedBlendKey).
   * @param {object} facts
   * @param {{ djPick?: boolean, learn?: boolean, now?: number }} [opts]
   * @returns {{ changed: boolean }}
   */
  function seedsQuickSkip(facts, { djPick = false, learn = false, now = Date.now() } = {}) {
    const f = _cleanFacts(facts);
    if (!f || _seedsMode() !== 'rolling') { return { changed: false }; }
    const before = _seedsSnap();
    _seedsPruneSilently(now);
    const key = seedKeyOf(f.owner, f.path);
    if (djPick === true) {
      _seedsLive = quickSkip(_seedsLive, f, { learn: learn === true, now });
    } else if (seedsBlendSkippable(key)) {
      _seedsLive = quickSkip(_seedsLive, f, { learn: false, now });
      if (_indexOf(_seedsLive.more, key) < 0) { _seedsLane.skippedBlendKey = key; }
    }
    return { changed: _seedsCommit(before, now) };
  }

  /** @returns {string|null} the key the lane passes over (the quick-skipped blend) */
  function seedsSkippedBlendKey() {
    return _seedsLane.skippedBlendKey;
  }

  /**
   * The positive seeds a request carries: the LIVE More like rows the route
   * can carry ('local': this server's; 'fanout': any server's), none set
   * aside, at most eight, oldest first. With none, Drift falls back to
   * [current] (this server's song for 'local'; never one in Less like or
   * set aside); Stay close sends nothing.
   * @param {{ route?: 'local'|'fanout', current?: object|null, now?: number }} [opts]
   * @returns {{ path: string, peerId: number|null }[]}
   */
  function seedsPositives({ route = 'local', current = null, now = Date.now() } = {}) {
    _seedsPruneSilently(now);
    const fanout = route === 'fanout';
    const usable = (r) => !_seedsSetAside.has(r.key) && (fanout || r.owner === null);
    const rows = usableSeeds(_seedsLive.more, usable);
    if (rows.length > 0) { return rows.map((r) => ({ path: r.path, peerId: r.owner })); }
    if (_seedsMode() !== 'rolling') { return []; }
    const cur = _cleanFacts(current);
    if (!cur || (!fanout && cur.owner !== null)) { return []; }
    const key = seedKeyOf(cur.owner, cur.path);
    if (_indexOf(_seedsLive.less, key) >= 0 || _seedsSetAside.has(key)) { return []; }
    return [{ path: cur.path, peerId: cur.owner }];
  }

  /**
   * The negatives a request carries: this server's LIVE Less like paths, the
   * newest eight, oldest first ([] = send nothing).
   * @param {number} [now]
   * @returns {string[]}
   */
  function seedsNegatives(now = Date.now()) {
    _seedsPruneSilently(now);
    const paths = _seedsLive.less.filter((r) => r.owner === null && r.path).map((r) => r.path);
    return paths.length > SEEDS.WIRE_CAP ? paths.slice(paths.length - SEEDS.WIRE_CAP) : paths;
  }

  /**
   * What a heal of the refused seeds [keys] would do: More like rows shown
   * unpinned are dropped; rows shown pinned, and keys of no More like row
   * (the Drift fallback), are set aside for the lane. The heal keeps a
   * dropped row's key out of the lane's requests too (seedsHeal).
   * @param {Iterable<string>} keys
   * @returns {{ drop: string[], setAside: string[] }}
   */
  function seedsCulprits(keys) {
    const list = _keyList(keys);
    const verdict = culprits(_seedsLive, list);
    const named = new Set([...verdict.drop, ...verdict.setAside]);
    const setAside = Array.from(new Set([...verdict.setAside, ...list.filter((k) => !named.has(k))]));
    return { drop: verdict.drop, setAside };
  }

  /**
   * Applies seedsCulprits([keys]). A dropped row's key is set aside as
   * well: the song playing can be that very row (the lane's blend, a DJ
   * pick that joined as it started), and Drift's fallback to the current
   * row, or the row joining again, would send the refused seed once more
   * this lane (the phone's sonicFieldsDiffer case).
   * @param {Iterable<string>} keys
   * @param {number} [now]
   * @returns {boolean} whether a row was dropped or newly set aside
   */
  function seedsHeal(keys, now = Date.now()) {
    const verdict = seedsCulprits(keys);
    let setAside = false;
    for (const k of [...verdict.drop, ...verdict.setAside]) {
      if (!_seedsSetAside.has(k)) {
        _seedsSetAside.add(k);
        setAside = true;
      }
    }
    const before = _seedsSnap();
    if (verdict.drop.length > 0) { _seedsLive = withoutKeys(_seedsLive, verdict.drop); }
    return _seedsCommit(before, now) || setAside;
  }

  /**
   * Drops the expired Drift Less like rows, telling the listeners.
   * @param {number} [now]
   * @returns {boolean} whether a row went
   */
  function seedsPrune(now = Date.now()) {
    const before = _seedsSnap();
    _seedsPruneSilently(now);
    return _seedsCommit(before, now);
  }

  /**
   * @param {number} [now]
   * @returns {number|null} when the next unpinned Less like row runs out
   *   (ms, always after [now]), or null (none can, or Stay close)
   */
  function seedsNextExpiry(now = Date.now()) {
    _seedsPruneSilently(now);
    const a = nextExpiry(_seedsLive);
    const b = _seedsPending ? nextExpiry(_seedsPending) : null;
    if (a === null) { return b; }
    return b === null ? a : Math.min(a, b);
  }

  /**
   * The Skipped ring: [facts] of a song skipped early (any song, not only DJ
   * picks) as the newest entry, once per key, at most twenty, persisted.
   * @param {object} facts
   * @returns {boolean} whether it was taken
   */
  function seedsNoteSkip(facts) {
    const f = _cleanFacts(facts);
    if (!f) { return false; }
    delete f.bare;
    const key = seedKeyOf(f.owner, f.path);
    _seedsRing = [f, ..._seedsRing.filter((x) => seedKeyOf(x.owner, x.path) !== key)].slice(0, SEEDS.RECENT_SKIPS_MAX);
    _write(RECENT_SKIPS_KEY, _seedsRing);
    return true;
  }

  /** @returns {object[]} the Skipped ring's Facts, newest first (copies) */
  function seedsRecentSkips() {
    return _seedsRing.map((f) => ({ ...f }));
  }

  /**
   * Add song's sections (see addSongSections); prunes first. Without
   * [view], the current view's target list is used.
   */
  function seedsAddSongSections(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    _seedsPruneSilently(now);
    return addSongSections({ ...o, view: o.view || _seedsDraw(_seedsView(now)) });
  }

  /** @returns {{ key: string, owner: number|null, path: string }[]} the rows whose facts wait for a lookup */
  function seedsBareRows() {
    const out = [];
    const seen = new Set();
    for (const set of [_seedsLive, _seedsPending]) {
      if (!set) { continue; }
      for (const r of [...set.more, ...set.less]) {
        if (r.bare !== true || seen.has(r.key)) { continue; }
        seen.add(r.key);
        out.push({ key: r.key, owner: r.owner, path: r.path });
      }
    }
    return out;
  }

  /**
   * A lookup's [facts] for the row [key] in every set that holds it (its
   * title, artist, album, art and length, where the lookup has them); the
   * row is no longer bare, and a stored row is written again.
   * @param {string} key
   * @param {object} facts
   * @param {number} [now]
   * @returns {boolean} whether a row changed
   */
  function seedsFillFacts(key, facts, now = Date.now()) {
    const f = facts && typeof facts === 'object' ? facts : {};
    const pick = (v, old) => (typeof v === 'string' && v ? v : old);
    const fill = (r) => {
      if (r.key !== key) { return r; }
      const dur = Number(f.duration);
      const next = {
        title: pick(f.title, r.title),
        artist: pick(f.artist, r.artist),
        album: pick(f.album, r.album),
        art: pick(f.art, r.art),
        duration: f.duration !== null && f.duration !== undefined && Number.isFinite(dur) && dur > 0 ? dur : r.duration,
      };
      const same = r.bare !== true && Object.keys(next).every((k) => next[k] === r[k]);
      return same ? r : _copy(r, { ...next, bare: false });
    };
    const fillSet = (set) => _withRows(set, set.more.map(fill), set.less.map(fill));
    const before = _seedsSnap();
    _seedsLive = fillSet(_seedsLive);
    if (_seedsPending) { _seedsPending = fillSet(_seedsPending); }
    const changed = _seedsLive !== before.live || _seedsPending !== before.pending;
    const stored = changed && storedRows(_seedsView(now)).some((e) => e.row.key === key);
    return _seedsCommit(before, now, stored);
  }

  _seedsInit();

  // ── Exposed namespace ────────────────────────────────────────────
  //
  // Public API only — internal helpers (`CAMELOT`, `LS_PREFIX`, etc.)
  // and constants that callers don't need are kept module-private.
  // Tests reach internals through the `_internals` namespace below.
  return {
    // Pure helpers — useful enough externally to live on the top-level
    // namespace (Vue computed reads toCamelot, songBlocked is called
    // from the player's retry loop).
    toCamelot,
    camelotNeighbours,
    bpmAvg,
    buildBpmRanges,
    songBlocked,
    cleanMoods,

    // State (live mirror — direct mutation logs a console.warn via
    // the Proxy. Use setState() for clean writes.)
    state,
    setState,
    reset,

    // BPM history + anchor
    pushBpmHistory,
    getBpmAnchor,
    clearBpmHistory,

    // Camelot anchor
    setCamelotAnchor,
    getCamelotAnchor,
    getCamelotNeighbours,
    clearCamelotAnchor,

    // Anchor reset (called on manual pick; continuity only)
    resetAnchors,

    // The session seeds, More like / Less like (toggle on
    // state.sonicEnabled, threshold on state.sonicMinSimilarity, mode on
    // state.sonicAnchorMode). The quick-skip rule and the box's test are
    // pure and live here too.
    isQuickSkip,
    countsAsPlay,
    clearsPinsOnClear,
    seeds: {
      // UI-facing
      view: seedsView,
      subscribe: seedsSubscribe,
      add: seedsAdd,
      move: seedsMove,
      setPinned: seedsSetPinned,
      remove: seedsRemove,
      setMode: seedsSetMode,
      takesNegatives,
      needsNewerServer,
      keyOf: seedKeyOf,
      factsFromSong,
      factsFromMeta,
      factsFromSearchHit,
      factsFromRecent,
      addSongSections: seedsAddSongSections,
      recentSkips: seedsRecentSkips,
      isQuickSkip,
      countsAsPlay,
      // Engine-facing (the player)
      setArmed: seedsSetArmed,
      laneEdge: seedsLaneEdge,
      laneId: seedsLaneId,
      beginPick: seedsBeginPick,
      onPlay: seedsOnPlay,
      blendSkippable: seedsBlendSkippable,
      quickSkip: seedsQuickSkip,
      skippedBlendKey: seedsSkippedBlendKey,
      positives: seedsPositives,
      negatives: seedsNegatives,
      culprits: seedsCulprits,
      heal: seedsHeal,
      prune: seedsPrune,
      nextExpiry: seedsNextExpiry,
      noteSkip: seedsNoteSkip,
      bareRows: seedsBareRows,
      fillFacts: seedsFillFacts,
      // The pure set functions, for tests
      model: SEEDS_MODEL,
    },

    // Counted-filepath tracking (used by the song-change handler to
    // avoid double-counting BPM history when the user navigates back
    // to a previously-played DJ pick).
    isFilepathCounted,
    markFilepathCounted,

    // Artist cooldown
    pushArtistHistory,
    clearArtistHistory,
    getArtistHistory,

    // ignoreList passthrough
    setIgnoreList,
    getIgnoreList,

    // Cross-server session (toggle on state.federatedEnabled; the player
    // does the round trips, these are the pure parts + bookkeeping).
    federatedKey,
    federatedRecentKeys,
    chooseFederatedPick,
    chooseFederatedPicks,
    getPeerIgnoreList,
    setPeerIgnoreList,
    excludePeerForSession,
    isPeerExcluded,
    decodeWireVector,
    encodeWireVector,
    meanUnitVector,

    // Keyword filter (toggle lives on state.djFilterEnabled,
    // mutated via setState; helpers here marshall the word list).
    addFilterWord,
    removeFilterWord,
    clearFilterWords,
    getFilterWords,

    // Genre filter (mode on state.djGenreMode, list on state.djGenres,
    // kind on state.djGenreSource; state.djGenreEnabled is written with
    // the list — the filter is on exactly while genres are chosen). The
    // Genres row and drawer read genreValue / genreDraft and write the
    // whole filter through setGenreFilter; the wire asks genreSourceFor;
    // GENRES_MAX is the cap the drawer shows and the server enforces. The
    // one-field helpers stay.
    addGenre,
    removeGenre,
    clearGenres,
    getGenres,
    getGenreMode,
    setGenreMode,
    compareGenreNames,
    genreFilterOn,
    genreValue,
    genreDraft,
    setGenreFilter,
    noteGenreSources,
    takesGenreSource,
    genreSourceFor,
    GENRES_MAX: GENRE_LIST_LIMIT,

    // Track-length window (toggle on state.djDurationEnabled, unknown
    // policy on state.djAllowUnknownDuration — both plain setState
    // flags; the bounds go through this helper because they clamp and
    // constrain each other — durationWindow is the same rule, unstored).
    setDurationBounds,
    durationWindow,

    // Songs per fetch (state.djLimit — set through the clamping setter;
    // LIMIT_MAX is the ceiling the panel renders and the server enforces).
    setLimit,
    LIMIT_MAX: DJ_LIMIT_MAX,

    // Library genres-list cache (5-min TTL; populated by m.js's
    // panel-open lifecycle and the Genres drawer from /api/v1/db/genres;
    // the answer's kinds ride with the names).
    getCachedGenresList,
    setCachedGenresList,
    getCachedGenreSources,
    invalidateGenresCache,

    // Test-only internals — namespaced under `_internals` so they're
    // visibly out-of-band. Production code never touches these.
    _internals: {
      // Constants tests verify against
      CAMELOT,
      LS_PREFIX,
      BPM_HISTORY_LIMIT,
      ARTIST_COOLDOWN_LIMIT,
      COUNTED_FILEPATHS_LIMIT,
      FILTER_WORDS_LIMIT,
      DEFAULT_BPM_TOLERANCE,
      IGNORE_LIST_LIMIT,
      SONIC_ANCHOR_MODES,
      DEFAULT_SONIC_MIN_SIMILARITY,
      GENRE_LIST_LIMIT,
      GENRES_CACHE_TTL_MS,
      GENRE_MODES,
      GENRE_KINDS,
      GENRE_NAME_MAX,
      GENRE_SOURCE_SINCE,
      DURATION_MAX_SECONDS,
      DJ_LIMIT_MAX,
      SEEDS,
      // Re-read state from localStorage (tests seed LS then probe).
      rehydrate: _rehydrate,
    },
  };
}));
