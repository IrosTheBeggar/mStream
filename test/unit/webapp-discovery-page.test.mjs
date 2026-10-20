/**
 * webapp/alpha/discovery-page.js — the Discover page's pure half, on node:
 * the request bodies of both pages (play: library + the peers call;
 * explore: network — flags drop sources, pins lose their leading '/', the
 * visit's dropped seeds travel as exclude, caps hold), the stored window
 * and the visit's drop list, the seed chips, the library's album cards and
 * song rows, the connected servers' song rows and album cards, the labels
 * and the "Show more" column slicing, the network rows (raw rows kept for
 * the recommendation window, jobs badged through an injected
 * DISCOVERJOBS), and every page and source state. The route is stateless
 * (2026-10-14): nothing here keeps or reuses an answer, and no body carries
 * remember / filter / staleDays.
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
import { albumCredit as serverAlbumCredit } from '../../src/discovery-plugins/recommendation.js';
import { albumListing as serverAlbumListing } from '../../src/discovery-plugins/plugins/federation-copy.js';
import { nameKey as serverNameKey } from '../../src/db/name-key.js';

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
  test('windows, the default window, caps', () => {
    assert.deepEqual([...D.WINDOWS], [...tasteQ.WINDOWS]);
    assert.equal(D.DEFAULT_WINDOW, tasteQ.DEFAULT_WINDOW);
    assert.equal(D.PIN_CAP, tasteQ.PIN_CAP);
    assert.equal(D.EXCLUDE_CAP, tasteQ.EXCLUDE_CAP);
    assert.equal(D.HASH_MAX, tasteQ.HASH_MAX);
    assert.equal(D.LIMIT_CAPS.seeds, tasteQ.SEED_CAP);
    assert.deepEqual({ ...D.LIMIT_DEFAULTS }, { ...tasteQ.LIMIT_DEFAULTS });
    assert.deepEqual({ ...D.LIMIT_CAPS }, { ...tasteQ.LIMIT_CAPS });
    // the server dropped the library filters with the saved prefs
    for (const gone of ['FILTERS', 'DEFAULT_FILTER', 'STALE_DAYS_MIN', 'STALE_DAYS_MAX']) { assert.equal(tasteQ[gone], undefined, gone); }
  });

  test('storage key names: the window, and the panel\'s shared newArtistsOnly', () => {
    assert.deepEqual({ ...D.STORAGE_KEYS }, { window: 'discoverPageWindow', newArtistsOnly: 'discoverNewArtistsOnly' });
  });

  test('the pages and the page sizes', () => {
    assert.deepEqual([...D.PAGES], ['play', 'explore']);
    assert.equal(D.PAGE_SIZE, 16);
    assert.equal(D.ALBUM_STRIP_MAX, 12);
    assert.ok(D.ALBUM_STRIP_MAX <= tasteQ.LIMIT_CAPS.albums, 'the strip can be filled in one ask');
  });

  test('what the play-now page dropped is gone from the module', () => {
    for (const gone of ['seedsLine', 'windowLabel', 'filterOptions', 'agoLabel', 'playedWhen', 'pickSource']) {
      assert.equal(D[gone], undefined, gone);
    }
  });

  test('the saved prefs, the filters, the client TTL and the "New seeds" rotation are gone (2026-10-14)', () => {
    for (const gone of ['FILTERS', 'PAGE_FILTERS', 'DEFAULT_PREFS', 'STALE_DAYS_MIN', 'STALE_DAYS_MAX', 'CLIENT_TTL_MS',
      'defaultPrefs', 'cleanPrefs', 'mergePrefs', 'parseStoredPrefs', 'serializePrefs', 'requestKey', 'nextRotation',
      'filterFor', 'includesPlayed', 'includePlayedOption']) {
      assert.equal(D[gone], undefined, gone);
    }
    for (const word of ['persisted', 'remember', 'staleDays', 'rotation', 'TTL']) {
      assert.ok(!SOURCE.includes(word), `no ${word} in the module`);
    }
  });
});

// ── requests ──────────────────────────────────────────────────────────

describe('buildRequests', () => {
  const strip = (b) => { const c = { ...b }; delete c.sources; return c; };

  test('the play page: library alone, then peers — same seeds-shaping keys', () => {
    const { main, peers } = D.buildRequests({ window: 30, pinPath: '/Music/ALM/Manor.mp3', flags: FLAGS, ignoreVPaths: ['Podcasts'] });
    assert.deepEqual(main.sources, ['library'], 'the network leads are the explore page\'s');
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['Music/ALM/Manor.mp3']);
    assert.deepEqual(strip(main), strip(peers));
    assert.deepEqual(strip(main), { window: 30, pin: ['Music/ALM/Manor.mp3'], newArtistsOnly: false, ignoreVPaths: ['Podcasts'] });
    assert.deepEqual(D.buildRequests({ flags: FLAGS, page: 'play' }), D.buildRequests({ flags: FLAGS }), 'play is the default');
    assert.deepEqual(D.buildRequests({ flags: FLAGS, page: 'nope' }), D.buildRequests({ flags: FLAGS }));
  });

  test('the explore page: network alone, never a peers call — and the same seeds-shaping keys', () => {
    const play = D.buildRequests({ flags: FLAGS, window: 90, pinPath: 'a.mp3', exclude: ['h1'] });
    const explore = D.buildRequests({ flags: FLAGS, window: 90, pinPath: 'a.mp3', exclude: ['h1'], page: 'explore' });
    assert.deepEqual(explore.main.sources, ['network']);
    assert.equal(explore.peers, null);
    assert.deepEqual(strip(explore.main), strip(play.main), 'one window, pins and drop list across both pages');
    assert.deepEqual(D.buildRequests({ flags: { ...FLAGS, discoveryP2p: false }, page: 'explore' }), { main: null, peers: null }, 'nothing to explore without p2p');
  });

  test('flags drop sources: no federation discovery → no peers call; p2p never reaches the play page', () => {
    const noP2p = D.buildRequests({ flags: { ...FLAGS, discoveryP2p: false } });
    assert.deepEqual(noP2p.main.sources, ['library']);
    assert.ok(noP2p.peers);
    const noFed = D.buildRequests({ flags: { ...FLAGS, federationDiscovery: false } });
    assert.deepEqual(noFed.main.sources, ['library']);
    assert.equal(noFed.peers, null);
    const neither = D.buildRequests({ flags: { discovery: true, discoveryTaste: 1 } });
    assert.deepEqual(neither.main.sources, ['library']);
    assert.equal(neither.peers, null);
  });

  test('the window: always sent — a <select>\'s string reads, anything else is the default 30', () => {
    assert.equal(D.buildRequests({ flags: FLAGS, window: '7' }).main.window, 7);
    assert.equal(D.buildRequests({ flags: FLAGS, window: 0 }).main.window, 0, 'all time is a real window');
    for (const w of [undefined, null, '', 14, 'junk', true, 30.5]) {
      assert.equal(D.buildRequests({ flags: FLAGS, window: w }).main.window, 30, String(w));
    }
  });

  test('no saved-prefs keys ever: no remember, filter or staleDays (the route answers 400 to them)', () => {
    const { main, peers } = D.buildRequests({ flags: FLAGS, remember: true, filter: 'all', staleDays: 30, prefs: { window: 7, exclude: ['old'] } });
    for (const b of [main, peers]) {
      for (const k of ['remember', 'filter', 'staleDays', 'prefs']) { assert.equal(k in b, false, k); }
      assert.equal(b.window, 30, 'no prefs object is read');
      assert.equal(b.exclude, undefined);
    }
  });

  test('the page off: no bodies at all', () => {
    for (const flags of [{}, { ...FLAGS, discovery: false }, { ...FLAGS, discoveryTaste: 0 }, { ...FLAGS, discoveryTaste: undefined }, { ...FLAGS, discoveryTaste: true }, null]) {
      assert.deepEqual(D.buildRequests({ flags }), { main: null, peers: null }, JSON.stringify(flags));
    }
    assert.ok(D.buildRequests({ flags: { ...FLAGS, discoveryTaste: 2 } }).main, 'a later generation still has the page');
    assert.ok(D.buildRequests({ flags: { ...FLAGS, discoveryTaste: '1' } }).main);
  });

  test('pins: leading slashes stripped, de-duplicated, now playing first, capped at 12 (the seed cap)', () => {
    assert.equal(D.PIN_CAP, 12);
    assert.equal(D.PIN_CAP, D.LIMIT_CAPS.seeds, 'a whole seed batch fits');
    const many = Array.from({ length: 14 }, (_, i) => `/Music/p${i}.mp3`);
    const { main } = D.buildRequests({ flags: FLAGS, pinPath: '//Music/now.mp3', pins: ['Music/now.mp3', '', null, 42, ...many] });
    assert.equal(main.pin.length, 12);
    assert.equal(main.pin[0], 'Music/now.mp3');
    assert.ok(main.pin.every((p) => !p.startsWith('/')));
    assert.equal(new Set(main.pin).size, 12);
    assert.equal(D.buildRequests({ flags: FLAGS, pinPath: 'x'.repeat(2049) }).main.pin, undefined);
    assert.equal(D.buildRequests({ flags: FLAGS }).main.pin, undefined);
  });

  test('"new artists only" is the Explore page\'s: the play page never sends it', () => {
    const play = D.buildRequests({ newArtistsOnly: true, flags: FLAGS });
    assert.equal(play.main.newArtistsOnly, false);
    assert.equal(play.peers.newArtistsOnly, false, 'no hidden thinning of the connected servers\' rows');
    assert.equal(D.buildRequests({ newArtistsOnly: true, flags: FLAGS, page: 'explore' }).main.newArtistsOnly, true);
    assert.equal(D.buildRequests({ newArtistsOnly: 'yes', flags: FLAGS, page: 'explore' }).main.newArtistsOnly, false);
  });

  test('the visit\'s dropped seeds: cleaned, on both calls, the newest 200', () => {
    const { main, peers } = D.buildRequests({ flags: FLAGS, exclude: ['h9', 'h9', '', 'y'.repeat(129), 7, 'h8'] });
    assert.deepEqual(main.exclude, ['h9', 'h8']);
    assert.deepEqual(peers.exclude, main.exclude, 'both calls agree on the seeds');
    const lots = Array.from({ length: 205 }, (_, i) => `s${i}`);
    const sent = D.buildRequests({ flags: FLAGS, exclude: lots }).main.exclude;
    assert.equal(sent.length, D.EXCLUDE_CAP);
    assert.equal(sent[0], 's5', 'oldest out first');
    assert.equal(D.buildRequests({ flags: FLAGS, exclude: [] }).main.exclude, undefined);
    assert.equal(D.buildRequests({ flags: FLAGS, exclude: 'h1' }).main.exclude, undefined);
  });

  test('the visit\'s passed random picks travel in exclude after the drops, which keep their room', () => {
    assert.deepEqual(D.buildRequests({ flags: FLAGS, passed: ['r1', 'r2'] }).main.exclude, ['r1', 'r2']);
    const both = D.buildRequests({ flags: FLAGS, exclude: ['d1'], passed: ['r1', 'd1', '', 'r1', 'r2'] });
    assert.deepEqual(both.main.exclude, ['d1', 'r1', 'r2'], 'cleaned, a drop not sent twice');
    assert.deepEqual(both.peers.exclude, both.main.exclude);
    const drops = Array.from({ length: 198 }, (_, i) => `d${i}`);
    const passed = Array.from({ length: 5 }, (_, i) => `r${i}`);
    const sent = D.buildRequests({ flags: FLAGS, exclude: drops, passed }).main.exclude;
    assert.equal(sent.length, D.EXCLUDE_CAP);
    assert.deepEqual(sent.slice(0, 198), drops, 'every drop kept');
    assert.deepEqual(sent.slice(198), ['r3', 'r4'], 'the newest passed picks that fit');
    const full = Array.from({ length: 200 }, (_, i) => `d${i}`);
    assert.deepEqual(D.buildRequests({ flags: FLAGS, exclude: full, passed }).main.exclude, full, 'no room: no passed pick');
    assert.equal(D.buildRequests({ flags: FLAGS, passed: 'r1' }).main.exclude, undefined);
  });

  test('limits clamped to the caps; ignoreVPaths cleaned', () => {
    const { main } = D.buildRequests({
      flags: FLAGS, limits: { seeds: 0, tracks: 999, albums: 3.7, network: -4, peers: '30', bogus: 5 },
      ignoreVPaths: ['ok', '', 7, 'x'.repeat(257), ...Array.from({ length: 120 }, (_, i) => `v${i}`)],
    });
    assert.deepEqual(main.limit, { seeds: 1, tracks: 50, albums: 3, network: 0, peers: 25 });
    assert.equal(main.ignoreVPaths.length, 100);
    assert.equal(main.ignoreVPaths[0], 'ok');
    assert.equal(D.buildRequests({ flags: FLAGS, limits: {} }).main.limit, undefined);
    assert.equal(D.buildRequests({ flags: FLAGS }).main.ignoreVPaths, undefined, 'a peer context sends none');
  });
});

describe('peersRequest: the peers call seeds from the library answer\'s batch', () => {
  const seed = (i, extra = {}) => ({ hash: `h${i}`, filepath: `Music/S/${i}.flac`, metadata: {}, pinned: false, analyzed: true, ...extra });
  const peersBody = () => D.buildRequests({ flags: FLAGS, window: 90, pinPath: 'Music/S/0.flac', exclude: ['hx'], limits: { tracks: 48, peers: 25 } }).peers;

  test('pins the answer\'s seeds, in order, and asks the server for no seed of its own', () => {
    const body = peersBody();
    const main = { seedSource: 'history', seeds: [seed(0, { pinned: true }), seed(1), seed(2)] };
    const out = D.peersRequest(body, main);
    assert.deepEqual(out.pin, ['Music/S/0.flac', 'Music/S/1.flac', 'Music/S/2.flac']);
    assert.deepEqual(out.limit, { tracks: 48, peers: 25, seeds: 3 });
    assert.deepEqual(out.sources, ['peers']);
    assert.equal(out.window, 90);
    assert.deepEqual(out.exclude, ['hx']);
    assert.deepEqual(body.pin, ['Music/S/0.flac'], 'the built body is not touched');
    assert.equal(body.limit.seeds, undefined);
  });

  test('every seed of a full 12-seed batch; past PIN_CAP (a malformed answer) the first ones; bad paths skipped', () => {
    const full = Array.from({ length: 12 }, (_, i) => seed(i, { pinned: i === 0 }));
    const all = D.peersRequest(peersBody(), { seedSource: 'history', seeds: full });
    assert.deepEqual(all.pin, full.map((s) => s.filepath));
    assert.equal(all.limit.seeds, 12);
    const seeds = [seed(0, { filepath: '/Music/S/0.flac' }), seed(9, { filepath: '' }), seed(1, { filepath: 'Music/S/0.flac' }),
      ...Array.from({ length: 12 }, (_, i) => seed(i + 2))];
    const out = D.peersRequest(peersBody(), { seedSource: 'history', seeds });
    assert.equal(out.pin.length, D.PIN_CAP);
    assert.deepEqual(out.pin.slice(0, 2), ['Music/S/0.flac', 'Music/S/2.flac'], 'the leading / stripped, a duplicate and an empty path skipped');
    assert.equal(out.limit.seeds, D.PIN_CAP);
  });

  test('no peers call: no body, a failed or refused answer, no seeds, or the random stand-in', () => {
    const main = { seedSource: 'history', seeds: [seed(1)] };
    assert.equal(D.peersRequest(null, main), null);
    for (const bad of [undefined, null, { disabled: true }, { seedSource: 'history', seeds: [] }, { seedSource: 'random', seeds: [seed(1)] }]) {
      assert.equal(D.peersRequest(peersBody(), bad), null, JSON.stringify(bad));
    }
    const noLimit = D.buildRequests({ flags: FLAGS }).peers;
    assert.deepEqual(D.peersRequest(noLimit, main).limit, { seeds: 1 });
  });
});

describe('the window and the visit\'s dropped seeds', () => {
  test('the stored window reads back, or is the default 30 — never a throw', () => {
    for (const [raw, w] of [['7', 7], ['90', 90], ['0', 0], ['30', 30]]) { assert.equal(D.storedWindow(raw), w, raw); }
    for (const bad of [null, undefined, '', '14', 'junk', '{', '30.5', 7.5]) { assert.equal(D.storedWindow(bad), 30, String(bad)); }
    assert.equal(D.storedWindow(90), 90);
  });

  test('drop and restore a seed: a new list, the newest 200, a re-drop moves to the newest end', () => {
    const full = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const dropped = D.dropSeed(full, 'new');
    assert.equal(dropped.length, 200);
    assert.equal(dropped[199], 'new');
    assert.equal(dropped[0], 's1');
    assert.equal(full.length, 200, 'not mutated');
    assert.deepEqual(D.dropSeed(['a', 'b'], 'a'), ['b', 'a']);
    assert.deepEqual(D.dropSeed(null, 'h'), ['h']);
    assert.deepEqual(D.dropSeed(['a'], ''), ['a'], 'not a hash: nothing added');
    assert.deepEqual(D.restoreSeed(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(D.restoreSeed(['a'], 'zz'), ['a']);
    assert.deepEqual(D.restoreSeed(undefined, 'a'), []);
  });

  test('Another pick: passPick adds the pick shown (newest end, the newest 200), randomPick names it', () => {
    assert.deepEqual(D.passPick([], 'r1'), ['r1']);
    assert.deepEqual(D.passPick(['r1', 'r2'], 'r1'), ['r2', 'r1']);
    assert.deepEqual(D.passPick(null, ''), []);
    const full = Array.from({ length: 200 }, (_, i) => `r${i}`);
    const out = D.passPick(full, 'new');
    assert.equal(out.length, 200);
    assert.equal(out[199], 'new');
    const pick = { hash: 'r7', filepath: 'Music/r7.flac', pinned: false };
    assert.equal(D.randomPick({ seedSource: 'random', seeds: [pick] }), 'r7');
    for (const no of [undefined, null, { disabled: true }, { seedSource: 'history', seeds: [pick] },
      { seedSource: 'random', seeds: [] }, { seedSource: 'random', seeds: [{ ...pick, pinned: true }] }]) {
      assert.equal(D.randomPick(no), null, JSON.stringify(no));
    }
  });

  test('noPickLeft: no seed at all on a random or scan-pending answer — never a listed seed, a failure or a 403', () => {
    assert.equal(D.noPickLeft({ seedSource: 'random', seeds: [], notAnalyzed: true }), true);
    assert.equal(D.noPickLeft({ seedSource: 'random', seeds: [] }), true);
    assert.equal(D.noPickLeft({ seedSource: 'history', seeds: [], notAnalyzed: true }), true);
    for (const no of [undefined, null, { disabled: true }, { seedSource: 'history', seeds: [] },
      { seedSource: 'random', seeds: [{ hash: 'r1' }] }, { seedSource: 'history', notAnalyzed: true, seeds: [{ hash: 'h1', analyzed: false }] }]) {
      assert.equal(D.noPickLeft(no), false, JSON.stringify(no));
    }
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

describe('seedChips', () => {
  test('history: chips, the playing pin, the overflow behind Show all', () => {
    const r = historyResponse();
    const out = collect(D.seedChips(r, { nowPlaying: '/Music/ALM/Manor.flac', now: NOW }));
    assert.equal(out.total, 9);
    assert.equal(out.chips.length, D.SEED_CHIPS_MAX);
    assert.equal(out.overflow, 2);
    assert.deepEqual(out.more, { key: 'dpage.seeds.showAll', params: {} }, 'no count');
    assert.equal(out.hidden.length, 2);
    const [pin, first] = out.chips;
    assert.deepEqual(pin.label, { key: 'dpage.seeds.chip', params: { title: 'Manor', artist: 'ALM' } });
    assert.equal(pin.tag.key, 'dpage.seeds.playing');
    assert.equal(pin.action, 'unpin');
    assert.equal(pin.art, 'hp.jpg');
    assert.equal(first.tag, null);
    assert.equal(first.action, 'drop');
    assert.equal(first.hash, 'h1');
    assert.equal('detail' in first, false, 'the picker\'s statistics are gone');
    // Another pin (not the song playing) reads "picked".
    assert.equal(D.seedChips(r, { nowPlaying: 'Music/other.mp3' }).chips[0].tag.key, 'dpage.seeds.picked');
    assert.equal(D.seedChips(r, { max: 0 }).overflow, 9);
    assert.equal(D.seedChips(r, { max: 20 }).more, null);
  });

  test('a seed without a title or artist, an un-analyzed one', () => {
    const r = historyResponse({
      seeds: [
        seed('x1', 'ignored', 'ignored', { metadata: { title: '', artist: '' }, filepath: 'Music/dir/file name.mp3', outcome: 'stopped' }),
        seed('x2', 'Pending', 'Artist', { analyzed: false }),
      ],
    });
    const { chips } = collect(D.seedChips(r, { now: NOW }));
    assert.deepEqual(chips[0].label, { key: 'dpage.seeds.chipTitle', params: { title: 'file name.mp3' } });
    assert.equal(chips[1].analyzed, false);
    assert.equal(chips[1].tag.key, 'dpage.seeds.notAnalyzed');
  });

  test('the random pick: tagged, no ×', () => {
    const random = historyResponse({ seedSource: 'random', fallback: true, seeds: [seed('r', 'Rand', 'Om', { outcome: null, plays: null, lastPlayed: null })] });
    const chip = collect(D.seedChips(random)).chips[0];
    assert.equal(chip.tag.key, 'dpage.seeds.randomTag');
    assert.equal(chip.action, null, 'the random pick has no ×');
    assert.deepEqual(D.seedChips(undefined).chips, []);
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
  test('albums before songs, with the card fields renderAlbum takes — and no captions', () => {
    const out = collect(D.librarySections(historyResponse()));
    assert.equal(out.count, 6);
    const [a1, a3] = out.albums;
    assert.deepEqual(
      { name: a1.name, artistLine: a1.artistLine, albumArtist: a1.albumArtist, albumArtFile: a1.albumArtFile, trackPaths: a1.trackPaths },
      { name: 'Album 1', artistLine: 'Artist F, Guest', albumArtist: null, albumArtFile: 'Album 1.jpg', trackPaths: ['Music/Album 1/01.flac', 'Music/Album 1/02.flac'] },
    );
    for (const gone of ['playedLabel', 'lastPlayedLabel']) { assert.equal(gone in a1, false, gone); }
    assert.deepEqual(a1.because, { key: 'dpage.because', params: { title: 'One' } });
    assert.equal(a3.artistLine, 'Artist G');
    assert.equal(a3.albumArtist, 'Artist G');
  });

  test('song rows: "Artist · Album", art, the because tooltip', () => {
    const { tracks } = collect(D.librarySections(historyResponse()));
    assert.equal(tracks.length, 4);
    const [t7, t8, t9, t10] = tracks;
    assert.equal(t7.filepath, 'Music/T/7.mp3');
    assert.equal(t7.title, 'Title 7');
    assert.equal(t7.subtitle, 'Artist J · Album 7', 'no genre, year or when');
    assert.equal(t7.art, 'a7.jpg', 'artImgAttr(r.art, "s")');
    assert.equal(t7.length, '4:11');
    for (const gone of ['whenLabel', 'agoLabel']) { assert.equal(gone in t7, false, gone); }
    assert.deepEqual(t7.because, { key: 'dpage.because', params: { title: 'Two' } });
    assert.equal(t7.metadata.album, 'Album 7');
    assert.equal(t8.because, null, 'a pin was not finished: no "because you finished"');
    assert.equal(t9.title, '9.mp3', 'no title → the file name');
    assert.equal(t9.subtitle, 'Album 8');
    assert.equal(t9.art, null);
    assert.equal(t10.because, null, 'a seedHash that names no seed');
    const random = D.librarySections(historyResponse({ seedSource: 'random' }));
    assert.ok(random.tracks.every((t) => t.because === null) && random.albums.every((a) => a.because === null), 'nothing was finished');
  });

  test('the server\'s one rule decides the rows: none narrowed or added here, no filter on the view', () => {
    const r = historyResponse();
    r.library = { ...r.library, filter: 'all' };   // an old server's leftover field
    const out = D.librarySections(r, { filter: 'fresh', staleDays: 1, now: NOW });
    assert.equal(out.tracks.length, 4, 'a played row the server sent stays');
    assert.equal(out.albums.length, 2);
    for (const gone of ['filter', 'provisional']) { assert.equal(gone in out, false, gone); }
  });

  test('caps and the footer: Queue all with no count', () => {
    const out = collect(D.librarySections(historyResponse(), { maxAlbums: 1, maxTracks: 3 }));
    assert.equal(out.albums.length, 1);
    assert.equal(out.tracks.length, 3);
    assert.equal(out.count, 6, 'the count is the whole section');
    assert.deepEqual(out.footer, {
      queueAllLabel: { key: 'dpage.verb.queueAll', params: {} },
      paths: ['Music/T/7.mp3', 'Music/T/8.mp3', 'Music/T/9.mp3', 'Music/T/10.mp3'],
    });
  });

  test('no library section → empty, never a throw', () => {
    for (const r of [undefined, null, { disabled: true }, historyResponse({ library: null })]) {
      const out = D.librarySections(r);
      assert.deepEqual([out.albums, out.tracks, out.count, out.footer.paths], [[], [], 0, []]);
    }
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
    assert.deepEqual(n1.because, { key: 'dpage.because', params: { title: 'One' } });
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
    const out = collect(D.peerGroups(r));
    assert.equal(out.count, 3);
    assert.deepEqual(out.searched, { peers: 1, unreachable: 1, mismatched: 1 });
    assert.deepEqual(out.groups.map((g) => g.name), ['Sam’s server', 'peer C', 'peer B']);
    const [sam, cee, bee] = out.groups;
    assert.equal(sam.playable, true);
    assert.equal(cee.playable, false);
    assert.equal(bee.playable, false);
    for (const g of out.groups) {
      for (const gone of ['stateLabel', 'lastSeenLabel', 'countLabel']) { assert.equal(gone in g, false, gone); }
    }
    assert.equal('line' in out, false, 'no "n of m peers answered"');
    assert.ok(sam.rows.every((row) => row.matchSeed === null && row.because === null), 'a peers row is matched against the centroid');
    const row = sam.rows[0];
    assert.equal(row.raw, r.peers.peers[1].results[0], 'the very object — queueDiscoverFed(raw)');
    assert.equal(row.raw.source, 'federation');
    assert.equal(row.raw.seedHash, null);
    assert.deepEqual([row.peerId, row.peerName, row.filepath, row.playable], [1, 'Sam’s server', 'music/q/P1.mp3', true]);
    assert.equal(row.subtitle, 'Artist Q · Album P1', 'no year, no server');
    assert.equal(row.similarity, 0.7412);
    assert.equal(row.art, null, 'a row without albumArt: the note tile');
    assert.equal(row.length, '4:03');
    assert.deepEqual(D.peerRowsOf(out.groups).map((x) => x.title), ['P1', 'P2', 'P3']);
    assert.deepEqual(D.peerRowsOf(out).map((x) => x.title), ['P1', 'P2', 'P3'], 'the whole answer works too');
  });

  test('a row that names its seed says "Because you finished …" (centroid rows say nothing)', () => {
    const r = peersResponse();
    const hash = HISTORY[0].hash;
    // a responder that names the seed (the route stamps none today)
    const sec = { peers: [{ ...SAM, reachable: true, mismatched: false, results: [fedRow(SAM, 'S1', { seedHash: hash }), fedRow(SAM, 'S2')] }], searched: { peers: 1 } };
    const rows = D.peerGroups({ ...r, peers: sec }).groups[0].rows;
    assert.equal(rows[0].because.key, 'dpage.because');
    assert.equal(rows[1].because, null);
    assert.equal(D.peerGroups({ ...r, seedSource: 'random', peers: sec }).groups[0].rows[0].because, null, 'a random pick is no reason');
  });

  test('a row that carries an art file keeps it for the art proxy', () => {
    const fan = { peers: [{ ...SAM, reachable: true, mismatched: false, results: [fedRow(SAM, 'A1', { art: 'cover.jpg' }), fedRow(SAM, 'A2', { 'album-art': 'b.png' }), fedRow(SAM, 'A3', { art: 42 })] }], searched: { peers: 1 } };
    // Through the route's own stamping: a row's extra keys survive it.
    const groups = D.peerGroups({ peers: peersSection(fan) }).groups;
    assert.deepEqual(groups[0].rows.map((x) => x.art), ['cover.jpg', 'b.png', null]);
  });

  test('the route\'s albumArt is the row\'s art (read first); null or absent = the note tile', () => {
    const fan = { peers: [{ ...SAM, reachable: true, mismatched: false, results: [
      fedRow(SAM, 'C1', { albumArt: '0f1e2d3c.jpeg' }),
      fedRow(SAM, 'C2', { albumArt: '0f1e2d3c.jpeg', art: 'older-guess.jpg' }),
      fedRow(SAM, 'C3', { albumArt: null }),
      fedRow(SAM, 'C4'),
      fedRow(SAM, 'C5', { albumArt: '' }),
    ] }], searched: { peers: 1 } };
    // Through the route's own stamping, as the peers section sends them.
    const rows = D.peerGroups({ peers: peersSection(fan) }).groups[0].rows;
    assert.deepEqual(rows.map((x) => x.art), ['0f1e2d3c.jpeg', '0f1e2d3c.jpeg', null, null, null], 'albumArt wins over the older spellings');
    assert.deepEqual(rows.map((x) => x.peerId), [1, 1, 1, 1, 1], 'the proxy URL names the row\'s server');
  });
});

// vp.js's peer window: dmSongMeta (what Play now / Queue next / Add
// queue), sliced from the component's methods and run over a stub modal.
const VP_SRC = readFileSync(new URL('../../webapp/alpha/vp.js', import.meta.url), 'utf8');
function vpDmSongMeta() {
  const start = VP_SRC.indexOf('      dmSongMeta: function () {');
  assert.ok(start >= 0, 'vp.js no longer defines dmSongMeta — update this test');
  const end = VP_SRC.indexOf('\n      },\n', start);
  const fnSrc = VP_SRC.slice(start + '      dmSongMeta: '.length, end + '\n      }'.length);
  return new Function('DISCOVERYPAGE', `return (${fnSrc});`)(D);
}

describe('the peer window\'s queued metadata (vp.js dmSongMeta)', () => {
  const meta = vpDmSongMeta();
  const call = (modal) => meta.call({ discover: { modal } });
  const track = fedRow(SAM, 'W1', { albumArt: 'w1art.jpeg' });
  test('before the peer metadata read answers (or after it failed): the row\'s albumArt is the song\'s cover', () => {
    assert.equal(call({ source: 'federation', track, file: null })['album-art'], 'w1art.jpeg');
  });
  test('once it answers, the read\'s own cover wins; a read with none keeps the row\'s', () => {
    assert.equal(call({ source: 'federation', track, file: { metadata: { 'album-art': 'read.jpeg', title: 'W1' } } })['album-art'], 'read.jpeg');
    assert.equal(call({ source: 'federation', track, file: { metadata: { 'album-art': null, title: 'W1' } } })['album-art'], 'w1art.jpeg');
  });
  test('a row without albumArt (an older peer) names no cover; a network row never does', () => {
    assert.equal('album-art' in call({ source: 'federation', track: fedRow(SAM, 'W2'), file: null }), false);
    assert.equal('album-art' in call({ source: 'network', track, file: null }), false);
  });
});

// ── vp.js: the recommendation window as Discover opens it ────────────────
// The window's methods sliced out of the component and run over a stub
// `this`, beside the module's own blankDiscoverModal / dmNameKey and its
// session memory (discoverModalView); DISCOVERJOBS and DISCOVERYPAGE are
// the real modules, t() the app's own i18n.js over en.json (plural forms
// included), MSTREAMAPI a stub of the peer's and the library's reads.
function vpMethodSrc(name) {
  const m = new RegExp(`\\n {6}${name}: (?:async )?function \\(`).exec(VP_SRC);
  assert.ok(m, `vp.js no longer defines ${name} — update this test`);
  const start = m.index + 1 + `      ${name}: `.length;
  const end = VP_SRC.indexOf('\n      },\n', start);
  return VP_SRC.slice(start, end + '\n      }'.length);
}
function vpModuleFn(name) {
  const start = VP_SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, `vp.js no longer defines ${name}() — update this test`);
  const end = VP_SRC.indexOf('\n  }\n', start);
  return VP_SRC.slice(start + 1, end + '\n  }'.length);
}
const I18N_SRC = readFileSync(new URL('../../webapp/assets/js/i18n.js', import.meta.url), 'utf8');
const I18N = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', `${I18N_SRC}\nreturn I18N;`)(
  {}, { querySelector: () => null, querySelectorAll: () => [] }, { getItem: () => null, setItem: () => {} }, { language: 'en' },
  async () => ({ json: async () => EN }));
await I18N.loadLanguage('en');
const tEn = I18N.t;

const WINDOW_METHODS = ['tt', 'dmLive', 'dmDuration', 'dmText', 'openDiscoverModal', 'openDiscoverModalForJob', 'dmLoadPeerFacts', 'dmAlbumQuery', 'dmArtistOwnership',
  'dmQueueAlbum', 'dmViewAlbum', 'closeDiscoverModal',
  'dmAlbumFocus', 'dmHeadTitle', 'dmSubtitle', 'dmAlbumFacts', 'dmArtistFacts', 'dmAlbumPlaySub', 'discoverAcquirePlugins', 'dmHasDestination',
  'dmCopyRows', 'dmJobRow', 'dmJobOtherPeer', 'dmScopeRows', 'dmMissingRows', 'dmAlbumIdleSub', 'dmArtistIdleSub', 'dmKeepChoices', 'dmKeepChoose',
  'dmKeepChosen', 'dmKeepMissingChoice', 'dmKeepMissingCount', 'dmKeepScope', 'dmKeepRow', 'dmKeepIdle', 'dmKeepStartLabel',
  'dmMissingHeld', 'dmKeepMissingLabel', 'setDiscoverModalView', 'dmGetItRows', 'dmKeepTitle', 'dmKeepStart', 'toastDiscoverJob', 'discoverPluginTitle',
  'dmRecommendation'];
const COPY = { name: 'federation-copy', title: 'Copy from a connected server', capabilities: ['acquire'], scopes: ['song', 'album', 'artist', 'artist-missing', 'folder'] };
const DEST = { vpath: 'collection', base: 'From peers', layout: '{{ARTIST}}/{{ALBUM}}', source: 'saved' };
const STAGE_B = { id: 1, name: 'Stage Peer B' };
const STAGE_C = { id: 4, name: 'Stage Peer C' };
// A taste peers row as the route sends it (stage A's 'Borrowed Tapes').
const tapesRow = (peer, title, over) => ({
  source: 'federation', seedHash: null, artist: 'Boukmanflow', title, album: 'Borrowed Tapes', year: 2019, duration: 221,
  similarity: 0.83, filepath: `peerlib/Boukmanflow/Borrowed Tapes/${title}.mp3`, peer: { ...peer }, albumArt: 'bt.jpg', ...over,
});
const peerAlbumItem = (name, over) => ({ name, year: 2019, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'], compilation: false, year_min: 2019, year_max: 2019, track_count: 3, ...over });
const songsOf = (n) => Array.from({ length: n }, (_, i) => ({ filepath: `peerlib/x/${i}.mp3`, metadata: { title: `S${i}`, duration: 200 } }));
// The library's reads and the peer's, as dmLoadPeerFacts asks them.
const readsOf = ({ albumSongs = null, peerAlbums = null, localAlbums = null } = {}) => ({
  federationPeers: async () => ({ peers: [{ ...STAGE_B, lastSeen: null, lastStatus: 'ok' }, { ...STAGE_C, lastSeen: null, lastStatus: 'ok' }] }),
  peer: {
    metadata: async () => ({ metadata: { format: 'mp3' } }),
    albumSongs: async () => albumSongs,
    artistAlbums: async () => peerAlbums,
  },
  artistAlbums: async () => localAlbums,
});
const STAGE_READS = () => readsOf({
  albumSongs: songsOf(3),
  peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] },
  localAlbums: { albums: ['Night Market', 'Ferry Lines', 'Cold Open'].map((n) => peerAlbumItem(n)) },
});

function makeWindow({ reads = readsOf(), remembered = 'federation', plugins = [COPY], jobsAllowed = true, destination = DEST, available = true } = {}) {
  const body = `
    let discoverModalGen = 0;
    let discoverModalView = ${JSON.stringify(remembered)};
    function onDiscoverModalKey() {}
    ${vpModuleFn('blankDiscoverModal')}
    ${vpModuleFn('dmNameKey')}
    return {
      methods: { ${WINDOW_METHODS.map((n) => `${n}: ${vpMethodSrc(n)}`).join(',\n')} },
      blank: blankDiscoverModal,
      remembered: () => discoverModalView,
    };`;
  // View album's element (its attributes) and the app's browse hand-off;
  // the album queue's federation rows
  const doc = { addEventListener() {}, removeEventListener() {},
    createElement: (tag) => { const attrs = {}; return { tag, attrs, setAttribute: (k, v) => { attrs[k] = String(v); } }; } };
  const viewed = [];
  const fedQueued = [];
  const app = { addFederationSongWizard: (...args) => { fedQueued.push(args); }, clearQueue() {} };
  const toasts = [];
  const izi = Object.fromEntries(['error', 'success', 'warning', 'info'].map((kind) => [kind, (o) => toasts.push({ kind, ...o })]));
  const mod = new Function('DISCOVERJOBS', 'DISCOVERYPAGE', 'MSTREAMAPI', 'document', 't', 'iziToast', 'getAlbumsOnClick', 'mstreamModule', 'MSTREAMPLAYER', body)(
    J, D, reads, doc, tEn, izi, (el) => { viewed.push(el.attrs); }, app, { positionCache: { val: 0 } });
  const loads = [];
  const starts = [];
  const vm = {
    discover: { plugins: { available, list: plugins, jobsAllowed }, dest: { view: { destination }, loaded: true }, admin: false, seedTitle: '', modal: mod.blank() },
    $refs: {}, $nextTick() {}, $set(o, k, v) { o[k] = v; }, $delete(o, k) { delete o[k]; },
    stopDiscoverPreview() {}, scheduleDiscoverJobsPoll() {}, copyDiscoverP2p() { loads.push('copied'); },
    dmLoadLinks: async () => { loads.push('links'); },
    dmLoadJobs: async () => { loads.push('jobs'); },
    dmLoadFederate: async () => { loads.push('federate'); },
    dmJobStart: (plugin, choice, scope) => { starts.push({ plugin: plugin.name, choice, scope }); },
    ...mod.methods,
  };
  return { vm, loads, starts, toasts, viewed, fedQueued, remembered: mod.remembered };
}
const subText = (vm, row) => vm.dmText(row.sub);
const copyJob = (over) => ({ id: 41, plugin: 'federation-copy', key: 'album:06676dc1', state: 'running', progress: 0.4, statusText: 'song 1 of 3 · Rooftop Cypher', params: { scope: 'album' }, recommendation: tapesRow(STAGE_B, '02 - Late Train Verse'), ...over });

describe('the recommendation window: album focus (vp.js)', () => {
  test('a card\'s opening reads as the album: Federation view and Album chosen — the session\'s remembered view neither used nor changed', async () => {
    const { vm, remembered } = makeWindow({ reads: STAGE_READS(), remembered: 'plugins' });
    const row = tapesRow(STAGE_B, '02 - Late Train Verse');
    await vm.openDiscoverModal(row, 'federation', { seedPlain: 'your recent listening', focus: 'album', view: 'federation' });
    const m = vm.discover.modal;
    assert.equal(m.track, row, 'the best row itself, as received');
    assert.equal(m.focus, 'album');
    assert.equal(m.view, 'federation');
    assert.deepEqual(m.keep, { scope: 'album', onlyMissing: true });
    assert.equal(remembered(), 'plugins', 'the session\'s choice is the tabs\', not the opener\'s');
    assert.equal(vm.dmKeepChosen(), 'album');
    assert.equal(vm.dmKeepScope(), 'album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', '3 songs'], ['artist', '1 album']], 'no "This song" in the album\'s window');
  });

  test('a song row\'s ⋯ (view: federation) opens on the Federation view whatever was last chosen; the panel\'s rows keep the remembered view', async () => {
    const page = makeWindow({ remembered: 'plugins' });
    await page.vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation', { seedPlain: 'x', view: 'federation' });
    assert.equal(page.vm.discover.modal.view, 'federation');
    assert.equal(page.vm.discover.modal.focus, null);
    assert.deepEqual(page.vm.discover.modal.keep, { scope: 'song', onlyMissing: true });
    assert.equal(page.remembered(), 'plugins');
    const panel = makeWindow({ remembered: 'plugins' });
    await panel.vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation');
    assert.equal(panel.vm.discover.modal.view, 'plugins', 'no opts: the session\'s choice, as before');
    const off = makeWindow({ remembered: 'plugins', available: false });
    await off.vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation', { view: 'plugins' });
    assert.equal(off.vm.discover.modal.view, 'federation', 'no plug-ins: there is only the Federation view');
  });

  test('album focus needs an album; a network row never takes it', async () => {
    const { vm } = makeWindow();
    await vm.openDiscoverModal(tapesRow(STAGE_B, 'Loose', { album: null }), 'federation', { focus: 'album', view: 'federation' });
    assert.equal(vm.discover.modal.focus, null);
    assert.equal(vm.discover.modal.keep.scope, 'song');
    await vm.openDiscoverModal({ title: 'Lead', artist: 'Mo', album: 'Lead Album', peer: { endpointId: 'e1' } }, 'p2p', { focus: 'album' });
    assert.equal(vm.discover.modal.focus, null);
    assert.equal(vm.discover.modal.view, 'plugins');
  });

  test('the header: the album\'s name, then "artist · year · N songs" once the peer said how many', async () => {
    const { vm } = makeWindow({ reads: readsOf() });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', view: 'federation' });
    assert.equal(vm.dmHeadTitle(), 'Borrowed Tapes');
    assert.equal(vm.dmSubtitle(), 'Boukmanflow · 2019', 'count unknown (the peer did not answer): no count');
    vm.discover.modal.album = { songs: songsOf(1), count: 1, seconds: 200, owned: false };
    assert.equal(vm.dmSubtitle(), 'Boukmanflow · 2019 · 1 song');
    vm.discover.modal.album = { songs: songsOf(3), count: 3, seconds: 662, owned: false };
    assert.equal(vm.dmSubtitle(), 'Boukmanflow · 2019 · 3 songs');
    assert.equal(vm.dmAlbumPlaySub(), '11:02 · none in your library', 'the play line: how long, and whether the library has it');
    // the song's own window is unchanged
    const song = makeWindow();
    await song.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    assert.equal(song.vm.dmHeadTitle(), '02 - Late Train Verse');
    assert.equal(song.vm.dmSubtitle(), 'Boukmanflow · Borrowed Tapes · 2019 · 3:41');
    song.vm.discover.modal.track = { ...song.vm.discover.modal.track, title: '' };
    assert.equal(song.vm.dmHeadTitle(), '(untitled)');
  });
});

describe('the recommendation window on Discover rows: what Keep offers (vp.js)', () => {
  test('a row without an artist offers no Album (the peer would hand back every album of that name) and no Artist', async () => {
    const { vm } = makeWindow({ reads: readsOf({ albumSongs: songsOf(3) }) });
    await vm.openDiscoverModal(tapesRow(STAGE_B, 'Untagged Hit', { artist: null, album: 'Greatest Hits' }), 'federation', { view: 'federation' });
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song']);
    assert.deepEqual(vm.dmScopeRows('album'), []);
    assert.deepEqual(vm.dmScopeRows('artist'), []);
    assert.deepEqual(vm.dmMissingRows(), []);
    // its album card's ⋯: no choice at all, so no Keep card
    const card = makeWindow({ reads: readsOf({ albumSongs: songsOf(3) }) });
    await card.vm.openDiscoverModal(tapesRow(STAGE_B, 'Untagged Hit', { artist: '', album: 'Greatest Hits' }), 'federation', { focus: 'album', view: 'federation' });
    assert.equal(card.vm.discover.modal.focus, 'album');
    assert.deepEqual(card.vm.dmKeepChoices(), []);
    assert.equal(card.vm.dmKeepRow(), null);
  });

  test('"Only the 1 album you don\'t have": 3 of the artist\'s albums here, the peer\'s one by name not — counts said "you have 3" and hid it', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    const a = vm.discover.modal.artist;
    assert.deepEqual([a.albums, a.owned, a.missing, a.local], [1, 0, 1, 3]);
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['song', '3:41 · mp3'], ['album', '3 songs'], ['artist', '1 album']]);
    assert.equal(vm.dmArtistFacts(), '1 album · 3 songs · 2019 · none in your library');
    vm.dmKeepChoose('artist');
    assert.equal(vm.dmKeepMissingChoice(), true);
    assert.equal(tEn('discover.modal.onlyMissing', { count: vm.dmKeepMissingCount() }), 'Only the 1 album you don’t have');
    assert.equal(vm.dmKeepScope(), 'artist-missing', 'ticked by default');
    assert.equal(vm.dmKeepStartLabel(), 'Add 1 album');
    assert.equal(vm.dmArtistIdleSub('artist-missing'), '1 album by Boukmanflow you don’t have');
    vm.discover.modal.keep.onlyMissing = false;
    assert.equal(vm.dmKeepScope(), 'artist');
    assert.equal(vm.dmKeepStartLabel(), 'Add artist');
  });

  test('by name, as the copy reckons it: a spelling variant is the same album; an album they only appear on is never "missing"', async () => {
    const peerAlbums = { albums: [
      peerAlbumItem('Borrowed Tapes'),
      peerAlbumItem('Cold  Open’s B-Sides', { year: 2021, year_min: 2021, year_max: 2021 }),
      peerAlbumItem('Block Party Comp', { album_artist: 'Various Artists', artists: ['Various Artists', 'Boukmanflow'], compilation: true }),
      peerAlbumItem('', { album_artist: null }),
    ] };
    const localAlbums = { albums: [peerAlbumItem('borrowed tapes '), peerAlbumItem('Cold Open\'s B‐Sides')] };
    const { vm } = makeWindow({ reads: readsOf({ albumSongs: songsOf(3), peerAlbums, localAlbums }) });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    const a = vm.discover.modal.artist;
    assert.equal(a.owned, 2, 'case, spaces, a curly apostrophe and a Unicode hyphen fold as name-key.js folds them');
    assert.equal(a.missing, 0, 'the compilation is an appearance (the copy skips it), the blank name the singles bucket');
    assert.equal(vm.discover.modal.album.owned, true, 'the album line: in your library');
    assert.equal(vm.dmArtistFacts(), '4 albums · 12 songs · 2019 – 2021 · you have 2');
    vm.dmKeepChoose('artist');
    assert.deepEqual(vm.dmMissingRows(), [], 'nothing missing by name: no choice');
    assert.equal(vm.dmKeepMissingChoice(), false);
    assert.equal(vm.dmKeepScope(), 'artist');
  });

  test('no album of the artist\'s here: the plain artist copy takes them all, no checkbox; a listing that did not answer is unknown', async () => {
    const none = makeWindow({ reads: readsOf({ albumSongs: songsOf(3), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] }, localAlbums: { albums: [] } }) });
    await none.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    none.vm.dmKeepChoose('artist');
    assert.deepEqual([none.vm.discover.modal.artist.missing, none.vm.discover.modal.artist.local], [1, 0]);
    assert.equal(none.vm.dmKeepMissingChoice(), false);
    assert.equal(none.vm.dmKeepScope(), 'artist');
    const failed = makeWindow({ reads: readsOf({ albumSongs: songsOf(3), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] }, localAlbums: null }) });
    await failed.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    const a = failed.vm.discover.modal.artist;
    assert.deepEqual([a.owned, a.missing, a.local], [null, null, null]);
    assert.equal(failed.vm.dmArtistFacts(), '1 album · 3 songs · 2019', 'no "you have" it cannot know');
    assert.equal(failed.vm.dmArtistIdleSub('artist-missing'), 'Only the albums by Boukmanflow you don’t have');
  });

  test('one album, one song: singular', async () => {
    const { vm } = makeWindow({ reads: readsOf({ albumSongs: songsOf(1), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes', { track_count: 1 })] }, localAlbums: { albums: [] } }) });
    await vm.openDiscoverModal(tapesRow(STAGE_C, '01 - Rooftop Cypher'), 'federation', { view: 'federation' });
    assert.equal(vm.dmArtistFacts(), '1 album · 1 song · 2019 · none in your library');
    assert.equal(vm.dmAlbumFacts(), '2019 · 1 song · 3:20 · none in your library');
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.sub), ['3:41 · mp3', '1 song', '1 album']);
    vm.dmKeepChoose('album');
    assert.equal(vm.dmAlbumIdleSub(), 'Copies its 1 song from Stage Peer C into your library');
    assert.equal(vm.dmArtistIdleSub('artist'), 'Every album by Boukmanflow on Stage Peer C · 1 album, 1 song');
    for (const key of ['discover.modal.songCount', 'discover.modal.albumCount', 'discover.modal.onlyMissing', 'discover.modal.keepAddMissing', 'discover.modal.albumQueued', 'discover.modal.addAlbumSub']) {
      assert.ok(EN[key] && typeof EN[key].one === 'string' && typeof EN[key].other === 'string', `${key}: one and other`);
      assert.ok(!/\b1 (songs|albums)\b/.test(tEn(key, { count: 1, peer: 'P' })), `${key}: "${tEn(key, { count: 1, peer: 'P' })}"`);
    }
  });
});

describe('the recommendation window: another server\'s copy, and a job reopened from the strip (vp.js)', () => {
  test('another server\'s album copy, running: shown as "from <that server>" (Add would only return it); once it ended the card is this server\'s again', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', view: 'federation' });
    const fromC = copyJob({ recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher') });
    vm.discover.modal.jobs = { 'federation-copy@album': fromC };
    const live = vm.dmKeepRow().row;
    assert.equal(live.state, 'running');
    assert.equal(vm.dmKeepIdle(), false);
    assert.equal(subText(vm, live), 'from Stage Peer C · song 1 of 3 · Rooftop Cypher · 40%');
    vm.discover.modal.jobs = { 'federation-copy@album': { ...fromC, state: 'done', progress: 1, result: { songs: { total: 1, copied: [{}], skipped: [], failed: [] }, stopped: null, peer: STAGE_C } } };
    assert.equal(vm.dmKeepRow().row.state, 'idle', 'C\'s finished copy is not B\'s album');
    assert.equal(vm.dmKeepIdle(), true, 'Add album is offered again');
    // this server's own job reads as before, with no "from"
    vm.discover.modal.jobs = { 'federation-copy@album': copyJob() };
    assert.equal(subText(vm, vm.dmKeepRow().row), 'song 1 of 3 · Rooftop Cypher · 40%');
  });

  test('a song copied from another server is the same recording: it stays, named by its server', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '01 - Rooftop Cypher'), 'federation', { view: 'federation' });
    vm.discover.modal.jobs = { 'federation-copy': copyJob({ params: {}, state: 'done', recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher'),
      result: { copied: { filepath: 'collection/From peers/Boukmanflow/Borrowed Tapes/01 - Rooftop Cypher.mp3' } } }) };
    const row = vm.dmKeepRow().row;
    assert.equal(row.state, 'copied');
    assert.equal(subText(vm, row), 'from Stage Peer C · collection / From peers / Boukmanflow / Borrowed Tapes / 01 - Rooftop Cypher.mp3');
    assert.ok(row.actions.includes('play'));
    // a refused start keeps the server's own words, alone
    vm.discover.modal.jobErrors = { 'federation-copy': 'Uploading Disabled' };
    assert.equal(subText(vm, vm.dmKeepRow().row), 'Uploading Disabled');
  });

  test('a strip row reopens its job: an album copy as the album on Album, artist-missing as Artist with only-missing ticked, another plug-in on Plug-Ins', async () => {
    const album = makeWindow({ reads: STAGE_READS(), remembered: 'plugins' });
    const job = copyJob({ recommendation: { ...tapesRow(STAGE_B, '02 - Late Train Verse'), albumArt: undefined, similarity: undefined } });
    await album.vm.openDiscoverModalForJob(job);
    let m = album.vm.discover.modal;
    assert.equal(m.focus, 'album');
    assert.equal(m.view, 'federation', 'never the remembered Plug-Ins view, where Keep is absent');
    assert.equal(album.vm.dmKeepChosen(), 'album');
    m.jobs = { 'federation-copy@album': job };
    assert.equal(album.vm.dmKeepRow().row.state, 'running', 'the card IS the job');
    assert.equal(album.remembered(), 'plugins');

    const missing = makeWindow({ reads: STAGE_READS() });
    const mJob = copyJob({ params: { scope: 'artist-missing' }, key: 'artist-missing:x' });
    await missing.vm.openDiscoverModalForJob(mJob);
    m = missing.vm.discover.modal;
    assert.equal(m.focus, null);
    assert.deepEqual(m.keep, { scope: 'artist', onlyMissing: true });
    m.jobs = { 'federation-copy@artist-missing': mJob };
    assert.equal(missing.vm.dmKeepScope(), 'artist-missing');
    assert.equal(missing.vm.dmKeepRow().row.state, 'running');

    const artist = makeWindow({ reads: STAGE_READS() });
    await artist.vm.openDiscoverModalForJob(copyJob({ params: { scope: 'artist' } }));
    assert.deepEqual(artist.vm.discover.modal.keep, { scope: 'artist', onlyMissing: false });
    assert.equal(artist.vm.dmKeepScope(), 'artist', 'the plain artist copy, not the missing one');

    const song = makeWindow({ reads: STAGE_READS(), remembered: 'plugins' });
    await song.vm.openDiscoverModalForJob(copyJob({ params: {} }));
    assert.deepEqual([song.vm.discover.modal.focus, song.vm.discover.modal.view, song.vm.dmKeepChosen()], [null, 'federation', 'song']);

    const other = makeWindow({ reads: STAGE_READS(), remembered: 'federation' });
    await other.vm.openDiscoverModalForJob({ id: 9, plugin: 'youtube', state: 'running', params: {}, recommendation: tapesRow(STAGE_B, 'A') });
    assert.equal(other.vm.discover.modal.view, 'plugins', 'a download lives on the Plug-Ins view');
  });

  test('a running only-missing copy keeps its choice even once the library has every album by name', async () => {
    const reads = readsOf({ albumSongs: songsOf(3), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] }, localAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] } });
    const { vm } = makeWindow({ reads });
    const mJob = copyJob({ params: { scope: 'artist-missing' } });
    await vm.openDiscoverModalForJob(mJob);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': mJob };
    assert.equal(vm.discover.modal.artist.missing, 0);
    assert.equal(vm.dmKeepMissingChoice(), true);
    assert.equal(vm.dmKeepRow().row.state, 'running');
    vm.discover.modal.jobs = {};
    assert.equal(vm.dmKeepMissingChoice(), false, 'once it is gone, nothing missing hides it');
  });
});

describe('the recommendation window: what album focus and a reopened failure show (vp.js)', () => {
  const YT = { name: 'youtube', title: 'YouTube download', capabilities: ['acquire'] };

  test('album focus has no Plug-Ins view: no tab to switch to, and no "Get it" row that would run a song job on the card\'s best row', async () => {
    const song = makeWindow({ reads: STAGE_READS(), remembered: 'plugins', plugins: [COPY, YT] });
    await song.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    assert.deepEqual(song.vm.dmGetItRows().map((r) => r.plugin.name), ['youtube'], 'a song\'s window: the download is offered on its Plug-Ins view');
    song.vm.setDiscoverModalView('plugins');
    assert.equal(song.vm.discover.modal.view, 'plugins');

    const { vm, remembered } = makeWindow({ reads: STAGE_READS(), remembered: 'federation', plugins: [COPY, YT] });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', view: 'federation', seedPlain: 'x' });
    assert.equal(vm.discover.modal.view, 'federation');
    vm.setDiscoverModalView('plugins');
    assert.equal(vm.discover.modal.view, 'federation', 'the album\'s window stays on Federation');
    assert.equal(remembered(), 'federation', 'and the session\'s choice is untouched');
    assert.deepEqual(vm.dmGetItRows(), [], 'no download row for raws[0] under the album\'s header');
    vm.setDiscoverModalView('federation');
    assert.equal(vm.discover.modal.view, 'federation');
  });

  // A failed only-missing copy, reopened from the strip: the peer went
  // away, so its listing answered nothing (the facts are unknown).
  const failedMissing = (over) => copyJob({ id: 77, key: 'artist-missing:x', params: { scope: 'artist-missing' }, state: 'failed', progress: null, statusText: null,
    error: 'Stage Peer B is unreachable', ...over });
  const goneReads = () => readsOf({ albumSongs: null, peerAlbums: null, localAlbums: { albums: [peerAlbumItem('Night Market')] } });

  test('a FAILED only-missing copy reopened from the strip lands on that job — its error and its Retry — not on an idle "Add artist"', async () => {
    const { vm, starts } = makeWindow({ reads: goneReads() });
    const job = failedMissing();
    await vm.openDiscoverModalForJob(job);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': job };
    const a = vm.discover.modal.artist;
    assert.deepEqual([a.albums, a.missing, a.local], [null, null, 1], 'the facts: unknown');
    assert.equal(vm.dmKeepChosen(), 'artist');
    assert.equal(vm.dmKeepMissingChoice(), true, 'the failed job holds the choice');
    assert.equal(vm.dmKeepMissingLabel(), 'Only the albums you don’t have', 'no "0 albums" it cannot count');
    assert.equal(vm.dmKeepScope(), 'artist-missing');
    const k = vm.dmKeepRow();
    assert.deepEqual([k.row.state, k.row.sub.text, k.row.actions], ['failed', 'Stage Peer B is unreachable', ['retry']]);
    assert.equal(vm.dmKeepIdle(), false);
    assert.equal(vm.dmKeepTitle(), 'Add what you’re missing');
    vm.dmKeepStart();   // the job row's Retry emits start
    assert.deepEqual(starts, [{ plugin: 'federation-copy', choice: null, scope: 'artist-missing' }], 'Retry runs the same only-missing copy, never the broader artist copy');
    // once the job is gone, unknown facts offer no checkbox: the plain artist copy
    vm.discover.modal.jobs = {};
    assert.equal(vm.dmKeepMissingChoice(), false);
    assert.equal(vm.dmKeepScope(), 'artist');
  });

  test('the same with nothing missing by name now, with a copy stopped early, and with a refused start; another server\'s failed copy never holds it', async () => {
    const allHere = readsOf({ albumSongs: songsOf(3), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] }, localAlbums: { albums: [peerAlbumItem('Borrowed Tapes')] } });
    const { vm } = makeWindow({ reads: allHere });
    await vm.openDiscoverModalForJob(failedMissing());
    assert.equal(vm.discover.modal.artist.missing, 0);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': failedMissing() };
    assert.equal(vm.dmMissingRows().length, 1, 'the slot is kept for its job');
    assert.deepEqual([vm.dmKeepScope(), vm.dmKeepRow().row.state], ['artist-missing', 'failed']);
    assert.equal(vm.dmKeepMissingLabel(), 'Only the albums you don’t have');
    // stopped by the transfer limit (a many-song job ends 'done')
    const stopped = failedMissing({ state: 'done', error: null, result: { scope: 'artist-missing', albums: [], skippedAlbums: [], songs: { total: 2, copied: [{}], skipped: [], failed: [{}] }, counts: { total: 2, copied: 1, skipped: 0, failed: 1 }, stopped: 'quota', peer: STAGE_B } });
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': stopped };
    assert.deepEqual([vm.dmKeepScope(), vm.dmKeepRow().row.state], ['artist-missing', 'stopped']);
    // a start the server refused: its words stay on the card
    vm.discover.modal.jobs = {};
    vm.discover.modal.jobErrors = { 'federation-copy@artist-missing': 'Uploading Disabled' };
    vm.discover.modal.keep.onlyMissing = true;
    assert.equal(vm.dmKeepScope(), 'artist-missing');
    assert.equal(vm.dmText(vm.dmKeepRow().row.sub), 'Uploading Disabled');
    // a finished copy that went well does not keep a choice with nothing left to add
    vm.discover.modal.jobErrors = {};
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': failedMissing({ state: 'done', error: null, result: { scope: 'artist-missing', albums: [], skippedAlbums: [], songs: { total: 1, copied: [{}], skipped: [], failed: [] }, counts: { total: 1, copied: 1, skipped: 0, failed: 0 }, stopped: null, peer: STAGE_B } }) };
    assert.equal(vm.dmKeepMissingChoice(), false);
    // C's failed copy is not B's: the card is B's own, idle
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': failedMissing({ recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher') }) };
    assert.equal(vm.dmKeepMissingChoice(), false);
    assert.equal(vm.dmKeepScope(), 'artist');
  });

  test('a copy that found nothing to take says so when its window is closed — and a many-song failure toasts its counts', async () => {
    const { vm, toasts } = makeWindow({ reads: STAGE_READS() });
    const guest = { id: 80, plugin: 'federation-copy', key: 'artist:x', state: 'done', params: { scope: 'artist' }, error: null,
      recommendation: tapesRow(STAGE_B, 'Party Verse', { album: 'Block Party Comp' }),
      result: { scope: 'artist', albums: [], skippedAlbums: [{ name: 'Block Party Comp', year: 2020, trackCount: 12, why: 'appearance' }],
        songs: { total: 0, copied: [], skipped: [], failed: [] }, counts: { total: 0, copied: 0, skipped: 0, failed: 0 }, stopped: null, peer: STAGE_B } };
    assert.equal(J.jobRowState(guest).state, 'nothing');
    vm.toastDiscoverJob(guest);
    assert.equal(toasts.length, 1, 'never silent');
    assert.deepEqual([toasts[0].kind, toasts[0].title, toasts[0].message], ['info', 'Nothing to copy', 'Boukmanflow · Nothing of theirs to copy · they only appear on 1 album there']);
    toasts.length = 0;
    const allFailed = { ...guest, id: 81, params: { scope: 'album' }, key: 'album:x',
      result: { scope: 'album', songs: { total: 2, copied: [], skipped: [], failed: [{}, {}] }, counts: { total: 2, copied: 0, skipped: 0, failed: 2 }, stopped: null, peer: STAGE_B } };
    vm.toastDiscoverJob(allFailed);
    assert.deepEqual([toasts[0].kind, toasts[0].title], ['error', 'Copy from a connected server failed']);
    assert.match(toasts[0].message, /2 failed/, 'a done job has no error: its counts say what happened');
    toasts.length = 0;
    vm.toastDiscoverJob({ ...guest, id: 82, params: {}, key: 'text:x', state: 'failed', error: 'does not allow copies', result: null });
    assert.equal(toasts[0].message, 'does not allow copies', 'a song\'s failure: the server\'s own words, as before');
    assert.equal(EN['discover.job.toastNothing'], 'Nothing to copy');
  });
});

// A compilation on Stage Peer B (2026-10-19: the user's "for compilation
// albums, copy the whole album"): 'Mixtape Vol 1', credited 'Various
// Artists', with songs by Ana and Ben. The rows carry the album's credit
// (`albumArtist`); the window lists, counts, plays, views and copies the
// album by it, whole — and keeps the track artist's line and scopes.
describe('the recommendation window on a compilation (vp.js)', () => {
  const mix = (title, artist, over) => tapesRow(STAGE_B, title, {
    artist, album: 'Mixtape Vol 1', albumArtist: 'Various Artists', year: 2020, filepath: `peerlib/VA/Mixtape Vol 1/${title}.mp3`, ...over,
  });
  const ANA = mix('Wind One', 'Ana');
  const BEN = mix('Ben Song', 'Ben');
  // the peer's and the library's reads, each call recorded
  const compReads = (asked) => ({
    federationPeers: () => Promise.resolve({ peers: [{ ...STAGE_B, lastSeen: null, lastStatus: 'ok' }] }),
    peer: {
      metadata: () => Promise.resolve({ metadata: { format: 'mp3' } }),
      albumSongs: (id, body) => { asked.push(['albumSongs', id, body]); return Promise.resolve(songsOf(4)); },
      artistAlbums: (id, body) => {
        asked.push(['artistAlbums', id, body]);
        return Promise.resolve({ albums: [peerAlbumItem(`${body.artist} Alone`, { album_artist: body.artist, artists: [body.artist] }),
          peerAlbumItem('Mixtape Vol 1', { album_artist: 'Various Artists', artists: ['Various Artists', 'Ana', 'Ben'], compilation: true, track_count: 4 })] });
      },
    },
    artistAlbums: (body) => { asked.push(['localArtistAlbums', body]); return Promise.resolve({ albums: [] }); },
  });
  const albumKey = (rec) => keysOfRec(rec).album;

  test('a card\'s ⋯ (raws[0]): "Various Artists · 2020 · 4 songs", the count from the album listed by its credit — the artist\'s facts stay the track artist\'s', async () => {
    const asked = [];
    const { vm, starts } = makeWindow({ reads: compReads(asked) });
    await vm.openDiscoverModal(ANA, 'federation', { seedPlain: 'x', focus: 'album', view: 'federation' });
    assert.deepEqual(asked.filter((a) => a[0] === 'albumSongs'), [['albumSongs', 1, { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists', year: 2020 }]],
      'by the album\'s credit, NOT narrowed by Ana — what the album copy lists (federation-copy albumListing)');
    assert.deepEqual(asked.filter((a) => a[0] !== 'albumSongs'), [['artistAlbums', 1, { artist: 'Ana' }], ['localArtistAlbums', { artist: 'Ana' }]]);
    assert.equal(vm.dmHeadTitle(), 'Mixtape Vol 1');
    assert.equal(vm.dmSubtitle(), 'Various Artists · 2020 · 4 songs');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', '4 songs'], ['artist', '2 albums']]);
    assert.equal(vm.dmKeepChosen(), 'album');
    assert.equal(vm.dmAlbumIdleSub(), 'Copies its 4 songs from Stage Peer B into your library');
    assert.match(vm.dmArtistIdleSub('artist'), /^Every album by Ana on Stage Peer B/, 'Artist is still Ana\'s');
    vm.dmKeepStart();
    assert.deepEqual(starts, [{ plugin: 'federation-copy', choice: null, scope: 'album' }]);
    // what the job is started with: the row, its credit included — so its
    // key is the one Ben's row looks up (src/discovery-plugins jobKeysFor)
    const rec = vm.dmRecommendation();
    assert.equal(rec.albumArtist, 'Various Artists');
    assert.equal(albumKey(rec), albumKey(BEN), 'one album copy for every song of the compilation');
    assert.notEqual(albumKey(rec), albumKey({ ...ANA, albumArtist: null }), 'not the track artist\'s key any more');
  });

  test('a compilation song\'s own ⋯: This song | Album (the whole compilation) | Artist (the track artist)', async () => {
    const asked = [];
    const { vm } = makeWindow({ reads: compReads(asked) });
    await vm.openDiscoverModal(BEN, 'federation', { seedPlain: 'x', view: 'federation' });
    assert.equal(vm.discover.modal.focus, null);
    assert.equal(vm.dmSubtitle(), 'Ben · Mixtape Vol 1 · 2020 · 3:41', 'the song\'s header names its own artist');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['song', '3:41 · mp3'], ['album', '4 songs'], ['artist', '2 albums']]);
    assert.equal(vm.dmAlbumFacts(), '2020 · 4 songs · 13:20 · none in your library', 'the album line: the whole compilation');
    assert.deepEqual(asked.find((a) => a[0] === 'albumSongs')[2], { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists', year: 2020 });
    assert.deepEqual(asked.find((a) => a[0] === 'artistAlbums')[2], { artist: 'Ben' });
    vm.dmKeepChoose('album');
    assert.equal(vm.dmKeepScope(), 'album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album');
  });

  test('Album needs the album and a credit — the album artist alone will do; Artist still needs the track artist', async () => {
    const credited = makeWindow({ reads: compReads([]) });
    await credited.vm.openDiscoverModal(mix('Untagged Performer', null), 'federation', { view: 'federation' });
    assert.deepEqual(credited.vm.dmKeepChoices().map((c) => c.scope), ['song', 'album']);
    assert.equal(credited.vm.dmScopeRows('album').length, 1);
    assert.deepEqual(credited.vm.dmScopeRows('artist'), []);
    assert.deepEqual(credited.vm.dmScopeRows('artist-missing'), []);
    // a blank credit is none: back to the track artist, then to nothing
    const blank = makeWindow({ reads: compReads([]) });
    await blank.vm.openDiscoverModal(mix('Blank', '', { albumArtist: '  ' }), 'federation', { view: 'federation' });
    assert.deepEqual(blank.vm.dmKeepChoices().map((c) => c.scope), ['song'], 'no credit at all: no Album (the jobs route\'s 400)');
    // an album job reopened from the strip, started from a card's album
    // (the album and its credit, no track artist): the album, Album offered
    const reopened = makeWindow({ reads: compReads([]) });
    const job = copyJob({ key: albumKey(ANA), recommendation: { source: 'federation', peer: { ...STAGE_B }, album: 'Mixtape Vol 1', albumArtist: 'Various Artists', filepath: 'peerlib/VA/Mixtape Vol 1/Wind One.mp3' } });
    await reopened.vm.openDiscoverModalForJob(job);
    assert.equal(reopened.vm.discover.modal.focus, 'album');
    reopened.vm.discover.modal.jobs = { 'federation-copy@album': job };
    assert.deepEqual(reopened.vm.dmKeepChoices().map((c) => c.scope), ['album']);
    assert.equal(reopened.vm.dmKeepRow().row.state, 'running', 'the card is the job');
    assert.equal(reopened.vm.dmSubtitle(), 'Various Artists · 4 songs');
  });

  test('Play / Add album and View album ask for the album as its credit holds it; an ordinary row keeps its artist', async () => {
    const asked = [];
    const { vm, viewed, fedQueued } = makeWindow({ reads: compReads(asked) });
    await vm.openDiscoverModal(ANA, 'federation', { focus: 'album', view: 'federation' });
    vm.discover.modal.album = { ...vm.discover.modal.album, songs: null };   // not listed yet: Add album asks
    asked.length = 0;
    await vm.dmQueueAlbum(false);
    assert.deepEqual(asked, [['albumSongs', 1, { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists', year: 2020 }]]);
    assert.equal(fedQueued.length, 4, 'the whole compilation queued');
    await vm.openDiscoverModal(ANA, 'federation', { focus: 'album', view: 'federation' });
    vm.dmViewAlbum();
    assert.deepEqual(viewed, [{ 'data-album': 'Mixtape Vol 1', 'data-album-artist': 'Various Artists', 'data-year': '2020', 'data-peer': '1' }],
      'getAlbumsOnClick lists it by album_artist, never by Ana');
    viewed.length = 0;
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { view: 'federation' });
    vm.dmViewAlbum();
    assert.deepEqual(viewed, [{ 'data-album': 'Borrowed Tapes', 'data-artist': 'Boukmanflow', 'data-year': '2019', 'data-peer': '1' }], 'no credit (an older peer): the track artist, as before');
  });
});

describe('index.html: the window\'s album focus', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8');
  const win = HTML.slice(HTML.indexOf('class="dmodal-shadow"'), HTML.indexOf('id="pop"'));
  test('the header names the album; Listen plays the album in its place; no ISRC (a recording\'s) on the album', () => {
    assert.match(win, /id="dmodal-title">\{\{ dmHeadTitle\(\) \}\}</);
    assert.match(win, /<div v-if="dmAlbumFocus\(\)" class="dm-play">[\s\S]*?v-on:click="dmQueueAlbum\(true\)"[\s\S]*?dmAlbumPlaySub\(\)[\s\S]*?v-on:click="dmQueueAlbum\(false\)"[\s\S]*?v-on:click="dmViewAlbum"/);
    assert.match(win, /<div v-else class="dm-play">[\s\S]*?v-on:click="dmPlayNow"/);
    assert.match(win, /<div v-if="discover\.modal\.track\.album && !dmAlbumFocus\(\)">/, 'the album line is the play line\'s in album focus');
    assert.match(win, /v-if="discover\.modal\.track\.isrc && !dmAlbumFocus\(\)" class="dmodal-isrc"/);
  });
  test('album focus draws no Federation | Plug-Ins tabs; the checkbox names its count only when it has one', () => {
    assert.match(win, /<div v-if="discover\.modal\.source === 'federation' && discover\.plugins\.available && !dmAlbumFocus\(\)" class="dmodal-tabs" role="tablist">/);
    assert.match(win, /<label v-if="dmKeepMissingChoice\(\)" class="dm-check">[\s\S]*?\{\{ dmKeepMissingLabel\(\) \}\}<\/label>/);
    assert.equal(EN['discover.modal.onlyMissingNoCount'], 'Only the albums you don’t have');
  });
  test('no 30 second previews on a connected server\'s row — the whole song plays', () => {
    assert.match(win, /<section v-if="discover\.modal\.source !== 'federation' && discoverPreviewPlugins\(\)\.length" class="dmodal-section">/);
  });
  test('en.json: the paired row no longer names the removed "From your peers"', () => {
    assert.ok(!/From your peers/i.test(EN['discover.modal.pairedSub']));
    assert.equal(EN['discover.job.fromPeer'], 'from {{peer}}');
  });
});

describe('fedQueueMeta (a peers row\'s lite metadata for the queue)', () => {
  test('title, artist, album, length and the row\'s cover as the song\'s album-art', () => {
    const raw = fedRow(SAM, 'Q1', { albumArt: 'aa11.jpeg' });
    assert.deepEqual(D.fedQueueMeta(raw), { title: 'Q1', artist: 'Artist Q', duration: 243, album: 'Album P1', 'album-art': 'aa11.jpeg' },
      'songArtUrl draws a federation song\'s album-art through the peer art proxy');
  });
  test('no albumArt (a bare track, an older peer): no album-art, the default cover', () => {
    const bare = D.fedQueueMeta(fedRow(SAM, 'Q2', { albumArt: null, album: null }));
    assert.deepEqual(bare, { title: 'Q2', artist: 'Artist Q', duration: 243 });
    assert.equal('album-art' in D.fedQueueMeta(fedRow(SAM, 'Q3')), false);
    assert.deepEqual(D.fedQueueMeta(undefined), { title: '', artist: '', duration: null });
  });
});

describe('peerGroups (its edges)', () => {
  test('an absent section', () => {
    assert.deepEqual(D.peerGroups(historyResponse()), { groups: [], count: 0, searched: null });
    assert.deepEqual(D.peerGroups(undefined).groups, []);
  });
});

// Several connected servers, best matches interleaved across them.
const TOM = { id: 4, name: 'Tom’s server' };
const MANY = {
  peers: [
    { ...SAM, reachable: true, mismatched: false, results: [
      fedRow(SAM, 'S1', { similarity: 0.9, album: 'Blue', artist: 'Artist Q' }),
      fedRow(SAM, 'S2', { similarity: 0.6, album: 'Blue', artist: 'artist q ' }),
      fedRow(SAM, 'S3', { similarity: 0.5, album: null }),
      fedRow(SAM, 'S4', { similarity: 0.4, album: 'Red', artist: 'Artist R', art: 'red.jpg' }),
    ] },
    { ...BEE, reachable: false, mismatched: false, results: [fedRow(BEE, 'B1', { similarity: 0.99, album: 'Gone' })] },
    { ...TOM, reachable: true, mismatched: false, results: [
      fedRow(TOM, 'T1', { similarity: 0.8, album: 'Blue', artist: 'Artist Q' }),
      fedRow(TOM, 'T2', { similarity: null, album: 'Green' }),
    ] },
    { ...CEE, reachable: true, mismatched: true, results: [fedRow(CEE, 'C1', { similarity: 0.95, album: 'Other' })] },
  ],
  searched: { peers: 2, unreachable: 1, mismatched: 1 },
};
const manyGroups = () => D.peerGroups({ peers: peersSection(MANY) }).groups;

describe('peerSongRows', () => {
  test('one flat list: playable rows only, best match first across the servers', () => {
    assert.deepEqual(D.peerSongRows(manyGroups()).map((r) => r.title), ['S1', 'T1', 'S2', 'S3', 'S4', 'T2']);
    assert.deepEqual(D.peerSongRows(D.peerGroups(peersResponse())).map((r) => r.title), ['P1', 'P2', 'P3']);
    assert.deepEqual(D.peerSongRows([]), []);
    assert.deepEqual(D.peerSongRows(undefined), []);
  });
});

describe('peerAlbums', () => {
  test('playable rows grouped by peer + album + artist (no album credit on these rows), best first, with what the card needs', () => {
    const cards = D.peerAlbums(manyGroups());
    assert.deepEqual(cards.map((c) => [c.peerName, c.album, c.artist]), [
      ['Sam’s server', 'Blue', 'Artist Q'],
      ['Tom’s server', 'Blue', 'Artist Q'],
      ['Sam’s server', 'Red', 'Artist R'],
      ['Tom’s server', 'Green', 'Artist Q'],
    ], 'one album per server; untagged rows, offline and mismatched peers left out');
    const [blue] = cards;
    assert.equal(blue.peerId, 1);
    assert.deepEqual(blue.paths, ['music/q/S1.mp3', 'music/q/S2.mp3'], 'case and spaces fold');
    assert.equal(blue.raws.length, 2);
    assert.equal(blue.raws[0].source, 'federation', 'raws queue through the federation stream');
    assert.equal(blue.art, null);
    assert.equal(cards[2].art, 'red.jpg');
    assert.equal(typeof blue.key, 'string');
    assert.notEqual(blue.key, cards[1].key);
    for (const c of cards) { assert.equal('similarityPct' in c, false, 'no percentage'); }
  });

  test('capped by an option; empty when nothing is tagged or playable', () => {
    assert.equal(D.peerAlbums(manyGroups(), { max: 2 }).length, 2);
    assert.equal(D.peerAlbums(manyGroups(), { max: 0 }).length, 0);
    const many = { peers: [{ ...SAM, reachable: true, mismatched: false, results: Array.from({ length: 20 }, (_, i) => fedRow(SAM, `N${i}`, { album: `Album ${i}` })) }], searched: {} };
    assert.equal(D.peerAlbums(D.peerGroups({ peers: peersSection(many) })).length, D.ALBUM_STRIP_MAX);
    const untagged = { peers: [{ ...SAM, reachable: true, mismatched: false, results: [fedRow(SAM, 'U', { album: '' })] }], searched: {} };
    assert.deepEqual(D.peerAlbums(D.peerGroups({ peers: peersSection(untagged) })), []);
    assert.deepEqual(D.peerAlbums([]), []);
  });

  // 2026-10-19: the rows carry the album's own credit (albumArtist).
  const CREDITED = { peers: [
    { ...SAM, reachable: true, mismatched: false, results: [
      // an ISRC as a raw tag spells it: the route keeps the row, ISRC nulled
      fedRow(SAM, 'Wind One', { artist: 'Ana', album: 'Mixtape Vol 1', albumArtist: 'Various Artists', similarity: 0.9, isrc: 'US-RC1-76-07839', albumArt: 'mix.jpeg' }),
      fedRow(SAM, 'Ben Song', { artist: 'Ben', album: 'Mixtape Vol 1', albumArtist: 'Various Artists', similarity: 0.8 }),
      fedRow(SAM, 'Ferry One', { artist: 'Nova', album: 'Night Ferry', albumArtist: 'Nova', similarity: 0.7 }),
      fedRow(SAM, 'Ferry Guest', { artist: 'Nova feat. Kai', album: 'Night Ferry', albumArtist: 'Nova', similarity: 0.6 }),
      fedRow(SAM, 'Hits One', { artist: 'Other Band', album: 'Greatest Hits', albumArtist: 'Other Band', similarity: 0.5 }),
      fedRow(SAM, 'Hits Two', { artist: 'Nova', album: 'Greatest Hits', albumArtist: 'Nova', similarity: 0.4 }),
    ] },
    // a peer on an older server: no albumArtist on its rows
    { ...TOM, reachable: true, mismatched: false, results: [fedRow(TOM, 'Tom Wind', { artist: 'Ana', album: 'Mixtape Vol 1', similarity: 0.3 })] },
  ], searched: { peers: 2 } };
  const creditedGroups = () => D.peerGroups({ peers: peersSection(CREDITED) });

  test('a compilation is ONE card under its album artist, whoever performs each song; a guest track joins its album; same-named albums by two credits stay two', () => {
    const cards = D.peerAlbums(creditedGroups());
    assert.deepEqual(cards.map((c) => [c.peerId, c.album, c.artist, c.albumArtist, c.raws.map((r) => r.title)]), [
      [1, 'Mixtape Vol 1', 'Various Artists', 'Various Artists', ['Wind One', 'Ben Song']],
      [1, 'Night Ferry', 'Nova', 'Nova', ['Ferry One', 'Ferry Guest']],
      [1, 'Greatest Hits', 'Other Band', 'Other Band', ['Hits One']],
      [1, 'Greatest Hits', 'Nova', 'Nova', ['Hits Two']],
      [4, 'Mixtape Vol 1', 'Ana', null, ['Tom Wind']],
    ], 'an older peer\'s rows group by the track artist, as before');
    const [mixtape] = cards;
    assert.equal(mixtape.raws[0].isrc, null, 'the malformed ISRC row is kept, the fact nulled, and still on its card');
    assert.equal(mixtape.art, 'mix.jpeg');
    assert.deepEqual(mixtape.paths, ['music/q/Wind One.mp3', 'music/q/Ben Song.mp3']);
    // the server's own keys: the card's rows share one album copy, each keeps its own artist
    const [a, b] = mixtape.raws.map(keysOfRec);
    assert.equal(a.album, b.album, 'Album from either row is the same whole-album job');
    assert.notEqual(a.artist, b.artist);
    // what the card asks of the peer: the album whole, by its credit
    assert.deepEqual(D.peerAlbumQuery(mixtape), { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists' });
    assert.deepEqual(D.peerAlbumQuery(cards[4]), { album: 'Mixtape Vol 1', artist: 'Ana' }, 'no credit: the track artist narrows; no album_artist key at all');
  });

  test('the rows expose the credit (leadFields): the album artist, \'\' from an older peer', () => {
    const rows = D.peerSongRows(creditedGroups());
    assert.deepEqual(rows.map((r) => [r.title, r.artist, r.albumArtist]), [
      ['Wind One', 'Ana', 'Various Artists'], ['Ben Song', 'Ben', 'Various Artists'], ['Ferry One', 'Nova', 'Nova'],
      ['Ferry Guest', 'Nova feat. Kai', 'Nova'], ['Hits One', 'Other Band', 'Other Band'], ['Hits Two', 'Nova', 'Nova'], ['Tom Wind', 'Ana', ''],
    ]);
    assert.equal(rows[0].subtitle, 'Ana · Mixtape Vol 1', 'a song row still reads "Artist · Album"');
    assert.equal(D.networkRows(historyResponse()).rows[0].albumArtist, '', 'a network lead has none');
  });

  test('albumCreditOf / peerAlbumQuery are the copy\'s own albumCredit / albumListing', () => {
    const recs = [
      { album: 'Mixtape Vol 1', artist: 'Ana', albumArtist: 'Various Artists', year: 2020 },
      { album: 'Night Ferry', artist: 'Nova', albumArtist: null },
      { album: 'Night Ferry', artist: 'Nova', albumArtist: '   ' },
      { album: 'Mixtape Vol 1', artist: null, albumArtist: 'Various Artists' },
      { album: 'Mixtape Vol 1', artist: '', albumArtist: '' },
      { album: 'Loose', artist: 'Zed' },
    ];
    for (const rec of recs) {
      assert.equal(D.albumCreditOf(rec), serverAlbumCredit(rec), JSON.stringify(rec));
      const want = serverAlbumListing(rec);
      const q = D.peerAlbumQuery(rec);
      assert.deepEqual([q.album, q.artist, q.album_artist === undefined ? null : q.album_artist], [want.album, want.artist, want.albumArtist], JSON.stringify(rec));
    }
    assert.equal(D.albumCreditOf(null), null);
    assert.deepEqual(D.peerAlbumQuery(undefined), { album: '', artist: null });
  });

  test('a card\'s art is its first row\'s albumArt (best match first); none = the note tile', () => {
    const fan = { peers: [
      { ...SAM, reachable: true, mismatched: false, results: [
        fedRow(SAM, 'K2', { similarity: 0.5, album: 'Kite', albumArt: 'kite-b.jpeg' }),
        fedRow(SAM, 'K1', { similarity: 0.9, album: 'Kite', albumArt: 'kite-a.jpeg' }),
        fedRow(SAM, 'L1', { similarity: 0.8, album: 'Lark', albumArt: null }),
        fedRow(SAM, 'L2', { similarity: 0.7, album: 'Lark', albumArt: 'lark.jpeg' }),
        fedRow(SAM, 'M1', { similarity: 0.6, album: 'Moth' }),
      ] },
      { ...TOM, reachable: true, mismatched: false, results: [fedRow(TOM, 'K9', { similarity: 0.85, album: 'Kite', albumArt: 'tom-kite.jpeg' })] },
    ], searched: { peers: 2 } };
    const cards = D.peerAlbums(D.peerGroups({ peers: peersSection(fan) }));
    assert.deepEqual(cards.map((c) => [c.peerId, c.album, c.art]), [
      [1, 'Kite', 'kite-a.jpeg'],
      [4, 'Kite', 'tom-kite.jpeg'],
      [1, 'Lark', 'lark.jpeg'],
      [1, 'Moth', null],
    ], 'the best row\'s cover; a later row\'s when the first has none; each server\'s own');
  });
});

describe('pageLabels', () => {
  const g = (peer, playable) => ({ id: peer.id, name: peer.name, playable, rows: [] });
  test('the library labels always; the peers ones by who answered', () => {
    const none = collect(D.pageLabels([]));
    assert.deepEqual(none, {
      libraryAlbums: { key: 'dpage.albums.library', params: {} },
      librarySongs: { key: 'dpage.songs.library', params: {} },
      peerAlbums: null, peerSongs: null, peerName: null,
    }, 'no connected servers: no peers label at all');
    const one = collect(D.pageLabels(D.peerGroups(peersResponse()).groups));
    assert.deepEqual([one.peerAlbums, one.peerSongs, one.peerName], [
      { key: 'dpage.albums.peerOne', params: { name: 'Sam’s server' } },
      { key: 'dpage.songs.peerOne', params: { name: 'Sam’s server' } },
      'Sam’s server',
    ], 'one of three answered: its name');
    const two = collect(D.pageLabels(manyGroups()));
    assert.deepEqual([two.peerAlbums.key, two.peerSongs.key, two.peerName], ['dpage.albums.peerMany', 'dpage.songs.peerMany', null]);
    assert.equal(D.pageLabels([g(SAM, false)]).peerSongs.params.name, 'Sam’s server', 'nobody answered, one paired: still its name');
    assert.equal(D.pageLabels([g(SAM, false), g(BEE, false)]).peerSongs.key, 'dpage.songs.peerMany');
    assert.equal(D.pageLabels([{ ...g(SAM, true), name: '' }]).peerSongs.key, 'dpage.songs.peerMany', 'a nameless server');
    assert.equal(D.pageLabels(D.peerGroups(peersResponse())).peerName, 'Sam’s server', 'the whole answer works too');
  });
});

describe('Show more', () => {
  const rows = Array.from({ length: 37 }, (_, i) => `r${i + 1}`);
  test('pageSlice: 16 first, then 16 more, until the end', () => {
    const first = D.pageSlice(rows);
    assert.deepEqual([first.rows.length, first.shown, first.total, first.more, first.next], [16, 16, 37, true, 32]);
    const second = D.pageSlice(rows, first.next);
    assert.deepEqual([second.rows.length, second.more, second.next], [32, true, 37]);
    const last = D.pageSlice(rows, second.next);
    assert.deepEqual([last.rows.length, last.more, last.next], [37, false, 37]);
    assert.deepEqual(D.pageSlice(rows.slice(0, 5)), { rows: rows.slice(0, 5), shown: 5, total: 5, more: false, next: 5 });
    assert.deepEqual(D.pageSlice(undefined), { rows: [], shown: 0, total: 0, more: false, next: 0 });
    assert.deepEqual(D.pageSlice(rows, 8, 8).next, 16, 'a page size of its own');
    assert.equal(D.pageSlice(rows, 500).shown, 37);
  });

  test('columnBlocks: column-major halves of each block of 16, indexes kept', () => {
    const blocks = D.columnBlocks(D.pageSlice(rows, 32).rows);
    assert.equal(blocks.length, 2);
    const [a, b] = blocks;
    assert.deepEqual([a.start, a.perColumn], [0, 8]);
    assert.deepEqual(a.left.map((x) => x.row), rows.slice(0, 8), 'rows 1–8 left');
    assert.deepEqual(a.right.map((x) => x.row), rows.slice(8, 16), 'rows 9–16 right');
    assert.deepEqual(a.rows.map((x) => x.i), Array.from({ length: 16 }, (_, i) => i));
    assert.deepEqual([b.start, b.left[0].i, b.right[7].i], [16, 16, 31]);
    const short = D.columnBlocks(rows.slice(0, 26));
    assert.deepEqual([short[1].perColumn, short[1].left.length, short[1].right.length], [5, 5, 5], 'a short last block splits evenly');
    assert.deepEqual(D.columnBlocks(rows.slice(0, 1))[0].right, []);
    assert.deepEqual(D.columnBlocks([]), []);
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

// The play page's connected-server rows and album cards: one badge per
// server. Album and artist job keys carry no server (the registry's own
// jobKeysFor), so the lookup hands Stage Peer B's rows Stage Peer C's copy
// of the same album — the stage's 'Borrowed Tapes' (B holds two of its
// songs here, C one).
describe('connected servers\' badges: per server, the album cards from their rows', () => {
  const PB = { id: 1, name: 'Stage Peer B' };
  const PC = { id: 4, name: 'Stage Peer C' };
  const tape = (peer, title, similarity) => fedRow(peer, title, {
    artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2021, similarity, filepath: `peerlib/Boukmanflow/Borrowed Tapes/${title}.mp3`,
  });
  const TAPES = {
    peers: [
      { ...PB, reachable: true, mismatched: false, results: [tape(PB, 'Late Train Verse', 0.9), tape(PB, 'Corner Store Loop', 0.7), fedRow(PB, 'Glass One', { artist: 'Color Out', album: 'Glass', similarity: 0.6 })] },
      { ...PC, reachable: true, mismatched: false, results: [tape(PC, 'Rooftop Cypher', 0.8)] },
    ],
    searched: { peers: 2, unreachable: 0, mismatched: 0 },
  };
  const groups = () => D.peerGroups({ peers: peersSection(TAPES) });
  // best match first: B Late Train, C Rooftop, B Corner Store, B Glass One
  // one answer: a card finds its rows by raw row, as the page's do
  const page = () => {
    const g = groups();
    const rows = D.peerSongRows(g);
    const cards = D.peerAlbums(g);
    return { rows, cards, byTitle: (t) => rows.findIndex((r) => r.title === t) };
  };
  const recOf = (row, over) => ({ source: 'federation', peer: row.raw.peer, title: row.raw.title, artist: row.raw.artist, album: row.raw.album, year: row.raw.year, filepath: row.raw.filepath, ...over });
  const copy = (id, row, scope, state, result, over) => ({
    id, plugin: 'federation-copy', key: keysOfRec(row.raw)[scope], state, params: scope === 'song' ? {} : { scope },
    recommendation: recOf(row), result: result || null, progress: state === 'running' ? 0.4 : null, statusText: state === 'running' ? 'album 1 of 1 · 2 of 3 songs' : null, ...over,
  });
  const albumDone = (copied, over) => ({ scope: 'album', songs: { total: 3, copied: Array.from({ length: copied }, () => ({})), skipped: [], failed: [] }, counts: { total: 3, copied, skipped: 0, failed: 0 }, stopped: null, peer: PB, ...over });
  const lookedUp = (rows, jobs) => collect(D.jobBadges(rows, batchAnswer(rows.map((r) => r.raw), jobs), J));

  test('the fixture: one album key across both servers, the cards apart', () => {
    const { rows, cards, byTitle } = page();
    assert.deepEqual(rows.map((r) => [r.peerId, r.title]), [[1, 'Late Train Verse'], [4, 'Rooftop Cypher'], [1, 'Corner Store Loop'], [1, 'Glass One']]);
    assert.equal(keysOfRec(rows[byTitle('Late Train Verse')].raw).album, keysOfRec(rows[byTitle('Rooftop Cypher')].raw).album, 'the album key ignores the server');
    assert.deepEqual(cards.map((c) => [c.peerId, c.album, c.raws.length]), [[1, 'Borrowed Tapes', 2], [4, 'Borrowed Tapes', 1], [1, 'Glass', 1]]);
  });

  test('an album job badges every row of its card and the card; a song job only its row, never a card', () => {
    const { rows, cards, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    let badged = lookedUp(rows, [copy(30, late, 'album', 'running')]);
    for (const t of ['Late Train Verse', 'Corner Store Loop']) {
      const b = badged[byTitle(t)].badge;
      assert.deepEqual([b.state, b.tag, b.kind, b.slot, b.progress], ['running', 'discover.job.copying', 'discover.tray.kindAlbum', 'federation-copy@album', 40], t);
    }
    assert.equal(badged[byTitle('Glass One')].badge, null, 'another album: nothing');
    let cardBadges = D.peerAlbumBadges(cards, badged, J);
    assert.deepEqual([cardBadges[0].state, cardBadges[0].kind, cardBadges[0].jobId], ['running', 'discover.tray.kindAlbum', 30]);
    assert.deepEqual([cardBadges[1], cardBadges[2]], [null, null], 'C\'s card and the other album stay bare');
    assert.equal(D.anyLiveBadge(badged), true);

    badged = lookedUp(rows, [copy(31, late, 'song', 'done', { copied: { vpath: 'collection', filepath: 'collection/From peers/Boukmanflow/Borrowed Tapes/Late Train Verse.mp3' } })]);
    assert.deepEqual([badged[byTitle('Late Train Verse')].badge.state, badged[byTitle('Late Train Verse')].badge.tag], ['copied', 'discover.job.inCollection']);
    assert.equal(badged[byTitle('Corner Store Loop')].badge, null, 'one song of the album is not the album');
    cardBadges = D.peerAlbumBadges(cards, badged, J);
    assert.deepEqual(cardBadges, [null, null, null], 'a song job never badges a card');
  });

  test('another server\'s album copy never badges this server\'s rows or card — running or done — and stays in their jobs, marked', () => {
    const { rows, cards, byTitle } = page();
    const roof = rows[byTitle('Rooftop Cypher')];
    for (const job of [copy(40, roof, 'album', 'running'), copy(41, roof, 'album', 'done', albumDone(1, { peer: PC }))]) {
      const badged = lookedUp(rows, [job]);
      for (const t of ['Late Train Verse', 'Corner Store Loop']) {
        const r = badged[byTitle(t)];
        assert.equal(r.badge, null, `${t} (${job.state}): C's copy is not B's`);
        assert.equal(r.jobs['federation-copy@album'].id, job.id, 'kept in the row\'s jobs (the window says "from Stage Peer C")');
        assert.deepEqual(r.otherPeer, ['federation-copy@album']);
      }
      const own = badged[byTitle('Rooftop Cypher')];
      assert.equal(own.badge.jobId, job.id, 'C\'s own row shows it');
      assert.deepEqual(own.otherPeer, []);
      const cardBadges = D.peerAlbumBadges(cards, badged, J);
      assert.equal(cardBadges[0], null, 'B\'s Borrowed Tapes card: no badge');
      assert.equal(cardBadges[1].jobId, job.id, 'C\'s card: its own copy');
    }
    const done = D.peerAlbumBadges(cards, lookedUp(rows, [copy(41, roof, 'album', 'done', albumDone(1, { peer: PC }))]), J)[1];
    assert.deepEqual([done.state, done.tag, done.kind], ['copiedMany', 'discover.job.inCollection', 'discover.tray.kindAlbum']);
    // the poll's flat list merges the same way (no new lookup)
    const first = lookedUp(rows, []);
    const polled = D.jobBadges(first, { jobs: [copy(42, roof, 'album', 'running')] }, J);
    assert.equal(polled[byTitle('Late Train Verse')].badge, null);
    assert.deepEqual(polled[byTitle('Late Train Verse')].otherPeer, ['federation-copy@album']);
    assert.equal(polled[byTitle('Rooftop Cypher')].badge.jobId, 42);
  });

  test('a song copied from another server is the same recording: it badges the row wherever it came from', () => {
    const { rows, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    const fromC = copy(50, late, 'song', 'done', { copied: { vpath: 'collection', filepath: 'collection/x.mp3' } }, { recommendation: recOf(late, { peer: PC }) });
    const badged = lookedUp(rows, [fromC]);
    assert.equal(badged[byTitle('Late Train Verse')].badge.jobId, 50);
    assert.deepEqual(badged[byTitle('Late Train Verse')].otherPeer, []);
  });

  test('an artist job badges that server\'s rows and cards of the artist — never another server\'s, never another artist\'s', () => {
    const { rows, cards, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    for (const [scope, kind] of [['artist', 'discover.tray.kindArtist'], ['artist-missing', 'discover.tray.kindMissing']]) {
      const badged = lookedUp(rows, [copy(60, late, scope, 'queued')]);
      assert.deepEqual([badged[byTitle('Late Train Verse')].badge.kind, badged[byTitle('Corner Store Loop')].badge.kind], [kind, kind], scope);
      assert.equal(badged[byTitle('Rooftop Cypher')].badge, null, `${scope}: C's row`);
      assert.equal(badged[byTitle('Glass One')].badge, null, `${scope}: Color Out`);
      const cardBadges = D.peerAlbumBadges(cards, badged, J);
      assert.deepEqual(cardBadges.map((b) => (b ? [b.state, b.kind] : null)), [['queued', kind], null, null], scope);
    }
  });

  // An artist walk as federation-copy reports it (copyAlbums over
  // planArtistAlbums): each album walked with its own songs, or the error
  // its listing met; the albums left out, with why.
  const walked = (name, { copied = 0, skipped = 0, failed = 0, stopped = null, error = null } = {}) => (error
    ? { name, year: null, error, songs: { total: 0, copied: [], skipped: [], failed: [] }, bytes: 0, stopped: null }
    : { name, year: 2021, bytes: 0, stopped, songs: { total: copied + skipped + failed,
      copied: Array.from({ length: copied }, () => ({})), skipped: Array.from({ length: skipped }, () => ({ why: 'owned' })), failed: Array.from({ length: failed }, () => ({ error: 'x' })) } });
  const artistDone = (albums, skippedAlbums, over) => {
    const sum = (k) => albums.reduce((n, a) => n + a.songs[k].length, 0);
    const total = albums.reduce((n, a) => n + a.songs.total, 0);
    return { scope: 'artist', artist: { name: 'Boukmanflow' }, albums, skippedAlbums,
      songs: { total, copied: albums.flatMap((a) => a.songs.copied), skipped: albums.flatMap((a) => a.songs.skipped), failed: albums.flatMap((a) => a.songs.failed) },
      counts: { total, copied: sum('copied'), skipped: sum('skipped'), failed: sum('failed') }, stopped: null, peer: PB, ...over };
  };
  // B also holds a song Boukmanflow only guests on, on a compilation. Its
  // rows carry no album credit (a peer before 2026-10-19), so the card
  // groups by the track's artist and Discover draws 'Block Party Comp ·
  // Boukmanflow' — and the artist key is the same.
  const COMP = {
    peers: [{ ...PB, reachable: true, mismatched: false, results: [
      tape(PB, 'Late Train Verse', 0.9), tape(PB, 'Corner Store Loop', 0.7),
      fedRow(PB, 'Party Verse', { artist: 'Boukmanflow', album: 'Block Party Comp', year: 2020, similarity: 0.65, filepath: 'peerlib/VA/Block Party Comp/07 - Party Verse.mp3' }),
    ] }],
    searched: { peers: 1, unreachable: 0, mismatched: 0 },
  };
  const compPage = () => {
    const g = D.peerGroups({ peers: peersSection(COMP) });
    const rows = D.peerSongRows(g);
    return { rows, cards: D.peerAlbums(g), byTitle: (t) => rows.findIndex((r) => r.title === t) };
  };

  test('a finished artist copy speaks for each card as its walk did: a compilation they only guest on is never "in your collection"', () => {
    const { rows, cards, byTitle } = compPage();
    const late = rows[byTitle('Late Train Verse')];
    assert.deepEqual(cards.map((c) => [c.album, c.artist]), [['Borrowed Tapes', 'Boukmanflow'], ['Block Party Comp', 'Boukmanflow']]);
    assert.equal(keysOfRec(late.raw).artist, keysOfRec(rows[byTitle('Party Verse')].raw).artist, 'one artist key for both albums');
    const result = artistDone([walked('Borrowed Tapes', { copied: 2 })], [{ name: 'Block Party Comp', year: 2020, trackCount: 12, why: 'appearance' }]);
    const badged = lookedUp(rows, [copy(90, late, 'artist', 'done', result)]);
    for (const t of ['Late Train Verse', 'Corner Store Loop']) {
      const b = badged[byTitle(t)].badge;
      assert.deepEqual([b.state, b.tag, b.kind, b.jobId], ['copiedMany', 'discover.job.inCollection', 'discover.tray.kindArtist', 90], t);
    }
    assert.equal(badged[byTitle('Party Verse')].badge, null, 'the walk left the compilation out: nothing of it is in the library');
    assert.equal(badged[byTitle('Party Verse')].jobs['federation-copy@artist'].id, 90, 'still the row\'s job (the window shows it)');
    const cardBadges = D.peerAlbumBadges(cards, badged, J);
    assert.deepEqual(cardBadges.map((b) => (b ? [b.state, b.tag, b.kind] : null)), [['copiedMany', 'discover.job.inCollection', 'discover.tray.kindArtist'], null]);
    // while it runs, every card of the artist reads "copying · every album"
    const live = D.peerAlbumBadges(cards, lookedUp(rows, [copy(91, late, 'artist', 'running')]), J);
    assert.deepEqual(live.map((b) => b && [b.state, b.kind]), [['running', 'discover.tray.kindArtist'], ['running', 'discover.tray.kindArtist']]);
  });

  // Since 2026-10-19 the rows carry the album's credit: B's compilation
  // is one card, and one whole-album copy (the user's choice).
  const VA = {
    peers: [{ ...PB, reachable: true, mismatched: false, results: [
      fedRow(PB, 'Party Verse', { artist: 'Boukmanflow', album: 'Block Party Comp', albumArtist: 'Various Artists', year: 2020, similarity: 0.65, filepath: 'peerlib/VA/Block Party Comp/07 - Party Verse.mp3' }),
      fedRow(PB, 'Crowd Song', { artist: 'Color Out', album: 'Block Party Comp', albumArtist: 'Various Artists', year: 2020, similarity: 0.6, filepath: 'peerlib/VA/Block Party Comp/02 - Crowd Song.mp3' }),
    ] }],
    searched: { peers: 1, unreachable: 0, mismatched: 0 },
  };
  test('a compilation\'s album copy, started from any of its songs, badges its ONE card and every row of it', () => {
    const g = D.peerGroups({ peers: peersSection(VA) });
    const rows = D.peerSongRows(g);
    const cards = D.peerAlbums(g);
    assert.deepEqual(cards.map((c) => [c.album, c.artist, c.raws.length]), [['Block Party Comp', 'Various Artists', 2]]);
    const crowd = rows[1];
    // started from Color Out's song (the second row), not the card's raws[0]
    const badged = lookedUp(rows, [copy(99, crowd, 'album', 'running', null, { recommendation: recOf(crowd, { albumArtist: 'Various Artists' }) })]);
    assert.deepEqual(badged.map((r) => r.badge && [r.badge.state, r.badge.kind, r.badge.jobId]), [['running', 'discover.tray.kindAlbum', 99], ['running', 'discover.tray.kindAlbum', 99]]);
    assert.deepEqual(D.peerAlbumBadges(cards, badged, J).map((b) => b && [b.state, b.jobId]), [['running', 99]]);
    const done = lookedUp(rows, [copy(99, crowd, 'album', 'done', albumDone(2, { album: { name: 'Block Party Comp', artist: 'Color Out', albumArtist: 'Various Artists', year: 2020 } }))]);
    assert.deepEqual(D.peerAlbumBadges(cards, done, J).map((b) => b && [b.state, b.tag]), [['copiedMany', 'discover.job.inCollection']]);
    // an album job stored before the rows carried the credit keyed on the
    // track artist: the lookup no longer hands it to these rows
    const old = { ...copy(98, crowd, 'album', 'done', albumDone(1)), key: keysOfRec({ ...crowd.raw, albumArtist: null }).album };
    assert.deepEqual(lookedUp(rows, [old]).map((r) => r.badge), [null, null]);
  });

  test('album by album: its own songs\' account, "already yours" when only-missing left it out, nothing where its listing failed or the walk never reached it', () => {
    const { rows, cards, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    const card = (result, scope = 'artist') => {
      const badged = lookedUp(rows, [copy(95, late, scope, 'done', result)]);
      return [D.peerAlbumBadges(cards, badged, J)[0], badged[byTitle('Late Train Verse')].badge];
    };
    const states = (pair) => pair.map((b) => (b ? [b.state, b.tag] : null));
    // the job copied 3 elsewhere, but every song of THIS album failed
    const mixed = artistDone([walked('Borrowed Tapes', { failed: 2 }), walked('Second Wind', { copied: 3 })], []);
    assert.equal(J.jobRowState(copy(95, late, 'artist', 'done', mixed)).state, 'copiedMany', 'the job as a whole');
    assert.deepEqual(states(card(mixed)), [['failed', 'discover.job.failed'], ['failed', 'discover.job.failed']]);
    // the walk names albums as the peer's listing spells them: folded as name-key.js folds them
    assert.deepEqual(states(card(artistDone([walked('borrowed  TAPES', { copied: 2 })], []))), [['copiedMany', 'discover.job.inCollection'], ['copiedMany', 'discover.job.inCollection']]);
    assert.deepEqual(states(card(artistDone([walked('Borrowed Tapes', { skipped: 2 })], []))), [['owned', 'discover.job.owned'], ['owned', 'discover.job.owned']]);
    // only-missing left it out: the library has it
    const owned = artistDone([walked('Second Wind', { copied: 3 })], [{ name: 'Borrowed Tapes', year: 2021, trackCount: 2, why: 'owned' }], { scope: 'artist-missing' });
    const ownedPair = card(owned, 'artist-missing');
    assert.deepEqual(states(ownedPair), [['owned', 'discover.job.owned'], ['owned', 'discover.job.owned']]);
    assert.equal(ownedPair[0].kind, 'discover.tray.kindMissing');
    // its listing failed, the walk went on: nothing claimed for it
    assert.deepEqual(card(artistDone([walked('Borrowed Tapes', { error: 'Stage Peer B answered 500' }), walked('Second Wind', { copied: 3 })], [])), [null, null]);
    // the run stopped there (the transfer limit): stopped
    const quota = card(artistDone([walked('Second Wind', { copied: 3 }), walked('Borrowed Tapes', { error: 'transfer limit' })], [], { stopped: 'quota' }));
    assert.deepEqual(states(quota), [['stopped', 'discover.job.stopped'], ['stopped', 'discover.job.stopped']]);
    // stopped mid-album: that album stopped; one the walk never reached says nothing
    assert.deepEqual(states(card(artistDone([walked('Borrowed Tapes', { copied: 1, stopped: 'busy' })], [], { stopped: 'busy' }))), [['stopped', 'discover.job.stopped'], ['stopped', 'discover.job.stopped']]);
    assert.deepEqual(card(artistDone([walked('Second Wind', { copied: 1, stopped: 'quota' })], [], { stopped: 'quota' })), [null, null]);
    // a done artist job with no walk at all to read: nothing claimed
    assert.deepEqual(card({ counts: { total: 2, copied: 2, skipped: 0, failed: 0 }, songs: { total: 2, copied: [{}, {}], skipped: [], failed: [] }, stopped: null }), [null, null]);
    // a failed artist job (it never walked) still says so on every card of the artist
    const failed = lookedUp(rows, [copy(96, late, 'artist', 'failed', null, { error: 'Stage Peer B is unreachable' })]);
    assert.deepEqual([D.peerAlbumBadges(cards, failed, J)[0].state, failed[byTitle('Corner Store Loop')].badge.state], ['failed', 'failed']);
    // an album job is the album's: unchanged
    assert.equal(D.peerAlbumBadges(cards, lookedUp(rows, [copy(97, late, 'album', 'done', albumDone(3))]), J)[0].state, 'copiedMany');
  });

  test('nameKey is src/db/name-key.js\'s, byte for byte', () => {
    for (const s of ['Borrowed Tapes', '  borrowed\tTAPES ', 'Cold Open’s B‐Sides', '“Quoted” — Dash', 'Beyoncé', 'R.E.M.', '', null, undefined, 42]) {
      assert.equal(D.nameKey(s), serverNameKey(s), JSON.stringify(s));
    }
  });

  test('"done" is not "kept": a copy stopped by the quota reads stopped, one whose songs all failed reads failed — on rows and cards', () => {
    const { rows, cards, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    const quota = lookedUp(rows, [copy(70, late, 'album', 'done', albumDone(1, { stopped: 'quota' }))]);
    for (const b of [quota[byTitle('Late Train Verse')].badge, D.peerAlbumBadges(cards, quota, J)[0]]) {
      assert.deepEqual([b.state, b.tag, b.tagCls], ['stopped', 'discover.job.stopped', 'err']);
    }
    const failed = lookedUp(rows, [copy(71, late, 'album', 'done', albumDone(0, { songs: { total: 3, copied: [], skipped: [], failed: [{}, {}, {}] }, counts: { total: 3, copied: 0, skipped: 0, failed: 3 } }))]);
    const fb = D.peerAlbumBadges(cards, failed, J)[0];
    assert.deepEqual([fb.state, fb.tag, fb.tagCls], ['failed', 'discover.job.failed', 'err'], 'never "already yours"');
  });

  test('the card ranks as a row does: a live copy over a finished one; a folder job never badges', () => {
    const { rows, cards, byTitle } = page();
    const late = rows[byTitle('Late Train Verse')];
    const badged = lookedUp(rows, [copy(80, late, 'album', 'done', albumDone(3)), copy(81, late, 'artist', 'running')]);
    assert.deepEqual([D.peerAlbumBadges(cards, badged, J)[0].jobId, badged[byTitle('Late Train Verse')].badge.jobId], [81, 81]);
    const folder = { ...copy(82, late, 'song', 'running'), key: keysOfRec(late.raw).folder, params: { scope: 'folder' } };
    const withFolder = lookedUp(rows, [folder]);
    assert.equal(withFolder[byTitle('Late Train Verse')].badge, null, 'Discover never offers a folder copy');
    // no DISCOVERJOBS, no rows, a card with no raws: no badge, never a throw
    assert.deepEqual(D.peerAlbumBadges(cards, [], J), [null, null, null]);
    assert.deepEqual(D.peerAlbumBadges([{ peerId: 1 }], badged, J), [null]);
    assert.deepEqual(D.peerAlbumBadges(null, badged, J), []);
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
      assert.deepEqual(Object.values(s.sources).map((x) => x.status), ['absent', 'absent', 'absent']);
    }
    assert.equal(D.stateOf({ disabled: true }, FLAGS).state, 'off');
  });

  test('loading and failed', () => {
    const loading = D.stateOf(undefined, FLAGS);
    assert.equal(loading.state, 'loading');
    assert.deepEqual([loading.sources.library.status, loading.sources.network.status, loading.sources.peers.status], ['loading', 'absent', 'loading']);
    const exploring = D.stateOf(undefined, FLAGS, { page: 'explore' });
    assert.deepEqual([exploring.sources.library.status, exploring.sources.network.status, exploring.sources.peers.status], ['absent', 'loading', 'absent']);
    assert.equal(D.stateOf(undefined, { ...FLAGS, discoveryP2p: false }, { page: 'explore' }).sources.network.status, 'absent');
    const failed = collect(D.stateOf(null, FLAGS));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason.key, 'dpage.state.failed');
    assert.equal(failed.sources.library.status, 'failed');
    assert.equal('tabs' in failed, false, 'no segmented tabs');
  });

  test('a random seed: the server asks no connected server, so no peers column while that call is out', () => {
    const random = D.mergeResponses({ ...historyResponse(), seedSource: 'random' }, undefined, true);
    assert.equal(D.stateOf(random, FLAGS).sources.peers.status, 'absent');
    assert.equal(D.stateOf(D.mergeResponses(historyResponse(), undefined, true), FLAGS).sources.peers.status, 'loading', 'a history seed: still asking');
  });

  test('ready: the play page draws library + peers, the explore page the network', () => {
    const s = D.stateOf(merged(), FLAGS);
    assert.equal(s.state, 'ready');
    assert.equal(s.reason, null);
    assert.deepEqual(Object.entries(s.sources).map(([k, x]) => [k, x.status, x.count]), [['library', 'ready', 6], ['network', 'absent', 0], ['peers', 'ready', 3]]);
    const explore = D.stateOf(merged(), FLAGS, { page: 'explore' });
    assert.deepEqual(Object.entries(explore.sources).map(([k, x]) => [k, x.status, x.count]), [['library', 'absent', 0], ['network', 'ready', 3], ['peers', 'absent', 0]]);
  });

  test('scanPending: no seed analyzed — the sources wait, the seeds are listed', () => {
    const fan = { peers: [{ ...SAM, reachable: true, mismatched: false, results: [] }], searched: { peers: 1, unreachable: 0, mismatched: 0 } };
    const r = merged({
      notAnalyzed: true, seeds: HISTORY.map((x) => ({ ...x, analyzed: false })),
      library: { tracks: [], albums: [], capped: false }, network: { results: [], searched: { peers: 0, tracks: 0 } },
    }, { ...peersResponse(), peers: peersSection(fan) });
    const s = collect(D.stateOf(r, FLAGS));
    assert.equal(s.state, 'scanPending');
    assert.equal(s.reason.key, 'dpage.state.scanPending');
    for (const k of ['library', 'peers']) {
      assert.equal(s.sources[k].status, 'empty');
      assert.equal(s.sources[k].reason.key, 'dpage.source.waitingForScan');
    }
    assert.equal(collect(D.stateOf(r, FLAGS, { page: 'explore' })).sources.network.reason.key, 'dpage.source.waitingForScan');
  });

  test('nothingFinished: a random seed — or every finished song dropped', () => {
    const random = { seedSource: 'random', fallback: true, network: null, seeds: [seed('r', 'R', 'A', { outcome: null })] };
    const s = collect(D.stateOf(merged(random, { ...peersResponse(), peers: null }), FLAGS));
    assert.equal(s.state, 'nothingFinished');
    assert.equal(s.reason.key, 'dpage.state.nothingFinished');
    assert.equal(s.sources.peers.status, 'absent', 'no fan-out for a random seed: not drawn');
    assert.equal(s.sources.library.status, 'ready');
    assert.equal(D.stateOf(merged(random, null), FLAGS, { page: 'explore' }).sources.network.status, 'absent');
    const dropped = collect(D.stateOf(merged({ ...random, excluded: [{ hash: 'h1', filepath: 'x', metadata: {} }] }, null), FLAGS));
    assert.equal(dropped.reason.key, 'dpage.state.allDropped');
    assert.equal(dropped.sources.peers.status, 'failed');
    // no rotation any more: an un-analyzed batch is the scan-pending state
    const pending = { ...historyResponse(), notAnalyzed: true, seeds: [seed('u1', 'U', 'A', { analyzed: false })], library: { tracks: [], albums: [], capped: false } };
    assert.equal(D.stateOf(merged(pending, null), FLAGS, { rotated: true }).state, 'scanPending', 'an old opt is ignored');
  });

  test('the library empty: the one line alone (no button to widen it)', () => {
    const lib = collect(D.stateOf(merged({ library: { tracks: [], albums: [], capped: false } }), FLAGS)).sources.library;
    assert.deepEqual(lib, { status: 'empty', count: 0, reason: { key: 'dpage.library.nothing', params: {} } });
  });

  test('the network explains its emptiness (explore page)', () => {
    const net = (searchedPeers) => collect(D.stateOf(merged({ network: { results: [], searched: { peers: searchedPeers, tracks: 0 } } }), FLAGS, { page: 'explore' })).sources.network;
    assert.deepEqual([net(0).status, net(0).reason.key], ['empty', 'dpage.network.warmingUp']);
    assert.equal(net(3).reason.key, 'dpage.network.nothingNew');
  });

  test('connected servers: none paired → not drawn; paired but nothing playable → the quiet line', () => {
    const peers = (groups) => collect(D.stateOf(merged({}, { ...peersResponse(), peers: peersSection({ peers: groups, searched: {} }) }), FLAGS)).sources.peers;
    assert.deepEqual(peers([]), { status: 'absent', reason: null, count: 0 }, 'no connected servers: no label, strip or column');
    const quiet = { status: 'empty', count: 0, reason: { key: 'dpage.peers.quiet', params: {} } };
    assert.deepEqual(peers([{ ...BEE, reachable: false, mismatched: false, results: [] }]), quiet, 'offline');
    assert.deepEqual(peers([{ ...CEE, reachable: true, mismatched: true, results: [fedRow(CEE, 'C')] }]), quiet, 'another model: its rows do not count');
    assert.deepEqual(peers([{ ...SAM, reachable: true, mismatched: false, results: [] }, { ...BEE, reachable: false, results: [fedRow(BEE, 'B')] }]), quiet, 'nothing new');
    assert.deepEqual(peers([{ ...SAM, reachable: true, mismatched: false, results: [fedRow(SAM, 'S')] }, { ...BEE, reachable: false, results: [fedRow(BEE, 'B')] }]), { status: 'ready', reason: null, count: 1 }, 'playable rows only');
  });

  test('a source still in flight, a source not drawn', () => {
    const s = D.stateOf(D.mergeResponses(historyResponse(), undefined, true), FLAGS);
    assert.equal(s.sources.peers.status, 'loading');
    const noFed = D.stateOf(D.mergeResponses(historyResponse(), undefined, false), { ...FLAGS, federationDiscovery: false });
    assert.equal(noFed.sources.peers.status, 'absent');
    assert.equal(noFed.sources.network.status, 'absent', 'never on the play page');
  });
});

// ── prefs and option lists ────────────────────────────────────────────

describe('option lists', () => {
  test('the window options, the plug-in chips', () => {
    const w = collect(D.windowOptions(90));
    assert.deepEqual(w.map((o) => [o.value, o.label.key, o.selected]), [[7, 'dpage.window.days', false], [30, 'dpage.window.days', false], [90, 'dpage.window.days', true], [0, 'dpage.window.all', false]]);
    assert.equal(D.windowOptions('0')[3].selected, true, 'a stored string selects');
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
    assert.ok(EMITTED.length > 60, `collected ${EMITTED.length}`);
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

  test('every literal dpage key in the module', () => {
    const literals = [...new Set([...SOURCE.matchAll(/'(dpage\.[A-Za-z.]+[A-Za-z])'/g)].map((m) => m[1]))];
    assert.ok(literals.length > 30, `found ${literals.length}`);
    for (const key of literals) { assert.ok(EN[key] !== undefined, `${key} missing from en.json`); }
  });

  test('the play-now copy, exactly', () => {
    const copy = {
      'dpage.albums.library': 'Albums from your library',
      'dpage.albums.peerOne': 'Albums from {{name}}',
      'dpage.albums.peerMany': 'Albums from connected servers',
      'dpage.songs.library': 'Songs from your library',
      'dpage.songs.peerOne': 'Songs from {{name}}',
      'dpage.songs.peerMany': 'Songs from connected servers',
      'dpage.showMore': 'Show more',
      'dpage.library.nothing': 'Nothing new in your library sounds like these songs.',
      'dpage.peers.quiet': 'Nothing from your connected servers right now.',
      'dpage.because': 'Because you finished {{title}}',
      'dpage.verb.queueAll': 'Queue all',
      'dpage.seeds.showAll': 'Show all',
    };
    for (const [k, v] of Object.entries(copy)) { assert.equal(EN[k], v, k); }
  });

  test('the copy the play-now page dropped is gone', () => {
    const values = Object.entries(EN).filter(([k]) => k.startsWith('dpage.')).map(([, v]) => JSON.stringify(v).toLowerCase());
    for (const phrase of ['matched by sound', 'never played', 'unplayed and forgotten', 'see all', 'last played', 'not answering', 'plays when the peer is back', 'peers answered',
      'played lately', 'been through every song', 'discover settings']) {
      assert.ok(!values.some((v) => v.includes(phrase)), phrase);
    }
    for (const prefix of ['dpage.filter.', 'dpage.ago.', 'dpage.when.', 'dpage.seen.', 'dpage.count.', 'dpage.album.', 'dpage.tab.', 'dpage.because.',
      'dpage.opt.', 'dpage.prefs.', 'dpage.state.seedsCycled']) {
      assert.deepEqual(Object.keys(EN).filter((k) => k.startsWith(prefix)), [], prefix);
    }
  });

  test('the nav entry and the panel title', () => {
    assert.equal(EN['nav.discover'], 'Discover');
    assert.equal(EN['panel.discover'], 'Discover');
  });
});
