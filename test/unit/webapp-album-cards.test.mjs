/**
 * The album-API series in the default UI (PR 5): album cards carry the album
 * artist, clicks and queueing send it back, and the Artists panel honours the
 * two layout preferences.
 *
 * What is pinned:
 *   - a card shows the album artist under its name and carries it as
 *     data-album-artist; when the collapsed rows disagree (album_artist null)
 *     the line falls back to the credits and NO selector is set — a joined
 *     display would match nothing and open an empty album;
 *   - a server without the fields (a peer on an older version) draws the
 *     pre-series card, byte for byte;
 *   - opening or queueing a card sends `album_artist` only when the card has
 *     one, never null, so older servers see the request they always did;
 *   - the local filter re-renders cards losslessly, selector included
 *     (the currentBrowsingList contract);
 *   - /db/artists gets `include: ['albumArtists']` by default and
 *     `sort: 'order'` on request, and neither when browsing a peer.
 *
 * Same technique as webapp-local-search.test.mjs: the real functions are
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

const FNS = ['escapeHtml', 'peerAttr', 'peerOf', 'adoptPeer', 'browseApi', 'localIgnoreVPaths',
  'artUrl', 'artImgAttr', 'albumCredit', 'renderAlbum', 'renderArtist', 'createMusicFileHtml',
  'setBrowserRootPanel', 'artistsBody', 'albumSongsBody', 'getAllArtists', 'getArtistsAlbums',
  'getAllAlbums', 'getAlbumsOnClick', 'getAlbumSongs', 'queueAlbum', 'runLocalSearch'];

const KNOWN_IDS = ['filelist', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn'];

// A sandbox around the sliced functions. `api` supplies the MSTREAMAPI browse
// methods; every call's body is captured in `calls` for the request tests.
function makeSandbox(api, { altLayout = {}, peer = null } = {}) {
  const els = new Map();
  for (const id of KNOWN_IDS) {
    els.set(id, { innerHTML: '', value: '', scrollTop: 0, style: {}, disabled: false,
      classList: { add() {}, remove() {}, contains: () => false }, dispatchEvent() {} });
  }
  const calls = [];
  const wrap = (name, fn) => (body) => { calls.push({ name, body }); return Promise.resolve(fn ? fn(body) : []); };
  const local = {};
  for (const name of ['artists', 'albums', 'artistAlbums', 'albumSongs']) { local[name] = wrap(name, api[name]); }
  const peerApi = {};
  for (const name of ['artists', 'albums', 'artistAlbums', 'albumSongs']) {
    peerApi[name] = (peerId, body) => { calls.push({ name: `peer.${name}`, peerId, body }); return Promise.resolve(api[name] ? api[name](body) : []); };
  }
  const queued = [];
  const globals = {
    document: { getElementById: (id) => els.get(id) ?? null, getElementsByClassName: () => [] },
    MSTREAMAPI: { currentServer: { host: 'http://host/', token: 'TOK' }, ...local, peer: peerApi },
    MSTREAMPLAYER: { ignoreVPaths: {} },
    VUEPLAYERCORE: { altLayout: { compressArt: false, ...altLayout }, playlists: [] },
    iziToast: { success() {} },
    t: (k) => k,
    getLoadingSvg: () => '',
    boilerplateFailure: (err) => { throw err; },
    applyServerContext: () => {},
    queueRow: (p, filepath, metadata) => { queued.push({ peer: p, filepath, metadata }); },
    knownPeers: new Map(peer ? [[peer.id, peer]] : []),
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let peerContext = ${peer ? JSON.stringify(peer) : 'null'};
    let browseGeneration = 0;
    ${sliceConst('entityMap')}
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      html: () => __els.get('filelist').innerHTML,
      filter: (value) => { runLocalSearch({ value }); return __els.get('filelist').innerHTML; },
      list: () => currentBrowsingList,
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));
  return { S, calls, queued };
}

const cards = (html) => html.split(/(?=<div class="album-grid-card")/).filter((c) => c.includes('album-grid-card')).map((c) => c.trim());
const attr = (card, name) => (card.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1];
const line = (card) => (card.match(/<div class="album-grid-artist">([^<]*)<\/div>/) ?? [])[1];

// A card element as the click handlers see it.
function cardEl(card) {
  const attrs = {};
  for (const m of card.matchAll(/ (data-[a-z-]+)="([^"]*)"/g)) { attrs[m[1]] = m[2]; }
  return { hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null, closest: () => null };
}

const ALBUMS = [
  { name: 'Solo', year: 2001, album_art_file: 'solo.jpg', album_artist: 'Ann', artists: ['Ann'], compilation: false },
  { name: 'Twin', year: 2003, album_art_file: 'twin.jpg', album_artist: null, artists: ['Ann', 'Bob'], compilation: false },
  { name: 'Mix', year: 2005, album_art_file: 'mix.jpg', album_artist: 'Various Artists', artists: ['Various Artists'], compilation: true },
];
const OLD_SERVER_ALBUMS = [
  { name: 'Solo', year: 2001, album_art_file: 'solo.jpg' },
];

describe('album cards carry the album artist', () => {
  test('the line and the selector follow album_artist; a disagreeing group shows its credits without a selector', async () => {
    const { S } = makeSandbox({ albums: () => ({ albums: ALBUMS }) });
    await S.getAllAlbums();
    const [solo, twin, mix] = cards(S.html());
    assert.equal(line(solo), 'Ann');
    assert.equal(attr(solo, 'data-album-artist'), 'Ann');
    assert.equal(line(twin), 'Ann, Bob', 'the credits stand in when the rows disagree');
    assert.equal(attr(twin, 'data-album-artist'), undefined, 'a joined display is never a selector');
    assert.equal(line(mix), 'Various Artists');
    assert.equal(attr(mix, 'data-album-artist'), 'Various Artists');
    assert.equal(attr(solo, 'data-year'), '2001');
    assert.deepEqual(S.list().map((x) => [x.album_artist, x.artist_line]), [['Ann', 'Ann'], [null, 'Ann, Bob'], ['Various Artists', 'Various Artists']]);
  });

  test('a server without the fields draws the pre-series card', async () => {
    const { S } = makeSandbox({ albums: () => ({ albums: OLD_SERVER_ALBUMS }) });
    await S.getAllAlbums();
    const [solo] = cards(S.html());
    assert.equal(line(solo), undefined);
    assert.ok(!solo.includes('data-album-artist'));
    assert.ok(solo.includes('data-year="2001"') && solo.includes('data-album="Solo"'));
  });

  test('an artist\'s albums carry the credit too, and the singles card names the artist', async () => {
    const { S } = makeSandbox({ artistAlbums: () => ({ albums: [
      ...ALBUMS.slice(0, 1),
      { name: null, year: null, album_art_file: null, album_artist: 'Ann', artists: ['Ann'], compilation: false },
    ] }) });
    await S.getArtistsAlbums('Ann');
    const [solo, singles] = cards(S.html());
    assert.equal(attr(solo, 'data-album-artist'), 'Ann');
    assert.ok(singles.includes('SINGLES'));
    assert.equal(attr(singles, 'data-artist'), 'Ann', 'the singles card still routes by track artist');
    assert.equal(line(singles), 'Ann');
  });

  test('the local filter re-renders cards losslessly, selector included', async () => {
    const { S } = makeSandbox({ albums: () => ({ albums: ALBUMS }) });
    await S.getAllAlbums();
    const before = cards(S.html());
    const after = cards(S.filter('tw'));
    assert.equal(after.length, 1);
    assert.equal(after[0], before[1], 'the Twin card survives the filter byte for byte');
    const onlySolo = cards(S.filter('solo'));
    assert.equal(attr(onlySolo[0], 'data-album-artist'), 'Ann');
  });
});

describe('opening and queueing a card send the album artist back', () => {
  test('getAlbumsOnClick sends album_artist for a card that carries one, and omits it otherwise', async () => {
    const { S, calls } = makeSandbox({ albums: () => ({ albums: ALBUMS }), albumSongs: () => [] });
    await S.getAllAlbums();
    const [solo, twin] = cards(S.html());
    S.getAlbumsOnClick(cardEl(solo));
    await new Promise((r) => setImmediate(r));
    const soloCall = calls.find((c) => c.name === 'albumSongs');
    assert.deepEqual(soloCall.body, { album: 'Solo', artist: null, year: '2001', ignoreVPaths: [], album_artist: 'Ann' });
    calls.length = 0;
    S.getAlbumsOnClick(cardEl(twin));
    await new Promise((r) => setImmediate(r));
    const twinCall = calls.find((c) => c.name === 'albumSongs');
    assert.deepEqual(twinCall.body, { album: 'Twin', artist: null, year: '2003', ignoreVPaths: [] },
      'no album_artist key at all for a disagreeing card — the whole album opens');
  });

  test('queueAlbum sends the same body and queues every row', async () => {
    const songs = [{ filepath: 'm/Solo/1.mp3', metadata: { title: 'One' } }, { filepath: 'm/Solo/2.mp3', metadata: { title: 'Two' } }];
    const { S, calls, queued } = makeSandbox({ albums: () => ({ albums: ALBUMS }), albumSongs: () => songs });
    await S.getAllAlbums();
    const [solo] = cards(S.html());
    await S.queueAlbum(cardEl(solo));
    assert.deepEqual(calls.find((c) => c.name === 'albumSongs').body,
      { album: 'Solo', artist: null, year: '2001', ignoreVPaths: [], album_artist: 'Ann' });
    assert.deepEqual(queued.map((q) => q.filepath), ['m/Solo/1.mp3', 'm/Solo/2.mp3']);
  });
});

describe('the Artists panel honours the layout preferences', () => {
  test('defaults: album-only artists included, articles honoured', async () => {
    const { S, calls } = makeSandbox({ artists: () => ({ artists: ['Ann', 'Various Artists'] }) });
    await S.getAllArtists();
    assert.deepEqual(calls[0].body, { ignoreVPaths: [], include: ['albumArtists'] });
    assert.ok(S.html().includes('Various Artists'));
  });

  test('both preferences flipped: no include, sort by order name', async () => {
    const { S, calls } = makeSandbox({ artists: () => ({ artists: [] }) },
      { altLayout: { artistsShowAlbumOnly: false, artistsIgnoreArticles: true } });
    await S.getAllArtists();
    assert.deepEqual(calls[0].body, { ignoreVPaths: [], sort: 'order' });
  });

  test('a peer gets neither preference — its version may validate neither', async () => {
    const { S, calls } = makeSandbox({ artists: () => ({ artists: [] }) },
      { altLayout: { artistsIgnoreArticles: true }, peer: { id: 7, name: 'rum' } });
    await S.getAllArtists();
    assert.equal(calls[0].name, 'peer.artists');
    assert.deepEqual(calls[0].body, { ignoreVPaths: undefined });
  });
});
