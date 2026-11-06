/**
 * Instant Mix in the webapp: the pure half (webapp/alpha/instant-mix.js,
 * window.INSTANTMIX) on node, and the mix page in m.js (instantMix*) in a
 * sandbox of its real functions; the server half is POST
 * /api/v1/discovery/local/mix (src/api/discovery-mix.js).
 *
 * What is pinned:
 *   - the body: one `from` per seed kind (a song without its leading slash,
 *     an album's identity with a numeric year, never the singles bucket),
 *     limit 50, and every filter key only when it filters —
 *     allowUnknownDuration only beside a bound, moods only where the ping
 *     says the server takes them (and their threshold only when not
 *     Standard), tempo and key only for a song with a BPM / a key (Dolo's
 *     windows, its 3A wheel), the app's folder choice joined by the pills
 *     the page turned off, never to no library at all — and every body one
 *     the route's own strict schema takes;
 *   - active() counts only the page's own filters that would be sent; a word
 *     or genre added as Auto DJ adds them (addName); every view state, and
 *     which answers the page keeps (never a "yet"); the default name ("Dolo
 *     Mix", "Dolo Mix 2", "Téranga Mix"); a seeded shuffle; one cache key
 *     per body;
 *   - the ways in — the ▾ menu's Instant Mix, the queue ⋮'s, the bar's ✦ on
 *     album, artist and playlist pages with rows — only while the server can
 *     mix (discovery, discoveryReady, instantMix ≥ 1) and never on a
 *     connected server; the ▾ reads "More";
 *   - the page: its chrome, its header (verbs and funnel hidden until an
 *     answer shows them), each state's one line, a filter change asked again
 *     (debounced, dimmed, a newer ask wins, a change undone asks nothing,
 *     answers kept by body), a late answer never drawn, the mood echo; Play,
 *     Shuffle, Queue all and Save (a seed already playing plays on), a new
 *     playlist name joining the lists;
 *   - Back: to an album, to the explorer (its folder kept), to a playlist,
 *     to a view that keeps no stack (changeView again), to an earlier mix;
 *   - MSTREAMPLAYER.trimToCurrent keeps the playing row and adds no Auto DJ
 *     pick; api.js's call, spa.js's changeView, index.html and en.json.
 *
 * Same technique as webapp-mood-filters.test.mjs: the real functions are
 * sliced out of m.js (the player's out of mstream.player.js, changeView out
 * of spa.js) and run against stub globals.
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
const PLAYER = read('webapp', 'assets', 'js', 'mstream.player.js');
const SPA = read('webapp', 'alpha', 'spa.js');
const API = read('webapp', 'alpha', 'api.js');
const HTML = read('webapp', 'index.html');
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

// ── fixtures: the demo library's real rows (the design boards' songs) ───
const DOLO = { filepath: 'demo/Boukmanflow/Dolo.mp3', metadata: { title: 'Dolo', artist: 'Boukmanflow', album: 'Stim Pack Volume one', year: 2019, bpm: 87, 'musical-key': 'Bb minor', duration: 100, 'album-art': 'dolo.jpeg' } };
const ELEVATION = { filepath: 'demo/ALM/Free Instrumentals Vol.2 - Old School Session/Elevation.mp3', metadata: { title: 'Elevation', artist: 'ALM', album: 'Free Instrumentals Vol.2 - Old School Session', 'album-art': 'alm2.jpeg' } };
const SWING = { filepath: 'demo/ALM/Swing.mp3', metadata: { title: 'Swing', artist: 'ALM', album: null } };
const TERANGA = { filepath: 'demo/ALM/Free Instrumental Vol.3/Téranga.mp3', metadata: { title: 'Téranga', artist: 'ALM', album: 'Free Instrumental Vol.3' } };
const answer = (songs, extra = {}) => ({
  model: { id: 'effnet-discogs', version: '1' }, seed: { kind: 'song', members: 1, analyzed: 1 }, notAnalyzed: false,
  songs: songs.map((s, i) => ({ ...s, similarity: i === 0 ? 1 : 0.8, genreTags: [] })),
  short: false, capped: false, relaxed: [], floor: 0.2, filteredOut: false, moods: {}, ...extra,
});
const DOLO_SEED = { kind: 'song', filepath: 'demo/Boukmanflow/Dolo.mp3', bpm: 87, key: 'Bb minor' };
const DOLO_HEAD = { kind: 'song', title: 'Dolo', sub: 'Boukmanflow', art: 'dolo.jpeg' };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) { await tick(); } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ── the pure half ────────────────────────────────────────────────────────
const f = (over = {}) => ({ ...M.emptyFilters(), ...over });
const ctx = (over = {}) => ({ dj: AUTODJ, moodFilters: true, moods: null, ignoreVPaths: [], vpaths: ['demo'], ...over });
const keysOf = (body) => Object.keys(body).filter((k) => k !== 'from' && k !== 'limit').sort();

describe('INSTANTMIX: the body', () => {
  test('one `from` per seed kind and limit 50 — nothing else while no filter is set', () => {
    assert.equal(M.LIMIT, 50);
    assert.deepEqual(M.requestBody({ kind: 'song', filepath: '/demo/Boukmanflow/Dolo.mp3' }, f(), ctx()),
      { from: { song: 'demo/Boukmanflow/Dolo.mp3' }, limit: 50 }, 'the leading slash goes');
    assert.deepEqual(M.requestBody({ kind: 'album', album: 'Stim Pack Volume one', artist: null, albumArtist: 'Boukmanflow', year: '2019' }, f(), ctx()),
      { from: { album: { album: 'Stim Pack Volume one', album_artist: 'Boukmanflow', year: 2019 } }, limit: 50 }, "a card's year is a number on the wire");
    assert.deepEqual(M.requestBody({ kind: 'album', album: 'Greatest Hits', artist: 'ALM', albumArtist: null, year: null }, f(), ctx()).from,
      { album: { album: 'Greatest Hits', artist: 'ALM' } }, 'nulls are left out');
    assert.deepEqual(M.requestBody({ kind: 'artist', artist: 'Boukmanflow' }, f(), ctx()), { from: { artist: 'Boukmanflow' }, limit: 50 });
    assert.deepEqual(M.requestBody({ kind: 'playlist', playlist: 'Road trip' }, f(), ctx()), { from: { playlist: 'Road trip' }, limit: 50 });
  });

  test('no seed, no body: the singles bucket, a blank path or name, an unknown kind', () => {
    const seeds = [{ kind: 'album', album: null, artist: 'ALM' }, { kind: 'album', album: '  ' }, { kind: 'song', filepath: '/' },
      { kind: 'song' }, { kind: 'artist', artist: '' }, { kind: 'playlist' }, { kind: 'genre', genre: 'Jazz' }, null];
    for (const seed of seeds) { assert.equal(M.requestBody(seed, f(), ctx()), null, JSON.stringify(seed)); }
  });

  test('each filter key only when it filters', () => {
    const song = DOLO_SEED;
    assert.deepEqual(keysOf(M.requestBody(song, f({ minRating: 7 }), ctx())), ['minRating']);
    assert.equal(M.requestBody(song, f({ minRating: 7 }), ctx()).minRating, 7);
    for (const r of [0, '', null, 11, 2.5, -1]) { assert.deepEqual(keysOf(M.requestBody(song, f({ minRating: r }), ctx())), [], `rating ${r}`); }
    const words = M.requestBody(song, f({ words: [' live ', 'Live', 'acappella', '', 'x'.repeat(101)] }), ctx());
    assert.deepEqual(words.skipWords, ['live', 'acappella'], 'trimmed, once each whatever its case, within 100 characters');
    assert.deepEqual(keysOf(words), ['skipWords']);
    assert.equal(M.requestBody(song, f({ words: Array.from({ length: 60 }, (_, i) => `w${i}`) }), ctx()).skipWords.length, M.WORDS_MAX);
    const genres = M.requestBody(song, f({ genres: ['Jazz', 'jazz', 'Hip Hop'], genreMode: 'blacklist' }), ctx());
    assert.deepEqual([genres.genres, genres.genreMode], [['Jazz', 'Hip Hop'], 'blacklist']);
    assert.equal(M.requestBody(song, f({ genres: ['Jazz'], genreMode: 'nonsense' }), ctx()).genreMode, 'whitelist');
    assert.deepEqual(keysOf(M.requestBody(song, f({ genreMode: 'blacklist' }), ctx())), [], 'the mode alone filters nothing');
    assert.equal(M.requestBody(song, f({ genres: Array.from({ length: 210 }, (_, i) => `g${i}`) }), ctx()).genres.length, M.GENRES_MAX);
    assert.deepEqual(keysOf(M.requestBody(song, f({ bpm: false, bpmTolerance: 3, harmonic: false })), ctx()), [], 'tempo and key off');
  });

  test('allowUnknownDuration only beside a bound; seconds, capped; a backwards window repaired the way Auto DJ does', () => {
    assert.deepEqual(keysOf(M.requestBody(DOLO_SEED, f({ allowUnknownDuration: true }), ctx())), [], 'no bound: nothing');
    const min = M.requestBody(DOLO_SEED, f({ minDuration: 120, allowUnknownDuration: true }), ctx());
    assert.deepEqual([min.minDuration, min.maxDuration, min.allowUnknownDuration], [120, undefined, true]);
    const max = M.requestBody(DOLO_SEED, f({ maxDuration: 300 }), ctx());
    assert.deepEqual([max.minDuration, max.maxDuration, max.allowUnknownDuration], [undefined, 300, false]);
    const back = M.requestBody(DOLO_SEED, f({ minDuration: 600, maxDuration: 60 }), ctx());
    assert.deepEqual([back.minDuration, back.maxDuration], [600, 600], 'the minimum kept (AUTODJ.setDurationBounds)');
    assert.equal(M.requestBody(DOLO_SEED, f({ maxDuration: 999999 }), ctx()).maxDuration, M.DURATION_MAX);
    assert.equal(M.requestBody(DOLO_SEED, f({ minDuration: 90.4 }), ctx()).minDuration, 90);
  });

  test('moods only where the ping says the server takes them, and only with a group set', () => {
    const relaxed = { energy: 'relaxed', threshold: 0.7 };
    assert.deepEqual(M.requestBody(DOLO_SEED, f(), ctx({ moods: relaxed })).moods, relaxed);
    assert.equal('moods' in M.requestBody(DOLO_SEED, f(), ctx({ moods: relaxed, moodFilters: false })), false, 'a strict schema elsewhere');
    assert.equal('moods' in M.requestBody(DOLO_SEED, f(), ctx({ moods: { threshold: 0.7 } })), false, 'a threshold alone raises no bar');
    assert.deepEqual(M.requestBody(DOLO_SEED, f(), ctx({ moods: { tags: ['party'] } })).moods, { tags: ['party'] });
  });

  test("tempo and key only for a song seed with a BPM / a key: Dolo's windows and its 3A wheel", () => {
    const body = M.requestBody(DOLO_SEED, f({ bpm: true, harmonic: true }), ctx());
    assert.deepEqual(body.bpmRanges, [{ min: 79, max: 95 }, { min: 40, max: 48 }, { min: 158, max: 190 }]);
    assert.deepEqual(body.bpmRanges, AUTODJ.buildBpmRanges(87, M.BPM_TOLERANCE), "Auto DJ's own windows");
    assert.deepEqual(body.musicalKeys, ['3A', '3B', '2A', '2B', '4A', '4B'], 'Bb minor = 3A, and its neighbours');
    assert.equal(body.requireMusicalKey, true);
    assert.equal('bpmRangesWide' in body, false, 'tempo is hard on a mix: no waterfall key');
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ bpm: true, bpmTolerance: 4 }), ctx()).bpmRanges, AUTODJ.buildBpmRanges(87, 4));
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ bpm: true, bpmTolerance: 99 }), ctx()).bpmRanges, AUTODJ.buildBpmRanges(87, 20), 'the slider tops at 20');
    const bare = { kind: 'song', filepath: 'demo/x.mp3', bpm: null, key: null };
    assert.deepEqual(keysOf(M.requestBody(bare, f({ bpm: true, harmonic: true }), ctx())), [], 'no BPM, no key: neither');
    assert.deepEqual(keysOf(M.requestBody({ ...DOLO_SEED, key: 'H major' }, f({ harmonic: true }), ctx())), [], 'a key with no Camelot code');
    for (const seed of [{ kind: 'album', album: 'Stim Pack Volume one', bpm: 87, key: 'Bb minor' }, { kind: 'artist', artist: 'Boukmanflow' }, { kind: 'playlist', playlist: 'Road trip' }]) {
      assert.deepEqual(keysOf(M.requestBody(seed, f({ bpm: true, harmonic: true }), ctx())), [], `${seed.kind}: no single tempo or key`);
    }
    assert.deepEqual(keysOf(M.requestBody(DOLO_SEED, f({ bpm: true, harmonic: true }), ctx({ dj: null }))), [], "without Auto DJ's helpers");
  });

  test("the app's folder choice, joined by the pills the page turned off — never down to no library", () => {
    const libs = ctx({ vpaths: ['music', 'podcasts', 'audiobooks'], ignoreVPaths: ['podcasts'] });
    assert.deepEqual(M.requestBody(DOLO_SEED, f(), libs).ignoreVPaths, ['podcasts'], 'the folder choice alone');
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ vpathsOff: ['audiobooks'] }), libs).ignoreVPaths, ['podcasts', 'audiobooks']);
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ vpathsOff: ['podcasts'] }), libs).ignoreVPaths, ['podcasts'], 'once');
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ vpathsOff: ['music', 'audiobooks'] }), libs).ignoreVPaths, ['podcasts'], 'the pills would leave none: dropped');
    assert.deepEqual(M.requestBody(DOLO_SEED, f({ vpathsOff: ['gone'] }), libs).ignoreVPaths, ['podcasts'], 'an unknown library is no pill');
    assert.equal('ignoreVPaths' in M.requestBody(DOLO_SEED, f(), ctx()), false, 'nothing hidden: nothing sent');
  });

  test("every body is one the route takes (src/api/discovery-mix.js's strict schema): each seed kind, no filter and every filter", async () => {
    const { mixSchema } = await import('../../src/api/discovery-mix.js');
    const { parseMoods } = await import('../../src/api/mood-filter.js');
    const every = f({ vpathsOff: ['podcasts'], minRating: 7, bpm: true, bpmTolerance: 20, harmonic: true, words: Array.from({ length: 60 }, (_, i) => `w${i}`),
      genres: Array.from({ length: 210 }, (_, i) => `g${i}`), genreMode: 'blacklist', minDuration: 90000, maxDuration: 60, allowUnknownDuration: true });
    const all = ctx({ moods: { valence: 'happy', energy: 'aggressive', voice: 'vocals', tags: ['acoustic', 'party', 'danceable'], threshold: 0.7 },
      ignoreVPaths: ['old'], vpaths: ['demo', 'podcasts', 'old'] });
    assert.deepEqual(keysOf(M.requestBody(DOLO_SEED, every, all)), ['allowUnknownDuration', 'bpmRanges', 'genreMode', 'genres', 'ignoreVPaths', 'maxDuration',
      'minDuration', 'minRating', 'moods', 'musicalKeys', 'requireMusicalKey', 'skipWords'], 'every filter on the wire');
    const seeds = [DOLO_SEED, { kind: 'song', filepath: 'demo/x.mp3', bpm: 299.6, key: '12B' },
      { kind: 'album', album: 'Stim Pack Volume one', artist: 'Boukmanflow', albumArtist: 'Boukmanflow', year: '2019' },
      { kind: 'album', album: 'Greatest Hits', artist: '', albumArtist: '', year: null }, { kind: 'artist', artist: 'Boukmanflow' }, { kind: 'playlist', playlist: 'Road trip' }];
    for (const seed of seeds) {
      for (const [filters, c] of [[f(), ctx()], [every, all]]) {
        const body = M.requestBody(seed, filters, c);
        const { error } = mixSchema.validate(body);
        assert.equal(error, undefined, `${seed.kind}: ${error && error.message}`);
        if (body.moods) { assert.doesNotThrow(() => parseMoods(body.moods), 'its mood filter parses'); }
      }
    }
  });
});

describe('INSTANTMIX: what is set, the states, the name, the shuffle, the key', () => {
  test("active() counts the page's own filters that would be sent — never the app's folder choice", () => {
    const c = (over) => ctx({ seed: DOLO_SEED, ...over });
    assert.equal(M.active(f(), null, c({ ignoreVPaths: ['podcasts'], vpaths: ['demo', 'podcasts'] })), 0);
    assert.equal(M.active(f({ minRating: 6 }), null, c()), 1);
    assert.equal(M.active(f({ minRating: 6, words: ['live'], genres: ['Jazz'], minDuration: 60, bpm: true, harmonic: true }), { energy: 'relaxed' }, c()), 7);
    assert.equal(M.active(f(), { energy: 'relaxed' }, c({ moodFilters: false })), 0, 'a mood the server cannot apply');
    assert.equal(M.active(f({ bpm: true, harmonic: true }), null, c({ seed: { kind: 'album', album: 'Stim Pack Volume one' } })), 0, 'no tempo or key off a song');
    assert.equal(M.active(f({ vpathsOff: ['podcasts'] }), null, c({ vpaths: ['demo', 'podcasts'] })), 1);
    assert.equal(M.active(f({ vpathsOff: ['demo'] }), null, c({ vpaths: ['demo'] })), 0, 'pills that would leave none');
    assert.equal(M.active(f({ genreMode: 'blacklist', bpmTolerance: 3, allowUnknownDuration: true }), null, c()), 0, 'settings that filter nothing alone');
  });

  test("addName: a word or a genre added as Auto DJ adds them — trimmed, once whatever its case, capped — and within the route's length", () => {
    assert.deepEqual(M.addName(['live'], '  Remix ', 'word'), ['live', 'Remix']);
    assert.deepEqual(M.addName([], 'Hip Hop', 'genre'), ['Hip Hop']);
    for (const [list, raw, kind, why] of [
      [['live'], 'LIVE', 'word', 'there already, whatever its case'],
      [[], '   ', 'word', 'blank'],
      [[], null, 'genre', 'not a string'],
      [[], 'x'.repeat(101), 'word', 'over 100 characters'],
      [Array.from({ length: M.WORDS_MAX }, (_, i) => `w${i}`), 'one more', 'word', 'the list full'],
      [Array.from({ length: M.GENRES_MAX }, (_, i) => `g${i}`), 'Jazz', 'genre', 'the list full'],
    ]) {
      assert.equal(M.addName(list, raw, kind), null, why);
    }
    assert.deepEqual(M.addName([], 'x'.repeat(200), 'genre'), ['x'.repeat(200)], 'a genre may be 200 long');
    const list = ['a'];
    M.addName(list, 'b', 'word');
    assert.deepEqual(list, ['a'], 'a new list, the old one untouched');
  });

  test('every view state', () => {
    const song = { kind: 'song', active: 0, seedPath: '/demo/Boukmanflow/Dolo.mp3' };
    assert.equal(M.viewState(undefined, song), 'loading');
    assert.equal(M.viewState({ disabled: true }, song), 'off');
    assert.equal(M.viewState(null, song), 'failed');
    assert.equal(M.viewState({ error: 'x' }, song), 'failed', 'no songs list');
    assert.equal(M.viewState(answer([], { notAnalyzed: true }), song), 'notAnalyzed');
    assert.equal(M.viewState(answer([DOLO, ELEVATION]), song), 'ready');
    assert.equal(M.viewState(answer([DOLO]), song), 'nothingSimilar', 'only the seed (its path, slash or not)');
    assert.equal(M.viewState(answer([]), song), 'nothingSimilar');
    assert.equal(M.viewState(answer([DOLO], { filteredOut: true }), { ...song, active: 2 }), 'noMatch');
    assert.equal(M.viewState(answer([DOLO], { filteredOut: true }), song), 'nothingSimilar', 'no filter of the page did it');
    const album = { kind: 'album', active: 1 };
    assert.equal(M.viewState(answer([DOLO]), album), 'ready', "an album's mix has no seed row to discount");
    assert.equal(M.viewState(answer([], { filteredOut: true }), album), 'noMatch');
  });

  test('the answers the page keeps: rows, or a list the filters emptied — never a "yet" (not analysed, nothing similar), nor a failure', () => {
    const song = { kind: 'song', seedPath: '/demo/Boukmanflow/Dolo.mp3' };
    assert.equal(M.keeps(answer([DOLO, ELEVATION]), song), true);
    assert.equal(M.keeps(answer([DOLO], { filteredOut: true }), song), true, 'the filters did it, whichever set them');
    assert.equal(M.keeps(answer([], { notAnalyzed: true }), song), false);
    assert.equal(M.keeps(answer([DOLO]), song), false, 'nothing similar yet: the seed alone');
    assert.equal(M.keeps(answer([]), { kind: 'album' }), false);
    assert.equal(M.keeps(answer([DOLO]), { kind: 'album' }), true);
    for (const res of [undefined, null, { disabled: true }, { error: 'x' }]) { assert.equal(M.keeps(res, song), false, JSON.stringify(res)); }
  });

  test('the default name: "‹title› Mix", then 2, 3 … while taken (exactly); accents and symbols kept', () => {
    const fmt = (name) => `${name} Mix`;
    assert.equal(M.defaultName('Dolo', [], fmt), 'Dolo Mix');
    assert.equal(M.defaultName('Dolo', [{ name: 'Dolo Mix', type: 'playlist' }], fmt), 'Dolo Mix 2');
    assert.equal(M.defaultName('Dolo', ['Dolo Mix', 'Dolo Mix 2'], fmt), 'Dolo Mix 3');
    assert.equal(M.defaultName('Dolo', ['dolo mix'], fmt), 'Dolo Mix', 'an exact compare');
    assert.equal(M.defaultName('Téranga', [], fmt), 'Téranga Mix');
    assert.equal(M.defaultName('AC/DC & co', [], fmt), 'AC/DC & co Mix');
    assert.equal(M.defaultName('Stim Pack Volume one', []), 'Stim Pack Volume one Mix', 'English without a format');
  });

  test('a seeded shuffle: a copy, every row once, the same order for the same source', () => {
    const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'];
    const one = M.shuffle(rows, seeded(42));
    assert.deepEqual(one, M.shuffle(rows, seeded(42)));
    assert.deepEqual([...one].sort(), rows);
    assert.notDeepEqual(one, rows);
    assert.deepEqual(rows, ['a', 'b', 'c', 'd', 'e', 'f'], 'the list itself untouched');
    assert.deepEqual([...M.shuffle(rows, () => 0.9999999)].sort(), rows, 'a source at its top stays in range');
  });

  test('one cache key per body, whatever order its keys were built in; fresh filters every time', () => {
    const a = M.requestBody(DOLO_SEED, f({ minRating: 6, words: ['live'] }), ctx());
    const b = { skipWords: ['live'], limit: 50, minRating: 6, from: { song: 'demo/Boukmanflow/Dolo.mp3' } };
    assert.equal(M.cacheKey(a), M.cacheKey(b));
    assert.notEqual(M.cacheKey(a), M.cacheKey(M.requestBody(DOLO_SEED, f({ minRating: 7, words: ['live'] }), ctx())));
    const one = M.emptyFilters();
    one.words.push('live');
    assert.deepEqual(M.emptyFilters().words, [], 'no shared lists');
    assert.equal(M.CACHE_MAX, 8);
  });
});

// ── the mix page, in m.js ────────────────────────────────────────────────
function sliceFn(src, name, end = '}') {
  const lines = src.split('\n');
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `no ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === end) { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of ${name}()`);
}

function sliceConst(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  if (lines[start].endsWith('};') || lines[start].endsWith("';")) { return lines[start]; }
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') { return lines.slice(start, i + 1).join('\n'); }
  }
  throw new Error(`could not find the end of const ${name}`);
}

// A just-enough DOM. An element's innerHTML start tags become its
// descendants — flat, in document order — for getElementById,
// querySelector(All) and closest (the element itself, when it matches).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '=' };
const decode = (v) => String(v).replace(/&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g, (e) => ENTITIES[e]);
function attrsOf(raw) {
  const out = {};
  for (const m of raw.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) { out[m[1]] = decode(m[2] ?? ''); }
  return out;
}
function matches(el, sel) {
  const parts = sel.trim().match(/^[a-z]+|[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
  return parts.length > 0 && parts.every((p) => {
    if (p[0] === '.') { return el.classList.contains(p.slice(1)); }
    if (p[0] === '#') { return el.getAttribute('id') === p.slice(1); }
    if (p[0] === '[') {
      const [, n, v] = p.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return v === undefined ? el.hasAttribute(n) : el.getAttribute(n) === v;
    }
    return el.tag === p;
  });
}
function makeEl(tag, attrs = {}) {
  const el = {
    tag, attrs: new Map(Object.entries(attrs)), kids: [], html: '', listeners: [], focused: 0, scrollTop: 0, value: '', style: {},
    getAttribute: (n) => (el.attrs.has(n) ? el.attrs.get(n) : null),
    setAttribute: (n, v) => { el.attrs.set(n, String(v)); },
    removeAttribute: (n) => { el.attrs.delete(n); },
    hasAttribute: (n) => el.attrs.has(n),
    focus: () => { el.focused++; },
    closest: (sel) => (sel.split(',').some((s) => matches(el, s)) ? el : null),
    querySelectorAll: (sel) => el.kids.filter((k) => sel.split(',').some((s) => matches(k, s))),
    querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
    addEventListener: (type, fn, opts) => { el.listeners.push({ type, fn, signal: opts && opts.signal }); },
    fire: (type, target) => { for (const l of el.listeners) { if (l.type === type && !(l.signal && l.signal.aborted)) { l.fn({ type, target }); } } },
    live: (type) => el.listeners.filter((l) => l.type === type && !(l.signal && l.signal.aborted)).length,
  };
  const classes = () => new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
  const write = (set) => el.setAttribute('class', [...set].join(' '));
  el.classList = {
    contains: (c) => classes().has(c),
    add: (c) => { const s = classes(); s.add(c); write(s); },
    remove: (c) => { const s = classes(); s.delete(c); write(s); },
    toggle: (c, on) => { const s = classes(); const want = on === undefined ? !s.has(c) : !!on; if (want) { s.add(c); } else { s.delete(c); } write(s); return want; },
  };
  for (const decl of (el.getAttribute('style') || '').split(';')) {
    const [k, v] = decl.split(':');
    if (k && v !== undefined) { el.style[k.trim()] = v.trim(); }
  }
  Object.defineProperty(el, 'innerHTML', {
    get: () => el.html,
    set: (h) => {
      el.html = String(h);
      el.kids = [...el.html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)].map((m) => makeEl(m[1].toLowerCase(), attrsOf(m[2])));
    },
  });
  return el;
}
const IDS = ['filelist', 'browse-head', 'directory_bar', 'directoryName', 'localSearchBar', 'local_search_btn', 'search_folders', 'mkdir_btn',
  'upload_btn', 'add_all_btn', 'instant_mix_btn', 'genre_source', 'pop-f', 'live-playlist-select', 'save_playlist_name', 'playlist_name',
  'dpage-head', 'mood_filter_btn', 'mood_filters', 'pop-d-mix'];
function makeDoc() {
  const els = new Map(IDS.map((id) => [id, makeEl('div', { id })]));
  const find = (id) => {
    for (const host of els.values()) {
      const kid = host.kids.find((k) => k.getAttribute('id') === id);
      if (kid) { return kid; }
    }
    return els.get(id) || null;
  };
  return {
    els,
    getElementById: find,
    getElementsByClassName: () => [],
    // '#host .descendant' — the page's own lookups; anything else finds nothing
    querySelector: (sel) => {
      const m = sel.match(/^#([\w-]+) (.+)$/);
      return m && els.has(m[1]) ? els.get(m[1]).querySelector(m[2]) : null;
    },
    querySelectorAll: () => [],
  };
}

const tEn = (k, p) => {
  let s = typeof EN[k] === 'string' ? EN[k] : k;
  for (const [n, v] of Object.entries(p || {})) { s = s.split(`{{${n}}}`).join(String(v)); }
  return s;
};

const MIX_FNS = [...SRC.matchAll(/^(?:async )?function ((?:instantMix|onInstantMix)\w*)\(/gm)].map((m) => m[1]);
const FNS = ['escapeHtml', 'peerAttr', 'peerOf', 'browseApi', 'localIgnoreVPaths', 'artUrl', 'artImgAttr', 'albumCredit', 'albumSongsBody',
  'browsingListMetadata', 'moodLevel', 'moodFilterBody', 'moodPanelHtml', 'moodSortHtml', 'ratingOptionsHtml', 'filterChipsHtml', 'genreSuggestHtml',
  'hideMoodFilters', 'discoveryHideHead', 'discoverySkelHtml', 'discoveryArtHtml',
  'browseHeadTile', 'popFHeadHtml', 'popFPlaylistHtml', 'createPopper3', 'createMusicFileHtml', 'renderFileWithMetadataHtml', 'renderSearchRow',
  'renderDiscoverDownloadRow', 'setBrowserRootPanel', 'getAlbumSongs', 'getArtistsAlbums', 'onPlaylistClick', 'onBackButton',
  'openSavePlaylistModal', 'savePlaylistFromModal', ...MIX_FNS];

const NAV = makeEl('div', { class: 'side-nav-item', 'data-panel': 'allAlbums' });
const viewFn = () => {};

// One stubbed app around the sliced functions. `respond(body)` answers the
// mix route (a value or a promise); calls are recorded.
function makeSandbox({ server = {}, playlist = [], position = -1, playing = false, playlists = [], peer = null } = {}) {
  const doc = makeDoc();
  for (const id of ['instant_mix_btn', 'search_folders', 'browse-head', 'dpage-head', 'mood_filter_btn', 'mood_filters']) { doc.els.get(id).classList.add('super-hide'); }
  doc.els.get('pop-d-mix').style.display = 'none';
  const calls = { asked: [], lookups: [], queued: [], cleared: 0, trimmed: 0, toasts: [], modal: [], saved: [], loaded: [], albumSongs: [], artistAlbums: [], views: [], panels: [], senddir: [], popper: [], failures: [] };
  const timers = [];
  const box = { calls, doc, timers, respond: () => answer([DOLO, ELEVATION, SWING]), meta: {}, playlistSongs: [], albumSongs: [], artistAlbums: [] };
  const player = {
    ignoreVPaths: {},
    playlist,
    positionCache: { val: position },
    playerStats: { playing },
    clearPlaylist: () => { calls.cleared++; player.playlist.length = 0; player.positionCache.val = -1; },
    trimToCurrent: () => { calls.trimmed++; },
  };
  const api = {
    currentServer: { host: 'http://host/', token: 'TOK', vpaths: ['demo'], discovery: true, discoveryReady: true, instantMix: 1, moodFilters: true, ...server },
    instantMix: (body) => { calls.asked.push(body); return Promise.resolve(box.respond(body)); },
    getGenres: () => Promise.resolve({ status: 'ok', value: ['Hip Hop', 'Jazz'] }),
    lookupMetadata: (fp) => { calls.lookups.push(fp); return Promise.resolve({ filepath: fp, metadata: box.meta[fp] || null }); },
    loadPlaylist: (name) => { calls.loaded.push(name); return Promise.resolve(box.playlistSongs); },
    savePlaylist: (title, songs) => { calls.saved.push({ title, songs }); return Promise.resolve({}); },
    albumSongs: (body) => { calls.albumSongs.push(body); return Promise.resolve(box.albumSongs); },
    artistAlbums: (body) => { calls.artistAlbums.push(body); return Promise.resolve({ albums: box.artistAlbums }); },
    peer: {
      albumSongs: (id, body) => { calls.albumSongs.push({ peer: id, ...body }); return Promise.resolve(box.albumSongs); },
      artistAlbums: (id, body) => { calls.artistAlbums.push({ peer: id, ...body }); return Promise.resolve({ albums: box.artistAlbums }); },
    },
  };
  const vue = {
    playlists,
    altLayout: { compressArt: false },
    addSongWizard: (filepath, metadata, lookup, position, live, autoPlayOff) => { calls.queued.push({ filepath, lookup, position, live, autoPlayOff }); },
  };
  const panel = (name) => (...args) => { calls.panels.push([name, ...args]); return Promise.resolve(); };
  const globals = {
    document: doc,
    window: { matchMedia: () => ({ matches: false }) },
    t: tEn,
    MSTREAMAPI: api,
    MSTREAMPLAYER: player,
    VUEPLAYERCORE: vue,
    INSTANTMIX: M,
    AUTODJ,
    iziToast: { success: (o) => calls.toasts.push(o), info: (o) => calls.toasts.push(o), error: (o) => calls.toasts.push({ ...o, error: true }) },
    myModal: { open: (sel) => calls.modal.push(sel), close: () => calls.modal.push('close') },
    Popper: { createPopper: (ref, pop, opts) => { calls.popper.push(ref); if (opts && opts.onFirstUpdate) { opts.onFirstUpdate(); } return { destroy() {} }; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) { timers[id - 1].live = false; } },
    changeView: (fn, el) => { calls.views.push({ fn, el }); },
    loadFileExplorer: () => {},
    toggleThing: () => {},
    getAllPlaylists: panel('allPlaylists'),
    getAllAlbums: panel('allAlbums'),
    getAllArtists: panel('allArtists'),
    getAllGenres: panel('allGenres'),
    getGenreSongs: panel('genre'),
    setupSearchPanel: panel('searchPanel'),
    discoveryPanel: panel('discovery'),
    browseKeepReset: () => {},
    browseKeepDrawn: () => {},
    browseKeepBack: () => false,
    browseAlbumHead: () => {},
    browseArtistHead: () => {},
    keepGateFor: () => Promise.resolve(),
    keepGateOpen: () => false,
    browseKeepSongTab: () => '',
    browseKeepSongMark: () => '',
    browseKeepTabHtml: () => '',
    browseKeepKey: () => '',
    boilerplateFailure: (err) => { calls.failures.push(err); },
    getLoadingSvg: () => 'LOADING',
    renderAlbum: (name) => `<div class="album-grid-card" data-album="${name}"></div>`,
    discoverDownloadPluginTitle: (name) => name,
    discoverDownloadsAgo: () => '',
  };
  const body = `
    'use strict';
    let programState = [];
    let fileExplorerArray = [];
    let currentBrowsingList = [];
    let curFileTracker;
    let popFInstance;
    let peerContext = ${JSON.stringify(peer)};
    let browseGeneration = 0;
    let lastView = null;
    let savePlaylistModalPaths = null;
    const knownPeers = new Map();
    const discoveryView = { shown: { allTracks: [] }, flags: {} };
    async function senddir() { __calls.senddir.push(fileExplorerArray.slice()); }
    ${['entityMap', 'MOODS', 'DPAGE_ICONS', 'searchMap', 'MIX', 'MIX_PLAYLIST_TILE'].map(sliceConst).join('\n')}
    ${FNS.map((n) => sliceFn(SRC, n)).join('\n\n')}
    return {
      ${FNS.join(', ')}, MIX, MOODS, discoveryView,
      state: () => programState, setState: (s) => { programState = s; },
      dirs: () => fileExplorerArray, setDirs: (d) => { fileExplorerArray = d; },
      setList: (l) => { currentBrowsingList = l; },
      tracker: () => curFileTracker, setTracker: (v) => { curFileTracker = v; },
      setLastView: (v) => { lastView = v; },
      setPeer: (p) => { peerContext = p; },
    };
  `;
  const names = [...Object.keys(globals), '__calls'];
  box.S = new Function(...names, body)(...names.map((n) => (n === '__calls' ? calls : globals[n])));
  box.globals = globals;
  box.player = player;
  box.el = (id) => doc.getElementById(id);
  box.head = () => doc.els.get('browse-head');
  box.list = () => doc.els.get('filelist');
  box.liveTimers = () => timers.filter((tm) => tm.live);
  box.runTimers = () => { for (const tm of timers) { if (tm.live) { tm.live = false; tm.fn(); } } };
  box.headClick = (sel) => { const target = box.head().querySelector(sel); assert.ok(target, `the header has ${sel}`); box.head().fire('click', target); };
  box.listClick = (sel) => { const target = box.list().querySelector(sel); assert.ok(target, `the list has ${sel}`); box.list().fire('click', target); };
  box.hidden = (el) => el.classList.contains('super-hide');
  // A mix of Dolo over the Albums list.
  box.open = async (seed = DOLO_SEED, head = DOLO_HEAD, under = [{ state: 'allAlbums' }]) => {
    box.S.setState(under);
    box.S.setLastView({ fn: viewFn, el: NAV });
    await box.S.instantMixOpen(seed, head);
  };
  return box;
}

const rowsOf = (html) => [...html.matchAll(/<div class="discover-row dpage-row pointer" data-mx="queue" data-i="(\d+)">[\s\S]*?<div class="discover-row-title">([^<]*)<\/div><div class="discover-row-sub">([^<]*)<\/div>/g)]
  .map((m) => [decode(m[2]), decode(m[3])]);
const lineOf = (html) => { const m = html.match(/<div class="dpage-hint">([^<]*)/); return m ? decode(m[1]).trim() : null; };

describe('Instant Mix: the ways in', () => {
  test('the ▾ menu starts with Instant Mix, hidden, then the playlists\' header; a playlist row is escaped', () => {
    const { S } = makeSandbox();
    assert.equal(S.popFHeadHtml(), '<div class="pop-list-item" id="pop-f-mix" style="display:none" onclick="instantMixFromMenu()">Instant Mix</div><div class="pop-f pop-playlist">Add To Playlist:</div>');
    assert.match(S.popFPlaylistHtml('Road <trip>'), /data-playlist="Road &lt;trip&gt;"[^>]*>&#8226; Road &lt;trip&gt;<\/div>$/);
  });

  test('createPopper3 shows the menu\'s Instant Mix only while this server can mix right now', () => {
    const box = makeSandbox();
    box.el('pop-f').innerHTML = box.S.popFHeadHtml();
    const server = box.globals.MSTREAMAPI.currentServer;
    let n = 0;
    const open = () => { box.S.createPopper3(makeEl('span', { 'data-file_location': `demo/${n++}.mp3` })); return box.el('pop-f-mix').style.display; };
    assert.equal(open(), '', 'discovery, discoveryReady and instantMix ≥ 1');
    for (const [key, value] of [['discoveryReady', false], ['discoveryReady', undefined], ['instantMix', 0], ['discovery', false]]) {
      const was = server[key];
      server[key] = value;
      assert.equal(open(), 'none', `${key}: ${value}`);
      server[key] = was;
      assert.equal(open(), '', `${key} back`);
    }
    box.S.setPeer({ id: 2, name: 'B' });
    assert.equal(box.S.instantMixOn(), false, 'never while the app shows a connected server');
  });

  test('the menu\'s Instant Mix mixes the row it was opened on — let go, so that row\'s next ▾ opens the menu again', async () => {
    const box = makeSandbox();
    box.S.setList([{ type: 'file', path: DOLO.filepath, metadata: DOLO.metadata }]);
    box.S.setTracker(DOLO.filepath);
    box.S.setState([{ state: 'allAlbums' }]);
    await box.S.instantMixFromMenu();
    assert.equal(box.S.tracker(), undefined);
    assert.deepEqual(box.calls.lookups, [], 'the list on screen had its metadata');
    const top = box.S.state().at(-1);
    assert.deepEqual([top.state, top.seed, top.head], ['mix', DOLO_SEED, DOLO_HEAD]);
    assert.deepEqual(box.calls.asked[0].from, { song: 'demo/Boukmanflow/Dolo.mp3' });
  });

  test('a song known nowhere on screen is looked up once; without metadata its file name heads the page', async () => {
    const box = makeSandbox();
    box.meta['/demo/ALM/Swing.mp3'] = SWING.metadata;
    box.S.setTracker('/demo/ALM/Swing.mp3');
    await box.S.instantMixFromMenu();
    assert.deepEqual(box.calls.lookups, ['/demo/ALM/Swing.mp3']);
    assert.deepEqual(box.S.state().at(-1).head, { kind: 'song', title: 'Swing', sub: 'ALM', art: null });
    const bare = makeSandbox();
    bare.S.setTracker('demo/x/Untagged.flac');
    await bare.S.instantMixFromMenu();
    assert.equal(bare.S.state().at(-1).head.title, 'Untagged.flac');
    assert.deepEqual(bare.S.state().at(-1).seed, { kind: 'song', filepath: 'demo/x/Untagged.flac', bpm: null, key: null });
  });

  test('the queue ⋮: Instant Mix for the row\'s song when it is this server\'s and the server can mix', async () => {
    const local = { rawFilePath: '/demo/Boukmanflow/Dolo.mp3', filepath: 'demo/Boukmanflow/Dolo.mp3', metadata: DOLO.metadata };
    const fed = { rawFilePath: 'tunes/x.mp3', metadata: { title: 'X' }, federation: { peerId: 2 } };
    // a press on row i's ⋮, as the queue draws it (its header row first)
    const press = (box, i) => {
      const rows = [makeEl('div', { class: 'np-queue-item' }), makeEl('div', { class: 'np-queue-item' })];
      const parent = { children: [makeEl('div', { class: 'np-queue-head' }), ...rows] };
      for (const r of rows) { r.parentElement = parent; }
      const more = { closest: (sel) => (sel === '.np-queue-item' ? rows[i] : null) };
      box.S.instantMixQueueCapture({ target: { closest: (sel) => (sel === '.np-queue-item .popperMenu' ? more : null) } });
    };
    const box = makeSandbox({ playlist: [fed, local] });
    press(box, 0);
    assert.equal(box.el('pop-d-mix').style.display, 'none', "a connected server's song");
    press(box, 1);
    assert.equal(box.el('pop-d-mix').style.display, '');
    assert.equal(box.S.MIX.queued, local);
    box.S.instantMixQueueCapture({ target: { closest: () => null } });
    assert.equal(box.S.MIX.queued, local, 'a press elsewhere changes nothing');
    await box.S.instantMixFromQueue();
    assert.equal(box.S.MIX.queued, null);
    assert.deepEqual(box.calls.lookups, [], "the queue song's own metadata");
    assert.deepEqual(box.S.state().at(-1).seed, DOLO_SEED);
    const off = makeSandbox({ playlist: [fed, local], server: { instantMix: 0 } });
    press(off, 1);
    assert.equal(off.el('pop-d-mix').style.display, 'none', 'a server without the route');
    assert.equal(off.S.MIX.queued, null);
  });

  test('the bar\'s ✦: an album page of this server\'s with songs — its identity, its credit, a cover; never the singles card, an empty album, a connected server\'s', async () => {
    const box = makeSandbox();
    box.albumSongs = [{ filepath: 'demo/Boukmanflow/TopRanking.mp3', metadata: { title: 'TopRanking', artist: 'Boukmanflow' } }, DOLO];
    await box.S.getAlbumSongs('Stim Pack Volume one', null, '2019', 'Boukmanflow');
    assert.equal(box.hidden(box.el('instant_mix_btn')), false);
    assert.deepEqual(box.S.MIX.bar, {
      seed: { kind: 'album', album: 'Stim Pack Volume one', artist: null, albumArtist: 'Boukmanflow', year: '2019' },
      head: { kind: 'album', title: 'Stim Pack Volume one', sub: 'Boukmanflow', art: 'dolo.jpeg' },
    });
    await box.S.instantMixFromBar();
    assert.deepEqual(box.calls.asked.at(-1).from, { album: { album: 'Stim Pack Volume one', album_artist: 'Boukmanflow', year: 2019 } });
    for (const [why, album, songs, peer] of [['the singles card', null, [DOLO], null], ['no songs', 'Empty', [], null], ['a connected server', 'Stim Pack Volume one', [DOLO], { id: 2, name: 'B' }]]) {
      const b = makeSandbox({ peer });
      b.albumSongs = songs;
      await b.S.getAlbumSongs(album, 'Boukmanflow', null, null);
      assert.ok(b.hidden(b.el('instant_mix_btn')), why);
    }
  });

  test('the ✦ on an artist page and on a playlist with songs; every other page hides it', async () => {
    const box = makeSandbox();
    box.artistAlbums = [{ name: 'Stim Pack Volume one', year: 2019, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'] }];
    await box.S.getArtistsAlbums('Boukmanflow');
    assert.deepEqual(box.S.MIX.bar, { seed: { kind: 'artist', artist: 'Boukmanflow' }, head: { kind: 'artist', title: 'Boukmanflow' } });
    assert.equal(box.hidden(box.el('instant_mix_btn')), false);
    box.S.setBrowserRootPanel('Albums');
    assert.ok(box.hidden(box.el('instant_mix_btn')));
    box.playlistSongs = [{ filepath: DOLO.filepath, metadata: DOLO.metadata, lokiId: 1 }];
    await box.S.onPlaylistClick(makeEl('span', { 'data-playlistname': encodeURIComponent('Road trip') }));
    assert.deepEqual(box.S.MIX.bar, { seed: { kind: 'playlist', playlist: 'Road trip' }, head: { kind: 'playlist', title: 'Road trip' } });
    box.playlistSongs = [];
    await box.S.onPlaylistClick(makeEl('span', { 'data-playlistname': 'Empty' }));
    assert.ok(box.hidden(box.el('instant_mix_btn')), 'a playlist that drew no rows');
    const off = makeSandbox({ server: { discoveryReady: false } });
    off.artistAlbums = box.artistAlbums;
    await off.S.getArtistsAlbums('Boukmanflow');
    assert.ok(off.hidden(off.el('instant_mix_btn')));
  });

  test('a failed playlist load says so, with the error it got', async () => {
    const box = makeSandbox();
    box.globals.MSTREAMAPI.loadPlaylist = () => Promise.reject(new Error('offline'));
    await box.S.onPlaylistClick(makeEl('span', { 'data-playlistname': 'Road%20trip' }));
    assert.equal(box.list().innerHTML, `<div>${tEn('error.serverCallFailed')}</div>`);
    assert.equal(box.calls.failures[0].message, 'offline');
  });

  test('the ▾ reads "More" on browse, search and Downloads rows (the menu holds more than playlists)', () => {
    const { S } = makeSandbox();
    const htmls = [
      S.createMusicFileHtml('demo/a.mp3', 'A'),
      S.renderSearchRow('title', { filepath: 'demo/a.mp3', name: 'A' }, null),
      S.renderDiscoverDownloadRow({ id: 1, plugin: 'youtube', size: '', at: null, crumbs: ['demo'], title: 'A', artist: '', album: '', actions: ['play'], present: true, state: 'present', filepath: 'demo/a.mp3' }),
    ];
    for (const html of htmls) {
      assert.match(html, /<span title="More" aria-label="More" onclick="createPopper3\(this\);" data-file_location="demo&#x2F;a.mp3"[^>]* class="fileAddToPlaylist">/);
      assert.ok(!html.includes('Add To Playlist'));
    }
  });
});

describe('Instant Mix: the page', () => {
  test('opening: on the Back stack over the view it opens on; the bar with ← and its name; the header; four skeleton rows; one ask', async () => {
    const box = makeSandbox();
    box.el('localSearchBar').value = 'sto';
    box.list().scrollTop = 240;
    const answered = deferred();
    box.respond = () => answered.promise;
    box.S.setState([{ state: 'allAlbums' }]);
    box.S.setLastView({ fn: viewFn, el: NAV });
    const opening = box.S.instantMixOpen(DOLO_SEED, DOLO_HEAD);
    assert.deepEqual(box.S.state().at(-1), { state: 'mix', seed: DOLO_SEED, head: DOLO_HEAD, underView: { fn: viewFn, el: NAV }, previousScroll: 240, previousSearch: 'sto' });
    assert.equal(box.el('directory_bar').style.display, '');
    assert.equal(box.el('directoryName').innerHTML, 'Instant Mix');
    assert.equal(box.el('local_search_btn').style.display, 'none');
    for (const id of ['add_all_btn', 'instant_mix_btn', 'mkdir_btn', 'upload_btn', 'genre_source', 'mood_filter_btn']) { assert.ok(box.hidden(box.el(id)), id); }
    assert.equal(box.el('localSearchBar').value, '');
    const head = box.head();
    assert.ok(!box.hidden(head));
    assert.match(head.innerHTML, /<h2 class="browse-head-title" tabindex="-1">Dolo<\/h2><div class="browse-head-sub">Boukmanflow<\/div>/);
    assert.equal(head.querySelector('img').getAttribute('src'), 'http://host/album-art/dolo.jpeg?compress=s&token=TOK', "the song's cover in the 72 px tile");
    assert.equal(head.querySelector('.browse-head-title').focused, 1, 'the heading takes the keyboard');
    assert.ok(box.hidden(head.querySelector('.browse-head-acts')), 'no action row before an answer');
    assert.ok(box.hidden(box.el('mix_filter_btn')) && box.hidden(box.el('mix-filters')));
    assert.equal((box.list().innerHTML.match(/class="dpage-skel-row"/g) || []).length, 4);
    assert.deepEqual(box.calls.asked, [{ from: { song: 'demo/Boukmanflow/Dolo.mp3' }, limit: 50 }]);
    answered.resolve(answer([DOLO, ELEVATION, SWING]));
    await opening;
    assert.deepEqual(rowsOf(box.list().innerHTML), [['Dolo', 'Boukmanflow · Stim Pack Volume one'], ['Elevation', 'ALM · Free Instrumentals Vol.2 - Old School Session'], ['Swing', 'ALM']]);
  });

  test('the answer: Discover\'s rows in .dpage.mix-page, the verbs and the funnel shown, the panel closed until the funnel opens it', async () => {
    const box = makeSandbox();
    await box.open();
    assert.match(box.list().innerHTML, /^<div class="dpage mix-page"><div class="dpage-songs dpage-songs-solo"><div class="dpage-col"><div class="dpage-rows" aria-label="Instant Mix">/);
    const verbs = box.head().querySelectorAll('[data-mx="playAll"], [data-mx="shuffle"], [data-mx="queueAll"], [data-mx="save"]');
    assert.deepEqual(verbs.map((b) => box.hidden(b)), [false, false, false, false]);
    // drawn hidden (instantMixHeadState shows them), in the board's order
    assert.match(box.head().innerHTML, /<button type="button" class="spath-btn spath-btn-primary super-hide" data-mx="playAll">▶ Play<\/button><button type="button" class="spath-btn super-hide" data-mx="shuffle">Shuffle<\/button><button type="button" class="spath-btn super-hide" data-mx="queueAll">Queue all<\/button><button type="button" class="spath-btn super-hide" data-mx="save">Save as playlist<\/button><button type="button" id="mix_filter_btn" class="mood-filter-btn super-hide"/);
    const funnel = box.el('mix_filter_btn');
    assert.ok(!box.hidden(funnel) && !funnel.classList.contains('mood-on'), 'white: nothing set');
    assert.deepEqual([funnel.getAttribute('aria-label'), funnel.getAttribute('aria-controls'), funnel.getAttribute('aria-expanded')], ['Filters', 'mix-filters', 'false']);
    const panel = box.el('mix-filters');
    assert.deepEqual([panel.getAttribute('role'), panel.getAttribute('aria-label'), box.hidden(panel)], ['region', 'Filters', true]);
    box.headClick('#mix_filter_btn');
    assert.deepEqual([box.hidden(panel), funnel.getAttribute('aria-expanded'), box.S.MIX.open], [false, 'true', true]);
    assert.ok(panel.querySelector('[data-mxf-row="rating"]'), 'its rows: instantMixFiltersHtml');
    box.headClick('#mix_filter_btn');
    assert.deepEqual([box.hidden(panel), funnel.getAttribute('aria-expanded'), panel.innerHTML], [true, 'false', '']);
    // the row verbs: Discover's three, the ⋯ carrying the song for the ▾ menu
    assert.match(box.list().innerHTML, /data-mx="more" data-i="0" data-file_location="demo&#x2F;Boukmanflow&#x2F;Dolo.mp3" title="More" aria-label="More">⋯<\/button>/);
  });

  test('each state is one line: not analysed, nothing similar and off with no row and no funnel; no match with Clear; a failure with Try again', async () => {
    const cases = [
      ['notAnalyzed', answer([], { notAnalyzed: true }), 'Not analyzed yet', null],
      ['nothingSimilar', answer([DOLO]), 'Nothing similar yet', null],
      ['off', { disabled: true }, EN['dpage.state.off'], null],
      ['failed', null, 'Couldn’t build the mix', 'Try again'],
    ];
    for (const [st, res, line, btn] of cases) {
      const box = makeSandbox();
      box.respond = () => res;
      await box.open();
      assert.equal(lineOf(box.list().innerHTML), line, st);
      const button = box.list().querySelector('.dpage-hint-btn');
      assert.equal(button ? decode(box.list().innerHTML.match(/dpage-hint-btn" data-mx="\w+">([^<]*)/)[1]) : null, btn, st);
      assert.ok(box.hidden(box.head().querySelector('.browse-head-acts')), `${st}: no action row`);
      assert.ok(box.hidden(box.el('mix_filter_btn')), `${st}: no funnel`);
    }
    const off = makeSandbox();
    off.respond = () => ({ disabled: true });
    await off.open();
    assert.equal(off.globals.MSTREAMAPI.currentServer.instantMix, 0, 'a 403 takes the ways in away for the session');
    assert.equal(off.S.instantMixOn(), false);
  });

  test('filters carried into a new mix that leave nothing: the line and its Clear say why, the funnel orange, the panel closed; Clear asks again with none', async () => {
    const box = makeSandbox();
    box.S.MIX.filters = { ...M.emptyFilters(), minRating: 8 };
    box.respond = (body) => (body.minRating ? answer([DOLO], { filteredOut: true }) : answer([DOLO, ELEVATION]));
    await box.open();
    assert.equal(box.calls.asked[0].minRating, 8, 'the page keeps its filters from one mix to the next');
    assert.equal(lineOf(box.list().innerHTML), 'No songs match your filters');
    const funnel = box.el('mix_filter_btn');
    assert.ok(!box.hidden(funnel) && funnel.classList.contains('mood-on'));
    assert.ok(box.hidden(box.el('mix-filters')));
    assert.ok(box.head().querySelectorAll('[data-mx="playAll"], [data-mx="save"]').every((b) => box.hidden(b)), 'no verbs without rows');
    box.listClick('[data-mx="clear"]');
    assert.deepEqual(box.S.MIX.filters, M.emptyFilters());
    assert.equal(funnel.focused, 1, 'the keyboard back on the funnel');
    assert.ok(!funnel.classList.contains('mood-on'));
    box.runTimers();
    await settle();
    assert.equal('minRating' in box.calls.asked.at(-1), false);
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation']);
  });

  test('a song mix whose app folder choice emptied it is "nothing similar", never a Clear that clears nothing', async () => {
    const box = makeSandbox();
    box.globals.MSTREAMPLAYER.ignoreVPaths = { podcasts: true };
    box.globals.MSTREAMAPI.currentServer.vpaths = ['demo', 'podcasts'];
    box.respond = () => answer([DOLO], { filteredOut: true });
    await box.open();
    assert.deepEqual(box.calls.asked[0].ignoreVPaths, ['podcasts']);
    assert.equal(lineOf(box.list().innerHTML), 'Nothing similar yet');
  });

  test('a failure after a filter change: the line and Try again replace the rows, the funnel and the open panel stay; Try again asks again', async () => {
    const box = makeSandbox();
    await box.open();
    box.headClick('#mix_filter_btn');
    box.respond = () => null;
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.runTimers();
    await settle();
    assert.equal(lineOf(box.list().innerHTML), 'Couldn’t build the mix');
    assert.ok(!box.hidden(box.el('mix_filter_btn')) && !box.hidden(box.el('mix-filters')), 'the change can be undone where it was made');
    assert.ok(box.head().querySelectorAll('[data-mx="playAll"]').every((b) => box.hidden(b)));
    box.respond = () => answer([DOLO, TERANGA]);
    const before = box.calls.asked.length;
    box.listClick('[data-mx="retry"]');
    assert.ok(box.list().querySelector('.mix-page').classList.contains('mix-busy'));
    await settle();
    assert.equal(box.calls.asked.length, before + 1);
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Téranga']);
  });

  test('album, artist and playlist headers: the cover with the credit, the round person, the playlist glyph — no line for the last two', async () => {
    const box = makeSandbox();
    await box.open({ kind: 'album', album: 'Stim Pack Volume one', albumArtist: 'Boukmanflow', year: 2019 }, { kind: 'album', title: 'Stim Pack Volume one', sub: 'Boukmanflow', art: 'dolo.jpeg' });
    assert.match(box.head().innerHTML, /class="browse-head browse-head-album mix-head"[\s\S]*<div class="browse-head-sub">Boukmanflow<\/div>/);
    await box.S.instantMixOpen({ kind: 'artist', artist: 'Boukmanflow' }, { kind: 'artist', title: 'Boukmanflow' });
    assert.match(box.head().innerHTML, /class="browse-head-tile browse-head-tile-artist"/);
    assert.ok(!box.head().innerHTML.includes('browse-head-sub'));
    await box.S.instantMixOpen({ kind: 'playlist', playlist: 'Road trip' }, { kind: 'playlist', title: 'Road trip' });
    assert.ok(box.head().innerHTML.includes('M15 6H3v2h12V6z'), "the playlist's glyph");
    assert.deepEqual(box.calls.asked.map((b) => Object.keys(b.from)[0]), ['album', 'artist', 'playlist']);
  });
});

describe('Instant Mix: asking again', () => {
  test('a filter change: the funnel marked at once, the old rows dimmed (aria-busy), one ask 250 ms after the last of a burst, the panel kept', async () => {
    const box = makeSandbox();
    await box.open();
    box.headClick('#mix_filter_btn');
    const later = deferred();
    box.respond = () => later.promise;
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.S.MIX.filters.words = ['live'];
    box.S.instantMixFilterChanged();
    const page = box.list().querySelector('.mix-page');
    assert.ok(page.classList.contains('mix-busy') && page.getAttribute('aria-busy') === 'true');
    assert.ok(box.el('mix_filter_btn').classList.contains('mood-on'));
    assert.deepEqual(box.liveTimers().map((tm) => tm.ms), [250], 'one ask for the burst');
    assert.equal(box.calls.asked.length, 1);
    box.runTimers();
    assert.deepEqual([box.calls.asked.length, box.calls.asked[1].minRating, box.calls.asked[1].skipWords], [2, 6, ['live']]);
    assert.deepEqual(rowsOf(box.list().innerHTML).length, 3, 'the old rows stay until the new land');
    box.list().scrollTop = 500;
    later.resolve(answer([DOLO, TERANGA]));
    await settle();
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Téranga']);
    assert.ok(!box.list().querySelector('.mix-page').classList.contains('mix-busy'));
    assert.equal(box.list().scrollTop, 0, 'the new list from its top');
    assert.ok(!box.hidden(box.el('mix-filters')), 'the open panel untouched');
  });

  test('a change undone asks nothing, and an ask still out for it is never drawn', async () => {
    const box = makeSandbox();
    await box.open();
    const later = deferred();
    box.respond = () => later.promise;
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.runTimers();
    box.S.MIX.filters.minRating = 0;
    box.S.instantMixFilterChanged();
    assert.equal(box.liveTimers().length, 0);
    assert.ok(!box.list().querySelector('.mix-page').classList.contains('mix-busy'));
    later.resolve(answer([TERANGA]));
    await settle();
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation', 'Swing']);
    assert.equal(box.calls.asked.length, 2);
  });

  test('a newer ask wins: an older answer that lands after it — or during the next change\'s pause — is never drawn', async () => {
    const box = makeSandbox();
    await box.open();
    const first = deferred();
    const second = deferred();
    const queue = [first.promise, second.promise];
    box.respond = () => queue.shift();
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.runTimers();
    box.S.MIX.filters.minRating = 8;
    box.S.instantMixFilterChanged();
    first.resolve(answer([SWING]));
    await settle();
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation', 'Swing'], 'not drawn in the pause');
    box.runTimers();
    second.resolve(answer([DOLO, TERANGA]));
    await settle();
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Téranga']);
  });

  test('answers are kept by body: filters asked before draw again at once, with no ask', async () => {
    const box = makeSandbox();
    box.respond = (body) => (body.minRating ? answer([DOLO, TERANGA]) : answer([DOLO, ELEVATION, SWING]));
    await box.open();
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.runTimers();
    await settle();
    box.S.MIX.filters.minRating = 0;
    box.S.instantMixFilterChanged();
    box.runTimers();
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation', 'Swing'], 'drawn from the kept answer');
    assert.equal(box.calls.asked.length, 2);
    assert.ok(box.S.MIX.cache.size <= M.CACHE_MAX);
    for (let r = 1; r <= 10; r++) { box.S.MIX.filters.minRating = r; box.S.instantMixFilterChanged(); box.runTimers(); await settle(); }
    assert.equal(box.S.MIX.cache.size, M.CACHE_MAX, 'the newest eight');
  });

  test('a "yet" is never kept: a mix not analysed, or with nothing similar, asks again the next time it opens', async () => {
    for (const [why, first] of [['not analysed', answer([], { notAnalyzed: true })], ['nothing similar', answer([DOLO])]]) {
      const box = makeSandbox();
      box.respond = () => first;
      await box.open();
      await box.S.onBackButton();
      // the library's analysis went on meanwhile
      box.respond = () => answer([DOLO, ELEVATION]);
      await box.open();
      assert.equal(box.calls.asked.length, 2, why);
      assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation'], why);
      assert.equal(box.S.MIX.cache.size, 1, `${why}: only the answer with rows kept`);
    }
  });

  test('an answer for a page left is kept, never drawn over the page that replaced it', async () => {
    const box = makeSandbox();
    const late = deferred();
    box.respond = () => late.promise;
    box.S.setState([{ state: 'allAlbums' }]);
    const opening = box.S.instantMixOpen(DOLO_SEED, DOLO_HEAD);
    await box.S.onBackButton();
    box.list().innerHTML = 'ALBUMS';
    late.resolve(answer([DOLO, ELEVATION]));
    await opening;
    assert.equal(box.list().innerHTML, 'ALBUMS');
    assert.equal(box.S.MIX.cache.size, 1, 'kept for the way back');
  });

  test('the mood: its wire form, a threshold only when not Standard, only where the server takes moods; an answer without the echo empties it', async () => {
    const box = makeSandbox();
    box.S.MOODS.filters.mix = { energy: 'relaxed', level: 'strict' };
    await box.open();
    assert.deepEqual(box.calls.asked[0].moods, { energy: 'relaxed', threshold: 0.7 });
    box.S.MOODS.filters.mix = { energy: 'relaxed' };
    box.S.instantMixFilterChanged();
    box.runTimers();
    assert.deepEqual(box.calls.asked[1].moods, { energy: 'relaxed' }, 'Standard sends none');
    const plain = makeSandbox({ server: { moodFilters: false } });
    plain.S.MOODS.filters.mix = { energy: 'relaxed' };
    await plain.open();
    assert.equal('moods' in plain.calls.asked[0], false);
    const gone = makeSandbox();
    gone.S.MOODS.filters.mix = { voice: 'vocals' };
    gone.respond = () => { const res = answer([DOLO, ELEVATION]); delete res.moods; return res; };
    await gone.open();
    assert.deepEqual(gone.S.MOODS.filters.mix, {});
    assert.equal(gone.S.MIX.moodsGone, true);
    assert.ok(!gone.el('mix_filter_btn').classList.contains('mood-on'));
  });
});

describe('Instant Mix: the verbs and the rows', () => {
  test('▶ Play: the queue becomes the mix, its first row plays (every later row autoPlayOff)', async () => {
    const box = makeSandbox({ playlist: [{ rawFilePath: 'demo/other.mp3' }], position: 0, playing: true });
    await box.open();
    box.headClick('[data-mx="playAll"]');
    await settle();
    assert.equal(box.calls.cleared, 1);
    assert.equal(box.calls.trimmed, 0);
    assert.deepEqual(box.calls.queued.map((q) => [q.filepath, q.autoPlayOff, q.lookup, q.position]),
      [[DOLO.filepath, false, false, undefined], [ELEVATION.filepath, true, false, undefined], [SWING.filepath, true, false, undefined]]);
  });

  test('▶ Play while its first row is this server\'s song playing now: it plays on, the queue trimmed to it, the other rows after it', async () => {
    const playing = { rawFilePath: '/demo/Boukmanflow/Dolo.mp3', metadata: DOLO.metadata };
    const box = makeSandbox({ playlist: [{ rawFilePath: 'demo/a.mp3' }, playing, { rawFilePath: 'demo/b.mp3' }], position: 1, playing: true });
    await box.open();
    box.headClick('[data-mx="playAll"]');
    await settle();
    assert.deepEqual([box.calls.trimmed, box.calls.cleared], [1, 0]);
    assert.deepEqual(box.calls.queued.map((q) => [q.filepath, q.autoPlayOff]), [[ELEVATION.filepath, true], [SWING.filepath, true]]);
    for (const [why, opts] of [['paused', { playing: false }], ['on a connected server', { federated: true }]]) {
      const song = { ...playing, ...(opts.federated ? { federation: { peerId: 2 } } : {}) };
      const b = makeSandbox({ playlist: [song], position: 0, playing: opts.playing !== false });
      await b.open();
      b.headClick('[data-mx="playAll"]');
      await settle();
      assert.deepEqual([b.calls.trimmed, b.calls.cleared], [0, 1], why);
    }
  });

  test('Shuffle replaces the queue with the rows in a random order and plays the first; Queue all appends them', async () => {
    const box = makeSandbox();
    await box.open();
    box.headClick('[data-mx="shuffle"]');
    await settle();
    assert.equal(box.calls.cleared, 1);
    assert.deepEqual(box.calls.queued.map((q) => q.filepath).sort(), [DOLO, ELEVATION, SWING].map((s) => s.filepath).sort());
    assert.deepEqual(box.calls.queued.map((q) => q.autoPlayOff), [false, true, true]);
    const q = makeSandbox();
    await q.open();
    q.headClick('[data-mx="queueAll"]');
    await settle();
    assert.equal(q.calls.cleared, 0);
    assert.deepEqual(q.calls.queued.map((x) => [x.filepath, x.autoPlayOff, x.live]), [DOLO, ELEVATION, SWING].map((s) => [s.filepath, true, false]));
    assert.equal(q.calls.toasts.at(-1).title, 'Added to the queue');
  });

  test('a verb acts on the answer for the filters set: a change not asked yet is asked, an ask out waited for', async () => {
    const box = makeSandbox();
    await box.open();
    const later = deferred();
    box.respond = () => later.promise;
    box.S.MIX.filters.minRating = 6;
    box.S.instantMixFilterChanged();
    box.headClick('[data-mx="queueAll"]');
    await settle();
    assert.equal(box.calls.asked.length, 2, 'the pause cut short');
    assert.equal(box.calls.queued.length, 0, 'nothing queued from the old rows');
    later.resolve(answer([DOLO, TERANGA]));
    await settle();
    assert.deepEqual(box.calls.queued.map((x) => x.filepath), [DOLO.filepath, TERANGA.filepath]);
  });

  test('Save as playlist: the modal prefilled "Dolo Mix" — "Dolo Mix 2" when taken — saving the rows; a new name joins the lists once', async () => {
    const box = makeSandbox({ playlists: [{ name: 'Road trip', type: 'playlist' }] });
    box.el('pop-f').innerHTML = box.S.popFHeadHtml();
    await box.open();
    box.headClick('[data-mx="save"]');
    await settle();
    assert.equal(box.el('save_playlist_name').value, 'Dolo Mix');
    assert.deepEqual(box.calls.modal, ['#savePlaylistModal']);
    await box.S.savePlaylistFromModal();
    assert.deepEqual(box.calls.saved, [{ title: 'Dolo Mix', songs: [DOLO, ELEVATION, SWING].map((s) => s.filepath) }]);
    assert.deepEqual(box.globals.VUEPLAYERCORE.playlists.map((p) => p.name), ['Road trip', 'Dolo Mix']);
    assert.match(box.el('pop-f').innerHTML, /data-playlist="Dolo Mix"/);
    assert.match(box.el('live-playlist-select').innerHTML, /<option value="Dolo Mix">Dolo Mix<\/option>/);
    assert.equal(box.calls.toasts.at(-1).title, 'Playlist saved');
    box.headClick('[data-mx="save"]');
    await settle();
    assert.equal(box.el('save_playlist_name').value, 'Dolo Mix 2', 'the next default never takes it');
    box.el('save_playlist_name').value = 'Road trip';
    await box.S.savePlaylistFromModal();
    assert.equal(box.globals.VUEPLAYERCORE.playlists.length, 2, 'an existing name is not added twice');
    box.S.openSavePlaylistModal(() => ['x']);
    assert.equal(box.el('save_playlist_name').value, '', 'the Sonic Path and Discover open it empty, as before');
  });

  test('a row: its click queues it, ▶ plays it next, ⋯ opens the song menu (whose Instant Mix chains a new mix)', async () => {
    const box = makeSandbox({ position: 4 });
    box.el('pop-f').innerHTML = box.S.popFHeadHtml();
    await box.open();
    box.listClick('.dpage-row[data-i="1"]');
    assert.deepEqual(box.calls.queued.at(-1), { filepath: ELEVATION.filepath, lookup: false, position: undefined, live: false, autoPlayOff: true });
    assert.equal(box.calls.toasts.at(-1).title, 'Added to the queue');
    box.listClick('[data-mx="play"][data-i="2"]');
    assert.deepEqual([box.calls.queued.at(-1).filepath, box.calls.queued.at(-1).position], [SWING.filepath, 5]);
    box.listClick('[data-mx="more"][data-i="1"]');
    assert.equal(box.S.tracker(), ELEVATION.filepath);
    assert.equal(box.el('pop-f-mix').style.display, '');
    await box.S.instantMixFromMenu();
    assert.deepEqual(box.S.state().map((s) => s.state), ['allAlbums', 'mix', 'mix']);
    assert.deepEqual(box.S.state().at(-1).head, { kind: 'song', title: 'Elevation', sub: 'ALM', art: 'alm2.jpeg' }, "from the mix's own rows");
  });
});

describe('Instant Mix: Back', () => {
  test('to the album under it: drawn again from its entry, the bar\'s search and Add All back, the header and the page\'s listeners gone', async () => {
    const box = makeSandbox();
    const album = { state: 'album', name: 'Stim Pack Volume one', artist: null, albumArtist: 'Boukmanflow', year: '2019', compilation: false, previousScroll: 0, previousSearch: '' };
    box.albumSongs = [DOLO];
    await box.open(DOLO_SEED, DOLO_HEAD, [{ state: 'allAlbums' }, album]);
    assert.equal(box.head().live('click'), 1);
    await box.S.onBackButton();
    assert.deepEqual(box.S.state(), [{ state: 'allAlbums' }, album]);
    assert.equal(box.S.state()[1], album, 'the entry itself, put back');
    assert.deepEqual(box.calls.albumSongs.at(-1), { album: 'Stim Pack Volume one', artist: null, year: '2019', ignoreVPaths: [], album_artist: 'Boukmanflow' });
    assert.equal(box.el('local_search_btn').style.display, '');
    assert.ok(!box.hidden(box.el('add_all_btn')));
    assert.equal(box.S.MIX.entry, null);
    assert.equal(box.head().live('click') + box.list().live('click'), 0, 'listeners dropped with the page');
    assert.equal(box.el('directoryName').innerHTML, 'Album: Stim Pack Volume one');
  });

  test('to the file explorer: the folder it was opened on, not its parent', async () => {
    const box = makeSandbox();
    box.S.setDirs(['demo', 'Boukmanflow']);
    await box.open(DOLO_SEED, DOLO_HEAD, [{ state: 'fileExplorer' }, { state: 'fileExplorer' }, { state: 'fileExplorer' }]);
    await box.S.onBackButton();
    assert.deepEqual(box.calls.senddir, [['demo', 'Boukmanflow']]);
    assert.equal(box.S.state().length, 3);
  });

  test('to a playlist: opened again by name, its entry put back as it was', async () => {
    const box = makeSandbox();
    const entry = { state: 'playlist', name: 'Road trip', previousScroll: 12, previousSearch: '' };
    box.playlistSongs = [{ filepath: DOLO.filepath, metadata: DOLO.metadata, lokiId: 1 }];
    await box.open({ kind: 'playlist', playlist: 'Road trip' }, { kind: 'playlist', title: 'Road trip' }, [{ state: 'allPlaylists' }, entry]);
    await box.S.onBackButton();
    assert.deepEqual(box.calls.loaded, ['Road trip']);
    assert.equal(box.S.state()[1], entry);
    assert.equal(box.S.state().length, 2);
    assert.equal(box.el('directoryName').innerHTML, 'Playlist: Road trip');
  });

  test('over a view that keeps no stack (Auto DJ), or at the stack\'s root: that view again, through changeView', async () => {
    const autoDj = () => {};
    const navEl = makeEl('div', { class: 'side-nav-item' });
    for (const under of [[{ state: 'view' }], []]) {
      const box = makeSandbox();
      box.S.setState(under);
      box.S.setLastView({ fn: autoDj, el: navEl });
      await box.S.instantMixOpen(DOLO_SEED, DOLO_HEAD);
      await box.S.onBackButton();
      assert.deepEqual(box.calls.views, [{ fn: autoDj, el: navEl }], JSON.stringify(under));
      assert.deepEqual(box.calls.panels, []);
      assert.equal(box.S.MIX.entry, null);
    }
    const rated = makeSandbox();
    await rated.open(DOLO_SEED, DOLO_HEAD, [{ state: 'allRated' }]);
    await rated.S.onBackButton();
    assert.deepEqual(rated.calls.views, [{ fn: viewFn, el: NAV }], 'a root list with no branch of its own');
  });

  test('to an earlier mix (a mix of one of its rows): drawn again from its kept answer, no ask', async () => {
    const box = makeSandbox();
    await box.open();
    await box.S.instantMixOpen({ kind: 'song', filepath: ELEVATION.filepath, bpm: null, key: null }, { kind: 'song', title: 'Elevation', sub: 'ALM', art: null });
    assert.equal(box.calls.asked.length, 2);
    await box.S.onBackButton();
    assert.equal(box.calls.asked.length, 2, 'from the kept answer');
    assert.match(box.head().innerHTML, /<h2 class="browse-head-title" tabindex="-1">Dolo<\/h2>/);
    assert.deepEqual(rowsOf(box.list().innerHTML).map((r) => r[0]), ['Dolo', 'Elevation', 'Swing']);
    assert.deepEqual(box.S.state().map((s) => s.state), ['allAlbums', 'mix']);
    assert.equal(box.head().live('click'), 1, "one page's listeners");
  });

  test('an album opened over a mix leaves it; its Back draws the mix again', async () => {
    const box = makeSandbox();
    box.albumSongs = [DOLO];
    await box.open();
    await box.S.getAlbumSongs('Stim Pack Volume one', null, null, 'Boukmanflow');
    assert.equal(box.S.MIX.entry, null);
    assert.ok(!box.hidden(box.el('add_all_btn')));
    await box.S.onBackButton();
    assert.equal(box.S.MIX.entry, box.S.state().at(-1));
    assert.equal(box.el('directoryName').innerHTML, 'Instant Mix');
  });
});

describe('Instant Mix: the player and the wiring', () => {
  // The player's own function, sliced out of its module closure.
  function sliceMember(name) {
    const lines = PLAYER.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`  mstreamModule.${name} = function`));
    assert.ok(start >= 0, `mstream.player.js no longer defines mstreamModule.${name}`);
    for (let i = start; i < lines.length; i++) {
      if (lines[i] === '  }') { return lines.slice(start, i + 1).join('\n'); }
    }
    throw new Error(`could not find the end of mstreamModule.${name}`);
  }

  test('trimToCurrent keeps the playing row (at position 0, the same array) and adds no Auto DJ pick', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => ({ filepath: n }));
    const mod = { playlist: [a, b, c, d], positionCache: { val: 2 }, playerStats: { autoDJ: true, shuffle: true } };
    const list = mod.playlist;
    const hits = [];
    const run = new Function('mstreamModule', '__sc', '__sp', 'clearEnd', '_autoDjQueueN', 'autoDJ', `
      let shuffleCache = __sc;
      let shufflePrevious = __sp;
      ${sliceMember('trimToCurrent')}
      return { trim: () => mstreamModule.trimToCurrent(), sc: () => shuffleCache, sp: () => shufflePrevious };
    `)(mod, [a, d, c], [b, c], () => hits.push('clearEnd'), () => hits.push('queueN'), () => hits.push('autoDJ'));
    assert.equal(run.trim(), true);
    assert.equal(mod.playlist, list, 'the queue Vue watches, edited in place');
    assert.deepEqual(mod.playlist, [c]);
    assert.equal(mod.positionCache.val, 0);
    assert.deepEqual([run.sc(), run.sp()], [[c], [c]]);
    assert.deepEqual(hits, [], 'no DJ pick; its end still goes on to the next row');
    const empty = { playlist: [], positionCache: { val: -1 }, playerStats: {} };
    const none = new Function('mstreamModule', `let shuffleCache = []; let shufflePrevious = [];\n${sliceMember('trimToCurrent')};\nreturn mstreamModule.trimToCurrent();`)(empty);
    assert.equal(none, false);
  });

  test('api.js: POST api/v1/discovery/local/mix with the token; {disabled:true} on 403, null on any other failure', async () => {
    const seen = [];
    let reply;
    const fetch = (url, opts) => { seen.push({ url, opts }); return reply(); };
    const MSTREAMAPI = new Function('fetch', 'localStorage', 'Cookies', 'document', 'window', `${API}\nreturn MSTREAMAPI;`)(fetch, globalThis.localStorage, {}, {}, { location: { href: '' } });
    MSTREAMAPI.currentServer.host = 'http://host/';
    MSTREAMAPI.currentServer.token = 'TOK';
    const body = { from: { song: 'demo/Boukmanflow/Dolo.mp3' }, limit: 50 };
    reply = () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(answer([DOLO])) });
    assert.equal((await MSTREAMAPI.instantMix(body)).songs.length, 1);
    assert.equal(seen[0].url, 'http://host/api/v1/discovery/local/mix');
    assert.deepEqual([seen[0].opts.method, seen[0].opts.headers['x-access-token'], JSON.parse(seen[0].opts.body)], ['POST', 'TOK', body]);
    reply = () => Promise.resolve({ status: 403, ok: false });
    assert.deepEqual(await MSTREAMAPI.instantMix(body), { disabled: true });
    reply = () => Promise.resolve({ status: 400, ok: false });
    assert.equal(await MSTREAMAPI.instantMix(body), null);
    reply = () => Promise.reject(new Error('offline'));
    assert.equal(await MSTREAMAPI.instantMix(body), null);
  });

  test('spa.js changeView: the view it opens is what a mix over it goes back to, on a Back stack of its own', () => {
    const calls = [];
    const S = new Function('document', 'closeSideMenu', `
      let lastView = null;
      let programState = [{ state: 'allAlbums' }, { state: 'album' }];
      ${sliceFn(SPA, 'changeView')}
      return { changeView, view: () => lastView, state: () => programState };
    `)({ querySelectorAll: () => [] }, () => {});
    const el = makeEl('div', { class: 'side-nav-item' });
    const fn = () => calls.push(S.state());
    S.changeView(fn, el);
    assert.deepEqual(S.view(), { fn, el });
    assert.deepEqual(calls, [[{ state: 'view' }]], 'a stack with no Back branch, before the view draws');
    assert.ok(el.classList.contains('select'));
  });

  test('index.html: the ✦ just before Add All, both menus\' entries, playlist names free of the old pattern, the script beside discovery-page.js', () => {
    const bar = HTML.slice(HTML.indexOf('<div id="directory_bar"'), HTML.indexOf('<div id="mood_filters"'));
    const btn = bar.match(/<button type="button" id="instant_mix_btn" class="mix-bar-btn super-hide" onclick="instantMixFromBar\(\);" aria-label="Instant Mix" data-i18n="mix.title" data-i18n-attr="aria-label">/);
    assert.ok(btn, 'the ✦');
    assert.ok(bar.indexOf('id="instant_mix_btn"') < bar.indexOf('<svg id="add_all_btn" onclick="addAll();"'), 'left of Add All');
    assert.ok(bar.includes('M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5'), 'the sparkles glyph');
    assert.match(HTML, /id="pop-f" role="tooltip">\s*<div class="pop-list-item" id="pop-f-mix" style="display:none" onclick="instantMixFromMenu\(\)" data-i18n="mix.title">Instant Mix<\/div>\s*<div class="pop-f pop-playlist">/,
      "the ▾ menu: Instant Mix above the playlists' header");
    const popD = HTML.slice(HTML.indexOf('id="pop-d"'), HTML.indexOf('pop-d pop-playlist'));
    assert.match(popD, /v-on:click="gsi2" >Song Info<\/div>\s*<!--[\s\S]*?-->\s*<div id="pop-d-mix" class="pop-list-item" style="display:none" onclick="instantMixFromQueue\(\)">\{\{ tt\('mix.title'\) \}\}<\/div>\s*<div class="pop-list-item" v-on:click="downloadSong2">Download<\/div>/);
    assert.ok(!HTML.includes('pattern="[a-zA-Z0-9 _-]+"'), 'a playlist may be named "Téranga Mix"');
    const page = HTML.indexOf('<script src="alpha/discovery-page.js"></script>');
    const mix = HTML.indexOf('<script src="alpha/instant-mix.js"></script>');
    assert.ok(page > 0 && mix > page && mix < HTML.indexOf('<script src="alpha/vp.js"></script>'));
  });

  test('en.json: the six new strings, exactly; every mix.* key the page uses exists', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(EN).filter(([k]) => k.startsWith('mix.'))), {
      'mix.title': 'Instant Mix',
      'mix.noMatch': 'No songs match your filters',
      'mix.nothingSimilar': 'Nothing similar yet',
      'mix.notAnalyzed': 'Not analyzed yet',
      'mix.failed': 'Couldn’t build the mix',
      'mix.defaultName': '{{name}} Mix',
    });
    const used = new Set([...SRC.matchAll(/'(mix\.[A-Za-z]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...used].filter((k) => !(k in EN)), []);
    for (const k of ['sonicPath.play', 'dpage.verb.shuffle', 'dpage.verb.queueAll', 'dpage.verb.saveAsPlaylist', 'dpage.verb.playNow', 'dpage.verb.queue',
      'dpage.verb.more', 'dpage.verb.tryAgain', 'dpage.state.off', 'moods.filters', 'moods.clear', 'discover.modal.queued', 'sonicPath.playlistSaved']) {
      assert.ok(typeof EN[k] === 'string', k);
    }
  });
});
