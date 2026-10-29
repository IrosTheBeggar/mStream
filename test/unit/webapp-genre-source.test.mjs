/**
 * The Genres panel's tags / generated / both switch (default UI): the panel
 * lists the files' own tag genres, the discovery model's genres, or both,
 * through the server's `source` filter. The switch is the browse bar's
 * #genre_source (index.html), next to the search icon.
 *
 * What is pinned:
 *   - with both kinds on the server: the switch shown, tag genres first, and
 *     each row carrying its source so its songs are asked for the same way;
 *   - 'both': no filter on the list or on a genre's songs;
 *   - the remembered choice is what gets asked for, and choosing re-lists
 *     and remembers;
 *   - a server with only one kind lists that kind, with the switch hidden;
 *   - a server that predates the filter (no `sources` in the answer) draws
 *     the panel as before: no switch, no source on rows or song requests;
 *   - every other panel hides the switch;
 *   - no localStorage (private mode): tags, and the choice lasts the visit.
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
const M_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'm.js');
const SRC = fs.readFileSync(M_PATH, 'utf8');

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
  if (lines[start].endsWith(';')) { return lines[start]; }   // one-liner
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

const FNS = ['escapeHtml', 'peerAttr', 'peerOf', 'adoptPeer', 'browseApi', 'createMusicFileHtml',
  'setBrowserRootPanel', 'discoveryHideHead', 'hideMoodFilters', 'renderGenre', 'preferredGenreSource',
  'chooseGenreSource', 'showGenreSourceSwitch', 'getAllGenres', 'getGenreSongsList', 'getGenreSongs',
  'runLocalSearch'];

// Keep a copy's half of the browse pages: with its gate never read it
// draws nothing and asks nothing (as in webapp-album-cards.test.mjs).
const KEEP_FNS = [...SRC.matchAll(/^(?:async )?function ((?:keepGate|browseKeep|browseHead|browseAlbum|browseArtist|browseFolder)\w*|writeReadOnlyNote)\(/gm)].map((m) => m[1]);
const keepState = () => `${['keepGate', 'browseKeep', 'BROWSE_KEEP_ICONS'].map(sliceConst).join('\n')}
    let keepGatePending = null;
    let keepGateAsk = 0;
    let browseKeepQueued = null;
    const discoveryView = { flags: { discoveryPlugins: false } };
    ${KEEP_FNS.map(sliceFn).join('\n\n')}`;

const KNOWN_IDS = ['filelist', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn'];

const GENRES = {
  tag: [{ name: 'Ambient', track_count: 3 }, { name: 'Electronic', track_count: 5 }],
  model: [{ name: 'Ambient', track_count: 1 }, { name: 'Synthwave', track_count: 2 }],
};

// A server answering /db/genres like the real one: the asked-for source's
// list (every genre without one), plus `sources`. `sources: false` plays a
// server that predates the filter: it ignores `source` and sends every genre.
function genreServer({ tag = true, model = true, sources = true } = {}) {
  const have = { tag: tag ? GENRES.tag : [], model: model ? GENRES.model : [] };
  return (body) => {
    if (!sources) { return { genres: [...have.tag, ...have.model] }; }
    const genres = body?.source ? have[body.source] : [...have.tag, ...have.model];
    return { genres, sources: { tag: have.tag.length, model: have.model.length } };
  };
}

function makeStorage(initial = {}, { broken = false } = {}) {
  const map = new Map(Object.entries(initial));
  if (broken) {
    return { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  }
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, map };
}

// The bar's #genre_source as index.html has it: three buttons, hidden.
function makeSwitch() {
  const classes = new Set(['genre-source', 'super-hide']);
  const buttons = ['tag', 'model', 'both'].map((source) => {
    const attrs = { 'data-source': source, 'aria-pressed': 'false' };
    return { getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => { attrs[n] = v; } };
  });
  return {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelectorAll: () => buttons,
    hidden: () => classes.has('super-hide'),
    pressed: () => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-source')),
  };
}

function makeSandbox(genres, storage = makeStorage()) {
  const els = new Map();
  for (const id of KNOWN_IDS) {
    els.set(id, { innerHTML: '', value: '', scrollTop: 0, style: {}, disabled: false,
      classList: { add() {}, remove() {}, contains: () => false }, dispatchEvent() {} });
  }
  const sw = makeSwitch();
  els.set('genre_source', sw);
  const calls = [];
  const globals = {
    document: { getElementById: (id) => els.get(id) ?? null, getElementsByClassName: () => [] },
    MSTREAMAPI: {
      currentServer: { host: 'http://host/', token: 'TOK' },
      genres: (body) => { calls.push({ name: 'genres', body }); return Promise.resolve(genres(body)); },
      genreSongs: (body) => { calls.push({ name: 'genreSongs', body }); return Promise.resolve([]); },
      peer: {},
    },
    MSTREAMPLAYER: { ignoreVPaths: {} },
    VUEPLAYERCORE: { altLayout: { compressArt: false }, playlists: [] },
    localStorage: storage,
    t: (k) => k,
    getLoadingSvg: () => '',
    boilerplateFailure: (err) => { throw err; },
    applyServerContext: () => {},
    knownPeers: new Map(),
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let peerContext = null;
    let browseGeneration = 0;
    let genreSourceChoice = null;
    ${sliceConst('entityMap')}
    ${sliceConst('GENRE_SOURCES')}
    ${keepState()}
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      html: () => __els.get('filelist').innerHTML,
      filter: (value) => { runLocalSearch({ value }); return __els.get('filelist').innerHTML; },
      state: () => programState,
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));
  return { S, calls, sw };
}

// The rows as the click handler sees them.
function rows(html) {
  return [...html.matchAll(/<div data-genre="([^"]*)"(?: data-genre-source="([^"]*)")?/g)]
    .map((m) => ({ genre: m[1], source: m[2] ?? null }));
}
function rowEl(row) {
  const attrs = { 'data-genre': row.genre, ...(row.source ? { 'data-genre-source': row.source } : {}) };
  return { hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null, closest: () => null };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('Genres panel: tags, generated or both', () => {
  test('both kinds: the switch shown with Tags pressed, rows carrying their source', async () => {
    const { S, calls, sw } = makeSandbox(genreServer());
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'tag' }]);
    assert.equal(sw.hidden(), false);
    assert.deepEqual(sw.pressed(), ['tag']);
    assert.deepEqual(rows(S.html()), [{ genre: 'Ambient', source: 'tag' }, { genre: 'Electronic', source: 'tag' }]);
  });

  test('a genre opened from the list asks for its songs with the list\'s source, and hides the switch', async () => {
    const { S, calls, sw } = makeSandbox(genreServer(), makeStorage({ 'genre-source': 'model' }));
    await S.getAllGenres();
    const synth = rows(S.html()).find((r) => r.genre === 'Synthwave');
    S.getGenreSongsList(rowEl(synth));
    await tick();
    assert.deepEqual(calls.at(-1), { name: 'genreSongs', body: { genre: 'Synthwave', source: 'model' } });
    assert.equal(S.state().at(-1).source, 'model', 'back navigation re-asks the same way');
    assert.equal(sw.hidden(), true, 'the songs page is not the genre list');
  });

  test("'both' asks without a filter, and a genre's songs too", async () => {
    const { S, calls, sw } = makeSandbox(genreServer(), makeStorage({ 'genre-source': 'both' }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{}]);
    assert.deepEqual(sw.pressed(), ['both']);
    assert.equal(rows(S.html()).length, 4);
    assert.ok(rows(S.html()).every((r) => r.source === null), 'rows ask for every song');

    S.getGenreSongsList(rowEl(rows(S.html())[0]));
    await tick();
    assert.deepEqual(calls.at(-1).body, { genre: 'Ambient' });
  });

  test('the remembered choice is asked for; choosing another re-lists and remembers it', async () => {
    const storage = makeStorage({ 'genre-source': 'model' });
    const { S, calls, sw } = makeSandbox(genreServer(), storage);
    await S.getAllGenres();
    assert.deepEqual(calls[0].body, { source: 'model' });
    assert.deepEqual(sw.pressed(), ['model']);

    S.chooseGenreSource('both');
    await tick();
    assert.equal(storage.map.get('genre-source'), 'both');
    assert.deepEqual(calls.at(-1).body, {});
    assert.deepEqual(sw.pressed(), ['both']);

    const before = calls.length;
    S.chooseGenreSource('both');
    assert.equal(calls.length, before, 'choosing the shown kind again asks nothing');
  });

  test('only generated genres: listed with the switch hidden', async () => {
    const { S, calls, sw } = makeSandbox(genreServer({ tag: false }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'tag' }, { source: 'model' }], 'tags were empty, so the other kind');
    assert.equal(sw.hidden(), true);
    assert.deepEqual(rows(S.html()).map((r) => r.source), ['model', 'model']);
  });

  test("only tag genres, 'model' remembered: tags, switch hidden", async () => {
    const { S, calls, sw } = makeSandbox(genreServer({ model: false }), makeStorage({ 'genre-source': 'model' }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'model' }, { source: 'tag' }]);
    assert.equal(sw.hidden(), true);
    assert.deepEqual(rows(S.html()).map((r) => r.source), ['tag', 'tag']);
  });

  test("'both' on a server with one kind: one request, switch hidden", async () => {
    const { S, calls, sw } = makeSandbox(genreServer({ model: false }), makeStorage({ 'genre-source': 'both' }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{}]);
    assert.equal(sw.hidden(), true);
    assert.equal(rows(S.html()).length, 2);
  });

  test('a server without the filter: every genre, no switch, no source anywhere', async () => {
    const { S, calls, sw } = makeSandbox(genreServer({ sources: false }));
    await S.getAllGenres();
    assert.equal(sw.hidden(), true);
    assert.equal(rows(S.html()).length, 4);
    assert.ok(rows(S.html()).every((r) => r.source === null));
    S.getGenreSongsList(rowEl(rows(S.html())[0]));
    await tick();
    assert.deepEqual(calls.at(-1).body, { genre: 'Ambient' }, 'the request it always sent');
  });

  test('any other panel hides the switch', async () => {
    const { S, sw } = makeSandbox(genreServer());
    await S.getAllGenres();
    assert.equal(sw.hidden(), false);
    S.setBrowserRootPanel('panel.albums');
    assert.equal(sw.hidden(), true);
  });

  test('the local filter keeps each row\'s source', async () => {
    const { S, sw } = makeSandbox(genreServer());
    await S.getAllGenres();
    assert.deepEqual(rows(S.filter('amb')), [{ genre: 'Ambient', source: 'tag' }]);
    assert.equal(sw.hidden(), false, 'the switch is in the bar, untouched by the filter');
  });

  test('no localStorage: tag genres, and choosing still works for the visit', async () => {
    const { S, calls, sw } = makeSandbox(genreServer(), makeStorage({}, { broken: true }));
    await S.getAllGenres();
    assert.deepEqual(calls[0].body, { source: 'tag' });
    S.chooseGenreSource('model');
    await tick();
    assert.deepEqual(calls.at(-1).body, { source: 'model' });
    assert.deepEqual(sw.pressed(), ['model']);

    await S.getAllGenres();   // back to the panel later in the visit
    assert.deepEqual(calls.at(-1).body, { source: 'model' }, 'the pick holds for the visit');
  });
});
