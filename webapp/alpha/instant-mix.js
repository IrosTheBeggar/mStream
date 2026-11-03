// Instant Mix's pure half (the mix page, m.js instantMix*): the body POST
// /api/v1/discovery/local/mix takes — the seed as `from`, then the page's
// filters, each key only when it filters — how many of the page's filters
// are set, a word or genre its panel adds, which state an answer puts the
// page in and whether the page keeps it, the name Save offers, the
// shuffle, and the key the page keeps its answers by.
//
// The route's contract (src/api/discovery-mix.js, docs/openapi.yaml):
//   from      exactly one of { song } · { album: { album, artist?,
//             album_artist?, year? } } · { artist } · { playlist } (the
//             caller's own); the singles bucket (album null) is no seed
//   limit     LIMIT
//   filters   random-songs' own keys — ignoreVPaths, minRating, bpmRanges,
//             musicalKeys + requireMusicalKey, genres + genreMode,
//             minDuration / maxDuration + allowUnknownDuration, moods —
//             and the mix's skipWords. Every one is a hard filter, never
//             relaxed, and the schema is strict: a key goes out only when
//             it filters.
//   answer    200 for every empty state (notAnalyzed; songs [] or [seed],
//             with filteredOut when the filters emptied it); 403 when
//             discovery is off ({ disabled: true } from api.js), null for
//             any other failure
//
// The page's filters (emptyFilters) are Auto DJ's rows, kept by the page
// in memory for the session (m.js MIX.filters) and never read from or
// written to Auto DJ. Its mood filter is MOODS.filters.mix, handed in as
// its wire form (m.js moodFilterBody). Tempo and key apply to a song seed
// only, built around its own BPM and key with Auto DJ's helpers
// (AUTODJ.buildBpmRanges, toCamelot, camelotNeighbours — ctx.dj).
//
// No DOM, no fetch, no storage — m.js wires it to the app; the unit test
// (test/unit/webapp-instant-mix.test.mjs) drives it on node. Same UMD shape
// as alpha/discovery-page.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.INSTANTMIX = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  // ── contract constants ─────────────────────────────────────────────────
  // The route's Joi (src/api/discovery-mix.js and random-songs' filter
  // keys, src/api/random.js) reads the same bounds.
  const LIMIT = 50;
  const WORDS_MAX = 50;          // skipWords: 1–100 characters each
  const WORD_LENGTH_MAX = 100;
  const GENRES_MAX = 200;        // genres: 1–200 characters each
  const GENRE_LENGTH_MAX = 200;
  const DURATION_MAX = 86400;    // seconds, either bound; 0 = no bound
  const RATING_MAX = 10;         // minRating in half stars; 0 = any
  const VPATHS_MAX = 50;
  const PATH_MAX = 4096;
  const NAME_MAX = 1000;         // an album, artist or playlist name
  // Auto DJ's BPM tolerance: its default and its slider's range.
  const BPM_TOLERANCE = 8;
  const BPM_TOLERANCE_MIN = 1;
  const BPM_TOLERANCE_MAX = 20;
  // Answers the page keeps, by body (m.js MIX.cache).
  const CACHE_MAX = 8;
  const MOOD_SCALES = ['valence', 'energy', 'voice'];

  // ── small helpers ──────────────────────────────────────────────────────
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const named = (v) => typeof v === 'string' && v.trim().length > 0;
  const stripSlash = (p) => String(p == null ? '' : p).replace(/^\/+/, '');

  // A whole number from a number or a numeric string (a card's data-year);
  // never from null, '' or a boolean, which Number() would turn into 0.
  function toInt(v) {
    if (typeof v === 'number') { return Number.isInteger(v) ? v : undefined; }
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) { return Number(v.trim()); }
    return undefined;
  }

  // A list of names as the route takes it: trimmed, each within `max`
  // characters, once each whatever its case (the first spelling kept), at
  // most `cap` of them.
  function uniqueNames(list, max, cap) {
    const seen = new Set();
    const out = [];
    for (const raw of arr(list)) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      const lc = name.toLowerCase();
      if (!name || name.length > max || seen.has(lc)) { continue; }
      seen.add(lc);
      out.push(name);
      if (out.length >= cap) { break; }
    }
    return out;
  }

  // A length bound in whole seconds, 0 for none.
  function seconds(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(DURATION_MAX, Math.round(n)) : 0;
  }

  // ── the page's filters ─────────────────────────────────────────────────
  // Nothing set: every library the app's folder choice leaves (vpathsOff:
  // the page's pills turned off), any rating, tempo and key off (Auto DJ's
  // tolerance kept for when tempo comes on), no words, no genres
  // (whitelist), no length bound, unknown lengths left out.
  function emptyFilters() {
    return {
      vpathsOff: [],
      minRating: 0,
      bpm: false,
      bpmTolerance: BPM_TOLERANCE,
      harmonic: false,
      words: [],
      genres: [],
      genreMode: 'whitelist',
      minDuration: 0,
      maxDuration: 0,
      allowUnknownDuration: false,
    };
  }

  // A word (the Keyword filter's) or a genre added to its list, the way
  // Auto DJ adds them (AUTODJ.addFilterWord / addGenre): trimmed, once
  // whatever its case, the list capped — and within the route's length, so
  // every chip the panel shows filters. → the new list, or null when
  // nothing was added (blank, there already, too long, the list full).
  function addName(list, raw, kind) {
    const genre = kind === 'genre';
    const items = arr(list);
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > (genre ? GENRE_LENGTH_MAX : WORD_LENGTH_MAX)) { return null; }
    if (items.length >= (genre ? GENRES_MAX : WORDS_MAX)) { return null; }
    const lc = name.toLowerCase();
    if (items.some((v) => typeof v === 'string' && v.toLowerCase() === lc)) { return null; }
    return items.concat(name);
  }

  // The seed as the route's `from`, or null when it is none: an empty path
  // or name, an unknown kind, the singles bucket (an album of null). Names
  // go as they are (the library's own spelling); a song loses its leading
  // slash; an album's year goes as a number.
  function fromOf(seed) {
    if (!isObj(seed)) { return null; }
    if (seed.kind === 'song') {
      const song = stripSlash(seed.filepath);
      return song && song.length <= PATH_MAX ? { song } : null;
    }
    if (seed.kind === 'album') {
      if (!named(seed.album) || seed.album.length > NAME_MAX) { return null; }
      const album = { album: seed.album };
      if (named(seed.artist) && seed.artist.length <= NAME_MAX) { album.artist = seed.artist; }
      if (named(seed.albumArtist) && seed.albumArtist.length <= NAME_MAX) { album.album_artist = seed.albumArtist; }
      const year = toInt(seed.year);
      if (year !== undefined) { album.year = year; }
      return { album };
    }
    if (seed.kind === 'artist' || seed.kind === 'playlist') {
      const name = seed[seed.kind];
      return named(name) && name.length <= NAME_MAX ? { [seed.kind]: name } : null;
    }
    return null;
  }

  // The filters' wire keys for `seed`, only those that filter, and the
  // page's rows they come from (what active() counts):
  //   ignoreVPaths   the app's folder choice (ctx.ignoreVPaths) and the
  //                  libraries the page's pills turned off — the pills only
  //                  while they leave one (ctx.vpaths: every library)
  //   minRating      1–10
  //   bpmRanges      a song seed with a BPM: Auto DJ's windows around it
  //   musicalKeys    a song seed whose key maps to Camelot: its neighbours,
  //                  with requireMusicalKey
  //   skipWords      the keyword filter's words
  //   genres         with genreMode; the mode alone filters nothing
  //   moods          its wire form, where the ping says the server can
  //                  filter (ctx.moodFilters) and a group is set
  //   minDuration / maxDuration   seconds, each above 0, a backwards window
  //                  repaired as Auto DJ does (the minimum kept);
  //                  allowUnknownDuration beside a bound only
  function filterFields(seed, f, moods, ctx) {
    const c = isObj(ctx) ? ctx : {};
    const flt = Object.assign(emptyFilters(), isObj(f) ? f : {});
    const body = {};
    const rows = [];

    const all = arr(c.vpaths).filter(named);
    const global = arr(c.ignoreVPaths).filter(named);
    const off = arr(flt.vpathsOff).filter((v) => named(v) && !global.includes(v) && (!all.length || all.includes(v)));
    let ignore = global.slice();
    if (off.length && (!all.length || all.some((v) => !global.includes(v) && !off.includes(v)))) {
      ignore = ignore.concat(off);
      rows.push('sources');
    }
    ignore = [...new Set(ignore)].slice(0, VPATHS_MAX);
    if (ignore.length) { body.ignoreVPaths = ignore; }

    const rating = toInt(flt.minRating);
    if (rating >= 1 && rating <= RATING_MAX) {
      body.minRating = rating;
      rows.push('rating');
    }

    const dj = isObj(c.dj) ? c.dj : null;
    const song = isObj(seed) && seed.kind === 'song';
    if (flt.bpm === true && song && Number.isFinite(seed.bpm) && dj && typeof dj.buildBpmRanges === 'function') {
      const tol = Number(flt.bpmTolerance);
      const tolerance = Number.isFinite(tol)
        ? Math.max(BPM_TOLERANCE_MIN, Math.min(BPM_TOLERANCE_MAX, Math.round(tol)))
        : BPM_TOLERANCE;
      const ranges = dj.buildBpmRanges(seed.bpm, tolerance);
      if (Array.isArray(ranges) && ranges.length) {
        body.bpmRanges = ranges;
        rows.push('bpm');
      }
    }
    if (flt.harmonic === true && song && dj && typeof dj.toCamelot === 'function' && typeof dj.camelotNeighbours === 'function') {
      const code = dj.toCamelot(seed.key);
      const keys = code ? dj.camelotNeighbours(code) : null;
      if (keys && keys.size) {
        body.musicalKeys = [...keys];
        body.requireMusicalKey = true;
        rows.push('harmonic');
      }
    }

    const words = uniqueNames(flt.words, WORD_LENGTH_MAX, WORDS_MAX);
    if (words.length) {
      body.skipWords = words;
      rows.push('words');
    }

    const genres = uniqueNames(flt.genres, GENRE_LENGTH_MAX, GENRES_MAX);
    if (genres.length) {
      body.genres = genres;
      body.genreMode = flt.genreMode === 'blacklist' ? 'blacklist' : 'whitelist';
      rows.push('genres');
    }

    if (c.moodFilters === true && isObj(moods) && (MOOD_SCALES.some((g) => named(moods[g])) || arr(moods.tags).length > 0)) {
      body.moods = Object.assign({}, moods, Array.isArray(moods.tags) ? { tags: moods.tags.slice() } : {});
      rows.push('mood');
    }

    const min = seconds(flt.minDuration);
    let max = seconds(flt.maxDuration);
    if (min > 0 && max > 0 && min > max) { max = min; }
    if (min > 0) { body.minDuration = min; }
    if (max > 0) { body.maxDuration = max; }
    if (min > 0 || max > 0) {
      body.allowUnknownDuration = flt.allowUnknownDuration === true;
      rows.push('length');
    }

    return { body, rows };
  }

  // The body for a seed and the page's filters, or null for no seed.
  //   ctx.moods          the mood filter's wire form (or null)
  //   ctx.moodFilters    the ping's flag: this server takes `moods`
  //   ctx.ignoreVPaths   the app's folder choice (m.js localIgnoreVPaths)
  //   ctx.vpaths         every library (the pills that would leave none
  //                      are dropped)
  //   ctx.dj             Auto DJ's helpers (window.AUTODJ)
  function requestBody(seed, f, ctx) {
    const from = fromOf(seed);
    if (!from) { return null; }
    const c = isObj(ctx) ? ctx : {};
    return Object.assign({ from, limit: LIMIT }, filterFields(seed, f, c.moods, c).body);
  }

  // How many of the page's filters are set for this seed's mix (ctx.seed;
  // ctx as for requestBody) — the funnel's mark, and whether an emptied
  // list is the filters' doing. Only what would be sent counts: tempo and
  // key off a song without a BPM or key, a mood the server can't apply,
  // pills that would leave no library — and never the app's folder choice,
  // which is not the page's.
  function active(f, moodsBody, ctx) {
    const c = isObj(ctx) ? ctx : {};
    return filterFields(c.seed, f, moodsBody, c).rows.length;
  }

  // Which state an answer puts the page in (opts: { kind, active,
  // seedPath } — the seed's kind, active() for it, a song seed's path):
  //   loading         no answer yet (undefined)
  //   off             403: discovery is off ({ disabled: true })
  //   failed          null, or an answer without its songs
  //   notAnalyzed     the seed, or every member of it, has no sound yet
  //   noMatch         nothing beyond the seed, and the filters did it
  //                   (filteredOut while a filter is set)
  //   nothingSimilar  nothing beyond the seed otherwise
  //   ready           rows to show
  // Beyond the seed = a row whose path is not the seed song's.
  function viewState(answer, opts) {
    const o = isObj(opts) ? opts : {};
    if (answer === undefined) { return 'loading'; }
    if (isObj(answer) && answer.disabled === true) { return 'off'; }
    if (!isObj(answer) || !Array.isArray(answer.songs)) { return 'failed'; }
    if (answer.notAnalyzed === true) { return 'notAnalyzed'; }
    const seedPath = o.kind === 'song' ? stripSlash(o.seedPath) : null;
    const beyond = answer.songs.some((s) => isObj(s) && named(s.filepath) && stripSlash(s.filepath) !== seedPath);
    if (beyond) { return 'ready'; }
    return answer.filteredOut === true && o.active ? 'noMatch' : 'nothingSimilar';
  }

  // Whether the page keeps an answer for later (m.js MIX.cache; opts as
  // for viewState): rows, or a list the filters emptied — never a "yet"
  // (not analysed, nothing similar), which the library's analysis
  // outgrows: the next open of that mix asks again. Nor a failure.
  function keeps(answer, opts) {
    const st = viewState(answer, Object.assign({}, isObj(opts) ? opts : {}, { active: 1 }));
    return st === 'ready' || st === 'noMatch';
  }

  // The name Save offers: `fmt(title)` — the page's "‹title› Mix" — then
  // "‹title› Mix 2", 3 … while a playlist (`taken`: names, or { name })
  // already has it, compared exactly. Accents and symbols are kept.
  function defaultName(title, taken, fmt) {
    const name = String(title == null ? '' : title).trim();
    const base = typeof fmt === 'function' ? String(fmt(name)) : `${name} Mix`;
    const names = new Set(arr(taken).map((p) => (isObj(p) ? p.name : p)).filter((n) => typeof n === 'string'));
    if (!names.has(base)) { return base; }
    let n = 2;
    while (names.has(`${base} ${n}`)) { n++; }
    return `${base} ${n}`;
  }

  // Fisher–Yates over a copy; `rng` (0 ≤ x < 1) defaults to Math.random.
  function shuffle(list, rng) {
    const out = arr(list).slice();
    const rand = typeof rng === 'function' ? rng : Math.random;
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(rand() * (i + 1)));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // One string per body whatever order its keys were built in: what the
  // page keeps its answers by.
  function cacheKey(body) {
    const canon = (v) => {
      if (Array.isArray(v)) { return v.map(canon); }
      if (!isObj(v)) { return v; }
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) { out[k] = canon(v[k]); }
      }
      return out;
    };
    return JSON.stringify(canon(body === undefined ? null : body));
  }

  return {
    LIMIT, WORDS_MAX, GENRES_MAX, DURATION_MAX, CACHE_MAX, BPM_TOLERANCE,
    emptyFilters, addName, requestBody, active, viewState, keeps, defaultName, shuffle, cacheKey,
  };
}));
