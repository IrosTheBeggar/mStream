/**
 * A small DOM for the Auto DJ drawers' tests, as a browser runs them: the
 * Seeds drawer test's own (test/unit/webapp-auto-dj-seeds-drawer.test.mjs,
 * which keeps its copy), copied verbatim and exported for the Genres
 * drawer's (test/unit/webapp-auto-dj-genres-drawer.test.mjs).
 *
 * Markup parsed into a tree; compound selectors (tag, #id, .class, [attr],
 * [attr="v"], [attr^="v"]) in lists and with the descendant combinator;
 * focus (only a connected, enabled control, or one with a tabindex; a
 * removed element loses it); listeners with bubbling and stopPropagation,
 * then the document; the onclick-style properties a panel sets; and the
 * house window's trap helpers out of vp.js (VP.dmTabbables / dmTrapTarget).
 *
 * Not a test file: `npm test` globs *.test.mjs only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VP_SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'vp.js'), 'utf8').replace(/\r\n/g, '\n');

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

export {
  vpFn, VP, VOID, NAMED, decodeEntities, escText, escAttr, FOCUSABLE, hide, TextNode, walk, listen, unlisten, Element,
  serialize, parseHtml, parseCompound, matchCompound, matchesSelector, makeDocument, fire, tabOrder, click, press,
  typeInto, flush, settle, makeTimers, deferred,
};
