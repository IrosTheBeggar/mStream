/**
 * The mood filters in the default UI (m.js MOODS / moodPanelHtml /
 * showMoodFilters …; the server half is src/api/mood-filter.js).
 *
 * What is pinned:
 *   - a page's filter goes to the server in its wire form — only the groups
 *     that filter, tags in a fixed order — and nothing at all when empty;
 *   - the panel draws one pressed value per scale and pressed tags, and
 *     Clear only while something is set; Discover's buttons carry data-dp
 *     actions instead of handlers;
 *   - the bar's Filters button shows only when the list's answer carries
 *     `moods`, starts closed, and is marked while a filter is set;
 *   - pressing a value again lets it go, tags toggle, Clear empties the
 *     page's filter — and each change asks the list again, as a newer ask.
 *
 * Same technique as webapp-album-cards.test.mjs: the real functions are
 * sliced out of m.js and run against stub globals.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'm.js'), 'utf8');

function sliceFn(name) {
  const lines = SRC.split(/\r?\n/);
  const header = (l) => l.split(' (').join('(');   // `function escapeHtml (string)`
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

const FNS = ['escapeHtml', 'moodFilterBody', 'moodPanelHtml', 'showMoodFilters', 'hideMoodFilters', 'toggleMoodPanel',
  'pickMood', 'toggleMoodTag', 'clearMoodFilters', 'moodFilterChanged', 'discoveryPickMood'];

// An element with a working classList and attributes; querySelectorAll
// finds nothing (the pressed states are asserted through the HTML).
function el() {
  const classes = new Set();
  const attrs = new Map();
  return {
    innerHTML: '',
    focused: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) { classes.add(c); } else { classes.delete(c); } },
    },
    setAttribute: (n, v) => attrs.set(n, String(v)),
    getAttribute: (n) => attrs.get(n) ?? null,
    hasChildNodes() { return this.innerHTML !== ''; },
    querySelectorAll: () => [],
    querySelector: () => null,
    focus() { this.focused = true; },
  };
}

function makeSandbox() {
  const els = new Map([['mood_filter_btn', el()], ['mood_filters', el()]]);
  els.get('mood_filter_btn').classList.add('super-hide');
  els.get('mood_filters').classList.add('super-hide');
  const asked = [];
  const globals = {
    document: { getElementById: (id) => els.get(id) ?? null },
    t: (k) => k,
    getAllAlbums: (opts) => asked.push({ list: 'albums', opts }),
    getAllArtists: (opts) => asked.push({ list: 'artists', opts }),
    redoDiscovery: () => asked.push({ list: 'discover' }),
    discoveryRefocus: () => {},
  };
  const body = `
    'use strict';
    let browseGeneration = 0;
    ${sliceConst('entityMap')}
    ${sliceConst('MOODS')}
    ${FNS.map(sliceFn).join('\n\n')}
    return { ${FNS.join(', ')}, MOODS, generation: () => browseGeneration };
  `;
  const names = Object.keys(globals);
  const S = new Function(...names, body)(...names.map((n) => globals[n]));
  return { S, els, asked };
}

const pressed = (html) => [...html.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1]);

describe('mood filters: the wire form', () => {
  test('only the groups that filter, tags in a fixed order; nothing when empty', () => {
    const { S } = makeSandbox();
    assert.equal(S.moodFilterBody('albums'), null);
    S.MOODS.filters.albums = { valence: 'neutral', energy: undefined, tags: ['danceable', 'acoustic'] };
    assert.deepEqual(S.moodFilterBody('albums'), { valence: 'neutral', tags: ['acoustic', 'danceable'] });
    S.MOODS.filters.albums = { tags: [] };
    assert.equal(S.moodFilterBody('albums'), null);
    assert.equal(S.moodFilterBody('nope'), null);
  });
});

describe('mood filters: the panel', () => {
  test('one pressed value per scale, pressed tags, Clear only while set', () => {
    const { S } = makeSandbox();
    const empty = S.moodPanelHtml('albums');
    assert.deepEqual(pressed(empty), []);
    assert.match(empty, /class="mood-clear super-hide"/);
    assert.equal((empty.match(/class="mood-seg"/g) || []).length, 3, 'happy/sad, relaxed/aggressive, instrumental/vocals');
    assert.match(empty, /onclick="pickMood\('valence', 'neutral'\)"/);
    S.MOODS.filters.albums = { energy: 'relaxed', voice: 'instrumental', tags: ['party'] };
    const set = S.moodPanelHtml('albums');
    assert.deepEqual(pressed(set), ['moods.relaxed', 'moods.instrumental', 'moods.party']);
    assert.match(set, /class="mood-clear"/);
  });

  test("Discover's buttons carry data-dp actions, not handlers", () => {
    const { S } = makeSandbox();
    const html = S.moodPanelHtml('discover');
    assert.doesNotMatch(html, /onclick=/);
    assert.match(html, /data-dp="mood" data-v="energy:aggressive"/);
    assert.match(html, /data-dp="moodTag" data-v="acoustic"/);
    assert.match(html, /data-dp="moodClear"/);
  });
});

describe('mood filters: the bar button', () => {
  test('shown only when the answer carries moods; closed; marked while a filter is set', () => {
    const { S, els } = makeSandbox();
    const btn = els.get('mood_filter_btn');
    const panel = els.get('mood_filters');
    S.showMoodFilters('albums', { albums: [] });
    assert.ok(btn.classList.contains('super-hide'), 'an older server, or no scores: no filters');
    S.showMoodFilters('albums', { albums: [], moods: {} });
    assert.ok(!btn.classList.contains('super-hide'));
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.ok(panel.classList.contains('super-hide'), 'hidden by default');
    assert.ok(!btn.classList.contains('mood-on'));
    S.MOODS.filters.albums = { valence: 'sad' };
    S.showMoodFilters('albums', { albums: [], moods: { valence: 'sad' } });
    assert.ok(btn.classList.contains('mood-on'));
  });

  test('the button opens and closes the panel; another list closes it', () => {
    const { S, els } = makeSandbox();
    const btn = els.get('mood_filter_btn');
    const panel = els.get('mood_filters');
    S.showMoodFilters('albums', { moods: {} });
    S.toggleMoodPanel();
    assert.ok(!panel.classList.contains('super-hide'));
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.match(panel.innerHTML, /mood-seg/);
    S.showMoodFilters('albums', { moods: {} });
    assert.ok(!panel.classList.contains('super-hide'), 'a refresh of the same list keeps it open');
    S.showMoodFilters('artists', { moods: {} });
    assert.ok(panel.classList.contains('super-hide'), 'another list starts closed');
    S.toggleMoodPanel();
    S.toggleMoodPanel();
    assert.ok(panel.classList.contains('super-hide'));
    assert.equal(panel.innerHTML, '');
  });
});

describe('mood filters: changing the filter', () => {
  test('pressing a value again lets it go; tags toggle; each change asks again, as a newer ask', () => {
    const { S, asked } = makeSandbox();
    S.showMoodFilters('albums', { moods: {} });
    S.pickMood('energy', 'relaxed');
    assert.deepEqual(S.moodFilterBody('albums'), { energy: 'relaxed' });
    S.pickMood('energy', 'aggressive');
    assert.deepEqual(S.moodFilterBody('albums'), { energy: 'aggressive' }, 'one value per scale');
    S.pickMood('energy', 'aggressive');
    assert.equal(S.moodFilterBody('albums'), null);
    S.toggleMoodTag('party');
    S.toggleMoodTag('acoustic');
    S.toggleMoodTag('party');
    assert.deepEqual(S.moodFilterBody('albums'), { tags: ['acoustic'] });
    assert.equal(asked.length, 6);
    assert.ok(asked.every((a) => a.list === 'albums' && a.opts.refresh === true));
    assert.equal(S.generation(), 6);
  });

  test("Clear empties this list's filter only, and gives the keyboard back to the button", () => {
    const { S, els, asked } = makeSandbox();
    S.MOODS.filters.artists = { valence: 'happy' };
    S.showMoodFilters('albums', { moods: {} });
    S.pickMood('voice', 'vocals');
    S.clearMoodFilters();
    assert.equal(S.moodFilterBody('albums'), null);
    assert.deepEqual(S.moodFilterBody('artists'), { valence: 'happy' });
    assert.ok(els.get('mood_filter_btn').focused);
    assert.deepEqual(asked.map((a) => a.list), ['albums', 'albums']);
  });

  test("Discover's actions change its own filter and ask the page again", () => {
    const { S, asked } = makeSandbox();
    S.discoveryPickMood('mood', 'valence:neutral');
    S.discoveryPickMood('moodTag', 'danceable');
    assert.deepEqual(S.moodFilterBody('discover'), { valence: 'neutral', tags: ['danceable'] });
    S.discoveryPickMood('mood', 'valence:angry');
    S.discoveryPickMood('moodTag', 'sad');
    assert.deepEqual(S.moodFilterBody('discover'), { valence: 'neutral', tags: ['danceable'] }, 'unknown values change nothing');
    S.discoveryPickMood('moodClear', 'all');
    assert.equal(S.moodFilterBody('discover'), null);
    assert.equal(asked.filter((a) => a.list === 'discover').length, 3);
  });
});
