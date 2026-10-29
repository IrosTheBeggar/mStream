/**
 * Keep a copy from browsing a connected server (the webapp's pages, m.js
 * keepGate* / browseKeep* / browseHead*): the gate, every way in per row
 * type, the page headers, the marks a copy leaves on the page, the queue
 * row's ⋮ entry, and "Show in your library" leaving the peer first.
 *
 * What is pinned:
 *   - the gate opens only with the copy plug-in listed (on, available, an
 *     acquire plug-in), this account allowed to start jobs and a
 *     destination; each way in needs its own scope; a failed read closes it;
 *     peer panels await it before their first draw;
 *   - a ⋯ only on a connected server's row (keyed to the row's own server in
 *     a federated search), in the ▾ / ↓ slot, gone with the gate (the ▾ / ↓
 *     back); never on a library row at a multi-library root, a card with no
 *     single credit or the singles card; this server's rows draw what they
 *     always did;
 *   - the headers: the album's credit from the opener, the songs, or the
 *     peer's album list — the button appearing when it resolves, the line
 *     when credits disagree, nothing when unknown, the header kept (without
 *     a way in) under a closed gate; the artist's takes line by the
 *     plug-in's rule or the no-artist-copy line; a folder's below the
 *     library root only;
 *   - the marks: each its own scope, this server's jobs only (another
 *     server's album copy never marks a card or row; the header says whose
 *     it is while it runs), done ≠ kept; with the gate closed earlier copies
 *     still say what they are; a refused lookup marks nothing; the header
 *     button is patched in place while its words change;
 *   - the queue ⋮ entry: a connected server's song while the gate passes,
 *     never this server's;
 *   - every door's call to the window (VUEPLAYERCORE.openDiscoverModal).
 *
 * Same technique as webapp-local-search.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals; the job keys are the
 * server's own (src/discovery-plugins), so a mark finds a job the window's
 * start would have keyed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'm.js'), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const DISCOVERYPAGE = require('../../webapp/alpha/discovery-page.js');
const DISCOVERJOBS = require('../../webapp/alpha/discover-jobs.js');
const plugins = await import('../../src/discovery-plugins/index.js');

function sliceFn(name) {
  const lines = SRC.split(/\r?\n/);
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
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
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

const KEEP_FNS = [...SRC.matchAll(/^(?:async )?function ((?:keepGate|browseKeep|browseHead|browseAlbum|browseArtist|browseFolder)\w*|writeReadOnlyNote|onQueueMoreCapture)\(/gm)].map((m) => m[1]);
const FNS = ['escapeHtml', 'peerAttr', 'peerOf', 'adoptPeer', 'browseApi', 'localIgnoreVPaths', 'artUrl', 'artImgAttr', 'albumCredit', 'albumSongsBody',
  'searchKey', 'createMusicFileHtml', 'renderDirHtml', 'renderAlbum', 'renderArtist', 'renderSearchRow', 'renderSearchResults',
  'setBrowserRootPanel', 'discoveryHideHead', 'hideMoodFilters', 'moodFilterBody', 'showMoodFilters', 'senddir', 'printdir', 'getFileExplorerPath', 'getDirectoryString2',
  'getAlbumsOnClick', 'getAlbumSongs', 'getArtistsAlbums', 'getAllAlbums', 'getGenreSongs', 'redoRecentlyAdded', 'runLocalSearch',
  'openFileExplorerAt', 'applyServerContext', ...KEEP_FNS];

const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (v) => String(v).replace(/&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (e) => ENTITIES[e]);
const attrOf = (html, name) => { const m = html.match(new RegExp(` ${name}="([^"]*)"`)); return m ? decode(m[1]) : undefined; };
const tick = () => new Promise((r) => setImmediate(r));

const PEER = { id: 2, name: 'Stage Peer B' };
const PEER_C = { id: 3, name: 'Stage Peer C' };
const DEST = { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'saved' };
const ALL_SCOPES = ['song', 'album', 'artist', 'artist-missing', 'folder'];
const LISTING = (over = {}) => ({
  plugins: [{ name: 'federation-copy', capabilities: ['acquire'], enabled: true, available: true, scopes: ALL_SCOPES, ...over }],
  jobs: { allowed: true, maxFolderSongs: 1000 },
});
const VIEW = { destination: DEST, libraries: ['copies', 'music'] };

const TAPES = [
  ['01 - Rooftop Cypher.mp3', 'Rooftop Cypher', 12],
  ['02 - Late Train Verse.mp3', 'Late Train Verse', 8],
  ['03 - Corner Store Loop.mp3', 'Corner Store Loop', 9],
].map(([file, title, duration]) => ({
  filepath: `music/Boukmanflow/Borrowed Tapes/${file}`,
  metadata: { title, artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, duration, 'album-art': 'tapes.jpg' },
}));
const SAMPLER = [['Lantern Street', 'Color Out'], ['Night Market Cypher', 'Boukmanflow'], ['Paper Lanterns', 'ALM']].map(([title, artist], i) => ({
  filepath: `music/Various Artists/Night Market Sampler/0${i + 1} - ${title}.mp3`,
  metadata: { title, artist, album: 'Night Market Sampler', year: 2024, duration: 10 },
}));
const BOUK_ALBUMS = [
  { name: 'Borrowed Tapes', year: 2019, year_min: 2019, year_max: 2019, album_art_file: 'tapes.jpg', album_artist: 'Boukmanflow', artists: ['Boukmanflow'], compilation: false },
  { name: 'Harbour Lights', year: 2021, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'], compilation: false },
  { name: 'Night Market Sampler', year: 2024, album_art_file: null, album_artist: 'Various Artists', artists: ['Color Out', 'Boukmanflow', 'ALM'], compilation: true },
  { name: 'Second Shift', year: 2023, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'], compilation: false },
  { name: null, year: null, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'], track_count: null },
];

// A job as the jobs route stores it: keyed by the server's own jobKey for
// the recommendation the window would have started.
let nextId = 100;
function job(scope, state, rec, extra = {}) {
  const r = plugins.normalizeRecommendation({ source: 'federation', peer: PEER, ...rec });
  return {
    id: extra.id || ++nextId, plugin: 'federation-copy', key: plugins.jobKey(r, scope), state, recommendation: r,
    params: scope === 'song' ? { destination: DEST } : { scope, destination: DEST, ...(extra.landing ? { landing: extra.landing } : {}) },
    progress: extra.progress, cancelRequested: extra.cancelRequested, result: extra.result, createdAt: extra.id || nextId,
  };
}
const manyResult = (copied, extra = {}) => ({
  songs: { total: copied.length + (extra.failed || []).length + (extra.skipped || []).length, copied: copied.map((from) => ({ from, filepath: `copies/x/${from}` })), skipped: extra.skipped || [], failed: (extra.failed || []).map((from) => ({ from, error: 'x' })) },
  peer: PEER,
});
// The batch lookup, answering from `jobs` by the server's own keys.
const lookupFrom = (jobs) => (recs) => ({
  results: recs.map((rec) => {
    const keys = plugins.jobKeysFor(plugins.normalizeRecommendation(rec));
    const own = new Set(Object.values(keys));
    return { key: keys.song, keys, jobs: jobs().filter((j) => own.has(j.key)).sort((a, b) => b.id - a.id) };
  }),
});

// ── a just-enough DOM ───────────────────────────────────────────────
// #filelist's mark slots and #browse-head's button are found in what was
// last written; their stubs persist, so a patch in place is visible as a
// write to the same stub (and a full redraw as a new innerHTML). A slot
// sits in its row (or card text), which always has a box; an empty folder
// mark has none, as spa.css hides it (`box`, what the observer stub reads).
function slotStubs(host, patches) {
  const cache = new Map();
  return () => [...host.inner.matchAll(/data-keep-mark="([^"]*)" data-keep-form="([^"]*)"/g)].map(([, k, form]) => {
    const key = decode(k);
    if (!cache.has(key)) {
      const card = { attrs: {}, getAttribute: (n) => card.attrs[n] ?? null, hasAttribute: (n) => n in card.attrs, setAttribute: (n, v) => { card.attrs[n] = v; } };
      const label = host.inner.match(new RegExp(`data-keep-label="([^"]*)"[^>]*>(?:(?!album-grid-card)[\\s\\S])*data-keep-mark="${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
      if (label) { card.attrs['data-keep-label'] = decode(label[1]); }
      const slot = {
        keepHtml: undefined, card, parentElement: { row: key },
        get box() { return form !== 'folder' || !!slot.html; },
        getAttribute: (n) => (n === 'data-keep-mark' ? key : (n === 'data-keep-form' ? form : null)),
        closest: () => (form === 'card' ? card : null),
        set innerHTML(h) { patches.push({ key, html: h }); slot.html = h; },
        get innerHTML() { return slot.html || ''; },
      };
      cache.set(key, slot);
    }
    return cache.get(key);
  });
}

function headStub() {
  const head = { inner: '', classes: new Set(['super-hide']), writes: 0, kids: {} };
  const kid = (sel) => {
    if (!head.kids[sel]) {
      const k = { attrs: {}, className: '', text: '', html: '', patches: 0 };
      k.getAttribute = (n) => k.attrs[n] ?? null;
      k.setAttribute = (n, v) => { k.attrs[n] = v; };
      Object.defineProperty(k, 'innerHTML', { get: () => k.html, set: (h) => { k.html = h; k.patches++; } });
      Object.defineProperty(k, 'textContent', { get: () => k.text, set: (v) => { k.text = v; k.patches++; } });
      head.kids[sel] = k;
    }
    return head.kids[sel];
  };
  const el = {
    classList: { add: (c) => head.classes.add(c), remove: (c) => head.classes.delete(c), contains: (c) => head.classes.has(c) },
    get innerHTML() { return head.inner; },
    set innerHTML(h) {
      head.inner = h;
      head.writes++;
      head.kids = {};
      const btn = h.match(/<button type="button" class="([^"]*)" data-keep-key="[^"]*" onclick="browseKeepHead\(this\);" title="[^"]*" aria-label="([^"]*)"/);
      if (btn) { const b = kid('.browse-keep'); b.className = btn[1]; b.attrs['aria-label'] = decode(btn[2]); }
      const live = h.match(/data-head="live">([^<]*)</);
      if (live) { kid('[data-head="live"]').text = decode(live[1]); }
    },
    get firstElementChild() {
      if (!head.inner) { return null; }
      const sig = decode((head.inner.match(/data-sig="([^"]*)"/) || [])[1] || '');
      return {
        getAttribute: (n) => (n === 'data-sig' ? sig : null),
        querySelector: (sel) => {
          const present = { '.browse-keep': /class="browse-keep[ "]/, '.browse-keep-plain': /class="browse-keep-plain"/, '[data-head="live"]': /data-head="live"/, '[data-head="bar"]': /data-head="bar"/ }[sel];
          return present && present.test(head.inner) ? kid(sel) : null;
        },
      };
    },
  };
  return { head, el };
}

// An IntersectionObserver as the browser runs one: what it watches, and a
// scroll that brings every watched target near — one without a box never
// intersects.
function observerStub() {
  const all = [];
  class Observer {
    constructor(fn, opts) { Object.assign(this, { fn, opts, targets: new Set() }); all.push(this); }
    observe(t) { this.targets.add(t); }
    unobserve(t) { this.targets.delete(t); }
    disconnect() { this.targets.clear(); }
  }
  return {
    Observer,
    watched: () => all.flatMap((o) => [...o.targets]),
    scrollIn: () => { for (const o of all) { o.fn([...o.targets].map((target) => ({ target, isIntersecting: target.box !== false })), o); } },
  };
}

function makeSandbox({ peer = PEER, flagOn = true, listing = LISTING(), view = VIEW, jobs = [], lookup, api = {}, playlist = [], observer = null } = {}) {
  const els = new Map();
  const plain = (id) => {
    const e = { inner: '', value: id.endsWith('-limit') ? '100' : '', scrollTop: 0, style: {}, classList: { add() {}, remove() {}, contains: () => false }, dispatchEvent() {} };
    Object.defineProperty(e, 'innerHTML', { get: () => e.inner, set: (h) => { e.inner = h; } });
    return e;
  };
  for (const id of ['filelist', 'localSearchBar', 'directoryName', 'directory_bar', 'local_search_btn', 'upload_btn', 'mkdir_btn',
    'recently-added-limit', 'dpage-head', 'nav-readonly-note', 'pop-d-keep']) { els.set(id, plain(id)); }
  const patches = [];
  const slots = slotStubs(els.get('filelist'), patches);
  els.get('filelist').querySelectorAll = (sel) => (sel === '[data-keep-mark]' ? slots() : []);
  const { head, el: headEl } = headStub();
  els.set('browse-head', headEl);
  const note = els.get('nav-readonly-note');
  note.appendChild = () => {};
  Object.defineProperty(note, 'textContent', { get: () => note.text, set: (v) => { note.text = v; } });

  let currentJobs = typeof jobs === 'function' ? jobs : () => jobs;
  const calls = [];
  const opened = [];
  const watchers = [];
  // the window's side: the listings the page handed it, who watches its
  // gate, the toasts and the listeners the page puts on the document
  const taken = [];
  const gateWatchers = [];
  const toasts = [];
  const listeners = [];
  const rec = (name, fn) => (...args) => { calls.push({ name, args }); return fn(...args); };
  const globals = {
    document: {
      getElementById: (id) => els.get(id) ?? null,
      getElementsByClassName: () => [],
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({ appendChild() {} }),
      addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture }); },
      activeElement: null,
      body: { classList: { toggle() {} } },
    },
    MSTREAMAPI: {
      currentServer: { host: 'http://host/', token: 'TOK' },
      discoveryPlugins: rec('plugins', () => Promise.resolve(listing)),
      discoveryDestination: rec('destination', () => (view instanceof Error ? Promise.reject(view) : Promise.resolve(view))),
      discoveryJobLookupBatch: rec('lookup', (recs) => (lookup === 'refuse' ? Promise.reject(Object.assign(new Error('403'), { status: 403 })) : Promise.resolve((lookup || lookupFrom(() => currentJobs()))(recs)))),
      peerArtUrl: (id, art, c) => `http://host/peer/${id}/art/${art}?c=${c}`,
      dirparser: rec('dirparser', (dir) => Promise.resolve(api.dirparser ? api.dirparser(dir) : { path: `/${dir}`, directories: [], files: [] })),
      albumSongs: rec('albumSongs', () => Promise.resolve([])),
      albums: rec('albums', () => Promise.resolve({ albums: api.albums || [] })),
      peer: {
        dirparser: rec('peer.dirparser', (id, dir) => Promise.resolve(api.dirparser(dir))),
        albumSongs: rec('peer.albumSongs', (id, body) => Promise.resolve(api.albumSongs(body))),
        artistAlbums: rec('peer.artistAlbums', (id, body) => (api.artistAlbums ? Promise.resolve(api.artistAlbums(body)) : Promise.reject(new Error('offline')))),
        albums: rec('peer.albums', () => Promise.resolve({ albums: api.albums || [] })),
        genreSongs: rec('peer.genreSongs', () => Promise.resolve(api.genreSongs || [])),
        recentlyAdded: rec('peer.recentlyAdded', () => Promise.resolve(api.recentlyAdded || [])),
      },
    },
    MSTREAMPLAYER: { ignoreVPaths: {}, playlist },
    VUEPLAYERCORE: {
      altLayout: { compressArt: false },
      openDiscoverModal: (track, source, opts) => { opened.push({ track, source, opts }); return Promise.resolve(); },
      discoverJobs: () => currentJobs().slice(),
      watchDiscoverJobs: (fn) => { const w = { fn, live: true }; watchers.push(w); return () => { w.live = false; }; },
      refreshDiscoverJobs: rec('refreshJobs', () => Promise.resolve([])),
      takeDiscoverPlugins: (l) => { taken.push(l); },
      watchKeepGate: (fn) => { gateWatchers.push(fn); return () => {}; },
    },
    DISCOVERYPAGE,
    DISCOVERJOBS,
    IntersectionObserver: observer ? observer.Observer : undefined,
    t: tStub,
    getLoadingSvg: () => 'LOADING',
    boilerplateFailure: (err) => { toasts.push(err); },
    switchServer: () => {},
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let fileExplorerArray = [];
    let peerContext = ${peer ? JSON.stringify(peer) : 'null'};
    let browseGeneration = 0;
    let searchResultMetadata = {};
    const knownPeers = new Map([[${PEER.id}, ${JSON.stringify(PEER)}], [${PEER_C.id}, ${JSON.stringify(PEER_C)}]]);
    const discoveryView = { flags: { discoveryPlugins: ${flagOn} } };
    ${sliceConst('entityMap')}
    ${sliceConst('MOODS')}
    ${sliceConst('searchMap')}
    ${['keepGate', 'browseKeep', 'BROWSE_KEEP_ICONS'].map(sliceConst).join('\n')}
    let keepGatePending = null;
    let keepGateAsk = 0;
    let browseKeepQueued = null;
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      keepGate, browseKeep,
      dirs: () => fileExplorerArray,
      list: () => currentBrowsingList,
      setPeer(p) { peerContext = p; },
      peer: () => peerContext,
      setDirs(a) { fileExplorerArray = a; },
      setState(s) { programState = s; },
      state: () => programState,
      setList(l) { currentBrowsingList = l; },
      setSearchMeta(m) { searchResultMetadata = m; },
      html: () => __els.get('filelist').innerHTML,
      filter: (value) => { runLocalSearch({ value }); return __els.get('filelist').innerHTML; },
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));
  return {
    S, calls, opened, patches, head, els, watchers, taken, gateWatchers, toasts, listeners, globals,
    setListing: (l) => { listing = l; },
    setJobs: (j) => { currentJobs = typeof j === 'function' ? j : () => j; },
    tickJobs: () => { for (const w of watchers) { if (w.live) { w.fn(currentJobs().slice()); } } },
    async openGate(scopes = ALL_SCOPES) {
      listing = LISTING({ scopes });
      await S.keepGateRefresh();
    },
  };
}

const headHtml = (box) => box.head.inner;
const rowsOf = (html) => html.split(/(?=<li class="collection-item")/).filter((r) => r.startsWith('<li'));
const cardsOf = (html) => (html.startsWith('<div class="album-grid">') ? html.slice('<div class="album-grid">'.length, -'</div>'.length) : html)
  .split(/(?=<div class="album-grid-card")/).filter((c) => c.startsWith('<div class="album-grid-card"')).map((c) => c.trim());

// ─────────────────────────────────────────────────────────────────────
describe('the gate', () => {
  test('open only with the copy plug-in listed, on, available and acquiring, jobs allowed and a destination', () => {
    const { S } = makeSandbox();
    const open = S.keepGateOf(true, LISTING(), VIEW);
    assert.equal(open.open, true);
    assert.deepEqual(open.scopes, ALL_SCOPES);
    assert.equal(open.marks, true);
    assert.deepEqual(Object.keys(open).sort(), ['marks', 'open', 'ready', 'scopes'], 'nothing kept that nothing reads (the window keeps its own destination view)');
    const closed = (why, gate) => assert.equal(gate.open, false, why);
    closed('jobs not allowed', S.keepGateOf(true, { ...LISTING(), jobs: { allowed: false } }, VIEW));
    closed('no destination (no upload right, no writable library)', S.keepGateOf(true, LISTING(), { destination: null, libraries: [] }));
    closed('no destination view at all', S.keepGateOf(true, LISTING(), null));
    closed('the copy plug-in off', S.keepGateOf(true, LISTING({ enabled: false }), VIEW));
    closed('its probe failed', S.keepGateOf(true, LISTING({ available: false }), VIEW));
    closed('not an acquire plug-in', S.keepGateOf(true, LISTING({ capabilities: ['links'] }), VIEW));
    closed('another plug-in only', S.keepGateOf(true, LISTING({ name: 'youtube' }), VIEW));
    closed('the listing refused (a jukebox session)', S.keepGateOf(true, null, VIEW));
    const off = S.keepGateOf(false, LISTING(), VIEW);
    assert.equal(off.open, false, 'no plug-ins on this server');
    assert.equal(off.marks, false, 'and nothing to look up');
  });

  test('each read hands its listing to the window, so a way in never opens on an older one; a read that failed hands nothing', async () => {
    const box = makeSandbox();
    await box.S.keepGateRefresh();
    assert.deepEqual(box.taken, [LISTING()], 'the listing itself: the window reads its list, jobs.allowed and the folder cap from it');
    box.setListing(Promise.reject(new Error('offline')));
    await box.S.keepGateRefresh();
    assert.equal(box.taken.length, 1);
    assert.equal(box.S.keepGate.open, false);
  });

  test('each way in needs its own scope', async () => {
    const box = makeSandbox();
    await box.openGate(['song', 'album']);
    assert.equal(box.S.keepGateOpen('song'), true);
    assert.equal(box.S.keepGateOpen('album'), true);
    assert.equal(box.S.keepGateOpen('artist'), false);
    assert.equal(box.S.keepGateOpen('folder'), false);
  });

  test('a read that fails closes it; the read-only note says a copy can be kept only while it is open', async () => {
    const box = makeSandbox({ view: new Error('offline') });
    await box.S.keepGateRefresh();
    assert.equal(box.S.keepGate.ready, true);
    assert.equal(box.S.keepGate.open, false);
    assert.equal(box.els.get('nav-readonly-note').text, 'server.readOnlyNote{"name":"Stage Peer B"}');
    const ok = makeSandbox();
    await ok.S.keepGateRefresh();
    assert.equal(ok.els.get('nav-readonly-note').text, 'server.readOnlyNoteKeep{"name":"Stage Peer B"}');
    assert.deepEqual(ok.calls.filter((c) => c.name === 'plugins' || c.name === 'destination').map((c) => c.name), ['plugins', 'destination']);
  });

  test('a peer panel waits for the gate before its first draw (no ⋯ pops in later)', async () => {
    let release;
    // the listing answers after the albums do
    const box = makeSandbox({ listing: new Promise((r) => { release = r; }), api: { albums: BOUK_ALBUMS.slice(0, 1) } });
    const load = box.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.equal(box.S.html(), 'LOADING', 'not drawn while the gate is out');
    release(LISTING());
    await load;
    assert.match(box.S.html(), /class="dpage-album-more browse-keep-more"/, 'drawn once, with its ⋯');
  });

  test('on this server a panel waits for nothing and asks nothing', async () => {
    const box = makeSandbox({ peer: null });
    await box.S.getAllAlbums();
    assert.equal(box.calls.filter((c) => c.name === 'plugins').length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the ⋯ per row type', () => {
  const songRow = (S, fp, title) => S.createMusicFileHtml(fp, title, undefined, undefined, 'Boukmanflow');

  test('a connected server\'s song row: the ⋯ takes the ▾\'s slot, named for what it keeps', async () => {
    const box = makeSandbox();
    await box.openGate();
    const row = songRow(box.S, TAPES[1].filepath, 'Late Train Verse');
    assert.ok(!row.includes('fileAddToPlaylist'), 'no dead ▾ beside it');
    assert.match(row, /<button type="button" class="browse-keep-tab" onclick="browseKeepSong\(this\);"/);
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'aria-label'), 'browse.keep.ofItem{"name":"Late Train Verse"}');
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'aria-haspopup'), 'dialog');
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'data-keep-key'), `2|song|${TAPES[1].filepath}`);
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'data-peer'), '2');
  });

  test('with the gate closed for songs the ▾ comes back; this server\'s rows draw exactly what they did', async () => {
    const box = makeSandbox();
    await box.openGate(['album', 'folder']);
    const peerRow = songRow(box.S, TAPES[1].filepath, 'Late Train Verse');
    assert.ok(peerRow.includes('class="fileAddToPlaylist"') && !peerRow.includes('browse-keep-tab'));
    const closedLocal = makeSandbox({ peer: null });
    const before = songRow(closedLocal.S, 'music/a.mp3', 'A');
    const openLocal = makeSandbox({ peer: null });
    await openLocal.openGate();
    assert.equal(songRow(openLocal.S, 'music/a.mp3', 'A'), before, 'a local row never changes with the gate');
    assert.ok(!before.includes('browse-keep') && !before.includes('data-keep'));
  });

  test('folder rows: the ⋯ takes the ↓\'s slot inside a library; a multi-library root\'s library rows keep the ↓', async () => {
    const box = makeSandbox();
    await box.openGate();
    box.S.setDirs(['music']);
    const row = box.S.renderDirHtml('Boukmanflow');
    assert.ok(!row.includes('class="downloadDir"'));
    assert.match(row, /onclick="browseKeepFolder\(this\);"/);
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'aria-label'), 'browse.keep.ofFolder{"name":"Boukmanflow"}');
    assert.equal(attrOf(row.slice(row.indexOf('browse-keep-tab')), 'data-keep-key'), '2|folder|/music/Boukmanflow');
    assert.ok(row.includes('title="Add All To Queue"'), '+ Add All To Queue stays');
    box.S.setDirs([]);
    const library = box.S.renderDirHtml('music');
    assert.ok(library.includes('class="downloadDir"') && !library.includes('browse-keep'), 'no ⋯ and no mark on a library row');
    const closed = makeSandbox();
    await closed.openGate(['song']);
    closed.S.setDirs(['music']);
    assert.ok(closed.S.renderDirHtml('Boukmanflow').includes('class="downloadDir"'));
    const local = makeSandbox({ peer: null });
    await local.openGate();
    local.S.setDirs(['music']);
    assert.ok(!local.S.renderDirHtml('Boukmanflow').includes('browse-keep'));
  });

  test('album cards: the ⋯ only on a card naming its album and one credit; a compilation says so', async () => {
    const box = makeSandbox();
    await box.openGate();
    const card = box.S.renderAlbum('Borrowed Tapes', null, 'Borrowed Tapes', 'tapes.jpg', 2019, 'Boukmanflow', 'Boukmanflow', false);
    assert.match(card, /<button type="button" class="dpage-album-more browse-keep-more" data-keep-key="2\|album\|Borrowed Tapes\|Boukmanflow" data-art="tapes.jpg" onclick="event.stopPropagation\(\); browseKeepAlbum\(this\);"/);
    assert.equal(attrOf(card.slice(card.indexOf('browse-keep-more')), 'aria-label'), 'browse.keep.ofItem{"name":"Borrowed Tapes"}');
    assert.equal(attrOf(card, 'aria-label'), 'Borrowed Tapes, Boukmanflow, 2019', 'the card\'s name: its name, credit and year');
    const split = box.S.renderAlbum('Split Series', null, 'Split Series', null, 2022, null, 'ALM, Night Owl Radio', false);
    assert.ok(!split.includes('browse-keep'), 'credits disagree: no ⋯');
    const singles = box.S.renderAlbum(null, 'Boukmanflow', 'SINGLES', null, null, 'Boukmanflow', 'Boukmanflow', false);
    assert.ok(!singles.includes('browse-keep'), 'the singles card: no ⋯');
    const comp = box.S.renderAlbum('Night Market Sampler', null, 'Night Market Sampler', null, 2024, 'Various Artists', 'Various Artists', true);
    assert.ok(comp.includes(' data-compilation="true"') && comp.includes('browse-keep-more'));
    const closed = makeSandbox();
    await closed.openGate(['song']);
    assert.ok(!closed.S.renderAlbum('Borrowed Tapes', null, 'Borrowed Tapes', null, 2019, 'Boukmanflow', 'Boukmanflow').includes('browse-keep-more'));
    const local = makeSandbox({ peer: null });
    await local.openGate();
    assert.ok(!local.S.renderAlbum('Borrowed Tapes', null, 'Borrowed Tapes', null, 2019, 'Boukmanflow', 'Boukmanflow').includes('browse-keep'));
  });

  test('search: a connected server\'s song hit gets the ⋯ keyed to its own server; album hits keep their credit and year', async () => {
    const box = makeSandbox({ peer: null });
    await box.openGate();
    const hit = { name: 'Boukmanflow - Night Market Cypher', filepath: SAMPLER[1].filepath, metadata: SAMPLER[1].metadata };
    const fed = box.S.renderSearchRow('title', hit, PEER_C);
    assert.equal(attrOf(fed.slice(fed.indexOf('browse-keep-tab')), 'data-keep-key'), `3|song|${SAMPLER[1].filepath}`, 'the row\'s own server, not the one browsed');
    assert.equal(attrOf(fed.slice(fed.indexOf('browse-keep-tab')), 'data-peer'), '3');
    assert.equal(attrOf(fed.slice(fed.indexOf('browse-keep-tab')), 'aria-label'), 'browse.keep.ofItem{"name":"Night Market Cypher"}');
    const local = box.S.renderSearchRow('title', hit, null);
    assert.ok(local.includes('class="fileAddToPlaylist"') && !local.includes('browse-keep'), 'this server\'s hit keeps its ▾');
    const album = box.S.renderSearchRow('albums', { name: 'Night Market Sampler', album_artist: 'Various Artists', year: 2024, filepath: false }, PEER);
    assert.equal(attrOf(album, 'data-album-artist'), 'Various Artists');
    assert.equal(attrOf(album, 'data-year'), '2024');
    assert.ok(!album.includes('browse-keep'), 'no ⋯ on an Album hit');
    assert.ok(!box.S.renderSearchRow('artists', { name: 'Boukmanflow', filepath: false }, PEER).includes('browse-keep'), 'nor on an Artist hit');
  });

  test('the filter redraws the cards with their ⋯ and compilation from what the panel kept', async () => {
    const box = makeSandbox({ api: { albums: BOUK_ALBUMS.slice(0, 3) } });
    await box.openGate();
    await box.S.getAllAlbums();
    const before = cardsOf(box.S.html());
    const after = cardsOf(box.S.filter('night'));
    assert.equal(after.length, 1);
    assert.equal(after[0], before[2], 'byte for byte');
    assert.ok(after[0].includes('data-compilation="true"'));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the page header', () => {
  const albumPage = async (box, opener) => {
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs(opener.album, opener.artist || null, opener.year || null, opener.albumArtist || null);
    for (let i = 0; i < 5; i++) { await tick(); }
  };

  test('album: the opener\'s credit gives the button at once; the sub names credit, year, songs and length', async () => {
    const box = makeSandbox({ api: { albumSongs: () => TAPES } });
    await box.openGate();
    await albumPage(box, { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', year: '2019' });
    const h = headHtml(box);
    assert.ok(!box.head.classes.has('super-hide'));
    assert.match(h, /<h2 class="browse-head-title">Borrowed Tapes<\/h2>/);
    assert.match(h, /<div class="browse-head-sub">Boukmanflow · 2019 · discover\.modal\.songCount\{&quot;count&quot;:3\} · 0:29<\/div>/);
    assert.equal(box.head.kids['.browse-keep'].attrs['aria-label'], 'browse.keep.ofItem{"name":"Borrowed Tapes"}');
    assert.match(h, /<img src="http:&#x2F;&#x2F;host&#x2F;peer&#x2F;2&#x2F;art&#x2F;tapes.jpg\?c&#x3D;s"/, 'the cover through the peer proxy, compressed');
    assert.equal(box.calls.filter((c) => c.name === 'peer.artistAlbums').length, 0);
    assert.deepEqual(box.S.state().at(-1), { state: 'album', name: 'Borrowed Tapes', artist: null, albumArtist: 'Boukmanflow', year: '2019', compilation: false, previousScroll: 0, previousSearch: '' },
      'the page keeps what it was opened with');
  });

  test('album: every song naming the same album artist gives the credit (a compilation reads Various Artists)', async () => {
    const songs = SAMPLER.map((s) => ({ ...s, metadata: { ...s.metadata, 'album-artist': 'Various Artists' } }));
    const box = makeSandbox({ api: { albumSongs: () => songs } });
    await box.openGate();
    await albumPage(box, { album: 'Night Market Sampler' });
    assert.match(headHtml(box), /browse-head-sub">Various Artists · 2024 ·/);
    assert.ok(box.head.kids['.browse-keep']);
    assert.equal(box.calls.filter((c) => c.name === 'peer.artistAlbums').length, 0);
  });

  test('album: an older peer\'s page holds its action row while the peer\'s album list names the credit, then the button appears', async () => {
    let answer;
    const box = makeSandbox({ api: { albumSongs: () => SAMPLER, artistAlbums: () => new Promise((r) => { answer = r; }) } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    const page = box.S.getAlbumSongs('Night Market Sampler', null, null, null);
    await page;
    await tick();
    const held = headHtml(box);
    assert.match(held, /<div class="browse-head-row"><\/div>/, 'the row is held, empty');
    assert.match(held, /browse-head-sub">Color Out, Boukmanflow, ALM · 2024 ·/, 'until then the sub lists the track artists');
    assert.deepEqual(box.calls.find((c) => c.name === 'peer.artistAlbums').args, [2, { artist: 'Color Out' }]);
    answer({ albums: [{ name: 'Night Market Sampler', year_min: 2024, year_max: 2024, album_artist: 'Various Artists' }, { name: 'Peer Sessions', album_artist: 'Color Out' }] });
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.match(headHtml(box), /browse-head-sub">Various Artists · 2024 ·/);
    assert.ok(box.head.kids['.browse-keep'], 'the button appeared');
  });

  test('album: credits that disagree get the line, no button; an unknown credit gets neither', async () => {
    const split = [{ filepath: 'music/x/1.mp3', metadata: { title: 'A', artist: 'ALM', album: 'Split Series', year: 2022, duration: 10 } }];
    const box = makeSandbox({ api: { albumSongs: () => split, artistAlbums: () => ({ albums: [{ name: 'Split Series', year: 2022, album_artist: null }] }) } });
    await box.openGate();
    await albumPage(box, { album: 'Split Series' });
    assert.match(headHtml(box), /<span class="browse-head-line">browse\.keep\.noCredit<\/span>/);
    assert.ok(!box.head.kids['.browse-keep']);
    const none = makeSandbox({ api: { albumSongs: () => split } });
    await none.openGate();
    await albumPage(none, { album: 'Split Series' });
    assert.ok(!/browse-head-acts/.test(headHtml(none)), 'the read failed: no button, no line');
    assert.match(headHtml(none), /browse-head-sub">ALM · 2022/, 'the sub still names the songs\' artists');
  });

  test('album: with the gate closed the header stays (it gives the credit back), without a way in', async () => {
    const box = makeSandbox({ api: { albumSongs: () => TAPES } });
    await box.openGate(['song']);
    await albumPage(box, { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' });
    assert.match(headHtml(box), /browse-head-title">Borrowed Tapes/);
    assert.ok(!/browse-head-acts/.test(headHtml(box)));
    const local = makeSandbox({ peer: null, api: { albumSongs: () => TAPES } });
    await local.openGate();
    await albumPage(local, { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' });
    assert.equal(headHtml(local), '', 'this server\'s album page has none');
  });

  test('artist: the takes line by the plug-in\'s own rule; an artist with no album of their own gets the line instead', async () => {
    const box = makeSandbox({ api: { artistAlbums: () => ({ albums: BOUK_ALBUMS }) } });
    await box.openGate();
    box.S.setState([{ state: 'allArtists' }, { state: 'artist', name: 'Boukmanflow' }]);
    await box.S.getArtistsAlbums('Boukmanflow');
    const h = headHtml(box);
    assert.match(h, /browse-head-sub">browse\.head\.albumsOn\{&quot;count&quot;:4,&quot;peer&quot;:&quot;Stage Peer B&quot;\}/, 'named albums only');
    assert.match(h, /browse\.keep\.takes\{&quot;count&quot;:3,&quot;artist&quot;:&quot;Boukmanflow&quot;\}/);
    assert.equal(box.head.kids['.browse-keep'].attrs['aria-label'], 'browse.keep.ofArtist{"artist":"Boukmanflow"}');
    const cards = cardsOf(box.S.html());
    assert.equal(cards.filter((c) => c.includes('browse-keep-more')).length, 4, 'every named card with a credit, the compilation\'s too');
    assert.ok(!cards[4].includes('browse-keep-more'), 'not the singles card');
    const choir = makeSandbox({ api: { artistAlbums: () => ({ albums: [BOUK_ALBUMS[2]] }) } });
    await choir.openGate();
    await choir.S.getArtistsAlbums('Lantern Choir');
    assert.match(headHtml(choir), /browse\.keep\.noArtistCopy\{&quot;artist&quot;:&quot;Lantern Choir&quot;\}/);
    assert.ok(!choir.head.kids['.browse-keep']);
  });

  test('artist and folder headers go with the gate (unless a copy of theirs has something to say)', async () => {
    const box = makeSandbox({ api: { artistAlbums: () => ({ albums: BOUK_ALBUMS }) } });
    await box.openGate(['song']);
    await box.S.getArtistsAlbums('Boukmanflow');
    assert.equal(headHtml(box), '');
    assert.ok(box.head.classes.has('super-hide'));
  });

  test('folder: below the library root only, counted from the listing alone', async () => {
    const listing = { path: '/music/Boukmanflow/', directories: [{ name: 'Borrowed Tapes' }, { name: 'Harbour Lights' }, { name: 'Second Shift' }], files: [{ type: 'm3u', name: 'x.m3u' }] };
    const box = makeSandbox();
    await box.openGate();
    box.S.setState([{ state: 'fileExplorer' }]);
    box.S.setDirs(['music', 'Boukmanflow']);
    box.S.printdir(listing);
    assert.match(headHtml(box), /browse-head-title">Boukmanflow</);
    assert.match(headHtml(box), /browse-head-sub">browse\.head\.folderOn\{&quot;peer&quot;:&quot;Stage Peer B&quot;\} · browse\.head\.folders\{&quot;count&quot;:3\}</, 'the m3u is not counted');
    assert.equal(box.head.kids['.browse-keep'].attrs['aria-label'], 'browse.keep.ofFolder{"name":"Boukmanflow"}');
    box.S.browseKeepReset();
    box.S.setDirs(['music', 'Boukmanflow', 'Borrowed Tapes']);
    box.S.printdir({ path: '/music/Boukmanflow/Borrowed Tapes/', directories: [], files: TAPES.map((t) => ({ type: 'mp3', name: t.filepath.split('/').pop() })) });
    assert.match(headHtml(box), /browse-head-sub">browse\.head\.folderOn\{&quot;peer&quot;:&quot;Stage Peer B&quot;\} · discover\.modal\.songCount\{&quot;count&quot;:3\}</);
    box.S.browseKeepReset();
    box.S.setDirs(['music']);
    box.S.printdir({ path: '/music/', directories: [{ name: 'Boukmanflow' }], files: [] });
    assert.equal(headHtml(box), '', 'the library root: none');
    box.S.setDirs([]);
    box.S.printdir({ path: '/', directories: [{ name: 'live sets' }, { name: 'music' }], files: [] });
    assert.equal(headHtml(box), '', 'a multi-library root: none');
    const closed = makeSandbox();
    await closed.openGate(['song']);
    closed.S.setDirs(['music', 'Boukmanflow']);
    closed.S.printdir(listing);
    assert.equal(headHtml(closed), '', 'the gate closed: no header at all');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('marks: each its own scope, this server\'s jobs only', () => {
  const TAPES_REC = { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' };
  const songRec = (s) => ({ filepath: s.filepath, artist: s.metadata.artist, title: s.metadata.title, album: s.metadata.album });
  async function albumBox(jobs, opts = {}) {
    const box = makeSandbox({ jobs, api: { albumSongs: () => TAPES }, ...opts });
    await box.openGate(opts.scopes);
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 6; i++) { await tick(); }
    return box;
  }
  const markOf = (box, s) => box.S.browseKeepSlotHtml(`2|song|${s.filepath}`, 'row', 'span');

  test('an album page\'s songs: their own copies and the album copy as its lists name them; done is not kept', async () => {
    const album = job('album', 'done', TAPES_REC, { result: manyResult([TAPES[0].filepath], { skipped: [{ from: TAPES[2].filepath, why: 'owned', at: 'music/x.mp3' }], failed: [TAPES[1].filepath] }) });
    const box = await albumBox([album]);
    assert.match(markOf(box, TAPES[0]), /bk-kept.*discover\.keep\.kept/);
    assert.match(markOf(box, TAPES[0]), /browse-keep-sep" aria-hidden="true"> · </, 'after the artist');
    assert.match(markOf(box, TAPES[1]), /bk-failed.*discover\.keep\.failed/, 'in the album copy\'s failed list');
    assert.match(markOf(box, TAPES[2]), /bk-yours.*discover\.keep\.yours/);
    assert.equal(box.head.kids['.browse-keep'].className, 'browse-keep browse-keep-on bk-kept');
    assert.equal(box.head.kids['.browse-keep'].attrs['aria-label'], 'browse.keep.stateAria{"name":"Borrowed Tapes","state":"discover.keep.kept"}');
    const lookup = box.calls.find((c) => c.name === 'lookup');
    assert.equal(lookup.args[0].length, 4, 'one call: the album and its three songs');
    assert.deepEqual(lookup.args[0][0], { source: 'federation', peer: PEER, album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', artist: 'Boukmanflow', year: 2019 });
  });

  test('a song\'s own job, newest wins; a running album copy names no row but its header copies, with the live line and the bar', async () => {
    const own = job('song', 'done', songRec(TAPES[0]), { result: { copied: { filepath: 'copies/x/1.mp3' }, peer: PEER } });
    const running = job('album', 'running', TAPES_REC, { progress: 0.43 });
    const box = await albumBox([own, running]);
    assert.match(markOf(box, TAPES[0]), /discover\.keep\.kept/);
    assert.equal(markOf(box, TAPES[1]).replace(/<[^>]*>/g, ''), '', 'the album copy\'s running: rows don\'t guess');
    const btn = box.head.kids['.browse-keep'];
    assert.equal(btn.className, 'browse-keep browse-keep-on bk-copying');
    assert.equal(btn.attrs['aria-label'], 'browse.keep.stateIntoAria{"name":"Borrowed Tapes","state":"discover.keep.copying, 43%","path":"copies/Boukmanflow/Borrowed Tapes"}');
    // drawn idle while the lookup was out, then patched in place
    assert.match(btn.innerHTML, /<span class="browse-keep-pct">43%<\/span>/);
    assert.equal(box.head.kids['[data-head="live"]'].text, 'browse.keep.keepsGoing{"peer":"Stage Peer B"}');
    assert.match(box.head.kids['[data-head="bar"]'].innerHTML, /role="progressbar" aria-label="browse\.keep\.copyingOf\{&quot;name&quot;:&quot;Borrowed Tapes&quot;\}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="43"/);
    assert.ok(box.calls.some((c) => c.name === 'refreshJobs'), 'a live mark wakes the job poll');
  });

  test('another server\'s album copy: never a row\'s or a card\'s; the header says whose it is while it runs, nothing once over', async () => {
    const theirs = job('album', 'running', { ...TAPES_REC, peer: PEER_C }, { progress: 0.6 });
    const box = await albumBox([theirs]);
    assert.equal(markOf(box, TAPES[0]).replace(/<[^>]*>/g, ''), '');
    assert.equal(box.head.kids['.browse-keep'].className, 'browse-keep browse-keep-on bk-other');
    assert.match(box.head.kids['.browse-keep'].innerHTML, /discover\.keep\.copyingFrom\{&quot;peer&quot;:&quot;Stage Peer C&quot;\}/);
    assert.equal(box.head.kids['[data-head="live"]'].text, '', 'no live line: not this page\'s copy');
    assert.ok(!/browse-head-bar/.test(box.head.kids['[data-head="bar"]'].innerHTML), 'no bar either');
    const done = job('album', 'done', { ...TAPES_REC, peer: PEER_C }, { result: manyResult(TAPES.map((t) => t.filepath)) });
    const over = await albumBox([done]);
    assert.equal(over.head.kids['.browse-keep'].className, 'browse-keep', 'idle again');
    const card = makeSandbox({ jobs: [done], api: { albums: BOUK_ALBUMS.slice(0, 1) } });
    await card.openGate();
    await card.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.equal(card.S.browseKeepSlotHtml('2|album|Borrowed Tapes|Boukmanflow', 'card', 'div').replace(/<[^>]*>/g, ''), '');
  });

  test('cards: an album copy, or this server\'s finished artist copy as its walk saw the album; the card\'s name reads it', async () => {
    const artist = job('artist', 'done', { artist: 'Boukmanflow' }, { result: { scope: 'artist', albums: [{ name: 'Harbour Lights', songs: { total: 3, copied: [{ from: 'a' }], skipped: [], failed: [] } }], skippedAlbums: [{ name: 'Night Market Sampler', why: 'appearance' }], peer: PEER } });
    const copying = job('album', 'running', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { progress: 0.43 });
    const box = makeSandbox({ jobs: [artist, copying], api: { artistAlbums: () => ({ albums: BOUK_ALBUMS }) } });
    await box.openGate();
    await box.S.getArtistsAlbums('Boukmanflow');
    for (let i = 0; i < 4; i++) { await tick(); }
    const line = (album, credit = 'Boukmanflow') => box.S.browseKeepSlotHtml(`2|album|${album}|${credit}`, 'card', 'div');
    assert.match(line('Borrowed Tapes'), /bk-copying.*browse\.keep\.copyingPct\{&quot;pct&quot;:43\}/);
    assert.match(line('Harbour Lights'), /discover\.keep\.kept/);
    assert.equal(line('Night Market Sampler', 'Various Artists').replace(/<[^>]*>/g, ''), '', 'an album they only appear on: nothing');
    const borrowed = box.patches.find((p) => p.key === '2|album|Borrowed Tapes|Boukmanflow');
    assert.ok(borrowed, 'the line was patched in place');
    assert.equal(box.S.browseKeepCardLabel('2|album|Harbour Lights|Boukmanflow', 'Harbour Lights, Boukmanflow, 2021'), 'Harbour Lights, Boukmanflow, 2021, discover.keep.kept');
  });

  test('folder rows: folder copies only', async () => {
    const folder = job('folder', 'running', { filepath: '/music/Boukmanflow/Borrowed Tapes', title: 'Borrowed Tapes' }, { progress: 0.12 });
    const album = job('album', 'done', { album: 'Harbour Lights', albumArtist: 'Boukmanflow' }, { result: manyResult(['x']) });
    const box = makeSandbox({ jobs: [folder, album] });
    await box.openGate();
    box.S.setDirs(['music', 'Boukmanflow']);
    box.S.printdir({ path: '/music/Boukmanflow/', directories: [{ name: 'Borrowed Tapes' }, { name: 'Harbour Lights' }], files: [] });
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.match(box.S.browseKeepSlotHtml('2|folder|/music/Boukmanflow/Borrowed Tapes', 'folder', 'span'), /browse\.keep\.copyingPct\{&quot;pct&quot;:12\}/);
    assert.equal(box.S.browseKeepSlotHtml('2|folder|/music/Boukmanflow/Harbour Lights', 'folder', 'span').replace(/<[^>]*>/g, ''), '', 'kept as an album: its card says so, not the folder');
  });

  test('with the gate closed earlier copies still say what they are (only the ways in go)', async () => {
    const album = job('album', 'done', TAPES_REC, { result: manyResult(TAPES.map((t) => t.filepath)) });
    const box = await albumBox([album], { scopes: [] });
    assert.equal(box.S.keepGate.open, false);
    assert.match(markOf(box, TAPES[0]), /discover\.keep\.kept/);
    assert.ok(!box.head.kids['.browse-keep'], 'no button');
    assert.match(headHtml(box), /<span class="browse-keep-plain"><span class="browse-keep-st bk-kept">/, 'the header says it in words');
    const rows = rowsOf(box.S.html());
    assert.ok(rows.every((r) => r.includes('class="fileAddToPlaylist"') && !r.includes('browse-keep-tab')));
    assert.ok(rows.every((r) => r.includes(`data-keep-mark="2|song|`)), 'the rows keep the slots their marks draw in');
  });

  test('what a job says on the page: done is not kept, a refused or stopped copy says so, an ended nothing says nothing', () => {
    const { S } = makeSandbox();
    const st = (j) => (S.browseKeepState(j) || { state: null }).state;
    const many = (counts, extra = {}) => ({ songs: { total: 3, copied: [], skipped: [], failed: [], ...counts }, peer: PEER, ...extra });
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({ failed: [{ from: 'a' }] }) })), 'failed', 'copied 0 with failures');
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({ copied: [{ from: 'a' }], failed: [{ from: 'b' }] }) })), 'kept', 'in, with failures');
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({ skipped: [{ from: 'a', why: 'owned' }] }) })), 'yours', 'every song already here');
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({ skipped: [{ from: 'a', why: 'owned' }, { from: 'b', why: 'exists' }] }) })), 'skipped', 'a file at its place is not "yours"');
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({ copied: [{ from: 'a' }] }, { stopped: 'refused' }) })), 'refused');
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({}, { stopped: 'quota' }) })), 'stopped');
    assert.equal(st(job('song', 'done', songRec(TAPES[0]), { result: { skipped: 'exists', filepath: 'x' } })), 'skipped');
    assert.equal(st(job('song', 'failed', songRec(TAPES[0]))), 'failed');
    assert.equal(st(job('album', 'running', TAPES_REC, { progress: 0.2, cancelRequested: true })), 'stopping');
    assert.equal(st(job('album', 'running', TAPES_REC, { progress: 0 })), 'copying');
    assert.equal(S.browseKeepState(job('album', 'running', TAPES_REC, { progress: 0 })).pct, null, 'no figure before a byte moved');
    assert.equal(st(job('album', 'cancelled', TAPES_REC, { result: many({ copied: [{ from: 'a' }] }) })), null);
    assert.equal(st(job('album', 'done', TAPES_REC, { result: many({}, { songs: { total: 0, copied: [], skipped: [], failed: [] } }) })), null, 'nothing to copy');
  });

  test('a lookup still out when the page changes is dropped', async () => {
    const artist = job('artist', 'running', { artist: 'Boukmanflow' }, { progress: 0.5 });
    const box = makeSandbox({ jobs: [artist] });
    await box.openGate();
    box.S.browseKeepAdd('2|artist|Boukmanflow', { kind: 'artist', rec: box.S.browseKeepRec(PEER, { artist: 'Boukmanflow' }) });
    // the lookup answers after the next page started
    const ask = box.S.browseKeepAsk(['2|artist|Boukmanflow']);
    box.S.browseKeepReset();
    await ask;
    assert.equal(box.S.browseKeep.items.size, 0);
    assert.equal(box.watchers.length, 0, 'no watch for a page that is gone');
    assert.ok(!box.calls.some((c) => c.name === 'refreshJobs'));
  });

  test('a lookup the server refuses marks nothing; a server without plug-ins is never asked', async () => {
    const album = job('album', 'done', TAPES_REC, { result: manyResult(TAPES.map((t) => t.filepath)) });
    const refused = await albumBox([album], { lookup: 'refuse' });
    assert.equal(markOf(refused, TAPES[0]).replace(/<[^>]*>/g, ''), '');
    assert.equal(refused.head.kids['.browse-keep'].className, 'browse-keep');
    const off = await albumBox([album], { flagOn: false });
    assert.equal(off.calls.filter((c) => c.name === 'lookup').length, 0);
    assert.ok(!off.S.html().includes('data-keep-mark'), 'no slots either');
  });

  test('the job list keeps marks current, and the header button is patched in place while its words change', async () => {
    const box = await albumBox([]);
    const btn = box.head.kids['.browse-keep'];
    const writes = box.head.writes;
    assert.equal(btn.className, 'browse-keep');
    box.setJobs([job('album', 'queued', TAPES_REC)]);
    box.tickJobs();
    assert.equal(box.head.kids['.browse-keep'], btn, 'the same button');
    assert.equal(box.head.writes, writes, 'no redraw of the header');
    assert.equal(btn.className, 'browse-keep browse-keep-on bk-queued');
    assert.match(btn.innerHTML, /discover\.keep\.queued/);
    box.setJobs([job('song', 'done', songRec(TAPES[1]), { result: { copied: { filepath: 'copies/x.mp3' }, peer: PEER } })]);
    box.tickJobs();
    assert.ok(box.patches.some((p) => p.key === `2|song|${TAPES[1].filepath}` && /discover\.keep\.kept/.test(p.html)), 'a row patched in place');
    box.S.browseKeepReset();
    assert.equal(box.watchers.every((w) => !w.live), true, 'the watch goes with the page');
  });
});

// ─────────────────────────────────────────────────────────────────────
// The 2026-10-23 live walk (D1): no folder row was ever looked up — the
// observer watched the mark itself, and an empty folder mark has no box.
describe('the grid\'s cards and the folder rows are looked up as they come near (SPEC-fed §5)', () => {
  const asked = (box) => box.calls.filter((c) => c.name === 'lookup').flatMap((c) => c.args[0].map((r) => r.filepath || r.album));
  const debounce = () => new Promise((r) => setTimeout(r, 300));

  test('a folder row is watched by the row its mark sits in (an empty mark draws no box: spa.css), then looked up and marked', async () => {
    const CSS = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(CSS, /\.browse-keep-folder:empty \{ display: none; \}/, 'why the mark itself cannot be watched');
    const key = '2|folder|/music/Color Out/Peer Sessions';
    const kept = job('folder', 'done', { filepath: '/music/Color Out/Peer Sessions', title: 'Peer Sessions' }, { result: manyResult(['a']) });
    const io = observerStub();
    const box = makeSandbox({ jobs: [kept], observer: io });
    await box.openGate();
    box.S.setDirs(['music', 'Color Out']);
    box.S.printdir({ path: '/music/Color Out/', directories: [{ name: 'Peer Sessions' }], files: [] });
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.deepEqual(asked(box), ['/music/Color Out'], 'the header at once; the row once it comes near');
    assert.deepEqual(io.watched().map((t) => [t.row, t.keepMark]), [[key, key]], 'the row, carrying its mark\'s key — not the slot');
    io.scrollIn();
    await debounce();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.deepEqual(asked(box), ['/music/Color Out', '/music/Color Out/Peer Sessions']);
    assert.ok(box.patches.some((p) => p.key === key && /discover\.keep\.kept/.test(p.html)), 'its mark drawn: In your collection');
    assert.deepEqual(io.watched(), [], 'asked once a visit');
  });

  test('an album card is watched by its text, as before: looked up once near', async () => {
    const io = observerStub();
    const box = makeSandbox({ api: { albums: BOUK_ALBUMS.slice(0, 1) }, observer: io });
    await box.openGate();
    await box.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.deepEqual(asked(box), []);
    assert.deepEqual(io.watched().map((t) => t.keepMark), ['2|album|Borrowed Tapes|Boukmanflow']);
    io.scrollIn();
    await debounce();
    assert.deepEqual(asked(box), ['Borrowed Tapes']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the queue row\'s ⋮ menu', () => {
  const peerSong = { filepath: TAPES[1].filepath, metadata: { ...TAPES[1].metadata, 'album-artist': 'Boukmanflow' }, federation: { peerId: 2, peerName: 'Stage Peer B' } };
  const localSong = { filepath: 'music/a.mp3', metadata: { title: 'A' } };
  // the ⋮ of the queue's `i`th row, as the capture listener meets it
  function press(S, i, count) {
    const rows = [];
    for (let n = 0; n < count; n++) {
      const more = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      const row = { classList: { contains: (c) => c === 'np-queue-item' } };
      more.closest = (sel) => (sel === '.np-queue-item' ? row : null);
      row.more = more;
      rows.push(row);
    }
    const parent = { children: rows };
    rows.forEach((r) => { r.parentElement = parent; });
    const target = { closest: (sel) => (sel === '.np-queue-item .popperMenu' ? rows[i].more : null) };
    S.onQueueMoreCapture({ target });
    return rows[i].more;
  }

  test('a connected server\'s song: "Keep a copy…", opening the song window on its own server; the ⋮ is the opener', async () => {
    const box = makeSandbox({ peer: null, playlist: [localSong, peerSong] });
    await box.openGate();
    const more = press(box.S, 1, 2);
    assert.equal(box.els.get('pop-d-keep').style.display, '');
    assert.equal(more.attrs['data-keep-key'], undefined, 'its row binds the key to the song it shows (vp.js playlist-item), not the press');
    box.S.browseKeepQueue();
    assert.equal(box.opened.length, 1);
    assert.deepEqual(box.opened[0].track, { peer: PEER, filepath: TAPES[1].filepath, title: 'Late Train Verse', artist: 'Boukmanflow', album: 'Borrowed Tapes',
      year: 2019, duration: 8, albumArt: 'tapes.jpg', albumArtist: undefined }, 'Album joins once the window bears out the song\'s own credit');
    assert.deepEqual(box.opened[0].opts, { from: 'browse', hide: [], opener: more });
    assert.equal(box.opened[0].source, 'federation');
  });

  test('this server\'s song never gets it; nor does any song while the gate is closed', async () => {
    const box = makeSandbox({ peer: null, playlist: [localSong, peerSong] });
    await box.openGate();
    press(box.S, 0, 2);
    assert.equal(box.els.get('pop-d-keep').style.display, 'none');
    box.S.browseKeepQueue();
    assert.equal(box.opened.length, 0);
    const closed = makeSandbox({ peer: null, playlist: [peerSong] });
    await closed.openGate(['album']);
    press(closed.S, 0, 1);
    assert.equal(closed.els.get('pop-d-keep').style.display, 'none');
    closed.S.browseKeepQueue();
    assert.equal(closed.opened.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('"Show in your library" from a connected server\'s page', () => {
  test('openFileExplorerAt comes home first, so YOUR folder is listed (G22)', async () => {
    const box = makeSandbox({ api: { dirparser: (dir) => ({ path: `/${dir}`, directories: [], files: [] }) } });
    box.S.openFileExplorerAt(['copies', 'Boukmanflow', 'Borrowed Tapes']);
    await tick();
    assert.equal(box.S.peer(), null);
    assert.deepEqual(box.calls.filter((c) => /dirparser/.test(c.name)).map((c) => [c.name, c.args]), [['dirparser', ['copies/Boukmanflow/Borrowed Tapes/']]]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('every door opens the window with what it names', () => {
  const el = (attrs, extra = {}) => ({ getAttribute: (n) => (n in attrs ? attrs[n] : null), hasAttribute: (n) => n in attrs, ...extra });

  test('the album header, a song row on its page, the artist header, the folder header and a folder row', async () => {
    const box = makeSandbox({ api: { albumSongs: () => TAPES } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, '2019', 'Boukmanflow');
    for (let i = 0; i < 4; i++) { await tick(); }
    const head = el({});
    box.S.browseKeepHead(head);
    assert.deepEqual(box.opened.at(-1), { source: 'federation', track: { peer: PEER, album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', artist: 'Boukmanflow', year: 2019, albumArt: 'tapes.jpg', compilation: false, filepath: null },
      opts: { focus: 'album', from: 'browse', hide: ['viewAlbum'], opener: head } });
    const row = el({ 'data-file_location': TAPES[1].filepath, 'data-peer': '2' });
    box.S.browseKeepSong(row);
    assert.deepEqual(box.opened.at(-1).track, { peer: PEER, filepath: TAPES[1].filepath, title: 'Late Train Verse', artist: 'Boukmanflow', album: 'Borrowed Tapes',
      year: 2019, duration: 8, albumArt: 'tapes.jpg', albumArtist: 'Boukmanflow' }, 'the page\'s credit is the song\'s album\'s');
    assert.deepEqual(box.opened.at(-1).opts, { from: 'browse', hide: ['viewAlbum'], opener: row });

    const artist = makeSandbox({ api: { artistAlbums: () => ({ albums: BOUK_ALBUMS }) } });
    await artist.openGate();
    artist.S.setState([{ state: 'allArtists' }, { state: 'artist', name: 'Boukmanflow' }]);
    await artist.S.getArtistsAlbums('Boukmanflow');
    artist.S.browseKeepHead(head);
    assert.deepEqual(artist.opened.at(-1).track, { peer: PEER, artist: 'Boukmanflow' });
    assert.deepEqual(artist.opened.at(-1).opts, { focus: 'artist', from: 'browse', opener: head });

    const folder = makeSandbox();
    await folder.openGate();
    folder.S.setDirs(['music', 'Boukmanflow']);
    folder.S.printdir({ path: '/music/Boukmanflow/', directories: [{ name: 'Borrowed Tapes' }], files: [] });
    folder.S.browseKeepHead(head);
    assert.deepEqual(folder.opened.at(-1).track, { peer: PEER, filepath: '/music/Boukmanflow', title: 'Boukmanflow' });
    assert.deepEqual(folder.opened.at(-1).opts, { focus: 'folder', scope: 'folder', from: 'browse', opener: head });
    const dirRow = el({ 'data-directory': 'Borrowed Tapes', 'data-peer': '2' });
    folder.S.browseKeepFolder(dirRow);
    assert.deepEqual(folder.opened.at(-1).track, { peer: PEER, filepath: '/music/Boukmanflow/Borrowed Tapes', title: 'Borrowed Tapes' });
    assert.deepEqual(folder.opened.at(-1).opts, { focus: 'folder', scope: 'folder', from: 'browse', opener: dirRow });
  });

  test('an album card (no View artist on the artist\'s page; a compilation keeps no Artist)', async () => {
    const box = makeSandbox();
    await box.openGate();
    box.S.setState([{ state: 'allArtists' }, { state: 'artist', name: 'Boukmanflow' }]);
    const card = el({ 'data-album': 'Night Market Sampler', 'data-album-artist': 'Various Artists', 'data-year': '2024', 'data-compilation': 'true', 'data-peer': '2' });
    const more = el({ 'data-art': 'nms.jpg' }, { closest: () => card });
    box.S.browseKeepAlbum(more);
    assert.deepEqual(box.opened.at(-1).track, { peer: PEER, album: 'Night Market Sampler', albumArtist: 'Various Artists', artist: null, year: 2024, albumArt: 'nms.jpg', compilation: true });
    assert.deepEqual(box.opened.at(-1).opts, { focus: 'album', from: 'browse', hide: [], opener: more }, 'no artist to view: nothing to hide');
    const tapes = el({ 'data-album': 'Borrowed Tapes', 'data-album-artist': 'Boukmanflow', 'data-year': '2019', 'data-peer': '2' });
    box.S.browseKeepAlbum(el({}, { closest: () => tapes }));
    assert.deepEqual([box.opened.at(-1).track.artist, box.opened.at(-1).opts.hide], ['Boukmanflow', ['viewArtist']], 'his own album on his page: already there');
    const guest = el({ 'data-album': 'Joint Session', 'data-album-artist': 'ALM', 'data-year': '2022', 'data-peer': '2' });
    box.S.browseKeepAlbum(el({}, { closest: () => guest }));
    assert.deepEqual([box.opened.at(-1).track.artist, box.opened.at(-1).opts.hide], ['ALM', []], 'an album credited to someone else: View artist leads to their page');
    box.S.setState([{ state: 'allAlbums' }]);
    box.S.browseKeepAlbum(el({}, { closest: () => tapes }));
    assert.equal(box.opened.at(-1).track.artist, 'Boukmanflow');
    assert.deepEqual(box.opened.at(-1).opts.hide, []);
  });

  test('an explorer file row: This song, its folder as a choice — none at the library root', async () => {
    const box = makeSandbox();
    await box.openGate();
    box.S.setState([{ state: 'fileExplorer' }, { state: 'fileExplorer' }]);
    box.S.setDirs(['music', 'Boukmanflow', 'Borrowed Tapes']);
    box.S.printdir({ path: '/music/Boukmanflow/Borrowed Tapes/', directories: [], files: [{ type: 'mp3', name: '02 - Late Train Verse.mp3' }] });
    const fp = '/music/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3';
    const row = el({ 'data-file_location': fp, 'data-peer': '2' });
    box.S.browseKeepSong(row);
    assert.deepEqual(box.opened.at(-1).track, { peer: PEER, filepath: fp, title: '02 - Late Train Verse.mp3' });
    assert.deepEqual(box.opened.at(-1).opts, { from: 'browse', opener: row, folder: { path: '/music/Boukmanflow/Borrowed Tapes', name: 'Borrowed Tapes' } });
    box.S.setDirs(['music']);
    box.S.printdir({ path: '/music/', directories: [], files: [{ type: 'mp3', name: 'loose.mp3' }] });
    box.S.browseKeepSong(el({ 'data-file_location': '/music/loose.mp3', 'data-peer': '2' }));
    assert.equal(box.opened.at(-1).opts.folder, undefined);
  });

  test('a federated search\'s song hit opens on the hit\'s own server, and the app stays home', async () => {
    const box = makeSandbox({ peer: null });
    await box.openGate();
    box.S.setSearchMeta({ [`3:${SAMPLER[1].filepath}`]: SAMPLER[1].metadata });
    const hit = el({ 'data-file_location': SAMPLER[1].filepath, 'data-peer': '3' });
    box.S.browseKeepHit(hit);
    assert.deepEqual(box.opened.at(-1).track.peer, PEER_C);
    assert.equal(box.opened.at(-1).track.title, 'Night Market Cypher');
    assert.equal(box.S.peer(), null);
  });

  test('genre and Recently Added rows: the song window, no hidden links', async () => {
    const box = makeSandbox({ api: { genreSongs: TAPES } });
    await box.openGate();
    box.S.setState([{ state: 'allGenres' }, { state: 'genre', name: 'Hip-Hop' }]);
    await box.S.getGenreSongs('Hip-Hop');
    assert.equal(rowsOf(box.S.html()).filter((r) => r.includes('browse-keep-tab')).length, 3);
    assert.ok(!box.S.html().includes('data-keep-mark'), 'no marks off an album page');
    const row = el({ 'data-file_location': TAPES[0].filepath, 'data-peer': '2' });
    box.S.browseKeepSong(row);
    assert.deepEqual(box.opened.at(-1).opts, { from: 'browse', hide: [], opener: row });
    assert.equal(box.opened.at(-1).track.albumArtist, undefined, 'the window finds the credit');
  });
});

// ─────────────────────────────────────────────────────────────────────
// The 2026-10-23 review of the browse half: what each finding pinned.
describe('a compilation\'s album page: one choice, Album — never "Various Artists" as an artist (rule 1)', () => {
  const songsVA = SAMPLER.map((s) => ({ ...s, metadata: { ...s.metadata, 'album-artist': 'Various Artists' } }));
  const openHead = (box) => { const head = { getAttribute: () => null }; box.S.browseKeepHead(head); return box.opened.at(-1); };

  test('the songs\' credit names none of their artists: the header\'s window gets no artist and the compilation flag; its lookup asks no artist copy', async () => {
    const box = makeSandbox({ api: { albumSongs: () => songsVA } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    await box.S.getAlbumSongs('Night Market Sampler', null, null, null);
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.equal(box.S.browseKeep.head.compilation, true);
    const { track, opts } = openHead(box);
    assert.deepEqual([track.albumArtist, track.artist, track.compilation, opts.focus], ['Various Artists', null, true, 'album']);
    const rec = box.calls.find((c) => c.name === 'lookup').args[0][0];
    assert.deepEqual([rec.albumArtist, 'artist' in rec], ['Various Artists', false]);
  });

  // a compilation flagged so, credited to one of its own artists — its
  // songs alone would not say it is one
  const PARTY = [['Block Party Intro', 'Boukmanflow'], ['Stoop Talk', 'ALM']].map(([title, artist], i) => ({
    filepath: `music/Boukmanflow/Block Party/0${i + 1} - ${title}.mp3`, metadata: { title, artist, album: 'Block Party', year: 2025, duration: 10 } }));
  const PARTY_ALBUM = { name: 'Block Party', year: 2025, year_min: 2025, year_max: 2025, album_artist: 'Boukmanflow', artists: ['Boukmanflow', 'ALM'], compilation: true };

  test('a card\'s word (data-compilation) rides through the page\'s state, and Back keeps it', async () => {
    const box = makeSandbox({ api: { albumSongs: () => PARTY } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    const card = { hasAttribute: (n) => ['data-album', 'data-album-artist', 'data-year', 'data-peer', 'data-compilation'].indexOf(n) !== -1,
      getAttribute: (n) => ({ 'data-album': 'Block Party', 'data-album-artist': 'Boukmanflow', 'data-year': '2025', 'data-peer': '2', 'data-compilation': 'true' })[n] ?? null };
    box.S.getAlbumsOnClick(card);
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.equal(box.S.state().at(-1).compilation, true);
    assert.equal(openHead(box).track.artist, null, 'its card said so: Album alone, as the card\'s own ⋯ opens it');
    const plain = makeSandbox({ api: { albumSongs: () => PARTY } });
    await plain.openGate();
    plain.S.setState([{ state: 'allAlbums' }]);
    await plain.S.getAlbumSongs('Block Party', null, '2025', 'Boukmanflow');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.equal(openHead(plain).track.artist, 'Boukmanflow', 'nothing says it is one: the credit is his');
  });

  test('the peer\'s album list calls it a compilation', async () => {
    const box = makeSandbox({ api: { albumSongs: () => PARTY, artistAlbums: () => ({ albums: [PARTY_ALBUM] }) } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    await box.S.getAlbumSongs('Block Party', null, null, null);
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.deepEqual([box.S.browseKeep.head.albumArtist, box.S.browseKeep.head.compilation], ['Boukmanflow', true]);
  });

  test('the peer\'s album list names it a compilation; an album of one artist\'s keeps that artist', async () => {
    const box = makeSandbox({ api: { albumSongs: () => SAMPLER.slice(1, 2), artistAlbums: () => ({ albums: [BOUK_ALBUMS[2]] }) } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    await box.S.getAlbumSongs('Night Market Sampler', null, null, null);
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.deepEqual([box.S.browseKeep.head.albumArtist, box.S.browseKeep.head.compilation], ['Various Artists', true], 'one song of it on the page: its artist is Boukmanflow, the list says compilation');
    const own = makeSandbox({ api: { albumSongs: () => TAPES } });
    await own.openGate();
    own.S.setState([{ state: 'allAlbums' }]);
    await own.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.equal(own.S.browseKeep.head.compilation, false);
    assert.equal(openHead(own).track.artist, 'Boukmanflow');
  });

  // The 2026-10-23 live walk (D2): a peer whose files carry no
  // compilation flag lists Night Market Sampler as compilation: false,
  // its only credit Various Artists.
  const SAMPLER_UNFLAGGED = { name: 'Night Market Sampler', year: 2024, album_art_file: null, album_artist: 'Various Artists', artists: ['Various Artists'], compilation: false };
  const cardEl = (html) => {
    const attrs = Object.fromEntries(['data-album', 'data-album-artist', 'data-year', 'data-peer', 'data-compilation']
      .map((n) => [n, attrOf(html, n)]).filter(([, v]) => v !== undefined));
    return { getAttribute: (n) => attrs[n] ?? null, hasAttribute: (n) => n in attrs };
  };

  test('a card credited to Various Artists that its listing does not flag: its ⋯ offers Album alone (no Artist "Various Artists"), and its lookup asks no artist copy', async () => {
    const box = makeSandbox({ api: { albums: [SAMPLER_UNFLAGGED] } });
    await box.openGate();
    await box.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    const [html] = cardsOf(box.S.html());
    assert.ok(html.includes('browse-keep-more') && !html.includes('data-compilation'), 'its ⋯, and the listing\'s word that it is none');
    const card = cardEl(html);
    const more = { getAttribute: () => null, closest: () => card };
    box.S.browseKeepAlbum(more);
    assert.deepEqual(box.opened.at(-1).track, { peer: PEER, album: 'Night Market Sampler', albumArtist: 'Various Artists', artist: null, year: 2024, albumArt: null, compilation: true });
    const rec = box.calls.find((c) => c.name === 'lookup').args[0][0];
    assert.deepEqual([rec.albumArtist, 'artist' in rec], ['Various Artists', false]);
    // the same card on the artist page of one of its artists
    box.S.setState([{ state: 'allArtists' }, { state: 'artist', name: 'Boukmanflow' }]);
    box.S.browseKeepAlbum(more);
    assert.deepEqual([box.opened.at(-1).track.artist, box.opened.at(-1).track.compilation, box.opened.at(-1).opts.hide], [null, true, []]);
  });

  test('a page whose songs all name Various Artists, as their artist too: still a compilation — no artist copy of "Various Artists"', async () => {
    const songs = SAMPLER.map((s) => ({ ...s, metadata: { ...s.metadata, artist: 'Various Artists', 'album-artist': 'Various Artists' } }));
    const box = makeSandbox({ api: { albumSongs: () => songs } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Night Market Sampler', null, '2024', 'Various Artists');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.equal(box.S.browseKeep.head.compilation, true);
    assert.deepEqual([openHead(box).track.artist, openHead(box).track.compilation], [null, true]);
  });

  test('the songs\' agreed credit wins over an opener that names the album\'s first artist (a search hit\'s): one job key for the album, wherever it is opened', async () => {
    const joint = [['Snare Talk', 'Color Out'], ['Two Rooms', 'ALM']].map(([title, artist], i) => ({
      filepath: `music/Color Out/Joint Session/0${i + 1} - ${title}.mp3`, metadata: { title, artist, album: 'Joint Session', year: 2022, duration: 10, 'album-artist': 'Color Out & ALM' } }));
    const box = makeSandbox({ api: { albumSongs: () => joint } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    await box.S.getAlbumSongs('Joint Session', null, '2022', 'Color Out');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.equal(box.S.browseKeep.head.albumArtist, 'Color Out & ALM');
    assert.equal(box.S.browseKeep.head.key, '2|album|Joint Session|Color Out & ALM', 'the card\'s key');
    assert.equal(box.S.state().at(-1).albumArtist, 'Color Out', 'Back asks the peer as it was asked');
  });
});

describe('an album page whose songs name different album artists: no Album in a row\'s window either', () => {
  test('a row\'s ⋯ says so (creditsDisagree) and names no credit; a page with one credit hands it over', async () => {
    const split = [['A', 'ALM'], ['B', 'Night Owl Radio']].map(([title, artist], i) => ({ filepath: `music/x/${i}.mp3`,
      metadata: { title, artist, album: 'Split Series', year: 2022, duration: 10, 'album-artist': artist } }));
    const box = makeSandbox({ api: { albumSongs: () => split, artistAlbums: () => ({ albums: [{ name: 'Split Series', year: 2022, album_artist: null }] }) } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Split Series', null, null, null);
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.equal(box.S.browseKeep.head.credit, 'disagree');
    const row = { getAttribute: (n) => ({ 'data-file_location': 'music/x/0.mp3', 'data-peer': '2' })[n] ?? null };
    box.S.browseKeepSong(row);
    assert.equal(box.opened.at(-1).track.albumArtist, undefined, 'never the song\'s own half\'s credit');
    assert.deepEqual(box.opened.at(-1).opts, { from: 'browse', hide: ['viewAlbum'], opener: row, creditsDisagree: true });
  });

  test('each song is looked up as its ⋯ starts it: an untitled one by its file\'s name', async () => {
    const untitled = [{ filepath: 'music/Boukmanflow/Borrowed Tapes/04 - interlude.mp3', metadata: { artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, duration: 4 } }];
    const box = makeSandbox({ api: { albumSongs: () => untitled } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 5; i++) { await tick(); }
    const recs = box.calls.find((c) => c.name === 'lookup').args[0];
    assert.equal(recs[1].title, '04 - interlude.mp3');
    box.S.browseKeepSong({ getAttribute: (n) => ({ 'data-file_location': untitled[0].filepath, 'data-peer': '2' })[n] ?? null });
    assert.equal(box.opened.at(-1).track.title, recs[1].title, 'the same title the window starts the job with: the same key');
  });
});

describe('the gate is read again when the window learns it changed, and a page keeps the gate it drew with (SPEC-fed §3)', () => {
  test('the page listens: a queue ⋮ press on its way down, and the window\'s word — on which the listing is read again', async () => {
    const box = makeSandbox();
    box.S.browseKeepListen();
    assert.deepEqual(box.listeners.map((l) => [l.type, l.capture]), [['click', true]]);
    assert.equal(box.gateWatchers.length, 1);
    await box.openGate();
    const before = box.calls.filter((c) => c.name === 'plugins').length;
    box.gateWatchers[0]();
    await tick();
    assert.equal(box.calls.filter((c) => c.name === 'plugins').length, before + 1);
  });

  test('a right lost (a 403 start): the page drawn keeps its button; the next one draws no ⋯ and no button', async () => {
    const box = makeSandbox({ api: { albumSongs: () => TAPES } });
    box.S.browseKeepListen();
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.ok(box.head.kids['.browse-keep']);
    // the window's start was refused: the gate is read again, and is shut
    box.setListing({ ...LISTING(), jobs: { allowed: false } });
    box.gateWatchers[0]();
    for (let i = 0; i < 3; i++) { await tick(); }
    assert.equal(box.S.keepGate.open, false);
    box.tickJobs();
    box.S.browseKeepPaint();
    assert.ok(box.head.kids['.browse-keep'], 'never pulled from under the pointer');
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 5; i++) { await tick(); }
    assert.ok(!box.head.kids['.browse-keep'], 'the next page: no button');
    assert.ok(rowsOf(box.S.html()).every((r) => !r.includes('browse-keep-tab') && r.includes('class="fileAddToPlaylist"')), 'no ⋯: the ▾ back');
  });

  test('this server\'s search reads the gate again for each federated block (a read already out serves)', async () => {
    const box = makeSandbox({ peer: null });
    await box.S.keepGateRefresh();
    const asked = () => box.calls.filter((c) => c.name === 'plugins').length;
    await box.S.keepGateFresh();
    assert.equal(asked(), 2, 'read again, though the session read one');
    const a = box.S.keepGateFresh();
    const b = box.S.keepGateFresh();
    assert.equal(a, b, 'one read for two asks while it is out');
    await a;
    assert.equal(asked(), 3);
    assert.match(sliceFn('searchPeers'), /const gate = keepGateFresh\(\);/);
  });
});

describe('the formats this server plays reach the window\'s folder count (SPEC-fed §6.5.3)', () => {
  test('init keeps the ping\'s supportedAudioFiles', () => {
    assert.match(sliceFn('init'), /MSTREAMAPI\.currentServer\.supportedAudioFiles = response\.supportedAudioFiles \|\| null;/);
  });
});

describe('a navigation that fails on a connected server leaves the page as it was (SPEC-fed §4.10)', () => {
  const failOn = (want, answer) => (body) => { if (body.album === want) { throw new Error('peer unreachable'); } return answer; };

  test('an album page: another album that fails brings it back — list, header, marks, Back — and only toasts', async () => {
    const album = job('album', 'done', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { result: manyResult(TAPES.map((x) => x.filepath)) });
    const box = makeSandbox({ jobs: [album], api: { albumSongs: failOn('Harbour Lights', TAPES) } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 6; i++) { await tick(); }
    const list = box.S.html();
    const header = headHtml(box);
    const states = JSON.stringify(box.S.state());
    box.els.get('directoryName').innerHTML = 'Album: Borrowed Tapes';
    await box.S.getAlbumSongs('Harbour Lights', null, 2021, 'Boukmanflow');
    assert.equal(box.toasts.length, 1, 'the toast');
    assert.equal(box.S.html(), list, 'the list as it was, no "Server call failed" in it');
    assert.equal(headHtml(box), header);
    assert.ok(!box.head.classes.has('super-hide'));
    assert.equal(JSON.stringify(box.S.state()), states, 'Back goes where it went');
    assert.equal(box.els.get('directoryName').innerHTML, 'Album: Borrowed Tapes');
    assert.match(box.S.browseKeepSlotHtml(`2|song|${TAPES[0].filepath}`, 'row', 'span'), /discover\.keep\.kept/, 'its marks with it');
    assert.equal(box.S.browseKeep.head.album, 'Borrowed Tapes');
    // and its ⋯ still opens what it names
    box.S.browseKeepSong({ getAttribute: (n) => ({ 'data-file_location': TAPES[1].filepath, 'data-peer': '2' })[n] ?? null });
    assert.equal(box.opened.at(-1).track.albumArtist, 'Boukmanflow');
  });

  test('what the page was still asking when it was left lands on it once it is back (an older peer\'s credit)', async () => {
    let answer;
    const box = makeSandbox({ api: { albumSongs: failOn('Harbour Lights', SAMPLER), artistAlbums: () => new Promise((r) => { answer = r; }) } });
    await box.openGate();
    box.S.setState([{ state: 'searchPanel' }]);
    await box.S.getAlbumSongs('Night Market Sampler', null, null, null);
    await tick();
    assert.match(headHtml(box), /<div class="browse-head-row"><\/div>/, 'its row held while the list is asked');
    await box.S.getAlbumSongs('Harbour Lights', null, 2021, 'Boukmanflow');
    answer({ albums: [{ name: 'Night Market Sampler', year_min: 2024, year_max: 2024, album_artist: 'Various Artists', compilation: true }] });
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.ok(box.head.kids['.browse-keep'], 'the button appeared on the page that came back');
    assert.equal(box.S.browseKeep.head.credit, 'known');
  });

  test('a folder: a folder below it that fails leaves the explorer where it was (its path, its header)', async () => {
    const listings = { 'music/Boukmanflow/': { path: '/music/Boukmanflow/', directories: [{ name: 'Borrowed Tapes' }], files: [] } };
    const box = makeSandbox({ api: { dirparser: (dir) => { if (!listings[dir]) { throw new Error('peer unreachable'); } return listings[dir]; } } });
    await box.openGate();
    box.S.setState([{ state: 'fileExplorer' }, { state: 'fileExplorer' }]);
    box.S.setDirs(['music', 'Boukmanflow']);
    await box.S.senddir();
    const list = box.S.html();
    // the row's press: in, then the load
    box.S.setDirs(['music', 'Boukmanflow', 'Borrowed Tapes']);
    box.S.setState(box.S.state().concat({ state: 'fileExplorer' }));
    await box.S.senddir();
    assert.deepEqual(box.S.dirs(), ['music', 'Boukmanflow']);
    assert.equal(box.S.state().length, 2);
    assert.equal(box.S.html(), list);
    assert.match(headHtml(box), /browse-head-title">Boukmanflow</);
    assert.equal(box.toasts.length, 1);
  });

  test('nothing to give back: this server\'s page, or a page in between that held none of the server\'s, says it failed as before', async () => {
    const local = makeSandbox({ peer: null });
    local.globals.MSTREAMAPI.albumSongs = () => Promise.reject(new Error('x'));
    await local.S.getAlbumSongs('Borrowed Tapes', null, 2019, null);
    assert.equal(local.S.html(), '<div>error.serverCallFailed</div>');
    const box = makeSandbox({ api: { albumSongs: failOn('Harbour Lights', TAPES), albums: BOUK_ALBUMS.slice(0, 1) } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    // a panel with nothing of the server's on it (layout settings)
    box.S.setBrowserRootPanel('panel.layout', false);
    box.S.setState([{ state: 'layout' }]);
    await box.S.getAlbumSongs('Harbour Lights', null, 2021, 'Boukmanflow');
    assert.equal(box.S.html(), '<div>error.serverCallFailed</div>');
  });

  test('a genre\'s songs that fail: the page back, and a toast where there was none', async () => {
    const box = makeSandbox({ api: { albums: BOUK_ALBUMS.slice(0, 2) } });
    await box.openGate();
    await box.S.getAllAlbums();
    const list = box.S.html();
    box.globals.MSTREAMAPI.peer.genreSongs = () => { throw new Error('peer unreachable'); };
    await box.S.getGenreSongs('Hip-Hop');
    assert.equal(box.S.html(), list);
    assert.equal(box.toasts.length, 1);
  });
});

describe('the header\'s smaller rules', () => {
  test('folder rows\' marks: the card\'s words, the row\'s glyph (12; a card\'s is 10)', async () => {
    const { S } = makeSandbox();
    const kept = { state: 'kept' };
    assert.match(S.browseKeepMarkHtml(kept, 'folder'), /width="12" height="12"/);
    assert.match(S.browseKeepMarkHtml(kept, 'card'), /width="10" height="10"/);
    assert.match(S.browseKeepMarkHtml({ state: 'copying', live: true, pct: 12 }, 'folder'), /browse\.keep\.copyingPct\{&quot;pct&quot;:12\}/);
    const folder = job('folder', 'done', { filepath: '/music/Boukmanflow/Second Shift', title: 'Second Shift' }, { result: manyResult(['a']) });
    const box = makeSandbox({ jobs: [folder] });
    await box.openGate();
    box.S.setDirs(['music', 'Boukmanflow']);
    box.S.printdir({ path: '/music/Boukmanflow/', directories: [{ name: 'Second Shift' }], files: [] });
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.match(box.S.browseKeepSlotHtml('2|folder|/music/Boukmanflow/Second Shift', 'folder', 'span'), /width="12"/);
    assert.ok(box.patches.some((p) => p.key === '2|folder|/music/Boukmanflow/Second Shift' && /width="12"/.test(p.html)), 'the poll draws it the same');
  });

  test('counts in the app\'s language: "1,240 songs"', async () => {
    const box = makeSandbox();
    await box.openGate();
    box.S.setDirs(['music', 'Night Owl Radio Archive']);
    box.S.printdir({ path: '/music/Night Owl Radio Archive/', directories: [], files: Array.from({ length: 1240 }, (_, i) => ({ type: 'mp3', name: `${i}.mp3` })) });
    assert.match(headHtml(box), /discover\.modal\.songCount\{&quot;count&quot;:1,240\}/);
    assert.equal(box.S.browseKeepCount('browse.head.albumsOn', 4, { peer: 'P' }), 'browse.head.albumsOn{"count":4,"peer":"P"}', 'under a thousand, as it is');
  });

  test('Various Artists, and an artist whose every album here is a compilation, offer no artist copy (their cards keep their ⋯)', async () => {
    const va = makeSandbox({ api: { artistAlbums: () => ({ albums: [BOUK_ALBUMS[2], { ...BOUK_ALBUMS[2], name: 'Block Party', compilation: false }] }) } });
    await va.openGate();
    await va.S.getArtistsAlbums('Various Artists');
    assert.ok(!va.head.kids['.browse-keep'], 'no button');
    assert.match(headHtml(va), /browse\.keep\.noArtistCopy\{&quot;artist&quot;:&quot;Various Artists&quot;\}/);
    assert.equal(cardsOf(va.S.html()).filter((c) => c.includes('browse-keep-more')).length, 2);
    const curator = makeSandbox({ api: { artistAlbums: () => ({ albums: [{ ...BOUK_ALBUMS[2], album_artist: 'DJ Curator', artists: ['DJ Curator'] }] }) } });
    await curator.openGate();
    await curator.S.getArtistsAlbums('DJ Curator');
    assert.ok(!curator.head.kids['.browse-keep']);
  });

  test('the focused header button keeps its name while only the figure moves; a new state, or the keyboard leaving, gives the new one', async () => {
    const box = await (async () => {
      const b = makeSandbox({ jobs: [job('album', 'running', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { id: 300, progress: 0.4 })], api: { albumSongs: () => TAPES } });
      await b.openGate();
      b.S.setState([{ state: 'allAlbums' }]);
      await b.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
      for (let i = 0; i < 6; i++) { await tick(); }
      return b;
    })();
    const btn = box.head.kids['.browse-keep'];
    const named = btn.attrs['aria-label'];
    assert.match(named, /43%|40%/);
    box.globals.document.activeElement = btn;
    box.setJobs([job('album', 'running', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { id: 300, progress: 0.55 })]);
    box.tickJobs();
    assert.equal(btn.attrs['aria-label'], named, 'not spoken again at each beat');
    assert.match(btn.innerHTML, /55%/, 'the face moves on');
    box.globals.document.activeElement = null;
    box.S.browseHeadDraw();
    assert.match(btn.attrs['aria-label'], /55%/, 'the keyboard left: the name catches up');
    box.globals.document.activeElement = btn;
    box.setJobs([job('album', 'done', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { id: 300, result: manyResult(TAPES.map((x) => x.filepath)) })]);
    box.tickJobs();
    assert.equal(btn.attrs['aria-label'], 'browse.keep.stateAria{"name":"Borrowed Tapes","state":"discover.keep.kept"}', 'a new state is said');
    assert.match(headHtml(box), / onblur="browseHeadDraw\(\);"/);
  });

  test('the button\'s words shrink before it leaves the column; the figure never does', async () => {
    const box = makeSandbox({ jobs: [job('album', 'running', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { progress: 0.43 })], api: { albumSongs: () => TAPES } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.match(box.head.kids['.browse-keep'].innerHTML, /<span class="browse-keep-w">discover\.keep\.copying<\/span><span class="browse-keep-pct">43%<\/span>/);
  });
});

describe('marks keep to this server: the cases a regression would slip through', () => {
  const ALL = ['Borrowed Tapes', 'Harbour Lights'];
  const artistDone = (peer) => job('artist', 'done', { artist: 'Boukmanflow', peer }, { result: { scope: 'artist', albums: ALL.map((name) => ({ name, songs: { total: 3, copied: [{ from: 'a' }], skipped: [], failed: [] } })), peer } });

  test('another server\'s finished artist copy marks none of this server\'s cards', async () => {
    const box = makeSandbox({ jobs: [artistDone(PEER_C)], api: { albums: BOUK_ALBUMS.slice(0, 2) } });
    await box.openGate();
    await box.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    for (const name of ALL) { assert.equal(box.S.browseKeepSlotHtml(`2|album|${name}|Boukmanflow`, 'card', 'div').replace(/<[^>]*>/g, ''), '', name); }
    const own = makeSandbox({ jobs: [artistDone(PEER)], api: { albums: BOUK_ALBUMS.slice(0, 2) } });
    await own.openGate();
    await own.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.match(own.S.browseKeepSlotHtml('2|album|Harbour Lights|Boukmanflow', 'card', 'div'), /discover\.keep\.kept/, 'this server\'s does');
  });

  test('another server\'s finished album copy marks none of the album page\'s songs', async () => {
    const theirs = job('album', 'done', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', peer: PEER_C }, { result: manyResult(TAPES.map((x) => x.filepath), { failed: [] }) });
    const box = makeSandbox({ jobs: [theirs], api: { albumSongs: () => TAPES } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 6; i++) { await tick(); }
    for (const s of TAPES) { assert.equal(box.S.browseKeepSlotHtml(`2|song|${s.filepath}`, 'row', 'span').replace(/<[^>]*>/g, ''), ''); }
  });

  test('the artist header: "Copying from" while another server\'s artist copy runs, else this server\'s own — never the other\'s', async () => {
    const live = job('artist', 'running', { artist: 'Boukmanflow', peer: PEER_C }, { id: 500, progress: 0.3 });
    const mine = job('artist-missing', 'done', { artist: 'Boukmanflow' }, { id: 400, result: { scope: 'artist-missing', albums: [], peer: PEER } });
    const open = async (jobs) => {
      const b = makeSandbox({ jobs, api: { artistAlbums: () => ({ albums: BOUK_ALBUMS }) } });
      await b.openGate();
      await b.S.getArtistsAlbums('Boukmanflow');
      for (let i = 0; i < 4; i++) { await tick(); }
      return b;
    };
    const running = await open([live, mine]);
    assert.equal(running.head.kids['.browse-keep'].className, 'browse-keep browse-keep-on bk-other');
    // over: the other server's newer copy failed, this server's older one copied
    const failedThere = { ...live, state: 'done', progress: null, result: { ...manyResult([], { failed: ['a'] }), scope: 'artist', albums: [{ name: 'Borrowed Tapes' }], peer: PEER_C } };
    const keptHere = { ...mine, result: { ...manyResult(['b']), scope: 'artist-missing', albums: [{ name: 'Second Shift' }], peer: PEER } };
    const over = await open([failedThere, keptHere]);
    const own = over.S.browseKeepState(keptHere).state;
    assert.notEqual(over.S.browseKeepState(failedThere).state, own, 'the two say different things');
    assert.equal(over.head.kids['.browse-keep'].className, `browse-keep browse-keep-on bk-${own}`, 'this server\'s own copy speaks, not the newer one of another server');
  });

  test('a card while another server copies its album: its line stays empty (only the album page\'s header says whose)', async () => {
    const theirs = job('album', 'running', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', peer: PEER_C }, { progress: 0.6 });
    const box = makeSandbox({ jobs: [theirs], api: { albums: BOUK_ALBUMS.slice(0, 1) } });
    await box.openGate();
    await box.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.equal(box.S.browseKeepSlotHtml('2|album|Borrowed Tapes|Boukmanflow', 'card', 'div').replace(/<[^>]*>/g, ''), '');
  });

  test('with the gate shut, folder rows and card lines still say what an earlier copy is; no ⋯', async () => {
    const folder = job('folder', 'done', { filepath: '/music/Boukmanflow/Second Shift', title: 'Second Shift' }, { result: manyResult(['a']) });
    const album = job('album', 'done', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { result: manyResult(['a']) });
    const dir = makeSandbox({ jobs: [folder] });
    await dir.openGate([]);
    dir.S.setDirs(['music', 'Boukmanflow']);
    dir.S.printdir({ path: '/music/Boukmanflow/', directories: [{ name: 'Second Shift' }], files: [] });
    for (let i = 0; i < 6; i++) { await tick(); }
    assert.match(dir.S.browseKeepSlotHtml('2|folder|/music/Boukmanflow/Second Shift', 'folder', 'span'), /discover\.keep\.kept/);
    assert.ok(!dir.S.html().includes('browse-keep-tab'));
    const grid = makeSandbox({ jobs: [album], api: { albums: BOUK_ALBUMS.slice(0, 1) } });
    await grid.openGate([]);
    await grid.S.getAllAlbums();
    for (let i = 0; i < 4; i++) { await tick(); }
    assert.match(grid.S.browseKeepSlotHtml('2|album|Borrowed Tapes|Boukmanflow', 'card', 'div'), /discover\.keep\.kept/);
    assert.ok(!grid.S.html().includes('browse-keep-more'));
  });

  test('a job list older than what the lookup found does not replace it', async () => {
    const newer = job('album', 'done', { album: 'Borrowed Tapes', albumArtist: 'Boukmanflow' }, { id: 900, result: manyResult(TAPES.map((x) => x.filepath)) });
    const box = makeSandbox({ jobs: [newer], api: { albumSongs: () => TAPES } });
    await box.openGate();
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.getAlbumSongs('Borrowed Tapes', null, 2019, 'Boukmanflow');
    for (let i = 0; i < 6; i++) { await tick(); }
    box.setJobs([{ ...newer, id: 899, state: 'running', progress: 0.1, result: null }]);
    box.tickJobs();
    assert.equal(box.head.kids['.browse-keep'].className, 'browse-keep browse-keep-on bk-kept');
  });
});

describe('the page\'s styles (spa.css)', () => {
  const CSS = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
  test('the header bar\'s holder takes no cell of the header\'s grid: no row gap under the action row at a narrow width', () => {
    assert.match(CSS, /\.browse-head > \[data-head="bar"\] \{ display: contents; \}/);
  });
  test('the header button never runs off the column: the box keeps to it, the words shrink to an ellipsis, the figure never does', () => {
    assert.match(CSS, /\.browse-keep, \.browse-keep-plain \{ max-width: 100%; min-width: 0; \}/);
    assert.match(CSS, /\.browse-keep \.browse-keep-w, \.browse-keep-plain \.browse-keep-w \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
    assert.match(CSS, /\.browse-keep-pct \{ flex: none;/);
  });
  test('the header\'s lines break a name with no space anywhere', () => {
    assert.match(CSS, /\.browse-head-line \{[^}]*overflow-wrap: anywhere;/);
    assert.match(CSS, /\.browse-head-live \{[^}]*overflow-wrap: anywhere;/);
  });
  test('keyboard focus inside any album card shows its play button (which Tab reaches before the ⋯), with the house ring', () => {
    assert.match(CSS, /\.album-grid-card:has\(:focus-visible\) \.album-grid-play \{ opacity: 1; transform: translateY\(0\); \}/);
    assert.match(CSS, /\.album-grid-play:focus-visible \{ outline: 2px solid #fa832b; outline-offset: 2px; \}/);
    const fallback = CSS.slice(CSS.indexOf('@supports not selector(:has(*))'));
    assert.match(fallback, /^@supports not selector\(:has\(\*\)\) \{\s*\.album-grid-card:focus-within \.album-grid-play \{ opacity: 1; transform: translateY\(0\); \}/);
  });
});
