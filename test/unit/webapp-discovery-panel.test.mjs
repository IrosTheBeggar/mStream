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
 *   - Peer Recommendations (discoveryView.page 'peerRecs', m.js peerRecs*;
 *     docs/peer-recommendations-plan.md §4.1 "Tests → MT (W4)"): its gate
 *     and nav row, the R1 body and one peers poll on open, the peer strip
 *     and its in-place patch, tabs on the batch, New seeds, two columns of
 *     leads (a row opens its window, only the play icon plays), Preview
 *     all, the band and its Get it…, every Add outcome and the re-ask a
 *     landed one makes, Copy list, every state, leaving, and what it never
 *     draws;
 *   - an answer that lands after the app moved on (browseGeneration bumped)
 *     is dropped; a 403 re-pings before naming a reason;
 *   - index.html carries the nav entry and the script, spa.css the
 *     container-query columns in the house palette, en.json every dpage.*
 *     key the module and the panel use (and no other).
 *
 * Clicks resolve against the DRAWN markup: click({ 'data-dp': 'precOpen' })
 * fails when no such element is on the page (a focusable one — button or
 * link — is preferred over a row).
 *
 * Same technique as webapp-album-cards.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals; DISCOVERYPAGE,
 * DISCOVERJOBS and PEERRECS are the real modules, and Peer Recommendations'
 * peers answers and leads are built by the server's own buildPeerView and
 * stampNetworkRows.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildPeerView, peerLabels } from '../../src/state/discovery-peer-view.js';
