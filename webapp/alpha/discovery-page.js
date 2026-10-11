// The Discover page's pure half (docs/discovery-page-plan.md §4.1): the two
// request bodies the page sends to POST /api/v1/discovery/taste, and what
// the answer looks like on screen — the seed chips, the library's album
// cards and song rows, the connected servers' (federation) album cards and
// song rows, the column slicing behind "Show more", the network rows and
// the job badges on them, and which state the page (and each source) is in.
//
// Two pages share it (2026-10-11): 'play' (Discover — songs you can play
// now, from your library and your connected servers) and 'explore' (the
// p2p network's leads, songs you don't have). They share the prefs and the
// seeds; each asks only for its own sources (buildRequests' `page`).
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
  const FILTERS = Object.freeze(['fresh', 'unplayed', 'all']);
  const SOURCES = Object.freeze(['library', 'network', 'peers']);
  // The page's own filter: ONE checkbox, "Include songs I've played lately"
  // — unticked = 'fresh' (unplayed, or not played in staleDays), ticked =
  // 'all'. The server still takes 'unplayed', but the page never sends it:
  // a saved 'unplayed' (and the old client spelling 'never') reads 'fresh'.
  const PAGE_FILTERS = Object.freeze(['fresh', 'all']);
  // 'play' = Discover (library + connected servers); 'explore' = the network.
  const PAGES = Object.freeze(['play', 'explore']);
  const DEFAULT_PREFS = Object.freeze({ window: 30, filter: 'fresh', staleDays: 90 });
  const STALE_DAYS_MIN = 1;
  const STALE_DAYS_MAX = 3650;
  const PIN_CAP = 8;
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
  // writes them, in try/catch). `newArtistsOnly` is the Discover panel's own
  // key: one semantic, one knob, shared (plan §3.2). `prefs` mirrors the
  // window / filter / staleDays (and, where the server cannot persist —
  // public-access mode — the dropped seeds) for the next visit.
  const STORAGE_KEYS = Object.freeze({
    prefs: 'discoverPagePrefs',
    newArtistsOnly: 'discoverNewArtistsOnly',
  });
  // How long an answer may be shown again without asking (a revisit within
  // the server's own 5-minute section cache). Clients never poll.
  const CLIENT_TTL_MS = 5 * 60 * 1000;
  // Seed chips drawn before "Show all" (the canvas: now playing + 6).
  const SEED_CHIPS_MAX = 7;

  const DAY_MS = 24 * 60 * 60 * 1000;

  // ── small helpers ──────────────────────────────────────────────────────
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const lbl = (key, params) => ({ key, params: params || {} });

  // A number from a number or a numeric string (a <select>'s value); never
  // from null / '' / a boolean, which Number() would turn into 0.
  function toInt(v) {
    if (typeof v === 'number') { return Number.isInteger(v) ? v : undefined; }
    if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) { return Number(v.trim()); }
    return undefined;
  }

  // Milliseconds from an ISO string, a Date or epoch ms; NaN when unknown.
  function toMs(v) {
    if (v instanceof Date) { return v.getTime(); }
    if (typeof v === 'number') { return v; }
    if (typeof v === 'string' && v) { return Date.parse(v); }
    return NaN;
  }
  const nowMs = (now) => { const n = toMs(now); return Number.isFinite(n) ? n : Date.now(); };

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

  // ── prefs ──────────────────────────────────────────────────────────────

  function cleanWindow(v) { const n = toInt(v); return n !== undefined && WINDOWS.indexOf(n) !== -1 ? n : undefined; }
  // The page's filter from anything stored or answered: 'all' stays, 'fresh'
  // / 'unplayed' / 'never' read 'fresh', anything else is unknown.
  function pageFilter(v) {
    if (v === 'all') { return 'all'; }
    return v === 'fresh' || v === 'unplayed' || v === 'never' ? 'fresh' : undefined;
  }
  function cleanStaleDays(v) { const n = toInt(v); return n !== undefined && n >= STALE_DAYS_MIN && n <= STALE_DAYS_MAX ? n : undefined; }
  const isHash = (h) => typeof h === 'string' && h.length > 0 && h.length <= HASH_MAX;

  // Valid, de-duplicated hashes in order; undefined for a non-list.
  function cleanHashes(list) {
    if (!Array.isArray(list)) { return undefined; }
    const out = [];
    for (const h of list) { if (isHash(h) && out.indexOf(h) === -1) { out.push(h); } }
    return out;
  }
  // The server's trim rule: oldest first out, so the newest EXCLUDE_CAP stay.
  const trimExclude = (list) => (list.length > EXCLUDE_CAP ? list.slice(list.length - EXCLUDE_CAP) : list);

  // Only the valid keys of a prefs-ish object (a server answer, a stored
  // copy, the page's own state); everything else is dropped.
  function cleanPrefs(p) {
    const out = {};
    if (!isObj(p)) { return out; }
    const w = cleanWindow(p.window); if (w !== undefined) { out.window = w; }
    const f = pageFilter(p.filter); if (f !== undefined) { out.filter = f; }
    const s = cleanStaleDays(p.staleDays); if (s !== undefined) { out.staleDays = s; }
    const e = cleanHashes(p.exclude); if (e !== undefined) { out.exclude = trimExclude(e); }
    if (typeof p.newArtistsOnly === 'boolean') { out.newArtistsOnly = p.newArtistsOnly; }
    return out;
  }

  function defaultPrefs() {
    return { window: DEFAULT_PREFS.window, filter: DEFAULT_PREFS.filter, staleDays: DEFAULT_PREFS.staleDays, exclude: [], newArtistsOnly: false, persisted: false };
  }

  // The prefs the page renders with. `saved` = GET …/taste/prefs (defaults
  // applied, `persisted`), or null when it failed or never ran; `local` =
  // the stored copy plus the client-only `newArtistsOnly`.
  //   persisted: true   the account's prefs are the truth on every client:
  //                     the server's values win, local only fills a gap
  //   otherwise         (public-access mode, where nothing is stored, or no
  //                     answer) this browser's copy wins over the server's
  //                     defaults
  // `persisted` says whether a change should be sent with `remember: true`
  // (and whether the dropped seeds live on the server).
  function mergePrefs(saved, local) {
    const s = cleanPrefs(saved);
    const l = cleanPrefs(local);
    const persisted = isObj(saved) && saved.persisted === true;
    const first = persisted ? s : l;
    const second = persisted ? l : s;
    const pick = (k) => (first[k] !== undefined ? first[k] : (second[k] !== undefined ? second[k] : DEFAULT_PREFS[k]));
    return {
      window: pick('window'),
      filter: pick('filter'),
      staleDays: pick('staleDays'),
      // A server that persists keeps THE list; elsewhere this browser does.
      exclude: (persisted ? s.exclude : (l.exclude || s.exclude)) || [],
      newArtistsOnly: l.newArtistsOnly === true,
      persisted,
    };
  }

  // The localStorage copy (STORAGE_KEYS.prefs) ↔ prefs. Never throws.
  function parseStoredPrefs(raw) {
    if (typeof raw !== 'string' || !raw) { return {}; }
    try { return cleanPrefs(JSON.parse(raw)); } catch (_) { return {}; }
  }
  function serializePrefs(prefs) {
    const p = cleanPrefs(prefs);
    const out = {};
    for (const k of ['window', 'filter', 'staleDays', 'exclude']) { if (p[k] !== undefined) { out[k] = p[k]; } }
    return JSON.stringify(out);
  }

  // Dropping a seed (its chip's ×) and bringing it back (the seeds sheet).
  // A drop is sent as `exclude: [hash]` with `remember: true` (the server
  // merges and trims); a restore is a PUT of the whole list without it —
  // `{ exclude: next.exclude }` — since the POST can only add.
  function dropSeed(prefs, hash) {
    const p = Object.assign({}, prefs || {});
    const list = (cleanHashes(p.exclude) || []).filter((h) => h !== hash);
    if (isHash(hash)) { list.push(hash); }
    p.exclude = trimExclude(list);
    return p;
  }
  function restoreSeed(prefs, hash) {
    const p = Object.assign({}, prefs || {});
    p.exclude = (cleanHashes(p.exclude) || []).filter((h) => h !== hash);
    return p;
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

  // The page's calls (plan §3.1). Every body carries the SAME seeds-shaping
  // keys (window, pins, exclusions, scope, limits) so the two pages and the
  // two calls agree on the seeds and share the server's section cache; only
  // `sources` differs, and `remember` rides on `main` alone (one write).
  //   page 'play'    (the default) main = { sources: ['library'] }, plus the
  //                  separate peers call where federationDiscovery is on —
  //                  so the library renders without waiting on a connected
  //                  server's 4 s deadline
  //   page 'explore' main = { sources: ['network'] } where discoveryP2p is
  //                  on (both null where it is not: nothing to explore);
  //                  never a peers call
  //   prefs          mergePrefs' answer (window / filter / staleDays / exclude /
  //                  newArtistsOnly / persisted)
  //   window, filter, staleDays, newArtistsOnly   this call's choice, over prefs
  //                  (a filter of 'unplayed' / 'never' is sent as 'fresh')
  //   pinPath        now playing (string; a leading '/' is stripped)
  //   pins           songs the user picked (paths), after pinPath; ≤ 8 in all
  //   exclude        hashes dropped in THIS call (a persisting server merges
  //                  its saved list itself; elsewhere prefs.exclude is sent too)
  //   remember       save window / filter / staleDays / exclusions
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
    const prefs = isObj(o.prefs) ? o.prefs : {};
    const p = cleanPrefs(prefs);
    const either = (a, b) => (a !== undefined ? a : b);

    const body = {};
    const w = either(cleanWindow(o.window), p.window);
    if (w !== undefined) { body.window = w; }
    const f = either(pageFilter(o.filter), p.filter);
    if (f !== undefined) { body.filter = f; }
    const s = either(cleanStaleDays(o.staleDays), p.staleDays);
    if (s !== undefined) { body.staleDays = s; }

    const pins = [];
    const pinList = [].concat(o.pinPath == null ? [] : o.pinPath, arr(o.pins));
    for (const raw of pinList) {
      if (pins.length >= PIN_CAP) { break; }
      const path = stripSlash(raw);
      if (!path || path.length > PIN_PATH_MAX || pins.indexOf(path) !== -1) { continue; }
      pins.push(path);
    }
    if (pins.length) { body.pin = pins; }

    const callEx = cleanHashes(o.exclude) || [];
    const merged = prefs.persisted === true ? callEx : (cleanHashes([...(p.exclude || []), ...callEx]) || []);
    const ex = trimExclude(merged);
    if (ex.length) { body.exclude = ex; }

    // The saved 'new artists only' is the Explore page's toggle (and the
    // now-playing panel's): the play page draws no control for it, so it
    // never thins that page's connected-server rows unseen.
    body.newArtistsOnly = typeof o.newArtistsOnly === 'boolean' ? o.newArtistsOnly : (page === 'explore' && p.newArtistsOnly === true);

    if (Array.isArray(o.ignoreVPaths)) {
      body.ignoreVPaths = o.ignoreVPaths
        .filter((v) => typeof v === 'string' && v.length > 0 && v.length <= VPATH_MAX)
        .slice(0, IGNORE_VPATHS_CAP);
    }
    const limit = cleanLimits(o.limits);
    if (limit) { body.limit = limit; }

    const main = Object.assign({ sources: page === 'explore' ? ['network'] : ['library'] }, body);
    if (o.remember === true) { main.remember = true; }
    const peers = page === 'play' && flags.federationDiscovery === true ? Object.assign({ sources: ['peers'] }, body) : null;
    return { main, peers };
  }

  function cleanPage(v) { return PAGES.indexOf(v) !== -1 ? v : 'play'; }

  // A stable identity for a request body (key order and `remember` aside):
  // the page re-shows a kept answer only while the next request's key is the
  // same, and drops an answer whose key is no longer the latest.
  function stable(v) {
    if (Array.isArray(v)) { return '[' + v.map(stable).join(',') + ']'; }
    if (isObj(v)) { return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'; }
    return v === undefined ? 'null' : JSON.stringify(v);
  }
  function requestKey(body) {
    if (!isObj(body)) { return ''; }
    const rest = Object.assign({}, body);
    delete rest.remember;
    return stable(rest);
  }

  // The two answers as one response for the views below.
  //   main       the library (or, on explore, network) answer: undefined = in flight, null =
  //              failed, { disabled: true } = 403
  //   peersRes   the peers answer, same conventions
  //   peersAsked whether the peers call was made (buildRequests' `peers`)
  // → undefined / null / { disabled } passed through for main; otherwise the
  // main answer with `peers` = undefined (in flight) | null (not asked, not
  // available, refused) | the section — and `peersFailed: true` when that
  // call failed. A peers answer that lands first lends its seeds while the
  // library is still in flight (`library` / `network` undefined, `partial`).
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
      // dropped (remembered); the random pick has no × ("Another pick").
      action: s.pinned ? 'unpin' : (ctx.random ? null : 'drop'),
      label: artist ? lbl('dpage.seeds.chip', { title, artist }) : lbl('dpage.seeds.chipTitle', { title }),
      tag: tags[0] || null,
      tags,
      metadata: md,
    };
  }

  // The "Based on what you finished" strip: the first `max` chips and the
  // rest behind "Show all" (`more`; no count is drawn); `excluded` = the
  // dropped seeds the server still resolves, for the picker to bring back.
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

  // ── option lists (the bar's window, the filter checkbox, the plug-ins) ─

  function windowOptions(current) {
    const cur = cleanWindow(current);
    return WINDOWS.map((w) => ({
      value: w,
      label: w === 0 ? lbl('dpage.window.all') : lbl('dpage.window.days', { count: w }),
      selected: w === cur,
    }));
  }

  // The library filter as the one checkbox under More options:
  // "Include songs I've played lately". Ticked = 'all'; unticked = 'fresh'.
  function filterFor(includePlayed) { return includePlayed === true ? 'all' : 'fresh'; }
  function includesPlayed(filter) { return pageFilter(filter) === 'all'; }
  // → { checked, label, filter, next }: `filter` = the one on screen, `next`
  // = the one a click asks for (the library-empty button sends 'all').
  function includePlayedOption(current) {
    const checked = includesPlayed(current);
    return { checked, label: lbl('dpage.opt.includePlayed'), filter: filterFor(checked), next: filterFor(!checked) };
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

  // How strict a filter is: a stricter one can be applied to a looser
  // answer on the client (all → fresh) while the re-ask runs.
  const STRICTNESS = { all: 0, fresh: 1 };

  function isStale(lastPlayed, now, staleDays) {
    const t = toMs(lastPlayed);
    return Number.isFinite(t) && t < nowMs(now) - staleDays * DAY_MS;
  }
  // The server's §2.5 rule as far as a row can tell (skip counts and
  // ratings are not on the wire, so this only ever narrows a looser answer;
  // the server's own answer replaces it).
  function trackPasses(row, filter, now, staleDays) {
    if (filter === 'all') { return true; }
    if (!(row.playCount > 0)) { return true; }
    return filter === 'fresh' && isStale(row.lastPlayed, now, staleDays);
  }
  function albumPasses(card, filter, now, staleDays) {
    if (filter === 'all') { return true; }
    if (!(card.playedTracks > 0)) { return true; }
    return filter === 'fresh' && isStale(card.lastPlayed, now, staleDays);
  }

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

  // "Albums from your library" and "Songs from your library" (plan §2.6).
  //   opts.filter     the filter on screen ('fresh' | 'all'); when it is
  //                   stricter than the one the answer was chosen by (the
  //                   checkbox just unticked, the re-ask in flight) the rows
  //                   are narrowed here and `provisional` is set; a looser one
  //                   keeps the rows, also provisional
  //   opts.staleDays  the `fresh` cutoff for that narrowing (default 90)
  //   opts.now        "now" for that cutoff
  //   opts.maxAlbums / opts.maxTracks   caps (default: all); the song column
  //                   pages itself with pageSlice
  // → { filter, provisional, albums, tracks, count, capped, footer }
  //   footer.paths  what "Queue all · Shuffle · Save as playlist" act on
  //                 (every song row, the ones past maxTracks included);
  //                 footer.queueAllLabel = 'Queue all' (no count)
  function librarySections(response, opts) {
    const o = opts || {};
    const lib = isObj(response) && isObj(response.library) ? response.library : null;
    const answered = lib ? pageFilter(lib.filter) : undefined;
    const filter = pageFilter(o.filter) || answered || DEFAULT_PREFS.filter;
    const staleDays = cleanStaleDays(o.staleDays) || DEFAULT_PREFS.staleDays;
    const ctx = { seeds: seedIndex(response), random: isObj(response) && response.seedSource === 'random' };

    let albums = lib ? arr(lib.albums).filter(isObj).map((a) => albumCard(a, ctx)) : [];
    let tracks = lib ? arr(lib.tracks).filter((t) => isObj(t) && t.filepath).map((t) => trackRow(t, ctx)) : [];
    const provisional = !!answered && filter !== answered;
    if (provisional && STRICTNESS[filter] > STRICTNESS[answered]) {
      albums = albums.filter((a) => albumPasses(a, filter, o.now, staleDays));
      tracks = tracks.filter((t) => trackPasses(t, filter, o.now, staleDays));
    }

    const maxA = Number.isInteger(o.maxAlbums) && o.maxAlbums >= 0 ? o.maxAlbums : albums.length;
    const maxT = Number.isInteger(o.maxTracks) && o.maxTracks >= 0 ? o.maxTracks : tracks.length;
    return {
      filter,
      provisional,
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

  // A federation row's album art file, when the row carries one (read
  // through MSTREAMAPI.peerArtUrl(peerId, art, 's') — the
  // /api/v1/federation/peers/:id/art/ proxy); null = the note tile. The
  // taste route's rows carry none today; a responder that adds one is
  // picked up here without a client change.
  function peerArtOf(raw) {
    for (const k of ['art', 'albumArt', 'album-art', 'album_art_file']) {
      const v = raw[k];
      if (typeof v === 'string' && v && v.length <= PIN_PATH_MAX) { return v; }
    }
    return null;
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

  // "Albums from …": the playable rows grouped by peer + album + artist
  // (rows without an album tag are left out), best match first — an album
  // ranks by its best row — capped at opts.max (default ALBUM_STRIP_MAX).
  // → [{ key, peerId, peerName, album, artist, art, similarity, paths, raws }]
  //   paths / raws  the album's matched rows, best first: the card's play
  //                 button queues the raws through the federation stream
  //                 (VUEPLAYERCORE.queueDiscoverFed), paths = their
  //                 peer-side filepaths
  //   art           the first row's art that has one, else null (note tile)
  //   peerName      the card's tooltip
  function peerAlbums(groups, opts) {
    const o = opts || {};
    const max = Number.isInteger(o.max) && o.max >= 0 ? o.max : ALBUM_STRIP_MAX;
    const fold = (v) => str(v).trim().toLowerCase();
    const byKey = new Map();
    for (const r of peerSongRows(groups)) {
      const album = str(r.album).trim();
      if (!album) { continue; }
      const key = JSON.stringify([r.peerId, fold(album), fold(r.artist)]);
      let card = byKey.get(key);
      if (!card) {
        card = { key, peerId: r.peerId, peerName: r.peerName, album, artist: str(r.artist), art: null, similarity: r.similarity, paths: [], raws: [] };
        byKey.set(key, card);
      }
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
  // A cancelled job is over — the row is back to its verbs.
  const BADGE_RANK = { running: 0, queued: 1, failed: 2, done: 3 };
  function badgeOf(held, DJ) {
    let best = null;
    let bestSlot = null;
    for (const slot of Object.keys(held)) {
      const job = held[slot];
      if (!isObj(job) || !Object.prototype.hasOwnProperty.call(BADGE_RANK, job.state)) { continue; }
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

  function keysOf(found) {
    const out = [];
    if (found.key) { out.push(found.key); }
    if (isObj(found.keys)) {
      for (const k of Object.keys(found.keys)) { const v = found.keys[k]; if (v && out.indexOf(v) === -1) { out.push(v); } }
    }
    return out;
  }

  // Merge jobs onto rows → new rows with recKey, recKeys, jobs (by slot) and
  // badge (DJ.jobRowState of the job shown, plus slot / plugin / scope /
  // kind / jobId; null for none).
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
      next.badge = dj ? badgeOf(held, dj) : null;
      return next;
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
  //                   songs.'; `includePlayed: true` when the answer was
  //                   chosen by 'fresh' — the page offers the button that
  //                   ticks "Include songs I've played lately" and re-asks
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
      if (waiting) { return { status: 'empty', count: 0, reason: lbl('dpage.source.waitingForScan') }; }
      const filter = pageFilter(sec.filter) || opts.filter;
      return { status: 'empty', count: 0, reason: lbl('dpage.library.nothing'), includePlayed: filter !== 'all' };
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
  //   opts      { page, filter, staleDays } — page 'play' (default) draws
  //             library + peers (network absent); 'explore' draws network
  //             alone; filter for the library's empty line
  // → { state, reason, sources: { library, network, peers } }
  //   state     'off'             the ping does not advertise the page, or
  //                               the route said 403 (re-ping before
  //                               naming a reason)
  //             'loading'         no answer yet
  //             'failed'          the call failed (not a 403): try again
  //             'scanPending'     no seed is analyzed yet (seeds listed)
  //             'nothingFinished' a random seed stands in: nothing counted,
  //                               or every finished song was dropped
  //                               (reason dpage.state.allDropped)
  //             'ready'
  function stateOf(response, flags, opts) {
    const f = isObj(flags) ? flags : {};
    const o = Object.assign({ filter: DEFAULT_PREFS.filter, staleDays: DEFAULT_PREFS.staleDays }, opts || {});
    const so = { page: cleanPage(o.page), filter: pageFilter(o.filter) || DEFAULT_PREFS.filter };
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
    WINDOWS, FILTERS, PAGE_FILTERS, SOURCES, PAGES, DEFAULT_PREFS, STALE_DAYS_MIN, STALE_DAYS_MAX, PIN_CAP, EXCLUDE_CAP, HASH_MAX,
    LIMIT_DEFAULTS, LIMIT_CAPS, LOOKUP_BATCH_MAX, STORAGE_KEYS, CLIENT_TTL_MS, SEED_CHIPS_MAX, PAGE_SIZE, ALBUM_STRIP_MAX,
    defaultPrefs, cleanPrefs, mergePrefs, parseStoredPrefs, serializePrefs, dropSeed, restoreSeed,
    pageAvailable, buildRequests, requestKey, mergeResponses,
    fmtLength,
    seedChips, windowOptions, filterFor, includesPlayed, includePlayedOption, pluginChips,
    librarySections, networkRows,
    peerGroups, peerRowsOf, peerSongRows, peerAlbums, pageLabels, pageSlice, columnBlocks,
    lookupChunks, jobBadges, anyLiveBadge,
    stateOf,
  };
}));
