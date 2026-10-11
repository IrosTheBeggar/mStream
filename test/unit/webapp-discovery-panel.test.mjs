/**
 * The Discover page's m.js half (docs/discovery-page-plan.md §4.1): the
 * panel that wires alpha/discovery-page.js (DISCOVERYPAGE) to the app.
 *
 * What is pinned (the play-now page, discoveryView.page 'play'):
 *   - opening the page fires the two parallel taste calls the plan names
 *     (library, peers) with the now-playing song pinned and the same limits,
 *     reads the saved prefs once, and draws "Albums from your library",
 *     "Albums from {server}", "Songs from your library" and "Songs from
 *     {server}" in that order — plain album cards, songs as art tile,
 *     title and "Artist · Album" — every value escaped;
 *   - none of the old busy-ness comes back in any state: no "matched by
 *     sound", no "never played", no count, no percentage, no meter, no
 *     when-label, no filter toggles, no phone tabs, no See all, no per-peer
 *     headers, no network section (assertTrimmed);
 *   - a connected server's row queues on click, as a library row does; its
 *     verbs are Play now / Add to queue / ⋯ (the peer window); its album
 *     card opens in the peer-browse view and its play button queues the
 *     album through the federation stream;
 *   - with no connected server there is no peers label, strip or column,
 *     and the library's songs flow column-major over both columns;
 *     federation on with nothing playable keeps the column and one line;
 *   - "Show more" appends 16 per column; the one filter is the "Include
 *     songs I've played lately" checkbox under More options ('fresh' ⇄
 *     'all', remembered), and the library-empty line's button ticks it;
 *   - the seed chips sit behind the gray bar's "More options" under that
 *     checkbox: the toggle flips its label and aria-expanded, stays as left
 *     across re-renders within a visit, and starts closed on a fresh open;
 *   - a random seed draws the "finish a few songs" card, and Another pick
 *     re-asks with that pick excluded (never remembered); dropping a seed
 *     re-asks with exclude + remember;
 *   - the bar's ⟳ is "New seeds": each press re-asks with the history seeds
 *     on screen added to a visit-only rotation in exclude (never
 *     remembered, never a pin, never drawn as dropped), the old answer
 *     drawn busy until the new one lands (a reset meanwhile never draws
 *     the passed-over seeds as dropped); a random, pins-only or
 *     not-analyzed answer ends the cycle and the next press starts from
 *     the newest; a window / filter / pin change, a drop or restore, a
 *     picked song, "new artists only", a page switch and a fresh open
 *     reset it; the keyboard stays on the cycled card's New seeds;
 *   - discoveryPanel({ page: 'explore' }) still asks the network alone and
 *     draws its list, its "new artists only" and its job badges (a poll
 *     tick patches only the badges that changed);
 *   - an answer that lands after the app moved on (browseGeneration bumped)
 *     is dropped; a 403 re-pings before naming a reason; a prefs GET that
 *     failed is asked again before a drop;
 *   - index.html carries the nav entry and the script, spa.css the
 *     container-query columns in the house palette, en.json every dpage.*
 *     key the module and the panel use (and no other).
 *
 * Clicks resolve against the DRAWN markup: click({ 'data-dp': 'lead' })
 * fails when no such element is on the page (a focusable one — button or
 * link — is preferred over a row).
 *
 * Same technique as webapp-album-cards.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals; DISCOVERYPAGE and
 * DISCOVERJOBS are the real modules.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const M_PATH = path.join(ROOT, 'webapp', 'alpha', 'm.js');
const SRC = fs.readFileSync(M_PATH, 'utf8');
const require = createRequire(import.meta.url);
const DISCOVERYPAGE = require('../../webapp/alpha/discovery-page.js');
const DISCOVERJOBS = require('../../webapp/alpha/discover-jobs.js');

function sliceFn(name) {
  const lines = SRC.split(/\r?\n/);
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) =>
    header(l).startsWith(`function ${name}(`) ||
    header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceConst(name) {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  if (lines[start].endsWith('};')) return lines[start];
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

const FNS = ['escapeHtml', 'peerAttr', 'artUrl', 'artImgAttr', 'renderAlbum', 'setBrowserRootPanel',
  'localIgnoreVPaths', 'applyDiscoveryPing', 'discoverySetEntry', 'discoveryAdoptPrefs', 'discoveryEnsurePrefs',
  'discoveryWatchJobs', 'discoveryMergeJobs', 'discoveryPatchBadges', 'discoveryLeadTag',
  'discoveryMatchOpts', 'discoveryDropSeed', 'discoveryT', 'discoveryText', 'discoveryOnScreen', 'discoveryNowPlayingPath',
  'discoveryLocalPrefs', 'discoverySaveLocalPrefs', 'discoveryPanel', 'redoDiscovery', 'discoveryOff',
  'discoveryResponse', 'discoveryLoadBadges', 'renderDiscovery', 'discoveryFocusedSelector', 'discoveryHeadHtml',
  'discoveryOptionsHtml', 'discoveryCheckHtml', 'discoveryCardHtml', 'discoverySeedsHtml', 'discoveryLabelHtml',
  'discoverySkelHtml', 'discoveryPlayHtml', 'discoveryStripHtml', 'discoveryPeerAlbumHtml', 'discoveryArtHtml',
  'discoverySongRowHtml', 'discoveryShowMoreHtml', 'discoveryColHintHtml', 'discoveryLibrarySongsHtml',
  'discoveryPeerSongsHtml', 'discoveryExploreHtml', 'discoverySectionHtml', 'discoveryEmptyHtml',
  'discoveryBadgeHtml', 'discoveryProgressHtml', 'discoveryNetworkHtml', 'onDiscoveryChange', 'onDiscoveryClick',
  'discoveryAction', 'discoveryOpenPeerAlbum', 'discoveryQueuePeerAlbum',
  'discoveryRestoreSeed', 'discoveryQueueAll', 'discoveryPick', 'discoveryRefocus', 'onDiscoveryKey',
  'discoveryFocusFallbacks'];

const KNOWN_IDS = ['filelist', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn', 'nav-discover'];

// t() echoes the key, with its params when there are any — so a test can
// see which label (and which count) was drawn.
const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);

const FLAGS_ALL = { discovery: true, discoveryTaste: 1, discoveryP2p: true, federationDiscovery: true, discoveryPlugins: false };

// The start tags of a drawn page, with their attributes (values decoded).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (v) => v.replace(/&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (e) => ENTITIES[e]);
function tagsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) { attrs[a[1]] = decode(a[2] ?? ''); }
    out.push({ tag: m[1].toLowerCase(), attrs });
  }
  return out;
}
// The drawn element matching every attr — a button or link first, or the
// one with tag `tag` (a row's own div).
function findDrawn(html, attrs, tag) {
  const hits = tagsOf(html).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === String(v)));
  if (tag) { return hits.find((el) => el.tag === tag) || null; }
  return hits.find((el) => el.tag === 'button' || el.tag === 'a') || hits[0] || null;
}
const countDrawn = (html, attrs) => tagsOf(html).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === String(v))).length;

// One stubbed app around the sliced functions.
//   taste(body)   answers MSTREAMAPI.discoveryTaste (a value or a promise)
//   prefs         GET …/taste/prefs's answer (a function: called per GET)
//   ping          MSTREAMAPI.ping's answer (the re-ping after a 403)
//   playing       MSTREAMPLAYER.getCurrentSong()
//   lookup(recs)  MSTREAMAPI.discoveryJobLookupBatch
//   jobs          VUEPLAYERCORE.discoverJobs() (the strip's last poll)
function makeSandbox({ taste, prefs = { window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: true }, ping = null, playing = null, flags = FLAGS_ALL, lookup = null, plugins = null, jobs = [], albumSongs = null } = {}) {
  const els = new Map();
  const pageHandlers = {};
  const patches = [];
  let renders = 0;
  // document.activeElement: the drawn control's attrs while one has focus
  const focus = { on: null };
  const classesOf = (initial) => {
    const classes = new Set(initial);
    return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  };
  for (const id of KNOWN_IDS) {
    let inner = '';
    const el = {
      value: '', scrollTop: 0, style: {},
      classList: classesOf(id === 'nav-discover' ? ['super-hide'] : []),
      // .dpage takes the delegated handlers; a badge / bar slot is there
      // when the drawn markup has it (its writes are recorded)
      querySelector: (sel) => {
        if (sel === '.dpage') { return { addEventListener: (type, fn) => { pageHandlers[type] = fn; } }; }
        const m = sel.match(/^\[(data-[bp]slot)="([^"]+)"\]$/);
        if (m && inner.includes(`${m[1]}="${m[2]}"`)) {
          return { set innerHTML(h) { patches.push({ slot: m[1], id: m[2], html: h }); } };
        }
        return null;
      },
    };
    // a whole-page draw drops the keyboard's control, as the DOM does
    Object.defineProperty(el, 'innerHTML', { get: () => inner, set: (h) => { inner = h; if (id === 'filelist') { renders++; focus.on = null; } } });
    els.set(id, el);
  }
  const bodyClasses = classesOf(['has-discover-page']);
  const watchers = [];
  let currentJobs = jobs;
  const calls = [];
  const storage = new Map();
  const queued = [];
  const opened = [];
  const fedQueued = [];
  const toasts = [];
  const views = [];
  // the peer-browse hand-off and the album queue (m.js's own helpers)
  const adopted = [];
  const albumsOpened = [];
  const rowsQueued = [];
  const knownPeers = new Map();
  // focus() calls on a drawn data-dp control after a re-render, in order
  const focused = [];
  const globals = {
    document: {
      body: { classList: bodyClasses },
      getElementById: (id) => els.get(id) ?? null,
      getElementsByClassName: () => [],
      get activeElement() {
        const a = focus.on;
        return a ? { closest: () => ({}), getAttribute: (n) => (n in a ? a[n] : null) } : null;
      },
      // `#filelist .dpage [data-dp="x"][data-i="3"]…`: a DRAWN control
      querySelector: (sel) => {
        const m = sel.match(/^#filelist \.dpage ((?:\[[a-z-]+="[^"]*"\])+)$/);
        if (!m) { return null; }
        const attrs = Object.fromEntries([...m[1].matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].map((x) => [x[1], x[2]]));
        const found = findDrawn(els.get('filelist').innerHTML, attrs);
        if (!found || !attrs['data-dp']) { return null; }
        return { focus: () => { focused.push(attrs['data-dp']); focus.on = found.attrs; } };
      },
    },
    window: {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    },
    MSTREAMAPI: {
      currentServer: { host: 'http://host/', token: 'TOK', admin: false },
      discoveryTaste: (body) => { calls.push({ name: 'taste', body }); return Promise.resolve(taste(body)); },
      discoveryTastePrefs: () => { calls.push({ name: 'prefs' }); return Promise.resolve(typeof prefs === 'function' ? prefs() : prefs); },
      ping: () => { calls.push({ name: 'ping' }); return ping ? Promise.resolve(ping) : Promise.reject(new Error('no ping')); },
      discoveryTastePrefsSave: (patch) => { calls.push({ name: 'prefsSave', body: patch }); return Promise.resolve({ ...prefs, ...patch }); },
      discoveryJobLookupBatch: (recs) => { calls.push({ name: 'lookup', body: recs }); return lookup ? Promise.resolve(lookup(recs)) : Promise.reject(new Error('no lookup')); },
      peerArtUrl: (id, art, compress) => `http://host/peer/${id}/art/${art}?c=${compress}`,
      peer: {
        albumSongs: (id, body) => { calls.push({ name: 'peerAlbumSongs', id, body }); return albumSongs ? Promise.resolve(albumSongs(id, body)) : Promise.reject(new Error('no album')); },
      },
    },
    MSTREAMPLAYER: { ignoreVPaths: {}, positionCache: { val: 2 }, getCurrentSong: () => playing },
    VUEPLAYERCORE: {
      altLayout: { compressArt: false },
      songCapture: null,
      addSongWizard: (...args) => { queued.push(args); },
      addFederationSongWizard: (...args) => { fedQueued.push(['play', ...args]); },
      queueDiscoverFed: (raw) => { fedQueued.push(['queue', raw]); },
      openDiscoverModal: (raw, source, opts) => { opened.push({ raw, source, opts }); return Promise.resolve(); },
      ensureDiscoverPlugins: () => Promise.resolve(plugins || { available: false, list: [], jobsAllowed: false }),
      discoverJobs: () => currentJobs.slice(),
      watchDiscoverJobs: (fn) => {
        const w = { fn, live: true };
        watchers.push(w);
        return () => { w.live = false; };
      },
      refreshDiscoverJobs: () => Promise.resolve([]),
    },
    DISCOVERYPAGE,
    DISCOVERJOBS,
    iziToast: { success: (o) => toasts.push(o), warning: (o) => toasts.push(o), error: (o) => toasts.push({ ...o, error: true }), show: (o) => toasts.push(o) },
    t: tStub,
    getLoadingSvg: () => 'LOADING',
    sonicPathHideBanner: () => {},
    switchServer: () => { throw new Error('switchServer should not run on the local server'); },
    changeView: (fn) => { views.push(fn); },
    showPickBanner: () => {},
    createPopper3: () => {},
    myModal: { open() {}, close() {} },
    openSavePlaylistModal: () => {},
    loadFileExplorer: () => {},
    knownPeers,
    rememberPeer: (peer) => { knownPeers.set(Number(peer.id), { id: Number(peer.id), name: peer.name || 'peer' }); return peer; },
    adoptPeer: (el) => { adopted.push(el.getAttribute('data-peer')); },
    getAlbumSongs: (...args) => { albumsOpened.push(args); },
    queueRow: (...args) => { rowsQueued.push(args); },
    applyServerContext: () => {},
    highlightNavPanel: () => {},
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let peerContext = null;
    let browseGeneration = 0;
    let fileExplorerArray = [];
    ${sliceConst('entityMap')}
    ${sliceConst('DPAGE_LIMITS')}
    ${sliceConst('discoveryView')}
    ${sliceConst('DPAGE_ICONS')}
    discoveryView.flags = ${JSON.stringify(flags)};
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      view: discoveryView,
      html: () => __els.get('filelist').innerHTML,
      state: () => programState,
      setState: (s) => { programState = s; },
      bump: () => { browseGeneration++; },
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));
  // Click a DRAWN data-dp element (it must be on the page): the delegated
  // handler sees a target whose closest('[data-dp]') is it.
  const click = (attrs, tag) => {
    const found = findDrawn(S.html(), attrs, tag);
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    const el = { tagName: found.tag.toUpperCase(), getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) };
    pageHandlers.click({ target: { closest: () => el } });
  };
  // The keyboard on a drawn control: focus it, then click it (Enter / Space).
  const keyClick = (attrs, tag) => {
    const found = findDrawn(S.html(), attrs, tag);
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    focus.on = found.attrs;
    click(attrs, tag);
  };
  // A keydown on a drawn element (its class list from the markup).
  const keydown = (attrs, key) => {
    const found = findDrawn(S.html(), attrs, 'div');
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    const cls = String(found.attrs.class || '').split(/\s+/);
    let prevented = false;
    pageHandlers.keydown({ key, preventDefault: () => { prevented = true; },
      target: { classList: { contains: (c) => cls.includes(c) }, getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) } });
    return prevented;
  };
  const activeAttrs = () => focus.on;
  const change = (attrs, value) => {
    const found = findDrawn(S.html(), attrs);
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    pageHandlers.change({ target: { value, getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) } });
  };
  // A poll of the strip's job list: every live watch hears it.
  const tick = (list) => { currentJobs = list; for (const w of watchers.slice()) { if (w.live) { w.fn(list.slice()); } } };
  const liveWatches = () => watchers.filter((w) => w.live).length;
  return { S, keyClick, keydown, activeAttrs, views, focused, vpc: globals.VUEPLAYERCORE, calls, storage, queued, opened, fedQueued, toasts, els, click, change, tick, liveWatches, watchers, patches, renders: () => renders, bodyClasses, adopted, albumsOpened, rowsQueued, knownPeers };
}

// The seed picker: open it from the bar ("More options").
const openOptions = (click) => click({ 'data-dp': 'options' });
// The markup of one drawn region (its opening tag up to the next region).
const seedsSection = (html) => { const i = html.indexOf('<section class="dpage-seeds"'); return i === -1 ? '' : html.slice(i, html.indexOf('</section>', i)); };

// The page's own loading state: aria-busy on the .dpage root.
const PAGE_BUSY = /<div class="dpage [^"]*" aria-busy="true">/;
const tasteCalls = (calls) => calls.filter((c) => c.name === 'taste').map((c) => c.body);
const flush = () => new Promise((r) => setImmediate(r));

// ── fixtures (the server's shapes: src/api/discovery-taste.js) ──────────

const SEEDS = [
  { hash: 'h-np', filepath: 'music/Now/Playing.flac', metadata: { title: 'Now Song', artist: 'Now Artist' }, outcome: null, lastPlayed: null, plays: 0, pinned: true, analyzed: true },
  { hash: 'h1', filepath: 'music/A/One.flac', metadata: { title: 'Seed <One>', artist: 'Ann' }, outcome: 'completed', lastPlayed: '2026-10-04T21:10:00.000Z', plays: 3, pinned: false, analyzed: true },
  { hash: 'h2', filepath: 'music/B/Two.flac', metadata: { title: 'Seed Two', artist: 'Bob' }, outcome: 'completed', lastPlayed: '2026-10-03T21:10:00.000Z', plays: 1, pinned: false, analyzed: true },
];

const libTrack = (i, extra = {}) => ({ filepath: `music/X/${i}.flac`, similarity: 0.7, seedHash: 'h1', metadata: { title: `Many ${i}`, artist: 'Max' }, playCount: 0, lastPlayed: null, ...extra });

const MAIN = {
  window: 30, widenedFrom: null, seedSource: 'history', fallback: false,
  seeds: SEEDS, excluded: [], dropped: 0, notAnalyzed: false,
  model: { id: 'test-fake', version: '1' },
  library: {
    filter: 'fresh',
    albums: [
      { name: 'Album <One>', year: 2019, album_art_file: 'a1.jpg', album_artist: 'Fay', artists: ['Fay'], similarity: 0.84, seedHash: 'h1', scopedTracks: 11, playedTracks: 0, lastPlayed: null, tracks: ['music/F/1.flac'] },
    ],
    tracks: [
      { filepath: 'music/J/Seven.flac', similarity: 0.83, seedHash: 'h1', metadata: { title: 'Title Seven', artist: 'Jay', album: 'Album Seven', duration: 200, 'album-art': 'a7.jpg' }, genreTags: ['Electronic---Synthwave'], playCount: 0, lastPlayed: null },
      { filepath: 'music/K/Eight.flac', similarity: 0.8, seedHash: 'h2', metadata: { title: 'Title Eight', artist: 'Kay' }, genreTags: [], playCount: 2, lastPlayed: '2026-02-01T00:00:00.000Z' },
    ],
    capped: false,
  },
  network: {
    results: [
      { source: 'p2p', seedHash: 'h1', peer: { endpointId: 'ep1', name: 'Far <Server>' }, exportId: 'x1', title: 'Lead One', artist: 'Mo', album: 'Lead Album', year: 2020, duration: 180, similarity: 0.86 },
    ],
    searched: { peers: 3, tracks: 7421 },
  },
  peers: null,
};

const PEER_ROW = { source: 'federation', seedHash: null, peer: { id: 1, name: 'Sam\'s server' }, filepath: 'tunes/P/One.mp3', title: 'Peer Song', artist: 'Quinn', album: 'Peer Album', duration: 210, similarity: 0.85, art: 'pa.jpg' };
const PEERS = {
  ...MAIN, library: null, network: null,
  peers: {
    peers: [
      { id: 1, name: 'Sam\'s server', reachable: true, mismatched: false, lastSeen: '2026-10-05T00:00:00.000Z',
        results: [PEER_ROW, { ...PEER_ROW, filepath: 'tunes/P/Two.mp3', title: 'Peer Two', album: '', art: undefined, similarity: 0.6 }] },
      { id: 2, name: 'Peer <B>', reachable: false, mismatched: false, lastSeen: '2026-10-03T00:00:00.000Z', results: [{ ...PEER_ROW, peer: { id: 2, name: 'Peer <B>' }, title: 'Offline Song' }] },
    ],
    searched: { peers: 1, unreachable: 1, mismatched: 0 },
  },
};

const answer = (body) => (body.sources.includes('peers') ? PEERS : MAIN);
const PLAYING = { rawFilePath: '/music/Now/Playing.flac', metadata: { title: 'Now Song' } };
const NO_FED = { ...FLAGS_ALL, federationDiscovery: false };

// What the play page never draws again (the user found it too busy).
const GONE = [
  'dpage.subtitle', 'dpage.matchedBySound', 'dpage-tagline', 'dpage.album.', 'dpage-album-badge', 'dpage-album-w',
  'dpage.when.', 'dpage.ago.', 'dpage.seen.', 'dpage-when', 'discover-match', 'dpage.count.', 'dpage-count',
  'dpage.filter.', 'data-dp="filter"', 'dpage-seg', 'dpage.tab.', 'data-dp="source"', 'data-dp="focus"', 'dpage.seeAll',
  'data-dp="back"', 'dpage.back', 'dpage-peer"', 'dpage-peer-dot', 'dpage.peers.answered', 'dpage.peers.footer',
  'dpage.peers.none', 'dpage.peers.playsWhenBack', 'dpage-plugins', 'data-dp="newArtists"', 'dpage-sec-network',
  'dpage.network.', 'data-dp="lead"', 'dpage.library.title', 'dpage.library.sub', 'dpage.library.moreUnderSeeAll',
  'dpage.verb.listen', 'dpage.verb.moreKeepCopy', 'dpage.seeds.finished', 'dpage.seeds.skipsLeftOut', 'dpage.seeds.clickToDrop',
  'album-grid-year', 'Offline Song', 'Electronic', '&quot;count&quot;', 'dpage.state.loading',
];
function assertTrimmed(page, label) {
  // the window select's options ("Last 30 days") are a choice, not a count
  const html = page.replace(/<select[\s\S]*?<\/select>/g, '');
  for (const g of GONE) { assert.ok(!html.includes(g), `${label}: no ${g}`); }
  assert.ok(!/\d\s*%/.test(html), `${label}: no percentage`);
}

describe('Discover page: opening it', () => {
  test('two parallel taste calls — the library and the connected servers — with now playing pinned, prefs read once', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    assert.deepEqual(S.state(), [{ state: 'discovery' }]);
    assert.equal(S.view.page, 'play');
    assert.equal(calls.filter((c) => c.name === 'prefs').length, 1);
    const [main, peers] = tasteCalls(calls);
    assert.deepEqual(main.sources, ['library'], 'the network is the Explore page\'s');
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['music/Now/Playing.flac'], 'the leading / is stripped');
    assert.deepEqual(peers.pin, main.pin, 'both calls agree on the seeds');
    // peers is per server, at its cap: one server fills the first 16 rows
    // and a "Show more" (the server's default of 12 could not)
    assert.deepEqual(main.limit, { albums: 12, tracks: 48, peers: 25 }, 'the strip\'s share and three pages of songs');
    assert.deepEqual(peers.limit, main.limit);
    assert.equal(peers.newArtistsOnly, false, 'the play page sends no hidden "new artists only"');
    assert.equal(main.window, 30);
    assert.equal(main.filter, 'fresh');
    assert.equal(main.remember, undefined, 'opening the page saves nothing');
  });

  test('a federated now-playing song is never pinned', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: { rawFilePath: 'x/y.mp3', federation: { peerId: 1 } } });
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls)[0].pin, undefined);
  });

  test('draws the two album strips and the two song columns, labelled, in order', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    const at = (x) => html.indexOf(x);
    const peerName = 'Sam&#39;s server';
    const labels = [
      'dpage.albums.library',
      `dpage.albums.peerOne{&quot;name&quot;:&quot;${peerName}&quot;}`,
      'dpage.songs.library',
      `dpage.songs.peerOne{&quot;name&quot;:&quot;${peerName}&quot;}`,
    ];
    for (const l of labels) { assert.ok(at(l) > 0, l); }
    assert.ok(labels.every((l, i) => i === 0 || at(l) > at(labels[i - 1])), 'library albums, connected albums, library songs, connected songs');
    assert.match(html, /<h3 class="dpage-label"><span class="dpage-dot" aria-hidden="true"><\/span>dpage\.albums\.library<\/h3>/);
    assert.match(html, /class="dpage-strip dpage-src-library"[\s\S]*class="dpage-strip dpage-src-peers"/);
    assert.match(html, /<div class="dpage-songs"><section class="dpage-col dpage-src-library"[\s\S]*<section class="dpage-col dpage-src-peers"/);
    // the library album: renderAlbum's plain card — art, title, artist
    assert.match(html, /class="album-grid-card"[^>]*data-year="2019"[^>]*data-album-artist="Fay"[^>]*data-album="Album &lt;One&gt;"/,
      'the year rides on the card (the click narrows by it), not on its face');
    assert.ok(!html.includes('album-grid-year'));
    assert.match(html, /title="dpage\.because\{&quot;title&quot;:&quot;Seed &lt;One&gt;&quot;\}"><div class="album-grid-card"/, 'the because is a tooltip');
    // the connected server's album: built from its playable rows
    const card = findDrawn(html, { 'data-dp': 'peerAlbumOpen', 'data-i': 0 });
    assert.equal(card.attrs['data-peer'], '1');
    assert.equal(card.attrs['data-album'], 'Peer Album');
    assert.equal(card.attrs['data-artist'], 'Quinn');
    assert.equal(card.attrs.tabindex, '0', 'the keyboard reaches the card');
    assert.equal(card.attrs.role, 'link');
    assert.equal(card.attrs['aria-label'], 'Peer Album · Quinn');
    assert.match(html, /<img loading="lazy" src="http:&#x2F;&#x2F;host&#x2F;peer&#x2F;1&#x2F;art&#x2F;pa.jpg\?c&#x3D;undefined" alt="">/);
    assert.equal(countDrawn(html, { 'data-dp': 'peerAlbumOpen' }), 1, 'the album-less row makes no card');
    // the songs: art tile, title, "Artist · Album"
    assert.ok(html.includes('Title Seven') && html.includes('Title Eight'));
    assert.match(html, /<span class="dpage-art"><img loading="lazy" src="http:\/\/host\/album-art\/a7.jpg\?compress=s&token=TOK" alt=""><\/span>/);
    assert.match(html, /<span class="dpage-art dpage-art-ph">/, 'no art: the note tile');
    assert.ok(html.includes('Jay · Album Seven'));
    assert.ok(html.includes('Quinn · Peer Album'));
    assert.match(html, /<span class="dpage-art"><img loading="lazy" src="http:&#x2F;&#x2F;host&#x2F;peer&#x2F;1&#x2F;art&#x2F;pa.jpg\?c&#x3D;s" alt=""><\/span>/);
    // the connected column is one flat list of the playable rows
    assert.ok(html.includes('Peer Two'));
    assert.ok(!html.includes('Offline Song'), 'an offline server\'s rows are not shown');
    assert.ok(!html.includes('Peer &lt;B&gt;'), 'no per-server headers');
    assert.equal(findDrawn(html, { 'data-dp': 'fedQueue', 'data-i': 0 }, 'div').attrs.title, 'Sam\'s server', 'a centroid match: the server alone');
    // footers
    assert.ok(html.indexOf('data-dp="queueAll"') < html.indexOf('dpage-src-peers" data-source'), 'Queue all under the library column');
    for (const f of ['shuffle', 'save', 'peerQueueAll']) { assert.ok(findDrawn(html, { 'data-dp': f }), f); }
    assert.match(html, /data-dp="queueAll">dpage\.verb\.queueAll</);
    assert.match(html, /data-dp="peerQueueAll">dpage\.verb\.queueAll</);
    assertTrimmed(html, 'ready');
  });

  test('row verbs: library play / queue / ⋯; a connected row plays now / queues / ⋯ opens the peer window', async () => {
    const { S, click, queued, opened, fedQueued } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    click({ 'data-dp': 'queue', 'data-i': 0 });
    assert.deepEqual(queued[0].slice(0, 2), ['music/J/Seven.flac', MAIN.library.tracks[0].metadata]);
    click({ 'data-dp': 'play', 'data-i': 1 });
    assert.equal(queued[1][0], 'music/K/Eight.flac');
    assert.equal(queued[1][3], 3, 'play now = right after the playing song');
    click({ 'data-dp': 'peerPlay', 'data-i': 0 });
    assert.equal(fedQueued[0][0], 'play');
    assert.deepEqual(fedQueued[0][1], { id: 1, name: 'Sam\'s server' });
    assert.equal(fedQueued[0][2], 'tunes/P/One.mp3');
    assert.equal(fedQueued[0][5], 3, 'right after the playing song');
    click({ 'data-dp': 'fedQueue', 'data-i': 1 });
    assert.deepEqual(fedQueued[1], ['queue', PEERS.peers.peers[0].results[1]], 'the route\'s own row, through the federation stream');
    click({ 'data-dp': 'peerMore', 'data-i': 0 });
    assert.equal(opened[0].source, 'federation');
    assert.equal(opened[0].raw, PEER_ROW);
    assert.deepEqual(opened[0].opts, { seedPlain: 'dpage.match.recent' }, 'a connected row was matched against the centroid');
  });

  test('a click on a connected server\'s row queues it, exactly as a library row does', async () => {
    const { S, click, queued, opened, fedQueued, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    const libRow = findDrawn(html, { 'data-dp': 'queue', 'data-i': 0 }, 'div');
    const peerRow = findDrawn(html, { 'data-dp': 'fedQueue', 'data-i': 0 }, 'div');
    assert.ok(libRow && peerRow, 'both rows are click targets');
    assert.equal(peerRow.attrs.class, libRow.attrs.class, 'the same row');
    assert.equal(peerRow.attrs.title, 'Sam\'s server', 'the server names itself in the tooltip');
    click({ 'data-dp': 'fedQueue', 'data-i': 0 }, 'div');
    assert.deepEqual(fedQueued, [['queue', PEER_ROW]]);
    assert.equal(opened.length, 0, 'the window is the ⋯\'s, not the row\'s');
    click({ 'data-dp': 'queue', 'data-i': 0 }, 'div');
    assert.equal(queued.length, 1);
    assert.equal(toasts.filter((o) => o.title === 'discover.modal.queued').length, 2);
  });

  test('every row verb is a labelled button; the two columns\' verbs line up (same icons, same labels)', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    const lib = ['play', 'queue', 'more'].map((dp) => findDrawn(html, { 'data-dp': dp, 'data-i': 0 }));
    const peer = ['peerPlay', 'fedQueue', 'peerMore'].map((dp) => findDrawn(html, { 'data-dp': dp, 'data-i': 0 }));
    for (const el of [...lib, ...peer]) {
      assert.equal(el.tag, 'button');
      assert.ok(el.attrs['aria-label'] && el.attrs.title, `${el.attrs['data-dp']} is labelled`);
    }
    assert.deepEqual(lib.map((el) => el.attrs.title), ['dpage.verb.playNow', 'dpage.verb.queue', 'dpage.verb.addToPlaylist']);
    assert.deepEqual(peer.map((el) => el.attrs.title), ['dpage.verb.playNow', 'dpage.verb.queue', 'dpage.verb.more']);
    assert.equal(lib[2].attrs['data-file_location'], 'music/J/Seven.flac');
  });

  test('a connected server\'s album: the card opens it in the peer-browse view, its play button queues it', async () => {
    const songs = [{ filepath: 'tunes/P/One.mp3', metadata: { title: 'Peer Song' } }, { filepath: 'tunes/P/Three.mp3', metadata: { title: 'Three' } }];
    const { S, click, adopted, albumsOpened, rowsQueued, calls, knownPeers, fedQueued } = makeSandbox({ taste: answer, albumSongs: () => songs });
    await S.discoveryPanel();
    assert.deepEqual(knownPeers.get(1), { id: 1, name: 'Sam\'s server' }, 'the queue rows can name the server');
    click({ 'data-dp': 'peerAlbumOpen', 'data-i': 0 });
    assert.deepEqual(adopted, ['1'], 'the app follows the card onto that server');
    assert.deepEqual(albumsOpened, [['Peer Album', 'Quinn', null, null]]);
    click({ 'data-dp': 'peerAlbum', 'data-i': 0 });
    await flush(); await flush();
    assert.deepEqual(calls.filter((c) => c.name === 'peerAlbumSongs').map((c) => [c.id, c.body]), [[1, { album: 'Peer Album', artist: 'Quinn' }]]);
    assert.deepEqual(rowsQueued.map((r) => [r[0].id, r[1]]), [[1, 'tunes/P/One.mp3'], [1, 'tunes/P/Three.mp3']], 'the whole album, through the federation stream');
    assert.equal(adopted.length, 1, 'queueing leaves the app on this server');
    assert.equal(fedQueued.length, 0);
  });

  test('a connected album card: Enter opens it (the keyboard reaches it); a card with no art draws the note tile', async () => {
    const noArt = { ...PEER_ROW, filepath: 'tunes/P/Other.mp3', title: 'Other', album: 'Bare Album', art: undefined, similarity: 0.7 };
    const peers = { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: [PEER_ROW, noArt] }] } };
    const { S, keydown, adopted, albumsOpened } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? peers : MAIN) });
    await S.discoveryPanel();
    const html = S.html();
    const strip = html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
    assert.equal(countDrawn(strip, { 'data-dp': 'peerAlbumOpen' }), 2);
    const bare = strip.slice(strip.indexOf('data-album="Bare Album"'));
    assert.match(bare, /^[^]*?<div class="album-grid-art">\s*<svg[^>]*viewBox="0 0 24 24"/, 'no art: the note tile');
    assert.equal(keydown({ 'data-dp': 'peerAlbumOpen', 'data-i': 1 }, 'a'), false, 'another key does nothing');
    assert.deepEqual(adopted, []);
    assert.equal(keydown({ 'data-dp': 'peerAlbumOpen', 'data-i': 1 }, 'Enter'), true);
    assert.deepEqual(adopted, ['1']);
    assert.deepEqual(albumsOpened, [['Bare Album', 'Quinn', null, null]]);
  });

  test('a connected album the server cannot list: its play button queues the rows that matched', async () => {
    const { S, click, fedQueued } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
    click({ 'data-dp': 'peerAlbum', 'data-i': 0 });
    await flush(); await flush();
    assert.deepEqual(fedQueued, [['queue', PEER_ROW]]);
  });

  test('Queue all under the connected column queues every playable row', async () => {
    const { S, click, fedQueued } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
    click({ 'data-dp': 'peerQueueAll' });
    assert.deepEqual(fedQueued.map((f) => f[1].filepath), ['tunes/P/One.mp3', 'tunes/P/Two.mp3'], 'best match first, the offline server\'s left out');
  });

  test('off: the ping has no page — one line, no request', async () => {
    const { S, calls } = makeSandbox({ taste: answer, flags: { ...FLAGS_ALL, discoveryTaste: 0 } });
    await S.discoveryPanel();
    assert.equal(calls.length, 0);
    assert.match(S.html(), /dpage-off[\s\S]*dpage\.state\.off/);
  });

  test('a 403 retracts the nav entry and the panel\'s link, re-pings, and says off when the ping agrees', async () => {
    const { S, els, calls, bodyClasses } = makeSandbox({ taste: () => ({ disabled: true }), ping: { discovery: false, discoveryTaste: 1 } });
    els.get('nav-discover').classList.remove('super-hide');
    await S.discoveryPanel();
    await flush();
    assert.equal(calls.filter((c) => c.name === 'ping').length, 1, 'one re-ping for the two 403s');
    assert.match(S.html(), /dpage\.state\.off/);
    assert.ok(els.get('nav-discover').classList.contains('super-hide'));
    assert.ok(!bodyClasses.contains('has-discover-page'), '"Discover page →" goes too');
  });

  test('a 403 while the ping still has the page: not available for this account (no admin copy)', async () => {
    const { S } = makeSandbox({ taste: () => ({ disabled: true }), ping: { discovery: true, discoveryTaste: 1 } });
    await S.discoveryPanel();
    await flush();
    assert.match(S.html(), /dpage\.state\.unavailable/);
    assert.ok(!S.html().includes('dpage.state.off'));
  });

  test('a 403 with no ping answer says off', async () => {
    const { S } = makeSandbox({ taste: () => ({ disabled: true }) });
    await S.discoveryPanel();
    await flush();
    assert.match(S.html(), /dpage\.state\.offBody/);
  });

  test('first open draws skeleton strips and rows — no spinner, no "asking" line', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    const html = S.html();
    assert.match(html, /<div class="dpage dpage-page-play[^"]*" aria-busy="true">/);
    assert.match(html, /dpage-bar[\s\S]*dpage-skel-card/);
    assert.equal(html.split('dpage-skel-card').length - 1, 8, 'four tiles in each strip');
    assert.ok(html.includes('dpage-skel-row'));
    assert.ok(!html.includes('LOADING'));
    assertTrimmed(html, 'loading');
    release();
    await run;
    assert.ok(!S.html().includes('dpage-skel'));
  });

  test('the library first, the connected servers when they answer: their strip and column wait as skeletons', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? gate.then(() => PEERS) : MAIN) });
    const run = S.discoveryPanel();
    await flush(); await flush(); await flush();
    let html = S.html();
    assert.ok(html.includes('Title Seven'), 'the library drew');
    assert.match(html, /class="dpage-strip dpage-src-peers" aria-busy="true"><div class="album-grid dpage-albums"><div class="dpage-skel-card">/, 'no label while asked');
    assert.match(html, /<section class="dpage-col dpage-src-peers" data-source="peers"><div class="dpage-rows" aria-busy="true">/);
    release();
    await run;
    html = S.html();
    assert.ok(html.includes('Peer Song'));
    assert.ok(!html.includes('dpage-skel'));
  });
});

describe('Discover page: no connected servers', () => {
  const many = (n) => ({ ...MAIN, library: { ...MAIN.library, tracks: Array.from({ length: n }, (_, i) => libTrack(i)) } });

  test('federation off: one call, no connected label, strip or column — the library flows over both columns', async () => {
    const { S, calls } = makeSandbox({ taste: () => many(20), flags: NO_FED });
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls).length, 1, 'no peers call');
    assert.deepEqual(tasteCalls(calls)[0].sources, ['library']);
    const html = S.html();
    assert.ok(!html.includes('dpage-src-peers'));
    assert.ok(!html.includes('dpage.albums.peer') && !html.includes('dpage.songs.peer'));
    assert.ok(!html.includes('dpage.peers.quiet'));
    assert.match(html, /<div class="dpage-songs dpage-songs-solo"><section class="dpage-col dpage-src-library"/);
    assert.equal(html.split('dpage.songs.library').length - 1, 1, 'ONE heading over the block');
    // the first block: rows 1–8 left, 9–16 right (column-major, a CSS grid)
    const blocks = [...html.matchAll(/<div class="dpage-rows dpage-flow" style="--dpage-per:(\d+)">/g)].map((m) => Number(m[1]));
    assert.deepEqual(blocks, [8], 'one block of 16: 8 per column');
    assert.ok(html.includes('Many 15') && !html.includes('Many 16'));
    assert.ok(html.indexOf('Many 0') < html.indexOf('Many 8'), 'in order: the grid lays them out column-major');
    assert.ok(html.indexOf('data-dp="showMore" data-v="library"') > html.indexOf('Many 15'));
    assert.ok(html.indexOf('data-dp="queueAll"') > html.indexOf('data-dp="showMore"'), 'the footer under the block');
    assertTrimmed(html, 'no federation');
  });

  test('Show more adds the next block of 16 (a short last block splits evenly), then goes', async () => {
    const { S, click } = makeSandbox({ taste: () => many(20), flags: NO_FED });
    await S.discoveryPanel();
    click({ 'data-dp': 'showMore', 'data-v': 'library' });
    const html = S.html();
    const blocks = [...html.matchAll(/--dpage-per:(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(blocks, [8, 2]);
    assert.ok(html.includes('Many 19'));
    assert.ok(!html.includes('data-dp="showMore"'), 'nothing left');
    // the row indexes keep counting across blocks
    assert.ok(findDrawn(html, { 'data-dp': 'play', 'data-i': 19 }));
  });

  test('paired servers with nothing playable: no connected album strip, the column says so in one dim line', async () => {
    const quiet = { ...PEERS, peers: { ...PEERS.peers, peers: PEERS.peers.peers.map((g) => ({ ...g, reachable: false })) } };
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? quiet : MAIN) });
    await S.discoveryPanel();
    const html = S.html();
    assert.ok(!html.includes('dpage-strip dpage-src-peers'));
    assert.match(html, /<section class="dpage-col dpage-src-peers" data-source="peers"><h3 class="dpage-label">[\s\S]*dpage\.songs\.peerMany[\s\S]*<div class="dpage-hint">dpage\.peers\.quiet<\/div><\/section>/);
    assert.ok(!html.includes('Offline Song'));
    assert.ok(!html.includes('dpage-songs-solo'), 'two columns: federation is on');
    assertTrimmed(html, 'quiet');
  });

  test('zero paired servers: drawn as no federation at all', async () => {
    const none = { ...PEERS, peers: { peers: [], searched: { peers: 0 } } };
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? none : MAIN) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('dpage-src-peers'));
    assert.ok(S.html().includes('dpage-songs-solo'));
  });

  test('a failed connected call: the column\'s one line with Try again', async () => {
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? null : MAIN) });
    await S.discoveryPanel();
    assert.match(S.html(), /dpage-src-peers[\s\S]*dpage\.source\.failed[\s\S]*data-dp="retry"/);
    const n = tasteCalls(calls).length;
    click({ 'data-dp': 'retry' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n + 2);
  });
});

describe('Discover page: Show more', () => {
  test('each column starts at 16 and appends 16 more per click, independently', async () => {
    const lib = { ...MAIN, library: { ...MAIN.library, tracks: Array.from({ length: 40 }, (_, i) => libTrack(i)) } };
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...PEER_ROW, filepath: `tunes/Q/${i}.mp3`, title: `Peer ${i}`, similarity: 0.9 - i / 100 }));
    const peers = { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: rows }] } };
    const { S, click, keyClick, activeAttrs } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? peers : lib) });
    await S.discoveryPanel();
    const count = (dp) => countDrawn(S.html(), { 'data-dp': dp, class: 'discover-row dpage-row pointer' });
    assert.equal(count('queue'), 16);
    assert.equal(count('fedQueue'), 16);
    assert.ok(!S.html().includes('dpage-flow'), 'two columns: the library is one list');
    click({ 'data-dp': 'showMore', 'data-v': 'library' });
    assert.equal(count('queue'), 32);
    assert.equal(count('fedQueue'), 16, 'the other column stays');
    keyClick({ 'data-dp': 'showMore', 'data-v': 'peers' });
    assert.equal(count('fedQueue'), 20);
    assert.ok(!findDrawn(S.html(), { 'data-dp': 'showMore', 'data-v': 'peers' }), 'gone at the end');
    assert.deepEqual([activeAttrs()['data-dp'], activeAttrs()['data-i']], ['peerPlay', '16'], 'the keyboard goes on to the first row it added');
    keyClick({ 'data-dp': 'showMore', 'data-v': 'library' });
    assert.equal(count('queue'), 40);
    assert.deepEqual([activeAttrs()['data-dp'], activeAttrs()['data-i']], ['play', '32']);
    assert.ok(!S.html().includes('data-dp="showMore"'));
    // a new answer starts both columns over
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(count('queue'), 16);
    // and a fresh visit does too
    click({ 'data-dp': 'showMore', 'data-v': 'library' });
    await S.discoveryPanel();
    assert.equal(count('queue'), 16);
  });

  test('Queue all / Shuffle / Save act on every library song, not only the ones shown', async () => {
    const lib = { ...MAIN, library: { ...MAIN.library, tracks: Array.from({ length: 20 }, (_, i) => libTrack(i)) } };
    const { S, click, queued } = makeSandbox({ taste: () => lib, flags: NO_FED });
    await S.discoveryPanel();
    click({ 'data-dp': 'queueAll' });
    assert.equal(queued.length, 20);
  });
});

describe('Discover page: states', () => {
  const RANDOM = {
    ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null,
    seeds: [{ hash: 'r1', filepath: 'music/R/Rand.flac', metadata: { title: 'Rand', artist: 'Ray' }, outcome: null, plays: 0, pinned: false, analyzed: true }],
  };

  test('nothing finished: the card, a random chip with no ×, and Another pick re-asks without that pick', async () => {
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('dpage-seeds'), 'the card, no seed strip');
    assertTrimmed(S.html(), 'nothingFinished');
    openOptions(click);
    const html = S.html();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.nothingFinished/);
    assert.match(html, /data-dp="another"/);
    assert.match(html, /data-dp="pick"/);
    assert.match(html, /data-dp="browse">dpage\.verb\.browseLibrary/);
    assert.match(html, /dpage\.seeds\.randomTag/);
    assert.ok(!/data-dp="drop"/.test(html), 'the random pick has no ×');
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const next = tasteCalls(calls).slice(before);
    assert.ok(next.length >= 1);
    assert.deepEqual(next[0].exclude, ['r1']);
    assert.equal(next[0].remember, undefined, 'a passed-over pick is never saved');
  });

  test('after Another pick, the checkbox or a window change keeps the skip out — and saves the prefs with a PUT, not remember', async () => {
    const { S, calls, click, change } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    openOptions(click);
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'includePlayed' });
    await flush(); await flush();
    let [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'all');
    assert.deepEqual(main.exclude, ['r1'], 'the skipped pick stays skipped');
    assert.equal(main.remember, undefined, 'nothing sent is saved with it');
    assert.deepEqual(calls.filter((c) => c.name === 'prefsSave').map((c) => c.body), [{ window: 30, filter: 'all', staleDays: 90 }]);
    before = tasteCalls(calls).length;
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    [main] = tasteCalls(calls).slice(before);
    assert.equal(main.window, 90);
    assert.deepEqual(main.exclude, ['r1']);
    assert.equal(main.remember, undefined);
  });

  test('scan pending: the card with Check again, the seeds under More options', async () => {
    const pending = { ...MAIN, notAnalyzed: true, library: { filter: 'fresh', albums: [], tracks: [] } };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...pending, peers: { peers: [], searched: {} } } : pending) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('dpage-seeds'), 'the card, no seed strip');
    assertTrimmed(S.html(), 'scanPending');
    openOptions(click);
    const html = S.html();
    assert.match(html, /dpage\.state\.scanPending/);
    assert.match(html, /dpage\.state\.seedsListedAnyway/);
    assert.match(html, /data-dp="retry"/);
    assert.ok(seedsSection(html).includes('Seed &lt;One&gt;'), 'seeds are listed anyway, in the picker');
    assert.match(html, /dpage\.source\.waitingForScan/);
    assert.ok(!html.includes('data-dp="includePlayedOn"'), 'nothing to widen while the scan has not run');
  });

  test('the library-empty button gone after the re-ask: the keyboard lands on More options, not <body>', async () => {
    const empty = (filter) => ({ ...MAIN, library: { filter, albums: [], tracks: [] } });
    const { S, keyClick, activeAttrs } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : empty(b.filter || 'fresh')) });
    await S.discoveryPanel();
    keyClick({ 'data-dp': 'includePlayedOn' });
    await flush(); await flush();
    assert.ok(!S.html().includes('data-dp="includePlayedOn"'), 'nothing left to widen');
    assert.equal(activeAttrs()['data-dp'], 'options');
  });

  test('a failed call draws the failed card with Try again', async () => {
    const { S } = makeSandbox({ taste: () => null });
    await S.discoveryPanel();
    assert.match(S.html(), /dpage\.state\.failed[\s\S]*data-dp="retry"/);
    assertTrimmed(S.html(), 'failed');
  });

  test('library empty: one dim line and "Include songs I\'ve played lately", which ticks the checkbox and re-asks', async () => {
    const empty = { ...MAIN, library: { filter: 'fresh', albums: [], tracks: [] } };
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : empty) });
    await S.discoveryPanel();
    let html = S.html();
    assert.ok(!html.includes('dpage-strip dpage-src-library'), 'no library albums: no strip');
    assert.match(html, /<div class="dpage-hint">dpage\.library\.nothing <button type="button" class="dpage-vb dpage-hint-btn" data-dp="includePlayedOn">dpage\.opt\.includePlayed<\/button><\/div>/);
    assertTrimmed(html, 'library empty');
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'includePlayedOn' });
    await flush(); await flush();
    const [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'all');
    assert.equal(main.remember, true);
    openOptions(click);
    html = S.html();
    assert.equal(findDrawn(html, { 'data-dp': 'includePlayed' }).attrs['aria-checked'], 'true', 'the checkbox is ticked');
  });

  test('library empty with every played song included: the line alone', async () => {
    const empty = { ...MAIN, library: { filter: 'all', albums: [], tracks: [] } };
    const { S } = makeSandbox({ taste: () => empty, flags: NO_FED, prefs: { window: 30, filter: 'all', staleDays: 90, exclude: [], persisted: true } });
    await S.discoveryPanel();
    assert.match(S.html(), /<div class="dpage-hint">dpage\.library\.nothing<\/div>/);
  });

  test('every seed dropped: the card says so and its Edit seeds opens the picker on the dropped ones', async () => {
    const ALL_DROPPED = { ...RANDOM, excluded: [{ hash: 'gone', filepath: 'music/G/Gone.flac', metadata: { title: 'Gone Song' } }] };
    const { S, click, focused } = makeSandbox({
      taste: (b) => (b.sources.includes('peers') ? { ...ALL_DROPPED, library: null } : ALL_DROPPED),
      prefs: { window: 30, filter: 'fresh', staleDays: 90, exclude: ['gone'], persisted: true },
    });
    await S.discoveryPanel();
    let html = S.html();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.allDropped[\s\S]*dpage\.state\.allDroppedBody/);
    assert.ok(!html.includes('dpage-seeds'), 'the picker starts closed');
    assert.match(html, /data-dp="editSeeds">dpage\.seeds\.edit/);
    for (const act of ['another', 'pick', 'browse']) { assert.ok(html.includes(`data-dp="${act}"`), act); }
    click({ 'data-dp': 'editSeeds' });
    html = S.html();
    assert.equal(S.view.optionsOpen, true);
    assert.equal(findDrawn(html, { 'data-dp': 'options' }).attrs['aria-expanded'], 'true');
    assert.ok(seedsSection(html).includes('dpage-dropped'), 'the dropped seeds, with Use again');
    assert.ok(findDrawn(seedsSection(html), { 'data-dp': 'restore', 'data-i': 0 }));
    assert.deepEqual(focused, ['restore'], 'the keyboard lands on the first Use again');
  });

  test('a song still finished keeps the plain card (no Edit seeds button)', async () => {
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    assert.match(S.html(), /dpage\.state\.nothingFinishedBody/);
    assert.ok(!S.html().includes('data-dp="editSeeds"'));
  });
});

describe('Discover page: changes re-ask', () => {
  test('dropping a seed re-asks with exclude + remember, with an Undo', async () => {
    const { S, calls, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const [main, peers] = tasteCalls(calls).slice(before);
    assert.deepEqual(main.exclude, ['h1']);
    assert.equal(main.remember, true);
    assert.equal(peers.remember, undefined, 'remember rides on one call');
    const undo = toasts.find((o) => o.buttons);
    assert.ok(undo, 'the drop toast has an Undo');
    undo.buttons[0][1]({ hide() {} }, {});
    await flush(); await flush();
    assert.deepEqual(calls.filter((c) => c.name === 'prefsSave').map((c) => c.body), [{ exclude: [] }], 'Undo is a restore: THE list without it');
  });

  test('a persisting account never keeps the drop list in localStorage', async () => {
    const { S, click, storage } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const stored = JSON.parse(storage.get(DISCOVERYPAGE.STORAGE_KEYS.prefs));
    assert.equal(stored.exclude, undefined);
    assert.equal(stored.window, 30);
  });

  test('a prefs GET that failed: a drop asks again first, and does nothing (a toast) while they stay unknown', async () => {
    const answers = [null, null, { window: 30, filter: 'fresh', staleDays: 90, exclude: ['old'], persisted: true }];
    const { S, calls, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING, prefs: () => answers.shift() });
    await S.discoveryPanel();
    assert.equal(S.view.prefsKnown, false);
    openOptions(click);
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, before, 'no drop while unknown');
    assert.ok(toasts.some((o) => o.error && o.title === 'dpage.prefs.unknown'));
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const [main] = tasteCalls(calls).slice(before);
    assert.equal(S.view.prefsKnown, true);
    assert.deepEqual(main.exclude, ['h1'], 'a persisting account: only this drop is sent');
    assert.equal(main.remember, true);
    assert.equal(calls.filter((c) => c.name === 'prefs').length, 3);
  });

  test('the checkbox while the prefs are unknown is not remembered', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer, prefs: () => null });
    await S.discoveryPanel();
    openOptions(click);
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'includePlayed' });
    await flush(); await flush();
    const [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'all');
    assert.equal(main.remember, undefined);
  });

  test('"Show all" opens the whole seed strip, and then reads Show less', async () => {
    const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 8 }, (_, i) => ({ hash: `m${i}`, filepath: `music/M/${i}.flac`, metadata: { title: `More ${i}` }, outcome: 'completed', plays: 1, pinned: false, analyzed: true }))] };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    openOptions(click);
    assert.match(S.html(), /data-dp="moreSeeds">dpage\.seeds\.showAll</);
    assert.ok(!seedsSection(S.html()).includes('dpage-sub'), 'no statistics line');
    click({ 'data-dp': 'moreSeeds' });
    assert.match(S.html(), /data-dp="moreSeeds">dpage\.seeds\.showLess/);
    assert.ok(S.html().includes('More 7'));
  });

  test('"Include songs I\'ve played lately": off by default; ticking re-asks with \'all\', unticking narrows at once and re-asks with \'fresh\'', async () => {
    const recent = new Date(Date.now() - 5 * 86400000).toISOString();
    const all = { ...MAIN, library: { ...MAIN.library, filter: 'all', tracks: [...MAIN.library.tracks, libTrack(9, { metadata: { title: 'Played Lately' }, playCount: 4, lastPlayed: recent })] } };
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : (b.filter === 'all' ? all : MAIN)) });
    await S.discoveryPanel();
    openOptions(click);
    let box = findDrawn(S.html(), { 'data-dp': 'includePlayed' });
    assert.equal(box.tag, 'button');
    assert.equal(box.attrs.role, 'checkbox');
    assert.equal(box.attrs['aria-checked'], 'false');
    assert.match(S.html(), /data-dp="includePlayed"><i aria-hidden="true"><\/i>dpage\.opt\.includePlayed</);
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'includePlayed' });
    await flush(); await flush();
    let [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'all');
    assert.equal(main.remember, true);
    assert.ok(S.html().includes('Played Lately'));
    assert.equal(findDrawn(S.html(), { 'data-dp': 'includePlayed' }).attrs['aria-checked'], 'true');
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'includePlayed' });
    // provisional: the recently played row is gone before the answer lands
    assert.ok(!S.html().includes('Played Lately'));
    await flush(); await flush();
    [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'fresh');
    assert.equal(main.remember, true);
    box = findDrawn(S.html(), { 'data-dp': 'includePlayed' });
    assert.equal(box.attrs['aria-checked'], 'false');
  });

  test('a saved "never played" filter is read as the checkbox off (\'fresh\')', async () => {
    for (const filter of ['never', 'unplayed']) {
      const { S, calls, click } = makeSandbox({ taste: answer, prefs: { window: 30, filter, staleDays: 90, exclude: [], persisted: true } });
      await S.discoveryPanel();
      assert.equal(tasteCalls(calls)[0].filter, 'fresh', filter);
      openOptions(click);
      assert.equal(findDrawn(S.html(), { 'data-dp': 'includePlayed' }).attrs['aria-checked'], 'false', filter);
    }
  });

  test('the window select lives in the bar (only) and re-asks with the window', async () => {
    const { S, calls, change } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
    const html = S.html();
    const bar = html.slice(html.indexOf('<div class="dpage-bar">'), html.indexOf('</label>', html.indexOf('<div class="dpage-bar">')));
    assert.match(bar, /dpage\.basedOnLast[\s\S]*data-dp-change="window"/);
    assert.equal(html.split('data-dp-change="window"').length, 2, 'one window form');
    const before = tasteCalls(calls).length;
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    assert.equal(tasteCalls(calls).slice(before)[0].window, 90);
  });

  test('a revisit within the client TTL reuses the answer; refresh forces a new one', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const n = tasteCalls(calls).length;
    await S.discoveryPanel({ keep: true });
    assert.equal(tasteCalls(calls).length, n, 'same request, kept answer');
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n + 2);
  });
});

describe('Discover page: the configuration bar', () => {
  test('the bar: the window form, More options, then refresh — no tagline, no back link, no seed strip in the body', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    const at = (s) => html.indexOf(s);
    assert.ok(at('class="dpage-bar"') > 0);
    assert.ok(at('data-dp-change="window"') > at('class="dpage-bar"'));
    assert.ok(at('data-dp="options"') > at('data-dp-change="window"'));
    assert.ok(at('data-dp="refresh"') > at('data-dp="options"'), 'refresh at the far right');
    const toggle = findDrawn(html, { 'data-dp': 'options' });
    assert.equal(toggle.tag, 'button');
    assert.equal(toggle.attrs['aria-expanded'], 'false');
    assert.match(html, /data-dp="options"[^>]*>dpage\.bar\.moreOptions/);
    assert.equal(toggle.attrs['aria-controls'], undefined, 'nothing to point at while closed');
    for (const absent of ['dpage-tagline', 'dpage.subtitle', 'data-dp="back"', 'dpage-seeds', 'dpage-options', 'dpage.seeds.title', 'data-dp="drop"', 'data-dp="unpin"', 'data-dp="moreSeeds"', 'data-dp="includePlayed"']) {
      assert.ok(!html.includes(absent), absent);
    }
  });

  test('a random seed draws no connected-server column while the peers call is out, nor on the next load', async () => {
    const RAND = { ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null, seeds: [{ hash: 'r1', filepath: 'music/R/Rand.flac', metadata: { title: 'Rand' }, outcome: null, plays: 0, pinned: false, analyzed: true }] };
    let release;
    let gate = new Promise((r) => { release = r; });
    let mainGate = null;
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? gate.then(() => ({ ...RAND, library: null })) : (mainGate ? mainGate.then(() => RAND) : RAND)) });
    const run = S.discoveryPanel();
    await flush(); await flush();
    assert.match(S.html(), /dpage\.state\.nothingFinished/, 'the library answer is in');
    assert.ok(!S.html().includes('dpage-src-peers'), 'no peers skeleton re-flowing away');
    assert.ok(S.html().includes('dpage-songs dpage-songs-solo'));
    release();
    await run;
    // a later visit, both calls out: the one-column skeleton (the last
    // library answer had a random seed)
    gate = new Promise((r) => { release = r; });
    mainGate = gate;
    S.view.main = undefined;
    S.view.peers = undefined;
    S.view.at = 0;
    const again = S.discoveryPanel();
    await flush();
    assert.match(S.html(), PAGE_BUSY, 'loading');
    assert.ok(!S.html().includes('dpage-src-peers'));
    assert.ok(S.html().includes('dpage-songs dpage-songs-solo'));
    release();
    await again;
  });

  test('no seed strip in the body in any state while closed', async () => {
    const RANDOM = { ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null, seeds: [{ hash: 'r1', filepath: 'music/R/Rand.flac', metadata: { title: 'Rand' }, outcome: null, plays: 0, pinned: false, analyzed: true }] };
    const pending = { ...MAIN, notAnalyzed: true, library: { filter: 'fresh', albums: [], tracks: [] } };
    let release;
    const gate = new Promise((r) => { release = r; });
    const loading = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = loading.S.discoveryPanel();
    assert.match(loading.S.html(), PAGE_BUSY);
    assert.ok(!loading.S.html().includes('dpage-seeds'), 'loading');
    release();
    await run;
    // each case proves it reached its state before checking the absence
    const reached = {
      nothingFinished: /dpage-card[\s\S]*dpage\.state\.nothingFinished/,
      scanPending: /dpage-card[\s\S]*dpage\.state\.scanPending/,
      ready: /dpage-src-library[\s\S]*data-dp="queue"/,
      failed: /dpage-card[\s\S]*dpage\.state\.failed/,
    };
    for (const [name, taste] of [['nothingFinished', () => RANDOM], ['scanPending', () => pending], ['ready', answer], ['failed', () => null]]) {
      const { S } = makeSandbox({ taste });
      await S.discoveryPanel();
      assert.match(S.html(), reached[name], `${name}: drawn`);
      assert.ok(!PAGE_BUSY.test(S.html()), `${name}: not still loading`);
      if (name === 'ready') { assert.ok(!S.html().includes('dpage-card'), 'ready: no state card'); }
      assert.ok(!S.html().includes('dpage-seeds'), name);
      assert.ok(S.html().includes('data-dp="options"'), `${name}: the bar is there`);
    }
  });

  test('More options opens the checkbox above the seed picker; the toggle reads Fewer options, then closes it', async () => {
    const { S, click } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    let html = S.html();
    const toggle = findDrawn(html, { 'data-dp': 'options' });
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    assert.equal(toggle.attrs['aria-controls'], 'dpage-options');
    assert.match(html, /data-dp="options"[^>]*>dpage\.bar\.fewerOptions/);
    const bar = html.indexOf('class="dpage-bar"');
    const panel = html.indexOf('class="dpage-options" id="dpage-options"');
    const check = html.indexOf('data-dp="includePlayed"');
    const seeds = html.indexOf('class="dpage-seeds"');
    const lib = html.indexOf('dpage-src-library');
    assert.ok(bar > 0 && panel > bar && check > panel && seeds > check && lib > seeds, 'bar, the checkbox, the picker, then the page');
    assert.match(seedsSection(html), /dpage\.seeds\.title/);
    assert.match(seedsSection(html), /data-dp="pick"/);
    assert.equal(html.split('data-dp="includePlayed"').length, 2, 'one filter on the page');
    assert.ok(!html.includes('data-dp="newArtists"'), 'new artists only is the Explore page\'s');
    openOptions(click);
    html = S.html();
    assert.equal(findDrawn(html, { 'data-dp': 'options' }).attrs['aria-expanded'], 'false');
    assert.ok(!html.includes('dpage-seeds'));
  });

  test('while the answer is still coming, the open drawer has the checkbox and says the seeds wait', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S, click } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    openOptions(click);
    assert.match(S.html(), /class="dpage-options"[^>]*><div class="dpage-opt-row"><button[^>]*data-dp="includePlayed"[\s\S]*?<\/div><div class="dpage-hint">dpage\.bar\.seedsWait/);
    assert.ok(!S.html().includes('dpage.state.loading'), 'skeletons, no loading line');
    release();
    await run;
    assert.ok(S.html().includes('class="dpage-seeds"'), 'the chips arrive in the open picker');
  });

  test('a failed call with the picker open: its own waiting line, the failed text once', async () => {
    const { S, click } = makeSandbox({ taste: () => null });
    await S.discoveryPanel();
    openOptions(click);
    const html = S.html();
    assert.match(html, /<div class="dpage-hint">dpage\.bar\.seedsWait/);
    assert.equal(html.split('dpage.state.failed').length - 1, 1, 'the failed card only');
    assert.match(html, /dpage-card[\s\S]*data-dp="retry"/);
  });

  test('the keyboard stays on the toggle (and on more/less) across the re-render', async () => {
    const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 8 }, (_, i) => ({ hash: `m${i}`, filepath: `music/M/${i}.flac`, metadata: { title: `More ${i}` }, outcome: 'completed', plays: 1, pinned: false, analyzed: true }))] };
    const { S, click, keyClick, focused, activeAttrs } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    openOptions(click);
    assert.deepEqual(focused, ['options']);
    assert.equal(activeAttrs()['data-dp'], 'options');
    keyClick({ 'data-dp': 'moreSeeds' });
    assert.equal(focused.at(-1), 'moreSeeds');
    assert.equal(activeAttrs()['data-dp'], 'moreSeeds');
    keyClick({ 'data-dp': 'options' });
    assert.equal(focused.at(-1), 'options');
    assert.equal(activeAttrs()['data-dp'], 'options');
    assert.match(S.html(), /data-dp="options" aria-expanded="false"/);
  });

  test('the picker stays open across a drop, an Undo and the checkbox, and starts closed on a fresh open', async () => {
    const { S, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    assert.ok(S.html().includes('class="dpage-seeds"'), 'still open after the drop');
    toasts.find((o) => o.buttons).buttons[0][1]({ hide() {} }, {});
    await flush(); await flush();
    assert.ok(S.html().includes('class="dpage-seeds"'), 'still open after the Undo');
    click({ 'data-dp': 'includePlayed' });
    await flush(); await flush();
    assert.ok(S.html().includes('class="dpage-seeds"'), 'still open after a re-render');
    // a return to the page (an album opened from it, the song picker)
    await S.discoveryPanel({ keep: true });
    assert.ok(S.html().includes('class="dpage-seeds"'), 'a return keeps it');
    // a nav click: a fresh visit
    await S.discoveryPanel();
    assert.equal(S.view.optionsOpen, false);
    assert.ok(!S.html().includes('dpage-seeds'));
    assert.match(S.html(), /data-dp="options"[^>]*>dpage\.bar\.moreOptions/);
  });

  test('inside the picker: + Now playing pins, × unpins, Edit seeds shows the dropped ones and Use again restores', async () => {
    const dropped = { ...MAIN, excluded: [{ hash: 'gone', filepath: 'music/G/Gone.flac', metadata: { title: 'Gone Song' } }] };
    const { S, calls, click } = makeSandbox({
      // the now-playing seed comes back only while it is pinned
      taste: (b) => (b.sources.includes('peers') ? PEERS : { ...dropped, seeds: b.pin ? SEEDS : SEEDS.slice(1) }),
      playing: PLAYING,
      prefs: { window: 30, filter: 'fresh', staleDays: 90, exclude: ['gone'], persisted: true },
    });
    await S.discoveryPanel();
    // the pin was made at open: unpin it from inside the picker
    openOptions(click);
    assert.ok(!S.html().includes('data-dp="addPlaying"'), 'pinned already');
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'unpin', 'data-i': 0 });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).slice(before)[0].pin, undefined);
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'addPlaying' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).slice(before)[0].pin, ['music/Now/Playing.flac']);
    assert.ok(S.html().includes('class="dpage-seeds"'), 'still open');
    // Edit seeds → the dropped list → Use again
    click({ 'data-dp': 'moreSeeds' });
    assert.ok(S.html().includes('dpage-dropped'));
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'restore', 'data-i': 0 });
    await flush(); await flush();
    assert.deepEqual(calls.filter((c) => c.name === 'prefsSave').map((c) => c.body), [{ exclude: [] }]);
    assert.ok(tasteCalls(calls).length > before, 're-asked');
    assert.ok(S.html().includes('class="dpage-seeds"'), 'still open');
  });

  test('inside the picker: + Add a song… pins the picked song, and the page comes back with the picker open', async () => {
    const { S, calls, click, views, vpc } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    assert.ok(findDrawn(seedsSection(S.html()), { 'data-dp': 'pick' }), '+ Add a song… is in the picker');
    click({ 'data-dp': 'pick' });
    S.setState([{ state: 'fileExplorer' }]);
    // the next row click anywhere is the capture; its way back is the page
    assert.equal(typeof vpc.songCapture, 'function');
    const before = tasteCalls(calls).length;
    vpc.songCapture({ filepath: '/music/P/Picked.flac' });
    await views[views.length - 1]();
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).slice(before)[0].pin, ['music/Now/Playing.flac', 'music/P/Picked.flac']);
    assert.equal(S.view.optionsOpen, true);
    assert.ok(seedsSection(S.html()).includes('data-dp="pick"'), 'the picker shows the result');
  });
});

describe('Discover page: New seeds (the bar\'s ⟳)', () => {
  const fin = (n) => ({ hash: `f${n}`, filepath: `music/F/${n}.flac`, metadata: { title: `Fin ${n}`, artist: 'Hal' }, outcome: 'completed', lastPlayed: '2026-10-04T21:10:00.000Z', plays: 1, pinned: false, analyzed: true });
  // The server's pick (src/api/discovery-taste.js collectSeeds): the pins,
  // then the next two finished songs not excluded; none left → the pins
  // alone, then (no pin) the finished songs the worker has not analyzed
  // (notAnalyzed: no suggestions), or a random pick. Every exclusion is
  // listed in `excluded`.
  const server = (count, { unanalyzed = 0 } = {}) => (body) => {
    const ex = new Set(body.exclude || []);
    const pins = (body.pin || []).includes('music/Now/Playing.flac') ? [SEEDS[0]] : [];
    const history = Array.from({ length: count }, (_, i) => fin(i + 1)).filter((s) => !ex.has(s.hash)).slice(0, 2);
    const waiting = !pins.length && !history.length
      ? Array.from({ length: unanalyzed }, (_, i) => ({ ...fin(50 + i), hash: `u${i + 1}`, analyzed: false })).filter((s) => !ex.has(s.hash)).slice(0, 2)
      : [];
    const random = !pins.length && !history.length && !waiting.length;
    const res = {
      ...MAIN, seedSource: random ? 'random' : (history.length || waiting.length ? 'history' : 'pinned'), fallback: random,
      seeds: random ? [{ ...fin(99), hash: 'r1', outcome: null }] : [...pins, ...history, ...waiting],
      excluded: [...ex].map((h) => ({ hash: h, filepath: `music/G/${h}.flac`, metadata: { title: `Gone ${h}` } })),
      notAnalyzed: waiting.length > 0,
      library: waiting.length ? { ...MAIN.library, albums: [], tracks: [] } : MAIN.library,
      network: random ? null : MAIN.network,
    };
    return body.sources.includes('peers') ? { ...PEERS, ...res, library: null, network: null, peers: random ? null : PEERS.peers } : res;
  };
  // Holds the server's answers while `hold()` is on (the page in flight).
  const gated = (base) => {
    let gate = null;
    let open = () => {};
    return {
      taste: (b) => (gate ? gate.then(() => base(b)) : base(b)),
      hold: () => { gate = new Promise((r) => { open = r; }); },
      release: () => { const o = open; gate = null; o(); },
    };
  };
  const settle = async () => { await flush(); await flush(); await flush(); };
  const mains = (calls) => tasteCalls(calls).filter((b) => b.sources.includes('library'));
  const press = async (click) => { click({ 'data-dp': 'refresh' }); await flush(); await flush(); };

  test('the bar\'s button says what it does: "New seeds" (title and aria-label)', async () => {
    const { S } = makeSandbox({ taste: server(6) });
    await S.discoveryPanel();
    const btn = findDrawn(S.html(), { 'data-dp': 'refresh' });
    assert.equal(btn.attrs.title, 'dpage.verb.newSeeds');
    assert.equal(btn.attrs['aria-label'], 'dpage.verb.newSeeds');
  });

  test('a press re-asks without the history seeds on screen (never remembered, pins kept); a second press leaves out both sets', async () => {
    const { S, calls, click } = makeSandbox({ taste: server(6), playing: PLAYING });
    await S.discoveryPanel();
    assert.equal(mains(calls)[0].exclude, undefined);
    let before = tasteCalls(calls).length;
    await press(click);
    let next = tasteCalls(calls).slice(before);
    assert.equal(next.length, 2, 'the library and the connected servers, as at open');
    for (const b of next) {
      assert.deepEqual(b.exclude, ['f1', 'f2']);
      assert.equal(b.remember, undefined, 'a rotation is never saved');
      assert.deepEqual(b.pin, ['music/Now/Playing.flac'], 'the pin stays a seed');
    }
    before = tasteCalls(calls).length;
    await press(click);
    next = tasteCalls(calls).slice(before);
    assert.deepEqual(next.map((b) => b.exclude), [['f1', 'f2', 'f3', 'f4'], ['f1', 'f2', 'f3', 'f4']]);
    assert.ok(!next.some((b) => b.exclude.includes('h-np')), 'a pin is never excluded');
    assert.equal(calls.filter((c) => c.name === 'prefsSave').length, 0, 'no PUT either');
  });

  test('the picker shows the new seeds — and no "dropped" chips for the ones passed over', async () => {
    const { S, click } = makeSandbox({ taste: server(6), playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    assert.match(seedsSection(S.html()), /Fin 1[\s\S]*Fin 2/);
    await press(click);
    const seeds = seedsSection(S.html());
    assert.match(seeds, /Now Song[\s\S]*Fin 3[\s\S]*Fin 4/, 'the pin, then the next finished songs');
    assert.ok(!/Fin [12]\b/.test(seeds), 'the passed-over seeds are gone from the strip');
    assert.ok(!S.html().includes('Gone '), 'never drawn as dropped');
    assert.ok(!S.html().includes('data-dp="moreSeeds"'), 'no Edit seeds for them');
    assert.ok(!S.html().includes('dpage-dropped'));
  });

  test('past every finished song: the random pick says so, and the next press starts again from the newest', async () => {
    const { S, calls, click } = makeSandbox({ taste: server(3) });
    await S.discoveryPanel();
    await press(click);
    assert.deepEqual(mains(calls).at(-1).exclude, ['f1', 'f2']);
    await press(click);
    assert.deepEqual(mains(calls).at(-1).exclude, ['f1', 'f2', 'f3']);
    // the server widened all the way to a random pick
    const html = S.html();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.seedsCycled[\s\S]*dpage\.state\.seedsCycledBody/);
    assert.ok(!html.includes('dpage.state.nothingFinished'), 'not "finish a few songs": they did');
    assert.ok(!html.includes('dpage.state.allDropped'), 'nor "every one dropped"');
    assert.match(html, /class="dpage-btn pri" data-dp="refresh" data-v="card">dpage\.verb\.newSeeds/, 'the card offers New seeds first');
    assert.match(html, /data-dp="another">dpage\.verb\.anotherPick/);
    // a cycle, not a dead end
    await press(click);
    assert.equal(mains(calls).at(-1).exclude, undefined);
    assert.deepEqual(S.view.rotation, []);
    assert.deepEqual(S.view.main.seeds.map((x) => x.hash), ['f1', 'f2'], 'the newest finished songs again');
    assert.ok(!S.html().includes('dpage-card'), 'the card is gone');
    await press(click);
    assert.deepEqual(mains(calls).at(-1).exclude, ['f1', 'f2'], 'and round again');
  });

  test('with a pin: past every finished song the pins alone seed — and the next press starts over too', async () => {
    const { S, calls, click } = makeSandbox({ taste: server(2), playing: PLAYING });
    await S.discoveryPanel();
    await press(click);
    assert.deepEqual(mains(calls).at(-1).exclude, ['f1', 'f2']);
    assert.equal(S.view.main.seedSource, 'pinned');
    await press(click);
    assert.equal(mains(calls).at(-1).exclude, undefined);
  });

  test('Another pick on the cycled card keeps the rotation (and adds its skip); still never remembered', async () => {
    const { S, calls, click } = makeSandbox({ taste: server(2) });
    await S.discoveryPanel();
    await press(click);
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const last = mains(calls).at(-1);
    assert.deepEqual(last.exclude, ['r1', 'f1', 'f2']);
    assert.equal(last.remember, undefined);
  });

  test('a window change, the checkbox, a pin change, a drop and a fresh open each start from the newest again', async () => {
    const { S, calls, click, change } = makeSandbox({ taste: server(6), playing: PLAYING });
    await S.discoveryPanel();
    await press(click);
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    let last = mains(calls).at(-1);
    assert.equal(last.window, 90);
    assert.equal(last.exclude, undefined, 'the rotation is gone');
    assert.equal(last.remember, true, 'the window is still remembered');

    await press(click);
    openOptions(click);
    click({ 'data-dp': 'includePlayed' });
    await flush(); await flush();
    last = mains(calls).at(-1);
    assert.equal(last.filter, 'all');
    assert.equal(last.exclude, undefined);

    await press(click);
    click({ 'data-dp': 'unpin', 'data-i': 0 });
    await flush(); await flush();
    last = mains(calls).at(-1);
    assert.equal(last.pin, undefined);
    assert.equal(last.exclude, undefined);

    await press(click);
    click({ 'data-dp': 'drop', 'data-i': 0 });
    await flush(); await flush();
    last = mains(calls).at(-1);
    assert.deepEqual(last.exclude, ['f3'], 'the drop alone, as before');
    assert.equal(last.remember, true);
    assert.deepEqual(S.view.rotation, []);

    await press(click);
    assert.ok(S.view.rotation.length > 0);
    await S.discoveryPanel();
    assert.deepEqual(S.view.rotation, []);
    assert.equal(mains(calls).at(-1).exclude, undefined);
  });

  test('the answer on screen stays drawn (busy, not loading) until the new one lands', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    let n = 0;
    const base = server(6);
    const { S, click } = makeSandbox({
      taste: (b) => {
        if (!b.exclude) { return base(b); }
        n++;
        return late.then(() => {
          const res = base(b);
          return res.library ? { ...res, library: { ...MAIN.library, tracks: [{ ...MAIN.library.tracks[0], metadata: { title: 'Fresh Pick', artist: 'New' } }] } } : res;
        });
      },
      playing: PLAYING,
    });
    await S.discoveryPanel();
    assert.match(S.html(), /Title Seven/);
    click({ 'data-dp': 'refresh' });
    await flush();
    assert.equal(n, 2, 'asked');
    let html = S.html();
    assert.match(html, /<div class="dpage dpage-page-play dpage-busy">/, 'busy');
    assert.ok(!PAGE_BUSY.test(html), 'not the loading state');
    assert.match(html, /Title Seven/, 'the old rows stay');
    assert.ok(!/dpage-skel/.test(html), 'no skeletons');
    release();
    await flush(); await flush(); await flush();
    html = S.html();
    assert.match(html, /Fresh Pick/);
    assert.ok(!html.includes('dpage-busy'));
  });

  test('a reset while the old answer is drawn: its passed-over seeds never show as dropped (the cycled card, a window change)', async () => {
    const g = gated(server(3));
    const { S, click, change } = makeSandbox({ taste: g.taste });
    await S.discoveryPanel();
    await press(click);
    await press(click);
    assert.match(S.html(), /dpage\.state\.seedsCycled/);
    // New seeds from the cycled card: the rotation starts over at once, the
    // random answer stays drawn — as the cycled card, not "all dropped"
    g.hold();
    click({ 'data-dp': 'refresh', 'data-v': 'card' });
    await flush();
    assert.deepEqual(S.view.rotation, []);
    let html = S.html();
    assert.ok(html.includes('dpage-busy'), 'in flight');
    assert.match(html, /dpage\.state\.seedsCycled/);
    assert.ok(!html.includes('dpage.state.allDropped'), 'never "every song was dropped"');
    assert.ok(!html.includes('data-dp="editSeeds"'));
    g.release();
    await settle();
    assert.ok(!S.html().includes('dpage-card'), 'the newest finished songs again');

    // rotate once, then change the window: the busy picker lists no drops
    await press(click);
    openOptions(click);
    g.hold();
    change({ 'data-dp-change': 'window' }, '90');
    await flush();
    html = S.html();
    assert.ok(html.includes('dpage-busy'));
    assert.ok(!html.includes('data-dp="moreSeeds"'), 'no Edit seeds for the passed-over songs');
    assert.ok(!html.includes('Gone '), 'nor a Use again chip');
    g.release();
    await settle();
    assert.ok(!S.html().includes('Gone '));
  });

  test('songs the worker has not analyzed end the cycle: said so (no "nothing analyzed yet"), then the newest again', async () => {
    const { S, calls, click } = makeSandbox({ taste: server(2, { unanalyzed: 5 }) });
    await S.discoveryPanel();
    await press(click);
    assert.deepEqual(mains(calls).at(-1).exclude, ['f1', 'f2']);
    const html = S.html();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.seedsCycled[\s\S]*dpage\.state\.seedsCycledPendingBody/);
    assert.ok(!html.includes('dpage.state.scanPending'), 'not "this server hasn\'t analyzed any music"');
    assert.ok(!html.includes('data-dp="admin"') && !html.includes('dpage.verb.checkAgain'));
    assert.ok(!html.includes('data-dp="another"'), 'no random pick to replace');
    assert.match(html, /class="dpage-btn pri" data-dp="refresh" data-v="card">dpage\.verb\.newSeeds/);
    await press(click);
    assert.equal(mains(calls).at(-1).exclude, undefined, 'a cycle: the unanalyzed songs are never stepped through');
    assert.deepEqual(S.view.main.seeds.map((x) => x.hash), ['f1', 'f2']);
    // without a rotation the same answer is the real scan-pending state
    const fresh = makeSandbox({ taste: () => server(0, { unanalyzed: 2 })({ sources: ['library'] }) });
    await fresh.S.discoveryPanel();
    assert.match(fresh.S.html(), /dpage\.state\.scanPending/);
  });

  test('the keyboard on the cycled card\'s New seeds stays on it while in flight, then lands on the bar\'s', async () => {
    const g = gated(server(2));
    const { S, click, keyClick, activeAttrs } = makeSandbox({ taste: g.taste });
    await S.discoveryPanel();
    await press(click);
    g.hold();
    keyClick({ 'data-dp': 'refresh', 'data-v': 'card' });
    await flush();
    assert.equal(activeAttrs()['data-v'], 'card', 'the card is still drawn (busy): its button keeps the focus');
    g.release();
    await settle();
    assert.equal(activeAttrs()['data-dp'], 'refresh');
    assert.equal(activeAttrs()['data-v'], undefined, 'the card is gone: the bar\'s ⟳');
  });

  test('a restore, + Now playing, a picked song, a page switch and "new artists only" start from the newest again', async () => {
    const base = server(6);
    const { S, calls, click, views, vpc } = makeSandbox({
      // one remembered drop to restore (the server lists it in excluded)
      taste: (b) => { const r = base(b); return { ...r, excluded: [{ hash: 'gone', filepath: 'music/G/Gone.flac', metadata: { title: 'Kept Out' } }, ...r.excluded] }; },
      playing: PLAYING,
      prefs: { window: 30, filter: 'fresh', staleDays: 90, exclude: ['gone'], persisted: true },
    });
    await S.discoveryPanel();
    const reset = (what) => {
      assert.deepEqual(S.view.rotation, [], what);
      assert.equal(tasteCalls(calls).at(-1).exclude, undefined, what);
    };
    await press(click);
    openOptions(click);
    click({ 'data-dp': 'moreSeeds' });
    assert.ok(!S.html().includes('Gone '), 'only the real drop is listed');
    click({ 'data-dp': 'restore', 'data-i': 0 });
    await settle();
    reset('restore');

    await press(click);
    click({ 'data-dp': 'unpin', 'data-i': 0 });
    await settle();
    await press(click);
    assert.ok(S.view.rotation.length > 0);
    click({ 'data-dp': 'addPlaying' });
    await settle();
    reset('+ Now playing');

    await press(click);
    click({ 'data-dp': 'pick' });
    S.setState([{ state: 'fileExplorer' }]);
    vpc.songCapture({ filepath: '/music/P/Picked.flac' });
    await views[views.length - 1]();
    await settle();
    reset('a picked song');

    await press(click);
    await S.discoveryPanel({ page: 'explore', keep: true });
    await settle();
    reset('the other page');
    await press(click);
    assert.ok(S.view.rotation.length > 0);
    if (!S.view.optionsOpen) { openOptions(click); }
    click({ 'data-dp': 'newArtists' });
    await settle();
    reset('new artists only');
  });
});

describe('Discover page: the explore page (no nav row yet)', () => {
  test('discoveryPanel({ page: \'explore\' }) asks the network alone and draws its list', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel({ page: 'explore' });
    assert.equal(S.view.page, 'explore');
    const asked = tasteCalls(calls);
    assert.equal(asked.length, 1, 'no peers call');
    assert.deepEqual(asked[0].sources, ['network']);
    const html = S.html();
    assert.match(html, /class="dpage dpage-page-explore/);
    assert.ok(html.includes('dpage-sec-network') && html.includes('dpage.network.title'));
    assert.match(html, /data-dp="lead" data-i="0"/);
    assert.ok(html.includes('Far &lt;Server&gt;'), 'escaped');
    assert.ok(!html.includes('dpage-src-library') && !html.includes('dpage-src-peers'), 'no library, no connected servers');
  });

  test('a lead opens its window, matched against its own seed', async () => {
    const { S, click, opened } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel({ page: 'explore' });
    const lead = findDrawn(S.html(), { 'data-dp': 'lead', 'data-i': 0 });
    assert.equal(lead.tag, 'button');
    assert.ok(lead.attrs['aria-label']);
    click({ 'data-dp': 'lead', 'data-i': 0 });
    assert.equal(opened[0].source, 'p2p');
    assert.equal(opened[0].raw, MAIN.network.results[0], 'the route\'s own row, unchanged');
    assert.deepEqual(opened[0].opts, { seedTitle: 'Seed <One>' }, 'h1, the seed the lead was matched against (escaped by Vue)');
  });

  test('"new artists only" sits in its More options (not the play page\'s checkbox) and re-asks', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer });
    await S.discoveryPanel({ page: 'explore' });
    openOptions(click);
    const html = S.html();
    assert.ok(!html.includes('data-dp="includePlayed"'));
    const box = findDrawn(html, { 'data-dp': 'newArtists' });
    assert.equal(box.attrs['aria-checked'], 'false');
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'newArtists' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).slice(before)[0].newArtistsOnly, true);
  });

  test('a return keeps the page; a nav click is Discover again', async () => {
    const { S, calls } = makeSandbox({ taste: answer });
    await S.discoveryPanel({ page: 'explore' });
    await S.discoveryPanel({ keep: true });
    assert.equal(S.view.page, 'explore');
    await S.discoveryPanel();
    assert.equal(S.view.page, 'play');
    assert.deepEqual(tasteCalls(calls).at(-2).sources, ['library']);
    assert.ok(S.html().includes('dpage-src-library'));
    assert.ok(!S.html().includes('dpage-sec-network'), 'the network answer is not drawn on Discover');
  });

  test('a server without p2p has nothing to explore: no request', async () => {
    const { S, calls } = makeSandbox({ taste: answer, flags: { ...FLAGS_ALL, discoveryP2p: false } });
    await S.discoveryPanel({ page: 'explore' });
    assert.equal(tasteCalls(calls).length, 0);
  });
});

describe('Discover page: fencing', () => {
  test('an answer that lands after browseGeneration moved on is dropped', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    await flush();
    const loading = S.html();
    assert.match(loading, PAGE_BUSY, 'the page\'s own loading state, at once');
    S.bump();   // a server switch / peer adoption superseded the load
    release();
    await run;
    assert.equal(S.html(), loading, 'the stale answer never drew');
    assert.equal(S.view.main, undefined);
  });

  test('after a superseded load, the next visit asks again (it never waits on the dropped one)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let first = true;
    const { S, calls } = makeSandbox({ taste: (b) => (first ? gate.then(() => answer(b)) : answer(b)) });
    const run = S.discoveryPanel();
    await flush();
    S.bump();
    first = false;
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls).length, 4, 'asked again');
    assert.ok(S.html().includes('Title Seven'), 'and drew');
    release();
    await run;
    assert.ok(S.html().includes('Title Seven'), 'the dropped answer changed nothing');
  });

  test('an answer that lands while another panel is up is kept but not drawn', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    await flush();
    const loading = S.html();
    S.setState([{ state: 'allAlbums' }]);
    release();
    await run;
    assert.equal(S.html(), loading);
    assert.ok(S.view.main && S.view.main.library, 'kept for the way back');
  });
});

describe('Discover page: job badges (the explore page)', () => {
  const JOB = { id: 7, plugin: 'youtube', state: 'running', progress: 0.1, key: 'k1', params: {} };
  const badgeBox = (extra = {}) => makeSandbox({
    taste: answer,
    flags: { ...FLAGS_ALL, discoveryPlugins: true },
    plugins: { available: true, list: [{ name: 'youtube', title: 'YouTube', capabilities: ['acquire'] }], jobsAllowed: true },
    lookup: (recs) => ({ results: recs.map((r, i) => (i === 0 ? { key: 'k1', keys: {}, jobs: [JOB] } : { key: 'other' + i, keys: {}, jobs: [] })) }),
    ...extra,
  });

  test('the batch lookup puts a job badge on its network row', async () => {
    const job = { ...JOB, progress: 0.64 };
    const { S, calls } = badgeBox({ lookup: (recs) => ({ results: recs.map(() => ({ key: 'k1', keys: {}, jobs: [job] })) }) });
    await S.discoveryPanel({ page: 'explore' });
    const lookups = calls.filter((c) => c.name === 'lookup');
    assert.equal(lookups.length, 1);
    assert.deepEqual(lookups[0].body, [MAIN.network.results[0]], 'the network lead alone');
    const html = S.html();
    assert.match(html, /dpage-badge-src">discover\.job\.downloading/);
    assert.match(html, /<div class="dpage-prog"><i style="width:64%"><\/i><\/div>/);
    assert.match(html, /dpage\.plugins\.getIt/);
  });

  test('the play page looks nothing up (its rows carry no badge)', async () => {
    const { S, calls } = badgeBox();
    await S.discoveryPanel();
    assert.equal(calls.filter((c) => c.name === 'lookup').length, 0);
    assert.ok(!S.html().includes('dpage-badge'));
  });

  test('a poll tick redraws only a badge that changed, in place; an unchanged tick draws nothing', async () => {
    const { S, tick, patches, renders } = badgeBox();
    await S.discoveryPanel({ page: 'explore' });
    const drawn = renders();
    const html = S.html();
    tick([JOB]);
    assert.equal(patches.length, 0, 'nothing changed: nothing drawn');
    tick([{ ...JOB, progress: 0.5 }]);
    assert.equal(renders(), drawn, 'no whole-page draw on the poll');
    assert.equal(S.html(), html);
    const bar = patches.find((pt) => pt.slot === 'data-pslot' && pt.id === 'n0');
    assert.ok(bar && /width:50%/.test(bar.html), 'the lead\'s bar moved');
    assert.ok(patches.some((pt) => pt.slot === 'data-bslot' && pt.id === 'n0'));
  });

  test('a return within the TTL listens again and catches the badges up', async () => {
    const { S, tick, liveWatches, calls } = badgeBox();
    await S.discoveryPanel({ page: 'explore' });
    assert.equal(liveWatches(), 1);
    S.setState([{ state: 'allAlbums' }]);   // the user left
    tick([{ ...JOB, progress: 0.3 }]);
    assert.equal(liveWatches(), 0, 'the watch ends once the page is left');
    tick([{ ...JOB, progress: 0.9 }]);       // moved while away (no one listening)
    const lookups = calls.filter((c) => c.name === 'lookup').length;
    await S.discoveryPanel({ page: 'explore' }); // back, same question, within the TTL
    assert.equal(calls.filter((c) => c.name === 'lookup').length, lookups, 'the kept answer: no new lookup');
    assert.equal(liveWatches(), 1, 'listening again');
    assert.match(S.html(), /width:90%/, 'the badge caught up');
  });
});

describe('Discover page: wiring', () => {
  const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8'));
  const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8');

  test('index.html: the nav entry in the Music group after Most Played, hidden until the ping', () => {
    const nav = html.match(/<div id="nav-discover" class="([^"]*)" onclick="changeView\(discoveryPanel, this\);" data-panel="discovery">/);
    assert.ok(nav, 'the entry');
    for (const c of ['local-only', 'side-nav-item', 'super-hide']) { assert.ok(nav[1].split(' ').includes(c), c); }
    const most = html.indexOf('data-i18n="nav.mostPlayed"');
    const disc = html.indexOf('id="nav-discover"');
    const rated = html.indexOf('data-panel="allRated"');
    assert.ok(most > 0 && disc > most && rated > disc, 'right after Most Played');
    assert.ok(html.indexOf('data-i18n="nav.discover"') > disc);
    assert.ok(!html.includes('nav-explore'), 'no Explore row yet');
  });

  test('index.html: discovery-page.js loads beside discover-jobs.js, before vp.js', () => {
    const jobs = html.indexOf('<script src="alpha/discover-jobs.js"></script>');
    const page = html.indexOf('<script src="alpha/discovery-page.js"></script>');
    const vp = html.indexOf('<script src="alpha/vp.js"></script>');
    assert.ok(jobs > 0 && page > jobs && vp > page);
    assert.match(html, /onclick="openDiscoveryPage\(\);"/, 'the panel links the page');
    assert.match(html, /id="savePlaylistModal"[\s\S]*?action="javascript:savePlaylistFromModal\(\)"/, 'one name-a-playlist modal');
    assert.ok(!/id="(?:dpageSaveModal|spathSaveModal)"/.test(html));
  });

  test('m.js: the page is a top-level panel, never a peer-capable one, revealed by the ping', () => {
    assert.match(SRC, /\n {2}discovery: \(\) => discoveryPanel\(\),\n/);
    const peerCapable = SRC.slice(SRC.indexOf('const PEER_CAPABLE_STATES'), SRC.indexOf(']);', SRC.indexOf('const PEER_CAPABLE_STATES')));
    assert.ok(!peerCapable.includes('discovery'));
    const init = sliceFn('init');
    assert.ok(init.includes('applyDiscoveryPing(response);'), 'init() hands the ping to applyDiscoveryPing');
  });

  test('spa.css: the columns follow the page\'s own width (a container query), the no-federation flow is column-major, the phone tabs are gone', () => {
    const page = css.slice(css.indexOf('/* ── The Discover page'));
    assert.match(page, /\.dpage \{[^}]*container-type: inline-size;[^}]*container-name: dpage;/);
    const wide = page.slice(page.indexOf('@container dpage (min-width: 560px)'));
    assert.ok(page.includes('@container dpage (min-width: 560px)'));
    assert.match(wide, /\.dpage-songs:not\(\.dpage-songs-solo\) \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
    assert.match(wide, /\.dpage-flow \{[^}]*grid-template-rows: repeat\(var\(--dpage-per, 8\), auto\);[^}]*grid-auto-flow: column;/);
    for (const gone of ['.dpage-seg', '.dpage-album-badge', '.dpage-album-w', '.dpage-when', '.dpage-count', '.dpage-peer-dot', '.dpage-tagline', '.dpage-back', '.dpage-vb-peer']) {
      assert.ok(!page.includes(gone), gone);
    }
    // narrow content box: 120 px cards, 36 px art; touch: verbs and the
    // strips' play buttons always shown, 40 px verbs; keyboard: the same
    const narrow = page.slice(page.indexOf('@container dpage (max-width: 600px)'));
    assert.ok(page.includes('@container dpage (max-width: 600px)'));
    assert.match(narrow, /\.album-grid\.dpage-albums \{ grid-auto-columns: 120px;/);
    assert.match(narrow, /\.dpage-art, \.dpage-skel-row i \{ width: 36px; height: 36px; \}/);
    const touch = page.slice(page.indexOf('@media (hover: none)'));
    assert.match(touch, /^@media \(hover: none\) \{[^}]*\.dpage-verbs \{ opacity: 1; \}\s*\.dpage \.album-grid-play \{ opacity: 1;[^}]*\}\s*\.dpage-vb \{ min-width: 40px; height: 40px; \}/);
    assert.match(page, /\.dpage-row:hover \.dpage-verbs, \.dpage-row:focus-within \.dpage-verbs \{ opacity: 1; \}/);
    assert.match(page, /\.dpage \.album-grid-card:focus-within \.album-grid-play \{ opacity: 1;/);
    assert.match(page, /\.dpage \.album-grid-play:focus-visible, \.dpage-peer-card:focus-visible \{ outline: 2px solid #fa832b;/);
    assert.match(page, /@media \(max-width: 600px\) \{[^}]*\.dpage-bar \{ padding: 6px 16px; \}/, '16 px gutters on a phone');
    assert.ok(!page.includes('.dpage-row-off'), 'no offline rows any more');
    // the house palette only
    const hex = new Set(css.slice(0, css.indexOf('/* ── The Discover page')).match(/#[0-9a-fA-F]{3,6}\b/g).map((h) => h.toLowerCase()));
    for (const h of page.match(/#[0-9a-fA-F]{3,6}\b/g)) { assert.ok(hex.has(h.toLowerCase()), `${h} is a house colour`); }
  });

  test('applyDiscoveryPing: the flags, the nav entry and the panel\'s link follow the ping', () => {
    const { S, els, bodyClasses } = makeSandbox({ taste: answer });
    S.applyDiscoveryPing({ discovery: true, discoveryTaste: 2, discoveryP2p: true, federationDiscovery: false, discoveryPlugins: true });
    assert.deepEqual(S.view.flags, { discovery: true, discoveryTaste: 2, discoveryP2p: true, federationDiscovery: false, discoveryPlugins: true });
    assert.ok(!els.get('nav-discover').classList.contains('super-hide'));
    assert.ok(bodyClasses.contains('has-discover-page'));
    for (const off of [{ discovery: true, discoveryTaste: 0 }, { discovery: false, discoveryTaste: 1 }, { discovery: true }, {}]) {
      S.applyDiscoveryPing(off);
      assert.ok(els.get('nav-discover').classList.contains('super-hide'), JSON.stringify(off));
      assert.ok(!bodyClasses.contains('has-discover-page'), JSON.stringify(off));
    }
    S.applyDiscoveryPing({ discovery: true, discoveryTaste: '1' });
    assert.equal(S.view.flags.discoveryTaste, 1, 'a string generation still counts');
    assert.ok(bodyClasses.contains('has-discover-page'));
  });

  test('en.json: the panel is retitled "More like this"; the page has its nav and panel names', () => {
    assert.equal(en['discover.title'], 'More like this');
    assert.equal(en['nav.discover'], 'Discover');
    assert.equal(en['panel.discover'], 'Discover');
    assert.ok(en['discover.openPage']);
  });

  test('en.json: the play page\'s copy, exactly', () => {
    assert.equal(en['dpage.albums.library'], 'Albums from your library');
    assert.equal(en['dpage.songs.peerMany'], 'Songs from connected servers');
    assert.equal(en['dpage.showMore'], 'Show more');
    assert.equal(en['dpage.verb.queueAll'], 'Queue all');
    assert.equal(en['dpage.peers.quiet'], 'Nothing from your connected servers right now.');
  });

  test('en.json: every dpage.* key the module and the panel emit exists', () => {
    const moduleSrc = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'discovery-page.js'), 'utf8');
    const start = SRC.indexOf('///////////////// Discover page');
    const end = SRC.indexOf('///////////////// Transcode');
    assert.ok(start > 0 && end > start);
    const panelSrc = SRC.slice(start, end);
    const keys = new Set();
    for (const src of [moduleSrc, panelSrc]) {
      for (const m of src.matchAll(/'((?:dpage|discover)\.[A-Za-z0-9_.]+)'/g)) { keys.add(m[1]); }
    }
    const missing = [...keys].filter((k) => !(k in en));
    assert.deepEqual(missing, []);
    assert.ok(keys.size > 50, `scanned ${keys.size} keys`);
    // …and the other way: no dpage.* string that nothing emits (translators
    // would be asked for dead copy).
    const dead = Object.keys(en).filter((k) => k.startsWith('dpage.') && !keys.has(k));
    assert.deepEqual(dead, []);
  });

  test('i18n t(): a param\'s $-patterns are text (a song title, a peer name)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'webapp', 'assets', 'js', 'i18n.js'), 'utf8');
    const win = {};
    const I18N = new Function('window', 'document', 'localStorage', 'navigator', `${src}\nreturn I18N;`)(win, {}, { getItem: () => null }, { language: 'en' });
    assert.equal(I18N.t('because {{title}}', { title: "Money $' Talks $& $$" }), "because Money $' Talks $& $$");
    assert.equal(I18N.t('{{n}} of {{m}}', { n: 2, m: 3 }), '2 of 3');
  });
});