import { stampNetworkRows } from '../../src/api/discovery-taste.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const M_PATH = path.join(ROOT, 'webapp', 'alpha', 'm.js');
const SRC = fs.readFileSync(M_PATH, 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const DISCOVERYPAGE = require('../../webapp/alpha/discovery-page.js');
const DISCOVERJOBS = require('../../webapp/alpha/discover-jobs.js');
const PEERRECS = require('../../webapp/alpha/peer-recs.js');
// the registry's own job keys (the batch lookup's answer)
const plugins = await import('../../src/discovery-plugins/index.js');

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
  if (lines[start].endsWith('};') || lines[start].endsWith("';")) return lines[start];
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

const FNS = ['escapeHtml', 'peerAttr', 'artUrl', 'artImgAttr', 'renderAlbum', 'setBrowserRootPanel',
  'localIgnoreVPaths', 'applyDiscoveryPing', 'applyDiscoverySurfaces', 'applyServerInfo', 'discoverySetEntry',
  'discoveryWatchJobs', 'discoveryMergeJobs', 'discoveryPatchBadges',
  'discoveryMatchOpts', 'discoveryDropSeed', 'discoveryT', 'discoveryOnScreen', 'discoveryNowPlayingPath',
  'discoveryLocalChoices', 'discoverySaveLocalChoice', 'discoveryPanel', 'redoDiscovery', 'redoDiscoveryPeers', 'discoveryOff',
  'discoveryResponse', 'discoveryLoadBadges', 'discoveryHideHead', 'renderDiscovery', 'discoveryFocusedSelector', 'discoveryHeadHtml',
  'discoveryOptionsHtml', 'discoveryCardHtml', 'discoveryScanCardHtml', 'discoverySeedsHtml', 'discoveryLabelHtml',
  'discoverySkelHtml', 'discoveryPlayHtml', 'discoveryStripHtml', 'discoveryPeerArtFailed', 'discoveryPeerAlbumHtml', 'discoveryArtHtml',
  'discoverySongRowHtml', 'discoveryShowMoreHtml', 'discoveryColHintHtml', 'discoveryLibrarySongsHtml',
  'discoveryPeerSongsHtml', 'discoveryBadgeHtml', 'discoveryCardBadgeHtml', 'discoveryThinBarHtml', 'discoveryIndexBadges', 'onDiscoveryChange', 'onDiscoveryClick',
  'discoveryAction', 'discoveryOpenPeerAlbum', 'discoveryQueuePeerAlbum',
  'discoveryRestoreSeed', 'discoveryQueueAll', 'discoveryPick', 'discoveryRefocus', 'onDiscoveryKey',
  'discoveryFocusFallbacks'];

// Peer Recommendations' own part (m.js peerRecs*): every top-level function
// of it, whatever it grows — each must close with a `}` at column 0.
const PEER_FNS = [...SRC.matchAll(/^(?:async )?function (peerRecs\w*)\(/gm)].map((m) => m[1]);

// Keep a copy's half of the browse pages (m.js keepGate* / browseKeep* /
// browseHead* …): renderAlbum and setBrowserRootPanel call it; on this
// server's own page it draws nothing and asks nothing.
const KEEP_FNS = [...SRC.matchAll(/^(?:async )?function ((?:keepGate|browseKeep|browseHead|browseAlbum|browseArtist|browseFolder)\w*|writeReadOnlyNote)\(/gm)].map((m) => m[1]);
const keepState = () => `${['keepGate', 'browseKeep', 'BROWSE_KEEP_ICONS'].map(sliceConst).join('\n')}
    let keepGatePending = null;
    let keepGateAsk = 0;
    let browseKeepQueued = null;
    ${KEEP_FNS.map(sliceFn).join('\n\n')}`;

const KNOWN_IDS = ['filelist', 'dpage-head', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn', 'nav-discover', 'nav-peer-recs', 'dpage-band', 'nav-sonic-path'];
// what index.html draws hidden until the ping (or a clip) shows it
const HIDDEN_IDS = ['nav-discover', 'nav-peer-recs', 'dpage-head', 'dpage-band', 'nav-sonic-path'];

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

// Peer Recommendations writes slots in place (data-*slot, data-prec-strip,
// data-band-prog): a small DOM over the drawn markup finds an element by a
// selector — '.cls', '[attr]' or '[attr="v"]…' — and its inner markup
// (the start tag, its matching end tag), so a write lands in the page the
// test reads.
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'wbr']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>/g;
function selMatches(attrs, sel) {
  const cls = /^\.([\w-]+)$/.exec(sel);
  if (cls) { return String(attrs.class || '').split(/\s+/).includes(cls[1]); }
  const parts = [...sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
  if (!parts.length || parts.map((x) => x[0]).join('') !== sel) { return false; }
  return parts.every(([, k, v]) => (v === undefined ? k in attrs : attrs[k] === v));
}
// → { attrs, innerStart, innerEnd } of the first element matching `sel`
// within html[from, to), or null.
function locateIn(html, sel, from = 0, to = html.length) {
  const re = new RegExp(TAG_RE.source, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(html)) && m.index < to) {
    if (m[1]) { continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) { attrs[a[1]] = decode(a[2] ?? ''); }
    if (!selMatches(attrs, sel)) { continue; }
    const tag = m[2].toLowerCase();
    const innerStart = m.index + m[0].length;
    if (m[4] || VOID_TAGS.has(tag)) { return { attrs, innerStart, innerEnd: innerStart }; }
    const close = new RegExp(TAG_RE.source, 'g');
    close.lastIndex = innerStart;
    let depth = 1;
    let n;
    while ((n = close.exec(html))) {
      if (n[2].toLowerCase() !== tag || n[4]) { continue; }
      depth += n[1] ? -1 : 1;
      if (depth === 0) { return { attrs, innerStart, innerEnd: n.index }; }
    }
    return null;
  }
  return null;
}
// A path of selectors, each inside the last.
function locatePath(html, path) {
  let at = { attrs: {}, innerStart: 0, innerEnd: html.length };
  for (const sel of path) {
    at = locateIn(html, sel, at.innerStart, at.innerEnd);
    if (!at) { return null; }
  }
  return at;
}

// One stubbed app around the sliced functions.
//   taste(body)   answers MSTREAMAPI.discoveryTaste (a value or a promise)
//   stored        localStorage's starting entries
//   ping          MSTREAMAPI.ping's answer (the re-ping after a 403)
//   playing       MSTREAMPLAYER.getCurrentSong()
//   lookup(recs)  MSTREAMAPI.discoveryJobLookupBatch
//   jobs          VUEPLAYERCORE.discoverJobs() (the strip's last poll)
// Peer Recommendations:
//   peers()       MSTREAMAPI.discoveryP2pPeers: an answer (or a promise);
//                 throw { status } for a refusal. Without it: a 404
//   add(id)       MSTREAMAPI.discoveryP2pAdd → { status, body } (or a promise)
//   destination   MSTREAMAPI.discoveryDestination's `destination`
//   admin         MSTREAMAPI.currentServer.admin
//   clipboard     false: navigator.clipboard.writeText refuses
// Its turnOn mode (W7):
//   adminApi      MSTREAMAPI.currentServer.adminApi (GET /api's admin object)
//   adminStatus() MSTREAMAPI.discoveryP2pAdminStatus: an answer (or a
//                 promise); throw { status, body } for a refusal. Without
//                 it: a 404
//   setEnabled(enabled), setName(name), setDescription(description)
//                 the POSTs' answers, the same way. Without them: ok
//   tr            t() (default: the key echoed)
function makeSandbox({ taste, stored = {}, ping = null, playing = null, flags = FLAGS_ALL, lookup = null, plugins = null, jobs = [], albumSongs = null, noHead = false, peerArtUrl = null, compressArt = false, peers = null, add = null, destination = null, admin = false, clipboard = true, adminApi = false, adminStatus = null, setEnabled = null, setName = null, setDescription = null, tr = tStub } = {}) {
  const els = new Map();
  // the delegated handlers, by the root ('filelist' | 'dpage-head' |
  // 'dpage-band') whose drawn .dpage (the band's .prec-band) took them: a
  // control's events reach only its own root's
  const pageHandlers = { filelist: {}, 'dpage-head': {}, 'dpage-band': {} };
  const patches = [];
  // Peer Recommendations' slot writes, in place: { root, path, html }
  const writes = [];
  let renders = 0;
  // document.activeElement: the drawn control's attrs while one has focus,
  // and the root it was drawn in
  const focus = { on: null, root: null };
  // an element's sideways scroll, by root and selector; markup written over
  // it starts the new one at 0, as the DOM does
  const scrolls = new Map();
  const sameAttrs = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const holds = (html, attrs) => tagsOf(html).some((x) => sameAttrs(x.attrs, attrs));
  const dropScrolls = (id, html) => {
    for (const k of [...scrolls.keys()]) {
      const [root, sel] = [k.slice(0, k.indexOf(' ')), k.slice(k.indexOf(' ') + 1)];
      if (root === id && (html === null || locateIn(html, sel))) { scrolls.delete(k); }
    }
  };
  const classesOf = (initial) => {
    const classes = new Set(initial);
    return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  };
  // focus() calls on a drawn data-dp control after a re-render, in order
  const focused = [];
  // …and the root each was found in ('dpage-head' | 'filelist' | 'dpage-band')
  const focusedIn = [];
  for (const id of KNOWN_IDS) {
    let inner = '';
    // the drawn picker (.dpage-options): a new element on every write, its
    // own scroll starting at the top, as the DOM's does
    let options = null;
    // an element of this root's drawn markup, by a path of selectors
    const node = (path) => {
      const at = () => locatePath(inner, path);
      const key = `${id} ${path[path.length - 1]}`;
      return {
        get innerHTML() { const a = at(); return a ? inner.slice(a.innerStart, a.innerEnd) : ''; },
        set innerHTML(h) {
          const a = at();
          if (!a) { return; }
          const old = inner.slice(a.innerStart, a.innerEnd);
          // the keyboard's control goes with the markup it was in
          if (focus.root === id && focus.on && holds(old, focus.on)) { focus.on = null; focus.root = null; }
          dropScrolls(id, old);
          inner = inner.slice(0, a.innerStart) + h + inner.slice(a.innerEnd);
          writes.push({ root: id, path, html: h });
        },
        get scrollLeft() { return scrolls.get(key) || 0; },
        set scrollLeft(v) { scrolls.set(key, v); },
        getAttribute: (n) => { const a = at(); return a && n in a.attrs ? a.attrs[n] : null; },
        querySelector: (sel) => (locatePath(inner, [...path, sel]) ? node([...path, sel]) : null),
        focus: () => {
          const a = at();
          if (!a) { return; }
          focus.on = a.attrs;
          focus.root = id;
          focused.push(a.attrs['data-dp'] || null);
          focusedIn.push(id);
        },
      };
    };
    const el = {
      value: '', scrollTop: 0, style: {},
      classList: classesOf(HIDDEN_IDS.includes(id) ? ['super-hide'] : []),
      // a drawn .dpage (the band's .prec-band) takes the delegated
      // handlers (this root's); the picker, a badge / bar slot is there
      // when the drawn markup has it (a slot's writes are recorded); any
      // other selector finds a drawn element whose writes land in place
      querySelector: (sel) => {
        if (sel === '.dpage' || sel === '.prec-band') {
          if (!new RegExp(`class="${sel.slice(1)}[ "]`).test(inner)) { return null; }
          return { addEventListener: (type, fn) => { (pageHandlers[id] ||= {})[type] = fn; } };
        }
        if (sel === '.dpage-options') { return options; }
        const m = sel.match(/^\[(data-[bp]slot)="([^"]+)"\]$/);
        if (m && inner.includes(`${m[1]}="${m[2]}"`)) {
          return { set innerHTML(h) { patches.push({ slot: m[1], id: m[2], html: h }); } };
        }
        return locateIn(inner, sel) ? node([sel]) : null;
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
      dropScrolls(id, null);
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
  // the nav row each changeView lit
  const viewNavs = [];
  // the peer-browse hand-off and the album queue (m.js's own helpers)
  const adopted = [];
  const albumsOpened = [];
  const rowsQueued = [];
  const knownPeers = new Map();
  // document listeners (visibilitychange)
  const docListeners = [];
  // timers (the strip's poll): run by hand
  const timers = [];
  let timerIds = 0;
  const copied = [];
  const title = { innerHTML: '' };
  // Peer Recommendations' clip (VUEPLAYERCORE.clip*): vp.js's own rules in
  // small — a start is 'resolving' at once, a toggle pauses / resumes /
  // drops its own lead, a stop ends a live clip with 'stopped' — and the
  // test plays the rest (clip.play, clip.time, clip.end …).
  const LIVE = ['resolving', 'waiting', 'playing', 'paused'];
  const clip = { key: null, raw: null, tile: null, status: 'idle', preview: null, at: 0, seconds: 30 };
  const clipCalls = [];
  const clipWatchers = [];
  const clipArt = {};
  const clipResults = {};
  const gateWatchers = [];
  const clipSnap = () => ({ ...clip, live: LIVE.includes(clip.status) });
  // VUEPLAYERCORE.setAdmin's calls (applyServerInfo)
  const adminSet = [];
  // the now-playing panel's discovery setters, in order: [name, value]
  const surfaces = [];
  // an admin call's answer: fn's value or promise, its throw a rejection
  const answerOf = (fn, args, fallback) => {
    try {
      return fn ? Promise.resolve(fn(...args)) : fallback();
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const clipEmit = (type, extra) => {
    const ev = { type, key: clip.key, state: clipSnap(), ...(extra || {}) };
    for (const fn of clipWatchers.slice()) { fn(ev); }
  };
  const clipBegin = (raw) => {
    Object.assign(clip, { key: PEERRECS.leadKey(raw), raw, tile: raw.tile || null, status: 'resolving', preview: null, at: 0 });
    clipEmit('resolving');
  };
  const clipStop = (why) => {
    if (!LIVE.includes(clip.status)) { return false; }
    Object.assign(clip, { status: 'idle', at: 0 });
    clipEmit('stopped', { why: why || 'user' });
    return true;
  };
  const globals = {
    document: {
      body: { classList: bodyClasses },
      visibilityState: 'visible',
      addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
      removeEventListener: (type, fn) => {
        const at = docListeners.findIndex((l) => l.type === type && l.fn === fn);
        if (at !== -1) { docListeners.splice(at, 1); }
      },
      getElementById: (id) => els.get(id) ?? null,
      // the panel's title (setBrowserRootPanel writes it)
      getElementsByClassName: (c) => (c === 'panel_one_name' ? [title] : []),
      get activeElement() {
        const a = focus.on;
        const root = focus.root;
        // closest('#x .dpage, #y .dpage'): only a selector naming the root
        // the control was drawn in finds an ancestor; '#dpage-band' its
        // root; '[data-prec-strip]' the strip's host holding it
        const closest = (sel) => {
          if (String(sel).split(',').some((part) => part.trim() === `#${root} .dpage` || part.trim() === `#${root}`)) { return {}; }
          if (sel === '[data-prec-strip]' && root === 'filelist') {
            const html = els.get('filelist').innerHTML;
            const host = locateIn(html, '[data-prec-strip]');
            return host && holds(html.slice(host.innerStart, host.innerEnd), a) ? {} : null;
          }
          return null;
        };
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
    navigator: {
      clipboard: { writeText: (text) => { copied.push(text); return clipboard ? Promise.resolve() : Promise.reject(new Error('no clipboard')); } },
    },
    setTimeout: (fn, ms) => { const t = { id: ++timerIds, fn, ms, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) { t.live = false; } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    },
    MSTREAMAPI: {
      currentServer: { host: 'http://host/', token: 'TOK', admin, adminApi },
      discoveryTaste: (body) => { calls.push({ name: 'taste', body }); return Promise.resolve(taste(body)); },
      ping: () => { calls.push({ name: 'ping' }); return ping ? Promise.resolve(ping) : Promise.reject(new Error('no ping')); },
      discoveryJobLookupBatch: (recs) => { calls.push({ name: 'lookup', body: recs }); return lookup ? Promise.resolve(lookup(recs)) : Promise.reject(new Error('no lookup')); },
      discoveryP2pPeers: () => {
        calls.push({ name: 'peers' });
        try {
          return peers ? Promise.resolve(peers()) : Promise.reject(Object.assign(new Error('no route'), { status: 404 }));
        } catch (err) {
          return Promise.reject(err);
        }
      },
      discoveryP2pAdd: (endpointId) => { calls.push({ name: 'add', endpointId }); return Promise.resolve(add ? add(endpointId) : { status: 0, body: null }); },
      discoveryDestination: () => { calls.push({ name: 'destination' }); return Promise.resolve({ destination }); },
      discoveryP2pAdminStatus: () => {
        calls.push({ name: 'adminStatus' });
        return answerOf(adminStatus, [], () => Promise.reject(Object.assign(new Error('no route'), { status: 404 })));
      },
      discoveryP2pSetEnabled: (enabled) => { calls.push({ name: 'setEnabled', enabled }); return answerOf(setEnabled, [enabled], () => Promise.resolve({ enabled })); },
      discoveryP2pSetName: (name) => { calls.push({ name: 'setName', value: name }); return answerOf(setName, [name], () => Promise.resolve({ announced: false })); },
      discoveryP2pSetDescription: (description) => { calls.push({ name: 'setDescription', value: description }); return answerOf(setDescription, [description], () => Promise.resolve({ announced: false })); },
      peerArtUrl: peerArtUrl || ((id, art, compress) => `http://host/peer/${id}/art/${art}?c=${compress}`),
      peer: {
        albumSongs: (id, body) => { calls.push({ name: 'peerAlbumSongs', id, body }); return albumSongs ? Promise.resolve(albumSongs(id, body)) : Promise.reject(new Error('no album')); },
      },
    },
    MSTREAMPLAYER: { ignoreVPaths: {}, positionCache: { val: 2 }, getCurrentSong: () => playing },
    VUEPLAYERCORE: {
      altLayout: { compressArt },
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
      setAdmin: (on) => { adminSet.push(on); },
      setDiscoveryAvailable: (on) => { surfaces.push(['discovery', on]); },
      setDiscoveryP2pAvailable: (on) => { surfaces.push(['p2p', on]); },
      watchKeepGate: (fn) => { gateWatchers.push(fn); return () => { const at = gateWatchers.indexOf(fn); if (at !== -1) { gateWatchers.splice(at, 1); } }; },
      clipToggle: (raw) => {
        clipCalls.push(['toggle', raw]);
        if (PEERRECS.leadKey(raw) === clip.key) {
          if (clip.status === 'playing') { clip.status = 'paused'; clipEmit('paused'); return Promise.resolve(); }
          if (clip.status === 'paused') { clip.status = 'playing'; clipEmit('playing'); return Promise.resolve(); }
          if (clip.status === 'resolving' || clip.status === 'waiting') { clipStop('user'); return Promise.resolve(); }
        }
        clipBegin(raw);
        return Promise.resolve();
      },
      clipStart: (raw) => { clipCalls.push(['start', raw]); clipBegin(raw); return Promise.resolve(); },
      clipPrefetch: (raw) => { clipCalls.push(['prefetch', raw]); return Promise.resolve(true); },
      clipStop: (why) => { clipCalls.push(['stop', why]); return clipStop(why); },
      clipReset: () => {
        clipCalls.push(['reset']);
        clipStop('reset');
        Object.assign(clip, { key: null, raw: null, tile: null, status: 'idle', preview: null, at: 0, seconds: 30 });
        for (const k of Object.keys(clipArt)) { delete clipArt[k]; }
        for (const k of Object.keys(clipResults)) { delete clipResults[k]; }
        clipEmit('reset');
      },
      clipState: clipSnap,
      clipArt: (tileKey) => clipArt[tileKey] || null,
      clipResult: (raw) => clipResults[PEERRECS.leadKey(raw)] || null,
      watchClip: (fn) => {
        clipWatchers.push(fn);
        return () => { const at = clipWatchers.indexOf(fn); if (at !== -1) { clipWatchers.splice(at, 1); } };
      },
    },
    DISCOVERYPAGE,
    DISCOVERJOBS,
    PEERRECS,
    iziToast: { success: (o) => toasts.push(o), warning: (o) => toasts.push(o), info: (o) => toasts.push({ ...o, info: true }), error: (o) => toasts.push({ ...o, error: true }), show: (o) => toasts.push(o) },
    t: tr,
    getLoadingSvg: () => 'LOADING',
    sonicPathHideBanner: () => {},
    switchServer: () => { throw new Error('switchServer should not run on the local server'); },
    changeView: (fn, el) => { views.push(fn); viewNavs.push(el); },
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
    ${sliceConst('DPAGE_NOTE_CARD')}
    ${sliceConst('peerRecsView')}
    ${sliceConst('PREC_ICONS')}
    ${keepState()}
    discoveryView.flags = ${JSON.stringify(flags)};
    ${FNS.map(sliceFn).join('\n\n')}
    ${PEER_FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      ${PEER_FNS.join(', ')},
      view: discoveryView,
      prec: peerRecsView,
      html: () => __els.get('filelist').innerHTML,
      head: () => (__els.get('dpage-head') ? __els.get('dpage-head').innerHTML : ''),
      band: () => __els.get('dpage-band').innerHTML,
      // what the user sees: the bar's host over the scroller (and the band under it)
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
  const locate = (attrs, tag, roots = ['dpage-head', 'filelist']) => {
    const hits = roots.filter((r) => els.has(r)).flatMap((root) => {
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
  // A click on the band (#dpage-band, its own handler).
  const bandClick = (attrs) => {
    const { found } = locate(attrs, undefined, ['dpage-band']);
    const el = { tagName: found.tag.toUpperCase(), getAttribute: (n) => (n in found.attrs ? found.attrs[n] : null) };
    dispatch('dpage-band', 'click', { target: { closest: () => el } });
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
  // The timers waiting (the strip's poll), and running them as if they fired.
  const liveTimers = () => timers.filter((x) => x.live);
  const runTimers = () => { const due = liveTimers(); for (const x of due) { x.live = false; } for (const x of due) { x.fn(); } };
  // The document hidden or shown again.
  const setVisibility = (state) => {
    globals.document.visibilityState = state;
    for (const l of docListeners.filter((x) => x.type === 'visibilitychange')) { l.fn(); }
  };
  // The clip, played by the test: what vp.js would emit next.
  const clipCtl = {
    calls: clipCalls,
    state: clip,
    watchers: clipWatchers,
    results: clipResults,
    play: (preview = null) => { Object.assign(clip, { status: 'playing', preview }); clipEmit('playing'); },
    time: (at) => { clip.at = at; clipEmit('time'); },
    end: () => { Object.assign(clip, { status: 'idle', at: 0 }); clipEmit('ended'); },
    none: () => { clipResults[clip.key] = { status: 'none', preview: null }; Object.assign(clip, { status: 'none', preview: null }); clipEmit('none'); },
    fail: () => { Object.assign(clip, { status: 'failed', preview: null }); clipEmit('failed'); },
    earn: (tileKey, url) => { clipArt[tileKey] = url; clipEmit('art', { tileKey, url }); },
    off: () => { clipStop('reset'); clipEmit('reset'); clipEmit('off'); },
    main: () => { clipStop('main'); },
  };
  return { S, dispatch, locate, adminSet, surfaces, keyClick, keydown, activeAttrs, views, focused, focusedIn, vpc: globals.VUEPLAYERCORE, api: globals.MSTREAMAPI, calls, storage, queued, opened, fedQueued, toasts, els, click, bandClick, change, tick, liveWatches, watchers, patches, writes, renders: () => renders, bodyClasses, adopted, albumsOpened, rowsQueued, knownPeers, timers, liveTimers, runTimers, setVisibility, docListeners, clip: clipCtl, gateWatchers, copied, scrolls, title, viewNavs, explorer: globals.loadFileExplorer };
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

const PEER_ROW = { source: 'federation', seedHash: null, peer: { id: 1, name: 'Sam\'s server' }, filepath: 'tunes/P/One.mp3', title: 'Peer Song', artist: 'Quinn', album: 'Peer Album', duration: 210, similarity: 0.85, albumArt: 'pa.jpg' };
const PEERS = {
  ...MAIN, library: null, network: null,
  peers: {
    peers: [
      { id: 1, name: 'Sam\'s server', reachable: true, mismatched: false, lastSeen: '2026-10-05T00:00:00.000Z',
        results: [PEER_ROW, { ...PEER_ROW, filepath: 'tunes/P/Two.mp3', title: 'Peer Two', album: '', albumArt: null, similarity: 0.6 }] },
      { id: 2, name: 'Peer <B>', reachable: false, mismatched: false, lastSeen: '2026-10-03T00:00:00.000Z', results: [{ ...PEER_ROW, peer: { id: 2, name: 'Peer <B>' }, title: 'Offline Song' }] },
    ],
    searched: { peers: 1, unreachable: 1, mismatched: 0 },
  },
};

const answer = (body) => (body.sources.includes('peers') ? PEERS : MAIN);

// api.js's own MSTREAMAPI.peerArtUrl (the art proxy URL), over the
// sandbox's server — so a test sees the very URL an <img> would load.
function realPeerArtUrl() {
  const api = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = api.indexOf('  mstreamModule.peerArtUrl = ');
  assert.ok(start >= 0, 'api.js no longer defines mstreamModule.peerArtUrl — update this test');
  const end = api.indexOf('\n  };', start);
  const mstreamModule = { currentServer: { host: 'http://host/', token: 'TOK' } };
  new Function('mstreamModule', api.slice(start, end + 5))(mstreamModule);
  return mstreamModule.peerArtUrl;
}

// A connected server's answer whose rows name their covers (albumArt), and
// one whose rows name none (a peer on an older server sends no field).
const COVER_ROWS = [
  { ...PEER_ROW, peer: { id: 7, name: 'Kim' }, filepath: 'k/Kite 1.mp3', title: 'Kite One', album: 'Kite', artist: 'Kim', albumArt: 'c0ffee12.jpeg', similarity: 0.9 },
  { ...PEER_ROW, peer: { id: 7, name: 'Kim' }, filepath: 'k/Kite 2.mp3', title: 'Kite Two', album: 'Kite', artist: 'Kim', albumArt: 'c0ffee12.jpeg', similarity: 0.8 },
  { ...PEER_ROW, peer: { id: 7, name: 'Kim' }, filepath: 'k/Lark 1.mp3', title: 'Lark One', album: 'Lark', artist: 'Kim', albumArt: 'beef 34.png', similarity: 0.7 },
];
const peersWith = (results) => ({ ...PEERS, peers: { peers: [{ id: 7, name: 'Kim', reachable: true, mismatched: false, lastSeen: null, results }], searched: { peers: 1, unreachable: 0, mismatched: 0 } } });
const coverAnswer = (results) => (body) => (body.sources.includes('peers') ? peersWith(results) : { ...MAIN, library: null });
const imgSrcs = (html) => [...html.matchAll(/<img loading="lazy" src="([^"]*)"/g)].map((m) => decode(m[1]));
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
    assert.match(html, /<img loading="lazy" src="http:&#x2F;&#x2F;host&#x2F;peer&#x2F;1&#x2F;art&#x2F;pa.jpg\?c&#x3D;l" alt="" onerror="discoveryPeerArtFailed\(this\)">/, 'the card asks for the peer\'s compressed \'l\' cover');
    assert.equal(countDrawn(html, { 'data-dp': 'peerAlbumOpen' }), 1, 'the album-less row makes no card');
    // the songs: art tile, title, "Artist · Album"
    assert.ok(html.includes('Title Seven') && html.includes('Title Eight'));
    assert.match(html, /<span class="dpage-art"><img loading="lazy" src="http:\/\/host\/album-art\/a7.jpg\?compress=s&token=TOK" alt=""><\/span>/);
    assert.match(html, /<span class="dpage-art dpage-art-ph">/, 'no art: the note tile');
    assert.ok(html.includes('Jay · Album Seven'));
    assert.ok(html.includes('Quinn · Peer Album'));
    assert.match(html, /<span class="dpage-art"><img loading="lazy" src="http:&#x2F;&#x2F;host&#x2F;peer&#x2F;1&#x2F;art&#x2F;pa.jpg\?c&#x3D;s" alt="" onerror="discoveryPeerArtFailed\(this\)"><\/span>/);
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
    assert.deepEqual(fedQueued[0][3], { title: 'Peer Song', artist: 'Quinn', duration: 210, album: 'Peer Album', 'album-art': 'pa.jpg' },
      'the lite metadata carries the cover: the queue row and now-playing card draw it through the proxy');
    assert.equal(fedQueued[0][5], 3, 'right after the playing song');
    click({ 'data-dp': 'fedQueue', 'data-i': 1 });
    assert.deepEqual(fedQueued[1], ['queue', PEERS.peers.peers[0].results[1]], 'the route\'s own row, through the federation stream');
    click({ 'data-dp': 'peerMore', 'data-i': 0 });
    assert.equal(opened[0].source, 'federation');
    assert.equal(opened[0].raw, PEER_ROW);
    const { opener, ...opts } = opened[0].opts;
    assert.deepEqual(opts, { seedPlain: 'dpage.match.recent' }, 'a connected row was matched against the centroid');
    assert.equal(opener.getAttribute('data-dp'), 'peerMore', 'the window gives the keyboard back to the ⋯ on close');
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

  // The album card's ⋯: the recommendation window, read as the album.
  const BEST = { ...PEER_ROW, filepath: 'tunes/P/Three.mp3', title: 'Peer Three', similarity: 0.95, albumArt: null };
  const twoRowAlbum = (b) => (b.sources.includes('peers')
    ? { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: [PEER_ROW, BEST] }] } }
    : MAIN);

  test('a connected album card\'s ⋯ opens the window on the album\'s best row, as the album — no copy starts', async () => {
    const { S, click, opened, adopted, albumsOpened, fedQueued, rowsQueued, calls } = makeSandbox({ taste: twoRowAlbum });
    await S.discoveryPanel();
    const asked = calls.length;
    click({ 'data-dp': 'peerAlbumMore', 'data-i': 0 });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].source, 'federation');
    assert.equal(opened[0].raw, BEST, 'raws[0]: the best match, the route\'s own row unchanged');
    const { opener, ...opts } = opened[0].opts;
    assert.deepEqual(opts, { seedPlain: 'dpage.match.recent', focus: 'album' });
    assert.equal(opener.getAttribute('data-dp'), 'peerAlbumMore', 'the keyboard goes back to the card\'s ⋯');
    assert.deepEqual([adopted, albumsOpened, fedQueued, rowsQueued], [[], [], [], []], 'the ⋯ neither browses nor queues');
    assert.equal(calls.length, asked, 'nothing is asked of the server — the window does its own reads');
  });

  test('the card\'s own click and Enter still open the album in peer browse — never the window', async () => {
    const { S, click, keydown, opened, adopted, albumsOpened } = makeSandbox({ taste: twoRowAlbum });
    await S.discoveryPanel();
    click({ 'data-dp': 'peerAlbumOpen', 'data-i': 0 }, 'div');
    assert.equal(keydown({ 'data-dp': 'peerAlbumOpen', 'data-i': 0 }, 'Enter'), true);
    assert.deepEqual(adopted, ['1', '1']);
    assert.deepEqual(albumsOpened, [['Peer Album', 'Quinn', null, null], ['Peer Album', 'Quinn', null, null]]);
    assert.equal(opened.length, 0);
  });

  test('the card\'s ⋯ is a labelled, focusable button on the card\'s art, beside its play button', async () => {
    const { S, keyClick, opened } = makeSandbox({ taste: twoRowAlbum });
    await S.discoveryPanel();
    const html = S.page();
    const strip = html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
    const more = findDrawn(strip, { 'data-dp': 'peerAlbumMore', 'data-i': 0 });
    assert.ok(more, 'drawn on the connected server\'s card');
    assert.equal(more.tag, 'button', 'a real button: Tab reaches it, Enter and Space press it');
    assert.equal(more.attrs.type, 'button');
    assert.equal(more.attrs.title, 'dpage.verb.albumMore');
    assert.equal(more.attrs['aria-label'], 'dpage.verb.albumMore');
    assert.equal(more.attrs.class, 'dpage-album-more');
    assert.equal(countDrawn(html, { 'data-dp': 'peerAlbumMore' }), 1, 'one per card');
    const art = strip.slice(strip.indexOf('<div class="album-grid-art">'), strip.indexOf('<div class="album-grid-info">'));
    assert.ok(art.indexOf('data-dp="peerAlbum"') >= 0 && art.indexOf('data-dp="peerAlbum"') < art.indexOf('data-dp="peerAlbumMore"'), 'on the art, after the play button');
    const lib = html.slice(html.indexOf('dpage-strip dpage-src-library'), html.indexOf('dpage-strip dpage-src-peers'));
    assert.ok(!lib.includes('peerAlbumMore'), 'the library\'s cards have none');
    keyClick({ 'data-dp': 'peerAlbumMore', 'data-i': 0 });
    assert.equal(opened.length, 1);
    assert.match(html, /aria-label="dpage\.verb\.albumMore">⋯<\/button>/);
    // shown as the play button is: on hover, on keyboard focus inside the
    // card (never a mouse click's focus), always on touch — on any album
    // card (a connected server's browse cards carry the same ⋯)
    const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(css, /\n\.album-grid-card:hover \.dpage-album-more, \.album-grid-card:has\(:focus-visible\) \.dpage-album-more \{ opacity: 1; \}/);
    assert.match(css, /\.dpage-album-more:focus-visible \{ outline: 2px solid #fa832b;/);
    const touch = css.slice(css.indexOf('@media (hover: none) {', css.indexOf('/* ── The Discover page')));
    assert.match(touch.slice(0, touch.indexOf('\n}')), /\n {2}\.dpage-album-more \{ opacity: 1;/);
    assert.ok(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8').replace(/\r\n/g, '\n').includes('"dpage.verb.albumMore": "More for this album"'));
  });

  test('connected servers\' covers: the row\'s albumArt through the art proxy, on the album card and the song row', async () => {
    const { S } = makeSandbox({ taste: coverAnswer(COVER_ROWS), peerArtUrl: realPeerArtUrl() });
    await S.discoveryPanel();
    const html = S.page();
    const strip = html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
    const col = html.slice(html.indexOf('dpage-col dpage-src-peers'));
    // the album cards: one per album, the first row's cover, the peer's
    // compressed 'l' variant (zl-, at most 256 px) — never the full-size
    // original, which crosses the proxy for a 150 px card
    assert.deepEqual(imgSrcs(strip), [
      'http://host/api/v1/federation/peers/7/art/c0ffee12.jpeg?compress=l&token=TOK',
      'http://host/api/v1/federation/peers/7/art/beef%2034.png?compress=l&token=TOK',
    ]);
    // the song rows: the 40 px tile, the small thumbnail, lazy like the library's
    assert.deepEqual(imgSrcs(col), [
      'http://host/api/v1/federation/peers/7/art/c0ffee12.jpeg?compress=s&token=TOK',
      'http://host/api/v1/federation/peers/7/art/c0ffee12.jpeg?compress=s&token=TOK',
      'http://host/api/v1/federation/peers/7/art/beef%2034.png?compress=s&token=TOK',
    ], 'the row\'s server, the row\'s file, compress=s');
    assert.ok(!col.includes('dpage-art-ph'), 'every row has its cover');
    assert.equal(countDrawn(strip, { 'data-dp': 'peerAlbumOpen' }), 2);

    // the compressed-art layout setting changes nothing here: still 'l' on
    // the cards, 's' on the rows
    const small = makeSandbox({ taste: coverAnswer(COVER_ROWS), peerArtUrl: realPeerArtUrl(), compressArt: true });
    await small.S.discoveryPanel();
    const sHtml = small.S.page();
    const sStrip = sHtml.slice(sHtml.indexOf('dpage-strip dpage-src-peers'), sHtml.indexOf('<div class="dpage-songs'));
    const sCol = sHtml.slice(sHtml.indexOf('dpage-col dpage-src-peers'));
    assert.deepEqual(imgSrcs(sStrip), imgSrcs(strip), 'the same card URLs with the setting on');
    assert.deepEqual(imgSrcs(sCol).map((u) => new URL(u).searchParams.get('compress')), ['s', 's', 's']);
  });

  test('a connected server\'s cover that fails to load (the proxy\'s 502 or 404) falls back to the note tile', async () => {
    const { S } = makeSandbox({ taste: coverAnswer(COVER_ROWS), peerArtUrl: realPeerArtUrl() });
    await S.discoveryPanel();
    const html = S.page();
    const strip = html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
    const col = html.slice(html.indexOf('dpage-col dpage-src-peers'));
    // every peer <img> (cards and rows) carries the fallback; the library's do not
    const peerImgs = (h) => [...h.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    assert.ok(peerImgs(strip).length === 2 && peerImgs(strip).every((t) => t.includes('onerror="discoveryPeerArtFailed(this)"')));
    assert.ok(peerImgs(col).length === 3 && peerImgs(col).every((t) => t.includes('onerror="discoveryPeerArtFailed(this)"')));
    const libCol = html.slice(html.indexOf('dpage-col dpage-src-library'), html.indexOf('dpage-col dpage-src-peers'));
    assert.ok(peerImgs(libCol).every((t) => !t.includes('onerror')), 'the library\'s own covers are unchanged');
    // the handler: a song row's tile becomes the placeholder tile, a card's <img> the card's note glyph
    const fakeImg = (cls) => {
      const box = { innerHTML: '<img>', classes: new Set(cls), classList: null };
      box.classList = { contains: (c) => box.classes.has(c), add: (c) => box.classes.add(c) };
      return { parentElement: box, onerror: () => {}, outerHTML: '<img>' };
    };
    const row = fakeImg(['dpage-art']);
    S.discoveryPeerArtFailed(row);
    assert.ok(row.parentElement.classes.has('dpage-art-ph'));
    assert.match(row.parentElement.innerHTML, /^<svg[^>]*viewBox="0 0 24 24"/);
    assert.equal(row.onerror, null, 'never fires twice');
    const card = fakeImg(['album-grid-art']);
    S.discoveryPeerArtFailed(card);
    assert.match(card.outerHTML, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" fill="#555">/);
    assert.ok(!card.parentElement.classes.has('dpage-art-ph'));
    S.discoveryPeerArtFailed({ parentElement: null }); // detached: nothing to do, no throw
  });

  test('connected servers without albumArt (an older peer, a bare track): the note tile, no proxy request', async () => {
    const bare = COVER_ROWS.map(({ albumArt: _albumArt, ...r }, i) => (i === 2 ? { ...r, albumArt: null } : r));
    const { S } = makeSandbox({ taste: coverAnswer(bare), peerArtUrl: realPeerArtUrl() });
    await S.discoveryPanel();
    const html = S.page();
    const strip = html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
    const col = html.slice(html.indexOf('dpage-col dpage-src-peers'));
    assert.deepEqual(imgSrcs(html), [], 'no <img> at all');
    assert.ok(!html.includes('/art/'), 'nothing asks the proxy');
    assert.equal((strip.match(/<div class="album-grid-art">\s*<svg[^>]*viewBox="0 0 24 24"/g) || []).length, 2, 'both cards: the note tile');
    assert.equal((col.match(/<span class="dpage-art dpage-art-ph">/g) || []).length, 3, 'every row: the note tile');
  });

  test('a connected album card: Enter opens it (the keyboard reaches it); a card with no art draws the note tile', async () => {
    const noArt = { ...PEER_ROW, filepath: 'tunes/P/Other.mp3', title: 'Other', album: 'Bare Album', albumArt: null, similarity: 0.7 };
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

// A compilation on a connected server (2026-10-19: "for compilation
// albums, copy the whole album"): two songs by two track artists, one
// album credit. The rows carry it as `albumArtist`; the page draws one
// card under it and asks the peer for the album by it, whole.
describe('Discover page: a connected server\'s compilation', () => {
  const VA_ROW = (title, artist, similarity, over) => ({
    ...PEER_ROW, filepath: `tunes/VA/Mixtape/${title}.mp3`, title, artist, album: 'Mixtape Vol 1', albumArtist: 'Various Artists', year: 2020,
    albumArt: 'mix.jpeg', similarity, ...over,
  });
  const ANA = VA_ROW('Wind One', 'Ana', 0.9);
  const BEN = VA_ROW('Ben Song', 'Ben', 0.8);
  const compAnswer = (b) => (b.sources.includes('peers')
    ? { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: [BEN, ANA] }] } }
    : { ...MAIN, library: null });
  const strip = (html) => html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));
  // the batch lookup as the server answers it: the registry's own keys
  const keysOf = (rec) => plugins.jobKeysFor(plugins.recommendationSchema.validate(rec).value);
  const realLookup = (jobs) => (recs) => ({ results: recs.map((r) => {
    const keys = keysOf(r);
    const own = new Set(Object.values(keys));
    return { key: keys.song, keys, jobs: jobs.filter((j) => own.has(j.key)) };
  }) });

  test('two songs by Ana and Ben, one album credit: ONE card, its artist line "Various Artists", narrowed by the credit and never by a track artist', async () => {
    const { S } = makeSandbox({ taste: compAnswer });
    await S.discoveryPanel();
    const html = S.page();
    assert.equal(countDrawn(html, { 'data-dp': 'peerAlbumOpen' }), 1, 'one card, not one per track artist');
    const card = findDrawn(html, { 'data-dp': 'peerAlbumOpen', 'data-i': 0 });
    assert.equal(card.attrs['data-album'], 'Mixtape Vol 1');
    assert.equal(card.attrs['data-album-artist'], 'Various Artists');
    assert.equal('data-artist' in card.attrs, false, 'no track artist on the card');
    assert.equal(card.attrs['aria-label'], 'Mixtape Vol 1 · Various Artists');
    assert.match(strip(html), /<div class="album-grid-name">Mixtape Vol 1<\/div>\s*<div class="album-grid-artist">Various Artists<\/div>/);
    // the song rows keep their own artists
    assert.ok(html.includes('Ana · Mixtape Vol 1') && html.includes('Ben · Mixtape Vol 1'));
  });

  test('the card opens and queues the album whole: album_artist, no artist', async () => {
    const songs = [ANA, BEN, VA_ROW('Third', 'Cy', 0.1)].map((r) => ({ filepath: r.filepath, metadata: { title: r.title, artist: r.artist } }));
    const { S, click, albumsOpened, rowsQueued, calls } = makeSandbox({ taste: compAnswer, albumSongs: () => songs });
    await S.discoveryPanel();
    click({ 'data-dp': 'peerAlbumOpen', 'data-i': 0 });
    assert.deepEqual(albumsOpened, [['Mixtape Vol 1', null, null, 'Various Artists']], 'getAlbumSongs(album, artist, year, albumArtist)');
    click({ 'data-dp': 'peerAlbum', 'data-i': 0 });
    await flush(); await flush();
    assert.deepEqual(calls.filter((c) => c.name === 'peerAlbumSongs').map((c) => [c.id, c.body]), [[1, { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists' }]]);
    assert.equal(rowsQueued.length, 3, 'every song of the compilation, Cy\'s too');
  });

  test('the card\'s ⋯ opens its best row (raws[0]) as the album; that row\'s album copy is the one Ben\'s row looks up', async () => {
    const { S, click, opened } = makeSandbox({ taste: compAnswer });
    await S.discoveryPanel();
    click({ 'data-dp': 'peerAlbumMore', 'data-i': 0 });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].raw, ANA, 'the best match, the route\'s row unchanged — its albumArtist included');
    assert.deepEqual({ ...opened[0].opts, opener: undefined }, { seedPlain: 'dpage.match.recent', focus: 'album', opener: undefined });
    assert.equal(keysOf(opened[0].raw).album, keysOf(BEN).album, 'one whole-album job, whichever song it starts from');
    assert.notEqual(keysOf(ANA).artist, keysOf(BEN).artist);
  });

  test('a running copy of the compilation badges both rows and the one card (the server\'s own keys)', async () => {
    const PLUG = { available: true, list: [{ name: 'federation-copy', title: 'Copy from a connected server', capabilities: ['acquire'], scopes: ['song', 'album', 'artist', 'artist-missing'] }], jobsAllowed: true };
    const copying = { id: 5, plugin: 'federation-copy', state: 'running', progress: 0.25, statusText: 'song 1 of 4', key: keysOf(BEN).album,
      params: { scope: 'album' }, recommendation: { ...BEN }, cancelRequested: false };
    const { S, calls } = makeSandbox({ taste: compAnswer, flags: { ...FLAGS_ALL, discoveryPlugins: true }, plugins: PLUG, lookup: realLookup([copying]), jobs: [copying] });
    await S.discoveryPanel();
    const lookup = calls.find((c) => c.name === 'lookup');
    assert.deepEqual(lookup.body.map((r) => [r.title, r.albumArtist]), [['Wind One', 'Various Artists'], ['Ben Song', 'Various Artists']], 'the rows go to the lookup raw, their credit with them');
    const html = S.page();
    for (const i of [0, 1]) {
      assert.match(html, new RegExp(`data-bslot="p${i}"><span class="dpage-badge dpage-badge-src">discover\\.job\\.copying · discover\\.tray\\.kindAlbum<`), `row ${i}`);
    }
    assert.match(strip(html), /data-bslot="a0"><span class="dpage-badge dpage-badge-src">discover\.job\.copying<\/span>/);
    assert.equal(countDrawn(html, { 'data-dp': 'peerAlbumOpen' }), 1);
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

});

// The connected servers' call is the page's slow half (a peer may take its
// whole 4 s deadline), asked after the library answer lands: it never dims
// the library, and its column retries on its own.
describe('Discover page: the connected servers\' call on its own', () => {
  const libraryCol = (html) => /<section class="dpage-col dpage-src-library"[\s\S]*?<\/section>/.exec(html)[0];

  test('while only that call is out, nothing dims: the library is drawn bright, their strip and column wait in skeletons', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { S } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? gate.then(() => PEERS) : MAIN), playing: PLAYING });
    const run = S.discoveryPanel();
    await flush(); await flush();
    let html = S.page();
    assert.match(html, /Title Seven/, 'the library answer has landed');
    assert.ok(!S.head().includes('dpage-busy') && !S.html().includes('dpage-busy'), 'neither root dims');
    assert.ok(!PAGE_BUSY.test(S.html()), 'not the loading state either');
    assert.match(html, /<section class="dpage-strip dpage-src-peers" aria-busy="true">/, 'their strip says it is asking');
    assert.match(html, /<section class="dpage-col dpage-src-peers" data-source="peers"><div class="dpage-rows" aria-busy="true">/, 'so does their column');
    assert.ok(!/<section class="dpage-col dpage-src-library"[^>]*aria-busy/.test(html) && !/dpage-src-library[^"]*" aria-busy/.test(html), 'the library is not marked busy');
    release();
    await run;
    html = S.page();
    assert.match(html, /Peer Song/);
    assert.ok(!html.includes('aria-busy'), 'settled');
  });

  test('a failed connected call: the column\'s Try again re-sends that call alone, as it was — the library batch on screen stays', async () => {
    let peersFail = true;
    const { S, calls, click } = makeSandbox({ taste: (b) => (b.sources.includes('peers') ? (peersFail ? null : PEERS) : MAIN), playing: PLAYING });
    await S.discoveryPanel();
    assert.match(S.page(), /dpage-src-peers[\s\S]*dpage\.source\.failed[\s\S]*data-dp="peersRetry"/, 'its own Try again');
    const before = libraryCol(S.page());
    const sent = tasteCalls(calls);
    const firstPeers = sent[sent.length - 1];
    assert.deepEqual(firstPeers.sources, ['peers']);
    peersFail = false;
    click({ 'data-dp': 'peersRetry' });
    // asking: that column's skeleton, the page bright
    let html = S.page();
    assert.match(html, /<section class="dpage-col dpage-src-peers" data-source="peers"><div class="dpage-rows" aria-busy="true">/);
    assert.ok(!S.html().includes('dpage-busy'), 'no dim');
    assert.equal(libraryCol(html), before, 'the library column is untouched while it asks');
    await flush(); await flush();
    const after = tasteCalls(calls);
    assert.equal(after.length, sent.length + 1, 'one call: the connected servers alone');
    assert.deepEqual(after[after.length - 1], firstPeers, 'the same body: the same pins, window and limits');
    html = S.page();
    assert.equal(libraryCol(html), before, 'the library column is untouched after it lands');
    assert.match(html, /Peer Song/, 'the column draws the answer');
    assert.ok(!html.includes('data-dp="peersRetry"'));
  });

  test('New seeds while that Try again is out: the late retry answer is dropped, the new ask\'s column stands', async () => {
    let mode = 'fail';
    let releaseRetry;
    const retryGate = new Promise((r) => { releaseRetry = r; });
    const FRESH = { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: [{ ...PEER_ROW, title: 'Fresh Peer' }] }] } };
    const { S, click } = makeSandbox({
      taste: (b) => {
        if (!b.sources.includes('peers')) { return MAIN; }
        if (mode === 'fail') { return null; }
        if (mode === 'retry') { return retryGate.then(() => PEERS); }
        return FRESH;
      },
    });
    await S.discoveryPanel();
    mode = 'retry';
    click({ 'data-dp': 'peersRetry' });
    await flush();
    mode = 'fresh';
    click({ 'data-dp': 'refresh' });
    await flush(); await flush(); await flush();
    assert.match(S.page(), /Fresh Peer/, 'the new ask drew its own column');
    releaseRetry();
    await flush(); await flush();
    const html = S.page();
    assert.match(html, /Fresh Peer/, 'still the new ask\'s');
    assert.ok(!html.includes('Peer Two'), 'the late retry answer never drew');
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
    const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
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
    const n = tasteCalls(calls).length;
    inHead({ 'data-dp': 'refresh' });
    click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.equal(tasteCalls(calls).length, n + 2, 'refresh re-asks');
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

// The play page's connected-server rows and album cards carry their copy's
// badge: a word and what it acts on, at most a thin bar — no percentage
// and no count on the page (the numbers stay in the window).
describe('Discover page: job badges (the play page\'s connected servers)', () => {
  const PLUG = { available: true, list: [{ name: 'federation-copy', title: 'Copy from a connected server', capabilities: ['acquire'], scopes: ['song', 'album', 'artist', 'artist-missing'] }], jobsAllowed: true };
  // Sam's album copy of 'Peer Album' (PEER_ROW's), keyed as the server keys it
  const COPY = {
    id: 9, plugin: 'federation-copy', state: 'running', progress: 0.5, statusText: 'album 1 of 1 · 1 of 2 songs', key: 'album:pa',
    params: { scope: 'album' }, recommendation: { ...PEER_ROW }, cancelRequested: false,
  };
  const KEYS = {
    'Peer Song': { key: 'text:ps', keys: { song: 'text:ps', album: 'album:pa', artist: 'artist:q', folder: 'folder:1' } },
    'Peer Two': { key: 'text:p2', keys: { song: 'text:p2', artist: 'artist:q', folder: 'folder:2' } },
  };
  const answerFor = (jobs) => (recs) => ({ results: recs.map((r) => {
    const k = KEYS[r.title] || { key: 'text:' + r.title, keys: { song: 'text:' + r.title } };
    const own = new Set(Object.values(k.keys));
    return { ...k, jobs: jobs.filter((j) => own.has(j.key)) };
  }) });
  const box = (extra = {}) => makeSandbox({ taste: answer, flags: { ...FLAGS_ALL, discoveryPlugins: true }, plugins: PLUG, lookup: answerFor([COPY]), jobs: [COPY], ...extra });
  const lookupsOf = (calls) => calls.filter((c) => c.name === 'lookup');
  const peerCol = (html) => html.slice(html.indexOf('<section class="dpage-col dpage-src-peers"'));
  const libCol = (html) => html.slice(html.indexOf('<section class="dpage-col dpage-src-library"'), html.indexOf('<section class="dpage-col dpage-src-peers"'));
  const strip = (html) => html.slice(html.indexOf('dpage-strip dpage-src-peers'), html.indexOf('<div class="dpage-songs'));

  test('one batch for the connected rows (the library\'s never); the album copy badges its row and its card — the word and the kind, a thin bar, no number', async () => {
    const { S, calls } = box();
    await S.discoveryPanel();
    const lookups = lookupsOf(calls);
    assert.equal(lookups.length, 1, 'one batch');
    assert.deepEqual(lookups[0].body, [PEER_ROW, PEERS.peers.peers[0].results[1]], 'the playable connected rows as the route sent them — the offline server\'s row and the library rows never');
    const html = S.page();
    const col = peerCol(html);
    // the word rides the subtitle line after "Artist · Album" (which gives way
    // first) and the bar is pinned to the row's edge: neither adds a line, so
    // a badge arriving on the poll never changes the row's height
    assert.match(col, /<div class="discover-row-sub dpage-subline"><span class="dpage-subtext">Quinn · Peer Album<\/span><div class="dpage-slot" data-bslot="p0"><span class="dpage-badge dpage-badge-src">discover\.job\.copying · discover\.tray\.kindAlbum<\/span><\/div><\/div>/);
    assert.match(col, /<\/div><div class="dpage-slot" data-pslot="p0"><div class="dpage-prog dpage-prog-thin" aria-hidden="true"><i style="transform:scaleX\(0\.5\)"><\/i><\/div><\/div><\/div>/, 'the bar sits outside the subtitle line');
    assert.match(col, /data-bslot="p1"><\/div>/, 'Peer Two (no album, no job of its own): an empty slot');
    const card = strip(html);
    assert.match(card, /data-bslot="a0"><span class="dpage-badge dpage-badge-src">discover\.job\.copying<\/span>/, 'the card: the same copy, under its artist line — no "album" on an album');
    assert.match(card, /data-pslot="a0"><div class="dpage-prog dpage-prog-thin"/, 'its bar along the cover');
    assert.ok(!/data-[bp]slot/.test(libCol(html)), 'library rows carry no slot');
    const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(css, /\.dpage-songs \.dpage-row \.dpage-prog-thin \{ position: absolute;/, 'the row bar is pinned, never a line of its own');
    assert.ok(!/\.discover-row-info \.dpage-badge \{ display: block/.test(css), 'the row badge is never a block line under the subtitle');
    assert.ok(!html.includes('discover.job.copiedCount') && !html.includes('1 of 2 songs'), 'no count');
    assertTrimmed(html, 'with a live copy');
  });

  test('a poll tick patches p0 and a0 in place — no page draw, the keyboard stays where it was; an unchanged tick draws nothing', async () => {
    const { S, tick, patches, renders, keyClick, activeAttrs } = box();
    await S.discoveryPanel();
    keyClick({ 'data-dp': 'peerMore', 'data-i': 1 });
    const focusedOn = activeAttrs();
    assert.ok(focusedOn, 'focus on the second row\'s ⋯');
    const drawn = renders();
    const html = S.page();
    tick([COPY]);
    assert.equal(patches.length, 0, 'nothing changed: nothing drawn');
    tick([{ ...COPY, progress: 0.8, statusText: 'album 1 of 1 · 2 of 2 songs' }]);
    assert.equal(renders(), drawn, 'no whole-page draw on the poll');
    assert.equal(S.page(), html, 'the page markup is untouched (slots are written in place)');
    assert.equal(activeAttrs(), focusedOn, 'the keyboard stays on its control');
    const bar = (id) => patches.filter((pt) => pt.slot === 'data-pslot' && pt.id === id).pop();
    assert.match(bar('p0').html, /scaleX\(0\.8\)/);
    assert.match(bar('a0').html, /scaleX\(0\.8\)/);
    assert.ok(!patches.some((pt) => pt.id === 'p1'), 'the other row is left alone');
    patches.length = 0;
    tick([{ ...COPY, state: 'done', progress: 1, result: { scope: 'album', songs: { total: 2, copied: [{}, {}], skipped: [], failed: [] }, counts: { total: 2, copied: 2, skipped: 0, failed: 0 }, stopped: null, peer: { id: 1, name: 'Sam\'s server' } } }]);
    const word = (id) => patches.filter((pt) => pt.slot === 'data-bslot' && pt.id === id).pop();
    assert.equal(word('p0').html, '<span class="dpage-badge dpage-badge-ok">discover.job.inCollection · discover.tray.kindAlbum</span>');
    assert.equal(word('a0').html, '<span class="dpage-badge dpage-badge-ok">discover.job.inCollection</span>');
    assert.equal(bar('p0').html, '', 'finished: no bar');
    for (const pt of patches) { assert.ok(!/\d\s*%|count/.test(pt.html), `no number in ${pt.id}`); }
    assert.equal(renders(), drawn);
  });

  test('"done" is not "kept": an album copy stopped by the quota reads stopped on the row and the card', async () => {
    const stopped = { ...COPY, state: 'done', progress: 1, result: { scope: 'album', songs: { total: 2, copied: [{}], skipped: [], failed: [{}] }, counts: { total: 2, copied: 1, skipped: 0, failed: 1 }, stopped: 'quota', peer: { id: 1, name: 'Sam\'s server' } } };
    const { S } = box({ lookup: answerFor([stopped]), jobs: [stopped] });
    await S.discoveryPanel();
    const html = S.page();
    assert.match(peerCol(html), /data-bslot="p0"><span class="dpage-badge dpage-badge-err">discover\.job\.stopped · discover\.tray\.kindAlbum</);
    assert.match(strip(html), /data-bslot="a0"><span class="dpage-badge dpage-badge-err">discover\.job\.stopped</);
    assert.ok(!html.includes('discover.job.inCollection'));
  });

  test('an artist copy: every row by the artist says "every album", and so does the card', async () => {
    const artist = { ...COPY, id: 11, state: 'queued', progress: null, statusText: null, key: 'artist:q', params: { scope: 'artist' } };
    const { S } = box({ lookup: answerFor([artist]), jobs: [artist] });
    await S.discoveryPanel();
    const html = S.page();
    for (const i of [0, 1]) {
      assert.match(peerCol(html), new RegExp(`data-bslot="p${i}"><span class="dpage-badge dpage-badge-src">discover\\.job\\.queued · discover\\.tray\\.kindArtist<`), `row ${i}`);
    }
    assert.match(strip(html), /data-bslot="a0"><span class="dpage-badge dpage-badge-src">discover\.job\.queued · discover\.tray\.kindArtist</);
  });

  test('every connected album card keeps its state line, badge or not — the slot the poll fills, so the strip never changes height', async () => {
    const { S, tick, patches } = box({ lookup: answerFor([]), jobs: [] });
    await S.discoveryPanel();
    const html = strip(S.page());
    const cards = html.match(/<div class="dpage-album"/g) || [];
    assert.ok(cards.length >= 1, 'a card drawn');
    const lines = html.match(/<div class="dpage-cstate" data-bslot="a\d+">/g) || [];
    assert.equal(lines.length, cards.length, 'one state line per card');
    assert.match(html, /<div class="album-grid-artist">[^<]*<\/div>\s*<div class="dpage-cstate" data-bslot="a0"><\/div>/, 'drawn empty under the artist line');
    assert.ok(!/class="dpage-slot" data-bslot="a/.test(html), 'not a display:contents slot (that one reserves nothing)');
    tick([COPY]);
    const word = patches.filter((pt) => pt.slot === 'data-bslot' && pt.id === 'a0').pop();
    assert.equal(word.html, '<span class="dpage-badge dpage-badge-src">discover.job.copying</span>', 'the poll fills the kept line in place');
  });

  test('another connected server\'s copy of the same album badges neither the row nor the card', async () => {
    const fromTom = { ...COPY, recommendation: { ...PEER_ROW, peer: { id: 4, name: 'Tom' } } };
    const { S, tick, patches } = box({ lookup: answerFor([fromTom]), jobs: [fromTom] });
    await S.discoveryPanel();
    const html = S.page();
    assert.match(peerCol(html), /data-bslot="p0"><\/div>/);
    assert.match(strip(html), /data-bslot="a0"><\/div>/);
    assert.ok(!html.includes('dpage-badge'));
    tick([{ ...fromTom, progress: 0.9 }]);
    assert.equal(patches.length, 0, 'its progress is not this server\'s');
  });

  test('the connected column\'s Try again looks its new rows up', async () => {
    let peersFail = true;
    const { S, calls, click } = box({ taste: (b) => (b.sources.includes('peers') ? (peersFail ? null : PEERS) : MAIN) });
    await S.discoveryPanel();
    assert.equal(lookupsOf(calls).length, 0, 'a failed column: nothing to look up');
    peersFail = false;
    click({ 'data-dp': 'peersRetry' });
    await flush(); await flush(); await flush(); await flush();
    const lookups = lookupsOf(calls);
    assert.equal(lookups.length, 1, 'its new rows, looked up');
    assert.deepEqual(lookups[0].body.map((r) => r.title), ['Peer Song', 'Peer Two']);
    assert.match(peerCol(S.page()), /data-bslot="p0"><span class="dpage-badge dpage-badge-src">discover\.job\.copying/);
  });

  test('101 connected rows: two batch calls (100, then 1) — "Show more"\'s rows are badged without asking again', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ ...PEER_ROW, filepath: `tunes/P/${i}.mp3`, title: `Many ${i}`, similarity: 0.9 - i / 1000 }));
    const big = (b) => (b.sources.includes('peers') ? { ...PEERS, peers: { ...PEERS.peers, peers: [{ ...PEERS.peers.peers[0], results: rows }] } } : MAIN);
    const { S, calls, click } = box({ taste: big, lookup: answerFor([]) });
    await S.discoveryPanel();
    assert.deepEqual(lookupsOf(calls).map((c) => c.body.length), [100, 1]);
    assert.equal(S.view.badgeRows.length, 101, 'every row, not only the 16 drawn');
    click({ 'data-dp': 'showMore', 'data-v': 'peers' });
    assert.equal(lookupsOf(calls).length, 2, 'Show more asks nothing');
    assert.match(S.page(), /data-bslot="p31"/);
  });

  test('no lookup, no slot content when the discoveryPlugins flag is off', async () => {
    const { S, calls } = box({ flags: { ...FLAGS_ALL, discoveryPlugins: false } });
    await S.discoveryPanel();
    assert.equal(lookupsOf(calls).length, 0);
    assert.ok(!S.page().includes('dpage-badge'));
  });

  test('spa.css: the play page\'s badge and thin bar use the house badge colours', () => {
    const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(css, /\.dpage-prog-thin i \{ width: 100%; transform-origin: left center; \}/);
    // the row's badge shares the subtitle line, and its bar is pinned to the row's edge
    assert.match(css, /\.dpage-subline \{ display: flex; align-items: baseline; gap: 8px; min-width: 0; \}/);
    assert.match(css, /\.dpage-subtext \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    // the card's state line: a fixed line box, so a badge never grows the strip
    assert.match(css, /\.dpage-strip \.dpage-cstate \{ display: block; height: 16px; margin-top: 2px; overflow: hidden; \}/);
    assert.match(css, /\.dpage-strip \.dpage-cstate \.dpage-badge \{ display: block; max-width: 100%; margin: 0; line-height: 16px; \}/);
    assert.ok(!/\.album-grid-info \.dpage-badge/.test(css), 'no rule left that makes the card\'s badge its own growing line');
    assert.match(css, /\.dpage-src-peers \.album-grid-art \.dpage-prog \{ position: absolute;/);
    assert.match(css, /\.dpage-badge-dim \{ color: #8a919e; \}/);
  });
});

describe('Discover page: wiring', () => {
  const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8').replace(/\r\n/g, '\n'));
  const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');

  test('index.html: the nav entry in the Music group after Most Played, hidden until the ping', () => {
    const nav = html.match(/<div id="nav-discover" class="([^"]*)" onclick="changeView\(discoveryPanel, this\);" data-panel="discovery">/);
    assert.ok(nav, 'the entry');
    for (const c of ['local-only', 'side-nav-item', 'super-hide']) { assert.ok(nav[1].split(' ').includes(c), c); }
    const most = html.indexOf('data-i18n="nav.mostPlayed"');
    const disc = html.indexOf('id="nav-discover"');
    const rated = html.indexOf('data-panel="allRated"');
    assert.ok(most > 0 && disc > most && rated > disc, 'right after Most Played');
    assert.ok(html.indexOf('data-i18n="nav.discover"') > disc);
    assert.ok(!html.includes('nav-explore'), 'no Explore row');
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
    // keyboard focus shows a row's verbs and a card's play button; a mouse
    // click's focus (and focus handed back when a menu or window closes)
    // does not keep them up — :focus-within only where :has() is missing
    assert.match(page, /\.dpage-row:hover \.dpage-verbs, \.dpage-row:has\(:focus-visible\) \.dpage-verbs \{ opacity: 1; \}/);
    assert.match(page, /\.dpage \.album-grid-card:has\(:focus-visible\) \.album-grid-play \{ opacity: 1;/);
    const plain = page.slice(0, page.indexOf('@supports not selector(:has(*))'));
    assert.ok(!/\.dpage-row:focus-within|\.album-grid-card:focus-within/.test(plain), 'no bare :focus-within outside the fallback');
    assert.match(page, /@supports not selector\(:has\(\*\)\) \{[^}]*\.album-grid-card:focus-within \.album-grid-play \{ opacity: 1;[^}]*\}\s*[^}]*\.dpage-row:focus-within \.dpage-verbs \{ opacity: 1;/);
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
    assert.deepEqual(S.view.flags, { discovery: true, discoveryTaste: 2, discoveryP2p: true, discoveryP2pPeers: 0, federationDiscovery: false, discoveryPlugins: true });
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
    const moduleSrc = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'discovery-page.js'), 'utf8').replace(/\r\n/g, '\n');
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
    const src = fs.readFileSync(path.join(ROOT, 'webapp', 'assets', 'js', 'i18n.js'), 'utf8').replace(/\r\n/g, '\n');
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

// ── Peer Recommendations (discoveryView.page 'peerRecs', m.js peerRecs*) ──
// docs/peer-recommendations-plan.md §4.1 "Tests → MT (W4)". The peers
// answers come from the route's own buildPeerView, the leads from the taste
// route's own stampNetworkRows (label and tile stamped as the server does).

const PR_FLAGS = { ...FLAGS_ALL, discoveryTaste: 2, discoveryP2pPeers: 1 };
const PR_NOW = Date.parse('2026-10-27T10:00:00.000Z');
const ep = (head) => head.padEnd(64, '0');
const BASEMENT = ep('aa01');
const KITCHEN = ep('bb02');
const MSTREAM = ep('3f9a');
const LIGHTHOUSE = ep('cc03');
const STATIC = ep('dd04');
const ROOFTOP = ep('ee05');
const prHeld = (endpointId, name) => ({ endpointId, hash: `hash-${endpointId.slice(0, 4)}`, modelId: 'm', rowCount: 100, sizeBytes: 1000, name, pinned: false });
const prCat = (endpointId, name, silentMs = 0) => ({ from: endpointId, updatedAt: new Date(PR_NOW - silentMs).toISOString(), payload: { name, hash: `hash-${endpointId.slice(0, 4)}`, rowCount: 100, modelId: 'm', size: 1000 } });
const PR_SHELF = [prHeld(BASEMENT, 'Basement Hi-Fi'), prHeld(KITCHEN, 'Kitchen Radio'), prHeld(MSTREAM, '')];
// mStream · 3f9a has been silent 10 minutes: offline
const PR_CATALOG = [prCat(BASEMENT, 'Basement Hi-Fi'), prCat(KITCHEN, 'Kitchen Radio'), prCat(MSTREAM, '', 10 * 60 * 1000),
  prCat(LIGHTHOUSE, 'Lighthouse Tapes'), prCat(STATIC, 'Static Garden'), prCat(ROOFTOP, 'Rooftop FM')];
// GET /api/v1/discovery/p2p/peers as the route builds it
function peersOf({ canAdd = false, shelf = PR_SHELF, catalog = PR_CATALOG, states = {} } = {}) {
  return buildPeerView({ shelf, catalog, localModel: 'm', now: PR_NOW, canAdd, running: true, addStateOf: (id) => states[id] || null });
}
const PR_LABELS = peerLabels({ shelf: PR_SHELF, catalog: PR_CATALOG });
const prLead = (exportId, artist, title, album, endpointId) => ({
  seedIndex: 1, artist, title, album, year: 2021, isrc: null, duration: 200, similarity: 0.83, recordingMbid: null,
  exportId, peer: { endpointId, name: PR_CATALOG.find((c) => c.from === endpointId).payload.name || null },
});
const stamp = (rows) => stampNetworkRows(rows, SEEDS, 32, PR_LABELS);
const PR_LEADS = stamp([
  prLead('x1', 'Paper Lantern', 'Signal Fires', 'Night Ferry', KITCHEN),
  prLead('x2', 'Paper Lantern', 'Harbor Lights', 'Night Ferry', BASEMENT),
  prLead('x3', 'Marlowe Fields', 'Long Exposure', 'Daylight Savings', KITCHEN),
  prLead('x4', 'Juniper Static', 'Arcade Rain', 'Neon Psalms', MSTREAM),
  prLead('x5', 'Ada <Merrow>', 'Field & Notes', 'Cartography', BASEMENT),
]);
const manyLeads = (n) => stamp(Array.from({ length: n }, (_, i) => prLead(`m${i}`, `Artist ${i}`, `Song ${i}`, `Album ${i}`, i % 2 ? BASEMENT : KITCHEN)));
// a taste answer of the page (sources: ['network']): its batch, its leads
const prAnswer = (results = PR_LEADS, over = {}) => ({ ...MAIN, library: null, peers: null, network: { results, searched: { peers: 3, tracks: 7421 }, reason: results.length ? null : 'nothing-new' }, ...over });
// The route narrowed by networkPeers (a tab): that peer's leads.
const prTaste = (over = {}) => (b) => (b.networkPeers ? prAnswer(PR_LEADS.filter((l) => l.peer.endpointId === b.networkPeers[0]), over) : prAnswer(PR_LEADS, over));
const PR_RANDOM = { seedSource: 'random', fallback: true, seeds: [{ hash: 'r1', filepath: 'music/R/Rand.flac', metadata: { title: 'Rand' }, outcome: null, plays: 0, pinned: false, analyzed: true }] };
const DEEZER = { name: 'deezer', title: 'Deezer', capabilities: ['preview'] };
const PR_PLUGINS = { available: true, list: [{ name: 'links', title: 'Links', capabilities: ['links'] }, DEEZER], jobsAllowed: false };
const GET_IT = { available: true, list: [DEEZER, { name: 'youtube', title: 'YouTube', capabilities: ['acquire'] }], jobsAllowed: true };
const PREVIEW = { provider: 'deezer', url: 'https://cdn/clip.mp3', seconds: 30, title: 'Signal Fires', artist: 'Paper Lantern', album: 'Night Ferry', link: 'https://www.deezer.com/track/1', artwork: 'https://cdn/nf.jpg', attribution: 'Preview from Deezer' };

const prBox = (extra = {}) => makeSandbox({ taste: prTaste(), flags: PR_FLAGS, peers: () => peersOf(), plugins: PR_PLUGINS, playing: PLAYING, ...extra });
// Open the page and let its poll, its plug-in read and its ask land.
const openPage = async (box) => { await box.S.peerRecsPanel(); await flush(); await flush(); await flush(); };
const peersCalls = (calls) => calls.filter((c) => c.name === 'peers').length;
const stripOf = (html) => { const at = locateIn(html, '[data-prec-strip]'); return at ? html.slice(at.innerStart, at.innerEnd) : ''; };
const drawnRows = (html) => tagsOf(html).filter((el) => el.attrs['data-dp'] === 'precOpen');
const playOf = (html, i) => findDrawn(html, { 'data-dp': 'precPlay', 'data-i': i });
const lastWrite = (writes, sel) => writes.filter((w) => w.path[w.path.length - 1] === sel).pop();

describe('Peer Recommendations: the gate and its nav row', () => {
  test('the nav row shows with all four flags; any one missing keeps it hidden (Discover\'s row follows its own)', () => {
    const { S, els } = makeSandbox({ taste: answer });
    const full = { discovery: true, discoveryTaste: 2, discoveryP2p: true, discoveryP2pPeers: 1 };
    S.applyDiscoveryPing(full);
    assert.equal(S.view.flags.discoveryP2pPeers, 1);
    assert.ok(!els.get('nav-peer-recs').classList.contains('super-hide'));
    for (const off of [{ discovery: false }, { discoveryTaste: 1 }, { discoveryP2p: false }, { discoveryP2pPeers: 0 }, { discoveryP2pPeers: undefined }]) {
      S.applyDiscoveryPing({ ...full, ...off });
      assert.ok(els.get('nav-peer-recs').classList.contains('super-hide'), JSON.stringify(off));
    }
    S.applyDiscoveryPing({ ...full, discoveryP2p: false });
    assert.ok(!els.get('nav-discover').classList.contains('super-hide'), 'Discover keeps its row');
    S.applyDiscoveryPing({ ...full, discoveryTaste: '2', discoveryP2pPeers: '1' });
    assert.ok(!els.get('nav-peer-recs').classList.contains('super-hide'), 'numeric strings count');
  });

  test('a server without the page asks nothing: no taste call, no peers poll', async () => {
    for (const flags of [FLAGS_ALL, { ...PR_FLAGS, discoveryP2pPeers: 0 }, { ...PR_FLAGS, discoveryP2p: false }]) {
      const box = prBox({ flags });
      await openPage(box);
      assert.equal(tasteCalls(box.calls).length, 0, JSON.stringify(flags));
      assert.equal(peersCalls(box.calls), 0);
      assert.equal(box.liveTimers().length, 0);
    }
  });
});

describe('Peer Recommendations: opening it', () => {
  test('one taste call with the R1 body, one peers poll, its own programState and title', async () => {
    const box = prBox();
    await openPage(box);
    const { S, calls, title } = box;
    assert.deepEqual(S.state(), [{ state: 'peerRecs' }]);
    assert.equal(S.view.page, 'peerRecs');
    assert.equal(title.innerHTML, 'panel.peerRecs');
    assert.deepEqual(calls.filter((c) => c.name === 'taste' || c.name === 'peers').map((c) => c.name).sort(), ['peers', 'taste']);
    const [body] = tasteCalls(calls);
    assert.deepEqual(body, {
      sources: ['network'], window: 30, pin: ['music/Now/Playing.flac'], newArtistsOnly: false, ignoreVPaths: [],
      limit: { seeds: 12, network: 32 }, networkOnRandomSeed: true,
    }, 'now playing pinned; All: no networkPeers');
    assert.equal(box.clip.calls.filter((c) => c[0] === 'reset').length, 1, 'a fresh visit forgets the last one\'s previews');
  });

  test('the bar in the host; the strip, the acts line and the leads in the list — no Discover sections', async () => {
    const box = prBox();
    await openPage(box);
    const { S } = box;
    assert.match(S.head(), /^<div class="dpage dpage-chrome dpage-page-peerRecs">\s*<div class="dpage-bar">/);
    const html = S.html();
    assert.match(html, /^<div class="dpage dpage-page-peerRecs"><div class="prec-strip-host" data-prec-strip><section class="prec-strip"/);
    assert.ok(html.indexOf('data-prec-strip') < html.indexOf('data-aslot="acts"') && html.indexOf('data-aslot="acts"') < html.indexOf('data-dp="precOpen"'), 'strip, acts, leads');
    for (const gone of ['dpage-src-library', 'dpage-src-peers', 'dpage-strip', 'dpage.songs.', 'dpage.albums.']) { assert.ok(!html.includes(gone), gone); }
    assert.equal(drawnRows(html).length, 5);
  });

  test('a return ({ keep: true }) keeps the tab and the batch; the nav row is a fresh visit', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, calls } = box;
    click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    const batch = S.prec.batch;
    S.setState([{ state: 'fileExplorer' }]);
    S.setBrowserRootPanel('panel.fileExplorer');
    await S.discoveryPanel({ keep: true });
    await flush();
    assert.equal(S.prec.selected, KITCHEN, 'the tab stays');
    assert.deepEqual(tasteCalls(calls).at(-1).networkPeers, [KITCHEN], 'a new batch keeps the tab (R3)');
    assert.notEqual(S.prec.batch, batch, 'a return asks a new batch, as Discover does');
    await openPage(box);
    assert.equal(S.prec.selected, null, 'the nav row: All again');
    assert.equal(tasteCalls(calls).at(-1).networkPeers, undefined);
  });
});

describe('Peer Recommendations: the peer strip', () => {
  test('a member: All, then the shelf\'s peers in the server\'s order — monogram on its hue, a dot while online, dimmed offline; no "+"', async () => {
    const box = prBox();
    await openPage(box);
    const strip = stripOf(box.S.html());
    assert.match(strip, /^<section class="prec-strip" role="group" aria-label="peerRecs\.a11y\.peers"><div class="prec-strip-row">/);
    const items = tagsOf(strip).filter((el) => el.tag === 'button');
    assert.deepEqual(items.map((el) => el.attrs['data-v']), ['', BASEMENT, KITCHEN, MSTREAM], 'online first, then by label; All first');
    const [all, basement, , mstream] = items;
    assert.equal(all.attrs.class, 'prec-peer prec-all is-on');
    assert.equal(all.attrs['aria-pressed'], 'true');
    assert.match(strip, /data-v="" aria-pressed="true"><span class="prec-circle"><svg[^>]*>[\s\S]*?<\/svg><\/span><span class="prec-name">peerRecs\.all<\/span><\/button>/);
    assert.equal(basement.attrs.class, 'prec-peer');
    assert.equal(basement.attrs['aria-pressed'], 'false');
    assert.equal(basement.attrs['aria-label'], 'Basement Hi-Fi');
    assert.equal(basement.attrs.title, 'Basement Hi-Fi');
    const hue = peersOf().peers[0].hue;
    assert.equal(basement.attrs.style, `--h:${hue}`, 'the server\'s hue, an integer');
    assert.match(strip, /<span class="prec-circle">BH<i class="prec-online" aria-hidden="true"><\/i><\/span><span class="prec-name">Basement Hi-Fi<\/span>/);
    assert.equal(mstream.attrs.class, 'prec-peer prec-off');
    assert.match(strip, /<span class="prec-circle">mS<\/span><span class="prec-name">mStream · 3f9a<\/span>/, 'offline: no dot; the label as the server sent it');
    assert.ok(!strip.includes('precAdd') && !strip.includes('prec-add'), 'members add nothing');
  });

  test('an admin: the addable peers after the shelf — "+", Adding… (inert), Try again, No room (inert)', async () => {
    const states = { [STATIC]: { state: 'adding', code: null, at: PR_NOW }, [ROOFTOP]: { state: 'failed', code: 'offline', at: PR_NOW }, [LIGHTHOUSE]: { state: 'failed', code: 'no-room', at: PR_NOW } };
    const box = prBox({ admin: true, peers: () => peersOf({ canAdd: true, states }) });
    await openPage(box);
    const strip = stripOf(box.S.html());
    const adds = tagsOf(strip).filter((el) => el.tag === 'button' && el.attrs['data-dp'] === 'precAdd');
    assert.deepEqual(adds.map((el) => el.attrs['data-v']), [LIGHTHOUSE, STATIC, ROOFTOP], 'the server\'s order');
    const [lighthouse, statik, rooftop] = adds;
    assert.equal(lighthouse.attrs.class, 'prec-peer prec-add prec-noroom');
    assert.equal(lighthouse.attrs['aria-disabled'], 'true');
    assert.equal(lighthouse.attrs['aria-label'], 'peerRecs.a11y.noRoom{"name":"Lighthouse Tapes"}');
    assert.equal(statik.attrs.class, 'prec-peer prec-add prec-adding');
    assert.equal(statik.attrs['aria-disabled'], 'true');
    assert.match(strip, /<span class="prec-circle">SG<\/span><span class="prec-name">Static Garden<\/span><span class="prec-state">peerRecs\.adding<\/span>/);
    assert.equal(rooftop.attrs.class, 'prec-peer prec-add prec-failed');
    assert.equal(rooftop.attrs['aria-disabled'], undefined, 'Try again is a press');
    assert.equal(rooftop.attrs['aria-label'], 'peerRecs.a11y.failed{"name":"Rooftop FM"}');
    assert.match(strip, /<span class="prec-name">Rooftop FM<\/span><span class="prec-state">peerRecs\.tryAgain<\/span>/);
    assert.match(strip, /<span class="prec-name">Lighthouse Tapes<\/span><span class="prec-state">peerRecs\.noRoom<\/span>/);
    // a bare "+": the dashed circle, its dot while online, "Add {name}"
    const idle = prBox({ admin: true, peers: () => peersOf({ canAdd: true }) });
    await openPage(idle);
    const plus = findDrawn(idle.S.html(), { 'data-dp': 'precAdd', 'data-v': LIGHTHOUSE });
    assert.equal(plus.attrs.class, 'prec-peer prec-add');
    assert.equal(plus.attrs['aria-label'], 'peerRecs.a11y.add{"name":"Lighthouse Tapes"}');
    assert.match(stripOf(idle.S.html()), /data-v="cc03[0-9]+"[^>]*><span class="prec-circle"><svg[^>]*><path d="M12 5v14M5 12h14"\/><\/svg><i class="prec-online" aria-hidden="true"><\/i><\/span>/);
  });

  test('labels and monograms are escaped; data-v only ever an endpoint id; nothing until the first poll answers', async () => {
    const odd = [prCat(BASEMENT, 'Kitchen & <b>Co</b> "x"'), ...PR_CATALOG.slice(1)];
    let release;
    const gate = new Promise((r) => { release = r; });
    const box = prBox({ peers: () => gate.then(() => {
      const answer = peersOf({ catalog: odd });
      answer.peers.push({ ...answer.peers[0], endpointId: 'not-an-id' });
      return answer;
    }) });
    await openPage(box);
    assert.equal(stripOf(box.S.html()), '', 'no strip while the first poll is out');
    release();
    await flush(); await flush();
    const strip = stripOf(box.S.html());
    assert.ok(strip.includes('Kitchen &amp; &lt;b&gt;Co&lt;&#x2F;b&gt; &quot;x&quot;'), 'the label, escaped');
    assert.ok(!strip.includes('<b>Co'));
    for (const el of tagsOf(strip).filter((x) => x.attrs['data-v'] !== undefined)) {
      assert.ok(el.attrs['data-v'] === '' || /^[0-9a-f]{64}$/.test(el.attrs['data-v']), el.attrs['data-v']);
    }
    assert.ok(!strip.includes('not-an-id'));
  });

  test('no peer to show: no strip; a server without the route (404): All alone, and no more polls', async () => {
    const empty = prBox({ peers: () => peersOf({ shelf: [] }) });
    await openPage(empty);
    assert.equal(stripOf(empty.S.html()), '');
    const old = prBox({ peers: null });
    await openPage(old);
    const strip = stripOf(old.S.html());
    assert.deepEqual(tagsOf(strip).filter((el) => el.tag === 'button').map((el) => el.attrs['data-v']), ['']);
    assert.equal(old.liveTimers().length, 0, 'the poll stops');
    assert.equal(drawnRows(old.S.html()).length, 5, 'the page still works');
  });

  test('a poll that changes nothing writes nothing; a changed one patches the strip in place — its scroll and the keyboard\'s item kept', async () => {
    let answer = peersOf({ canAdd: true });
    const box = prBox({ admin: true, peers: () => answer });
    await openPage(box);
    const { S, writes, renders, runTimers, scrolls } = box;
    const stripWrites = () => writes.filter((w) => w.path[0] === '[data-prec-strip]').length;
    const written = stripWrites();
    runTimers();
    await flush(); await flush();
    assert.equal(stripWrites(), written, 'nothing changed: nothing written');
    scrolls.set('filelist .prec-strip-row', 240);
    // the keyboard on Rooftop FM's "+"; another admin starts Static Garden's Add
    S.discoveryRefocus(`[data-dp="precAdd"][data-v="${ROOFTOP}"]`);
    assert.equal(box.activeAttrs()['data-v'], ROOFTOP);
    answer = peersOf({ canAdd: true, states: { [STATIC]: { state: 'adding', code: null, at: PR_NOW } } });
    const before = renders();
    runTimers();
    await flush(); await flush();
    assert.equal(renders(), before, 'no page draw on a poll');
    assert.equal(stripWrites(), written + 1, 'the strip, once, in place');
    assert.match(stripOf(S.html()), /<span class="prec-name">Static Garden<\/span><span class="prec-state">peerRecs\.adding<\/span>/);
    assert.equal(scrolls.get('filelist .prec-strip-row'), 240, 'scrolled where it was');
    assert.equal(box.activeAttrs()['data-v'], ROOFTOP, 'the keyboard back on its item');
    assert.equal(box.focusedIn.at(-1), 'filelist');
    assert.equal(box.liveTimers().at(-1).ms, 3000, 'a row being added: 3 s');
  });

  test('a whole-page draw keeps the strip\'s sideways scroll too', async () => {
    const box = prBox();
    await openPage(box);
    box.scrolls.set('filelist .prec-strip-row', 180);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    assert.equal(box.scrolls.get('filelist .prec-strip-row'), 180);
  });
});

describe('Peer Recommendations: tabs', () => {
  test('a peer: one call pinned to every seed of the batch with networkPeers; All and the peer again ask nothing', async () => {
    const box = prBox();
    await openPage(box);
    const { S, calls, click } = box;
    const first = tasteCalls(calls)[0];
    click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    const asked = tasteCalls(calls);
    assert.equal(asked.length, 2);
    assert.deepEqual(asked[1], { ...first, pin: SEEDS.map((s) => s.filepath), limit: { seeds: 3, network: 32 }, networkPeers: [KITCHEN] }, 'R2: the batch, its seed count, the tab');
    assert.equal(findDrawn(S.html(), { 'data-dp': 'precTab', 'data-v': KITCHEN }).attrs['aria-pressed'], 'true');
    assert.deepEqual(drawnRows(S.html()).map((el) => el.attrs['data-i']), ['0', '1'], 'Kitchen Radio\'s two leads');
    assert.ok(S.html().includes('Long Exposure') && !S.html().includes('Harbor Lights'));
    click({ 'data-dp': 'precTab', 'data-v': '' });
    assert.equal(tasteCalls(calls).length, 2, 'All: the batch\'s own answer');
    assert.equal(drawnRows(S.html()).length, 5);
    click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    assert.equal(tasteCalls(calls).length, 2, 'the peer again: its answer for this batch');
    assert.equal(drawnRows(S.html()).length, 2);
  });

  test('the seed chips are the batch\'s, not a tab\'s (pinned) answer', async () => {
    const pinnedSeeds = SEEDS.map((s) => ({ ...s, pinned: true }));
    const box = prBox({ taste: (b) => (b.networkPeers ? prAnswer(PR_LEADS.slice(0, 1), { seeds: pinnedSeeds }) : prAnswer()) });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    openOptions(box.click);
    const seeds = seedsSection(box.S.page());
    assert.ok(seeds.includes('data-dp="drop"'), 'the batch\'s history seeds still drop');
    assert.equal(countDrawn(seeds, { 'data-dp': 'unpin' }), 1, 'now playing is the one pin');
  });

  test('a random batch: a tab pins its random pick too', async () => {
    const box = prBox({ taste: prTaste(PR_RANDOM), playing: null });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': BASEMENT });
    await flush(); await flush();
    const body = tasteCalls(box.calls).at(-1);
    assert.deepEqual(body.pin, ['music/R/Rand.flac']);
    assert.equal(body.limit.seeds, 1);
    assert.deepEqual(body.networkPeers, [BASEMENT]);
  });

  test('not-on-shelf (R5): back to All — its answer for the batch, no call', async () => {
    const box = prBox({ taste: (b) => (b.networkPeers ? prAnswer([], { network: { results: [], searched: { peers: 0, tracks: 0 }, reason: 'not-on-shelf' } }) : prAnswer()) });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    assert.equal(box.S.prec.selected, null);
    assert.equal(tasteCalls(box.calls).length, 2, 'no third call');
    assert.equal(findDrawn(box.S.html(), { 'data-dp': 'precTab', 'data-v': '' }).attrs['aria-pressed'], 'true');
    assert.equal(drawnRows(box.S.html()).length, 5, 'All\'s leads');
  });

  test('a walk that failed (reason error) is no answer for its tab: tapped again, the tab asks again', async () => {
    let failing = true;
    const base = prTaste();
    const box = prBox({ taste: (b) => (b.networkPeers && failing ? prAnswer([], { network: { results: [], searched: { peers: 1, tracks: 0 }, reason: 'error' } }) : base(b)) });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    assert.ok(findDrawn(box.S.html(), { 'data-dp': 'retry' }), '"Try again"');
    failing = false;
    box.click({ 'data-dp': 'precTab', 'data-v': '' });
    const n = tasteCalls(box.calls).length;
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    assert.equal(tasteCalls(box.calls).length, n + 1, 'asked again');
    assert.deepEqual(tasteCalls(box.calls).at(-1).networkPeers, [KITCHEN]);
    assert.ok(box.S.html().includes('Long Exposure') && !findDrawn(box.S.html(), { 'data-dp': 'retry' }));
    box.click({ 'data-dp': 'precTab', 'data-v': '' });
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    assert.equal(tasteCalls(box.calls).length, n + 1, 'its answer now kept');
  });

  test('the tab\'s peer gone from the shelf in a poll (R5): All again', async () => {
    let answer = peersOf();
    const box = prBox({ peers: () => answer });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    const n = tasteCalls(box.calls).length;
    answer = peersOf({ shelf: PR_SHELF.filter((e) => e.endpointId !== KITCHEN) });
    box.runTimers();
    await flush(); await flush();
    assert.equal(box.S.prec.selected, null);
    assert.equal(tasteCalls(box.calls).length, n, 'All\'s answer for the batch');
    assert.equal(drawnRows(box.S.html()).length, 5);
    assert.equal(findDrawn(box.S.html(), { 'data-dp': 'precTab', 'data-v': KITCHEN }), null);
  });

  test('the last tap wins: an answer for an earlier tab is dropped', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const base = prTaste();
    const box = prBox({ taste: (b) => (b.networkPeers && b.networkPeers[0] === KITCHEN ? gate.then(() => base(b)) : base(b)) });
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush();
    assert.match(box.S.html(), /class="dpage dpage-page-peerRecs dpage-busy"/, 'asking: the rows on screen dim');
    box.click({ 'data-dp': 'precTab', 'data-v': BASEMENT });
    await flush(); await flush();
    release();
    await flush(); await flush();
    assert.equal(box.S.prec.selected, BASEMENT);
    assert.ok(box.S.html().includes('Harbor Lights') && !box.S.html().includes('Long Exposure'));
  });
});

describe('Peer Recommendations: New seeds', () => {
  test('a new batch that keeps the tab (networkPeers), pinned to now playing alone', async () => {
    const box = prBox();
    await openPage(box);
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    box.click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    const body = tasteCalls(box.calls).at(-1);
    assert.deepEqual(body.networkPeers, [KITCHEN]);
    assert.deepEqual(body.pin, ['music/Now/Playing.flac']);
    assert.deepEqual(body.limit, { seeds: 12, network: 32 });
    const n = tasteCalls(box.calls).length;
    box.click({ 'data-dp': 'precTab', 'data-v': '' });
    await flush(); await flush();
    assert.equal(tasteCalls(box.calls).length, n + 1, 'All asks again: the last batch\'s answers are gone');
  });

  test('on a random answer the pick is passed over (exclude), as "Another pick" does', async () => {
    const box = prBox({ taste: prTaste(PR_RANDOM), playing: null });
    await openPage(box);
    box.click({ 'data-dp': 'refresh' });
    await flush(); await flush();
    assert.deepEqual(tasteCalls(box.calls).at(-1).exclude, ['r1']);
    box.change({ 'data-dp-change': 'window' }, '90');
    await flush(); await flush();
    assert.equal(tasteCalls(box.calls).at(-1).window, 90, 'the window is a new batch too');
  });
});

describe('Peer Recommendations: the leads', () => {
  test('two columns, column-major in blocks of 16 — 5 → 3 | 2, 12 → 6 | 6, 32 → two blocks of 8 | 8 — and no "Show more"', async () => {
    for (const [n, per] of [[5, ['3']], [12, ['6']], [32, ['8', '8']]]) {
      const box = prBox({ taste: () => prAnswer(n === 5 ? PR_LEADS : manyLeads(n)) });
      await openPage(box);
      const html = box.S.html();
      assert.deepEqual([...html.matchAll(/<div class="dpage-rows dpage-flow" style="--dpage-per:(\d+)">/g)].map((m) => m[1]), per, `${n} leads`);
      assert.match(html, /<div class="dpage-songs dpage-songs-solo prec-songs">/);
      assert.deepEqual(drawnRows(html).map((el) => Number(el.attrs['data-i'])), Array.from({ length: n }, (_, i) => i), 'every lead, in order');
      assert.ok(!html.includes('data-dp="showMore"') && !html.includes('dpage.showMore'));
    }
  });

  test('a row: its open button (tile, title, "Artist · Album"), then the 28 px play icon — escaped', async () => {
    const box = prBox();
    await openPage(box);
    const html = box.S.html();
    const tile = PR_LEADS[0].tile;
    assert.match(html, new RegExp(`<button type="button" class="prec-open" data-dp="precOpen" data-i="0" aria-haspopup="dialog"><span class="dpage-slot" data-tslot="0"><span class="dpage-art prec-tile" style="--h:${tile.hue}" aria-hidden="true">P</span></span><span class="discover-row-info"><span class="discover-row-title">Signal Fires</span><span class="discover-row-sub">Paper Lantern · Night Ferry</span></span></button>`));
    assert.ok(html.includes('Field &amp; Notes') && html.includes('Ada &lt;Merrow&gt; · Cartography'));
    const play = playOf(html, 0);
    assert.equal(play.attrs.class, 'prec-play');
    assert.equal(play.attrs['aria-pressed'], 'false');
    assert.equal(play.attrs['aria-label'], 'peerRecs.a11y.previewSong{"title":"Signal Fires"}');
    assert.equal(PR_LEADS[0].tile.key, PR_LEADS[1].tile.key, 'Night Ferry\'s two leads share a tile');
  });

  test('a row click opens the window (no clip); the play icon toggles the clip (no window)', async () => {
    const box = prBox();
    await openPage(box);
    const { click, opened, clip } = box;
    click({ 'data-dp': 'precOpen', 'data-i': 2 });
    assert.equal(opened.length, 1);
    const { raw, source, opts } = opened[0];
    assert.equal(raw, PR_LEADS[2], 'the route\'s own lead');
    assert.equal(source, 'p2p');
    const { opener, ...rest } = opts;
    assert.deepEqual(rest, { from: 'peerRecs', peer: { endpointId: KITCHEN, label: 'Kitchen Radio', online: true }, tile: PR_LEADS[2].tile });
    assert.equal(opener.getAttribute('data-dp'), 'precOpen', 'the keyboard comes back to the row');
    assert.equal(clip.calls.filter((c) => c[0] !== 'reset').length, 0, 'opening plays nothing');
    click({ 'data-dp': 'precPlay', 'data-i': 1 });
    assert.deepEqual(clip.calls.at(-1), ['toggle', PR_LEADS[1]]);
    assert.equal(opened.length, 1, 'the play icon opens nothing');
  });

  test('the play icon follows its clip in place: busy, playing (pause), paused — the keyboard stays on it', async () => {
    const box = prBox();
    await openPage(box);
    const { S, keyClick, clip, renders, activeAttrs } = box;
    const drawn = renders();
    keyClick({ 'data-dp': 'precPlay', 'data-i': 0 });
    let play = playOf(S.html(), 0);
    assert.equal(play.attrs.class, 'prec-play is-live is-busy');
    assert.equal(play.attrs['aria-pressed'], 'true');
    assert.equal(play.attrs['aria-label'], 'peerRecs.a11y.pauseSong{"title":"Signal Fires"}');
    clip.play(PREVIEW);
    play = playOf(S.html(), 0);
    assert.equal(play.attrs.class, 'prec-play is-live');
    assert.match(S.html(), /data-cslot="0"><button[^>]*><svg[^>]*><path fill="currentColor" d="M7 5h3.5v14H7zM13\.5 5H17v14h-3\.5z"\/><\/svg><\/button>/, 'the pause glyph');
    keyClick({ 'data-dp': 'precPlay', 'data-i': 0 });
    play = playOf(S.html(), 0);
    assert.equal(play.attrs.class, 'prec-play is-live', 'paused: still its row\'s clip');
    assert.equal(play.attrs['aria-pressed'], 'false');
    assert.equal(renders(), drawn, 'no page draw');
    assert.equal(activeAttrs()['data-dp'], 'precPlay');
    assert.equal(playOf(S.html(), 1).attrs.class, 'prec-play', 'the other rows stay idle');
  });

  test('no preview this visit: muted and inert, said once; no preview plug-in: no play icon and no Preview all', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, clip, toasts } = box;
    click({ 'data-dp': 'precPlay', 'data-i': 3 });
    clip.none();
    const play = playOf(S.html(), 3);
    assert.equal(play.attrs.class, 'prec-play is-none');
    assert.equal(play.attrs['aria-disabled'], 'true');
    assert.equal(play.attrs.title, 'peerRecs.noPreview');
    assert.equal(toasts.filter((o) => o.title === 'peerRecs.noPreview').length, 1);
    const n = clip.calls.length;
    click({ 'data-dp': 'precPlay', 'data-i': 3 });
    assert.equal(clip.calls.length, n, 'a muted icon does nothing');
    const none = prBox({ plugins: { available: false, list: [], jobsAllowed: false } });
    await openPage(none);
    assert.ok(!none.S.html().includes('data-dp="precPlay"'));
    assert.ok(!none.S.html().includes('data-dp="precAll"'));
    assert.ok(none.S.html().includes('data-dp="precCopy"'), 'Copy list stays');
  });

  test('earned art: every drawn row with the tile key, in place, without the referrer; never a non-https URL', async () => {
    const box = prBox();
    await openPage(box);
    const { S, clip } = box;
    clip.earn(PR_LEADS[0].tile.key, 'https://cdn/nf.jpg');
    const html = S.html();
    for (const i of [0, 1]) {
      assert.match(html, new RegExp(`data-tslot="${i}"><span class="dpage-art"><img loading="lazy" src="https:&#x2F;&#x2F;cdn&#x2F;nf.jpg" alt="" referrerpolicy="no-referrer" onerror="discoveryPeerArtFailed\\(this\\)"><\\/span>`), `Night Ferry row ${i}`);
    }
    assert.match(html, /data-tslot="2"><span class="dpage-art prec-tile"/, 'another album keeps its tile');
    clip.earn(PR_LEADS[2].tile.key, 'http://cdn/plain.jpg');
    assert.match(S.html(), /data-tslot="2"><span class="dpage-art prec-tile"/);
  });
});

describe('Peer Recommendations: Preview all', () => {
  test('one lead after another, past "No preview"; one look ahead at 20 s; the band goes at the end', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, clip, els } = box;
    click({ 'data-dp': 'precAll' });
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[0]]);
    assert.equal(findDrawn(S.html(), { 'data-dp': 'precAll' }).attrs['aria-pressed'], 'true');
    clip.play(PREVIEW);
    clip.time(12);
    clip.time(21);
    clip.time(25);
    assert.deepEqual(clip.calls.filter((c) => c[0] === 'prefetch'), [['prefetch', PR_LEADS[1]]], 'once, the next lead');
    clip.end();
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[1]], 'the next one, inside the clip\'s own event');
    clip.none();
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[2]], 'no preview: skipped');
    clip.play(PREVIEW);
    clip.end();
    clip.play(PREVIEW);
    clip.end();
    clip.play(PREVIEW);
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[4]]);
    clip.end();
    assert.equal(clip.calls.filter((c) => c[0] === 'start').length, 5, 'the end of the list');
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.equal(S.band(), '');
    assert.equal(findDrawn(S.html(), { 'data-dp': 'precAll' }).attrs['aria-pressed'], 'false');
    // pressed again: from the top
    click({ 'data-dp': 'precAll' });
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[0]]);
  });

  test('it starts past a lead with no preview this visit', async () => {
    const box = prBox();
    await openPage(box);
    box.click({ 'data-dp': 'precPlay', 'data-i': 0 });
    box.clip.none();
    box.click({ 'data-dp': 'precAll' });
    assert.deepEqual(box.clip.calls.at(-1), ['start', PR_LEADS[1]]);
  });

  test('a failed clip ends the chain (no run into the limiter); a second press stops', async () => {
    const box = prBox();
    await openPage(box);
    const { click, clip, els, toasts } = box;
    click({ 'data-dp': 'precAll' });
    clip.fail();
    assert.equal(clip.calls.filter((c) => c[0] === 'start').length, 1, 'no next');
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.equal(toasts.length, 0, 'Preview all says nothing');
    click({ 'data-dp': 'precAll' });
    clip.play(PREVIEW);
    click({ 'data-dp': 'precAll' });
    assert.deepEqual(clip.calls.at(-1), ['stop', 'user']);
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
  });

  test('a new answer while it runs: the clip plays out, then the sequence ends', async () => {
    const box = prBox();
    await openPage(box);
    const { click, clip } = box;
    click({ 'data-dp': 'precAll' });
    clip.play(PREVIEW);
    click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    clip.end();
    assert.equal(clip.calls.filter((c) => c[0] === 'start').length, 1);
  });
});

describe('Peer Recommendations: the band', () => {
  test('hidden until a clip; then its title and artist, the attribution only once resolved (linked to https), the line on time ticks', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, clip, els, writes } = box;
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    assert.ok(!els.get('dpage-band').classList.contains('super-hide'));
    let band = S.band();
    assert.match(band, /^<div class="prec-band" role="region" aria-label="peerRecs\.preview">/);
    assert.match(band, /<div class="prec-band-title">Signal Fires<\/div><div class="prec-band-sub"><span class="prec-band-artist">Paper Lantern<\/span><\/div>/, 'no attribution before the resolve');
    assert.equal(findDrawn(band, { 'data-dp': 'bandToggle' }).attrs.class, 'prec-band-toggle is-busy');
    assert.match(band, new RegExp(`<span class="dpage-art prec-band-art prec-tile" style="--h:${PR_LEADS[0].tile.hue}" aria-hidden="true">P</span>`));
    clip.play(PREVIEW);
    band = S.band();
    assert.match(band, /<span class="prec-band-artist">Paper Lantern<\/span><span aria-hidden="true">·<\/span><a class="prec-band-credit" href="https:&#x2F;&#x2F;www.deezer.com&#x2F;track&#x2F;1" target="_blank" rel="noopener noreferrer">Preview from Deezer<\/a>/);
    const toggle = findDrawn(band, { 'data-dp': 'bandToggle' });
    assert.equal(toggle.attrs['aria-pressed'], 'true');
    assert.equal(toggle.attrs['aria-label'], 'peerRecs.a11y.pause');
    clip.time(12);
    assert.match(S.band(), /<div class="prec-band-prog" role="progressbar" aria-label="peerRecs\.a11y\.position" aria-valuemin="0" aria-valuemax="30" aria-valuenow="12"><i style="transform:scaleX\(0\.4\)"><\/i><\/div>/);
    assert.deepEqual(lastWrite(writes, '[data-band-prog]').root, 'dpage-band', 'the line alone, in place');
    clip.play({ ...PREVIEW, link: 'http://www.deezer.com/track/1' });
    assert.match(S.band(), /<span class="prec-band-credit">Preview from Deezer<\/span>/, 'no https: plain text');
    assert.ok(!/<a [^>]*prec-band-credit/.test(S.band()));
  });

  test('⏸ toggles the clip, ⏭ starts the next lead, ✕ stops it and the band goes; the main player starting ends it too', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, bandClick, clip, els } = box;
    click({ 'data-dp': 'precPlay', 'data-i': 1 });
    clip.play(PREVIEW);
    bandClick({ 'data-dp': 'bandToggle' });
    assert.deepEqual(clip.calls.at(-1), ['toggle', PR_LEADS[1]]);
    assert.equal(findDrawn(S.band(), { 'data-dp': 'bandToggle' }).attrs['aria-label'], 'peerRecs.a11y.play', 'paused');
    bandClick({ 'data-dp': 'bandNext' });
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[2]]);
    clip.play(PREVIEW);
    bandClick({ 'data-dp': 'bandClose' });
    assert.deepEqual(clip.calls.at(-1), ['stop', 'user']);
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.equal(S.band(), '');
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.play(PREVIEW);
    clip.main();
    assert.ok(els.get('dpage-band').classList.contains('super-hide'), 'the user started the main player');
    assert.equal(playOf(S.html(), 0).attrs.class, 'prec-play');
  });

  test('the clip\'s list follows the clip: its lead pressed again once it ended or failed; a clip the window started (⏭ goes on from it, its no-preview is the window\'s to say)', async () => {
    const box = prBox();
    await openPage(box);
    const { click, bandClick, clip, toasts, vpc } = box;
    const said = () => toasts.filter((o) => o.title === 'peerRecs.noPreview').length;
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.fail();
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.fail();
    assert.equal(said(), 2, 'a failed press, then the same lead again: said both times');
    click({ 'data-dp': 'precPlay', 'data-i': 1 });
    clip.play(PREVIEW);
    clip.end();
    click({ 'data-dp': 'precPlay', 'data-i': 1 });
    clip.play(PREVIEW);
    bandClick({ 'data-dp': 'bandNext' });
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[2]], 'played out, then again: ⏭ goes on from it');
    // a row's clip, then the window's Preview on another lead (dmClipToggle)
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.play(PREVIEW);
    vpc.clipToggle(PR_LEADS[2]);
    clip.play(PREVIEW);
    bandClick({ 'data-dp': 'bandNext' });
    assert.deepEqual(clip.calls.at(-1), ['start', PR_LEADS[3]], 'the lead after the window\'s');
    clip.play(PREVIEW);
    vpc.clipToggle(PR_LEADS[4]);
    clip.fail();
    assert.equal(said(), 2, 'the window says it');
    // Preview all, then the window's Preview: the chain ends with the window's clip
    click({ 'data-dp': 'precAll' });
    clip.play(PREVIEW);
    vpc.clipToggle(PR_LEADS[3]);
    clip.play(PREVIEW);
    const starts = clip.calls.filter((c) => c[0] === 'start').length;
    clip.end();
    assert.equal(clip.calls.filter((c) => c[0] === 'start').length, starts, 'no next');
    assert.equal(findDrawn(box.S.html(), { 'data-dp': 'precAll' }).attrs['aria-pressed'], 'false');
  });

  test('Get it… only with the gate — an acquire plug-in (not the connected servers\' copy), jobs allowed, a destination — and it opens the window', async () => {
    const cases = [
      [{ plugins: GET_IT, destination: 'copies' }, true],
      [{ plugins: GET_IT, destination: null }, false],
      [{ plugins: { ...GET_IT, jobsAllowed: false }, destination: 'copies' }, false],
      [{ plugins: { ...GET_IT, list: [DEEZER, { name: 'federation-copy', capabilities: ['acquire'] }] }, destination: 'copies' }, false],
    ];
    for (const [extra, shown] of cases) {
      const box = prBox(extra);
      await openPage(box);
      box.click({ 'data-dp': 'precPlay', 'data-i': 0 });
      box.clip.play(PREVIEW);
      assert.equal(!!findDrawn(box.S.band(), { 'data-dp': 'bandGetIt' }), shown, JSON.stringify(extra));
      if (!shown) { continue; }
      box.bandClick({ 'data-dp': 'bandGetIt' });
      const { raw, source, opts } = box.opened.at(-1);
      assert.equal(raw, PR_LEADS[0]);
      assert.equal(source, 'p2p');
      assert.equal(opts.from, 'peerRecs');
      assert.deepEqual(opts.peer, { endpointId: KITCHEN, label: 'Kitchen Radio', online: true });
      assert.equal(opts.opener.getAttribute('data-dp'), 'bandGetIt');
    }
  });

  test('the gate is read again when the window says it moved', async () => {
    let dest = null;
    const box = prBox({ plugins: GET_IT });
    box.api.discoveryDestination = () => Promise.resolve({ destination: dest });
    await openPage(box);
    box.click({ 'data-dp': 'precPlay', 'data-i': 0 });
    box.clip.play(PREVIEW);
    assert.equal(findDrawn(box.S.band(), { 'data-dp': 'bandGetIt' }), null);
    dest = 'copies';
    for (const fn of box.gateWatchers.slice()) { fn(); }
    await flush(); await flush();
    assert.ok(findDrawn(box.S.band(), { 'data-dp': 'bandGetIt' }));
  });
});

