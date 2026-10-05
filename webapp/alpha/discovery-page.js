// The Discover page's pure half (docs/discovery-page-plan.md §4.1): the two
// request bodies the page sends to POST /api/v1/discovery/taste, and what
// the answer looks like on screen — the seed chips and the "based on …"
// line, the library's album cards and song rows, the network rows, the
// per-peer groups, the job badges on those rows, and which state the page
// (and each source) is in. No DOM, no Vue, no fetch, no storage — m.js
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

  // What the page keeps in localStorage (names only — the panel reads and
  // writes them, in try/catch). `newArtistsOnly` is the Discover panel's own
  // key: one semantic, one knob, shared (plan §3.2). `prefs` mirrors the
  // window / filter / staleDays (and, where the server cannot persist —
  // public-access mode — the dropped seeds) for the next visit; `source` is
  // the one-source-at-a-time choice of the focused view and the phone fold.
  const STORAGE_KEYS = Object.freeze({
    prefs: 'discoverPagePrefs',
    newArtistsOnly: 'discoverNewArtistsOnly',
    source: 'discoverPageSource',
  });
  // How long an answer may be shown again without asking (a revisit within
  // the server's own 5-minute section cache). Clients never poll.
  const CLIENT_TTL_MS = 5 * 60 * 1000;
  // Seed chips drawn before "+ n more" (the canvas: now playing + 6).
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
  function cleanFilter(v) { return FILTERS.indexOf(v) !== -1 ? v : undefined; }
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
    const f = cleanFilter(p.filter); if (f !== undefined) { out.filter = f; }
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

  // The page's two parallel calls (plan §3.1): library + network in one, so
  // the library renders without waiting on a peer's 4 s deadline, peers in
  // the other. Both carry the SAME seeds-shaping keys (window, pins,
  // exclusions, scope, limits) so they agree on the seeds and share the
  // server's section cache; only `sources` differs, and `remember` rides on
  // the first alone (one write).
  //   prefs          mergePrefs' answer (window / filter / staleDays / exclude /
  //                  newArtistsOnly / persisted)
  //   window, filter, staleDays, newArtistsOnly   this call's choice, over prefs
  //   pinPath        now playing (string; a leading '/' is stripped)
  //   pins           songs the user picked (paths), after pinPath; ≤ 8 in all
  //   exclude        hashes dropped in THIS call (a persisting server merges
  //                  its saved list itself; elsewhere prefs.exclude is sent too)
  //   remember       save window / filter / staleDays / exclusions
  //   ignoreVPaths   m.js localIgnoreVPaths()
  //   limits         { seeds, tracks, albums, network, peers }, clamped to the caps
  //   flags          { discovery, discoveryTaste, discoveryP2p, federationDiscovery }
  // → { main, peers }: main = { sources: ['library'(, 'network')], … }, peers
  // = { sources: ['peers'], … } or null; both null where the page is off.
  function buildRequests(opts) {
    const o = opts || {};
    const flags = o.flags || {};
    if (!pageAvailable(flags)) { return { main: null, peers: null }; }
    const prefs = isObj(o.prefs) ? o.prefs : {};
    const p = cleanPrefs(prefs);
    const either = (a, b) => (a !== undefined ? a : b);

    const body = {};
    const w = either(cleanWindow(o.window), p.window);
    if (w !== undefined) { body.window = w; }
    const f = either(cleanFilter(o.filter), p.filter);
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

    body.newArtistsOnly = typeof o.newArtistsOnly === 'boolean' ? o.newArtistsOnly : p.newArtistsOnly === true;

    if (Array.isArray(o.ignoreVPaths)) {
      body.ignoreVPaths = o.ignoreVPaths
        .filter((v) => typeof v === 'string' && v.length > 0 && v.length <= VPATH_MAX)
        .slice(0, IGNORE_VPATHS_CAP);
    }
    const limit = cleanLimits(o.limits);
    if (limit) { body.limit = limit; }

    const main = Object.assign({ sources: flags.discoveryP2p === true ? ['library', 'network'] : ['library'] }, body);
    if (o.remember === true) { main.remember = true; }
    const peers = flags.federationDiscovery === true ? Object.assign({ sources: ['peers'] }, body) : null;
    return { main, peers };
  }

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
  //   main       the library+network answer: undefined = in flight, null =
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

  // ── relative time ──────────────────────────────────────────────────────

  // { key, params } for "when": never · today · n days · n months · n years
  // ago. Families share the suffixes, so one rule draws every column:
  //   dpage.ago.*   the LAST PLAYED column and the seeds sheet ("8 months ago")
  //   dpage.when.*  a row's sub-line ("last played 8 months ago", "never played")
  //   dpage.seen.*  a peer that is not answering ("last seen 2 days ago")
  // Elapsed whole days, not calendar days: under 24 h is today; 1–29 days;
  // then months of 30 days, never "12 months" (330–364 days read 11); then
  // years of 365. A future time (clock skew) reads today.
  function agoLabel(iso, now, family) {
    const fam = family || 'dpage.ago';
    const t = toMs(iso);
    if (iso == null || iso === '' || !Number.isFinite(t)) { return lbl(fam + '.never'); }
    const days = Math.floor(Math.max(0, nowMs(now) - t) / DAY_MS);
    if (days < 1) { return lbl(fam + '.today'); }
    if (days < 30) { return lbl(fam + '.days', { count: days }); }
    if (days < 365) { return lbl(fam + '.months', { count: Math.min(11, Math.floor(days / 30)) }); }
    return lbl(fam + '.years', { count: Math.floor(days / 365) });
  }

  // A library row's play facts: never played, else when — and a play the
  // server holds no date for (a legacy counter) is "played before", never
  // "never".
  function playedWhen(playCount, lastPlayed, now, family) {
    const fam = family || 'dpage.when';
    if (!(Number(playCount) > 0)) { return lbl(fam + '.never'); }
    if (!Number.isFinite(toMs(lastPlayed))) { return lbl(fam + '.undated'); }
    return agoLabel(lastPlayed, now, fam);
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

  // "because you finished X" for a row whose seedHash names a seed; null
  // when the row is because of no single seed (peers rows: the centroid).
  function becauseOf(seedHash, seeds, random) {
    const s = seedHash ? seeds.get(seedHash) : null;
    if (!s) { return null; }
    const params = { title: seedTitle(s) };
    if (s.pinned) { return lbl('dpage.because.picked', params); }
    if (random) { return lbl('dpage.because.random', params); }
    if (s.outcome === 'completed') { return lbl('dpage.because.finished', params); }
    if (s.outcome === 'stopped') { return lbl('dpage.because.listened', params); }
    return lbl('dpage.because.played', params);
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
    // The seeds sheet's line: "today · played 3×", "yesterday · listened to".
    const detail = [];
    if (s.lastPlayed) { detail.push(agoLabel(s.lastPlayed, ctx.now, 'dpage.ago')); }
    if (!s.pinned && Number(s.plays) > 1) { detail.push(lbl('dpage.seeds.plays', { count: Number(s.plays) })); }
    if (s.outcome === 'stopped') { detail.push(lbl('dpage.seeds.listenedTo')); }
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
      detail,
      metadata: md,
    };
  }

  // The "Based on what you finished" strip: the first `max` chips and the
  // rest behind "+ n more"; `excluded` = the dropped seeds the server still
  // resolves, for the seeds sheet to bring back.
  //   opts.nowPlaying  the now-playing path (its pin reads "playing")
  //   opts.max         chips drawn before the overflow (default 7)
  function seedChips(response, opts) {
    const o = opts || {};
    const max = Number.isInteger(o.max) && o.max >= 0 ? o.max : SEED_CHIPS_MAX;
    const ctx = {
      random: isObj(response) && response.seedSource === 'random',
      nowPlaying: o.nowPlaying ? stripSlash(o.nowPlaying) : null,
      now: o.now,
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
      more: overflow ? lbl('dpage.seeds.more', { count: overflow }) : null,
      total: all.length,
      excluded,
    };
  }

  // The window as words: "last 30 days" / "all time".
  function windowLabel(window) {
    const w = cleanWindow(window);
    if (w === undefined) { return null; }
    return w === 0 ? lbl('dpage.window.all') : lbl('dpage.window.last', { count: w });
  }

  // The line under the page title ("based on 12 songs you finished · last
  // 30 days"). → { key, params } of the main phrase, plus `parts` = every
  // phrase of the line in order (the caller translates each and joins them
  // with ' · '). Null before there is an answer.
  //   history   dpage.seeds.finished (every history seed completed) or
  //             dpage.seeds.listened (some only mostly listened to), with
  //             the window; dpage.seeds.widened { count, from } when the
  //             window held nothing and the seeds come from all time
  //   counters  dpage.seeds.counters (play counts, not the log)
  //   pinned    dpage.seeds.pinned (only songs the user picked)
  //   random    dpage.seeds.random
  //   none      dpage.seeds.none (nothing at all to start from)
  // Pins next to history or counters add "+ n you picked".
  function seedsLine(response) {
    if (!isObj(response) || response.disabled === true) { return null; }
    const seeds = seedsOf(response);
    const pinned = seeds.filter((s) => s.pinned);
    const rest = seeds.filter((s) => !s.pinned);
    const src = response.seedSource;
    let main;
    let windowPart = null;
    if (src === 'random') {
      main = seeds.length ? lbl('dpage.seeds.random') : lbl('dpage.seeds.none');
    } else if (src === 'history' && rest.length) {
      const widened = cleanWindow(response.widenedFrom);
      if (widened !== undefined && widened !== 0) {
        main = lbl('dpage.seeds.widened', { count: rest.length, from: widened });
      } else {
        main = lbl(rest.some((s) => s.outcome === 'stopped') ? 'dpage.seeds.listened' : 'dpage.seeds.finished', { count: rest.length });
        windowPart = windowLabel(response.window);
      }
    } else if (src === 'counters' && rest.length) {
      main = lbl('dpage.seeds.counters', { count: rest.length });
    } else if (pinned.length) {
      main = lbl('dpage.seeds.pinned', { count: pinned.length });
    } else {
      main = lbl('dpage.seeds.none');
    }
    const parts = [main];
    if (pinned.length && main.key !== 'dpage.seeds.pinned' && src !== 'random') {
      parts.push(lbl('dpage.seeds.plusPicked', { count: pinned.length }));
    }
    if (windowPart) { parts.push(windowPart); }
    return { key: main.key, params: main.params, parts };
  }

  // ── option lists (the header dropdown, the filter chips, the plug-ins) ─

  function windowOptions(current) {
    const cur = cleanWindow(current);
    return WINDOWS.map((w) => ({
      value: w,
      label: w === 0 ? lbl('dpage.window.all') : lbl('dpage.window.days', { count: w }),
      selected: w === cur,
    }));
  }

  // The canvas order: Never played · Not in 90 days · Everything.
  function filterOptions(current, staleDays) {
    const cur = cleanFilter(current);
    const days = cleanStaleDays(staleDays) || DEFAULT_PREFS.staleDays;
    return [
      { value: 'unplayed', label: lbl('dpage.filter.unplayed'), selected: cur === 'unplayed' },
      { value: 'fresh', label: lbl('dpage.filter.fresh', { count: days }), selected: cur === 'fresh' },
      { value: 'all', label: lbl('dpage.filter.all'), selected: cur === 'all' },
    ];
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
  // answer on the client (all → fresh → unplayed) while the re-ask runs.
  const STRICTNESS = { all: 0, fresh: 1, unplayed: 2 };

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
      year: a.year == null ? null : a.year,
      albumArtFile: a.album_art_file || null,
      similarityPct: pct(a.similarity),
      seedHash: a.seedHash || null,
      because: becauseOf(a.seedHash, ctx.seeds, ctx.random),
      scopedTracks: scoped,
      playedTracks: played,
      lastPlayed: a.lastPlayed || null,
      // "never played · 11 songs" / "2 of 12 played"
      playedLabel: played === 0
        ? lbl('dpage.album.neverPlayed', { count: scoped })
        : lbl('dpage.album.somePlayed', { played, count: scoped }),
      lastPlayedLabel: played === 0 ? null : playedWhen(played, a.lastPlayed, ctx.now, 'dpage.when'),
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
      subtitle: joinParts([artist, album, genre]),
      similarityPct: pct(t.similarity),
      seedHash: t.seedHash || null,
      because: becauseOf(t.seedHash, ctx.seeds, ctx.random),
      playCount,
      lastPlayed: t.lastPlayed || null,
      // "never played" / "last played 8 months ago" (the row) and "never" /
      // "8 months ago" (the LAST PLAYED column)
      whenLabel: playedWhen(playCount, t.lastPlayed, ctx.now, 'dpage.when'),
      agoLabel: playedWhen(playCount, t.lastPlayed, ctx.now, 'dpage.ago'),
      length: fmtLength(md.duration),
      art: md['album-art'] || null,
      metadata: md,
    };
  }

  // The headings follow the filter the rows were chosen by.
  function libraryHeadings(filter) {
    return {
      sub: lbl(filter === 'all' ? 'dpage.library.subAll' : (filter === 'unplayed' ? 'dpage.library.subUnplayed' : 'dpage.library.subFresh')),
      albums: lbl(filter === 'all' ? 'dpage.library.albumsAll' : 'dpage.library.albums'),
      tracks: lbl(filter === 'all' ? 'dpage.library.songsAll' : (filter === 'unplayed' ? 'dpage.library.songsUnplayed' : 'dpage.library.songsFresh')),
    };
  }

  // "From your library": album cards first, then the songs (plan §2.6).
  //   opts.filter     the filter on screen; when it is stricter than the one
  //                   the answer was chosen by (a chip just tapped, the re-ask
  //                   in flight) the rows are narrowed here and `provisional`
  //                   is set; a looser one keeps the rows, also provisional
  //   opts.staleDays  the `fresh` cutoff for that narrowing (default 90)
  //   opts.maxAlbums / opts.maxTracks   the overview's share; the rest are
  //                   counted in footer.more ("13 more under See all")
  //   opts.now        for the relative times
  // → { filter, provisional, headings, albums, tracks, count, footer }
  //   footer.queueAll  the songs "+ Queue all n" queues (every song row, the
  //                    ones past maxTracks included); paths = theirs
  function librarySections(response, opts) {
    const o = opts || {};
    const lib = isObj(response) && isObj(response.library) ? response.library : null;
    const answered = lib ? cleanFilter(lib.filter) : undefined;
    const filter = cleanFilter(o.filter) || answered || DEFAULT_PREFS.filter;
    const staleDays = cleanStaleDays(o.staleDays) || DEFAULT_PREFS.staleDays;
    const ctx = { seeds: seedIndex(response), random: isObj(response) && response.seedSource === 'random', now: o.now };

    let albums = lib ? arr(lib.albums).filter(isObj).map((a) => albumCard(a, ctx)) : [];
    let tracks = lib ? arr(lib.tracks).filter((t) => isObj(t) && t.filepath).map((t) => trackRow(t, ctx)) : [];
    const provisional = !!answered && filter !== answered;
    if (provisional && STRICTNESS[filter] > STRICTNESS[answered]) {
      albums = albums.filter((a) => albumPasses(a, filter, o.now, staleDays));
      tracks = tracks.filter((t) => trackPasses(t, filter, o.now, staleDays));
    }

    const maxA = Number.isInteger(o.maxAlbums) && o.maxAlbums >= 0 ? o.maxAlbums : albums.length;
    const maxT = Number.isInteger(o.maxTracks) && o.maxTracks >= 0 ? o.maxTracks : tracks.length;
    const shownTracks = tracks.slice(0, maxT);
    const more = tracks.length - shownTracks.length;
    return {
      filter,
      provisional,
      headings: libraryHeadings(filter),
      albums: albums.slice(0, maxA),
      tracks: shownTracks,
      count: albums.length + tracks.length,
      capped: !!(lib && lib.capped === true),
      footer: {
        queueAll: tracks.length,
        queueAllLabel: lbl('dpage.verb.queueAll', { count: tracks.length }),
        paths: tracks.map((t) => t.filepath),
        more,
        moreLabel: more > 0 ? lbl('dpage.library.moreUnderSeeAll', { count: more }) : null,
        // "6 albums · 18 songs"
        summary: [lbl('dpage.count.albums', { count: albums.length }), lbl('dpage.count.songs', { count: tracks.length })],
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

  // ── peers ──────────────────────────────────────────────────────────────

  // "From your peers", one group per paired server, answering ones first
  // (then a model mismatch, then the ones that did not answer; otherwise the
  // server's order). A row keeps the federation lead RAW (`raw` →
  // VUEPLAYERCORE.queueDiscoverFed(raw) / openDiscoverModal(raw,
  // 'federation')); `playable` = its peer answered in this call.
  // → { groups, count, searched, line }; line = "2 of 3 peers answered"
  function peerGroups(response, opts) {
    const o = opts || {};
    const sec = isObj(response) && isObj(response.peers) ? response.peers : null;
    if (!sec) { return { groups: [], count: 0, searched: null, line: null }; }
    const rank = (g) => (g.playable ? 0 : (g.mismatched ? 1 : 2));
    const groups = arr(sec.peers).filter(isObj).map((g, order) => {
      const reachable = g.reachable === true;
      const mismatched = g.mismatched === true;
      const playable = reachable && !mismatched;
      const name = str(g.name);
      const rows = arr(g.results).filter(isObj).map((raw) => {
        const peer = isObj(raw.peer) ? raw.peer : {};
        return Object.assign({ raw, source: 'federation' }, leadFields(raw), {
          peerId: peer.id != null ? peer.id : (g.id != null ? g.id : null),
          peerName: str(peer.name) || name,
          filepath: str(raw.filepath),
          playable,
          // matched against the seeds' centroid, not one seed
          matchSeed: null,
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
        stateLabel: lbl(mismatched ? 'dpage.peers.mismatched' : (reachable ? 'dpage.peers.online' : 'dpage.peers.notAnswering')),
        lastSeenLabel: reachable ? null : agoLabel(g.lastSeen, o.now, 'dpage.seen'),
        countLabel: lbl('dpage.count.songs', { count: rows.length }),
        rows,
        order,
      };
    }).sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
    const s = isObj(sec.searched) ? sec.searched : {};
    const answered = toInt(s.peers) || 0;
    const unreachable = toInt(s.unreachable) || 0;
    const mismatched = toInt(s.mismatched) || 0;
    const total = answered + unreachable + mismatched;
    return {
      groups,
      count: groups.reduce((n, g) => n + g.rows.length, 0),
      searched: { peers: answered, unreachable, mismatched },
      line: lbl('dpage.peers.answered', { answered, count: total }),
    };
  }

  // Every row of the peers section, in group order ("Listen to all 5").
  function peerRowsOf(groups) {
    const out = [];
    for (const g of arr(groups)) { for (const r of arr(g.rows)) { out.push(r); } }
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

  function libraryEmptyReason(filter, staleDays) {
    if (filter === 'unplayed') { return lbl('dpage.library.allPlayed', { count: staleDays }); }
    if (filter === 'fresh') { return lbl('dpage.library.allPlayedFresh'); }
    return lbl('dpage.library.nothing');
  }

  // One source's state: absent (not drawn at all — the flag is off, or the
  // server answered null: not available here / a random seed), loading,
  // failed, empty (with the one dim line that explains it), ready.
  function sourceState(name, response, flags, opts) {
    const absent = { status: 'absent', reason: null, count: 0 };
    if (name === 'network' && flags.discoveryP2p !== true) { return absent; }
    if (name === 'peers' && flags.federationDiscovery !== true) { return absent; }
    if (response === undefined) { return { status: 'loading', reason: null, count: 0 }; }
    if (!isObj(response)) { return { status: 'failed', reason: lbl('dpage.source.failed'), count: 0 }; }
    if (name === 'peers' && response.peersFailed === true) { return { status: 'failed', reason: lbl('dpage.source.failed'), count: 0 }; }
    const sec = response[name];
    if (sec === undefined) { return { status: 'loading', reason: null, count: 0 }; }
    if (!isObj(sec)) { return absent; }
    const waiting = response.notAnalyzed === true;

    if (name === 'library') {
      const count = arr(sec.albums).length + arr(sec.tracks).length;
      if (count) { return { status: 'ready', reason: null, count }; }
      return { status: 'empty', count: 0, reason: waiting ? lbl('dpage.source.waitingForScan') : libraryEmptyReason(cleanFilter(sec.filter) || opts.filter, opts.staleDays) };
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
    const count = groups.reduce((n, g) => n + arr(g.results).length, 0);
    if (count) { return { status: 'ready', reason: null, count }; }
    if (waiting) { return { status: 'empty', count: 0, reason: lbl('dpage.source.waitingForScan') }; }
    if (groups.length === 0) { return { status: 'empty', count: 0, reason: lbl('dpage.peers.none') }; }
    const answered = groups.filter((g) => g.reachable === true && g.mismatched !== true).length;
    const mismatched = groups.filter((g) => g.mismatched === true).length;
    let reason = 'dpage.peers.nothingNew';
    if (answered === 0 && mismatched === 0) { reason = 'dpage.peers.unreachable'; }
    else if (answered === 0) { reason = 'dpage.peers.allMismatched'; }
    return { status: 'empty', count: 0, reason: lbl(reason) };
  }

  // Which page to draw, and each source's state.
  //   response  mergeResponses' answer: undefined = in flight, null = failed,
  //             { disabled: true } = 403
  //   flags     { discovery, discoveryTaste, discoveryP2p, federationDiscovery }
  //   opts      { filter, staleDays } — for the library's empty line
  // → { state, reason, sources: { library, network, peers }, tabs }
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
  //   tabs      the sources drawn, in order, with counts — the segmented
  //             switch of the focused view and the phone fold
  function stateOf(response, flags, opts) {
    const f = isObj(flags) ? flags : {};
    const o = Object.assign({ filter: DEFAULT_PREFS.filter, staleDays: DEFAULT_PREFS.staleDays }, opts || {});
    const staleDays = cleanStaleDays(o.staleDays) || DEFAULT_PREFS.staleDays;
    const so = { filter: cleanFilter(o.filter) || DEFAULT_PREFS.filter, staleDays };
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
    const tabs = SOURCES
      .filter((k) => sources[k].status !== 'absent')
      .map((k) => ({ key: k, label: lbl('dpage.tab.' + k), count: sources[k].count, status: sources[k].status }));
    return { state, reason, sources, tabs };
  }

  // The remembered focused source, when it is still drawn; else the first tab.
  function pickSource(remembered, tabs) {
    const list = arr(tabs);
    if (list.some((t) => t.key === remembered)) { return remembered; }
    return list.length ? list[0].key : 'library';
  }

  return {
    WINDOWS, FILTERS, SOURCES, DEFAULT_PREFS, STALE_DAYS_MIN, STALE_DAYS_MAX, PIN_CAP, EXCLUDE_CAP, HASH_MAX,
    LIMIT_DEFAULTS, LIMIT_CAPS, LOOKUP_BATCH_MAX, STORAGE_KEYS, CLIENT_TTL_MS, SEED_CHIPS_MAX,
    defaultPrefs, cleanPrefs, mergePrefs, parseStoredPrefs, serializePrefs, dropSeed, restoreSeed,
    pageAvailable, buildRequests, requestKey, mergeResponses,
    agoLabel, playedWhen, fmtLength,
    seedChips, seedsLine, windowLabel, windowOptions, filterOptions, pluginChips,
    librarySections, networkRows, peerGroups, peerRowsOf,
    lookupChunks, jobBadges, anyLiveBadge,
    stateOf, pickSource,
  };
}));
