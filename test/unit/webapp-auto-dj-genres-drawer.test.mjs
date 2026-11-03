/**
 * The Auto DJ Genres drawer (the phone's Genres sheet, in the Seeds
 * drawer's shell): m.js autoDjGenres* and the shared autoDjDrawer*, and
 * api.js getGenres(source).
 *
 * What is pinned:
 *   - the shell: a modal dialog on its own scrim (a .dmodal-shadow on body,
 *     the Seeds drawer's .dj-seeds kit), named by its heading, Close its
 *     first child; open puts the keyboard on Close and marks the Genres
 *     row (aria-expanded, aria-controls); Close, Esc (from the search too)
 *     and a scrim press that began on the scrim close it and give the
 *     keyboard back to the row — a drag out of the drawer, a double-click's
 *     later press and an IME's Esc don't; Tab wraps inside it (an off box
 *     skipped); a view that takes the column closes it, the keyboard left
 *     be; closing writes nothing;
 *   - its lists: the panel's cached answer opens it without an ask, else
 *     one ask for every kind (which fills the cache); a stored kind opens
 *     on its own list; each kind is asked for once per open, a failed one
 *     again at its next turn; an answer for an earlier open is dropped;
 *   - Only | Skip and Generated | Tags | Mixed: pressed by the filter; the
 *     kind offered only where the latest answer has genres of both kinds
 *     and the server is known to take the kind (/api/'s version, read at
 *     the open and at each answer: one that comes in between leaves the
 *     list drawn as it is until then); a change is stored at once (the
 *     row's value with it) and the pressed one writes nothing; a kind
 *     change keeps the chosen genres ticked and in view; an answer without
 *     both kinds takes a stored kind back to Mixed, the keyboard leaving
 *     the vanishing switch for the pressed Only | Skip; where an answer is
 *     in but the switch is hidden, a change stores Mixed (before any
 *     answer the stored kind stays);
 *   - the list: the chosen genres first, sorted and pinned (a tick never
 *     moves a row; a genre the server no longer reports can be let go),
 *     then the kind's genres sorted; one row per name whatever its case;
 *     ticks stored at once with no redraw (the box keeps the keyboard); the
 *     filter on exactly while genres are chosen; a filter that is off opens
 *     with nothing ticked, its stored list kept until the first change
 *     replaces it; at 200, "200 max" by the heading and the unticked boxes
 *     off; the search by substring, the pinned rows too, kept across kinds;
 *     the states: a spinner (the pinned rows wait too), "No genres", "No
 *     matches", "Could not load genres" alone or above the pinned rows;
 *   - names holding markup draw as text, reach their genre and are found
 *     again by comparing data-genre (never a selector built from one);
 *     every drawn key is in en.json;
 *   - api.js getGenres(source): the body it posts, the answer's kinds;
 *   - spa.css: the Genres drawer's block, after the Seeds drawer's.
 *
 * Technique: webapp-auto-dj-seeds-drawer.test.mjs's — the real panel and
 * drawer functions sliced out of m.js and run against stub globals, AUTODJ
 * the real module under a Map-backed localStorage shim, and the small real
 * DOM (test/helpers/drawer-dom.mjs: markup parsed into a tree; focus,
 * selectors and events as a browser's). A tick there is what a browser
 * does for a press on a box, its label, or Space on a focused box: the box
 * turns, then input and change fire on it.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { VP, serialize, makeDocument, fire, click, press, typeInto, settle, deferred } from '../helpers/drawer-dom.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'm.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'spa.css'), 'utf8').replace(/\r\n/g, '\n');
const API_SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
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
  const header = (l) => l.split(' (').join('(');
  const start = LINES.findIndex((l) =>
    header(l).startsWith(`function ${name}(`) ||
    header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < LINES.length; i++) {
    if (LINES[i] === '}') return LINES.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceConst(name) {
  const start = LINES.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  for (let i = start; i < LINES.length; i++) {
    if (LINES[i] === '};') return LINES.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

// t() echoes the key, with its params when there are any.
const tStub = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);

const HOST = 'http://host/';
const peerArtUrl = (id, art, compress) => `${HOST}api/v1/federation/peers/${id}/art/${encodeURIComponent(art)}?compress=${compress}&token=TOK`;
const KIND_KEY = 'mstream-dj-djGenreSource';

// The library: every kind (the Mixed list, in the server's order: the
// drawer sorts it), Tags and Generated; and how many genres of each kind it
// has (the answer's sources).
const LISTS = {
  both: ['Rock', 'jazz', 'Ambient', 'Hip Hop', 'house'],
  tag: ['Rock', 'jazz', 'Hip Hop'],
  model: ['Ambient', 'house', 'Rock'],
};
const BOTH = { tag: 3, model: 3 };
const MIXED_SORTED = ['Ambient', 'Hip Hop', 'house', 'jazz', 'Rock'];
// 'G000', 'G001', …
const numbered = (n) => Array.from({ length: n }, (_, i) => `G${String(i).padStart(3, '0')}`);

const PANEL_FNS = ['escapeHtml', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'autoDjSeedArtUrl', 'autoDjSecToMin',
  'ratingOptionsHtml', 'autoDjChipsHtml', 'autoDjGenresValue', 'autoDjSwitchRowHtml', 'autoDjSubState', 'autoDjSeedsTilesHtml', 'autoDjSubRowsHtml', 'autoDjPanelHtml',
  'autoDjApplySonicDim', 'autoDjRenderTiles', 'autoDjRenderToggle', 'autoDjPanel'];
// Every function of the Genres drawer and of the drawers' shell.
const DRAWER_FNS = [...SRC.matchAll(/^(?:async )?function ((?:autoDjGenres|onAutoDjGenres|autoDjDrawer)\w*)\(/gm)].map((m) => m[1]);
const FNS = [...new Set([...PANEL_FNS, ...DRAWER_FNS, 'getLoadingSvg'])];

// The statement setBrowserRootPanel (every view that takes the column)
// runs for the Genres drawer; the sandbox's setBrowserRootPanel runs it too.
const ROOT_PANEL_GENRES = sliceFn('setBrowserRootPanel').split('\n').map((l) => l.trim())
  .find((l) => l.includes('autoDjGenres') && !l.startsWith('//')) || '';

const BODY = '<div id="nav-auto-dj" class="local-only side-nav-item"></div><div id="filelist"></div>';

const SANDBOX_BODY = `
  'use strict';
  ${sliceConst('entityMap')}
  ${sliceConst('MOODS')}
  ${sliceConst('AUTODJ_SEEDS_ICONS')}
  ${sliceConst('autoDjGenresUi')}
  let _autoDjPanelAbortController = null;
  ${FNS.map(sliceFn).join('\n\n')}
  return { ${FNS.join(', ')}, ui: autoDjGenresUi };
`;

// One stubbed app around the sliced panel and drawer.
//   server   MSTREAMAPI.currentServer's flags; version '6.33.1' (/api/'s)
//   lists    the genres answers' names, per kind ('both' | 'tag' | 'model')
//   sources  the answers' { tag, model } (null: a server older than them)
// MSTREAMAPI.getGenres(source) records each ask (sb.api.asks: undefined for
// every kind); a kind in sb.api.fail answers a 500; a kind in sb.api.hold
// waits in sb.api.pending until the test resolves it (the answer then, or
// the one given).
function makeSandbox({ server = {}, lists = LISTS, sources = BOTH } = {}) {
  const doc = makeDocument(BODY);
  const live = new Set();
  const playerListeners = new Set();
  const rootPanels = [];
  const seeds = {
    ...AUTODJ.seeds,
    subscribe: (fn) => {
      const off = AUTODJ.seeds.subscribe(fn);
      live.add(fn);
      return () => { live.delete(fn); off(); };
    },
  };
  const api = {
    currentServer: { host: HOST, token: 'TOK', vpaths: ['Music'], discovery: true, autoDj: 1, version: '6.33.1', ...server },
    lists: { both: [...lists.both], tag: [...lists.tag], model: [...lists.model] },
    sources,
    asks: [],
    hold: new Set(),
    fail: new Set(),
    pending: [],
    getGenres(source) {
      api.asks.push(source);
      const kind = source === 'tag' || source === 'model' ? source : 'both';
      const reply = () => (api.fail.has(kind)
        ? { status: 'error', value: null, code: 500 }
        : { status: 'ok', value: [...api.lists[kind]], sources: api.sources });
      if (api.hold.has(kind)) {
        const d = deferred();
        api.pending.push({ kind, resolve: (res) => d.resolve(res === undefined ? reply() : res) });
        return d.promise;
      }
      return Promise.resolve(reply());
    },
    peerArtUrl,
  };
  const player = {
    playerStats: { autoDJ: false },
    playlist: [],
    positionCache: { val: -1 },
    onAutoDj(fn) { playerListeners.add(fn); return () => { playerListeners.delete(fn); }; },
    fillBareSeeds() {},
    toggleAutoDJ() { player.playerStats.autoDJ = !player.playerStats.autoDJ; return player.playerStats.autoDJ; },
  };
  const vpc = { songCapture: null, dmTabbables: VP.dmTabbables, dmTrapTarget: VP.dmTrapTarget };
  let S = null;
  const globals = {
    document: doc,
    AUTODJ: { ...AUTODJ, seeds },
    MSTREAMAPI: api,
    MSTREAMPLAYER: player,
    VUEPLAYERCORE: vpc,
    t: tStub,
    iziToast: { warning() {}, success() {}, error() {} },
    setBrowserRootPanel: (name) => {
      rootPanels.push(name);
      new Function('autoDjGenresClose', ROOT_PANEL_GENRES)(S.autoDjGenresClose);
    },
    _autoDjMigrateLegacyKeys: () => {},
    _fetchLastfmStatus: () => Promise.resolve({ serverEnabled: true }),
    _syncVpathsToLegacy: () => {},
  };
  S = new Function(...Object.keys(globals), SANDBOX_BODY)(...Object.values(globals));
  return {
    S, doc, api, vpc, live, rootPanels,
    g: globals,
    $: (id) => doc.getElementById(id),
    dialog: () => doc.getElementById('dj-genres-drawer'),
    // resolves the first held ask of [kind]
    answer(kind, res) {
      const at = api.pending.findIndex((p) => p.kind === kind);
      assert.ok(at >= 0, `an ask for ${kind} is out`);
      api.pending.splice(at, 1)[0].resolve(res);
    },
  };
}

// The page drawn (once), the Genres row pressed, its answers in.
async function openDrawer(sb, { wait = true } = {}) {
  if (!sb.$('dj-genres-btn')) { await sb.S.autoDjPanel(); }
  click(sb.$('dj-genres-btn'));
  if (wait) { await settle(); }
  const dialog = sb.dialog();
  assert.ok(dialog, 'the drawer opened');
  return dialog;
}

// The drawn boxes, as the user reads them.
function rowsOf(sb) {
  return sb.$('dj-genres-list').querySelectorAll('input[data-genre]').map((box) => {
    const label = box.closest('label');
    return { name: box.getAttribute('data-genre'), on: box.checked, off: box.disabled, dim: label.classList.contains('is-off'), text: label.textContent, box, label };
  });
}
const names = (sb) => rowsOf(sb).map((r) => r.name);
const ticked = (sb) => rowsOf(sb).filter((r) => r.on).map((r) => r.name);
const boxNamed = (sb, name) => {
  const row = rowsOf(sb).find((r) => r.name === name);
  assert.ok(row, `a box for ${name}`);
  return row.box;
};
// The list's line, and whether it is the error's.
const stateLine = (sb) => {
  const p = sb.$('dj-genres-list').querySelector('p');
  return p ? [p.textContent, p.classList.contains('is-error')] : null;
};
const spinner = (sb) => sb.$('dj-genres-list').querySelector('.spinner') !== null;
const modeBtns = (sb) => sb.dialog().querySelectorAll('[data-dj-act="mode"]');
const kindBtns = (sb) => sb.$('dj-genres-kind-box').querySelectorAll('[data-dj-act="kind"]');
const kindBtn = (sb, kind) => kindBtns(sb).find((b) => b.getAttribute('data-kind') === kind);
const pressedOf = (btns) => btns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-mode') || b.getAttribute('data-kind'));
const stored = () => JSON.stringify([..._store].sort());

// A user's tick: the box turns, then input and change fire on it (what a
// browser does; it never turns a disabled box).
function tick(box) {
  if (box.disabled) { return; }
  box.checked = !box.checked;
  fire(box, 'input');
  fire(box, 'change');
}

describe('the Genres drawer: shell', () => {
  test('a modal dialog on its own scrim on body, named by its heading, Close first; open puts the keyboard on Close and marks the row', async () => {
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    const row = sb.$('dj-genres-btn');
    click(row);
    const dialog = sb.dialog();
    assert.ok(dialog, 'the row opens it');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('tabindex'), '-1');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dj-genres-title');
    assert.equal(dialog.className, 'dj-seeds', 'the Seeds drawer\'s look');
    const shade = sb.$('dj-genres-shade');
    assert.equal(shade.parentNode, sb.doc.body);
    assert.deepEqual(shade.className.split(' '), ['dmodal-shadow', 'dj-seeds-shade'], 'the player\'s hotkeys and YouTube paste stay off under it');
    assert.equal(dialog.parentNode, shade);
    assert.ok(!sb.$('filelist').contains(shade), 'not in the column');
    const close = dialog.children[0];
    assert.equal(close.className, 'dj-seeds-close');
    assert.equal(close.getAttribute('aria-label'), 'modal.close');
    assert.equal(close.getAttribute('type'), 'button');
    assert.ok(!close.hasAttribute('title'), 'no tooltip (minimal text)');
    assert.equal(sb.doc.activeElement, close, 'open: the keyboard on Close');
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.equal(row.getAttribute('aria-controls'), 'dj-genres-drawer');
    assert.equal(sb.doc.querySelectorAll('[role="dialog"]').length, 1);
    // the head: the heading, and the cap's live region (empty under 200)
    const head = dialog.children[1];
    assert.equal(head.className, 'dj-seeds-head dj-genres-head');
    assert.deepEqual(head.children.map((el) => el.id), ['dj-genres-title', 'dj-genres-max']);
    const title = sb.$('dj-genres-title');
    assert.equal(title.localName, 'h2');
    assert.equal(title.className, 'dj-seeds-title');
    assert.equal(title.textContent, 'autoDJ.genresLabel');
    assert.equal(sb.$('dj-genres-max').getAttribute('aria-live'), 'polite');
    assert.equal(sb.$('dj-genres-max').textContent, '');
    // the body, top to bottom: Only | Skip, the kind's box, the search, the list
    const body = dialog.children[2];
    assert.equal(dialog.children.length, 3);
    assert.deepEqual([body.id, body.className], ['dj-genres-body', 'dj-seeds-body']);
    assert.deepEqual(body.children.map((el) => el.className), ['dj-seeds-mode', 'dj-genres-kind-box', 'dj-add-search dj-genres-search', 'dj-genres-list']);
    // the search: Add song's field
    const search = sb.$('dj-genres-search');
    assert.equal(search.getAttribute('type'), 'search');
    assert.equal(search.className, 'dj-filter-input browser-default');
    assert.equal(search.getAttribute('placeholder'), 'tooltip.search');
    assert.equal(search.getAttribute('aria-label'), 'tooltip.search');
    assert.equal(search.getAttribute('autocomplete'), 'off');
    assert.equal(search.value, '');
    assert.ok(search.parentNode.querySelector('svg.dj-add-search-ic'), 'the search icon');
    // the column's markup drawn again: the drawer stays
    sb.$('filelist').innerHTML = '<p>drawn again</p>';
    assert.equal(sb.dialog(), dialog);
  });

  test('Close, Esc (from the search too) and a scrim press that began on the scrim close it, the keyboard back on the row; a drag out, a double-click\'s later press and an IME\'s Esc don\'t', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'] });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    const before = stored();
    const row = () => sb.$('dj-genres-btn');
    const closed = (what) => {
      assert.equal(sb.$('dj-genres-shade'), null, `${what}: the scrim is gone`);
      assert.equal(sb.doc.activeElement, row(), `${what}: the keyboard back on the Genres row`);
      assert.equal(row().getAttribute('aria-expanded'), 'false');
      assert.ok(!row().hasAttribute('aria-controls'));
      assert.deepEqual(sb.doc.listeners.get('keydown') || [], [], `${what}: its key listener went with it`);
      assert.equal(sb.S.ui.open, false);
      assert.equal(stored(), before, `${what}: closing writes nothing`);
    };
    click(row());
    click(sb.dialog().children[0]);
    closed('Close');
    click(row());
    press(sb.doc, 'Escape');
    closed('Esc');
    click(row());
    sb.$('dj-genres-search').focus();
    typeInto(sb.$('dj-genres-search'), 'ro');
    press(sb.doc, 'Escape');
    closed('Esc from the search');
    click(row());
    click(sb.$('dj-genres-shade'));
    closed('a press on the scrim');
    // a drag out of the drawer (it began inside) is no press outside
    click(row());
    const again = sb.dialog();
    click(sb.$('dj-genres-shade'), { downOn: sb.$('dj-genres-title') });
    assert.equal(sb.dialog(), again, 'a press that began in the drawer keeps it');
    click(sb.$('dj-genres-title'));
    assert.ok(sb.dialog(), 'a press inside keeps it');
    press(sb.doc, 'Escape');
    // a double-click on the row: its second press lands on the new scrim
    click(row(), { detail: 1 });
    click(sb.$('dj-genres-shade'), { detail: 2 });
    assert.ok(sb.dialog(), 'a multi-click\'s later press is no press outside');
    // a touch on the scrim (detail 0) closes it
    fire(sb.$('dj-genres-shade'), 'touchstart', { detail: 0 });
    fire(sb.$('dj-genres-shade'), 'click', { detail: 1 });
    assert.equal(sb.dialog(), null, 'a tap on the scrim');
    // an IME's Esc is its own
    click(row());
    press(sb.doc, 'Escape', { isComposing: true });
    press(sb.doc, 'Escape', { keyCode: 229 });
    assert.ok(sb.dialog());
    press(sb.doc, 'Escape');
    closed('Esc');
  });

  test('Tab wraps inside it: Close, Only, Skip, Generated, Tags, Mixed, the search, the boxes — an off box skipped', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'] });
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    const order = () => sb.vpc.dmTabbables(dialog).map((el) => el.getAttribute('aria-label') || el.getAttribute('data-mode') || el.getAttribute('data-kind') || el.getAttribute('data-genre'));
    assert.deepEqual(order(), ['modal.close', 'whitelist', 'blacklist', 'model', 'tag', 'both', 'tooltip.search', 'Rock', 'Ambient', 'Hip Hop', 'house', 'jazz']);
    boxNamed(sb, 'jazz').focus();
    press(sb.doc, 'Tab');
    assert.equal(sb.doc.activeElement, dialog.children[0], 'past the last box: Close');
    press(sb.doc, 'Tab', { shiftKey: true });
    assert.equal(sb.doc.activeElement, boxNamed(sb, 'jazz'), 'Shift+Tab from Close: the last box');
    press(sb.doc, 'Tab', { shiftKey: true });
    assert.equal(sb.doc.activeElement, boxNamed(sb, 'house'), 'inside, the browser\'s own move');
    sb.doc.activeElement = sb.doc.body;
    press(sb.doc, 'Tab');
    assert.equal(sb.doc.activeElement, dialog.children[0], 'from outside it (focus fell to body): the first control');
    // at 200 chosen an unticked box is off, and Tab skips it
    const many = numbered(201);
    AUTODJ.setGenreFilter({ genres: many.slice(0, 200) });
    AUTODJ.invalidateGenresCache();
    const full = makeSandbox({ lists: { both: many, tag: [], model: [] } });
    const fullDialog = await openDrawer(full);
    const boxes = full.vpc.dmTabbables(fullDialog).filter((el) => el.hasAttribute('data-genre'));
    assert.equal(boxes.length, 200);
    assert.ok(!boxes.includes(boxNamed(full, 'G200')));
    boxNamed(full, 'G199').focus();
    press(full.doc, 'Tab');
    assert.equal(full.doc.activeElement, fullDialog.children[0], 'past the last live box: Close');
  });

  test('a view that takes the column under it closes it, the keyboard left be; so does the page drawn again', async () => {
    const sb = makeSandbox();
    await openDrawer(sb);
    // a toast's Details (it sits above the scrim) takes the column
    const details = sb.doc.createElement('button');
    sb.doc.body.appendChild(details);
    details.focus();
    sb.g.setBrowserRootPanel('panel.addFromYoutube', false);
    assert.equal(sb.$('dj-genres-shade'), null, 'the drawer went with the page');
    assert.equal(sb.S.ui.open, false);
    assert.equal(sb.$('dj-genres-btn').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(sb.doc.listeners.get('keydown') || [], [], 'its key listener went with it');
    assert.equal(sb.doc.activeElement, details, 'the keyboard stays where it was');
    sb.g.setBrowserRootPanel('panel.fileExplorer');
    assert.equal(sb.S.ui.open, false, 'nothing open: nothing to do');
    // the Auto DJ page drawn again (its nav entry) closes it too
    click(sb.$('dj-genres-btn'));
    assert.ok(sb.dialog());
    await sb.S.autoDjPanel();
    assert.equal(sb.dialog(), null);
    assert.equal(sb.S.ui.open, false);
    // setBrowserRootPanel runs it for every view, right after the Seeds
    // drawer's (seven other tests slice it into sandboxes without either
    // drawer: hence the guard)
    assert.match(sliceFn('setBrowserRootPanel'), /\n {2}if \(typeof autoDjSeedsClose === 'function'\) \{ autoDjSeedsClose\(\{ noFocus: true \}\); \}\n {2}if \(typeof autoDjGenresClose === 'function'\) \{ autoDjGenresClose\(\{ noFocus: true \}\); \}\n/);
  });
});

describe('the Genres drawer: its lists and the kind', () => {
  test('the panel\'s cached answer opens it without an ask; nothing cached: one ask for every kind, which fills the cache', async () => {
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    assert.deepEqual(sb.api.asks, [undefined], 'the panel\'s ask');
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks, [undefined], 'the drawer asked nothing');
    assert.deepEqual(names(sb), MIXED_SORTED, 'every kind, sorted whatever the case');
    assert.equal(kindBtns(sb).length, 3, 'the cached counts offer the switch');
    press(sb.doc, 'Escape');
    // the cache ran out: one ask, a spinner and no switch until it answers
    AUTODJ.invalidateGenresCache();
    sb.api.hold.add('both');
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks, [undefined, undefined]);
    assert.ok(spinner(sb));
    assert.equal(kindBtns(sb).length, 0, 'no switch before an answer');
    sb.answer('both');
    await settle();
    assert.ok(!spinner(sb));
    assert.deepEqual(names(sb), MIXED_SORTED);
    assert.equal(kindBtns(sb).length, 3);
    assert.deepEqual(AUTODJ.getCachedGenresList(), LISTS.both, 'its answer fills the panel\'s cache');
    assert.deepEqual(AUTODJ.getCachedGenreSources(), BOTH);
    // the next open takes it from there
    press(sb.doc, 'Escape');
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks, [undefined, undefined]);
  });

  test('Only | Skip: pressed by the mode; a change is stored at once and the row reads it; the pressed one writes nothing', async () => {
    AUTODJ.setGenreFilter({ mode: 'whitelist', genres: ['Rock', 'jazz'] });
    const sb = makeSandbox();
    const dialog = await openDrawer(sb);
    const group = dialog.querySelector('.dj-seeds-mode');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'autoDJ.genreModeLabel');
    const [only, skip] = modeBtns(sb);
    assert.deepEqual([only, skip].map((b) => [b.getAttribute('data-mode'), b.textContent, b.className]), [
      ['whitelist', 'autoDJ.genresOnly', 'dj-seeds-mode-btn'], ['blacklist', 'autoDJ.genresSkip', 'dj-seeds-mode-btn']]);
    assert.deepEqual(pressedOf(modeBtns(sb)), ['whitelist']);
    const value = sb.$('dj-genres-value');
    assert.equal(value.textContent, 'jazz · Rock');
    click(skip);
    assert.equal(AUTODJ.state.djGenreMode, 'blacklist');
    assert.equal(localStorage.getItem('mstream-dj-djGenreMode'), '"blacklist"');
    assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'jazz'], 'the genres stay');
    assert.deepEqual(pressedOf(modeBtns(sb)), ['blacklist']);
    assert.equal(value.textContent, 'autoDJ.genresSkipValue{"genres":"jazz · Rock"}', 'the row reads it at once');
    assert.ok(value.classList.contains('is-set'));
    assert.equal(sb.doc.activeElement, skip, 'the keyboard stays on the pressed button');
    click(only);
    assert.equal(AUTODJ.state.djGenreMode, 'whitelist');
    assert.equal(value.textContent, 'jazz · Rock');
    press(sb.doc, 'Escape');
    // the pressed one writes nothing: a filter switched off keeps its list
    AUTODJ.setState({ djGenreEnabled: false });
    await openDrawer(sb);
    const before = stored();
    click(modeBtns(sb)[0]);
    assert.equal(stored(), before, 'nothing written');
    assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'jazz']);
    // drawn under Skip
    press(sb.doc, 'Escape');
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Rock'] });
    await openDrawer(sb);
    assert.deepEqual(pressedOf(modeBtns(sb)), ['blacklist']);
  });

  test('Generated | Tags | Mixed only where the latest answer has genres of both kinds and the server is known to take the kind', async () => {
    const sb = makeSandbox();
    await openDrawer(sb);
    const box = sb.$('dj-genres-kind-box');
    const group = box.children[0];
    assert.equal(box.children.length, 1);
    assert.equal(group.className, 'dj-seeds-mode dj-genres-kind', 'Only | Skip\'s look');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'genres.sourceLabel');
    assert.deepEqual(kindBtns(sb).map((b) => [b.getAttribute('data-kind'), b.textContent, b.getAttribute('aria-pressed'), b.className]), [
      ['model', 'genres.sourceGenerated', 'false', 'dj-seeds-mode-btn'],
      ['tag', 'genres.sourceTags', 'false', 'dj-seeds-mode-btn'],
      ['both', 'autoDJ.genresMixed', 'true', 'dj-seeds-mode-btn'],
    ], 'the phone\'s order and words; Mixed pressed by default');
    const offered = async (server, sources) => {
      AUTODJ.invalidateGenresCache();
      const other = makeSandbox({ server, sources });
      await openDrawer(other);
      assert.deepEqual(names(other), MIXED_SORTED, 'the list shows every kind');
      return kindBtns(other).length === 3;
    };
    assert.equal(await offered({}, { tag: 3, model: 0 }), false, 'Tags only');
    assert.equal(await offered({}, { tag: 0, model: 3 }), false, 'Generated only');
    assert.equal(await offered({}, null), false, 'no counts: a server older than the kinds');
    assert.equal(await offered({ version: '6.32.1' }, BOTH), false, 'a server older than random-songs\' kind');
    assert.equal(await offered({ version: undefined }, BOTH), false, '/api/ never answered');
    assert.equal(await offered({ version: '6.33.1-velvet' }, BOTH), false, 'a fork\'s numbering');
    assert.equal(await offered({ version: '6.32.2' }, BOTH), true, 'the first that takes it');
  });

  test('a stored kind opens on its own list: [every kind, then it] with nothing cached, [it] with the cache', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'], source: 'model' });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    let from = sb.api.asks.length;
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks.slice(from), ['model'], 'cached: just its kind');
    assert.deepEqual(pressedOf(kindBtns(sb)), ['model']);
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house'], 'the chosen first, then the Generated list');
    press(sb.doc, 'Escape');
    AUTODJ.invalidateGenresCache();
    from = sb.api.asks.length;
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks.slice(from), [undefined, 'model'], 'every kind first (it says which kinds there are), then its own');
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house']);
    assert.equal(AUTODJ.state.djGenreSource, 'model', 'opening writes nothing');
  });

  test('a kind change keeps the chosen genres ticked and in view and stores the kind; each list is asked once, a failed one again at its next turn; the shown kind does nothing', async () => {
    // the phone's worked example
    const lists = { both: ['Ambient', 'house', 'jazz', 'rock'], tag: ['jazz', 'rock'], model: ['Ambient', 'house'] };
    AUTODJ.setGenreFilter({ genres: ['rock'] });
    const sb = makeSandbox({ lists });
    await sb.S.autoDjPanel();
    const from = sb.api.asks.length;
    await openDrawer(sb);
    assert.deepEqual(names(sb), ['rock', 'Ambient', 'house', 'jazz']);
    // Generated: rock stays in view, ticked; the kind is stored
    click(kindBtn(sb, 'model'));
    assert.ok(spinner(sb), 'its list is out');
    await settle();
    assert.deepEqual(names(sb), ['rock', 'Ambient', 'house']);
    assert.deepEqual(ticked(sb), ['rock']);
    assert.equal(AUTODJ.state.djGenreSource, 'model');
    assert.equal(localStorage.getItem(KIND_KEY), '"model"');
    assert.deepEqual(pressedOf(kindBtns(sb)), ['model']);
    assert.equal(sb.doc.activeElement, kindBtn(sb, 'model'), 'the pressed kind keeps the keyboard');
    // a genre ticked under Generated stays in view under Tags, whose list fails
    tick(boxNamed(sb, 'house'));
    sb.api.fail.add('tag');
    click(kindBtn(sb, 'tag'));
    await settle();
    assert.deepEqual(stateLine(sb), ['autoDJ.genresLoadError', true], 'Tags failed: the line above the chosen rows');
    assert.deepEqual(names(sb), ['house', 'rock'], 'both chosen genres, pinned');
    assert.deepEqual(ticked(sb), ['house', 'rock']);
    assert.equal(AUTODJ.state.djGenreSource, 'tag');
    sb.api.fail.delete('tag');
    click(kindBtn(sb, 'both'));
    await settle();
    assert.deepEqual(names(sb), ['house', 'rock', 'Ambient', 'jazz']);
    assert.equal(AUTODJ.state.djGenreSource, null, 'Mixed');
    assert.equal(localStorage.getItem(KIND_KEY), null);
    click(kindBtn(sb, 'tag'));
    await settle();
    assert.deepEqual(names(sb), ['house', 'rock', 'jazz'], 'a failed kind is asked again at its next turn');
    click(kindBtn(sb, 'model'));
    await settle();
    assert.deepEqual(names(sb), ['house', 'rock', 'Ambient']);
    assert.deepEqual(sb.api.asks.slice(from), ['model', 'tag', 'tag'], 'Mixed came from the cache; each list asked once, the failed one again');
    assert.deepEqual(AUTODJ.state.djGenres, ['rock', 'house'], 'the ticks never changed');
    // pressing the shown kind changes nothing (a filter switched off keeps its list)
    press(sb.doc, 'Escape');
    AUTODJ.setState({ djGenreEnabled: false });
    await openDrawer(sb);
    const before = stored();
    const asks = sb.api.asks.length;
    click(kindBtn(sb, 'model'));
    await settle();
    assert.equal(stored(), before, 'nothing written');
    assert.equal(sb.api.asks.length, asks, 'nothing asked');
  });

  test('an answer without genres of both kinds takes a stored kind back to Mixed and the switch goes; the keyboard on it lands on the pressed Only | Skip', async () => {
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Rock'], source: 'model' });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    sb.api.hold.add('model');
    await openDrawer(sb);
    assert.ok(spinner(sb), 'Generated\'s list is out');
    const generated = kindBtn(sb, 'model');
    generated.focus();
    // the model's genres went meanwhile (a rescan)
    sb.api.sources = { tag: 3, model: 0 };
    sb.answer('model');
    await settle();
    assert.equal(AUTODJ.state.djGenreSource, null, 'back to Mixed');
    assert.equal(localStorage.getItem(KIND_KEY), null);
    assert.deepEqual([AUTODJ.state.djGenres, AUTODJ.state.djGenreMode], [['Rock'], 'blacklist'], 'the rest of the filter stays');
    assert.equal(kindBtns(sb).length, 0, 'the switch went');
    assert.equal(sb.$('dj-genres-kind-box').children.length, 0);
    assert.ok(!generated.isConnected);
    const skip = modeBtns(sb)[1];
    assert.equal(skip.getAttribute('aria-pressed'), 'true');
    assert.equal(sb.doc.activeElement, skip, 'the keyboard on the pressed Only | Skip, not lost to the page');
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'the list shows every kind');
  });

  test('where an answer is in but the switch is hidden (an older, unknown or forked server with both kinds), a change stores Mixed; before any answer the stored kind stays', async () => {
    for (const version of ['6.32.1', undefined, '6.33.1-velvet']) {
      AUTODJ.setGenreFilter({ genres: ['Rock'], source: 'model' });
      AUTODJ.invalidateGenresCache();
      const sb = makeSandbox({ server: { version } });
      await sb.S.autoDjPanel();
      assert.equal(AUTODJ.state.djGenreSource, 'model', `${version}: an answer with both kinds leaves the kind`);
      await openDrawer(sb);
      assert.equal(kindBtns(sb).length, 0, `${version}: no switch`);
      assert.deepEqual(names(sb), ['Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'every kind');
      tick(boxNamed(sb, 'jazz'));
      assert.equal(AUTODJ.state.djGenreSource, null, `${version}: what the list showed is what the filter matches`);
      assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'jazz']);
    }
    // before any answer: a change keeps the stored kind
    AUTODJ.setGenreFilter({ genres: ['Rock'], source: 'model' });
    AUTODJ.invalidateGenresCache();
    const sb = makeSandbox({ server: { version: '6.32.1' } });
    await sb.S.autoDjPanel();
    AUTODJ.invalidateGenresCache();
    sb.api.hold.add('both');
    await openDrawer(sb);
    click(modeBtns(sb)[1]);
    assert.equal(AUTODJ.state.djGenreMode, 'blacklist');
    assert.equal(AUTODJ.state.djGenreSource, 'model', 'no answer yet: the kind stays');
    sb.answer('both');
    await settle();
    assert.equal(AUTODJ.state.djGenreSource, 'model', 'an answer with both kinds alone changes nothing');
    click(modeBtns(sb)[0]);
    assert.equal(AUTODJ.state.djGenreSource, null, 'the next change stores what the list shows');
  });

  test('a drawer opened before /api/ answered keeps the list it drew once the version comes in: no spinner, a change stores what it shows, and the next open offers the switch', async () => {
    // Rock under Generated is stored; /api/ hasn't answered, the panel's
    // ask filled the cache (both kinds): the drawer draws every kind and no
    // switch. Then /api/'s version comes in.
    const early = async () => {
      AUTODJ.setGenreFilter({ mode: 'whitelist', genres: ['Rock'], source: 'model' });
      AUTODJ.invalidateGenresCache();
      const sb = makeSandbox({ server: { version: undefined } });
      await sb.S.autoDjPanel();
      await openDrawer(sb);
      assert.deepEqual(sb.api.asks, [undefined], 'the panel\'s ask: the drawer took the cache');
      assert.equal(kindBtns(sb).length, 0, 'no switch: the version is unknown');
      assert.deepEqual(names(sb), ['Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'every kind');
      sb.api.currentServer.version = '6.33.1';
      return sb;
    };
    const kept = (sb, what) => {
      assert.ok(!spinner(sb), `${what}: no spinner`);
      assert.equal(kindBtns(sb).length, 0, `${what}: no switch until the next answer or open`);
      assert.deepEqual(sb.api.asks, [undefined], `${what}: nothing asked`);
    };
    // Only | Skip: stored with Mixed, the kind the list shows
    let sb = await early();
    click(modeBtns(sb)[1]);
    await settle();
    kept(sb, 'Skip');
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'the list drawn stays');
    assert.equal(AUTODJ.state.djGenreMode, 'blacklist');
    assert.equal(AUTODJ.state.djGenreSource, null, 'what the list showed is what the filter matches');
    assert.equal(localStorage.getItem(KIND_KEY), null);
    press(sb.doc, 'Escape');
    await openDrawer(sb);
    assert.deepEqual(pressedOf(kindBtns(sb)), ['both'], 'the next open offers the switch, Mixed pressed');
    // a keystroke narrows the list and stores nothing
    sb = await early();
    typeInto(sb.$('dj-genres-search'), 'a');
    await settle();
    kept(sb, 'a keystroke');
    assert.deepEqual(names(sb), ['Ambient', 'jazz']);
    assert.equal(AUTODJ.state.djGenreSource, 'model');
    // a tick on a genre only Tags has: stored with Mixed, and still in view
    // at the next redraw, ticked
    sb = await early();
    tick(boxNamed(sb, 'jazz'));
    assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'jazz']);
    assert.equal(AUTODJ.state.djGenreSource, null, 'not narrowed to a Generated the list never showed');
    typeInto(sb.$('dj-genres-search'), '');
    await settle();
    kept(sb, 'a tick, then a redraw');
    assert.deepEqual(ticked(sb), ['Rock', 'jazz']);
    // no change: the next open is the stored kind's, asked for
    sb = await early();
    press(sb.doc, 'Escape');
    await openDrawer(sb);
    assert.deepEqual(sb.api.asks, [undefined, 'model']);
    assert.deepEqual(pressedOf(kindBtns(sb)), ['model']);
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house']);
  });

  test('the version coming in while the drawer\'s own ask is out: that answer brings the switch and asks for the stored kind\'s list', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'], source: 'model' });
    const sb = makeSandbox({ server: { version: undefined } });
    await sb.S.autoDjPanel();
    AUTODJ.invalidateGenresCache();
    sb.api.hold.add('both');
    await openDrawer(sb);
    assert.ok(spinner(sb), 'every kind\'s list is out');
    assert.equal(kindBtns(sb).length, 0);
    sb.api.currentServer.version = '6.33.1';
    sb.answer('both');
    await settle();
    assert.deepEqual(sb.api.asks, [undefined, undefined, 'model']);
    assert.deepEqual(pressedOf(kindBtns(sb)), ['model']);
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house'], 'the chosen first, then the Generated list');
    assert.equal(AUTODJ.state.djGenreSource, 'model');
  });

  test('an answer for an earlier open is dropped: it draws nothing, fills no cache and changes no kind', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'], source: 'model' });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    AUTODJ.invalidateGenresCache();
    sb.api.hold.add('both');
    await openDrawer(sb);
    press(sb.doc, 'Escape');
    await openDrawer(sb);
    assert.equal(sb.api.pending.length, 2, 'one ask per open');
    const [first, second] = sb.api.pending.splice(0);
    second.resolve();
    await settle();
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house'], 'this open\'s answers: every kind, then Generated');
    first.resolve({ status: 'ok', value: ['Stale'], sources: null });
    await settle();
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'house'], 'the earlier open\'s answer draws nothing');
    assert.deepEqual(AUTODJ.getCachedGenresList(), LISTS.both, 'nor fills the cache');
    assert.equal(AUTODJ.state.djGenreSource, 'model', 'nor takes the kind back to Mixed');
    // one that lands once the drawer closed
    press(sb.doc, 'Escape');
    AUTODJ.invalidateGenresCache();
    await openDrawer(sb);
    press(sb.doc, 'Escape');
    sb.answer('both', { status: 'ok', value: ['Late'], sources: null });
    await settle();
    assert.equal(AUTODJ.getCachedGenresList(), null);
    assert.equal(AUTODJ.state.djGenreSource, 'model');
    assert.equal(sb.dialog(), null);
  });
});

describe('the Genres drawer: the list', () => {
  test('the chosen genres first, sorted and pinned, then the kind\'s sorted; a tick never moves a row; a genre the server no longer reports can be let go', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock', 'Polka'] });
    const sb = makeSandbox();
    await openDrawer(sb);
    assert.deepEqual(names(sb), ['Polka', 'Rock', 'Ambient', 'Hip Hop', 'house', 'jazz']);
    assert.deepEqual(ticked(sb), ['Polka', 'Rock']);
    assert.deepEqual(rowsOf(sb).map((r) => r.text), names(sb), 'each box is named by its label');
    tick(boxNamed(sb, 'house'));
    tick(boxNamed(sb, 'Rock'));
    assert.deepEqual(names(sb), ['Polka', 'Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'ticks move no row');
    assert.deepEqual(ticked(sb), ['Polka', 'house']);
    tick(boxNamed(sb, 'Polka'));
    assert.deepEqual(AUTODJ.state.djGenres, ['house'], 'Polka, which the server no longer has, let go');
    assert.deepEqual(names(sb), ['Polka', 'Rock', 'Ambient', 'Hip Hop', 'house', 'jazz'], 'its row stays while the drawer is open');
    press(sb.doc, 'Escape');
    await openDrawer(sb);
    assert.deepEqual(names(sb), ['house', 'Ambient', 'Hip Hop', 'jazz', 'Rock'], 'the next open pins what is chosen then');
    // the markup: a list named by the heading, one labelled box per genre
    const ul = sb.$('dj-genres-list').querySelector('ul');
    assert.equal(ul.className, 'dj-genres-rows');
    assert.equal(ul.getAttribute('aria-labelledby'), 'dj-genres-title');
    const box = boxNamed(sb, 'house');
    assert.equal(box.getAttribute('type'), 'checkbox');
    assert.equal(box.closest('label').className, 'dj-check dj-genres-item', 'the drawer\'s box look');
    assert.equal(box.closest('label').querySelector('.dj-check-box').getAttribute('aria-hidden'), 'true');
    assert.equal(box.closest('li').parentNode, ul);
  });

  test('a tick is stored at once — the row\'s value too — and the filter is on exactly while genres are chosen; the box keeps the keyboard (no redraw)', async () => {
    const sb = makeSandbox();
    await openDrawer(sb);
    const value = sb.$('dj-genres-value');
    assert.equal(value.textContent, 'autoDJ.genresAny');
    const jazz = boxNamed(sb, 'jazz');
    jazz.focus();
    tick(jazz);
    assert.deepEqual(AUTODJ.state.djGenres, ['jazz']);
    assert.equal(AUTODJ.state.djGenreEnabled, true);
    assert.equal(AUTODJ.genreFilterOn(), true);
    assert.equal(localStorage.getItem('mstream-dj-djGenres'), '["jazz"]');
    assert.equal(localStorage.getItem('mstream-dj-djGenreEnabled'), 'true');
    assert.equal(sb.$('dj-genres-value'), value, 'the panel is not redrawn');
    assert.equal(value.textContent, 'jazz');
    assert.ok(value.classList.contains('is-set'));
    assert.ok(jazz.isConnected, 'the box ticked is still the one drawn');
    assert.equal(sb.doc.activeElement, jazz, 'and keeps the keyboard');
    assert.equal(jazz.checked, true);
    const ambient = boxNamed(sb, 'Ambient');
    tick(ambient);
    assert.deepEqual(AUTODJ.state.djGenres, ['jazz', 'Ambient'], 'in tick order');
    assert.equal(value.textContent, 'Ambient · jazz', 'the value sorted');
    // every one unticked: off
    tick(jazz);
    tick(ambient);
    assert.deepEqual(AUTODJ.state.djGenres, []);
    assert.equal(AUTODJ.state.djGenreEnabled, false);
    assert.equal(AUTODJ.genreFilterOn(), false);
    assert.equal(value.textContent, 'autoDJ.genresAny');
    assert.ok(!value.classList.contains('is-set'));
    assert.ok(jazz.isConnected && ambient.isConnected, 'never redrawn');
    assert.equal(sb.doc.activeElement, jazz);
    // a box's input event alone stores nothing (only its change does)
    const house = boxNamed(sb, 'house');
    house.checked = true;
    fire(house, 'input');
    assert.deepEqual(AUTODJ.state.djGenres, []);
  });

  test('a filter that is off opens with nothing ticked, its stored list kept until the first change replaces it: a tick, Only | Skip or the kind', async () => {
    const off = () => {
      AUTODJ.setGenreFilter({ genres: ['Rock', 'jazz'] });
      AUTODJ.setState({ djGenreEnabled: false });
    };
    off();
    const sb = makeSandbox();
    await openDrawer(sb);
    assert.deepEqual(ticked(sb), [], 'nothing ticked');
    assert.deepEqual(names(sb), MIXED_SORTED, 'nothing pinned');
    assert.equal(sb.$('dj-genres-value').textContent, 'autoDJ.genresAny');
    press(sb.doc, 'Escape');
    assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'jazz'], 'the stored list stays');
    // a tick replaces it
    await openDrawer(sb);
    tick(boxNamed(sb, 'house'));
    assert.deepEqual([AUTODJ.state.djGenres, AUTODJ.state.djGenreEnabled], [['house'], true]);
    press(sb.doc, 'Escape');
    // so does Only | Skip …
    off();
    await openDrawer(sb);
    click(modeBtns(sb)[1]);
    assert.deepEqual([AUTODJ.state.djGenres, AUTODJ.state.djGenreEnabled, AUTODJ.state.djGenreMode], [[], false, 'blacklist']);
    press(sb.doc, 'Escape');
    // … and the kind
    off();
    await openDrawer(sb);
    click(kindBtn(sb, 'model'));
    assert.deepEqual([AUTODJ.state.djGenres, AUTODJ.state.djGenreEnabled, AUTODJ.state.djGenreSource], [[], false, 'model']);
  });

  test('at 200: "200 max" beside the heading and the unticked boxes off; a ticked one can be let go, and the head clears', async () => {
    const many = numbered(203);
    AUTODJ.setGenreFilter({ genres: many.slice(0, 200) });
    const sb = makeSandbox({ lists: { both: many, tag: [], model: [] } });
    await openDrawer(sb);
    const max = sb.$('dj-genres-max');
    assert.equal(max.textContent, `autoDJ.genresMax${JSON.stringify({ count: 200 })}`);
    assert.equal(max.className, 'dj-genres-max');
    assert.equal(max.parentNode, sb.dialog().querySelector('.dj-genres-head'), 'beside the heading');
    const offRows = () => rowsOf(sb).filter((r) => r.off).map((r) => r.name);
    assert.deepEqual(offRows(), ['G200', 'G201', 'G202']);
    assert.ok(rowsOf(sb).every((r) => r.off === r.dim), 'an off box\'s label looks it (is-off)');
    assert.ok(rowsOf(sb).filter((r) => r.on).every((r) => !r.off), 'a ticked one stays live');
    // even a change on an off box adds nothing: the box shows what is stored
    const g201 = boxNamed(sb, 'G201');
    g201.checked = true;
    fire(g201, 'change');
    assert.equal(AUTODJ.state.djGenres.length, 200);
    assert.ok(!AUTODJ.state.djGenres.includes('G201'));
    assert.equal(g201.checked, false);
    // one let go: the head clears and every box is live
    tick(boxNamed(sb, 'G000'));
    assert.equal(AUTODJ.state.djGenres.length, 199);
    assert.equal(max.textContent, '');
    assert.deepEqual(offRows(), []);
    assert.ok(rowsOf(sb).every((r) => !r.dim));
    // full again
    tick(boxNamed(sb, 'G202'));
    assert.equal(max.textContent, `autoDJ.genresMax${JSON.stringify({ count: 200 })}`);
    assert.deepEqual(offRows(), ['G000', 'G200', 'G201']);
  });

  test('the search narrows the list by substring, the pinned rows too; "No matches"; the query stays across a kind change', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'] });
    const sb = makeSandbox();
    await openDrawer(sb);
    const search = sb.$('dj-genres-search');
    typeInto(search, 'hop');
    assert.deepEqual(names(sb), ['Hip Hop'], 'a substring, not only a prefix');
    typeInto(search, ' O ');
    assert.deepEqual(names(sb), ['Rock', 'Hip Hop', 'house'], 'trimmed, whatever the case; the pinned row too');
    typeInto(search, 'jaz');
    assert.deepEqual(names(sb), ['jazz'], 'a pinned row that doesn\'t match goes too');
    typeInto(search, 'xyz');
    assert.deepEqual(names(sb), []);
    assert.deepEqual(stateLine(sb), ['autoDJ.genresNoMatches', false]);
    typeInto(search, 'o');
    click(kindBtn(sb, 'tag'));
    await settle();
    assert.equal(sb.$('dj-genres-search'), search, 'the field is never redrawn');
    assert.equal(search.value, 'o');
    assert.deepEqual(names(sb), ['Rock', 'Hip Hop'], 'Tags, narrowed by the same query');
    assert.deepEqual(sb.api.asks, [undefined, 'tag'], 'typing asks for nothing');
    typeInto(search, '');
    assert.deepEqual(names(sb), ['Rock', 'Hip Hop', 'jazz']);
  });

  test('its states: a spinner while the kind shown loads (the pinned rows wait too); "No genres"; "Could not load genres" alone, and above the pinned rows', async () => {
    AUTODJ.setGenreFilter({ genres: ['Rock'] });
    const sb = makeSandbox();
    await sb.S.autoDjPanel();
    AUTODJ.invalidateGenresCache();
    sb.api.hold.add('both');
    await openDrawer(sb);
    assert.ok(spinner(sb), 'a spinner');
    assert.equal(sb.$('dj-genres-list').children.length, 1);
    assert.equal(sb.$('dj-genres-list').children[0].className, 'dj-genres-state');
    assert.deepEqual(names(sb), [], 'the pinned rows wait too');
    sb.answer('both');
    await settle();
    assert.ok(!spinner(sb));
    assert.deepEqual(names(sb), ['Rock', 'Ambient', 'Hip Hop', 'house', 'jazz']);
    assert.equal(stateLine(sb), null);
    press(sb.doc, 'Escape');
    // a failed list: the line above the pinned rows, which can still be let go
    AUTODJ.invalidateGenresCache();
    sb.api.hold.delete('both');
    sb.api.fail.add('both');
    await openDrawer(sb);
    assert.deepEqual(stateLine(sb), ['autoDJ.genresLoadError', true]);
    assert.deepEqual(sb.$('dj-genres-list').children.map((el) => el.localName), ['p', 'ul'], 'the line first');
    assert.deepEqual(names(sb), ['Rock']);
    tick(boxNamed(sb, 'Rock'));
    assert.deepEqual(AUTODJ.state.djGenres, [], 'let go on a failing server');
    typeInto(sb.$('dj-genres-search'), 'zz');
    assert.deepEqual(stateLine(sb), ['autoDJ.genresLoadError', true], 'a search that leaves nothing: still why');
    assert.equal(sb.$('dj-genres-list').children.length, 1);
    press(sb.doc, 'Escape');
    // nothing chosen and a failed list: the line alone
    await openDrawer(sb);
    assert.deepEqual(stateLine(sb), ['autoDJ.genresLoadError', true]);
    assert.equal(sb.$('dj-genres-list').children.length, 1);
    press(sb.doc, 'Escape');
    // nothing chosen and no genres: "No genres", which a search never turns into "No matches"
    sb.api.fail.delete('both');
    sb.api.lists.both = [];
    await openDrawer(sb);
    assert.deepEqual(stateLine(sb), ['autoDJ.genresNone', false]);
    typeInto(sb.$('dj-genres-search'), 'zz');
    assert.deepEqual(stateLine(sb), ['autoDJ.genresNone', false]);
  });

  test('one row per name whatever its case: a stored "hip hop" and a listed "Hip Hop" are one ticked row, letting it go drops every case of it; a listed "Rock" and "rock" are one row; a blank name is none', async () => {
    // an older client's list, two cases of one genre
    AUTODJ.setState({ djGenreEnabled: true, djGenres: ['hip hop', 'HIP HOP'] });
    const sb = makeSandbox({ lists: { both: ['Rock', 'rock', 'jazz', 'Hip Hop', '', null], tag: [], model: [] } });
    await openDrawer(sb);
    assert.deepEqual(names(sb), ['hip hop', 'jazz', 'Rock']);
    assert.deepEqual(ticked(sb), ['hip hop']);
    tick(boxNamed(sb, 'hip hop'));
    assert.deepEqual(AUTODJ.state.djGenres, [], 'every case of it let go');
    assert.equal(AUTODJ.state.djGenreEnabled, false);
    tick(boxNamed(sb, 'Rock'));
    tick(boxNamed(sb, 'hip hop'));
    assert.deepEqual(AUTODJ.state.djGenres, ['Rock', 'hip hop']);
    assert.deepEqual(ticked(sb), ['hip hop', 'Rock']);
  });
});

describe('the Genres drawer: escaping', () => {
  test('names holding markup draw as text, a tick reaches its genre, and the keyboard finds its box again by comparing data-genre', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const odd = ['"x"]', "it's", evil, 'a=b/c`d'];
    const sb = makeSandbox({ lists: { both: [...odd, 'Rock'], tag: [], model: [] } });
    await openDrawer(sb);
    const html = sb.S.autoDjGenresListHtml(sb.S.autoDjGenresView());
    assert.ok(!html.includes('onerror='), 'no raw markup from the data');
    assert.ok(!html.includes('<img'), 'no raw tag from the data');
    assert.equal(sb.dialog().querySelectorAll('img').length, 0, 'no injected element');
    assert.deepEqual(names(sb), ['"x"]', evil, 'a=b/c`d', "it's", 'Rock'], 'each name reads back exactly');
    assert.deepEqual(rowsOf(sb).map((r) => r.text), names(sb), 'each label reads its name as text');
    // a tick reaches its genre, and the row's value reads it as text
    const box = boxNamed(sb, '"x"]');
    box.focus();
    tick(box);
    assert.deepEqual(AUTODJ.state.djGenres, ['"x"]']);
    tick(boxNamed(sb, evil));
    assert.deepEqual(AUTODJ.state.djGenres, ['"x"]', evil]);
    assert.equal(sb.$('dj-genres-value').textContent, `"x"] · ${evil}`);
    assert.equal(sb.doc.activeElement, box, 'a tick redraws nothing');
    // a redraw with the keyboard on it: the new box of that name takes it
    // (found by comparing data-genre: this DOM can't read a selector built
    // from such a name)
    sb.S.autoDjGenresRender();
    assert.ok(!box.isConnected, 'the list was redrawn');
    assert.equal(sb.doc.activeElement, boxNamed(sb, '"x"]'), 'the keyboard on the new box of that name');
    assert.equal(sb.doc.activeElement.checked, true);
  });
});

// Every drawn key is a real one.
test('the drawer draws only keys en.json has', async () => {
  const many = numbered(201);
  AUTODJ.setGenreFilter({ genres: many.slice(0, 200) });
  const sb = makeSandbox({ lists: { both: many, tag: [], model: [] } });
  const keys = new Set();
  const collect = (node) => {
    for (const m of serialize(node).matchAll(/\b((?:autoDJ|genres|modal|tooltip)\.[A-Za-z]+)/g)) { keys.add(m[1]); }
  };
  await openDrawer(sb);
  collect(sb.dialog());   // the head's max, Only | Skip, the switch, the search
  typeInto(sb.$('dj-genres-search'), 'zz');
  collect(sb.dialog());   // No matches
  press(sb.doc, 'Escape');
  AUTODJ.setGenreFilter({ genres: [] });
  AUTODJ.invalidateGenresCache();
  sb.api.hold.add('both');
  await openDrawer(sb);
  collect(sb.dialog());   // the spinner
  sb.api.fail.add('both');
  sb.answer('both');
  await settle();
  collect(sb.dialog());   // Could not load genres
  press(sb.doc, 'Escape');
  sb.api.hold.delete('both');
  sb.api.fail.delete('both');
  sb.api.lists.both = [];
  await openDrawer(sb);
  collect(sb.dialog());   // No genres
  // the row: its label, and its value — Any, then Skip …
  await sb.S.autoDjPanel();
  collect(sb.$('filelist'));
  AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['G000'] });
  await sb.S.autoDjPanel();
  collect(sb.$('filelist'));
  for (const k of ['autoDJ.genresMax', 'autoDJ.genresNoMatches', 'autoDJ.genresLoadError', 'autoDJ.genresNone', 'autoDJ.genresSkipValue', 'autoDJ.genresAny', 'genres.sourceLabel', 'autoDJ.genresMixed']) {
    assert.ok(keys.has(k), `${k} was drawn`);
  }
  assert.ok(keys.size >= 16);
  assert.deepEqual([...keys].filter((k) => !(k in EN)), []);
});

describe('api.js getGenres(source)', () => {
  // webapp/alpha/api.js on node: a plain script, its fetch stubbed
  const loadApi = (answer) => {
    const calls = [];
    const fetch = (url, opts) => {
      calls.push({ url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
      return answer();
    };
    const api = new Function('fetch', `${API_SRC}\nreturn MSTREAMAPI;`)(fetch);
    api.currentServer.host = 'http://here/';
    api.currentServer.token = 'tok';
    return { api, calls };
  };
  const ok = (body) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  test('asks for one kind or every kind, and hands back how many genres of each kind the server has', async () => {
    const { api, calls } = loadApi(ok({ genres: [{ name: 'Rock', track_count: 3 }, { name: 'jazz', track_count: 1 }], sources: { tag: '4', model: 2 } }));
    assert.deepEqual(await api.getGenres('model'), { status: 'ok', value: ['Rock', 'jazz'], sources: { tag: 4, model: 2 } });
    for (const source of ['tag', undefined, 'both', 'junk']) { await api.getGenres(source); }
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'model' }, { source: 'tag' }, {}, {}, {}], 'one kind, or every kind');
    assert.deepEqual(calls[0], {
      url: 'http://here/api/v1/db/genres', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': 'tok' }, body: { source: 'model' },
    });
    // no counts (a server older than the kinds), or no object of them: null
    for (const sources of [undefined, null, 'x', [1, 2]]) {
      const { api: old } = loadApi(ok({ genres: [{ name: 'Rock' }], ...(sources === undefined ? {} : { sources }) }));
      assert.deepEqual(await old.getGenres(), { status: 'ok', value: ['Rock'], sources: null }, JSON.stringify(sources));
    }
    // a count that is no number reads 0
    const { api: odd } = loadApi(ok({ genres: [], sources: { tag: 'x' } }));
    assert.deepEqual((await odd.getGenres()).sources, { tag: 0, model: 0 });
    // errors keep their shape: the status's code, 0 for the network
    const { api: denied } = loadApi(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    assert.deepEqual(await denied.getGenres('model'), { status: 'error', value: null, code: 401 });
    const { api: down } = loadApi(() => Promise.reject(new Error('offline')));
    assert.deepEqual(await down.getGenres(), { status: 'error', value: null, code: 0 });
  });
});

describe('the Genres drawer: spa.css', () => {
  const start = CSS.indexOf('/* Auto DJ genres drawer */');
  const block = CSS.slice(start, CSS.indexOf('/* Now-playing BPM/key pills', start));
  const ruleOf = (sel) => {
    const at = block.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `${sel} has a rule`);
    return block.slice(at, block.indexOf('}', at) + 1);
  };

  test('its block follows the Seeds drawer\'s: the max beside the heading, the kind\'s labels, the rows, an off box, the states', () => {
    assert.ok(start > CSS.indexOf('/* Auto DJ seeds drawer (design B) */'), 'after the Seeds drawer\'s block');
    assert.ok(CSS.indexOf('/* Auto DJ seeds drawer (design B) */') > CSS.indexOf('/* Auto DJ panel (design E) */'));
    assert.match(ruleOf('.dj-genres-head'), /display: flex; align-items: baseline; gap: 8px;/, 'the max beside the heading (the phone\'s title row)');
    assert.match(ruleOf('.dj-genres-max'), /font-weight: 600;[^}]*color: #f5a05b; white-space: nowrap;/, 'the warning tone');
    assert.match(block, /\n\.dj-genres-kind-box:empty \{ display: none; \}/);
    assert.match(ruleOf('.dj-genres-kind .dj-seeds-mode-btn'), /white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/, 'a long kind stays in its segment');
    assert.match(block, /\n\.dj-genres-rows > li \+ li \{ border-top: 1px solid #3a4149; \}/, 'a rule between rows');
    assert.match(block, /\n\.dj-genres-item\.is-off \{ color: #8c919a; cursor: default; \}/, 'an off box looks it');
    assert.match(block, /\n\.dj-genres-item\.is-off input\[type="checkbox"\] \+ \.dj-check-box \{ border-color: #5c6370; cursor: default; \}/,
      'an off box shows no hand either (Materialize gives the box\'s span a pointer)');
    assert.match(ruleOf('.dj-genres-state'), /text-align: center;[^}]*color: #a0a7b3;/);
    assert.match(block, /\n\.dj-genres-state\.is-error \{ color: #ec8a90; \}/);
    assert.match(block, /\n\.dj-genres-state \.spinner \{ width: 32px; height: 32px; \}/);
    // only what is new gets a rule: the Seeds drawer's kit is worn, not copied
    for (const sel of ['.dmodal-shadow.dj-seeds-shade', '.dj-seeds', '.dj-seeds-close', '.dj-seeds-head', '.dj-seeds-title', '.dj-seeds-body', '.dj-seeds-mode', '.dj-seeds-mode-btn', '.dj-check', '.dj-add-search']) {
      assert.ok(!block.includes(`\n${sel} {`), `${sel} keeps its one rule, in the Seeds drawer's block`);
      assert.ok(CSS.includes(`\n${sel} {`), `${sel}'s head is untouched`);
    }
  });
});
