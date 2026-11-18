/**
 * The redone Auto DJ panel (design E): m.js autoDjPanel and its builders.
 *
 * What is pinned:
 *   - the card's rows, top to bottom: Sources (only with more than one
 *     library), Batch; Filters: Smart filters (only where the ping has
 *     moodFilters), Genres, Rating, Length, Skip words; Match: Sonic
 *     similarity, then its indented sub-items Learn from skips, Seeds and
 *     (only with federationBrowse) Play from federated servers, then Beat
 *     matching, Harmonic mixing and Similar artists, the card's last row —
 *     with the renamed labels, and no hero, status or hint line and no
 *     retired locale key;
 *   - every switch is a role=switch checkbox inside its row's <label>; a
 *     filter's editor (and Sonic's amount, Beat matching's tolerance) is
 *     shown only while its switch is on, turning it off keeps the values,
 *     and every field carries Materialize's opt-out (browser-default);
 *   - Sonic similarity off hides the amount, dims its sub-items and makes
 *     them inert (Seeds disabled) and keeps both seed lists; without
 *     discovery its row is disabled;
 *   - Learn from skips reads "Needs a newer server" (dimmed, inert) when
 *     the ping's autoDj is below 1, its hint from 1, and is inert with no
 *     reason before the ping answers;
 *   - the Seeds row opens the drawer through autoDjSeedsOpen (aria-haspopup
 *     dialog), draws the three newest More like covers, newest leftmost
 *     (a peer row's through the art proxy), redraws them in place on a
 *     seeds or song change, and draws markup in data as text;
 *   - the ping's autoDj and /api/'s features.discoveryReady land on
 *     MSTREAMAPI.currentServer; the live playlist's boot clear is not a
 *     user clear; the Auto DJ nav item has an id for the library pick's
 *     return;
 *   - the Start/Stop label follows a 'dj' event (the player bar's toggle);
 *   - spa.css carries design E's block (the Materialize cascade fixes).
 *
 * Same technique as webapp-discovery-panel.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals. AUTODJ is the real module
 * under auto-dj-client.test.mjs's Map-backed localStorage shim, so the
 * panel draws real seeds views. A small fake document answers
 * getElementById from the drawn markup, so the handlers run as wired.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'm.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = fs.readFileSync(path.join(ROOT, 'webapp', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
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

function sliceFn(name) {
  const lines = SRC.split('\n');
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
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

// The start tags of drawn markup, with their attributes (values decoded).
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
const byId = (html, id) => tagsOf(html).find((el) => el.attrs.id === id) || null;
const classesOf = (el) => new Set((el && el.attrs.class ? el.attrs.class : '').split(/\s+/).filter(Boolean));
// The visible text of a markup fragment (tags dropped, entities decoded).
const textOf = (html) => decode(html.replace(/<[^>]*>/g, ''));

// Each switch row (a <label class="dj-row…">, which never nests): its input
// id, its label and subtext, its classes and its input's state.
function switchRows(html) {
  return [...html.matchAll(/<label class="(dj-row[^"]*)">([\s\S]*?)<\/label>/g)].map((m) => {
    const input = tagsOf(m[2]).find((el) => el.tag === 'input');
    const label = m[2].match(/<span class="(?:dj-row-label|dj-sub-title)"[^>]*>([\s\S]*?)<\/span>/);
    const desc = m[2].match(/<span class="dj-sub-desc"[^>]*>([\s\S]*?)<\/span>/);
    return {
      rowClass: m[1],
      input,
      id: input ? input.attrs.id : null,
      label: label ? textOf(label[1]) : null,
      desc: desc ? textOf(desc[1]) : null,
      checked: !!input && 'checked' in input.attrs,
      disabled: !!input && 'disabled' in input.attrs,
    };
  });
}
const rowOf = (html, id) => switchRows(html).find((r) => r.id === id) || null;

// The card's rows, in drawn order, by a marker each.
function rowOrder(html) {
  const re = /id="dj-src"|<label class="dj-field-label" for="(dj-limit|dj-min-rating)">|<h4 class="autodj-section-heading">([^<]*)<\/h4>|<input type="checkbox" role="switch" id="([^"]+)"|id="dj-seeds-btn"/g;
  return [...html.matchAll(re)].map((m) => {
    if (m[0] === 'id="dj-src"') { return 'Sources'; }
    if (m[1]) { return m[1] === 'dj-limit' ? 'Batch' : 'Rating'; }
    if (m[2] !== undefined) { return `h4:${textOf(m[2])}`; }
    if (m[3]) { return m[3]; }
    return 'Seeds';
  });
}

const RETIRED = ['heroDescription', 'statusOn', 'statusOff', 'sectionContinuity', 'sectionSonic', 'sourcesHint', 'limitLabel', 'limitHint',
  'minRating', 'similarHint', 'similarHintNoKey', 'bpmContinuityLabel', 'bpmContinuityHint', 'harmonicMixingHint', 'keywordFilterLabel',
  'keywordFilterHint', 'genreFilterLabel', 'genreFilterHint', 'genreHintEmpty', 'genreHintAuth', 'genreHintError', 'moodFilterLabel',
  'durationFilterLabel', 'durationFilterHint', 'durationUnknownHint', 'sonicHint', 'sonicHintNoDiscovery', 'sonicSimValue',
  'sonicSimAdventurous', 'sonicSimBalanced', 'sonicSimFocused', 'sonicSimLockedIn', 'sonicAnchorLabel', 'sonicAnchorRolling',
  'sonicAnchorLocked', 'sonicAnchorRollingHint', 'sonicAnchorLockedHint', 'sonicSeedLabel', 'sonicSeedHint', 'sonicSeedNone',
  'sonicSeedRemove', 'federatedHint', 'genreNoMatches', 'sonicSeedNeededTitle', 'sonicSeedNeeded'].map((k) => `autoDJ.${k}`);

// t() echoes the key, with its params when there are any.
const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);

const HOST = 'http://host/';
const peerArtUrl = (id, art, compress) => `${HOST}api/v1/federation/peers/${id}/art/${encodeURIComponent(art)}?compress=${compress}&token=TOK`;
const localArt = (art) => `${HOST}album-art/${encodeURIComponent(art)}?compress=s&token=TOK`;

const T0 = 1_700_000_000_000;
const song = (name, extra = {}) => ({ owner: null, path: `music/${name}.mp3`, title: name, artist: '', album: '', art: null, duration: null, ...extra });

// A fake document: #filelist takes a draw; every other id answers from the
// latest draw, as a stub carrying the drawn attributes (a redraw replaces
// them all, as the DOM does). Writes into a drawn element are recorded.
function makeDom() {
  const els = new Map();
  const writes = [];
  const focused = [];
  let drawn = '';
  let renders = 0;
  function makeEl(tag) {
    const attrs = { ...tag.attrs };
    const classes = classesOf(tag);
    const listeners = {};
    let inner = null;
    const el = {
      id: attrs.id,
      tag: tag.tag,
      attrs,
      hidden: 'hidden' in attrs,
      disabled: 'disabled' in attrs,
      checked: 'checked' in attrs,
      value: attrs.value ?? '',
      textContent: null,
      dataset: {},
      listeners,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) { classes.add(c); } else { classes.delete(c); }
          return on;
        },
      },
      setAttribute: (n, v) => { attrs[n] = String(v); },
      getAttribute: (n) => (n in attrs ? attrs[n] : null),
      removeAttribute: (n) => { delete attrs[n]; },
      addEventListener: (type, fn, opts) => {
        (listeners[type] ||= []).push(fn);
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => { listeners[type] = listeners[type].filter((f) => f !== fn); });
        }
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      focus: () => { focused.push(attrs.id); },
      get innerHTML() { return inner; },
      set innerHTML(h) { inner = h; writes.push({ id: attrs.id, html: h }); },
    };
    return el;
  }
  const filelist = {
    get innerHTML() { return drawn; },
    set innerHTML(h) {
      drawn = h;
      renders++;
      els.clear();
      for (const tag of tagsOf(h)) { if (tag.attrs.id) { els.set(tag.attrs.id, makeEl(tag)); } }
    },
  };
  const document = {
    getElementById: (id) => (id === 'filelist' ? filelist : els.get(id) ?? null),
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
  };
  return { document, els, writes, focused, filelist, renders: () => renders };
}

const FNS = ['escapeHtml', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'autoDjSeedArtUrl', 'autoDjSecToMin',
  'autoDjChipsHtml', 'autoDjSwitchRowHtml', 'autoDjSubState', 'autoDjSeedsTilesHtml', 'autoDjSubRowsHtml', 'autoDjPanelHtml',
  'autoDjApplySonicDim', 'autoDjRenderTiles', 'autoDjRenderToggle', 'autoDjPanel'];

// One stubbed app around the sliced panel.
//   server   MSTREAMAPI.currentServer's flags (the ping's)
//   lastfm   the Last.fm status's serverEnabled
//   genres   the library's genre list (null: the load fails)
//   djOn     MSTREAMPLAYER.playerStats.autoDJ
//   noHooks  a player without onAutoDj / fillBareSeeds (server-audio mode)
function makeSandbox({ server = {}, lastfm = true, genres = ['Rock', 'Jazz'], djOn = false, noHooks = false } = {}) {
  const dom = makeDom();
  const opened = [];
  const playerListeners = new Set();
  const calls = [];
  const unsubscribed = [];
  const live = new Set();
  const MSTREAMPLAYER = {
    playerStats: { autoDJ: djOn },
    toggleAutoDJ() {
      calls.push('toggle');
      this.playerStats.autoDJ = !this.playerStats.autoDJ;
      for (const fn of [...playerListeners]) { fn('dj'); }
      return this.playerStats.autoDJ;
    },
  };
  if (!noHooks) {
    MSTREAMPLAYER.onAutoDj = (fn) => { playerListeners.add(fn); return () => { playerListeners.delete(fn); }; };
    MSTREAMPLAYER.fillBareSeeds = () => { calls.push('fill'); };
  }
  // the real seeds, with subscribe watched (who let go)
  const seeds = {
    ...AUTODJ.seeds,
    subscribe: (fn) => {
      const off = AUTODJ.seeds.subscribe(fn);
      live.add(fn);
      return () => { unsubscribed.push(fn); live.delete(fn); off(); };
    },
  };
  const globals = {
    document: dom.document,
    AUTODJ: { ...AUTODJ, seeds },
    MSTREAMAPI: {
      currentServer: { host: HOST, token: 'TOK', vpaths: ['Music'], discovery: true, autoDj: 1, ...server },
      getGenres: () => Promise.resolve(genres ? { status: 'ok', value: genres } : { status: 'error', code: 500 }),
      peerArtUrl,
    },
    MSTREAMPLAYER,
    VUEPLAYERCORE: { songCapture: null },
    t: tStub,
    iziToast: { warning() {}, success() {}, error() {} },
    setBrowserRootPanel: () => {},
    _autoDjMigrateLegacyKeys: () => {},
    _fetchLastfmStatus: () => Promise.resolve({ serverEnabled: lastfm }),
    _syncVpathsToLegacy: () => {},
    autoDjSeedsOpen: (opts) => { opened.push(opts); },
  };
  const body = `
    'use strict';
    ${sliceConst('entityMap')}
    ${sliceConst('MOODS')}
    let _autoDjPanelAbortController = null;
    ${FNS.map(sliceFn).join('\n\n')}
    return { ${FNS.join(', ')} };
  `;
  const S = new Function(...Object.keys(globals), body)(...Object.values(globals));
  return { S, dom, globals, opened, calls, playerListeners, unsubscribed, live, server: globals.MSTREAMAPI.currentServer };
}

// The builders' ctx, as autoDjPanel reads it.
function ctxOf(sb, { vpaths = sb.server.vpaths, lastfmAvailable = true, genres = ['Rock'], loadState = 'ready', djOn = false } = {}) {
  return {
    state: AUTODJ.state,
    server: sb.server,
    vpaths,
    includedSet: new Set(AUTODJ.state.djVpaths.length > 0 ? AUTODJ.state.djVpaths : vpaths),
    lastfmAvailable,
    genres: { list: genres, loadState },
    djOn,
    limitMax: AUTODJ.LIMIT_MAX,
    seeds: AUTODJ.seeds.view(),
  };
}
const draw = (sb, opts) => sb.S.autoDjPanelHtml(ctxOf(sb, opts));

// A running lane, so edits go live (with the DJ off they are held aside,
// and view() still shows them).
function liveLane() {
  AUTODJ.seeds.setArmed(true);
  AUTODJ.seeds.laneEdge({ now: T0 });
  AUTODJ.seeds.beginPick({ current: null, now: T0 });
}
const seedKeys = (view) => ({ more: view.more.map((r) => [r.key, r.shownPinned]), less: view.less.map((r) => [r.key, r.shownPinned]) });

describe('the Auto DJ panel: rows', () => {
  test('the card\'s rows, top to bottom', () => {
    AUTODJ.setState({ sonicEnabled: true });
    const full = makeSandbox({ server: { vpaths: ['Music', 'Live'], moodFilters: true, federationBrowse: true } });
    assert.deepEqual(rowOrder(draw(full)), [
      'Sources', 'Batch',
      'h4:autoDJ.sectionFilters', 'dj-mood-on', 'dj-genre-on', 'Rating', 'dj-duration-on', 'dj-duration-unknown', 'dj-filter-on',
      'h4:autoDJ.sectionMatch', 'dj-sonic-on', 'dj-skips-on', 'Seeds', 'dj-federated-on', 'dj-bpm-cont', 'dj-harmonic', 'dj-similar',
    ]);
    // one library, no mood filters, no federation: no Sources, no Smart
    // filters, no federated sub-item
    const bare = makeSandbox({ server: { vpaths: ['Music'], moodFilters: false, federationBrowse: false } });
    assert.deepEqual(rowOrder(draw(bare)), [
      'Batch',
      'h4:autoDJ.sectionFilters', 'dj-genre-on', 'Rating', 'dj-duration-on', 'dj-duration-unknown', 'dj-filter-on',
      'h4:autoDJ.sectionMatch', 'dj-sonic-on', 'dj-skips-on', 'Seeds', 'dj-bpm-cont', 'dj-harmonic', 'dj-similar',
    ]);
    // the renamed labels
    const html = draw(full);
    const labels = Object.fromEntries(switchRows(html).map((r) => [r.id, r.label]));
    assert.deepEqual(labels, {
      'dj-mood-on': 'autoDJ.smartFiltersLabel',
      'dj-genre-on': 'autoDJ.genresLabel',
      'dj-duration-on': 'autoDJ.lengthLabel',
      'dj-duration-unknown': 'autoDJ.durationUnknownLabel',
      'dj-filter-on': 'autoDJ.skipWordsLabel',
      'dj-sonic-on': 'autoDJ.sonicLabel',
      'dj-skips-on': 'autoDJ.learnFromSkipsLabel',
      'dj-federated-on': 'autoDJ.federatedLabel',
      'dj-bpm-cont': 'autoDJ.beatMatchingLabel',
      'dj-harmonic': 'autoDJ.harmonicMixingLabel',
      'dj-similar': 'autoDJ.similarLabel',
    });
    assert.match(html, /<label class="dj-field-label" for="dj-limit">autoDJ\.batchLabel<\/label>/);
    assert.match(html, /<label class="dj-field-label" for="dj-min-rating">autoDJ\.ratingLabel<\/label>/);
    assert.match(html, /<span class="dj-sources-label" id="dj-src">autoDJ\.sectionSources<\/span><div class="dj-vpath-pills" id="dj-vpaths" role="group" aria-labelledby="dj-src">/);
    assert.match(html, /<span class="dj-seeds-row-label">autoDJ\.seedsLabel<\/span>/);
    // the sub-items are indented under Sonic similarity (one .dj-sub each)
    assert.match(html, /<div class="dj-sub" id="dj-sub-skips"><label class="dj-row dj-sub-row">/);
    assert.match(html, /<div class="dj-sub" id="dj-sub-seeds"><button type="button" id="dj-seeds-btn"/);
    assert.match(html, /<div class="dj-sub" id="dj-sub-federated"><label class="dj-row">/);
    // Similar artists is the card's last row (it drops the rule: spa.css)
    const last = switchRows(html).pop();
    assert.equal(last.id, 'dj-similar');
    assert.ok(html.endsWith('</label></div></div>'), 'nothing after Similar artists but the card\'s and the root\'s close');
    // Start/Stop leads, before the card
    const tags = tagsOf(html);
    assert.equal(tags[0].attrs.class, 'pad-6 autodj-root');
    assert.equal(tags[1].attrs.id, 'autodj-main-btn');
    assert.equal(tags[2].attrs.class, 'autodj-opts');
  });

  test('no hero, status or hint line, and no retired key', () => {
    AUTODJ.setState({ sonicEnabled: true, djFilterEnabled: true, djGenreEnabled: true, djDurationEnabled: true, djMoodEnabled: true, bpmContinuity: true });
    for (const autoDj of [0, 1, undefined]) {
      const sb = makeSandbox({ server: { vpaths: ['Music', 'Live'], moodFilters: true, federationBrowse: true, autoDj } });
      for (const html of [draw(sb), draw(sb, { lastfmAvailable: false, genres: [], loadState: 'error' })]) {
        for (const gone of ['autodj-hero', 'autodj-status', 'autodj-opt-hint', 'autodj-opt-row', 'dj-filter-head', 'dj-sonic-seed', 'dj-sonic-anchor', '<h2', '<p ', '<em>']) {
          assert.ok(!html.includes(gone), `${gone} is gone`);
        }
        const keys = [...decode(html).matchAll(/\b(autoDJ\.[A-Za-z]+|moods\.[A-Za-z]+)/g)].map((m) => m[1]);
        assert.ok(keys.length > 20);
        assert.deepEqual(keys.filter((k) => RETIRED.includes(k)), [], 'no retired key is drawn');
        assert.deepEqual([...new Set(keys)].filter((k) => !(k in EN)), [], 'every drawn key is in en.json');
      }
    }
    // …and none is left anywhere in m.js
    const used = RETIRED.filter((k) => new RegExp(`['"\`]${k.replace('.', '\\.')}['"\`]`).test(SRC));
    assert.deepEqual(used, []);
    for (const gone of ['getSonicSeed', 'setSonicSeed', 'clearSonicSeed', 'clearSonicAnchors', 'sonicLockedAnchor']) {
      assert.ok(!SRC.includes(gone), `m.js no longer calls ${gone}`);
    }
  });
});

describe('the Auto DJ panel: switches and editors', () => {
  test('every switch is a role=switch checkbox inside its row\'s label', () => {
    AUTODJ.setState({ sonicEnabled: true, djDurationEnabled: true });
    const sb = makeSandbox({ server: { vpaths: ['Music', 'Live'], moodFilters: true, federationBrowse: true } });
    const html = draw(sb);
    const boxes = tagsOf(html).filter((el) => el.tag === 'input' && el.attrs.type === 'checkbox');
    assert.equal(boxes.length, 11);
    for (const box of boxes) {
      assert.equal(box.attrs.role, 'switch', box.attrs.id);
      const row = rowOf(html, box.attrs.id);
      assert.ok(row, `${box.attrs.id} sits in a <label class="dj-row">`);
      // the switch takes its name from the wrapping label: no aria-labelledby,
      // except Learn from skips, named and described by its title and subtext
      if (box.attrs.id === 'dj-skips-on') {
        assert.equal(box.attrs['aria-labelledby'], 'dj-skips-t');
        assert.equal(box.attrs['aria-describedby'], 'dj-skips-d');
      } else {
        assert.ok(!('aria-labelledby' in box.attrs), box.attrs.id);
      }
    }
    // the switch itself is a span: labels can't nest
    assert.ok(!html.includes('<label class="toggle-sw"'));
    assert.equal(tagsOf(html).filter((el) => el.tag === 'span' && el.attrs.class === 'toggle-sw').length, 11);
    // a disabled row looks it (Similar artists without a Last.fm key)
    const noKey = rowOf(draw(sb, { lastfmAvailable: false }), 'dj-similar');
    assert.ok(noKey.disabled && !noKey.checked && noKey.rowClass.includes('is-disabled'));
  });

  test('an editor is drawn only while its switch is on, and off keeps the values', async () => {
    const EDITORS = [['dj-mood-on', 'dj-mood-editor', 'djMoodEnabled'], ['dj-genre-on', 'dj-genre-editor', 'djGenreEnabled'],
      ['dj-duration-on', 'dj-duration-editor', 'djDurationEnabled'], ['dj-filter-on', 'dj-filter-editor', 'djFilterEnabled']];
    const server = { moodFilters: true };
    // off: every editor drawn hidden (its fields never disabled)
    let html = draw(makeSandbox({ server }));
    for (const [, editor] of EDITORS) { assert.ok('hidden' in byId(html, editor).attrs, `${editor} hidden while off`); }
    // on: shown, holding today's controls
    AUTODJ.setState({ djMoodEnabled: true, djGenreEnabled: true, djDurationEnabled: true, djFilterEnabled: true, bpmContinuity: true });
    AUTODJ.addFilterWord('live');
    AUTODJ.addGenre('Rock');
    AUTODJ.setDurationBounds(120, 600, 'min');
    AUTODJ.setState({ djMoods: { valence: 'happy' } });
    html = draw(makeSandbox({ server }));
    for (const [, editor] of EDITORS) { assert.ok(!('hidden' in byId(html, editor).attrs), `${editor} shown while on`); }
    assert.ok(!('hidden' in byId(html, 'dj-bpm-tol-row').attrs), 'Beat matching\'s tolerance shows while on');
    // an editor's fields are never disabled: the editor hides instead
    for (const [, editor] of EDITORS) {
      const at = html.indexOf(`<div class="dj-editor" id="${editor}"`);
      const inside = tagsOf(html.slice(at, html.indexOf('</div></div>', html.indexOf('dj-', at + 30)) + 1));
      const controls = inside.filter((el) => ['input', 'select', 'button'].includes(el.tag));
      assert.ok(controls.length > 0, editor);
      assert.deepEqual(controls.filter((el) => 'disabled' in el.attrs).map((el) => el.attrs.id || el.attrs.class), [], `${editor}'s fields`);
    }
    assert.match(html, /<div class="dj-moods" id="dj-moods"><div class="mood-seg" role="group"/, 'Smart filters: the mood segments');
    assert.equal(byId(html, 'dj-moods') && tagsOf(html).find((el) => el.attrs['data-mood-value'] === 'happy').attrs['aria-pressed'], 'true');
    assert.ok(tagsOf(html).some((el) => el.attrs['data-mood-level'] === 'strict'), 'Strict | Standard | Loose');
    assert.ok(tagsOf(html).some((el) => el.attrs.class === 'dj-genre-mode-btn' && el.attrs['data-mode'] === 'whitelist'), 'Whitelist | Blacklist');
    assert.equal(byId(html, 'dj-genre-input').attrs.placeholder, 'autoDJ.genrePlaceholder');
    assert.ok(tagsOf(html).some((el) => el.attrs['data-genre'] === 'Rock'), 'the genre chips');
    assert.equal(byId(html, 'dj-duration-min').attrs.value, '2');
    assert.equal(byId(html, 'dj-duration-max').attrs.value, '10');
    assert.ok(tagsOf(html).some((el) => el.attrs['data-word'] === 'live'), 'the skip words chips');
    // the genre list failed to load: Genres off, its editor away
    const failed = draw(makeSandbox({ server }), { genres: [], loadState: 'error' });
    assert.ok(rowOf(failed, 'dj-genre-on').disabled && 'hidden' in byId(failed, 'dj-genre-editor').attrs);

    // the switches, as wired: off hides the editor and keeps the values,
    // on shows it again
    const sb = makeSandbox({ server });
    await sb.S.autoDjPanel();
    const kept = () => JSON.stringify([AUTODJ.state.djFilterWords, AUTODJ.state.djGenres, AUTODJ.state.djMinDuration,
      AUTODJ.state.djMaxDuration, AUTODJ.state.djMoods, AUTODJ.state.bpmTolerance]);
    const before = kept();
    for (const [sw, editor, key] of EDITORS) {
      sb.dom.els.get(sw).onchange({ target: { checked: false } });
      assert.equal(AUTODJ.state[key], false, key);
      assert.equal(sb.dom.els.get(editor).hidden, true, `${editor} hides`);
      sb.dom.els.get(sw).onchange({ target: { checked: true } });
      assert.equal(AUTODJ.state[key], true, key);
      assert.equal(sb.dom.els.get(editor).hidden, false, `${editor} shows`);
    }
    sb.dom.els.get('dj-bpm-cont').onchange({ target: { checked: false } });
    assert.equal(sb.dom.els.get('dj-bpm-tol-row').hidden, true);
    assert.equal(kept(), before, 'every filter keeps its values');
  });

  test('every field has browser-default', () => {
    AUTODJ.setState({ djMoodEnabled: true, djGenreEnabled: true, djDurationEnabled: true, djFilterEnabled: true });
    const html = draw(makeSandbox({ server: { moodFilters: true } }));
    const fields = tagsOf(html).filter((el) => el.tag === 'select' || (el.tag === 'input' && ['text', 'number', 'search'].includes(el.attrs.type)));
    assert.deepEqual(fields.map((el) => el.attrs.id).sort(), ['dj-duration-max', 'dj-duration-min', 'dj-filter-input', 'dj-genre-input', 'dj-limit', 'dj-min-rating']);
    for (const el of fields) { assert.ok(classesOf(el).has('browser-default'), el.attrs.id); }
  });
});

describe('the Auto DJ panel: Sonic similarity', () => {
  test('off: no amount line, sub-items dimmed and inert, Seeds disabled', () => {
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true, federatedEnabled: true, sonicMinSimilarity: 0.7 });
    const sb = makeSandbox({ server: { federationBrowse: true } });
    let html = draw(sb);
    // on: the amount (aria-label "Match strictness", the percentage)
    const sim = byId(html, 'dj-sonic-sim');
    assert.ok(!('hidden' in byId(html, 'dj-sonic-amount-row').attrs));
    assert.equal(sim.attrs.type, 'range');
    assert.deepEqual([sim.attrs.min, sim.attrs.max, sim.attrs.step, sim.attrs.value], ['30', '90', '1', '70']);
    assert.equal(sim.attrs['aria-label'], 'autoDJ.sonicSimilarityLabel');
    assert.equal(sim.attrs['aria-valuetext'], 'autoDJ.sonicAmountValue{"pct":70}');
    assert.equal(textOf(html.match(/<span class="dj-amount-value" id="dj-sonic-sim-val" aria-hidden="true">([^<]*)<\/span>/)[1]), 'autoDJ.sonicAmountValue{"pct":70}');
    for (const id of ['dj-sub-skips', 'dj-sub-seeds', 'dj-sub-federated']) { assert.ok(!classesOf(byId(html, id)).has('is-dim'), id); }
    assert.ok(!('disabled' in byId(html, 'dj-seeds-btn').attrs));
    // off
    AUTODJ.setState({ sonicEnabled: false });
    html = draw(sb);
    assert.ok('hidden' in byId(html, 'dj-sonic-amount-row').attrs, 'no amount line');
    assert.ok(!rowOf(html, 'dj-sonic-on').checked && !rowOf(html, 'dj-sonic-on').disabled);
    for (const id of ['dj-sub-skips', 'dj-sub-seeds', 'dj-sub-federated']) { assert.ok(classesOf(byId(html, id)).has('is-dim'), `${id} dimmed`); }
    assert.ok(rowOf(html, 'dj-skips-on').disabled && rowOf(html, 'dj-federated-on').disabled, 'inert');
    assert.ok(rowOf(html, 'dj-skips-on').checked && rowOf(html, 'dj-federated-on').checked, 'their values still show');
    assert.ok('disabled' in byId(html, 'dj-seeds-btn').attrs, 'Seeds disabled');
  });

  test('no discovery: the row disabled and the sub-items dimmed', () => {
    AUTODJ.setState({ sonicEnabled: true });
    const html = draw(makeSandbox({ server: { discovery: false, federationBrowse: true } }));
    const row = rowOf(html, 'dj-sonic-on');
    assert.ok(row.disabled && !row.checked && row.rowClass.includes('is-disabled'));
    assert.ok('hidden' in byId(html, 'dj-sonic-amount-row').attrs);
    for (const id of ['dj-sub-skips', 'dj-sub-seeds', 'dj-sub-federated']) { assert.ok(classesOf(byId(html, id)).has('is-dim'), id); }
    assert.ok('disabled' in byId(html, 'dj-seeds-btn').attrs);
  });

  test('turning sonic off leaves the seeds as they were', async () => {
    // the panel reads the seeds at the real time: a learned skip's 30
    // minutes run from now
    const T = Date.now();
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    AUTODJ.seeds.setArmed(true);
    AUTODJ.seeds.laneEdge({ now: T });
    AUTODJ.seeds.beginPick({ current: null, now: T });
    AUTODJ.seeds.add('more', song('pinned', { art: 'p.jpg' }), T);
    AUTODJ.seeds.onPlay(song('pick'), { lanePick: true, now: T + 1 });
    AUTODJ.seeds.add('less', song('nope'), T + 2);
    AUTODJ.seeds.onPlay(song('skipped'), { lanePick: true, now: T + 3 });
    AUTODJ.seeds.quickSkip(song('skipped'), { djPick: true, learn: true, now: T + 4 });
    const before = seedKeys(AUTODJ.seeds.view());
    assert.equal(before.more.length, 2);
    assert.equal(before.less.length, 2);
    const sb = makeSandbox({ server: { federationBrowse: true } });
    await sb.S.autoDjPanel();
    sb.dom.els.get('dj-sonic-on').onchange({ target: { checked: false } });
    assert.equal(AUTODJ.state.sonicEnabled, false);
    assert.deepEqual(seedKeys(AUTODJ.seeds.view()), before, 'both lists, pins and all, as they were');
    assert.equal(AUTODJ.state.learnFromSkips, true, 'Learn from skips keeps its value');
    // in place: the amount hides, the sub-items dim and go inert
    const els = sb.dom.els;
    assert.equal(els.get('dj-sonic-amount-row').hidden, true);
    for (const id of ['dj-sub-skips', 'dj-sub-seeds', 'dj-sub-federated']) { assert.ok(els.get(id).classList.contains('is-dim'), id); }
    assert.ok(els.get('dj-skips-on').disabled && els.get('dj-seeds-btn').disabled && els.get('dj-federated-on').disabled);
    assert.equal(sb.dom.renders(), 1, 'no redraw');
    // back on: everything comes back, the seeds untouched
    els.get('dj-sonic-on').onchange({ target: { checked: true } });
    assert.equal(els.get('dj-sonic-amount-row').hidden, false);
    for (const id of ['dj-sub-skips', 'dj-sub-seeds', 'dj-sub-federated']) { assert.ok(!els.get(id).classList.contains('is-dim'), id); }
    assert.ok(!els.get('dj-skips-on').disabled && !els.get('dj-seeds-btn').disabled && !els.get('dj-federated-on').disabled);
    assert.deepEqual(seedKeys(AUTODJ.seeds.view()), before);
    // the amount: stored as the raw cosine, shown and announced as a percentage
    const sim = els.get('dj-sonic-sim');
    sim.oninput({ target: sim });
    sim.value = '64';
    sim.oninput({ target: sim });
    assert.equal(AUTODJ.state.sonicMinSimilarity, 0.64);
    assert.equal(els.get('dj-sonic-sim-val').textContent, 'autoDJ.sonicAmountValue{"pct":64}');
    assert.equal(sim.getAttribute('aria-valuetext'), 'autoDJ.sonicAmountValue{"pct":64}');
  });
});

describe('the Auto DJ panel: Needs a newer server', () => {
  test('autoDj 0: Learn from skips reads Needs a newer server, dimmed and inert', async () => {
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    const sb = makeSandbox({ server: { autoDj: 0 } });
    const html = draw(sb);
    const learn = rowOf(html, 'dj-skips-on');
    assert.equal(learn.desc, 'autoDJ.needsNewerServer');
    assert.ok(learn.disabled, 'inert');
    assert.ok(learn.checked, 'the stored value still shows');
    assert.ok(classesOf(byId(html, 'dj-sub-skips')).has('is-dim'), 'dimmed');
    assert.equal(byId(html, 'dj-skips-d').attrs.class, 'dj-sub-desc', 'aria-describedby still points at the reason');
    // the rest of Sonic similarity works
    assert.ok(!('disabled' in byId(html, 'dj-seeds-btn').attrs));
    assert.ok(!classesOf(byId(html, 'dj-sub-seeds')).has('is-dim'));
    // turning sonic off and on again in place never wakes it
    await sb.S.autoDjPanel();
    sb.dom.els.get('dj-sonic-on').onchange({ target: { checked: false } });
    sb.dom.els.get('dj-sonic-on').onchange({ target: { checked: true } });
    assert.ok(sb.dom.els.get('dj-skips-on').disabled);
    assert.ok(sb.dom.els.get('dj-sub-skips').classList.contains('is-dim'));
    assert.ok(!sb.dom.els.get('dj-seeds-btn').disabled);
  });

  test('autoDj 1: the hint', () => {
    AUTODJ.setState({ sonicEnabled: true });
    const html = draw(makeSandbox({ server: { autoDj: 1 } }));
    const learn = rowOf(html, 'dj-skips-on');
    assert.equal(learn.label, 'autoDJ.learnFromSkipsLabel');
    assert.equal(learn.desc, 'autoDJ.learnFromSkipsHint');
    assert.ok(!learn.disabled && !learn.checked, 'live, and off by default');
    assert.ok(!classesOf(byId(html, 'dj-sub-skips')).has('is-dim'));
  });

  test('before the ping: inert, no reason', () => {
    AUTODJ.setState({ sonicEnabled: true });
    const html = draw(makeSandbox({ server: { autoDj: undefined } }));
    const learn = rowOf(html, 'dj-skips-on');
    assert.equal(learn.desc, 'autoDJ.learnFromSkipsHint', 'no reason before the ping answers');
    assert.ok(learn.disabled);
    assert.ok(classesOf(byId(html, 'dj-sub-skips')).has('is-dim'));
  });
});

describe('the Auto DJ panel: the Seeds row', () => {
  test('aria-haspopup dialog, aria-expanded false; it opens the drawer', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    const sb = makeSandbox();
    const html = draw(sb);
    const btn = byId(html, 'dj-seeds-btn');
    assert.equal(btn.tag, 'button');
    assert.equal(btn.attrs.type, 'button');
    assert.equal(btn.attrs['aria-haspopup'], 'dialog');
    assert.equal(btn.attrs['aria-expanded'], 'false');
    assert.ok(!('aria-controls' in btn.attrs), 'aria-controls only while the drawer is open');
    assert.equal(byId(html, 'dj-seeds-tiles').attrs['aria-hidden'], 'true');
    assert.match(html, /<svg class="dj-seeds-chev" [^>]*aria-hidden="true"><path d="M9 6l6 6-6 6"><\/path><\/svg><\/button>/);
    // a press opens the drawer through its one way in
    await sb.S.autoDjPanel();
    sb.dom.els.get('dj-seeds-btn').onclick();
    assert.deepEqual(sb.opened, [{}]);
    // disabled (Sonic off): nothing opens
    sb.dom.els.get('dj-sonic-on').onchange({ target: { checked: false } });
    sb.dom.els.get('dj-seeds-btn').onclick();
    assert.equal(sb.opened.length, 1);
    // back from the library pick: the drawer opens on its lists, focus on
    // that list's Add song — only where the Seeds row could open it
    AUTODJ.setState({ sonicEnabled: true });
    await sb.S.autoDjPanel({ seeds: 'less' });
    assert.deepEqual(sb.opened[1], { list: 'less', focus: 'add' });
    AUTODJ.setState({ sonicEnabled: false });
    await sb.S.autoDjPanel({ seeds: 'more' });
    assert.equal(sb.opened.length, 2);
    // the side nav passes nothing: no drawer
    AUTODJ.setState({ sonicEnabled: true });
    await sb.S.autoDjPanel();
    assert.equal(sb.opened.length, 2);
  });

  test('the covers are the three newest, newest first; none when empty', () => {
    const sb = makeSandbox();
    assert.equal(byId(draw(sb), 'dj-seeds-tiles') && draw(sb).match(/<span class="dj-seeds-tiles" id="dj-seeds-tiles" aria-hidden="true">(.*?)<\/span><svg/)[1], '');
    assert.equal(sb.S.autoDjSeedsTilesHtml({ tiles: [] }), '');
    liveLane();
    for (const n of [1, 2, 3, 4]) { AUTODJ.seeds.add('more', song(`s${n}`, { art: `a${n}.jpg` }), T0 + n); }
    AUTODJ.seeds.add('less', song('no', { art: 'no.jpg' }), T0 + 9);
    const tiles = tagsOf(sb.S.autoDjSeedsTilesHtml(AUTODJ.seeds.view(T0 + 10)));
    assert.deepEqual(tiles.map((el) => [el.tag, el.attrs.class, el.attrs.alt, el.attrs.src]), [
      ['img', 'dj-seeds-tile', '', localArt('a4.jpg')],
      ['img', 'dj-seeds-tile', '', localArt('a3.jpg')],
      ['img', 'dj-seeds-tile', '', localArt('a2.jpg')],
    ]);
    // the panel draws the same
    const html = draw(sb);
    assert.deepEqual(tagsOf(html.match(/id="dj-seeds-tiles" aria-hidden="true">(.*?)<\/span><svg/)[1]).map((el) => el.attrs.src),
      [localArt('a4.jpg'), localArt('a3.jpg'), localArt('a2.jpg')]);
  });

  test('a peer row\'s cover goes through the art proxy', () => {
    const sb = makeSandbox();
    assert.equal(sb.S.autoDjSeedArtUrl(song('a', { art: 'x y.jpg' })), localArt('x y.jpg'));
    assert.equal(sb.S.autoDjSeedArtUrl(song('a', { owner: 7, art: 'p.jpg' })), peerArtUrl(7, 'p.jpg', 's'));
    assert.equal(sb.S.autoDjSeedArtUrl(song('a')), null, 'no art');
    assert.equal(sb.S.autoDjSeedArtUrl(null), null);
    liveLane();
    AUTODJ.seeds.add('more', song('local'), T0);
    AUTODJ.seeds.onPlay(song('peer', { owner: 7, art: 'p.jpg' }), { lanePick: true, now: T0 + 1 });
    const tiles = tagsOf(sb.S.autoDjSeedsTilesHtml(AUTODJ.seeds.view(T0 + 2)));
    assert.deepEqual(tiles.map((el) => [el.tag, el.attrs.class, el.attrs.src ?? null]), [
      ['img', 'dj-seeds-tile', peerArtUrl(7, 'p.jpg', 's')],
      ['span', 'dj-seeds-tile is-none', null],
    ]);
  });

  test('a seeds change redraws the covers in place', async () => {
    AUTODJ.setState({ sonicEnabled: true });
    liveLane();
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    assert.deepEqual(sb.calls, ['fill'], 'a draw asks the player to fill bare seed rows');
    const tilesEl = sb.dom.els.get('dj-seeds-tiles');
    AUTODJ.seeds.add('more', song('one', { art: '1.jpg' }), T0 + 1);
    assert.deepEqual(tagsOf(tilesEl.innerHTML).map((el) => el.attrs.src), [localArt('1.jpg')]);
    AUTODJ.seeds.onPlay(song('two', { art: '2.jpg' }), { lanePick: true, now: T0 + 2 });
    assert.deepEqual(tagsOf(tilesEl.innerHTML).map((el) => el.attrs.src), [localArt('2.jpg'), localArt('1.jpg')]);
    AUTODJ.seeds.remove(AUTODJ.seeds.keyOf(null, 'music/two.mp3'), T0 + 3);
    assert.deepEqual(tagsOf(tilesEl.innerHTML).map((el) => el.attrs.src), [localArt('1.jpg')]);
    // a song change redraws them too
    const writes = sb.dom.writes.length;
    for (const fn of sb.playerListeners) { fn('song'); }
    assert.equal(sb.dom.writes.length, writes + 1);
    assert.equal(sb.dom.renders(), 1, 'never a whole-panel redraw');
    // another view takes the column: the listeners let go by themselves
    assert.equal(sb.live.size, 1);
    sb.dom.filelist.innerHTML = '<div id="something-else"></div>';
    AUTODJ.seeds.add('more', song('three'), T0 + 4);
    assert.equal(sb.live.size, 0, 'the seeds listener let go');
    for (const fn of [...sb.playerListeners]) { fn('song'); }
    assert.equal(sb.playerListeners.size, 0, 'the player listener let go');
    // a new draw aborts the last one's listeners: one of each stays live
    await sb.S.autoDjPanel();
    await sb.S.autoDjPanel();
    assert.equal(sb.live.size, 1);
    assert.equal(sb.playerListeners.size, 1);
  });

  test('a title or path holding markup draws as text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    liveLane();
    AUTODJ.seeds.add('more', song('a', { title: evil, path: 'music/a"b].mp3', artist: evil, art: `"><img src=x onerror=alert(2)>.jpg` }), T0);
    AUTODJ.setState({ djFilterEnabled: true, djGenreEnabled: true });
    AUTODJ.addFilterWord(evil);
    AUTODJ.addGenre(`"x"=${evil}`);
    const sb = makeSandbox({ server: { vpaths: [evil, 'Music'] } });
    const html = draw(sb, { genres: ['Rock'] });
    const tags = tagsOf(html);
    // the data never reaches the markup raw (the scanner reads quoted
    // attributes only, so look for the raw text itself too)
    assert.ok(!html.includes('onerror='), 'no raw markup from the data');
    assert.ok(!tags.some((el) => 'onerror' in el.attrs), 'no injected element');
    assert.deepEqual([...html.matchAll(/<button type="button" class="dj-vpath-pill[^"]*" data-vpath="[^"]*" aria-pressed="[^"]*">([^<]*)<\/button>/g)].map((m) => decode(m[1])),
      [evil, 'Music'], 'each library pill reads its name as text');
    assert.equal(tags.filter((el) => el.tag === 'img').length, 1, 'the one cover');
    assert.equal(byId(html, 'dj-seeds-tiles') && tags.find((el) => el.tag === 'img').attrs.src, localArt(`"><img src=x onerror=alert(2)>.jpg`));
    // the data reads back exactly, as attributes and as text
    assert.deepEqual(tags.filter((el) => 'data-vpath' in el.attrs).map((el) => el.attrs['data-vpath']), [evil, 'Music']);
    assert.ok(textOf(html).includes(evil), 'the library name is drawn as text');
    assert.equal(tags.find((el) => el.attrs.class === 'dj-filter-tag-rm' && 'data-word' in el.attrs).attrs['data-word'], evil);
    assert.equal(tags.find((el) => el.attrs.class === 'dj-filter-tag-rm' && 'data-genre' in el.attrs).attrs['data-genre'], `"x"=${evil}`);
    assert.equal(tags.find((el) => 'data-word' in el.attrs).attrs['aria-label'], `autoDJ.keywordFilterTagRemove${JSON.stringify({ word: evil })}`);
  });
});

describe('the Auto DJ panel: facts on the server object', () => {
  const applySandbox = () => {
    const MSTREAMAPI = { currentServer: {} };
    const fn = new Function('MSTREAMAPI', 'discoveryView', 'discoverySetEntry', 'DISCOVERYPAGE',
      `${sliceFn('applyDiscoveryPing')}\nreturn applyDiscoveryPing;`)(MSTREAMAPI, {}, () => {}, { pageAvailable: () => false });
    return { MSTREAMAPI, applyDiscoveryPing: fn };
  };

  test('applyDiscoveryPing keeps the ping\'s autoDj as a number', () => {
    const { MSTREAMAPI, applyDiscoveryPing } = applySandbox();
    for (const [ping, want] of [[{ autoDj: 1 }, 1], [{ autoDj: 2 }, 2], [{ autoDj: '1' }, 1], [{ autoDj: 0 }, 0], [{}, 0], [{ autoDj: 'x' }, 0], [null, 0]]) {
      applyDiscoveryPing(ping);
      assert.equal(MSTREAMAPI.currentServer.autoDj, want, JSON.stringify(ping));
      assert.equal(typeof MSTREAMAPI.currentServer.autoDj, 'number');
    }
    // the gates the panel reads from it
    assert.ok(AUTODJ.seeds.needsNewerServer({ autoDj: 0, discovery: true }));
    assert.ok(AUTODJ.seeds.takesNegatives({ autoDj: 1, discovery: true }));
  });

  test('init reads discoveryReady from /api/ features', () => {
    const init = sliceFn('init');
    const then = init.slice(init.indexOf('MSTREAMAPI.serverInfo()'), init.indexOf('.catch(() => {'));
    const m = then.match(/\.then\(\(info\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*const feats = ([^\n]+);\n\s*MSTREAMAPI\.currentServer\.discoveryReady = ([^\n]+);\n\s*const admin = /);
    assert.ok(m, 'the first statements of serverInfo().then: before the admin and username lines, which a throw would skip');
    const read = new Function('info', `const feats = ${m[1]}; return ${m[2]};`);
    assert.equal(read({ features: { discoveryReady: true } }), true);
    assert.equal(read({ features: { discoveryReady: false } }), false);
    assert.equal(read({ features: { discoveryReady: 'yes' } }), false, 'only true reads ready');
    for (const info of [{ features: {} }, {}, null, undefined, { features: null }, { features: 'x' }, { features: 7 }]) {
      assert.equal(read(info), undefined, `unknown for ${JSON.stringify(info)}`);
    }
    const fail = init.slice(init.indexOf('.catch(() => {'), init.indexOf('MSTREAMAPI.currentServer.discoveryPath'));
    assert.match(fail, /^\.catch\(\(\) => \{\n\s*MSTREAMAPI\.currentServer\.discoveryReady = undefined;\n/, 'a failed /api/ leaves it unknown');
  });
});

describe('the Auto DJ panel: Start/Stop', () => {
  test('the label follows a dj event from the player bar', async () => {
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    assert.equal(sb.playerListeners.size, 1);
    const btn = sb.dom.els.get('autodj-main-btn');
    assert.ok(!btn.classList.contains('on'));
    // the player bar's toggle: the player flips the DJ and says 'dj'
    sb.globals.MSTREAMPLAYER.playerStats.autoDJ = true;
    for (const fn of sb.playerListeners) { fn('dj'); }
    assert.equal(btn.textContent, 'autoDJ.btnStop');
    assert.ok(btn.classList.contains('on'));
    sb.globals.MSTREAMPLAYER.playerStats.autoDJ = false;
    for (const fn of sb.playerListeners) { fn('dj'); }
    assert.equal(btn.textContent, 'autoDJ.btnStart');
    assert.ok(!btn.classList.contains('on'));
    // its own press toggles in place: no redraw, so it keeps focus
    btn.onclick();
    assert.deepEqual(sb.calls.filter((c) => c === 'toggle'), ['toggle']);
    assert.equal(btn.textContent, 'autoDJ.btnStop');
    assert.equal(sb.dom.renders(), 1);
    // drawn with the DJ on
    assert.match(draw(sb, { djOn: true }), /<button type="button" class="autodj-toggle on" id="autodj-main-btn">autoDJ\.btnStop<\/button>/);
    // server-audio mode's player has no hooks: the panel still draws and
    // its own press still flips the label
    const plain = makeSandbox({ noHooks: true });
    await plain.S.autoDjPanel();
    plain.dom.els.get('autodj-main-btn').onclick();
    assert.equal(plain.dom.els.get('autodj-main-btn').textContent, 'autoDJ.btnStop');
  });
});

describe('the Auto DJ panel: init and the nav', () => {
  test('the live playlist\'s boot clear is not a user clear', () => {
    const init = sliceFn('init');
    assert.match(init, /MSTREAMPLAYER\.clearPlaylist\(\{ userClear: false \}\);\n\s*response\.forEach\(value => \{\n\s*VUEPLAYERCORE\.addSongWizard\(/);
    assert.ok(!/clearPlaylist\(\)/.test(init), 'no bare clear left in init');
  });

  test('the Auto DJ nav item is #nav-auto-dj and keeps the onclick server-audio mode hides it by', () => {
    const items = [...INDEX.matchAll(/<div ([^>]*onclick="changeView\(autoDjPanel, this\);"[^>]*)>/g)];
    assert.equal(items.length, 1);
    assert.match(items[0][1], /^id="nav-auto-dj" class="local-only side-nav-item my-waves"/);
  });
});

describe('the Auto DJ panel: spa.css (design E)', () => {
  // design E's block: up to the seeds drawer's block (design B, appended
  // after it), else up to the next section
  const start = CSS.indexOf('/* Auto DJ panel (design E) */');
  const block = CSS.slice(start, Math.min(...['/* Auto DJ seeds drawer (design B)', '/* Now-playing BPM/key pills']
    .map((m) => CSS.indexOf(m, start)).filter((i) => i > start)));
  const rule = (sel) => {
    const at = CSS.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `${sel} has a rule`);
    return CSS.slice(at, CSS.indexOf('}', at) + 1);
  };

  test('the panel\'s block: rows, hidden parts, and the Materialize fixes', () => {
    assert.ok(CSS.includes('/* Auto DJ panel (design E)'), 'design E\'s block');
    assert.match(block, /\n\.dj-amount\[hidden\], \.dj-editor\[hidden\] \{ display: none; \}/, 'a class display never beats [hidden]');
    assert.match(block, /\n\.autodj-opts > :last-child \{ border-bottom: 0; \}/);
    assert.match(block, /\n\.dj-row \{[^}]*min-height: 48px;[^}]*font-size: 14px; color: #f5f7fa; \}/, 'a label row sets its own type (Materialize\'s label is .8rem)');
    assert.match(block, /\n\.dj-seeds-row:focus \{ background: transparent; \}/, 'no teal focused button');
    assert.match(block, /\n\.dj-sub \{ margin-left: 24px; border-bottom: 1px solid #383c47; \}/);
    // the sliders: heavier than Materialize's input[type=range], one rule
    // per vendor pseudo-element (an engine drops a list naming one it lacks)
    const sliders = block.split('\n').filter((l) => l.includes('.autodj-slider'));
    assert.ok(sliders.length >= 7);
    for (const l of sliders) {
      assert.ok(l.startsWith('.autodj-opts input[type="range"].autodj-slider'), l);
      assert.ok(!(l.includes('-webkit-') && l.includes('-moz-')) || !l.includes(','), l);
    }
    assert.match(block, /::-webkit-slider-thumb \{[^}]*width: 16px; height: 16px;[^}]*background: #fa832b;/);
    assert.match(block, /::-moz-range-thumb \{[^}]*background: #fa832b;/);
    assert.match(block, /\.autodj-slider:focus-visible \{ outline: 2px solid #fa832b; outline-offset: 2px; \}/);
    // the fields and the buttons Materialize restyles
    assert.match(rule('.autodj-select'), /height: 44px;[\s\S]*color-scheme: dark;/);
    assert.match(CSS, /\n\.autodj-select:focus-visible \{\n {2}outline: 2px solid #fa832b;/);
    assert.match(CSS, /\n\.autodj-toggle:focus \{ background: transparent; color: #fa832b; \}/);
    assert.match(CSS, /\n\.dj-vpath-pill:focus \{ background: #1a1d23; \}/);
    assert.match(rule('.autodj-toggle'), /margin: 0 0 24px;/, 'no status line under it');
  });

  test('today\'s dead rules are gone; shared rules are untouched', () => {
    for (const gone of ['.autodj-hero', '.autodj-status', '.autodj-opt-row', '.autodj-opt-hint', '.dj-filter-head', '.dj-duration-unknown', '.dj-moods button:disabled']) {
      assert.ok(!CSS.includes(gone), `${gone} is gone`);
    }
    assert.match(CSS, /\n\.autodj-opt-label \{/, 'Sonic Path still uses .autodj-opt-label');
    // the Genres panel's source switch and the mood bar share these lists
    assert.match(CSS, /\n\.dj-genre-mode, \.genre-source \{\n {2}display: inline-flex;\n {2}margin-top: 6px;/);
    assert.match(CSS, /\n\.dj-genre-mode-btn, \.genre-source-btn \{\n {2}appearance: none;/);
    assert.match(CSS, /\n\.mood-seg-btn, \.mood-chip, \.mood-clear \{\n {2}appearance: none;\n {2}height: 34px;/);
    assert.match(block, /\n\.dj-moods \.mood-seg-btn, \.dj-moods \.mood-chip, \.dj-moods \.mood-clear \{ height: 44px; \}/, '44px only inside the panel');
  });
});
