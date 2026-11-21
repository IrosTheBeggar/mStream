/**
 * The column's title — its h5 (desktop) and the phone's tab
 * (.m-tab.panel_one_name, index.html) — which every panel names
 * (m.js setBrowserRootPanel), against the language the page loads
 * (webapp/assets/js/i18n.js).
 *
 * What is pinned:
 *   - a fresh load: the File Explorer opens as m.js loads, before the
 *     language is in, and both read the panel's name once it is (the
 *     tab used to keep the raw key, 'panel.fileExplorer');
 *   - a language switch names the panel on screen again on both, in the
 *     new language: never File Explorer's name on another panel (the h5's
 *     own data-i18n did that), never the old language (the tab), and
 *     never Add from YouTube's over a view opened after it that keeps the
 *     stack it found (Transcode);
 *   - a connected server's panel keeps its server's name before the
 *     panel's through a switch.
 *
 * The real i18n.js runs over the real locale files; the real panel
 * openers are sliced out of m.js, with m.js's own language listener, over
 * the two title elements as index.html writes them.
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
const HTML = read('webapp', 'index.html');
const I18N_SRC = read('webapp', 'assets', 'js', 'i18n.js');
const DICT = (lang) => JSON.parse(read('webapp', 'locales', `${lang}.json`));
const EN = DICT('en');
const DE = DICT('de');

function sliceFn(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.split(' (').join('(').startsWith(`function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() — update this test`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

function sliceConst(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  return lines.slice(start, lines.indexOf('};', start) + 1).join('\n');
}

// m.js's language listener, the last I18N.onChange at its top level.
function langListener() {
  const at = SRC.lastIndexOf('\nI18N.onChange(() => {');
  assert.ok(at >= 0, 'm.js no longer listens for a language — update this test');
  return SRC.slice(at, SRC.indexOf('\n});\n', at) + 5);
}

// A just-enough element: text and <span data-i18n="…">…</span> children,
// which is all a panel's title holds; entities read as the page reads them.
const ENTITIES = { '&middot;': '·', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (s) => s.replace(/&(?:middot|amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (e) => ENTITIES[e]);
function makeEl(tag, attrs = {}, text = '') {
  const el = { tag, attrs: { ...attrs }, kids: text ? [text] : [] };
  el.getAttribute = (n) => (Object.hasOwn(el.attrs, n) ? el.attrs[n] : null);
  el.setAttribute = (n, v) => { el.attrs[n] = String(v); };
  el.hasAttribute = (n) => Object.hasOwn(el.attrs, n);
  Object.defineProperty(el, 'textContent', {
    get: () => el.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''),
    set: (v) => { el.kids = [String(v)]; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el.kids.map((k) => (typeof k === 'string' ? k : `<span data-i18n="${k.attrs['data-i18n']}">${k.textContent}</span>`)).join(''),
    set: (h) => {
      const parts = String(h).split(/(<span data-i18n="[^"]*">[^<]*<\/span>)/);
      assert.ok(!parts.some((p, i) => i % 2 === 0 && /[<>]/.test(p)), `a title holds text and its name: ${h}`);
      el.kids = parts.filter(Boolean).map((p) => {
        const m = p.match(/^<span data-i18n="([^"]*)">([^<]*)<\/span>$/);
        return m ? makeEl('span', { 'data-i18n': m[1] }, decode(m[2])) : decode(p);
      });
    },
  });
  return el;
}

// The column's two titles as index.html writes them.
function titlesOf(html) {
  const found = [...html.matchAll(/<(h5|div)\b([^>]*\bclass="[^"]*\bpanel_one_name\b[^"]*"[^>]*)>([^<]*)<\/\1>/g)];
  return found.map(([, tag, raw, text]) => {
    const attrs = Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    return makeEl(tag, attrs, text.trim());
  });
}

// The page: i18n.js (nothing loaded yet), the titles, and m.js's panel
// openers and language listener over stub chrome.
function makePage() {
  // in the page's order: the phone's tab, then the h5
  const titles = titlesOf(HTML);
  assert.equal(titles.length, 2, 'the phone\'s tab and the h5');
  const [tab, h5] = titles;
  assert.ok(tab.getAttribute('class').split(' ').includes('m-tab'));
  assert.equal(h5.tag, 'h5');
  const withKey = () => {
    const out = [];
    const walk = (el) => { if (el.hasAttribute('data-i18n')) { out.push(el); } el.kids.forEach((k) => { if (typeof k !== 'string') { walk(k); } }); };
    titles.forEach(walk);
    return out;
  };
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  const fetch = (url) => Promise.resolve({ json: () => Promise.resolve(DICT(String(url).replace(/^.*locales\/|\.json$/g, ''))) });
  const win = {};
  const I18N = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', `${I18N_SRC}\nreturn I18N;`)(
    win, { querySelector: () => null, querySelectorAll: (sel) => (sel === '[data-i18n]' ? withKey() : []) }, localStorage, { language: 'en' }, fetch);
  const chrome = new Map();
  const part = (id) => {
    if (!chrome.has(id)) { chrome.set(id, { id, style: {}, value: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {} } }); }
    return chrome.get(id);
  };
  const document = { getElementById: part, getElementsByClassName: (c) => (c === 'panel_one_name' ? titles : []) };
  const S = new Function('document', 'I18N', 't', 'MSTREAMAPI', 'MSTREAMPLAYER', `
    'use strict';
    let peerContext = null;
    let programState = [];
    let fileExplorerArray = [];
    let currentBrowsingList = [];
    const browseKeepReset = () => {};
    const discoveryHideHead = () => {};
    const hideMoodFilters = () => {};
    const senddir = () => {};
    const setupLayoutPanel = () => {};
    ${sliceConst('entityMap')}
    ${['escapeHtml', 'setBrowserRootPanel', 'loadFileExplorer', 'advancedConfig', 'setupTranscodePanel', 'ytdlPanel'].map(sliceFn).join('\n')}
    ${langListener()}
    return { loadFileExplorer, advancedConfig, setupTranscodePanel, ytdlPanel, setPeer: (p) => { peerContext = p; }, state: () => programState };
  `)(document, I18N, I18N.t, { currentServer: { vpaths: ['demo'] } }, { ignoreVPaths: {}, transcodeOptions: { serverEnabled: false } });
  // [the h5, the tab]
  const read = () => [h5, tab].map((el) => el.textContent.trim());
  return { S, I18N, read };
}

describe('the column\'s title (h5 and the phone\'s tab) and the language', () => {
  test('a fresh load: the File Explorer opens before the language is in; both titles read its name once it is', async () => {
    const page = makePage();
    page.S.loadFileExplorer();
    await page.I18N.loadLanguage('en');
    assert.deepEqual(page.read(), [EN['panel.fileExplorer'], EN['panel.fileExplorer']]);
  });

  test('a language switch names the panel on screen again, on both, in the new language', async () => {
    const page = makePage();
    page.S.loadFileExplorer();
    await page.I18N.loadLanguage('en');
    page.S.advancedConfig();
    assert.deepEqual(page.read(), [EN['panel.config'], EN['panel.config']]);
    await page.I18N.loadLanguage('de');
    assert.notEqual(DE['panel.config'], EN['panel.config']);
    assert.deepEqual(page.read(), [DE['panel.config'], DE['panel.config']], 'Config, in German: not File Explorer, not English');
    page.S.loadFileExplorer();
    assert.deepEqual(page.read(), [DE['panel.fileExplorer'], DE['panel.fileExplorer']]);
  });

  test('a view that keeps the stack it found (Transcode, after Add from YouTube) keeps its own name through a switch', async () => {
    const page = makePage();
    await page.I18N.loadLanguage('de');
    page.S.ytdlPanel();
    assert.deepEqual(page.S.state(), [{ state: 'addFromYoutube' }]);
    page.S.setupTranscodePanel();
    assert.deepEqual(page.S.state(), [{ state: 'addFromYoutube' }], 'Transcode keeps no stack of its own');
    await page.I18N.loadLanguage('en');
    assert.deepEqual(page.read(), [EN['panel.transcode'], EN['panel.transcode']]);
  });

  test('a connected server\'s panel: its server\'s name, then the panel\'s, through a switch', async () => {
    const page = makePage();
    await page.I18N.loadLanguage('en');
    page.S.setPeer({ id: 7, name: 'Sam\'s <server>' });
    page.S.loadFileExplorer();
    assert.deepEqual(page.read(), [`Sam's <server> · ${EN['panel.fileExplorer']}`, `Sam's <server> · ${EN['panel.fileExplorer']}`]);
    await page.I18N.loadLanguage('de');
    assert.deepEqual(page.read(), [`Sam's <server> · ${DE['panel.fileExplorer']}`, `Sam's <server> · ${DE['panel.fileExplorer']}`]);
  });
});
