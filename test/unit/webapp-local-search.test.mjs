/**
 * runLocalSearch() in webapp/alpha/m.js — the local filter bar above the
 * browse column.
 *
 * The filter does not hide rows, it RE-RENDERS them from
 * `currentBrowsingList`. That only works if the entries each panel pushes
 * carry everything the row needs. They didn't: the DB-driven panels pushed
 * `{ type: 'file', name }` and nothing else, so the re-render fell back to
 * `getFileExplorerPath() + x.name` — a rule that only ever held for the file
 * explorer. Inside an album view a row went from
 *
 *     music/The Wall/CD1/01 In the Flesh.flac      (unfiltered)
 *     music/In the Flesh                           (after typing one char)
 *
 * and clicking or queueing it played nothing. Back-navigation replays the
 * saved filter (`previousSearch` + a synthetic keyup), so the corruption also
 * hit rows you never typed over.
 *
 * The invariant pinned here: for every panel, filtering is *lossless* — a row
 * that survives the filter is byte-identical to the row the panel drew. That
 * covers the reported data-file_location bug and the quieter losses in the
 * same code path (album art, star rating, artist subtitle, album year).
 *
 * webapp/ has no browser test harness, so rather than re-typing the
 * implementation this slices the real functions out of m.js and runs them
 * against stub globals. If they are renamed or restructured the slice fails
 * loudly rather than silently testing nothing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const M_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'alpha', 'm.js');
const SRC = fs.readFileSync(M_PATH, 'utf8');

// ── source slicing ──────────────────────────────────────────────────
// Brace-match from a `function NAME(` / `async function NAME(` header to
// its closing brace. Naive on braces inside strings, which is fine for
// these functions: every one of them ends at column 0.
function sliceFn(name) {
  const lines = SRC.split(/\r?\n/);
  // m.js writes both `function name (` and `function name(`.
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

const RENDERERS = ['escapeHtml', 'renderAlbum', 'renderArtist', 'renderGenre',
  'renderFileWithMetadataHtml', 'createMusicFileHtml', 'renderDirHtml',
  'createFileplaylistHtml', 'renderPlaylist'];

const PANELS = ['setBrowserRootPanel', 'getFileExplorerPath', 'printdir',
  'getAllGenres', 'getGenreSongs', 'getAllAlbums', 'getArtistsAlbums',
  'getAlbumSongs', 'getRatedSongs', 'redoRecentlyPlayed', 'redoMostPlayed',
  'redoRecentlyAdded', 'runLocalSearch'];

const EXPORTS = [...RENDERERS, ...PANELS].join(', ');

// ── sandbox ─────────────────────────────────────────────────────────
// Only ids m.js actually touches resolve to an element. Everything else
// is null on purpose — notably `db-search`, whose presence makes
// runLocalSearch bail out early.
const KNOWN_IDS = ['filelist', 'localSearchBar', 'directoryName', 'directory_bar',
  'local_search_btn', 'upload_btn', 'mkdir_btn', 'recently-added-limit',
  'recently-played-limit', 'most-played-limit'];

function makeSandbox(api) {
  const els = new Map();
  for (const id of KNOWN_IDS) {
    els.set(id, {
      innerHTML: '', value: id.endsWith('-limit') ? '100' : '', scrollTop: 0,
      style: {}, disabled: false,
      classList: { add() {}, remove() {}, contains: () => false },
      dispatchEvent() {},
    });
  }

  const globals = {
    document: {
      getElementById: (id) => els.get(id) ?? null,
      getElementsByClassName: () => [],
    },
    MSTREAMAPI: { currentServer: { host: 'http://host/', token: 'TOK' }, ...api },
    MSTREAMPLAYER: { ignoreVPaths: {} },
    VUEPLAYERCORE: { altLayout: { compressArt: false }, playlists: [] },
    t: (k) => k,
    getLoadingSvg: () => '',
    boilerplateFailure: (err) => { throw err; },
  };

  const body = `
    'use strict';
    let currentBrowsingList = [];
    let programState = [];
    let fileExplorerArray = [];
    ${sliceConst('entityMap')}
    ${RENDERERS.map(sliceFn).join('\n\n')}
    ${PANELS.map(sliceFn).join('\n\n')}
    return {
      ${EXPORTS},
      setFileExplorerArray(a) { fileExplorerArray = a; },
      setProgramState(p) { programState = p; },
      html: () => __els.get('filelist').innerHTML,
      filter: (value) => { runLocalSearch({ value }); return __els.get('filelist').innerHTML; },
    };
  `;

  const names = [...Object.keys(globals), '__els'];
  const factory = new Function(...names, body);
  return factory(...names.map((n) => (n === '__els' ? els : globals[n])));
}

// ── assertions on rendered rows ─────────────────────────────────────
const WRAPPERS = [
  ['<ul class="collection">', '</ul>'],
  ['<div class="album-grid">', '</div>'],
];

function rows(html) {
  // Panels wrap their rows in a container; runLocalSearch re-renders the
  // rows on their own. Drop the wrapper so rows compare like for like.
  let h = html;
  for (const [open, close] of WRAPPERS) {
    if (!h.startsWith(open)) continue;
    h = h.slice(open.length);
    if (h.endsWith(close)) h = h.slice(0, -close.length);
    break;
  }

  return h
    .split(/(?=<li |<div class="album-grid-card")/)
    .filter((chunk) => /data-file_location=|album-grid-card|data-genre=/.test(chunk))
    .map((chunk) => chunk.trim());
}

function fileLocations(html) {
  return rows(html).map((r) => (r.match(/data-file_location="([^"]*)"/) ?? [])[1]);
}

// ── fixtures ────────────────────────────────────────────────────────
const canned = (value) => () => Promise.resolve(value);

const ALBUM_SONGS = [
  { filepath: 'music/The Wall/CD1/01 In the Flesh.flac',
    metadata: { title: 'In the Flesh?', artist: 'Pink Floyd', filename: '01 In the Flesh.flac' } },
  { filepath: 'music/The Wall/CD1/02 The Thin Ice.flac',
    metadata: { title: 'The Thin Ice', artist: 'Pink Floyd', filename: '02 The Thin Ice.flac' } },
];

const GENRE_SONGS = [
  { filepath: 'music/Kind of Blue/01 So What.flac',
    metadata: { title: 'So What', artist: 'Miles Davis' } },
  { filepath: 'music/Kind of Blue/02 Freddie Freeloader.flac',
    metadata: { title: 'Freddie Freeloader', artist: 'Miles Davis' } },
];

const RATED = [
  { filepath: 'music/The Wall/CD1/01 In the Flesh.flac',
    metadata: { title: 'In the Flesh?', artist: 'Pink Floyd', rating: 10, 'album-art': 'wall.jpg' } },
  { filepath: 'music/Kind of Blue/01 So What.flac',
    metadata: { title: 'So What', artist: 'Miles Davis', rating: 7 } },
];

const PLAYED = [
  { filepath: 'music/The Wall/CD1/01 In the Flesh.flac',
    metadata: { title: 'In the Flesh?', artist: 'Pink Floyd', 'album-art': 'wall.jpg', 'play-count': 4 } },
  { filepath: 'music/Kind of Blue/01 So What.flac',
    metadata: { title: 'So What', artist: 'Miles Davis', 'play-count': 9 } },
];

const DIR_RESPONSE = {
  path: 'music/The Wall/CD1/',
  directories: [],
  files: [
    { type: 'file', name: '01 In the Flesh.flac' },
    { type: 'file', name: '02 The Thin Ice.flac' },
  ],
};

// Every panel: load it, snapshot the rows, filter, and require each
// surviving row to be byte-identical to the one the panel drew.
const CASES = [
  { name: 'album songs',
    api: { albumSongs: canned(ALBUM_SONGS) },
    run: (S) => S.getAlbumSongs('The Wall', 'Pink Floyd', '1979'),
    needle: 'flesh', total: 2, kept: 1 },

  { name: 'genre songs',
    api: { genreSongs: canned(GENRE_SONGS) },
    state: [{ state: 'genre', name: 'Jazz' }],
    run: (S) => S.getGenreSongs('Jazz'),
    needle: 'freddie', total: 2, kept: 1 },

  { name: 'starred / rated',
    api: { getRated: canned(RATED) },
    run: (S) => S.getRatedSongs(),
    needle: 'pink floyd', total: 2, kept: 1 },

  { name: 'recently played',
    api: { getRecentlyPlayed: canned(PLAYED) },
    run: (S) => S.redoRecentlyPlayed(),
    needle: 'miles', total: 2, kept: 1 },

  { name: 'most played',
    api: { getMostPlayed: canned(PLAYED) },
    run: (S) => S.redoMostPlayed(),
    needle: 'miles', total: 2, kept: 1 },

  { name: 'recently added',
    api: { getRecentlyAdded: canned(PLAYED) },
    run: (S) => S.redoRecentlyAdded(),
    needle: 'miles', total: 2, kept: 1 },

  { name: 'file explorer',
    api: {},
    state: [{ state: 'fileExplorer' }],
    run: (S) => { S.setFileExplorerArray(['music', 'The Wall', 'CD1']); S.printdir(DIR_RESPONSE); },
    needle: 'thin', total: 2, kept: 1 },
];

// ── tests ───────────────────────────────────────────────────────────
describe('runLocalSearch — filtering is lossless', () => {
  for (const c of CASES) {
    test(`${c.name}: surviving rows are byte-identical to the unfiltered ones`, async () => {
      const S = makeSandbox(c.api);
      if (c.state) S.setProgramState(c.state);
      await c.run(S);

      const before = rows(S.html());
      assert.equal(before.length, c.total, 'panel did not render the expected rows');
      assert.ok(before.every((r) => /data-file_location="[^"]+"/.test(r)),
        'panel drew a file row with no path');

      const after = rows(S.filter(c.needle));
      assert.equal(after.length, c.kept, 'filter matched the wrong number of rows');
      for (const row of after) {
        assert.ok(before.includes(row),
          `filtered row differs from the row the panel drew:\n${row}`);
      }
    });
  }
});

describe('runLocalSearch — data-file_location', () => {
  test('album view keeps the real filepath instead of rebuilding it from the file explorer', async () => {
    const S = makeSandbox({ albumSongs: canned(ALBUM_SONGS) });
    // A leftover file-explorer position is exactly what the old fallback
    // (`getFileExplorerPath() + x.name`) reached for from inside an album.
    S.setFileExplorerArray(['music']);
    await S.getAlbumSongs('The Wall', 'Pink Floyd', '1979');

    assert.deepEqual(fileLocations(S.html()), [
      'music&#x2F;The Wall&#x2F;CD1&#x2F;01 In the Flesh.flac',
      'music&#x2F;The Wall&#x2F;CD1&#x2F;02 The Thin Ice.flac',
    ]);

    // Was: ['music&#x2F;In the Flesh?'] — a path that does not exist, so
    // clicking or queueing the row played nothing.
    assert.deepEqual(fileLocations(S.filter('flesh')),
      ['music&#x2F;The Wall&#x2F;CD1&#x2F;01 In the Flesh.flac']);
  });

  test('every filtered panel row points at a path the panel itself produced', async () => {
    for (const c of CASES) {
      const S = makeSandbox(c.api);
      if (c.state) S.setProgramState(c.state);
      await c.run(S);

      const before = new Set(fileLocations(S.html()));
      for (const loc of fileLocations(S.filter(c.needle))) {
        assert.ok(before.has(loc), `${c.name}: filter invented the path ${loc}`);
      }
    }
  });
});

describe('runLocalSearch — non-file panels', () => {
  test('genre rows stay genre rows instead of becoming playable file rows', async () => {
    const S = makeSandbox({
      genres: canned({ genres: [
        { name: 'Rock', track_count: 12 },
        { name: 'Jazz', track_count: 3 },
      ] }),
    });
    await S.getAllGenres();

    const before = rows(S.html());
    assert.equal(before.length, 2);

    const after = rows(S.filter('jazz'));
    assert.equal(after.length, 1);
    assert.ok(after[0].includes('data-genre="Jazz"'));
    assert.ok(!after[0].includes('data-file_location'),
      'genre was re-rendered as a file row — clicking it would try to play the genre name');
    assert.ok(before.includes(after[0]));
  });

  test('album cards keep the year that getAlbumsOnClick reads back', async () => {
    const S = makeSandbox({
      albums: canned({ albums: [
        { name: 'The Wall', album_art_file: 'wall.jpg', year: 1979 },
        { name: 'Animals', album_art_file: 'animals.jpg', year: 1977 },
      ] }),
    });
    await S.getAllAlbums();

    const before = rows(S.html());
    assert.equal(before.length, 2);

    const after = rows(S.filter('wall'));
    assert.equal(after.length, 1);
    // Dropping data-year sends getAlbumSongs(album, artist, undefined),
    // which can resolve to a different album of the same name.
    assert.ok(after[0].includes('data-year="1979"'), 'album year lost on filter');
    assert.ok(before.includes(after[0]));
  });

  test('artist albums keep their year too', async () => {
    const S = makeSandbox({
      artistAlbums: canned({ albums: [
        { name: 'The Wall', album_art_file: 'wall.jpg', year: 1979 },
        { name: 'Animals', album_art_file: 'animals.jpg', year: 1977 },
      ] }),
    });
    S.setProgramState([{ state: 'artist', name: 'Pink Floyd' }]);
    await S.getArtistsAlbums('Pink Floyd');

    const after = rows(S.filter('animals'));
    assert.equal(after.length, 1);
    assert.ok(after[0].includes('data-year="1977"'));
  });
});