describe('Peer Recommendations: Add', () => {
  const STATES = (states) => () => peersOf({ canAdd: true, states });
  const addBox = (add, extra = {}) => prBox({ admin: true, peers: STATES({}), add, ...extra });
  const item = (html, id) => findDrawn(html, { 'data-dp': 'precAdd', 'data-v': id });

  test('a "+" press: Adding… at once (inert), POST {endpointId}, the poll at 3 s', async () => {
    let answerAdd;
    const pending = new Promise((r) => { answerAdd = r; });
    const box = addBox(() => pending);
    await openPage(box);
    box.click({ 'data-dp': 'precAdd', 'data-v': LIGHTHOUSE });
    assert.deepEqual(box.calls.filter((c) => c.name === 'add').map((c) => c.endpointId), [LIGHTHOUSE]);
    assert.equal(item(box.S.html(), LIGHTHOUSE).attrs.class, 'prec-peer prec-add prec-adding');
    assert.equal(item(box.S.html(), LIGHTHOUSE).attrs['aria-disabled'], 'true');
    assert.equal(box.liveTimers().at(-1).ms, 3000);
    box.click({ 'data-dp': 'precAdd', 'data-v': LIGHTHOUSE });
    assert.equal(box.calls.filter((c) => c.name === 'add').length, 1, 'an inert item POSTs nothing');
    answerAdd({ status: 202, body: { endpointId: LIGHTHOUSE, state: 'adding', code: null } });
    await flush(); await flush();
    assert.equal(item(box.S.html(), LIGHTHOUSE).attrs.class, 'prec-peer prec-add prec-adding');
    assert.equal(box.liveTimers().at(-1).ms, 3000, 'still out: 3 s');
  });

  test('every answer, by its code (never its words)', async () => {
    const cases = [
      [{ status: 202, body: { state: 'adding' } }, 'prec-peer prec-add prec-adding', 3000],
      [{ status: 200, body: { state: 'done' } }, 'prec-peer prec-add prec-adding', 0],
      [{ status: 200, body: { state: 'failed', code: 'no-room' } }, 'prec-peer prec-add prec-noroom', 15000],
      [{ status: 200, body: { state: 'failed', code: 'offline' } }, 'prec-peer prec-add prec-failed', 15000],
      [{ status: 200, body: { state: 'failed', code: 'bad-snapshot', error: 'words <b>' } }, 'prec-peer prec-add prec-failed', 15000],
      [{ status: 404, body: { error: 'not-in-catalog' } }, 'prec-peer prec-add', 0],
      [{ status: 409, body: { error: 'blocked' } }, 'prec-peer prec-add', 0],
      [{ status: 403, body: null }, 'prec-peer prec-add', 0],
      [{ status: 405, body: null }, 'prec-peer prec-add', 0],
      [{ status: 400, body: { error: 'bad id' } }, 'prec-peer prec-add prec-failed', 15000],
      [{ status: 500, body: null }, 'prec-peer prec-add prec-failed', 15000],
      [{ status: 0, body: null }, 'prec-peer prec-add prec-failed', 15000],
    ];
    for (const [res, cls, next] of cases) {
      const box = addBox(() => res);
      await openPage(box);
      box.click({ 'data-dp': 'precAdd', 'data-v': LIGHTHOUSE });
      await flush(); await flush();
      const label = JSON.stringify(res);
      assert.equal(item(box.S.html(), LIGHTHOUSE).attrs.class, cls, label);
      assert.equal(box.liveTimers().at(-1).ms, next, `${label}: the next poll`);
      assert.ok(!box.S.html().includes('words') && !box.S.html().includes('not-in-catalog') && !box.S.html().includes('bad id'), `${label}: no server words`);
    }
  });

  test('an Add of this page\'s lands: the tab asks again on the batch — after the clip, when one plays', async () => {
    let states = {};
    let shelf = PR_SHELF;
    const box = prBox({ admin: true, peers: () => peersOf({ canAdd: true, states, shelf }), add: () => ({ status: 202, body: { state: 'adding' } }) });
    await openPage(box);
    const { click, clip, calls, runTimers } = box;
    click({ 'data-dp': 'precAdd', 'data-v': LIGHTHOUSE });
    await flush(); await flush();
    states = { [LIGHTHOUSE]: { state: 'adding', code: null, at: PR_NOW } };
    runTimers();
    await flush(); await flush();
    const n = tasteCalls(calls).length;
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.play(PREVIEW);
    // it lands while the clip plays
    states = {};
    shelf = [...PR_SHELF, prHeld(LIGHTHOUSE, 'Lighthouse Tapes')];
    runTimers();
    await flush(); await flush();
    assert.ok(findDrawn(box.S.html(), { 'data-dp': 'precTab', 'data-v': LIGHTHOUSE }), 'on the shelf now');
    assert.equal(tasteCalls(calls).length, n, 'held while the clip plays');
    assert.equal(box.liveTimers().at(-1).ms, 15000, 'back to 15 s');
    clip.end();
    await flush(); await flush();
    const asked = tasteCalls(calls);
    assert.equal(asked.length, n + 1, 'asked once the clip ended');
    assert.deepEqual(asked.at(-1).pin, SEEDS.map((s) => s.filepath), 'on the batch');
  });

  test('a peer someone else added only moves the strip; the shelf filling under "No peers yet" asks again', async () => {
    let shelf = PR_SHELF;
    const box = prBox({ peers: () => peersOf({ shelf }) });
    await openPage(box);
    const n = tasteCalls(box.calls).length;
    shelf = [...PR_SHELF, prHeld(LIGHTHOUSE, 'Lighthouse Tapes')];
    box.runTimers();
    await flush(); await flush();
    assert.ok(findDrawn(box.S.html(), { 'data-dp': 'precTab', 'data-v': LIGHTHOUSE }));
    assert.equal(tasteCalls(box.calls).length, n, 'rotation and other clients: the list stays');
    // an empty shelf: "No peers yet" — then a peer lands
    shelf = [];
    const empty = prBox({ peers: () => peersOf({ shelf }), taste: () => prAnswer([], { network: { results: [], searched: { peers: 0, tracks: 0 }, reason: 'empty-shelf' } }) });
    await openPage(empty);
    assert.ok(empty.S.html().includes('peerRecs.noPeers'));
    const m = tasteCalls(empty.calls).length;
    shelf = [prHeld(KITCHEN, 'Kitchen Radio')];
    empty.runTimers();
    await flush(); await flush();
    assert.equal(tasteCalls(empty.calls).length, m + 1, 'R4: 0 → 1 searchable while "No peers yet" shows');
  });

  test('the shelf emptied under the page (§2 item 18): asked again, "No peers yet" — from All, or from a peer\'s tab', async () => {
    for (const tab of ['', KITCHEN]) {
      let shelf = PR_SHELF;
      const base = prTaste();
      const emptyShelf = prAnswer([], { network: { results: [], searched: { peers: 0, tracks: 0 }, reason: 'empty-shelf' } });
      const box = prBox({ peers: () => peersOf({ shelf }), taste: (b) => (shelf.length ? base(b) : emptyShelf) });
      await openPage(box);
      if (tab) {
        box.click({ 'data-dp': 'precTab', 'data-v': tab });
        await flush(); await flush();
      }
      const n = tasteCalls(box.calls).length;
      shelf = [];
      box.runTimers();
      await flush(); await flush();
      const name = tab ? 'a peer\'s tab' : 'All';
      assert.equal(tasteCalls(box.calls).length, n + 1, `${name}: asked again, never the answer kept for the batch`);
      assert.equal(box.S.prec.selected, null, name);
      assert.ok(box.S.html().includes('peerRecs.noPeers'), `${name}: "No peers yet"`);
      assert.equal(drawnRows(box.S.html()).length, 0, `${name}: no lead from a peer that left`);
    }
  });

  test('the poll beats every 15 s, every 3 s while a row is being added', async () => {
    const box = prBox({ admin: true, peers: () => peersOf({ canAdd: true, states: { [STATIC]: { state: 'adding', code: null, at: PR_NOW } } }) });
    await openPage(box);
    assert.equal(box.liveTimers().at(-1).ms, 3000);
    const calm = prBox();
    await openPage(calm);
    assert.equal(calm.liveTimers().at(-1).ms, 15000);
    assert.equal(calm.liveTimers().length, 1, 'one timer');
  });
});

