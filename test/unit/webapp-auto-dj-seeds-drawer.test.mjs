/**
 * The Auto DJ Seeds drawer (design B), its Add song step and the library
 * pick: m.js autoDjSeeds* and the disarm points.
 *
 * What is pinned:
 *   - the shell: a modal dialog on its own scrim (a .dmodal-shadow on
 *     body, above a pick banner left up and below the toasts), named by its
 *     step's heading, Close its first child; open puts the keyboard on
 *     Close; Close, Esc (from either step) and a scrim press that began on
 *     the scrim (no later press of a double-click) close it and give the
 *     keyboard back to the Seeds row; a view that takes the column closes
 *     it too (setBrowserRootPanel); Tab wraps inside it;
 *   - the lists step: Drift | Stay close pressed by the mode, with the
 *     mode's line; More like and Less like newest first, each row's cover,
 *     title, artist, "Pin <title>" (pressed as pinned) and "More for
 *     <title>"; each list ends with Add song (off while the list is full);
 *     Stay close locks every pin (pressed, inert, the lock badge) while the
 *     menus still work; Less like on an old server says so, dims its rows
 *     and turns its Add song and every "Less like this" off; a connected
 *     server's row can't go to Less like; the box follows
 *     clearPinsOnQueueClear in both modes;
 *   - the row menu: Esc closes it first (the drawer stays), its keys
 *     (ytdl's menuMixin), a press outside closes it in place; a move lands
 *     pinned in the other list with the keyboard on its ⋮; Remove gives
 *     the keyboard to the next row's ⋮, else the previous, else Add song;
 *   - the Add song step: the library row, the search field (focused), then
 *     Up next, Skipped (Less like only; the song playing marked as the
 *     queue marks it) and Recently played; the search (two characters,
 *     300 ms, eight title hits, an older answer never over a newer one, a
 *     song the list holds dimmed and inert); a pick lands pinned in its
 *     list and the lists come back with the keyboard on that Add song;
 *     Go Back does the same;
 *   - the library pick: the drawer closes, a seeds capture is armed with
 *     the list's banner and the File Explorer opens; a captured row is
 *     looked up, added pinned, and the page comes back with the drawer on
 *     its lists; Cancel comes back with nothing added; a connected
 *     server's row is refused and the capture stays armed; entering Auto DJ
 *     from the nav, Discover or Sonic Path disarms a leftover seeds
 *     capture; a More like pick kicks a stalled DJ; a return from a
 *     connected server's library comes home first;
 *   - the live refresh: a seeds change redraws the rows with the keyboard
 *     kept by key, a row that left takes its menu with it, the song, the
 *     queue and the Skipped ring redraw Add song's sections (the field and
 *     its query stay), a Less like row running out redraws it;
 *   - markup in a title or a path draws as text, and its row is found again
 *     by its key;
 *   - spa.css carries design B's block.
 *
 * Technique: webapp-auto-dj-panel.test.mjs's — the real panel and drawer
 * functions sliced out of m.js (and the window trap helpers out of vp.js)
 * and run against stub globals, with AUTODJ the real module under
 * auto-dj-client.test.mjs's Map-backed localStorage shim. The repo has no
 * DOM library, and the drawer's behaviour is focus, bubbling and in-place
 * redraws, so the document is a small real one (below): markup is parsed
 * into a tree, and focus, selectors and events work as a browser's do.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'm.js'), 'utf8').replace(/\r\n/g, '\n');
const VP_SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'vp.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'locales', 'en.json'), 'utf8'));
const require = createRequire(import.meta.url);

// The module reads `localStorage` at load time: the shim goes in first.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};
const AUTODJ = require('../../webapp/alpha/auto-dj.js');

beforeEach(() => {
  _store.clear();
  AUTODJ._internals.rehydrate();
  AUTODJ.invalidateGenresCache();
});

const LINES = SRC.split('\n');
function sliceFn(name) {
  const lines = LINES;
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
  const lines = LINES;
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

// A 2-space-indented closure function of vp.js (the house window's trap
// helpers, exported there as VUEPLAYERCORE.dmTabbables / dmTrapTarget).
function vpFn(name) {
  const start = VP_SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, `vp.js no longer defines ${name}() — update this test`);
  const end = VP_SRC.indexOf('\n  }\n', start);
  return VP_SRC.slice(start + 1, end + '\n  }'.length);
}
const VP = new Function(`${vpFn('dmTabbables')}\n${vpFn('dmTrapTarget')}\nreturn { dmTabbables, dmTrapTarget };`)();

// ── A small DOM ─────────────────────────────────────────────────────
// Enough of one for the panel and the drawer, as a browser runs them:
// markup parsed into a tree; compound selectors (tag, #id, .class,
// [attr], [attr="v"], [attr^="v"]) in lists and with the descendant
// combinator; focus (only a connected, enabled control, or one with a
// tabindex; a removed element loses it); listeners with bubbling and
// stopPropagation, then the document; and the onclick-style properties
// the panel sets.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', middot: '·' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, n) => {
  if (n[0] === '#') { return String.fromCodePoint(n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10)); }
  return Object.prototype.hasOwnProperty.call(NAMED, n) ? NAMED[n] : m;
});
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const FOCUSABLE = new Set(['button', 'input', 'select', 'textarea']);

// A node's links into the tree are non-enumerable: a failed assertion's
// message (node's assert inspects with getters on, custom inspectors off
// and depth 1000) then shows the node itself, not every path through the
// whole document.
function hide(node, links) {
  for (const [k, v] of Object.entries(links)) { Object.defineProperty(node, k, { value: v, writable: true, enumerable: false, configurable: true }); }
}

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    hide(this, { parentNode: null });
  }
  get textContent() { return this.data; }
  [util.inspect.custom]() { return `#text ${JSON.stringify(this.data)}`; }
}

function walk(root, fn) {
  for (const n of root.childNodes) {
    if (n.nodeType === 1) { fn(n); walk(n, fn); }
  }
}

function listen(target, type, fn, opts) {
  if (!target.listeners.has(type)) { target.listeners.set(type, []); }
  target.listeners.get(type).push(fn);
  if (opts && opts.signal) { opts.signal.addEventListener('abort', () => { unlisten(target, type, fn); }); }
}
function unlisten(target, type, fn) {
  if (target.listeners.has(type)) { target.listeners.set(type, target.listeners.get(type).filter((f) => f !== fn)); }
}

class Element {
  constructor(doc, tag, attrs) {
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs || {}));
    hide(this, { ownerDocument: doc, childNodes: [], parentNode: null, listeners: new Map() });
    this._value = this.attrs.has('value') ? this.attrs.get('value') : '';
    this._checked = this.attrs.has('checked');
    this.rect = null;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list) => { this.setAttribute('class', list.join(' ')); };
    return {
      contains: (c) => names().includes(c),
      add: (...cs) => write([...new Set([...names(), ...cs])]),
      remove: (...cs) => write(names().filter((x) => !cs.includes(x))),
      toggle: (c, force) => {
        const on = force === undefined ? !names().includes(c) : !!force;
        write(on ? [...new Set([...names(), c])] : names().filter((x) => x !== c));
        return on;
      },
    };
  }
  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) {
      if (k.startsWith('data-')) { out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; }
    }
    return out;
  }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { if (v) { this.attrs.set('disabled', ''); } else { this.attrs.delete('disabled'); } }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) { this.attrs.set('hidden', ''); } else { this.attrs.delete('hidden'); } }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get type() { return (this.getAttribute('type') || (this.localName === 'button' ? 'submit' : '')).toLowerCase(); }
  get name() { return this.getAttribute('name') || ''; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this._empty();
    if (String(v) !== '') { this._adopt(new TextNode(String(v))); }
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    this._empty();
    for (const n of parseHtml(this.ownerDocument, String(html))) { this._adopt(n); }
  }
  insertAdjacentHTML(where, html) {
    assert.equal(where, 'beforeend', 'the test DOM only appends');
    for (const n of parseHtml(this.ownerDocument, String(html))) { this._adopt(n); }
  }
  appendChild(n) {
    if (n.parentNode) { n.parentNode._drop(n); }
    this._adopt(n);
    return n;
  }
  remove() { if (this.parentNode) { this.parentNode._drop(this); } }
  _adopt(n) { n.parentNode = this; this.childNodes.push(n); }
  _drop(n) {
    this.ownerDocument._lose(n);
    this.childNodes = this.childNodes.filter((x) => x !== n);
    n.parentNode = null;
  }
  _empty() {
    for (const n of this.childNodes) { this.ownerDocument._lose(n); n.parentNode = null; }
    this.childNodes = [];
  }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) { if (n === this.ownerDocument.documentElement) { return true; } }
    return false;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) { if (n === this) { return true; } }
    return false;
  }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) { if (n.matches(sel)) { return n; } }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (n) => { if (n.matches(sel)) { out.push(n); } });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() {
    if (!this.isConnected || this.disabled) { return; }
    if (!FOCUSABLE.has(this.localName) && !this.attrs.has('tabindex')) { return; }
    this.ownerDocument.activeElement = this;
  }
  blur() { if (this.ownerDocument.activeElement === this) { this.ownerDocument.activeElement = this.ownerDocument.body; } }
  getClientRects() {
    if (!this.isConnected) { return []; }
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) { if (n.attrs.has('hidden')) { return []; } }
    return [{}];
  }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  addEventListener(type, fn, opts) { listen(this, type, fn, opts); }
  removeEventListener(type, fn) { unlisten(this, type, fn); }
  // A failed assertion names the element instead of inspecting the whole
  // (cyclic) document.
  [util.inspect.custom]() {
    const label = this.getAttribute('aria-label');
    return `<${this.localName}${this.id ? `#${this.id}` : ''}${this.className ? `.${this.className.trim().split(/\s+/).join('.')}` : ''}${label ? ` "${label}"` : ''}${this.isConnected ? '' : ' (detached)'}>`;
  }
}

function serialize(n) {
  if (n.nodeType === 3) { return escText(n.data); }
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  return VOID.has(n.localName) ? `<${n.localName}${attrs}>` : `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

function parseHtml(doc, html) {
  const top = [];
  const open = [];
  const add = (n) => { if (open.length) { open[open.length - 1]._adopt(n); } else { top.push(n); } };
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)|</g;
  for (const m of html.matchAll(re)) {
    if (m[0].startsWith('<!--')) { continue; }
    if (m[1]) {
      const at = open.map((e) => e.localName).lastIndexOf(m[1].toLowerCase());
      if (at >= 0) { open.length = at; }
      continue;
    }
    if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*"([^"]*)")?/g)) { attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? ''); }
      const el = new Element(doc, m[2], attrs);
      add(el);
      if (!VOID.has(el.localName) && !m[4]) { open.push(el); }
      continue;
    }
    add(new TextNode(m[5] !== undefined ? decodeEntities(m[5]) : '<'));
  }
  return top;
}

function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g;
  let at = 0;
  for (const m of s.matchAll(re)) {
    assert.equal(m.index, at, `the test DOM can't read the selector ${s}`);
    at = m.index + m[0].length;
    if (m[1]) { out.tag = m[1].toLowerCase(); } else if (m[2]) { out.id = m[2]; } else if (m[3]) { out.classes.push(m[3]); } else { out.attrs.push({ name: m[4], op: m[5] || null, value: m[6] }); }
  }
  assert.equal(at, s.length, `the test DOM can't read the selector ${s}`);
  return out;
}
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) { return false; }
  if (c.id && el.getAttribute('id') !== c.id) { return false; }
  for (const cls of c.classes) { if (!el.classList.contains(cls)) { return false; } }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) { return false; }
    if (a.op === '=' && v !== a.value) { return false; }
    if (a.op === '^=' && !v.startsWith(a.value)) { return false; }
  }
  return true;
}
function matchesSelector(el, sel) {
  return sel.split(',').some((part) => {
    const steps = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, steps[steps.length - 1])) { return false; }
    let i = steps.length - 2;
    for (let n = el.parentNode; i >= 0 && n && n.nodeType === 1; n = n.parentNode) {
      if (matchCompound(n, steps[i])) { i--; }
    }
    return i < 0;
  });
}

function makeDocument(bodyHtml) {
  const doc = { nodeType: 9, listeners: new Map() };
  doc.documentElement = new Element(doc, 'html');
  doc.body = new Element(doc, 'body');
  doc.documentElement._adopt(doc.body);
  doc.activeElement = doc.body;
  doc._lose = (n) => { if (n.nodeType === 1 && n.contains(doc.activeElement)) { doc.activeElement = doc.body; } };
  doc.createElement = (tag) => new Element(doc, tag);
  doc.getElementById = (id) => {
    let hit = null;
    walk(doc.documentElement, (n) => { if (!hit && n.getAttribute('id') === id) { hit = n; } });
    return hit;
  };
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = (type, fn, opts) => { listen(doc, type, fn, opts); };
  doc.removeEventListener = (type, fn) => { unlisten(doc, type, fn); };
  doc.body.innerHTML = bodyHtml;
  return doc;
}

// An event through [target]'s ancestors, then the document; a listener's
// stopPropagation ends it after the node it is on.
function fire(target, type, init = {}) {
  const doc = target.ownerDocument;
  const ev = {
    type,
    target,
    currentTarget: null,
    key: init.key,
    detail: init.detail,
    shiftKey: !!init.shiftKey,
    isComposing: !!init.isComposing,
    keyCode: init.keyCode || 0,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  const route = [];
  for (let n = target; n; n = n.parentNode) { route.push(n); }
  route.push(doc);
  for (const node of route) {
    ev.currentTarget = node;
    for (const fn of [...(node.listeners.get(type) || [])]) { fn.call(node, ev); }
    const prop = node[`on${type}`];
    if (typeof prop === 'function') { prop.call(node, ev); }
    if (ev.stopped) { break; }
  }
  return ev;
}

// The document's controls a Tab moves through, in tree order.
function tabOrder(doc) {
  const out = [];
  walk(doc.documentElement, (n) => {
    const focusable = FOCUSABLE.has(n.localName) || n.hasAttribute('tabindex');
    if (focusable && !n.disabled && n.getAttribute('tabindex') !== '-1' && n.getClientRects().length) { out.push(n); }
  });
  return out;
}

// A user's press: mousedown (which focuses the control pressed), then click;
// [detail] is the press's place in a multi-click (2: a double-click's second).
function click(el, { downOn, detail } = {}) {
  const doc = el.ownerDocument;
  const down = downOn || el;
  const ev = fire(down, 'mousedown', { detail });
  if (!ev.defaultPrevented) {
    const target = down.closest('button, input, select, textarea, [tabindex]');
    if (target) { target.focus(); }
  }
  fire(el, 'click', { detail });
  return doc;
}
// A key on what has focus; a Tab nobody took moves as the browser does.
function press(doc, key, init = {}) {
  const at = doc.activeElement;
  const ev = fire(at, 'keydown', { key, ...init });
  if (key === 'Tab' && !ev.defaultPrevented) {
    const order = tabOrder(doc);
    const i = order.indexOf(doc.activeElement);
    const next = init.shiftKey ? order[i - 1] : order[i + 1];
    if (next) { next.focus(); }
  }
  return ev;
}
function typeInto(el, value) {
  el.value = value;
  fire(el, 'input');
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) { await flush(); } }

// The fake clock's timers: nothing really waits, and nothing is left
// running when a test ends.
function makeTimers() {
  let next = 0;
  const live = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++next; live.set(id, { fn, ms: Number(ms) || 0 }); return id; },
    clearTimeout: (id) => { live.delete(id); },
    pending: () => [...live.values()].map((x) => x.ms),
    run(filter) {
      for (const [id, x] of [...live]) {
        if (!filter || filter(x.ms)) { live.delete(id); x.fn(); }
      }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// t() echoes the key, with its params when there are any.
const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);

const HOST = 'http://host/';
const peerArtUrl = (id, art, compress) => `${HOST}api/v1/federation/peers/${id}/art/${encodeURIComponent(art)}?compress=${compress}&token=TOK`;
const localArt = (art) => `${HOST}album-art/${encodeURIComponent(art)}?compress=s&token=TOK`;

const song = (name, extra = {}) => ({ owner: null, path: `music/${name}.mp3`, title: name, artist: '', album: '', art: null, duration: null, ...extra });
const keyOf = (name, owner = null) => AUTODJ.seeds.keyOf(owner, `music/${name}.mp3`);
// A queue row (addSongWizard's shape) of [name].
const queueRow = (name, extra = {}) => ({ rawFilePath: `music/${name}.mp3`, filepath: `music/${name}.mp3`, metadata: { title: name, artist: `${name} artist` }, ...extra });

const PANEL_FNS = ['escapeHtml', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'autoDjSeedArtUrl', 'autoDjSecToMin',
  'autoDjChipsHtml', 'autoDjSwitchRowHtml', 'autoDjSubState', 'autoDjSeedsTilesHtml', 'autoDjSubRowsHtml', 'autoDjPanelHtml',
  'autoDjApplySonicDim', 'autoDjRenderTiles', 'autoDjRenderToggle', 'autoDjPanel'];
// Every function of the drawer, Add song and the library pick.
const DRAWER_FNS = [...SRC.matchAll(/^(?:async )?function ((?:autoDjSeed|onAutoDjSeeds|autoDjAddSong|autoDjAddResults|autoDjPickRow)\w*)\(/gm)].map((m) => m[1]);
const CAPTURE_FNS = ['peerOf', 'onFileClick', 'showPickBanner', 'sonicPathHideBanner'];
const FNS = [...new Set([...PANEL_FNS, ...DRAWER_FNS, ...CAPTURE_FNS])];

// The statement setBrowserRootPanel (every view that takes the column)
// runs for the drawer; the sandbox's setBrowserRootPanel runs it too.
const ROOT_PANEL_SEEDS = sliceFn('setBrowserRootPanel').split('\n').map((l) => l.trim())
  .find((l) => l.includes('autoDjSeeds') && !l.startsWith('//')) || '';

const BODY = '<div class="side-nav-item select" data-panel="fileExplorer" id="nav-explorer"></div>'
  + '<div id="nav-auto-dj" class="local-only side-nav-item"></div><div id="filelist"></div>';

// The sliced functions, with m.js's top-level state they share (a
// connected server's browse context, which the library pick's return
// resets, is readable through `browse`).
const SANDBOX_BODY = `
  'use strict';
  ${sliceConst('entityMap')}
  ${sliceConst('MOODS')}
  ${sliceConst('autoDjSeedsUi')}
  ${sliceConst('AUTODJ_SEEDS_ICONS')}
  let _autoDjPanelAbortController = null;
  let peerContext = null;
  let browseGeneration = 0;
  let fileExplorerArray = ['a connected server\\'s folder'];
  const knownPeers = new Map([[7, { id: 7, name: 'Peer' }]]);
  ${FNS.map(sliceFn).join('\n\n')}
  return {
    ${FNS.join(', ')},
    ui: autoDjSeedsUi,
    browse: {
      get peerContext() { return peerContext; },
      set peerContext(v) { peerContext = v; },
      get browseGeneration() { return browseGeneration; },
      get fileExplorerArray() { return fileExplorerArray; },
    },
  };
`;

// One stubbed app around the sliced panel and drawer.
//   server   MSTREAMAPI.currentServer's flags (the ping's)
//   djOn     MSTREAMPLAYER.playerStats.autoDJ
//   recent   Recently played's answer (a function: the call's promise)
function makeSandbox({ server = {}, djOn = false, recent = [] } = {}) {
  const doc = makeDocument(BODY);
  const timers = makeTimers();
  const log = [];
  const toasts = [];
  const views = [];
  const live = new Set();
  const playerListeners = new Set();
  const seeds = {
    ...AUTODJ.seeds,
    subscribe: (fn) => {
      const off = AUTODJ.seeds.subscribe(fn);
      live.add(fn);
      return () => { live.delete(fn); off(); };
    },
  };
  const api = {
    currentServer: { host: HOST, token: 'TOK', vpaths: ['Music'], discovery: true, autoDj: 1, ...server },
    getGenres: () => Promise.resolve({ status: 'ok', value: ['Rock'] }),
    peerArtUrl,
    searches: [],
    search(body) {
      const d = deferred();
      api.searches.push({ body, ...d });
      return d.promise;
    },
    recentAsks: [],
    getRecentlyPlayed(limit, ignoreVPaths) {
      api.recentAsks.push({ limit, ignoreVPaths });
      return typeof recent === 'function' ? recent() : Promise.resolve(recent);
    },
    lookups: [],
    lookupMetadata(filepath) {
      const d = deferred();
      api.lookups.push({ filepath, ...d });
      return d.promise;
    },
  };
  const player = {
    playerStats: { autoDJ: djOn },
    playlist: [],
    positionCache: { val: -1 },
    current: null,
    ignoreVPaths: { Music: false, Live: true },
    getCurrentSong() { return player.current || false; },
    onAutoDj(fn) { playerListeners.add(fn); return () => { playerListeners.delete(fn); }; },
    fillBareSeeds() {},
    autoDjKick() { log.push('kick'); },
    toggleAutoDJ() { player.playerStats.autoDJ = !player.playerStats.autoDJ; return player.playerStats.autoDJ; },
  };
  const vpc = { songCapture: null, dmTabbables: VP.dmTabbables, dmTrapTarget: VP.dmTrapTarget };
  const rootPanels = [];
  let S = null;
  const globals = {
    document: doc,
    AUTODJ: { ...AUTODJ, seeds },
    MSTREAMAPI: api,
    MSTREAMPLAYER: player,
    VUEPLAYERCORE: vpc,
    t: tStub,
    iziToast: { warning: (o) => toasts.push(o), success: (o) => toasts.push(o), error: (o) => toasts.push(o) },
    setBrowserRootPanel: (name) => {
      rootPanels.push(name);
      new Function('autoDjSeedsClose', ROOT_PANEL_SEEDS)(S.autoDjSeedsClose);
    },
    _autoDjMigrateLegacyKeys: () => {},
    _fetchLastfmStatus: () => Promise.resolve({ serverEnabled: true }),
    _syncVpathsToLegacy: () => {},
    // spa.js's: it reads el.classList, so a null nav item would throw
    changeView: (fn, el) => {
      assert.ok(el && el.classList, 'changeView needs its nav item');
      views.push({ fn, el });
      log.push(`view:${el.id}`);
      return fn();
    },
    loadFileExplorer: () => { log.push('explorer'); },
    applyServerContext: () => { log.push('serverContext'); },
    queueRow: (...args) => { log.push(['queue', ...args]); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  S = new Function(...Object.keys(globals), SANDBOX_BODY)(...Object.values(globals));
  const sb = {
    S, doc, timers, log, toasts, views, live, playerListeners, api, player, vpc, rootPanels,
    g: globals,
    server: api.currentServer,
    $: (id) => doc.getElementById(id),
    dialog: () => doc.getElementById('dj-seeds-drawer'),
    song: (reason) => { for (const fn of [...playerListeners]) { fn(reason); } },
    lastView: () => views[views.length - 1],
  };
  return sb;
}

// The page drawn, then the Seeds row pressed.
async function openDrawer(sb) {
  await sb.S.autoDjPanel();
  click(sb.$('dj-seeds-btn'));
  const dialog = sb.dialog();
  assert.ok(dialog, 'the drawer opened');
  return dialog;
}

// A running lane, so edits go live (with the DJ off they are held aside,
// and view() still shows them).
function liveLane(now) {
  AUTODJ.seeds.setArmed(true);
  AUTODJ.seeds.laneEdge({ now });
  AUTODJ.seeds.beginPick({ current: null, now });
}

// The boards' lists (B-Drift): More like, newest first, SkyWalk (a pick),
// Crystalstair and Fayz (pinned), Better Days, Looking Back (picks); Less
// like Bout2skate (a learned skip) and Guard Up! (pinned).
function boardSeeds(T) {
  liveLane(T);
  AUTODJ.seeds.onPlay(song('Looking Back', { artist: 'Boukmanflow', art: 'lb.jpg' }), { lanePick: true, now: T + 1 });
  AUTODJ.seeds.onPlay(song('Better Days', { artist: 'Boukmanflow' }), { lanePick: true, now: T + 2 });
  AUTODJ.seeds.add('more', song('Fayz', { artist: 'ALM', art: 'fz.jpg' }), T + 3);
  AUTODJ.seeds.add('more', song('Crystalstair', { artist: 'Boukmanflow' }), T + 4);
  AUTODJ.seeds.onPlay(song('SkyWalk', { artist: 'Boukmanflow', art: 'sw.jpg' }), { lanePick: true, now: T + 5 });
  AUTODJ.seeds.onPlay(song('Bout2skate', { artist: 'Boukmanflow' }), { lanePick: true, now: T + 6 });
  AUTODJ.seeds.quickSkip(song('Bout2skate', { artist: 'Boukmanflow' }), { djPick: true, learn: true, now: T + 7 });
  AUTODJ.seeds.add('less', song('Guard Up!', { artist: 'ALM' }), T + 8);
}

// The drawn rows of a list ('more' | 'less'), as the user reads them.
function rowsOf(sb, list) {
  const ul = sb.dialog().querySelectorAll('.dj-seeds-list').find((u) => u.getAttribute('data-list') === list);
  return ul.querySelectorAll('.dj-seed').map((li) => {
    const pin = li.querySelector('.dj-seed-pin');
    const more = li.querySelector('.dj-seed-more');
    const artist = li.querySelector('.dj-seed-artist');
    const art = li.querySelector('.dj-seed-art');
    return {
      li, pin, more,
      key: li.getAttribute('data-seed-key'),
      title: li.querySelector('.dj-seed-title').textContent,
      artist: artist ? artist.textContent : null,
      art: art.localName === 'img' ? art.getAttribute('src') : null,
      pressed: pin.getAttribute('aria-pressed'),
      inert: pin.getAttribute('aria-disabled') === 'true',
      dim: li.classList.contains('is-dim'),
    };
  });
}
const titles = (sb, list) => rowsOf(sb, list).map((r) => r.title);
const rowNamed = (sb, list, title) => rowsOf(sb, list).find((r) => r.title === title);
const addSongOf = (sb, list) => sb.dialog().querySelectorAll('.dj-seeds-add').find((b) => b.getAttribute('data-add') === list);
const menuItems = (sb) => {
  const menu = sb.$('dj-seeds-menu');
  return menu ? menu.querySelectorAll('[role="menuitem"]') : [];
};
const viewKeys = (list) => AUTODJ.seeds.view()[list].map((r) => [r.key, r.shownPinned]);
// Add song's sections, drawn: heading → the rows' titles (and marks).
function sectionsOf(sb) {
  const box = sb.$('dj-add-results');
  const out = {};
  for (const h of box.querySelectorAll('h3')) {
    const ul = box.querySelectorAll('ul').find((u) => u.getAttribute('aria-labelledby') === h.id);
    out[h.textContent] = ul.querySelectorAll('.dj-pick').map((b) => b.querySelector('.dj-seed-title').textContent
      + (b.getAttribute('aria-current') === 'true' ? ' (playing)' : '') + (b.getAttribute('aria-disabled') === 'true' ? ' (taken)' : ''));
  }
  const hits = sb.$('dj-add-hits');
  if (hits) {
    out.hits = hits.querySelectorAll('.dj-pick').map((b) => b.querySelector('.dj-seed-title').textContent
      + (b.getAttribute('aria-disabled') === 'true' ? ' (taken)' : ''));
  }
  return out;
}
const pickNamed = (sb, title) => sb.$('dj-add-results').querySelectorAll('.dj-pick').find((b) => b.querySelector('.dj-seed-title').textContent === title);
const searchHit = (name, extra = {}) => ({ name: `Artist - ${name}`, filepath: `music/${name}.mp3`, metadata: { title: name, artist: 'Artist', 'album-art': `${name}.jpg` }, ...extra });

describe('the Seeds drawer: shell', () => {
  test('a dialog, modal, named by its step\'s heading; Close is its first child', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('tabindex'), '-1');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dj-seeds-title');
    assert.equal(sb.$('dj-seeds-title').localName, 'h2');
    assert.equal(sb.$('dj-seeds-title').textContent, 'autoDJ.seedsLabel');
    const close = dialog.children[0];
    assert.equal(close.className, 'dj-seeds-close');
    assert.equal(close.getAttribute('aria-label'), 'modal.close');
    assert.equal(close.getAttribute('type'), 'button');
    assert.ok(!close.hasAttribute('title'), 'no tooltip (minimal text)');
    // the Seeds row says it opened the drawer, and which
    assert.equal(sb.$('dj-seeds-btn').getAttribute('aria-expanded'), 'true');
    assert.equal(sb.$('dj-seeds-btn').getAttribute('aria-controls'), 'dj-seeds-drawer');
    // Add song: named by its own heading, Close still first, then Go Back
    click(addSongOf(sb, 'more'));
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dj-add-title');
    assert.equal(sb.$('dj-add-title').textContent, 'autoDJ.addSong');
    assert.equal(dialog.children[0].className, 'dj-seeds-close');
    assert.equal(dialog.querySelector('.dj-seeds-head').children[0].getAttribute('aria-label'), 'tooltip.goBack');
    assert.equal(sb.doc.querySelectorAll('[role="dialog"]').length, 1, 'one dialog, two steps');
  });

  test('the scrim is a dmodal-shadow on body, which a redraw of the column\'s markup leaves be', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    const shade = sb.$('dj-seeds-shade');
    assert.equal(shade.parentNode, sb.doc.body);
    assert.deepEqual(shade.className.split(' '), ['dmodal-shadow', 'dj-seeds-shade'], 'the player\'s hotkeys and YouTube paste stay off under it');
    assert.equal(dialog.parentNode, shade);
    assert.ok(!sb.$('filelist').contains(shade), 'not in the column');
    sb.$('filelist').innerHTML = '<p>drawn again</p>';
    assert.equal(sb.dialog(), dialog, 'the drawer survives the column\'s markup');
  });

  test('a view that takes the column under it closes the drawer, from either step, the keyboard left be', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    for (const step of ['lists', 'add']) {
      const sb = makeSandbox();
      await openDrawer(sb);
      if (step === 'add') { click(addSongOf(sb, 'less')); }
      // a toast's Details (ytdlToast → ytdlOpenPanel → changeView): a
      // toast sits above the scrim, and its press takes the column
      const details = sb.doc.createElement('button');
      sb.doc.body.appendChild(details);
      details.focus();
      sb.g.changeView(() => sb.g.setBrowserRootPanel('panel.addFromYoutube', false), sb.$('nav-explorer'));
      assert.equal(sb.$('dj-seeds-shade'), null, `${step}: the drawer went with the page`);
      assert.equal(sb.S.ui.open, false);
      assert.equal(sb.S.ui.step, 'lists', 'the next open starts on the lists');
      assert.equal(sb.$('dj-seeds-btn').getAttribute('aria-expanded'), 'false');
      assert.deepEqual(sb.doc.listeners.get('keydown') || [], [], 'its key listener went with it');
      assert.equal(sb.live.size, 1, 'only the panel\'s seeds listener is left');
      assert.equal(sb.doc.activeElement, details, 'the keyboard stays where it was');
      // nothing open: nothing to do
      sb.g.setBrowserRootPanel('panel.fileExplorer');
      assert.equal(sb.S.ui.open, false);
    }
    // setBrowserRootPanel runs it for every view, a connected server's too
    assert.match(sliceFn('setBrowserRootPanel'), /\n {2}if \(typeof autoDjSeedsClose === 'function'\) \{ autoDjSeedsClose\(\{ noFocus: true \}\); \}\n/);
  });

  test('its scrim sits above a pick banner left up, and below the toasts', () => {
    // Discover's and Sonic Path's picks keep their banner across views (the
    // Auto DJ page disarms only a seeds pick): under the scrim, the banner
    // can neither cover Close and the heading nor offer its Cancel, which
    // would draw another page under the modal drawer.
    const zOf = (css, sel) => {
      const m = new RegExp(`\\n${sel.replace(/[.#]/g, '\\$&')} \\{[^}]*?z-index: ?(\\d+);`).exec(css);
      assert.ok(m, `${sel} has a z-index`);
      return Number(m[1]);
    };
    const shade = zOf(CSS, '.dmodal-shadow.dj-seeds-shade');
    assert.ok(shade > zOf(CSS, '#spath-banner'), 'above the pick banner');
    assert.ok(shade > zOf(CSS, '.dmodal-shadow'), 'above the house windows\' scrim it reuses');
    const IZI = fs.readFileSync(path.join(ROOT, 'webapp', 'assets', 'css', 'izi-toast.css'), 'utf8');
    assert.ok(shade < Number(/\.iziToast-wrapper\{z-index:(\d+)/.exec(IZI)[1]), 'a toast stays above it');
  });

  test('a double-click on the Seeds row opens the drawer and leaves it open', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    click(sb.$('dj-seeds-btn'), { detail: 1 });
    assert.ok(sb.dialog(), 'the first press opens it');
    // the second press lands on the scrim, now over the row
    click(sb.$('dj-seeds-shade'), { detail: 2 });
    assert.ok(sb.dialog(), 'a multi-click\'s later press is no press outside');
    click(sb.$('dj-seeds-shade'), { detail: 3 });
    assert.ok(sb.dialog());
    // a press of its own still closes it, a touch's (detail 0) too
    click(sb.$('dj-seeds-shade'), { detail: 1 });
    assert.equal(sb.dialog(), null);
    click(sb.$('dj-seeds-btn'), { detail: 1 });
    fire(sb.$('dj-seeds-shade'), 'touchstart', { detail: 0 });
    fire(sb.$('dj-seeds-shade'), 'click', { detail: 1 });
    assert.equal(sb.dialog(), null, 'a tap on the scrim');
  });

  test('open focuses Close; Close, Escape and a scrim press that began on the scrim close it and focus the Seeds row', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const closed = () => {
      assert.equal(sb.$('dj-seeds-shade'), null, 'the scrim is gone');
      assert.equal(sb.doc.activeElement, sb.$('dj-seeds-btn'), 'the keyboard is back on the Seeds row');
      assert.equal(sb.$('dj-seeds-btn').getAttribute('aria-expanded'), 'false');
      assert.ok(!sb.$('dj-seeds-btn').hasAttribute('aria-controls'));
      assert.deepEqual(sb.doc.listeners.get('keydown') || [], [], 'the drawer\'s key listener went with it');
      assert.equal(sb.live.size, 1, 'only the panel\'s seeds listener is left');
      assert.equal(sb.S.ui.open, false);
    };
    const dialog = await openDrawer(sb);
    assert.equal(sb.doc.activeElement, dialog.children[0], 'open: the keyboard on Close');
    assert.equal(sb.live.size, 2, 'the drawer listens to the seeds');
    click(dialog.children[0]);
    closed();
    // Esc, on the lists
    click(sb.$('dj-seeds-btn'));
    press(sb.doc, 'Escape');
    closed();
    // Esc, from Add song's field
    click(sb.$('dj-seeds-btn'));
    click(addSongOf(sb, 'more'));
    assert.equal(sb.doc.activeElement, sb.$('dj-add-search'));
    press(sb.doc, 'Escape');
    closed();
    // a press that began on the scrim and ended there
    click(sb.$('dj-seeds-btn'));
    click(sb.$('dj-seeds-shade'));
    closed();
    // a drag out of the drawer (it began inside) is no press outside
    click(sb.$('dj-seeds-btn'));
    const again = sb.dialog();
    click(sb.$('dj-seeds-shade'), { downOn: sb.$('dj-seeds-title') });
    assert.equal(sb.dialog(), again, 'a press that began in the drawer keeps it');
    click(sb.$('dj-seeds-title'));
    assert.ok(sb.dialog(), 'a press inside keeps it');
    // an IME's Esc is its own
    press(sb.doc, 'Escape', { isComposing: true });
    press(sb.doc, 'Escape', { keyCode: 229 });
    assert.ok(sb.dialog());
    press(sb.doc, 'Escape');
    closed();
  });

  test('Tab wraps inside it', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.add('more', song('A'), T + 1);
    AUTODJ.seeds.add('less', song('Z'), T + 2);
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    // the order (UI-SPEC §2.8): Close, Drift, Stay close, each row's Pin and
    // ⋮, a list's Add song, …, the box
    assert.deepEqual(sb.vpc.dmTabbables(dialog).map((el) => el.getAttribute('aria-label') || el.getAttribute('data-mode') || el.getAttribute('data-add') || el.id), [
      'modal.close', 'rolling', 'locked',
      'autoDJ.seedPin{"title":"A"}', 'autoDJ.seedMore{"title":"A"}', 'more',
      'autoDJ.seedPin{"title":"Z"}', 'autoDJ.seedMore{"title":"Z"}', 'less',
      'dj-seeds-clear-pins',
    ]);
    sb.$('dj-seeds-clear-pins').focus();
    press(sb.doc, 'Tab');
    assert.equal(sb.doc.activeElement, dialog.children[0], 'past the last control: Close');
    press(sb.doc, 'Tab', { shiftKey: true });
    assert.equal(sb.doc.activeElement, sb.$('dj-seeds-clear-pins'), 'Shift+Tab from Close: the last control');
    press(sb.doc, 'Tab', { shiftKey: true });
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'less'), 'inside, the browser\'s own move');
    // focus fell out (to body): the first control
    sb.doc.activeElement = sb.doc.body;
    press(sb.doc, 'Tab');
    assert.equal(sb.doc.activeElement, dialog.children[0]);
    // the Add song step wraps too: Close, Go Back, the library row, the field
    click(addSongOf(sb, 'less'));
    assert.deepEqual(sb.vpc.dmTabbables(dialog).map((el) => el.getAttribute('aria-label') || el.id), ['modal.close', 'tooltip.goBack', 'dj-add-library', 'autoDJ.sonicSeedPlaceholder']);
    press(sb.doc, 'Tab');
    assert.equal(sb.doc.activeElement, dialog.children[0], 'past the field: Close');
  });
});

describe('the Seeds drawer: lists', () => {
  test('Drift and Stay close pressed by the mode, with the mode\'s line', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    const group = dialog.querySelector('.dj-seeds-mode');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'autoDJ.seedModeLabel');
    const [drift, close] = group.querySelectorAll('.dj-seeds-mode-btn');
    assert.deepEqual([drift.textContent, close.textContent], ['autoDJ.seedModeDrift', 'autoDJ.seedModeStayClose']);
    const desc = sb.$('dj-seeds-mode-desc');
    assert.equal(desc.getAttribute('aria-live'), 'polite');
    assert.deepEqual([drift.getAttribute('aria-pressed'), close.getAttribute('aria-pressed')], ['true', 'false']);
    assert.equal(desc.textContent, 'autoDJ.seedModeDriftHint');
    click(close);
    assert.equal(AUTODJ.state.sonicAnchorMode, 'locked');
    assert.deepEqual([drift.getAttribute('aria-pressed'), close.getAttribute('aria-pressed')], ['false', 'true']);
    assert.equal(sb.$('dj-seeds-mode-desc'), desc, 'the line changes in place (a live region)');
    assert.equal(desc.textContent, 'autoDJ.seedModeStayCloseHint');
    assert.equal(sb.doc.activeElement, close, 'the keyboard stays on the pressed button');
    click(drift);
    assert.equal(AUTODJ.state.sonicAnchorMode, 'rolling');
    assert.equal(desc.textContent, 'autoDJ.seedModeDriftHint');
    assert.equal(sb.doc.activeElement, drift);
    // drawn in Stay close
    AUTODJ.seeds.setMode('locked');
    press(sb.doc, 'Escape');
    click(sb.$('dj-seeds-btn'));
    assert.deepEqual(sb.dialog().querySelectorAll('.dj-seeds-mode-btn').map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
    assert.equal(sb.$('dj-seeds-mode-desc').textContent, 'autoDJ.seedModeStayCloseHint');
  });

  test('rows newest first, Pin <title> pressed as pinned, More for <title> with a menu', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox();
    await openDrawer(sb);
    assert.deepEqual(titles(sb, 'more'), ['SkyWalk', 'Crystalstair', 'Fayz', 'Better Days', 'Looking Back']);
    assert.deepEqual(titles(sb, 'less'), ['Guard Up!', 'Bout2skate']);
    assert.deepEqual(rowsOf(sb, 'more').map((r) => r.pressed), ['false', 'true', 'true', 'false', 'false']);
    assert.deepEqual(rowsOf(sb, 'less').map((r) => r.pressed), ['true', 'false']);
    const sky = rowNamed(sb, 'more', 'SkyWalk');
    assert.equal(sky.artist, 'Boukmanflow');
    assert.equal(sky.art, localArt('sw.jpg'));
    assert.equal(sky.li.querySelector('.dj-seed-art').getAttribute('alt'), '');
    assert.equal(rowNamed(sb, 'more', 'Better Days').art, null, 'no art: the empty tile');
    assert.equal(rowNamed(sb, 'more', 'Better Days').li.querySelector('.dj-seed-art').getAttribute('aria-hidden'), 'true');
    assert.equal(sky.pin.getAttribute('aria-label'), 'autoDJ.seedPin{"title":"SkyWalk"}');
    assert.equal(sky.more.getAttribute('aria-label'), 'autoDJ.seedMore{"title":"SkyWalk"}');
    assert.equal(sky.more.getAttribute('aria-haspopup'), 'menu');
    assert.equal(sky.more.getAttribute('aria-expanded'), 'false');
    assert.ok(!sky.inert && !sky.dim);
    assert.ok(rowsOf(sb, 'more').every((r) => !r.pin.querySelector('circle')), 'Drift: no lock badge');
    // the lists take their names from their headings
    for (const list of ['more', 'less']) {
      const ul = sb.dialog().querySelectorAll('.dj-seeds-list').find((u) => u.getAttribute('data-list') === list);
      assert.equal(sb.$(ul.getAttribute('aria-labelledby')).textContent, list === 'more' ? 'autoDJ.seedsMoreLike' : 'autoDJ.seedsLessLike');
    }
    // the pin: pressed pins the row, the keyboard stays on it (the row
    // redrew)
    click(sky.pin);
    assert.deepEqual(viewKeys('more')[0], [keyOf('SkyWalk'), true]);
    assert.equal(rowNamed(sb, 'more', 'SkyWalk').pressed, 'true');
    assert.notEqual(rowNamed(sb, 'more', 'SkyWalk').pin, sky.pin, 'redrawn');
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'SkyWalk').pin, 'the keyboard found it again');
    click(rowNamed(sb, 'more', 'SkyWalk').pin);
    assert.deepEqual(viewKeys('more')[0], [keyOf('SkyWalk'), false]);
    // a row without a title shows its file name
    AUTODJ.seeds.add('more', { owner: null, path: 'music/x/Untitled.flac', title: '' }, Date.now());
    assert.equal(titles(sb, 'more')[0], 'Untitled.flac');
  });

  test('each list ends with Add song', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.add('less', song('Z'), T);
    const sb = makeSandbox();
    await openDrawer(sb);
    for (const list of ['more', 'less']) {
      const ul = sb.dialog().querySelectorAll('.dj-seeds-list').find((u) => u.getAttribute('data-list') === list);
      const last = ul.children[ul.children.length - 1];
      const add = last.querySelector('button');
      assert.equal(add, addSongOf(sb, list));
      assert.equal(add.className, 'dj-seeds-add');
      assert.equal(add.textContent, 'autoDJ.addSong');
      assert.equal(add.getAttribute('aria-describedby'), `dj-seeds-${list}-h`, 'Add song, More like / Less like');
      assert.ok(!add.disabled);
      assert.equal(add.querySelector('.dj-seeds-add-ic').getAttribute('aria-hidden'), 'true');
    }
    // eight pinned rows: the list is full, its Add song off
    for (let i = 0; i < 8; i++) { AUTODJ.seeds.add('more', song(`p${i}`), T + 1 + i); }
    assert.equal(rowsOf(sb, 'more').length, 8);
    assert.ok(addSongOf(sb, 'more').disabled);
    assert.ok(!addSongOf(sb, 'less').disabled);
  });

  test('Stay close: every pin pressed, disabled and locked; the menus still work', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    AUTODJ.seeds.setMode('locked');
    const sb = makeSandbox();
    await openDrawer(sb);
    const all = [...rowsOf(sb, 'more'), ...rowsOf(sb, 'less')];
    assert.equal(all.length, 7);
    for (const r of all) {
      assert.equal(r.pressed, 'true', `${r.title}: pressed`);
      assert.ok(r.inert, `${r.title}: aria-disabled`);
      assert.equal(r.pin.querySelector('svg').getAttribute('width'), '22', 'the locked icon');
      assert.equal(r.pin.querySelector('circle').getAttribute('fill'), '#2d333b', 'the badge cut out of the window ground');
      assert.ok(!r.pin.disabled, 'still focusable');
    }
    const before = JSON.stringify(AUTODJ.seeds.view());
    click(all[0].pin);
    assert.equal(JSON.stringify(AUTODJ.seeds.view()), before, 'a locked pin does nothing');
    // the menus: Remove and the moves work
    click(rowNamed(sb, 'more', 'Looking Back').more);
    assert.deepEqual(menuItems(sb).map((b) => b.textContent), ['autoDJ.seedLessLikeThis', 'autoDJ.seedRemove']);
    click(menuItems(sb)[1]);
    assert.ok(!titles(sb, 'more').includes('Looking Back'), 'removed in Stay close');
    click(rowNamed(sb, 'less', 'Guard Up!').more);
    click(menuItems(sb)[0]);
    assert.equal(titles(sb, 'more')[0], 'Guard Up!', 'moved in Stay close');
  });

  test('Less like on an old server: the reason, rows dimmed, Add song off, Less like this off', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox({ server: { autoDj: 0 } });
    await openDrawer(sb);
    const reason = sb.$('dj-seeds-less-reason');
    assert.equal(reason.textContent, 'autoDJ.needsNewerServer');
    const siblings = reason.parentNode.children;
    assert.equal(siblings[siblings.indexOf(reason) - 1].id, 'dj-seeds-less-h', 'right under Less like\'s heading');
    const lessUl = sb.dialog().querySelectorAll('.dj-seeds-list').find((u) => u.getAttribute('data-list') === 'less');
    assert.equal(lessUl.getAttribute('aria-describedby'), 'dj-seeds-less-reason');
    for (const r of rowsOf(sb, 'less')) {
      assert.ok(r.dim, `${r.title} dimmed`);
      assert.ok(r.inert, `${r.title}: its pin inert`);
    }
    assert.ok(rowsOf(sb, 'more').every((r) => !r.dim && !r.inert), 'More like works');
    assert.ok(addSongOf(sb, 'less').disabled, 'Less like\'s Add song off');
    assert.ok(!addSongOf(sb, 'more').disabled);
    click(rowNamed(sb, 'less', 'Guard Up!').pin);
    assert.deepEqual(viewKeys('less')[0], [keyOf('Guard Up!'), true], 'a dimmed pin does nothing');
    // More like's menus: Less like this off (and pressing it does nothing)
    click(rowNamed(sb, 'more', 'Fayz').more);
    assert.equal(menuItems(sb)[0].getAttribute('aria-disabled'), 'true');
    click(menuItems(sb)[0]);
    assert.ok(titles(sb, 'more').includes('Fayz') && sb.$('dj-seeds-menu'), 'nothing moved, the menu stays');
    // a Less like row's ⋮ still works
    click(rowNamed(sb, 'less', 'Guard Up!').more);
    assert.equal(menuItems(sb)[0].getAttribute('aria-disabled'), null, 'More like this');
    click(menuItems(sb)[1]);
    assert.deepEqual(titles(sb, 'less'), ['Bout2skate'], 'Remove works');
    // before the ping answers: inert, no reason
    const early = makeSandbox({ server: { autoDj: undefined } });
    await openDrawer(early);
    assert.equal(early.$('dj-seeds-less-reason'), null);
    assert.ok(rowsOf(early, 'less').every((r) => r.dim && r.inert));
    assert.ok(addSongOf(early, 'less').disabled);
    // a server that takes negatives: none of it
    const ok = makeSandbox({ server: { autoDj: 1 } });
    await openDrawer(ok);
    assert.equal(ok.$('dj-seeds-less-reason'), null);
    assert.deepEqual(rowsOf(ok, 'less').map((r) => [r.title, r.dim, r.inert]), [['Bout2skate', false, false]]);
    assert.ok(!addSongOf(ok, 'less').disabled);
  });

  test('Less like this is off on a peer row', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.onPlay(song('Remote', { owner: 7, art: 'r.jpg' }), { lanePick: true, now: T + 1 });
    AUTODJ.seeds.add('more', song('Local'), T + 2);
    const sb = makeSandbox();
    await openDrawer(sb);
    assert.equal(rowNamed(sb, 'more', 'Remote').art, peerArtUrl(7, 'r.jpg', 's'), 'a peer row\'s cover through the art proxy');
    click(rowNamed(sb, 'more', 'Remote').more);
    assert.equal(menuItems(sb)[0].getAttribute('aria-disabled'), 'true');
    click(menuItems(sb)[0]);
    assert.ok(titles(sb, 'more').includes('Remote') && !titles(sb, 'less').includes('Remote'));
    click(rowNamed(sb, 'more', 'Local').more);
    assert.equal(menuItems(sb)[0].getAttribute('aria-disabled'), null, 'this server\'s row moves');
  });

  test('the box reflects clearPinsOnQueueClear and works in both modes', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await openDrawer(sb);
    const box = sb.$('dj-seeds-clear-pins');
    assert.equal(box.getAttribute('type'), 'checkbox');
    assert.equal(box.checked, false, 'off by default');
    const label = box.closest('label');
    assert.equal(label.className, 'dj-check');
    assert.equal(label.textContent, 'autoDJ.seedsClearPins', 'the label names it');
    assert.equal(box.parentNode.querySelector('.dj-check-box').getAttribute('aria-hidden'), 'true');
    box.checked = true;
    fire(box, 'change');
    assert.equal(AUTODJ.state.clearPinsOnQueueClear, true);
    // in Stay close too
    click(sb.dialog().querySelectorAll('.dj-seeds-mode-btn')[1]);
    assert.equal(sb.$('dj-seeds-clear-pins'), box);
    box.checked = false;
    fire(box, 'change');
    assert.equal(AUTODJ.state.clearPinsOnQueueClear, false);
    box.checked = true;
    fire(box, 'change');
    // drawn as stored
    press(sb.doc, 'Escape');
    click(sb.$('dj-seeds-btn'));
    assert.equal(sb.$('dj-seeds-clear-pins').checked, true);
  });
});

describe('the Seeds drawer: the row menu', () => {
  test('Escape closes the menu first, the drawer stays', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox();
    await openDrawer(sb);
    const sky = rowNamed(sb, 'more', 'SkyWalk');
    click(sky.more);
    const menu = sb.$('dj-seeds-menu');
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(menu.getAttribute('aria-label'), 'autoDJ.seedMore{"title":"SkyWalk"}');
    assert.equal(menu.parentNode, sky.li, 'the row\'s last child');
    assert.equal(sky.li.children[sky.li.children.length - 1], menu);
    assert.equal(sky.more.getAttribute('aria-expanded'), 'true');
    assert.equal(sky.more.getAttribute('aria-controls'), 'dj-seeds-menu');
    assert.equal(sb.doc.activeElement, menuItems(sb)[0], 'open: the keyboard on the first item');
    assert.deepEqual(menuItems(sb).map((b) => [b.textContent, b.getAttribute('role')]), [['autoDJ.seedLessLikeThis', 'menuitem'], ['autoDJ.seedRemove', 'menuitem']]);
    press(sb.doc, 'Escape');
    assert.equal(sb.$('dj-seeds-menu'), null, 'the menu closed');
    assert.ok(sb.dialog(), 'the drawer stays');
    assert.equal(sb.doc.activeElement, sky.more, 'the keyboard back on ⋮');
    assert.equal(sky.more.getAttribute('aria-expanded'), 'false');
    assert.ok(!sky.more.hasAttribute('aria-controls'));
    press(sb.doc, 'Escape');
    assert.equal(sb.dialog(), null, 'the next Esc closes the drawer');
  });

  test('its keys, and a press outside', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox();
    await openDrawer(sb);
    const fayz = rowNamed(sb, 'more', 'Fayz');
    fayz.more.focus();
    press(sb.doc, 'ArrowDown');
    assert.equal(sb.doc.activeElement, menuItems(sb)[0], 'Down on ⋮: the first item');
    press(sb.doc, 'ArrowDown');
    assert.equal(sb.doc.activeElement, menuItems(sb)[1]);
    press(sb.doc, 'ArrowDown');
    assert.equal(sb.doc.activeElement, menuItems(sb)[0], 'Down cycles');
    press(sb.doc, 'ArrowUp');
    assert.equal(sb.doc.activeElement, menuItems(sb)[1], 'Up cycles');
    press(sb.doc, 'Home');
    assert.equal(sb.doc.activeElement, menuItems(sb)[0]);
    press(sb.doc, 'End');
    assert.equal(sb.doc.activeElement, menuItems(sb)[1]);
    press(sb.doc, 'Escape');
    press(sb.doc, 'ArrowUp');
    assert.equal(sb.doc.activeElement, menuItems(sb)[1], 'Up on ⋮: the last item');
    // Tab closes it from ⋮, and the browser's Tab moves on from there
    press(sb.doc, 'Tab');
    assert.equal(sb.$('dj-seeds-menu'), null);
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'Better Days').pin, 'the next control after Fayz\'s ⋮');
    // one menu at a time
    click(rowNamed(sb, 'more', 'Fayz').more);
    click(rowNamed(sb, 'more', 'SkyWalk').more);
    assert.equal(sb.doc.querySelectorAll('[role="menu"]').length, 1);
    assert.equal(sb.$('dj-seeds-menu').parentNode, rowNamed(sb, 'more', 'SkyWalk').li);
    assert.equal(rowNamed(sb, 'more', 'Fayz').more.getAttribute('aria-expanded'), 'false');
    // ⋮ again closes it
    click(rowNamed(sb, 'more', 'SkyWalk').more);
    assert.equal(sb.$('dj-seeds-menu'), null);
    // a press outside closes it in place: the pressed pin still takes the press
    click(rowNamed(sb, 'more', 'SkyWalk').more);
    const pin = rowNamed(sb, 'more', 'Better Days').pin;
    click(pin);
    assert.equal(sb.$('dj-seeds-menu'), null, 'closed by the press');
    assert.equal(rowNamed(sb, 'more', 'Better Days').pressed, 'true', 'and the pin took it');
    // a press inside it does not
    click(rowNamed(sb, 'more', 'SkyWalk').more);
    fire(sb.$('dj-seeds-menu'), 'mousedown');
    assert.ok(sb.$('dj-seeds-menu'));
    // a menu that would hang past the drawer's body opens upward
    press(sb.doc, 'Escape');
    const looking = rowNamed(sb, 'more', 'Looking Back');
    sb.dialog().querySelector('.dj-seeds-body').rect = { top: 0, bottom: 400 };
    const origInsert = looking.li.insertAdjacentHTML.bind(looking.li);
    looking.li.insertAdjacentHTML = (where, html) => { origInsert(where, html); looking.li.querySelector('.dj-seeds-menu').rect = { top: 380, bottom: 480 }; };
    click(looking.more);
    assert.ok(sb.$('dj-seeds-menu').classList.contains('is-up'));
  });

  test('a move lands pinned in the other list with focus on its ⋮', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox();
    await openDrawer(sb);
    click(rowNamed(sb, 'more', 'Better Days').more);
    click(menuItems(sb)[0]);
    assert.equal(sb.$('dj-seeds-menu'), null);
    assert.deepEqual(titles(sb, 'less'), ['Better Days', 'Guard Up!', 'Bout2skate'], 'the newest Less like row');
    assert.ok(!titles(sb, 'more').includes('Better Days'));
    assert.equal(rowNamed(sb, 'less', 'Better Days').pressed, 'true', 'pinned');
    assert.deepEqual(viewKeys('less')[0], [keyOf('Better Days'), true]);
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'less', 'Better Days').more, 'the keyboard on its ⋮ there');
    // and back: More like this
    click(rowNamed(sb, 'less', 'Bout2skate').more);
    assert.equal(menuItems(sb)[0].textContent, 'autoDJ.seedMoreLikeThis');
    click(menuItems(sb)[0]);
    assert.equal(titles(sb, 'more')[0], 'Bout2skate');
    assert.equal(rowNamed(sb, 'more', 'Bout2skate').pressed, 'true');
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'Bout2skate').more);
  });

  test('Remove focuses the next row\'s ⋮, else the previous, else Add song', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    for (const n of ['c', 'b', 'a']) { AUTODJ.seeds.add('more', song(n), T + n.charCodeAt(0)); }
    const sb = makeSandbox();
    await openDrawer(sb);
    assert.deepEqual(titles(sb, 'more'), ['a', 'b', 'c']);
    click(rowNamed(sb, 'more', 'a').more);
    click(menuItems(sb)[1]);
    assert.deepEqual(titles(sb, 'more'), ['b', 'c']);
    assert.deepEqual(viewKeys('more').map((k) => k[0]), [keyOf('b'), keyOf('c')]);
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'b').more, 'the row now in its place');
    click(rowNamed(sb, 'more', 'c').more);
    click(menuItems(sb)[1]);
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'b').more, 'the last row: the one before');
    click(rowNamed(sb, 'more', 'b').more);
    click(menuItems(sb)[1]);
    assert.deepEqual(titles(sb, 'more'), []);
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'more'), 'the only row: Add song');
  });
});

describe('the Seeds drawer: the Add song step', () => {
  // The queue: Playing (the current row), then Next, a connected server's
  // row and Guard (in Less like already); the ring holds Skip1; Recently
  // played answers Old, then Next again.
  function queueSandbox(opts = {}) {
    const sb = makeSandbox({
      recent: [{ filepath: 'music/Old.mp3', metadata: { title: 'Old', artist: 'Old artist', 'album-art': 'old.jpg' } },
        { filepath: 'music/Next.mp3', metadata: { title: 'Next' } }],
      ...opts,
    });
    const playing = queueRow('Playing');
    sb.player.playlist = [queueRow('Before'), playing, queueRow('Next'), queueRow('Far', { federation: { peerId: 7, peerName: 'Peer' } }), queueRow('Guard')];
    sb.player.positionCache.val = 1;
    sb.player.current = playing;
    AUTODJ.seeds.noteSkip(song('Skip1', { artist: 'S' }));
    return sb;
  }

  test('the library row, the search field (focused), then Up next, Skipped (Less like only), Recently played', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.add('less', song('Guard'), T);
    const sb = queueSandbox();
    await openDrawer(sb);
    click(addSongOf(sb, 'less'));
    const body = sb.$('dj-add-body');
    const [library, search, results] = body.children;
    assert.equal(library.id, 'dj-add-library');
    assert.equal(library.className, 'dj-seeds-add dj-seeds-library');
    assert.equal(library.textContent, 'autoDJ.addSongFromLibrary');
    assert.ok(library.querySelector('.dj-seeds-add-ic svg rect'), 'the library icon');
    assert.equal(search.localName, 'label');
    assert.equal(search.className, 'dj-add-search');
    const field = sb.$('dj-add-search');
    assert.equal(field.parentNode, search);
    assert.equal(field.getAttribute('type'), 'search');
    assert.deepEqual(field.className.split(' '), ['dj-filter-input', 'browser-default']);
    assert.equal(field.getAttribute('placeholder'), 'autoDJ.sonicSeedPlaceholder');
    assert.equal(field.getAttribute('aria-label'), 'autoDJ.sonicSeedPlaceholder');
    assert.equal(field.getAttribute('autocomplete'), 'off');
    assert.equal(sb.doc.activeElement, field, 'the step opens with the keyboard in the field');
    assert.equal(results.id, 'dj-add-results');
    // before Recently played lands
    assert.deepEqual(sectionsOf(sb), {
      'autoDJ.addSongUpNext': ['Next'],
      'autoDJ.addSongSkipped': ['Playing (playing)', 'Skip1'],
    });
    await settle();
    assert.deepEqual(sb.api.recentAsks, [{ limit: 20, ignoreVPaths: ['Live'] }], 'asked once, the hidden libraries left out');
    assert.deepEqual(sectionsOf(sb), {
      'autoDJ.addSongUpNext': ['Next'],
      'autoDJ.addSongSkipped': ['Playing (playing)', 'Skip1'],
      'autoDJ.addSongRecent': ['Old'],
    }, 'Next shows once, in Up next; a connected server\'s row and a song Less like holds are not offered');
    const playingRow = pickNamed(sb, 'Playing');
    assert.equal(playingRow.getAttribute('aria-current'), 'true');
    assert.equal(pickNamed(sb, 'Old').querySelector('img').getAttribute('src'), localArt('old.jpg'));
    assert.equal(pickNamed(sb, 'Next').querySelector('.dj-seed-artist').textContent, 'Next artist');
    // More like's: no Skipped
    click(sb.dialog().querySelector('.dj-seeds-back'));
    click(addSongOf(sb, 'more'));
    await settle();
    assert.deepEqual(Object.keys(sectionsOf(sb)), ['autoDJ.addSongUpNext', 'autoDJ.addSongRecent']);
    assert.deepEqual(sectionsOf(sb)['autoDJ.addSongUpNext'], ['Next', 'Guard'], 'a song in the other list stays offered');
    // a failed Recently played shows nothing
    const failed = queueSandbox({ recent: () => Promise.reject(new Error('down')) });
    await openDrawer(failed);
    click(addSongOf(failed, 'more'));
    await settle();
    assert.deepEqual(Object.keys(sectionsOf(failed)), ['autoDJ.addSongUpNext']);
  });

  test('a hit already in the list is dimmed and aria-disabled', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.add('more', song('Taken'), T);
    const sb = queueSandbox();
    await openDrawer(sb);
    click(addSongOf(sb, 'more'));
    const field = sb.$('dj-add-search');
    typeInto(field, 's');
    assert.deepEqual(sb.timers.pending(), [], 'one character: no search');
    typeInto(field, 'sk');
    assert.deepEqual(sb.timers.pending(), [300], 'two: one once typing pauses');
    assert.deepEqual(sectionsOf(sb), {}, 'the sections give way to the hits');
    sb.timers.run((ms) => ms === 300);
    assert.equal(sb.api.searches.length, 1);
    assert.deepEqual(sb.api.searches[0].body, { search: 'sk', noArtists: true, noAlbums: true, noFiles: true, noLyrics: true });
    sb.api.searches[0].resolve({ title: [searchHit('Taken'), searchHit('Fresh'), ...Array.from({ length: 9 }, (_, i) => searchHit(`h${i}`))] });
    await settle();
    const drawn = sectionsOf(sb).hits;
    assert.equal(drawn.length, 8, 'the first eight hits');
    assert.deepEqual(drawn.slice(0, 2), ['Taken (taken)', 'Fresh']);
    assert.equal(sb.$('dj-add-hits').parentNode, sb.$('dj-add-results'));
    assert.equal(sb.$('dj-add-results').querySelectorAll('h3').length, 0, 'no heading');
    const taken = pickNamed(sb, 'Taken');
    assert.equal(taken.getAttribute('aria-disabled'), 'true');
    click(taken);
    assert.equal(sb.S.ui.step, 'add', 'a taken hit does nothing');
    assert.deepEqual(viewKeys('more'), [[keyOf('Taken'), true]]);
    assert.equal(pickNamed(sb, 'Fresh').querySelector('img').getAttribute('src'), localArt('Fresh.jpg'));
    // no hits: nothing
    typeInto(field, 'sky');
    sb.timers.run();
    sb.api.searches[1].resolve({ title: [] });
    await settle();
    assert.deepEqual(sectionsOf(sb), {});
    assert.equal(sb.$('dj-add-results').children.length, 0);
    // under two characters the sections come back at once
    typeInto(field, 's');
    assert.deepEqual(Object.keys(sectionsOf(sb)), ['autoDJ.addSongUpNext', 'autoDJ.addSongRecent']);
  });

  test('an older search answer never replaces a newer', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = queueSandbox();
    await openDrawer(sb);
    click(addSongOf(sb, 'more'));
    const field = sb.$('dj-add-search');
    typeInto(field, 'ab');
    sb.timers.run();
    typeInto(field, 'abc');
    sb.timers.run();
    assert.deepEqual(sb.api.searches.map((s) => s.body.search), ['ab', 'abc']);
    sb.api.searches[1].resolve({ title: [searchHit('Newer')] });
    await settle();
    assert.deepEqual(sectionsOf(sb).hits, ['Newer']);
    sb.api.searches[0].resolve({ title: [searchHit('Older')] });
    await settle();
    assert.deepEqual(sectionsOf(sb).hits, ['Newer'], 'the older answer is dropped');
    // Enter searches at once; back under two characters an answer still out is dropped
    typeInto(field, 'abcd');
    press(sb.doc, 'Enter');
    assert.deepEqual(sb.timers.pending(), [], 'no wait');
    assert.equal(sb.api.searches.length, 3);
    typeInto(field, 'a');
    sb.api.searches[2].resolve({ title: [searchHit('Late')] });
    await settle();
    assert.ok(!('hits' in sectionsOf(sb)), 'the sections stay');
  });

  test('a pick adds the song pinned to the list it was opened for and returns to the lists, focus on that Add song', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    liveLane(T);
    AUTODJ.seeds.add('more', song('Guard'), T);
    const sb = queueSandbox({ djOn: true });
    await openDrawer(sb);
    click(addSongOf(sb, 'less'));
    await settle();
    click(pickNamed(sb, 'Guard'));
    assert.equal(sb.S.ui.step, 'lists');
    assert.deepEqual(viewKeys('less'), [[keyOf('Guard'), true]], 'pinned in Less like');
    assert.deepEqual(viewKeys('more'), [], 'out of More like (a move)');
    assert.equal(rowNamed(sb, 'less', 'Guard').artist, 'Guard artist', 'with its facts');
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'less'), 'the keyboard on Less like\'s Add song');
    assert.equal(sb.dialog().getAttribute('aria-labelledby'), 'dj-seeds-title');
    assert.deepEqual(sb.log.filter((x) => x === 'kick'), [], 'a Less like pick kicks nothing');
    // More like: a search hit, with its art
    click(addSongOf(sb, 'more'));
    typeInto(sb.$('dj-add-search'), 'fr');
    sb.timers.run();
    sb.api.searches[0].resolve({ title: [searchHit('Fresh')] });
    await settle();
    click(pickNamed(sb, 'Fresh'));
    assert.deepEqual(viewKeys('more'), [[keyOf('Fresh'), true]]);
    assert.equal(rowNamed(sb, 'more', 'Fresh').art, localArt('Fresh.jpg'));
    assert.equal(rowNamed(sb, 'more', 'Fresh').artist, 'Artist');
    assert.deepEqual(sb.log.filter((x) => x === 'kick'), ['kick'], 'a More like pick may start a stalled DJ');
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'more'));
    // a list that filled meanwhile takes nothing, and the step still returns
    for (let i = 0; i < 6; i++) { AUTODJ.seeds.add('less', song(`p${i}`), T + 10 + i); }
    click(addSongOf(sb, 'less'));
    await settle();
    assert.equal(sb.S.ui.step, 'add', 'seven rows: room for one');
    AUTODJ.seeds.add('less', song('p6'), T + 20);
    const full = viewKeys('less');
    assert.equal(full.length, 8);
    click(pickNamed(sb, 'Next'));
    assert.deepEqual(viewKeys('less'), full, 'refused silently');
    assert.equal(sb.S.ui.step, 'lists');
    assert.equal(sb.doc.activeElement, rowsOf(sb, 'less')[0].more, 'Add song is off: the list\'s newest row\'s ⋮');
  });

  test('Go Back returns with focus on Add song', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = queueSandbox();
    await openDrawer(sb);
    click(addSongOf(sb, 'less'));
    typeInto(sb.$('dj-add-search'), 'abc');
    const back = sb.dialog().querySelector('.dj-seeds-back');
    assert.equal(back.getAttribute('aria-label'), 'tooltip.goBack');
    click(back);
    assert.equal(sb.S.ui.step, 'lists');
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'less'));
    assert.deepEqual(sb.timers.pending().filter((ms) => ms === 300), [], 'the search waiting to run is dropped');
    click(addSongOf(sb, 'less'));
    assert.equal(sb.$('dj-add-search').value, '', 'a new step starts empty');
  });
});

describe('the Seeds drawer: the library pick', () => {
  // The drawer open on Add song for [list], then its library row pressed.
  async function pickFromLibrary(sb, list) {
    await openDrawer(sb);
    click(addSongOf(sb, list));
    click(sb.$('dj-add-library'));
  }
  const fileRow = (sb, filepath, peer) => {
    const el = sb.doc.createElement('div');
    el.setAttribute('data-file_location', filepath);
    if (peer !== undefined) { el.setAttribute('data-peer', String(peer)); }
    return el;
  };
  const banner = (sb) => sb.$('spath-banner');

  test('the row closes the drawer, arms a seeds capture, shows the list\'s banner and opens the File Explorer', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    for (const list of ['more', 'less']) {
      const sb = makeSandbox();
      await pickFromLibrary(sb, list);
      assert.equal(sb.dialog(), null, 'the drawer closed');
      assert.equal(sb.$('dj-seeds-btn').getAttribute('aria-expanded'), 'false');
      assert.equal(typeof sb.vpc.songCapture, 'function');
      assert.equal(sb.vpc.songCapture.seeds, list, 'a seeds capture, for its list');
      assert.equal(banner(sb).querySelector('span').textContent, list === 'more' ? 'autoDJ.seedPickBannerMore' : 'autoDJ.seedPickBannerLess');
      assert.equal(banner(sb).querySelector('.spath-banner-cancel').textContent, 'sonicPath.cancelPick');
      assert.deepEqual(sb.log.slice(-2), ['view:nav-explorer', 'explorer'], 'the File Explorer');
    }
  });

  test('a captured row is looked up, added pinned, and the Auto DJ page comes back with the drawer open on its lists', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await pickFromLibrary(sb, 'less');
    sb.S.onFileClick(fileRow(sb, '/music/Picked.flac'));
    assert.equal(sb.vpc.songCapture, null, 'one-shot');
    assert.equal(banner(sb), null, 'the banner goes');
    assert.deepEqual(sb.api.lookups.map((l) => l.filepath), ['/music/Picked.flac'], 'its title, artist and art looked up');
    sb.api.lookups[0].resolve({ metadata: { title: 'Picked', artist: 'Picker', 'album-art': 'pk.jpg' } });
    await settle();
    assert.equal(sb.lastView().el.id, 'nav-auto-dj', 'back to Auto DJ');
    await sb.lastView().fn;
    await settle();
    assert.ok(sb.dialog(), 'the drawer is open again');
    assert.equal(sb.S.ui.step, 'lists', 'on its lists');
    assert.deepEqual(viewKeys('less'), [[AUTODJ.seeds.keyOf(null, 'music/Picked.flac'), true]], 'pinned in Less like');
    const row = rowNamed(sb, 'less', 'Picked');
    assert.equal(row.artist, 'Picker');
    assert.equal(row.art, localArt('pk.jpg'));
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'less'), 'the keyboard on that list\'s Add song');
    assert.deepEqual(sb.log.filter((x) => x === 'kick'), [], 'Less like kicks nothing');
    // a row that carries its title is taken as it is; a failed lookup
    // falls back to the file name
    click(addSongOf(sb, 'more'));
    click(sb.$('dj-add-library'));
    sb.S.onFileClick(fileRow(sb, '/music/Bare.flac'));
    sb.api.lookups[1].reject(new Error('down'));
    await settle();
    await sb.lastView().fn;
    await settle();
    assert.equal(rowsOf(sb, 'more')[0].title, 'Bare.flac');
  });

  test('Cancel comes back with nothing added', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await pickFromLibrary(sb, 'more');
    const before = JSON.stringify(AUTODJ.seeds.view());
    click(banner(sb).querySelector('.spath-banner-cancel'));
    assert.equal(sb.vpc.songCapture, null);
    assert.equal(banner(sb), null);
    await sb.lastView().fn;
    await settle();
    assert.ok(sb.dialog(), 'the drawer is back');
    assert.equal(sb.S.ui.step, 'lists');
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'more'));
    assert.equal(JSON.stringify(AUTODJ.seeds.view()), before, 'nothing added');
  });

  test('a peer row is refused and the capture stays armed', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await pickFromLibrary(sb, 'more');
    const capture = sb.vpc.songCapture;
    sb.S.onFileClick(fileRow(sb, '/music/Theirs.flac', 7));
    assert.deepEqual(sb.toasts.map((o) => o.title), ['sonicPath.federatedTrack']);
    assert.equal(sb.vpc.songCapture, capture, 'still armed');
    assert.ok(banner(sb), 'its banner up');
    assert.deepEqual(sb.api.lookups, []);
    assert.ok(!sb.log.some((x) => Array.isArray(x) && x[0] === 'queue'), 'nothing queued');
    // then a row of this server's is taken
    sb.S.onFileClick(fileRow(sb, '/music/Mine.flac'));
    sb.api.lookups[0].resolve({ metadata: { title: 'Mine' } });
    await settle();
    assert.deepEqual(viewKeys('more'), [[AUTODJ.seeds.keyOf(null, 'music/Mine.flac'), true]]);
  });

  test('entering Auto DJ from the nav disarms a leftover seeds capture', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await pickFromLibrary(sb, 'less');
    assert.ok(sb.vpc.songCapture && banner(sb));
    await sb.S.autoDjPanel();
    assert.equal(sb.vpc.songCapture, null, 'disarmed');
    assert.equal(banner(sb), null, 'its banner gone');
    assert.equal(sb.dialog(), null, 'the nav opens no drawer');
    // another page's pick (Sonic Path's) is left as it is
    const sonic = () => {};
    sb.vpc.songCapture = sonic;
    await sb.S.autoDjPanel();
    assert.equal(sb.vpc.songCapture, sonic);
  });

  test('Discover and Sonic Path clear a seeds capture when they hide the banner; Discover\'s own capture behaves as before', () => {
    // The statement each page runs right after sonicPathHideBanner(), run
    // against each kind of capture.
    const disarmOf = (fn) => {
      const src = sliceFn(fn);
      const at = src.indexOf('sonicPathHideBanner();');
      assert.ok(at >= 0, `${fn} hides the banner`);
      const rest = src.slice(at + 'sonicPathHideBanner();'.length).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
      assert.match(rest[0], /^if \(VUEPLAYERCORE\.songCapture/, `${fn}: the disarm follows the banner's hide`);
      return (capture) => {
        const vpc = { songCapture: capture };
        new Function('VUEPLAYERCORE', rest[0])(vpc);
        return vpc.songCapture;
      };
    };
    const seedsPick = Object.assign(() => {}, { seeds: 'more' });
    const dpagePick = Object.assign(() => {}, { dpage: true });
    const sonicPick = () => {};
    const discover = disarmOf('discoveryPanel');
    assert.equal(discover(seedsPick), null, 'Discover clears a seeds capture');
    assert.equal(discover(dpagePick), null, 'and its own, as before');
    assert.equal(discover(sonicPick), sonicPick, 'Sonic Path\'s stays, as before');
    assert.equal(discover(null), null);
    const sonicPath = disarmOf('sonicPathPanel');
    assert.equal(sonicPath(seedsPick), null, 'Sonic Path clears a seeds capture');
    assert.equal(sonicPath(sonicPick), sonicPick, 'its own stays (its pick comes back to it)');
    assert.equal(sonicPath(dpagePick), dpagePick);
    assert.equal(sonicPath(null), null);
  });

  test('a More like pick with the DJ on and the queue empty kicks the DJ', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox({ djOn: true });
    await pickFromLibrary(sb, 'more');
    sb.S.onFileClick(fileRow(sb, '/music/Starter.flac'));
    sb.api.lookups[0].resolve({ metadata: { title: 'Starter' } });
    await settle();
    assert.deepEqual(sb.log.filter((x) => x === 'kick'), ['kick'], 'autoDjKick (it starts only a DJ on an empty queue)');
    assert.ok(sb.log.indexOf('kick') < sb.log.lastIndexOf('view:nav-auto-dj'), 'before the page comes back');
    // a refused add kicks nothing: a full More like
    const full = makeSandbox({ djOn: true });
    liveLane(Date.now());
    for (let i = 0; i < 8; i++) { AUTODJ.seeds.add('more', song(`p${i}`), Date.now() + i); }
    await openDrawer(full);
    click(full.dialog().querySelectorAll('.dj-seeds-mode-btn')[0]);
    full.S.autoDjSeedsPickFromLibrary('more');
    full.S.onFileClick(fileRow(full, '/music/Late.flac'));
    full.api.lookups[0].resolve({ metadata: { title: 'Late' } });
    await settle();
    assert.deepEqual(full.log.filter((x) => x === 'kick'), []);
  });

  test('Cancel from a connected server\'s library comes home before the page draws', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await pickFromLibrary(sb, 'more');
    // the user browsed a connected server meanwhile (the top bar's switcher)
    sb.S.browse.peerContext = { id: 7, name: 'Peer' };
    const gen = sb.S.browse.browseGeneration;
    sb.log.length = 0;
    click(banner(sb).querySelector('.spath-banner-cancel'));
    assert.equal(sb.S.browse.peerContext, null, 'home');
    assert.equal(sb.S.browse.browseGeneration, gen + 1, 'the connected server\'s loads superseded');
    assert.deepEqual(sb.S.browse.fileExplorerArray, [], 'its folder trail dropped');
    assert.deepEqual(sb.log.slice(0, 2), ['serverContext', 'view:nav-auto-dj'], 'the chrome follows home before the page draws');
    await sb.lastView().fn;
    await settle();
    assert.ok(sb.dialog());
    // at home already: nothing to do
    const home = makeSandbox();
    await pickFromLibrary(home, 'less');
    home.log.length = 0;
    click(banner(home).querySelector('.spath-banner-cancel'));
    assert.deepEqual(home.log.slice(0, 1), ['view:nav-auto-dj']);
    assert.equal(home.S.browse.browseGeneration, 0);
  });
});

describe('the Seeds drawer: live refresh', () => {
  test('a seeds change re-renders the rows and keeps focus by key', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const T = Date.now();
    boardSeeds(T);
    const sb = makeSandbox();
    await openDrawer(sb);
    const fayz = rowNamed(sb, 'more', 'Fayz');
    fayz.pin.focus();
    // a DJ pick starts playing: it joins More like
    AUTODJ.seeds.onPlay(song('Fresh pick', { art: 'fp.jpg' }), { lanePick: true, now: T + 100 });
    assert.equal(titles(sb, 'more')[0], 'Fresh pick', 'redrawn with the new row');
    assert.notEqual(rowNamed(sb, 'more', 'Fayz').pin, fayz.pin, 'the rows were redrawn');
    assert.equal(sb.doc.activeElement, rowNamed(sb, 'more', 'Fayz').pin, 'the keyboard on Fayz\'s pin again');
    // a lookup fills a row's facts
    AUTODJ.seeds.fillFacts(keyOf('Better Days'), { title: 'Better Days', artist: 'Filled', art: 'bd.jpg' });
    assert.equal(rowNamed(sb, 'more', 'Better Days').artist, 'Filled');
    // a redraw that changes nothing leaves the rows be
    const same = rowNamed(sb, 'more', 'Fayz').pin;
    sb.song('song');
    sb.song('queue');
    assert.equal(rowNamed(sb, 'more', 'Fayz').pin, same);
    // a mode change from elsewhere: the mode and the pins follow
    AUTODJ.seeds.setMode('locked');
    assert.deepEqual(sb.dialog().querySelectorAll('.dj-seeds-mode-btn').map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
    assert.ok(rowsOf(sb, 'more').every((r) => r.inert && r.pressed === 'true'));
  });

  test('a row that left closes its menu and moves focus to the list\'s Add song', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    boardSeeds(Date.now());
    const sb = makeSandbox();
    await openDrawer(sb);
    click(rowNamed(sb, 'more', 'Better Days').more);
    assert.equal(sb.doc.activeElement, menuItems(sb)[0]);
    AUTODJ.seeds.remove(keyOf('Better Days'));
    assert.equal(sb.$('dj-seeds-menu'), null, 'the menu went with its row');
    assert.equal(sb.S.ui.menuKey, null);
    assert.equal(sb.doc.activeElement, addSongOf(sb, 'more'), 'the keyboard on its list\'s Add song');
    // a menu whose row stays stays open, its item keeping the keyboard
    click(rowNamed(sb, 'more', 'Fayz').more);
    press(sb.doc, 'ArrowDown');
    AUTODJ.seeds.onPlay(song('Another'), { lanePick: true, now: Date.now() });
    assert.ok(sb.$('dj-seeds-menu'));
    assert.equal(sb.$('dj-seeds-menu').parentNode, rowNamed(sb, 'more', 'Fayz').li);
    assert.equal(sb.doc.activeElement, menuItems(sb)[1], 'on Remove still');
  });

  test('a song change refreshes Up next and Skipped, keeping the query', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const a = queueRow('A');
    const b = queueRow('B');
    sb.player.playlist = [a, b, queueRow('C')];
    sb.player.positionCache.val = 0;
    sb.player.current = a;
    await openDrawer(sb);
    click(addSongOf(sb, 'less'));
    const field = sb.$('dj-add-search');
    typeInto(field, 'x');
    assert.deepEqual(sectionsOf(sb), { 'autoDJ.addSongUpNext': ['B', 'C'], 'autoDJ.addSongSkipped': ['A (playing)'] });
    // the next song plays
    sb.player.positionCache.val = 1;
    sb.player.current = b;
    sb.song('song');
    assert.deepEqual(sectionsOf(sb), { 'autoDJ.addSongUpNext': ['C'], 'autoDJ.addSongSkipped': ['B (playing)'] });
    assert.equal(sb.$('dj-add-search'), field, 'the field is never redrawn');
    assert.equal(field.value, 'x');
    assert.equal(sb.doc.activeElement, field);
    // a row queued
    sb.player.playlist.push(queueRow('D'));
    sb.song('queue');
    assert.deepEqual(sectionsOf(sb)['autoDJ.addSongUpNext'], ['C', 'D']);
    // with hits on screen, they stay
    typeInto(field, 'xy');
    sb.timers.run();
    sb.api.searches[0].resolve({ title: [searchHit('Hit')] });
    await settle();
    sb.player.positionCache.val = 2;
    sb.song('song');
    assert.deepEqual(sectionsOf(sb), { hits: ['Hit'] });
    assert.equal(field.value, 'xy');
  });

  test('a skip event refreshes Skipped', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    await openDrawer(sb);
    click(addSongOf(sb, 'less'));
    assert.deepEqual(sectionsOf(sb), {});
    AUTODJ.seeds.noteSkip(song('Skipped now', { artist: 'S' }));
    sb.song('skip');
    assert.deepEqual(sectionsOf(sb), { 'autoDJ.addSongSkipped': ['Skipped now'] });
  });

  test('a Less like row running out redraws the open drawer', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
      liveLane(clock);
      AUTODJ.seeds.onPlay(song('Brief'), { lanePick: true, now: clock });
      AUTODJ.seeds.quickSkip(song('Brief'), { djPick: true, learn: true, now: clock + 1 });
      AUTODJ.seeds.add('less', song('Kept'), clock + 2);
      clock += 60_000;
      const sb = makeSandbox();
      await openDrawer(sb);
      assert.deepEqual(titles(sb, 'less'), ['Kept', 'Brief']);
      // Brief was learned at T0 + 1: its 30 minutes end at T0 + 1 + ttl
      const ends = 1_700_000_000_001 + AUTODJ._internals.SEEDS.LESS_LIKE_TTL_MS;
      assert.deepEqual(sb.timers.pending(), [ends - clock], 'one timer, to the row\'s end');
      clock = ends;
      sb.timers.run();
      assert.deepEqual(titles(sb, 'less'), ['Kept'], 'gone from the drawer');
      assert.deepEqual(sb.timers.pending(), [], 'nothing else runs out');
      press(sb.doc, 'Escape');
      assert.deepEqual(sb.timers.pending(), []);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('the Seeds drawer: escaping', () => {
  test('a title <img src=x onerror=alert(1)> and a path holding " and ] draw as text in rows, labels, menus and pick rows, and the row is found again by its key after a re-render', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const evil = '<img src=x onerror=alert(1)>';
    const T = Date.now();
    liveLane(T);
    const facts = { owner: null, path: 'music/a"b].mp3', title: evil, artist: evil, album: '', art: '"><img src=x onerror=alert(2)>.jpg', duration: null };
    AUTODJ.seeds.add('more', facts, T);
    const sb = makeSandbox();
    const evilRow = { rawFilePath: 'music/q"r].mp3', filepath: 'music/q"r].mp3', metadata: { title: evil, artist: evil } };
    sb.player.playlist = [queueRow('Now'), evilRow];
    sb.player.positionCache.val = 0;
    sb.player.current = sb.player.playlist[0];
    await openDrawer(sb);
    const drawn = [];
    const listsHtml = sb.S.autoDjSeedsListsHtml(AUTODJ.seeds.view(), { lessOn: true, needsNewer: false, canAdd: { more: true, less: true }, menuKey: keyOf('x'), menuUp: false, clearPins: false });
    const key = AUTODJ.seeds.keyOf(null, 'music/a"b].mp3');
    const withMenu = sb.S.autoDjSeedsListsHtml(AUTODJ.seeds.view(), { lessOn: true, needsNewer: false, canAdd: { more: true, less: true }, menuKey: key, menuUp: false, clearPins: false });
    drawn.push(listsHtml, withMenu);
    const row = rowsOf(sb, 'more')[0];
    assert.equal(row.key, key, 'the key reads back exactly');
    assert.equal(row.title, evil, 'the title is text');
    assert.equal(row.artist, evil);
    assert.equal(row.pin.getAttribute('aria-label'), `autoDJ.seedPin${JSON.stringify({ title: evil })}`);
    assert.equal(row.more.getAttribute('aria-label'), `autoDJ.seedMore${JSON.stringify({ title: evil })}`);
    assert.equal(row.art, localArt('"><img src=x onerror=alert(2)>.jpg'));
    assert.equal(row.li.querySelectorAll('img').length, 1, 'no injected element');
    // the menu
    click(row.more);
    assert.equal(sb.$('dj-seeds-menu').getAttribute('aria-label'), `autoDJ.seedMore${JSON.stringify({ title: evil })}`);
    press(sb.doc, 'Escape');
    // the pick rows (Up next)
    click(addSongOf(sb, 'less'));
    const pick = sb.$('dj-add-results').querySelector('.dj-pick');
    assert.equal(pick.getAttribute('data-seed-key'), AUTODJ.seeds.keyOf(null, 'music/q"r].mp3'));
    assert.equal(pick.querySelector('.dj-seed-title').textContent, evil);
    assert.equal(pick.querySelector('.dj-seed-artist').textContent, evil);
    const ui = { query: '', list: 'less' };
    drawn.push(sb.S.autoDjAddResultsHtml(ui, { upNext: [AUTODJ.seeds.factsFromSong(evilRow)], skipped: [], recent: [] }, { taken: new Set(), playingKey: null }));
    // the raw markup never reaches the page
    for (const html of drawn) {
      assert.ok(!html.includes('onerror='), 'no raw markup from the data');
      assert.ok(!html.includes('<img src=x'), 'no raw tag from the data');
    }
    assert.equal(sb.doc.querySelectorAll('img').filter((el) => el.hasAttribute('onerror')).length, 0);
    // found again by its key after a redraw (a path with a quote and a bracket)
    click(sb.dialog().querySelector('.dj-seeds-back'));
    const pin = rowsOf(sb, 'more')[0].pin;
    pin.focus();
    AUTODJ.seeds.add('more', song('Other'), T + 1);
    assert.notEqual(rowsOf(sb, 'more')[1].pin, pin, 'redrawn');
    assert.equal(sb.doc.activeElement, rowsOf(sb, 'more').find((r) => r.key === key).pin, 'the keyboard back on that row\'s pin');
    click(sb.doc.activeElement);
    assert.deepEqual(viewKeys('more').find((k) => k[0] === key), [key, false], 'and its press reaches its row');
  });
});

describe('the Seeds drawer: spa.css (design B)', () => {
  const start = CSS.indexOf('/* Auto DJ seeds drawer (design B) */');
  const block = CSS.slice(start, CSS.indexOf('/* Now-playing BPM/key pills', start));
  const ruleOf = (sel) => {
    const at = block.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `${sel} has a rule`);
    return block.slice(at, block.indexOf('}', at) + 1);
  };

  test('the drawer\'s block, after the panel\'s: the shell, the rows, and the Materialize fixes', () => {
    assert.ok(start > CSS.indexOf('/* Auto DJ panel (design E) */'), 'design B\'s block follows design E\'s');
    assert.match(ruleOf('.dmodal-shadow.dj-seeds-shade'), /align-items: stretch; justify-content: flex-end; padding: 0; overflow: hidden; overflow: clip; \}/,
      'the house scrim laid out as a drawer, never scrolled by a focus while the drawer slides in');
    assert.match(ruleOf('.dj-seeds'), /width: 420px; max-width: 100%; height: 100%;[^}]*border-left: 1px solid #444c56; background: #2d333b;[^}]*box-shadow: -16px 0 48px rgba\(0,0,0,\.6\);/);
    assert.match(ruleOf('.dj-seeds-close'), /width: 44px; height: 44px;/);
    assert.match(ruleOf('.dj-seeds-body'), /overflow-y: auto; overscroll-behavior: contain;/);
    // Materialize: a focused button turns teal unless its class says otherwise
    for (const sel of ['.dj-seeds-close', '.dj-seeds-back', '.dj-seeds-mode-btn', '.dj-seed-btn', '.dj-seeds-add', '.dj-seeds-menu-item', '.dj-pick']) {
      assert.match(block, new RegExp(`\\n${sel.replace(/\./g, '\\.')}:focus \\{ background: transparent;`), `${sel}:focus keeps its ground`);
    }
    assert.match(block, /\n\.dj-seeds :focus-visible \{ outline: 2px solid #fa832b; outline-offset: -2px; \}/, 'one inset orange ring');
    assert.match(block, /\n\.dj-add-search \.dj-filter-input:focus-visible \{ outline: 2px solid #fa832b; outline-offset: 0; border-color: #fa832b; \}/, 'the field keeps its own ring');
    // the box: Materialize's own checkbox look turned off, above its (0,3,2) rules
    assert.match(block, /\n\.dj-check \.dj-check-ctl input\[type="checkbox"\] \+ \.dj-check-box::before \{ content: none; \}/);
    assert.match(block, /\n\.dj-check \.dj-check-ctl input\[type="checkbox"\] \+ \.dj-check-box::after \{ content: none; \}/);
    assert.match(block, /\n\.dj-check input\[type="checkbox"\]:checked \+ \.dj-check-box \{ border-color: #fa832b; background: #fa832b; \}/);
    assert.match(block, /\n\.dj-pick\[aria-current="true"\] \{ padding-left: 5px; border-left: 3px solid #657ee4; \}/, 'the queue\'s playing mark, without its tint');
    assert.match(block, /\n\.dj-seeds-menu\.is-up \{ top: auto; bottom: 52px; \}/);
    assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{ \.dj-seeds \{ animation: none; \} \}/);
    // this file paints every svg white (svg { fill: #FFF }, over an icon's
    // own fill="none"): an outline pin would read as pinned
    assert.match(block, /\n\.dj-seeds svg \{ fill: none; \}/);
    assert.match(block, /\n\.dj-seeds \.dj-seed-more svg, \.dj-seeds \.dj-seed-art\.is-none svg \{ fill: currentColor; \}/);
    assert.match(block, /\n\.dj-seeds-row \.dj-seeds-chev \{ fill: none; \}/, 'the Seeds row\'s chevron is a stroke');
  });

  test('the shared window rules are untouched', () => {
    assert.match(CSS, /\n\.dmodal-shadow \{\n {2}position: fixed;\n {2}inset: 0;/);
    assert.match(CSS, /\.dmodal-shadow \{ padding: 24px 0 0; align-items: flex-start; \}/, 'the phone sheet');
    assert.ok(!/\n\.dmodal-shadow \{[^}]*justify-content: flex-end/.test(CSS), 'only the drawer\'s own scrim is a drawer');
    assert.match(CSS, /\nsvg \{\n {2}fill: #FFF;\n\}/, 'the page-wide svg fill stays (the drawer counters it in its own block)');
  });
});

// Every drawn key is a real one.
test('the drawer draws only keys en.json has', async () => {
  AUTODJ.setState({ sonicEnabled: true });
  boardSeeds(Date.now());
  const sb = makeSandbox({ server: { autoDj: 0 } });
  await openDrawer(sb);
  click(rowNamed(sb, 'more', 'Fayz').more);
  const keys = new Set();
  const collect = () => {
    for (const m of serialize(sb.dialog()).matchAll(/\b((?:autoDJ|modal|tooltip|sonicPath)\.[A-Za-z]+)/g)) { keys.add(m[1]); }
  };
  collect();
  press(sb.doc, 'Escape');
  click(addSongOf(sb, 'more'));
  collect();
  click(sb.$('dj-add-library'));
  for (const m of serialize(sb.doc.body).matchAll(/\b((?:autoDJ|sonicPath)\.[A-Za-z]+)/g)) { keys.add(m[1]); }
  assert.ok(keys.size >= 20);
  assert.deepEqual([...keys].filter((k) => !(k in EN)), []);
});
