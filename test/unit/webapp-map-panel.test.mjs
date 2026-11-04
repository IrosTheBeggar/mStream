/**
 * The music map's panel wiring (docs/music-map-plan.md §4.1, §4.2, §4.11):
 * everything outside alpha/music-map.js that makes the Map a panel of the
 * webapp. What is pinned:
 *   - mapPanel() sets programState before the peer guard, and on a
 *     connected server goes home (switchServer(null)) drawing nothing; on
 *     this server it hides the bar, draws #map-head, takes the column
 *     (#filelist.mmap-on, body.map-open, aria-current) and mounts
 *     MUSICMAP on #filelist with `deps`;
 *   - mapHide() (every root panel, guarded; an album opened over the map)
 *     destroys the mount, drops what it subscribed to through deps and the
 *     map's own Sonic Path pick, and gives the column back;
 *   - `map` is a panel (PANELS_BY_STATE) and never a peer-capable one;
 *     init() hands the ping to applyMapPing, which shows #nav-map on
 *     `discovery && discoveryMap >= 1` unless a 403 took it away; the entry
 *     is a focusable link that Enter and Space open;
 *   - index.html: #nav-map directly above Rated, #map-head beside
 *     #dpage-head, music-map.js directly above vp.js; spa.css: the scoped
 *     tokens, the column, the 1200 px split, the phone rules;
 *   - the head: Search reveals a field (300 ms debounce, Enter, Esc),
 *     Filters is moodPanelHtml('map') with its own dispatch, Plays heat is
 *     a pressed toggle the controller can take away;
 *   - deps: the API answers are dropped after a browseGeneration bump; the
 *     now-playing watcher, the trail's sources, reduced motion, capture;
 *   - the card verbs (Play / Queue via queueRow, the ▾ menu, Auto DJ from
 *     here, Sonic Path into SONICPATH, Play / Queue all / Save on a place),
 *     and Play on a place through the REAL player (mstream.player.js and
 *     vp.js's addSongWizard): row 0 starts with Auto DJ off and on;
 *   - the player's finished-plays ring (MSTREAMPLAYER.stats.recentPlays);
 *   - discoveryMapFetch's status mapping and its wrappers (api.js);
 *   - hotkeysSkip covers .mmap; en.json holds exactly the plan's map.* keys.
 *
 * Same technique as webapp-discovery-panel.test.mjs: the real functions are
 * sliced out of m.js (and vp.js, api.js, mstream.player.js) and run
 * against stub globals; webapp/ has no browser test harness.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('webapp', 'alpha', 'm.js');
const VP_SRC = read('webapp', 'alpha', 'vp.js');
const API_SRC = read('webapp', 'alpha', 'api.js');
const PLAYER_SRC = read('webapp', 'assets', 'js', 'mstream.player.js');
const SESSION_SRC = read('webapp', 'assets', 'js', 'mstream.play-session.js');
const HTML = read('webapp', 'index.html');
const CSS = read('webapp', 'alpha', 'spa.css');
const EN = JSON.parse(read('webapp', 'locales', 'en.json'));
const MUSIC_MAP_PATH = path.join(ROOT, 'webapp', 'alpha', 'music-map.js');

function sliceFn(name, src = SRC) {
  const lines = src.split('\n');
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) =>
    header(l).startsWith(`function ${name}(`) ||
    header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceConst(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  if (lines[start].endsWith('};') || lines[start].endsWith("';")) { return lines[start]; }
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of const ${name}`);
}

// A function or method two spaces in, inside vp.js's module.
function vpSlice(startsWith) {
  const lines = VP_SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(startsWith));
  assert.ok(start >= 0, `vp.js no longer has "${startsWith}" — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '  }' || lines[i] === '  };') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of ${startsWith}`);
}

// Keep a copy's half of the browse pages: setBrowserRootPanel calls it; on
// this server's own page it draws nothing and asks nothing.
const KEEP_FNS = [...SRC.matchAll(/^(?:async )?function ((?:keepGate|browseKeep|browseHead|browseAlbum|browseArtist|browseFolder)\w*|writeReadOnlyNote)\(/gm)].map((m) => m[1]);
const keepState = () => `${['keepGate', 'browseKeep', 'BROWSE_KEEP_ICONS'].map(sliceConst).join('\n')}
    let keepGatePending = null;
    let keepGateAsk = 0;
    let browseKeepQueued = null;
    ${KEEP_FNS.map((n) => sliceFn(n)).join('\n\n')}`;

// The start tags of drawn markup, with their attributes (values decoded).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (v) => v.replace(/&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (e) => ENTITIES[e]);
function tagsOf(html) {
  const out = [];
  for (const m of String(html).matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) { attrs[a[1]] = decode(a[2] ?? ''); }
    out.push({ tag: m[1].toLowerCase(), attrs });
  }
  return out;
}
const findDrawn = (html, attrs) => tagsOf(html).find((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === String(v))) || null;
const selAttrs = (sel) => Object.fromEntries([...String(sel).matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].map((x) => [x[1], x[2]]));

const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);
const flush = () => new Promise((r) => setImmediate(r));
const PENDING = Symbol('pending');
// A promise's state after the queue drained: its value, or PENDING.
async function settled(p) {
  let out = PENDING;
  p.then((v) => { out = v; }, (e) => { out = e; });
  for (let i = 0; i < 5; i++) { await flush(); }
  return out;
}

// ── The fake DOM ─────────────────────────────────────────────────────────

function makeDom() {
  const byId = new Map();
  const drawn = new Map(); // host id → the ids its last draw put on the page
  const doc = { activeElement: null, visibilityState: 'visible', listeners: {}, focusLog: [] };
  function el(id, { tag = 'div', classes = [], attrs = {} } = {}) {
    const cls = new Set(classes);
    const at = new Map(Object.entries(attrs));
    let inner = '';
    const e = {
      id, tagName: tag.toUpperCase(), value: '', style: {}, scrollTop: 0, listeners: {},
      classList: {
        add: (c) => { cls.add(c); },
        remove: (c) => { cls.delete(c); },
        contains: (c) => cls.has(c),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) { cls.add(c); } else { cls.delete(c); } return want; },
      },
      getAttribute: (n) => (at.has(n) ? at.get(n) : null),
      setAttribute: (n, v) => { at.set(n, String(v)); },
      removeAttribute: (n) => { at.delete(n); },
      hasAttribute: (n) => at.has(n),
      addEventListener: (type, fn) => { (e.listeners[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => { e.listeners[type] = (e.listeners[type] || []).filter((f) => f !== fn); },
      focus: () => { doc.activeElement = e; doc.focusLog.push(id || '(anonymous)'); },
      querySelector: (sel) => e.query(sel),
      query: () => null,
      onHtml: () => {},
      get innerHTML() { return inner; },
      set innerHTML(h) { inner = String(h); e.onHtml(inner); },
    };
    if (id) { byId.set(id, e); }
    return e;
  }
  // A host whose draw registers the ids it draws (and drops its old ones).
  function host(id, opts) {
    const h = el(id, opts);
    let root = null;
    h.onHtml = (html) => {
      for (const old of drawn.get(id) || []) { byId.delete(old); }
      const ids = [];
      for (const tag of tagsOf(html)) {
        if (!tag.attrs.id) { continue; }
        const child = el(tag.attrs.id, { tag: tag.tag, classes: (tag.attrs.class || '').split(/\s+/).filter(Boolean), attrs: tag.attrs });
        ids.push(tag.attrs.id);
        if (tag.attrs.id === 'map-moods') {
          // its buttons, by attributes, from what it draws
          child.query = (sel) => {
            const found = findDrawn(child.innerHTML, selAttrs(sel));
            return found ? { focus: () => { doc.activeElement = { attrs: found.attrs }; doc.focusLog.push(sel); } } : null;
          };
        }
      }
      drawn.set(id, ids);
      root = /class="mmap mmap-head"/.test(html) ? el(null, { classes: ['mmap', 'mmap-head'] }) : null;
    };
    h.query = (sel) => (sel === '.mmap-head' ? root : null);
    h.root = () => root;
    return h;
  }
  return { byId, doc, el, host };
}

// ── The m.js sandbox ─────────────────────────────────────────────────────

const MAP_FNS = ['escapeHtml', 'queueRow', 'setBrowserRootPanel', 'discoveryHideHead', 'hideMoodFilters',
  'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'songListMoods', 'discoveryNowPlayingPath',
  'applyMapPing', 'mapNavKey', 'mapOnScreen', 'mapPanel', 'mapHide', 'mapCancelPick', 'mapEmit', 'mapDeps', 'mapWatchNowPlaying',
  'mapDisable', 'mapHeadHtml', 'mapRenderHead', 'mapRenderMoods', 'onMapHeadClick', 'mapToggleSearch',
  'onMapHeadInput', 'onMapHeadKey', 'mapSetHeat', 'mapPickMood', 'mapRowMeta', 'mapAutoDj', 'mapSonicPath',
  'mapBuildPath', 'mapPlayAll', 'mapQueueAll', 'mapSaveAsPlaylist', 'getAlbumSongs', 'onBackButton'];

// The sliced m.js, built once: every sandbox runs it against its own stubs.
let sandboxSrc = null;
function sandboxBody() {
  if (sandboxSrc) { return sandboxSrc; }
  sandboxSrc = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let peerContext = __peer;
    let browseGeneration = 0;
    let fileExplorerArray = [];
    const discoveryView = { flags: { moodFilters: __moodFilters, discoveryPlugins: false } };
    ${sliceConst('entityMap')}
    ${sliceConst('MOODS')}
    ${sliceConst('SONICPATH')}
    ${sliceConst('mapView')}
    ${sliceConst('MAP_ICONS')}
    ${keepState()}
    ${MAP_FNS.map((n) => sliceFn(n)).join('\n\n')}
    return {
      ${MAP_FNS.join(', ')},
      MOODS, SONICPATH, mapView, MAP_ICONS,
      state: () => programState,
      setState: (s) => { programState = s; },
      setPeer: (p) => { peerContext = p; },
      bump: () => { browseGeneration++; },
      gen: () => browseGeneration,
    };
  `;
  return sandboxSrc;
}

//   peer         the connected server the app points at (null: this one)
//   moodFilters  the ping's flag (Filters in the head)
//   playing      MSTREAMPLAYER.getCurrentSong()
//   autoDJ       MSTREAMPLAYER.playerStats.autoDJ
//   reduced      prefers-reduced-motion: reduce
//   noMusicMap   window.MUSICMAP missing (the script did not load)
//   onMount      (host, deps) => …, run inside MUSICMAP.mount
//   api          MSTREAMAPI overrides
//   player, vpc  a real MSTREAMPLAYER / VUEPLAYERCORE (the end-to-end tests)
function makeSandbox(opts = {}) {
  const { byId, doc, el, host } = makeDom();
  for (const id of ['directory_bar', 'localSearchBar', 'directoryName', 'local_search_btn', 'upload_btn', 'mkdir_btn', 'mood_filter_btn', 'mood_filters', 'dpage-head', 'nav-sonic-path']) { el(id); }
  byId.get('dpage-head').classList.add('super-hide');
  const filelist = el('filelist');
  const head = host('map-head', { classes: ['super-hide'] });
  const nav = el('nav-map', { classes: ['local-only', 'side-nav-item', 'my-waves', 'super-hide'], attrs: { role: 'link', tabindex: '0', 'data-panel': 'map' } });
  const feNav = el(null, { classes: ['side-nav-item'], attrs: { 'data-panel': 'fileExplorer' } });
  const title = el(null);
  const body = el(null);
  const calls = [];
  const log = (name, ...args) => { calls.push({ name, args }); };
  const mounts = [];
  const vues = [];
  const timers = [];
  let timerSeq = 0;
  const toasts = [];
  const banners = [];
  let S = null;
  class FakeVue {
    constructor(o) { this.o = o; this.destroyed = false; vues.push(this); }
    $destroy() { this.destroyed = true; }
    fire() { for (const w of Object.values(this.o.watch)) { (typeof w === 'function' ? w : w.handler).call(this); } }
  }
  const metadata = { filepath: '', title: '' };
  const MSTREAMPLAYER = opts.player || {
    positionCache: { val: 2 },
    playerStats: { autoDJ: opts.autoDJ === true, metadata },
    getCurrentSong: () => (typeof opts.playing === 'function' ? opts.playing() : opts.playing || null),
    clearPlaylist: () => { log('clearPlaylist'); },
    toggleAutoDJ: () => { log('toggleAutoDJ'); },
    autoDjKick: () => { log('autoDjKick'); },
    stats: { recentPlays: () => [{ filePath: 'demo/a.mp3', federated: false }], session: () => opts.session ?? null },
  };
  const VUEPLAYERCORE = opts.vpc || {
    songCapture: null,
    addSongWizard: (...args) => { log('addSongWizard', ...args); },
    addFederationSongWizard: (...args) => { log('addFederationSongWizard', ...args); },
  };
  const answer = (name, fallback) => (...args) => { log(name, ...args); return Promise.resolve(opts.api && opts.api[name] ? opts.api[name](...args) : fallback); };
  const MSTREAMAPI = {
    currentServer: { host: 'http://host/', token: 'TOK' },
    discoveryMap: answer('discoveryMap', { state: 'empty' }),
    discoveryMapOverlay: answer('discoveryMapOverlay', null),
    discoveryMapTracks: answer('discoveryMapTracks', { tracks: [] }),
    discoveryMapSearch: answer('discoveryMapSearch', { ids: [], best: null, capped: false }),
    discoveryMapRegion: answer('discoveryMapRegion', { notFound: true }),
    discoveryMapNeighbours: answer('discoveryMapNeighbours', { notFound: true }),
    statsHistory: answer('statsHistory', { items: [], next: null }),
    discoveryPath: answer('discoveryPath', null),
  };
  const globals = {
    document: {
      body,
      get activeElement() { return doc.activeElement; },
      get visibilityState() { return doc.visibilityState; },
      getElementById: (id) => byId.get(id) ?? null,
      getElementsByClassName: (c) => (c === 'panel_one_name' ? [title] : []),
      querySelector: (sel) => (sel === '.side-nav-item[data-panel="fileExplorer"]' ? feNav : null),
      addEventListener: (type, fn) => { (doc.listeners[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn); },
    },
    window: { matchMedia: (q) => ({ matches: opts.reduced === true && /prefers-reduced-motion:\s*reduce/.test(q) }) },
    MSTREAMAPI,
    MSTREAMPLAYER,
    VUEPLAYERCORE,
    AUTODJ: {
      setState: (patch) => { log('AUTODJ.setState', patch); },
      setSonicSeed: (fp, label) => { log('AUTODJ.setSonicSeed', fp, label); return true; },
      getIgnoreList: () => (opts.ignoreList || []).slice(),
      setIgnoreList: (list) => { log('AUTODJ.setIgnoreList', list); },
    },
    MSTREAMPLAYSESSION: { tabSessionId: () => 'tab-1' },
    MUSICMAP: opts.noMusicMap ? undefined : {
      mount: (hostEl, deps) => {
        const inst = { host: hostEl, deps, destroyed: 0, update() {}, destroy() { inst.destroyed++; } };
        mounts.push(inst);
        if (opts.onMount) { opts.onMount(hostEl, deps, inst); }
        return inst;
      },
    },
    Vue: FakeVue,
    iziToast: { success: (o) => toasts.push(o), error: (o) => toasts.push({ ...o, error: true }), warning: (o) => toasts.push(o) },
    t: tStub,
    getLoadingSvg: () => '<svg class="spinner"></svg>',
    changeView: (fn, navEl) => { log('changeView', fn.name, navEl); fn(); },
    loadFileExplorer: function loadFileExplorer() { log('loadFileExplorer'); S.setBrowserRootPanel('panel.fileExplorer'); S.setState([{ state: 'fileExplorer' }]); },
    switchServer: (peerId) => { log('switchServer', peerId, S.state().map((s) => ({ ...s }))); },
    sonicPathHideBanner: () => { log('sonicPathHideBanner'); },
    showPickBanner: (text, onCancel) => { banners.push({ text, onCancel }); log('showPickBanner', text); },
    openSavePlaylistModal: (getPaths) => { log('openSavePlaylistModal', getPaths()); },
    createPopper3: (anchor) => { log('createPopper3', anchor); },
    setTimeout: (fn, ms) => { timers.push({ id: ++timerSeq, fn, ms }); return timerSeq; },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i !== -1) { timers.splice(i, 1); } },
    applyServerContext: () => {},
    highlightNavPanel: () => {},
    boilerplateFailure: () => {},
    browseApi: (name, body) => { log('browseApi', name, body); return Promise.resolve([]); },
    albumSongsBody: (album) => ({ album }),
    createMusicFileHtml: () => '',
    console: { error: (...a) => log('console.error', ...a), warn: () => {}, log: () => {} },
  };
  const names = [...Object.keys(globals), '__peer', '__moodFilters'];
  const extra = { __peer: opts.peer || null, __moodFilters: opts.moodFilters !== false };
  S = new Function(...names, sandboxBody())(...names.map((n) => (n in extra ? extra[n] : globals[n])));
  const runTimers = () => { while (timers.length) { const x = timers.shift(); x.fn(); } };
  const pendingTimers = () => timers.map((x) => x.ms);
  // the head's root (its delegated listeners) and its drawn controls
  const headRoot = () => head.root();
  const dispatch = (type, ev) => {
    const r = headRoot();
    assert.ok(r, 'no head drawn');
    for (const fn of r.listeners[type] || []) { fn(ev); }
  };
  // Click a drawn head control: by id, or a Filters panel button by attrs.
  const clickHead = (idOrAttrs) => {
    let target;
    if (typeof idOrAttrs === 'string') {
      target = byId.get(idOrAttrs);
      assert.ok(target, `#${idOrAttrs} is not drawn`);
    } else {
      const panel = byId.get('map-moods');
      const found = panel && findDrawn(panel.innerHTML, idOrAttrs);
      assert.ok(found, `nothing drawn with ${JSON.stringify(idOrAttrs)}`);
      target = { getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) };
    }
    dispatch('click', { target: { closest: (sel) => (sel === '[data-mmh]' && target.getAttribute('data-mmh') ? target : null) } });
  };
  const typeSearch = (text) => {
    const field = byId.get('map-search');
    assert.ok(field, 'no search field drawn');
    field.value = text;
    dispatch('input', { target: field });
  };
  const keySearch = (key) => {
    const field = byId.get('map-search');
    let prevented = false;
    dispatch('keydown', { target: field, key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { S, byId, doc, filelist, head, nav, feNav, title, body, calls, mounts, vues, toasts, banners, metadata, MSTREAMPLAYER, VUEPLAYERCORE, MSTREAMAPI, runTimers, pendingTimers, clickHead, typeSearch, keySearch, named: (name) => calls.filter((c) => c.name === name) };
}

const lastMount = (sb) => sb.mounts[sb.mounts.length - 1];

// ── Opening ──────────────────────────────────────────────────────────────

describe('Map panel: opening (mapPanel)', () => {
  test('on this server: programState first, the bar hidden, the head drawn, the column taken, then MUSICMAP.mount(#filelist, deps)', () => {
    let atMount = null;
    const sb = makeSandbox({
      onMount: (hostEl) => {
        atMount = {
          host: hostEl,
          state: sb.S.state().map((s) => ({ ...s })),
          bar: sb.byId.get('directory_bar').style.display,
          headShown: !sb.head.classList.contains('super-hide'),
          heat: !!sb.byId.get('map-heat-btn'),
          mmapOn: sb.filelist.classList.contains('mmap-on'),
          mapOpen: sb.body.classList.contains('map-open'),
          current: sb.nav.getAttribute('aria-current'),
        };
      },
    });
    sb.S.mapPanel();
    assert.equal(sb.mounts.length, 1, 'mounted once');
    assert.equal(atMount.host, sb.filelist, 'on #filelist');
    assert.deepEqual(atMount.state, [{ state: 'map' }]);
    assert.equal(atMount.bar, 'none', 'setBrowserRootPanel(…, false) hid #directory_bar');
    assert.ok(atMount.headShown && atMount.heat, 'the head is drawn before the mount');
    assert.ok(atMount.mmapOn && atMount.mapOpen, 'the column is the map\'s before the mount');
    assert.equal(atMount.current, 'page');
    assert.equal(sb.title.innerHTML, 'panel.map', 'titled with panel.map');
    assert.equal(sb.S.mapView.mount.inst, lastMount(sb), 'the mount kept for its teardown');
    assert.equal(sb.S.gen(), 1, 'a load still out for the page left is superseded');
    // the order inside the function: programState, the peer guard,
    // setBrowserRootPanel, the head, the classes, the mount
    const fn = sliceFn('mapPanel');
    const at = (s) => { const i = fn.indexOf(s); assert.ok(i > 0, s); return i; };
    assert.ok(at("programState = [{ state: 'map' }];") < at('if (peerContext)'));
    assert.ok(at('if (peerContext)') < at('browseGeneration++;'));
    assert.ok(at('browseGeneration++;') < at("setBrowserRootPanel(t('panel.map'), false);"));
    assert.ok(at("setBrowserRootPanel(t('panel.map'), false);") < at('mapRenderHead();'));
    assert.ok(at('mapRenderHead();') < at("filelist.classList.add('mmap-on');"));
    assert.ok(at("document.body.classList.add('map-open');") < at('MUSICMAP.mount(filelist, mapDeps(m))'));
  });

  test('on a connected server: programState is set before the peer guard, then switchServer(null) — nothing drawn, nothing mounted', () => {
    const sb = makeSandbox({ peer: { id: 4, name: 'Peer' } });
    sb.S.setState([{ state: 'allAlbums' }]);
    sb.S.mapPanel();
    const sw = sb.named('switchServer');
    assert.equal(sw.length, 1);
    assert.equal(sw[0].args[0], null, 'home');
    assert.deepEqual(sw[0].args[1], [{ state: 'map' }], 'the keep logic will land back on the map');
    assert.equal(sb.mounts.length, 0);
    assert.ok(sb.head.classList.contains('super-hide'), 'no head');
    assert.ok(!sb.filelist.classList.contains('mmap-on'));
    assert.equal(sb.byId.get('directory_bar').style.display, undefined, 'setBrowserRootPanel never ran');
  });

  test('switchServer lands back on the map: `map` is a panel, never a peer-capable one', () => {
    assert.match(SRC, /\n {2}map: \(\) => mapPanel\(\),\n/);
    const S = new Function('mapPanel', `${sliceConst('PANELS_BY_STATE')}\nreturn PANELS_BY_STATE;`)(() => 'drawn');
    assert.equal(S.map(), 'drawn');
    const peerCapable = SRC.slice(SRC.indexOf('const PEER_CAPABLE_STATES'), SRC.indexOf(']);', SRC.indexOf('const PEER_CAPABLE_STATES')));
    assert.ok(!/'map'/.test(peerCapable));
    // the real switch: keep only what a peer can answer
    assert.match(sliceFn('switchServer'), /const keep = PANELS_BY_STATE\[current\] && \(!peerContext \|\| PEER_CAPABLE_STATES\.has\(current\)\);/);
  });

  test('a page without music-map.js (it failed to load) says the one failed line, never throws', () => {
    const sb = makeSandbox({ noMusicMap: true });
    sb.S.mapPanel();
    assert.match(sb.filelist.innerHTML, /class="mmap mmap-plate"/);
    assert.match(sb.filelist.innerHTML, /<div class="mmap-line">map\.failed<\/div>/);
    assert.ok(sb.filelist.classList.contains('mmap-on'));
  });

  test('a mount that throws is logged and says the failed line; the page stays up', () => {
    const sb = makeSandbox({ onMount: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => sb.S.mapPanel());
    assert.equal(sb.named('console.error').length, 1);
    assert.equal(sb.S.mapView.mount.inst, null);
    assert.match(sb.filelist.innerHTML, /<div class="mmap-line">map\.failed<\/div>/);
    assert.ok(sb.filelist.classList.contains('mmap-on') && !sb.head.classList.contains('super-hide'));
  });

  test('a mount that hands the column back while mounting (deps.disable at once) is destroyed, never kept', () => {
    const sb = makeSandbox({ onMount: (h, deps) => { deps.disable(); } });
    sb.S.mapPanel();
    sb.runTimers(); // the File Explorer takes over on the next tick
    assert.equal(sb.named('loadFileExplorer').length, 1);
    assert.equal(lastMount(sb).destroyed, 1, 'destroyed once');
    assert.equal(sb.S.mapView.mount, null);
  });
});

// ── Leaving ──────────────────────────────────────────────────────────────

describe('Map panel: leaving (mapHide)', () => {
  test('another root panel tears it down: destroy once, the column, aria-current, the head, every subscription, the watcher, the visibility listener', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const heard = [];
    deps.head.onSearch((q) => heard.push(['search', q]));
    deps.head.onPlaysHeat((on) => heard.push(['heat', on]));
    deps.moods.subscribe((f) => heard.push(['moods', f]));
    deps.nowPlaying.subscribe((p) => heard.push(['np', p]));
    deps.visible.subscribe(() => heard.push(['visible']));
    assert.equal(sb.vues.length, 1, 'one now-playing watcher');
    assert.equal((sb.doc.listeners.visibilitychange || []).length, 1);
    assert.equal(deps.live(), true);

    sb.S.setState([{ state: 'allAlbums' }]);
    sb.S.setBrowserRootPanel('panel.albums');
    assert.equal(lastMount(sb).destroyed, 1);
    assert.ok(!sb.filelist.classList.contains('mmap-on'));
    assert.ok(!sb.body.classList.contains('map-open'));
    assert.equal(sb.nav.getAttribute('aria-current'), null);
    assert.ok(sb.head.classList.contains('super-hide'));
    assert.equal(sb.head.innerHTML, '');
    assert.equal(sb.vues[0].destroyed, true);
    assert.equal((sb.doc.listeners.visibilitychange || []).length, 0);
    assert.equal(deps.live(), false);
    for (const kind of ['search', 'heat', 'moods', 'nowPlaying', 'visible']) { sb.S.mapEmit(kind, 'x'); }
    sb.vues[0].fire();
    assert.deepEqual(heard, [], 'nothing reaches a torn-down mount');
    // and a second teardown is a no-op
    sb.S.setBrowserRootPanel('panel.albums');
    assert.equal(lastMount(sb).destroyed, 1);
  });

  test('the map\'s own Sonic Path pick goes with it (and its banner); another panel\'s pick stays armed', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    lastMount(sb).deps.verbs.sonicPath({ filepath: 'demo/a.mp3', metadata: { title: 'A' } }, {});
    assert.equal(sb.VUEPLAYERCORE.songCapture.mmap, true);
    sb.S.setBrowserRootPanel('panel.albums');
    assert.equal(sb.VUEPLAYERCORE.songCapture, null);
    assert.equal(sb.named('sonicPathHideBanner').length, 1);

    const other = () => {};
    sb.S.mapPanel();
    sb.VUEPLAYERCORE.songCapture = other;
    sb.S.setBrowserRootPanel('panel.albums');
    assert.equal(sb.VUEPLAYERCORE.songCapture, other, 'Sonic Path\'s "Pick from library…" can still be answered');
  });

  test('opening the map again replaces the mount: the old one is destroyed first', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const first = lastMount(sb);
    sb.S.mapPanel();
    assert.equal(sb.mounts.length, 2);
    assert.equal(first.destroyed, 1);
    assert.equal(first.deps.live(), false);
    assert.equal(lastMount(sb).deps.live(), true);
    assert.ok(sb.filelist.classList.contains('mmap-on'), 'still the map\'s column');
  });

  test('an album opened over the map (the now-playing card\'s) takes the column back, with the bar; Back returns to the map', async () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const first = lastMount(sb);
    await sb.S.getAlbumSongs('Perspectives EP', null, null, null);
    assert.equal(first.destroyed, 1);
    assert.ok(!sb.filelist.classList.contains('mmap-on'), 'the list scrolls again');
    assert.ok(!sb.body.classList.contains('map-open'));
    assert.ok(sb.head.classList.contains('super-hide'));
    assert.equal(sb.byId.get('directory_bar').style.display, '', 'the bar, with its Back');
    assert.deepEqual(sb.S.state().map((s) => s.state), ['map', 'album']);
    await sb.S.onBackButton();
    assert.equal(sb.mounts.length, 2, 'the map again');
    assert.deepEqual(sb.S.state(), [{ state: 'map' }]);
  });

  test('guards: setBrowserRootPanel still calls discoveryHideHead(), and mapHide only behind its typeof guard — the sliced sandboxes without the map run it', () => {
    const fn = sliceFn('setBrowserRootPanel');
    assert.ok(fn.includes('discoveryHideHead()'), 'every root panel hides Discover\'s head');
    assert.match(fn, /typeof mapHide === 'function' && mapHide\(\);/);
    assert.ok(fn.indexOf('hideMoodFilters();') < fn.indexOf('mapHide()'), 'after the existing hide calls');
    // a sandbox like the six that slice it (no mapHide, unknown ids null)
    const els = new Map(['directory_bar', 'localSearchBar', 'directoryName', 'local_search_btn', 'upload_btn', 'mkdir_btn']
      .map((id) => [id, { style: {}, classList: { add() {}, remove() {} }, value: '', innerHTML: '' }]));
    const run = new Function('document', 't', `'use strict';
      let currentBrowsingList = []; let programState = []; let peerContext = null; let browseGeneration = 0; let fileExplorerArray = [];
      ${sliceConst('entityMap')}
      ${keepState()}
      ${['escapeHtml', 'setBrowserRootPanel', 'discoveryHideHead', 'hideMoodFilters'].map((n) => sliceFn(n)).join('\n')}
      return setBrowserRootPanel;`)({ getElementById: (id) => els.get(id) ?? null, getElementsByClassName: () => [], body: { classList: { remove() {} } } }, tStub);
    assert.doesNotThrow(() => run('panel.albums'));
    // getAlbumSongs's and onBackButton's map branches are guarded the same way
    assert.match(sliceFn('getAlbumSongs'), /under\.state === 'map' && typeof mapHide === 'function'/);
    assert.match(sliceFn('onBackButton'), /backState\.state === 'map' && typeof mapPanel === 'function'/);
  });
});

// ── The nav entry and the flag ───────────────────────────────────────────

describe('Map panel: the nav entry and the flag', () => {
  test('applyMapPing: shown on discovery && discoveryMap >= 1; hidden otherwise; a 403 keeps it hidden for the session', () => {
    const sb = makeSandbox();
    sb.S.applyMapPing({ discovery: true, discoveryMap: 1 });
    assert.equal(sb.MSTREAMAPI.currentServer.discoveryMap, true);
    assert.ok(!sb.nav.classList.contains('super-hide'));
    for (const off of [{ discovery: true, discoveryMap: 0 }, { discovery: false, discoveryMap: 1 }, { discovery: true }, {}, null]) {
      sb.S.applyMapPing(off);
      assert.ok(sb.nav.classList.contains('super-hide'), JSON.stringify(off));
      assert.equal(sb.MSTREAMAPI.currentServer.discoveryMap, false);
    }
    sb.S.applyMapPing({ discovery: true, discoveryMap: '2' });
    assert.ok(!sb.nav.classList.contains('super-hide'), 'a later generation (or a string) still counts');
    sb.S.mapView.off = true;
    sb.S.applyMapPing({ discovery: true, discoveryMap: 1 });
    assert.ok(sb.nav.classList.contains('super-hide'), 'gone for the session after a 403');
  });

  test('init() hands the ping to applyMapPing, beside Discover\'s', () => {
    const init = sliceFn('init');
    assert.ok(init.includes('applyMapPing(response);'));
    assert.ok(init.indexOf('applyDiscoveryPing(response);') < init.indexOf('applyMapPing(response);'));
  });

  test('mapNavKey: Enter and Space open the map (Space never reaches the player\'s play/pause); other keys do nothing', () => {
    const sb = makeSandbox();
    const key = (k, extra = {}) => {
      const ev = { key: k, prevented: false, stopped: false, preventDefault() { ev.prevented = true; }, stopPropagation() { ev.stopped = true; }, ...extra };
      sb.S.mapNavKey(ev, sb.nav);
      return ev;
    };
    for (const k of ['Enter', ' ']) {
      const before = sb.named('changeView').length;
      const ev = key(k);
      assert.ok(ev.prevented && ev.stopped, k);
      const opened = sb.named('changeView').slice(before);
      assert.equal(opened.length, 1, k);
      assert.equal(opened[0].args[0], 'mapPanel');
      assert.equal(opened[0].args[1], sb.nav, 'the entry is selected like a click');
    }
    const before = sb.named('changeView').length;
    for (const k of ['a', 'Tab', 'ArrowDown', 'Escape']) {
      const ev = key(k);
      assert.ok(!ev.prevented && !ev.stopped, k);
    }
    key('Enter', { repeat: true });
    assert.equal(sb.named('changeView').length, before, 'nothing else opens it (a held key neither)');
  });

  test('index.html: #nav-map is a focusable link directly above Rated, after Discover, hidden until the ping, with the folded-map icon', () => {
    const tag = HTML.match(/<div id="nav-map"[^>]*>/);
    assert.ok(tag, 'the entry');
    const attrs = tagsOf(tag[0])[0].attrs;
    assert.equal(attrs.role, 'link');
    assert.equal(attrs.tabindex, '0');
    for (const c of ['local-only', 'side-nav-item', 'my-waves', 'super-hide']) { assert.ok(attrs.class.split(' ').includes(c), c); }
    assert.equal(attrs.onclick, 'changeView(mapPanel, this);');
    assert.equal(attrs.onkeydown, 'mapNavKey(event, this);');
    assert.equal(attrs['data-panel'], 'map', 'highlightNavPanel finds it');
    const at = HTML.indexOf('<div id="nav-map"');
    const disc = HTML.indexOf('id="nav-discover"');
    const rated = HTML.indexOf('data-panel="allRated"');
    assert.ok(disc > 0 && at > disc && rated > at);
    // directly above Rated: the next nav entry after the map's is Rated
    const nextItem = HTML.slice(at + 1).match(/<div [^>]*class="[^"]*side-nav-item[^"]*"[^>]*>/);
    assert.match(nextItem[0], /data-panel="allRated"/);
    const entry = HTML.slice(at, HTML.indexOf('</div>', at));
    assert.ok(entry.includes('d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"') && entry.includes('d="M9 3v15M15 6v15"'), 'the board\'s folded map');
    assert.match(entry, /<svg [^>]*fill="none" stroke="#DDD"/, 'a stroked icon (Discover\'s precedent)');
    for (const p of entry.match(/<path [^>]*>/g)) { assert.match(p, /fill="none"/, 'the nav\'s fill:#fff never fills it'); }
    assert.match(entry, /<span data-i18n="nav\.map">Map<\/span>/);
  });

  test('index.html: #map-head beside #dpage-head in the column\'s chrome, above #filelist; music-map.js directly above vp.js', () => {
    const col = HTML.slice(HTML.indexOf('<div id="browser"'));
    const bar = col.indexOf('id="directory_bar"');
    const mhead = col.indexOf('<div id="map-head" class="super-hide"></div>');
    const dhead = col.indexOf('<div id="dpage-head" class="super-hide"></div>');
    const list = col.indexOf('<div id="filelist">');
    assert.ok(bar > 0 && mhead > bar && dhead > mhead && list > dhead, 'with the rest of the chrome, outside the scroller');
    // only comments between the two hosts (Discover's stays directly above #filelist)
    assert.match(col.slice(mhead), /^<div id="map-head" class="super-hide"><\/div>\s*<!--[\s\S]*?-->\s*<div id="dpage-head" class="super-hide"><\/div>\s*<div id="filelist">/);
    const lines = HTML.split('\n').map((l) => l.trim());
    const vp = lines.indexOf('<script src="alpha/vp.js"></script>');
    assert.equal(lines[vp - 1], '<script src="alpha/music-map.js"></script>', 'directly above vp.js');
    assert.ok(lines.indexOf('<script src="alpha/discovery-page.js"></script>') < vp - 1);
  });

  test('spa.css: the scoped tokens, the column, the 1200 px split, the phone rules — and nothing over #pop-f', () => {
    const start = CSS.indexOf('/* ── The music map');
    assert.ok(start > 0);
    const end = CSS.indexOf('/* ── ', start + 10);
    const sec = CSS.slice(start, end);
    assert.ok(start < CSS.indexOf('/* ── The Discover page'), 'its colours sit with the house palette, before the Discover page');
    assert.match(sec, /\.mmap \{[^}]*--sea: #171a1f;[^}]*--plate-edge: #2a2f37;[^}]*--lit: #f5f7fa;[^}]*--ring: #e6e8ec;[^}]*--pin: #fa832b;/);
    assert.match(sec, /#filelist\.mmap-on \{ overflow: hidden !important;/);
    assert.match(sec, /@media \(min-width: 1200px\) \{\s*body\.map-open #browser\.m6 \{ width: 56\.7%; \}\s*body\.map-open #playlist\.m6 \{ width: 43\.3%; \}\s*\}/);
    assert.match(sec, /\.mmap-plate \{[^}]*background: var\(--sea\);[^}]*border: 1px solid var\(--plate-edge\);[^}]*border-radius: 8px;/);
    assert.match(sec, /\.mmap-canvas \{[^}]*touch-action: none;/);
    assert.match(sec, /\.mmap-layer > \* \{ pointer-events: auto; touch-action: none; \}/, 'a drag or a pinch from a name is the map\'s');
    assert.match(sec, /\.mmap-card \{[^}]*max-width: calc\(100% - 24px\);/);
    assert.match(sec, /\.mmap-card-song \{ width: 506px; \}/);
    assert.match(sec, /\.mmap-card-place, \.mmap-card-path \{ width: 420px;/);
    assert.match(sec, /\.mmap-ctrls \{ position: absolute; top: 12px; right: 12px;/);
    assert.match(sec, /@media \(max-width: 600px\) \{[^}]*\.mmap-plate \{[^}]*\}\s*\.mmap-card, \.mmap-card-song, \.mmap-card-place, \.mmap-card-path \{ right: 12px; width: auto; \}/);
    assert.match(sec, /#nav-map:focus-visible \{ outline: 2px solid #fa832b;/);
    // the global svg { fill: #FFF } would fill the stroked icons solid
    assert.match(CSS, /\nsvg \{\s*fill: #FFF;\s*\}/);
    assert.match(sec, /\.mmap svg\[fill="none"\] \{ fill: none; \}\n\.mmap svg\[fill="currentColor"\] \{ fill: currentColor; \}/);
    const z = [...sec.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(z.length > 0 && z.every((n) => n < 100), `under #pop-f's 100: ${z}`);
    assert.match(CSS, /#pop-d, #pop-f \{[^}]*z-index: 100;/);
  });
});

// ── The head ─────────────────────────────────────────────────────────────

describe('Map panel: the head (#map-head)', () => {
  test('Search, Filters, a spacer, Plays heat — named buttons inside .mmap (hotkeysSkip\'s scope)', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const html = sb.head.innerHTML;
    assert.match(html, /^<div class="mmap mmap-head"><div class="mmap-bar">/);
    const order = ['id="map-search-btn"', 'id="map-search"', 'id="map-moods-btn"', '<span class="grow"></span>', 'id="map-heat-btn"'].map((s) => html.indexOf(s));
    assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`);
    assert.equal(findDrawn(html, { id: 'map-search-btn' }).attrs['aria-label'], 'map.search');
    assert.equal(findDrawn(html, { id: 'map-search-btn' }).attrs['aria-expanded'], 'false');
    assert.equal(findDrawn(html, { id: 'map-moods-btn' }).attrs['aria-label'], 'moods.filters');
    const heat = findDrawn(html, { id: 'map-heat-btn' }).attrs;
    assert.equal(heat['aria-label'], 'map.playsHeat');
    assert.equal(heat['aria-pressed'], 'false');
    const field = findDrawn(html, { id: 'map-search' }).attrs;
    assert.ok(field.class.split(' ').includes('super-hide'), 'the field waits for the button');
    assert.ok(field.class.split(' ').includes('browser-default'), 'out of materialize\'s input styles');
    assert.equal(field.maxlength, '128', 'the route\'s limit');
    assert.ok(!/onclick=/.test(html), 'one delegated handler, no inline handlers');
    assert.ok(!/Back/.test(html), 'no Back: it would be inert at a root panel');
  });

  test('Search reveals the field and focuses it; typing searches 300 ms after the last key (2+ characters); Enter searches now; Esc empties, then closes', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const heard = [];
    deps.head.onSearch((q) => heard.push(['search', q]));
    deps.head.onSearchEnter((q) => heard.push(['enter', q]));
    sb.clickHead('map-search-btn');
    const field = sb.byId.get('map-search');
    assert.ok(!field.classList.contains('super-hide'));
    assert.equal(sb.byId.get('map-search-btn').getAttribute('aria-expanded'), 'true');
    assert.equal(sb.doc.activeElement, field, 'the keyboard is in the field');
    sb.typeSearch('A');
    sb.typeSearch('Ab');
    sb.typeSearch('Abc ');
    assert.deepEqual(sb.pendingTimers(), [300], 'one debounce, restarted on each key');
    assert.deepEqual(heard, []);
    sb.runTimers();
    assert.deepEqual(heard, [['search', 'Abc']]);
    sb.typeSearch('A');
    sb.runTimers();
    assert.deepEqual(heard.at(-1), ['search', ''], 'one character searches nothing');
    sb.typeSearch('Color');
    assert.equal(sb.keySearch('Enter'), true);
    assert.deepEqual(sb.pendingTimers(), [], 'Enter drops the pending debounce');
    assert.deepEqual(heard.at(-1), ['enter', 'Color']);
    sb.typeSearch('');
    assert.deepEqual(heard.at(-1), ['search', ''], 'an emptied field clears at once');
    sb.typeSearch('Rock');
    sb.runTimers();
    assert.equal(sb.keySearch('Escape'), true);
    assert.equal(field.value, '');
    assert.deepEqual(heard.at(-1), ['search', '']);
    assert.ok(!field.classList.contains('super-hide'), 'the first Esc only empties it');
    sb.keySearch('Escape');
    assert.ok(field.classList.contains('super-hide'), 'the second closes it');
    assert.equal(sb.byId.get('map-search-btn').getAttribute('aria-expanded'), 'false');
    assert.equal(sb.doc.activeElement, sb.byId.get('map-search-btn'), 'the keyboard back on its button');
    // closing it from its button with text in it clears the search too
    sb.clickHead('map-search-btn');
    sb.typeSearch('Hip');
    sb.runTimers();
    sb.clickHead('map-search-btn');
    assert.deepEqual(heard.at(-1), ['search', '']);
    assert.equal(field.value, '');
  });

  test('Plays heat: pressed and heard; setPlaysHeat fires nothing; hidePlaysHeat takes it away for the session', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const heard = [];
    deps.head.onPlaysHeat((on) => heard.push(on));
    sb.clickHead('map-heat-btn');
    assert.equal(sb.byId.get('map-heat-btn').getAttribute('aria-pressed'), 'true');
    sb.clickHead('map-heat-btn');
    assert.equal(sb.byId.get('map-heat-btn').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(heard, [true, false]);
    deps.head.setPlaysHeat(true);
    assert.equal(sb.byId.get('map-heat-btn').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(heard, [true, false], 'set, not pressed: nothing fired');
    deps.head.hidePlaysHeat();
    assert.ok(sb.byId.get('map-heat-btn').classList.contains('super-hide'));
    assert.equal(sb.byId.get('map-heat-btn').getAttribute('aria-pressed'), 'false');
    assert.equal(sb.doc.activeElement, null, 'the keyboard was elsewhere: left alone');
    sb.S.mapPanel();
    assert.equal(sb.byId.get('map-heat-btn'), undefined, 'the next visit draws none');
  });

  test('a control taken away while the keyboard is on it hands the keyboard to Search, never to the page', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    sb.byId.get('map-heat-btn').focus();
    deps.head.hidePlaysHeat();
    assert.equal(sb.doc.activeElement, sb.byId.get('map-search-btn'), 'Plays heat (its press asked for the layer, then a 403)');
    assert.ok(sb.byId.get('map-heat-btn').classList.contains('super-hide'));
    const moods = makeSandbox();
    moods.S.mapPanel();
    moods.byId.get('map-moods-btn').focus();
    lastMount(moods).deps.head.showFilters(false);
    assert.equal(moods.doc.activeElement, moods.byId.get('map-search-btn'), 'Filters (no scores here)');
    assert.ok(moods.byId.get('map-moods-btn').classList.contains('super-hide'));
  });

  test('Filters: moodPanelHtml("map") with its own data-mmh dispatch — a pick redraws the panel in place, keeps the keyboard, and the controller hears the wire form', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const heard = [];
    deps.moods.subscribe((f) => heard.push(f));
    assert.equal(deps.moods.available(), true);
    assert.equal(deps.moods.filter(), null);
    const panelHtml = sb.S.moodPanelHtml('map');
    assert.ok(!/onclick=/.test(panelHtml), 'never the lists\' handlers (they re-ask the lists by name)');
    assert.ok(!/data-dp=/.test(panelHtml), 'never Discover\'s');
    assert.ok(findDrawn(panelHtml, { 'data-mmh': 'mood', 'data-v': 'valence:happy' }));
    assert.ok(findDrawn(panelHtml, { 'data-mmh': 'moodTag', 'data-v': 'party' }));
    assert.ok(findDrawn(panelHtml, { 'data-mmh': 'moodLevel', 'data-v': 'strict' }));
    assert.ok(findDrawn(panelHtml, { 'data-mmh': 'moodClear', 'data-v': 'all' }));
    assert.ok(!/data-mood-sort/.test(panelHtml), 'no Sort: the map has no order');

    const panel = () => sb.byId.get('map-moods');
    assert.ok(panel().classList.contains('super-hide'), 'closed on a fresh visit');
    sb.clickHead('map-moods-btn');
    assert.ok(!panel().classList.contains('super-hide'));
    assert.equal(sb.byId.get('map-moods-btn').getAttribute('aria-expanded'), 'true');
    sb.clickHead({ 'data-mmh': 'mood', 'data-v': 'valence:happy' });
    assert.deepEqual(sb.S.MOODS.filters.map, { valence: 'happy' });
    assert.equal(findDrawn(panel().innerHTML, { 'data-mmh': 'mood', 'data-v': 'valence:happy' }).attrs['aria-pressed'], 'true');
    assert.deepEqual(sb.doc.focusLog.at(-1), '[data-mmh="mood"][data-v="valence:happy"]', 'the keyboard stays on the pressed button');
    assert.ok(sb.byId.get('map-moods-btn').classList.contains('mood-on'));
    assert.deepEqual(heard, [{ valence: 'happy' }]);
    sb.clickHead({ 'data-mmh': 'moodTag', 'data-v': 'party' });
    sb.clickHead({ 'data-mmh': 'moodLevel', 'data-v': 'strict' });
    assert.deepEqual(heard.at(-1), { valence: 'happy', tags: ['party'], threshold: 0.7 });
    assert.deepEqual(deps.moods.filter(), { valence: 'happy', tags: ['party'], threshold: 0.7 });
    sb.clickHead({ 'data-mmh': 'moodLevel', 'data-v': 'strict' });
    assert.equal(heard.length, 3, 'the pressed level again: nothing');
    sb.clickHead({ 'data-mmh': 'moodClear', 'data-v': 'all' });
    assert.deepEqual(sb.S.MOODS.filters.map, {});
    assert.equal(heard.at(-1), null, 'cleared: no filter');
    assert.equal(sb.doc.activeElement, sb.byId.get('map-moods-btn'), 'Clear hides itself: back to Filters');
    assert.ok(!sb.byId.get('map-moods-btn').classList.contains('mood-on'));
    const n = heard.length;
    sb.clickHead({ 'data-mmh': 'moodLevel', 'data-v': 'loose' });
    assert.equal(heard.length, n, 'a level with no mood set sends the same nothing');
    assert.equal(findDrawn(panel().innerHTML, { 'data-mmh': 'moodLevel', 'data-v': 'loose' }).attrs['aria-pressed'], 'true', 'but shows pressed');
    sb.S.mapPickMood('mood', 'valence:nope');
    sb.S.mapPickMood('moodTag', 'loud');
    sb.S.mapPickMood('nope', 'x');
    assert.equal(heard.length, n, 'an unknown value or action is ignored');
    // the mood overlay said "no scores": Filters goes, its panel closes
    deps.head.showFilters(false);
    assert.ok(sb.byId.get('map-moods-btn').classList.contains('super-hide'));
    assert.ok(panel().classList.contains('super-hide'));
    deps.head.showFilters(true);
    assert.ok(!sb.byId.get('map-moods-btn').classList.contains('super-hide'));
  });

  test('Filters only where the server filters by mood (the ping), and never the list bar\'s panel', () => {
    const sb = makeSandbox({ moodFilters: false });
    sb.S.mapPanel();
    assert.equal(sb.byId.get('map-moods-btn'), undefined);
    assert.equal(sb.byId.get('map-moods'), undefined);
    assert.equal(lastMount(sb).deps.moods.available(), false);
    assert.ok(sb.byId.get('mood_filter_btn').classList.contains('super-hide'), 'the bar\'s own Filters stays hidden');
  });
});

// ── deps ─────────────────────────────────────────────────────────────────

describe('Map panel: deps', () => {
  test('the shape the controller codes against', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const fns = {
      '': ['t', 'escapeHtml', 'reducedMotion', 'generation', 'live', 'disable'],
      api: ['map', 'overlay', 'tracks', 'search', 'region', 'neighbours'],
      head: ['onSearch', 'onSearchEnter', 'onPlaysHeat', 'setPlaysHeat', 'hidePlaysHeat', 'showFilters'],
      moods: ['available', 'filter', 'subscribe'],
      nowPlaying: ['path', 'title', 'startedAt', 'subscribe'],
      trail: ['sessionId', 'recentPlays', 'history'],
      capture: ['armed', 'mine', 'answer', 'cancel'],
      verbs: ['play', 'queue', 'songMenu', 'autoDj', 'sonicPath', 'playAll', 'queueAll', 'saveAsPlaylist'],
      visible: ['now', 'subscribe'],
    };
    for (const [group, names] of Object.entries(fns)) {
      const o = group ? deps[group] : deps;
      for (const name of names) { assert.equal(typeof o[name], 'function', `${group || 'deps'}.${name}`); }
    }
    assert.equal(typeof deps.spinnerHtml, 'string');
    assert.equal(typeof deps.verbs.songMenuGlyph, 'string');
    assert.equal(deps.t('map.label'), 'map.label');
    assert.equal(deps.escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;&#x2F;b&gt;');
    // the contract is written down where the controller reads it
    const doc = SRC.slice(SRC.indexOf('///////////////// Music map'), SRC.indexOf('function mapPanel()'));
    for (const name of ['onSearchEnter', 'hidePlaysHeat', 'recentPlays', 'startedAt', 'songMenuGlyph', 'saveAsPlaylist', 'reducedMotion', '.mmap-plate', '.mmap-card']) {
      assert.ok(doc.includes(name), `the contract names ${name}`);
    }
  });

  test('deps.api: each wrapper calls its route; answers pass while live, never settle after a browseGeneration bump or once the map was left', async () => {
    const sb = makeSandbox({ api: { discoveryMap: () => ({ state: 'ready', rev: 'r1' }) } });
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    assert.deepEqual(await deps.api.map(), { state: 'ready', rev: 'r1' });
    await deps.api.overlay('mood', 'r1', { valence: 'happy' });
    await deps.api.tracks({ ids: [3] });
    await deps.api.search('love');
    await deps.api.region('g:Rock');
    await deps.api.neighbours(14);
    await deps.trail.history();
    assert.deepEqual(sb.named('discoveryMapOverlay')[0].args, ['mood', 'r1', { valence: 'happy' }]);
    assert.deepEqual(sb.named('discoveryMapTracks')[0].args, [{ ids: [3] }]);
    assert.deepEqual(sb.named('discoveryMapSearch')[0].args, ['love']);
    assert.deepEqual(sb.named('discoveryMapRegion')[0].args, ['g:Rock']);
    assert.deepEqual(sb.named('discoveryMapNeighbours')[0].args, [14]);
    assert.deepEqual(sb.named('statsHistory')[0].args, [{ limit: 50, origin: 'local' }]);

    // the app moved on (a server switch bumps the generation)
    const out = deps.api.map();
    assert.equal(deps.generation(), 1);
    sb.S.bump();
    assert.equal(deps.generation(), 2);
    assert.equal(deps.live(), false);
    assert.equal(await settled(out), PENDING, 'an answer for the old generation is dropped');
    assert.equal(await settled(deps.api.search('x')), PENDING);
    // a fresh mount is live again; leaving it drops its answers too
    sb.S.mapPanel();
    const fresh = lastMount(sb).deps;
    assert.equal(fresh.live(), true);
    const late = fresh.api.region('g:Rock');
    sb.S.setState([{ state: 'allAlbums' }]);
    sb.S.setBrowserRootPanel('panel.albums');
    assert.equal(await settled(late), PENDING);
  });

  test('deps.live: the map must be the page — an album pushed over it is not', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    assert.equal(deps.live(), true);
    sb.S.setState([{ state: 'map' }, { state: 'album' }]);
    assert.equal(deps.live(), false);
    sb.S.setState([{ state: 'map' }]);
    assert.equal(deps.live(), true);
  });

  test('deps.disable(): the nav entry goes for the session and the File Explorer takes over on the next tick — not when the app moved on first', () => {
    const sb = makeSandbox();
    sb.S.applyMapPing({ discovery: true, discoveryMap: 1 });
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    deps.disable();
    assert.ok(sb.nav.classList.contains('super-hide'));
    assert.equal(sb.S.mapView.off, true);
    assert.equal(sb.MSTREAMAPI.currentServer.discoveryMap, false);
    assert.equal(sb.named('loadFileExplorer').length, 0, 'not inside the controller\'s own call');
    sb.runTimers();
    const cv = sb.named('changeView');
    assert.equal(cv.at(-1).args[0], 'loadFileExplorer');
    assert.equal(cv.at(-1).args[1], sb.feNav);
    assert.equal(lastMount(sb).destroyed, 1);
    sb.S.applyMapPing({ discovery: true, discoveryMap: 1 });
    assert.ok(sb.nav.classList.contains('super-hide'), 'the ping cannot bring it back this session');

    const sb2 = makeSandbox();
    sb2.S.mapPanel();
    lastMount(sb2).deps.disable();
    sb2.S.bump();
    sb2.runTimers();
    assert.equal(sb2.named('loadFileExplorer').length, 0, 'the app moved on: nothing to fall back from');
  });

  test('nowPlaying: the vpath form, null for a connected server\'s song; one Vue watcher on the reactive filepath; subscribe / unsubscribe', () => {
    let song = { rawFilePath: '/demo/Color Out/High Hopes.mp3', metadata: { title: 'High Hopes' } };
    const sb = makeSandbox({ playing: () => song });
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    sb.metadata.title = 'High Hopes';
    assert.equal(deps.nowPlaying.path(), 'demo/Color Out/High Hopes.mp3');
    assert.equal(deps.nowPlaying.title(), 'High Hopes');
    const heard = [];
    const off = deps.nowPlaying.subscribe((p) => heard.push(p));
    deps.nowPlaying.subscribe(() => {});
    assert.equal(sb.vues.length, 1, 'one watcher per mount');
    assert.deepEqual(Object.keys(sb.vues[0].o.watch), ['meta.filepath']);
    assert.equal(sb.vues[0].o.data.meta, sb.metadata, 'on MSTREAMPLAYER.playerStats.metadata');
    sb.vues[0].fire();
    song = { rawFilePath: 'peer/x.mp3', federation: { peerId: 2 }, metadata: {} };
    sb.vues[0].fire();
    assert.deepEqual(heard, ['demo/Color Out/High Hopes.mp3', null]);
    assert.equal(deps.nowPlaying.title(), '', 'no title for a song that has no pin');
    off();
    sb.vues[0].fire();
    assert.equal(heard.length, 2, 'unsubscribed');
    song = { rawFilePath: 'demo/untagged.mp3', metadata: {} };
    sb.metadata.title = '';
    assert.equal(deps.nowPlaying.title(), 'untagged.mp3', 'the file name when untagged');
  });

  test('trail: this tab\'s session id, the page\'s finished plays, one page of local history', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    assert.equal(deps.trail.sessionId(), 'tab-1');
    assert.deepEqual(deps.trail.recentPlays(), [{ filePath: 'demo/a.mp3', federated: false }]);
  });

  test('nowPlaying.startedAt: the playing song\'s play-session start (ms), null with no session', () => {
    const playing = makeSandbox({ session: { filePath: '/demo/a.mp3', startedAt: 1700000000000 } });
    playing.S.mapPanel();
    assert.equal(lastMount(playing).deps.nowPlaying.startedAt(), 1700000000000);
    const idle = makeSandbox();
    idle.S.mapPanel();
    assert.equal(lastMount(idle).deps.nowPlaying.startedAt(), null);
    const odd = makeSandbox({ session: { startedAt: 'soon' } });
    odd.S.mapPanel();
    assert.equal(lastMount(odd).deps.nowPlaying.startedAt(), null);
  });

  test('reducedMotion() reads prefers-reduced-motion: reduce at call time', () => {
    assert.equal((() => { const sb = makeSandbox({ reduced: true }); sb.S.mapPanel(); return lastMount(sb).deps.reducedMotion(); })(), true);
    assert.equal((() => { const sb = makeSandbox(); sb.S.mapPanel(); return lastMount(sb).deps.reducedMotion(); })(), false);
  });

  test('visible: fires when the page becomes visible again, not when it hides', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    let n = 0;
    deps.visible.subscribe(() => { n++; });
    deps.visible.subscribe(() => {});
    assert.equal(sb.doc.listeners.visibilitychange.length, 1, 'one listener per mount');
    sb.doc.visibilityState = 'hidden';
    sb.doc.listeners.visibilitychange[0]();
    assert.equal(deps.visible.now(), false);
    sb.doc.visibilityState = 'visible';
    sb.doc.listeners.visibilitychange[0]();
    assert.equal(n, 1);
    assert.equal(deps.visible.now(), true);
  });

  test('capture: armed / mine / answer / cancel — another panel\'s pick is answered with the row, as a browse row\'s click does, and never cancelled', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    assert.equal(deps.capture.armed(), false);
    assert.equal(deps.capture.answer({ filepath: 'demo/a.mp3' }), false);
    const got = [];
    sb.VUEPLAYERCORE.songCapture = (song) => got.push(song);
    assert.equal(deps.capture.armed(), true);
    assert.equal(deps.capture.mine(), false);
    assert.equal(deps.capture.answer({ filepath: 'demo/a.mp3', metadata: { title: 'A' } }), true);
    assert.equal(sb.VUEPLAYERCORE.songCapture, null, 'one-shot: taken at once');
    assert.equal(deps.capture.armed(), false);
    assert.deepEqual(got, [], 'answered on the next tick, never inside the controller\'s own handler');
    sb.runTimers();
    assert.deepEqual(got, [{ filepath: 'demo/a.mp3', metadata: { title: 'A' } }]);
    // cancel: the map's own pick goes with its banner (Esc, the sea, ×);
    // another panel's stays armed
    const other = () => {};
    sb.VUEPLAYERCORE.songCapture = other;
    deps.capture.cancel();
    assert.equal(sb.VUEPLAYERCORE.songCapture, other);
    assert.equal(sb.named('sonicPathHideBanner').length, 0);
    deps.verbs.sonicPath({ filepath: 'demo/a.mp3', metadata: { title: 'A' } }, {});
    assert.equal(deps.capture.mine(), true);
    deps.capture.cancel();
    assert.equal(sb.VUEPLAYERCORE.songCapture, null);
    assert.equal(deps.capture.armed(), false);
    assert.equal(sb.named('sonicPathHideBanner').length, 1);
  });
});

// ── The card verbs ───────────────────────────────────────────────────────

const ROWS = [
  { filepath: 'demo/Color Out/High Hopes.mp3', metadata: { title: 'High Hopes', artist: 'Color Out' } },
  { filepath: 'demo/Color Out/Home.mp3', metadata: { title: 'Home', artist: 'Color Out' } },
  { filepath: 'demo/ALM/Evasion.mp3', metadata: { title: 'Evasion', artist: 'ALM' } },
];

describe('Map panel: the card verbs', () => {
  test('Play → queueRow(null, fp, meta, positionCache.val + 1); Queue → queueRow(null, fp, meta) — copies of the row\'s metadata', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    deps.verbs.play(ROWS[0]);
    deps.verbs.queue(ROWS[1]);
    const adds = sb.named('addSongWizard');
    assert.deepEqual(adds[0].args, [ROWS[0].filepath, ROWS[0].metadata, false, 3], 'after the current song (2), and start');
    assert.deepEqual(adds[1].args, [ROWS[1].filepath, ROWS[1].metadata, false, undefined]);
    assert.notEqual(adds[0].args[1], ROWS[0].metadata, 'the queue may edit its copy (ratings), never the map\'s row');
    assert.match(sliceFn('mapDeps'), /play: \(row\) => \{ if \(row && row\.filepath\) \{ queueRow\(null, row\.filepath, mapRowMeta\(row\), MSTREAMPLAYER\.positionCache\.val \+ 1\); \} \}/);
    deps.verbs.play(null);
    deps.verbs.queue({});
    assert.equal(sb.named('addSongWizard').length, 2, 'no row, no add');
  });

  test('the song menu: createPopper3 on the element; its glyph is a browse row\'s ▾, classed pop-f', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const anchor = { getAttribute: () => 'demo/a.mp3' };
    deps.verbs.songMenu(anchor);
    assert.equal(sb.named('createPopper3')[0].args[0], anchor);
    const glyph = tagsOf(deps.verbs.songMenuGlyph);
    assert.equal(glyph[0].tag, 'svg');
    assert.equal(glyph[0].attrs.class, 'pop-f');
    assert.equal(glyph[1].tag, 'path');
    assert.equal(glyph[1].attrs.class, 'pop-f');
    const row = sliceFn('createMusicFileHtml');
    assert.ok(row.includes(glyph[1].attrs.d), 'the row\'s exact path');
  });

  test('Auto DJ from here: sonic mode on, then the seed, then the DJ started — or kicked when it is on', () => {
    for (const on of [false, true]) {
      const sb = makeSandbox({ autoDJ: on });
      sb.S.mapPanel();
      lastMount(sb).deps.verbs.autoDj(ROWS[2]);
      const seq = sb.calls.filter((c) => /^(AUTODJ\.|toggleAutoDJ|autoDjKick)/.test(c.name)).map((c) => [c.name, ...c.args]);
      assert.deepEqual(seq, [
        ['AUTODJ.setState', { sonicEnabled: true }],
        ['AUTODJ.setSonicSeed', 'demo/ALM/Evasion.mp3', 'Evasion — ALM'],
        [on ? 'autoDjKick' : 'toggleAutoDJ'],
      ], on ? 'on: kick' : 'off: start');
    }
    const sb = makeSandbox();
    sb.S.mapPanel();
    lastMount(sb).deps.verbs.autoDj({ filepath: 'demo/x/Untagged.mp3', metadata: {} });
    assert.deepEqual(sb.named('AUTODJ.setSonicSeed')[0].args, ['demo/x/Untagged.mp3', 'Untagged.mp3']);
  });

  test('Play on a place or a path: clearPlaylist, then row 0 with autoplay on and the rest off — one synchronous block', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const ret = lastMount(sb).deps.verbs.playAll(ROWS);
    assert.equal(ret, undefined, 'nothing to await: done when it returns');
    const seq = sb.calls.filter((c) => c.name === 'clearPlaylist' || c.name === 'addSongWizard');
    assert.equal(seq[0].name, 'clearPlaylist');
    assert.deepEqual(seq.slice(1).map((c) => [c.args[0], c.args[3], c.args[4], c.args[5]]), [
      [ROWS[0].filepath, undefined, false, false],
      [ROWS[1].filepath, undefined, false, true],
      [ROWS[2].filepath, undefined, false, true],
    ], 'appended (no position), live playlist untouched, only row 0 autoplays');
    const fn = sliceFn('mapPlayAll');
    assert.ok(!/await|sonicPathPlay|clearAndPlay/.test(fn.replace(/\/\/.*$/gm, '')), 'no await, never sonicPathPlay(true) or clearAndPlay');
    assert.equal(sb.named('AUTODJ.setIgnoreList').length, 0, 'Auto DJ off: its cooldown untouched');
  });

  test('Play with Auto DJ on: the rows\' ids join the DJ\'s cooldown before clearPlaylist asks for its pick', () => {
    const sb = makeSandbox({ autoDJ: true, ignoreList: [5, 89, 76] });
    sb.S.mapPanel();
    lastMount(sb).deps.verbs.playAll([{ id: 89, ...ROWS[0] }, { id: 12, ...ROWS[1] }, { id: null, ...ROWS[2] }]);
    const seq = sb.calls.filter((c) => c.name === 'AUTODJ.setIgnoreList' || c.name === 'clearPlaylist').map((c) => c.name);
    assert.deepEqual(seq, ['AUTODJ.setIgnoreList', 'clearPlaylist'], 'first: the bootstrap\'s request is built inside clearPlaylist');
    assert.deepEqual(sb.named('AUTODJ.setIgnoreList')[0].args[0], [5, 76, 89, 12], 'newest last, no duplicate, a row with no id left out');
  });

  test('Queue all: Discover\'s loop, then its toast; Save as playlist: the shared modal with the paths', () => {
    const sb = makeSandbox();
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    deps.verbs.queueAll(ROWS);
    assert.deepEqual(sb.named('addSongWizard').map((c) => [c.args[0], c.args[2], c.args[3], c.args[4], c.args[5]]),
      ROWS.map((r) => [r.filepath, false, undefined, false, true]));
    assert.deepEqual(sb.toasts.map((x) => x.title), ['discover.modal.queued']);
    deps.verbs.saveAsPlaylist(ROWS);
    assert.deepEqual(sb.named('openSavePlaylistModal')[0].args[0], ROWS.map((r) => r.filepath));
    deps.verbs.queueAll([]);
    deps.verbs.saveAsPlaylist([]);
    assert.equal(sb.toasts.length, 1);
    assert.equal(sb.named('openSavePlaylistModal').length, 1, 'nothing to save, no modal');
  });

  test('Sonic Path: arms the end pick (the banner, no navigation); the answer builds the path into SONICPATH and hands the rows back', async () => {
    const results = [ROWS[0], ROWS[1], ROWS[2]].map((r) => ({ ...r, similarity: 0.8, genreTags: [] }));
    const sb = makeSandbox({ api: { discoveryPath: () => ({ results, notAnalyzed: { start: false, end: false } }) } });
    sb.S.mapPanel();
    const { deps } = lastMount(sb);
    const paths = [];
    deps.verbs.sonicPath({ filepath: '/demo/Color Out/High Hopes.mp3', metadata: ROWS[0].metadata }, { onPath: (p) => paths.push(p) });
    assert.equal(sb.VUEPLAYERCORE.songCapture.mmap, true);
    assert.deepEqual(sb.banners.map((b) => b.text), ['sonicPath.pickBannerEnd']);
    assert.equal(sb.named('changeView').length, 0, 'no navigation away');
    assert.equal(deps.capture.armed(), true);
    assert.equal(deps.capture.mine(), true);
    deps.capture.answer(ROWS[2]);
    assert.equal(deps.capture.armed(), false);
    sb.runTimers();
    assert.equal(sb.named('sonicPathHideBanner').length, 1);
    await flush();
    assert.deepEqual(sb.named('discoveryPath')[0].args, ['demo/Color Out/High Hopes.mp3', 'demo/ALM/Evasion.mp3', 14], 'stripped paths, SONICPATH.length');
    assert.equal(sb.S.SONICPATH.view, 'results');
    assert.equal(sb.S.SONICPATH.fetched, true);
    assert.equal(sb.S.SONICPATH.loading, false);
    assert.deepEqual(sb.S.SONICPATH.start, { rawFilePath: '/demo/Color Out/High Hopes.mp3', title: 'High Hopes', artist: 'Color Out', art: null });
    assert.deepEqual(sb.S.SONICPATH.end, { rawFilePath: 'demo/ALM/Evasion.mp3', title: 'Evasion', artist: 'ALM', art: null });
    assert.deepEqual(sb.S.SONICPATH.rows, results, 'the Sonic Path panel lists the same journey');
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0].rows, results);
    assert.deepEqual(paths[0].notAnalyzed, { start: false, end: false });
    assert.equal(paths[0].end.filepath, 'demo/ALM/Evasion.mp3');
  });

  test('Sonic Path: a 403 hides Sonic Path (toasted), a failure is toasted — both hand back null; Cancel drops the pick and says so; a left map hears nothing', async () => {
    const run = async (answerWith) => {
      const sb = makeSandbox({ api: { discoveryPath: () => answerWith } });
      sb.S.mapPanel();
      const paths = [];
      lastMount(sb).deps.verbs.sonicPath(ROWS[0], { onPath: (p) => paths.push(p) });
      lastMount(sb).deps.capture.answer(ROWS[1]);
      sb.runTimers();
      await flush();
      return { sb, paths };
    };
    const off = await run({ disabled: true });
    assert.deepEqual(off.paths, [null]);
    assert.ok(off.sb.byId.get('nav-sonic-path').classList.contains('super-hide'));
    assert.deepEqual(off.sb.toasts.map((x) => x.title), ['sonicPath.disabled']);
    assert.equal(off.sb.S.SONICPATH.view, 'setup', 'nothing written');
    const failed = await run(null);
    assert.deepEqual(failed.paths, [null]);
    assert.deepEqual(failed.sb.toasts.map((x) => x.title), ['sonicPath.failed']);

    const sb = makeSandbox({ api: { discoveryPath: () => ({ results: ROWS }) } });
    sb.S.mapPanel();
    let cancelled = 0;
    const paths = [];
    lastMount(sb).deps.verbs.sonicPath(ROWS[0], { onPath: (p) => paths.push(p), onCancel: () => { cancelled++; } });
    sb.banners[0].onCancel();
    assert.equal(cancelled, 1);
    // armed again, answered, but the map is left before the path lands
    lastMount(sb).deps.verbs.sonicPath(ROWS[0], { onPath: (p) => paths.push(p) });
    lastMount(sb).deps.capture.answer(ROWS[1]);
    sb.S.setState([{ state: 'allAlbums' }]);
    sb.S.setBrowserRootPanel('panel.albums');
    sb.runTimers();
    await flush();
    assert.deepEqual(paths, [], 'the torn-down card is never called');
    assert.equal(sb.S.SONICPATH.view, 'results', 'the journey still lands in the Sonic Path panel');
  });
});

// ── Through the real player ──────────────────────────────────────────────

// mstream.player.js, loaded as the page loads it: a fake <audio>, the real
// play-session module, timers that never hold the process open.
function loadPlaySession(storage) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'localStorage', 'sessionStorage', 'self', SESSION_SRC)(mod, mod.exports, storage, storage, undefined);
  return mod.exports;
}
function loadPlayer({ getRandomSong } = {}) {
  const audios = [];
  class FakeAudio {
    constructor() { this.listeners = {}; this.paused = true; this.currentTime = 0; this.duration = NaN; this.src = ''; this.volume = 1; this.playbackRate = 1; audios.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    load() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    emit(type) { for (const fn of this.listeners[type] || []) { fn(); } }
  }
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  const VUEPLAYERCORE = {};
  const randomCalls = [];
  const MSTREAMAPI = {
    currentServer: { host: 'http://host/', token: 'TOK', vpaths: [], discovery: false },
    postPlays: (body) => Promise.resolve({ accepted: (body.plays || []).map((p) => p.id) }),
    postNowPlaying: () => Promise.resolve({}),
    getRandomSong: (body) => { randomCalls.push(body); return Promise.resolve(getRandomSong ? getRandomSong(body) : { songs: [] }); },
    lastfmSimilarArtists: () => Promise.resolve({ artists: [] }),
    addToPlaylist: () => Promise.resolve({}),
    lookupMetadata: () => Promise.resolve({}),
  };
  const later = (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) { h.unref(); } return h; };
  const quiet = { log() {}, warn() {}, error() {}, assert() {} };
  const P = new Function('window', 'navigator', 'document', 'localStorage', 'Audio', 'iziToast', 't', 'MSTREAMAPI', 'MSTREAMPLAYSESSION', 'VUEPLAYERCORE', 'setTimeout', 'clearTimeout', 'setInterval', 'console',
    `${PLAYER_SRC}\nreturn MSTREAMPLAYER;`)(
    { addEventListener() {} }, {}, { title: '' }, storage, FakeAudio, { error() {}, warning() {}, info() {}, success() {} }, tStub,
    MSTREAMAPI, loadPlaySession(storage), VUEPLAYERCORE, later, clearTimeout, () => 0, quiet);
  // vp.js's own addSongWizard, against this player
  VUEPLAYERCORE.addSongWizard = new Function('MSTREAMPLAYER', 'MSTREAMAPI', 'saveLiveQueue',
    `const mstreamModule = { livePlaylist: { name: false }, altLayout: { waveformBar: false }, prefetchWaveform() {} };
     ${vpSlice('  mstreamModule.addSongWizard = async (')}
     return mstreamModule.addSongWizard;`)(P, MSTREAMAPI, () => {});
  VUEPLAYERCORE.addFederationSongWizard = () => {};
  VUEPLAYERCORE.songCapture = null;
  // a position report on whichever element plays (the handler reads the current one)
  const tick = (...secs) => { for (const s of secs) { for (const a of audios) { a.currentTime = s; } audios[0].emit('timeupdate'); } };
  const playingAudio = () => audios.find((a) => !a.paused) || null;
  return { P, audios, VUEPLAYERCORE, MSTREAMAPI, tick, playingAudio, randomCalls };
}
const songOf = (fp, extra = {}) => ({ url: `http://host/media/${fp}?token=TOK`, rawFilePath: fp, filepath: fp, metadata: { title: fp.split('/').pop() }, ...extra });

describe('Map panel: Play on a place through the real player (mstream.player.js, vp.js addSongWizard)', () => {
  test('Auto DJ off: the queue is replaced and row 0 plays at once — not cued paused', async () => {
    const { P, VUEPLAYERCORE, playingAudio } = loadPlayer();
    P.addSong(songOf('demo/old/1.mp3'));
    P.addSong(songOf('demo/old/2.mp3'));
    const sb = makeSandbox({ player: P, vpc: VUEPLAYERCORE });
    sb.S.mapPanel();
    lastMount(sb).deps.verbs.playAll(ROWS);
    assert.deepEqual(P.playlist.map((s) => s.rawFilePath), ROWS.map((r) => r.filepath));
    assert.equal(P.positionCache.val, 0);
    assert.equal(P.getCurrentSong().rawFilePath, ROWS[0].filepath);
    assert.equal(P.playerStats.playing, true, 'started');
    assert.ok(playingAudio() && playingAudio().src.includes('High%20Hopes') === false && playingAudio().src.includes('High Hopes'), 'the element plays row 0');
    assert.equal(P.playlist[0].metadata.title, 'High Hopes', 'with the row\'s metadata (no lookup)');
    await flush();
    assert.equal(P.playlist.length, 3, 'nothing else lands');
  });

  test('Auto DJ on: row 0 still starts, and one DJ pick follows the rows (the DJ carrying on after the queue)', async () => {
    const { P, VUEPLAYERCORE, playingAudio, randomCalls } = loadPlayer({
      getRandomSong: () => ({ songs: [{ filepath: 'demo/dj/Pick.mp3', metadata: { title: 'Pick' } }], ignoreList: [7] }),
    });
    P.playerStats.autoDJ = true;
    const sb = makeSandbox({ player: P, vpc: VUEPLAYERCORE });
    sb.S.mapPanel();
    lastMount(sb).deps.verbs.playAll(ROWS);
    // synchronously: the rows, row 0 playing — the DJ's fetch is still out
    assert.deepEqual(P.playlist.map((s) => s.rawFilePath), ROWS.map((r) => r.filepath));
    assert.equal(P.getCurrentSong().rawFilePath, ROWS[0].filepath);
    assert.equal(P.playerStats.playing, true);
    assert.ok(playingAudio());
    for (let i = 0; i < 20; i++) { await flush(); }
    assert.deepEqual(P.playlist.map((s) => s.rawFilePath), [...ROWS.map((r) => r.filepath), 'demo/dj/Pick.mp3'], 'one DJ pick, after the mix');
    assert.equal(randomCalls.length, 1, 'one fetch: the bootstrap and row 0\'s goToSong share it');
    assert.equal(P.getCurrentSong().rawFilePath, ROWS[0].filepath, 'row 0 is still what plays');
    P.playerStats.autoDJ = false;
  });
});

describe('the player\'s finished-plays ring (MSTREAMPLAYER.stats.recentPlays)', () => {
  test('a finished play lands newest first, with the connected-server flag; copies; under a second is no play; at most 50', () => {
    const { P, tick } = loadPlayer();
    assert.deepEqual(P.stats.recentPlays(), []);
    P.addSong(songOf('demo/a.mp3')); // the first song plays at once
    tick(0.5, 1.5, 2.5);
    P.addSong(songOf('peer/b.mp3', { federation: { peerId: 3, peerName: 'P' } }));
    P.nextSong();
    let ring = P.stats.recentPlays();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].filePath, 'demo/a.mp3');
    assert.equal(ring[0].federated, false);
    assert.equal(ring[0].outcome, 'skipped');
    assert.equal(ring[0].playedMs, 2000);
    assert.equal(ring[0].source, 'manual');
    assert.equal(typeof ring[0].sessionId, 'string');
    assert.ok(!Number.isNaN(Date.parse(ring[0].startedAt)) && !Number.isNaN(Date.parse(ring[0].endedAt)));
    tick(0.5, 1.5);
    P.addSong(songOf('demo/c.mp3'));
    P.nextSong();
    ring = P.stats.recentPlays();
    assert.deepEqual(ring.map((p) => [p.filePath, p.federated]), [['peer/b.mp3', true], ['demo/a.mp3', false]], 'newest first; a connected server\'s song says so');
    P.addSong(songOf('demo/d.mp3'));
    P.nextSong(); // c was left at once: no play
    assert.equal(P.stats.recentPlays().length, 2);
    ring[0].filePath = 'changed';
    assert.equal(P.stats.recentPlays()[0].filePath, 'peer/b.mp3', 'copies');
    for (let i = 0; i < 55; i++) {
      tick(0.5, 1.5);
      P.addSong(songOf(`demo/n/${i}.mp3`));
      P.nextSong();
    }
    ring = P.stats.recentPlays();
    assert.equal(ring.length, 50, 'capped');
    assert.equal(ring[0].filePath, 'demo/n/53.mp3', 'the newest finished play first');
    assert.match(PLAYER_SRC, /recentPlays: \(\) => recentPlays\.map\(\(p\) => Object\.assign\(\{\}, p\)\),/);
  });
});

// ── api.js ───────────────────────────────────────────────────────────────

function loadApi(fetchImpl) {
  return new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'localStorage', 'Cookies', 'document', 'window',
    `${API_SRC}\nreturn MSTREAMAPI;`)(fetchImpl, AbortController, setTimeout, clearTimeout, { removeItem() {} }, { remove() {} }, {}, {});
}
const answerWith = (status, body) => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
  };
  return { calls, fetchImpl };
};

describe('discoveryMapFetch (api.js): status-preserving', () => {
  test('403 disabled, 404 notFound, 409 stale, 429 busy; other statuses and a network error null; 2xx the body', async () => {
    const cases = [[403, { disabled: true }], [404, { notFound: true }], [409, { stale: true }], [429, { busy: true }], [500, null], [400, null], [401, null], [200, { state: 'ready' }]];
    for (const [status, want] of cases) {
      const { fetchImpl } = answerWith(status, { state: 'ready' });
      const api = loadApi(fetchImpl);
      assert.deepEqual(await api.discoveryMapFetch('GET', 'api/v1/discovery/map'), want, String(status));
    }
    const down = loadApi(() => Promise.reject(new TypeError('Failed to fetch')));
    assert.equal(await down.discoveryMapFetch('GET', 'api/v1/discovery/map'), null);
    const bad = loadApi(() => Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new SyntaxError('x')) }));
    assert.equal(await bad.discoveryMapFetch('GET', 'api/v1/discovery/map'), null, 'an unreadable body');
  });

  test('a request that hangs is given up (the timeout): null', async () => {
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const api = loadApi(hang);
    assert.equal(await api.discoveryMapFetch('GET', 'api/v1/discovery/map', { timeoutMs: 20 }), null);
  });

  test('the wrappers: their routes, methods and bodies; the overlay\'s query carries the mood filter as JSON; statsHistory', async () => {
    const { calls, fetchImpl } = answerWith(200, {});
    const api = loadApi(fetchImpl);
    api.currentServer.host = 'http://host/';
    api.currentServer.token = 'TOK';
    await api.discoveryMap();
    await api.discoveryMapOverlay('mood', 'abc123', { valence: 'happy', threshold: 0.7 });
    await api.discoveryMapOverlay('plays', 'abc123', null);
    await api.discoveryMapTracks({ filepaths: ['demo/a.mp3'] });
    await api.discoveryMapSearch('love');
    await api.discoveryMapRegion('g:Hip Hop');
    await api.discoveryMapNeighbours(14);
    await api.statsHistory({ limit: 50, origin: 'local' });
    const seen = calls.map((c) => [c.init.method, c.url, c.init.body === undefined ? undefined : JSON.parse(c.init.body)]);
    assert.deepEqual(seen, [
      ['GET', 'http://host/api/v1/discovery/map', undefined],
      ['GET', 'http://host/api/v1/discovery/map/overlay?layer=mood&rev=abc123&moods=%7B%22valence%22%3A%22happy%22%2C%22threshold%22%3A0.7%7D', undefined],
      ['GET', 'http://host/api/v1/discovery/map/overlay?layer=plays&rev=abc123', undefined],
      ['POST', 'http://host/api/v1/discovery/map/tracks', { filepaths: ['demo/a.mp3'] }],
      ['POST', 'http://host/api/v1/discovery/map/search', { q: 'love' }],
      ['POST', 'http://host/api/v1/discovery/map/region', { key: 'g:Hip Hop' }],
      ['POST', 'http://host/api/v1/discovery/map/neighbours', { id: 14 }],
      ['GET', 'http://host/api/v1/stats/history?limit=50&origin=local', undefined],
    ]);
    for (const c of calls) {
      assert.equal(c.init.headers['x-access-token'], 'TOK');
      assert.equal('Content-Type' in c.init.headers, c.init.method === 'POST', 'JSON only with a body');
    }
    // the overlay's moods decode back to the filter
    assert.deepEqual(JSON.parse(new URL(calls[1].url).searchParams.get('moods')), { valence: 'happy', threshold: 0.7 });
  });
});

// ── vp.js ────────────────────────────────────────────────────────────────

describe('hotkeysSkip (vp.js): the map\'s keyboard is its own', () => {
  // focusBy: how focus last arrived ('key' — Tab, Enter, a screen reader — or 'pointer'), as vp.js tracks it
  const skipWith = (focusBy) => new Function('hotkeysFocusBy', `${vpSlice('  function hotkeysSkip(target) {')}\nreturn hotkeysSkip;`)(focusBy);
  const target = (tagName, inside = []) => ({ tagName, isContentEditable: false,
    closest: (sel) => (sel.split(/,\s*/).some((one) => inside.includes(one.replace(/^\./, ''))) ? {} : null) });

  test('a map button the keyboard brought focus to keeps its keys (Space and Enter press it); one a click left focused, and the plate, leave Space to the player', () => {
    assert.equal(skipWith('key')(target('BUTTON', ['mmap'])), true, 'Tab or Enter brought focus: Space presses the button, never Play/Pause');
    assert.equal(skipWith('pointer')(target('BUTTON', ['mmap'])), false, 'a click or a tap left it focused (or a card that click opened): Space plays or pauses');
    assert.equal(skipWith('key')(target('DIV', ['mmap'])), false, 'the plate itself: Space plays or pauses (its arrows, + = − and Esc stop at the plate)');
    assert.equal(skipWith('key')(target('CANVAS', ['mmap'])), false);
    assert.equal(skipWith('key')(target('INPUT', ['mmap'])), true, 'the head\'s search field, as any field');
    assert.equal(skipWith('key')(target('BUTTON')), false, 'a button elsewhere: the hotkey plays');
    assert.equal(skipWith('key')(target('BODY')), false);
    assert.equal(skipWith('pointer')(target('BUTTON', ['browse-keep'])), true, 'the other skips stand');
    const fn = vpSlice('  function hotkeysSkip(target) {');
    assert.match(fn, /closest\('\.dmodal-shadow, \.browse-keep, \.browse-keep-tab, \.browse-keep-more'\)/);
    assert.match(fn, /element === 'button' && target\.closest\('\.mmap'\) !== null && hotkeysFocusBy !== 'pointer'/);
  });

  test('vp.js tracks how focus arrived: a pointer press, then the focus it brings; a key press, then the focus it brings', () => {
    const at = VP_SRC.indexOf('  function hotkeysSkip(target) {');
    const block = VP_SRC.slice(at, VP_SRC.indexOf('window.addEventListener("keydown"', at));
    const listeners = {};
    const track = new Function('document', `${block.slice(block.indexOf('  let hotkeysInput'))}\nreturn () => hotkeysFocusBy;`)({
      addEventListener: (type, fn, capture) => { assert.equal(capture, true, `${type}: in the capture phase, before anything moves focus`); listeners[type] = fn; },
    });
    assert.equal(track(), 'key', 'by default (a screen reader\'s click comes with no pointer press)');
    listeners.pointerdown(); listeners.focusin();
    assert.equal(track(), 'pointer', 'a click focused it');
    listeners.focusin();
    assert.equal(track(), 'pointer', 'and what that click opened then (the card\'s first verb)');
    listeners.keydown();
    assert.equal(track(), 'pointer', 'a key press alone changes nothing: the button the click focused stays the player\'s');
    listeners.focusin();
    assert.equal(track(), 'key', 'Tab moved focus');
  });

  test('the plate stops its own keys, so the player never hears them; Space and the rest go on', () => {
    const src = fs.readFileSync(MUSIC_MAP_PATH, 'utf8');
    assert.match(src, /own = \(\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/);
    assert.match(VP_SRC, /window\.addEventListener\("keydown", \(event\) => \{[\s\S]{0,200}if \(hotkeysSkip\(event\.target\)\) \{ return; \}/, 'the window listener runs on bubble, after the plate');
  });
});

// ── en.json ──────────────────────────────────────────────────────────────

const PLAN_MAP_KEYS = {
  'map.label': 'Music map',
  'map.search': 'Search',
  'map.playsHeat': 'Plays heat',
  'map.follow': "Follow what's playing",
  'map.zoom': 'Zoom',
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.play': 'Play',
  'map.queue': 'Queue',
  'map.queueAll': 'Queue all',
  'map.saveAsPlaylist': 'Save as playlist',
  'map.autoDj': 'Auto DJ',
  'map.sonicPath': 'Sonic Path',
  'map.songMenu': 'Song menu',
  'map.goToNowPlaying': 'Go to now playing, {{title}}',
  'map.pathTitle': '{{start}} → {{end}}',
  'map.empty': 'Your map appears once songs are analysed.',
  'map.failed': "The map couldn't load.",
  'map.pass': 'Music map',
};

// The map.* keys a source names: 'map.x' / "map.x" / `map.x` literals.
const mapKeysIn = (src) => new Set([...src.matchAll(/['"`](map\.[A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]));

describe('en.json: the map\'s strings', () => {
  test('exactly the plan\'s map.* keys (§4.10), and the nav and panel names', () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith('map.'));
    assert.deepEqual(keys.sort(), Object.keys(PLAN_MAP_KEYS).sort());
    for (const [k, v] of Object.entries(PLAN_MAP_KEYS)) { assert.equal(EN[k], v, k); }
    assert.equal(EN['nav.map'], 'Map');
    assert.equal(EN['panel.map'], 'Map');
    // the reused keys exist as they are
    for (const k of ['modal.close', 'moods.filters', 'sonicPath.pickBannerEnd', 'sonicPath.playlistSaved', 'discover.modal.queued', 'dpage.verb.tryAgain']) {
      assert.ok(typeof EN[k] === 'string' && EN[k], k);
    }
  });

  test('every map.* key the code names exists', () => {
    const sources = [SRC, read('webapp', 'alpha', 'scan-progress.js'), read('webapp', 'admin', 'index.js')];
    if (fs.existsSync(MUSIC_MAP_PATH)) { sources.push(fs.readFileSync(MUSIC_MAP_PATH, 'utf8')); }
    const used = new Set(sources.flatMap((s) => [...mapKeysIn(s)]));
    assert.ok(used.has('map.search') && used.has('map.playsHeat') && used.has('map.failed') && used.has('map.pass'));
    const missing = [...used].filter((k) => !(k in EN));
    assert.deepEqual(missing, []);
  });

  test('…and no other: every map.* string is named by the code (the controller, alpha/music-map.js, included)', () => {
    const sources = [SRC, read('webapp', 'alpha', 'scan-progress.js'), read('webapp', 'admin', 'index.js'), fs.readFileSync(MUSIC_MAP_PATH, 'utf8')];
    const used = new Set(sources.flatMap((s) => [...mapKeysIn(s)]));
    const dead = Object.keys(EN).filter((k) => k.startsWith('map.') && !used.has(k));
    assert.deepEqual(dead, []);
  });
});