describe('Peer Recommendations: Copy list', () => {
  test('the tab\'s leads, "Artist - Title" a line, no trailing newline; "Copied"', async () => {
    const box = prBox();
    await openPage(box);
    box.click({ 'data-dp': 'precCopy' });
    await flush();
    assert.deepEqual(box.copied, ['Paper Lantern - Signal Fires\nPaper Lantern - Harbor Lights\nMarlowe Fields - Long Exposure\nJuniper Static - Arcade Rain\nAda <Merrow> - Field & Notes']);
    assert.deepEqual(box.toasts.at(-1), { title: 'peerRecs.copied', position: 'topCenter', timeout: 1800 });
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    box.click({ 'data-dp': 'precCopy' });
    await flush();
    assert.equal(box.copied.at(-1), 'Paper Lantern - Signal Fires\nMarlowe Fields - Long Exposure');
  });

  test('no clipboard: the list in a toast, escaped, to copy by hand', async () => {
    const box = prBox({ clipboard: false });
    await openPage(box);
    box.click({ 'data-dp': 'precCopy' });
    await flush(); await flush();
    assert.equal(box.toasts.at(-1).info, true);
    assert.ok(box.toasts.at(-1).title.includes('Ada &lt;Merrow&gt; - Field &amp; Notes'));
  });
});

