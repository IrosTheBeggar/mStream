/**
 * The Discover page's m.js half (docs/discovery-page-plan.md §4.1): the
 * panel that wires alpha/discovery-page.js (DISCOVERYPAGE) to the app.
 *
 * What is pinned:
 *   - opening the page fires the two parallel taste calls the plan names
 *     (library+network, peers) with the now-playing song pinned, reads the
 *     saved prefs once, and draws the seed chips, the three sections, the
 *     library's album cards and song rows, the network leads and the peer
 *     groups — every value escaped;
 *   - a random seed draws the "finish a few songs" card, and Another pick
 *     re-asks with that pick excluded (never remembered);
 *   - dropping a seed re-asks with exclude + remember; a filter chip
 *     re-asks with the new filter;
 *   - an answer that lands after the app moved on (browseGeneration bumped)
 *     is dropped;
 *   - job badges come from the batch lookup, a poll tick patches only the
 *     badges that changed, and a return within the TTL listens again;
 *   - a 403 re-pings before naming a reason, and takes the panel's link too;
 *   - a prefs GET that failed is asked again before a drop;
 *   - index.html carries the nav entry and the script, en.json carries
 *     every dpage.* key the module and the panel use (and no other).
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
  'discoveryWatchJobs', 'discoveryMergeJobs', 'discoveryPatchBadges', 'discoveryLeadTag', 'discoveryPeerTag',
  'discoveryMatchOpts', 'discoveryDropSeed', 'discoveryT', 'discoveryText', 'discoveryOnScreen', 'discoveryNowPlayingPath',
  'discoveryLocalPrefs', 'discoverySaveLocalPrefs', 'discoveryPanel', 'redoDiscovery', 'discoveryOff',
  'discoveryResponse', 'discoveryLoadBadges', 'renderDiscovery', 'discoveryHeadHtml', 'discoveryCardHtml',
  'discoverySeedsHtml', 'discoverySegHtml', 'discoverySectionHtml', 'discoveryEmptyHtml', 'discoverySeeAll',
  'discoveryMeter', 'discoveryLibraryHtml', 'discoveryBadgeHtml', 'discoveryProgressHtml',
  'discoveryNetworkHtml', 'discoveryPeersHtml', 'onDiscoveryChange', 'onDiscoveryClick', 'discoveryAction',
  'discoveryRestoreSeed', 'discoveryQueueAll'];

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
// The drawn element matching every attr — a button or link first.
function findDrawn(html, attrs) {
  const hits = tagsOf(html).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === String(v)));
  return hits.find((el) => el.tag === 'button' || el.tag === 'a') || hits[0] || null;
}

// One stubbed app around the sliced functions.
//   taste(body)   answers MSTREAMAPI.discoveryTaste (a value or a promise)
//   prefs         GET …/taste/prefs's answer (a function: called per GET)
//   ping          MSTREAMAPI.ping's answer (the re-ping after a 403)
//   playing       MSTREAMPLAYER.getCurrentSong()
//   lookup(recs)  MSTREAMAPI.discoveryJobLookupBatch
//   jobs          VUEPLAYERCORE.discoverJobs() (the strip's last poll)
function makeSandbox({ taste, prefs = { window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: true }, ping = null, playing = null, flags = FLAGS_ALL, lookup = null, plugins = null, jobs = [] } = {}) {
  const els = new Map();
  const pageHandlers = {};
  const patches = [];
  let renders = 0;
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
    Object.defineProperty(el, 'innerHTML', { get: () => inner, set: (h) => { inner = h; if (id === 'filelist') { renders++; } } });
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
  const globals = {
    document: {
      body: { classList: bodyClasses },
      getElementById: (id) => els.get(id) ?? null,
      getElementsByClassName: () => [],
      querySelector: () => null,
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
    changeView: () => {},
    createPopper3: () => {},
    myModal: { open() {}, close() {} },
    openSavePlaylistModal: () => {},
    loadFileExplorer: () => {},
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let peerContext = null;
    let browseGeneration = 0;
    ${sliceConst('entityMap')}
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
  const click = (attrs) => {
    const found = findDrawn(S.html(), attrs);
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    const el = { tagName: found.tag.toUpperCase(), getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) };
    pageHandlers.click({ target: { closest: () => el } });
  };
  const change = (attrs, value) => {
    const found = findDrawn(S.html(), attrs);
    assert.ok(found, `nothing drawn with ${JSON.stringify(attrs)}`);
    pageHandlers.change({ target: { value, getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) } });
  };
  // A poll of the strip's job list: every live watch hears it.
  const tick = (list) => { currentJobs = list; for (const w of watchers.slice()) { if (w.live) { w.fn(list.slice()); } } };
  const liveWatches = () => watchers.filter((w) => w.live).length;
  return { S, calls, storage, queued, opened, fedQueued, toasts, els, click, change, tick, liveWatches, watchers, patches, renders: () => renders, bodyClasses };
}

const tasteCalls = (calls) => calls.filter((c) => c.name === 'taste').map((c) => c.body);
const flush = () => new Promise((r) => setImmediate(r));

// ── fixtures (the server's shapes: src/api/discovery-taste.js) ──────────

const SEEDS = [
  { hash: 'h-np', filepath: 'music/Now/Playing.flac', metadata: { title: 'Now Song', artist: 'Now Artist' }, outcome: null, lastPlayed: null, plays: 0, pinned: true, analyzed: true },
  { hash: 'h1', filepath: 'music/A/One.flac', metadata: { title: 'Seed <One>', artist: 'Ann' }, outcome: 'completed', lastPlayed: '2026-10-04T21:10:00.000Z', plays: 3, pinned: false, analyzed: true },
  { hash: 'h2', filepath: 'music/B/Two.flac', metadata: { title: 'Seed Two', artist: 'Bob' }, outcome: 'completed', lastPlayed: '2026-10-03T21:10:00.000Z', plays: 1, pinned: false, analyzed: true },
];

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
      { filepath: 'music/J/Seven.flac', similarity: 0.83, seedHash: 'h1', metadata: { title: 'Title Seven', artist: 'Jay', album: 'Album Seven', duration: 200 }, genreTags: ['Electronic---Synthwave'], playCount: 0, lastPlayed: null },
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

const PEERS = {
  ...MAIN, library: null, network: null,
  peers: {
    peers: [
      { id: 1, name: 'Sam\'s server', reachable: true, mismatched: false, lastSeen: '2026-10-05T00:00:00.000Z',
        results: [{ source: 'federation', seedHash: null, peer: { id: 1, name: 'Sam\'s server' }, filepath: 'tunes/P/One.mp3', title: 'Peer Song', artist: 'Quinn', album: 'Peer Album', duration: 210, similarity: 0.85 }] },
      { id: 2, name: 'Peer <B>', reachable: false, mismatched: false, lastSeen: '2026-10-03T00:00:00.000Z', results: [] },
    ],
    searched: { peers: 1, unreachable: 1, mismatched: 0 },
  },
};

const answer = (body) => (body.sources.includes('peers') ? PEERS : MAIN);
const PLAYING = { rawFilePath: '/music/Now/Playing.flac', metadata: { title: 'Now Song' } };

describe('Discover page: opening it', () => {
  test('two parallel taste calls — library+network and peers — with now playing pinned, prefs read once', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    assert.deepEqual(S.state(), [{ state: 'discovery' }]);
    assert.equal(calls.filter((c) => c.name === 'prefs').length, 1);
    const [main, peers] = tasteCalls(calls);
    assert.deepEqual(main.sources, ['library', 'network']);
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['music/Now/Playing.flac'], 'the leading / is stripped');
    assert.deepEqual(peers.pin, main.pin, 'both calls agree on the seeds');
    assert.equal(main.window, 30);
    assert.equal(main.filter, 'fresh');
    assert.equal(main.remember, undefined, 'opening the page saves nothing');
  });

  test('a federated now-playing song is never pinned', async () => {
    const { S, calls } = makeSandbox({ taste: answer, playing: { rawFilePath: 'x/y.mp3', federation: { peerId: 1 } } });
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls)[0].pin, undefined);
  });

  test('draws the seed chips, the three sections, album cards, song rows, leads and peer groups', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    // seeds: the pin reads "playing" and has an unpin ×; history seeds drop
    assert.match(html, /data-dp="unpin" data-i="0"/);
    assert.match(html, /data-dp="drop" data-i="1"/);
    assert.match(html, /dpage\.seeds\.playing/);
    assert.match(html, /dpage\.seeds\.finished/);
    assert.ok(html.includes('Seed &lt;One&gt;'), 'seed titles are escaped');
    assert.ok(!html.includes('Seed <One>'));
    assert.match(html, /data-dp="pick"/, '+ Add a song…');
    // three sections, in order
    const lib = html.indexOf('dpage-sec-library');
    const net = html.indexOf('dpage-sec-network');
    const peers = html.indexOf('dpage-sec-peers');
    assert.ok(lib > 0 && net > lib && peers > net, 'library, network, peers');
    for (const k of ['dpage.library.title', 'dpage.network.title', 'dpage.peers.title']) { assert.ok(html.includes(k), k); }
    // library: an album card (renderAlbum's own markup) and its facts
    assert.match(html, /class="album-grid dpage-albums"/);
    assert.match(html, /class="album-grid-card"[^>]*data-album-artist="Fay"[^>]*data-album="Album &lt;One&gt;"/);
    assert.match(html, /<span class="dpage-album-badge">84%<\/span>/);
    assert.match(html, /dpage\.album\.neverPlayed/);
    // library: song rows with their when-label and verbs
    assert.ok(html.includes('Title Seven') && html.includes('Title Eight'));
    assert.match(html, /dpage\.when\.never/);
    assert.match(html, /data-dp="play" data-i="0"/);
    assert.match(html, /data-dp="more" data-i="1" data-file_location="music&#x2F;K&#x2F;Eight.flac"/);
    assert.match(html, /data-dp="queueAll"/);
    // network: the lead, the server named and escaped, the searched line
    assert.match(html, /data-dp="lead" data-i="0"/);
    assert.ok(html.includes('Far &lt;Server&gt;'));
    assert.match(html, /dpage\.network\.searched\{&quot;count&quot;:3\}/);
    // peers: one group per server, answering first; the dead one dimmed
    assert.ok(html.indexOf('Sam&#39;s server') < html.indexOf('Peer &lt;B&gt;'));
    assert.match(html, /dpage-peer-dot off/);
    assert.match(html, /data-dp="listen" data-i="0"/);
    assert.match(html, /dpage\.peers\.answered/);
    // the phone fold has a tab per source
    assert.match(html, /data-dp="source" data-v="library"/);
    assert.match(html, /data-dp="source" data-v="peers"/);
  });

  test('row verbs: library queue/play, a lead opens its window, a peer row listens / queues / opens', async () => {
    const { S, click, queued, opened, fedQueued } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    click({ 'data-dp': 'queue', 'data-i': 0 });
    assert.deepEqual(queued[0].slice(0, 2), ['music/J/Seven.flac', MAIN.library.tracks[0].metadata]);
    click({ 'data-dp': 'play', 'data-i': 1 });
    assert.equal(queued[1][0], 'music/K/Eight.flac');
    assert.equal(queued[1][3], 3, 'play now = right after the playing song');
    click({ 'data-dp': 'lead', 'data-i': 0 });
    assert.equal(opened[0].source, 'p2p');
    assert.equal(opened[0].raw, MAIN.network.results[0], 'the route\'s own row, unchanged');
    click({ 'data-dp': 'listen', 'data-i': 0 });
    assert.equal(fedQueued[0][0], 'play');
    assert.deepEqual(fedQueued[0][1], { id: 1, name: 'Sam\'s server' });
    assert.equal(fedQueued[0][2], 'tunes/P/One.mp3');
    click({ 'data-dp': 'fedQueue', 'data-i': 0 });
    assert.equal(fedQueued[1][1], PEERS.peers.peers[0].results[0]);
    click({ 'data-dp': 'peerMore', 'data-i': 0 });
    assert.equal(opened[1].source, 'federation');
  });

  test('a section the ping does not advertise is not drawn at all', async () => {
    const { S, calls } = makeSandbox({ taste: () => ({ ...MAIN, network: null }), flags: { ...FLAGS_ALL, discoveryP2p: false, federationDiscovery: false } });
    await S.discoveryPanel();
    assert.equal(tasteCalls(calls).length, 1, 'no peers call');
    assert.deepEqual(tasteCalls(calls)[0].sources, ['library']);
    const html = S.html();
    assert.ok(html.includes('dpage-sec-library'));
    assert.ok(!html.includes('dpage-sec-network') && !html.includes('dpage-sec-peers'));
    assert.ok(!html.includes('dpage-seg"'), 'one source: no switch');
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

  test('the recommendation window names the row\'s own seed; a peers row (the centroid) a phrase', async () => {
    const { S, click, opened } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    click({ 'data-dp': 'lead', 'data-i': 0 });
    assert.deepEqual(opened[0].opts, { seedTitle: 'Seed <One>' }, 'h1, the seed the lead was matched against (escaped by Vue)');
    click({ 'data-dp': 'peerMore', 'data-i': 0 });
    assert.deepEqual(opened[1].opts, { seedPlain: 'dpage.match.recent' });
  });

  test('every row verb is a focusable control: the network row has a real button', async () => {
    const { S } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
    const html = S.html();
    for (const attrs of [{ 'data-dp': 'lead', 'data-i': 0 }, { 'data-dp': 'play', 'data-i': 0 }, { 'data-dp': 'queue', 'data-i': 0 }, { 'data-dp': 'more', 'data-i': 0 }, { 'data-dp': 'listen', 'data-i': 0 }, { 'data-dp': 'fedQueue', 'data-i': 0 }, { 'data-dp': 'peerMore', 'data-i': 0 }]) {
      const el = findDrawn(html, attrs);
      assert.ok(el && el.tag === 'button', JSON.stringify(attrs));
      // (Listen carries its word; the icon-only verbs need a label)
      if (attrs['data-dp'] !== 'listen') { assert.ok(el.attrs['aria-label'] || el.attrs.title, `${attrs['data-dp']} is labelled`); }
    }
    assert.equal(findDrawn(html, { 'data-dp': 'more', 'data-i': 0 }).attrs.title, 'dpage.verb.addToPlaylist', 'the library ⋯ is the playlist picker');
  });

  test('first open draws the page\'s own loading state, not a spinner', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => gate.then(() => answer(b)) });
    const run = S.discoveryPanel();
    assert.match(S.html(), /dpage-head[\s\S]*dpage-loading/);
    assert.ok(!S.html().includes('LOADING'));
    release();
    await run;
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
    const html = S.html();
    assert.match(html, /dpage-card[\s\S]*dpage\.state\.nothingFinished/);
    assert.match(html, /data-dp="another"/);
    assert.match(html, /data-dp="pick"/);
    assert.match(html, /data-dp="browse"/);
    assert.match(html, /dpage\.seeds\.randomTag/);
    assert.ok(!/data-dp="drop"/.test(html), 'the random pick has no ×');
    assert.ok(!html.includes('dpage-sec-network'), 'no fan-out for a random seed');
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    const next = tasteCalls(calls).slice(before);
    assert.ok(next.length >= 1);
    assert.deepEqual(next[0].exclude, ['r1']);
    assert.equal(next[0].remember, undefined, 'a passed-over pick is never saved');
  });

  test('after Another pick, a filter or window change keeps the skip out — and saves the prefs with a PUT, not remember', async () => {
    const { S, calls, click, change } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...RANDOM, library: null } : RANDOM) });
    await S.discoveryPanel();
    click({ 'data-dp': 'another' });
    await flush(); await flush();
    let before = tasteCalls(calls).length;
    click({ 'data-dp': 'filter', 'data-v': 'all' });
    await flush(); await flush();
    let [main] = tasteCalls(calls).slice(before);
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

  test('scan pending: the card with Check again, the seeds still listed', async () => {
    const pending = { ...MAIN, notAnalyzed: true, library: { filter: 'fresh', albums: [], tracks: [] }, network: { results: [], searched: { peers: 0 } } };
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? { ...pending, peers: { peers: [], searched: {} } } : pending) });
    await S.discoveryPanel();
    const html = S.html();
    assert.match(html, /dpage\.state\.scanPending/);
    assert.match(html, /data-dp="retry"/);
    assert.ok(html.includes('Seed &lt;One&gt;'), 'seeds are listed anyway');
    assert.match(html, /dpage\.source\.waitingForScan/);
  });

  test('a failed call draws the failed card with Try again', async () => {
    const { S } = makeSandbox({ taste: () => null });
    await S.discoveryPanel();
    assert.match(S.html(), /dpage\.state\.failed[\s\S]*data-dp="retry"/);
  });
});

describe('Discover page: changes re-ask', () => {
  test('dropping a seed re-asks with exclude + remember, with an Undo', async () => {
    const { S, calls, click, toasts } = makeSandbox({ taste: answer, playing: PLAYING });
    await S.discoveryPanel();
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

  test('a filter change while the prefs are unknown is not remembered', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer, prefs: () => null });
    await S.discoveryPanel();
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'filter', 'data-v': 'unplayed' });
    await flush(); await flush();
    const [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'unplayed');
    assert.equal(main.remember, undefined);
  });

  test('"+ n more" opens the whole strip, and then reads Show less', async () => {
    const many = { ...MAIN, seeds: [...SEEDS, ...Array.from({ length: 8 }, (_, i) => ({ hash: `m${i}`, filepath: `music/M/${i}.flac`, metadata: { title: `More ${i}` }, outcome: 'completed', plays: 1, pinned: false, analyzed: true }))] };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    assert.match(S.html(), /data-dp="moreSeeds">dpage\.seeds\.more/);
    click({ 'data-dp': 'moreSeeds' });
    assert.match(S.html(), /data-dp="moreSeeds">dpage\.seeds\.showLess/);
    assert.ok(S.html().includes('More 7'));
  });

  test('a filter chip narrows at once and re-asks with the filter remembered', async () => {
    const { S, calls, click } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
    const before = tasteCalls(calls).length;
    click({ 'data-dp': 'filter', 'data-v': 'unplayed' });
    // provisional: the played row is gone before the answer lands
    assert.ok(!S.html().includes('Title Eight'));
    await flush(); await flush();
    const [main] = tasteCalls(calls).slice(before);
    assert.equal(main.filter, 'unplayed');
    assert.equal(main.remember, true);
  });

  test('the window select re-asks with the window', async () => {
    const { S, calls, change } = makeSandbox({ taste: answer });
    await S.discoveryPanel();
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

  test('See all draws one source with every row, Back returns to the overview', async () => {
    const many = { ...MAIN, library: { ...MAIN.library, tracks: Array.from({ length: 9 }, (_, i) => ({ filepath: `music/X/${i}.flac`, similarity: 0.7, seedHash: 'h1', metadata: { title: `Many ${i}` }, playCount: 0, lastPlayed: null })) } };
    const { S, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? PEERS : many) });
    await S.discoveryPanel();
    assert.ok(!S.html().includes('Many 8'), 'the overview shows five');
    assert.match(S.html(), /dpage\.library\.moreUnderSeeAll\{&quot;count&quot;:4\}/);
    click({ 'data-dp': 'focus', 'data-v': 'library' });
    assert.ok(S.html().includes('Many 8'));
    assert.ok(!S.html().includes('dpage-sec-network'));
    assert.match(S.html(), /data-dp="back"/);
    click({ 'data-dp': 'back' });
    assert.ok(S.html().includes('dpage-sec-network'));
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
    assert.match(loading, /dpage-loading/, 'the page\'s own loading state, at once');
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
    assert.ok(S.html().includes('dpage-sec-library'), 'and drew');
    release();
    await run;
    assert.ok(S.html().includes('dpage-sec-library'), 'the dropped answer changed nothing');
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

describe('Discover page: job badges', () => {
  test('the batch lookup puts a job badge on its network row', async () => {
    const job = { id: 7, plugin: 'youtube', state: 'running', progress: 0.64, key: 'k1', params: {} };
    const { S, calls } = makeSandbox({
      taste: answer,
      flags: { ...FLAGS_ALL, discoveryPlugins: true },
      plugins: { available: true, list: [{ name: 'youtube', title: 'YouTube', capabilities: ['acquire'] }], jobsAllowed: true },
      lookup: (recs) => ({ results: recs.map((r, i) => (i === 0 ? { key: 'k1', keys: {}, jobs: [job] } : { key: 'k' + i, keys: {}, jobs: [] })) }),
    });
    await S.discoveryPanel();
    const lookups = calls.filter((c) => c.name === 'lookup');
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].body.length, 2, 'the network lead and the peer row');
    assert.equal(lookups[0].body[0], MAIN.network.results[0]);
    const html = S.html();
    assert.match(html, /dpage-badge-src">discover\.job\.downloading/);
    assert.match(html, /<div class="dpage-prog"><i style="width:64%"><\/i><\/div>/);
    assert.match(html, /dpage\.plugins\.getIt/);
  });

  const JOB = { id: 7, plugin: 'youtube', state: 'running', progress: 0.1, key: 'k1', params: {} };
  const badgeBox = (extra = {}) => makeSandbox({
    taste: answer,
    flags: { ...FLAGS_ALL, discoveryPlugins: true },
    plugins: { available: true, list: [{ name: 'youtube', title: 'YouTube', capabilities: ['acquire'] }], jobsAllowed: true },
    lookup: (recs) => ({ results: recs.map((r, i) => (i === 0 ? { key: 'k1', keys: {}, jobs: [JOB] } : { key: 'other' + i, keys: {}, jobs: [] })) }),
    ...extra,
  });

  test('a poll tick redraws only a badge that changed, in place; an unchanged tick draws nothing', async () => {
    const { S, tick, patches, renders } = badgeBox();
    await S.discoveryPanel();
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
    assert.ok(!patches.some((pt) => pt.id === 'p0'), 'the peer row did not change');
  });

  test('a return within the TTL listens again and catches the badges up', async () => {
    const { S, tick, liveWatches, calls } = badgeBox();
    await S.discoveryPanel();
    assert.equal(liveWatches(), 1);
    S.setState([{ state: 'allAlbums' }]);   // the user left
    tick([{ ...JOB, progress: 0.3 }]);
    assert.equal(liveWatches(), 0, 'the watch ends once the page is left');
    tick([{ ...JOB, progress: 0.9 }]);       // moved while away (no one listening)
    const lookups = calls.filter((c) => c.name === 'lookup').length;
    await S.discoveryPanel();                 // back via the nav, same question, within the TTL
    assert.equal(calls.filter((c) => c.name === 'lookup').length, lookups, 'the kept answer: no new lookup');
    assert.equal(liveWatches(), 1, 'listening again');
    assert.match(S.html(), /width:90%/, 'the badge caught up');
  });
});

describe('Discover page: wiring', () => {
  const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8'));

  test('index.html: the nav entry in the Music group after Most Played, hidden until the ping', () => {
    const nav = html.match(/<div id="nav-discover" class="([^"]*)" onclick="changeView\(discoveryPanel, this\);" data-panel="discovery">/);
    assert.ok(nav, 'the entry');
    for (const c of ['local-only', 'side-nav-item', 'super-hide']) { assert.ok(nav[1].split(' ').includes(c), c); }
    const most = html.indexOf('data-i18n="nav.mostPlayed"');
    const disc = html.indexOf('id="nav-discover"');
    const rated = html.indexOf('data-panel="allRated"');
    assert.ok(most > 0 && disc > most && rated > disc, 'right after Most Played');
    assert.ok(html.indexOf('data-i18n="nav.discover"') > disc);
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
    const missing = [];
    const families = { 'dpage.ago': ['never', 'today', 'days', 'months', 'years', 'undated'], 'dpage.when': ['never', 'today', 'days', 'months', 'years', 'undated'], 'dpage.seen': ['never', 'today', 'days', 'months', 'years'] };
    for (const k of keys) {
      if (k.endsWith('.')) {
        // a prefix the code completes: 'dpage.tab.' + source
        for (const s of DISCOVERYPAGE.SOURCES) { if (!(k + s in en)) { missing.push(k + s); } }
      } else if (families[k]) {
        for (const s of families[k]) { if (!(`${k}.${s}` in en)) { missing.push(`${k}.${s}`); } }
      } else if (!(k in en)) {
        missing.push(k);
      }
    }
    assert.deepEqual(missing, []);
    assert.ok(keys.size > 60, `scanned ${keys.size} keys`);
    // …and the other way: no dpage.* string that nothing emits (translators
    // would be asked for dead copy).
    const prefixes = [...keys].filter((k) => k.endsWith('.'));
    const famPrefixes = Object.keys(families).map((f) => f + '.');
    const dead = Object.keys(en).filter((k) => k.startsWith('dpage.') && !keys.has(k) &&
      !prefixes.some((pre) => k.startsWith(pre)) && !famPrefixes.some((pre) => k.startsWith(pre)));
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
