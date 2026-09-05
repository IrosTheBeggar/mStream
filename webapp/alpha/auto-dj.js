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
 * fork's webapp/app.js — sources cited inline. Comments preserve the
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
  const SONIC_HISTORY_LIMIT = 5;        // rolling sonic-anchor ring buffer (server accepts up to 8 similarTo entries)
  const SONIC_ANCHOR_MODES = Object.freeze(['rolling', 'locked']);
  const DEFAULT_SONIC_MIN_SIMILARITY = 0.55;
  const ARTIST_COOLDOWN_LIMIT = 15;     // last-N artists to exclude
  const COUNTED_FILEPATHS_LIMIT = 50;   // ring of "BPM-history-counted" filepaths
  const FILTER_WORDS_LIMIT = 50;        // sanity cap on the user-supplied skip list
  const IGNORE_LIST_LIMIT = 500;        // mirrors src/api/random.js Joi.array().max(500); defensive in case a future server bug ships an unbounded ignoreList
  const DEFAULT_BPM_TOLERANCE = 8;
  const GENRE_LIST_LIMIT = 200;         // sanity cap on the genre whitelist/blacklist (mirrors Joi)
  const DURATION_MAX_SECONDS = 86400;   // mirrors src/api/random.js Joi.number().max(86400) — 24h
  const GENRES_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min — popover dropdown content
  const GENRE_MODES = Object.freeze(['whitelist', 'blacklist']);

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
      djGenreEnabled: !!_read('djGenreEnabled', false),
      djGenreMode:    GENRE_MODES.includes(_read('djGenreMode', null))
        ? _read('djGenreMode', null)
        : 'whitelist',
      djGenres:       Array.isArray(_read('djGenres', null)) ? _read('djGenres', null) : [],
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
      // Sonic similarity (discovery embeddings, PR #697 server API).
      // `sonicMinSimilarity` is the RAW cosine threshold the server
      // takes; the panel slider maps a perceptual scale onto it.
      // `sonicAnchorMode` is a pure client-side policy — it only decides
      // WHICH paths go into the request's `similarTo` array:
      //   • 'rolling' — the last-N DJ picks (session centroid; the
      //     session follows its own vibe).
      //   • 'locked'  — one anchor path for the whole session lane.
      // Hardened against LS junk the same way djGenreMode is — a stale
      // unknown mode would otherwise ripple garbage into request
      // building until the user re-toggled it.
      sonicEnabled:       !!_read('sonicEnabled', false),
      sonicMinSimilarity: _readNumber('sonicMinSimilarity', DEFAULT_SONIC_MIN_SIMILARITY, 0, 1),
      sonicAnchorMode:    SONIC_ANCHOR_MODES.includes(_read('sonicAnchorMode', null))
        ? _read('sonicAnchorMode', null)
        : 'rolling',
      // Explicit user-picked seed ({filepath, title}) — the "start the
      // session HERE" choice, required when Auto-DJ starts on an empty
      // queue. Survives reset() (it's closer to a preference than to
      // session state) but is cleared by resetAnchors() — a manual song
      // pick mid-session means "go this direction instead".
      sonicSeed: (() => {
        const v = _read('sonicSeed', null);
        return (v && typeof v === 'object' && typeof v.filepath === 'string')
          ? { filepath: v.filepath, title: typeof v.title === 'string' ? v.title : v.filepath }
          : null;
      })(),
      // Rolling anchor — filepaths of the last-N DJ picks.
      sonicHistory: Array.isArray(_read('sonicHistory', null)) ? _read('sonicHistory', null) : [],
      // Locked anchor — the single filepath the 'locked' mode pins the
      // session to. Lazily set on the first pick of a session.
      sonicLockedAnchor: (() => {
        const v = _read('sonicLockedAnchor', null);
        return typeof v === 'string' ? v : null;
      })(),
      // Cross-server session (mStream #929): ask this server AND every
      // federated peer that shares its discovery model, seed as a vector,
      // best cosine wins. A preference like sonicEnabled; the panel only
      // offers it when the server advertises federationBrowse.
      federatedEnabled:   !!_read('federatedEnabled', false),
      // Which server each sonicHistory path came from — a peer id, or null
      // for this server. A path only names a row on the server that holds
      // it, so a cross-server anchor must remember its owner or the seed
      // read-out asks the wrong server. Pruned with the history ring.
      sonicHistoryOwners: (() => {
        const v = _read('sonicHistoryOwners', null);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      })(),
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
  }

  // Single setter so persistence is automatic. Accepts a partial
  // patch. Unknown keys are dropped with a console.warn — they're
  // almost always typos (`harmoniMixing` for `harmonicMixing`), and
  // silently dropping them is the kind of footgun that takes
  // forever to track down. The warn is loud enough for dev consoles
  // but doesn't throw, so a one-off prod bug isn't catastrophic.
  function setState(patch) {
    if (!patch || typeof patch !== 'object') { return; }
    _allowDirectWrite = true;
    try {
      for (const k of Object.keys(patch)) {
        if (!(k in _stateRaw)) {
          // eslint-disable-next-line no-console
          console.warn(`[AUTODJ] setState ignored unknown key: ${k}`);
          continue;
        }
        _stateRaw[k] = patch[k];
        _write(k, patch[k]);
      }
    } finally {
      _allowDirectWrite = false;
    }
  }

  // Wipe every DJ-related localStorage entry. Called when the user
  // toggles Auto-DJ off OR clicks a song manually with intent to
  // reset the session (matches velvet's `_resetDjSession` semantics).
  // Preserves user preferences (similar / bpmContinuity / harmonic /
  // tolerance / vpaths / minRating) — only session state is wiped.
  function reset() {
    setState({
      djIgnoreList: [],
      djArtistHistory: [],
      bpmHistory: [],
      camelotAnchor: null,
      djCountedFilepaths: [],
      sonicHistory: [],
      sonicHistoryOwners: {},
      sonicLockedAnchor: null,
      djPeerIgnoreLists: {},
      // sonicSeed survives — like the toggles it's a choice, not
      // session state, so a DJ off/on cycle keeps the picked seed.
      // federatedEnabled survives for the same reason.
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
  // Called when the user manually picks a song while DJ is on. The
  // intent is "start a new lane" — drop the rolling BPM context and
  // the locked harmonic anchor so the next DJ pick gates off the new
  // song's properties, not the old session's.
  //
  // Also clears the counted-filepath ring: a new session means the
  // user's intent has shifted, so prior "we've already counted this
  // song's BPM" markers no longer apply.
  function resetAnchors() {
    setState({
      bpmHistory: [],
      camelotAnchor: null,
      djCountedFilepaths: [],
      // Manual pick = new lane: the sonic session re-anchors on the new
      // song, and any explicit seed from the old lane is consumed.
      sonicHistory: [],
      sonicHistoryOwners: {},
      sonicLockedAnchor: null,
      sonicSeed: null,
    });
  }

  // ── Sonic anchor (discovery-embedding similarity) ────────────────
  //
  // The anchor policy is entirely client-side: the server statelessly
  // averages whatever paths arrive in `similarTo` (PR #697), so
  // 'rolling' vs 'locked' is just a question of which paths
  // buildSonicParams() returns.

  // Seed paths on the wire never carry a leading slash (they resolve
  // through getVPathInfo server-side); rawFilePath from some queue-add
  // paths does. Normalize once at every write/build point.
  function _normSonicPath(p) {
    if (typeof p !== 'string') { return null; }
    const s = p.charAt(0) === '/' ? p.slice(1) : p;
    return s || null;
  }

  // Explicit seed — the DJ panel's "start the session here" pick.
  // Setting a new seed drops the running sonic session state so the
  // next pick anchors on the new seed, not on stale history.
  function setSonicSeed(filepath, title) {
    const norm = _normSonicPath(filepath);
    if (!norm) { return false; }
    setState({
      sonicSeed: { filepath: norm, title: String(title || norm) },
      sonicHistory: [],
      sonicHistoryOwners: {},
      sonicLockedAnchor: null,
    });
    return true;
  }

  function clearSonicSeed() {
    setState({ sonicSeed: null });
  }

  function getSonicSeed() {
    return state.sonicSeed ? { ...state.sonicSeed } : null;
  }

  // Rolling-anchor ring buffer — DJ-picked filepaths, most recent
  // last. Re-picking a path already in the window moves it to the
  // most-recent slot instead of duplicating it (a duplicate would
  // double-weight that song in the server's centroid).
  //
  // `ownerPeerId` is the server the pick came from — a peer id, or null
  // (the default, and every single-server pick) for this server. The
  // owners map is pruned with the ring so it never outgrows it.
  function pushSonicHistory(filepath, ownerPeerId = null) {
    const norm = _normSonicPath(filepath);
    if (!norm) { return; }
    const next = state.sonicHistory.filter(p => p !== norm);
    next.push(norm);
    while (next.length > SONIC_HISTORY_LIMIT) { next.shift(); }
    const owners = {};
    for (const p of next) {
      if (p === norm) { owners[p] = ownerPeerId === null || ownerPeerId === undefined ? null : Number(ownerPeerId); }
      else if (p in state.sonicHistoryOwners) { owners[p] = state.sonicHistoryOwners[p]; }
    }
    // The locked anchor is pinned outside the ring; its owner (recorded
    // by sonicAnchors when the pin came from a playing peer track) rides
    // along until the pin is cleared.
    const pin = state.sonicLockedAnchor;
    if (pin && !(pin in owners) && pin in state.sonicHistoryOwners) { owners[pin] = state.sonicHistoryOwners[pin]; }
    setState({ sonicHistory: next, sonicHistoryOwners: owners });
  }

  function clearSonicHistory() {
    setState({ sonicHistory: [], sonicHistoryOwners: {} });
  }

  // Clear the per-session sonic anchors (history + locked pin) while
  // keeping the explicit seed. Used when the feature is toggled off in
  // the panel — mirrors clearBpmHistory/clearCamelotAnchor semantics.
  function clearSonicAnchors() {
    setState({ sonicHistory: [], sonicHistoryOwners: {}, sonicLockedAnchor: null });
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

  // Which server each anchor path lives on: the owners map for history
  // paths, the playing song's own `federation` marker for the current
  // track (a peer pick the user is listening to), and this server for
  // anything else (the explicit seed is always picked from a local
  // search). Returns [{ path, peerId }] in the order given, peerId null
  // for this server.
  function _currentSongOwner(currentSong) {
    return currentSong && currentSong.federation && Number.isFinite(Number(currentSong.federation.peerId))
      ? Number(currentSong.federation.peerId) : null;
  }

  function resolveSonicOwners(paths, currentSong) {
    const curPath = _normSonicPath(currentSong && currentSong.rawFilePath);
    const curPeer = _currentSongOwner(currentSong);
    const out = [];
    for (const raw of (Array.isArray(paths) ? paths : [])) {
      const path = _normSonicPath(raw);
      if (!path) { continue; }
      let peerId = null;
      if (Object.prototype.hasOwnProperty.call(state.sonicHistoryOwners, path)) {
        const v = state.sonicHistoryOwners[path];
        peerId = v === null || v === undefined ? null : Number(v);
      } else if (curPath && path === curPath) {
        peerId = curPeer;
      }
      out.push({ path, peerId });
    }
    return out;
  }

  // "<owner>|<path>" keys for everything a federated pick must not answer
  // with: the anchors and the playing track. A vector seed carries no
  // hashes for a server to exclude (the filepath form's seeds are dropped
  // from the pool server-side), and ignoreList is only a soft cooldown that
  // yields to the full pool once it covers every candidate — so the guard
  // is here, and an answer that repeats is passed over for the next best.
  function federatedKey(peerId, path) {
    return `${peerId === null || peerId === undefined ? 'local' : Number(peerId)}|${_normSonicPath(path)}`;
  }

  function federatedRecentKeys(anchors, currentSong) {
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
    return keys;
  }

  // Best answer across servers: highest reported cosine among the answers
  // that are neither blocked (keyword / genre / duration / continuity —
  // the same client-side checks the single-server loop applies) nor a
  // repeat of what is playing or anchoring. Null when nothing qualifies,
  // which sends the player back to the single-server pick.
  //   answers: [{ peerId|null, song, res, similarity, blocked }]
  function chooseFederatedPick(answers, recentKeys) {
    const recent = recentKeys instanceof Set ? recentKeys : new Set(recentKeys || []);
    let best = null;
    for (const a of (Array.isArray(answers) ? answers : [])) {
      if (!a || !a.song || a.blocked) { continue; }
      if (recent.has(federatedKey(a.peerId, a.song.filepath))) { continue; }
      const sim = Number.isFinite(a.similarity) ? a.similarity : -1;
      if (!best || sim > best.similarity) { best = { ...a, similarity: sim }; }
    }
    return best;
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

  // The anchors a sonic pick averages over, each paired with the server
  // that owns it (resolveSonicOwners) — [{ path, peerId }], empty when
  // sonic mode is off or nothing is resolvable (empty queue, no explicit
  // seed). One synchronous read: a song change between reading the ring
  // and reading the owners map would have pruned an evicted path's owner,
  // and a peer path then reads as this server's — which answers a
  // uniform 404 for any path it can't resolve.
  //
  // Anchor resolution:
  //   locked  → the pinned path; lazily pinned on the session's first
  //             pick from the explicit seed, else the current song (whose
  //             owner is recorded with the pin when it is a peer track).
  //   rolling → the DJ-pick history; falls back to the explicit seed,
  //             else the current song, for the session's first pick.
  //
  // `currentSong` is the playing song object (rawFilePath + the
  // `federation` marker a peer pick carries); a bare path is accepted too.
  function sonicAnchors(currentSong) {
    if (!state.sonicEnabled) { return []; }
    const song = typeof currentSong === 'string' ? { rawFilePath: currentSong } : currentSong;
    const cur = _normSonicPath(song && song.rawFilePath);
    const explicit = state.sonicSeed ? _normSonicPath(state.sonicSeed.filepath) : null;

    if (state.sonicAnchorMode === 'locked') {
      let anchor = state.sonicLockedAnchor;
      if (!anchor) {
        anchor = explicit || cur;
        if (anchor) {
          const owner = anchor === cur ? _currentSongOwner(song) : null;
          setState({
            sonicLockedAnchor: anchor,
            sonicHistoryOwners: owner === null
              ? state.sonicHistoryOwners
              : { ...state.sonicHistoryOwners, [anchor]: owner },
          });
        }
      }
      return anchor ? resolveSonicOwners([anchor], song) : [];
    }

    if (state.sonicHistory.length > 0) {
      return resolveSonicOwners([...state.sonicHistory], song);
    }
    const seed = explicit || cur;
    return seed ? resolveSonicOwners([seed], song) : [];
  }

  // The `similarTo`/`minSimilarity` fields for the next random-songs
  // body sent to THIS server, or null when sonic mode is off OR no anchor
  // this server holds remains (the caller decides how to surface that;
  // the player toasts a "pick a seed" pointer).
  //
  // Anchors a peer owns are left out — a filepath only names a row on the
  // server that holds it. When every anchor lives elsewhere (a federated
  // session that has wandered onto peers, now asking this server alone),
  // the explicit seed stands in; in rolling mode the playing song does
  // too when it is this server's. A locked pin on a peer track with no
  // seed yields null rather than quietly re-anchoring somewhere else.
  function buildSonicParams(currentSong) {
    const song = typeof currentSong === 'string' ? { rawFilePath: currentSong } : currentSong;
    const anchors = sonicAnchors(song);
    if (anchors.length === 0) { return null; }
    const minSimilarity = state.sonicMinSimilarity;
    let local = anchors.filter(a => a.peerId === null).map(a => a.path);
    if (local.length === 0) {
      const explicit = state.sonicSeed ? _normSonicPath(state.sonicSeed.filepath) : null;
      const cur = _normSonicPath(song && song.rawFilePath);
      const curLocal = cur && resolveSonicOwners([cur], song)[0].peerId === null ? cur : null;
      local = explicit ? [explicit]
        : (state.sonicAnchorMode !== 'locked' && curLocal ? [curLocal] : []);
    }
    return local.length > 0 ? { similarTo: local, minSimilarity } : null;
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
  // List-of-genres + mode-toggle pair. Match semantics live in
  // songBlocked above (overlap test, inverted under blacklist mode);
  // the helpers here marshal the list with the same shape as the
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
  function setDurationBounds(minSeconds, maxSeconds, prefer) {
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
    setState({ djMinDuration: min, djMaxDuration: max });
    return { min, max };
  }

  // ── Genres-list fetch cache ─────────────────────────────────────
  //
  // The popover/dropdown content (the SET of genres in the library)
  // is fetched from /api/v1/db/genres on first panel open. Module-
  // scoped, NOT persisted via setState — the cache is ephemeral and
  // ought to refresh when the user reloads (e.g. after a rescan).
  //
  // 5-minute TTL: covers the "open panel, browse elsewhere, come
  // back" round-trip without making the user wait twice; short enough
  // that a rescan-during-session stale window is bounded.
  //
  // Returned arrays are copies — mutating the result doesn't poison
  // the cache. invalidateGenresCache() is exported for tests and as
  // a manual refresh hook (e.g. a future post-rescan event).
  let _genresListCache = null;  // { fetchedAt: number, items: string[] } | null

  function _isGenresCacheFresh() {
    return _genresListCache != null
      && (Date.now() - _genresListCache.fetchedAt) < GENRES_CACHE_TTL_MS;
  }

  function getCachedGenresList() {
    return _isGenresCacheFresh() ? [..._genresListCache.items] : null;
  }

  function setCachedGenresList(items) {
    if (!Array.isArray(items)) { return; }
    _genresListCache = { fetchedAt: Date.now(), items: [...items] };
  }

  function invalidateGenresCache() {
    _genresListCache = null;
  }

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

    // Anchor reset (called on manual pick)
    resetAnchors,

    // Sonic anchor (toggle on state.sonicEnabled, threshold on
    // state.sonicMinSimilarity, mode on state.sonicAnchorMode — all
    // via setState; helpers here marshal the seed + history and build
    // the request fields).
    setSonicSeed,
    clearSonicSeed,
    getSonicSeed,
    pushSonicHistory,
    clearSonicHistory,
    clearSonicAnchors,
    buildSonicParams,
    sonicAnchors,

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
    resolveSonicOwners,
    federatedRecentKeys,
    chooseFederatedPick,
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

    // Genre filter (toggle on state.djGenreEnabled, mode on
    // state.djGenreMode, list on state.djGenres — helpers here
    // marshal each).
    addGenre,
    removeGenre,
    clearGenres,
    getGenres,
    getGenreMode,
    setGenreMode,

    // Track-length window (toggle on state.djDurationEnabled, unknown
    // policy on state.djAllowUnknownDuration — both plain setState
    // flags; the bounds go through this helper because they clamp and
    // constrain each other).
    setDurationBounds,

    // Library genres-list cache (5-min TTL; populated by m.js's
    // panel-open lifecycle from /api/v1/db/genres).
    getCachedGenresList,
    setCachedGenresList,
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
      SONIC_HISTORY_LIMIT,
      IGNORE_LIST_LIMIT,
      SONIC_ANCHOR_MODES,
      DEFAULT_SONIC_MIN_SIMILARITY,
      GENRE_LIST_LIMIT,
      GENRES_CACHE_TTL_MS,
      GENRE_MODES,
      DURATION_MAX_SECONDS,
      // Re-read state from localStorage (tests seed LS then probe).
      rehydrate: _rehydrate,
    },
  };
}));