describe('Peer Recommendations: states', () => {
  const reasonOf = (reason, over = {}) => () => prAnswer([], { network: { results: [], searched: { peers: 0, tracks: 0 }, reason }, ...over });
  // the page after its strip
  const only = (html) => { const at = locateIn(html, '[data-prec-strip]'); return html.slice(html.indexOf('</div>', at.innerEnd) + 6); };

  test('loading: two columns of eight skeleton rows; an ask with rows on screen dims them', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const box = prBox({ taste: () => gate.then(() => prAnswer()) });
    const run = box.S.peerRecsPanel();
    await flush();
    const html = box.S.html();
    assert.match(html, PAGE_BUSY);
    assert.match(html, /<div class="dpage-songs dpage-songs-solo prec-songs" aria-busy="true"><div class="dpage-rows dpage-flow" style="--dpage-per:8">/);
    assert.equal((html.match(/class="dpage-skel-row"/g) || []).length, 16);
    assert.ok(!html.includes('data-dp="precAll"'), 'no acts line yet');
    release();
    await run;
  });

  test('"No peers yet": empty-shelf, no-compatible, or a shelf with none searchable — the line alone', async () => {
    for (const [taste, peers] of [[reasonOf('empty-shelf'), () => peersOf({ shelf: [] })], [reasonOf('no-compatible'), () => peersOf()],
      [reasonOf('nothing-new'), () => ({ ...peersOf(), shelf: { held: 1, searchable: 0, running: true } })]]) {
      const box = prBox({ taste, peers });
      await openPage(box);
      const html = box.S.html();
      assert.ok(html.includes('<div class="dpage-hint">peerRecs.noPeers</div>'));
      for (const gone of ['data-dp="precAll"', 'data-dp="precCopy"', 'data-dp="precOpen"', 'peerRecs.nothingNew']) { assert.ok(!html.includes(gone), gone); }
    }
  });

  test('"Nothing new" with New seeds; scan pending: Discover\'s card; an error or a failed call: "Try again" alone', async () => {
    const nothing = prBox({ taste: reasonOf('nothing-new') });
    await openPage(nothing);
    assert.match(nothing.S.html(), /<div class="dpage-hint">peerRecs\.nothingNew <button type="button" class="dpage-vb dpage-hint-btn" data-dp="refresh">dpage\.verb\.newSeeds<\/button><\/div>/);
    const scan = prBox({ taste: reasonOf('scan-pending', { notAnalyzed: true }) });
    await openPage(scan);
    assert.ok(scan.S.html().includes('dpage.state.scanPending') && scan.S.html().includes('data-dp="retry"'));
    for (const taste of [reasonOf('error'), () => null]) {
      const box = prBox({ taste });
      await openPage(box);
      const body = only(box.S.html());
      assert.equal(body, '<div class="prec-retry"><button type="button" class="dpage-btn" data-dp="retry">dpage.verb.tryAgain</button></div></div>', 'the button alone');
    }
  });

  test('Try again asks on the batch (a tab\'s failed ask), else a new batch', async () => {
    let fail = false;
    const base = prTaste();
    const box = prBox({ taste: (b) => (fail ? null : base(b)) });
    await openPage(box);
    fail = true;
    box.click({ 'data-dp': 'precTab', 'data-v': KITCHEN });
    await flush(); await flush();
    fail = false;
    box.click({ 'data-dp': 'retry' });
    await flush(); await flush();
    const body = tasteCalls(box.calls).at(-1);
    assert.deepEqual(body.networkPeers, [KITCHEN]);
    assert.deepEqual(body.pin, SEEDS.map((s) => s.filepath));
    assert.ok(box.S.html().includes('Long Exposure'));
  });

  test('switched off (R7) — a taste 403, no network on a history answer, a peers 403: one re-ping, the nav row hidden, the file explorer', async () => {
    const off = { discovery: true, discoveryTaste: 2, discoveryP2p: false, discoveryP2pPeers: 1 };
    const refusal = Object.assign(new Error('off'), { status: 403 });
    for (const [label, extra] of [
      ['taste 403', { taste: () => ({ disabled: true }) }],
      ['network null', { taste: () => ({ ...prAnswer(), network: null }) }],
      ['peers 403', { peers: () => { throw refusal; } }],
    ]) {
      const box = prBox({ ping: off, ...extra });
      box.els.get('nav-peer-recs').classList.remove('super-hide');
      await openPage(box);
      await flush();
      assert.equal(box.calls.filter((c) => c.name === 'ping').length, 1, `${label}: one re-ping`);
      assert.ok(box.els.get('nav-peer-recs').classList.contains('super-hide'), `${label}: the nav row goes`);
      assert.equal(box.views.at(-1), box.explorer, `${label}: the file explorer`);
      assert.ok(!box.S.html().includes('dpage.state.off'), `${label}: no off card`);
    }
  });

  test('still on after the re-ping: a refused answer is "Try again"; a refused poll leaves the page as it is', async () => {
    const on = { discovery: true, discoveryTaste: 2, discoveryP2p: true, discoveryP2pPeers: 1 };
    const box = prBox({ ping: on, taste: () => ({ disabled: true }) });
    await openPage(box);
    await flush();
    assert.ok(!box.els.get('nav-peer-recs').classList.contains('super-hide'));
    assert.equal(box.views.length, 0);
    assert.ok(box.S.html().includes('data-dp="retry"'));
    const refusal = Object.assign(new Error('off'), { status: 403 });
    const polled = prBox({ ping: on, peers: () => { throw refusal; } });
    await openPage(polled);
    await flush();
    assert.equal(drawnRows(polled.S.html()).length, 5);
    assert.equal(polled.liveTimers().length, 0, 'the refused poll stops');
  });

  test('hidden: no poll; shown again: one, at once', async () => {
    const box = prBox();
    await openPage(box);
    const n = peersCalls(box.calls);
    box.setVisibility('hidden');
    box.runTimers();
    await flush();
    assert.equal(peersCalls(box.calls), n, 'skipped while hidden');
    assert.equal(box.liveTimers().length, 0);
    box.setVisibility('visible');
    await flush();
    assert.equal(peersCalls(box.calls), n + 1);
    box.setVisibility('visible');
    await flush();
    assert.equal(peersCalls(box.calls), n + 1, 'one, not one per event');
  });
});

