// The Discover page's pure half (docs/discovery-page-plan.md §4.1): the two
// request bodies the page sends to POST /api/v1/discovery/taste, and what
// the answer looks like on screen — the seed chips, the library's album
// cards and song rows, the connected servers' (federation) album cards and
// song rows, the column slicing behind "Show more", the network rows and
// the job badges on them, and which state the page (and each source) is in.
//
// Two pages share it (2026-10-11): 'play' (Discover — songs you can play
// now, from your library and your connected servers) and 'explore' (the
// p2p network's leads, songs you don't have). They share the window and the
// visit's pins and dropped seeds; each asks only for its own sources
// (buildRequests' `page`).
//
// The route is stateless (2026-10-14): every call draws a NEW random batch
// of the account's finished songs as seeds, so every open and every tap
// asks again — nothing is kept between calls, by the server or here. The
// window is this browser's choice (localStorage, STORAGE_KEYS.window); pins
// and dropped seeds last for the visit only and travel as `pin` / `exclude`,
// and so do the random picks "Another pick" passed over (a list of its own,
// beside the drops — passPick / noPickLeft).
// No DOM, no Vue, no fetch, no storage — m.js
// (discoveryPanel) wires it to the app; the unit test
// (test/unit/webapp-discovery-page.test.mjs) drives it on node and holds the
// contract constants to the server's (src/discovery/taste-queries.js). Same
// UMD shape as alpha/discover-jobs.js.
//
// Text never leaves here as English: labels are i18n KEYS with their params
// ({ key, params }) and the caller translates (t() in m.js). Data — titles,
// artists, peer names — travels as plain strings and must still go through
// escapeHtml when it is drawn.
//
// The wire shapes are the server's (src/api/discovery-taste.js and the
// TasteRequest / TasteResponse schemas in docs/openapi.yaml):
//   network / peers   null = not available here (the flag is off, or a
//                     random seed); asked and empty = { results: [] } /
//                     { peers: [] } with `searched`
//   rows              every network and peers row is a ready-to-send
//                     recommendation (`source` stamped): it is kept RAW on
//                     its view model so the recommendation window, the
//                     plug-in routes and the batch lookup get it unchanged.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.DISCOVERYPAGE = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  // ── contract constants ─────────────────────────────────────────────────
  // src/discovery/taste-queries.js (the route's Joi reads the same values).
  // The unit test fails when the two disagree.
  const WINDOWS = Object.freeze([7, 30, 90, 0]);   // days; 0 = all time
  const DEFAULT_WINDOW = 30;
  const SOURCES = Object.freeze(['library', 'network', 'peers']);
  // 'play' = Discover (library + connected servers); 'explore' = the network.
  const PAGES = Object.freeze(['play', 'explore']);
  const PIN_CAP = 12;            // = LIMIT_CAPS.seeds: the peers call pins a whole batch
  const PIN_PATH_MAX = 2048;
  const EXCLUDE_CAP = 200;
  const HASH_MAX = 128;
  const IGNORE_VPATHS_CAP = 100;
  const VPATH_MAX = 256;
  const LIMIT_DEFAULTS = Object.freeze({ seeds: 12, tracks: 24, albums: 8, network: 12, peers: 12 });
  const LIMIT_CAPS = Object.freeze({ seeds: 12, tracks: 50, albums: 24, network: 50, peers: 25 });
  const LIMIT_MINS = Object.freeze({ seeds: 1, tracks: 0, albums: 0, network: 0, peers: 0 });
  // POST /api/v1/discovery/plugin-jobs/lookup/batch takes 1–100.
  const LOOKUP_BATCH_MAX = 100;
  // A song column's first rows and each "Show more" step; an album strip's
  // cards (one horizontal scroll row).
  const PAGE_SIZE = 16;
  const ALBUM_STRIP_MAX = 12;

  // What the page keeps in localStorage (names only — the panel reads and
  // writes them, in try/catch): the window the bar's dropdown chose (one
  // number; storedWindow reads it back) and "new artists only" — the
  // Discover panel's own key: one semantic, one knob, shared (plan §3.2).
  // Nothing else outlives a visit.
  const STORAGE_KEYS = Object.freeze({
    window: 'discoverPageWindow',
    newArtistsOnly: 'discoverNewArtistsOnly',
  });
  // Seed chips drawn before "Show all" (the canvas: now playing + 6).
  const SEED_CHIPS_MAX = 7;

  // ── small helpers ──────────────────────────────────────────────────────
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');
  const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const lbl = (key, params) => ({ key, params: params || {} });

  // A number from a number or a numeric string (a <select>'s value); never
  // from null / '' / a boolean, which Number() would turn into 0.
  function toInt(v) {
    if (typeof v === 'number') { return Number.isInteger(v) ? v : undefined; }
    if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) { return Number(v.trim()); }
    return undefined;
  }

  // 0.834 → 83 (0–100); null when the server sent none.
  function pct(similarity) {
    const n = Number(similarity);
    if (similarity == null || !Number.isFinite(n)) { return null; }
    return Math.max(0, Math.min(100, Math.round(n * 100)));
  }

  // 253 → "4:13"; 3725 → "1:02:05"; '' for an unknown length.
  function fmtLength(sec) {
    if (sec == null || sec === '') { return ''; }
    const s = Math.round(Number(sec));
    if (!Number.isFinite(s) || s <= 0) { return ''; }
    const two = (n) => (n < 10 ? '0' + n : String(n));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
  }

  function baseName(filepath) {
    const s = str(filepath);
    const i = s.lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
  }

  // The taste route takes vpath-form paths without the leading '/' the
  // player keeps on rawFilePath (the panel's refreshDiscover strips it too).
  function stripSlash(p) { return str(p).replace(/^\/+/, ''); }

  // A data line: the parts that exist, joined with the house ' · '.
  const joinParts = (parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ');

  // "Electronic---Synthwave" → "Synthwave" (the panel's discoverTags rule).
  function modelGenre(tags) {
    const first = arr(tags).find((t) => typeof t === 'string' && t);
    return first ? first.split('---').pop() : '';
  }

  // ── the window and the visit's dropped seeds ──────────────────────────

  function cleanWindow(v) { const n = toInt(v); return n !== undefined && WINDOWS.indexOf(n) !== -1 ? n : undefined; }
  const isHash = (h) => typeof h === 'string' && h.length > 0 && h.length <= HASH_MAX;

  // Valid, de-duplicated hashes in order; undefined for a non-list.
  function cleanHashes(list) {
    if (!Array.isArray(list)) { return undefined; }
    const out = [];
    for (const h of list) { if (isHash(h) && out.indexOf(h) === -1) { out.push(h); } }
    return out;
  }
  // The route takes at most EXCLUDE_CAP: the newest stay.
  const trimExclude = (list) => (list.length > EXCLUDE_CAP ? list.slice(list.length - EXCLUDE_CAP) : list);

  // The stored window (STORAGE_KEYS.window: the raw localStorage string, or
  // null) → a window the route takes; DEFAULT_WINDOW for anything else.
  // Never throws.
  function storedWindow(raw) {
    const w = cleanWindow(raw);
    return w === undefined ? DEFAULT_WINDOW : w;
  }

  // Dropping a seed (its chip's ×) and bringing it back ("Use again", the
  // drop toast's Undo): the visit's list of dropped hashes, sent as
  // `exclude` on every call of the visit and never stored anywhere. A
  // re-drop moves the hash to the newest end; past EXCLUDE_CAP the oldest
  // drop goes. → a new list (the old one is not touched).
  function dropSeed(list, hash) {
    const out = (cleanHashes(list) || []).filter((h) => h !== hash);
    if (isHash(hash)) { out.push(hash); }
    return trimExclude(out);
  }
  function restoreSeed(list, hash) {
    return (cleanHashes(list) || []).filter((h) => h !== hash);
  }

  // "Another pick" (plan §2.8): the random fallback is drawn fresh on every
  // call, and the page re-asks with the picks it already showed this visit
  // in `exclude`, so the next one is a song not seen yet. The visit's list
  // of passed picks is NOT the drops: it is never drawn as dropped chips
  // (the page filters an answer's `excluded` to the drops) and goes on a
  // fresh open. passPick adds one (the newest end; past EXCLUDE_CAP the
  // oldest goes) → a new list.
  function passPick(list, hash) {
    return dropSeed(list, hash);
  }

  // The random pick of an answer (its hash), or null: not a random-seed
  // answer, or no pick in it.
  function randomPick(response) {
    if (!isObj(response) || response.disabled === true || response.seedSource !== 'random') { return null; }
    const s = seedsOf(response).find((x) => isObj(x) && x.pinned !== true && isHash(x.hash));
    return s ? s.hash : null;
  }

  // An answer with no pick left: no seed at all — the random fallback found
  // no song outside the visit's exclusions (the server says notAnalyzed,
  // which would draw a false "scan pending" card). With passed picks in the
  // ask, the page clears them and asks once more so it starts over.
  function noPickLeft(response) {
    if (!isObj(response) || response.disabled === true) { return false; }
    if (seedsOf(response).length > 0) { return false; }
    return response.seedSource === 'random' || response.notAnalyzed === true;
  }

  // ── flags and requests ─────────────────────────────────────────────────

  // The page exists where the ping says so (plan §2.10): discovery on and a
  // server that has the taste route. Never probed.
  // `discoveryTaste` is an integer generation (a later body shape ships as
  // 2), so anything ≥ 1 has the page.
  function pageAvailable(flags) {
    if (!isObj(flags) || flags.discovery !== true) { return false; }
    const gen = typeof flags.discoveryTaste === 'number' ? flags.discoveryTaste : toInt(flags.discoveryTaste);
    return Number.isFinite(gen) && gen >= 1;
  }

  function cleanLimits(limits) {
    if (!isObj(limits)) { return null; }
    const out = {};
    for (const k of Object.keys(LIMIT_CAPS)) {
      const n = Number(limits[k]);
      if (limits[k] == null || limits[k] === '' || typeof limits[k] === 'boolean' || !Number.isFinite(n)) { continue; }
      out[k] = Math.max(LIMIT_MINS[k], Math.min(LIMIT_CAPS[k], Math.floor(n)));
    }
    return Object.keys(out).length ? out : null;
  }

  // The page's calls (plan §3.1). Both bodies carry the SAME keys (window,
  // pins, exclusions, scope, limits) and differ only in `sources`. The
  // peers body is not sent as built: each call draws its own random batch
  // (the server keeps nothing between calls), so it goes out AFTER the main
  // answer lands, pinned to that answer's seeds (peersRequest below) — the
  // connected-server column is built from the batch the picker shows.
  //   page 'play'    (the default) main = { sources: ['library'] }, plus the
  //                  separate peers call where federationDiscovery is on —
  //                  so the library renders without waiting on a connected
  //                  server's 4 s deadline
  //   page 'explore' main = { sources: ['network'] } where discoveryP2p is
  //                  on (both null where it is not: nothing to explore);
  //                  never a peers call
  //   window         7 | 30 | 90 | 0 (a <select>'s string too); anything
  //                  else sends DEFAULT_WINDOW — the body always names one
  //   pinPath        now playing (string; a leading '/' is stripped)
  //   pins           songs the user picked (paths), after pinPath; ≤ PIN_CAP
  //                  (12) in all
  //   exclude        the visit's dropped seeds (hashes; the newest 200)
  //   passed         the random picks "Another pick" passed over this visit
  //                  (hashes): sent in `exclude` after the drops, which keep
  //                  their room — the newest that fit under EXCLUDE_CAP
  //   newArtistsOnly the Explore page's toggle; the play page draws no
  //                  control for it, so it never thins that page's rows
  //   ignoreVPaths   m.js localIgnoreVPaths()
  //   limits         { seeds, tracks, albums, network, peers }, clamped to the caps
  //   flags          { discovery, discoveryTaste, discoveryP2p, federationDiscovery }
  // → { main, peers }: peers = { sources: ['peers'], … } or null; both null
  // where the page is off.
  function buildRequests(opts) {
    const o = opts || {};
    const flags = o.flags || {};
    const page = cleanPage(o.page);
    if (!pageAvailable(flags)) { return { main: null, peers: null }; }
    if (page === 'explore' && flags.discoveryP2p !== true) { return { main: null, peers: null }; }

    const w = cleanWindow(o.window);
    const body = { window: w === undefined ? DEFAULT_WINDOW : w };

    const pins = [];
    const pinList = [].concat(o.pinPath == null ? [] : o.pinPath, arr(o.pins));
    for (const raw of pinList) {
      if (pins.length >= PIN_CAP) { break; }
      const path = stripSlash(raw);
      if (!path || path.length > PIN_PATH_MAX || pins.indexOf(path) !== -1) { continue; }
      pins.push(path);
    }
    if (pins.length) { body.pin = pins; }

    const drops = trimExclude(cleanHashes(o.exclude) || []);
    const passed = (cleanHashes(o.passed) || []).filter((h) => drops.indexOf(h) === -1);
    const room = EXCLUDE_CAP - drops.length;
    const ex = drops.concat(room > 0 ? passed.slice(Math.max(0, passed.length - room)) : []);
    if (ex.length) { body.exclude = ex; }

    body.newArtistsOnly = page === 'explore' && o.newArtistsOnly === true;

    if (Array.isArray(o.ignoreVPaths)) {
      body.ignoreVPaths = o.ignoreVPaths
        .filter((v) => typeof v === 'string' && v.length > 0 && v.length <= VPATH_MAX)
        .slice(0, IGNORE_VPATHS_CAP);
    }
    const limit = cleanLimits(o.limits);
    if (limit) { body.limit = limit; }

    const main = Object.assign({ sources: page === 'explore' ? ['network'] : ['library'] }, body);
    const peers = page === 'play' && flags.federationDiscovery === true ? Object.assign({ sources: ['peers'] }, body) : null;
    return { main, peers };
  }

  // The peers call of one ask, built once the main answer has landed: the
  // peers body (buildRequests' `peers`) pinned to EVERY seed of the main
  // answer (PIN_CAP = the seed cap, so a whole batch fits), with
  // limit.seeds = those pins, so the server adds no seeds of its own and
  // the column's centroid is the batch the picker draws.
  //   peersBody  buildRequests' `peers` (null: no peers call)
  //   main       the main answer
  // → the body to send, or null: no peers body; the main answer failed, was
  // refused or has no seeds; or its seed is the random stand-in (the server
  // asks no connected server on a random seed, and a pin would make it).
  function peersRequest(peersBody, main) {
    if (!isObj(peersBody) || !isObj(main) || main.disabled === true) { return null; }
    if (main.seedSource === 'random') { return null; }
    const pins = [];
    for (const s of seedsOf(main)) {
      if (pins.length >= PIN_CAP) { break; }
      const path = stripSlash(s.filepath);
      if (!path || path.length > PIN_PATH_MAX || pins.indexOf(path) !== -1) { continue; }
      pins.push(path);
    }
    if (!pins.length) { return null; }
    const body = Object.assign({}, peersBody, { pin: pins });
    body.limit = Object.assign({}, isObj(peersBody.limit) ? peersBody.limit : {}, { seeds: pins.length });
    return body;
  }

  function cleanPage(v) { return PAGES.indexOf(v) !== -1 ? v : 'play'; }

  // The two answers as one response for the views below.
  //   main       the library (or, on explore, network) answer: undefined = in flight, null =
  //              failed, { disabled: true } = 403
  //   peersRes   the peers answer, same conventions
  //   peersAsked whether the peers call was made (buildRequests' `peers`)
  // → undefined / null / { disabled } passed through for main; otherwise the
  // main answer with `peers` = undefined (in flight) | null (not asked, not
  // available, refused) | the section — and `peersFailed: true` when that
  // call failed. A peers answer that lands first lends its seeds while the
  // library is still in flight (`library` / `network` undefined, `partial`)
  // — kept for a caller that asks both at once; the page itself chains the
  // peers call on the main answer (peersRequest), so it never sees one.
  function mergeResponses(main, peersRes, peersAsked) {
    const asked = !!peersAsked;
    if (main === undefined && asked && isObj(peersRes) && peersRes.disabled !== true) {
      return Object.assign({}, peersRes, { library: undefined, network: undefined, partial: true });
    }
    if (!isObj(main) || main.disabled === true) { return main; }
    const out = Object.assign({}, main);
    delete out.peersFailed;
    if (!asked) { out.peers = null; return out; }
    if (peersRes === undefined) { out.peers = undefined; return out; }
    if (peersRes === null) { out.peers = null; out.peersFailed = true; return out; }
    out.peers = (isObj(peersRes) && peersRes.disabled !== true && peersRes.peers !== undefined) ? peersRes.peers : null;
    return out;
  }

  // ── seeds ──────────────────────────────────────────────────────────────

  function seedsOf(response) { return isObj(response) ? arr(response.seeds).filter(isObj) : []; }
  function seedIndex(response) {
    const m = new Map();
    for (const s of seedsOf(response)) { if (s.hash && !m.has(s.hash)) { m.set(s.hash, s); } }
    return m;
  }

  function seedTitle(s) {
    const md = isObj(s.metadata) ? s.metadata : {};
    return str(md.title) || baseName(s.filepath);
  }
  function seedArtist(s) {
    const md = isObj(s.metadata) ? s.metadata : {};
    return str(md['artist-display']) || str(md.artist);
  }

  // "Because you finished X" (a tooltip, never visible text) for a row whose
  // seedHash names a history seed; null when the row is because of no single
  // seed (peers rows: the centroid), or of a seed nobody finished — a pin
  // (now playing, a picked song) or the random stand-in.
  function becauseOf(seedHash, seeds, random) {
    const s = seedHash ? seeds.get(seedHash) : null;
    if (!s || s.pinned || random) { return null; }
    return lbl('dpage.because', { title: seedTitle(s) });
  }

  // The title of the seed a row was matched against, or null (no seedHash —
  // a peers row is matched against the seeds' centroid — or not in seeds).
  function matchSeedOf(seedHash, seeds) {
    const s = seedHash ? seeds.get(seedHash) : null;
    return s ? seedTitle(s) || null : null;
  }

  function seedChip(s, ctx) {
    const md = isObj(s.metadata) ? s.metadata : {};
    const title = seedTitle(s);
    const artist = seedArtist(s);
    const tags = [];
    if (s.pinned) {
      const playing = ctx.nowPlaying && stripSlash(s.filepath) === ctx.nowPlaying;
      tags.push(lbl(playing ? 'dpage.seeds.playing' : 'dpage.seeds.picked'));
    } else if (ctx.random) {
      tags.push(lbl('dpage.seeds.randomTag'));
    }
    if (s.analyzed === false) { tags.push(lbl('dpage.seeds.notAnalyzed')); }
    return {
      hash: s.hash || null,
      filepath: str(s.filepath),
      title,
      artist,
      art: md['album-art'] || null,
      pinned: s.pinned === true,
      outcome: s.outcome || null,
      analyzed: s.analyzed !== false,
      // What its × does: a pin leaves this visit's pins; a history seed is
      // dropped for this visit (the next calls exclude it); the random pick
      // has no × ("Another pick").
      action: s.pinned ? 'unpin' : (ctx.random ? null : 'drop'),
      label: artist ? lbl('dpage.seeds.chip', { title, artist }) : lbl('dpage.seeds.chipTitle', { title }),
      tag: tags[0] || null,
      tags,
      metadata: md,
    };
  }

  // The "Based on what you finished" strip: the first `max` chips and the
  // rest behind "Show all" (`more`; no count is drawn); `excluded` = the
  // answer's `excluded` rows — the visit's dropped seeds this call left out
  // — for the picker to bring back ("Use again").
  //   opts.nowPlaying  the now-playing path (its pin reads "playing")
  //   opts.max         chips drawn before the overflow (default 7)
  function seedChips(response, opts) {
    const o = opts || {};
    const max = Number.isInteger(o.max) && o.max >= 0 ? o.max : SEED_CHIPS_MAX;
    const ctx = {
      random: isObj(response) && response.seedSource === 'random',
      nowPlaying: o.nowPlaying ? stripSlash(o.nowPlaying) : null,
    };
    const all = seedsOf(response).map((s) => seedChip(s, ctx));
    const overflow = Math.max(0, all.length - max);
    const excluded = isObj(response) ? arr(response.excluded).filter(isObj).map((e) => {
      const title = seedTitle(e);
      const artist = seedArtist(e);
      return {
        hash: e.hash || null, filepath: str(e.filepath), title, artist,
        art: (isObj(e.metadata) && e.metadata['album-art']) || null,
        label: artist ? lbl('dpage.seeds.chip', { title, artist }) : lbl('dpage.seeds.chipTitle', { title }),
        tag: lbl('dpage.seeds.dropped'),
      };
    }) : [];
    return {
      chips: all.slice(0, max),
      hidden: all.slice(max),
      overflow,
      more: overflow ? lbl('dpage.seeds.showAll') : null,
      total: all.length,
      excluded,
    };
  }

  // ── option lists (the bar's window, the plug-ins) ──────────────────────

  function windowOptions(current) {
    const cur = cleanWindow(current);
    return WINDOWS.map((w) => ({
      value: w,
      label: w === 0 ? lbl('dpage.window.all') : lbl('dpage.window.days', { count: w }),
      selected: w === cur,
    }));
  }

  // "plug-ins on this server: Previews · Deezer  Get it · YouTube  Open
  // elsewhere" over the network rows — one chip per plug-in capability a
  // network row can use (the peer copy belongs to the peers rows; Get it
  // needs jobs.allowed). → [{ key, params, name, title }].
  function pluginChips(list, jobsAllowed) {
    const out = [];
    for (const p of arr(list)) {
      if (!isObj(p) || !p.name || p.name === 'federation-copy') { continue; }
      const caps = arr(p.capabilities);
      const title = str(p.title) || str(p.name);
      if (caps.indexOf('preview') !== -1) { out.push({ key: 'dpage.plugins.preview', params: {}, name: p.name, title }); }
      if (caps.indexOf('acquire') !== -1 && jobsAllowed === true) { out.push({ key: 'dpage.plugins.getIt', params: {}, name: p.name, title }); }
      if (caps.indexOf('links') !== -1) { out.push({ key: 'dpage.plugins.links', params: {}, name: p.name, title }); }
    }
    return out;
  }

  // ── library ────────────────────────────────────────────────────────────

  // m.js albumCredit's rule: the album-artist credit, else the artists.
  function albumCreditLine(a) {
    const albumArtist = typeof a.album_artist === 'string' && a.album_artist ? a.album_artist : null;
    const artists = arr(a.artists).filter((x) => typeof x === 'string' && x);
    return { albumArtist, line: albumArtist || (artists.length ? artists.join(', ') : null) };
  }

  function albumCard(a, ctx) {
    const credit = albumCreditLine(a);
    const trackPaths = arr(a.tracks).filter((p) => typeof p === 'string' && p);
    const scoped = toInt(a.scopedTracks) !== undefined ? toInt(a.scopedTracks)
      : (toInt(a.track_count) !== undefined ? toInt(a.track_count) : trackPaths.length);
    const played = toInt(a.playedTracks) || 0;
    return {
      // renderAlbum(name, undefined, name, albumArtFile, year, albumArtist, artistLine)
      name: a.name == null ? null : String(a.name),
      artistLine: credit.line,
      albumArtist: credit.albumArtist,
      // Data only: the card draws art, title and artist — no year, no
      // percentage, no play counts.
      year: a.year == null ? null : a.year,
      albumArtFile: a.album_art_file || null,
      similarityPct: pct(a.similarity),
      seedHash: a.seedHash || null,
      because: becauseOf(a.seedHash, ctx.seeds, ctx.random),
      scopedTracks: scoped,
      playedTracks: played,
      lastPlayed: a.lastPlayed || null,
      // The card's matched songs, best first — what "queue album" from the
      // page could queue without another request (the card's own click
      // opens the whole album as everywhere else).
      trackPaths,
      raw: a,
    };
  }

  function trackRow(t, ctx) {
    const md = isObj(t.metadata) ? t.metadata : {};
    const artist = str(md['artist-display']) || str(md.artist);
    const album = str(md.album);
    const genre = modelGenre(t.genreTags);
    const playCount = Number(t.playCount) > 0 ? Number(t.playCount) : 0;
    return {
      filepath: str(t.filepath),
      title: str(md.title) || baseName(t.filepath),
      artist,
      album,
      genre,
      // line two of the row: "Artist · Album" (no genre, year or when)
      subtitle: joinParts([artist, album]),
      similarityPct: pct(t.similarity),
      seedHash: t.seedHash || null,
      because: becauseOf(t.seedHash, ctx.seeds, ctx.random),
      playCount,
      lastPlayed: t.lastPlayed || null,
      length: fmtLength(md.duration),
      art: md['album-art'] || null,
      metadata: md,
    };
  }

  // "Albums from your library" and "Songs from your library" (plan §2.6):
  // the server's fixed rule, songs you haven't played lately.
  //   opts.maxAlbums / opts.maxTracks   caps (default: all); the song column
  //                   pages itself with pageSlice
  // → { albums, tracks, count, capped, footer }
  //   footer.paths  what "Queue all · Shuffle · Save as playlist" act on
  //                 (every song row, the ones past maxTracks included);
  //                 footer.queueAllLabel = 'Queue all' (no count)
  function librarySections(response, opts) {
    const o = opts || {};
    const lib = isObj(response) && isObj(response.library) ? response.library : null;
    const ctx = { seeds: seedIndex(response), random: isObj(response) && response.seedSource === 'random' };
    const albums = lib ? arr(lib.albums).filter(isObj).map((a) => albumCard(a, ctx)) : [];
    const tracks = lib ? arr(lib.tracks).filter((t) => isObj(t) && t.filepath).map((t) => trackRow(t, ctx)) : [];
    const maxA = Number.isInteger(o.maxAlbums) && o.maxAlbums >= 0 ? o.maxAlbums : albums.length;
    const maxT = Number.isInteger(o.maxTracks) && o.maxTracks >= 0 ? o.maxTracks : tracks.length;
    return {
      albums: albums.slice(0, maxA),
      tracks: tracks.slice(0, maxT),
      count: albums.length + tracks.length,
      capped: !!(lib && lib.capped === true),
      footer: {
        queueAllLabel: lbl('dpage.verb.queueAll'),
        paths: tracks.map((t) => t.filepath),
      },
    };
  }

  // ── network ────────────────────────────────────────────────────────────

  function leadFields(raw) {
    const artist = str(raw.artist);
    const album = str(raw.album);
    const year = raw.year == null || raw.year === '' ? null : raw.year;
    return {
      title: str(raw.title),
      artist,
      album,
      // The album's own credit ('Various Artists' on a compilation), apart
      // from the track's artist: a connected server's row carries it since
      // 2026-10-19 ('' from an older peer, and on every network lead).
      albumArtist: str(raw.albumArtist),
      year,
      subtitle: joinParts([artist, album, year == null ? '' : String(year)]),
      length: fmtLength(raw.duration),
      similarityPct: pct(raw.similarity),
    };
  }

  // "From the network": p2p leads, metadata only. A row keeps the lead RAW
  // (`raw` → VUEPLAYERCORE.openDiscoverModal(raw, 'p2p'), the batch lookup)
  // and adds what the row draws. `newArtist` is the server's hint when a row
  // carries one (`newArtist: true`; the taste route sends none today — with
  // newArtistsOnly every row is one anyway). recKey / recKeys / jobs / badge
  // are filled by jobBadges.
  // → { rows, count, searched, line }; line = "3 servers searched"
  function networkRows(response) {
    const net = isObj(response) && isObj(response.network) ? response.network : null;
    if (!net) { return { rows: [], count: 0, searched: null, line: null }; }
    const ctx = { seeds: seedIndex(response), random: response.seedSource === 'random' };
    const rows = arr(net.results).filter(isObj).map((raw) => {
      const peerName = isObj(raw.peer) ? str(raw.peer.name) : '';
      const newArtist = raw.newArtist === true;
      return Object.assign({ raw, source: 'p2p' }, leadFields(raw), {
        seedHash: raw.seedHash || null,
        because: becauseOf(raw.seedHash, ctx.seeds, ctx.random),
        // the seed's title for the window's match bar; null = not one seed
        matchSeed: matchSeedOf(raw.seedHash, ctx.seeds),
        peerName,
        onLabel: peerName ? lbl('dpage.network.onServer', { name: peerName }) : null,
        newArtist,
        newArtistLabel: newArtist ? lbl('dpage.network.newArtist') : null,
        recKey: null, recKeys: [], jobs: {}, badge: null,
      });
    });
    const searched = isObj(net.searched) ? net.searched : { peers: 0, tracks: 0 };
    const n = toInt(searched.peers) || 0;
    return { rows, count: rows.length, searched, line: lbl('dpage.network.searched', { count: n }) };
  }

  // ── peers (connected servers) ──────────────────────────────────────────

  // A federation row's album art file: the peer's own /album-art/<name>
  // file, drawn through this server's art proxy
  // (MSTREAMAPI.peerArtUrl(peerId, art, compress) →
  // /api/v1/federation/peers/:id/art/<name>?compress=…: 's' on a song
  // row, 'l' on an album card, neither asks for the full size); null = the
  // note tile. The taste route's peers rows carry it as `albumArt` (null
  // for a track without a cover; absent from a peer on an older server).
  // The other spellings are older guesses, read only after it and harmless.
  function peerArtOf(raw) {
    for (const k of ['albumArt', 'art', 'album-art', 'album_art_file']) {
      const v = raw[k];
      if (typeof v === 'string' && v && v.length <= PIN_PATH_MAX) { return v; }
    }
    return null;
  }

  // A federation row's lite metadata for the queue (VUEPLAYERCORE's
  // queueDiscoverFed and the page's Play now), so the queue row and the
  // now-playing card draw without a lookup: title, artist, album, length,
  // and the row's cover as the song's 'album-art' — songArtUrl draws a
  // federation song's art through the peer art proxy. No albumArt (a
  // track without a cover, a peer on an older server) = no 'album-art',
  // the default cover.
  function fedQueueMeta(raw) {
    const r = isObj(raw) ? raw : {};
    const md = { title: str(r.title), artist: str(r.artist), duration: r.duration || null };
    const album = str(r.album);
    if (album) { md.album = album; }
    const art = peerArtOf(r);
    if (art) { md['album-art'] = art; }
    return md;
  }

  // One group per paired server, answering ones first (then a model
  // mismatch, then the ones that did not answer; otherwise the server's
  // order). A row keeps the federation lead RAW (`raw` →
  // VUEPLAYERCORE.queueDiscoverFed(raw) / openDiscoverModal(raw,
  // 'federation')); `playable` = its peer answered in this call (the page
  // draws only playable rows: peerSongRows / peerAlbums).
  // → { groups, count, searched }
  function peerGroups(response) {
    const sec = isObj(response) && isObj(response.peers) ? response.peers : null;
    if (!sec) { return { groups: [], count: 0, searched: null }; }
    const rank = (g) => (g.playable ? 0 : (g.mismatched ? 1 : 2));
    const ctx = { seeds: seedIndex(response), random: response.seedSource === 'random' };
    const groups = arr(sec.peers).filter(isObj).map((g, order) => {
      const reachable = g.reachable === true;
      const mismatched = g.mismatched === true;
      const playable = reachable && !mismatched;
      const name = str(g.name);
      const rows = arr(g.results).filter(isObj).map((raw) => {
        const peer = isObj(raw.peer) ? raw.peer : {};
        const lead = leadFields(raw);
        const sim = Number(raw.similarity);
        return Object.assign({ raw, source: 'federation' }, lead, {
          // line two of the row: "Artist · Album" (no year, no server)
          subtitle: joinParts([lead.artist, lead.album]),
          similarity: raw.similarity == null || !Number.isFinite(sim) ? null : sim,
          peerId: peer.id != null ? peer.id : (g.id != null ? g.id : null),
          peerName: str(peer.name) || name,
          filepath: str(raw.filepath),
          art: peerArtOf(raw),
          playable,
          // matched against the seeds' centroid, not one seed — unless a
          // responder names the seed (seedHash): then the tooltip says so
          matchSeed: null,
          because: becauseOf(raw.seedHash, ctx.seeds, ctx.random),
          recKey: null, recKeys: [], jobs: {}, badge: null,
        });
      });
      return {
        id: g.id == null ? null : g.id,
        name,
        reachable,
        mismatched,
        playable,
        lastSeen: g.lastSeen || null,
        rows,
        order,
      };
    }).sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
    const s = isObj(sec.searched) ? sec.searched : {};
    return {
      groups,
      count: groups.reduce((n, g) => n + g.rows.length, 0),
      searched: { peers: toInt(s.peers) || 0, unreachable: toInt(s.unreachable) || 0, mismatched: toInt(s.mismatched) || 0 },
    };
  }

  // peerGroups' answer or its `groups` — the helpers below take either.
  const groupsOf = (x) => (isObj(x) && Array.isArray(x.groups) ? x.groups : arr(x)).filter(isObj);

  // Every row of the peers section, in group order (playable or not).
  function peerRowsOf(groups) {
    const out = [];
    for (const g of groupsOf(groups)) { for (const r of arr(g.rows)) { out.push(r); } }
    return out;
  }

  // Best match first; the server's order (group, then row) on a tie and for
  // a row without a similarity.
  function byMatch(list) {
    return list
      .map((r, i) => ({ r, i, s: r.similarity == null ? -Infinity : r.similarity }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map((x) => x.r);
  }

  // "Songs from …": ONE flat list of the playable rows (a peer that did not
  // answer, or answered with another analysis model, adds nothing), best
  // match first across the servers.
  function peerSongRows(groups) {
    return byMatch(peerRowsOf(groupsOf(groups).filter((g) => g.playable)).filter((r) => r.playable));
  }

  // The credit an album copy acts on (src/discovery-plugins/recommendation.js
  // albumCredit, mirrored): the album's own (`albumArtist`) when the row —
  // or a card — carries it, else the track artist; null when neither.
  function albumCreditOf(rec) {
    if (isObj(rec) && hasText(rec.albumArtist)) { return rec.albumArtist; }
    return isObj(rec) && hasText(rec.artist) ? rec.artist : null;
  }

  // What a connected server's album-songs is asked for the album of a row
  // (or of a peerAlbums card), as the album copy asks it (federation-copy
  // albumListing, mirrored): by the album's own credit when there is one —
  // the album whole, a compilation's every track artist, so the window's
  // count, the card's queue and its browse are what Album copies — else
  // narrowed by the track artist. `album_artist` only when there is a
  // credit (m.js albumSongsBody's rule: a peer on an older server sees the
  // request it always did). The caller adds `year` where it has one.
  // → { album, artist, album_artist? }
  function peerAlbumQuery(rec) {
    const r = isObj(rec) ? rec : {};
    const credit = hasText(r.albumArtist) ? r.albumArtist : null;
    const out = { album: str(r.album), artist: credit ? null : (hasText(r.artist) ? r.artist : null) };
    if (credit) { out.album_artist = credit; }
    return out;
  }

  // "Albums from …": the playable rows grouped by peer + album + the
  // album's credit (its albumArtist, else the track artist — so a
  // compilation is ONE card, 'Various Artists', whoever performs each song;
  // rows without an album tag are left out), best match first — an album
  // ranks by its best row — capped at opts.max (default ALBUM_STRIP_MAX).
  // → [{ key, peerId, peerName, album, artist, albumArtist, art, similarity, paths, raws }]
  //   artist        the card's artist line: the credit it is grouped by
  //   albumArtist   the album's own credit (the first row that names one),
  //                 else null (an older peer: the track artist groups it,
  //                 and narrows its listing — peerAlbumQuery)
  //   paths / raws  the album's matched rows, best first: the card's play
  //                 button queues the raws through the federation stream
  //                 (VUEPLAYERCORE.queueDiscoverFed), paths = their
  //                 peer-side filepaths; its ⋯ opens raws[0]
  //   art           the album's cover: the first row's albumArt (best
  //                 match first; a later row's when the first has none),
  //                 else null (the note tile)
  //   peerName      the card's tooltip
  function peerAlbums(groups, opts) {
    const o = opts || {};
    const max = Number.isInteger(o.max) && o.max >= 0 ? o.max : ALBUM_STRIP_MAX;
    const fold = (v) => str(v).trim().toLowerCase();
    const byKey = new Map();
    for (const r of peerSongRows(groups)) {
      const album = str(r.album).trim();
      if (!album) { continue; }
      const credit = hasText(r.albumArtist) ? r.albumArtist.trim() : null;
      const key = JSON.stringify([r.peerId, fold(album), fold(credit || r.artist)]);
      let card = byKey.get(key);
      if (!card) {
        card = { key, peerId: r.peerId, peerName: r.peerName, album, artist: credit || str(r.artist), albumArtist: credit, art: null, similarity: r.similarity, paths: [], raws: [] };
        byKey.set(key, card);
      }
      if (!card.albumArtist && credit) { card.albumArtist = credit; }
      if (!card.art && r.art) { card.art = r.art; }
      if (r.filepath) { card.paths.push(r.filepath); }
      card.raws.push(r.raw);
    }
    return [...byKey.values()].slice(0, max);
  }

  // The section labels, from who answered:
  //   library      'Albums from your library' / 'Songs from your library'
  //   peers        'Albums from {{name}}' / 'Songs from {{name}}' when ONE
  //                connected server answered (or, when none answered, when
  //                only one is paired), else '… from connected servers';
  //                null when there are no connected servers at all (the
  //                page draws no peers label, strip or column)
  // → { libraryAlbums, librarySongs, peerAlbums, peerSongs, peerName }
  function pageLabels(groups) {
    const all = groupsOf(groups);
    const out = {
      libraryAlbums: lbl('dpage.albums.library'),
      librarySongs: lbl('dpage.songs.library'),
      peerAlbums: null,
      peerSongs: null,
      peerName: null,
    };
    if (!all.length) { return out; }
    const answered = all.filter((g) => g.playable === true);
    const named = answered.length ? answered : all;
    const one = named.length === 1 && str(named[0].name) ? str(named[0].name) : null;
    out.peerName = one;
    out.peerAlbums = one ? lbl('dpage.albums.peerOne', { name: one }) : lbl('dpage.albums.peerMany');
    out.peerSongs = one ? lbl('dpage.songs.peerOne', { name: one }) : lbl('dpage.songs.peerMany');
    return out;
  }

  // ── Show more ──────────────────────────────────────────────────────────

  // A song column's visible rows: the first `shown` (default PAGE_SIZE),
  // and what "Show more" does next.
  // → { rows, shown, total, more, next }
  //   more  whether "Show more" is drawn (rows remain)
  //   next  the `shown` a click asks for (shown + size, at most total)
  function pageSlice(list, shown, size) {
    const all = arr(list);
    const step = Number.isInteger(size) && size > 0 ? size : PAGE_SIZE;
    const want = Number.isInteger(shown) && shown >= 0 ? shown : step;
    const n = Math.min(all.length, want);
    return { rows: all.slice(0, n), shown: n, total: all.length, more: all.length > n, next: Math.min(all.length, n + step) };
  }

  // The no-connected-servers layout: "Songs from your library" fills BOTH
  // columns on a wide screen. The visible rows go in blocks of `size`
  // (default PAGE_SIZE); each block is two columns filled column-major —
  // rows 1–8 left, 9–16 right — and a short last block splits evenly
  // (10 rows → 5 + 5). Each entry keeps its index in `rows` (`i`, the
  // panel's data-i). `perColumn` = the block's grid-template-rows count
  // for a grid-auto-flow: column grid; left / right = the same split as
  // two lists.
  // → [{ start, perColumn, rows: [{ row, i }], left, right }]
  function columnBlocks(rows, size) {
    const all = arr(rows);
    const step = Number.isInteger(size) && size > 1 ? size : PAGE_SIZE;
    const out = [];
    for (let start = 0; start < all.length; start += step) {
      const block = all.slice(start, start + step).map((row, k) => ({ row, i: start + k }));
      const perColumn = Math.ceil(block.length / 2);
      out.push({ start, perColumn, rows: block, left: block.slice(0, perColumn), right: block.slice(perColumn) });
    }
    return out;
  }

  // ── job badges ─────────────────────────────────────────────────────────
  // What the user already did with a lead — "getting it · 64%", "added · in
  // Discover downloads", "copying the album · 2 of 7" — from the plug-in
  // jobs, matched by recommendation key. The keys are the server's
  // (recommendationKey): the batch lookup answers them per row, so they are
  // never computed here.

  // The raw recommendations for POST …/plugin-jobs/lookup/batch, in chunks
  // the route takes (≤ 100); the answers concatenate back in row order.
  function lookupChunks(rows) {
    const recs = arr(rows).map((r) => (isObj(r) && isObj(r.raw) ? r.raw : null)).filter(Boolean);
    const out = [];
    for (let i = 0; i < recs.length; i += LOOKUP_BATCH_MAX) { out.push(recs.slice(i, i + LOOKUP_BATCH_MAX)); }
    return out;
  }

  // Which job a row shows: a live one first (running, then queued), then a
  // failure (it wants the user), then a finished one; the newest on a tie.
  // A cancelled job is over — the row is back to its verbs. A folder job
  // never badges a Discover row (a row's folder key is its own file's, so
  // none should come back; Discover offers no folder copy), and the slots
  // in `skip` (another server's album and artist jobs) never do either.
  const BADGE_RANK = { running: 0, queued: 1, failed: 2, done: 3 };
  const BADGE_SCOPES = ['song', 'album', 'artist', 'artist-missing'];
  function scopeOfJob(job, DJ) {
    return DJ && typeof DJ.jobScope === 'function' ? DJ.jobScope(job) : ((isObj(job.params) && job.params.scope) || 'song');
  }
  function badgeOf(held, DJ, skip) {
    let best = null;
    let bestSlot = null;
    for (const slot of Object.keys(held)) {
      const job = held[slot];
      if (!isObj(job) || !Object.prototype.hasOwnProperty.call(BADGE_RANK, job.state)) { continue; }
      if (BADGE_SCOPES.indexOf(scopeOfJob(job, DJ)) === -1) { continue; }
      if (Array.isArray(skip) && skip.indexOf(slot) !== -1) { continue; }
      const r = BADGE_RANK[job.state];
      const br = best ? BADGE_RANK[best.state] : Infinity;
      if (r < br || (r === br && Number(job.id) > Number(best.id))) { best = job; bestSlot = slot; }
    }
    if (!best) { return null; }
    return Object.assign({}, DJ.jobRowState(best, { plugin: best.plugin }), {
      slot: bestSlot,
      plugin: best.plugin,
      scope: typeof DJ.jobScope === 'function' ? DJ.jobScope(best) : 'song',
      // 'discover.tray.kindAlbum' etc. for a job on more than the song
      kind: typeof DJ.jobKind === 'function' ? DJ.jobKind(best) : null,
      jobId: best.id,
    });
  }

  // src/db/name-key.js, mirrored: how the copy matches album names (the
  // artist walk's planArtistAlbums and owned.js fold names this way).
  function nameKey(raw) {
    if (raw == null) { return ''; }
    return String(raw).replace(/\s+/g, ' ').trim()
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/[‐‑‒–—―−]/g, '-')
      .toLowerCase();
  }

  // "Done" is not "kept", album by album. An artist job's key sits on
  // every row and card of the artist on that server, but its walk copies
  // only the artist's own albums (result.albums) and leaves out the ones
  // they only appear on and — only-missing — the ones the library had
  // (result.skippedAlbums). So a FINISHED artist or artist-missing job
  // speaks for one album (`album`, the card's or the row's) only as that
  // album came out of the walk:
  //   walked, no error            that album's own account (its songs
  //                               copied, already yours, failed, or
  //                               where the run stopped)
  //   its listing failed          nothing — unless the run stopped there
  //                               (the transfer limit, the peer gone):
  //                               stopped
  //   left out as 'owned'         already yours
  //   left out as 'appearance',
  //   never walked, no album      nothing (null)
  // A live or failed artist job, and every other scope, is the job itself.
  function jobForAlbum(job, album, DJ) {
    const scope = scopeOfJob(job, DJ);
    if ((scope !== 'artist' && scope !== 'artist-missing') || job.state !== 'done') { return job; }
    const res = isObj(job.result) ? job.result : {};
    const walked = arr(res.albums).filter(isObj);
    const left = arr(res.skippedAlbums).filter(isObj);
    const want = nameKey(album);
    if (!want || (!Array.isArray(res.albums) && !Array.isArray(res.skippedAlbums))) { return null; }
    const at = walked.findIndex((a) => nameKey(a.name) === want);
    const view = (songs, stopped, extra) => {
      const n = (k) => arr(songs[k]).length;
      const total = Number.isFinite(Number(songs.total)) ? Number(songs.total) : n('copied') + n('skipped') + n('failed');
      return Object.assign({}, job, {
        result: Object.assign({
          scope: res.scope || scope,
          songs: { total, copied: arr(songs.copied), skipped: arr(songs.skipped), failed: arr(songs.failed) },
          counts: { total, copied: n('copied'), skipped: n('skipped'), failed: n('failed') },
          stopped: stopped || null,
          peer: res.peer || null,
        }, extra || {}),
      });
    };
    if (at !== -1) {
      const one = walked[at];
      const last = at === walked.length - 1;
      if (one.error) { return res.stopped && last ? view({}, res.stopped) : null; }
      if (!isObj(one.songs)) { return job; }   // no per-album account: the walk's
      return view(one.songs, one.stopped);
    }
    const skipped = left.find((a) => nameKey(a.name) === want);
    if (skipped && skipped.why === 'owned') { return view({}, null, { skippedAlbums: [skipped] }); }
    return null;
  }

  // `held` (slot → job) as it speaks for one album (jobForAlbum); the
  // slots that say nothing about it are left out.
  function heldForAlbum(held, album, DJ) {
    const out = {};
    for (const slot of Object.keys(held)) {
      const job = isObj(held[slot]) ? jobForAlbum(held[slot], album, DJ) : null;
      if (job) { out[slot] = job; }
    }
    return out;
  }

  // ── Keep a copy: a wider copy that already settled the album or the song ──
  // A peer's file path as the copy compares them (src/discovery-plugins/
  // recommendation.js normalizePeerPath, mirrored).
  function normalizePeerPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.').join('/');
  }

  // When a job last moved: its finish, else its last update, else its
  // creation (the jobs table's epoch milliseconds; a date string reads
  // too). NaN when it carries none.
  function jobStamp(job) {
    for (const k of ['finishedAt', 'updatedAt', 'createdAt']) {
      const v = job[k];
      if (v == null || v === '') { continue; }
      const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
      if (Number.isFinite(n)) { return n; }
    }
    return NaN;
  }

  // Is job `a` newer than job `b`: by those stamps, else (none, or a tie)
  // by id — the order the jobs were made in.
  function newerJob(a, b) {
    const sa = jobStamp(a);
    const sb = jobStamp(b);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) { return sa > sb; }
    return Number(a.id) > Number(b.id);
  }

  // A finished album copy — or an artist copy's view of one album
  // (jobForAlbum) — as it speaks for ONE of its songs: only where its
  // lists name the song's file on the peer (each entry's `from`: the path
  // the copy fetched, the peer's own rendering of it, as the row carries
  // it). Copied → in your collection, where it landed; left out as
  // already here → already yours ('owned': where the library has it;
  // 'exists': a file already sits at its place — nothing to play from
  // here). Failed, not listed (a list stops at 500), no path: nothing
  // (null). The view is a song's result on the wider job.
  function songView(job, filepath) {
    const want = normalizePeerPath(filepath);
    const res = isObj(job.result) ? job.result : null;
    const songs = res && isObj(res.songs) ? res.songs : null;
    if (!want || !songs) { return null; }
    const hit = (list) => arr(list).find((e) => isObj(e) && normalizePeerPath(e.from) === want) || null;
    const as = (result) => Object.assign({}, job, { result: Object.assign({ peer: res.peer || null }, result) });
    const copied = hit(songs.copied);
    if (copied) {
      const landed = Object.assign({}, copied);
      delete landed.from;
      return as({ copied: landed });
    }
    const kept = hit(songs.skipped);
    if (kept && kept.why === 'owned') { return as({ skipped: 'owned', existing: kept.at ? { filepath: kept.at } : null }); }
    if (kept && kept.why === 'exists') { return as({ skipped: 'owned', existing: null }); }
    return null;
  }

  // What a connected server's Keep a copy choice shows — the Album choice
  // and This song, each its own scope's job, unless a FINISHED wider copy
  // of the same server settled it since: the user ran "Only the albums you
  // don't have", the album came in, and the Album choice still offered
  // "Add album" (2026-10-20). The rows' markers already read such a copy
  // album by album (jobForAlbum); the choices read it the same way.
  //   scope  'album' | 'song' (any other: `own`, as it is)
  //   own    the choice's own job, or null; a live one is always the
  //          choice's
  //   wider  that server's jobs of the wider scopes (the caller leaves
  //          another server's out): for the album its artist and
  //          only-missing copies, for the song those and its album copy.
  //          Only a 'done' one speaks — a live one is its own choice's, a
  //          failed or cancelled one recorded nothing for this album —
  //          and only as it saw THIS album (jobForAlbum: walked, or left
  //          out as already here) and, for the song, only where its lists
  //          name the song (songView)
  //   at     { album, filepath }: the row's album tag and its file on the peer
  // → the newest wider job that speaks, as that view — unless the own job
  //   is newer (newerJob): then the own job; null for neither.
  const WIDER_SCOPES = { album: ['artist', 'artist-missing'], song: ['album', 'artist', 'artist-missing'] };
  function keepJobFor(scope, own, wider, at, DJ) {
    const mine = isObj(own) ? own : null;
    const live = mine && (DJ && typeof DJ.isLive === 'function' ? DJ.isLive(mine) : (mine.state === 'queued' || mine.state === 'running'));
    const scopes = WIDER_SCOPES[scope];
    if (!scopes || live) { return mine; }
    const where = isObj(at) ? at : {};
    let best = null;
    let bestJob = null;
    for (const job of arr(wider)) {
      if (!isObj(job) || job.state !== 'done') { continue; }
      const s = scopeOfJob(job, DJ);
      if (scopes.indexOf(s) === -1) { continue; }
      const forAlbum = s === 'album' ? job : jobForAlbum(job, where.album, DJ);
      const view = !forAlbum ? null : (scope === 'album' ? forAlbum : songView(forAlbum, where.filepath));
      if (view && (!bestJob || newerJob(job, bestJob))) { best = view; bestJob = job; }
    }
    if (!best || (mine && !newerJob(bestJob, mine))) { return mine; }
    return best;
  }

  function keysOf(found) {
    const out = [];
    if (found.key) { out.push(found.key); }
    if (isObj(found.keys)) {
      for (const k of Object.keys(found.keys)) { const v = found.keys[k]; if (v && out.indexOf(v) === -1) { out.push(v); } }
    }
    return out;
  }

  // Album and artist job keys carry no server (the same album on two
  // connected servers is one key, and a live job dedupes across them), so
  // the lookup can hand a connected server's row another server's album or
  // artist copy. Such a job is not this server's: true when `job` is an
  // album / artist / artist-missing job whose recommendation names a
  // server other than `peerId`. A song job is the recording wherever it
  // came from; a job that names no server, or a row with none (a network
  // lead), is never another's.
  function otherPeerJob(job, peerId, DJ) {
    if (peerId == null || !isObj(job) || scopeOfJob(job, DJ) === 'song') { return false; }
    const rec = isObj(job.recommendation) ? job.recommendation : null;
    const peer = rec && isObj(rec.peer) ? rec.peer : null;
    if (!peer || peer.id == null) { return false; }
    return String(peer.id) !== String(peerId);
  }

  // A row's album tag: its raw recommendation's, else the row's own.
  function rowAlbum(row) {
    if (isObj(row.raw) && row.raw.album != null) { return row.raw.album; }
    return row.album;
  }

  // The slots of `held` whose job is another server's (otherPeerJob).
  function otherPeerSlots(held, peerId, DJ) {
    return Object.keys(held).filter((slot) => otherPeerJob(held[slot], peerId, DJ));
  }

  // Merge jobs onto rows → new rows with recKey, recKeys, jobs (by slot),
  // otherPeer (the slots holding another connected server's album or
  // artist job: kept in jobs, never the badge) and badge (DJ.jobRowState
  // of the job shown, plus slot / plugin / scope / kind / jobId; null for
  // none). A row with a peerId is a connected server's; the others (the
  // network's leads) take any job under their keys.
  //   answer.results  the batch lookup's `results`, aligned with `rows`
  //                   (concatenated across lookupChunks): sets each row's
  //                   keys, and its jobs from scratch
  //   answer.jobs     a flat job list (VUEPLAYERCORE.discoverJobs(), the
  //                   strip's poll): merged onto rows that know their keys,
  //                   a newer job (higher id) replacing the one held
  //   DJ              DISCOVERJOBS (injected; the browser's global when
  //                   omitted); without it rows keep no badge
  // An array for `answer` is taken as `results`.
  function jobBadges(rows, answer, DJ) {
    const dj = DJ || ((typeof globalThis !== 'undefined' && globalThis.DISCOVERJOBS) || null);
    const a = Array.isArray(answer) ? { results: answer } : (isObj(answer) ? answer : {});
    const results = Array.isArray(a.results) ? a.results : null;
    const jobs = Array.isArray(a.jobs) ? a.jobs.filter(isObj) : null;
    return arr(rows).map((row, i) => {
      const next = Object.assign({}, row);
      let held = Object.assign({}, isObj(row.jobs) ? row.jobs : {});
      next.recKeys = arr(row.recKeys).slice();
      const found = results ? results[i] : null;
      if (isObj(found)) {
        next.recKey = found.key || null;
        next.recKeys = keysOf(found);
        held = dj ? Object.assign({}, dj.jobsBySlot(arr(found.jobs))) : {};
      }
      if (dj && jobs && next.recKeys.length) {
        const mine = dj.jobsBySlot(jobs.filter((j) => next.recKeys.indexOf(j.key) !== -1));
        for (const slot of Object.keys(mine)) {
          const have = held[slot];
          if (!have || Number(mine[slot].id) >= Number(have.id)) { held[slot] = mine[slot]; }
        }
      }
      next.jobs = held;
      next.otherPeer = otherPeerSlots(held, row.peerId, dj);
      // an artist copy speaks for the row as the walk did for its album
      next.badge = dj ? badgeOf(heldForAlbum(held, rowAlbum(row), dj), dj, next.otherPeer) : null;
      return next;
    });
  }

  // A connected server's album cards' badges, from their rows' jobs (the
  // rows jobBadges answered, matched to a card by raw row): the album and
  // artist copies of THAT server — an album job sits on every row of the
  // card (they share its key), an artist job on every row by the artist,
  // and a finished one speaks for the card's album only as its walk did
  // (jobForAlbum: a compilation they only guest on is not copied). Never a
  // song job (one song of the album is not the album), never another
  // server's copy of the same album. Ranked as a row's badge is.
  //   cards  peerAlbums' cards ({ peerId, album, raws })
  //   rows   jobBadges' rows ({ raw, jobs })
  //   DJ     DISCOVERJOBS (injected; the browser's global when omitted)
  // → [badge | null], aligned with cards
  function peerAlbumBadges(cards, rows, DJ) {
    const dj = DJ || ((typeof globalThis !== 'undefined' && globalThis.DISCOVERJOBS) || null);
    const byRaw = new Map();
    for (const r of arr(rows)) { if (isObj(r) && isObj(r.raw) && !byRaw.has(r.raw)) { byRaw.set(r.raw, r); } }
    return arr(cards).map((card) => {
      if (!dj || !isObj(card)) { return null; }
      const held = {};
      for (const raw of arr(card.raws)) {
        const row = byRaw.get(raw);
        if (!row || !isObj(row.jobs)) { continue; }
        for (const slot of Object.keys(row.jobs)) {
          const job = row.jobs[slot];
          if (!isObj(job) || scopeOfJob(job, dj) === 'song' || otherPeerJob(job, card.peerId, dj)) { continue; }
          const have = held[slot];
          if (!have || Number(job.id) > Number(have.id)) { held[slot] = job; }
        }
      }
      return badgeOf(heldForAlbum(held, card.album, dj), dj);
    });
  }

  // Is any badge still moving (the page keeps listening to the poll)?
  function anyLiveBadge(rows) {
    return arr(rows).some((r) => isObj(r) && isObj(r.badge) && r.badge.live === true);
  }

  // ── states ─────────────────────────────────────────────────────────────

  // One source's state: absent (not drawn at all — the flag is off, another
  // page's source, the server answered null: not available here / a random
  // seed, or — peers — no connected servers at all), loading, failed, empty
  // (with the one dim line that explains it), ready.
  //   library empty   'Nothing new in your library sounds like these
  //                   songs.' (the line alone)
  //   peers empty     'Nothing from your connected servers right now.' —
  //                   servers are paired but no playable row came back (all
  //                   offline, all on another model, or nothing new)
  //   count           rows the source would draw (peers: playable rows only)
  function sourceState(name, response, flags, opts) {
    const absent = { status: 'absent', reason: null, count: 0 };
    if (name === 'network' && (flags.discoveryP2p !== true || opts.page !== 'explore')) { return absent; }
    if (name !== 'network' && opts.page === 'explore') { return absent; }
    if (name === 'peers' && flags.federationDiscovery !== true) { return absent; }
    if (response === undefined) { return { status: 'loading', reason: null, count: 0 }; }
    if (!isObj(response)) { return { status: 'failed', reason: lbl('dpage.source.failed'), count: 0 }; }
    if (name === 'peers' && response.peersFailed === true) { return { status: 'failed', reason: lbl('dpage.source.failed'), count: 0 }; }
    // A random seed (nothing finished): the server asks no connected server,
    // so the page draws no column for them while that call is still out.
    if (name === 'peers' && response.seedSource === 'random' && response.partial !== true) { return absent; }
    const sec = response[name];
    if (sec === undefined) { return { status: 'loading', reason: null, count: 0 }; }
    if (!isObj(sec)) { return absent; }
    const waiting = response.notAnalyzed === true;

    if (name === 'library') {
      const count = arr(sec.albums).length + arr(sec.tracks).length;
      if (count) { return { status: 'ready', reason: null, count }; }
      return { status: 'empty', count: 0, reason: lbl(waiting ? 'dpage.source.waitingForScan' : 'dpage.library.nothing') };
    }
    if (name === 'network') {
      const count = arr(sec.results).length;
      if (count) { return { status: 'ready', reason: null, count }; }
      const searched = isObj(sec.searched) ? toInt(sec.searched.peers) || 0 : 0;
      return {
        status: 'empty', count: 0,
        reason: waiting ? lbl('dpage.source.waitingForScan') : lbl(searched === 0 ? 'dpage.network.warmingUp' : 'dpage.network.nothingNew'),
      };
    }
    const groups = arr(sec.peers).filter(isObj);
    if (groups.length === 0) { return absent; }
    const count = groups
      .filter((g) => g.reachable === true && g.mismatched !== true)
      .reduce((n, g) => n + arr(g.results).filter(isObj).length, 0);
    if (count) { return { status: 'ready', reason: null, count }; }
    return { status: 'empty', count: 0, reason: lbl(waiting ? 'dpage.source.waitingForScan' : 'dpage.peers.quiet') };
  }

  // Which page to draw, and each source's state.
  //   response  mergeResponses' answer: undefined = in flight, null = failed,
  //             { disabled: true } = 403
  //   flags     { discovery, discoveryTaste, discoveryP2p, federationDiscovery }
  //   opts      { page } — 'play' (default) draws library + peers (network
  //             absent); 'explore' draws network alone
  // → { state, reason, sources: { library, network, peers } }
  //   state     'off'             the ping does not advertise the page, or
  //                               the route said 403 (re-ping before
  //                               naming a reason)
  //             'loading'         no answer yet
  //             'failed'          the call failed (not a 403): try again
  //             'scanPending'     no seed is analyzed yet (seeds listed)
  //             'nothingFinished' a random seed stands in: nothing counted,
  //                               or every finished song was dropped this
  //                               visit (reason dpage.state.allDropped)
  //             'ready'
  function stateOf(response, flags, opts) {
    const f = isObj(flags) ? flags : {};
    const so = { page: cleanPage((opts || {}).page) };
    const absent = { status: 'absent', reason: null, count: 0 };
    const off = !pageAvailable(f) || (isObj(response) && response.disabled === true);
    const sources = off
      ? { library: absent, network: absent, peers: absent }
      : {
        library: sourceState('library', response, f, so),
        network: sourceState('network', response, f, so),
        peers: sourceState('peers', response, f, so),
      };
    let state = 'ready';
    let reason = null;
    if (off) { state = 'off'; reason = lbl('dpage.state.off'); }
    else if (response === undefined) { state = 'loading'; }
    else if (!isObj(response)) { state = 'failed'; reason = lbl('dpage.state.failed'); }
    else if (response.notAnalyzed === true) { state = 'scanPending'; reason = lbl('dpage.state.scanPending'); }
    else if (response.seedSource === 'random') {
      state = 'nothingFinished';
      reason = lbl(arr(response.excluded).length ? 'dpage.state.allDropped' : 'dpage.state.nothingFinished');
    }
    return { state, reason, sources };
  }

  return {
    WINDOWS, DEFAULT_WINDOW, SOURCES, PAGES, PIN_CAP, EXCLUDE_CAP, HASH_MAX,
    LIMIT_DEFAULTS, LIMIT_CAPS, LOOKUP_BATCH_MAX, STORAGE_KEYS, SEED_CHIPS_MAX, PAGE_SIZE, ALBUM_STRIP_MAX,
    storedWindow, dropSeed, restoreSeed, passPick, randomPick, noPickLeft,
    pageAvailable, buildRequests, peersRequest, mergeResponses,
    fmtLength,
    seedChips, windowOptions, pluginChips,
    librarySections, networkRows,
    peerGroups, peerRowsOf, peerSongRows, peerAlbums, albumCreditOf, peerAlbumQuery, fedQueueMeta, pageLabels, pageSlice, columnBlocks,
    lookupChunks, jobBadges, peerAlbumBadges, anyLiveBadge, nameKey, normalizePeerPath, keepJobFor,
    stateOf,
  };
}));
