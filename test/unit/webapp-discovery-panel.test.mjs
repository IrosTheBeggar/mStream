/**
 * The Discover page's m.js half (docs/discovery-page-plan.md §4.1): the
 * panel that wires alpha/discovery-page.js (DISCOVERYPAGE) to the app.
 *
 * What is pinned (the play-now page, discoveryView.page 'play'):
 *   - opening the page fires the two taste calls the plan names (library,
 *     then peers once the library answer lands, pinned to that answer's
 *     seeds — each call draws its own random batch, so the connected-server
 *     column is built from the batch the picker shows) with the now-playing
 *     song pinned, the window from localStorage and the same limits — and
 *     nothing else: no prefs call,
 *     no remember / filter / staleDays (the route is stateless since
 *     2026-10-14) — and draws "Albums from your library", "Albums from
 *     {server}", "Songs from your library" and "Songs from {server}" in that
 *     order — plain album cards, songs as art tile, title and "Artist ·
 *     Album" — every value escaped;
 *   - none of the old busy-ness comes back in any state: no "matched by
 *     sound", no "never played", no count, no percentage, no meter, no
 *     when-label, no filter toggles or checkbox, no phone tabs, no See all,
 *     no per-peer headers, no network section (assertTrimmed);
 *   - a connected server's row queues on click, as a library row does; its
 *     verbs are Play now / Add to queue / ⋯ (the peer window); its album
 *     card opens in the peer-browse view and its play button queues the
 *     album through the federation stream;
 *   - with no connected server there is no peers label, strip or column,
 *     and the library's songs flow column-major over both columns;
 *     federation on with nothing playable keeps the column and one line;
 *   - "Show more" appends 16 per column; the library-empty line stands
 *     alone (no button to widen it);
 *   - the seed chips sit behind the gray bar's "More options": the toggle
 *     flips its label and aria-expanded, stays as left across re-renders
 *     within a visit, and starts closed on a fresh open;
 *   - every open, every return and every tap asks again (no client-side
 *     reuse); the answer on screen stays drawn, busy, until the new one
 *     lands; the bar's ⟳ ("New seeds") and "Another pick" are that same
 *     question again — the server draws the new batch;
 *   - the window lives in localStorage; pins and dropped seeds last for the
 *     visit: a drop re-asks with exclude (never stored), Use again / Undo
 *     re-asks without it, the dropped chips are the answer's excluded[];
 *     a fresh open forgets both;
 *   - discoveryPanel({ page: 'explore' }) still asks the network alone and
 *     draws its list, its "new artists only" and its job badges (a poll
 *     tick patches only the badges that changed);
 *   - an answer that lands after the app moved on (browseGeneration bumped)
 *     is dropped; a 403 re-pings before naming a reason;
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
  'localIgnoreVPaths', 'applyDiscoveryPing', 'discoverySetEntry',
  'discoveryWatchJobs', 'discoveryMergeJobs', 'discoveryPatchBadges', 'discoveryLeadTag',
  'discoveryMatchOpts', 'discoveryDropSeed', 'discoveryT', 'discoveryText', 'discoveryOnScreen', 'discoveryNowPlayingPath',
  'discoveryLocalChoices', 'discoverySaveLocalChoice', 'discoveryPanel', 'redoDiscovery', 'discoveryOff',
  'discoveryResponse', 'discoveryLoadBadges', 'discoveryHideHead', 'renderDiscovery', 'discoveryFocusedSelector', 'discoveryHeadHtml',
  'discoveryOptionsHtml', 'discoveryCheckHtml', 'discoveryCardHtml', 'discoverySeedsHtml', 'discoveryLabelHtml',
  'discoverySkelHtml', 'discoveryPlayHtml', 'discoveryStripHtml', 'discoveryPeerAlbumHtml', 'discoveryArtHtml',
  'discoverySongRowHtml', 'discoveryShowMoreHtml', 'discoveryColHintHtml', 'discoveryLibrarySongsHtml',
  'discoveryPeerSongsHtml', 'discoveryExploreHtml', 'discoverySectionHtml', 'discoveryEmptyHtml',
  'discoveryBadgeHtml', 'discoveryProgressHtml', 'discoveryNetworkHtml', 'onDiscoveryChange', 'onDiscoveryClick',
  'discoveryAction', 'discoveryOpenPeerAlbum', 'discoveryQueuePeerAlbum',
  'discoveryRestoreSeed', 'discoveryQueueAll', 'discoveryPick', 'discoveryRefocus', 'onDiscoveryKey',
  'discoveryFocusFallbacks'];

const KNOWN_IDS = ['filelist', 'dpage-head', 'localSearchBar', 'directoryName', 'directory_bar',
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
//   stored        localStorage's starting entries
//   ping          MSTREAMAPI.ping's answer (the re-ping after a 403)
//   playing       MSTREAMPLAYER.getCurrentSong()
//   lookup(recs)  MSTREAMAPI.discoveryJobLookupBatch
//   jobs          VUEPLAYERCORE.discoverJobs() (the strip's last poll)
function makeSandbox({ taste, stored = {}, ping = null, playing = null, flags = FLAGS_ALL, lookup = null, plugins = null, jobs = [], albumSongs = null, noHead = false } = {}) {
  const els = new Map();
  // the delegated handlers, by the root ('filelist' | 'dpage-head') whose
  // drawn .dpage took them: a control's events reach only its own root's
  const pageHandlers = { filelist: {}, 'dpage-head': {} };
  const patches = [];
  let renders = 0;
  // document.activeElement: the drawn control's attrs while one has focus,
  // and the root it was drawn in
  const focus = { on: null, root: null };
  const classesOf = (initial) => {
    const classes = new Set(initial);
    return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  };
  for (const id of KNOWN_IDS) {
    let inner = '';
    // the drawn picker (.dpage-options): a new element on every write, its
    // own scroll starting at the top, as the DOM's does
    let options = null;
    const el = {
      value: '', scrollTop: 0, style: {},
      classList: classesOf(id === 'nav-discover' || id === 'dpage-head' ? ['super-hide'] : []),
      // a drawn .dpage takes the delegated handlers (this root's); the
      // picker, a badge / bar slot is there when the drawn markup has it
      // (a slot's writes are recorded)
      querySelector: (sel) => {
        if (sel === '.dpage') {
          if (!/class="dpage[ "]/.test(inner)) { return null; }
          return { addEventListener: (type, fn) => { (pageHandlers[id] ||= {})[type] = fn; } };
        }
        if (sel === '.dpage-options') { return options; }
        const m = sel.match(/^\[(data-[bp]slot)="([^"]+)"\]$/);
        if (m && inner.includes(`${m[1]}="${m[2]}"`)) {
          return { set innerHTML(h) { patches.push({ slot: m[1], id: m[2], html: h }); } };
        }
        return null;
      },
    };
    // a whole-page draw drops the keyboard's control, as the DOM does
    // (the bar's host too: its controls are replaced with it)
    Object.defineProperty(el, 'innerHTML', { get: () => inner, set: (h) => {
      inner = h;
      options = /class="dpage-options[ "]/.test(h) ? { scrollTop: 0 } : null;
      if (pageHandlers[id]) { pageHandlers[id] = {}; }
      if (id === 'filelist') { renders++; }
      if (focus.root === id) { focus.on = null; focus.root = null; }
    } });
    els.set(id, el);
  }
  // an index.html older than m.js: no bar host at all
  if (noHead) { els.delete('dpage-head'); }
  const bodyClasses = classesOf(['has-discover-page']);
  const watchers = [];
  let currentJobs = jobs;
  const calls = [];
  const storage = new Map(Object.entries(stored));
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
  // …and the root each was found in ('dpage-head' | 'filelist')
  const focusedIn = [];
  const globals = {
    document: {
      body: { classList: bodyClasses },
      getElementById: (id) => els.get(id) ?? null,
      getElementsByClassName: () => [],
      get activeElement() {
        const a = focus.on;
        const root = focus.root;
        // closest('#x .dpage, #y .dpage'): only a selector naming the root
        // the control was drawn in finds an ancestor
        const closest = (sel) => (String(sel).split(',').some((part) => part.trim() === `#${root} .dpage`) ? {} : null);
        return a ? { closest, getAttribute: (n) => (n in a ? a[n] : null) } : null;
      },
      // `#filelist .dpage [data-dp="x"][data-i="3"]…` (or `#dpage-head
      // .dpage …`, the bar's host): a DRAWN control in that root
      querySelector: (sel) => {
        const m = sel.match(/^#(filelist|dpage-head) \.dpage ((?:\[[a-z-]+="[^"]*"\])+)$/);
        if (!m || !els.has(m[1])) { return null; }
        const attrs = Object.fromEntries([...m[2].matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].map((x) => [x[1], x[2]]));
        const found = findDrawn(els.get(m[1]).innerHTML, attrs);
        if (!found || !attrs['data-dp']) { return null; }
        return { focus: () => { focused.push(attrs['data-dp']); focusedIn.push(m[1]); focus.on = found.attrs; focus.root = m[1]; } };
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
      ping: () => { calls.push({ name: 'ping' }); return ping ? Promise.resolve(ping) : Promise.reject(new Error('no ping')); },
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
      head: () => (__els.get('dpage-head') ? __els.get('dpage-head').innerHTML : ''),
      // what the user sees: the bar's host over the scroller
      page: () => (__els.get('dpage-head') ? __els.get('dpage-head').innerHTML : '') + __els.get('filelist').innerHTML,
      state: () => programState,
      setState: (s) => { programState = s; },
      bump: () => { browseGeneration++; },
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));
  // A DRAWN element (it must be on the page) and the root it is drawn in:
  // the host's controls first, as the page reads top-down (a button or link
  // over a bare match, across both roots, as findDrawn picks).
  const locate = (attrs, tag) => {
    const roots = ['dpage-head', 'filelist'].filter((r) => els.has(r));
    const hits = roots.flatMap((root) => {
      const one = findDrawn(els.get(root).innerHTML, attrs, tag);
      return one ? [{ found: one, root }] : [];
    });
    const hit = tag ? hits[0] : (hits.find((h) => h.found.tag === 'button' || h.found.tag === 'a') || hits[0]);
    assert.ok(hit, `nothing drawn with ${JSON.stringify(attrs)}`);
    return hit;
  };
  // Dispatch an event through the handler its root's drawn .dpage took.
  const dispatch = (root, type, ev) => {
    const fn = pageHandlers[root] && pageHandlers[root][type];
    assert.ok(fn, `no ${type} handler on #${root}'s .dpage`);
    fn(ev);
  };
  // Click a DRAWN data-dp element: its root's delegated handler sees a
  // target whose closest('[data-dp]') is it.
  const click = (attrs, tag) => {
    const { found, root } = locate(attrs, tag);
    const el = { tagName: found.tag.toUpperCase(), getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) };
    dispatch(root, 'click', { target: { closest: () => el } });
  };
  // The keyboard on a drawn control: focus it, then click it (Enter / Space).
  const keyClick = (attrs, tag) => {
    const { found, root } = locate(attrs, tag);
    focus.on = found.attrs;
    focus.root = root;
    click(attrs, tag);
  };
  // A keydown on a drawn element (its class list from the markup).
  const keydown = (attrs, key) => {
    const { found, root } = locate(attrs, 'div');
    const cls = String(found.attrs.class || '').split(/\s+/);
    let prevented = false;
    dispatch(root, 'keydown', { key, preventDefault: () => { prevented = true; },
      target: { classList: { contains: (c) => cls.includes(c) }, getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) } });
    return prevented;
  };
  const activeAttrs = () => focus.on;
  const change = (attrs, value) => {
    const { found, root } = locate(attrs);
    dispatch(root, 'change', { target: { value, getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) } });
  };
  // A poll of the strip's job list: every live watch hears it.
  const tick = (list) => { currentJobs = list; for (const w of watchers.slice()) { if (w.live) { w.fn(list.slice()); } } };
  const liveWatches = () => watchers.filter((w) => w.live).length;
  return { S, keyClick, keydown, activeAttrs, views, focused, focusedIn, vpc: globals.VUEPLAYERCORE, calls, storage, queued, opened, fedQueued, toasts, els, click, change, tick, liveWatches, watchers, patches, renders: () => renders, bodyClasses, adopted, albumsOpened, rowsQueued, knownPeers };
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
  'data-dp="includePlayed', 'dpage.opt.', 'dpage-check', 'dpage.state.seedsCycled',
];
function assertTrimmed(page, label) {
  // the window select's options ("Last 30 days") are a choice, not a count
  const html = page.replace(/<select[\s\S]*?<\/select>/g, '');
  for (const g of GONE) { assert.ok(!html.includes(g), `${label}: no ${g}`); }
  assert.ok(!/\d\s*%/.test(html), `${label}: no percentage`);
}

describe('Discover page: opening it', () => {
  test('two taste calls — the library, then the connected servers pinned to its seeds — with now playing pinned, and nothing else asked', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    assert.deepEqual(S.state(), [{ state: 'discovery' }]);
    assert.equal(S.view.page, 'play');
    assert.deepEqual(calls.map((c) => c.name), ['taste', 'taste'], 'no prefs call: the route keeps nothing');
    const [main, peers] = tasteCalls(calls);
    assert.deepEqual(main.sources, ['library'], 'the network is the Explore page\'s');
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['music/Now/Playing.flac'], 'the leading / is stripped');
    assert.deepEqual(peers.pin, SEEDS.map((x) => x.filepath), 'the peers call seeds from the library answer\'s batch');
    // peers is per server, at its cap: one server fills the first 16 rows
    // and a "Show more" (the server's default of 12 could not)
    assert.deepEqual(main.limit, { albums: 12, tracks: 48, peers: 25 }, 'the strip\'s share and three pages of songs');
    assert.deepEqual(peers.limit, { ...main.limit, seeds: SEEDS.length }, 'no seeds of the server\'s own');
    assert.equal(peers.window, main.window);
    assert.equal(peers.newArtistsOnly, false, 'the play page sends no hidden "new artists only"');
    assert.equal(main.window, 30, 'the default window');
    for (const b of [main, peers]) {
      for (const k of ['remember', 'filter', 'staleDays', 'exclude']) { assert.equal(k in b, false, k); }
    }
  });

  test('a federated now-playing song is never pinned', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: { rawFilePath: 'x/y.mp3', federation: { peerId: 1 } } });
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls)[0].pin, undefined);
  });

  test('draws the two album strips and the two song columns, labelled, in order', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.page();
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
    // the whole-list verbs sit under each column's header, ahead of its rows
    assert.ok(html.indexOf('dpage.songs.library') < html.indexOf('data-dp="queueAll"'), 'library verbs after the header');
    assert.ok(html.indexOf('data-dp="queueAll"') < html.indexOf('data-dp="play"'), 'library verbs before the first row');
    assert.ok(html.indexOf('data-dp="peerQueueAll"') < html.indexOf('data-dp="peerPlay"'), 'peers verbs before the first peer row');
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
    const html = S.page();
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
    const html = S.page();
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
    const html = S.page();
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
    assert.match(S.page(), /dpage-off[\s\S]*dpage\.state\.off/);
  });

  test('a 403 retracts the nav entry and the panel\'s link, re-pings, and says off when the ping agrees', async () => {
    const { S, els, calls, bodyClasses } = makeSandbox({ taste: () => ({ disabled: true }), ping: { discovery: false, discoveryTaste: 1 } });
    els.get('nav-discover').classList.remove('super-hide');
    await S.discoveryPanel();
    await flush();
    assert.equal(calls.filter((c) => c.name === 'ping').length, 1, 'one re-ping for the two 403s');
    assert.match(S.page(), /dpage\.state\.off/);
    assert.ok(els.get('nav-discover').classList.contains('super-hide'));
    assert.ok(!bodyClasses.contains('has-discover-page'), '"Discover page →" goes too');
  });

  test('a 403 while the ping still has the page: not available for this account (no admin copy)', async () => {
    const { S } = makeSandbox({ taste: () => ({ disabled: true }), ping: { discovery: true, discoveryTaste: 1 } });
    await S.discoveryPanel();
    await flush();
    assert.match(S.page(), /dpage\.state\.unavailable/);
    assert.ok(!S.page().includes('dpage.state.off'));
  });

  test('a 403 with no ping answer says off', async () => {
    const { S } = makeSandbox({ taste: () => ({ disabled: true }) });
    await S.discoveryPanel();
    await flush();
    assert.match(S.page(), /dpage\.state\.offBody/);
  });

  test('first open draws skeleton strips and rows — no spinner, no "asking" line', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    const html = S.page();
    assert.match(html, /<div class="dpage dpage-page-play[^"]*" aria-busy="true">/);
    assert.match(html, /dpage-bar[\s\S]*dpage-skel-card/);
    assert.equal(html.split('dpage-skel-card').length - 1, 8, 'four tiles in each strip');
    assert.ok(html.includes('dpage-skel-row'));
    assert.ok(!html.includes('LOADING'));
    assertTrimmed(html, 'loading');
    release();
    await run;
    assert.ok(!S.page().includes('dpage-skel'));
  });

  test('the library first, the connected servers when they answer: their strip and column wait as skeletons', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? gate.then(() => PEERS) : MAIN) });
    const run = S.discoveryPanel();
    await flush(); await flush(); await flush();
    let html = S.page();
    assert.ok(html.includes('Title Seven'), 'the library drew');
    assert.match(html, /class="dpage-strip dpage-src-peers" aria-busy="true"><div class="album-grid dpage-albums"><div class="dpage-skel-card">/, 'no label while asked');
    assert.match(html, /<section class="dpage-col dpage-src-peers" data-source="peers"><div class="dpage-rows" aria-busy="true">/);
    release();
    await run;
    html = S.page();
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
    const html = S.page();
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
    assert.ok(html.indexOf('data-dp="queueAll"') < html.indexOf('Many 0'), 'the verbs under the header, ahead of the rows');
    assertTrimmed(html, 'no federation');
  });

  test('Show more adds the next block of 16 (a short last block splits evenly), then goes', async () => {
    const { S, click } = makeSandbox({ taste: () => many(20), flags: NO_FED });
    await S.discoveryPanel();
    click({ 'data-dp': 'showMore', 'data-v': 'library' });
    const html = S.page();
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
    const html = S.page();
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
    assert.ok(!S.page().includes('dpage-src-peers'));
    assert.ok(S.page().includes('dpage-songs-solo'));
  });

  test('a failed connected call: the column\'s one line with Try again', async () => {
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? null : MAIN) });
    await S.discoveryPanel();
    assert.match(S.page(), /dpage-src-peers[\s\S]*dpage\.source\.failed[\s\S]*data-dp="retry"/);
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
    const count = (dp) => countDrawn(S.page(), { 'data-dp': dp, class: 'discover-row dpage-row pointer' });
    assert.equal(count('queue'), 16);
    assert.equal(count('fedQueue'), 16);
    assert.ok(!S.page().includes('dpage-flow'), 'two columns: the library is one list');
    click({ 'data-dp': 'showMore', 'data-v': 'library' });
    assert.equal(count('queue'), 32);
    assert.equal(count('fedQueue'), 16, 'the other column stays');
    keyClick({ 'data-dp': 'showMore', 'data-v': 'peers' });
    assert.equal(count('fedQueue'), 20);
    assert.ok(!findDrawn(S.page(), { 'data-dp': 'showMore', 'data-v': 'peers' }), 'gone at the end');
    assert.deepEqual([activeAttrs()['data-dp'], activeAttrs()['data-i']], ['peerPlay', '16'], 'the keyboard goes on to the first row it added');
    keyClick({ 'data-dp': 'showMore', 'data-v': 'library' });
    assert.equal(count('queue'), 40);
    assert.deepEqual([activeAttrs()['data-dp'], activeAttrs()['data-i']], ['play', '32']);
    assert.ok(!S.page().includes('data-dp="showMore"'));
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

  test('nothing finished: the card, a random chip with no ×, and Another pick passes the pick on screen over', async () => {
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('dpage-seeds'), 'the card, no seed strip');
    assertTrimmed(S.page(), 'nothingFinished');
    openOptions(click);
    const html = S.page();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.nothingFinished/);
    assert.match(html, /class="dpage-btn pri" data-dp="another">dpage\.verb\.anotherPick/);
    assert.match(html, /data-dp="pick"/);
    assert.match(html, /data-dp="browse">dpage\.verb\.browseLibrary/);
    assert.match(html, /dpage\.seeds\.randomTag/);
    assert.ok(!/data-dp="drop"/.test(html), 'the random pick has no ×');
    const first = tasteCalls(calls);
    assert.deepEqual(first.map((b) => b.sources), [['library']], 'no connected-server call on a random seed (the server asks none)');
    assert.ok(!html.includes('dpage.peers.') && !html.includes('dpage-src-peers'), 'no connected column');
    assert.equal(first[0].exclude, undefined, 'nothing passed over yet');
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const next = tasteCalls(calls).slice(first.length);
    assert.deepEqual(next.map((b) => b.sources), [['library']]);
    assert.deepEqual(next[0].exclude, ['r1'], 'the pick on screen is passed over: the server draws another song');
    assert.deepEqual({ ...next[0], exclude: undefined }, { ...first[0], exclude: undefined }, 'otherwise the same question');
  });

  // A server's random fallback over a three-song library: the first song
  // not in exclude, or no seed at all (notAnalyzed) when every one is.
  const POOL = ['r1', 'r2', 'r3'];
  const randomServer = (b) => {
    const ex = b.exclude || [];
    const hash = POOL.find((h) => !ex.includes(h));
    const base = { ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null, excluded: echoExcluded(b) };
    return hash
      ? { ...base, seeds: [{ ...RANDOM.seeds[0], hash, filepath: `music/R/${hash}.flac`, metadata: { title: `Rand ${hash}` } }] }
      : { ...base, seeds: [], notAnalyzed: true, library: { albums: [], tracks: [] } };
  };

  test('Another pick: each press passes one more pick over; never drawn as dropped; a fresh open forgets them', async () => {
    const { S, calls, click } = makeSandbox({ taste: randomServer, flags: NO_FED });
    await S.discoveryPanel();
    assert.equal(S.view.main.seeds[0].hash, 'r1');
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    assert.equal(S.view.main.seeds[0].hash, 'r2');
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const html = S.page();
    assert.equal(S.view.main.seeds[0].hash, 'r3');
    assert.deepEqual(tasteCalls(calls).map((b) => b.exclude), [undefined, ['r1'], ['r1', 'r2']]);
    assert.deepEqual(S.view.passed, ['r1', 'r2']);
    assert.deepEqual(S.view.excluded, [], 'passed picks are not drops');
    assert.match(html, /dpage\.state\.nothingFinished/, 'not "every seed dropped": the passed picks are not drops');
    openOptions(click);
    assert.ok(!S.page().includes('dpage-dropped'), 'no dropped chips for the passed picks');
    await S.discoveryPanel();
    assert.deepEqual(S.view.passed, [], 'a fresh open starts over');
    assert.equal(tasteCalls(calls).at(-1).exclude, undefined);
  });

  test('Another pick ran out: the passed list is cleared and the page asks once more — no false scan-pending card', async () => {
    const { S, calls, click } = makeSandbox({ taste: randomServer, flags: NO_FED });
    await S.discoveryPanel();
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'another' });
    for (let i = 0; i < 4; i++) { await flush(); }
    const next = tasteCalls(calls).slice(before);
    assert.deepEqual(next.map((b) => b.exclude), [['r1', 'r2', 'r3'], undefined], 'ran out, then the same ask with nothing passed over');
    assert.deepEqual(S.view.passed, []);
    const html = S.page();
    assert.ok(!html.includes('dpage.state.scanPending'), 'never the scan-pending card');
    assert.match(html, /dpage\.state\.nothingFinished/);
    assert.equal(S.view.main.seeds[0].hash, 'r1', 'started over from the whole library');
  });

  test('a real scan-pending answer (nothing passed over) is drawn, never re-asked', async () => {
    const none = (b) => ({ ...randomServer({ ...b, exclude: POOL }), excluded: [] });
    const { S, calls } = makeSandbox({ taste: none, flags: NO_FED });
    await S.discoveryPanel();
    await flush();
    assert.equal(tasteCalls(calls).length, 1);
    assert.match(S.page(), /dpage\.state\.scanPending/);
  });

  test('the drops keep their room in exclude: passed picks fill what is left, never repeat a drop', async () => {
    const { S, calls, click } = makeSandbox({ taste: randomServer, flags: NO_FED });
    await S.discoveryPanel();
    S.view.excluded = ['d1', 'd2'];
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-1).exclude, ['d1', 'd2', 'r1'], 'drops first, then the passed picks');
  });

  test('scan pending: the card with Check again, the seeds under More options', async () => {
    const pending = { ...MAIN, notAnalyzed: true, library: { albums: [], tracks: [] } };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...pending, peers: { peers: [], searched: {} } } : pending) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('dpage-seeds'), 'the card, no seed strip');
    assertTrimmed(S.page(), 'scanPending');
    openOptions(click);
    const html = S.page();
    assert.match(html, /dpage\.state\.scanPending/);
    assert.match(html, /dpage\.state\.seedsListedAnyway/);
    assert.match(html, /data-dp="retry"/);
    assert.ok(seedsSection(html).includes('Seed &lt;One&gt;'), 'seeds are listed anyway, in the picker');
    assert.match(html, /dpage\.source\.waitingForScan/);
    assert.ok(!html.includes('dpage-hint-btn'), 'a line, no button');
  });

  test('a failed call draws the failed card with Try again', async () => {
    const { S } = makeSandbox({ taste: () => null });
    await S.discoveryPanel();
    assert.match(S.page(), /dpage\.state\.failed[\s\S]*data-dp="retry"/);
    assertTrimmed(S.page(), 'failed');
  });

  test('library empty: one dim line, alone', async () => {
    const empty = { ...MAIN, library: { albums: [], tracks: [] } };
    for (const flags of [FLAGS_ALL, NO_FED]) {
      const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : empty), flags });
      await S.discoveryPanel();
      const html = S.page();
      assert.ok(!html.includes('dpage-strip dpage-src-library'), 'no library albums: no strip');
      assert.match(html, /<div class="dpage-hint">dpage\.library\.nothing<\/div>/);
      assert.ok(!html.includes('dpage-hint-btn'), 'no button to widen it');
      assertTrimmed(html, 'library empty');
    }
  });

  test('every seed dropped: the card says so and its Edit seeds opens the picker on the dropped ones', async () => {
    // the visit drops the one song finished; the server falls to a random pick
    const { S, click, focused } = makeSandbox({
      taste: (b) => (b.exclude ? { ...RANDOM, excluded: echoExcluded(b) } : answer(b)),
    });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    click({ 'data-dp': 'options' });
    let html = S.page();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.allDropped[\s\S]*dpage\.state\.allDroppedBody/);
    assert.ok(!html.includes('dpage-seeds'), 'the picker starts closed');
    assert.match(html, /data-dp="editSeeds">dpage\.seeds\.edit/);
    for (const act of ['another', 'pick', 'browse']) { assert.ok(html.includes(`data-dp="${act}"`), act); }
    click({ 'data-dp': 'editSeeds' });
    html = S.page();
    assert.equal(S.view.optionsOpen, true);
    assert.equal(findDrawn(html, { 'data-dp': 'options' }).attrs['aria-expanded'], 'true');
    assert.ok(seedsSection(html).includes('dpage-dropped'), 'the dropped seeds, with Use again');
    assert.ok(seedsSection(html).includes('Gone h1'));
    assert.ok(findDrawn(seedsSection(html), { 'data-dp': 'restore', 'data-i': 0 }));
    assert.equal(focused.at(-1), 'restore', 'the keyboard lands on the first Use again');
  });

  test('a song still finished keeps the plain card (no Edit seeds button)', async () => {
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    assert.match(S.page(), /dpage\.state\.nothingFinishedBody/);
    assert.ok(!S.page().includes('data-dp="editSeeds"'));
  });
});

// The route's `excluded`: a row for each of THIS call's exclude hashes.
const echoExcluded = (body) => (body.exclude || []).map((h) => ({ hash: h, filepath: `music/G/${h}.flac`, metadata: { title: `Gone ${h}` } }));

describe('Discover page: changes re-ask', () => {
  test('dropping a seed re-asks with it in exclude (both calls, never remembered), with an Undo that re-asks without it', async () => {
    const { S, calls, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const [main, peers] = tasteCalls(calls).slice(before);
    assert.deepEqual(main.exclude, ['h1']);
    assert.deepEqual(peers.exclude, ['h1'], 'both calls agree on the seeds');
    for (const b of [main, peers]) { assert.equal('remember' in b, false); }
    assert.deepEqual(main.pin, ['music/Now/Playing.flac'], 'the pin stays');
    assert.deepEqual(S.view.excluded, ['h1']);
    const undo = toasts.find((o) => o.buttons);
    assert.ok(undo, 'the drop toast has an Undo');
    const n = tasteCalls(calls).length;
    undo.buttons[0][1]({ hide() {} }, {});
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n + 2, 'Undo asks again');
    assert.equal(tasteCalls(calls).at(-2).exclude, undefined, 'without the drop');
    assert.deepEqual(S.view.excluded, []);
    assert.deepEqual([...new Set(calls.map((c) => c.name))], ['taste'], 'nothing but taste calls: no prefs PUT');
  });

  test('drops last for the visit: every later ask of it keeps them; a return keeps them; a fresh open forgets them — and nothing is stored', async () => {
    const { S, calls, click, change, storage } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).exclude, ['h1'], 'a window change keeps the drop');
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).exclude, ['h1'], 'New seeds keeps the drop');
    await S.discoveryPanel({ keep: true });
    assert.deepEqual(tasteCalls(calls).at(-2).exclude, ['h1'], 'a return keeps the drop');
    assert.deepEqual([...storage.keys()], [DISCOVERYPAGE.STORAGE_KEYS.window], 'the window alone (the shared toggle is not written back)');
    assert.ok(![...storage.values()].some((v) => v.includes('h1')), 'the drop is never stored');
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls).at(-2).exclude, undefined, 'a fresh open forgets it');
    assert.equal(tasteCalls(calls).at(-2).window, 90, 'and remembers the window');
  });

  test('"Show all" opens the whole seed strip, and then reads Show less', async () => {
    const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 8 }, (_, i) => ({ hash: `m${i}`, filepath: `music/M/${i}.flac`, metadata: { title: `More ${i}` }, outcome: 'completed', plays: 1, pinned: false, analyzed: true }))] };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    openOptions(click);
    assert.match(S.page(), /data-dp="moreSeeds">dpage\.seeds\.showAll</);
    assert.ok(!seedsSection(S.page()).includes('dpage-sub'), 'no statistics line');
    click({ 'data-dp': 'moreSeeds' });
    assert.match(S.page(), /data-dp="moreSeeds">dpage\.seeds\.showLess/);
    assert.ok(S.page().includes('More 7'));
  });

  test('the window select lives in the bar (only), re-asks with the window and remembers it in localStorage', async () => {
    const { S, calls, change, storage } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
    const html = S.page();
    const bar = html.slice(html.indexOf('<div class="dpage-bar">'), html.indexOf('</label>', html.indexOf('<div class="dpage-bar">')));
    assert.match(bar, /dpage\.basedOnLast[\s\S]*data-dp-change="window"/);
    assert.equal(html.split('data-dp-change="window"').length, 2, 'one window form');
    assert.match(bar, /<option value="30" selected>/, 'the default window');
    const before = tasteCalls(calls).length;
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    const next = tasteCalls(calls).slice(before);
    assert.deepEqual(next.map((b) => b.window), [90, 90], 'both calls');
    assert.equal(storage.get(DISCOVERYPAGE.STORAGE_KEYS.window), '90');
    assert.match(S.page(), /<option value="90" selected>/);
    change({ 'data-dp-change': 'window' }, '14');
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, before + 2, 'not a window the route takes: nothing asked');
  });

  test('a fresh open reads the stored window back; a bad stored value is the default 30', async () => {
    for (const [raw, w] of [['0', 0], ['7', 7], ['junk', 30], ['', 30]]) {
      const { S, calls } = makeSandbox({ taste: answer, stored: { discoverPageWindow: raw } });
      await S.discoveryPanel();
      assert.deepEqual(tasteCalls(calls).map((b) => b.window), [w, w], raw);
      assert.match(S.page(), new RegExp(`<option value="${w}" selected>`), raw);
    }
  });

  test('every open asks again — no reuse of an earlier answer; refresh is the same question again', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const first = tasteCalls(calls);
    assert.equal(first.length, 2);
    await S.discoveryPanel({ keep: true });
    assert.deepEqual(tasteCalls(calls).slice(2), first, 'a return asks the same question again');
    await S.discoveryPanel();
    assert.deepEqual(tasteCalls(calls).slice(4), first, 'so does a fresh open');
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).slice(6), first, 'New seeds: same window and pins — the server draws the new batch');
    for (const gone of ['prefs', 'prefsKnown', 'rotation', 'skipped', 'mainAsked', 'peersPassed', 'key', 'at']) {
      assert.equal(gone in S.view, false, gone);
    }
  });
});

describe('Discover page: the configuration bar', () => {
  test('the bar: the window form, More options, then refresh — no tagline, no back link, no seed strip in the body', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.page();
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
    assert.match(S.page(), /dpage\.state\.nothingFinished/, 'the library answer is in');
    assert.ok(!S.page().includes('dpage-src-peers'), 'no peers skeleton re-flowing away');
    assert.ok(S.page().includes('dpage-songs dpage-songs-solo'));
    release();
    await run;
    // a later visit, both calls out: the one-column skeleton (the last
    // library answer had a random seed)
    gate = new Promise((r) => { release = r; });
    mainGate = gate;
    S.view.main = undefined;
    S.view.peers = undefined;
    const again = S.discoveryPanel();
    await flush();
    assert.match(S.page(), PAGE_BUSY, 'loading');
    assert.ok(!S.page().includes('dpage-src-peers'));
    assert.ok(S.page().includes('dpage-songs dpage-songs-solo'));
    release();
    await again;
  });

  test('no seed strip in the body in any state while closed', async () => {
    const RANDOM = { ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null, seeds: [{ hash: 'r1', filepath: 'music/R/Rand.flac', metadata: { title: 'Rand' }, outcome: null, plays: 0, pinned: false, analyzed: true }] };
    const pending = { ...MAIN, notAnalyzed: true, library: { albums: [], tracks: [] } };
    let release;
    const gate = new Promise((r) => { release = r; });
    const loading = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = loading.S.discoveryPanel();
    assert.match(loading.S.page(), PAGE_BUSY);
    assert.ok(!loading.S.page().includes('dpage-seeds'), 'loading');
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
      assert.match(S.page(), reached[name], `${name}: drawn`);
      assert.ok(!PAGE_BUSY.test(S.page()), `${name}: not still loading`);
      if (name === 'ready') { assert.ok(!S.page().includes('dpage-card'), 'ready: no state card'); }
      assert.ok(!S.page().includes('dpage-seeds'), name);
      assert.ok(S.page().includes('data-dp="options"'), `${name}: the bar is there`);
    }
  });

  test('More options opens the seed picker (no checkbox on Discover); the toggle reads Fewer options, then closes it', async () => {
    const { S, click } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    let html = S.page();
    const toggle = findDrawn(html, { 'data-dp': 'options' });
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    assert.equal(toggle.attrs['aria-controls'], 'dpage-options');
    assert.match(html, /data-dp="options"[^>]*>dpage\.bar\.fewerOptions/);
    const bar = html.indexOf('class="dpage-bar"');
    const panel = html.indexOf('class="dpage-options" id="dpage-options"');
    const seeds = html.indexOf('class="dpage-seeds"');
    const lib = html.indexOf('dpage-src-library');
    assert.ok(bar > 0 && panel > bar && seeds > panel && lib > seeds, 'bar, the picker, then the page');
    assert.match(html, /<div class="dpage-options" id="dpage-options"><section class="dpage-seeds">/, 'the picker first: no checkbox row');
    assert.match(seedsSection(html), /dpage\.seeds\.title/);
    assert.match(seedsSection(html), /data-dp="pick"/);
    assert.ok(!html.includes('dpage-opt-row') && !html.includes('role="checkbox"'), 'no filter on the page');
    assert.ok(!html.includes('data-dp="newArtists"'), 'new artists only is the Explore page\'s');
    assertTrimmed(html, 'picker open');
    openOptions(click);
    html = S.page();
    assert.equal(findDrawn(html, { 'data-dp': 'options' }).attrs['aria-expanded'], 'false');
    assert.ok(!html.includes('dpage-seeds'));
  });

  test('while the answer is still coming, the open drawer says the seeds wait', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S, click } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    openOptions(click);
    assert.match(S.page(), /class="dpage-options" id="dpage-options"><div class="dpage-hint">dpage\.bar\.seedsWait/);
    assert.ok(!S.page().includes('dpage.state.loading'), 'skeletons, no loading line');
    release();
    await run;
    assert.ok(S.page().includes('class="dpage-seeds"'), 'the chips arrive in the open picker');
  });

  test('a failed call with the picker open: its own waiting line, the failed text once', async () => {
    const { S, click } = makeSandbox({ taste: () => null });
    await S.discoveryPanel();
    openOptions(click);
    const html = S.page();
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
    assert.match(S.page(), /data-dp="options" aria-expanded="false"/);
  });

  test('the picker stays open across a drop, an Undo and a window change, and starts closed on a fresh open', async () => {
    const { S, click, change, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    assert.ok(S.page().includes('class="dpage-seeds"'), 'still open after the drop');
    toasts.find((o) => o.buttons).buttons[0][1]({ hide() {} }, {});
    await flush(); await flush();
    assert.ok(S.page().includes('class="dpage-seeds"'), 'still open after the Undo');
    change({ 'data-dp-change': 'window' }, '7');
    await flush(); await flush();
    assert.ok(S.page().includes('class="dpage-seeds"'), 'still open after a re-render');
    // a return to the page (an album opened from it, the song picker)
    await S.discoveryPanel({ keep: true });
    assert.ok(S.page().includes('class="dpage-seeds"'), 'a return keeps it');
    // a nav click: a fresh visit
    await S.discoveryPanel();
    assert.equal(S.view.optionsOpen, false);
    assert.ok(!S.page().includes('dpage-seeds'));
    assert.match(S.page(), /data-dp="options"[^>]*>dpage\.bar\.moreOptions/);
  });

  test('inside the picker: + Now playing pins, × unpins, × drops, Edit seeds shows the dropped ones (the answer\'s excluded) and Use again restores', async () => {
    const { S, calls, click } = makeSandbox({
      // the now-playing seed comes back only while it is pinned; the route
      // lists this call's exclusions in `excluded`
      taste: (b) => (b.sources.includes('peers') ? PEERS : { ...MAIN, excluded: echoExcluded(b), seeds: (b.pin ? SEEDS : SEEDS.slice(1)).filter((x) => !(b.exclude || []).includes(x.hash)) }),
      playing: PLAYING,
    });
    await S.discoveryPanel();
    // the pin was made at open: unpin it from inside the picker
    openOptions(click);
    assert.ok(!S.page().includes('data-dp="addPlaying"'), 'pinned already');
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'unpin', 'data-i': 0 });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).slice(before)[0].pin, undefined);
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'addPlaying' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).slice(before)[0].pin, ['music/Now/Playing.flac']);
    assert.ok(S.page().includes('class="dpage-seeds"'), 'still open');
    // × on a history seed: dropped for the visit
    assert.ok(!S.page().includes('data-dp="moreSeeds"'), 'nothing dropped yet: no Edit seeds');
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).exclude, ['h1']);
    assert.ok(!seedsSection(S.page()).includes('Seed &lt;One&gt;'), 'gone from the batch');
    // Edit seeds → the dropped list (the answer's excluded rows) → Use again
    click({ 'data-dp': 'moreSeeds' });
    let html = S.page();
    assert.ok(html.includes('dpage-dropped'));
    assert.match(seedsSection(html), /data-dp="restore" data-i="0"[^>]*>[\s\S]*?Gone h1[\s\S]*?dpage\.seeds\.dropped/);
    before = tasteCalls(calls).length;
    click({ 'data-dp': 'restore', 'data-i': 0 });
    await flush(); await flush();
    const next = tasteCalls(calls).slice(before);
    assert.equal(next.length, 2, 're-asked');
    assert.equal(next[0].exclude, undefined, 'without it');
    html = S.page();
    assert.ok(!html.includes('dpage-dropped') && !html.includes('Gone h1'), 'no dropped chips left');
    assert.ok(html.includes('class="dpage-seeds"'), 'still open');
    assert.deepEqual([...new Set(calls.map((c) => c.name))], ['taste']);
  });

  test('inside the picker: + Add a song… pins the picked song, and the page comes back with the picker open', async () => {
    const { S, calls, click, views, vpc } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    assert.ok(findDrawn(seedsSection(S.page()), { 'data-dp': 'pick' }), '+ Add a song… is in the picker');
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
    assert.ok(seedsSection(S.page()).includes('data-dp="pick"'), 'the picker shows the result');
  });
});

// The bar's host: #dpage-head sits in the #browser column's chrome, directly
// above the #filelist scroller (as #directory_bar does for the explorer), so
// the bar and the open picker never scroll; the sections stay in the list.
describe('Discover page: the bar lives outside the scroll box', () => {
  const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 8 }, (_, i) => ({ hash: `m${i}`, filepath: `music/M/${i}.flac`, metadata: { title: `More ${i}` }, outcome: 'completed', plays: 1, pinned: false, analyzed: true }))] };

  test('index.html: the host is in the #browser column, hidden, directly before #filelist', () => {
    const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8');
    const col = html.slice(html.indexOf('<div id="browser"'));
    assert.match(col, /<div id="dpage-head" class="super-hide"><\/div>\s*<div id="filelist">/);
    assert.ok(col.indexOf('id="directory_bar"') < col.indexOf('id="dpage-head"'), 'with the rest of the chrome');
  });

  test('the bar and the open picker draw in #dpage-head, the sections in #filelist', async () => {
    const { S, els, click } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const head = els.get('dpage-head');
    assert.equal(head.classList.contains('super-hide'), false, 'shown on render');
    assert.match(S.head(), /^<div class="dpage dpage-chrome dpage-page-play">\s*<div class="dpage-bar">/);
    for (const a of [{ 'data-dp-change': 'window' }, { 'data-dp': 'options' }, { 'data-dp': 'refresh' }]) {
      assert.ok(findDrawn(S.head(), a), `${JSON.stringify(a)} in the host`);
      assert.equal(findDrawn(S.html(), a), null, `${JSON.stringify(a)} not in the list`);
    }
    assert.ok(!S.html().includes('dpage-bar'), 'no bar in the scroll box');
    assert.ok(S.html().includes('dpage-src-library') && S.html().includes('dpage-src-peers'), 'the sections in the list');
    assert.ok(!S.head().includes('dpage-src-'), 'no section in the host');
    openOptions(click);
    assert.ok(S.head().includes('id="dpage-options"') && S.head().includes('class="dpage-seeds"'), 'the open picker in the host');
    assert.ok(!S.html().includes('dpage-options') && !S.html().includes('dpage-seeds'), 'not in the list');
    assert.ok(S.head().indexOf('dpage-bar') < S.head().indexOf('dpage-options'), 'under the bar');
  });

  test('busy and page classes ride on both roots; the loading flag stays on the list\'s', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    assert.match(S.html(), PAGE_BUSY);
    assert.ok(!PAGE_BUSY.test(S.head()), 'no aria-busy on the host');
    assert.ok(S.head().includes('data-dp="options"'), 'the bar shows while loading');
    release();
    await run;
    assert.ok(!S.head().includes('dpage-busy') && !S.html().includes('dpage-busy'), 'settled');
    // a re-ask holds the answer on screen, busy: both roots dim together
    let again;
    const hold = new Promise((r) => { again = r; });
    const next = makeSandbox({ taste: (b) => (b.window === 90 ? hold.then(() => answer(b)) : answer(b)) });
    await next.S.discoveryPanel();
    next.change({ 'data-dp-change': 'window' }, '90');
    await flush();
    assert.match(next.S.head(), /class="dpage dpage-chrome dpage-page-play dpage-busy"/);
    assert.match(next.S.html(), /class="dpage dpage-page-play dpage-busy"/);
    again();
    await flush(); await flush();
  });

  test('every bar and picker control works from the host', async () => {
    const { S, calls, click, change, toasts, views, vpc } = makeSandbox({
      taste: (b) => (b.sources.includes('peers') ? PEERS : { ...many, excluded: echoExcluded(b), seeds: (b.pin ? many.seeds : many.seeds.slice(1)).filter((x) => !(b.exclude || []).includes(x.hash)) }),
      playing: PLAYING,
    });
    await S.discoveryPanel();
    const inHead = (a) => { assert.ok(findDrawn(S.head(), a), `${JSON.stringify(a)} in the host`); assert.equal(findDrawn(S.html(), a), null, `${JSON.stringify(a)} not in the list`); };
    let n = tasteCalls(calls).length;
    inHead({ 'data-dp': 'refresh' });
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n + 2, 'refresh re-asks');
    n = tasteCalls(calls).length;
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    assert.equal(tasteCalls(calls).at(-1).window, 90, 'the window re-asks');
    inHead({ 'data-dp': 'options' });
    click({ 'data-dp': 'options' });
    assert.equal(S.view.optionsOpen, true);
    inHead({ 'data-dp': 'moreSeeds' });
    click({ 'data-dp': 'moreSeeds' });
    assert.ok(S.head().includes('More 7'), 'show all');
    inHead({ 'data-dp': 'unpin', 'data-i': 0 });
    click({ 'data-dp': 'unpin', 'data-i': 0 });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).at(-2).pin, undefined, 'unpinned');
    inHead({ 'data-dp': 'addPlaying' });
    click({ 'data-dp': 'addPlaying' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).pin, ['music/Now/Playing.flac'], '+ Now playing');
    inHead({ 'data-dp': 'drop', 'data-i': 1 });
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).exclude, ['h1'], 'dropped');
    toasts.find((o) => o.buttons).buttons[0][1]({ hide() {} }, {});
    await flush(); await flush();
    assert.equal(tasteCalls(calls).at(-2).exclude, undefined, 'Undo');
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    inHead({ 'data-dp': 'restore', 'data-i': 0 });
    click({ 'data-dp': 'restore', 'data-i': 0 });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).at(-2).exclude, undefined, 'Use again');
    inHead({ 'data-dp': 'pick' });
    click({ 'data-dp': 'pick' });
    S.setState([{ state: 'fileExplorer' }]);
    vpc.songCapture({ filepath: '/music/P/Picked.flac' });
    await views[views.length - 1]();
    await flush(); await flush();
    assert.deepEqual(tasteCalls(calls).at(-2).pin, ['music/Now/Playing.flac', 'music/P/Picked.flac'], '+ Add a song…');
    assert.ok(S.head().includes('class="dpage-seeds"'), 'back with the picker open, in the host');
  });

  test('the keyboard comes back to the host\'s control after a re-render', async () => {
    const { S, keyClick, focused, focusedIn, activeAttrs } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    keyClick({ 'data-dp': 'options' });
    assert.equal(focused.at(-1), 'options');
    assert.equal(focusedIn.at(-1), 'dpage-head');
    keyClick({ 'data-dp': 'moreSeeds' });
    assert.equal(focused.at(-1), 'moreSeeds');
    assert.equal(focusedIn.at(-1), 'dpage-head');
    assert.equal(activeAttrs()['data-dp'], 'moreSeeds');
    keyClick({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(focused.at(-1), 'refresh', 'the ⟳ keeps the keyboard across the new answer');
    assert.equal(focusedIn.at(-1), 'dpage-head');
  });

  test('the host hides (and empties) when another panel takes over, and shows again on the way back', async () => {
    const { S, els } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const head = els.get('dpage-head');
    assert.equal(head.classList.contains('super-hide'), false);
    S.setState([{ state: 'allAlbums' }]);
    S.setBrowserRootPanel('panel.albums');
    assert.equal(head.classList.contains('super-hide'), true, 'hidden on another panel');
    assert.equal(S.head(), '', 'and emptied');
    await S.discoveryPanel({ keep: true });
    assert.equal(head.classList.contains('super-hide'), false, 'back on the page');
    assert.ok(S.head().includes('dpage-bar'));
  });

  test('an album opened from the page hides the host with the directory bar restored', () => {
    const fn = sliceFn('getAlbumSongs');
    const branch = fn.slice(fn.indexOf("under.state === 'discovery'"), fn.indexOf('}', fn.indexOf("under.state === 'discovery'")));
    assert.ok(branch.includes("document.getElementById('directory_bar').style.display = ''"));
    assert.ok(branch.includes('discoveryHideHead()'));
    assert.ok(sliceFn('setBrowserRootPanel').includes('discoveryHideHead()'), 'every root panel hides it');
  });

  test('the capped picker keeps its own scroll across a redraw (it is redrawn with the host)', async () => {
    const { S, els, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    const head = els.get('dpage-head');
    assert.equal(head.querySelector('.dpage-options'), null, 'no picker while closed');
    openOptions(click);
    const first = head.querySelector('.dpage-options');
    assert.equal(first.scrollTop, 0);
    first.scrollTop = 240;
    click({ 'data-dp': 'moreSeeds' });
    const second = head.querySelector('.dpage-options');
    assert.notEqual(second, first, 'a new picker element');
    assert.equal(second.scrollTop, 240, 'scrolled where the user left it');
    // closed and opened again: the picker starts at its top
    openOptions(click);
    openOptions(click);
    assert.equal(head.querySelector('.dpage-options').scrollTop, 0);
  });

  test('no host in the page (an older index.html): the bar heads the list instead of vanishing', async () => {
    const { S, click, change, calls } = makeSandbox({ taste: answer, playing: PLAYING, noHead: true });
    await S.discoveryPanel();
    assert.ok(S.html().includes('class="dpage-bar"'), 'the bar in the list');
    assert.ok(S.html().indexOf('dpage-bar') < S.html().indexOf('dpage-src-library'), 'above the sections');
    openOptions(click);
    assert.ok(S.html().includes('class="dpage-seeds"'), 'the picker opens there too');
    const n = tasteCalls(calls).length;
    change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    assert.ok(tasteCalls(calls).length > n, 'its controls work');
    S.setState([{ state: 'allAlbums' }]);
    S.setBrowserRootPanel('panel.albums');
  });

  test('off and unavailable draw no bar: the host is hidden', async () => {
    for (const ping of [null, { discovery: true, discoveryTaste: 1 }]) {
      const { S, els } = makeSandbox({ taste: () => ({ disabled: true }), ping });
      await S.discoveryPanel();
      await flush();
      assert.match(S.html(), /dpage-off/);
      assert.equal(els.get('dpage-head').classList.contains('super-hide'), true);
      assert.equal(S.head(), '');
    }
  });

  test('Explore: its bar and "new artists only" in the host, its network list in the scroll box', async () => {
    const { S, click } = makeSandbox({ taste: answer });
    await S.discoveryPanel({ page: 'explore' });
    assert.match(S.head(), /^<div class="dpage dpage-chrome dpage-page-explore/);
    assert.ok(S.html().includes('dpage-sec-network'));
    assert.ok(!S.head().includes('dpage-sec-network'));
    openOptions(click);
    assert.ok(findDrawn(S.head(), { 'data-dp': 'newArtists' }));
    assert.equal(findDrawn(S.html(), { 'data-dp': 'newArtists' }), null);
  });
});

describe('Discover page: New seeds (the bar\'s ⟳)', () => {
  const fin = (n) => ({ hash: `f${n}`, filepath: `music/F/${n}.flac`, metadata: { title: `Fin ${n}`, artist: 'Hal' }, outcome: 'completed', lastPlayed: '2026-10-04T21:10:00.000Z', plays: 1, pinned: false, analyzed: true });
  // The server's pick (src/api/discovery-taste.js collectSeeds): the pins,
  // then a RANDOM batch of the finished songs not excluded — a different
  // one on every call (here: the next two of eight, round and round, per
  // source).
  const server = () => {
    const draws = { library: 0, peers: 0 };
    const all = Array.from({ length: 8 }, (_, i) => fin(i + 1));
    return (body) => {
      const ex = new Set(body.exclude || []);
      const pins = (body.pin || []).map((p) => (p === SEEDS[0].filepath ? SEEDS[0] : all.find((x) => x.filepath === p))).filter(Boolean);
      const room = Math.min(2, ((body.limit && body.limit.seeds) || 12) - pins.length);
      const pool = all.filter((x) => !ex.has(x.hash) && !pins.includes(x));
      const at = (draws[body.sources[0]]++ * 2) % pool.length;
      const res = { ...MAIN, seeds: [...pins, ...(room > 0 ? pool.slice(at, at + room) : [])], excluded: echoExcluded(body) };
      return body.sources.includes('peers') ? { ...PEERS, ...res, library: null, network: null, peers: PEERS.peers } : res;
    };
  };
  const press = async (click) => { click({ 'data-dp': 'refresh' }); await flush(); await flush(); };

  test('the bar\'s button says what it does: "New seeds" (title and aria-label)', async () => {
    const { S } = makeSandbox({ taste: server() });
    await S.discoveryPanel();
    const btn = findDrawn(S.page(), { 'data-dp': 'refresh' });
    assert.equal(btn.attrs.title, 'dpage.verb.newSeeds');
    assert.equal(btn.attrs['aria-label'], 'dpage.verb.newSeeds');
  });

  test('a press is a plain new ask with the same window, pins and drops — no exclude of its own, never remembered', async () => {
    const { S, calls, click, change } = makeSandbox({ taste: server(), playing: PLAYING });
    await S.discoveryPanel();
    change({ 'data-dp-change': 'window' }, '7');
    await flush(); await flush();
    openOptions(click);
    const dropped = S.view.shown.chips[1].hash;
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const asked = tasteCalls(calls).slice(-2);
    assert.deepEqual(asked[0].exclude, [dropped]);
    assert.equal(asked[0].window, 7);
    for (let p = 0; p < 3; p++) {
      const before = tasteCalls(calls).length;
      await press(click);
      const next = tasteCalls(calls).slice(before);
      assert.deepEqual(next[0], asked[0], `press ${p + 1}: the same library body`);
      // the peers body: the same question, seeded from this press's batch
      const { pin, limit, ...rest } = next[1];
      const { pin: _p, limit: _l, ...askedRest } = asked[1];
      assert.deepEqual(rest, askedRest, `press ${p + 1}: the same peers body`);
      assert.deepEqual(pin, S.view.main.seeds.map((x) => x.filepath), `press ${p + 1}: pinned to the batch drawn`);
      assert.equal(limit.seeds, pin.length);
    }
    for (const b of tasteCalls(calls)) { assert.equal('remember' in b, false); }
  });

  test('the picker shows the batch each answer was built from — and no "dropped" chips for the songs it replaced', async () => {
    const { S, click } = makeSandbox({ taste: server(), playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    assert.match(seedsSection(S.page()), /Now Song[\s\S]*Fin 1[\s\S]*Fin 2/);
    await press(click);
    const seeds = seedsSection(S.page());
    assert.match(seeds, /Now Song[\s\S]*Fin 3[\s\S]*Fin 4/, 'the pin, then the server\'s new batch');
    assert.ok(!/Fin [12]\b/.test(seeds), 'the last batch is gone from the strip');
    assert.ok(!S.page().includes('Gone ') && !S.page().includes('dpage-dropped'), 'never drawn as dropped');
    assert.ok(!S.page().includes('data-dp="moreSeeds"'), 'no Edit seeds for them');
  });

  test('the answer on screen stays drawn (busy, not loading) until the new one lands', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    let n = 0;
    const base = server();
    const { S, click } = makeSandbox({
      taste: (b) => {
        n++;
        if (n <= 2) { return base(b); }
        return late.then(() => {
          const res = base(b);
          return res.library ? { ...res, library: { ...MAIN.library, tracks: [{ ...MAIN.library.tracks[0], metadata: { title: 'Fresh Pick', artist: 'New' } }] } } : res;
        });
      },
      playing: PLAYING,
    });
    await S.discoveryPanel();
    assert.match(S.page(), /Title Seven/);
    click({ 'data-dp': 'refresh' });
    await flush();
    assert.equal(n, 3, 'asked (the library first; the peers call waits for its seeds)');
    let html = S.page();
    assert.match(html, /<div class="dpage dpage-page-play dpage-busy">/, 'busy');
    assert.ok(!PAGE_BUSY.test(html), 'not the loading state');
    assert.match(html, /Title Seven/, 'the old rows stay');
    assert.ok(!/dpage-skel/.test(html), 'no skeletons');
    release();
    await flush(); await flush(); await flush();
    html = S.page();
    assert.match(html, /Fresh Pick/);
    assert.ok(!html.includes('dpage-busy'));
  });

  test('a fresh open draws the last answer busy until the new one lands; a failed one is not drawn again', async () => {
    let gate = null;
    let fail = false;
    const base = server();
    const { S } = makeSandbox({ taste: (b) => (fail ? null : (gate ? gate.then(() => base(b)) : base(b))) });
    await S.discoveryPanel();
    let release;
    gate = new Promise((r) => { release = r; });
    const again = S.discoveryPanel();
    assert.match(S.page(), /<div class="dpage dpage-page-play dpage-busy">/);
    assert.match(S.page(), /Title Seven/, 'the last answer, busy');
    release();
    await again;
    assert.ok(!S.page().includes('dpage-busy'));
    gate = null;
    fail = true;
    await S.discoveryPanel();
    assert.match(S.page(), /dpage\.state\.failed/);
    fail = false;
    gate = new Promise((r) => { release = r; });
    const third = S.discoveryPanel();
    assert.match(S.page(), PAGE_BUSY, 'the loading state, not the failed card');
    assert.ok(!S.page().includes('dpage.state.failed'));
    release();
    await third;
  });

  test('the old rotation and its cycled card are gone', async () => {
    const RANDOM = { ...MAIN, seedSource: 'random', fallback: true, network: null, peers: null, seeds: [{ ...fin(99), hash: 'r1', outcome: null }] };
    const { S, calls, click } = makeSandbox({ taste: () => RANDOM, flags: NO_FED });
    await S.discoveryPanel();
    await press(click);
    await press(click);
    const html = S.page();
    assert.match(html, /dpage\.state\.nothingFinished/, 'a random pick is "finish a few songs", however often New seeds is pressed');
    assert.ok(!html.includes('seedsCycled') && !html.includes('data-v="card"'));
    assert.ok(tasteCalls(calls).every((b) => !('exclude' in b)));
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
    const html = S.page();
    assert.match(html, /class="dpage dpage-page-explore/);
    assert.ok(html.includes('dpage-sec-network') && html.includes('dpage.network.title'));
    assert.match(html, /data-dp="lead" data-i="0"/);
    assert.ok(html.includes('Far &lt;Server&gt;'), 'escaped');
    assert.ok(!html.includes('dpage-src-library') && !html.includes('dpage-src-peers'), 'no library, no connected servers');
  });

  test('a lead opens its window, matched against its own seed', async () => {
    const { S, click, opened } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel({ page: 'explore' });
    const lead = findDrawn(S.page(), { 'data-dp': 'lead', 'data-i': 0 });
    assert.equal(lead.tag, 'button');
    assert.ok(lead.attrs['aria-label']);
    click({ 'data-dp': 'lead', 'data-i': 0 });
    assert.equal(opened[0].source, 'p2p');
    assert.equal(opened[0].raw, MAIN.network.results[0], 'the route\'s own row, unchanged');
    assert.deepEqual(opened[0].opts, { seedTitle: 'Seed <One>' }, 'h1, the seed the lead was matched against (escaped by Vue)');
  });

  test('"new artists only" sits in its More options, re-asks and is remembered in the panel\'s shared key', async () => {
    const { S, calls, click, storage } = makeSandbox({ taste: answer });
    await S.discoveryPanel({ page: 'explore' });
    openOptions(click);
    const html = S.page();
    assert.match(html, /<div class="dpage-options" id="dpage-options"><div class="dpage-opt-row"><button[^>]*data-dp="newArtists"/);
    const box = findDrawn(html, { 'data-dp': 'newArtists' });
    assert.equal(box.attrs['aria-checked'], 'false');
    assert.equal(box.attrs.role, 'checkbox');
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'newArtists' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).slice(before)[0].newArtistsOnly, true);
    assert.equal(storage.get('discoverNewArtistsOnly'), 'true');
    assert.equal(findDrawn(S.page(), { 'data-dp': 'newArtists' }).attrs['aria-checked'], 'true');
    // a fresh open reads it back; the play page never sends it
    await S.discoveryPanel({ page: 'explore' });
    assert.equal(tasteCalls(calls).at(-1).newArtistsOnly, true);
    await S.discoveryPanel();
    assert.ok(tasteCalls(calls).slice(-2).every((b) => b.newArtistsOnly === false));
  });

  test('a return keeps the page; a nav click is Discover again', async () => {
    const { S, calls } = makeSandbox({ taste: answer });
    await S.discoveryPanel({ page: 'explore' });
    await S.discoveryPanel({ keep: true });
    assert.equal(S.view.page, 'explore');
    await S.discoveryPanel();
    assert.equal(S.view.page, 'play');
    assert.deepEqual(tasteCalls(calls).at(-2).sources, ['library']);
    assert.ok(S.page().includes('dpage-src-library'));
    assert.ok(!S.page().includes('dpage-sec-network'), 'the network answer is not drawn on Discover');
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
    const loading = S.page();
    assert.match(loading, PAGE_BUSY, 'the page\'s own loading state, at once');
    S.bump();   // a server switch / peer adoption superseded the load
    release();
    await run;
    assert.equal(S.page(), loading, 'the stale answer never drew');
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
    assert.equal(tasteCalls(calls).length, 3, 'asked again (the dropped load never reached its peers call)');
    assert.ok(S.page().includes('Title Seven'), 'and drew');
    release();
    await run;
    assert.ok(S.page().includes('Title Seven'), 'the dropped answer changed nothing');
  });

  test('an answer that lands while another panel is up is kept but not drawn', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    await flush();
    const loading = S.page();
    S.setState([{ state: 'allAlbums' }]);
    release();
    await run;
    assert.equal(S.page(), loading);
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
    const html = S.page();
    assert.match(html, /dpage-badge-src">discover\.job\.downloading/);
    assert.match(html, /<div class="dpage-prog"><i style="width:64%"><\/i><\/div>/);
    assert.match(html, /dpage\.plugins\.getIt/);
  });

  test('the play page looks nothing up (its rows carry no badge)', async () => {
    const { S, calls } = badgeBox();
    await S.discoveryPanel();
    assert.equal(calls.filter((c) => c.name === 'lookup').length, 0);
    assert.ok(!S.page().includes('dpage-badge'));
  });

  test('a poll tick redraws only a badge that changed, in place; an unchanged tick draws nothing', async () => {
    const { S, tick, patches, renders } = badgeBox();
    await S.discoveryPanel({ page: 'explore' });
    const drawn = renders();
    const html = S.page();
    tick([JOB]);
    assert.equal(patches.length, 0, 'nothing changed: nothing drawn');
    tick([{ ...JOB, progress: 0.5 }]);
    assert.equal(renders(), drawn, 'no whole-page draw on the poll');
    assert.equal(S.page(), html);
    const bar = patches.find((pt) => pt.slot === 'data-pslot' && pt.id === 'n0');
    assert.ok(bar && /width:50%/.test(bar.html), 'the lead\'s bar moved');
    assert.ok(patches.some((pt) => pt.slot === 'data-bslot' && pt.id === 'n0'));
  });

  test('a return asks again, looks its rows up again, listens again and catches the badges up', async () => {
    const { S, tick, liveWatches, calls } = badgeBox();
    await S.discoveryPanel({ page: 'explore' });
    assert.equal(liveWatches(), 1);
    S.setState([{ state: 'allAlbums' }]);   // the user left
    tick([{ ...JOB, progress: 0.3 }]);
    assert.equal(liveWatches(), 0, 'the watch ends once the page is left');
    tick([{ ...JOB, progress: 0.9 }]);       // moved while away (no one listening)
    const lookups = calls.filter((c) => c.name === 'lookup').length;
    const asks = tasteCalls(calls).length;
    await S.discoveryPanel({ page: 'explore' }); // back: no earlier answer is reused
    assert.equal(tasteCalls(calls).length, asks + 1, 'asked again');
    assert.equal(calls.filter((c) => c.name === 'lookup').length, lookups + 1, 'the new rows looked up');
    assert.equal(liveWatches(), 1, 'listening again (one watch)');
    assert.match(S.page(), /width:90%/, 'the badge caught up');
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
    // the configuration bar sits in the column's chrome (#dpage-head), not
    // stuck inside the scroller; the host's open picker is height-capped
    const barRule = page.match(/\n\.dpage-bar \{[^}]*\}/);
    assert.ok(barRule, 'the bar\'s rule');
    assert.ok(!/position:\s*sticky/.test(barRule[0]), 'the bar is not sticky');
    assert.match(page, /#dpage-head \{[^}]*flex-shrink: 0;[^}]*background: #262a33;[^}]*border-bottom: 1px solid #2c313a;/);
    assert.match(page, /#dpage-head \.dpage-options \{[^}]*max-height: 45vh;[^}]*overflow-y: auto;/);
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

describe('Discover page: one batch per ask, one visit per open', () => {
  test('the connected-server call waits for the library answer and pins every seed of its batch (a full 12)', async () => {
    const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 9 }, (_, i) => ({ ...SEEDS[1], hash: `m${i}`, filepath: `music/M/${i}.flac` }))] };
    assert.equal(many.seeds.length, 12, 'the server\'s largest batch');
    assert.equal(DISCOVERYPAGE.PIN_CAP, 12, 'PIN_CAP = the seed cap');
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S, calls } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : gate.then(() => many)), playing: PLAYING });
    const run = S.discoveryPanel();
    await flush();
    assert.deepEqual(tasteCalls(calls).map((b) => b.sources), [['library']], 'nothing asks the connected servers before the batch is known');
    release();
    await run;
    const peers = tasteCalls(calls)[1];
    assert.deepEqual(peers.pin, many.seeds.map((x) => x.filepath), 'every seed, in the batch\'s order');
    assert.equal(peers.limit.seeds, 12);
  });

  test('when the new batch lands, the old connected column goes to its skeleton — never drawn under the new seeds', async () => {
    let gate = null;
    let release;
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') && gate ? gate.then(() => PEERS) : answer(b)), playing: PLAYING });
    await S.discoveryPanel();
    assert.ok(S.page().includes('Peer Song'));
    gate = new Promise((r) => { release = r; });
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(S.view.pending.main, false);
    assert.equal(S.view.pending.peers, true);
    assert.ok(!S.page().includes('Peer Song'), 'the old column is gone');
    assert.match(S.page(), /dpage-skel/, 'its skeleton instead');
    release();
    await flush(); await flush();
    assert.ok(S.page().includes('Peer Song'));
    assert.ok(!S.page().includes('dpage-busy'));
  });

  test('a drop toast\'s Undo after a fresh open (or off the page) asks nothing', async () => {
    const { S, calls, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const undo = toasts.find((o) => o.buttons).buttons[0][1];
    await S.discoveryPanel();
    let n = tasteCalls(calls).length;
    undo({ hide() {} }, {});
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n, 'the drop is already forgotten');
    // dropped again, then the page is left: the list changes, nothing is asked
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    const undo2 = toasts.filter((o) => o.buttons).at(-1).buttons[0][1];
    S.setState([{ state: 'somewhere-else' }]);
    n = tasteCalls(calls).length;
    undo2({ hide() {} }, {});
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n, 'no off-screen ask');
    assert.deepEqual(S.view.excluded, []);
  });

  test('a fresh open does not offer back the last visit\'s drops while it asks', async () => {
    let gate = null;
    const { S, click } = makeSandbox({
      taste: (b) => {
        const res = b.exclude ? { ...answer(b), excluded: echoExcluded(b) } : answer(b);
        return gate ? gate.then(() => res) : res;
      },
      playing: PLAYING,
    });
    await S.discoveryPanel();
    openOptions(click);
    click({ 'data-dp': 'drop', 'data-i': 1 });
    await flush(); await flush();
    click({ 'data-dp': 'moreSeeds' });
    assert.ok(seedsSection(S.page()).includes('Gone h1'), 'dropped this visit');
    let release;
    gate = new Promise((r) => { release = r; });
    const run = S.discoveryPanel();
    S.view.optionsOpen = true;
    S.view.allSeeds = true;
    S.renderDiscovery();
    assert.match(S.page(), /dpage-busy/, 'the held answer, busy');
    assert.ok(!S.page().includes('Gone h1'), 'its excluded[] belongs to the last visit');
    release();
    await run;
  });

  test('a window change writes the window alone — the panel\'s "new artists only" stays as the panel left it', async () => {
    const key = DISCOVERYPAGE.STORAGE_KEYS.newArtistsOnly;
    const { S, change, storage } = makeSandbox({ taste: answer, stored: {} });
    await S.discoveryPanel();
    storage.set(key, 'true');   // the now-playing panel ticked it meanwhile
    change({ 'data-dp-change': 'window' }, '7');
    await flush(); await flush();
    assert.equal(storage.get(key), 'true');
    assert.equal(storage.get(DISCOVERYPAGE.STORAGE_KEYS.window), '7');
  });
});
