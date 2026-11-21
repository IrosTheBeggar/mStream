/**
 * The rows' menus against the player bar: a browse row's ▾ / ⋯ menu
 * (m.js createPopper3, #pop-f) and the queue row's ⋮ menu and rater
 * (vp.js createPopper2, #pop-d; createPopper, #pop).
 *
 * What is pinned:
 *   - each one, run on the page's own Popper (webapp/assets/js/lib/popper.js,
 *     @popperjs/core 2) over a 1280×800 page whose player bar sits under
 *     the two columns (#browser and #playlist end at its top, y 694):
 *     a row near a column's foot opens its menu above it, clear of the bar;
 *     a row with room below opens it below; either way it shows;
 *   - opened again and again, on row after row, each menu lands by its
 *     own row at its own size: one Popper on it at a time (a new one over
 *     a live one started from the old inline right: 0, was measured the
 *     page's width, and landed off the page's right edge);
 *   - spa.css paints #pop-d and #pop-f over #mstream-player, for a menu
 *     with room on neither side.
 *
 * webapp/ has no browser harness: the functions are sliced out of m.js and
 * vp.js and run in a vm context beside the real Popper, over a just-enough
 * DOM — each element a fixed box, its computed style what a test gives it,
 * and the menus laid out from their inline styles, as CSS lays out an
 * absolute box.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('webapp', 'alpha', 'm.js');
const VP = read('webapp', 'alpha', 'vp.js');
const CSS = read('webapp', 'alpha', 'spa.css');
const POPPER = read('webapp', 'assets', 'js', 'lib', 'popper.js');

// A top-level function of m.js, through its closing brace.
function sliceFn(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() — update this test`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

// A method of vp.js's queue row (playlist-item), as an object member.
function sliceMethod(name) {
  const lines = VP.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`      ${name}: function (`));
  assert.ok(start >= 0, `vp.js no longer has the ${name} method — update this test`);
  const end = lines.indexOf('      },', start);
  return lines.slice(start, end + 1).join('\n');
}

// The page at 1280×800, the player bar under the columns: each box is
// [left, top, width, height] in CSS px, as the walk measured it.
const BAR_TOP = 694;
function makePage() {
  class Element {}
  class HTMLElement extends Element {}
  const win = {
    Element, HTMLElement, devicePixelRatio: 1, pageXOffset: 0, pageYOffset: 0,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: (el) => el.computed(),
    toString: () => '[object Window]',
  };
  const doc = { nodeName: '#document', defaultView: win };
  const byId = new Map();
  const make = (tag, box, { id = null, parent = null, css = {} } = {}) => {
    const el = new HTMLElement();
    const attrs = new Map();
    const [left, top, width, height] = box;
    Object.assign(el, {
      nodeName: tag.toUpperCase(), id, parentNode: parent, ownerDocument: doc, style: {}, scrollTop: 0, scrollLeft: 0,
      offsetWidth: width, offsetHeight: height, clientWidth: width, clientHeight: height, clientTop: 0, clientLeft: 0,
      scrollWidth: width, scrollHeight: height,
      getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }),
      getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
      setAttribute: (n, v) => { attrs.set(n, String(v)); },
      removeAttribute: (n) => { attrs.delete(n); },
      hasAttribute: (n) => attrs.has(n),
      contains: (other) => { for (let n = other; n; n = n.parentNode) { if (n === el) { return true; } } return false; },
      getRootNode: () => doc,
      querySelector: () => null,
      addEventListener() {}, removeEventListener() {},
      computed: () => ({ position: 'static', overflow: 'visible', overflowX: 'visible', overflowY: 'visible', transform: 'none',
        perspective: 'none', contain: 'none', willChange: 'auto', filter: 'none', ...css }),
    });
    if (id) { byId.set(id, el); }
    return el;
  };
  const html = make('html', [0, 0, 1280, 800]);
  const body = make('body', [0, 0, 1280, 800], { parent: html, css: { position: 'fixed' } });
  doc.documentElement = html;
  doc.body = body;
  doc.getElementById = (id) => byId.get(id) || null;
  const content = make('div', [240, 48, 1040, 752], { id: 'content', parent: body, css: { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' } });
  make('div', [240, BAR_TOP, 1040, 106], { id: 'mstream-player', parent: content });
  const row = make('div', [240, 48, 1040, BAR_TOP - 48], { parent: content });
  const browser = make('div', [240, 48, 509, BAR_TOP - 48], { id: 'browser', parent: row });
  const filelist = make('div', [240, 140, 509, BAR_TOP - 140], { id: 'filelist', parent: browser, css: { overflowY: 'auto' } });
  const playlist = make('div', [749, 48, 531, BAR_TOP - 48], { id: 'playlist', parent: row });
  const flip = make('div', [749, 93, 531, BAR_TOP - 93], { id: 'flip-me', parent: playlist, css: { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' } });
  const queue = make('ul', [749, 300, 531, BAR_TOP - 300], { parent: flip, css: { overflowY: 'auto' } });
  // the menus: absolute against body (position: fixed, 1280×800), laid out
  // from their inline styles as CSS lays them out — a side set pins that
  // edge, both sides of a pair set stretch the menu between them (it has no
  // width of its own), and the transform moves the box after
  const menu = (id, parent, w, h) => {
    const el = make('div', [0, 0, w, h], { id, parent, css: { position: 'absolute' } });
    const px = (v) => (v === undefined || v === '' || v === 'auto' ? null : parseFloat(v));
    const box = () => {
      const s = el.style;
      const [tx, ty] = (/translate(?:3d)?\((-?[\d.]+)px, (-?[\d.]+)px/.exec(s.transform || '') || [0, 0, 0]).slice(1).map(Number);
      const [l, r, t, b] = [px(s.left), px(s.right), px(s.top), px(s.bottom)];
      const width = l !== null && r !== null ? 1280 - l - r : w;
      const height = t !== null && b !== null ? 800 - t - b : h;
      const left = (l !== null ? l : r !== null ? 1280 - r - width : 0) + tx;
      const top = (t !== null ? t : b !== null ? 800 - b - height : 0) + ty;
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    };
    for (const [prop, side] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['scrollWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height'], ['scrollHeight', 'height']]) {
      Object.defineProperty(el, prop, { get: () => box()[side], configurable: true });
    }
    el.getBoundingClientRect = box;
    Object.assign(el, { offsetParent: body, offsetLeft: 0, offsetTop: 0 });
    // index.html's own inline style
    Object.assign(el.style, { visibility: 'hidden', position: 'absolute' });
    return el;
  };
  menu('pop-f', browser, 129, 124);
  menu('pop-d', flip, 150, 150);
  menu('pop', flip, 120, 40);
  const ctx = vm.createContext({ window: win, document: doc, Element, HTMLElement,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } });
  vm.runInContext(POPPER, ctx);
  const real = ctx.Popper;
  assert.equal(typeof real.createPopper, 'function', 'the page\'s Popper loads');
  const made = [];
  ctx.Popper = { createPopper: (...args) => { const instance = real.createPopper(...args); made.push(instance); return instance; } };
  // a row's control in a list: its box, its list, the song it is for
  const control = (box, parent, song) => {
    const el = make('span', box, { parent });
    el.setAttribute('data-file_location', song);
    return el;
  };
  return { ctx, made, doc, filelist, queue, control, $: (id) => byId.get(id) };
}

// Popper lays a menu out a microtask after it is made.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Where the menu landed, in the page's px (its offset parent, body, sits at 0,0).
function landed(instance) {
  const { x, y } = instance.state.modifiersData.popperOffsets;
  const { width, height } = instance.state.rects.popper;
  return { placement: instance.state.placement, top: y, bottom: y + height, left: x, right: x + width };
}

// m.js's createPopper3, with the top-level state it shares.
function browseMenu(page) {
  vm.runInContext(`
    let curFileTracker;
    let popFInstance;
    const peerOf = () => null;
    const iziToast = { info() {} };
    const t = (k) => k;
    ${sliceFn('createPopper3')}
    globalThis.createPopper3 = createPopper3;
  `, page.ctx);
  return (el) => page.ctx.createPopper3(el);
}

// vp.js's queue row: its rater and its ⋮, with their closure's state.
function queueRow(page) {
  vm.runInContext(`
    let currentPopperSongIndex = false;
    let currentPopperSongIndex2;
    let currentPopperSong;
    let cpsi = false;
    let cps;
    let popInstance;
    let popDInstance;
    const showClearLink = { val: false };
    const myRater = { setRating() {} };
    const iziToast = { info() {} };
    const t = (k) => k;
    const MSTREAMPLAYER = { playlist: [{ metadata: {} }, { metadata: {} }, { metadata: {} }, { metadata: { rating: 6 } }] };
    globalThis.queueMethods = {
      ${sliceMethod('createPopper')}
      ${sliceMethod('createPopper2')}
    };
  `, page.ctx);
  const song = { filepath: 'demo/Boukmanflow/Dolo.mp3', metadata: { rating: 6 } };
  return (method, el, index = 3) => page.ctx.queueMethods[method].call({ index, song }, { target: el });
}

describe('a row\'s menu and the player bar', () => {
  test('the browse ▾ / ⋯ menu (#pop-f): near the column\'s foot it opens above its row, clear of the bar; with room below, below', async () => {
    const page = makePage();
    const open = browseMenu(page);
    // a row near the foot: below it, the 124 px menu would reach y 749
    open(page.control([727, 599, 14, 26], page.filelist, 'demo/Boukmanflow/Dolo.mp3'));
    await settle();
    const low = landed(page.made[0]);
    assert.equal(low.placement, 'top-end', 'opens above the row');
    assert.ok(low.bottom <= BAR_TOP && low.top >= 48, `clear of the bar, inside the column: ${low.top}..${low.bottom}`);
    assert.equal(page.$('pop-f').style.visibility, 'visible');
    // a row near the top: room below, so below it
    open(page.control([727, 180, 14, 26], page.filelist, 'demo/Boukmanflow/6AM.mp3'));
    await settle();
    const high = landed(page.made[1]);
    assert.equal(high.placement, 'bottom-end');
    assert.ok(high.top >= 206 && high.bottom <= BAR_TOP, `${high.top}..${high.bottom}`);
    assert.equal(page.$('pop-f').style.visibility, 'visible');
    assert.equal(page.made[0].state.elements.popper, page.$('pop-f'));
  });

  test('the queue row\'s ⋮ menu (#pop-d) and its rater (#pop): near the queue\'s foot above the row, with room below below', async () => {
    const page = makePage();
    const press = queueRow(page);
    press('createPopper2', page.control([1240, 560, 16, 24], page.queue, 'demo/Boukmanflow/Dolo.mp3'));
    await settle();
    const menu = landed(page.made[0]);
    assert.equal(menu.placement, 'top-end');
    assert.ok(menu.bottom <= BAR_TOP && menu.top >= 48, `${menu.top}..${menu.bottom}`);
    assert.equal(page.$('pop-d').style.visibility, 'visible');
    press('createPopper2', page.control([1240, 320, 16, 24], page.queue, 'demo/Boukmanflow/6AM.mp3'), 1);
    await settle();
    assert.equal(landed(page.made[1]).placement, 'bottom-end', 'room below: below');
    press('createPopper', page.control([1215, 660, 16, 24], page.queue, 'demo/Boukmanflow/Dolo.mp3'));
    await settle();
    const rater = landed(page.made[2]);
    assert.equal(rater.placement, 'top-end');
    assert.ok(rater.bottom <= BAR_TOP, `${rater.top}..${rater.bottom}`);
    assert.equal(page.$('pop').style.visibility, 'visible');
  });

  test('each menu opened again and again lands by its own row and inside the page: one Popper on it at a time', async () => {
    const menus = [
      // the menu, how a row opens it, its list, its rows' controls (the last near the foot), its own size
      ['pop-f', (page) => browseMenu(page), 'filelist', [[727, 180, 14, 26], [727, 400, 14, 26], [727, 599, 14, 26]], [129, 124]],
      ['pop-d', (page) => { const press = queueRow(page); return (el, i) => press('createPopper2', el, i); }, 'queue', [[1240, 320, 16, 24], [1240, 450, 16, 24], [1240, 560, 16, 24]], [150, 150]],
      ['pop', (page) => { const press = queueRow(page); return (el, i) => press('createPopper', el, i); }, 'queue', [[1215, 320, 16, 24], [1215, 450, 16, 24], [1215, 660, 16, 24]], [120, 40]],
    ];
    for (const [id, opener, list, controls, [width, height]] of menus) {
      const page = makePage();
      const open = opener(page);
      for (const [i, box] of controls.entries()) {
        open(page.control(box, page[list], `demo/Boukmanflow/${id}-${i}.mp3`), i);
        await settle();
        const shown = page.$(id).getBoundingClientRect();
        const at = `#${id}, open ${i + 1}: [${shown.left}, ${shown.top}, ${shown.width}, ${shown.height}]`;
        assert.deepEqual([shown.width, shown.height], [width, height], `${at}: its own size`);
        assert.equal(shown.right, box[0] + box[2], `${at}: its right edge at its row's control`);
        assert.ok(shown.left >= 0 && shown.right <= 1280 && shown.top >= 48 && shown.bottom <= BAR_TOP, `${at}: in the page, clear of the bar`);
        assert.equal(page.$(id).style.visibility, 'visible', at);
      }
    }
  });

  test('spa.css: #pop-d and #pop-f paint over the player bar', () => {
    const zOf = (selector) => {
      const rules = [...CSS.matchAll(/^([^{}\n][^{}]*)\{([^}]*)\}/gm)].filter((m) => m[1].trim() === selector);
      const z = rules.map((m) => m[2].match(/(?:^|;|\s)z-index:\s*(\d+)/)).filter(Boolean).map((m) => Number(m[1]));
      assert.equal(z.length, 1, `one z-index for ${selector}`);
      return z[0];
    };
    assert.ok(zOf('#pop-d, #pop-f') > zOf('#mstream-player'), 'the menus over the bar');
  });
});
