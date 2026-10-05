/**
 * webapp/alpha/discovery-page.js — the Discover page's pure half, on node:
 * the two request bodies (flags drop sources, pins lose their leading '/',
 * caps hold), the seed chips and the "based on …" line for every seed
 * source, the library's album cards and song rows under each filter, the
 * relative times at their boundaries, the network rows and peer groups
 * (raw rows kept for the recommendation window, jobs badged through an
 * injected DISCOVERJOBS), every page and source state, and the prefs merge.
 *
 * Held to the server where it can be: the contract constants against
 * src/discovery/taste-queries.js, the network / peers fixtures stamped by
 * the taste route's own stampNetworkRows / peersSection, the batch lookup
 * answered with the plug-in registry's own jobKeysFor — and every i18n key
 * the module emits must have an English value with its placeholders filled.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as tasteQ from '../../src/discovery/taste-queries.js';
import { stampNetworkRows, peersSection } from '../../src/api/discovery-taste.js';
import * as plugins from '../../src/discovery-plugins/index.js';

const require = createRequire(import.meta.url);
const D = require('../../webapp/alpha/discovery-page.js');
const J = require('../../webapp/alpha/discover-jobs.js');
const EN = require('../../webapp/locales/en.json');
const SOURCE = readFileSync(new URL('../../webapp/alpha/discovery-page.js', import.meta.url), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const FLAGS = { discovery: true, discoveryTaste: 1, discoveryP2p: true, federationDiscovery: true };

// ── fixtures in the route's own shapes ──────────────────────────────────

const seed = (hash, title, artist, over) => ({
  hash, filepath: `Music/${artist}/${title}.flac`, metadata: { title, artist, 'album-art': `${hash}.jpg` },
  outcome: 'completed', lastPlayed: ago(1), plays: 1, pinned: false, analyzed: true, ...over,
});
const PIN = seed('hp', 'Manor', 'ALM', { pinned: true, outcome: null, plays: 4, lastPlayed: ago(0.1) });
const HISTORY = [
  seed('h1', 'One', 'Boukmanflow', { lastPlayed: ago(0.2), plays: 3 }),
  seed('h2', 'Two', 'Color Out', { lastPlayed: ago(1) }),
  seed('h3', 'Three', 'Artist B', { lastPlayed: ago(3) }),
  seed('h4', 'Four', 'Artist C', { lastPlayed: ago(4), plays: 2 }),
  seed('h5', 'Five', 'Artist D', { lastPlayed: ago(7) }),
  seed('h6', 'Six', 'Artist E', { lastPlayed: ago(8) }),
  seed('h7', 'Seven', 'Artist F', { lastPlayed: ago(9) }),
  seed('h8', 'Eight', 'Artist G', { lastPlayed: ago(10) }),
];

const albumRow = (name, over) => ({
  name, year: 2019, album_art_file: `${name}.jpg`, album_artist: null, artists: ['Artist F', 'Guest'], compilation: false,
  year_min: 2019, year_max: 2019, track_count: 11, duration: 2400,
  similarity: 0.8412, seedHash: 'h1', scopedTracks: 11, playedTracks: 0, lastPlayed: null,
  tracks: [`Music/${name}/01.flac`, `Music/${name}/02.flac`], ...over,
});
const trackRowIn = (n, over) => ({
  filepath: `Music/T/${n}.mp3`, similarity: 0.7731, seedHash: 'h2',
  metadata: { title: `Title ${n}`, artist: 'Artist J', album: 'Album 7', duration: 251, 'album-art': 'a7.jpg' },
  genreTags: ['Electronic---Synthwave', 'Electronic---Chillwave'], playCount: 0, lastPlayed: null, ...over,
});

const LIB_SEEDS = [PIN, ...HISTORY];
const P2P_RAW = [
  { seedIndex: 1, artist: 'Artist M', title: 'Lead One', album: 'Album N1', year: 2022, duration: 200, similarity: 0.81234, exportId: 'x1', peer: { endpointId: 'e1', name: 'Peer One' }, recordingMbid: null, isrc: null },
  { seedIndex: 2, artist: 'Artist N', title: 'Lead Two', album: 'Album N2', year: null, duration: null, similarity: 0.7, exportId: 'x2', peer: { endpointId: 'e2', name: null }, recordingMbid: null, isrc: null },
  { seedIndex: null, artist: 'Artist O', title: 'Lead Three', album: null, year: null, duration: 3725, similarity: 0.6, exportId: 'x3', peer: { endpointId: 'e3', name: 'Peer Three' }, recordingMbid: null, isrc: null },
];
const fedRow = (peer, title, over) => ({
  artist: 'Artist Q', title, album: 'Album P1', year: 2020, duration: 243, similarity: 0.7412, genreTags: null,
  recordingMbid: null, filepath: `music/q/${title}.mp3`, peer: { id: peer.id, name: peer.name }, ...over,
});
const SAM = { id: 1, name: 'Sam’s server' };
const BEE = { id: 2, name: 'peer B' };
const CEE = { id: 3, name: 'peer C' };
const FAN = {
  peers: [
    { ...BEE, reachable: false, mismatched: false, lastSeen: ago(2), results: [] },
    { ...SAM, reachable: true, mismatched: false, lastSeen: ago(0), results: [fedRow(SAM, 'P1'), fedRow(SAM, 'P2'), fedRow(SAM, 'P3', { artist: 'Artist S', album: 'Album P3' })] },
    { ...CEE, reachable: true, mismatched: true, lastSeen: ago(0), results: [] },
  ],
  searched: { peers: 1, unreachable: 1, mismatched: 1 },
};

function historyResponse(over) {
  return {
    window: 30, widenedFrom: null, seedSource: 'history', fallback: false,
    seeds: LIB_SEEDS, excluded: [], dropped: 0, notAnalyzed: false,
    model: { id: 'test-fake', version: '1' },
    library: {
      filter: 'fresh',
      tracks: [
        trackRowIn(7),
        trackRowIn(8, { playCount: 2, lastPlayed: ago(240), seedHash: 'hp' }),
        trackRowIn(9, { genreTags: null, metadata: { title: '', artist: '', album: 'Album 8', duration: 320 } }),
        trackRowIn(10, { playCount: 1, lastPlayed: null, seedHash: 'nope' }),
      ],
      albums: [albumRow('Album 1'), albumRow('Album 3', { playedTracks: 2, scopedTracks: 12, lastPlayed: ago(200), album_artist: 'Artist G', seedHash: 'h3' })],
      capped: false,
    },
    network: { results: stampNetworkRows(P2P_RAW, LIB_SEEDS, 12), searched: { peers: 3, tracks: 7421 } },
    peers: null,
    ...over,
  };
}
const peersResponse = () => ({ ...historyResponse(), library: null, network: null, peers: peersSection(FAN) });

// Every { key, params } in a value, recursively (raw rows and metadata skipped).
function labelsIn(value, out = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) { return out; }
  seen.add(value);
  if (typeof value.key === 'string' && /^(dpage|discover)\./.test(value.key) && (value.params === undefined || typeof value.params === 'object')) {
    out.push(value);
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'raw' || k === 'metadata' || k === 'job') { continue; }
    labelsIn(v, out, seen);
  }
  return out;
}
const EMITTED = [];
const collect = (v) => { labelsIn(v, EMITTED); return v; };

// ── contract ──────────────────────────────────────────────────────────

describe('the contract constants agree with the server', () => {
  test('windows, filters, defaults, caps', () => {
    assert.deepEqual([...D.WINDOWS], [...tasteQ.WINDOWS]);
    assert.deepEqual([...D.FILTERS], [...tasteQ.FILTERS]);
    assert.deepEqual({ ...D.DEFAULT_PREFS }, { window: tasteQ.DEFAULT_WINDOW, filter: tasteQ.DEFAULT_FILTER, staleDays: tasteQ.DEFAULT_STALE_DAYS });
    assert.equal(D.STALE_DAYS_MIN, tasteQ.STALE_DAYS_MIN);
    assert.equal(D.STALE_DAYS_MAX, tasteQ.STALE_DAYS_MAX);
    assert.equal(D.PIN_CAP, tasteQ.PIN_CAP);
    assert.equal(D.EXCLUDE_CAP, tasteQ.EXCLUDE_CAP);
    assert.equal(D.HASH_MAX, tasteQ.HASH_MAX);
    assert.deepEqual({ ...D.LIMIT_DEFAULTS }, { ...tasteQ.LIMIT_DEFAULTS });
    assert.deepEqual({ ...D.LIMIT_CAPS }, { ...tasteQ.LIMIT_CAPS });
  });

  test('storage key names (the panel shares newArtistsOnly)', () => {
    assert.deepEqual({ ...D.STORAGE_KEYS }, { prefs: 'discoverPagePrefs', newArtistsOnly: 'discoverNewArtistsOnly', source: 'discoverPageSource' });
  });
});

// ── requests ──────────────────────────────────────────────────────────

describe('buildRequests', () => {
  const prefs = { window: 30, filter: 'fresh', staleDays: 90, exclude: [], newArtistsOnly: false, persisted: true };

  test('two bodies: library+network, then peers — same seeds-shaping keys', () => {
    const { main, peers } = D.buildRequests({ prefs, pinPath: '/Music/ALM/Manor.mp3', flags: FLAGS, ignoreVPaths: ['Podcasts'] });
    assert.deepEqual(main.sources, ['library', 'network']);
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['Music/ALM/Manor.mp3']);
    const strip = (b) => { const c = { ...b }; delete c.sources; delete c.remember; return c; };
    assert.deepEqual(strip(main), strip(peers));
    assert.deepEqual(strip(main), { window: 30, filter: 'fresh', staleDays: 90, pin: ['Music/ALM/Manor.mp3'], newArtistsOnly: false, ignoreVPaths: ['Podcasts'] });
  });

  test('flags drop sources: no p2p → library alone; no federation discovery → no peers call', () => {
    const noP2p = D.buildRequests({ prefs, flags: { ...FLAGS, discoveryP2p: false } });
    assert.deepEqual(noP2p.main.sources, ['library']);
    assert.ok(noP2p.peers);
    const noFed = D.buildRequests({ prefs, flags: { ...FLAGS, federationDiscovery: false } });
    assert.deepEqual(noFed.main.sources, ['library', 'network']);
    assert.equal(noFed.peers, null);
    const neither = D.buildRequests({ prefs, flags: { discovery: true, discoveryTaste: 1 } });
    assert.deepEqual(neither.main.sources, ['library']);
    assert.equal(neither.peers, null);
  });

  test('the page off: no bodies at all', () => {
    for (const flags of [{}, { ...FLAGS, discovery: false }, { ...FLAGS, discoveryTaste: 0 }, { ...FLAGS, discoveryTaste: undefined }, { ...FLAGS, discoveryTaste: true }, null]) {
      assert.deepEqual(D.buildRequests({ prefs, flags }), { main: null, peers: null }, JSON.stringify(flags));
    }
    assert.ok(D.buildRequests({ prefs, flags: { ...FLAGS, discoveryTaste: 2 } }).main, 'a later generation still has the page');
    assert.ok(D.buildRequests({ prefs, flags: { ...FLAGS, discoveryTaste: '1' } }).main);
  });

  test('pins: leading slashes stripped, de-duplicated, now playing first, capped at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `/Music/p${i}.mp3`);
    const { main } = D.buildRequests({ prefs, flags: FLAGS, pinPath: '//Music/now.mp3', pins: ['Music/now.mp3', '', null, 42, ...many] });
    assert.equal(main.pin.length, 8);
    assert.equal(main.pin[0], 'Music/now.mp3');
    assert.ok(main.pin.every((p) => !p.startsWith('/')));
    assert.equal(new Set(main.pin).size, 8);
    assert.equal(D.buildRequests({ prefs, flags: FLAGS, pinPath: 'x'.repeat(2049) }).main.pin, undefined);
    assert.equal(D.buildRequests({ prefs, flags: FLAGS }).main.pin, undefined);
  });

  test('explicit choices win over prefs; unknown prefs are left out (the saved pref applies)', () => {
    const { main } = D.buildRequests({ prefs, flags: FLAGS, window: '7', filter: 'all', staleDays: 30, newArtistsOnly: true });
    assert.equal(main.window, 7);
    assert.equal(main.filter, 'all');
    assert.equal(main.staleDays, 30);
    assert.equal(main.newArtistsOnly, true);
    const bare = D.buildRequests({ flags: FLAGS, window: 14, filter: 'nope', staleDays: 0 }).main;
    assert.equal('window' in bare, false);
    assert.equal('filter' in bare, false);
    assert.equal('staleDays' in bare, false);
    assert.equal(D.buildRequests({ flags: FLAGS, window: 0 }).main.window, 0, 'all time is a real window');
    assert.equal('window' in D.buildRequests({ flags: FLAGS, window: null }).main, false, 'null is not all time');
  });

  test('remember rides on the first call alone', () => {
    const { main, peers } = D.buildRequests({ prefs, flags: FLAGS, remember: true, exclude: ['h9'] });
    assert.equal(main.remember, true);
    assert.equal('remember' in peers, false);
    assert.deepEqual(peers.exclude, ['h9'], 'both calls still agree on the seeds');
  });

  test('exclusions: a persisting server merges its own list; elsewhere the local list travels, newest 200', () => {
    const saved = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const persisted = D.buildRequests({ prefs: { ...prefs, exclude: saved }, flags: FLAGS, exclude: ['new', 'new', '', 'y'.repeat(129)] }).main;
    assert.deepEqual(persisted.exclude, ['new']);
    const local = D.buildRequests({ prefs: { ...prefs, exclude: saved, persisted: false }, flags: FLAGS, exclude: ['new'] }).main;
    assert.equal(local.exclude.length, 200);
    assert.equal(local.exclude[199], 'new');
    assert.equal(local.exclude[0], 's1', 'oldest out first');
    assert.equal(D.buildRequests({ prefs, flags: FLAGS }).main.exclude, undefined);
  });

  test('limits clamped to the caps; ignoreVPaths cleaned', () => {
    const { main } = D.buildRequests({
      prefs, flags: FLAGS, limits: { seeds: 0, tracks: 999, albums: 3.7, network: -4, peers: '30', bogus: 5 },
      ignoreVPaths: ['ok', '', 7, 'x'.repeat(257), ...Array.from({ length: 120 }, (_, i) => `v${i}`)],
    });
    assert.deepEqual(main.limit, { seeds: 1, tracks: 50, albums: 3, network: 0, peers: 25 });
    assert.equal(main.ignoreVPaths.length, 100);
    assert.equal(main.ignoreVPaths[0], 'ok');
    assert.equal(D.buildRequests({ prefs, flags: FLAGS, limits: {} }).main.limit, undefined);
    assert.equal(D.buildRequests({ prefs, flags: FLAGS }).main.ignoreVPaths, undefined, 'a peer context sends none');
  });

  test('requestKey: key order and remember do not matter; a seed change does', () => {
    const a = D.buildRequests({ prefs, flags: FLAGS, pinPath: 'a.mp3' }).main;
    const b = { ...D.buildRequests({ prefs, flags: FLAGS, pinPath: 'a.mp3', remember: true }).main };
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    assert.equal(D.requestKey(a), D.requestKey(reordered));
    assert.notEqual(D.requestKey(a), D.requestKey(D.buildRequests({ prefs, flags: FLAGS, pinPath: 'b.mp3' }).main));
    assert.equal(D.requestKey(null), '');
  });
});

describe('mergeResponses', () => {
  const main = historyResponse();
  test('main in flight / failed / refused passes through', () => {
    assert.equal(D.mergeResponses(undefined, undefined, true), undefined);
    assert.equal(D.mergeResponses(null, peersResponse(), true), null);
    assert.deepEqual(D.mergeResponses({ disabled: true }, peersResponse(), true), { disabled: true });
  });
  test('the peers section comes from the peers call', () => {
    assert.equal(D.mergeResponses(main, undefined, false).peers, null, 'not asked');
    assert.equal(D.mergeResponses(main, undefined, true).peers, undefined, 'in flight');
    const failed = D.mergeResponses(main, null, true);
    assert.equal(failed.peers, null);
    assert.equal(failed.peersFailed, true);
    assert.equal(D.mergeResponses(main, { disabled: true }, true).peers, null);
    const both = D.mergeResponses(main, peersResponse(), true);
    assert.equal(both.peers.peers.length, 3);
    assert.equal(both.library, main.library);
    assert.equal(both.network, main.network);
  });
  test('peers landing first lend their seeds while the library loads', () => {
    const partial = D.mergeResponses(undefined, peersResponse(), true);
    assert.equal(partial.partial, true);
    assert.equal(partial.library, undefined);
    assert.equal(partial.seeds.length, LIB_SEEDS.length);
    assert.equal(D.stateOf(partial, FLAGS).sources.library.status, 'loading');
    assert.equal(D.stateOf(partial, FLAGS).sources.peers.status, 'ready');
  });
});

// ── seeds ─────────────────────────────────────────────────────────────

describe('seedChips and seedsLine', () => {
  test('history: chips, the playing pin, the overflow, the sheet details', () => {
    const r = historyResponse();
    const out = collect(D.seedChips(r, { nowPlaying: '/Music/ALM/Manor.flac', now: NOW }));
    assert.equal(out.total, 9);
    assert.equal(out.chips.length, D.SEED_CHIPS_MAX);
    assert.equal(out.overflow, 2);
    assert.deepEqual(out.more, { key: 'dpage.seeds.more', params: { count: 2 } });
    assert.equal(out.hidden.length, 2);
    const [pin, first] = out.chips;
    assert.deepEqual(pin.label, { key: 'dpage.seeds.chip', params: { title: 'Manor', artist: 'ALM' } });
    assert.equal(pin.tag.key, 'dpage.seeds.playing');
    assert.equal(pin.action, 'unpin');
    assert.equal(pin.art, 'hp.jpg');
    assert.equal(first.tag, null);
    assert.equal(first.action, 'drop');
    assert.equal(first.hash, 'h1');
    assert.deepEqual(first.detail, [{ key: 'dpage.ago.today', params: {} }, { key: 'dpage.seeds.plays', params: { count: 3 } }]);
    // Another pin (not the song playing) reads "picked".
    assert.equal(D.seedChips(r, { nowPlaying: 'Music/other.mp3' }).chips[0].tag.key, 'dpage.seeds.picked');
    assert.equal(D.seedChips(r, { max: 0 }).overflow, 9);
  });

  test('a seed without a title or artist, a listened-to seed, an un-analyzed one', () => {
    const r = historyResponse({
      seeds: [
        seed('x1', 'ignored', 'ignored', { metadata: { title: '', artist: '' }, filepath: 'Music/dir/file name.mp3', outcome: 'stopped' }),
        seed('x2', 'Pending', 'Artist', { analyzed: false }),
      ],
    });
    const { chips } = collect(D.seedChips(r, { now: NOW }));
    assert.deepEqual(chips[0].label, { key: 'dpage.seeds.chipTitle', params: { title: 'file name.mp3' } });
    assert.ok(chips[0].detail.some((d) => d.key === 'dpage.seeds.listenedTo'));
    assert.equal(chips[1].analyzed, false);
    assert.equal(chips[1].tag.key, 'dpage.seeds.notAnalyzed');
  });

  test('the line: finished, listened, + picked, the window', () => {
    const line = collect(D.seedsLine(historyResponse()));
    assert.equal(line.key, 'dpage.seeds.finished');
    assert.deepEqual(line.params, { count: 8 });
    assert.deepEqual(line.parts.map((p) => p.key), ['dpage.seeds.finished', 'dpage.seeds.plusPicked', 'dpage.window.last']);
    assert.deepEqual(line.parts[2].params, { count: 30 });
    const stopped = collect(D.seedsLine(historyResponse({ seeds: [seed('a', 'A', 'B', { outcome: 'stopped' }), seed('b', 'C', 'D')], window: 0 })));
    assert.equal(stopped.key, 'dpage.seeds.listened');
    assert.deepEqual(stopped.parts.map((p) => p.key), ['dpage.seeds.listened', 'dpage.window.all']);
  });

  test('widened: the requested window held nothing', () => {
    const line = collect(D.seedsLine(historyResponse({ seeds: HISTORY.slice(0, 3), window: 0, widenedFrom: 30 })));
    assert.equal(line.key, 'dpage.seeds.widened');
    assert.deepEqual(line.params, { count: 3, from: 30 });
    assert.equal(line.parts.length, 1, 'the window is in the phrase');
  });

  test('random, counters, pins only, nothing', () => {
    const random = historyResponse({ seedSource: 'random', fallback: true, seeds: [seed('r', 'Rand', 'Om', { outcome: null, plays: null, lastPlayed: null })] });
    assert.equal(collect(D.seedsLine(random)).key, 'dpage.seeds.random');
    const chip = collect(D.seedChips(random)).chips[0];
    assert.equal(chip.tag.key, 'dpage.seeds.randomTag');
    assert.equal(chip.action, null, 'the random pick has no ×');
    assert.deepEqual(chip.detail, []);
    assert.equal(D.seedsLine(historyResponse({ seedSource: 'random', seeds: [] })).key, 'dpage.seeds.none');
    const counters = collect(D.seedsLine(historyResponse({ seedSource: 'counters', widenedFrom: 30, seeds: HISTORY.slice(0, 2).map((s) => ({ ...s, outcome: null })) })));
    assert.deepEqual([counters.key, counters.params, counters.parts.length], ['dpage.seeds.counters', { count: 2 }, 1]);
    const pinned = collect(D.seedsLine(historyResponse({ seedSource: 'pinned', seeds: [PIN] })));
    assert.deepEqual([pinned.key, pinned.params, pinned.parts.length], ['dpage.seeds.pinned', { count: 1 }, 1]);
    assert.equal(D.seedsLine(undefined), null);
    assert.equal(D.seedsLine({ disabled: true }), null);
  });

  test('excluded seeds come back as chips for the seeds sheet', () => {
    const r = historyResponse({ excluded: [{ hash: 'k1', filepath: 'Music/kids.mp3', metadata: { title: 'Kids’ song', artist: 'Artist X' } }] });
    const { excluded } = collect(D.seedChips(r));
    assert.deepEqual(excluded, [{
      hash: 'k1', filepath: 'Music/kids.mp3', title: 'Kids’ song', artist: 'Artist X', art: null,
      label: { key: 'dpage.seeds.chip', params: { title: 'Kids’ song', artist: 'Artist X' } }, tag: { key: 'dpage.seeds.dropped', params: {} },
    }]);
  });
});

// ── library ───────────────────────────────────────────────────────────

describe('librarySections', () => {
  test('albums before songs, with the card fields renderAlbum takes', () => {
    const out = collect(D.librarySections(historyResponse(), { now: NOW }));
    assert.equal(out.filter, 'fresh');
    assert.equal(out.provisional, false);
    assert.equal(out.count, 6);
    const [a1, a3] = out.albums;
    assert.deepEqual(
      { name: a1.name, artistLine: a1.artistLine, albumArtist: a1.albumArtist, year: a1.year, albumArtFile: a1.albumArtFile, similarityPct: a1.similarityPct, trackPaths: a1.trackPaths },
      { name: 'Album 1', artistLine: 'Artist F, Guest', albumArtist: null, year: 2019, albumArtFile: 'Album 1.jpg', similarityPct: 84, trackPaths: ['Music/Album 1/01.flac', 'Music/Album 1/02.flac'] },
    );
    assert.deepEqual(a1.playedLabel, { key: 'dpage.album.neverPlayed', params: { count: 11 } });
    assert.equal(a1.lastPlayedLabel, null);
    assert.deepEqual(a1.because, { key: 'dpage.because.finished', params: { title: 'One' } });
    assert.equal(a3.artistLine, 'Artist G');
    assert.equal(a3.albumArtist, 'Artist G');
    assert.deepEqual(a3.playedLabel, { key: 'dpage.album.somePlayed', params: { played: 2, count: 12 } });
    assert.deepEqual(a3.lastPlayedLabel, { key: 'dpage.when.months', params: { count: 6 } });
  });

  test('song rows: subtitle, match, when, because', () => {
    const { tracks } = collect(D.librarySections(historyResponse(), { now: NOW }));
    assert.equal(tracks.length, 4);
    const [t7, t8, t9, t10] = tracks;
    assert.equal(t7.filepath, 'Music/T/7.mp3');
    assert.equal(t7.title, 'Title 7');
    assert.equal(t7.subtitle, 'Artist J · Album 7 · Synthwave');
    assert.equal(t7.similarityPct, 77);
    assert.equal(t7.length, '4:11');
    assert.deepEqual(t7.whenLabel, { key: 'dpage.when.never', params: {} });
    assert.deepEqual(t7.agoLabel, { key: 'dpage.ago.never', params: {} });
    assert.deepEqual(t7.because, { key: 'dpage.because.finished', params: { title: 'Two' } });
    assert.equal(t7.metadata.album, 'Album 7');
    assert.deepEqual(t8.whenLabel, { key: 'dpage.when.months', params: { count: 8 } });
    assert.deepEqual(t8.agoLabel, { key: 'dpage.ago.months', params: { count: 8 } });
    assert.deepEqual(t8.because, { key: 'dpage.because.picked', params: { title: 'Manor' } });
    assert.equal(t9.title, '9.mp3', 'no title → the file name');
    assert.equal(t9.subtitle, 'Album 8');
    assert.deepEqual(t10.whenLabel, { key: 'dpage.when.undated', params: {} }, 'a play without a date is not "never"');
    assert.equal(t10.because, null, 'a seedHash that names no seed');
  });

  test('fresh vs all: the headings follow the filter the rows were chosen by', () => {
    const fresh = collect(D.librarySections(historyResponse()));
    assert.deepEqual([fresh.headings.sub.key, fresh.headings.albums.key, fresh.headings.tracks.key], ['dpage.library.subFresh', 'dpage.library.albums', 'dpage.library.songsFresh']);
    const r = historyResponse();
    r.library = { ...r.library, filter: 'all' };
    const all = collect(D.librarySections(r));
    assert.deepEqual([all.headings.sub.key, all.headings.albums.key, all.headings.tracks.key], ['dpage.library.subAll', 'dpage.library.albumsAll', 'dpage.library.songsAll']);
    assert.equal(all.provisional, false);
    r.library = { ...r.library, filter: 'unplayed' };
    assert.equal(collect(D.librarySections(r)).headings.tracks.key, 'dpage.library.songsUnplayed');
  });

  test('a stricter filter tapped while the re-ask runs narrows the looser answer', () => {
    const r = historyResponse();
    r.library = { ...r.library, filter: 'all' };
    const unplayed = D.librarySections(r, { filter: 'unplayed', now: NOW });
    assert.equal(unplayed.provisional, true);
    assert.deepEqual(unplayed.tracks.map((t) => t.filepath), ['Music/T/7.mp3', 'Music/T/9.mp3']);
    assert.deepEqual(unplayed.albums.map((a) => a.name), ['Album 1']);
    // fresh, 90 days: the 8-month-old play and the 200-day album pass; the
    // undated play does not (the server's rule for a legacy counter).
    const fresh = D.librarySections(r, { filter: 'fresh', staleDays: 90, now: NOW });
    assert.deepEqual(fresh.tracks.map((t) => t.filepath), ['Music/T/7.mp3', 'Music/T/8.mp3', 'Music/T/9.mp3']);
    assert.deepEqual(fresh.albums.map((a) => a.name), ['Album 1', 'Album 3']);
    const strict = D.librarySections(r, { filter: 'fresh', staleDays: 365, now: NOW });
    assert.deepEqual(strict.tracks.map((t) => t.filepath), ['Music/T/7.mp3', 'Music/T/9.mp3']);
    // A looser filter cannot add rows: kept as they are, provisional.
    const looser = D.librarySections(historyResponse(), { filter: 'all' });
    assert.equal(looser.provisional, true);
    assert.equal(looser.tracks.length, 4);
    assert.equal(looser.headings.tracks.key, 'dpage.library.songsAll');
  });

  test('the overview share and the footer', () => {
    const out = collect(D.librarySections(historyResponse(), { maxAlbums: 1, maxTracks: 3 }));
    assert.equal(out.albums.length, 1);
    assert.equal(out.tracks.length, 3);
    assert.equal(out.count, 6, 'the count is the whole section');
    assert.equal(out.footer.queueAll, 4);
    assert.deepEqual(out.footer.queueAllLabel, { key: 'dpage.verb.queueAll', params: { count: 4 } });
    assert.deepEqual(out.footer.paths, ['Music/T/7.mp3', 'Music/T/8.mp3', 'Music/T/9.mp3', 'Music/T/10.mp3']);
    assert.equal(out.footer.more, 1);
    assert.deepEqual(out.footer.moreLabel, { key: 'dpage.library.moreUnderSeeAll', params: { count: 1 } });
    assert.deepEqual(out.footer.summary, [{ key: 'dpage.count.albums', params: { count: 2 } }, { key: 'dpage.count.songs', params: { count: 4 } }]);
    assert.equal(D.librarySections(historyResponse()).footer.moreLabel, null);
  });

  test('no library section → empty, never a throw', () => {
    for (const r of [undefined, null, { disabled: true }, historyResponse({ library: null })]) {
      const out = D.librarySections(r);
      assert.deepEqual([out.albums, out.tracks, out.count, out.footer.queueAll], [[], [], 0, 0]);
    }
  });
});

describe('agoLabel', () => {
  const at = (days, family) => D.agoLabel(ago(days), NOW, family);
  test('boundaries: today, days, months (never 12), years', () => {
    assert.deepEqual(at(0), { key: 'dpage.ago.today', params: {} });
    assert.deepEqual(at(23 / 24), { key: 'dpage.ago.today', params: {} });
    assert.deepEqual(at(1), { key: 'dpage.ago.days', params: { count: 1 } });
    assert.deepEqual(at(29.9), { key: 'dpage.ago.days', params: { count: 29 } });
    assert.deepEqual(at(30), { key: 'dpage.ago.months', params: { count: 1 } });
    assert.deepEqual(at(59), { key: 'dpage.ago.months', params: { count: 1 } });
    assert.deepEqual(at(60), { key: 'dpage.ago.months', params: { count: 2 } });
    assert.deepEqual(at(364), { key: 'dpage.ago.months', params: { count: 11 } });
    assert.deepEqual(at(365), { key: 'dpage.ago.years', params: { count: 1 } });
    assert.deepEqual(at(729), { key: 'dpage.ago.years', params: { count: 1 } });
    assert.deepEqual(at(730), { key: 'dpage.ago.years', params: { count: 2 } });
  });
  test('never, the future, other inputs, the families', () => {
    for (const v of [null, undefined, '', 'not a date']) { assert.deepEqual(D.agoLabel(v, NOW), { key: 'dpage.ago.never', params: {} }); }
    assert.deepEqual(D.agoLabel(new Date(NOW + DAY).toISOString(), NOW), { key: 'dpage.ago.today', params: {} });
    assert.deepEqual(D.agoLabel(NOW - 3 * DAY, new Date(NOW)), { key: 'dpage.ago.days', params: { count: 3 } });
    assert.equal(at(3, 'dpage.when').key, 'dpage.when.days');
    assert.equal(at(3, 'dpage.seen').key, 'dpage.seen.days');
    assert.equal(D.agoLabel(null, NOW, 'dpage.seen').key, 'dpage.seen.never');
    assert.equal(D.agoLabel(ago(0), undefined).key, 'dpage.ago.today', 'now defaults to the clock');
  });
});

// ── network, peers, jobs ──────────────────────────────────────────────

// The batch route, answered by the registry's own keys: results aligned
// with the recommendations, each with the jobs under any of its keys.
function batchAnswer(recs, jobs) {
  return recs.map((rec) => {
    const keys = plugins.jobKeysFor(plugins.recommendationSchema.validate(rec).value);
    const own = new Set(Object.values(keys));
    return { key: keys.song, keys, jobs: jobs.filter((j) => own.has(j.key)) };
  });
}
const keysOfRec = (rec) => plugins.jobKeysFor(plugins.recommendationSchema.validate(rec).value);

// A stub DISCOVERJOBS: just enough to see what jobBadges hands it.
const STUB = {
  jobSlot: (plugin, scope) => (!scope || scope === 'song' ? plugin : `${plugin}@${scope}`),
  jobScope: (job) => (job.params && job.params.scope) || 'song',
  jobsBySlot(jobs) {
    const out = {};
    for (const j of jobs) { const s = this.jobSlot(j.plugin, this.jobScope(j)); if (!out[s]) { out[s] = j; } }
    return out;
  },
  jobRowState: (job, { plugin }) => ({ state: job.state, tag: `stub.${job.state}`, plugin, live: job.state === 'running' || job.state === 'queued' }),
  jobKind: (job) => ((job.params && job.params.scope) === 'album' ? 'discover.tray.kindAlbum' : null),
};

describe('networkRows', () => {
  test('raw rows kept as the route stamped them, plus what a row draws', () => {
    const r = historyResponse();
    const net = collect(D.networkRows(r));
    assert.equal(net.count, 3);
    assert.deepEqual(net.line, { key: 'dpage.network.searched', params: { count: 3 } });
    const [n1, n2, n3] = net.rows;
    assert.equal(n1.raw, r.network.results[0], 'the very object — openDiscoverModal(raw, "p2p")');
    assert.equal(n1.raw.source, 'p2p');
    assert.equal('seedIndex' in n1.raw, false);
    assert.equal(n1.source, 'p2p');
    assert.equal(n1.title, 'Lead One');
    assert.equal(n1.subtitle, 'Artist M · Album N1 · 2022');
    assert.equal(n1.similarityPct, 81);
    assert.equal(n1.length, '3:20');
    assert.equal(n1.seedHash, 'h1');
    assert.deepEqual(n1.because, { key: 'dpage.because.finished', params: { title: 'One' } });
    assert.equal(n1.matchSeed, 'One', 'the window\'s match bar names the seed this lead was matched against');
    assert.deepEqual(n1.onLabel, { key: 'dpage.network.onServer', params: { name: 'Peer One' } });
    assert.equal(n1.newArtist, false);
    assert.equal(n2.onLabel, null);
    assert.equal(n2.subtitle, 'Artist N · Album N2');
    assert.equal(n2.length, '');
    assert.equal(n3.length, '1:02:05');
    assert.equal(n3.seedHash, null);
    assert.equal(n3.because, null);
    assert.equal(n3.matchSeed, null);
    for (const row of net.rows) { assert.equal(plugins.recommendationSchema.validate(row.raw).error, undefined, 'still a sendable recommendation'); }
  });

  test('the new-artist hint when a row carries one; nothing for an absent section', () => {
    const r = historyResponse({ network: { results: [{ ...historyResponse().network.results[0], newArtist: true }], searched: { peers: 1, tracks: 10 } } });
    const row = collect(D.networkRows(r)).rows[0];
    assert.equal(row.newArtist, true);
    assert.deepEqual(row.newArtistLabel, { key: 'dpage.network.newArtist', params: {} });
    assert.deepEqual(D.networkRows(historyResponse({ network: null })), { rows: [], count: 0, searched: null, line: null });
    assert.equal(D.networkRows(undefined).rows.length, 0);
  });
});

describe('peerGroups', () => {
  test('one group per peer, answering first, rows raw and playable', () => {
    const r = peersResponse();
    const out = collect(D.peerGroups(r, { now: NOW }));
    assert.equal(out.count, 3);
    assert.deepEqual(out.searched, { peers: 1, unreachable: 1, mismatched: 1 });
    assert.deepEqual(out.line, { key: 'dpage.peers.answered', params: { answered: 1, count: 3 } });
    assert.deepEqual(out.groups.map((g) => g.name), ['Sam’s server', 'peer C', 'peer B']);
    const [sam, cee, bee] = out.groups;
    assert.equal(sam.playable, true);
    assert.ok(sam.rows.every((row) => row.matchSeed === null), 'a peers row is matched against the centroid');
    assert.deepEqual(sam.stateLabel, { key: 'dpage.peers.online', params: {} });
    assert.equal(sam.lastSeenLabel, null);
    assert.deepEqual(sam.countLabel, { key: 'dpage.count.songs', params: { count: 3 } });
    assert.deepEqual(cee.stateLabel, { key: 'dpage.peers.mismatched', params: {} });
    assert.equal(cee.playable, false);
    assert.deepEqual(bee.stateLabel, { key: 'dpage.peers.notAnswering', params: {} });
    assert.deepEqual(bee.lastSeenLabel, { key: 'dpage.seen.days', params: { count: 2 } });
    const row = sam.rows[0];
    assert.equal(row.raw, r.peers.peers[1].results[0], 'the very object — queueDiscoverFed(raw)');
    assert.equal(row.raw.source, 'federation');
    assert.equal(row.raw.seedHash, null);
    assert.deepEqual([row.peerId, row.peerName, row.filepath, row.playable], [1, 'Sam’s server', 'music/q/P1.mp3', true]);
    assert.equal(row.subtitle, 'Artist Q · Album P1 · 2020');
    assert.equal(row.length, '4:03');
    assert.deepEqual(D.peerRowsOf(out.groups).map((x) => x.title), ['P1', 'P2', 'P3']);
  });

  test('an absent section', () => {
    assert.deepEqual(D.peerGroups(historyResponse()), { groups: [], count: 0, searched: null, line: null });
    assert.deepEqual(D.peerGroups(undefined).groups, []);
  });
});

describe('jobBadges', () => {
  const r = historyResponse();
  const net = D.networkRows(r).rows;
  const k0 = keysOfRec(net[0].raw);
  const k1 = keysOfRec(net[1].raw);
  const job = (id, key, state, over) => ({ id, plugin: 'youtube', key, state, params: {}, ...over });

  test('the batch answer sets each row’s keys and its badge (stub DISCOVERJOBS)', () => {
    const jobs = [job(5, k0.song, 'done'), job(7, k0.song, 'running'), job(3, k1.album, 'failed', { plugin: 'federation-copy', params: { scope: 'album' } })];
    const chunks = D.lookupChunks(net);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0][0], net[0].raw, 'the lookup sends the raw rows');
    const rows = D.jobBadges(net, { results: batchAnswer(chunks[0], jobs) }, STUB);
    assert.equal(rows[0].recKey, k0.song);
    assert.ok(rows[0].recKeys.includes(k0.album));
    assert.equal(rows[0].jobs.youtube.id, 5, 'jobsBySlot keeps the first per slot, as the server orders them');
    assert.deepEqual(rows[0].badge, { state: 'done', tag: 'stub.done', plugin: 'youtube', live: false, slot: 'youtube', scope: 'song', kind: null, jobId: 5 });
    assert.equal(rows[1].badge.slot, 'federation-copy@album');
    assert.equal(rows[1].badge.kind, 'discover.tray.kindAlbum');
    assert.equal(rows[2].badge, null);
    assert.deepEqual(rows[2].jobs, {});
    assert.equal(rows[0].raw, net[0].raw, 'the raw row survives');
    assert.equal(net[0].badge, null, 'the input rows are not mutated');
  });

  test('a flat job list (the poll) merges by key: newer wins, live outranks finished, cancelled shows nothing', () => {
    const first = D.jobBadges(net, batchAnswer(net.map((x) => x.raw), [job(5, k0.song, 'done')]), STUB);
    const polled = D.jobBadges(first, { jobs: [job(9, k0.song, 'queued'), job(4, k0.song, 'running'), job(11, 'text:other', 'running')] }, STUB);
    assert.equal(polled[0].jobs.youtube.id, 9);
    assert.equal(polled[0].badge.state, 'queued');
    assert.equal(polled[0].badge.live, true);
    assert.equal(D.anyLiveBadge(polled), true);
    assert.equal(polled[1].badge, null, 'another row’s job stays off this one');
    // Two slots: the live copy outranks the finished download.
    const two = D.jobBadges(first, { jobs: [job(12, k0.album, 'running', { plugin: 'federation-copy', params: { scope: 'album' } })] }, STUB);
    assert.equal(two[0].badge.slot, 'federation-copy@album');
    // A failure outranks a finished job; a cancelled one is no badge.
    const failed = D.jobBadges(first, { jobs: [job(13, k0.artist, 'failed', { params: { scope: 'artist' } })] }, STUB);
    assert.equal(failed[0].badge.state, 'failed');
    const cancelled = D.jobBadges(net, batchAnswer(net.map((x) => x.raw), [job(6, k0.song, 'cancelled')]), STUB);
    assert.equal(cancelled[0].badge, null);
    assert.equal(D.anyLiveBadge(cancelled), false);
    // Rows that never had a lookup have no keys: the poll leaves them alone.
    assert.equal(D.jobBadges(net, { jobs: [job(1, k0.song, 'running')] }, STUB)[0].badge, null);
  });

  test('without DISCOVERJOBS: keys still land, no badge', () => {
    const rows = D.jobBadges(net, batchAnswer(net.map((x) => x.raw), [job(5, k0.song, 'done')]));
    assert.equal(rows[0].recKey, k0.song);
    assert.equal(rows[0].badge, null);
  });

  test('with the real DISCOVERJOBS: the badge is the job row the window would show', () => {
    const peerRows = D.peerRowsOf(D.peerGroups(peersResponse()).groups);
    const kp = keysOfRec(peerRows[0].raw);
    const copying = {
      id: 21, plugin: 'federation-copy', key: kp.album, state: 'running', progress: 0.25, statusText: '2 of 7 songs',
      params: { scope: 'album' }, cancelRequested: false,
    };
    const rows = collect(D.jobBadges(peerRows, batchAnswer(peerRows.map((x) => x.raw), [copying]), J));
    const b = rows[0].badge;
    assert.equal(b.state, 'running');
    assert.equal(b.tag, 'discover.job.copying');
    assert.deepEqual(b.sub, { text: '2 of 7 songs · 25%' });
    assert.equal(b.kind, 'discover.tray.kindAlbum');
    assert.deepEqual(b.actions, ['cancel']);
    assert.equal(rows[1].badge.jobId, 21, 'two songs of one album share the album job');
    assert.equal(rows[2].badge, null, 'another album: nothing');
  });

  test('lookups go in chunks of 100', () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ raw: { title: `t${i}`, source: 'p2p' } }));
    assert.deepEqual(D.lookupChunks(many).map((c) => c.length), [100, 100, 30]);
    assert.deepEqual(D.lookupChunks([{ raw: null }, {}]), []);
  });
});

// ── states ────────────────────────────────────────────────────────────

describe('stateOf', () => {
  const merged = (over, peers) => D.mergeResponses(historyResponse(over), peers === undefined ? peersResponse() : peers, true);

  test('off: flags, or the route said 403', () => {
    for (const flags of [{}, { ...FLAGS, discovery: false }, { ...FLAGS, discoveryTaste: 0 }]) {
      const s = collect(D.stateOf(merged(), flags));
      assert.equal(s.state, 'off');
      assert.deepEqual(s.reason, { key: 'dpage.state.off', params: {} });
      assert.deepEqual(s.tabs, []);
    }
    assert.equal(D.stateOf({ disabled: true }, FLAGS).state, 'off');
  });

  test('loading and failed', () => {
    const loading = D.stateOf(undefined, FLAGS);
    assert.equal(loading.state, 'loading');
    assert.deepEqual(Object.values(loading.sources).map((x) => x.status), ['loading', 'loading', 'loading']);
    assert.deepEqual(D.stateOf(undefined, { ...FLAGS, discoveryP2p: false }).sources.network.status, 'absent');
    const failed = collect(D.stateOf(null, FLAGS));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason.key, 'dpage.state.failed');
    assert.equal(failed.sources.library.status, 'failed');
  });

  test('ready, with counts and tabs', () => {
    const s = D.stateOf(merged(), FLAGS);
    assert.equal(s.state, 'ready');
    assert.equal(s.reason, null);
    assert.deepEqual(s.tabs.map((t) => [t.key, t.count, t.status]), [['library', 6, 'ready'], ['network', 3, 'ready'], ['peers', 3, 'ready']]);
    assert.deepEqual(s.tabs[1].label, { key: 'dpage.tab.network', params: {} });
    assert.equal(D.pickSource('peers', s.tabs), 'peers');
    assert.equal(D.pickSource('peers', s.tabs.slice(0, 2)), 'library');
    assert.equal(D.pickSource('x', []), 'library');
  });

  test('scanPending: no seed analyzed — the sources wait, the seeds are listed', () => {
    const r = merged({
      notAnalyzed: true, seeds: HISTORY.map((x) => ({ ...x, analyzed: false })),
      library: { filter: 'fresh', tracks: [], albums: [], capped: false }, network: { results: [], searched: { peers: 0, tracks: 0 } },
    }, { ...peersResponse(), peers: { peers: [], searched: { peers: 0, unreachable: 0, mismatched: 0 } } });
    const s = collect(D.stateOf(r, FLAGS));
    assert.equal(s.state, 'scanPending');
    assert.equal(s.reason.key, 'dpage.state.scanPending');
    for (const k of ['library', 'network', 'peers']) {
      assert.equal(s.sources[k].status, 'empty');
      assert.equal(s.sources[k].reason.key, 'dpage.source.waitingForScan');
    }
  });

  test('nothingFinished: a random seed — or every finished song dropped', () => {
    const random = { seedSource: 'random', fallback: true, network: null, seeds: [seed('r', 'R', 'A', { outcome: null })] };
    const s = collect(D.stateOf(merged(random, { ...peersResponse(), peers: null }), FLAGS));
    assert.equal(s.state, 'nothingFinished');
    assert.equal(s.reason.key, 'dpage.state.nothingFinished');
    assert.equal(s.sources.network.status, 'absent', 'no fan-outs for a random seed: not drawn');
    assert.equal(s.sources.peers.status, 'absent');
    assert.deepEqual(s.tabs.map((t) => t.key), ['library']);
    const dropped = collect(D.stateOf(merged({ ...random, excluded: [{ hash: 'h1', filepath: 'x', metadata: {} }] }, null), FLAGS));
    assert.equal(dropped.reason.key, 'dpage.state.allDropped');
    assert.equal(dropped.sources.peers.status, 'failed');
  });

  test('each source explains its own emptiness', () => {
    const emptyLib = (filter) => ({ library: { filter, tracks: [], albums: [], capped: false } });
    const lib = (filter, opts) => collect(D.stateOf(merged(emptyLib(filter)), FLAGS, opts)).sources.library.reason;
    assert.deepEqual(lib('unplayed', { staleDays: 60 }), { key: 'dpage.library.allPlayed', params: { count: 60 } });
    assert.deepEqual(lib('unplayed'), { key: 'dpage.library.allPlayed', params: { count: 90 } });
    assert.equal(lib('fresh').key, 'dpage.library.allPlayedFresh');
    assert.equal(lib('all').key, 'dpage.library.nothing');

    const net = (searchedPeers) => collect(D.stateOf(merged({ network: { results: [], searched: { peers: searchedPeers, tracks: 0 } } }), FLAGS)).sources.network;
    assert.deepEqual([net(0).status, net(0).reason.key], ['empty', 'dpage.network.warmingUp']);
    assert.equal(net(3).reason.key, 'dpage.network.nothingNew');

    const peers = (groups) => collect(D.stateOf(merged({}, { ...peersResponse(), peers: { peers: groups, searched: {} } }), FLAGS)).sources.peers.reason.key;
    assert.equal(peers([]), 'dpage.peers.none');
    assert.equal(peers([{ ...BEE, reachable: false, mismatched: false, results: [] }]), 'dpage.peers.unreachable');
    assert.equal(peers([{ ...CEE, reachable: true, mismatched: true, results: [] }]), 'dpage.peers.allMismatched');
    assert.equal(peers([{ ...SAM, reachable: true, mismatched: false, results: [] }, { ...BEE, reachable: false, results: [] }]), 'dpage.peers.nothingNew');
  });

  test('a source still in flight, a source not drawn', () => {
    const s = D.stateOf(D.mergeResponses(historyResponse(), undefined, true), FLAGS);
    assert.equal(s.sources.peers.status, 'loading');
    assert.equal(s.tabs.find((t) => t.key === 'peers').status, 'loading');
    const noFed = D.stateOf(D.mergeResponses(historyResponse(), undefined, false), { ...FLAGS, federationDiscovery: false });
    assert.equal(noFed.sources.peers.status, 'absent');
    assert.deepEqual(noFed.tabs.map((t) => t.key), ['library', 'network']);
  });
});

// ── prefs and option lists ────────────────────────────────────────────

describe('prefs', () => {
  test('defaults', () => {
    assert.deepEqual(D.defaultPrefs(), { window: 30, filter: 'fresh', staleDays: 90, exclude: [], newArtistsOnly: false, persisted: false });
    assert.deepEqual(D.mergePrefs(null, null), D.defaultPrefs());
  });

  test('a persisting server is the truth; local fills only the gaps and newArtistsOnly', () => {
    const saved = { window: 7, filter: 'all', staleDays: 30, exclude: ['a', 'b'], persisted: true };
    const local = { window: 90, filter: 'unplayed', staleDays: 400, exclude: ['z'], newArtistsOnly: true };
    assert.deepEqual(D.mergePrefs(saved, local), { window: 7, filter: 'all', staleDays: 30, exclude: ['a', 'b'], newArtistsOnly: true, persisted: true });
    assert.deepEqual(D.mergePrefs({ persisted: true, window: 'junk' }, { window: 0 }).window, 0, 'local fills an invalid server value');
  });

  test('public-access mode (persisted: false) or no answer: this browser wins over the defaults', () => {
    const local = { window: 0, filter: 'unplayed', staleDays: 400, exclude: ['z'] };
    assert.deepEqual(D.mergePrefs({ window: 30, filter: 'fresh', staleDays: 90, exclude: [], persisted: false }, local),
      { window: 0, filter: 'unplayed', staleDays: 400, exclude: ['z'], newArtistsOnly: false, persisted: false });
    assert.deepEqual(D.mergePrefs(null, local).window, 0);
    assert.deepEqual(D.mergePrefs(null, { window: 14, filter: 'x', staleDays: 0, exclude: 'no' }), D.defaultPrefs(), 'invalid values fall to the defaults');
  });

  test('the stored copy round-trips and never throws', () => {
    const p = { window: 90, filter: 'all', staleDays: 120, exclude: ['a', 'a', 'b'], newArtistsOnly: true, persisted: true };
    const raw = D.serializePrefs(p);
    assert.deepEqual(JSON.parse(raw), { window: 90, filter: 'all', staleDays: 120, exclude: ['a', 'b'] });
    assert.deepEqual(D.parseStoredPrefs(raw), { window: 90, filter: 'all', staleDays: 120, exclude: ['a', 'b'] });
    for (const bad of [null, '', '{', 'null', '[1]', '42']) { assert.deepEqual(D.parseStoredPrefs(bad), {}); }
  });

  test('drop and restore a seed', () => {
    const full = { exclude: Array.from({ length: 200 }, (_, i) => `s${i}`) };
    const dropped = D.dropSeed(full, 'new');
    assert.equal(dropped.exclude.length, 200);
    assert.equal(dropped.exclude[199], 'new');
    assert.equal(dropped.exclude[0], 's1');
    assert.deepEqual(D.dropSeed({ exclude: ['a', 'b'] }, 'a').exclude, ['b', 'a'], 'a re-drop moves it to the newest end');
    assert.deepEqual(D.restoreSeed({ exclude: ['a', 'b'] }, 'a').exclude, ['b']);
    assert.deepEqual(D.dropSeed(null, 'h').exclude, ['h']);
    assert.equal(full.exclude.length, 200, 'not mutated');
  });

  test('window and filter options, the plug-in chips', () => {
    const w = collect(D.windowOptions(90));
    assert.deepEqual(w.map((o) => [o.value, o.label.key, o.selected]), [[7, 'dpage.window.days', false], [30, 'dpage.window.days', false], [90, 'dpage.window.days', true], [0, 'dpage.window.all', false]]);
    const f = collect(D.filterOptions('fresh', 45));
    assert.deepEqual(f.map((o) => o.value), ['unplayed', 'fresh', 'all']);
    assert.deepEqual(f[1].label, { key: 'dpage.filter.fresh', params: { count: 45 } });
    assert.equal(f[1].selected, true);
    assert.deepEqual(collect(D.windowLabel(30)), { key: 'dpage.window.last', params: { count: 30 } });
    assert.equal(D.windowLabel(14), null);
    const list = [
      { name: 'deezer', title: 'Deezer', capabilities: ['preview'] },
      { name: 'youtube', title: 'YouTube', capabilities: ['acquire', 'lookup'] },
      { name: 'links', title: '', capabilities: ['links'] },
      { name: 'federation-copy', title: 'Copy', capabilities: ['acquire'] },
    ];
    assert.deepEqual(collect(D.pluginChips(list, true)).map((c) => [c.key, c.title]),
      [['dpage.plugins.preview', 'Deezer'], ['dpage.plugins.getIt', 'YouTube'], ['dpage.plugins.links', 'links']]);
    assert.deepEqual(D.pluginChips(list, false).map((c) => c.key), ['dpage.plugins.preview', 'dpage.plugins.links'], 'Get it needs jobs.allowed');
  });
});

// ── i18n ──────────────────────────────────────────────────────────────

describe('every key the page emits has an English value', () => {
  const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

  test('the labels the tests above produced: present, plural where counted, placeholders filled', () => {
    assert.ok(EMITTED.length > 80, `collected ${EMITTED.length}`);
    for (const { key, params } of EMITTED) {
      const val = EN[key];
      assert.ok(val !== undefined, `${key} missing from en.json`);
      const p = params || {};
      const forms = typeof val === 'object' ? [val.one, val.other] : [val];
      if (typeof val === 'object') {
        assert.equal(typeof p.count, 'number', `${key} is plural but was emitted without a count`);
        assert.ok(typeof val.one === 'string' && typeof val.other === 'string', `${key} needs one and other`);
      }
      for (const form of forms) {
        for (const name of placeholders(form)) { assert.ok(name in p, `${key}: {{${name}}} has no param`); }
      }
    }
  });

  test('every literal dpage key in the module, and every relative-time family', () => {
    const literals = [...new Set([...SOURCE.matchAll(/'(dpage\.[A-Za-z.]+[A-Za-z])'/g)].map((m) => m[1]))]
      .filter((k) => !['dpage.ago', 'dpage.when', 'dpage.seen'].includes(k));
    assert.ok(literals.length > 60);
    for (const key of literals) { assert.ok(EN[key] !== undefined, `${key} missing from en.json`); }
    for (const fam of ['dpage.ago', 'dpage.when', 'dpage.seen']) {
      for (const suffix of ['never', 'today', 'days', 'months', 'years']) { assert.ok(EN[`${fam}.${suffix}`] !== undefined, `${fam}.${suffix}`); }
    }
    for (const fam of ['dpage.ago', 'dpage.when']) { assert.ok(EN[`${fam}.undated`] !== undefined); }
    for (const s of D.SOURCES) { assert.ok(EN[`dpage.tab.${s}`] !== undefined); }
  });

  test('the nav entry and the panel title', () => {
    assert.equal(EN['nav.discover'], 'Discover');
    assert.equal(EN['panel.discover'], 'Discover');
  });
});
