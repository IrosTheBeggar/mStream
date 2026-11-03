/**
 * Instant Mix's filter panel in the webapp (m.js instantMixFiltersHtml /
 * instantMixFilterEvent / instantMixSyncFilters …, the pure half in
 * webapp/alpha/instant-mix.js) and the Auto DJ pieces it shares
 * (ratingOptionsHtml, filterChipsHtml, genreSuggestHtml — lifted out of
 * autoDjPanel — and moodPanelHtml).
 *
 * What is pinned:
 *   - Auto DJ still draws through the lifted builders: autoDjPanel's
 *     rating options, chips and genre suggestions, and their redraws when
 *     a word or genre comes and goes (the lift was checked byte for byte
 *     against the m.js it was made on before this commit);
 *   - the panel: Auto DJ's rows in Auto DJ's order with its labels, each
 *     only where it can filter this mix (Sources with two libraries left
 *     by the app's folder choice, tempo and key on a song with a BPM / a
 *     key, Genre with the library's genres or one set, Mood where the
 *     server filters by mood), no hints; its fields and select
 *     browser-default; the Mood row moodPanelHtml('mix') with no Clear and
 *     no Sort; one Clear, at the Track length row's end, while a filter is
 *     set;
 *   - the funnel: white at rest, orange while a filter is set, open state
 *     on aria-expanded; the panel closed on every new mix, its values
 *     carried;
 *   - its styles: capped at 45vh, one column under a 420 px header, and
 *     never run past the column's foot (a phone's column is short);
 *   - every commit, Auto DJ's way (pills, select, switches, modes, moods
 *     and × at once; Enter or a comma for words and genres, a suggestion
 *     on mousedown; `change` for lengths and the tolerance), in place —
 *     the panel never drawn again, the control pressed keeps the keyboard
 *     — and the body it asks with: each key only when it filters;
 *   - Clear empties every row, hides itself and hands the keyboard to the
 *     funnel;
 *   - asking again: one ask 250 ms after a burst, the rows dimmed, a newer
 *     ask wins, no ask when nothing the body carries moved; no match with
 *     its Clear, a failure that keeps the open panel, a lost mood echo
 *     that takes the Mood row away; the genres fetched once a mix opens.
 *
 * Same technique as webapp-mood-filters.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals — here over a small
 * tree DOM (events bubble, a panel's controls keep their identity).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('webapp', 'alpha', 'm.js');
const CSS = read('webapp', 'alpha', 'spa.css');
const EN = JSON.parse(read('webapp', 'locales', 'en.json'));

// auto-dj.js reads localStorage when it loads: a Map-backed shim first.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};
const require = createRequire(import.meta.url);
const M = require('../../webapp/alpha/instant-mix.js');
const AUTODJ = require('../../webapp/alpha/auto-dj.js');

const tEn = (k, p) => {
  let s = typeof EN[k] === 'string' ? EN[k] : k;
  for (const [n, v] of Object.entries(p || {})) { s = s.split(`{{${n}}}`).join(String(v)); }
  return s;
};

// ── slicing ──────────────────────────────────────────────────────────────
function sliceFn(src, name) {
  const lines = src.split('\n');
  const header = (l) => l.split(' (').join('(');   // `function escapeHtml (string)`
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `no ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceConst(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `no const ${name} — update this test`);
  if (lines[start].endsWith('};') || lines[start].endsWith("';")) { return lines[start]; }
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of const ${name}`);
}

const defines = (src, name) => new RegExp(`^(?:async )?function ${name} ?\\(`, 'm').test(src);

// ── a small tree DOM ─────────────────────────────────────────────────────
// Parsed from the HTML the code writes; enough of the API for the panels:
// attributes, classList, dataset, value / checked / disabled / hidden,
// textContent, innerHTML both ways, closest and querySelector(All) with
// compound and descendant selectors, focus, and events that bubble to
// addEventListener listeners and on<type> handlers.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] !== '#') { return NAMED[e] ?? m; }
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const enc = (s, attr) => String(s).replace(attr ? /[&"]/g : /[&<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

function compoundMatches(el, compound) {
  const parts = compound.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
  assert.equal(parts.join(''), compound, `the test DOM reads no selector like "${compound}"`);
  return parts.every((p) => {
    if (p[0] === '.') { return el.classList.contains(p.slice(1)); }
    if (p[0] === '#') { return el.getAttribute('id') === p.slice(1); }
    if (p[0] === '[') {
      const [, n, v] = p.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return v === undefined ? el.hasAttribute(n) : el.getAttribute(n) === v;
    }
    return el.tag === p.toLowerCase();
  });
}

// `s` cut at each `sep` outside [attribute] brackets (a value may hold
// spaces: [data-genre="Hip Hop"]).
function splitOutside(s, sep) {
  const out = [''];
  let depth = 0;
  for (const c of s) {
    if (c === '[') { depth++; }
    if (c === ']') { depth--; }
    if (depth === 0 && sep.test(c)) { out.push(''); } else { out[out.length - 1] += c; }
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

function selectorMatches(el, selector) {
  return splitOutside(selector, /,/).some((one) => {
    const chain = splitOutside(one, /\s/);
    if (!compoundMatches(el, chain[chain.length - 1])) { return false; }
    let at = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (at && !compoundMatches(at, chain[i])) { at = at.parentElement; }
      if (!at) { return false; }
      at = at.parentElement;
    }
    return true;
  });
}

function makeDom(ids) {
  const doc = { activeElement: null };
  const text = (data) => ({ nodeType: 3, data, parentNode: null });
  const serialize = (n) => {
    if (n.nodeType === 3) { return enc(n.data); }
    const attrs = [...n.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${enc(v, true)}"`)).join('');
    return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${n.innerHTML}</${n.tag}>`;
  };
  const attrsOf = (raw) => {
    const out = {};
    for (const m of raw.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) { out[m[1]] = decode(m[2] ?? m[3] ?? m[4] ?? ''); }
    return out;
  };
  const parseInto = (parent, html) => {
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    const stack = [parent];
    for (const m of html.matchAll(re)) {
      const top = stack[stack.length - 1];
      if (m[1]) {
        const at = stack.map((s) => s.tag).lastIndexOf(m[1].toLowerCase());
        if (at > 0) { stack.length = at; }
      } else if (m[2]) {
        const el = element(m[2].toLowerCase(), attrsOf(m[3] || ''));
        top.append(el);
        if (!VOID.has(el.tag) && !m[4]) { stack.push(el); }
      } else if (m[5]) {
        top.append(text(decode(m[5])));
      }
    }
  };
  function element(tag, attrs = {}) {
    const el = {
      nodeType: 1, tag, tagName: tag.toUpperCase(), attrs: new Map(Object.entries(attrs)), childNodes: [], parentNode: null,
      listeners: [], style: {}, scrollTop: 0, writes: 0, assigned: null,
      // no layout: a box a test sets (rect, clientTop, clientHeight), else none
      rect: null, clientTop: 0, clientHeight: 0,
      getBoundingClientRect: () => el.rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
      _value: attrs.value ?? '', _checked: 'checked' in attrs, _selected: 'selected' in attrs,
      getAttribute: (n) => (el.attrs.has(n) ? el.attrs.get(n) : null),
      setAttribute: (n, v) => { el.attrs.set(n, String(v)); },
      removeAttribute: (n) => { el.attrs.delete(n); },
      hasAttribute: (n) => el.attrs.has(n),
      append: (n) => { n.parentNode = el; el.childNodes.push(n); return n; },
      descendants: () => el.children.flatMap((c) => [c, ...c.descendants()]),
      matches: (sel) => selectorMatches(el, sel),
      closest: (sel) => { for (let n = el; n && n.nodeType === 1; n = n.parentNode) { if (n.matches(sel)) { return n; } } return null; },
      querySelectorAll: (sel) => el.descendants().filter((d) => d.matches(sel)),
      querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
      contains: (n) => { for (let x = n; x; x = x.parentNode) { if (x === el) { return true; } } return false; },
      focus: () => { doc.activeElement = el; },
      blur: () => { if (doc.activeElement === el) { doc.activeElement = null; } },
      addEventListener: (type, fn, opts) => { el.listeners.push({ type, fn, signal: opts && typeof opts === 'object' ? opts.signal : undefined }); },
      removeEventListener: (type, fn) => { el.listeners = el.listeners.filter((l) => l.type !== type || l.fn !== fn); },
    };
    const classes = () => new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    const write = (set) => el.setAttribute('class', [...set].join(' '));
    el.classList = {
      contains: (c) => classes().has(c),
      add: (c) => { const s = classes(); s.add(c); write(s); },
      remove: (c) => { const s = classes(); s.delete(c); write(s); },
      toggle: (c, on) => { const s = classes(); const want = on === undefined ? !s.has(c) : !!on; if (want) { s.add(c); } else { s.delete(c); } write(s); return want; },
    };
    el.dataset = new Proxy({}, {
      get: (_, k) => el.getAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
    });
    for (const decl of (el.getAttribute('style') || '').split(';')) {
      const [k, v] = decl.split(':');
      if (k && v !== undefined) { el.style[k.trim()] = v.trim(); }
    }
    const options = () => el.descendants().filter((o) => o.tag === 'option');
    Object.defineProperties(el, {
      children: { get: () => el.childNodes.filter((n) => n.nodeType === 1) },
      parentElement: { get: () => (el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null) },
      id: { get: () => el.getAttribute('id') || '' },
      innerHTML: {
        get: () => el.childNodes.map(serialize).join(''),
        set: (h) => { el.childNodes = []; el.writes++; el.assigned = String(h); parseInto(el, String(h)); },
      },
      textContent: {
        get: () => el.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join(''),
        set: (v) => { el.childNodes = []; el.append(text(String(v))); },
      },
      value: {
        get: () => {
          if (tag !== 'select') { return el._value; }
          const opt = options().find((o) => o._selected) || options()[0];
          return opt ? (opt.getAttribute('value') ?? opt.textContent) : '';
        },
        set: (v) => {
          if (tag !== 'select') { el._value = String(v); return; }
          for (const o of options()) { o._selected = (o.getAttribute('value') ?? o.textContent) === String(v); }
        },
      },
      checked: { get: () => el._checked, set: (v) => { el._checked = !!v; } },
      disabled: { get: () => el.hasAttribute('disabled'), set: (v) => { if (v) { el.setAttribute('disabled', ''); } else { el.removeAttribute('disabled'); } } },
      hidden: { get: () => el.hasAttribute('hidden'), set: (v) => { if (v) { el.setAttribute('hidden', ''); } else { el.removeAttribute('hidden'); } } },
    });
    return el;
  }
  const root = element('div', { id: 'root' });
  for (const id of ids) { root.append(element('div', { id })); }
  Object.assign(doc, {
    root,
    getElementById: (id) => root.descendants().find((d) => d.getAttribute('id') === id) || null,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  });
  return { doc, element };
}

// An event from `target`, bubbling to the root: listeners first, then the
// node's on<type> handler. → the event (defaultPrevented …).
function fire(target, type, init = {}) {
  const ev = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
  for (let n = target; n && !ev.stopped; n = n.parentNode) {
    for (const l of n.listeners.slice()) {
      if (l.type === type && !(l.signal && l.signal.aborted)) { l.fn.call(n, ev); }
    }
    if (typeof n[`on${type}`] === 'function') { n[`on${type}`](ev); }
  }
  return ev;
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) { await tick(); } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function resetAutoDj(patch = {}) {
  _store.clear();
  AUTODJ._internals.rehydrate();
  AUTODJ.invalidateGenresCache();
  AUTODJ.setState(patch);
}

// ── Auto DJ's panel, drawn through the lifted builders ──────────────────
// autoDjPanel out of `src` over a stub app; `opts` is the server's side.
function autoDjPanelOf(src, opts) {
  const { doc } = makeDom(['filelist']);
  const fns = ['escapeHtml', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'moodSortHtml', 'ratingOptionsHtml', 'filterChipsHtml', 'genreSuggestHtml', 'autoDjPanel']
    .filter((n) => defines(src, n));
  const globals = {
    document: doc,
    t: tEn,
    AUTODJ,
    MSTREAMAPI: {
      currentServer: { vpaths: opts.vpaths, moodFilters: opts.moodFilters, discovery: opts.discovery, federationBrowse: opts.federationBrowse },
      getGenres: () => Promise.resolve({ status: 'ok', value: opts.genres }),
      search: () => Promise.resolve({ title: [] }),
    },
    MSTREAMPLAYER: { playerStats: { autoDJ: opts.running === true }, toggleAutoDJ: () => {}, autoDjKick: () => {} },
    iziToast: { warning: () => {} },
    setBrowserRootPanel: () => {},
    _autoDjMigrateLegacyKeys: () => {},
    _fetchLastfmStatus: () => Promise.resolve({ serverEnabled: opts.lastfm === true }),
    _syncVpathsToLegacy: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const body = `
    'use strict';
    let _autoDjPanelAbortController = null;
    ${['entityMap', 'MOODS'].map((n) => sliceConst(src, n)).join('\n')}
    ${fns.map((n) => sliceFn(src, n)).join('\n\n')}
    return { autoDjPanel };
  `;
  const names = Object.keys(globals);
  const S = new Function(...names, body)(...names.map((n) => globals[n]));
  return { S, doc };
}

const RICH = {
  djVpaths: ['music'], djMinRating: 7, bpmContinuity: true, bpmTolerance: 5, harmonicMixing: true,
  djFilterEnabled: true, djFilterWords: ['live', 'AC/DC <remix>', 'acappella'],
  djGenreEnabled: true, djGenres: ['Hip Hop', 'Jazz & Soul'], djGenreMode: 'blacklist',
  djMoodEnabled: true, djMoods: { energy: 'relaxed', tags: ['party'] }, djMoodLevel: 'strict',
  djDurationEnabled: true, djMinDuration: 150, djMaxDuration: 600, djAllowUnknownDuration: true,
  sonicEnabled: true, djLimit: 3,
};
const RICH_SERVER = { vpaths: ['music', 'podcasts', 'audiobooks'], moodFilters: true, discovery: true, federationBrowse: true, lastfm: true,
  genres: ['Afrobeat', 'Hip Hop', 'Jazz', 'Jazz & Soul', 'Jazz Fusion', 'Acid Jazz'] };
const PLAIN_SERVER = { vpaths: ['demo'], moodFilters: false, discovery: false, federationBrowse: false, lastfm: false, genres: [] };

async function drawAutoDj(src, state, server) {
  resetAutoDj(state);
  if (state.sonicEnabled) { AUTODJ.setSonicSeed('music/Dolo.mp3', 'Dolo — Boukmanflow'); }
  const box = autoDjPanelOf(src, server);
  await box.S.autoDjPanel();
  return box;
}

describe('Auto DJ keeps its markup: the builders lifted out of autoDjPanel', () => {
  test('autoDjPanel draws its rows through the lifted builders — a fresh state and a full one', async () => {
    const fresh = (await drawAutoDj(SRC, {}, PLAIN_SERVER)).doc.getElementById('filelist').assigned;
    assert.ok(fresh.includes('id="dj-min-rating"') && fresh.includes('<option value="0" selected>Any</option>'), 'a fresh state: Any');
    const full = (await drawAutoDj(SRC, RICH, RICH_SERVER)).doc.getElementById('filelist').assigned;
    for (const piece of ['<option value="7" selected>★ 3.5</option>', 'data-word="AC&#x2F;DC &lt;remix&gt;"', 'data-genre="Jazz &amp; Soul"']) {
      assert.ok(full.includes(piece), `the full state shows ${piece}`);
    }
  });

  test('its chips and genre suggestions still redraw: a word added and taken away, a genre taken away, the dropdown, a suggestion taken', async () => {
    const { doc } = await drawAutoDj(SRC, RICH, RICH_SERVER);
    const words = doc.getElementById('dj-filter-tags');
    const genres = doc.getElementById('dj-genre-tags');
    const wordIn = doc.getElementById('dj-filter-input');
    const genreIn = doc.getElementById('dj-genre-input');
    const suggest = doc.getElementById('dj-genre-suggest');
    wordIn.value = 'Remaster';
    fire(wordIn, 'keydown', { key: 'Enter' });
    assert.ok(words.innerHTML.includes('data-word="Remaster"'), 'a word added');
    fire(words.querySelector('[data-word="live"]'), 'click');
    assert.ok(!words.innerHTML.includes('data-word="live"'), 'a word taken away');
    fire(genres.querySelector('[data-genre="Hip Hop"]'), 'click');
    assert.ok(!genres.innerHTML.includes('data-genre="Hip Hop"'), 'a genre taken away');
    genreIn.value = 'jazz';
    fire(genreIn, 'input');
    assert.ok(!suggest.hidden && suggest.assigned.includes('data-genre="Acid Jazz"'), 'the dropdown');
    const taken = AUTODJ.getGenres().length;
    fire(suggest.querySelector('.dj-genre-suggest-row'), 'mousedown');
    assert.equal(AUTODJ.getGenres().length, taken + 1, 'a suggestion taken');
  });

  test('ratingOptionsHtml, filterChipsHtml and genreSuggestHtml: what they draw', () => {
    const S = new Function('t', `
      ${sliceConst(SRC, 'entityMap')}
      ${['escapeHtml', 'ratingOptionsHtml', 'filterChipsHtml', 'genreSuggestHtml'].map((n) => sliceFn(SRC, n)).join('\n')}
      return { ratingOptionsHtml, filterChipsHtml, genreSuggestHtml };
    `)(tEn);
    const opts = S.ratingOptionsHtml(0);
    assert.equal((opts.match(/<option /g) || []).length, 11);
    assert.ok(opts.startsWith('<option value="0" selected>Any</option><option value="1" >★ 0.5</option>'));
    assert.ok(S.ratingOptionsHtml(10).endsWith('<option value="10" selected>★ 5</option>'));
    assert.equal(S.filterChipsHtml([], 'word'), '');
    assert.match(S.filterChipsHtml(['Live'], 'word'), /data-word="Live" aria-label="Remove Live">×<\/button>/);
    assert.match(S.filterChipsHtml(['R&B'], 'genre'), /data-genre="R&amp;B" aria-label="Remove R&amp;B">×<\/button>/);
    const list = Array.from({ length: 60 }, (_, i) => `Jazz ${i}`);
    assert.equal(S.genreSuggestHtml('  ', [], list), '', 'an empty field: no dropdown');
    assert.equal(S.genreSuggestHtml('polka', [], list), '<div class="dj-genre-suggest-empty">No matching genres</div>');
    const fifty = S.genreSuggestHtml('JAZZ', ['jazz 0'], list);
    assert.equal((fifty.match(/class="dj-genre-suggest-row"/g) || []).length, 50);
    assert.ok(!fifty.includes('data-genre="Jazz 0"'), 'a chosen genre, whatever its case, is not offered');
    assert.ok(fifty.endsWith('<div class="dj-genre-suggest-more">+9 more — refine your search</div>'));
  });
});

// ── the mix page's panel ─────────────────────────────────────────────────
const DOLO = { filepath: 'demo/Boukmanflow/Dolo.mp3', metadata: { title: 'Dolo', artist: 'Boukmanflow', album: 'Stim Pack Volume one', bpm: 87, 'musical-key': 'Bb minor' } };
const ENFANCE = { filepath: 'demo/ALM/Free Instrumentals Vol.2 - Old School Session/Enfance.mp3', metadata: { title: 'Enfance', artist: 'ALM', album: 'Free Instrumentals Vol.2 - Old School Session' } };
const HANGOUT = { filepath: 'demo/Boukmanflow/The Hangout.mp3', metadata: { title: 'The Hangout', artist: 'Boukmanflow', album: 'The Hangout' } };
const answer = (songs, extra = {}) => ({
  model: { id: 'effnet-discogs', version: '1' }, seed: { kind: 'song', members: 1, analyzed: 1 }, notAnalyzed: false,
  songs: songs.map((s, i) => ({ ...s, similarity: i === 0 ? 1 : 0.8, genreTags: [] })),
  short: true, capped: false, relaxed: [], floor: 0.2, filteredOut: false, moods: {}, ...extra,
});
const DOLO_SEED = { kind: 'song', filepath: 'demo/Boukmanflow/Dolo.mp3', bpm: 87, key: 'Bb minor' };
const DOLO_HEAD = { kind: 'song', title: 'Dolo', sub: 'Boukmanflow', art: null };
const ALBUM_SEED = { kind: 'album', album: 'Stim Pack Volume one', albumArtist: 'Boukmanflow', year: 2019 };
const ALBUM_HEAD = { kind: 'album', title: 'Stim Pack Volume one', sub: 'Boukmanflow', art: null };
const GENRES = ['Afrobeat', 'Hip Hop', 'Jazz', 'Jazz Fusion'];
const MIX_FNS = [...SRC.matchAll(/^(?:async )?function ((?:instantMix|onInstantMix)\w*)\(/gm)].map((m) => m[1]);
const FNS = ['escapeHtml', 'localIgnoreVPaths', 'artUrl', 'artImgAttr', 'browseHeadTile', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'moodSortHtml',
  'hideMoodFilters', 'discoveryHideHead', 'discoverySkelHtml', 'discoveryArtHtml', 'ratingOptionsHtml', 'filterChipsHtml', 'genreSuggestHtml', ...MIX_FNS];
const HOSTS = ['directory_bar', 'directoryName', 'localSearchBar', 'local_search_btn', 'search_folders', 'mkdir_btn', 'upload_btn', 'add_all_btn',
  'instant_mix_btn', 'genre_source', 'mood_filter_btn', 'mood_filters', 'dpage-head', 'browse-head', 'filelist'];

// One stubbed app around the sliced functions. `respond(body)` answers the
// mix route (a value or a promise); asks and genre fetches are recorded.
function mixSandbox({ server = {}, ignore = {}, genres = GENRES, genresReply } = {}) {
  resetAutoDj();
  const { doc } = makeDom(HOSTS);
  for (const id of ['browse-head', 'dpage-head', 'mood_filter_btn', 'mood_filters', 'instant_mix_btn', 'search_folders']) { doc.getElementById(id).classList.add('super-hide'); }
  const box = { doc, asked: [], genreAsks: 0, timers: [], respond: () => answer([DOLO, ENFANCE, HANGOUT]) };
  const player = { ignoreVPaths: { ...ignore }, playlist: [], positionCache: { val: -1 }, playerStats: { playing: false } };
  const api = {
    currentServer: { host: 'http://host/', token: 'TOK', vpaths: ['demo'], discovery: true, discoveryReady: true, instantMix: 1, moodFilters: true, ...server },
    instantMix: (body) => { box.asked.push(body); return Promise.resolve(box.respond(body)); },
    getGenres: () => { box.genreAsks++; return Promise.resolve(genresReply ? genresReply() : { status: 'ok', value: genres }); },
  };
  const globals = {
    document: doc,
    window: { matchMedia: () => ({ matches: false }) },
    t: tEn,
    MSTREAMAPI: api,
    MSTREAMPLAYER: player,
    VUEPLAYERCORE: { playlists: [], addSongWizard: () => {} },
    INSTANTMIX: M,
    AUTODJ,
    iziToast: { success: () => {}, error: () => {} },
    setTimeout: (fn, ms) => { box.timers.push({ fn, ms, live: true }); return box.timers.length; },
    clearTimeout: (id) => { if (id && box.timers[id - 1]) { box.timers[id - 1].live = false; } },
    changeView: () => {},
    toggleThing: () => {},
    browseKeepReset: () => {},
  };
  const body = `
    'use strict';
    let programState = [];
    let peerContext = null;
    let lastView = null;
    let curFileTracker;
    let currentBrowsingList = [];
    const discoveryView = { shown: { allTracks: [] }, flags: {} };
    ${['entityMap', 'MOODS', 'DPAGE_ICONS', 'MIX', 'MIX_PLAYLIST_TILE'].map((n) => sliceConst(SRC, n)).join('\n')}
    ${FNS.map((n) => sliceFn(SRC, n)).join('\n\n')}
    return { ${FNS.join(', ')}, MIX, MOODS, state: () => programState, setState: (s) => { programState = s; } };
  `;
  const names = Object.keys(globals);
  box.S = new Function(...names, body)(...names.map((n) => globals[n]));
  box.api = api;
  box.player = player;
  box.el = (id) => doc.getElementById(id);
  box.panel = () => doc.getElementById('mix-filters');
  box.funnel = () => doc.getElementById('mix_filter_btn');
  box.ctl = (sel) => { const c = box.panel().querySelector(sel); assert.ok(c, `the panel has ${sel}`); return c; };
  box.row = (name) => box.panel().querySelector(`[data-mxf-row="${name}"]`);
  box.shown = (el) => !!el && !el.classList.contains('super-hide');
  box.liveTimers = () => box.timers.filter((tm) => tm.live);
  box.runTimers = () => { for (const tm of box.timers) { if (tm.live && tm.ms === 250) { tm.live = false; tm.fn(); } } };
  box.titles = () => [...box.el('filelist').querySelectorAll('.discover-row-title')].map((n) => n.textContent);
  // a state's line, without its button
  box.line = () => box.el('filelist').querySelector('.dpage-hint')?.childNodes[0].data.trim() ?? null;
  // the body the page's filters ask with now — sent, or served from the
  // answers it keeps (a body asked before is not asked again)
  box.body = () => box.S.instantMixBody(box.S.MIX.entry.seed);
  box.open = async (seed = DOLO_SEED, head = DOLO_HEAD) => {
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.instantMixOpen(seed, head);
    await settle();
  };
  box.openPanel = () => {
    if (!box.S.MIX.open) { fire(box.funnel(), 'click'); }
    assert.ok(box.shown(box.panel()), 'the panel is open');
  };
  // Commit and let the debounced ask out and back.
  box.flush = async () => { box.runTimers(); await settle(); };
  return box;
}

const labelsOf = (box) => [...box.panel().querySelectorAll('.mix-filter-label')]
  .filter((l) => !l.closest('.super-hide') && l.getAttribute('id') !== 'mixf-unknown')
  .map((l) => l.textContent);
const keysOf = (body) => Object.keys(body).filter((k) => k !== 'from' && k !== 'limit').sort();

describe('Instant Mix filters: the panel', () => {
  test("Auto DJ's rows in Auto DJ's order with its labels — and no hint, heading or on/off switch of a row", async () => {
    const box = mixSandbox({ server: { vpaths: ['demo', 'podcasts'] } });
    await box.open();
    box.openPanel();
    assert.deepEqual(labelsOf(box), ['Sources', 'Minimum Rating', 'BPM continuity', 'Harmonic mixing', 'Keyword filter', 'Genre filter', 'Mood', 'Track length']);
    assert.deepEqual([...box.panel().querySelectorAll('[data-mxf-row]')].map((r) => r.getAttribute('data-mxf-row')),
      ['sources', 'rating', 'bpm', 'tolerance', 'harmonic', 'words', 'genres', 'mood', 'length', 'unknown'], 'BPM tolerance and the unknown-length switch drawn, hidden');
    assert.ok(!box.shown(box.row('tolerance')) && !box.shown(box.row('unknown')));
    const html = box.panel().assigned;
    for (const [k, v] of Object.entries(EN)) {
      if (/^autoDJ\..*Hint/.test(k) || /^autoDJ\.section(?!Sources)/.test(k)) { assert.ok(!html.includes(v), `no ${k}`); }
    }
    assert.ok(!html.includes('dj-filter-on') && !html.includes('dj-genre-on') && !html.includes('dj-duration-on') && !html.includes('dj-mood-on'), 'a row filters while it holds a value');
  });

  test('a row only where it can filter this mix', async () => {
    // one library left by the app's folder choice: no Sources
    const one = mixSandbox({ server: { vpaths: ['demo', 'podcasts'] }, ignore: { podcasts: true } });
    await one.open();
    one.openPanel();
    assert.equal(one.row('sources'), null);
    // tempo and key: a song with a BPM / a key only
    for (const [seed, head, rows] of [
      [ALBUM_SEED, ALBUM_HEAD, []],
      [{ kind: 'artist', artist: 'Boukmanflow' }, { kind: 'artist', title: 'Boukmanflow' }, []],
      [{ kind: 'playlist', playlist: 'Road trip' }, { kind: 'playlist', title: 'Road trip' }, []],
      [{ ...DOLO_SEED, bpm: null }, DOLO_HEAD, ['harmonic']],
      [{ ...DOLO_SEED, key: 'H major' }, DOLO_HEAD, ['bpm']],
      [{ ...DOLO_SEED, bpm: 5 }, DOLO_HEAD, ['harmonic']],
    ]) {
      const box = mixSandbox();
      await box.open(seed, head);
      box.openPanel();
      assert.deepEqual(['bpm', 'harmonic'].filter((r) => box.row(r)), rows, JSON.stringify(seed));
    }
    // Genre: with the library's genres, or one already set
    const bare = mixSandbox({ genres: [] });
    await bare.open();
    bare.openPanel();
    assert.ok(!bare.shown(bare.row('genres')), 'an untagged library');
    fire(bare.funnel(), 'click');
    bare.S.MIX.filters.genres = ['Jazz'];
    bare.openPanel();
    assert.ok(bare.shown(bare.row('genres')), 'a genre set can be let go');
    // Mood: where the server filters by mood
    const plain = mixSandbox({ server: { moodFilters: false } });
    await plain.open();
    plain.openPanel();
    assert.equal(plain.row('mood'), null);
  });

  test("the controls are Auto DJ's — fields and select browser-default, the Mood row its panel with no Clear and no Sort, one Clear at the length row's end", async () => {
    const box = mixSandbox({ server: { vpaths: ['demo', 'podcasts'] } });
    await box.open();
    box.openPanel();
    assert.deepEqual([...box.panel().querySelectorAll('.dj-vpath-pill')].map((b) => [b.textContent, b.classList.contains('on'), b.getAttribute('aria-pressed')]),
      [['demo', true, 'true'], ['podcasts', true, 'true']]);
    const select = box.ctl('select[data-mxf="rating"]');
    assert.ok(select.classList.contains('autodj-select') && select.classList.contains('browser-default'));
    assert.deepEqual([select.value, select.querySelectorAll('option').length, select.getAttribute('aria-labelledby')], ['0', 11, 'mixf-rating']);
    for (const act of ['bpm', 'harmonic', 'unknown']) {
      const sw = box.ctl(`input[data-mxf="${act}"]`);
      assert.ok(sw.closest('.toggle-sw') && sw.getAttribute('type') === 'checkbox' && !sw.checked, act);
      assert.equal(sw.getAttribute('aria-labelledby'), `mixf-${act}`);
    }
    const slider = box.ctl('input[data-mxf="tolerance"]');
    assert.deepEqual([slider.getAttribute('type'), slider.getAttribute('min'), slider.getAttribute('max'), slider.value], ['range', '1', '20', '8']);
    assert.equal(box.ctl('[data-mxf-value="tolerance"]').textContent, '± 8');
    for (const [act, placeholder] of [['word', 'Add a word and press Enter…'], ['genre', 'Type to filter…']]) {
      const input = box.ctl(`input[data-mxf="${act}"]`);
      assert.ok(input.classList.contains('dj-filter-input') && input.classList.contains('browser-default'), act);
      assert.equal(input.getAttribute('placeholder'), placeholder);
    }
    assert.deepEqual([...box.panel().querySelectorAll('[data-mxf="genreMode"]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      [['Whitelist', 'true'], ['Blacklist', 'false']]);
    const moods = box.row('mood');
    assert.equal(moods.querySelector('.mix-filter-wide .mix-filter-label').textContent, 'Mood', 'its label above it, across the panel');
    assert.deepEqual([...moods.querySelectorAll('button')].map((b) => b.textContent),
      ['Happy', 'Neutral', 'Sad', 'Relaxed', 'Neutral', 'Aggressive', 'Instrumental', 'Vocals', 'Acoustic', 'Party', 'Danceable', 'Strict', 'Standard', 'Loose']);
    assert.ok([...moods.querySelectorAll('button')].every((b) => !b.hasAttribute('onclick') && !b.hasAttribute('data-dp')), 'no handlers: the panel listens');
    assert.equal(moods.querySelector('.mood-clear') || moods.querySelector('[data-mood-sort]'), null);
    for (const side of ['minDuration', 'maxDuration']) {
      const input = box.ctl(`input[data-mxf="${side}"]`);
      assert.ok(input.classList.contains('dj-duration-num') && input.classList.contains('browser-default'));
      assert.deepEqual([input.getAttribute('type'), input.getAttribute('placeholder'), input.value], ['number', 'No limit', '']);
    }
    assert.deepEqual([...box.panel().querySelectorAll('.dj-duration-field-label')].map((n) => n.textContent), ['Min (minutes)', 'Max (minutes)']);
    const clears = box.panel().querySelectorAll('.mood-clear');
    assert.equal(clears.length, 1);
    assert.ok(clears[0].closest('[data-mxf-row="length"]'), "at the Track length row's end");
    assert.ok(!box.shown(clears[0]), 'nothing set: no Clear');
  });

  test('the funnel: white at rest, orange while a filter is set, its open state on aria-expanded; a new mix opens with the panel closed and the filters carried', async () => {
    const box = mixSandbox();
    await box.open();
    const funnel = box.funnel();
    assert.ok(box.shown(funnel) && !funnel.classList.contains('mood-on'));
    assert.equal(funnel.getAttribute('aria-expanded'), 'false');
    box.openPanel();
    assert.equal(funnel.getAttribute('aria-expanded'), 'true');
    const select = box.ctl('[data-mxf="rating"]');
    select.value = '6';
    fire(select, 'change');
    assert.ok(funnel.classList.contains('mood-on'), 'orange at once');
    await box.flush();
    await box.S.instantMixOpen(ALBUM_SEED, ALBUM_HEAD);
    await settle();
    assert.equal(box.S.MIX.open, false);
    assert.ok(!box.shown(box.panel()));
    assert.ok(box.funnel().classList.contains('mood-on'), 'the filters carried');
    assert.equal(box.asked.at(-1).minRating, 6);
    box.openPanel();
    assert.equal(box.ctl('[data-mxf="rating"]').value, '6');
  });

  test("spa.css: the panel capped at 45vh, one column under a 420 px header — and on a column too short for the header and 45vh (a phone's), the open panel scrolls in what the column leaves, its last row in reach, two rows of the list in sight", () => {
    assert.match(CSS, /\n\.mix-filters \{ display: grid; grid-template-columns: max-content minmax\(0, 1fr\);[^}]*max-height: 45vh; overflow-y: auto; \}/);
    assert.match(CSS, /\n@container \(max-width: 419px\) \{\n {2}\.mix-filters \{ grid-template-columns: minmax\(0, 1fr\); \}\n\}/);
    // #browse-head never shrinks (flex-shrink: 0) and #filelist's basis is
    // its rows: on a 375 × 812 phone the open panel ran 40 px past the
    // column's foot, the Track length row and Clear out of reach
    assert.match(CSS, /\n#browse-head \{ flex-shrink: 0;/);
    const open = '#browse-head:has(> .mix-filters:not(.super-hide))';
    for (const rule of [`${open} { display: flex; flex-direction: column; flex-shrink: 1; min-height: 0; }`, `${open} > .browse-head { flex: none; }`,
      `${open} > .mix-filters { min-height: 0; }`, `${open} ~ #filelist { flex-basis: 0; min-height: 112px; }`]) {
      assert.ok(CSS.includes(`\n${rule}\n`), rule);
    }
  });
});

describe('Instant Mix filters: commits', () => {
  test("Sources: a pill in or out, the app's folder choice joined by those turned off; the last one in is inert; Auto DJ's own choice untouched", async () => {
    const box = mixSandbox({ server: { vpaths: ['music', 'podcasts', 'audiobooks'] }, ignore: { audiobooks: true } });
    await box.open();
    box.openPanel();
    assert.deepEqual([...box.panel().querySelectorAll('.dj-vpath-pill')].map((b) => b.textContent), ['music', 'podcasts'], 'what the folder choice leaves');
    const podcasts = box.ctl('[data-vpath="podcasts"]');
    podcasts.focus();
    fire(podcasts, 'click');
    assert.deepEqual([podcasts.classList.contains('on'), podcasts.getAttribute('aria-pressed')], [false, 'false']);
    const music = box.ctl('[data-vpath="music"]');
    assert.equal(music.getAttribute('aria-disabled'), 'true', 'the last one in');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).ignoreVPaths, ['audiobooks', 'podcasts']);
    const asks = box.asked.length;
    fire(music, 'click');
    await box.flush();
    assert.ok(music.classList.contains('on'), 'inert');
    assert.equal(box.asked.length, asks, 'nothing asked');
    fire(podcasts, 'click');
    await box.flush();
    assert.deepEqual(box.body().ignoreVPaths, ['audiobooks'], 'back to the folder choice alone');
    assert.equal(box.asked.length, asks, 'drawn from the answer kept for it');
    assert.equal(music.hasAttribute('aria-disabled'), false);
    assert.deepEqual(AUTODJ.state.djVpaths, [], "Auto DJ's own Sources");
    assert.deepEqual(box.player.ignoreVPaths, { audiobooks: true }, 'the legacy folder choice');
    assert.equal(box.doc.activeElement, podcasts, 'the pill keeps the keyboard');
    assert.equal(box.panel().writes, 1, 'the panel drawn once: every change in place');
  });

  test('Minimum Rating: 1–10 sent, Any sends none', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const select = box.ctl('[data-mxf="rating"]');
    select.value = '7';
    fire(select, 'change');
    await box.flush();
    assert.equal(box.asked.at(-1).minRating, 7);
    select.value = '0';
    fire(select, 'change');
    await box.flush();
    assert.equal('minRating' in box.body(), false);
  });

  test("BPM continuity: Dolo's windows; the tolerance row with it, its readout following the drag, its change the windows' width; Harmonic mixing: the 3A set", async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const bpm = box.ctl('[data-mxf="bpm"]');
    bpm.checked = true;
    fire(bpm, 'change');
    assert.ok(box.shown(box.row('tolerance')), 'the tolerance shows while tempo is on');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).bpmRanges, [{ min: 79, max: 95 }, { min: 40, max: 48 }, { min: 158, max: 190 }]);
    assert.equal('bpmRangesWide' in box.asked.at(-1), false);
    const slider = box.ctl('[data-mxf="tolerance"]');
    const asks = box.asked.length;
    slider.value = '4';
    fire(slider, 'input');
    assert.equal(box.ctl('[data-mxf-value="tolerance"]').textContent, '± 4');
    assert.equal(slider.getAttribute('aria-valuenow'), '4');
    assert.equal(box.liveTimers().length, 0, 'the drag asks nothing');
    fire(slider, 'change');
    await box.flush();
    assert.equal(box.asked.length, asks + 1);
    assert.deepEqual(box.asked.at(-1).bpmRanges, AUTODJ.buildBpmRanges(87, 4));
    bpm.checked = false;
    fire(bpm, 'change');
    assert.ok(!box.shown(box.row('tolerance')));
    await box.flush();
    assert.equal('bpmRanges' in box.body(), false);
    const was = box.asked.length;
    slider.value = '12';
    fire(slider, 'change');
    await box.flush();
    assert.equal(box.asked.length, was, 'a tolerance with tempo off asks nothing');
    const key = box.ctl('[data-mxf="harmonic"]');
    key.checked = true;
    fire(key, 'change');
    await box.flush();
    assert.deepEqual([box.asked.at(-1).musicalKeys, box.asked.at(-1).requireMusicalKey], [['3A', '3B', '2A', '2B', '4A', '4B'], true]);
  });

  test('Keyword filter: Enter or a comma adds a word (once, whatever its case; up to 50); its × takes it away and hands the keyboard to the field', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const input = box.ctl('input[data-mxf="word"]');
    const chips = box.ctl('[data-mxf-chips="words"]');
    input.focus();
    input.value = '  live ';
    assert.equal(fire(input, 'keydown', { key: 'Enter' }).defaultPrevented, true);
    assert.equal(input.value, '');
    input.value = 'acappella';
    fire(input, 'keydown', { key: ',' });
    assert.deepEqual([...chips.querySelectorAll('.dj-filter-tag-rm')].map((b) => b.getAttribute('data-word')), ['live', 'acappella']);
    input.value = 'LIVE';
    fire(input, 'keydown', { key: 'Enter' });
    assert.equal(input.value, 'LIVE', 'nothing new: left as typed');
    input.value = '   ';
    fire(input, 'keydown', { key: 'Enter' });
    assert.equal(fire(input, 'keydown', { key: 'a' }).defaultPrevented, false, 'any other key types');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).skipWords, ['live', 'acappella']);
    assert.equal(box.liveTimers().length, 0);
    assert.equal(box.doc.activeElement, input);
    fire(chips.querySelector('[data-word="live"]'), 'click');
    assert.deepEqual(box.S.MIX.filters.words, ['acappella']);
    assert.equal(box.doc.activeElement, input, 'the chip went: the keyboard to the field');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).skipWords, ['acappella']);
    box.S.MIX.filters.words = Array.from({ length: 50 }, (_, i) => `w${i}`);
    input.value = 'one more';
    fire(input, 'keydown', { key: 'Enter' });
    assert.equal(box.S.MIX.filters.words.length, 50, 'the cap');
    assert.equal(box.panel().writes, 1, 'the panel never drawn again');
  });

  test('Genre filter: the suggestions from the library, a suggestion pressed (mousedown, the field keeps the keyboard), free text on Enter; the mode asks only beside a genre', async () => {
    const box = mixSandbox();
    await box.open();
    assert.equal(box.genreAsks, 1, 'fetched as the mix opened');
    box.openPanel();
    const input = box.ctl('input[data-mxf="genre"]');
    const suggest = box.el('mix-genre-suggest');
    assert.equal(input.getAttribute('aria-controls'), 'mix-genre-suggest');
    input.focus();
    input.value = 'jaz';
    fire(input, 'input');
    assert.equal(suggest.hidden, false);
    assert.deepEqual([...suggest.querySelectorAll('.dj-genre-suggest-row')].map((r) => r.textContent), ['Jazz', 'Jazz Fusion']);
    const press = fire(suggest.querySelector('[data-genre="Jazz Fusion"]'), 'mousedown');
    assert.equal(press.defaultPrevented, true, 'before the field blurs');
    assert.deepEqual([input.value, box.doc.activeElement === input, suggest.hidden], ['', true, true]);
    assert.deepEqual(box.S.MIX.filters.genres, ['Jazz Fusion']);
    input.value = 'jaz';
    fire(input, 'input');
    assert.deepEqual([...suggest.querySelectorAll('.dj-genre-suggest-row')].map((r) => r.textContent), ['Jazz'], 'a chosen one is not offered');
    fire(input, 'keydown', { key: 'Escape' });
    assert.equal(suggest.hidden, true);
    input.value = 'Kompa';
    fire(input, 'keydown', { key: 'Enter' });
    await box.flush();
    assert.deepEqual([box.asked.at(-1).genres, box.asked.at(-1).genreMode], [['Jazz Fusion', 'Kompa'], 'whitelist']);
    const black = box.ctl('[data-mode="blacklist"]');
    fire(black, 'click');
    assert.deepEqual([...box.panel().querySelectorAll('[data-mxf="genreMode"]')].map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
    await box.flush();
    assert.equal(box.asked.at(-1).genreMode, 'blacklist');
    for (const g of ['Jazz Fusion', 'Kompa']) { fire(box.panel().querySelector(`.dj-filter-tag-rm[data-genre="${g}"]`), 'click'); }
    await box.flush();
    assert.deepEqual(keysOf(box.body()), [], 'no genre, no mode');
    const asks = box.asked.length;
    fire(box.ctl('[data-mode="whitelist"]'), 'click');
    await box.flush();
    assert.equal(box.asked.length, asks, 'the mode alone filters nothing');
    input.value = 'x';
    fire(input, 'focusout');
    assert.ok(box.timers.some((tm) => tm.live && tm.ms === 150), 'the dropdown hides after a grace');
  });

  test("Genre filter: suggestions opened under a field near the panel's foot are scrolled into the panel (its own 45vh scroll box), never past the field", async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const panel = box.panel();
    const input = box.ctl('input[data-mxf="genre"]');
    const suggest = box.el('mix-genre-suggest');
    // 1024 × 768: the panel's box 300–646 (1 px border), the field at its
    // foot as the panel opens, the list of six under it running to 829
    Object.assign(panel, { rect: { top: 300, bottom: 646 }, clientTop: 1, clientHeight: 344 });
    input.rect = { top: 600, bottom: 630 };
    suggest.rect = { top: 632, bottom: 829 };
    input.focus();
    input.value = 'jaz';
    fire(input, 'input');
    assert.equal(suggest.hidden, false);
    assert.equal(panel.scrollTop, 829 - 645, 'its foot at the panel\'s foot');
    // a list taller than the room left: the field goes to the panel's top, no further
    panel.scrollTop = 0;
    suggest.rect = { top: 632, bottom: 1100 };
    fire(input, 'input');
    assert.equal(panel.scrollTop, 600 - 301);
    // a list that already shows, or none: the panel stays where it is
    panel.scrollTop = 40;
    suggest.rect = { top: 400, bottom: 600 };
    fire(input, 'input');
    input.value = '';
    suggest.rect = { top: 632, bottom: 829 };
    fire(input, 'input');
    assert.deepEqual([panel.scrollTop, suggest.hidden], [40, true]);
  });

  test('Mood: a value, pressed again it lets go; tags; Strict sends its threshold, Standard none — and a strictness alone asks nothing', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const btn = (sel) => box.ctl(`[data-mxf-row="mood"] ${sel}`);
    const asks = box.asked.length;
    fire(btn('[data-mood-level="strict"]'), 'click');
    await box.flush();
    assert.equal(box.asked.length, asks, 'no mood: the same ask');
    assert.equal(btn('[data-mood-level="strict"]').getAttribute('aria-pressed'), 'true');
    const relaxed = btn('[data-mood-group="energy"][data-mood-value="relaxed"]');
    relaxed.focus();
    fire(relaxed, 'click');
    fire(btn('[data-mood-tag="party"]'), 'click');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).moods, { energy: 'relaxed', tags: ['party'], threshold: 0.7 });
    assert.equal(relaxed.getAttribute('aria-pressed'), 'true');
    assert.equal(box.doc.activeElement, relaxed);
    fire(btn('[data-mood-level="standard"]'), 'click');
    await box.flush();
    assert.deepEqual(box.asked.at(-1).moods, { energy: 'relaxed', tags: ['party'] }, 'Standard: the server default, left off');
    fire(relaxed, 'click');
    fire(btn('[data-mood-tag="party"]'), 'click');
    await box.flush();
    assert.equal('moods' in box.body(), false);
    assert.equal(relaxed.getAttribute('aria-pressed'), 'false');
    assert.equal(box.panel().writes, 1);
  });

  test('Track length: minutes in, seconds sent; a backwards window keeps the side just edited; the unknown-length switch shows beside a bound and goes out only with one', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const min = box.ctl('[data-mxf="minDuration"]');
    const max = box.ctl('[data-mxf="maxDuration"]');
    min.value = '2.5';
    fire(min, 'change');
    assert.ok(box.shown(box.row('unknown')), 'a bound: the switch');
    await box.flush();
    assert.deepEqual([box.asked.at(-1).minDuration, box.asked.at(-1).maxDuration, box.asked.at(-1).allowUnknownDuration], [150, undefined, false]);
    max.value = '1';
    fire(max, 'change');
    assert.deepEqual([min.value, max.value], ['1', '1'], 'the max kept, the min pulled down — written back');
    await box.flush();
    assert.deepEqual([box.asked.at(-1).minDuration, box.asked.at(-1).maxDuration], [60, 60]);
    const unknown = box.ctl('[data-mxf="unknown"]');
    unknown.checked = true;
    fire(unknown, 'change');
    await box.flush();
    assert.equal(box.asked.at(-1).allowUnknownDuration, true);
    min.value = '';
    max.value = 'abc';
    fire(min, 'change');
    assert.ok(!box.shown(box.row('unknown')));
    await box.flush();
    assert.deepEqual(keysOf(box.body()), [], 'no bound: none of the three');
    assert.equal(box.S.MIX.filters.allowUnknownDuration, true, 'the switch kept for the next bound');
  });

  test('Clear: every row emptied (the mood too), Clear gone, the keyboard on the funnel, the mix with no filter drawn again', async () => {
    const box = mixSandbox({ server: { vpaths: ['demo', 'podcasts'] } });
    await box.open();
    box.openPanel();
    const select = box.ctl('[data-mxf="rating"]');
    select.value = '8';
    fire(select, 'change');
    fire(box.ctl('[data-vpath="podcasts"]'), 'click');
    fire(box.ctl('[data-mxf-row="mood"] [data-mood-group="valence"][data-mood-value="happy"]'), 'click');
    const clear = box.ctl('[data-mxf="clear"]');
    assert.ok(box.shown(clear), 'shown while a filter is set');
    await box.flush();
    fire(clear, 'click');
    assert.deepEqual(box.S.MIX.filters, M.emptyFilters());
    assert.deepEqual(box.S.MOODS.filters.mix, {});
    assert.equal(box.doc.activeElement, box.funnel());
    assert.ok(!box.shown(box.ctl('[data-mxf="clear"]')), 'Clear hides itself');
    assert.equal(box.ctl('[data-mxf="rating"]').value, '0');
    assert.ok(!box.funnel().classList.contains('mood-on'));
    await box.flush();
    assert.deepEqual(keysOf(box.body()), []);
    assert.deepEqual(box.titles(), ['Dolo', 'Enfance', 'The Hangout']);
    assert.ok(box.shown(box.panel()), 'the panel stays open');
  });
});

describe('Instant Mix filters: asking again', () => {
  test('a burst of commits is one ask 250 ms after the last; the rows dimmed meanwhile; a newer ask wins; the answer leaves the panel and its keyboard alone', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const first = deferred();
    const second = deferred();
    const replies = [first.promise, second.promise];
    box.respond = () => replies.shift();
    const select = box.ctl('[data-mxf="rating"]');
    const input = box.ctl('input[data-mxf="word"]');
    select.value = '6';
    fire(select, 'change');
    input.focus();
    input.value = 'live';
    fire(input, 'keydown', { key: 'Enter' });
    assert.deepEqual(box.liveTimers().map((tm) => tm.ms), [250], 'one ask for the burst');
    const page = box.el('filelist').querySelector('.mix-page');
    assert.ok(page.classList.contains('mix-busy') && page.getAttribute('aria-busy') === 'true');
    box.runTimers();
    assert.deepEqual([box.asked.at(-1).minRating, box.asked.at(-1).skipWords], [6, ['live']]);
    select.value = '8';
    fire(select, 'change');
    first.resolve(answer([DOLO, HANGOUT]));
    await settle();
    assert.deepEqual(box.titles(), ['Dolo', 'Enfance', 'The Hangout'], 'the older answer never drawn');
    box.runTimers();
    input.value = 'remix';
    second.resolve(answer([DOLO, ENFANCE]));
    await settle();
    assert.deepEqual(box.titles(), ['Dolo', 'Enfance']);
    assert.ok(!box.el('filelist').querySelector('.mix-page').classList.contains('mix-busy'));
    assert.equal(box.doc.activeElement, input, 'the field being typed in keeps the keyboard');
    assert.equal(input.value, 'remix', 'and what it holds');
    assert.equal(box.panel().writes, 1);
  });

  test("a change that empties the mix: the no-match line with its Clear, the funnel orange, the panel kept open; the line's Clear asks with none", async () => {
    const box = mixSandbox();
    box.respond = (body) => (body.minRating ? answer([DOLO], { filteredOut: true }) : answer([DOLO, ENFANCE]));
    await box.open();
    box.openPanel();
    const select = box.ctl('[data-mxf="rating"]');
    select.value = '10';
    fire(select, 'change');
    await box.flush();
    assert.equal(box.line(), 'No songs match your filters');
    assert.ok(box.el('filelist').querySelector('.dpage-hint-btn[data-mx="clear"]'));
    assert.ok(box.funnel().classList.contains('mood-on') && box.shown(box.panel()));
    fire(box.el('filelist').querySelector('[data-mx="clear"]'), 'click');
    await box.flush();
    assert.deepEqual(keysOf(box.body()), []);
    assert.deepEqual(box.titles(), ['Dolo', 'Enfance']);
    assert.equal(box.ctl('[data-mxf="rating"]').value, '0', 'the open panel shows the filters cleared');
  });

  test('a change that fails: the line and Try again replace the rows, the funnel and the open panel stay', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    box.respond = () => null;
    const bpm = box.ctl('[data-mxf="bpm"]');
    bpm.checked = true;
    fire(bpm, 'change');
    await box.flush();
    assert.equal(box.line(), 'Couldn’t build the mix');
    assert.ok(box.el('filelist').querySelector('[data-mx="retry"]'));
    assert.ok(box.shown(box.funnel()) && box.shown(box.panel()));
    assert.equal(bpm.checked, true, 'the change still there to undo');
    // Try again is drawn away with its line: the keyboard goes to the
    // page's heading, not to the body
    box.respond = () => answer([DOLO, ENFANCE]);
    const retry = box.el('filelist').querySelector('[data-mx="retry"]');
    retry.focus();
    fire(retry, 'click');
    await box.flush();
    assert.deepEqual(box.titles(), ['Dolo', 'Enfance']);
    assert.equal(box.doc.activeElement, box.el('browse-head').querySelector('.browse-head-title'));
  });

  test('an answer without the mood echo: the Mood row goes, in place, and the mood filter empties', async () => {
    const box = mixSandbox();
    await box.open();
    box.openPanel();
    const happy = box.ctl('[data-mxf-row="mood"] [data-mood-group="valence"][data-mood-value="happy"]');
    box.respond = () => { const res = answer([DOLO, ENFANCE]); delete res.moods; return res; };
    fire(happy, 'click');
    await box.flush();
    assert.ok(!box.shown(box.row('mood')));
    assert.deepEqual(box.S.MOODS.filters.mix, {});
    assert.equal(happy.getAttribute('aria-pressed'), 'false');
    box.respond = () => answer([DOLO, ENFANCE]);
    const select = box.ctl('[data-mxf="rating"]');
    select.value = '2';
    fire(select, 'change');
    await box.flush();
    assert.ok(box.shown(box.row('mood')), 'back with an answer that has the echo');
  });

  test("the genres: fetched once as a mix opens — Auto DJ's cached list when fresh — and the row shows in place when they land while the panel is open", async () => {
    const late = deferred();
    const box = mixSandbox({ genresReply: () => late.promise });
    await box.open();
    box.openPanel();
    assert.ok(!box.shown(box.row('genres')), 'no list yet');
    late.resolve({ status: 'ok', value: ['Kompa'] });
    await settle();
    assert.ok(box.shown(box.row('genres')));
    assert.deepEqual(AUTODJ.getCachedGenresList(), ['Kompa'], "into Auto DJ's cache");
    await box.S.instantMixOpen(ALBUM_SEED, ALBUM_HEAD);
    await settle();
    assert.equal(box.genreAsks, 1, 'the cached list');
    const failed = mixSandbox({ genresReply: () => ({ status: 'error', value: null, code: 500 }) });
    await failed.open();
    failed.openPanel();
    assert.deepEqual(failed.S.MIX.genres, []);
    assert.ok(!failed.shown(failed.row('genres')));
  });
});
