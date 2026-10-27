/**
 * The Genres panel's tags / generated switch (default UI): the panel lists
 * one kind of genre at a time — the files' own tags or the discovery
 * model's — through the server's `source` filter.
 *
 * What is pinned:
 *   - with both kinds on the server: the switch, tag genres first, and each
 *     row carrying its source so its songs are asked for the same way;
 *   - the remembered choice is what gets asked for, and choosing re-lists
 *     and remembers;
 *   - a server with only one kind lists that kind, with no switch;
 *   - a server that predates the filter (no `sources` in the answer) draws
 *     the panel as before: no switch, no source on rows or song requests;
 *   - the local filter keeps the switch above the filtered rows;
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
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

const FNS = ['escapeHtml', 'peerAttr', 'peerOf', 'adoptPeer', 'browseApi', 'createMusicFileHtml',
  'setBrowserRootPanel', 'discoveryHideHead', 'renderGenre', 'genreSourceSwitch', 'preferredGenreSource',
  'chooseGenreSource', 'getAllGenres', 'getGenreSongsList', 'getGenreSongs', 'runLocalSearch'];

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
// list, plus `sources`. `sources: false` plays a server that predates the
// filter: it ignores `source` and answers with every genre.
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

function makeSandbox(genres, storage = makeStorage()) {
  const els = new Map();
  for (const id of KNOWN_IDS) {
    els.set(id, { innerHTML: '', value: '', scrollTop: 0, style: {}, disabled: false,
      classList: { add() {}, remove() {}, contains: () => false }, dispatchEvent() {} });
  }
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
  return { S, calls };
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
const pressed = (html) => (html.match(/<button[^>]*aria-pressed="true"[^>]*onclick="chooseGenreSource\('(\w+)'\)"/) ?? [])[1] ?? null;
const hasSwitch = (html) => html.includes('class="genre-source"');

describe('Genres panel: tags or generated', () => {
  test('both kinds: the switch, tag genres first, and rows carrying their source', async () => {
    const { S, calls } = makeSandbox(genreServer());
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'tag' }]);
    assert.ok(hasSwitch(S.html()));
    assert.equal(pressed(S.html()), 'tag');
    assert.deepEqual(rows(S.html()), [{ genre: 'Ambient', source: 'tag' }, { genre: 'Electronic', source: 'tag' }]);
  });

  test('a genre opened from the list asks for its songs with the list\'s source', async () => {
    const { S, calls } = makeSandbox(genreServer(), makeStorage({ 'genre-source': 'model' }));
    await S.getAllGenres();
    const synth = rows(S.html()).find((r) => r.genre === 'Synthwave');
    S.getGenreSongsList(rowEl(synth));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.at(-1), { name: 'genreSongs', body: { genre: 'Synthwave', source: 'model' } });
    assert.equal(S.state().at(-1).source, 'model', 'back navigation re-asks the same way');
  });

  test('the remembered choice is asked for; choosing the other re-lists and remembers it', async () => {
    const storage = makeStorage({ 'genre-source': 'model' });
    const { S, calls } = makeSandbox(genreServer(), storage);
    await S.getAllGenres();
    assert.deepEqual(calls[0].body, { source: 'model' });
    assert.equal(pressed(S.html()), 'model');

    S.chooseGenreSource('tag');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.map.get('genre-source'), 'tag');
    assert.deepEqual(calls.at(-1).body, { source: 'tag' });
    assert.equal(pressed(S.html()), 'tag');

    const before = calls.length;
    S.chooseGenreSource('tag');
    assert.equal(calls.length, before, 'choosing the shown kind again asks nothing');
  });

  test('only generated genres: listed without a switch', async () => {
    const { S, calls } = makeSandbox(genreServer({ tag: false }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'tag' }, { source: 'model' }], 'tags were empty, so the other kind');
    assert.ok(!hasSwitch(S.html()));
    assert.deepEqual(rows(S.html()).map((r) => r.source), ['model', 'model']);
  });

  test('only tag genres: listed without a switch', async () => {
    const { S, calls } = makeSandbox(genreServer({ model: false }), makeStorage({ 'genre-source': 'model' }));
    await S.getAllGenres();
    assert.deepEqual(calls.map((c) => c.body), [{ source: 'model' }, { source: 'tag' }]);
    assert.ok(!hasSwitch(S.html()));
    assert.deepEqual(rows(S.html()).map((r) => r.source), ['tag', 'tag']);
  });

  test('a server without the filter: every genre, no switch, no source anywhere', async () => {
    const { S, calls } = makeSandbox(genreServer({ sources: false }));
    await S.getAllGenres();
    assert.ok(!hasSwitch(S.html()));
    assert.equal(rows(S.html()).length, 4);
    assert.ok(rows(S.html()).every((r) => r.source === null));
    S.getGenreSongsList(rowEl(rows(S.html())[0]));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.at(-1).body, { genre: 'Ambient' }, 'the request it always sent');
  });

  test('the local filter keeps the switch above the filtered rows', async () => {
    const { S } = makeSandbox(genreServer());
    await S.getAllGenres();
    const html = S.filter('amb');
    assert.ok(html.startsWith('<div class="genre-source"'), 'switch first');
    assert.equal(pressed(html), 'tag');
    assert.deepEqual(rows(html), [{ genre: 'Ambient', source: 'tag' }]);
  });

  test('no localStorage: tag genres, and choosing still works for the visit', async () => {
    const { S, calls } = makeSandbox(genreServer(), makeStorage({}, { broken: true }));
    await S.getAllGenres();
    assert.deepEqual(calls[0].body, { source: 'tag' });
    S.chooseGenreSource('model');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.at(-1).body, { source: 'model' });
    assert.equal(pressed(S.html()), 'model');

    await S.getAllGenres();   // back to the panel later in the visit
    assert.deepEqual(calls.at(-1).body, { source: 'model' }, 'the pick holds for the visit');
  });
});
