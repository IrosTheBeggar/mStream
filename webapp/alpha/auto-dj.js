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

  // ── songBlocked — post-fetch JS guard ────────────────────────────
  //
  // After the server returns a candidate pick the client double-checks
  // it against the local anchors. The server's tier filter already
  // prefers in-range rows, but in degraded fallback cases (steps 5,
  // 10) the client can re-block + retry up to N times before settling.
  //
  // Reads from velvet/webapp/app.js:1561-1602 with two adaptations:
  //   1. Filter-words branch removed (deferred — alpha doesn't ship
  //      that toggle in this PR).
  //   2. Reads `musical_key` AND `musical-key` so the helper works
  //      whether the caller passes the flat velvet shape or the
  //      kebab-case wire shape from renderMetadataObj.
  //
  // `song` shape: `{ bpm, musical_key | 'musical-key' }` or any object
  // with those fields readable. Truthy `bpm` on the song means we
  // KNOW the song's tempo; falsy means unknown → pass-through, server
  // is already filtering at the SQL layer.
  function songBlocked(song, opts) {
    if (!song || typeof song !== 'object') { return false; }
    const o = opts || {};

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
  const ARTIST_COOLDOWN_LIMIT = 15;     // last-N artists to exclude
  const DEFAULT_BPM_TOLERANCE = 8;

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
  function _hydrate() {
    return {
      enabled:        !!_read('enabled', false),
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
      // same songs.
      djIgnoreList:   Array.isArray(_read('djIgnoreList', null)) ? _read('djIgnoreList', null) : [],
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
    };
  }

  const state = _hydrate();

  // Test-only: discard the in-memory mirror and re-read from
  // localStorage. Lets unit tests seed localStorage then observe the
  // hydration path. Production callers should mutate via setState();
  // calling _rehydrate at runtime would race with concurrent writers.
  function _rehydrate() {
    const fresh = _hydrate();
    for (const k of Object.keys(state)) { delete state[k]; }
    Object.assign(state, fresh);
  }

  // Single setter so persistence is automatic. Accepts a partial
  // patch; ignores keys that aren't in `state`.
  function setState(patch) {
    if (!patch || typeof patch !== 'object') { return; }
    for (const k of Object.keys(patch)) {
      if (!(k in state)) { continue; }
      state[k] = patch[k];
      _write(k, patch[k]);
    }
  }

  // Wipe every DJ-related localStorage entry. Called when the user
  // toggles Auto-DJ off OR clicks a song manually with intent to
  // reset the session (matches velvet's `_resetDjSession` semantics).
  function reset() {
    setState({
      enabled: false,
      djIgnoreList: [],
      djArtistHistory: [],
      bpmHistory: [],
      camelotAnchor: null,
    });
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
  function setCamelotAnchor(rawKey) {
    const code = toCamelot(rawKey);
    setState({ camelotAnchor: code }); // null if rawKey unparseable
  }

  function getCamelotAnchor() {
    return state.camelotAnchor;
  }

  function getCamelotNeighbours() {
    return state.camelotAnchor ? camelotNeighbours(state.camelotAnchor) : null;
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
  function resetAnchors() {
    setState({
      bpmHistory: [],
      camelotAnchor: null,
    });
  }

  // ── Artist cooldown ─────────────────────────────────────────────
  //
  // Lifted from velvet/webapp/app.js:1818-1822. Lowercase + strip
  // dots normalisation so "M.C." == "MC" for de-duplication purposes;
  // this matches `db.resolveArtistNamesForDJ`'s server-side
  // normaliser well enough for cooldown semantics (both sides fold
  // the same way before comparing).
  function _normArtist(name) {
    return String(name || '').toLowerCase().replace(/\./g, '').trim();
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

  // ── ignoreList passthrough ──────────────────────────────────────
  //
  // The server is authoritative on what's in the ignoreList. The
  // client just persists whatever the server returns and sends it
  // back on the next call.
  function setIgnoreList(list) {
    setState({ djIgnoreList: Array.isArray(list) ? list : [] });
  }

  // ── Exposed namespace ────────────────────────────────────────────
  return {
    // Pure helpers
    CAMELOT,
    toCamelot,
    camelotNeighbours,
    bpmAvg,
    buildBpmRanges,
    songBlocked,

    // Constants
    BPM_HISTORY_LIMIT,
    ARTIST_COOLDOWN_LIMIT,
    DEFAULT_BPM_TOLERANCE,
    LS_PREFIX,

    // State (live mirror — read directly, mutate via setState)
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

    // Artist cooldown
    pushArtistHistory,
    clearArtistHistory,

    // ignoreList passthrough
    setIgnoreList,

    // Internal — tests only.
    _rehydrate,
  };
}));