describe('Peer Recommendations: leaving it', () => {
  test('another panel stops the poll, the clip and the band; Discover\'s own leaving touches none of it', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, clip, els, docListeners } = box;
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.play(PREVIEW);
    assert.equal(docListeners.length, 1);
    assert.equal(clip.watchers.length, 1);
    S.setState([{ state: 'allAlbums' }]);
    S.setBrowserRootPanel('panel.albums');
    assert.deepEqual(clip.calls.at(-1), ['stop', 'leave']);
    assert.equal(clip.watchers.length, 0, 'unwatched first: the page draws nothing for its own stop');
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.equal(S.band(), '');
    assert.equal(box.liveTimers().length, 0);
    assert.equal(docListeners.length, 0);
    const n = peersCalls(box.calls);
    box.runTimers();
    await flush();
    assert.equal(peersCalls(box.calls), n);
    // Discover: nothing of Peer Recommendations' runs
    const disc = makeSandbox({ taste: answer, flags: PR_FLAGS });
    await disc.S.discoveryPanel();
    disc.S.setBrowserRootPanel('panel.albums');
    assert.equal(disc.clip.calls.length, 0);
    assert.equal(peersCalls(disc.calls), 0);
  });

  test('the phone\'s Now Playing tab hides the column, the band with it: the clip ends, the page stays up (spa.js toggleThing)', async () => {
    const box = prBox();
    await openPage(box);
    const { S, click, clip, els } = box;
    click({ 'data-dp': 'precPlay', 'data-i': 0 });
    clip.play(PREVIEW);
    S.peerRecsCovered();
    assert.deepEqual(clip.calls.at(-1), ['stop', 'leave']);
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.equal(playOf(S.html(), 0).attrs.class, 'prec-play');
    assert.deepEqual(S.state(), [{ state: 'peerRecs' }]);
    assert.equal(clip.watchers.length, 1, 'still watched');
    assert.equal(box.liveTimers().length, 1, 'the poll goes on');
    S.peerRecsCovered();
    assert.ok(els.get('dpage-band').classList.contains('super-hide'), 'nothing live: nothing to end');
    // another panel: nothing of the page's to stop
    S.setState([{ state: 'allAlbums' }]);
    S.setBrowserRootPanel('panel.albums');
    const m = clip.calls.length;
    S.peerRecsCovered();
    assert.equal(clip.calls.length, m);
    const spa = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.js'), 'utf8');
    assert.match(spa, /if \(bool === false\) \{\n\s*document\.getElementById\('browser'\)\.classList\.add\('hide-on-small-only'\);\n(?:\s*\/\/[^\n]*\n)?\s*if \(typeof peerRecsCovered === 'function'\) \{ peerRecsCovered\(\); \}/);
  });

  test('from Peer Recommendations to Discover: the page left, Discover drawn', async () => {
    const box = prBox();
    await openPage(box);
    await box.S.discoveryPanel();
    assert.deepEqual(box.S.state(), [{ state: 'discovery' }]);
    assert.equal(box.title.innerHTML, 'panel.discover');
    assert.deepEqual(box.clip.calls.at(-1), ['stop', 'leave']);
    assert.ok(!box.S.html().includes('data-prec-strip'));
    assert.equal(box.liveTimers().length, 0);
  });

  test('the seed picker comes back to this page, its own nav row lit', async () => {
    const box = prBox();
    await openPage(box);
    box.S.discoveryPick();
    box.vpc.songCapture({ filepath: '/music/P/Picked.flac' });
    assert.equal(box.viewNavs.at(-1), box.els.get('nav-peer-recs'));
    await box.views.at(-1)();
    await flush(); await flush();
    assert.deepEqual(box.S.state(), [{ state: 'peerRecs' }]);
    assert.deepEqual(tasteCalls(box.calls).at(-1).pin, ['music/Now/Playing.flac', 'music/P/Picked.flac']);
  });
});

