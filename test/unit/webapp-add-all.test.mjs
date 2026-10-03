/**
 * addAll() in webapp/alpha/m.js — the "Add All To Queue" button above the
 * browse column.
 *
 * It queued every visible row with NO metadata, so addSongWizard fired one
 * /api/v1/db/metadata lookup per track — even in the panels whose rows had
 * just arrived with the full metadata object inline (a saved playlist, a
 * genre, an album, starred, recently played / added, most played). Adding a
 * 5,000-track playlist meant 5,000 round-trips for data the panel already
 * held (issue #374). Peer rows were worse off: a peer track is never looked
 * up, so Add All on a peer panel queued them with no title at all.
 *
 * Pinned here:
 *   - every DB panel's Add All queues each row with the metadata it was
 *     drawn from and asks for no lookup, in panel order, duplicates included;
 *   - rows drawn without metadata (the file explorer, a playlist entry whose
 *     file is gone) still get their lookup, and so does DB search, whose
 *     hits carry only the lite subset;
 *   - a peer row now carries its metadata, so it autoplays onto an empty
 *     queue like a local row (autoPlayOff false); without it, paused as before;
 *   - a live playlist still gets one add-song per row, in panel order.
 *
 * webapp/ has no browser test harness, so — like webapp-local-search — this
 * slices the real functions out of m.js (the panels, addAll, queueRow) AND
 * vp.js (addSongWizard / addFederationSongWizard, so the lookup decision is
 * the wizard's own, not a copy of it) and runs them against stub globals. If
 * they are renamed or restructured the slice fails loudly rather than
 * silently testing nothing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const M_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'm.js'), 'utf8');
const VP_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'vp.js'), 'utf8');

// ── source slicing ──────────────────────────────────────────────────
// Same brace-match as webapp-local-search: from a top-level
// `function NAME(` / `async function NAME(` header to its column-0 `}`.
function findFn(name) {
  const lines = M_SRC.split(/\r?\n/);
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) =>
    header(l).startsWith(`function ${name}(`) ||
    header(l).startsWith(`async function ${name}(`));
  if (start < 0) return null;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceFn(name) {
  const src = findFn(name);
  assert.ok(src, `m.js no longer defines ${name}() at top level — update this test`);
  return src;
}

function sliceConst(name) {
  const lines = M_SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of const ${name}`);
}

// vp.js defines the wizards as `  mstreamModule.NAME = … => {` inside its
// module closure, closing on a `  };` line.
function sliceWizard(name) {
  const lines = VP_SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`  mstreamModule.${name} = `));
  assert.ok(start >= 0, `vp.js no longer defines mstreamModule.${name} — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '  };') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of mstreamModule.${name}`);
}

const HELPERS = ['escapeHtml', 'peerAttr', 'peerOf', 'browseApi', 'localIgnoreVPaths',
  'artUrl', 'artImgAttr', 'albumCredit', 'albumSongsBody', 'searchKey', 'queueRow'];

const RENDERERS = ['renderFileWithMetadataHtml', 'createMusicFileHtml', 'renderDirHtml',
  'createFileplaylistHtml', 'renderSearchResults', 'renderSearchRow'];

const PANELS = ['setBrowserRootPanel', 'getFileExplorerPath', 'printdir', 'onPlaylistClick',
  'getGenreSongs', 'getAlbumSongs', 'getRatedSongs', 'redoRecentlyPlayed', 'redoMostPlayed',
  'redoRecentlyAdded', 'runLocalSearch', 'setupSearchPanel', 'federatedSearchOffered'];

// addAll's own helper is sliced when m.js has one, so this suite runs the
// same behavioural assertions against any m.js — one that inlines it, or
// the pre-fix one (where they fail on the lookups, not on a missing name).
// Renaming it without updating this list fails as a ReferenceError in addAll.
const OPTIONAL = ['browsingListMetadata'];

// ── a just-enough DOM ───────────────────────────────────────────────
// addAll walks document.getElementsByClassName('filez'). Rebuild that list
// from the HTML the panels actually wrote, decoding attributes the way the
// browser would, so the test reads the same data-file_location / data-peer
// a click would.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (m) => ENTITIES[m]);

function elementsWithClass(html, cls) {
  const out = [];
  for (const [, attrs] of html.matchAll(/<div\b([^>]*)>/g)) {
    const map = new Map();
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) map.set(k, decode(v));
    if ((map.get('class') || '').split(/\s+/).includes(cls)) {
      out.push({ getAttribute: (k) => (map.has(k) ? map.get(k) : null) });
    }
  }
  return out;
}

const KNOWN_IDS = ['filelist', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn', 'recently-added-limit',
  'recently-played-limit', 'most-played-limit', 'playlist_name', 'search-results',
  'search_folders'];

const el = (value = '') => ({
  innerHTML: '', value, scrollTop: 0, style: {}, disabled: false,
  classList: { add() {}, remove() {}, contains: () => false },
  dispatchEvent() {},
});

// `server` is the library the stubbed /api/v1/db/metadata answers from.
function makeSandbox(api, { server = {}, livePlaylist = null } = {}) {
  const els = new Map(KNOWN_IDS.map((id) => [id, el(id.endsWith('-limit') ? '100' : '')]));

  const lookups = [];          // every /api/v1/db/metadata request, by path
  const addSongPosts = [];     // every live-playlist /api/v1/playlist/add-song
  const queue = [];            // what MSTREAMPLAYER.addSong received, in order
  const api$ = {
    currentServer: { host: 'http://host/', token: 'TOK' },
    lookupMetadata: (fp) => {
      lookups.push(fp);
      return Promise.resolve({ filepath: fp, metadata: server[fp] ? { ...server[fp] } : null });
    },
    addToPlaylist: (name, fp) => { addSongPosts.push([name, fp]); return Promise.resolve({}); },
    ...api,
  };
  const player = {
    ignoreVPaths: {}, positionCache: { val: 0 },
    transcodeOptions: { serverEnabled: false, frontendEnabled: false },
    addSong: (song, autoPlayOff) => { queue.push({ song, autoPlayOff }); },
    insertSongAt: () => { throw new Error('Add All appends; it must not insert'); },
    getCurrentSong: () => null,
    resetCurrentMetadata() {},
  };

  // vp.js's module object — the page's VUEPLAYERCORE — with the real wizards.
  const core = {
    altLayout: { compressArt: false, waveformBar: false }, playlists: [],
    livePlaylist: { name: livePlaylist },
    prefetchWaveform() {},
  };
  new Function('mstreamModule', 'MSTREAMPLAYER', 'MSTREAMAPI', 'saveLiveQueue', `
    'use strict';
    ${sliceWizard('addSongWizard')}
    ${sliceWizard('addFederationSongWizard')}
  `)(core, player, api$, () => {});

  const globals = {
    document: {
      // #db-search exists only while setupSearchPanel's markup is on screen.
      getElementById: (id) => (id === 'db-search'
        ? (els.get('filelist').innerHTML.includes('id="db-search"') ? el() : null)
        : els.get(id) ?? null),
      getElementsByClassName: (cls) =>
        elementsWithClass(els.get('filelist').innerHTML + els.get('search-results').innerHTML, cls),
    },
    Event: class { constructor(type) { this.type = type; } },
    MSTREAMAPI: api$,
    MSTREAMPLAYER: player,
    VUEPLAYERCORE: core,
    t: (k) => k,
    getLoadingSvg: () => '',
    boilerplateFailure: (err) => { throw err; },
  };

  const optional = OPTIONAL.map(findFn).filter(Boolean);
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let fileExplorerArray = [];
    let peerContext = null;
    let browseGeneration = 0;
    let searchResultMetadata = {};
    const knownPeers = new Map();
    const searchToggles = { albums: true, artists: true, files: false, titles: true, lyrics: true, federated: false };
    ${sliceConst('entityMap')}
    ${sliceConst('searchMap')}
    ${HELPERS.map(sliceFn).join('\n\n')}
    ${RENDERERS.map(sliceFn).join('\n\n')}
    ${PANELS.map(sliceFn).join('\n\n')}
    ${optional.join('\n\n')}
    ${sliceFn('addAll')}
    return {
      ${PANELS.join(', ')}, addAll,
      setFileExplorerArray(a) { fileExplorerArray = a; },
      setProgramState(p) { programState = p; },
      setPeerContext(p) { peerContext = p; if (p) knownPeers.set(p.id, p); },
      browsingList: () => currentBrowsingList,
      // The tail of submitSearchForm: reset the per-search map, draw the rows.
      showSearchResults(res) {
        searchResultMetadata = {};
        __els.get('search-results').innerHTML = renderSearchResults(res, peerContext);
      },
      filter: (value) => runLocalSearch({ value }),
    };
  `;
  const names = [...Object.keys(globals), '__els'];
  const S = new Function(...names, body)(...names.map((n) => (n === '__els' ? els : globals[n])));

  // addSongWizard is async (it awaits the live-playlist POST and the lookup);
  // let every wizard call addAll started run to completion.
  S.addAllAndSettle = async () => {
    S.addAll();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return Object.assign(S, { lookups, addSongPosts, queue });
}

// ── fixtures ────────────────────────────────────────────────────────
const canned = (value) => () => Promise.resolve(value);
const song = (filepath, title, artist, extra = {}) => ({
  filepath,
  metadata: { title, artist, composer: `${artist} (comp)`, hash: `h-${title}`, 'album-art': null, ...extra },
});

const WALL = [
  song('music/The Wall/CD1/01 In the Flesh.flac', 'In the Flesh?', 'Pink Floyd', { rating: 10, 'play-count': 4 }),
  song('music/The Wall/CD1/02 The Thin Ice.flac', 'The Thin Ice', 'Pink Floyd', { rating: 8, 'play-count': 2 }),
  song('music/The Wall/CD1/03 Another Brick.flac', 'Another Brick in the Wall', 'Pink Floyd', { rating: 6, 'play-count': 9 }),
];

// What /api/v1/db/metadata would answer for each path.
const SERVER = Object.fromEntries(WALL.map((s) => [s.filepath, s.metadata]));

// /api/v1/playlist/load answers `{ lokiId, filepath, metadata }` per entry,
// `metadata: {}` for an entry whose file is gone; a path may appear twice.
const PLAYLIST = [
  { lokiId: '1', ...WALL[1] },
  { lokiId: '2', ...WALL[0] },
  { lokiId: '3', filepath: 'music/gone.flac', metadata: {} },
  { lokiId: '4', ...WALL[1] },
  { lokiId: '5', ...WALL[2] },
];

const playlistEl = (name) => ({ getAttribute: () => encodeURIComponent(name) });

const queuedPaths = (S) => S.queue.map((q) => q.song.rawFilePath);

// Every DB panel whose rows come with the full metadata object inline.
const PANEL_CASES = [
  { name: 'genre songs', api: { genreSongs: canned(WALL) }, state: [{ state: 'genre', name: 'Rock' }],
    run: (S) => S.getGenreSongs('Rock') },
  { name: 'album songs', api: { albumSongs: canned(WALL) }, run: (S) => S.getAlbumSongs('The Wall', 'Pink Floyd', '1979') },
  { name: 'starred / rated', api: { getRated: canned(WALL) }, run: (S) => S.getRatedSongs() },
  { name: 'recently played', api: { getRecentlyPlayed: canned(WALL) }, run: (S) => S.redoRecentlyPlayed() },
  { name: 'most played', api: { getMostPlayed: canned(WALL) }, run: (S) => S.redoMostPlayed() },
  { name: 'recently added', api: { getRecentlyAdded: canned(WALL) }, run: (S) => S.redoRecentlyAdded() },
];

// ── tests ───────────────────────────────────────────────────────────
describe('addAll — a playlist queues with the metadata it was loaded with', () => {
  test('no /db/metadata request per row; panel order and duplicates kept', async () => {
    const S = makeSandbox({ loadPlaylist: canned(PLAYLIST) }, { server: SERVER });
    S.setProgramState([{ state: 'allPlaylists' }]);
    await S.onPlaylistClick(playlistEl('Mix'));
    await S.addAllAndSettle();

    assert.deepEqual(queuedPaths(S), PLAYLIST.map((r) => r.filepath), 'queue order differs from the panel');
    // Only the entry whose file is gone (`metadata: {}`) still asks — that
    // lookup is the only data there is for it.
    assert.deepEqual(S.lookups, ['music/gone.flac'], 'rows that carried metadata were looked up again');
    for (const [i, q] of S.queue.entries()) {
      if (PLAYLIST[i].filepath === 'music/gone.flac') continue;
      assert.deepEqual(q.song.metadata, PLAYLIST[i].metadata, `${q.song.rawFilePath} queued without its metadata`);
    }
    // The duplicate path gets its metadata both times.
    assert.equal(S.queue[3].song.metadata.title, 'The Thin Ice');
    assert.equal(S.queue[0].song.metadata.title, 'The Thin Ice');
  });

  test('each queue entry owns its metadata — a rating edit in the queue does not reach the panel', async () => {
    const S = makeSandbox({ loadPlaylist: canned(PLAYLIST) }, { server: SERVER });
    S.setProgramState([{ state: 'allPlaylists' }]);
    await S.onPlaylistClick(playlistEl('Mix'));
    await S.addAllAndSettle();

    // MSTREAMPLAYER.editSongMetadata writes cur.metadata[key] in place.
    S.queue[0].song.metadata.rating = 1;
    assert.equal(S.browsingList()[0].metadata.rating, 8);
    assert.notEqual(S.queue[0].song.metadata, S.queue[3].song.metadata);
  });

  test('after the filter bar narrows the playlist, only the visible rows are queued — still with metadata', async () => {
    const S = makeSandbox({ loadPlaylist: canned(PLAYLIST) }, { server: SERVER });
    S.setProgramState([{ state: 'allPlaylists' }]);
    await S.onPlaylistClick(playlistEl('Mix'));
    S.filter('thin');
    await S.addAllAndSettle();

    assert.deepEqual(queuedPaths(S), [WALL[1].filepath, WALL[1].filepath]);
    assert.deepEqual(S.lookups, []);
    assert.ok(S.queue.every((q) => q.song.metadata.title === 'The Thin Ice'));
  });

  test('live playlist: still one add-song per row, in panel order', async () => {
    const S = makeSandbox({ loadPlaylist: canned(PLAYLIST) }, { server: SERVER, livePlaylist: 'Live' });
    S.setProgramState([{ state: 'allPlaylists' }]);
    await S.onPlaylistClick(playlistEl('Mix'));
    await S.addAllAndSettle();

    assert.deepEqual(S.addSongPosts.map(([, fp]) => fp), PLAYLIST.map((r) => r.filepath));
    assert.ok(S.addSongPosts.every(([name]) => name === 'Live'));
    assert.deepEqual(S.lookups, ['music/gone.flac']);
  });
});

describe('addAll — the other DB panels queue with the metadata they hold', () => {
  for (const c of PANEL_CASES) {
    test(`${c.name}: no per-row lookup, panel order kept`, async () => {
      const S = makeSandbox(c.api, { server: SERVER });
      S.setProgramState(c.state || [{ state: 'x' }]);
      await c.run(S);
      await S.addAllAndSettle();

      assert.deepEqual(queuedPaths(S), WALL.map((r) => r.filepath), 'queue order differs from the panel');
      assert.deepEqual(S.lookups, [], `${c.name} rows were looked up again`);
      for (const [i, q] of S.queue.entries()) {
        assert.deepEqual(q.song.metadata, WALL[i].metadata);
        assert.equal(q.song.federation, undefined);
      }
    });
  }

  test('album view narrowed by the filter bar: the visible row keeps its metadata', async () => {
    const S = makeSandbox({ albumSongs: canned(WALL) }, { server: SERVER });
    S.setProgramState([{ state: 'album' }]);
    await S.getAlbumSongs('The Wall', 'Pink Floyd', '1979');
    S.filter('brick');
    await S.addAllAndSettle();

    assert.deepEqual(queuedPaths(S), [WALL[2].filepath]);
    assert.deepEqual(S.lookups, []);
    assert.deepEqual(S.queue[0].song.metadata, WALL[2].metadata);
  });
});

describe('addAll — rows without full metadata keep their lookup', () => {
  test('file explorer: one lookup per file, exactly as before', async () => {
    const S = makeSandbox({}, { server: SERVER });
    S.setProgramState([{ state: 'fileExplorer' }]);
    S.setFileExplorerArray(['music', 'The Wall', 'CD1']);
    S.printdir({
      path: 'music/The Wall/CD1/',
      directories: [{ name: 'Bonus' }],
      files: [
        { type: 'file', name: '01 In the Flesh.flac', artist: 'Pink Floyd', title: 'In the Flesh?' },
        { type: 'file', name: '02 The Thin Ice.flac' },
      ],
    });
    await S.addAllAndSettle();

    assert.deepEqual(S.lookups, [WALL[0].filepath, WALL[1].filepath]);
    assert.deepEqual(S.queue.map((q) => q.song.metadata), [WALL[0].metadata, WALL[1].metadata]);
  });

  test('DB search: hits carry only lite metadata, so Add All still looks them up — and a previous panel\'s metadata does not leak in', async () => {
    const S = makeSandbox({ loadPlaylist: canned(PLAYLIST) }, { server: SERVER });
    S.setProgramState([{ state: 'allPlaylists' }]);
    await S.onPlaylistClick(playlistEl('Mix'));
    S.setupSearchPanel();
    const lite = (m) => ({ title: m.title, artist: m.artist, 'album-art': null });
    S.showSearchResults({ title: [{ name: 'In the Flesh?', filepath: WALL[0].filepath, metadata: lite(WALL[0].metadata) }] });
    await S.addAllAndSettle();

    assert.deepEqual(S.lookups, [WALL[0].filepath]);
    assert.deepEqual(S.queue[0].song.metadata, WALL[0].metadata, 'the lookup result (with composer) is what plays');
  });
});

describe('addAll — federated peer panels', () => {
  const PEER = { id: 7, name: 'Peer Seven' };
  const peerApi = (rows) => ({
    peer: { recentlyAdded: canned(rows), albumSongs: canned(rows) },
    peerArtUrl: (id, art) => `http://host/api/v1/federation/peers/${id}/art/${art}`,
  });

  test('peer rows queue over the bridge with their metadata and autoplay like a local row', async () => {
    const S = makeSandbox(peerApi(WALL), { server: SERVER });
    S.setProgramState([{ state: 'recentlyAdded' }]);
    S.setPeerContext(PEER);
    await S.redoRecentlyAdded();
    await S.addAllAndSettle();

    assert.deepEqual(queuedPaths(S), WALL.map((r) => r.filepath));
    assert.deepEqual(S.lookups, [], 'a peer path must never be looked up in the local library');
    for (const [i, q] of S.queue.entries()) {
      assert.deepEqual(q.song.federation, { peerId: 7, peerName: 'Peer Seven' });
      assert.deepEqual(q.song.metadata, WALL[i].metadata, 'peer row queued with no title');
      // Was `true` (loaded paused): the row reached queueRow with no
      // metadata. queueRow's own comment says a peer row with metadata
      // autoplays onto an empty queue like a local one.
      assert.equal(q.autoPlayOff, false);
    }
  });

  test('peer file explorer: no metadata to give, so rows stay as before (paused, no lookup)', async () => {
    const S = makeSandbox({ peerArtUrl: () => '' }, { server: SERVER });
    S.setProgramState([{ state: 'fileExplorer' }]);
    S.setPeerContext(PEER);
    S.setFileExplorerArray(['music', 'The Wall', 'CD1']);
    S.printdir({ path: 'music/The Wall/CD1/', directories: [], files: [{ type: 'file', name: '01 In the Flesh.flac' }] });
    await S.addAllAndSettle();

    assert.equal(S.queue.length, 1);
    assert.equal(S.queue[0].song.federation.peerId, 7);
    assert.deepEqual(S.queue[0].song.metadata, {});
    assert.equal(S.queue[0].autoPlayOff, true);
    assert.deepEqual(S.lookups, []);
  });
});