describe('Peer Recommendations: what it never draws', () => {
  test('no %, no year, no "on {name}", no network copy of the old page, no plug-ins line, no Show more, no job badges', async () => {
    const box = prBox({ flags: { ...PR_FLAGS, discoveryPlugins: true }, plugins: GET_IT, destination: 'copies', lookup: () => ({ results: [] }), admin: true, peers: () => peersOf({ canAdd: true }) });
    await openPage(box);
    const page = box.S.page();
    assertTrimmed(page, 'peerRecs');
    for (const gone of ['2021', 'dpage.network.', 'dpage-plugins', 'data-dp="lead"', 'dpage.showMore', 'dpage-badge', 'data-bslot', 'data-pslot', 'dpage-prog']) {
      assert.ok(!page.includes(gone), gone);
    }
    const songs = page.slice(page.indexOf('<div class="dpage-songs'));
    assert.ok(!songs.includes('Kitchen Radio') && !songs.includes('Basement Hi-Fi'), 'no peer on a row (the window names it)');
    assert.equal(box.calls.filter((c) => c.name === 'lookup').length, 0, 'the page never looks its leads up');
  });
});

describe('Peer Recommendations: wiring', () => {
  const html = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');

  test('index.html: the nav row under Discover in the Music group, local-only, hidden until the ping', () => {
    const nav = html.match(/<div id="nav-peer-recs" class="([^"]*)" onclick="changeView\(peerRecsPanel, this\);" data-panel="peerRecs">/);
    assert.ok(nav, 'the row');
    for (const c of ['local-only', 'side-nav-item', 'super-hide']) { assert.ok(nav[1].split(' ').includes(c), c); }
    const disc = html.indexOf('id="nav-discover"');
    const row = html.indexOf('id="nav-peer-recs"');
    const rated = html.indexOf('data-panel="allRated"');
    assert.ok(disc > 0 && row > disc && rated > row, 'right after Discover');
    assert.ok(html.indexOf('data-i18n="nav.peerRecs"') > row && html.indexOf('data-i18n="nav.peerRecs"') < rated);
  });

  test('index.html: the band\'s host right after #filelist; peer-recs.js before vp.js', () => {
    assert.match(html, /<div id="filelist">\s*<h4[^>]*>[^<]*<\/h4>\s*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div id="dpage-band" class="super-hide"><\/div>/);
    const pr = html.indexOf('<script src="alpha/peer-recs.js"></script>');
    const vp = html.indexOf('<script src="alpha/vp.js"></script>');
    assert.ok(pr > 0 && vp > pr);
  });

  test('m.js: its own top-level panel, never a peer-capable one', () => {
    assert.match(SRC, /\n {2}peerRecs: \(\) => peerRecsPanel\(\),\n/);
    const peerCapable = SRC.slice(SRC.indexOf('const PEER_CAPABLE_STATES'), SRC.indexOf(']);', SRC.indexOf('const PEER_CAPABLE_STATES')));
    assert.ok(!peerCapable.includes('peerRecs'));
    assert.ok(PEER_FNS.length > 20, `${PEER_FNS.length} peerRecs functions sliced`);
  });

  test('spa.css: the board\'s sizes, the band out of the scroller, 44 px taps on touch', () => {
    assert.match(css, /\.prec-circle \{[^}]*width: 64px; height: 64px;/);
    assert.match(css, /\.prec-name \{[^}]*font-size: 12px;/);
    assert.match(css, /\.prec-peer\.is-on \.prec-circle \{ box-shadow: 0 0 0 2px #1e2228, 0 0 0 4px #4fb8a8; \}/);
    assert.match(css, /\.prec-online \{[^}]*background: #4fc27a;/);
    assert.match(css, /\.prec-add \.prec-circle \{[^}]*dashed/);
    assert.match(css, /\.prec-play \{[^}]*width: 28px; height: 28px;[^}]*background: #4fb8a8;/);
    assert.match(css, /\.prec-band \{[^}]*height: 56px;/);
    assert.match(css, /#dpage-band \{ flex-shrink: 0; container-type: inline-size; \}/);
    // under 560 px the attribution takes the second line whole and wraps:
    // never under the buttons, never ellipsized (§2 items 11 and 14)
    const narrow = css.slice(css.indexOf('@container (max-width: 559px) {'));
    assert.ok(css.indexOf('@container (max-width: 559px) {') > css.indexOf('.prec-band-credit { flex: none;'), 'after the band\'s own rules');
    assert.match(narrow, /^@container \(max-width: 559px\) \{\n {2}\.prec-band \{ height: auto; min-height: 56px;[^}]*\}\n {2}\.prec-band-sub \{ white-space: normal;[^}]*\}\n {2}\.prec-band-sub:has\(\.prec-band-credit\) > :not\(\.prec-band-credit\) \{ display: none; \}\n {2}\.prec-band-credit \{ flex: 0 1 auto; min-width: 0; \}\n\}/);
    assert.ok(!/\.prec-band-credit \{[^}]*(?:text-overflow|overflow: hidden)/.test(css), 'the attribution is never cut');
    const touch = css.slice(css.indexOf('@media (pointer: coarse)'));
    assert.match(touch, /\.prec-play::before, \.prec-band-toggle::before \{ content: ''; position: absolute; inset: -8px; \}/, '28 + 2 × 8 = 44');
    assert.match(touch, /\.prec-band-icon \{ width: 44px; height: 44px; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.prec-adding \.prec-circle::after/);
  });
});

// ── W7: turn the network on (docs/peer-recommendations-plan.md §4.1 W7) ──
// With p2p off, an admin whose admin API answers (GET /api's admin object:
// lockAdmin off) gets the nav row, and the page is the form that turns the
// network on. The admin status as src/api/admin.js answers it.
const ON_STATUS = (over = {}) => ({
  enabled: false, binaryFound: true, binaryFetchable: true, running: false, endpointId: null, ticket: null, joined: false, neighbors: 0,
  knownPeers: 0, serverName: 'Kitchen <Radio>', serverDescription: 'Late & "loud"', ...over,
});
const OFF_FLAGS = { ...PR_FLAGS, discoveryP2p: false };
const OFF_PING = { discovery: true, discoveryTaste: 2, discoveryP2p: false, discoveryP2pPeers: 1 };
const ON_PING = { ...OFF_PING, discoveryP2p: true };
const refused = (status, error) => Object.assign(new Error(`HTTP ${status}`), { status, body: error === undefined ? null : { error } });
// an admin, the network off, the re-ping finding it on
const onBox = (extra = {}) => prBox({ flags: OFF_FLAGS, admin: true, adminApi: true, adminStatus: () => ON_STATUS(), ping: ON_PING, ...extra });
const callNames = (calls) => calls.map((c) => c.name);
const fieldOf = (html, key) => findDrawn(html, { 'data-prec-on': key }, 'input');
const turnOnBtn = (html) => findDrawn(html, { 'data-dp': 'precTurnOn' });
// A field typed in (the drawn input's own input event) and Enter in it.
const typeIn = (box, key, value) => {
  box.locate({ 'data-prec-on': key }, 'input', ['filelist']);
  box.dispatch('filelist', 'input', { target: { value, getAttribute: (n) => (n === 'data-prec-on' ? key : null) } });
};
const enterIn = (box, key, extra = {}) => {
  box.locate({ 'data-prec-on': key }, 'input', ['filelist']);
  let prevented = false;
  box.dispatch('filelist', 'keydown', { key: 'Enter', ...extra, preventDefault: () => { prevented = true; }, target: { getAttribute: (n) => (n === 'data-prec-on' ? key : null) } });
  return prevented;
};
const settle = async () => { for (let i = 0; i < 8; i++) { await flush(); } };

describe('W7: the nav row per role while the network is off', () => {
  test('a member: no row; an admin whose admin API answers: the row; a locked admin: no row — read again when GET /api lands', () => {
    const { S, els, api, adminSet } = makeSandbox({ taste: answer });
    const row = () => !els.get('nav-peer-recs').classList.contains('super-hide');
    S.applyDiscoveryPing(OFF_PING);
    assert.equal(row(), false, 'before GET /api: nobody is an admin yet');
    S.applyServerInfo({ user: { admin: true }, admin: { version: '6.30.0' } });
    assert.equal(row(), true, 'an admin, lockAdmin off');
    assert.deepEqual([api.currentServer.admin, api.currentServer.adminApi, adminSet.at(-1)], [true, true, true]);
    S.applyServerInfo({ user: { admin: true } });
    assert.equal(row(), false, 'a locked admin API: user.admin with no admin object');
    assert.deepEqual([api.currentServer.admin, api.currentServer.adminApi], [true, false]);
    S.applyServerInfo({ user: { admin: false }, admin: {} });
    assert.equal(row(), false, 'a member');
    S.applyServerInfo(null);
    assert.equal(row(), false, 'no answer');
    assert.deepEqual([api.currentServer.admin, api.currentServer.adminApi, adminSet.at(-1)], [false, false, false]);
    S.applyDiscoveryPing(ON_PING);
    assert.equal(row(), true, 'the network on: the page, for a member too');
  });

  test('the ping and GET /api in either order; collection off does not hide the admin\'s row (turning on turns it on)', () => {
    const { S, els } = makeSandbox({ taste: answer });
    const row = () => !els.get('nav-peer-recs').classList.contains('super-hide');
    S.applyServerInfo({ user: { admin: true }, admin: {} });
    S.applyDiscoveryPing({ ...OFF_PING, discovery: false });
    assert.equal(row(), true);
    assert.ok(els.get('nav-discover').classList.contains('super-hide'), 'Discover keeps its own gate');
    for (const off of [{ discoveryTaste: 1 }, { discoveryP2pPeers: 0 }, { discoveryP2pPeers: undefined }]) {
      S.applyDiscoveryPing({ ...OFF_PING, ...off });
      assert.equal(row(), false, `an older server: ${JSON.stringify(off)}`);
    }
    S.applyDiscoveryPing({ ...OFF_PING, discoveryTaste: '2', discoveryP2pPeers: '1' });
    assert.equal(row(), true, 'numeric strings count');
  });

  test('init() hands GET /api to applyServerInfo, a failure as null', () => {
    assert.match(SRC, /\n {4}MSTREAMAPI\.serverInfo\(\)\n {6}\.then\(applyServerInfo\)\n {6}\.catch\(\(\) => applyServerInfo\(null\)\);\n/);
  });

  test('init() and the turn-on\'s re-ping set the rest of the app\'s discovery flags in one place (applyDiscoverySurfaces)', () => {
    assert.match(SRC, /\n {4}applyDiscoverySurfaces\(response\);\n/);
    for (const set of ['VUEPLAYERCORE.setDiscoveryAvailable(', 'VUEPLAYERCORE.setDiscoveryP2pAvailable(', 'MSTREAMAPI.currentServer.discovery = ', 'MSTREAMAPI.currentServer.discoveryPath = ']) {
      assert.equal(SRC.split(set).length - 1, 1, `${set} once: applyDiscoverySurfaces's`);
      assert.ok(sliceFn('applyDiscoverySurfaces').includes(set), set);
    }
  });

  test('a member or a locked admin with the network off: the page asks nothing', async () => {
    for (const who of [{ admin: false, adminApi: false }, { admin: true, adminApi: false }]) {
      const box = onBox(who);
      await openPage(box);
      assert.deepEqual(callNames(box.calls), [], JSON.stringify(who));
      assert.ok(!box.S.html().includes('data-prec-on'));
    }
  });
});

describe('W7: opening the page as an admin with the network off', () => {
  test('the form: the shares line, the server\'s name and description (escaped, 64 / 180), Turn on — no bar, strip, poll, clip or band', async () => {
    const box = onBox();
    await openPage(box);
    const { S, calls, els, clip, title } = box;
    assert.deepEqual(callNames(calls), ['adminStatus'], 'the status alone: no taste call, no peers poll, no plug-in read');
    assert.deepEqual(S.state(), [{ state: 'peerRecs' }]);
    assert.equal(title.innerHTML, 'panel.peerRecs');
    const html = S.html();
    assert.match(html, /^<div class="dpage dpage-page-peerRecs prec-on-page"><div class="prec-on"><p class="prec-on-text">peerRecs\.turnOn\.shares<\/p><label class="prec-on-field">/);
    assert.ok(!html.includes('peerRecs.turnOn.collection'), 'collection is on: no collection line');
    const name = fieldOf(html, 'name');
    const desc = fieldOf(html, 'description');
    assert.deepEqual([name.attrs.value, name.attrs.maxlength, name.attrs.type], ['Kitchen <Radio>', '64', 'text']);
    assert.deepEqual([desc.attrs.value, desc.attrs.maxlength], ['Late & "loud"', '180']);
    assert.ok(html.includes('value="Kitchen &lt;Radio&gt;"') && html.includes('value="Late &amp; &quot;loud&quot;"'), 'escaped');
    for (const f of [name, desc]) {
      assert.ok(f.attrs.class.split(' ').includes('browser-default'), 'no materialize field');
      assert.equal('disabled' in f.attrs, false);
    }
    assert.ok(html.indexOf('peerRecs.turnOn.name') < html.indexOf('data-prec-on="name"') && html.indexOf('data-prec-on="name"') < html.indexOf('peerRecs.turnOn.description'));
    const btn = turnOnBtn(html);
    assert.equal('disabled' in btn.attrs, false, 'the prefilled form is valid');
    assert.match(html, /<div class="prec-on-acts" data-prec-on-slot="acts"><button type="button" class="dpage-btn pri prec-on-btn" data-dp="precTurnOn">peerRecs\.turnOn\.button<\/button><\/div><\/div><\/div>$/);
    for (const gone of ['data-prec-strip', 'data-aslot', 'dpage-bar', 'data-dp="refresh"', 'prec-songs', 'peerRecs.turnOn.unavailable', 'prec-on-err', '<h']) {
      assert.ok(!html.includes(gone), gone);
    }
    assert.equal(S.head(), '');
    assert.ok(els.get('dpage-head').classList.contains('super-hide'), 'no bar in the host');
    assert.ok(els.get('dpage-band').classList.contains('super-hide'));
    assert.deepEqual(clip.calls, [], 'no clip reset, nothing watched');
    assert.equal(clip.watchers.length, 0);
    assert.equal(box.liveTimers().length, 0, 'no poll');
    assert.equal(box.docListeners.length, 0);
  });

  test('the collection line only where the ping says collection is off', async () => {
    const box = onBox({ flags: { ...OFF_FLAGS, discovery: false } });
    await openPage(box);
    assert.match(box.S.html(), /<p class="prec-on-text">peerRecs\.turnOn\.shares<\/p><p class="prec-on-text">peerRecs\.turnOn\.collection<\/p><label/);
  });

  test('no sidecar for this platform and none to fetch: the one line; either one: the form', async () => {
    const none = onBox({ adminStatus: () => ON_STATUS({ binaryFound: false, binaryFetchable: false }) });
    await openPage(none);
    assert.equal(none.S.html(), '<div class="dpage dpage-page-peerRecs prec-on-page"><div class="prec-on"><p class="prec-on-text">peerRecs.turnOn.unavailable</p></div></div>');
    for (const over of [{ binaryFound: false, binaryFetchable: true }, { binaryFound: true, binaryFetchable: false }]) {
      const box = onBox({ adminStatus: () => ON_STATUS(over) });
      await openPage(box);
      assert.ok(fieldOf(box.S.html(), 'name'), JSON.stringify(over));
      assert.ok(!box.S.html().includes('peerRecs.turnOn.unavailable'));
    }
  });

  test('refused — 403 (no admin rights from here) or 405 (the admin API locked): the row goes, and so does the page', async () => {
    for (const status of [403, 405]) {
      const box = onBox({ adminStatus: () => { throw refused(status, status === 405 ? 'Admin API Disabled' : 'Admin access required'); } });
      box.els.get('nav-peer-recs').classList.remove('super-hide');
      await openPage(box);
      assert.equal(box.api.currentServer.adminApi, false, `${status}`);
      assert.ok(box.els.get('nav-peer-recs').classList.contains('super-hide'), `${status}: the row goes`);
      assert.equal(box.views.at(-1), box.explorer, `${status}: the file explorer`);
      assert.deepEqual(callNames(box.calls), ['adminStatus'], 'no re-ping, nothing else');
      box.S.applyDiscoveryPing(OFF_PING);
      assert.ok(box.els.get('nav-peer-recs').classList.contains('super-hide'), 'a later ping keeps it gone');
    }
  });

  test('already on (turned on meanwhile): one re-ping, then the page — its first ask (R1)', async () => {
    const box = onBox({ adminStatus: () => ON_STATUS({ enabled: true }) });
    await openPage(box);
    await settle();
    const names = callNames(box.calls);
    assert.deepEqual(names.slice(0, 2), ['adminStatus', 'ping']);
    assert.equal(names.filter((n) => n === 'ping').length, 1);
    assert.equal(box.S.view.flags.discoveryP2p, true);
    assert.deepEqual(tasteCalls(box.calls), [{
      sources: ['network'], window: 30, pin: ['music/Now/Playing.flac'], newArtistsOnly: false, ignoreVPaths: [],
      limit: { seeds: 12, network: 32 }, networkOnRandomSeed: true,
    }]);
    assert.equal(peersCalls(box.calls), 1);
    assert.equal(drawnRows(box.S.html()).length, 5);
    assert.equal(box.S.prec.turnOn, null);
  });

  test('already on, but the re-ping does not open the page (no answer): no loop — the file explorer', async () => {
    const box = onBox({ adminStatus: () => ON_STATUS({ enabled: true }), ping: null });
    await openPage(box);
    await settle();
    assert.deepEqual(callNames(box.calls), ['adminStatus', 'ping']);
    assert.equal(box.views.at(-1), box.explorer);
  });

  test('a status that did not come: "Try again" alone, in the one centred block — it asks the status again', async () => {
    let fail = true;
    const box = onBox({ adminStatus: () => { if (fail) { throw refused(500); } return ON_STATUS(); } });
    await openPage(box);
    assert.equal(box.S.html(), '<div class="dpage dpage-page-peerRecs prec-on-page"><div class="prec-on"><button type="button" class="dpage-btn" data-dp="precOnRetry">dpage.verb.tryAgain</button></div></div>');
    fail = false;
    box.click({ 'data-dp': 'precOnRetry' });
    await settle();
    assert.deepEqual(callNames(box.calls), ['adminStatus', 'adminStatus']);
    assert.ok(fieldOf(box.S.html(), 'name'));
  });

  test('while the status is out: an empty block, busy', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const box = onBox({ adminStatus: () => gate.then(() => ON_STATUS()) });
    const run = box.S.peerRecsPanel();
    assert.equal(box.S.html(), '<div class="dpage dpage-page-peerRecs prec-on-page" aria-busy="true"></div>');
    release();
    await run;
    assert.ok(fieldOf(box.S.html(), 'name'));
  });
});

describe('W7: the form', () => {
  test('Turn on is shut while the fields are not what the server takes — written in place, never the whole block', async () => {
    const box = onBox();
    await openPage(box);
    const { S, writes } = box;
    const renders = box.renders();
    const shut = () => 'disabled' in turnOnBtn(S.html()).attrs;
    const steps = [
      ['name', '', true], ['name', '   ', true], ['name', 'x'.repeat(65), true], ['name', 'x'.repeat(64), false],
      ['name', 'a|b', true], ['name', 'Ünïcödé 台所', false], ['description', 'd'.repeat(181), true], ['description', 'd'.repeat(180), false],
      ['description', 'tab\there', true], ['description', '', false],
    ];
    for (const [key, value, closed] of steps) {
      typeIn(box, key, value);
      assert.equal(shut(), closed, `${key} = ${JSON.stringify(value).slice(0, 20)}`);
    }
    assert.equal(box.renders(), renders, 'no whole-block draw while typing');
    assert.ok(writes.length > 0 && writes.every((w) => w.root === 'filelist' && w.path.join() === '[data-prec-on-slot="acts"]'));
    const n = writes.length;
    typeIn(box, 'description', 'still fine');
    assert.equal(writes.length, n, 'Turn on unchanged: nothing written');
    assert.equal(fieldOf(S.html(), 'name').attrs.value, 'Kitchen <Radio>', 'the fields are the browser\'s: never redrawn under the caret');
    typeIn(box, 'name', '');
    box.click({ 'data-dp': 'precTurnOn' });
    assert.equal(enterIn(box, 'name'), true, 'Enter is the form\'s');
    await settle();
    assert.ok(!callNames(box.calls).includes('setEnabled'), 'shut: neither a click nor Enter turns it on');
  });

  test('Turn on: "Turning on…" and the fields shut, POST enabled once — then the name (trimmed) only when changed, a re-ping, and the page\'s first ask', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const box = onBox({ setEnabled: () => gate.then(() => ({ enabled: true })) });
    await openPage(box);
    typeIn(box, 'name', '  Attic Tapes  ');
    box.click({ 'data-dp': 'precTurnOn' });
    await flush();
    const busy = box.S.html();
    const btn = turnOnBtn(busy);
    assert.equal(btn.attrs['aria-disabled'], 'true', 'shut');
    assert.equal('disabled' in btn.attrs, false, 'but focusable: the keyboard stays on it, "Turning on…" read');
    assert.match(busy, /^<div class="dpage dpage-page-peerRecs prec-on-page" aria-busy="true">/);
    assert.ok(busy.includes('>peerRecs.turnOn.busy</button>'));
    assert.ok('disabled' in fieldOf(busy, 'name').attrs && 'disabled' in fieldOf(busy, 'description').attrs, 'the fields shut');
    assert.equal(fieldOf(busy, 'name').attrs.value, '  Attic Tapes  ', 'as typed');
    box.click({ 'data-dp': 'precTurnOn' });
    await flush();
    assert.deepEqual(box.calls.filter((c) => c.name === 'setEnabled'), [{ name: 'setEnabled', enabled: true }], 'once, enabled: true');
    release();
    await settle();
    const names = callNames(box.calls);
    assert.deepEqual(names.slice(0, 4), ['adminStatus', 'setEnabled', 'setName', 'ping'], 'the name, then the re-ping');
    assert.deepEqual(box.calls.find((c) => c.name === 'setName').value, 'Attic Tapes', 'trimmed');
    assert.ok(!names.includes('setDescription'), 'the description was not changed');
    assert.equal(box.S.view.flags.discoveryP2p, true, 'the re-ping\'s flags');
    assert.equal(tasteCalls(box.calls).length, 1, 'the page\'s first ask');
    assert.deepEqual(tasteCalls(box.calls)[0].limit, { seeds: 12, network: 32 });
    assert.equal(peersCalls(box.calls), 1);
    assert.equal(drawnRows(box.S.html()).length, 5, 'the page, in its own mode');
    assert.ok(!box.S.html().includes('data-prec-on'));
    assert.equal(box.S.prec.turnOn, null);
    assert.ok(!box.els.get('nav-peer-recs').classList.contains('super-hide'));
  });

  test('turned on: the rest of the app follows the re-ping — the now-playing Discover and its "From the network", Auto-DJ\'s similarity, Sonic Path\'s row', async () => {
    for (const [label, extra] of [['the form', {}], ['already on', { adminStatus: () => ON_STATUS({ enabled: true }) }]]) {
      // collection off at boot: the enable turns it on (the ping says so)
      const box = onBox({ flags: { ...OFF_FLAGS, discovery: false }, ping: { ...ON_PING, discovery: true, discoveryPath: true }, ...extra });
      Object.assign(box.api.currentServer, { discovery: false, discoveryPath: false });
      await openPage(box);
      if (label === 'the form') { box.click({ 'data-dp': 'precTurnOn' }); }
      await settle();
      assert.deepEqual(box.surfaces, [['p2p', true], ['discovery', true]], `${label}: the network's first — the panel that shows asks for both`);
      assert.deepEqual([box.api.currentServer.discovery, box.api.currentServer.discoveryPath], [true, true], label);
      assert.equal(box.els.get('nav-sonic-path').classList.contains('super-hide'), false, `${label}: Sonic Path's row`);
      assert.equal(tasteCalls(box.calls).length, 1, `${label}: the page`);
    }
  });

  test('refused, or no re-ping answer: the rest of the app stays as it was', async () => {
    for (const [label, extra] of [['refused', { setEnabled: () => { throw refused(500, 'no'); } }], ['no answer', { ping: null }]]) {
      const box = onBox({ flags: { ...OFF_FLAGS, discovery: false }, ...extra });
      Object.assign(box.api.currentServer, { discovery: false, discoveryPath: false });
      await openPage(box);
      box.click({ 'data-dp': 'precTurnOn' });
      await settle();
      assert.deepEqual(box.surfaces, [], label);
      assert.deepEqual([box.api.currentServer.discovery, box.api.currentServer.discoveryPath], [false, false], label);
      assert.ok(box.els.get('nav-sonic-path').classList.contains('super-hide'), label);
    }
  });

  test('only what changed is sent: the description alone, a cleared description, a name only re-spaced', async () => {
    for (const [edits, sent] of [
      [[['description', 'New blurb ']], [['setDescription', 'New blurb']]],
      [[['description', '   ']], [['setDescription', '']]],
      [[['name', ' Kitchen <Radio> ']], []],
      [[['name', 'Attic'], ['description', 'Tapes']], [['setName', 'Attic'], ['setDescription', 'Tapes']]],
    ]) {
      const box = onBox();
      await openPage(box);
      for (const [key, value] of edits) { typeIn(box, key, value); }
      box.click({ 'data-dp': 'precTurnOn' });
      await settle();
      assert.deepEqual(box.calls.filter((c) => c.name === 'setName' || c.name === 'setDescription').map((c) => [c.name, c.value]), sent, JSON.stringify(edits));
      assert.equal(tasteCalls(box.calls).length, 1);
    }
  });

  test('Enter in a field turns it on, as the button does', async () => {
    const box = onBox();
    await openPage(box);
    typeIn(box, 'description', 'Night radio');
    assert.equal(enterIn(box, 'description'), true);
    await settle();
    assert.deepEqual(callNames(box.calls).slice(0, 4), ['adminStatus', 'setEnabled', 'setDescription', 'ping']);
  });

  test('the keyboard while it turns on: on "Turning on…" (from Turn on or from Enter in a field), the block busy — and back on Turn on, not busy, when refused', async () => {
    for (const how of ['button', 'enter']) {
      let refuse;
      const gate = new Promise((_, r) => { refuse = r; });
      const box = onBox({ setEnabled: () => gate });
      await openPage(box);
      if (how === 'button') { box.keyClick({ 'data-dp': 'precTurnOn' }); } else { enterIn(box, 'name'); }
      await flush();
      assert.equal(box.focused.at(-1), 'precTurnOn', `${how}: the keyboard on the busy button`);
      assert.deepEqual(box.activeAttrs() && [box.activeAttrs()['data-dp'], box.activeAttrs()['aria-disabled']], ['precTurnOn', 'true'], how);
      assert.ok(box.S.html().includes('>peerRecs.turnOn.busy</button>'), how);
      assert.ok(box.S.html().includes('aria-busy="true"'), `${how}: busy`);
      refuse(refused(500, 'no'));
      await settle();
      assert.ok(!box.S.html().includes('aria-busy'), `${how}: refused — not busy`);
      assert.deepEqual([box.focused.at(-1), 'aria-disabled' in box.activeAttrs()], ['precTurnOn', false], `${how}: Turn on again`);
    }
  });

  test('the Enter that confirms an IME conversion (ja / ko / zh) is the IME\'s: it turns nothing on', async () => {
    const box = onBox();
    await openPage(box);
    typeIn(box, 'name', '台所');
    // Chrome / Firefox: isComposing; Safari: keyCode 229
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, keyCode: 229 }]) {
      assert.equal(enterIn(box, 'name', extra), false, `${JSON.stringify(extra)}: the browser's`);
      await settle();
      assert.ok(!callNames(box.calls).includes('setEnabled'), JSON.stringify(extra));
      assert.ok(fieldOf(box.S.html(), 'name'), 'the form stays');
    }
    assert.equal(enterIn(box, 'name', { isComposing: false, keyCode: 13 }), true, 'the conversion done: Enter turns it on');
    await settle();
    assert.equal(box.calls.filter((c) => c.name === 'setEnabled').length, 1);
  });

  test('refused: the server\'s words on one line under the button, escaped — the form back as typed, the keyboard on Turn on', async () => {
    const said = 'failed to start the discovery network: <b>sidecar</b> & "co" <img src=x onerror=alert(1)>';
    const box = onBox({ setEnabled: () => { throw refused(500, said); } });
    await openPage(box);
    typeIn(box, 'name', 'Attic');
    box.click({ 'data-dp': 'precTurnOn' });
    await settle();
    const html = box.S.html();
    assert.ok(html.includes('<p class="prec-on-err" role="alert">failed to start the discovery network: &lt;b&gt;sidecar&lt;&#x2F;b&gt; &amp; &quot;co&quot; &lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;</p>'));
    assert.ok(!html.includes('<b>') && !html.includes('<img'), 'markup in the error stays text');
    assert.equal(tagsOf(html).filter((el) => el.attrs.class === 'prec-on-err').length, 1, 'one line');
    assert.ok(html.indexOf('data-dp="precTurnOn"') < html.indexOf('prec-on-err'), 'under the button');
    const btn = turnOnBtn(html);
    assert.equal('disabled' in btn.attrs, false);
    assert.ok(html.includes('>peerRecs.turnOn.button</button>'));
    assert.equal(fieldOf(html, 'name').attrs.value, 'Attic', 'as typed');
    assert.equal('disabled' in fieldOf(html, 'name').attrs, false);
    assert.equal(box.focused.at(-1), 'precTurnOn');
    assert.deepEqual(callNames(box.calls), ['adminStatus', 'setEnabled'], 'no name, no re-ping, no page');
    // the line stays while typing; the next press clears it
    typeIn(box, 'name', 'Attic Tapes');
    assert.ok(box.S.html().includes('prec-on-err'));
    box.click({ 'data-dp': 'precTurnOn' });
    assert.ok(!box.S.html().includes('prec-on-err'), 'the next press clears it');
    assert.ok(box.S.html().includes('>peerRecs.turnOn.busy</button>'));
    await settle();
    assert.ok(box.S.html().includes('prec-on-err'), 'refused again');
    assert.equal(box.calls.filter((c) => c.name === 'setEnabled').length, 2);
  });

  test('the server\'s words are drawn once: Turn on shut and opened again while typing never writes the alert again (a screen reader would read it each time)', async () => {
    const box = onBox({ setEnabled: () => { throw refused(500, 'failed to start the discovery network: no'); } });
    await openPage(box);
    box.click({ 'data-dp': 'precTurnOn' });
    await settle();
    const n = box.writes.length;
    for (const value of ['', 'Attic', '', 'Attic Tapes']) { typeIn(box, 'name', value); }
    const flips = box.writes.slice(n);
    assert.equal(flips.length, 4, 'Turn on shut, opened, shut, opened — each written in place');
    assert.ok(flips.every((w) => !w.html.includes('prec-on-err') && !w.html.includes('role="alert"')), 'the alert is not in what a flip writes');
    const html = box.S.html();
    assert.equal(countDrawn(html, { class: 'prec-on-err', role: 'alert' }), 1, 'the line stays, once');
    assert.ok(html.indexOf('data-dp="precTurnOn"') < html.indexOf('prec-on-err'), 'under the button');
  });

  test('a 503 (no sidecar to fetch) says the server\'s words too; no words at all: "Try again"', async () => {
    const no = onBox({ setEnabled: () => { throw refused(503, 'the p2p-sidecar binary is missing for this platform'); } });
    await openPage(no);
    no.click({ 'data-dp': 'precTurnOn' });
    await settle();
    assert.ok(no.S.html().includes('<p class="prec-on-err" role="alert">the p2p-sidecar binary is missing for this platform</p>'));
    for (const err of [refused(0), refused(502), refused(500, '   '), new TypeError('Failed to fetch')]) {
      const box = onBox({ setEnabled: () => { throw err; } });
      await openPage(box);
      box.click({ 'data-dp': 'precTurnOn' });
      await settle();
      assert.ok(box.S.html().includes('<p class="prec-on-err" role="alert">peerRecs.tryAgain</p>'), String(err.message));
    }
  });

  test('the name or the description not saved: a warning each, escaped — the network stays on and the page opens', async () => {
    const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8'));
    const tr = (k, p) => (k.startsWith('peerRecs.turnOn.') && typeof EN[k] === 'string' ? EN[k] : tStub(k, p));
    const box = onBox({ tr, setName: () => { throw refused(400, 'name: <bad>'); }, setDescription: () => Promise.reject(refused(500)) });
    await openPage(box);
    typeIn(box, 'name', 'Attic');
    typeIn(box, 'description', 'Tapes');
    box.click({ 'data-dp': 'precTurnOn' });
    await settle();
    const esc = (s) => s.replace(/'/g, '&#39;');
    assert.deepEqual(box.toasts.map((x) => x.title), [esc(EN['peerRecs.turnOn.nameNotSaved']), esc(EN['peerRecs.turnOn.descriptionNotSaved'])]);
    assert.ok(box.toasts.every((x) => !x.error && !x.info), 'warnings');
    assert.ok(box.toasts.every((x) => !JSON.stringify(x).includes('<bad>')), 'the server\'s words are not toasted');
    assert.equal(tasteCalls(box.calls).length, 1, 'the page opens');
  });

  test('leaving while it turns on: the answer draws nothing — what was sent is still saved, the flags still read', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const box = onBox({ setEnabled: () => gate.then(() => ({ enabled: true })) });
    await openPage(box);
    typeIn(box, 'name', 'Attic');
    box.click({ 'data-dp': 'precTurnOn' });
    await flush();
    box.S.setState([{ state: 'allAlbums' }]);
    box.S.setBrowserRootPanel('panel.albums');
    box.els.get('filelist').innerHTML = 'ALBUMS';
    const renders = box.renders();
    const views = box.views.length;
    release();
    await settle();
    assert.equal(box.S.html(), 'ALBUMS');
    assert.equal(box.renders(), renders, 'nothing drawn over the albums');
    assert.equal(box.views.length, views, 'no panel change');
    assert.equal(tasteCalls(box.calls).length, 0);
    assert.deepEqual(callNames(box.calls), ['adminStatus', 'setEnabled', 'setName', 'ping'], 'the name saved, the flags read');
    assert.ok(!box.els.get('nav-peer-recs').classList.contains('super-hide'));
  });

  test('leaving while it is refused, or while the status is out: nothing drawn', async () => {
    let refuse;
    const gate = new Promise((_, r) => { refuse = r; });
    const box = onBox({ setEnabled: () => gate });
    await openPage(box);
    box.click({ 'data-dp': 'precTurnOn' });
    await flush();
    box.S.setState([{ state: 'allAlbums' }]);
    box.S.setBrowserRootPanel('panel.albums');
    box.els.get('filelist').innerHTML = 'ALBUMS';
    refuse(refused(500, 'no'));
    await settle();
    assert.equal(box.S.html(), 'ALBUMS');
    for (const [label, answer] of [['the form', () => ON_STATUS()], ['a 405', () => { throw refused(405); }], ['already on', () => ON_STATUS({ enabled: true })]]) {
      let release;
      const slow = new Promise((r) => { release = r; });
      const left = onBox({ adminStatus: () => slow.then(answer) });
      left.els.get('nav-peer-recs').classList.remove('super-hide');
      const run = left.S.peerRecsPanel();
      left.S.setState([{ state: 'allAlbums' }]);
      left.S.setBrowserRootPanel('panel.albums');
      left.els.get('filelist').innerHTML = 'ALBUMS';
      release();
      await run;
      await settle();
      assert.equal(left.S.html(), 'ALBUMS', label);
      assert.equal(left.views.length, 0, label);
      assert.deepEqual(callNames(left.calls), ['adminStatus'], `${label}: nothing more asked`);
      // a refusal is the account's, whatever is up: no row
      assert.equal(left.els.get('nav-peer-recs').classList.contains('super-hide'), label === 'a 405', label);
    }
  });
});

describe('W7: switched off (R7) with the page up', () => {
  const refusal = Object.assign(new Error('off'), { status: 403 });

  test('an admin who can turn it back on: the form, in place of the page — the poll, the clip and the band end', async () => {
    for (const [label, extra] of [
      ['taste 403', { taste: () => ({ disabled: true }) }],
      ['network null', { taste: () => ({ ...prAnswer(), network: null }) }],
      ['peers 403', { peers: () => { throw refusal; } }],
    ]) {
      const box = prBox({ admin: true, adminApi: true, ping: OFF_PING, adminStatus: () => ON_STATUS(), ...extra });
      await openPage(box);
      await settle();
      assert.equal(box.calls.filter((c) => c.name === 'ping').length, 1, `${label}: one re-ping`);
      assert.equal(box.calls.filter((c) => c.name === 'adminStatus').length, 1, `${label}: the status`);
      assert.ok(!box.els.get('nav-peer-recs').classList.contains('super-hide'), `${label}: the row stays`);
      assert.equal(box.views.length, 0, `${label}: the page is not left`);
      const html = box.S.html();
      assert.ok(fieldOf(html, 'name') && turnOnBtn(html), `${label}: the form`);
      assert.ok(!html.includes('data-prec-strip'));
      assert.deepEqual(box.S.state(), [{ state: 'peerRecs' }]);
      assert.equal(box.liveTimers().length, 0, `${label}: no poll`);
      assert.equal(box.clip.watchers.length, 0);
      assert.equal(box.docListeners.length, 0);
      assert.ok(box.els.get('dpage-band').classList.contains('super-hide'));
    }
  });

  test('the page\'s first ask, still out when the poll\'s 403 turned the page into the form, is dropped — refused or answered, it draws nothing and asks nothing', async () => {
    for (const [label, late] of [['refused', { disabled: true }], ['network null', { ...prAnswer(), network: null }], ['answered', prAnswer()]]) {
      let release;
      const gate = new Promise((r) => { release = r; });
      const box = prBox({ admin: true, adminApi: true, ping: OFF_PING, adminStatus: () => ON_STATUS(), taste: () => gate.then(() => late), peers: () => { throw refusal; } });
      const run = box.S.peerRecsPanel();
      await settle();
      assert.equal(tasteCalls(box.calls).length, 1, `${label}: the first ask is out`);
      assert.ok(fieldOf(box.S.html(), 'name'), `${label}: the form, before the ask answers`);
      typeIn(box, 'name', 'Attic');
      const renders = box.renders();
      const asked = callNames(box.calls).length;
      release();
      await run;
      await settle();
      assert.equal(box.renders(), renders, `${label}: nothing drawn over the form`);
      assert.equal(callNames(box.calls).length, asked, `${label}: no second ping, no second status`);
      assert.deepEqual([box.calls.filter((c) => c.name === 'ping').length, box.calls.filter((c) => c.name === 'adminStatus').length], [1, 1], label);
      assert.equal(box.S.prec.turnOn.name, 'Attic', `${label}: as typed`);
      assert.equal(box.S.view.main, undefined, `${label}: the answer is not the page's`);
      assert.ok(turnOnBtn(box.S.html()), label);
    }
  });

  test('a member, or a locked admin API: the row goes and the page is left, as before', async () => {
    for (const who of [{ admin: false, adminApi: false }, { admin: true, adminApi: false }]) {
      const box = prBox({ ...who, ping: OFF_PING, adminStatus: () => ON_STATUS(), taste: () => ({ disabled: true }) });
      box.els.get('nav-peer-recs').classList.remove('super-hide');
      await openPage(box);
      await settle();
      assert.ok(box.els.get('nav-peer-recs').classList.contains('super-hide'), JSON.stringify(who));
      assert.equal(box.views.at(-1), box.explorer);
      assert.ok(!callNames(box.calls).includes('adminStatus'));
    }
  });
});

describe('W7: wiring', () => {
  const css = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
  const API_SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8'));

  // api.js over a stubbed fetch (as webapp-peer-recs-clip.test.mjs does)
  function makeApi(answer) {
    const sent = [];
    const fetch = (url, init) => {
      sent.push({ url, method: init.method, token: init.headers['x-access-token'], body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
      const a = typeof answer === 'function' ? answer(url) : answer;
      return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: () => Promise.resolve(a.body) });
    };
    const api = new Function('fetch', 'localStorage', 'Cookies', 'document', 'window', `${API_SRC}\nreturn MSTREAMAPI;`)(fetch, {}, {}, {}, {});
    api.currentServer.host = 'http://h/';
    api.currentServer.token = 'tok';
    return { api, sent };
  }

  test('api.js: the admin panel\'s routes — enabled is exactly { enabled: true }, no abort signal (no client timeout), a refusal thrown with its status and words', async () => {
    const a = makeApi({ status: 200, body: { enabled: true } });
    await a.api.discoveryP2pAdminStatus();
    await a.api.discoveryP2pSetEnabled(true);
    await a.api.discoveryP2pSetName('Attic');
    await a.api.discoveryP2pSetDescription('');
    assert.deepEqual(a.sent.map((s) => [s.method, s.url, s.body, s.token]), [
      ['GET', 'http://h/api/v1/admin/discovery/p2p/status', undefined, 'tok'],
      ['POST', 'http://h/api/v1/admin/discovery/p2p/enabled', { enabled: true }, 'tok'],
      ['POST', 'http://h/api/v1/admin/discovery/p2p/name', { name: 'Attic' }, 'tok'],
      ['POST', 'http://h/api/v1/admin/discovery/p2p/description', { description: '' }, 'tok'],
    ]);
    assert.ok(a.sent.every((s) => s.signal === undefined), 'nothing aborts it: the enable may download the sidecar first');
    for (const [status, error] of [[405, 'Admin API Disabled'], [403, 'Admin access required'], [500, 'failed to start the discovery network: x']]) {
      await assert.rejects(makeApi({ status, body: { error } }).api.discoveryP2pSetEnabled(true), (err) => err.status === status && err.body.error === error);
    }
    const off = makeApi({ status: 200, body: {} });
    await off.api.discoveryP2pSetEnabled('yes');
    assert.deepEqual(off.sent[0].body, { enabled: false }, 'only true turns it on');
  });

  test('en.json: every peerRecs.turnOn key m.js draws exists, and m.js draws every one', () => {
    const drawn = [...new Set([...SRC.matchAll(/'(peerRecs\.turnOn\.[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
    const own = Object.keys(en).filter((k) => k.startsWith('peerRecs.turnOn.')).sort();
    assert.deepEqual(drawn, own);
    assert.equal(own.length, 9);
  });

  test('spa.css: one centred block that fits 390 px, the house fields, 44 px targets on touch', () => {
    assert.match(css, /\.prec-on \{ box-sizing: border-box; width: calc\(100% - 32px\); max-width: 440px; margin: 32px auto 0 auto;[^}]*background: #23282f; \}/);
    assert.match(css, /\.prec-on-input, \.prec-on-input\[type="text"\] \{ display: block; width: 100%; height: 32px;[^}]*background: #1a1e25;/);
    assert.match(css, /\.prec-on-btn:disabled, \.prec-on-btn:disabled:hover, \.prec-on-btn\[aria-disabled="true"\], \.prec-on-btn\[aria-disabled="true"\]:hover \{ opacity: \.5;/, 'busy (aria-disabled) looks shut too');
    assert.match(css, /@media \(pointer: coarse\) \{\n {2}\.prec-on-input, \.prec-on-input\[type="text"\], \.prec-on \.dpage-btn \{ height: 44px; \}\n {2}\.prec-on-input, \.prec-on-input\[type="text"\] \{ font-size: 16px; \}\n\}/, 'Turn on and Try again; 16 px text: iOS Safari zooms into a smaller focused field');
    assert.match(css, /\.prec-on-err \{[^}]*overflow-wrap: anywhere; \}/, 'a long server error wraps inside 390 px');
  });
});
