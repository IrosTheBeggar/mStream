/**
 * webapp/alpha/discovery-page.js — the Discover page's pure half, on node:
 * the request bodies of both pages (play: library + the peers call; Peer
 * Recommendations: network, its re-ask pinned to the batch on screen —
 * flags drop sources, pins lose their leading '/', the visit's dropped
 * seeds travel as exclude, caps hold), the stored window
 * and the visit's drop list, the seed chips, the library's album cards and
 * song rows, the connected servers' song rows and album cards, the labels
 * and the "Show more" column slicing, the network rows (raw rows kept for
 * the recommendation window, the peer and the generated tile as the server
 * stamped them, jobs badged through an injected DISCOVERJOBS), and every
 * page and source state (the network's by its `reason`). The route is stateless
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
import { albumCredit as serverAlbumCredit, normalizePeerPath as serverNormalizePeerPath, normalizeRecommendation } from '../../src/discovery-plugins/recommendation.js';
import { buildLinks as serverBuildLinks } from '../../src/discovery-plugins/plugins/links.js';
import { albumListing as serverAlbumListing } from '../../src/discovery-plugins/plugins/federation-copy.js';
import { nameKey as serverNameKey } from '../../src/db/name-key.js';
import { peerLabels, leadTile } from '../../src/state/discovery-peer-view.js';

const require = createRequire(import.meta.url);
const D = require('../../webapp/alpha/discovery-page.js');
const J = require('../../webapp/alpha/discover-jobs.js');
const EN = require('../../webapp/locales/en.json');
const SOURCE = readFileSync(new URL('../../webapp/alpha/discovery-page.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const FLAGS = { discovery: true, discoveryTaste: 1, discoveryP2p: true, federationDiscovery: true };
// Peer Recommendations' gate: taste generation 2 and the peers route.
const PFLAGS = { ...FLAGS, discoveryTaste: 2, discoveryP2pPeers: 1 };
const PEER_PAGE = { page: 'peerRecs' };

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
  if (typeof value.key === 'string' && /^(dpage|discover|peerRecs)\./.test(value.key) && (value.params === undefined || typeof value.params === 'object')) {
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
    assert.deepEqual([...D.PAGES], ['play', 'peerRecs'], 'the hidden explore page is Peer Recommendations');
    assert.equal(D.PAGE_SIZE, 16);
    assert.equal(D.ALBUM_STRIP_MAX, 12);
    assert.ok(D.ALBUM_STRIP_MAX <= tasteQ.LIMIT_CAPS.albums, 'the strip can be filled in one ask');
  });

  test('Peer Recommendations\' limits: a whole seed batch and 32 leads, inside the route\'s caps', () => {
    assert.deepEqual({ ...D.PEER_LIMITS }, { seeds: 12, network: 32 });
    assert.ok(Object.isFrozen(D.PEER_LIMITS));
    assert.equal(D.PEER_LIMITS.seeds, tasteQ.SEED_CAP, 'a whole batch: its seeds pin a tab\'s re-ask');
    assert.ok(D.PEER_LIMITS.network <= tasteQ.LIMIT_CAPS.network);
    assert.equal(D.PEER_LIMITS.network, 2 * D.PAGE_SIZE, 'two blocks of 16, drawn in full');
  });

  test('what the play-now page dropped is gone from the module', () => {
    for (const gone of ['seedsLine', 'windowLabel', 'filterOptions', 'agoLabel', 'playedWhen', 'pickSource', 'pluginChips']) {
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
    assert.deepEqual(main.sources, ['library'], 'the network leads are Peer Recommendations\'');
    assert.deepEqual(peers.sources, ['peers']);
    assert.deepEqual(main.pin, ['Music/ALM/Manor.mp3']);
    assert.deepEqual(strip(main), strip(peers));
    assert.deepEqual(strip(main), { window: 30, pin: ['Music/ALM/Manor.mp3'], newArtistsOnly: false, ignoreVPaths: ['Podcasts'] });
    assert.deepEqual(D.buildRequests({ flags: FLAGS, page: 'play' }), D.buildRequests({ flags: FLAGS }), 'play is the default');
    assert.deepEqual(D.buildRequests({ flags: FLAGS, page: 'nope' }), D.buildRequests({ flags: FLAGS }));
  });

  test('Peer Recommendations: the R1 body — the network alone, never a peers call, the play page\'s seeds-shaping keys', () => {
    const opts = { window: 90, pinPath: '/Music/now.flac', exclude: ['h1'], passed: ['r1'], ignoreVPaths: ['Podcasts'] };
    const { main, peers } = D.buildRequests({ ...opts, flags: PFLAGS, ...PEER_PAGE, newArtistsOnly: true, limits: { tracks: 48, network: 12, peers: 25 } });
    assert.deepEqual(main, {
      sources: ['network'], window: 90, pin: ['Music/now.flac'], exclude: ['h1', 'r1'], newArtistsOnly: false, ignoreVPaths: ['Podcasts'],
      limit: { seeds: 12, network: 32 }, networkOnRandomSeed: true,
    }, 'its own limits (opts.limits is the play page\'s), leads off a random pick too, no networkPeers for All');
    assert.equal(peers, null);
    const play = D.buildRequests({ ...opts, flags: PFLAGS }).main;
    for (const k of ['window', 'pin', 'exclude', 'newArtistsOnly', 'ignoreVPaths']) { assert.deepEqual(main[k], play[k], k); }
    assert.deepEqual(D.buildRequests({ flags: PFLAGS, ...PEER_PAGE }).main,
      { sources: ['network'], window: 30, newArtistsOnly: false, limit: { seeds: 12, network: 32 }, networkOnRandomSeed: true }, 'a bare open');
    assert.notEqual(D.buildRequests({ flags: PFLAGS, ...PEER_PAGE }).main.limit, D.PEER_LIMITS, 'a copy, never the frozen constant');
  });

  test('networkPeers: lower-cased, 64 hex only, de-duplicated, the first 50 — none left, no key', () => {
    const id = (n) => n.toString(16).padStart(64, '0');
    const A = 'ab'.repeat(32);
    const sent = (networkPeers) => D.buildRequests({ flags: PFLAGS, ...PEER_PAGE, networkPeers }).main;
    assert.deepEqual(sent([A]).networkPeers, [A]);
    assert.deepEqual(sent([A.toUpperCase()]).networkPeers, [A], 'any case, sent lower-case (the route\'s lowercase())');
    assert.deepEqual(sent([A, A.toUpperCase(), id(1), A]).networkPeers, [A, id(1)], 'de-duplicated after the fold, in order');
    assert.deepEqual(sent(['ab'.repeat(31), 'ab'.repeat(33), ` ${A}`, 'zz'.repeat(32), 42, null, { id: A }, A]).networkPeers, [A],
      'short, long, padded, non-hex and non-string ids dropped');
    const many = Array.from({ length: 51 }, (_, i) => id(i + 1));
    assert.deepEqual(sent(many).networkPeers, many.slice(0, 50), '51 ids: the first 50 (the route\'s max)');
    for (const none of [[], ['nope'], undefined, null, A, {}]) {
      assert.equal('networkPeers' in sent(none), false, `${JSON.stringify(none)}: the key left out (the route answers 400 to [])`);
    }
    assert.equal('networkPeers' in D.buildRequests({ flags: PFLAGS, networkPeers: [A] }).main, false, 'never on the play page');
  });

  test('Peer Recommendations without any one of its four flags: no bodies at all', () => {
    const offs = [
      { ...PFLAGS, discovery: false }, { ...PFLAGS, discoveryP2p: false }, { ...PFLAGS, discoveryP2p: 'true' },
      { ...PFLAGS, discoveryTaste: 1 }, { ...PFLAGS, discoveryTaste: undefined }, { ...PFLAGS, discoveryP2pPeers: 0 },
      { ...PFLAGS, discoveryP2pPeers: undefined }, { ...PFLAGS, discoveryP2pPeers: true }, FLAGS, {}, null,
    ];
    for (const flags of offs) {
      assert.deepEqual(D.buildRequests({ flags, ...PEER_PAGE }), { main: null, peers: null }, JSON.stringify(flags));
      assert.equal(D.peerRecsAvailable(flags), false, JSON.stringify(flags));
    }
    for (const flags of [PFLAGS, { ...PFLAGS, discoveryTaste: '2', discoveryP2pPeers: '1' }, { ...PFLAGS, discoveryTaste: 3, discoveryP2pPeers: 2 }]) {
      assert.equal(D.peerRecsAvailable(flags), true, JSON.stringify(flags));
      assert.ok(D.buildRequests({ flags, ...PEER_PAGE }).main, 'a later generation, a numeric string: still the page');
    }
    assert.ok(D.buildRequests({ flags: FLAGS }).main, 'Discover keeps its own gate');
  });

  test('the hidden explore page m.js still draws (until its drawing goes): the network alone, the generation-1 gate, "new artists only"', () => {
    const explore = D.buildRequests({ flags: FLAGS, window: 90, pinPath: 'a.mp3', exclude: ['h1'], page: 'explore', newArtistsOnly: true, networkPeers: ['ab'.repeat(32)] });
    assert.deepEqual(explore, { main: { sources: ['network'], window: 90, pin: ['a.mp3'], exclude: ['h1'], newArtistsOnly: true }, peers: null },
      'no generation-2 key');
    assert.deepEqual(D.buildRequests({ flags: { ...FLAGS, discoveryP2p: false }, page: 'explore' }), { main: null, peers: null });
    assert.deepEqual(D.stateOf(historyResponse(), FLAGS, { page: 'explore' }).sources.network, { status: 'ready', reason: null, count: 3 });
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

  test('"new artists only": no page sends it — no control draws it any more', () => {
    const play = D.buildRequests({ newArtistsOnly: true, flags: PFLAGS });
    assert.equal(play.main.newArtistsOnly, false);
    assert.equal(play.peers.newArtistsOnly, false, 'no hidden thinning of the connected servers\' rows');
    assert.equal(D.buildRequests({ newArtistsOnly: true, flags: PFLAGS, ...PEER_PAGE }).main.newArtistsOnly, false);
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

describe('batchRequest: Peer Recommendations re-asks on the batch on screen', () => {
  const seed = (i, extra = {}) => ({ hash: `h${i}`, filepath: `Music/S/${i}.flac`, metadata: {}, pinned: false, analyzed: true, ...extra });
  const KITCHEN = 'b2'.repeat(32);
  const body = (networkPeers) => D.buildRequests({ flags: PFLAGS, ...PEER_PAGE, window: 7, pinPath: 'Music/S/0.flac', exclude: ['hx'], networkPeers }).main;
  const batch = { seedSource: 'history', seeds: [seed(0, { pinned: true }), seed(1), seed(2)] };

  test('a peer\'s tab: every seed of the batch pinned, limit.seeds = their count, networkPeers = that peer', () => {
    const b = body();
    const out = D.batchRequest(b, batch, KITCHEN);
    assert.deepEqual(out, {
      sources: ['network'], window: 7, pin: ['Music/S/0.flac', 'Music/S/1.flac', 'Music/S/2.flac'], exclude: ['hx'], newArtistsOnly: false,
      limit: { seeds: 3, network: 32 }, networkOnRandomSeed: true, networkPeers: [KITCHEN],
    });
    assert.deepEqual(b.pin, ['Music/S/0.flac'], 'the built body is not touched');
    assert.equal(b.limit.seeds, 12);
    assert.equal('networkPeers' in b, false);
    assert.deepEqual(D.batchRequest(b, batch, KITCHEN.toUpperCase()).networkPeers, [KITCHEN], 'cleaned as buildRequests cleans it');
  });

  test('All: the key left out — and taken off a body that carried one; an id that is no endpoint id is All', () => {
    const narrowed = body([KITCHEN]);
    assert.deepEqual(narrowed.networkPeers, [KITCHEN]);
    for (const all of [null, undefined, '', 'all', 'b2'.repeat(31), 7]) {
      const out = D.batchRequest(narrowed, batch, all);
      assert.equal('networkPeers' in out, false, String(all));
      assert.equal(out.limit.seeds, 3);
    }
    assert.deepEqual(narrowed.networkPeers, [KITCHEN], 'the built body is not touched');
    assert.deepEqual(D.batchRequest(narrowed, batch, 'a1'.repeat(32)).networkPeers, ['a1'.repeat(32)], 'another tab replaces it');
  });

  test('a random answer\'s pick is pinned too (the page walks the network on it)', () => {
    const random = { seedSource: 'random', fallback: true, seeds: [seed(9, { outcome: null })] };
    const out = D.batchRequest(body(), random, KITCHEN);
    assert.deepEqual(out.pin, ['Music/S/9.flac']);
    assert.equal(out.limit.seeds, 1);
    assert.equal(D.peersRequest(D.buildRequests({ flags: PFLAGS }).peers, random), null, 'unlike the connected servers\' call');
  });

  test('a full batch; past PIN_CAP (a malformed answer) the first ones; bad paths skipped', () => {
    const full = Array.from({ length: 12 }, (_, i) => seed(i, { pinned: i === 0 }));
    const all = D.batchRequest(body(), { seedSource: 'history', seeds: full }, null);
    assert.deepEqual(all.pin, full.map((s) => s.filepath));
    assert.equal(all.limit.seeds, 12);
    const seeds = [seed(0, { filepath: '/Music/S/0.flac' }), seed(9, { filepath: '' }), seed(1, { filepath: 'Music/S/0.flac' }),
      seed(8, { filepath: 'x'.repeat(2049) }), ...Array.from({ length: 12 }, (_, i) => seed(i + 2))];
    const out = D.batchRequest(body(), { seedSource: 'history', seeds }, null);
    assert.equal(out.pin.length, D.PIN_CAP);
    assert.deepEqual(out.pin.slice(0, 2), ['Music/S/0.flac', 'Music/S/2.flac'], 'the leading / stripped, a duplicate, an empty and an over-long path skipped');
  });

  test('null: no body, or a batch that failed, was refused or has no seed with a path (the caller asks a new batch)', () => {
    assert.equal(D.batchRequest(null, batch, KITCHEN), null);
    assert.equal(D.batchRequest(undefined, batch, null), null);
    for (const bad of [undefined, null, { disabled: true }, { seedSource: 'history', seeds: [] }, { seedSource: 'history', seeds: [seed(1, { filepath: '' })] }, { seedSource: 'history' }]) {
      assert.equal(D.batchRequest(body(), bad, KITCHEN), null, JSON.stringify(bad));
    }
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

// Peer Recommendations' leads as the taste route stamps them: three shelf
// peers labelled by the peers route's own peerLabels (an unnamed one reads
// 'mStream · 3f9a'), every lead's tile by its own leadTile.
const EP = { basement: 'a1'.repeat(32), kitchen: 'b2'.repeat(32), mstream: '3f9a'.padEnd(64, '0') };
const SHELF_LABELS = peerLabels({
  shelf: [{ endpointId: EP.basement, name: 'Basement Hi-Fi' }, { endpointId: EP.mstream, name: '' }],
  catalog: [{ from: EP.kitchen, payload: { name: 'Kitchen Radio' } }],
});
const LEADS_RAW = [
  { seedIndex: 1, artist: 'Paper Lantern', title: 'Signal Fires', album: 'Night Ferry', year: 2021, duration: 200, similarity: 0.81234, exportId: 'k1', peer: { endpointId: EP.kitchen, name: 'Kitchen Radio' }, recordingMbid: null, isrc: null },
  { seedIndex: 2, artist: 'Paper Lantern', title: 'Harbor Lights', album: 'Night Ferry', year: 2021, duration: 3725, similarity: 0.7, exportId: 'b1', peer: { endpointId: EP.basement, name: 'Basement Hi-Fi' }, recordingMbid: null, isrc: null },
  { seedIndex: null, artist: '', title: 'Untitled', album: null, year: null, duration: null, similarity: 0.6, exportId: 'm1', peer: { endpointId: EP.mstream, name: null }, recordingMbid: null, isrc: null },
];
const leadsResponse = (over) => historyResponse({
  network: { results: stampNetworkRows(LEADS_RAW, LIB_SEEDS, 32, SHELF_LABELS), searched: { peers: 3, tracks: 7421 }, reason: null },
  library: null,
  ...over,
});

describe('networkRows', () => {
  test('raw rows kept as the route stamped them, plus what a row draws: "Artist · Album", the peer, the tile', () => {
    const r = leadsResponse();
    const net = collect(D.networkRows(r));
    assert.equal(net.count, 3);
    assert.deepEqual(net.searched, { peers: 3, tracks: 7421 });
    assert.equal('line' in net, false, 'no "3 servers searched"');
    const [n1, n2, n3] = net.rows;
    assert.equal(n1.raw, r.network.results[0], 'the very object — openDiscoverModal(raw, "p2p")');
    assert.equal(n1.raw.source, 'p2p');
    assert.equal('seedIndex' in n1.raw, false);
    assert.equal(n1.source, 'p2p');
    assert.equal(n1.title, 'Signal Fires');
    assert.equal(n1.subtitle, 'Paper Lantern · Night Ferry', 'no year');
    assert.equal(n1.similarityPct, 81);
    assert.equal(n1.length, '3:20');
    assert.equal(n2.length, '1:02:05');
    assert.equal(n1.seedHash, 'h1');
    assert.deepEqual(n1.because, { key: 'dpage.because', params: { title: 'One' } });
    assert.equal(n1.matchSeed, 'One', 'the window\'s match bar names the seed this lead was matched against');
    assert.equal(n3.subtitle, '', 'no artist, no album');
    assert.equal(n3.seedHash, null);
    assert.equal(n3.because, null);
    assert.equal(n3.matchSeed, null);
    for (const row of net.rows) {
      for (const gone of ['onLabel', 'newArtist', 'newArtistLabel']) { assert.equal(gone in row, false, gone); }
      assert.equal(plugins.recommendationSchema.validate(row.raw).error, undefined, 'still a sendable recommendation');
    }
  });

  test('the peer: its endpointId (what every strip state keys on) and the server\'s label, verbatim', () => {
    const [n1, n2, n3] = D.networkRows(leadsResponse()).rows;
    assert.deepEqual([n1.peerId, n2.peerId, n3.peerId], [EP.kitchen, EP.basement, EP.mstream]);
    assert.deepEqual([n1.peerLabel, n2.peerLabel, n3.peerLabel], ['Kitchen Radio', 'Basement Hi-Fi', 'mStream · 3f9a'], 'the peers route\'s labels');
    assert.equal(n3.peerLabel, SHELF_LABELS.get(EP.mstream));
    assert.equal(n3.peerName, '', 'the catalogue name is data; the label is what is drawn');
    const unlabelled = historyResponse({ network: { results: [{ ...LEADS_RAW[0], source: 'p2p', peer: { endpointId: EP.kitchen, name: 'Kitchen Radio' } }] } });
    assert.equal(D.networkRows(unlabelled).rows[0].peerLabel, 'Kitchen Radio', 'a lead stamped without a label: its peer\'s name');
    const peerless = historyResponse({ network: { results: [{ ...LEADS_RAW[0], source: 'p2p', peer: null }] } });
    assert.deepEqual([D.networkRows(peerless).rows[0].peerId, D.networkRows(peerless).rows[0].peerLabel], [null, '']);
  });

  test('the tile: the server\'s own leadTile, drawn as sent — never computed here', () => {
    const rows = D.networkRows(leadsResponse()).rows;
    for (const [i, row] of rows.entries()) {
      assert.deepEqual(row.tile, leadTile(LEADS_RAW[i]), row.title);
      assert.deepEqual(row.tile, row.raw.tile);
      assert.notEqual(row.tile, row.raw.tile, 'a copy');
    }
    assert.deepEqual(rows[0].tile, { key: 'paper lantern|night ferry', hue: 39, letter: 'P' }, 'the plan\'s §5.1 vector');
    assert.equal(rows[0].tile.key, rows[1].tile.key, 'one album, one key: earned art spreads by it');
    assert.deepEqual(rows[2].tile, { key: 'untitled', hue: leadTile({ title: 'Untitled' }).hue, letter: 'U' }, 'no artist or album: the title');
    // a tile the server did not stamp, or one that cannot be drawn
    const tileOf = (tile) => D.networkRows(historyResponse({ network: { results: [{ ...LEADS_RAW[0], source: 'p2p', tile }] } })).rows[0].tile;
    for (const bad of [undefined, null, 'tile', [1, 2], { key: 'k', letter: 'K' }, { key: 'k', hue: '39', letter: 'K' }, { key: 'k', hue: NaN, letter: 'K' }]) {
      assert.equal(tileOf(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(tileOf({ key: 7, hue: 120, letter: null, extra: 'x' }), { key: '', hue: 120, letter: '' }, 'the three fields, strings as strings');
    assert.ok(!/fnv|0x811c9dc5|0x01000193/i.test(SOURCE), 'no tile hash in the module');
  });

  test('nothing for an absent section', () => {
    assert.deepEqual(D.networkRows(historyResponse({ network: null })), { rows: [], count: 0, searched: null });
    assert.equal(D.networkRows(undefined).rows.length, 0);
    assert.equal(D.networkRows({ network: { results: [] } }).count, 0);
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
const VP_SRC = readFileSync(new URL('../../webapp/alpha/vp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
const I18N_SRC = readFileSync(new URL('../../webapp/assets/js/i18n.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const I18N = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', `${I18N_SRC}\nreturn I18N;`)(
  {}, { querySelector: () => null, querySelectorAll: () => [] }, { getItem: () => null, setItem: () => {} }, { language: 'en' },
  async () => ({ json: async () => EN }));
await I18N.loadLanguage('en');
const tEn = I18N.t;

const WINDOW_METHODS = ['tt', 'dmLive', 'dmDuration', 'dmText', 'openDiscoverModal', 'openDiscoverModalForJob', 'dmLoadPeerFacts', 'dmAlbumQuery', 'dmArtistOwnership',
  'dmQueueAlbum', 'dmViewAlbum', 'closeDiscoverModal', 'dmHoldFocus',
  'dmAlbumFocus', 'dmHeadTitle', 'dmSubtitle', 'dmAlbumFacts', 'dmArtistFacts', 'dmAlbumPlaySub', 'discoverAcquirePlugins', 'dmHasDestination',
  'dmCopyRows', 'dmJobRow', 'dmShownJob', 'dmJobOtherPeer', 'dmWiderJob', 'dmScopeRows', 'dmMissingRows', 'dmKeepChoices', 'dmKeepCompilation', 'dmKeepChoose',
  'dmKeepChosen', 'dmKeepMissingChoice', 'dmKeepMissingCount', 'dmKeepScope', 'dmKeepArtistNewest', 'dmKeepArtistSays', 'dmKeepRow', 'dmKeepStartLabel',
  'dmMissingHeld', 'dmKeepMissingLabel', 'dmGetItRows', 'dmGetItBar', 'dmGetItLive', 'dmKeepStart', 'toastDiscoverJob', 'discoverPluginTitle',
  'dmKeepView', 'dmKeepLine', 'dmKeepFiles', 'dmKeepWhose', 'dmKeepMarker', 'dmKeepSegments', 'dmKeepShown', 'dmKeepAnnounce', 'dmKeepHint', 'dmKeepLost',
  'dmKeepAct', 'dmKeepCancel', 'dmKeepPlay', 'dmKeepShow', 'dmKeepHold', 'dmJobPath', 'dmDestMoved', 'dmJobCancel', 'playDiscoverFile', 'queueDiscoverFile',
  'dmRecommendation', 'dmLayoutTags', 'dmLayoutFile', 'dmLayoutPeer', 'dmScopeTags', 'dmMissingAlbum', 'dmDestPath', 'dmDestPathOf', 'dmSlotNote',
  'dmMetaParts', 'dmPeerStatus', 'dmMatchSeed', 'dmPct', 'dmAgo', 'dmLinksRecommendation', 'dmFindVisible', 'dmLinks', 'dmChipLabel', 'dmCopyTitle',
  // entered from a connected server's pages (SPEC-fed §6): artist and folder
  // focus, a browsed song's tags and credit, the folder's count, landings
  // and states
  'dmArtistFocus', 'dmFolderFocus', 'dmHidden', 'dmListenShown', 'dmCount', 'dmFolderRecommendation', 'dmFolder', 'dmLoadBrowsedFacts', 'dmTakePeerFacts',
  'dmMergeFileTags', 'dmCreditFrom', 'dmLoadFolderScan', 'dmLoadFolderTags', 'dmFolderReady', 'dmFolderCountParts', 'dmFolderPlaySub', 'dmQueueFolder',
  'dmKeepLeftOut', 'dmLandShown', 'dmLandings', 'dmLandChoose', 'dmLandHold', 'dmFolderLandingSent', 'dmFolderInto', 'dmFolderPlaceOk', 'dmFolderCap',
  'dmFolderCapFailed', 'dmJobLanded', 'dmIntoLoad', 'dmIntoCrumbs', 'dmIntoLibraries', 'dmIntoLibrary', 'dmIntoInto', 'dmIntoUp', 'dmIntoNewFolder',
  'dmIntoNaming', 'dmIntoBraced', 'dmIntoMissing', 'dmMirrorFoot', 'dmIntoStraight', 'dmPickerLibraries', 'dmPickerLandsAt', 'dmDestFocus',
  'dmKeepGateChanged'];
// Find elsewhere's own load (stubbed in every other window: it asks the
// links plug-in, and the harness's `realLinks` lets it)
const LINKS_METHODS = ['dmLoadLinks', 'ensureDiscoverPlugins', 'discoverLinksPlugin'];
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

function makeWindow({ reads = readsOf(), plugins = [COPY], jobsAllowed = true, destination = DEST, available = true, realLinks = false, doc: docOver = {} } = {}) {
  const body = `
    let discoverModalGen = 0;
    let discoverModalOpener = null;
    let discoverKeepPresses = 0;
    const discoverGateWatchers = [];
    function onDiscoverModalKey() {}
    ${VP_SRC.match(/\n {2}const FOLDER_TAGS_MAX = \d+;/)[0]}
    ${vpModuleFn('dmAttrValue')}
    ${vpModuleFn('blankDiscoverModal')}
    ${vpModuleFn('dmNameKey')}
    ${vpModuleFn('dmOpenerOf')}
    ${vpModuleFn('dmFocusBack')}
    ${vpModuleFn('dmLinksNameAlbum')}
    ${vpModuleFn('dmCapital')}
    return {
      methods: { ${WINDOW_METHODS.map((n) => `${n}: ${vpMethodSrc(n)}`).join(',\n')} },
      links: { ${LINKS_METHODS.map((n) => `${n}: ${vpMethodSrc(n)}`).join(',\n')} },
      blank: blankDiscoverModal,
      gateWatchers: discoverGateWatchers,
    };`;
  // View album's element (its attributes) and the app's browse hand-off;
  // the album queue's federation rows
  const doc = { addEventListener() {}, removeEventListener() {},
    createElement: (tag) => { const attrs = {}; return { tag, attrs, setAttribute: (k, v) => { attrs[k] = String(v); } }; }, ...docOver };
  const viewed = [];
  const fedQueued = [];
  // the library's queue (Play your copy, Queue) and the file explorer the
  // window opens (Show in your library)
  const queued = [];
  const explored = [];
  const app = { addFederationSongWizard: (...args) => { fedQueued.push(args); }, addSongWizard: (...args) => { queued.push(args); }, clearQueue() { queued.push('cleared'); } };
  const toasts = [];
  const izi = Object.fromEntries(['error', 'success', 'warning', 'info'].map((kind) => [kind, (o) => toasts.push({ kind, ...o })]));
  const mod = new Function('DISCOVERJOBS', 'DISCOVERYPAGE', 'MSTREAMAPI', 'document', 't', 'iziToast', 'getAlbumsOnClick', 'mstreamModule', 'MSTREAMPLAYER', 'openFileExplorerAt', body)(
    J, D, reads, doc, tEn, izi, (el) => { viewed.push(el.attrs); }, app, { positionCache: { val: 0 } }, (parts) => { explored.push(parts); });
  const loads = [];
  const starts = [];
  const cancels = [];
  const copied = [];
  // $nextTick's callbacks, run by the test (ticks.splice(0).forEach(f => f()))
  const ticks = [];
  const vm = {
    discover: { plugins: { available, list: plugins, jobsAllowed }, dest: { view: { destination }, saves: 0 }, admin: false, seedTitle: '', modal: mod.blank() },
    $refs: {}, $nextTick(cb) { if (cb) { ticks.push(cb); } }, $set(o, k, v) { o[k] = v; }, $delete(o, k) { delete o[k]; },
    stopDiscoverPreview() {}, scheduleDiscoverJobsPoll() {}, copyDiscoverP2p(track) { loads.push('copied'); copied.push(`${track.artist || ''} - ${track.title || ''}`); },
    dmLoadLinks: async () => { loads.push('links'); },
    dmLoadJobs: async () => { loads.push('jobs'); },
    dmLoadFederate: async () => { loads.push('federate'); },
    dmJobStart: (plugin, choice, scope) => { starts.push({ plugin: plugin.name, choice, scope }); },
    cancelDiscoverJob: async (job) => { cancels.push(job.id); },
    dmOpenPicker() { loads.push('picker'); },
    dmDestEditing: () => false,
    ...mod.methods,
    ...(realLinks ? mod.links : {}),
  };
  return { vm, loads, starts, toasts, viewed, fedQueued, ticks, copied, queued, explored, cancels, gateWatchers: mod.gateWatchers };
}
const subText = (vm, row) => vm.dmText(row.sub);
const copyJob = (over) => ({ id: 41, plugin: 'federation-copy', key: 'album:06676dc1', state: 'running', progress: 0.4, statusText: 'song 1 of 3 · Rooftop Cypher', params: { scope: 'album' }, recommendation: tapesRow(STAGE_B, '02 - Late Train Verse'), ...over });

describe('the recommendation window: album focus (vp.js)', () => {
  test('a card\'s opening reads as the album: Album chosen', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    const row = tapesRow(STAGE_B, '02 - Late Train Verse');
    await vm.openDiscoverModal(row, 'federation', { seedPlain: 'your recent listening', focus: 'album' });
    const m = vm.discover.modal;
    assert.equal(m.track, row, 'the best row itself, as received');
    assert.equal(m.focus, 'album');
    assert.deepEqual(m.keep, { scope: 'album', onlyMissing: true, landing: 'mirror', into: null, tree: null });
    assert.equal(vm.dmKeepChosen(), 'album');
    assert.equal(vm.dmKeepScope(), 'album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album · 3 songs');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', '3 songs'], ['artist', 'Boukmanflow · 1 album']], 'no "This song" in the album\'s window');
  });

  test('one view, no tabs: a song row\'s ⋯ and a now-playing row open the same window; an older caller\'s { view } changes nothing', async () => {
    const page = makeWindow();
    await page.vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation', { seedPlain: 'x' });
    assert.equal(page.vm.discover.modal.focus, null);
    assert.deepEqual(page.vm.discover.modal.keep, { scope: 'song', onlyMissing: true, landing: 'mirror', into: null, tree: null });
    assert.equal('view' in page.vm.discover.modal, false, 'no Federation | Plug-Ins view to remember');
    const older = makeWindow({ available: false });
    await older.vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation', { view: 'plugins' });
    assert.equal('view' in older.vm.discover.modal, false);
    assert.equal(VP_SRC.indexOf('setDiscoverModalView'), -1, 'the tabs\' switch is gone');
  });

  test('album focus needs an album; a network row never takes it', async () => {
    const { vm } = makeWindow();
    await vm.openDiscoverModal(tapesRow(STAGE_B, 'Loose', { album: null }), 'federation', { focus: 'album', view: 'federation' });
    assert.equal(vm.discover.modal.focus, null);
    assert.equal(vm.discover.modal.keep.scope, 'song');
    await vm.openDiscoverModal({ title: 'Lead', artist: 'Mo', album: 'Lead Album', peer: { endpointId: 'e1' } }, 'p2p', { focus: 'album' });
    assert.equal(vm.discover.modal.focus, null);
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
    assert.equal(vm.dmAlbumPlaySub(), '3 songs · 11:02', 'the play row: how many and how long — ownership is Keep a copy\'s to say');
    vm.discover.modal.album = { songs: null, count: null, seconds: null, owned: true };
    assert.equal(vm.dmAlbumPlaySub(), '', 'blank until the peer listed the album');
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
    assert.deepEqual([a.theirs, a.theirSongs, a.owned, a.missing, a.local], [1, 3, 0, 1, 3]);
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['song', '3:41 · mp3'], ['album', '3 songs'], ['artist', 'Boukmanflow · 1 album']]);
    assert.equal(vm.dmArtistFacts(), '1 album · 3 songs', 'what the peer has; whether the library has it is Keep a copy\'s to say');
    vm.dmKeepChoose('artist');
    assert.equal(vm.dmKeepMissingChoice(), true);
    assert.equal(tEn('discover.modal.onlyMissing', { count: vm.dmKeepMissingCount() }), 'Only the 1 album you don’t have');
    assert.equal(vm.dmKeepScope(), 'artist-missing', 'ticked by default');
    assert.equal(vm.dmKeepStartLabel(), 'Add 1 album', 'the one the library lacks');
    vm.discover.modal.keep.onlyMissing = false;
    assert.equal(vm.dmKeepScope(), 'artist');
    assert.equal(vm.dmKeepStartLabel(), 'Add 1 album', 'every album: the peer has the one');
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
    assert.equal(vm.dmArtistFacts(), '2 albums · 6 songs', 'their own two: never the compilation they are on, nor the singles bucket');
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
    assert.equal(failed.vm.dmArtistFacts(), '1 album · 3 songs');
    assert.equal(failed.vm.dmKeepStartLabel('artist-missing'), 'Add the missing albums', 'no count it cannot know');
  });

  test('one album, one song: singular', async () => {
    const { vm } = makeWindow({ reads: readsOf({ albumSongs: songsOf(1), peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes', { track_count: 1 })] }, localAlbums: { albums: [] } }) });
    await vm.openDiscoverModal(tapesRow(STAGE_C, '01 - Rooftop Cypher'), 'federation', { view: 'federation' });
    assert.equal(vm.dmArtistFacts(), '1 album · 1 song');
    assert.equal(vm.dmAlbumFacts(), '2019 · 1 song · 3:20');
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.sub), ['3:41 · mp3', '1 song', 'Boukmanflow · 1 album']);
    vm.dmKeepChoose('album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album · 1 song');
    assert.equal(vm.dmKeepStartLabel('artist'), 'Add 1 album');
    for (const key of ['discover.modal.songCount', 'discover.modal.albumCount', 'discover.modal.onlyMissing', 'discover.keep.addAlbums', 'discover.keep.addAlbum', 'discover.modal.albumQueued',
      'discover.keep.notCopied', 'discover.keep.refusedSome']) {
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
    assert.equal(vm.dmKeepView().kind, 'state');
    assert.equal(subText(vm, live), 'from Stage Peer C · song 1 of 3 · Rooftop Cypher · 40%');
    vm.discover.modal.jobs = { 'federation-copy@album': { ...fromC, state: 'done', progress: 1, result: { songs: { total: 1, copied: [{}], skipped: [], failed: [] }, stopped: null, peer: STAGE_C } } };
    assert.equal(vm.dmKeepRow().row.state, 'idle', 'C\'s finished copy is not B\'s album');
    assert.equal(vm.dmKeepView().kind, 'idle', 'Add album is offered again');
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

  test('a strip row reopens its job: an album copy as the album on Album, artist-missing as Artist with only-missing ticked, another plug-in on the song', async () => {
    const album = makeWindow({ reads: STAGE_READS() });
    const job = copyJob({ recommendation: { ...tapesRow(STAGE_B, '02 - Late Train Verse'), albumArt: undefined, similarity: undefined } });
    await album.vm.openDiscoverModalForJob(job);
    let m = album.vm.discover.modal;
    assert.equal(m.focus, 'album');
    assert.equal(album.vm.dmKeepChosen(), 'album');
    m.jobs = { 'federation-copy@album': job };
    assert.equal(album.vm.dmKeepRow().row.state, 'running', 'the card IS the job');

    const missing = makeWindow({ reads: STAGE_READS() });
    const mJob = copyJob({ params: { scope: 'artist-missing' }, key: 'artist-missing:x' });
    await missing.vm.openDiscoverModalForJob(mJob);
    m = missing.vm.discover.modal;
    assert.equal(m.focus, null);
    assert.deepEqual(m.keep, { scope: 'artist', onlyMissing: true, landing: 'mirror', into: null, tree: null });
    m.jobs = { 'federation-copy@artist-missing': mJob };
    assert.equal(missing.vm.dmKeepScope(), 'artist-missing');
    assert.equal(missing.vm.dmKeepRow().row.state, 'running');

    const artist = makeWindow({ reads: STAGE_READS() });
    await artist.vm.openDiscoverModalForJob(copyJob({ params: { scope: 'artist' } }));
    assert.deepEqual(artist.vm.discover.modal.keep, { scope: 'artist', onlyMissing: false, landing: 'mirror', into: null, tree: null });
    assert.equal(artist.vm.dmKeepScope(), 'artist', 'the plain artist copy, not the missing one');

    const song = makeWindow({ reads: STAGE_READS() });
    await song.vm.openDiscoverModalForJob(copyJob({ params: {} }));
    assert.deepEqual([song.vm.discover.modal.focus, song.vm.dmKeepChosen()], [null, 'song']);

    const other = makeWindow({ reads: STAGE_READS() });
    await other.vm.openDiscoverModalForJob({ id: 9, plugin: 'youtube', state: 'running', params: {}, recommendation: tapesRow(STAGE_B, 'A') });
    assert.deepEqual([other.vm.discover.modal.focus, other.vm.discover.modal.keep.scope], [null, 'song'], 'a download\'s window is the song\'s');
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

// The user's report (2026-10-20): "Only the albums you don't have" for
// Boukmanflow copied Borrowed Tapes, and the Album choice still offered
// "Add album" — its press answered "already yours". A finished wider copy
// of THIS server's now speaks for the Album choice as its walk saw the
// album (jobForAlbum, as the markers read it), and for This song only
// where its lists name the song's file on the peer.
describe('the recommendation window: a wider copy that settled the album or the song (vp.js)', () => {
  const fromB = (title) => `peerlib/Boukmanflow/Borrowed Tapes/${title}.mp3`;
  const landed = (title) => `collection/From peers/Boukmanflow/Borrowed Tapes/${title}.mp3`;
  const SONGS = ['01 - Rooftop Cypher', '02 - Late Train Verse', '03 - Corner Store Loop'];
  // one album as the artist walk reports it (copyAlbums over copySongs):
  // each list entry names the peer file it came from
  const walkOf = (name, { copied = [], owned = [], exists = [], failed = [], stopped = null } = {}) => ({
    name, year: 2019, bytes: 0, stopped,
    songs: {
      total: copied.length + owned.length + exists.length + failed.length,
      copied: copied.map((t) => ({ from: fromB(t), vpath: 'collection', filepath: landed(t), trackId: 7, bytes: 1, title: t, artist: 'Boukmanflow', album: name })),
      skipped: owned.map((t) => ({ from: fromB(t), why: 'owned', at: `Music/Boukmanflow/${t}.mp3` })).concat(exists.map((t) => ({ from: fromB(t), why: 'exists', at: landed(t) }))),
      failed: failed.map((t) => ({ from: fromB(t), error: 'x' })),
    },
  });
  const artistResult = (scope, albums, skippedAlbums = []) => {
    const all = (k) => albums.flatMap((a) => a.songs[k].map((e) => ({ album: a.name, ...e })));
    const total = albums.reduce((n, a) => n + a.songs.total, 0);
    return { scope, artist: { name: 'Boukmanflow' }, albums, skippedAlbums,
      songs: { total, copied: all('copied'), skipped: all('skipped'), failed: all('failed') },
      counts: { total, copied: all('copied').length, skipped: all('skipped').length, failed: all('failed').length }, stopped: null, peer: STAGE_B };
  };
  // the user's run: Borrowed Tapes walked, two copied, one already here
  const USERS_RUN = () => artistResult('artist-missing', [walkOf('Borrowed Tapes', { copied: SONGS.slice(0, 2), owned: [SONGS[2]] })]);
  const wide = (scope, result, over) => copyJob({ id: 50, key: `${scope}:boukmanflow`, state: 'done', progress: 1, statusText: null,
    params: { scope }, result, createdAt: 1000, updatedAt: 2000, finishedAt: 2000, ...over });
  const albumJob = (result, over) => copyJob({ id: 60, state: 'done', progress: 1, statusText: null, result, createdAt: 3000, updatedAt: 4000, finishedAt: 4000, ...over });
  const songJob = (over) => copyJob({ id: 70, key: 'text:late-train', params: {}, recommendation: tapesRow(STAGE_B, '02 - Late Train Verse'), ...over });
  const albumOf = (copied, skipped = 0) => ({ scope: 'album', album: { name: 'Borrowed Tapes', artist: 'Boukmanflow', albumArtist: null, year: 2019 },
    songs: { total: copied.length + skipped, copied: copied.map((t) => ({ from: fromB(t), vpath: 'collection', filepath: landed(t) })), skipped: [], failed: [] },
    counts: { total: copied.length + skipped, copied: copied.length, skipped, failed: 0 }, stopped: null, peer: STAGE_B });
  const open = async (title = '02 - Late Train Verse', choice = 'album') => {
    const w = makeWindow({ reads: STAGE_READS() });
    await w.vm.openDiscoverModal(tapesRow(STAGE_B, title), 'federation', { view: 'federation' });
    w.vm.dmKeepChoose(choice);
    return w.vm;
  };
  const card = (vm) => { const k = vm.dmKeepRow(); return [k.row.state, k.row.tag, vm.dmKeepView().kind === 'idle']; };

  test('the user\'s case: an only-missing copy that walked the album — the Album choice reads "in your collection" with its counts, no idle "Add album"', async () => {
    const vm = await open();
    assert.deepEqual(card(vm), ['idle', null, true], 'before: Add album');
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.deepEqual(card(vm), ['copiedMany', 'discover.job.inCollection', false]);
    const k = vm.dmKeepRow();
    assert.equal(subText(vm, k.row), '2 songs copied · 1 already yours', 'THIS album\'s account, not the walk\'s');
    assert.deepEqual(k.row.actions, ['start'], 'the existing actions: Add album again takes only the gaps');
    assert.equal(k.scope, 'album', 'a press still runs the album copy');
    assert.equal(k.slot, 'federation-copy@album');
    // the plain artist copy speaks the same way
    vm.discover.modal.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Borrowed Tapes', { copied: SONGS })])) };
    assert.deepEqual(card(vm), ['copiedMany', 'discover.job.inCollection', false]);
    // the Artist choice still reads its own job, untouched
    vm.dmKeepChoose('artist');
    vm.discover.modal.keep.onlyMissing = false;
    assert.equal(vm.dmKeepRow().row.state, 'copiedMany');
    assert.equal(subText(vm, vm.dmKeepRow().row), '1 album · 3 songs copied', 'the walk as a whole');
  });

  test('every song already here, or the album left out as owned → "already yours"', async () => {
    const vm = await open();
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', artistResult('artist-missing', [walkOf('Borrowed Tapes', { owned: SONGS })])) };
    assert.deepEqual(card(vm), ['owned', 'discover.job.owned', false]);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', artistResult('artist-missing', [walkOf('Second Wind', { copied: ['x'] })],
      [{ name: 'Borrowed Tapes', year: 2019, trackCount: 3, why: 'owned' }])) };
    assert.deepEqual(card(vm), ['owned', 'discover.job.owned', false]);
  });

  test('an album the walk left out as an appearance, never reached, or could not list: Album still offers "Add album"', async () => {
    const vm = await open();
    const idle = ['idle', null, true];
    vm.discover.modal.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Second Wind', { copied: ['x'] })],
      [{ name: 'Borrowed Tapes', year: 2019, trackCount: 3, why: 'appearance' }])) };
    assert.deepEqual(card(vm), idle, 'an appearance');
    vm.discover.modal.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Second Wind', { copied: ['x'] })])) };
    assert.deepEqual(card(vm), idle, 'never walked');
    const failedListing = artistResult('artist', [{ name: 'Borrowed Tapes', year: 2019, error: 'Stage Peer B answered 500', songs: { total: 0, copied: [], skipped: [], failed: [] }, bytes: 0, stopped: null }, walkOf('Second Wind', { copied: ['x'] })]);
    vm.discover.modal.jobs = { 'federation-copy@artist': wide('artist', failedListing) };
    assert.deepEqual(card(vm), idle, 'its listing failed, the walk went on');
  });

  test('a wider copy that is live, failed or cancelled says nothing new on Album — a live one shows on its own choice', async () => {
    const vm = await open();
    for (const state of ['running', 'queued', 'failed', 'cancelled']) {
      vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', state === 'failed' || state === 'cancelled' ? USERS_RUN() : null, { state, error: state === 'failed' ? 'Stage Peer B is unreachable' : null }) };
      assert.deepEqual(card(vm), ['idle', null, true], state);
    }
  });

  test('another server\'s finished artist copy never speaks for this server\'s album', async () => {
    const vm = await open();
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', { ...USERS_RUN(), peer: STAGE_C }, { recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher') }) };
    assert.deepEqual(card(vm), ['idle', null, true]);
    // B's own copy beside it does
    vm.discover.modal.jobs['federation-copy@artist'] = wide('artist', artistResult('artist', [walkOf('Borrowed Tapes', { owned: SONGS })]), { id: 49 });
    assert.deepEqual(card(vm), ['owned', 'discover.job.owned', false]);
  });

  test('the newest word wins: an own album job newer than the wider copy is the choice; an older one gives way; a live own job always wins', async () => {
    const vm = await open();
    const m = vm.discover.modal;
    const own = albumJob({ ...albumOf([], 3), counts: { total: 3, copied: 0, skipped: 3, failed: 0 } });
    own.result.songs.skipped = SONGS.map((t) => ({ from: fromB(t), why: 'owned', at: null }));
    // own finished after the wider copy (4000 > 2000)
    m.jobs = { 'federation-copy@album': own, 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.deepEqual(card(vm), ['owned', 'discover.job.owned', false], 'own newer: its "already yours"');
    assert.deepEqual(vm.dmKeepRow().row, vm.dmJobRow('federation-copy', 'album'), 'the card is the album row');
    // own finished before the wider copy
    m.jobs = { 'federation-copy@album': { ...own, finishedAt: 1500, updatedAt: 1500 }, 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.deepEqual(card(vm), ['copiedMany', 'discover.job.inCollection', false], 'the wider copy came later');
    // a cancelled own job, older: the wider copy's account
    m.jobs = { 'federation-copy@album': { ...own, state: 'cancelled', result: null, finishedAt: 1500 }, 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.equal(card(vm)[0], 'copiedMany');
    // a live own job, whatever the stamps say
    m.jobs = { 'federation-copy@album': copyJob({ createdAt: 100, updatedAt: 100 }), 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.deepEqual(card(vm), ['running', 'discover.job.copying', false]);
    m.jobs['federation-copy@album'] = copyJob({ state: 'queued', createdAt: 100 });
    assert.equal(card(vm)[0], 'queued');
    // no stamps at all: id order (60 > 50: own newer)
    const bare = (j) => { const c = { ...j }; delete c.createdAt; delete c.updatedAt; delete c.finishedAt; return c; };
    m.jobs = { 'federation-copy@album': bare(own), 'federation-copy@artist-missing': bare(wide('artist-missing', USERS_RUN())) };
    assert.equal(card(vm)[0], 'owned', 'the own job was made later');
    m.jobs = { 'federation-copy@album': bare({ ...own, id: 40 }), 'federation-copy@artist-missing': bare(wide('artist-missing', USERS_RUN())) };
    assert.equal(card(vm)[0], 'copiedMany', 'the wider copy was made later');
    // two wider copies: the newer that speaks
    m.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Borrowed Tapes', { owned: SONGS })]), { id: 51, finishedAt: 2500 }),
      'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.equal(card(vm)[0], 'owned', 'the artist copy finished later');
  });

  test('a refused start on Album keeps the server\'s own words over the wider copy\'s account', async () => {
    const vm = await open();
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    vm.discover.modal.jobErrors = { 'federation-copy@album': 'Uploading Disabled' };
    assert.equal(subText(vm, vm.dmKeepRow().row), 'Uploading Disabled');
  });

  // ── This song: only where the wider copy's lists name the song ──
  test('This song: copied by the artist walk → in your collection, where it landed, Play / Queue on that file', async () => {
    const vm = await open('02 - Late Train Verse', 'song');
    assert.equal(vm.dmKeepChosen(), 'song');
    assert.deepEqual(card(vm), ['idle', null, true]);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    const k = vm.dmKeepRow();
    assert.deepEqual(card(vm), ['copied', 'discover.job.inCollection', false]);
    assert.equal(k.row.filepath, landed('02 - Late Train Verse'));
    assert.deepEqual(k.row.actions, ['play', 'queue']);
    assert.equal(subText(vm, k.row), 'collection / From peers / Boukmanflow / Borrowed Tapes / 02 - Late Train Verse.mp3');
    assert.equal(k.scope, undefined, 'the song\'s own copy, if pressed');
    assert.equal(vm.dmJobRow('federation-copy').filepath, landed('02 - Late Train Verse'), 'Play reads the same row');
  });

  test('This song: left out as already here → already yours (owned: its library file) · a file at its place → skipped, where that file is (rule 4)', async () => {
    const vm = await open('03 - Corner Store Loop', 'song');
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    let row = vm.dmKeepRow().row;
    assert.deepEqual([row.state, row.tag, row.filepath], ['owned', 'discover.job.owned', 'Music/Boukmanflow/03 - Corner Store Loop.mp3']);
    vm.discover.modal.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Borrowed Tapes', { exists: ['03 - Corner Store Loop'] })])) };
    row = vm.dmKeepRow().row;
    assert.deepEqual([row.state, row.tag, row.filepath], ['exists', 'discover.job.skipped', null], 'not known to be this song: never "Already yours"');
    const v = vm.dmKeepView();
    assert.deepEqual([v.state, v.headline, v.sub, v.files, v.actions.map((a) => a.id)],
      ['skipped', 'Skipped', 'A file is already there · nothing was overwritten · with your copy of every album by Boukmanflow', [], ['change']]);
    assert.equal(`${v.path.prefix} ${[v.path.path.library, ...v.path.path.crumbs.map((c) => c.text)].join(' › ')} + ${v.path.path.file}`,
      'In collection › From peers › Boukmanflow › Borrowed Tapes + 03 - Corner Store Loop.mp3', 'In the file that was there');
  });

  test('This song: an album copy that lists it speaks too; one that failed it, or does not list it, or an album left out whole, says nothing', async () => {
    const vm = await open('01 - Rooftop Cypher', 'song');
    const m = vm.discover.modal;
    m.jobs = { 'federation-copy@album': albumJob(albumOf(['01 - Rooftop Cypher'])) };
    assert.deepEqual(card(vm), ['copied', 'discover.job.inCollection', false], 'the album copy took it');
    m.jobs = { 'federation-copy@album': albumJob(albumOf(['02 - Late Train Verse'])) };
    assert.deepEqual(card(vm), ['idle', null, true], 'its lists do not name this song (a list stops at 500)');
    m.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [walkOf('Borrowed Tapes', { failed: ['01 - Rooftop Cypher'] })])) };
    assert.deepEqual(card(vm), ['idle', null, true], 'it failed: nothing claimed');
    m.jobs = { 'federation-copy@artist-missing': wide('artist-missing', artistResult('artist-missing', [], [{ name: 'Borrowed Tapes', year: 2019, trackCount: 3, why: 'owned' }])) };
    assert.deepEqual(card(vm), ['idle', null, true], 'an album of that name here is not this song');
    // the same file in another album's walk: the row's album only
    m.jobs = { 'federation-copy@artist': wide('artist', artistResult('artist', [{ ...walkOf('Second Wind', { copied: ['01 - Rooftop Cypher'] }) }])) };
    assert.deepEqual(card(vm), ['idle', null, true], 'the walk\'s view of THIS album names nothing');
    // a live album copy is its own choice's
    m.jobs = { 'federation-copy@album': copyJob() };
    assert.deepEqual(card(vm), ['idle', null, true]);
  });

  test('This song: its own job newer or live wins; another server\'s album copy never speaks', async () => {
    const vm = await open('02 - Late Train Verse', 'song');
    const m = vm.discover.modal;
    const ownDone = songJob({ state: 'done', progress: 1, statusText: null, result: { skipped: 'owned', existing: { filepath: 'Music/x.mp3' } }, finishedAt: 5000 });
    m.jobs = { 'federation-copy': ownDone, 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.deepEqual([vm.dmKeepRow().row.state, vm.dmKeepRow().row.filepath], ['owned', 'Music/x.mp3'], 'own newer');
    m.jobs = { 'federation-copy': { ...ownDone, finishedAt: 1000, updatedAt: 1000 }, 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.equal(vm.dmKeepRow().row.state, 'copied', 'the wider copy came later');
    m.jobs = { 'federation-copy': songJob({ createdAt: 1 }), 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.equal(vm.dmKeepRow().row.state, 'running', 'a live own job');
    m.jobs = { 'federation-copy@album': albumJob({ ...albumOf(['02 - Late Train Verse']), peer: STAGE_C }, { recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher') }) };
    assert.deepEqual(card(vm), ['idle', null, true], 'C\'s album copy is not B\'s song');
    // the song's own job came from C (it stays, "from C") — until B's newer
    // wider copy speaks: then the line is B's, with no "from C" on it
    const fromC = songJob({ state: 'done', progress: 1, statusText: null, recommendation: tapesRow(STAGE_C, '02 - Late Train Verse'),
      result: { copied: { vpath: 'collection', filepath: 'collection/C/late.mp3' }, peer: STAGE_C }, finishedAt: 1000, updatedAt: 1000 });
    m.jobs = { 'federation-copy': fromC };
    assert.match(subText(vm, vm.dmKeepRow().row), /^from Stage Peer C · /, 'before: C\'s recording, named');
    m.jobs['federation-copy@artist-missing'] = wide('artist-missing', USERS_RUN());
    const row = vm.dmKeepRow().row;
    assert.deepEqual([row.state, row.filepath], ['copied', landed('02 - Late Train Verse')]);
    assert.doesNotMatch(subText(vm, row), /Stage Peer C/, 'B\'s own copy is not named from C');
  });

  test('a network row and another plug-in never borrow', async () => {
    const vm = await open('02 - Late Train Verse', 'song');
    const m = vm.discover.modal;
    m.jobs = { 'federation-copy@artist-missing': wide('artist-missing', USERS_RUN()) };
    assert.equal(vm.dmWiderJob('youtube', undefined, null), null);
    m.source = 'network';
    assert.equal(vm.dmWiderJob('federation-copy', undefined, null), null);
    assert.equal(vm.dmWiderJob('federation-copy', 'artist', null), null, 'the artist choices read only their own');
  });
});

describe('keepJobFor and normalizePeerPath (discovery-page.js)', () => {
  test('normalizePeerPath is recommendation.js\'s, byte for byte; a list entry matches through it', () => {
    for (const p of ['peerlib/A/B.mp3', '/peerlib//A/./B.mp3', 'peerlib\\A\\B.mp3', ' peerlib / A /B.mp3 ', '', null, undefined, 42]) {
      assert.equal(D.normalizePeerPath(p), serverNormalizePeerPath(p), JSON.stringify(p));
    }
    const job = { id: 1, plugin: 'federation-copy', state: 'done', params: { scope: 'album' },
      result: { scope: 'album', songs: { total: 1, copied: [{ from: '/peerlib\\A/B.mp3', filepath: 'collection/B.mp3' }], skipped: [], failed: [] } } };
    assert.equal(D.keepJobFor('song', null, [job], { album: 'B', filepath: 'peerlib/A/B.mp3' }, J).result.copied.filepath, 'collection/B.mp3');
    assert.equal(D.keepJobFor('song', null, [job], { album: 'B', filepath: 'peerlib/A/C.mp3' }, J), null);
  });

  test('only the album and song choices borrow; the view never carries the wider job\'s lists', () => {
    const job = { id: 1, plugin: 'federation-copy', state: 'done', params: { scope: 'album' },
      result: { scope: 'album', songs: { total: 1, copied: [{ from: 'p/x.mp3', filepath: 'c/x.mp3' }], skipped: [], failed: [] }, peer: { id: 1, name: 'B' } } };
    assert.equal(D.keepJobFor('artist', null, [job], { album: 'B', filepath: 'p/x.mp3' }, J), null);
    assert.equal(D.keepJobFor('album', null, [job], { album: 'B', filepath: 'p/x.mp3' }, J), null, 'an album copy is not wider than the album');
    const v = D.keepJobFor('song', null, [job], { album: 'B', filepath: 'p/x.mp3' }, J);
    assert.deepEqual(v.result, { peer: { id: 1, name: 'B' }, copied: { filepath: 'c/x.mp3' } });
    assert.equal(v.id, 1);
    assert.equal(J.jobRowState(v).state, 'copied');
  });
});

describe('the recommendation window: what album focus and a reopened failure show (vp.js)', () => {
  const YT = { name: 'youtube', title: 'YouTube download', capabilities: ['acquire'] };

  test('Get it in a connected server\'s window only in Keep a copy\'s place: the copy\'s gate failed, another acquire plug-in passes', async () => {
    const both = makeWindow({ reads: STAGE_READS(), plugins: [COPY, YT] });
    await both.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.ok(both.vm.dmKeepChoices().length, 'Keep a copy shows');
    assert.deepEqual(both.vm.dmGetItRows(), [], 'so no Get it: the exact file is one press away');

    const ytOnly = makeWindow({ reads: STAGE_READS(), plugins: [YT] });
    await ytOnly.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.deepEqual(ytOnly.vm.dmKeepChoices(), [], 'the copy plug-in is off');
    assert.deepEqual(ytOnly.vm.dmGetItRows().map((r) => r.plugin.name), ['youtube'], 'Get it takes Keep\'s place');

    const noDest = makeWindow({ reads: STAGE_READS(), plugins: [COPY, YT], destination: null });
    await noDest.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.deepEqual([noDest.vm.dmKeepChoices(), noDest.vm.dmGetItRows()], [[], []], 'nowhere to put a file: neither');

    const album = makeWindow({ reads: STAGE_READS(), plugins: [YT] });
    await album.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', seedPlain: 'x' });
    assert.deepEqual(album.vm.dmGetItRows(), [], 'never a download row for raws[0] under the album\'s header');

    const lead = makeWindow({ plugins: [COPY, YT] });
    await lead.vm.openDiscoverModal({ title: 'Lead', artist: 'Mo', peer: { endpointId: 'e1' } }, 'p2p');
    assert.deepEqual(lead.vm.dmGetItRows().map((r) => r.plugin.name), ['youtube'], 'a network row\'s Get it is unchanged');
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
    assert.deepEqual([a.theirs, a.missing, a.local], [null, null, 1], 'the facts: unknown');
    assert.equal(vm.dmKeepChosen(), 'artist');
    assert.equal(vm.dmKeepMissingChoice(), true, 'the failed job holds the choice');
    assert.equal(vm.dmKeepMissingLabel(), 'Only the albums you don’t have', 'no "0 albums" it cannot count');
    assert.equal(vm.dmKeepScope(), 'artist-missing');
    const k = vm.dmKeepRow();
    assert.deepEqual([k.row.state, k.row.sub.text, k.row.actions], ['failed', 'Stage Peer B is unreachable', ['retry']]);
    assert.equal(vm.dmKeepView().kind, 'state');
    const v = vm.dmKeepView();
    assert.deepEqual([v.state, v.headline, v.sub, v.actions.map((a) => a.label)], ['failed', 'Copy failed', 'Stage Peer B is unreachable', ['Retry']], 'the job, not an offer');
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
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', 'Whole compilation · 4 songs'], ['artist', 'Ana · 1 album']],
      'Artist is still Ana\'s — her own album; the compilation she is on is no album an artist copy takes');
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.aria), ['Album: the whole compilation Mixtape Vol 1, credited to Various Artists, 4 songs', 'Artist: every album by Ana, 1 album']);
    assert.equal(vm.dmKeepChosen(), 'album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album · 4 songs');
    vm.dmKeepStart();
    assert.deepEqual(starts, [{ plugin: 'federation-copy', choice: null, scope: 'album' }]);
    // what the job is started with: the row, its credit included — so its
    // key is the one Ben's row looks up (src/discovery-plugins jobKeysFor)
    const rec = vm.dmRecommendation();
    assert.equal(rec.albumArtist, 'Various Artists');
    assert.equal(albumKey(rec), albumKey(BEN), 'one album copy for every song of the compilation');
    assert.notEqual(albumKey(rec), albumKey({ ...ANA, albumArtist: null }), 'not the track artist\'s key any more');
  });

  test('the destination line previews a compilation where it lands: its credit, not the song\'s artist', async () => {
    const { vm } = makeWindow({ reads: compReads([]), destination: { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'user' } });
    await vm.openDiscoverModal(ANA, 'federation', { seedPlain: 'x', focus: 'album', view: 'federation' });
    assert.equal(vm.dmLayoutTags().albumartist, 'Various Artists');
    const texts = (p) => p.crumbs.map((c) => c.text);
    assert.deepEqual(texts(vm.dmDestPath('album')), ['Various Artists', 'Mixtape Vol 1']);
    assert.deepEqual(texts(vm.dmDestPath('artist')), ['Ana', 'one folder per album'], 'an artist copy is Ana\'s, never the compilation\'s credit');
    const own = makeWindow({ reads: compReads([]), destination: { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'user' } });
    await own.vm.openDiscoverModal(tapesRow(STAGE_B, 'Late Train Verse'), 'federation', { seedPlain: 'x', view: 'federation' });
    assert.deepEqual(texts(own.vm.dmDestPath('song')).slice(0, 1), ['Boukmanflow'], 'no credit on the row: the song\'s artist, as before');
  });

  test('a compilation song\'s own ⋯: This song | Album (the whole compilation) | Artist (the track artist)', async () => {
    const asked = [];
    const { vm } = makeWindow({ reads: compReads(asked) });
    await vm.openDiscoverModal(BEN, 'federation', { seedPlain: 'x', view: 'federation' });
    assert.equal(vm.discover.modal.focus, null);
    assert.equal(vm.dmSubtitle(), 'Ben · Mixtape Vol 1 · 2020 · 3:41', 'the song\'s header names its own artist');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['song', '3:41 · mp3'], ['album', 'Whole compilation · 4 songs'], ['artist', 'Ben · 1 album']]);
    assert.equal(vm.dmAlbumFacts(), '2020 · 4 songs · 13:20', 'the album row: the whole compilation');
    assert.deepEqual(asked.find((a) => a[0] === 'albumSongs')[2], { album: 'Mixtape Vol 1', artist: null, album_artist: 'Various Artists', year: 2020 });
    assert.deepEqual(asked.find((a) => a[0] === 'artistAlbums')[2], { artist: 'Ben' });
    vm.dmKeepChoose('album');
    assert.equal(vm.dmKeepScope(), 'album');
    assert.equal(vm.dmKeepStartLabel(), 'Add album · 4 songs');
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

// The window's shell (2026-10-21 design, SPEC §3–§5, §10, §11): one meta
// line under the title, Find elsewhere in every connected server's window
// (an album's asks for the album), and the keyboard — focus held in the
// window, given back to the opener, and the player's hotkeys kept out.
describe('the recommendation window: header, Find elsewhere and the keyboard (vp.js)', () => {
  const LINKS = { name: 'links', title: 'Open elsewhere', capabilities: ['links'] };
  // the links plug-in as the server runs it now, through the route's own
  // normalisation — and as a server from before the album phrase did: the
  // "artist title" phrase alone, which without a title is the credit
  const resolveNow = (asked) => async (name, rec) => { asked.push([name, rec]); return { result: { links: serverBuildLinks(normalizeRecommendation(rec)) } }; };
  const resolveOld = (asked) => async (name, rec) => {
    asked.push([name, rec]);
    const q = encodeURIComponent([rec.artist, rec.title].filter(Boolean).join(' '));
    return { result: { links: [{ id: 'musicbrainz-search', label: 'Search MusicBrainz', url: `https://musicbrainz.org/search?type=recording&method=indexed&query=${q}`, kind: 'search' }] } };
  };
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const silentReads = (peers) => ({ ...readsOf(), federationPeers: async () => peers,
    peer: { metadata: async () => { throw new Error('unreachable'); }, albumSongs: async () => null, artistAlbums: async () => null } });

  test('the meta line: the server\'s status, the song\'s format, the match in words — the dot and the words from one answer', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    const opening = vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'your recent listening' });
    assert.deepEqual(vm.dmMetaParts(), [{ kind: 'status', dot: 'wait', text: 'Stage Peer B' }, { kind: 'text', text: '83% match to your recent listening' }],
      'before the reads answer: the name alone and a grey dot hold the line; the format comes with the read');
    await opening;
    assert.deepEqual(vm.dmMetaParts(), [
      { kind: 'status', dot: 'ok', text: 'Stage Peer B online' },
      { kind: 'text', text: 'mp3' },
      { kind: 'text', text: '83% match to your recent listening' },
    ]);
    const seeded = makeWindow({ reads: STAGE_READS() });
    await seeded.vm.openDiscoverModal(tapesRow(STAGE_B, '03 - Corner Store Loop'), 'federation', { seedTitle: 'Late Train Verse' });
    assert.equal(seeded.vm.dmMetaParts()[2].text, '83% match to “Late Train Verse”', 'a seed song, in curly quotes');
    assert.equal(EN['discover.modal.matchLine'], '{{pct}}% match to {{seed}}');
  });

  test('not answering: a red dot with the words, whatever the admin\'s last health check said; the last seen only when the listing knows it', async () => {
    const listed = makeWindow({ reads: silentReads({ peers: [{ ...STAGE_B, lastSeen: minutesAgo(4), lastStatus: 'ok' }] }) });
    await listed.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.deepEqual(listed.vm.dmPeerStatus(), { dot: 'off', text: 'Stage Peer B not answering', seen: 'last seen 4 min ago' }, 'lastStatus "ok" no longer paints it green');
    assert.deepEqual(listed.vm.dmMetaParts().slice(0, 2), [{ kind: 'status', dot: 'off', text: 'Stage Peer B not answering' }, { kind: 'text', text: 'last seen 4 min ago' }],
      'the last seen a part of its own, the hidden "·" between them; no format: the read did not answer');
    const unlisted = makeWindow({ reads: silentReads({ peers: [] }) });
    await unlisted.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.deepEqual(unlisted.vm.dmPeerStatus(), { dot: 'off', text: 'Stage Peer B not answering' }, 'a listing that does not name it: no "last seen never"');
    assert.deepEqual(unlisted.vm.dmMetaParts().map((p) => p.text), ['Stage Peer B not answering', '83% match to x']);
    const neverSeen = makeWindow({ reads: silentReads({ peers: [{ ...STAGE_B, lastSeen: null, lastStatus: null }] }) });
    await neverSeen.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.deepEqual([neverSeen.vm.dmPeerStatus().text, neverSeen.vm.dmPeerStatus().seen], ['Stage Peer B not answering', 'last seen never']);
  });

  test('album focus drops the format (an album has many); a network row has no server status: its ISRC, then the match', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS() });
    await vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse', { isrc: 'USRC17607839' }), 'federation', { focus: 'album', seedPlain: 'your recent listening' });
    assert.deepEqual(vm.dmMetaParts().map((p) => [p.kind, p.text]), [['status', 'Stage Peer B online'], ['text', '83% match to your recent listening']],
      'no "mp3", no ISRC (a recording\'s) under the album');
    const lead = makeWindow();
    await lead.vm.openDiscoverModal({ title: 'Lead', artist: 'Mo', isrc: 'USRC17607839', similarity: 0.5, peer: { endpointId: 'e1' } }, 'p2p', { seedPlain: 'your recent listening' });
    assert.deepEqual(lead.vm.dmMetaParts(), [{ kind: 'isrc', text: 'USRC17607839' }, { kind: 'text', text: '50% match to your recent listening' }]);
  });

  test('album focus asks the links plug-in about the album itself: its credit and its name, nothing of one song', async () => {
    const asked = [];
    const { vm } = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: resolveNow(asked) }, plugins: [COPY, LINKS], realLinks: true });
    const row = tapesRow(STAGE_B, '02 - Late Train Verse', { isrc: 'USRC17607839', recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1' });
    await vm.openDiscoverModal(row, 'federation', { focus: 'album', seedPlain: 'x' });
    assert.deepEqual(asked, [['links', { source: 'federation', peer: { ...STAGE_B }, album: 'Borrowed Tapes', artist: 'Boukmanflow', releaseGroupMbid: 'rg-1' }]],
      'the album phrase: no title, file, ISRC or recording');
    assert.equal(vm.dmFindVisible(), true);
    assert.deepEqual(vm.dmLinks('canonical').map((l) => l.id), ['musicbrainz-release-group'], 'the release group leads; the recording and the ISRC are one song\'s');
    assert.deepEqual(vm.dmLinks('search').map((l) => vm.dmChipLabel(l)), ['MusicBrainz', 'Deezer', 'Apple Music', 'YouTube', 'Bandcamp', 'Discogs']);
    assert.deepEqual(vm.dmLinks('search').map((l) => l.label)[0], 'Search MusicBrainz', 'the full label stays the chip\'s name');
    assert.match(vm.dmLinks('search')[0].url, /type=release&.*query=Boukmanflow%20Borrowed%20Tapes$/);
    // the song's own window asks about the row, as before
    const songAsked = [];
    const song = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: resolveNow(songAsked) }, plugins: [COPY, LINKS], realLinks: true });
    await song.vm.openDiscoverModal(row, 'federation', { seedPlain: 'x' });
    assert.deepEqual([songAsked[0][1].title, songAsked[0][1].filepath], ['02 - Late Train Verse', row.filepath]);
    assert.deepEqual(song.vm.dmLinks('canonical').map((l) => l.id), ['musicbrainz-recording', 'musicbrainz-release-group', 'musicbrainz-isrc']);
  });

  test('a compilation\'s album searches under its credit; Copy title copies "Credit - Album" in album focus', async () => {
    const asked = [];
    const { vm, copied } = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: resolveNow(asked) }, plugins: [COPY, LINKS], realLinks: true });
    const ana = tapesRow(STAGE_B, 'Wind One', { artist: 'Ana', album: 'Mixtape Vol 1', albumArtist: 'Various Artists' });
    await vm.openDiscoverModal(ana, 'federation', { focus: 'album', seedPlain: 'x' });
    assert.deepEqual(asked[0][1], { source: 'federation', peer: { ...STAGE_B }, album: 'Mixtape Vol 1', artist: 'Various Artists', albumArtist: 'Various Artists' });
    assert.match(vm.dmLinks('search')[0].url, /query=Various%20Artists%20Mixtape%20Vol%201$/);
    vm.dmCopyTitle();
    await vm.openDiscoverModal(ana, 'federation', { seedPlain: 'x' });
    vm.dmCopyTitle();
    assert.deepEqual(copied, ['Various Artists - Mixtape Vol 1', 'Ana - Wind One']);
  });

  test('a server whose links plug-in only searches songs: album focus has no Find elsewhere; the song window keeps it; a failed lookup keeps the section', async () => {
    const old = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: resolveOld([]) }, plugins: [COPY, LINKS], realLinks: true });
    await old.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', seedPlain: 'x' });
    assert.deepEqual([old.vm.discover.modal.links, old.vm.discover.modal.loading, old.vm.discover.modal.error], [[], false, false], 'the credit\'s search is not the album\'s');
    assert.equal(old.vm.dmFindVisible(), false);
    await old.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.equal(old.vm.discover.modal.links.length, 1, 'a song phrase it answers');
    assert.equal(old.vm.dmFindVisible(), true);

    const none = makeWindow({ reads: STAGE_READS(), plugins: [COPY], realLinks: true });
    await none.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', seedPlain: 'x' });
    assert.equal(none.vm.dmFindVisible(), false, 'no links plug-in: nothing to find the album with');
    await none.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { seedPlain: 'x' });
    assert.equal(none.vm.dmFindVisible(), true, 'the song window always ends with it (Copy title)');

    const failed = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: async () => null }, plugins: [COPY, LINKS], realLinks: true });
    const opening = failed.vm.openDiscoverModal(tapesRow(STAGE_B, '02 - Late Train Verse'), 'federation', { focus: 'album', seedPlain: 'x' });
    assert.equal(failed.vm.dmFindVisible(), true, 'while it is asked: "Looking up…"');
    await opening;
    assert.deepEqual([failed.vm.discover.modal.error, failed.vm.dmFindVisible()], [true, true], '"Couldn\'t look up links right now." and Copy title');
    assert.equal(EN['discover.modal.search'], 'Search');
  });

  test('the opener: the control the window gives the keyboard back to, found again after a redraw, else the Discover heading', () => {
    const opener = new Function(`${vpModuleFn('dmOpenerOf')}\nreturn dmOpenerOf;`)();
    const back = new Function(`${vpModuleFn('dmFocusBack')}\nreturn dmFocusBack;`)();
    const node = (tagName, attrs = {}, over = {}) => {
      const el = { tagName, isConnected: true, focused: 0, attrs,
        getAttribute: (n) => (n in attrs ? String(attrs[n]) : null), hasAttribute: (n) => n in attrs, setAttribute: (n, v) => { attrs[n] = String(v); },
        closest: () => null, focus() { el.focused += 1; }, ...over };
      return el;
    };
    const more = node('BUTTON', { 'data-dp': 'peerMore', 'data-i': 3 });
    assert.deepEqual(opener(more), { el: more, sel: '[data-dp="peerMore"][data-i="3"]', key: null });
    const stripRow = node('DIV', { class: 'discover-job pointer' });
    assert.deepEqual(opener(stripRow), { el: stripRow, sel: null, key: null });
    assert.equal(opener(node('BODY')), null, 'nothing had focus');
    assert.equal(opener(node('BUTTON', {}, { closest: (sel) => (sel === '.dmodal-shadow' ? {} : null) })), null, 'a control inside the window');
    assert.equal(opener(undefined), null);

    const queries = [];
    const docOf = (found) => ({ querySelector: (sel) => { queries.push(sel); return found[sel] || null; } });
    assert.equal(back(opener(more), docOf({})), more, 'still on the page: itself');
    assert.equal(more.focused, 1);
    const redrawn = node('BUTTON', { 'data-dp': 'peerMore', 'data-i': 3 });
    const gone = { ...opener(more), el: { ...more, isConnected: false } };
    assert.equal(back(gone, docOf({ '#filelist .dpage [data-dp="peerMore"][data-i="3"]': redrawn })), redrawn, 'the page redrew: the ⋯ in its place');
    assert.deepEqual(queries.splice(0), ['#dpage-head .dpage button[data-dp="peerMore"][data-i="3"]', '#dpage-head .dpage [data-dp="peerMore"][data-i="3"]',
      '#filelist .dpage button[data-dp="peerMore"][data-i="3"]', '#filelist .dpage [data-dp="peerMore"][data-i="3"]'], 'a button first, in each place');
    // a lead's row and its ⋯ carry the same data-dp: the ⋯ (a button) takes it, not the row before it
    const leadRow = node('DIV', { 'data-dp': 'lead', 'data-i': 2 });
    const leadMore = node('BUTTON', { 'data-dp': 'lead', 'data-i': 2 });
    const lead = { el: { ...leadMore, isConnected: false }, sel: '[data-dp="lead"][data-i="2"]' };
    assert.equal(back(lead, docOf({ '#filelist .dpage [data-dp="lead"][data-i="2"]': leadRow, '#filelist .dpage button[data-dp="lead"][data-i="2"]': leadMore })), leadMore);
    assert.equal(leadRow.focused, 0);
    queries.length = 0;
    assert.equal(back(lead, docOf({ '#filelist .dpage [data-dp="lead"][data-i="2"]': leadRow })), leadRow, 'no button there: the plain match');
    queries.length = 0;
    const heading = node('H3');
    assert.equal(back(gone, docOf({ '#filelist .dpage h3': heading })), heading, 'gone: the Discover page\'s heading');
    assert.deepEqual([heading.attrs.tabindex, heading.focused], ['-1', 1], 'focusable out of the tab order');
    assert.equal(back({ el: { ...stripRow, isConnected: false }, sel: null }, docOf({})), null, 'nowhere: left alone');
    assert.equal(back(opener(stripRow), docOf({})), stripRow, 'a strip row (a div) takes it as tabindex -1');
    assert.equal(stripRow.attrs.tabindex, '-1');
  });

  test('open → close gives the keyboard back to the opener once the window is gone; a window that replaces an open one keeps the first opener', async () => {
    const { vm, ticks } = makeWindow({ reads: STAGE_READS() });
    const mk = (i) => { const el = { tagName: 'BUTTON', isConnected: true, focused: 0, getAttribute: (n) => ({ 'data-dp': 'peerMore', 'data-i': String(i) })[n] ?? null, hasAttribute: () => false, closest: () => null, focus() { el.focused += 1; } }; return el; };
    const first = mk(0);
    const second = mk(1);
    await vm.openDiscoverModal(tapesRow(STAGE_B, 'A'), 'federation', { opener: first });
    await vm.openDiscoverModal(tapesRow(STAGE_B, 'B'), 'federation', { opener: second });
    ticks.splice(0);   // Close's initial focus
    vm.closeDiscoverModal();
    assert.equal(first.focused, 0, 'not before the window left the page');
    ticks.splice(0).forEach((f) => f());
    assert.deepEqual([first.focused, second.focused], [1, 0]);
    vm.closeDiscoverModal();
    assert.equal(ticks.length, 0, 'a second close has no opener to go back to');
    // a strip row hands its row over
    await vm.openDiscoverModalForJob(copyJob({ params: {} }), second);
    ticks.splice(0);
    vm.closeDiscoverModal();
    ticks.splice(0).forEach((f) => f());
    assert.equal(second.focused, 1);
  });

  test('the focus trap: Tab past either end wraps; from outside the window it lands on the first (or last) control; a radio group is one stop', () => {
    const trap = new Function(`${vpModuleFn('dmTrapTarget')}\nreturn dmTrapTarget;`)();
    const tabbables = new Function(`${vpModuleFn('dmTabbables')}\nreturn dmTabbables;`)();
    const [close, disc, copyTitle, body] = ['close', 'disc', 'copy', 'body'].map((id) => ({ id }));
    const list = [close, disc, copyTitle];
    assert.equal(trap(list, copyTitle, false), close, 'Tab from the last: Close');
    assert.equal(trap(list, close, true), copyTitle, 'Shift+Tab from Close: the last');
    assert.equal(trap(list, disc, false), null, 'inside: the browser\'s own move');
    assert.equal(trap(list, disc, true), null);
    assert.equal(trap(list, body, false), close, 'focus fell to <body>: back in at Close');
    assert.equal(trap(list, body, true), copyTitle);
    assert.equal(trap([], close, false), null);
    const el = (id, over = {}) => ({ id, disabled: false, name: '', checked: false, getAttribute: (n) => (over.attrs && n in over.attrs ? over.attrs[n] : null), getClientRects: () => (over.unrendered ? [] : [{}]), ...over });
    const all = [el('close'), el('song', { type: 'radio', name: 's' }), el('album', { type: 'radio', name: 's', checked: true }), el('artist', { type: 'radio', name: 's' }),
      el('busy', { disabled: true }), el('hidden', { type: 'hidden' }), el('row', { attrs: { tabindex: '-1' } }), el('gone', { unrendered: true }), el('copy')];
    assert.deepEqual(tabbables({ querySelectorAll: () => all }).map((e) => e.id), ['close', 'album', 'copy']);
    const none = all.map((e) => (e.type === 'radio' ? { ...e, checked: false } : e));
    assert.deepEqual(tabbables({ querySelectorAll: () => none }).map((e) => e.id), ['close', 'song', 'copy'], 'no radio checked: the group\'s first');
    assert.deepEqual(tabbables(null), []);
  });

  test('the player\'s hotkeys skip a field, any key inside the window, and a page control that opens it (Space presses its buttons, never Play/Pause)', () => {
    const skip = new Function(`${vpModuleFn('hotkeysSkip')}\nreturn hotkeysSkip;`)();
    // `inside`: the classes of the element and its ancestors, as closest() matches a selector list
    const target = (tagName, { inWindow = false, editable = false, inside = [] } = {}) => ({ tagName, isContentEditable: editable,
      closest: (sel) => (sel.split(/,\s*/).some((one) => (one === '.dmodal-shadow' && inWindow) || inside.indexOf(one.replace(/^\./, '')) !== -1) ? {} : null) });
    assert.equal(skip(target('BUTTON', { inWindow: true })), true, 'a button in the window');
    for (const cls of ['browse-keep', 'browse-keep-tab', 'browse-keep-more']) {
      assert.equal(skip(target('BUTTON', { inside: [cls] })), true, `a connected server's page ${cls}: Space opens the window, as Enter does`);
    }
    assert.equal(skip(target('svg', { inside: ['browse-keep-tab'] })), true, 'its glyph too');
    assert.equal(skip(target('DIV', { inWindow: true })), true, 'the window itself (a click on its body)');
    assert.equal(skip(target('INPUT')), true);
    assert.equal(skip(target('SELECT')), true);
    assert.equal(skip(target('DIV', { editable: true })), true);
    assert.equal(skip(target('BUTTON')), false, 'a button elsewhere: the hotkey plays');
    assert.equal(skip(target('BODY')), false);
    assert.equal(skip(null), false);
    assert.match(VP_SRC, /window\.addEventListener\("keydown", \(event\) => \{[\s\S]{0,200}if \(hotkeysSkip\(event\.target\)\) \{ return; \}/);
  });
});

describe('index.html: the window\'s album focus', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const win = HTML.slice(HTML.indexOf('class="dmodal-shadow"'), HTML.indexOf('id="pop"'));
  test('the header names the album; Listen plays the album in its place; one meta line', () => {
    assert.match(win, /<h2 class="dmodal-title" id="dmodal-title">\{\{ dmHeadTitle\(\) \}\}<\/h2>/);
    assert.match(win, /<div v-(?:else-)?if="dmAlbumFocus\(\)" class="dm-play">[\s\S]*?v-on:click="dmQueueAlbum\(true\)"[\s\S]*?dmAlbumPlaySub\(\)[\s\S]*?v-on:click="dmQueueAlbum\(false\)"[\s\S]*?v-on:click="dmViewAlbum"/);
    assert.match(win, /<div v-else class="dm-play">[\s\S]*?v-on:click="dmPlayNow"/);
    assert.match(win, /<div v-if="discover\.modal\.track\.album && !dmAlbumFocus\(\)" class="dm-fact">/, 'the album row is the play row\'s in album focus');
    assert.match(win, /<div v-if="dmMetaParts\(\)\.length" class="dmodal-meta">/);
    assert.ok(!/dmodal-matchbar|dmodal-status-off/.test(win), 'no match-bar sliver; no second status line');
  });
  test('no tabs; Find elsewhere closes every window; real buttons; the checkbox names its count only when it has one', () => {
    assert.ok(!/dmodal-tabs|setDiscoverModalView|discover\.modal\.view\b/.test(win), 'no Federation | Plug-Ins tabs');
    const sections = [...win.matchAll(/<section v-if="([^"]*)" class="dmodal-section">|<section class="dmodal-section">/g)];
    assert.equal(sections[sections.length - 1][1], 'dmFindVisible()', 'Find elsewhere is the last section, in a connected server\'s window too');
    assert.match(win, /<button type="button" class="dmodal-close" ref="dmodalClose"[^>]*:aria-label="tt\('discover\.modal\.close'\)"/);
    assert.match(win, /<div class="dmodal" ref="dmodal" tabindex="-1"[^>]*role="dialog" aria-modal="true" aria-labelledby="dmodal-title">/);
    // every control in the window a real button (Keep a copy's included)
    assert.ok(win.indexOf('<section v-if="dmKeepShown()" class="dmodal-section">') > 0);
    assert.ok(!/javascript:void/.test(win), 'no <a href="javascript:void(0)"> anywhere in the window');
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

  test('off on Peer Recommendations: any one of its four flags missing, a 403, or a history answer with network: null (R7) — no line', () => {
    for (const flags of [FLAGS, { ...PFLAGS, discoveryP2p: false }, { ...PFLAGS, discoveryP2pPeers: 0 }, { ...PFLAGS, discoveryTaste: 1 }, { ...PFLAGS, discovery: false }]) {
      const s = D.stateOf(leadsResponse(), flags, PEER_PAGE);
      assert.equal(s.state, 'off', JSON.stringify(flags));
      assert.equal(s.reason, null, 'no off card: the page is left');
      assert.deepEqual(Object.values(s.sources).map((x) => x.status), ['absent', 'absent', 'absent']);
    }
    assert.equal(D.stateOf({ disabled: true }, PFLAGS, PEER_PAGE).state, 'off');
    const switchedOff = D.stateOf(leadsResponse({ network: null }), PFLAGS, PEER_PAGE);
    assert.deepEqual([switchedOff.state, switchedOff.reason, switchedOff.sources.network.status], ['off', null, 'absent'], 'p2p went off');
    assert.equal(D.stateOf(historyResponse({ network: null }), FLAGS).state, 'ready', 'Discover never asks the network');
    assert.equal(D.stateOf(leadsResponse(), PFLAGS, PEER_PAGE).state, 'ready');
  });

  test('loading and failed', () => {
    const loading = D.stateOf(undefined, FLAGS);
    assert.equal(loading.state, 'loading');
    assert.deepEqual([loading.sources.library.status, loading.sources.network.status, loading.sources.peers.status], ['loading', 'absent', 'loading']);
    const peerRecs = D.stateOf(undefined, PFLAGS, PEER_PAGE);
    assert.equal(peerRecs.state, 'loading');
    assert.deepEqual([peerRecs.sources.library.status, peerRecs.sources.network.status, peerRecs.sources.peers.status], ['absent', 'loading', 'absent']);
    const failed = collect(D.stateOf(null, FLAGS));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason.key, 'dpage.state.failed');
    assert.equal(failed.sources.library.status, 'failed');
    assert.equal('tabs' in failed, false, 'no segmented tabs');
    const peerFailed = D.stateOf(null, PFLAGS, PEER_PAGE);
    assert.deepEqual([peerFailed.state, peerFailed.reason], ['failed', null], 'Peer Recommendations: "Try again" alone');
    assert.deepEqual(peerFailed.sources.network, { status: 'failed', reason: null, count: 0 });
  });

  test('a random seed: the server asks no connected server, so no peers column while that call is out', () => {
    const random = D.mergeResponses({ ...historyResponse(), seedSource: 'random' }, undefined, true);
    assert.equal(D.stateOf(random, FLAGS).sources.peers.status, 'absent');
    assert.equal(D.stateOf(D.mergeResponses(historyResponse(), undefined, true), FLAGS).sources.peers.status, 'loading', 'a history seed: still asking');
  });

  test('ready: the play page draws library + peers, Peer Recommendations the network', () => {
    const s = D.stateOf(merged(), PFLAGS);
    assert.equal(s.state, 'ready');
    assert.equal(s.reason, null);
    assert.deepEqual(Object.entries(s.sources).map(([k, x]) => [k, x.status, x.count]), [['library', 'ready', 6], ['network', 'absent', 0], ['peers', 'ready', 3]]);
    const peerRecs = D.stateOf(merged(), PFLAGS, PEER_PAGE);
    assert.deepEqual([peerRecs.state, peerRecs.reason], ['ready', null]);
    assert.deepEqual(Object.entries(peerRecs.sources).map(([k, x]) => [k, x.status, x.count]), [['library', 'absent', 0], ['network', 'ready', 3], ['peers', 'absent', 0]]);
  });

  test('a random seed with a network section is ready on Peer Recommendations (leads off the pick, S6) — never "finish a few songs"', () => {
    const random = { seedSource: 'random', fallback: true, seeds: [seed('r', 'R', 'A', { outcome: null })] };
    const s = collect(D.stateOf(leadsResponse(random), PFLAGS, PEER_PAGE));
    assert.deepEqual([s.state, s.reason, s.sources.network.status, s.sources.network.count], ['ready', null, 'ready', 3]);
    const dropped = D.stateOf(leadsResponse({ ...random, excluded: [{ hash: 'h1', filepath: 'x', metadata: {} }] }), PFLAGS, PEER_PAGE);
    assert.equal(dropped.state, 'ready', 'every finished song dropped: still the leads');
    const empty = collect(D.stateOf(leadsResponse({ ...random, network: { results: [], searched: { peers: 0, tracks: 0 }, reason: 'empty-shelf' } }), PFLAGS, PEER_PAGE));
    assert.deepEqual([empty.state, empty.sources.network.why], ['ready', 'noPeers'], 'the network\'s own empty state');
    const none = D.stateOf(leadsResponse({ ...random, network: null }), PFLAGS, PEER_PAGE);
    assert.deepEqual([none.state, none.sources.network.status], ['nothingFinished', 'absent'], 'no section on a random answer (unreachable behind the gate): not off');
    assert.equal(D.stateOf(merged(random, null), PFLAGS).state, 'nothingFinished', 'Discover unchanged');
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
    const peer = collect(D.stateOf(r, PFLAGS, PEER_PAGE));
    assert.deepEqual([peer.state, peer.reason.key], ['scanPending', 'dpage.state.scanPending'], 'Discover\'s scan-pending card');
    assert.deepEqual(peer.sources.network, { status: 'empty', why: 'scanPending', reason: { key: 'dpage.source.waitingForScan', params: {} }, count: 0 });
    // the route's early answer: the section comes back empty with reason 'scan-pending'
    const early = leadsResponse({ seeds: [seed('u1', 'U', 'A', { analyzed: false })], network: { results: [], searched: { peers: 0, tracks: 0 }, reason: 'scan-pending' } });
    assert.equal(D.stateOf(early, PFLAGS, PEER_PAGE).state, 'scanPending', 'by the network\'s reason alone');
    assert.equal(D.stateOf({ ...early, seedSource: 'random' }, PFLAGS, PEER_PAGE).state, 'scanPending', 'a random pick with no vector too');
  });

  test('nothingFinished: a random seed — or every finished song dropped', () => {
    const random = { seedSource: 'random', fallback: true, network: null, seeds: [seed('r', 'R', 'A', { outcome: null })] };
    const s = collect(D.stateOf(merged(random, { ...peersResponse(), peers: null }), FLAGS));
    assert.equal(s.state, 'nothingFinished');
    assert.equal(s.reason.key, 'dpage.state.nothingFinished');
    assert.equal(s.sources.peers.status, 'absent', 'no fan-out for a random seed: not drawn');
    assert.equal(s.sources.library.status, 'ready');
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

  test('the network names its emptiness by the server\'s reason (Peer Recommendations) — no guess from the counts', () => {
    const net = (reason, searchedPeers = 3) => collect(D.stateOf(leadsResponse({ network: { results: [], searched: { peers: searchedPeers, tracks: 0 }, reason } }), PFLAGS, PEER_PAGE));
    const empty = (why, key) => ({ status: 'empty', why, reason: { key, params: {} }, count: 0 });
    for (const reason of ['empty-shelf', 'no-compatible']) {
      assert.deepEqual(net(reason, 0).sources.network, empty('noPeers', 'peerRecs.noPeers'), reason);
      assert.equal(net(reason, 0).state, 'ready', 'the page draws the source\'s state');
    }
    for (const reason of ['nothing-new', null, undefined, 'something-later']) {
      assert.deepEqual(net(reason).sources.network, empty('nothingNew', 'peerRecs.nothingNew'), String(reason));
    }
    assert.deepEqual(net('nothing-new', 0).sources.network, empty('nothingNew', 'peerRecs.nothingNew'), 'no peer searched is not "warming up" any more');
    assert.deepEqual(net('not-on-shelf', 0).sources.network, { status: 'notOnShelf', reason: null, count: 0 }, 'the tab\'s peer left the shelf: back to All (R5)');
    assert.deepEqual(net('error').sources.network, { status: 'failed', reason: null, count: 0 }, 'the walk failed: "Try again" alone');
    assert.deepEqual(net('scan-pending', 0).sources.network.why, 'scanPending');
    assert.deepEqual(net('empty-shelf').sources.network.status, 'empty');
    const ready = collect(D.stateOf(leadsResponse({ network: { ...leadsResponse().network, reason: 'empty-shelf' } }), PFLAGS, PEER_PAGE)).sources.network;
    assert.deepEqual(ready, { status: 'ready', reason: null, count: 3 }, 'rows win over a reason');
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
    const peerRecs = D.stateOf(leadsResponse({ network: undefined }), PFLAGS, PEER_PAGE);
    assert.equal(peerRecs.sources.network.status, 'loading');
    assert.equal(D.stateOf(leadsResponse(), PFLAGS, { page: 'nope' }).sources.network.status, 'absent', 'an unknown page is Discover');
  });
});

// ── prefs and option lists ────────────────────────────────────────────

describe('option lists', () => {
  test('the window options', () => {
    const w = collect(D.windowOptions(90));
    assert.deepEqual(w.map((o) => [o.value, o.label.key, o.selected]), [[7, 'dpage.window.days', false], [30, 'dpage.window.days', false], [90, 'dpage.window.days', true], [0, 'dpage.window.all', false]]);
    assert.equal(D.windowOptions('0')[3].selected, true, 'a stored string selects');
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
    assert.ok(literals.length > 20, `found ${literals.length}`);
    for (const key of literals) { assert.ok(EN[key] !== undefined, `${key} missing from en.json`); }
    assert.deepEqual(literals.filter((k) => /^dpage\.(network|plugins)\./.test(k)), [], 'the explore page\'s copy is not the model\'s');
  });

  test('Peer Recommendations: the module names its two empty states with the page\'s own keys, and nothing more', () => {
    const literals = [...new Set([...SOURCE.matchAll(/'(peerRecs\.[A-Za-z.]+[A-Za-z])'/g)].map((m) => m[1]))];
    assert.deepEqual(literals.sort(), ['peerRecs.noPeers', 'peerRecs.nothingNew']);
    assert.equal(EN['peerRecs.noPeers'], 'No peers yet');
    assert.equal(EN['peerRecs.nothingNew'], 'Nothing new');
    assert.ok(EMITTED.some((l) => l.key === 'peerRecs.noPeers') && EMITTED.some((l) => l.key === 'peerRecs.nothingNew'), 'both drawn by the tests above');
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

// ── vp.js: where files land — the path bar by scope, the path inside a
// copy's states, freshness, the start's destination, the editor ─────────
// The destination's methods sliced out like the window's, over the same
// stub `this` (makeWindow), with the server's routes stubbed beside the
// peer's reads; the window's controls the keyboard lands on are stand-ins
// that record focus.
const DEST_METHODS = ['dmLoadJobs', 'dmLoadDestination', 'dmDestRefused', 'dmDestShown', 'dmJobStart', 'dmErrorText', 'dmJobPath', 'dmDestMoved',
  'dmOpenPicker', 'dmPickerFill', 'dmPickerSync', 'dmDestEditing', 'dmClosePicker', 'dmDestFocus', 'dmPickerLibraries', 'dmPickerChips', 'dmPickerVars', 'dmPickerVarLabel',
  'dmPickerPresets', 'dmPickerIsPreset', 'dmPickerLayout', 'dmPickerAsOpened', 'dmPickerHeldBraces', 'dmPickerDirty', 'dmPickerCanSave', 'dmPickerCustomProblem',
  'dmPickerChoose', 'dmPickerChooseCustom', 'dmPickerTyped', 'dmPickerLibrary', 'dmPickerPreview', 'dmPickerUnseen', 'dmPickerLandsAt', 'dmPickerMissing', 'dmPickerProblem',
  'dmVarToken', 'dmPickerVarFits', 'dmInsertVar', 'dmDestDefault', 'dmPickerIsDefault', 'dmPickerUseDefault', 'dmPickerBase', 'dmPickerStartAt',
  'dmBrowseToggle', 'dmBrowseAnchor', 'dmBrowseLoad', 'dmBrowseCrumbs', 'dmBrowseIsBase', 'dmBrowseMissing',
  'dmBrowseInto', 'dmBrowseUp', 'dmBrowseNewFolder', 'dmPickerSubmit', 'dmDestLanding'];
const LAYOUT = '{{ALBUMARTIST}}/{{ALBUM}}';
const COPIES = { vpath: 'copies', base: '', layout: LAYOUT, source: 'user' };
const MUSIC_DEFAULT = { vpath: 'music', base: '', layout: LAYOUT, source: 'default' };
// GET /api/v1/discovery/collection/destination: the libraries in the
// server's order, the first the library default
const viewOf = (destination) => ({ destination, saved: destination && destination.source === 'user' ? { vpath: destination.vpath, base: destination.base, layout: destination.layout } : null,
  libraries: [{ vpath: 'music', template: null }, { vpath: 'copies', template: null }], defaultLayout: LAYOUT, variables: ['ARTIST', 'ALBUM', 'YEAR', 'GENRE', 'ALBUMARTIST', 'PEER'] });
// The spec's sample: the library has Harbour Lights (and here Borrowed
// Tapes) by name; Stage Peer B has those and Second Shift
const shiftReads = (local) => readsOf({
  albumSongs: songsOf(3),
  peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes'), peerAlbumItem('Harbour Lights'), peerAlbumItem('Second Shift', { year: 2021, year_min: 2021, year_max: 2021 })] },
  localAlbums: { albums: local.map((n) => peerAlbumItem(n)) },
});
const FOLDERS = { '/copies': ['from-peers', 'Boukmanflow'], '/copies/from-peers': ['Stage Peer B', 'Stage Peer C', '2025 archive'], '/copies/from-peers/Stage Peer C': [] };
const httpError = (status, body) => Object.assign(new Error(`failed: ${status}`), { status, body });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const pathLine = (p) => [p.library, ...p.crumbs.map((c) => c.text)].join(' › ');
const jobLine = (jp) => jp && `${jp.prefix} ${pathLine(jp.path)}`;

function makeDestWindow({ reads = shiftReads(['Harbour Lights', 'Borrowed Tapes']), server = { view: viewOf(COPIES) } } = {}) {
  const calls = { destination: 0, starts: [], saves: [], listed: [] };
  const api = Object.assign(reads, {
    currentServer: { host: '' },
    discoveryDestination: async () => { calls.destination += 1; return server.view; },
    discoveryJobLookup: async () => ({ key: 'song:k', keys: { song: 'song:k' }, jobs: [] }),
    discoveryJobStart: async (name, rec, choice, scope, destination) => {
      calls.starts.push({ name, scope, destination });
      return { job: { id: 7, plugin: name, key: `${scope || 'song'}:k`, state: 'queued', params: scope ? { scope } : null, recommendation: rec } };
    },
    discoverySaveDestination: async (d) => { calls.saves.push(d); server.view = viewOf(d ? { ...d, source: 'user' } : MUSIC_DEFAULT); return server.view; },
    dirparser: async (dir) => {
      calls.listed.push(dir);
      if (!(dir in FOLDERS)) { throw httpError(400, { error: 'not a directory' }); }
      return { directories: FOLDERS[dir].map((name) => ({ name })) };
    },
  });
  const w = makeWindow({ reads: api, destination: server.view.destination });
  const doc = { activeElement: null, body: { name: 'body' } };
  // a saved place's toast lands with the window's own
  const izi = { success: (o) => w.toasts.push({ kind: 'success', ...o }) };
  const methods = new Function('DISCOVERJOBS', 'MSTREAMAPI', 'document', 't', 'iziToast',
    `return { ${DEST_METHODS.map((n) => `${n}: ${vpMethodSrc(n)}`).join(',\n')} };`)(J, api, doc, tEn, izi);
  Object.assign(w.vm, methods, { ensureDiscoverPlugins: async () => w.vm.discover.plugins.list, noteDiscoverJob() {} });
  w.vm.discover.dest = { view: server.view, saves: 0 };
  const els = {};
  const el = (name) => (els[name] = els[name] || { name, focus() { doc.activeElement = this; } });
  const targets = { '[data-dm-change]': 'change', '[data-dm-browse]': 'browse', '.dm-dest-chip[aria-pressed="true"]': 'library', '.dm-dest-tree button': 'firstRow' };
  w.vm.$refs.dmodal = { contains: (x) => Object.values(els).includes(x), querySelector: (sel) => (targets[sel] ? el(targets[sel]) : null) };
  const tick = () => w.ticks.splice(0).forEach((f) => f());
  return { ...w, api, server, calls, doc, tick, el, focused: () => doc.activeElement && doc.activeElement.name };
}
const lateTrain = () => tapesRow(STAGE_B, '02 - Late Train Verse');

describe('where files land: the path bar draws what the chosen scope copies (vp.js)', () => {
  test('the song and its file; the album; every album "one folder per album"; only the missing names its one album', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const song = vm.dmDestPath('song');
    assert.deepEqual([pathLine(song), song.file, song.title], ['copies › Boukmanflow › Borrowed Tapes', '02 - Late Train Verse.mp3', 'copies/Boukmanflow/Borrowed Tapes']);
    assert.deepEqual([pathLine(vm.dmDestPath('album')), vm.dmDestPath('album').file], ['copies › Boukmanflow › Borrowed Tapes', null], 'an album has no file line');
    assert.equal(pathLine(vm.dmDestPath('artist')), 'copies › Boukmanflow › one folder per album', 'never the seed song\'s own folder for a wider scope');
    assert.deepEqual(vm.dmDestPath('artist').crumbs.map((c) => c.kind), ['rendered', 'note']);
    assert.deepEqual(vm.discover.modal.artist.missingOne, { name: 'Second Shift', year: 2021 });
    assert.equal(pathLine(vm.dmDestPath('artist-missing')), 'copies › Boukmanflow › Second Shift', 'exactly one missing: the path names it');
    const two = makeDestWindow({ reads: shiftReads(['Harbour Lights']) });
    await two.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.deepEqual([two.vm.discover.modal.artist.missing, two.vm.discover.modal.artist.missingOne], [2, null]);
    assert.equal(pathLine(two.vm.dmDestPath('artist-missing')), 'copies › Boukmanflow › one folder per album');
  });

  test('a layout without {{ALBUM}} adds nothing for an artist; a base folder follows the library and {{PEER}} names the server; no destination, no bar', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    vm.discover.dest.view = viewOf({ ...COPIES, layout: '{{ALBUMARTIST}}' });
    assert.equal(pathLine(vm.dmDestPath('artist')), 'copies › Boukmanflow', 'every album shares the artist\'s folder');
    vm.discover.dest.view = viewOf({ ...COPIES, base: 'from-peers', layout: '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}' });
    const peer = vm.dmDestPath('song');
    assert.equal(pathLine(peer), 'copies › from-peers › Stage Peer B › Boukmanflow › Borrowed Tapes');
    assert.deepEqual(peer.crumbs.map((c) => c.kind), ['base', 'rendered', 'rendered', 'rendered']);
    vm.discover.dest.view = viewOf(null);
    assert.equal(vm.dmDestPath('song'), null);
    assert.equal(vm.dmDestShown(), undefined, 'nothing shown, nothing to check');
  });
});

describe('where files land: the path inside a copy\'s states (vp.js)', () => {
  const pinned = { vpath: 'music', base: 'from-peers', layout: LAYOUT, source: 'user' };
  test('Into: the destination pinned on the job at start — a Save since does not move it; a job from before the pin: the saved one', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const into = vm.dmJobPath(copyJob({ state: 'queued', params: { scope: 'album', destination: pinned } }));
    assert.deepEqual([into.kind, jobLine(into)], ['into', 'Into music › from-peers › Boukmanflow › Borrowed Tapes']);
    assert.equal(jobLine(vm.dmJobPath(copyJob({ state: 'running', params: { scope: 'album' } }))), 'Into copies › Boukmanflow › Borrowed Tapes');
    assert.equal(jobLine(vm.dmJobPath(copyJob({ state: 'running', params: { scope: 'artist', destination: pinned } }))), 'Into music › from-peers › Boukmanflow › one folder per album');
    const theirs = copyJob({ state: 'running', recommendation: tapesRow(STAGE_C, 'x'), params: { scope: 'album', destination: { ...pinned, layout: '{{PEER}}/{{ALBUM}}' } } });
    assert.equal(jobLine(vm.dmJobPath(theirs)), 'Into music › from-peers › Stage Peer C › Borrowed Tapes', 'another server\'s copy names its own server');
  });

  test('In: where the files are — a song\'s with its file, the folder an artist\'s copies share; the destination it ran with when the result lists none; nothing landed, no path', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const song = { id: 9, plugin: 'federation-copy', state: 'done', params: null, recommendation: lateTrain(),
      result: { copied: { vpath: 'copies', filepath: 'copies/Boukmanflow/Borrowed Tapes/02 - Late Train Verse.mp3' }, destination: COPIES } };
    const landed = vm.dmJobPath(song);
    assert.deepEqual([landed.kind, jobLine(landed), landed.path.file, landed.path.crumbs[0].kind], ['in', 'In copies › Boukmanflow › Borrowed Tapes', '02 - Late Train Verse.mp3', 'landed']);
    const owned = { ...song, result: { skipped: 'owned', existing: { vpath: 'music', filepath: 'music/Old Rips/Late Train.flac' }, destination: COPIES } };
    assert.deepEqual([jobLine(vm.dmJobPath(owned)), vm.dmJobPath(owned).path.file], ['In music › Old Rips', 'Late Train.flac'], 'already yours: the existing file\'s folder');
    const artist = copyJob({ state: 'done', params: { scope: 'artist' }, result: { songs: { total: 3, copied: [{ filepath: 'copies/Boukmanflow/Borrowed Tapes/1.mp3' }, { filepath: 'copies/Boukmanflow/Second Shift/1.mp3' }], skipped: [], failed: [] }, stopped: null, destination: COPIES } });
    assert.equal(jobLine(vm.dmJobPath(artist)), 'In copies › Boukmanflow');
    const counted = copyJob({ state: 'done', params: { scope: 'album' }, result: { counts: { total: 3, copied: 3, skipped: 0, failed: 0 }, destination: pinned } });
    assert.equal(jobLine(vm.dmJobPath(counted)), 'In music › from-peers › Boukmanflow › Borrowed Tapes');
    assert.equal(vm.dmJobPath(copyJob({ state: 'failed', error: 'Stage Peer C no longer has this file', result: null })), null);
    assert.equal(vm.dmJobPath(copyJob({ state: 'cancelled', result: { songs: { total: 3, copied: [], skipped: [], failed: [] }, stopped: 'cancelled' } })), null);
    assert.equal(vm.dmJobPath(copyJob({ state: 'done', result: { songs: { total: 1, copied: [], skipped: [], failed: [{}] }, stopped: 'refused' } })), null);
    assert.equal(vm.dmJobPath(null), null);
  });

  test('the saved place moved since a copy ran: dmDestMoved, and where Retry adds now — however the base was written, the same place is the same', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const ran = copyJob({ state: 'done', params: { scope: 'album', destination: COPIES }, result: { songs: { total: 3, copied: [{ filepath: 'copies/Boukmanflow/Borrowed Tapes/1.mp3' }], skipped: [], failed: [] }, stopped: 'quota', destination: { ...COPIES, base: '/' } } });
    vm.dmKeepChoose('album');
    vm.discover.modal.jobs = { 'federation-copy@album': ran };
    assert.deepEqual([vm.dmDestMoved(ran), vm.dmKeepView().retryPath], [false, null]);
    vm.discover.dest.view = viewOf(MUSIC_DEFAULT);
    assert.equal(vm.dmDestMoved(ran), true);
    const again = vm.dmKeepView().retryPath;
    assert.equal(`${again.prefix} ${pathLine(again.path)}${tEn('discover.modal.dest.savedNow')}`, 'Retry adds to music › Boukmanflow › Borrowed Tapes, your saved place now');
    assert.equal(vm.dmDestMoved(copyJob({ state: 'queued', params: { scope: 'album', destination: MUSIC_DEFAULT } })), false, 'a job with only its pin compares that');
    assert.equal(vm.dmDestMoved(copyJob({ state: 'done', params: { scope: 'album' }, result: null })), false, 'nothing known it ran with: nothing moved');
  });
});

// Found live 2026-10-22: under "From friends/{{ARTIST}}" an album copy of the
// compilation Night Market Sampler (Various Artists; songs by Color Out,
// Boukmanflow, ALM) promised "From friends › Boukmanflow" — the server files
// each song by its own tags, so they land in three folders. A variable each
// song files by its own tag is a slot wherever the window draws a path not
// yet landed, with one quiet note under it.
describe('where files land: a variable each song files by its own tags is a slot, not one folder (vp.js)', () => {
  const FRIENDS = { vpath: 'copies', base: '', layout: 'From friends/{{ARTIST}}', source: 'user' };
  const night = (over) => tapesRow(STAGE_B, '02 - Borrowed Light', { album: 'Night Market Sampler', albumArtist: 'Various Artists', year: 2020,
    filepath: 'peerlib/VA/Night Market Sampler/02 - Borrowed Light.mp3', ...over });
  // the peer's listing of the album, each song with its own tags
  const sampler = (artists, over) => artists.map((artist, i) => ({ filepath: `peerlib/VA/Night Market Sampler/0${i + 1}.mp3`,
    metadata: { title: `S${i}`, artist, 'artist-display': artist, year: 2020, duration: 200, genres: [], ...over } }));
  const nightReads = (songs, genres = []) => {
    const reads = shiftReads(['Harbour Lights']);
    reads.peer.albumSongs = () => Promise.resolve(songs);
    reads.peer.metadata = () => Promise.resolve({ metadata: { format: 'mp3', genres } });
    return reads;
  };
  const open = async ({ songs = sampler(['Color Out', 'Boukmanflow', 'ALM']), genres, layout = FRIENDS.layout, row = night(), focus = 'album' } = {}) => {
    const w = makeDestWindow({ reads: nightReads(songs, genres), server: { view: viewOf({ ...FRIENDS, layout }) } });
    await w.vm.openDiscoverModal(row, 'federation', { seedPlain: 'x', focus });
    return w;
  };
  const slotsOf = (p) => p.crumbs.flatMap((c) => (c.parts || []).filter((x) => x.slot).map((x) => x.text));
  const ARTIST_NOTE = '‹artist› comes from each song’s own tags, so these songs can land in more than one folder.';

  test('the bug: the album of a compilation draws "From friends › ‹artist›" and says why; the song its own folder, no note', async () => {
    const { vm } = await open();
    const album = vm.dmDestPath('album');
    assert.deepEqual([pathLine(album), album.crumbs[1].parts, album.slotNote, album.title],
      ['copies › From friends › ‹artist›', [{ text: '‹artist›', slot: true }], ARTIST_NOTE, 'copies/From friends/‹artist›']);
    const song = vm.dmDestPath('song');
    assert.deepEqual([pathLine(song), song.slotNote], ['copies › From friends › Boukmanflow', '']);
    // before the listing answers (or when it failed): a compilation is a slot already
    vm.discover.modal.album = { ...vm.discover.modal.album, songs: null };
    assert.equal(pathLine(vm.dmDestPath('album')), 'copies › From friends › ‹artist›');
  });

  test('an album of one artist: the artist while the listing agrees (or has not answered); a feature on it files apart — a slot', async () => {
    const own = await open({ row: night({ albumArtist: null }), songs: sampler(['Boukmanflow', 'Boukmanflow']) });
    assert.deepEqual([pathLine(own.vm.dmDestPath('album')), own.vm.dmDestPath('album').slotNote], ['copies › From friends › Boukmanflow', '']);
    own.vm.discover.modal.album = { ...own.vm.discover.modal.album, songs: null };
    assert.equal(pathLine(own.vm.dmDestPath('album')), 'copies › From friends › Boukmanflow', 'no listing yet: not a compilation, its own artist');
    const feat = await open({ row: night({ albumArtist: null }), songs: sampler(['Boukmanflow', 'Boukmanflow feat. ALM']) });
    assert.equal(pathLine(feat.vm.dmDestPath('album')), 'copies › From friends › ‹artist›');
    // the compilation whose songs are all one artist's lands in one folder
    const solo = await open({ songs: sampler(['Boukmanflow', 'Boukmanflow', 'Boukmanflow']) });
    assert.equal(pathLine(solo.vm.dmDestPath('album')), 'copies › From friends › Boukmanflow');
  });

  test('{{YEAR}} keeps its folder\'s text; {{GENRE}} adds "a song with none…"; two slots are listed together; the credit is never a slot', async () => {
    const years = await open({ songs: sampler(['Color Out', 'ALM']).map((s, i) => ({ ...s, metadata: { ...s.metadata, year: 2019 + i } })),
      layout: '{{ALBUMARTIST}}/{{ALBUM}} ({{YEAR}})' });
    const y = years.vm.dmDestPath('album');
    assert.deepEqual([pathLine(y), y.crumbs[1].parts.map((x) => [x.text, x.slot])],
      ['copies › Various Artists › Night Market Sampler (‹year›)', [['Night Market Sampler (', false], ['‹year›', true], [')', false]]]);
    assert.equal(y.slotNote, '‹year› comes from each song’s own tags, so these songs can land in more than one folder.');
    const both = await open({ layout: '{{GENRE}}/{{ARTIST}}' });
    const b = both.vm.dmDestPath('album');
    assert.deepEqual([pathLine(b), slotsOf(b)], ['copies › ‹genre› › ‹artist›', ['‹genre›', '‹artist›']]);
    assert.equal(b.slotNote, '‹genre›, ‹artist› come from each song’s own tags, so these songs can land in more than one folder (a song with none leaves that folder out).');
  });

  test('the song: {{GENRE}} its own when the peer\'s metadata names one, else a slot with the song\'s note', async () => {
    const known = await open({ focus: null, genres: ['Hip-Hop'], layout: '{{GENRE}}/{{ALBUM}}' });
    assert.deepEqual([pathLine(known.vm.dmDestPath('song')), known.vm.dmDestPath('song').slotNote], ['copies › Hip-Hop › Night Market Sampler', '']);
    const unknown = await open({ focus: null, layout: '{{GENRE}}/{{ALBUM}}' });
    const p = unknown.vm.dmDestPath('song');
    assert.deepEqual([pathLine(p), p.file, p.slotNote], ['copies › ‹genre› › Night Market Sampler', '02 - Borrowed Light.mp3',
      '‹genre› comes from the song’s own tags (a song with none leaves that folder out).']);
    assert.equal(pathLine(known.vm.dmDestPath('album')), 'copies › ‹genre› › Night Market Sampler', 'the song\'s genre is not the album\'s');
  });

  test('the artist scopes: the artist and "one folder per album", {{GENRE}} before the cut a slot', async () => {
    const { vm } = await open({ focus: null, genres: ['Hip-Hop'], layout: '{{GENRE}}/{{ARTIST}}/{{ALBUM}}' });
    const p = vm.dmDestPath('artist');
    assert.deepEqual([pathLine(p), p.title], ['copies › ‹genre› › Boukmanflow › one folder per album', 'copies/‹genre›/Boukmanflow']);
    assert.equal(p.slotNote, '‹genre› comes from each song’s own tags, so these songs can land in more than one folder (a song with none leaves that folder out).');
    vm.discover.dest.view = viewOf({ ...FRIENDS, layout: '{{ARTIST}}/{{ALBUM}}/{{GENRE}}' });
    assert.deepEqual([pathLine(vm.dmDestPath('artist')), vm.dmDestPath('artist').slotNote], ['copies › Boukmanflow › one folder per album', ''], 'cut with the album: nothing to say');
  });

  test('everywhere a path has not landed yet: Into (the pinned place), Retry adds to, the editor\'s preview — an ended copy\'s In is where its files are', async () => {
    const { vm } = await open();
    const job = (over) => copyJob({ recommendation: night(), ...over });
    const into = vm.dmJobPath(job({ state: 'running', params: { scope: 'album', destination: FRIENDS } }));
    assert.deepEqual([jobLine(into), into.path.slotNote], ['Into copies › From friends › ‹artist›', ARTIST_NOTE]);
    assert.equal(jobLine(vm.dmJobPath(job({ state: 'queued', params: { scope: 'album', destination: COPIES } }))), 'Into copies › Various Artists › Night Market Sampler', 'pinned elsewhere: that layout');
    // a copy that ran with the album credit's layout; the saved place is From friends now
    const ran = job({ state: 'done', params: { scope: 'album', destination: COPIES },
      result: { songs: { total: 3, copied: [{ filepath: 'copies/Various Artists/Night Market Sampler/1.mp3' }], skipped: [], failed: [] }, stopped: 'quota', destination: COPIES } });
    vm.dmKeepChoose('album');
    vm.discover.modal.jobs = { 'federation-copy@album': ran };
    const v = vm.dmKeepView();
    assert.deepEqual([jobLine(v.path), v.path.path.slotNote], ['In copies › Various Artists › Night Market Sampler', undefined], 'landed: real folders, no slot');
    assert.deepEqual([`${v.retryPath.prefix} ${pathLine(v.retryPath.path)}`, v.retryPath.path.slotNote], ['Retry adds to copies › From friends › ‹artist›', ARTIST_NOTE]);
    vm.dmOpenPicker();
    vm.discover.modal.picker.text = 'From friends/{{ARTIST}} ({{YEAR}})';
    const preview = vm.dmPickerPreview('album');
    assert.deepEqual([pathLine(preview), preview.missingVars, preview.slotNote], ['copies › From friends › ‹artist› (2020)', [], ARTIST_NOTE]);
    assert.equal(pathLine(vm.dmPickerPreview('song')), 'copies › From friends › Boukmanflow (2020)', 'the song alone: its own folder');
  });

  // the 2026-10-22 review
  test('a genre tag the library split (two genres listed) is no one folder; an album whose songs each name the same one genre draws it', async () => {
    const split = await open({ focus: null, genres: ['Hip-Hop', 'Rap'], layout: '{{GENRE}}/{{ALBUM}}' });
    assert.deepEqual([pathLine(split.vm.dmDestPath('song')), split.vm.dmLayoutTags().genre], ['copies › ‹genre› › Night Market Sampler', null], '"Hip-Hop/Rap" lands in Hip-Hop-Rap');
    const each = await open({ songs: sampler(['Color Out', 'ALM'], { genres: ['Hip-Hop', 'Rap'] }), layout: '{{GENRE}}/{{ALBUM}}' });
    assert.equal(pathLine(each.vm.dmDestPath('album')), 'copies › ‹genre› › Night Market Sampler');
    const one = await open({ songs: sampler(['Color Out', 'ALM'], { genres: ['Hip-Hop'] }), layout: '{{GENRE}}/{{ALBUM}}' });
    assert.deepEqual([pathLine(one.vm.dmDestPath('album')), one.vm.dmDestPath('album').slotNote], ['copies › Hip-Hop › Night Market Sampler', ''], 'the listing names each song\'s genres');
  });

  test('the album\'s {{ALBUMARTIST}} is its credit — not a featured seed\'s own artist; a listed song with no artist tag files under the credit', async () => {
    const reads = nightReads(sampler(['Boukmanflow', 'Boukmanflow']));
    reads.peer.metadata = () => Promise.resolve({ metadata: { format: 'mp3', artist: 'Boukmanflow', 'artist-display': 'Boukmanflow feat. ALM', genres: [] } });
    const w = makeDestWindow({ reads, server: { view: viewOf(COPIES) } });
    await w.vm.openDiscoverModal(night({ albumArtist: null }), 'federation', { seedPlain: 'x', focus: 'album' });
    assert.equal(pathLine(w.vm.dmDestPath('album')), 'copies › Boukmanflow › Night Market Sampler');
    assert.equal(pathLine(w.vm.dmDestPath('song')), 'copies › Boukmanflow feat. ALM › Night Market Sampler', 'the song alone: its own tags');
    const untagged = { filepath: 'peerlib/Boukmanflow/Night Market Sampler/09.mp3', metadata: { title: 'untagged', year: 2020, duration: 200, genres: [] } };
    const own = await open({ row: night({ albumArtist: null }), songs: [...sampler(['Boukmanflow']), untagged] });
    assert.deepEqual([pathLine(own.vm.dmDestPath('album')), own.vm.dmDestPath('album').slotNote], ['copies › From friends › Boukmanflow', '']);
  });

  test('one note on a card: an In line drawn from the place an older server\'s copy ran with says its slots with the Retry line\'s, under the last path', async () => {
    const { vm } = await open({ layout: '{{GENRE}}/{{ARTIST}}' });
    // counts alone (an older server): the In line is the destination it ran with
    const ran = copyJob({ recommendation: night(), state: 'done', params: { scope: 'album', destination: FRIENDS },
      result: { counts: { total: 3, copied: 2, skipped: 0, failed: 1 }, destination: FRIENDS } });
    vm.dmKeepChoose('album');
    vm.discover.modal.jobs = { 'federation-copy@album': ran };
    const v = vm.dmKeepView();
    assert.deepEqual([jobLine(v.path), v.path.path.slotNote], ['In copies › From friends › ‹artist›', '']);
    assert.deepEqual([`${v.retryPath.prefix} ${pathLine(v.retryPath.path)}`, v.retryPath.path.slotNote], ['Retry adds to copies › ‹genre› › ‹artist›',
      '‹artist›, ‹genre› come from each song’s own tags, so these songs can land in more than one folder (a song with none leaves that folder out).']);
    assert.equal(vm.dmSlotNote('album', []), '');
  });
});

// Asked for 2026-10-22 ("copy the server's filepath"): {{SERVERFOLDER}}, the
// folders a song sits in on its server — a preset in the editor, and the
// same per-song slot rule: the song its own folder, the album the one every
// listed song shares (else ‹server folder›), the artist scopes cut there.
describe('where files land: {{SERVERFOLDER}}, the folders a song sits in on its server (vp.js)', () => {
  const SAME = { vpath: 'copies', base: '', layout: '{{SERVERFOLDER}}', source: 'user' };
  const VARS = ['ARTIST', 'ALBUM', 'YEAR', 'GENRE', 'ALBUMARTIST', 'PEER', 'SERVERFOLDER'];
  const night = (over) => tapesRow(STAGE_B, '02 - Borrowed Light', { album: 'Night Market Sampler', albumArtist: 'Various Artists', year: 2020,
    filepath: 'peerlib/VA/Night Market Sampler/02 - Borrowed Light.mp3', ...over });
  // the peer's listing of the album: each song where it sits there
  const listing = (folders, artists = []) => folders.map((f, i) => ({ filepath: `peerlib/${f}/0${i + 1}.mp3`,
    metadata: { title: `S${i}`, artist: artists[i] || 'Color Out', year: 2020, duration: 200, genres: [] } }));
  const open = async ({ songs = listing(['VA/Night Market Sampler', 'VA/Night Market Sampler']), layout = SAME.layout, row = night(), focus = 'album', local = ['Harbour Lights'] } = {}) => {
    const reads = shiftReads(local);
    reads.peer.albumSongs = () => Promise.resolve(songs);
    const view = { ...viewOf({ ...SAME, layout }), variables: VARS };
    const w = makeDestWindow({ reads, server: { view } });
    await w.vm.openDiscoverModal(row, 'federation', { seedPlain: 'x', focus });
    return w;
  };
  const SERVER_NOTE = '‹server folder› comes from where each song sits on the server, so these songs can land in more than one folder.';

  test('the song: where it sits on its server, its library\'s name dropped; at the root its folder drops out', async () => {
    const { vm } = await open();
    const song = vm.dmDestPath('song');
    assert.deepEqual([pathLine(song), song.file, song.slotNote], ['copies › VA › Night Market Sampler', '02 - Borrowed Light.mp3', '']);
    assert.equal(vm.dmLayoutTags().serverfolder, 'VA/Night Market Sampler');
    vm.discover.dest.view = { ...vm.discover.dest.view, destination: { ...SAME, layout: 'From friends/Copy of {{SERVERFOLDER}}' } };
    assert.equal(pathLine(vm.dmDestPath('song')), 'copies › From friends › Copy of VA › Night Market Sampler', 'the literal joins the first folder');
    const root = await open({ row: night({ filepath: 'peerlib/02 - Borrowed Light.mp3' }), layout: 'From friends/{{SERVERFOLDER}}' });
    assert.deepEqual([pathLine(root.vm.dmDestPath('song')), root.vm.dmDestPath('song').missingVars], ['copies › From friends', ['SERVERFOLDER']]);
    // a row that is not a connected server's (Get it) has no folder there
    vm.discover.modal.source = 'p2p';
    assert.equal(vm.dmLayoutTags().serverfolder, null);
  });

  test('the album: the folder every listed song shares; songs in more than one draw ‹server folder› and say why; before the listing, the row\'s', async () => {
    const { vm } = await open();
    assert.deepEqual([pathLine(vm.dmDestPath('album')), vm.dmDestPath('album').slotNote], ['copies › VA › Night Market Sampler', '']);
    const discs = await open({ songs: listing(['VA/Night Market Sampler/CD1', 'VA/Night Market Sampler/CD2']) });
    const p = discs.vm.dmDestPath('album');
    assert.deepEqual([pathLine(p), p.crumbs[0].parts, p.slotNote, p.title],
      ['copies › ‹server folder›', [{ text: '‹server folder›', slot: true }], SERVER_NOTE, 'copies/‹server folder›']);
    discs.vm.discover.modal.album = { ...discs.vm.discover.modal.album, songs: null };
    assert.equal(pathLine(discs.vm.dmDestPath('album')), 'copies › VA › Night Market Sampler', 'no listing yet: the row\'s folder');
    // with a tag slot: one note, the tags' words first
    const both = await open({ songs: listing(['VA/CD1', 'VA/CD2'], ['Color Out', 'ALM']), layout: 'From friends/{{ARTIST}}/{{SERVERFOLDER}}' });
    const b = both.vm.dmDestPath('album');
    assert.deepEqual([pathLine(b), b.slotNote], ['copies › From friends › ‹artist› › ‹server folder›',
      '‹artist› comes from each song’s own tags and ‹server folder› from where it sits on the server, so these songs can land in more than one folder.']);
    assert.equal(both.vm.dmSlotNote('album', ['GENRE', 'SERVERFOLDER', 'YEAR']),
      '‹genre›, ‹year› come from each song’s own tags and ‹server folder› from where it sits on the server, so these songs can land in more than one folder (a song with none leaves that folder out).');
    assert.equal(both.vm.dmSlotNote('song', ['GENRE']), '‹genre› comes from the song’s own tags (a song with none leaves that folder out).', 'a song\'s own words, as before');
  });

  test('the artist scopes: the folder naming {{SERVERFOLDER}} and all after it are "one folder per album"; the one missing album its slot', async () => {
    const { vm } = await open({ focus: null, row: night({ albumArtist: null }), layout: 'From friends/{{SERVERFOLDER}}', local: ['Harbour Lights', 'Borrowed Tapes'] });
    assert.deepEqual([pathLine(vm.dmDestPath('artist')), vm.dmDestPath('artist').slotNote], ['copies › From friends › one folder per album', '']);
    assert.equal(vm.dmMissingAlbum().name, 'Second Shift');
    const one = vm.dmDestPath('artist-missing');
    assert.deepEqual([pathLine(one), one.slotNote], ['copies › From friends › ‹server folder›', SERVER_NOTE]);
  });

  test('Into, Retry adds to and the preview follow the same rule', async () => {
    const { vm } = await open({ songs: listing(['VA/CD1', 'VA/CD2']) });
    const into = vm.dmJobPath(copyJob({ recommendation: night(), state: 'running', params: { scope: 'album', destination: SAME } }));
    assert.deepEqual([jobLine(into), into.path.slotNote], ['Into copies › ‹server folder›', SERVER_NOTE]);
    vm.dmOpenPicker();
    vm.dmPickerChooseCustom();
    vm.discover.modal.picker.text = 'Copy of {{SERVERFOLDER}}/{{ALBUM}}';
    assert.deepEqual([pathLine(vm.dmPickerPreview('album')), pathLine(vm.dmPickerPreview('song'))],
      ['copies › Copy of ‹server folder› › Night Market Sampler', 'copies › Copy of VA › Night Market Sampler › Night Market Sampler']);
  });

  test('the editor: "Same folders as the server" is a layout of its own, offered where the server lists the variable; the variable is named for a screen reader', async () => {
    const { vm } = await open({ layout: '{{ALBUMARTIST}}/{{ALBUM}}' });
    vm.dmOpenPicker();
    assert.ok(vm.dmPickerPresets().some((p) => p.layout === '{{SERVERFOLDER}}'));
    vm.dmPickerChoose('{{SERVERFOLDER}}');
    assert.deepEqual([vm.dmPickerLayout(), vm.discover.modal.picker.custom, vm.dmPickerCanSave()], ['{{SERVERFOLDER}}', false, true]);
    assert.deepEqual([vm.dmPickerPreview('song').valid, pathLine(vm.dmPickerPreview('song'))], [true, 'copies › VA › Night Market Sampler']);
    assert.equal(vm.dmPickerVarLabel('SERVERFOLDER'), 'Insert server folder, SERVERFOLDER', 'what the button shows, for Voice Control');
    vm.discover.dest.view = { ...vm.discover.dest.view, variables: VARS.slice(0, -1) };
    assert.ok(!vm.dmPickerPresets().some((p) => p.layout === '{{SERVERFOLDER}}'), 'an older server would refuse it');
    vm.discover.modal.picker = null;
    vm.dmPickerChoose('{{SERVERFOLDER}}');
    assert.equal(vm.discover.modal.picker, null, 'nothing open, nothing set');
  });

  // Review 2026-10-22: Get it's own bar shows on a connected server's row
  // when the copy's gate fails, and drew that row's server and folder —
  // but a download comes from no server (youtube.js renders neither).
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const DEST_SRC = VP_SRC.slice(VP_SRC.indexOf('Vue.component(\'dm-dest\''), VP_SRC.indexOf('Vue.component(\'dm-keep-body\''));
  const fromOf = (download) => {
    const src = /\n {6}from: (function \(\) \{ [^\n]*? \}),\n/.exec(DEST_SRC);
    assert.ok(src, 'dm-dest no longer computes `from` — update this test');
    return new Function(`return ${src[1]};`)().call({ download });
  };
  const YT = { name: 'youtube', title: 'YouTube', capabilities: ['acquire'], scopes: ['song'] };

  test('Get it\'s bar draws a download, from no server: {{PEER}} and {{SERVERFOLDER}} drop out of it — on a connected server\'s row too', async () => {
    const { vm } = await open({ focus: null, layout: 'From/{{PEER}}/{{SERVERFOLDER}}' });
    vm.discover.plugins.list = [YT];
    assert.deepEqual([vm.dmKeepChoices(), vm.dmGetItBar()], [[], true], 'the copy\'s gate failed: Get it takes Keep\'s place, its bar too');
    assert.match(HTML, /<dm-dest v-if="dmGetItBar\(\)" scope="song" download><\/dm-dest>/);
    assert.match(DEST_SRC, /path: function \(\) \{ return this\.\$root\.dmDestPath\(this\.shown, null, this\.from\); \}/);
    assert.match(DEST_SRC, /preview: function \(\) \{ return this\.\$root\.dmPickerPreview\(this\.shown, this\.from\); \}/);
    const from = fromOf(true);
    assert.deepEqual([from, fromOf(false)], [{ peer: null, filepath: null }, null], 'Keep\'s bar: this row\'s server');
    const bar = vm.dmDestPath('song', null, from);
    assert.deepEqual([pathLine(bar), bar.missingVars, bar.slotNote], ['copies › From', ['PEER', 'SERVERFOLDER'], '']);
    assert.equal(pathLine(vm.dmDestPath('song')), 'copies › From › Stage Peer B › VA › Night Market Sampler', 'a copy from this row\'s server names both');
    vm.dmOpenPicker();
    assert.equal(pathLine(vm.dmPickerPreview('song', from)), 'copies › From', 'the editor\'s preview the same');
  });

  test('another server\'s copy shown here draws {{SERVERFOLDER}} from its own song there: a song its folder and file, an album its slot', async () => {
    const D = { ...SAME, layout: '{{PEER}}/{{SERVERFOLDER}}' };
    const { vm } = await open({ focus: null, layout: D.layout });
    const theirs = tapesRow(STAGE_C, '02 - Late Train Verse', { filepath: 'otherlib/Mixes/2019/02 - Late Train Verse.mp3' });
    const song = vm.dmJobPath(copyJob({ recommendation: theirs, state: 'running', params: { destination: D } }));
    assert.deepEqual([jobLine(song), song.path.file, song.path.slotNote], ['Into copies › Stage Peer C › Mixes › 2019', '02 - Late Train Verse.mp3', '']);
    const ran = copyJob({ recommendation: theirs, state: 'done', params: { destination: D }, result: { counts: { total: 1, copied: 1, skipped: 0, failed: 0 }, destination: D } });
    assert.equal(jobLine(vm.dmJobPath(ran)), 'In copies › Stage Peer C › Mixes › 2019', 'the In line from the place it ran with, its result naming no file');
    const album = vm.dmJobPath(copyJob({ recommendation: theirs, state: 'running', params: { scope: 'album', destination: D } }));
    assert.deepEqual([jobLine(album), album.path.slotNote], ['Into copies › Stage Peer C › ‹server folder›', SERVER_NOTE], 'this window lists only this server\'s songs');
    assert.equal(jobLine(vm.dmJobPath(copyJob({ recommendation: theirs, state: 'running', params: { scope: 'artist', destination: D } }))),
      'Into copies › Stage Peer C › one folder per album');
    // this server's own copies: the row's folder, the album's listing
    const mine = vm.dmJobPath(copyJob({ recommendation: night(), state: 'running', params: { destination: D } }));
    assert.deepEqual([jobLine(mine), mine.path.file], ['Into copies › Stage Peer B › VA › Night Market Sampler', '02 - Borrowed Light.mp3']);
    assert.equal(jobLine(vm.dmJobPath(copyJob({ recommendation: night(), state: 'running', params: { scope: 'album', destination: D } }))),
      'Into copies › Stage Peer B › VA › Night Market Sampler');
  });

  test('the editor\'s preview note for a variable with no value: the server\'s variables say why, not the tags\' words', async () => {
    const { vm } = await open({ focus: null, row: night({ filepath: 'peerlib/02 - Borrowed Light.mp3', year: null }), layout: 'From friends/{{SERVERFOLDER}}' });
    assert.match(DEST_SRC, /<dm-dest-path :path="preview" variant="preview"><\/dm-dest-path>\s*<div v-if="preview\.missingVars\.length" class="dm-dest-slots">\{\{ \$root\.dmPickerMissing\(preview, from\) \}\}<\/div>/);
    vm.dmOpenPicker();
    const hint = (from) => vm.dmPickerMissing(vm.dmPickerPreview('song', from), from);
    // the phone's form: why, "so left out of the path:", then each variable in its braces
    assert.equal(hint(null), 'The song sits at the top of its server’s library, so left out of the path: {{SERVERFOLDER}}');
    const download = fromOf(true);
    assert.equal(hint(download), 'A download comes from no connected server, so left out of the path: {{SERVERFOLDER}}');
    vm.discover.modal.picker.text = '{{PEER}}/{{SERVERFOLDER}}';
    assert.equal(hint(download), 'A download comes from no connected server, so left out of the path: {{PEER}}, {{SERVERFOLDER}}');
    vm.discover.modal.picker.text = '{{YEAR}}/{{SERVERFOLDER}}';
    assert.equal(hint(null), 'No value for this song, so left out of the path: {{YEAR}}, {{SERVERFOLDER}}', 'a tag too: the phone\'s words');
    assert.equal(hint(download), 'No value for this song, so left out of the path: {{YEAR}}, {{SERVERFOLDER}}');
  });
});

describe('where files land: read again on every open, sent with every start (vp.js)', () => {
  test('every open reads the destination again; the last one known is drawn until the answer comes; a failed read keeps it', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.deepEqual([w.calls.destination, w.vm.discover.modal.destRead], [1, true]);
    // another tab saved "music" meanwhile; this answer is held back
    w.server.view = viewOf({ vpath: 'music', base: '', layout: LAYOUT, source: 'user' });
    let release = null;
    w.api.discoveryDestination = () => { w.calls.destination += 1; return new Promise((resolve) => { release = () => resolve(w.server.view); }); };
    const opening = w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    await flush();
    assert.equal(w.vm.discover.dest.view.destination.vpath, 'copies', 'the last one known, drawn at once — no spinner');
    assert.equal(w.vm.discover.modal.destRead, false);
    release();
    await opening;
    assert.deepEqual([w.calls.destination, w.vm.discover.dest.view.destination.vpath, w.vm.discover.modal.destRead], [2, 'music', true]);
    w.api.discoveryDestination = async () => { throw new Error('offline'); };
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.equal(w.vm.discover.dest.view.destination.vpath, 'music', 'a failed read keeps what is drawn');
  });

  test('none at open is only absent; none after the window had one is a right lost while it was open', async () => {
    const w = makeDestWindow({ server: { view: viewOf(null) } });
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.deepEqual([w.vm.dmHasDestination(), w.vm.discover.modal.destLost], [false, false]);
    w.server.view = viewOf(COPIES);
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.equal(w.vm.discover.modal.destLost, false);
    w.server.view = viewOf(null);
    await w.vm.dmLoadDestination(w.vm.discover.modal.gen);
    assert.deepEqual([w.vm.dmHasDestination(), w.vm.discover.modal.destLost], [false, true]);
  });

  test('a start sends the destination the window shows — its place, not its source — and the job is the window\'s', async () => {
    const w = makeDestWindow({ server: { view: viewOf({ ...COPIES, base: 'from-peers' }) } });
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    await w.vm.dmJobStart(COPY, null, 'album');
    assert.deepEqual(w.calls.starts, [{ name: 'federation-copy', scope: 'album', destination: { vpath: 'copies', base: 'from-peers', layout: LAYOUT } }]);
    assert.equal(w.vm.discover.modal.jobs['federation-copy@album'].id, 7);
    assert.equal(w.vm.discover.modal.jobBusy['federation-copy@album'], false);
  });

  test('409 destination_changed: nothing started; the bar redraws from the answer at once, the view is read again, and the window says so — the next start sends the new place', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const reads = w.calls.destination;
    const music = { vpath: 'music', base: '', layout: LAYOUT, source: 'user' };
    const start = w.api.discoveryJobStart;
    w.api.discoveryJobStart = async () => { throw httpError(409, { error: 'destination_changed', message: 'your collection destination has changed', destination: music }); };
    w.server.view = viewOf(music);
    await w.vm.dmJobStart(COPY, null, 'album');
    const m = w.vm.discover.modal;
    assert.equal(m.jobs['federation-copy@album'], undefined, 'nothing started');
    assert.equal(m.jobErrors['federation-copy@album'], 'Where files land changed since this window opened. Check the path above and add again.');
    assert.deepEqual(m.jobRefusals['federation-copy@album'], { status: 409, error: 'destination_changed' });
    assert.equal(w.vm.discover.dest.view.destination.vpath, 'music', 'redrawn from the answer, before the read');
    await flush();
    assert.equal(w.calls.destination, reads + 1, 'and read again');
    w.api.discoveryJobStart = start;
    await w.vm.dmJobStart(COPY, null, 'album');
    assert.deepEqual(w.calls.starts.pop().destination, { vpath: 'music', base: '', layout: LAYOUT });
    assert.deepEqual([m.jobErrors['federation-copy@album'], m.jobRefusals['federation-copy@album']], [undefined, undefined]);
  });

  test('every other refusal keeps the server\'s words and its status, and reads nothing again; a destination gone with the refusal is a right lost', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const reads = w.calls.destination;
    const m = w.vm.discover.modal;
    const refuse = async (err) => { w.api.discoveryJobStart = async () => { throw err; }; await w.vm.dmJobStart(COPY); };
    await refuse(httpError(409, { error: 'someone else on this server is already getting this — try again in a moment' }));
    assert.deepEqual([m.jobErrors['federation-copy'], m.jobRefusals['federation-copy']],
      ['someone else on this server is already getting this — try again in a moment', { status: 409, error: 'someone else on this server is already getting this — try again in a moment' }]);
    await refuse(httpError(429, { error: 'you have 20 jobs queued or running — wait for some to finish (the limit is 20)' }));
    assert.equal(m.jobRefusals['federation-copy'].status, 429);
    await refuse(new TypeError('Failed to fetch'));
    assert.deepEqual([m.jobErrors['federation-copy'], m.jobRefusals['federation-copy']], ['The server did not take that — try again', { status: 0, error: '' }]);
    assert.equal(w.calls.destination, reads, 'no read again for these');
    w.server.view = viewOf(null);
    await refuse(httpError(409, { error: 'destination_changed', destination: null }));
    await flush();
    assert.deepEqual([w.vm.dmHasDestination(), m.destLost], [false, true]);
  });
});

// The editor is the phone's destination sheet (2026-10-23, "I really like
// the phone UI for choosing the copy file path"): where this item lands,
// the library chips, the layouts as radios — Artist / Album, Server /
// Artist / Album, Same folders as the server, the library's own, Custom —
// no base folder field (a saved one folds into Custom), Use the library
// default and Save.
describe('where files land: the editor (vp.js)', () => {
  const opened = async (over) => {
    const w = makeDestWindow(over);
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    w.vm.dmOpenPicker();
    return { ...w, k: w.vm.discover.modal.picker };
  };

  test('Change… opens on the saved place and reads it again; "Use the library default" only refills it; Save then goes back to the default, says where, and the keyboard returns to Change…', async () => {
    const w = makeDestWindow();
    const { vm } = w;
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const reads = w.calls.destination;
    vm.dmOpenPicker();
    const k = vm.discover.modal.picker;
    assert.deepEqual([k.vpath, k.layout, k.custom, k.text, k.reset, vm.dmDestEditing()], ['copies', LAYOUT, false, '', false, true], 'the Artist / Album preset, Custom\'s field empty');
    assert.equal(w.calls.destination, reads + 1, 'read again: another tab or device may have saved one');
    await flush();
    assert.deepEqual([vm.dmPickerCanSave(), vm.dmPickerIsDefault()], [false, false], 'nothing changed; copies is not the library default — music is');
    vm.dmPickerUseDefault();
    assert.deepEqual([k.vpath, k.layout, k.custom, vm.dmPickerIsDefault(), vm.dmPickerCanSave()], ['music', LAYOUT, false, true, true]);
    assert.deepEqual(w.calls.saves, [], 'nothing saved until Save');
    w.tick();
    assert.equal(w.focused(), 'library', 'the button went with the difference: the keyboard on the chosen library');
    const saving = vm.dmPickerSubmit();
    assert.deepEqual([k.saving, vm.dmPickerCanSave()], [true, false], 'Saving…: Save off while it is out');
    await saving;
    assert.deepEqual(w.calls.saves, [null], 'the library default itself: the account follows it from now on');
    assert.deepEqual([vm.discover.modal.picker, vm.dmDestEditing(), vm.discover.dest.view.destination.source], [null, false, 'default']);
    assert.deepEqual(w.toasts.map((x) => [x.kind, x.title]), [['success', 'Saved · copies land in music']]);
    w.tick();
    assert.equal(w.focused(), 'change');
  });

  test('the layouts in the phone\'s order — Artist / Album, Server / Artist / Album, Same folders as the server, the library\'s own — then Custom; a chip per library', async () => {
    const view = { ...viewOf({ ...COPIES, layout: 'Rips/{{ARTIST}}' }), variables: [...J.LAYOUT_VARS],
      libraries: [{ vpath: 'music', template: null }, { vpath: 'copies', template: 'Rips/{{ARTIST}}' }] };
    const { vm, k } = await opened({ server: { view } });
    const offered = (vpath) => vm.dmPickerPresets(vpath).map((p) => `${tEn(p.key)} ${p.layout}`);
    assert.deepEqual(offered(), ['Artist / Album {{ALBUMARTIST}}/{{ALBUM}}', 'Server / Artist / Album {{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}',
      'Same folders as the server {{SERVERFOLDER}}', 'Library layout Rips/{{ARTIST}}']);
    assert.deepEqual([k.custom, k.layout], [false, 'Rips/{{ARTIST}}'], 'the library\'s own layout opens as its preset');
    assert.deepEqual(offered('music'), offered().slice(0, 3), 'a library with no template of its own');
    // the server's own default leads, never twice; one without {{SERVERFOLDER}} has no Same folders
    vm.discover.dest.view = { ...view, defaultLayout: J.PEER_LAYOUT, variables: view.variables.filter((v) => v !== 'SERVERFOLDER') };
    assert.deepEqual(offered('music'), ['Artist / Album {{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}']);
    assert.deepEqual(vm.dmPickerChips(), ['music', 'copies']);
    k.vpath = 'gone';
    assert.deepEqual(vm.dmPickerChips(), ['music', 'copies', 'gone'], 'the chosen one, when the server no longer lists it');
  });

  test('Custom: its field empty and Save off, the preview asks for a path; typed, the preview follows and Save sends the layout with no base folder', async () => {
    const { vm, k, calls, toasts } = await opened();
    vm.dmPickerChooseCustom();
    assert.deepEqual([k.custom, k.text, vm.dmPickerCanSave(), vm.dmPickerCustomProblem()], [true, '', false, '']);
    assert.deepEqual(vm.dmPickerUnseen(vm.dmPickerPreview('song')), { text: 'Type a path to see where files land', warn: false });
    k.text = 'From friends/{{ARTIST}}';
    const p = vm.dmPickerPreview('song');
    assert.equal(vm.dmPickerUnseen(p), null);
    assert.deepEqual([vm.dmPickerLandsAt('song'), pathLine(p), p.file], ['02 - Late Train Verse lands at', 'copies › From friends › Boukmanflow', '02 - Late Train Verse.mp3']);
    assert.equal(vm.dmPickerCanSave(), true);
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [{ vpath: 'copies', base: '', layout: 'From friends/{{ARTIST}}' }]);
    assert.equal(pathLine(vm.dmDestPath('song')), 'copies › From friends › Boukmanflow', 'the bar shows the new path');
    assert.equal(toasts.pop().title, 'Saved · copies land in copies › From friends', 'where every copy lands, whatever its tags');
  });

  test('a variable button drops {{NAME}} at the caret, over the selection, the caret after it — at the end without a field; off with no room left; named "Insert …"', async () => {
    const w = await opened();
    const { vm, k } = w;
    vm.dmPickerChooseCustom();
    k.text = 'From friends/';
    const field = { selectionStart: 5, selectionEnd: 12, focus() { this.focused = true; }, setSelectionRange(a, b) { this.caret = [a, b]; } };
    vm.dmInsertVar('ARTIST', field);
    assert.equal(k.text, 'From {{ARTIST}}/');
    w.tick();
    assert.deepEqual([field.focused, field.caret], [true, [15, 15]]);
    vm.dmInsertVar('ALBUM', null);
    assert.equal(k.text, 'From {{ARTIST}}/{{ALBUM}}');
    k.text = 'x'.repeat(490);
    assert.deepEqual([vm.dmPickerVarFits('YEAR'), vm.dmPickerVarFits('ALBUMARTIST')], [true, false], 'the server\'s 500 characters');
    vm.dmInsertVar('ALBUMARTIST', null);
    assert.equal(k.text.length, 490, 'no room: nothing inserted');
    assert.deepEqual(vm.dmPickerVars().map((v) => vm.dmPickerVarLabel(v)), ['Insert artist', 'Insert album', 'Insert year', 'Insert genre',
      'Insert album artist, ALBUMARTIST', 'Insert server name, PEER'], 'what a button shows is in its name where the words do not say it');
    assert.equal(vm.dmPickerVarLabel('MOOD'), 'Insert MOOD');
  });

  test('an invalid Custom layout: the validator\'s words in the warning tone, the preview asks to fix it, Save off', async () => {
    const { vm, k } = await opened();
    vm.dmPickerChooseCustom();
    const said = (text) => { k.text = text; return [vm.dmPickerCustomProblem(), vm.dmPickerCanSave()]; };
    assert.deepEqual(said('{{ARTST}}/{{ALBUM}}'), ['Unknown variable {{ARTST}}. Use ARTIST, ALBUM, YEAR, GENRE, ALBUMARTIST, PEER.', false]);
    assert.deepEqual(said('{{ artst }}/{{ALBUM}}'), ['Unknown variable {{ artst }}. Use ARTIST, ALBUM, YEAR, GENRE, ALBUMARTIST, PEER.', false], 'named as it was typed');
    assert.deepEqual(vm.dmPickerUnseen(vm.dmPickerPreview('song')), { text: 'Fix the layout to see where files land', warn: true });
    assert.deepEqual(said('{{ARTIST}'), ['A brace is out of place — variables are written like {{ARTIST}}.', false]);
    assert.deepEqual(said('/{{ARTIST}}'), ['A layout can’t start with / — it begins inside the library.', false]);
    assert.deepEqual(said('{{ARTIST}}/../x'), ['A path can’t contain .. folders.', false]);
    assert.deepEqual(said(' / '), ['That makes no folder — add a name or a variable.', false]);
    assert.deepEqual(said('~/{{ARTIST}}'), ['A path can’t contain ~ or $HOME.', false]);
    assert.deepEqual(said('{{ARTIST}}/D:stuff'), ['A path can’t use a drive letter like C:.', false]);
    assert.deepEqual(said('x'.repeat(501)), ['A layout can be at most 500 characters.', false]);
    assert.deepEqual(said('a\u0001b'), ['A path can’t contain tabs or other control characters.', false]);
    assert.deepEqual(said('From friends'), ['', true], 'a plain name: every copy in that folder');
  });

  test('a place saved with a base folder (the terminal keeps one) opens folded into Custom, drawn where the server files it, Save off until it is edited; Save sends no base folder', async () => {
    const { vm, k, calls } = await opened({ server: { view: viewOf({ ...COPIES, base: ' from-peers/ ', layout: '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}' }) } });
    assert.deepEqual([k.custom, k.text, vm.dmPickerCanSave(), vm.dmPickerCustomProblem()], [true, 'from-peers/{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}', false, ''],
      'never the Server preset, though the layout alone reads as one');
    assert.equal(pathLine(vm.dmPickerPreview('song')), 'copies › from-peers › Stage Peer B › Boukmanflow › Borrowed Tapes');
    assert.equal(pathLine(vm.dmPickerPreview('song')), pathLine(vm.dmDestPath('song')), 'as the bar draws it');
    vm.dmPickerChoose(J.PEER_LAYOUT);
    assert.equal(vm.dmPickerCanSave(), true, 'a preset chosen over it leaves the folder behind');
    vm.dmPickerChooseCustom();
    assert.equal(vm.dmPickerCanSave(), false, 'back as it opened');
    k.text = 'from-peers/{{PEER}}/{{ALBUM}}';
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [{ vpath: 'copies', base: '', layout: 'from-peers/{{PEER}}/{{ALBUM}}' }]);
  });

  test('a saved base folder whose name a layout reads as a variable: drawn as the server holds it, named under the field, Save waits until it is renamed or a preset is chosen', async () => {
    const { vm, k, calls } = await opened({ server: { view: viewOf({ ...COPIES, base: '{{PEER}}', layout: LAYOUT }) } });
    assert.deepEqual([k.custom, k.text], [true, '{{PEER}}/{{ALBUMARTIST}}/{{ALBUM}}']);
    assert.equal(vm.dmPickerCustomProblem(), '“{{PEER}}” is a folder set on another device, but in a layout it reads as a variable. Rename it here, or choose a layout.');
    assert.equal(pathLine(vm.dmPickerPreview('song')), 'copies › {{PEER}} › Boukmanflow › Borrowed Tapes', 'the folder, not the server\'s name');
    assert.equal(vm.dmPickerCanSave(), false);
    vm.dmPickerChoose(LAYOUT);
    assert.equal(vm.dmPickerCanSave(), true, 'the same layout, without that folder: an edit');
    vm.dmPickerChooseCustom();
    k.text = 'From peers/{{ALBUMARTIST}}/{{ALBUM}}';
    assert.deepEqual([vm.dmPickerCustomProblem(), vm.dmPickerCanSave()], ['', true]);
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [{ vpath: 'copies', base: '', layout: 'From peers/{{ALBUMARTIST}}/{{ALBUM}}' }]);
  });

  test('a preset chosen after typing keeps what Custom\'s field holds; Custom again finds it', async () => {
    const { vm, k } = await opened();
    vm.dmPickerChooseCustom();
    k.text = 'From friends/{{ARTIST}}';
    vm.dmPickerChoose(J.PEER_LAYOUT);
    assert.deepEqual([k.custom, vm.dmPickerLayout(), k.text], [false, J.PEER_LAYOUT, 'From friends/{{ARTIST}}']);
    assert.equal(pathLine(vm.dmPickerPreview('song')), 'copies › Stage Peer B › Boukmanflow › Borrowed Tapes');
    vm.dmPickerChooseCustom();
    assert.equal(vm.dmPickerLayout(), 'From friends/{{ARTIST}}');
  });

  test('a library chip: a library\'s own layout leaves with it into Custom\'s field; back with it untouched, its preset again and Custom\'s field as it was', async () => {
    const view = { ...viewOf({ ...COPIES, layout: 'Rips/{{ARTIST}}' }), libraries: [{ vpath: 'music', template: null }, { vpath: 'copies', template: 'Rips/{{ARTIST}}' }] };
    const { vm, k } = await opened({ server: { view } });
    vm.dmPickerChooseCustom();
    k.text = 'typed';
    vm.dmPickerChoose('Rips/{{ARTIST}}');
    vm.dmPickerLibrary('music');
    assert.deepEqual([k.vpath, k.custom, k.text], ['music', true, 'Rips/{{ARTIST}}']);
    assert.equal(pathLine(vm.dmPickerPreview('song')), 'music › Rips › Boukmanflow');
    vm.dmPickerLibrary('copies');
    assert.deepEqual([k.vpath, k.custom, vm.dmPickerLayout(), k.text], ['copies', false, 'Rips/{{ARTIST}}', 'typed']);
    vm.dmPickerChoose(LAYOUT);
    vm.dmPickerLibrary('music');
    assert.deepEqual([k.custom, vm.dmPickerLayout()], [false, LAYOUT], 'a preset every library has stays chosen');
  });

  test('the preview says what lands there — the song, the album, every album of the artist, the one missing album — and a path longer than the server takes, which Save still takes', async () => {
    const { vm, k } = await opened();
    assert.deepEqual(['song', 'album', 'artist', 'artist-missing'].map((s) => vm.dmPickerLandsAt(s)),
      ['02 - Late Train Verse lands at', 'Borrowed Tapes lands at', 'Every album by Boukmanflow lands at', 'Second Shift lands at']);
    assert.deepEqual([pathLine(vm.dmPickerPreview('artist')), vm.dmPickerPreview('artist').file], ['copies › Boukmanflow › one folder per album', null]);
    vm.discover.modal.artist = { ...vm.discover.modal.artist, missing: 2, missingOne: null };
    assert.equal(vm.dmPickerLandsAt('artist-missing'), 'The albums you don’t have land at');
    vm.dmPickerChooseCustom();
    k.text = Array.from({ length: 50 }, () => '{{ALBUM}}').join('/');
    assert.deepEqual([vm.dmPickerUnseen(vm.dmPickerPreview('song'), 'song'), vm.dmPickerCanSave()],
      [{ text: 'This song’s path would pass 500 characters, more than the server takes', warn: true }, true], 'the song: the phone\'s words');
    assert.deepEqual(vm.dmPickerUnseen(vm.dmPickerPreview('album'), 'album'), { text: 'This path would pass 500 characters, more than the server takes', warn: true });
    assert.match(VP_SRC, /\n {6}unseen: function \(\) \{ return this\.\$root\.dmPickerUnseen\(this\.preview, this\.shown\); \},/, 'the editor says it for the scope it draws');
  });

  test('"Start from an existing folder…": a folder chosen in the list starts Custom\'s layout — in front of a preset, in place of the folders Custom starts with; Up, New folder…, a folder not there yet; Esc closes the list first', async () => {
    const w = await opened();
    const { vm, k } = w;
    vm.dmBrowseToggle();
    assert.equal(k.browse.loading, true);
    await flush();
    assert.deepEqual([vm.dmBrowseCrumbs(), k.browse.dirs, vm.dmBrowseMissing()], [['copies'], ['from-peers', 'Boukmanflow'], false]);
    vm.dmBrowseInto('from-peers');
    assert.deepEqual([k.custom, k.text], [true, 'from-peers/{{ALBUMARTIST}}/{{ALBUM}}'], 'in front of the preset: the folder and that layout');
    await flush();
    assert.deepEqual([vm.dmBrowseCrumbs(), k.browse.dirs], [['copies', 'from-peers'], ['Stage Peer B', 'Stage Peer C', '2025 archive']]);
    w.doc.activeElement = null;   // the row pressed goes with the list it was in
    vm.dmBrowseInto('Stage Peer C');
    w.tick();
    assert.equal(w.focused(), 'firstRow');
    assert.equal(k.text, 'from-peers/Stage Peer C/{{ALBUMARTIST}}/{{ALBUM}}', 'in place of the folders it started with');
    await flush();
    assert.deepEqual([k.browse.dirs, vm.dmBrowseMissing()], [[], false]);
    w.el('browse').focus();
    vm.dmBrowseUp();
    w.tick();
    assert.equal(w.focused(), 'browse', 'a control still there keeps the keyboard');
    await flush();
    assert.deepEqual([k.text, vm.dmBrowseCrumbs()], ['from-peers/{{ALBUMARTIST}}/{{ALBUM}}', ['copies', 'from-peers']]);
    // opened again: on the chosen folder's parent, the folder pressed
    vm.dmBrowseToggle();
    vm.dmBrowseToggle();
    await flush();
    assert.deepEqual([vm.dmBrowseCrumbs(), k.browse.dirs.map((d) => vm.dmBrowseIsBase(d))], [['copies'], [true, false]]);
    // a folder typed that is not there yet says so; the list stays where it is (a list that moved
    // as the field lost focus would move Save from under a pointer on its way there)
    vm.dmBrowseInto('from-peers');
    await flush();
    const listed = w.calls.listed.length;
    k.text = 'from-peers/2026/{{ALBUM}}';
    await flush();
    assert.deepEqual([vm.dmBrowseCrumbs(), vm.dmBrowseMissing(), w.calls.listed.length], [['copies', 'from-peers'], true, listed]);
    assert.ok(!/id="dm-dest-custom"[^>]*v-on:change/.test(VP_SRC), 'the field never re-lists the folders');
    // New folder…: named, chosen, known not to exist — nothing to list
    const asked = w.calls.listed.length;
    vm.dmBrowseNewFolder();
    assert.equal(k.browse.naming, true);
    k.browse.newName = 'Fresh: Finds';
    vm.dmBrowseNewFolder();
    assert.deepEqual([k.text, k.browse.naming, vm.dmBrowseMissing(), w.calls.listed.length], ['from-peers/Fresh- Finds/{{ALBUM}}', false, true, asked]);
    // a listing that answers after the list moved on is dropped; at the library root the folders go, the rest stays
    let late = null;
    w.api.dirparser = (dir) => new Promise((resolve) => { late = () => resolve({ directories: [{ name: `stale ${dir}` }] }); });
    vm.dmBrowseUp();
    const held = late;
    w.api.dirparser = async () => ({ directories: [{ name: 'now' }] });
    vm.dmBrowseUp();
    await flush();
    held();
    await flush();
    assert.deepEqual([k.browse.dirs, k.text], [['now'], '{{ALBUM}}']);
    // from a preset the library root changes nothing
    vm.dmPickerChoose(LAYOUT);
    vm.dmPickerStartAt('');
    assert.deepEqual([k.custom, vm.dmPickerLayout()], [false, LAYOUT]);
    // Esc closes the list first, the keyboard on its toggle; then the editor, on Change…
    vm.dmBrowseToggle();
    assert.equal(k.browse, null);
    w.tick();
    assert.equal(w.focused(), 'browse');
    vm.dmClosePicker();
    w.tick();
    assert.equal(w.focused(), 'change');
    assert.match(VP_SRC, /if \(picker && picker\.browse\) \{ playlistVue\.dmBrowseToggle\(\); playlistVue\.dmHoldFocus\(\); return; \}\n\s*if \(picker\) \{ playlistVue\.dmClosePicker\(\); playlistVue\.dmHoldFocus\(\); return; \}\n[\s\S]{0,240}if \(tree && tree\.naming && discoverState\.modal\.keep\.landing === 'folder' && playlistVue\.dmLandShown\(\)\) \{ playlistVue\.dmIntoNaming\(false\); playlistVue\.dmHoldFocus\(\); return; \}\n\s*playlistVue\.closeDiscoverModal\(\);/,
      'Esc: the list, then the editor, then a folder being named under "Into a folder…", then the window');
  });

  test('a refused save keeps the editor open with the server\'s words under the layout — gone once the layout is edited; no answer: "try again"; Cancel saves nothing, the keyboard back on Change…', async () => {
    const w = await opened();
    const { vm, k } = w;
    vm.dmPickerChooseCustom();
    k.text = 'From friends/{{ARTIST}}';
    w.api.discoverySaveDestination = async () => { throw httpError(400, { error: 'destination: you cannot put files into library \'copies\'' }); };
    await vm.dmPickerSubmit();
    assert.deepEqual([vm.discover.modal.picker === k, k.saving, k.error, vm.dmPickerCanSave()], [true, false, 'destination: you cannot put files into library \'copies\'', true]);
    vm.dmPickerTyped();
    assert.equal(k.error, '', 'typed: gone');
    w.api.discoverySaveDestination = async () => { throw new TypeError('Failed to fetch'); };
    await vm.dmPickerSubmit();
    assert.equal(k.error, 'The server did not take that — try again');
    vm.dmPickerChoose(LAYOUT);
    assert.equal(k.error, '', 'a preset chosen: gone too');
    assert.deepEqual([w.toasts, w.calls.saves], [[], []], 'nothing saved, nothing said');
    vm.dmClosePicker();
    assert.equal(vm.discover.modal.picker, null);
    w.tick();
    assert.equal(w.focused(), 'change');
  });

  test('the place read again on open is taken while nothing was edited; an edit is kept; a place gone meanwhile leaves nothing to edit', async () => {
    const w = makeDestWindow();
    const { vm } = w;
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    w.server.view = viewOf({ vpath: 'music', base: '', layout: J.PEER_LAYOUT, source: 'user' });
    vm.dmOpenPicker();
    const k = vm.discover.modal.picker;
    assert.deepEqual([k.vpath, k.layout], ['copies', LAYOUT], 'the last one known, at once');
    await flush();
    assert.deepEqual([k.vpath, k.layout, k.custom, vm.dmPickerCanSave()], ['music', J.PEER_LAYOUT, false, false]);
    vm.dmClosePicker();
    w.server.view = viewOf(COPIES);
    vm.dmOpenPicker();
    const edited = vm.discover.modal.picker;
    vm.dmPickerChoose(LAYOUT);
    await flush();
    assert.deepEqual([edited.vpath, vm.dmPickerLayout(), vm.dmPickerCanSave()], ['music', LAYOUT, true], 'kept: Save or Cancel settles it');
    vm.dmClosePicker();
    w.server.view = viewOf(null);
    vm.dmOpenPicker();
    await flush();
    assert.equal(vm.discover.modal.picker, null);
  });

  test('Custom chosen with a pointer puts the keyboard in its field; with the arrow keys it stays in the radio group', () => {
    const chooseCustom = new Function(`return ${vpMethodSrc('chooseCustom')};`)();
    const run = (pointer) => {
      const ticks = [];
      const field = { focus() { this.focused = true; } };
      const c = { pointer, chosen: 0, $root: { dmPickerChooseCustom() { c.chosen += 1; } }, $refs: { custom: field }, $nextTick(cb) { ticks.push(cb); } };
      chooseCustom.call(c);
      ticks.forEach((f) => f());
      return [c.chosen, !!field.focused, c.pointer];
    };
    assert.deepEqual(run(true), [1, true, false]);
    assert.deepEqual(run(false), [1, false, false]);
  });

  test('Custom pressed again with a pointer while it is chosen puts the keyboard in its field (a chosen radio fires no change)', () => {
    const pressCustom = new Function(`return ${vpMethodSrc('pressCustom')};`)();
    const run = (pointer, custom) => {
      const ticks = [];
      const field = { focus() { this.focused = true; } };
      const c = { pointer, picker: { custom }, $refs: { custom: field }, $nextTick(cb) { ticks.push(cb); } };
      pressCustom.call(c);
      ticks.forEach((f) => f());
      return [!!field.focused, c.pointer];
    };
    assert.deepEqual(run(true, true), [true, false], 'chosen: its field');
    assert.deepEqual(run(true, false), [false, true], 'not chosen yet: the change after the click does it (chooseCustom), the pointer kept for it');
    assert.deepEqual(run(false, true), [false, false], 'Space: the keyboard stays on the radio');
  });

  test('the editor opens in view, the keyboard on the chosen library\'s chip', () => {
    const openedFn = new Function(`return ${vpMethodSrc('opened')};`)();
    const asked = [];
    const chip = { focus() { this.focused = true; } };
    const form = { scrollIntoView(o) { asked.push(o); }, querySelector(sel) { asked.push(sel); return chip; } };
    openedFn.call({ $refs: { form }, $nextTick(cb) { cb(); } });
    assert.deepEqual([asked, chip.focused], [[{ block: 'nearest' }, '.dm-dest-chip[aria-pressed="true"]'], true]);
  });

  test('Save is on for an edit alone and sends what the editor holds — another library alone too; with nothing it could save, it sends nothing', async () => {
    const { vm, k, calls } = await opened();
    await flush();
    vm.dmPickerLibrary('music');
    assert.deepEqual([k.vpath, k.custom, vm.dmPickerLayout(), vm.dmPickerCanSave()], ['music', false, LAYOUT, true], 'another library alone is an edit');
    vm.dmPickerLibrary('copies');
    assert.equal(vm.dmPickerCanSave(), false, 'back as it opened');
    await vm.dmPickerSubmit();
    vm.dmPickerChooseCustom();
    await vm.dmPickerSubmit();
    k.text = '{{ARTST}}';
    await vm.dmPickerSubmit();
    assert.deepEqual([calls.saves, vm.discover.modal.picker === k, k.saving], [[], true, false], 'unchanged, Custom empty, a layout the validator refuses: nothing sent');
    vm.dmPickerChoose(LAYOUT);
    vm.dmPickerLibrary('music');
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [{ vpath: 'music', base: '', layout: LAYOUT }], 'the default\'s place, kept as the account\'s own: not "Use the library default"');
  });

  test('"Use the library default" from Custom: the default\'s own preset chosen, what was typed left in the field — Save goes back to the default', async () => {
    const { vm, k, calls } = await opened();
    await flush();
    vm.dmPickerChooseCustom();
    k.text = 'From friends/{{ARTIST}}';
    vm.dmPickerUseDefault();
    assert.deepEqual([k.vpath, k.custom, vm.dmPickerLayout(), vm.dmPickerIsDefault(), vm.dmPickerCanSave()], ['music', false, LAYOUT, true, true]);
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [null]);
  });

  test('a place saved for the account that is the library default itself: "Use the library default" still goes back to following the library', async () => {
    const { vm, calls } = await opened({ server: { view: viewOf({ vpath: 'music', base: '', layout: LAYOUT, source: 'user' }) } });
    await flush();
    assert.deepEqual([vm.dmPickerIsDefault(), vm.dmPickerCanSave()], [true, false], 'the button shows while it is the account\'s own (mine); Save off until it is pressed');
    vm.dmPickerUseDefault();
    assert.equal(vm.dmPickerCanSave(), true);
    await vm.dmPickerSubmit();
    assert.deepEqual(calls.saves, [null]);
  });

  test('while a save is out nothing in the editor moves: the layouts, the libraries, Custom, the variables, the folder list (it only closes), Use the library default, the place read again', async () => {
    const w = await opened();
    const { vm, k } = w;
    await flush();
    vm.dmBrowseToggle();
    await flush();
    vm.dmPickerChoose(J.PEER_LAYOUT);
    let answer = null;
    w.api.discoverySaveDestination = (d) => new Promise((resolve) => { answer = () => { w.calls.saves.push(d); resolve(viewOf({ ...d, source: 'user' })); }; });
    const saving = vm.dmPickerSubmit();
    assert.equal(k.saving, true);
    const before = JSON.stringify(k);
    vm.dmPickerChoose(LAYOUT);
    vm.dmPickerLibrary('music');
    vm.dmPickerChooseCustom();
    vm.dmInsertVar('YEAR', null);
    vm.dmPickerUseDefault();
    vm.dmPickerStartAt('from-peers');
    vm.dmBrowseInto('from-peers');
    vm.dmBrowseUp();
    vm.dmBrowseNewFolder();
    vm.discover.dest.view = viewOf({ vpath: 'music', base: '', layout: LAYOUT, source: 'user' });
    vm.dmPickerSync();
    assert.equal(JSON.stringify(k), before, 'nothing changed');
    vm.discover.dest.view = viewOf(null);
    vm.dmPickerSync();
    assert.equal(vm.discover.modal.picker, k, 'a read finding no place while the save is out leaves the editor to the save\'s answer');
    vm.dmBrowseToggle();
    assert.equal(k.browse, null, 'the list closes (Esc closes it first)');
    vm.dmBrowseToggle();
    assert.equal(k.browse, null, 'but does not open');
    answer();
    await saving;
    assert.deepEqual(w.calls.saves, [{ vpath: 'copies', base: '', layout: J.PEER_LAYOUT }]);
  });

  test('a read of the place sent before a save answered is dropped: the bar keeps the saved place and the next Add sends it', async () => {
    const w = makeDestWindow();
    const { vm } = w;
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const before = w.server.view;
    const read = w.api.discoveryDestination;
    let release = null;
    w.api.discoveryDestination = () => { w.calls.destination += 1; return new Promise((resolve) => { release = () => resolve(before); }); };
    vm.dmOpenPicker();
    vm.dmPickerLibrary('music');
    await vm.dmPickerSubmit();
    assert.equal(vm.discover.dest.view.destination.vpath, 'music');
    release();
    await flush();
    assert.equal(vm.discover.dest.view.destination.vpath, 'music', 'the place from before the save is not drawn again');
    await vm.dmJobStart(COPY, null, 'album');
    assert.deepEqual(w.calls.starts.pop().destination, { vpath: 'music', base: '', layout: LAYOUT }, 'no 409 of its own making');
    w.api.discoveryDestination = read;
    w.server.view = viewOf(COPIES);
    await vm.dmLoadDestination(vm.discover.modal.gen);
    assert.equal(vm.discover.dest.view.destination.vpath, 'copies', 'a read sent after it is taken');
  });

  test('Get it\'s editor: opened from its bar, it says files — its toast too', async () => {
    const w = makeDestWindow();
    const { vm } = w;
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    vm.dmOpenPicker(true);
    const k = vm.discover.modal.picker;
    assert.equal(k.download, true);
    vm.dmPickerLibrary('music');
    await vm.dmPickerSubmit();
    assert.deepEqual(w.toasts.map((x) => x.title), ['Saved · files land in music']);
    vm.dmOpenPicker();
    assert.equal(vm.discover.modal.picker.download, false, 'Keep\'s Change…: copies');
  });

  test('the folder list moves with the library: a chip re-lists an open list on the new library', async () => {
    const w = await opened();
    const { vm } = w;
    vm.dmBrowseToggle();
    await flush();
    vm.dmBrowseInto('from-peers');
    await flush();
    assert.deepEqual(vm.dmBrowseCrumbs(), ['copies', 'from-peers']);
    const listed = w.calls.listed.length;
    vm.dmPickerLibrary('music');
    assert.deepEqual([vm.dmBrowseCrumbs(), w.calls.listed.slice(listed)], [['music'], ['/music']], 'the chosen folder\'s parent in that library');
  });

  test('a folder whose name has a brace cannot start a layout (a layout reads it as a variable): pressed, the list says why and nothing changes — New folder… the same', async () => {
    const w = await opened();
    const { vm, k } = w;
    vm.dmBrowseToggle();
    await flush();
    const held = [k.custom, k.text, k.browse.dir];
    const listed = w.calls.listed.length;
    vm.dmBrowseInto('Mixes {2024}');
    assert.deepEqual([k.custom, k.text, k.browse.dir, k.browse.braced, w.calls.listed.length], [...held, 'Mixes {2024}', listed]);
    assert.equal(tEn('discover.modal.dest.folderBraces', { folder: k.browse.braced }),
      '“Mixes {2024}” has a brace in its name, which a layout reads as a variable. Rename the folder to start from it.');
    vm.dmBrowseInto('from-peers');
    assert.deepEqual([k.browse.braced, k.text], ['', 'from-peers/{{ALBUMARTIST}}/{{ALBUM}}'], 'another folder: the note goes');
    vm.dmBrowseNewFolder();
    k.browse.newName = '{{PEER}}';
    vm.dmBrowseNewFolder();
    assert.deepEqual([k.browse.braced, k.text, k.browse.naming], ['{{PEER}}', 'from-peers/{{ALBUMARTIST}}/{{ALBUM}}', true], 'never the server\'s name; the name stays to fix');
    vm.dmBrowseUp();
    assert.equal(k.browse.braced, '', 'gone with the next move');
    assert.match(VP_SRC, /<div v-if="picker\.browse\.braced" class="dm-dest-tree-note dm-dest-tree-warn" role="alert">\{\{ tt\('discover\.modal\.dest\.folderBraces', \{ folder: picker\.browse\.braced \}\) \}\}<\/div>/);
  });
});

describe('dm-dest (vp.js): the bar and the editor as they are drawn', () => {
  const SRC = VP_SRC.slice(VP_SRC.indexOf('Vue.component(\'dm-dest-path\''), VP_SRC.indexOf('const playlistVue = new Vue('));
  const ED = SRC.slice(SRC.indexOf('<div v-if="picker" class="dm-dest-ed"'), SRC.indexOf('<div v-else-if="dest && path" class="dm-dest">'));
  const CSS = readFileSync(new URL('../../webapp/alpha/spa.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('the phone\'s order: the header, where it lands, the libraries, the layouts, then Use the library default and Save — no base folder field', () => {
    const at = (s) => { const i = ED.indexOf(s); assert.ok(i >= 0, s); return i; };
    // the folder list under the layouts, Custom's field after it: a folder chosen from a preset
    // brings the field in under the list, never over the row just pressed (a second press, into
    // a subfolder, would have inserted a variable)
    const order = ['class="dm-dest-ed-h"', 'class="dm-dest-preview"', 'class="dm-dest-chips"', 'role="radiogroup"', 'id="dm-dest-save-err"',
      'data-dm-browse', 'class="dm-dest-tree"', 'class="dm-dest-custom"', 'class="dm-dest-vars"', 'class="dm-dest-ed-foot"'].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(ED, /<div id="dm-dest-h" class="dm-dest-ed-title">\{\{ tt\(download \? 'discover\.modal\.dest\.headingFiles' : 'discover\.modal\.dest\.heading'\) \}\}<\/div><span class="dm-dest-tag"><dm-icon v-if="mine" name="person" :size="12"><\/dm-icon>\{\{ tt\(mine \? 'discover\.modal\.dest\.tagYours' : 'discover\.modal\.dest\.tagDefault'\) \}\}<\/span>/);
    assert.match(ED, /<div class="dm-dest-ed-sub">\{\{ tt\(download \? 'discover\.modal\.dest\.subFiles' : 'discover\.modal\.dest\.sub'\) \}\}<\/div>/, 'Get it\'s editor says files: the one setting is its too');
    assert.match(ED, /<button type="button" class="dm-btn dm-btn-quiet dm-btn-icon" :aria-label="tt\('discover\.modal\.cancel'\)"[^>]*v-on:click="\$root\.dmClosePicker\(\)">/);
    assert.match(ED, /<div v-else class="dm-dest-preview-body">\s*<div class="dm-dest-lands">\{\{ \$root\.dmPickerLandsAt\(shown\) \}\}<\/div>\s*<dm-dest-path :path="preview" variant="preview"><\/dm-dest-path>/);
    assert.ok(!/dm-dest-base|<select|discover\.modal\.dest\.(base|browse|applies|preview)'/.test(ED), 'no base folder field, no library select, no "Applies to…"');
    assert.match(ED, /<button v-if="mine \|\| !\$root\.dmPickerIsDefault\(\)" type="button" class="dm-btn dm-btn-quiet"[^>]*v-on:click="\$root\.dmPickerUseDefault\(\)">/,
      'while the account\'s own place is in force too, as the phone shows it');
    assert.match(ED, /:aria-disabled="\$root\.dmPickerCanSave\(\) \? null : 'true'" :aria-describedby="picker\.error \? 'dm-dest-save-err' : null" v-on:click="\$root\.dmPickerSubmit\(\)">.*tt\(picker\.saving \? 'discover\.modal\.dest\.saving' : 'discover\.modal\.dest\.save'\)/);
  });

  test('keyboard reach: the chips real buttons, pressed; the layouts real radios in one radiogroup, Custom last; the variables real buttons; the field named; the error announced', () => {
    assert.match(ED, /<button v-for="lib in libraries" :key="lib" type="button" class="dm-dest-chip" :class="\{ 'dm-on': lib === picker\.vpath \}" :aria-pressed="lib === picker\.vpath \? 'true' : 'false'" :aria-disabled="picker\.saving \? 'true' : null" :title="lib" v-on:click="\$root\.dmPickerLibrary\(lib\)">/,
      'a chip chooses its own library; its whole name in its title');
    const group = ED.slice(ED.indexOf('role="radiogroup"'), ED.indexOf('<div v-if="picker.custom" class="dm-dest-custom">'));
    const radios = group.match(/<input type="radio" name="dm-dest-layout"[^>]*>/g);
    assert.equal(radios.length, 2, 'the presets (one v-for), then Custom');
    assert.match(radios[0], /:checked="!picker\.custom && picker\.layout === p\.layout" :disabled="picker\.saving" v-on:change="\$root\.dmPickerChoose\(p\.layout\)"/, 'a preset is chosen only while Custom is not');
    assert.match(radios[1], /:checked="picker\.custom" :disabled="picker\.saving" aria-describedby="dm-dest-custom-sub" v-on:click="pressCustom\(\)" v-on:change="chooseCustom\(\)"/);
    // each radio is named by its words alone, as the phone reads it: a preset's template is drawn, not read
    // (braces and all); Custom's "Type your own path" is its description. Spans: a label holds phrasing content
    assert.match(group, /<label v-for="p in presets" :key="p\.layout" class="dm-dest-opt"[\s\S]*?<span class="dm-dest-opt-text"><span class="dm-dest-opt-label">\{\{ tt\(p\.key\) \}\}<\/span><span class="dm-dest-opt-sub dm-dest-mono" aria-hidden="true">\{\{ p\.layout \}\}<\/span><\/span>/);
    assert.match(group, /<span id="dm-dest-custom-sub" class="dm-dest-opt-sub" aria-hidden="true">\{\{ tt\('discover\.modal\.dest\.customSub'\) \}\}<\/span>/);
    for (const label of group.match(/<label[\s\S]*?<\/label>/g)) {
      assert.ok(!/<div/.test(label), 'no <div> inside a <label>');
      // Materialize hides a radio and draws one of its own from a "+ span": the radio comes last
      assert.match(label, /<input type="radio"[^>]*>\s*<\/label>$/, 'the radio last in its label');
    }
    assert.match(group, /<label class="dm-dest-opt" :class="\{ 'dm-on': picker\.custom \}" v-on:pointerdown="pointer = true">/);
    assert.match(ED, /role="radiogroup" aria-labelledby="dm-dest-layout-l" v-on:keydown="pointer = false"/);
    assert.match(ED, /<button v-for="v in \$root\.dmPickerVars\(\)" :key="v" type="button" class="dm-dest-var" :aria-label="\$root\.dmPickerVarLabel\(v\)"[^>]*v-on:click="\$root\.dmInsertVar\(v, \$refs\.custom\)">/);
    assert.match(ED, /<input id="dm-dest-custom" ref="custom" class="dm-input dm-dest-mono browser-default" type="text" maxlength="500" spellcheck="false" autocomplete="off" v-model="picker\.text" v-on:input="\$root\.dmPickerTyped\(\)" :disabled="picker\.saving"[^>]*:aria-label="tt\('discover\.modal\.dest\.customField'\)"/,
      'typed: a refusal under it goes; nothing typed while a save is out');
    // a refusal while Custom is chosen goes right under its field, in place of the validator's words, its border the error's;
    // with a preset chosen, under the layouts
    const custom = ED.slice(ED.indexOf('<div v-if="picker.custom" class="dm-dest-custom">'), ED.indexOf('class="dm-dest-ed-foot"'));
    assert.match(custom, /:class="\{ 'is-warn': !!problem && !picker\.error, 'is-err': !!picker\.error \}" :aria-invalid="problem \|\| picker\.error \? 'true' : null" :aria-describedby="picker\.error \? 'dm-dest-save-err dm-dest-custom-h' : problem \? 'dm-dest-custom-w dm-dest-custom-h' : 'dm-dest-custom-h'">\s*<div v-if="picker\.error" id="dm-dest-save-err" class="dm-dest-err" role="alert">[^\n]*\n\s*<div v-else-if="problem" id="dm-dest-custom-w" class="dm-dest-warn">/);
    assert.match(group, /<\/div>\s*<div v-if="picker\.error && !picker\.custom" id="dm-dest-save-err" class="dm-dest-err" role="alert">/);
    assert.match(CSS, /\n\.dm-dest-ed \.dm-input\.is-err, \.dm-dest-ed \.dm-input\[type="text"\]\.is-err \{ border-color: var\(--err\); \}/);
    assert.match(ED, /data-dm-browse :aria-expanded="picker\.browse \? 'true' : 'false'" :aria-disabled="picker\.saving && !picker\.browse \? 'true' : null" v-on:click="\$root\.dmBrowseToggle\(\)">[^\n]*tt\(picker\.browse \? 'discover\.modal\.dest\.hideFolders' : 'discover\.modal\.dest\.startFrom'\)/,
      'while a save is out the list only closes');
    assert.match(ED, /<button v-for="d in picker\.browse\.dirs" :key="d" type="button" class="dm-dest-node" :aria-pressed="\$root\.dmBrowseIsBase\(d\) \? 'true' : 'false'" :aria-disabled="picker\.saving \? 'true' : null"/);
    assert.match(SRC, /data-dm-change v-on:click="\$root\.dmOpenPicker\(download\)"/, 'Get it\'s bar opens it as Get it\'s (its toast says files)');
    assert.ok(!/dmResetDestination|dest\.reset|href="javascript|<(span|div)[^>]*v-on:click/.test(SRC), 'no anchors or clickable spans; no reset in the bar');
  });

  test('a slot drawn quiet inside its folder\'s text, as the "one folder per album" note is — italic in the preview; the file the preview\'s last crumb; the one note under the path', () => {
    assert.match(SRC, /<template v-if="c\.parts"><span v-for="\(p, j\) in c\.parts" :key="j" :class="\{ 'dm-dest-slot': p\.slot \}">\{\{ p\.text \}\}<\/span><\/template>/);
    assert.match(SRC, /<span v-if="file && path\.file && variant === 'preview'" class="dm-dest-crumb dm-dest-crumb-file"><i aria-hidden="true">&rsaquo;<\/i><span class="dm-sr">\/<\/span>\{\{ path\.file \}\}<\/span>/);
    assert.match(SRC, /<div v-if="file && path\.file && variant !== 'preview'" class="dm-dest-file">\{\{ path\.file \}\}<\/div>\s*<div v-if="path\.slotNote" class="dm-dest-slots">\{\{ path\.slotNote \}\}<\/div>/);
    const color = (sel) => (new RegExp(`\\n${sel.replace(/[.-]/g, '\\$&')} \\{[^}]*?color: (var\\(--t\\d\\))`).exec(CSS) || [])[1];
    assert.equal(color('.dm-dest-slot'), color('.dm-dest-crumb-note'), 'the note\'s colour');
    assert.match(CSS, /\n\.dm-dest-slot \{[^}]*font-weight: 400;/, 'quiet in the preview\'s bold source colour too');
    assert.match(CSS, /\n\.dm-dest-path-preview \.dm-dest-slot \{ font-style: italic; \}/);
    assert.match(CSS, /\n\.dm-dest-slots \{[^}]*font-size: 11px;[^}]*color: var\(--t4\);/, 'the note under the path: the editor\'s hint size and colour');
  });

  test('spa.css: the radios drawn natively, the chosen chip as the chosen segment, 44 px targets on a phone; the old editor\'s rules gone', () => {
    assert.match(CSS, /\n\.dmodal \.dm-dest-opt \.dm-dest-radio \{ order: -1; position: static;[^}]*opacity: 1; pointer-events: auto; accent-color: var\(--src\);/,
      'last in its label, drawn first');
    assert.match(CSS, /\n\.dm-dest-chip\.dm-on, [^{]*\{ background: var\(--btn\); border-color: var\(--src\);/);
    const phone = CSS.slice(CSS.indexOf('/* Phones: every target 44 px tall; Use the library default and Save share'), CSS.indexOf('/* Phones: a bottom sheet'));
    for (const rule of ['.dm-dest-chip, .dm-dest-chip:focus { height: 44px; }', '.dm-dest-opt { min-height: 44px; }', '.dm-dest-var, .dm-dest-var:focus { height: 44px; }',
      '.dm-dest-node, .dm-dest-node:focus { min-height: 44px; }', '.dm-dest-ed .dm-input, .dm-dest-ed .dm-input[type="text"] { height: 44px; }']) {
      assert.ok(phone.includes(rule), rule);
    }
    assert.ok(!/\.dm-dest-(select|static|row|applies|vars-rule)\b/.test(CSS), 'the old editor\'s rules are gone');
  });

  test('spa.css: a long library name ends in "…" inside the window; Custom\'s example is never cut on a phone; a label\'s spans are blocks', () => {
    assert.match(CSS, /\n\.dm-dest-chip, \.dm-dest-chip:focus \{[^}]*max-width: 100%;[^}]*white-space: nowrap;/);
    assert.match(CSS, /\n\.dm-dest-chips \{ display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; \}/, 'the row itself shrinks inside the editor\'s grid');
    assert.match(CSS, /\n\.dm-dest-chip > svg \{ flex-shrink: 0; \}\n\.dm-dest-chip-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
    assert.match(ED, /<span class="dm-dest-chip-name">\{\{ lib \}\}<\/span><\/button>/);
    // empty, the field draws its example in the window's font (monospace would cut "{{ALBUM}}" at 375 px),
    // and on a phone it gives back most of its indent
    assert.match(CSS, /\n\.dm-dest-ed \.dm-dest-mono\[type="text"\]:placeholder-shown \{ font-family: inherit; \}/);
    const phone = CSS.slice(CSS.indexOf('/* Phones: every target 44 px tall; Use the library default and Save share'), CSS.indexOf('/* Phones: a bottom sheet'));
    assert.ok(phone.includes('.dm-dest-custom { padding-left: 8px; }'));
    for (const sel of ['.dm-dest-opt-text', '.dm-dest-opt-label', '.dm-dest-opt-sub']) {
      assert.match(CSS, new RegExp(`\\n${sel.replace(/[.-]/g, '\\$&')} \\{ display: block;`), sel);
    }
    assert.match(CSS, /\n\.dm-dest-node\[aria-disabled="true"\] \{ opacity: \.6; cursor: default; \}/, 'a folder row while a save is out');
  });
});

describe('en.json: where files land, in the design\'s words', () => {
  test('the bar, the paths, the editor in the phone\'s words; the words it dropped are gone', () => {
    const want = {
      'discover.modal.dest.goTo': 'Files go to', 'discover.modal.dest.savedFor': 'Saved for your account', 'discover.modal.dest.libraryDefault': 'The library’s default',
      'discover.modal.dest.perAlbum': 'one folder per album', 'discover.modal.dest.change': 'Change…', 'discover.modal.dest.into': 'Into', 'discover.modal.dest.in': 'In',
      'discover.modal.dest.addAgainAddsTo': 'Add again adds to', 'discover.modal.dest.movedSince': 'Your saved place has changed since.',
      'discover.modal.dest.heading': 'Where copies land', 'discover.modal.dest.tagYours': 'yours', 'discover.modal.dest.tagDefault': 'library default',
      'discover.modal.dest.sub': 'One setting for your account · every copy uses it', 'discover.modal.dest.customEmpty': 'Type a path to see where files land',
      'discover.modal.dest.fixLayout': 'Fix the layout to see where files land', 'discover.modal.dest.library': 'Library', 'discover.modal.dest.layout': 'Layout',
      'discover.modal.dest.preset.artistAlbum': 'Artist / Album', 'discover.modal.dest.preset.server': 'Server / Artist / Album',
      'discover.modal.dest.preset.serverFolders': 'Same folders as the server', 'discover.modal.dest.preset.library': 'Library layout', 'discover.modal.dest.preset.custom': 'Custom',
      'discover.modal.dest.customSub': 'Type your own path', 'discover.modal.dest.customField': 'Custom layout',
      'discover.modal.dest.customHelp': 'Use / between folders. Variables sort copies by artist, album…; a plain name puts every copy in the same folder.',
      'discover.modal.dest.startFrom': 'Start from an existing folder…', 'discover.modal.dest.hideFolders': 'Hide folders',
      'discover.modal.dest.useDefault': 'Use the library default', 'discover.modal.dest.save': 'Save', 'discover.modal.dest.saving': 'Saving…',
      // Get it's editor: the one setting is its too
      'discover.modal.dest.headingFiles': 'Where files land', 'discover.modal.dest.subFiles': 'One setting for your account · every copy and download uses it',
    };
    for (const [key, text] of Object.entries(want)) { assert.equal(EN[key], text, key); }
    assert.equal(tEn('discover.modal.dest.landsAt', { title: 'Lantern Street' }), 'Lantern Street lands at');
    assert.equal(tEn('discover.modal.dest.customHint', { example: '{{ARTIST}}/{{ALBUM}}' }), 'e.g. From friends or {{ARTIST}}/{{ALBUM}}');
    assert.equal(tEn('discover.modal.dest.saved', { path: 'copies › From friends' }), 'Saved · copies land in copies › From friends');
    assert.equal(tEn('discover.modal.dest.savedFiles', { path: 'copies › From friends' }), 'Saved · files land in copies › From friends');
    assert.equal(tEn('discover.modal.dest.tooLongSong', { max: 500 }), 'This song’s path would pass 500 characters, more than the server takes');
    assert.equal(tEn('discover.modal.dest.tooLong', { max: 500 }), 'This path would pass 500 characters, more than the server takes');
    assert.equal(tEn('discover.modal.dest.missing', { vars: '{{YEAR}}, {{ALBUM}}' }), 'No value for this song, so left out of the path: {{YEAR}}, {{ALBUM}}', 'the phone\'s words');
    assert.deepEqual(['artist', 'year', 'genre', 'serverfolder'].map((v) => EN[`discover.modal.dest.slot.${v}`]), ['‹artist›', '‹year›', '‹genre›', '‹server folder›']);
    assert.equal(tEn('discover.modal.dest.slotNoteServer', { slot: '‹server folder›' }), '‹server folder› comes from where each song sits on the server, so these songs can land in more than one folder.');
    assert.equal(tEn('discover.modal.dest.slotNote', { slots: '‹artist›', count: 1 }), '‹artist› comes from each song’s own tags, so these songs can land in more than one folder.');
    assert.equal(tEn('discover.modal.dest.slotNote', { slots: '‹artist›, ‹year›', count: 2 }), '‹artist›, ‹year› come from each song’s own tags, so these songs can land in more than one folder.');
    assert.equal(tEn('discover.modal.dest.slotNoteGenre', { slots: '‹genre›', count: 1 }),
      '‹genre› comes from each song’s own tags, so these songs can land in more than one folder (a song with none leaves that folder out).');
    assert.equal(tEn('discover.modal.dest.slotNoteSong', { slots: '‹genre›', count: 1 }), '‹genre› comes from the song’s own tags (a song with none leaves that folder out).');
    assert.equal(tEn('discover.modal.dest.foldersIn', { library: 'copies' }), 'Folders in copies');
    assert.equal(tEn('discover.modal.dest.folderCount', { count: 1 }), '1 folder');
    for (const key of ['discover.modal.dest.yours', 'discover.modal.dest.default', 'discover.modal.dest.reset', 'discover.modal.dest.remembered', 'discover.modal.dest.use',
      'discover.modal.dest.libraryTemplate', 'discover.modal.dest.base', 'discover.modal.dest.root', 'discover.modal.dest.baseHint', 'discover.modal.dest.nested',
      'discover.modal.dest.browse', 'discover.modal.dest.libraryHint', 'discover.modal.dest.onlyLibrary', 'discover.modal.dest.useTemplate', 'discover.modal.dest.sameAsServer',
      'discover.modal.dest.layoutHint', 'discover.modal.dest.preview', 'discover.modal.dest.applies', 'discover.modal.dest.err.empty_template']) {
      assert.equal(EN[key], undefined, `${key} is gone`);
    }
  });
});

// ── vp.js: Keep a copy, the card (2026-10-21 design, SPEC §6–§8) ─────────
// dmKeepView puts each state in the window's words — the headline, its
// colour, the sub and muted lines, the bar, where the files are, what can
// be done — over the shared DISCOVERJOBS.jobRowState; the segments carry a
// marker for a state that is not the chosen one's; a start the server
// refused keeps the choices; a right lost while open is one plain line.
// The spec's sample: Late Train Verse (02, mp3) on Borrowed Tapes by
// Boukmanflow, from Stage Peer B; saved destination copies, layout
// {{ALBUMARTIST}}/{{ALBUM}}.
const KEEP_DEST = { vpath: 'copies', base: '', layout: LAYOUT, source: 'user' };
const LATE = '02 - Late Train Verse';
const TAPES = ['01 - Rooftop Cypher', LATE, '03 - Corner Store Loop'];
const fromPeer = (t, album = 'Borrowed Tapes') => `peerlib/Boukmanflow/${album}/${t}.mp3`;
const inCopies = (t, album = 'Borrowed Tapes') => `copies/Boukmanflow/${album}/${t}.mp3`;
// a copy job of this account's, as the jobs route sends it (pinned at start)
const keepJob = (over) => ({ id: 90, plugin: 'federation-copy', key: 'text:late', state: 'done', progress: null, statusText: null, cancelRequested: false, error: null,
  params: { destination: KEEP_DEST }, recommendation: tapesRow(STAGE_B, LATE), createdAt: 1000, updatedAt: 1000, finishedAt: 1000, ...over });
const albumJob = (over) => keepJob({ id: 91, key: 'album:bt', params: { scope: 'album', destination: KEEP_DEST }, ...over });
const artistJob = (scope, over) => keepJob({ id: 92, key: `${scope}:bk`, params: { scope, destination: KEEP_DEST }, ...over });
// an album copy's result (copySongs): each list entry names its peer file
const albumResult = ({ copied = [], owned = [], failed = [], total, stopped = null, peer = STAGE_B, album = 'Borrowed Tapes' } = {}) => {
  const all = total == null ? copied.length + owned.length + failed.length : total;
  return { scope: 'album', album: { name: album, artist: 'Boukmanflow', albumArtist: null, year: 2019 },
    songs: { total: all, copied: copied.map((t) => ({ from: fromPeer(t, album), vpath: 'copies', filepath: inCopies(t, album) })),
      skipped: owned.map((t) => ({ from: fromPeer(t, album), why: 'owned', at: `music/Boukmanflow/Harbour Lights/${t}.mp3` })),
      failed: failed.map((t) => ({ from: fromPeer(t, album), error: 'x' })) },
    counts: { total: all, copied: copied.length, skipped: owned.length, failed: failed.length }, stopped, peer, destination: KEEP_DEST };
};
// an artist walk's result (copyAlbums): the albums it took, the ones it left out
const walkAlbum = (name, { copied = 0, owned = 0, failed = 0, error = null } = {}) => ({ name, year: 2019, bytes: 0, stopped: null, error,
  songs: { total: copied + owned + failed,
    copied: Array.from({ length: copied }, (_, i) => ({ from: fromPeer(`c${i}`, name), vpath: 'copies', filepath: inCopies(`c${i}`, name) })),
    skipped: Array.from({ length: owned }, (_, i) => ({ from: fromPeer(`o${i}`, name), why: 'owned', at: `music/Boukmanflow/${name}/o${i}.mp3` })),
    failed: Array.from({ length: failed }, (_, i) => ({ from: fromPeer(`f${i}`, name), error: 'x' })) } });
const artistResult = (scope, albums, { skippedAlbums = [], stopped = null } = {}) => {
  const all = (k) => albums.flatMap((a) => a.songs[k]);
  const total = albums.reduce((n, a) => n + a.songs.total, 0);
  return { scope, artist: { name: 'Boukmanflow' }, albums, skippedAlbums, songs: { total, copied: all('copied'), skipped: all('skipped'), failed: all('failed') },
    counts: { total, copied: all('copied').length, skipped: all('skipped').length, failed: all('failed').length }, stopped, peer: STAGE_B, destination: KEEP_DEST };
};
// the card in a line or two per field — what the spec's tables say
const card = (v) => v && {
  state: v.state, kind: v.kind, tile: v.tile ? `${v.tile.icon} ${v.tile.tint}` : null, headline: v.headline, tone: v.tone, pct: v.pct,
  sub: v.sub, muted: v.muted, progress: v.progress,
  path: v.path ? `${jobLine(v.path)}${v.path.path.file ? ` + ${v.path.path.file}` : ''}` : null,
  retry: v.retryPath ? `${v.retryPath.prefix} ${pathLine(v.retryPath.path)}` : null,
  acts: v.actions.map((a) => `${a.kind} ${a.label}${a.busy ? ' (busy)' : ''}`), line: v.line,
};
const keepWindow = async ({ reads = STAGE_READS(), row = tapesRow(STAGE_B, LATE), focus = null, plugins: list = [COPY] } = {}) => {
  const w = makeWindow({ reads, destination: KEEP_DEST, plugins: list });
  await w.vm.openDiscoverModal(row, 'federation', focus ? { seedPlain: 'x', focus } : { seedPlain: 'x' });
  return w;
};
const withJobs = (vm, jobs) => { vm.discover.modal.jobs = jobs; return card(vm.dmKeepView()); };

describe('Keep a copy: This song, every state (vp.js dmKeepView, SPEC §7.1)', () => {
  test('S1 idle — the path bar and "Add this song"; S2 while the start is out: "Adding…", dimmed', async () => {
    const { vm } = await keepWindow();
    assert.deepEqual(card(vm.dmKeepView()), { state: 'idle', kind: 'idle', tile: null, headline: '', tone: 'n', pct: null, sub: '', muted: '', progress: null, path: null, retry: null,
      acts: ['primary Add this song'], line: '' });
    vm.discover.modal.jobBusy = { 'federation-copy': true };
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Adding… (busy)']);
  });

  test('S3 queued · S4 copying with no % yet · S5 copying 14% · S6 stopping: Into the pinned place, the file, Cancel (none once asked)', async () => {
    const { vm } = await keepWindow();
    const into = 'Into copies › Boukmanflow › Borrowed Tapes + 02 - Late Train Verse.mp3';
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'queued' }) }), { state: 'queued', kind: 'state', tile: 'clock grey', headline: 'Queued', tone: 'n', pct: null,
      sub: 'Waiting for a free slot · starts automatically', muted: '', progress: null, path: into, retry: null, acts: ['ghost Cancel'], line: '' });
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'running' }) }), { state: 'copying', kind: 'state', tile: 'download gold', headline: 'Copying', tone: 'n', pct: null,
      sub: 'Starting…', muted: '', progress: 'indeterminate', path: into, retry: null, acts: ['ghost Cancel'], line: '' });
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0.14, statusText: '1.2 of 8.4 MB' }) }), { state: 'copying', kind: 'state', tile: 'download gold',
      headline: 'Copying', tone: 'n', pct: 14, sub: '1.2 of 8.4 MB', muted: '', progress: 14, path: into, retry: null, acts: ['ghost Cancel'], line: '' });
    // the server's line, its first letter capitalised; a % it carries goes (it sits beside the headline)
    assert.equal(withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0.02, statusText: 'asking Stage Peer B about the file' }) }).sub, 'Asking Stage Peer B about the file');
    assert.equal(withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0.43, statusText: '4 of 11 songs · 38.2 MB · 43%' }) }).sub, '4 of 11 songs · 38.2 MB');
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0.4, statusText: '1.2 of 8.4 MB', cancelRequested: true }) }), { state: 'stopping', kind: 'state',
      tile: 'download gold', headline: 'Stopping…', tone: 'n', pct: null, sub: '1.2 of 8.4 MB', muted: '', progress: 40, path: into, retry: null, acts: [], line: '' });
    // a job from before the pin: Into the saved place
    vm.discover.modal.jobs = { 'federation-copy': keepJob({ state: 'queued', params: {} }) };
    assert.equal(card(vm.dmKeepView()).path, into);
  });

  test('S7 in your collection · S8 copied from another server · S9/S10 already yours: In where it is, Queue and Play your copy where there is a file', async () => {
    const { vm } = await keepWindow();
    const copied = { copied: { vpath: 'copies', filepath: inCopies(LATE) }, destination: KEEP_DEST };
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ result: copied }) }), { state: 'kept', kind: 'state', tile: 'check ok', headline: 'In your collection', tone: 'ok', pct: null,
      sub: '', muted: '', progress: null, path: 'In copies › Boukmanflow › Borrowed Tapes + 02 - Late Train Verse.mp3', retry: null, acts: ['secondary Queue', 'primary Play your copy'], line: '' });
    assert.equal(withJobs(vm, { 'federation-copy': keepJob({ recommendation: tapesRow(STAGE_C, LATE), result: { ...copied, peer: STAGE_C } }) }).sub, 'Copied from Stage Peer C');
    const owned = withJobs(vm, { 'federation-copy': keepJob({ result: { skipped: 'owned', existing: { vpath: 'music', filepath: 'music/Boukmanflow/Singles/Late Train Verse.mp3' } } }) });
    assert.deepEqual([owned.state, owned.tile, owned.headline, owned.tone, owned.sub, owned.path, owned.acts],
      ['yours', 'check grey', 'Already yours', 'n', 'Your library already has this song · nothing was copied', 'In music › Boukmanflow › Singles + Late Train Verse.mp3', ['secondary Queue', 'primary Play your copy']]);
    const nowhere = withJobs(vm, { 'federation-copy': keepJob({ result: { skipped: 'owned', existing: null } }) });
    assert.deepEqual([nowhere.headline, nowhere.path, nowhere.acts], ['Already yours', null, []], 'no location: no path, nothing to play');
  });

  test('S11 skipped: Change…, no Retry while the saved place is the one it used · S11b once it moved: the muted line, Retry, and where Retry adds', async () => {
    const { vm } = await keepWindow();
    const skipped = keepJob({ result: { skipped: 'exists', filepath: inCopies(LATE), destination: KEEP_DEST } });
    assert.deepEqual(withJobs(vm, { 'federation-copy': skipped }), { state: 'skipped', kind: 'state', tile: 'warn warn', headline: 'Skipped', tone: 'warn', pct: null,
      sub: 'A file is already there · nothing was overwritten', muted: '', progress: null, path: 'In copies › Boukmanflow › Borrowed Tapes + 02 - Late Train Verse.mp3', retry: null,
      acts: ['ghost Change…'], line: '' });
    vm.discover.dest.view = { destination: MUSIC_DEFAULT };
    const moved = card(vm.dmKeepView());
    assert.deepEqual([moved.muted, moved.acts, moved.retry, moved.path], ['Your saved place has changed since.', ['ghost Change…', 'primary Retry'], null,
      'In copies › Boukmanflow › Borrowed Tapes + 02 - Late Train Verse.mp3'], 'S11b: the muted line says it — no "Retry adds to …" line besides');
  });

  test('S12 copy failed: the server\'s words, else "Something went wrong"; Retry · S13 cancelled: "Add again" · S14 an unreadable result: "Done", nothing to do', async () => {
    const { vm } = await keepWindow();
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'failed', error: 'Stage Peer C no longer has this file' }) }), { state: 'failed', kind: 'state', tile: 'warn err',
      headline: 'Copy failed', tone: 'err', pct: null, sub: 'Stage Peer C no longer has this file', muted: '', progress: null, path: null, retry: null, acts: ['primary Retry'], line: '' });
    assert.equal(withJobs(vm, { 'federation-copy': keepJob({ state: 'failed' }) }).sub, 'Something went wrong');
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ state: 'cancelled', result: null }) }), { state: 'cancelled', kind: 'state', tile: 'close grey', headline: 'Cancelled',
      tone: 'n', pct: null, sub: 'Nothing was copied', muted: '', progress: null, path: null, retry: null, acts: ['primary Add again'], line: '' });
    assert.deepEqual(withJobs(vm, { 'federation-copy': keepJob({ result: {} }) }), { state: 'done', kind: 'state', tile: 'check grey', headline: 'Done', tone: 'n', pct: null,
      sub: '', muted: '', progress: null, path: null, retry: null, acts: [], line: '' });
  });

  test('settled by a finished wider copy of this server\'s: "With your album copy" / "With your copy of every album by Boukmanflow"', async () => {
    const { vm } = await keepWindow();
    const byAlbum = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES }) }) });
    assert.deepEqual([byAlbum.state, byAlbum.sub, byAlbum.path, byAlbum.acts],
      ['kept', 'With your album copy', 'In copies › Boukmanflow › Borrowed Tapes + 02 - Late Train Verse.mp3', ['secondary Queue', 'primary Play your copy']]);
    const walk = artistResult('artist', [{ ...walkAlbum('Borrowed Tapes'), songs: albumResult({ copied: TAPES }).songs }]);
    assert.equal(withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: walk }) }).sub, 'With your copy of every album by Boukmanflow');
    assert.equal(vm.dmKeepView().borrowed, 'artist');
  });
});

describe('Keep a copy: Album, every state (vp.js dmKeepView, SPEC §7.2)', () => {
  const album = () => keepWindow({ focus: 'album' });

  test('A1 "Add album · 3 songs" · A2 the library has it by name: "Add the songs you lack" · before the peer said: "Add album"', async () => {
    const { vm } = await album();
    assert.equal(vm.dmKeepChosen(), 'album');
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add album · 3 songs']);
    vm.discover.modal.album = { ...vm.discover.modal.album, owned: true };
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add the songs you lack']);
    vm.discover.modal.album = null;
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add album']);
  });

  test('A3 a compilation: "Whole compilation · 3 songs", named whole for a screen reader; its path under its credit', async () => {
    const row = tapesRow(STAGE_B, 'Night Bus', { album: 'Night Market Sampler', albumArtist: 'Various Artists', filepath: 'peerlib/VA/Night Market Sampler/Night Bus.mp3' });
    const { vm } = await keepWindow({ row, focus: 'album' });
    const [seg] = vm.dmKeepSegments();
    assert.deepEqual([seg.sub, seg.aria], ['Whole compilation · 3 songs', 'Album: the whole compilation Night Market Sampler, credited to Various Artists, 3 songs']);
    assert.deepEqual([card(vm.dmKeepView()).acts, pathLine(vm.dmDestPath('album'))], [['primary Add album · 3 songs'], 'copies › Various Artists › Night Market Sampler']);
  });

  test('A4 queued · A5 copying 43% · A6 stopping: Into the album\'s folder, no file line', async () => {
    const { vm } = await album();
    const into = 'Into copies › Boukmanflow › Borrowed Tapes';
    assert.deepEqual([withJobs(vm, { 'federation-copy@album': albumJob({ state: 'queued' }) })].map((c) => [c.headline, c.sub, c.path, c.acts]),
      [['Queued', 'Waiting for a free slot · starts automatically', into, ['ghost Cancel']]]);
    const copying = withJobs(vm, { 'federation-copy@album': albumJob({ state: 'running', progress: 0.43, statusText: '1 of 3 songs · 0.2 MB · 1.2 of 8.4 MB' }) });
    assert.deepEqual([copying.headline, copying.pct, copying.sub, copying.progress, copying.path], ['Copying', 43, '1 of 3 songs · 0.2 MB · 1.2 of 8.4 MB', 43, into]);
    const stopping = withJobs(vm, { 'federation-copy@album': albumJob({ state: 'running', progress: 0.43, statusText: '1 of 3 songs · 0.2 MB', cancelRequested: true }) });
    assert.deepEqual([stopping.headline, stopping.pct, stopping.progress, stopping.acts], ['Stopping…', null, 43, []]);
  });

  test('A7 in your collection: Show in your library, Play your copy · A8 with failures: "Retry takes only the gaps", Play steps down, Retry is the gold one', async () => {
    const { vm } = await album();
    assert.deepEqual(withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES.slice(0, 2), owned: [TAPES[2]] }) }) }), { state: 'kept', kind: 'state',
      tile: 'check ok', headline: 'In your collection', tone: 'ok', pct: null, sub: '2 songs copied · 1 already yours', muted: '', progress: null,
      path: 'In copies › Boukmanflow › Borrowed Tapes', retry: null, acts: ['ghost Show in your library', 'primary Play your copy'], line: '' });
    const gaps = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES.slice(0, 2), failed: [TAPES[2]] }) }) });
    assert.deepEqual([gaps.headline, gaps.sub, gaps.muted, gaps.acts], ['In your collection', '2 songs copied · 1 failed', 'Retry takes only the gaps', ['secondary Play your copy', 'primary Retry']]);
  });

  test('A9 settled by this server\'s finished artist copy: the album\'s own account, attributed — every album, or only the missing ones', async () => {
    const { vm } = await album();
    const walk = (scope) => artistResult(scope, [{ ...walkAlbum('Borrowed Tapes'), songs: albumResult({ copied: TAPES.slice(0, 2), owned: [TAPES[2]] }).songs }]);
    const every = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: walk('artist') }) });
    assert.deepEqual([every.state, every.sub, every.path, every.acts], ['kept', '2 songs copied · 1 already yours · with your copy of every album by Boukmanflow',
      'In copies › Boukmanflow › Borrowed Tapes', ['ghost Show in your library', 'primary Play your copy']]);
    assert.equal(withJobs(vm, { 'federation-copy@artist-missing': artistJob('artist-missing', { result: walk('artist-missing') }) }).sub,
      '2 songs copied · 1 already yours · with your copy of Boukmanflow’s missing albums');
  });

  test('A10 already yours: "You have it all · 3 already yours", In the owned files\' folder, Show and Play them', async () => {
    const { vm } = await album();
    const v = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ owned: TAPES }) }) });
    assert.deepEqual([v.state, v.tile, v.headline, v.tone, v.sub, v.path, v.acts], ['yours', 'check grey', 'Already yours', 'n', 'You have it all · 3 already yours',
      'In music › Boukmanflow › Harbour Lights', ['ghost Show in your library', 'primary Play your copy']]);
  });

  test('A11–A13 stopped, amber: the peer\'s limit, its load, its going away — "N not copied", Retry takes only the gaps', async () => {
    const { vm } = await album();
    const stopped = (why) => withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: [TAPES[0]], failed: [TAPES[1]], total: 3, stopped: why }) }) });
    assert.deepEqual(stopped('quota'), { state: 'stopped', kind: 'state', tile: 'warn warn', headline: 'Stage Peer B’s transfer limit stopped it', tone: 'warn', pct: null,
      sub: '1 song copied · 2 not copied · try again later', muted: 'Retry takes only the gaps', progress: null, path: 'In copies › Boukmanflow › Borrowed Tapes', retry: null,
      acts: ['primary Retry'], line: '' });
    assert.deepEqual([stopped('busy').headline, stopped('busy').sub], ['Stage Peer B is serving too many streams right now', '1 song copied · 2 not copied · try again in a moment']);
    assert.deepEqual([stopped('peer').headline, stopped('peer').sub], ['Stage Peer B went away', '1 song copied · 2 not copied']);
  });

  test('A14/A15 refused: its own amber headline, the peer\'s admin named, no Retry and no Add — In where the songs before it landed', async () => {
    const { vm } = await album();
    const none = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ failed: [TAPES[0]], total: 3, stopped: 'refused' }) }) });
    assert.deepEqual(none, { state: 'refused', kind: 'state', tile: 'warn warn', headline: 'Refused by Stage Peer B', tone: 'warn', pct: null,
      sub: 'Stage Peer B does not allow copies with your server’s key', muted: 'Nothing was copied. Playing it still works; only Stage Peer B’s admin can change this.',
      progress: null, path: null, retry: null, acts: [], line: '' });
    const some = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: [TAPES[0]], failed: [TAPES[1]], total: 3, stopped: 'refused' }) }) });
    assert.deepEqual([some.muted, some.path, some.acts], ['1 song copied before it refused. Playing it still works; only Stage Peer B’s admin can change this.', 'In copies › Boukmanflow › Borrowed Tapes', []]);
  });

  test('A16 copied 0 with failures is a failure — never "already yours" · A17 the job threw: the server\'s words · Retry', async () => {
    const { vm } = await album();
    const failed = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ failed: TAPES }) }) });
    assert.deepEqual([failed.state, failed.tile, failed.headline, failed.tone, failed.sub, failed.path, failed.acts], ['failed', 'warn err', 'Copy failed', 'err', 'Nothing was copied · 3 failed', null, ['primary Retry']]);
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ owned: [TAPES[0]], failed: TAPES.slice(1) }) }) }).sub, 'Nothing was copied · 1 already yours · 2 failed');
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ state: 'failed', error: 'Stage Peer B has no songs for “Borrowed Tapes”' }) }).sub, 'Stage Peer B has no songs for “Borrowed Tapes”');
  });

  test('A18/A19 cancelled: what landed and "the rest stay on" the peer, else "Nothing was copied" — "Add again" · A20 nothing to copy: no actions', async () => {
    const { vm } = await album();
    const some = withJobs(vm, { 'federation-copy@album': albumJob({ state: 'cancelled', result: albumResult({ copied: [TAPES[0]], total: 3, stopped: 'cancelled' }) }) });
    assert.deepEqual([some.state, some.tile, some.headline, some.sub, some.path, some.acts], ['cancelled', 'close grey', 'Cancelled', '1 song copied · the rest stay on Stage Peer B',
      'In copies › Boukmanflow › Borrowed Tapes', ['primary Add again']]);
    const none = withJobs(vm, { 'federation-copy@album': albumJob({ state: 'cancelled', result: albumResult({ total: 3, stopped: 'cancelled' }) }) });
    assert.deepEqual([none.sub, none.path, none.acts], ['Nothing was copied', null, ['primary Add again']]);
    const nothing = withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ total: 0 }) }) });
    assert.deepEqual([nothing.state, nothing.tile, nothing.headline, nothing.sub, nothing.acts], ['nothing', 'folder grey', 'Nothing to copy', 'No songs came back to copy', []]);
  });

  test('Retry lands elsewhere: once the saved place moved, "Retry adds to … , your saved place now" — "Add again adds to …" for a cancelled copy', async () => {
    const { vm } = await album();
    vm.discover.dest.view = { destination: MUSIC_DEFAULT };
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: [TAPES[0]], failed: [TAPES[1]], total: 3, stopped: 'quota' }) }) }).retry,
      'Retry adds to music › Boukmanflow › Borrowed Tapes');
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ state: 'cancelled', result: albumResult({ copied: [TAPES[0]], total: 3, stopped: 'cancelled' }) }) }).retry,
      'Add again adds to music › Boukmanflow › Borrowed Tapes');
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES }) }) }).retry, null, 'no Retry, nothing to say');
    vm.discover.dest.view = { destination: { ...KEEP_DEST, base: '/' } };
    assert.equal(withJobs(vm, { 'federation-copy@album': albumJob({ state: 'cancelled', result: null }) }).retry, null, 'the same place, however its base is written');
  });
});

describe('Keep a copy: Artist, every state (vp.js dmKeepView, SPEC §7.3)', () => {
  // the spec's sample: the library has Harbour Lights by name; Stage Peer B
  // has it, Borrowed Tapes and Second Shift
  const artist = async (local = ['Harbour Lights'], { tick = true } = {}) => {
    const w = await keepWindow({ reads: shiftReads(local) });
    w.vm.dmKeepChoose('artist');
    w.vm.discover.modal.keep.onlyMissing = tick;
    return w;
  };

  test('R1 every album: "Add 3 albums", one folder per album · R2 only the missing, one: "Add 1 album", the path names it · R3 two: "Add 2 albums"', async () => {
    const every = (await artist(['Harbour Lights'], { tick: false })).vm;
    assert.deepEqual([every.dmKeepScope(), card(every.dmKeepView()).acts, pathLine(every.dmDestPath(every.dmKeepScope()))], ['artist', ['primary Add 3 albums'], 'copies › Boukmanflow › one folder per album']);
    const one = (await artist(['Harbour Lights', 'Borrowed Tapes'])).vm;
    assert.deepEqual([one.dmKeepScope(), one.dmKeepMissingLabel(), card(one.dmKeepView()).acts, pathLine(one.dmDestPath(one.dmKeepScope()))],
      ['artist-missing', 'Only the 1 album you don’t have', ['primary Add 1 album'], 'copies › Boukmanflow › Second Shift']);
    const two = (await artist()).vm;
    assert.deepEqual([two.dmKeepMissingLabel(), card(two.dmKeepView()).acts], ['Only the 2 albums you don’t have', ['primary Add 2 albums']]);
  });

  test('before the listings answer: "Add every album"; a held only-missing job with no count: "Add the missing albums"', async () => {
    const { vm } = await keepWindow({ reads: readsOf({ albumSongs: songsOf(3) }) });
    vm.dmKeepChoose('artist');
    assert.deepEqual([vm.dmKeepScope(), card(vm.dmKeepView()).acts], ['artist', ['primary Add every album']]);
    assert.equal(vm.dmKeepChoices().find((c) => c.scope === 'artist').sub, '', 'a blank sub holds the strip\'s height');
    vm.discover.modal.jobRefusals = { 'federation-copy@artist-missing': { status: 409, error: 'destination_changed' } };
    vm.discover.modal.jobErrors = { 'federation-copy@artist-missing': 'Where files land changed since this window opened. Check the path above and add again.' };
    assert.deepEqual([vm.dmKeepMissingChoice(), vm.dmKeepMissingLabel(), card(vm.dmKeepView()).acts], [true, 'Only the albums you don’t have', ['primary Add the missing albums']]);
  });

  test('R4 copying: the server\'s line, Into the artist\'s folder, one folder per album', async () => {
    const { vm } = await artist();
    const v = withJobs(vm, { 'federation-copy@artist-missing': artistJob('artist-missing', { state: 'running', progress: 0.38, statusText: 'album 2 of 3 · Second Shift · 1 of 3 songs · 1.1 MB' }) });
    assert.deepEqual([v.headline, v.pct, v.sub, v.path], ['Copying', 38, 'Album 2 of 3 · Second Shift · 1 of 3 songs · 1.1 MB', 'Into copies › Boukmanflow › one folder per album']);
  });

  test('R5 in your collection: In the folder the copies share, Show in your library — an artist has no Play · R6 with failures: Retry beside it', async () => {
    const { vm } = await artist(['Harbour Lights'], { tick: false });
    const albums = [walkAlbum('Borrowed Tapes', { copied: 3 }), walkAlbum('Harbour Lights', { copied: 2, owned: 1 }), walkAlbum('Second Shift', { copied: 3 })];
    assert.deepEqual(withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', albums) }) }), { state: 'kept', kind: 'state', tile: 'check ok',
      headline: 'In your collection', tone: 'ok', pct: null, sub: '3 albums · 8 songs copied · 1 already yours', muted: '', progress: null, path: 'In copies › Boukmanflow', retry: null,
      acts: ['ghost Show in your library'], line: '' });
    const gaps = [walkAlbum('Borrowed Tapes', { copied: 3 }), walkAlbum('Harbour Lights', { copied: 1, failed: 1 }), walkAlbum('Second Shift', { copied: 3 })];
    const v = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', gaps) }) });
    assert.deepEqual([v.sub, v.muted, v.acts], ['3 albums · 7 songs copied · 1 failed', 'Retry takes only the gaps', ['ghost Show in your library', 'primary Retry']]);
  });

  test('R7 already yours, every album left out as owned: no path, nothing to do · R8 nothing of theirs: they only appear there', async () => {
    const { vm } = await artist(['Harbour Lights'], { tick: false });
    const left = [{ name: 'Borrowed Tapes', year: 2019, trackCount: 3, why: 'owned' }, { name: 'Second Shift', year: 2021, trackCount: 3, why: 'owned' }];
    const yours = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [], { skippedAlbums: left }) }) });
    assert.deepEqual([yours.state, yours.headline, yours.sub, yours.path, yours.acts], ['yours', 'Already yours', 'You have it all · 2 albums left out', null, []]);
    const guest = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [], { skippedAlbums: [{ name: 'Night Market Sampler', year: 2024, trackCount: 3, why: 'appearance' }] }) }) });
    assert.deepEqual([guest.state, guest.headline, guest.sub, guest.acts], ['nothing', 'Nothing to copy', 'Nothing of theirs to copy · they only appear on 1 album there', []]);
  });

  test('R9 the checkbox gone (nothing missing now) and the newer copy only-missing: the Artist choice still shows it — "your copy of the albums you didn\'t have"', async () => {
    const { vm } = await artist(['Harbour Lights', 'Borrowed Tapes', 'Second Shift'], { tick: false });
    const missing = artistJob('artist-missing', { id: 95, result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 2 })]) });
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': missing };
    assert.deepEqual([vm.dmKeepMissingChoice(), vm.dmKeepScope()], [false, 'artist-missing']);
    const v = card(vm.dmKeepView());
    assert.deepEqual([v.headline, v.sub, v.path, v.acts], ['In your collection', '1 album · 2 songs copied · your copy of the albums you didn’t have',
      'In copies › Boukmanflow › Second Shift', ['ghost Show in your library']]);
    // a plain artist copy made later is the record instead; another server's never is
    vm.discover.modal.jobs['federation-copy@artist'] = artistJob('artist', { id: 96, result: artistResult('artist', [walkAlbum('Borrowed Tapes', { copied: 3 })]) });
    assert.deepEqual([vm.dmKeepScope(), card(vm.dmKeepView()).sub], ['artist', '1 album · 3 songs copied']);
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': { ...missing, recommendation: tapesRow(STAGE_C, LATE) } };
    assert.equal(vm.dmKeepScope(), 'artist');
  });

  test('R10 a listing failed and nothing came: "Copy failed", the box kept · R11 stopped by the limit: no "not copied" for a walk · R12 cancelled', async () => {
    const { vm } = await artist();
    const listing = artistJob('artist-missing', { result: artistResult('artist-missing', [walkAlbum('Second Shift', { error: 'Stage Peer B answered 500' })]) });
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': listing };
    assert.deepEqual([vm.dmKeepMissingChoice(), card(vm.dmKeepView()).sub, card(vm.dmKeepView()).acts], [true, 'Nothing was copied · 1 album could not be listed', ['primary Retry']]);
    const quota = withJobs(vm, { 'federation-copy@artist-missing': artistJob('artist-missing', { result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 4, failed: 1 })], { stopped: 'quota' }) }) });
    assert.deepEqual([quota.headline, quota.sub, quota.muted], ['Stage Peer B’s transfer limit stopped it', '1 album · 4 songs copied · try again later', 'Retry takes only the gaps']);
    const cancelled = withJobs(vm, { 'federation-copy@artist-missing': artistJob('artist-missing', { state: 'cancelled', result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 3 })], { stopped: 'cancelled' }) }) });
    assert.deepEqual([cancelled.headline, cancelled.sub, cancelled.acts], ['Cancelled', '1 album · 3 songs copied · the rest stay on Stage Peer B', ['primary Add again']]);
  });
});

describe('Keep a copy: another server\'s live copy (vp.js dmKeepView, SPEC §7.4)', () => {
  test('O1 queued · O2 copying 60% · O3 stopping: grey, "Cancel that copy", this server\'s Add back once it ends (O4)', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    const theirs = (over) => albumJob({ id: 93, recommendation: tapesRow(STAGE_C, '01 - Rooftop Cypher'), ...over });
    assert.deepEqual(withJobs(vm, { 'federation-copy@album': theirs({ state: 'queued' }) }), { state: 'queued', kind: 'state', tile: 'clock grey', headline: 'Queued from Stage Peer C', tone: 'n',
      pct: null, sub: 'Waiting for a free slot · starts automatically', muted: 'Add from Stage Peer B returns when that copy ends', progress: null,
      path: 'Into copies › Boukmanflow › Borrowed Tapes', retry: null, acts: ['ghost Cancel that copy'], line: '' });
    const copying = withJobs(vm, { 'federation-copy@album': theirs({ state: 'running', progress: 0.6, statusText: '0 of 1 songs · 0.0 MB · 0.5 of 0.8 MB' }) });
    assert.deepEqual([copying.tile, copying.headline, copying.pct, copying.progress, copying.muted, copying.acts],
      ['download grey', 'Copying from Stage Peer C', 60, 60, 'Add from Stage Peer B returns when that copy ends', ['ghost Cancel that copy']]);
    assert.deepEqual(vm.dmKeepView().other, { id: 4, name: 'Stage Peer C' }, 'drawn grey: its % and its fill in --other');
    const stopping = withJobs(vm, { 'federation-copy@album': theirs({ state: 'running', progress: 0.6, statusText: '0 of 1 songs · 0.0 MB', cancelRequested: true }) });
    assert.deepEqual([stopping.headline, stopping.sub, stopping.muted, stopping.progress, stopping.acts], ['Stopping…', 'Stage Peer C’s copy · 0 of 1 songs · 0.0 MB', '', 60, []]);
    assert.deepEqual(withJobs(vm, { 'federation-copy@album': theirs({ result: albumResult({ copied: TAPES, peer: STAGE_C }) }) }).acts, ['primary Add album · 3 songs'], 'O4: this server\'s own state again');
  });

  test('a song from another server is the recording: live it is theirs to cancel, and no "Add returns" line (it stays once it ended)', async () => {
    const { vm } = await keepWindow();
    const v = withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0.2, statusText: '0.2 of 1.0 MB', recommendation: tapesRow(STAGE_C, LATE) }) });
    assert.deepEqual([v.headline, v.muted, v.acts], ['Copying from Stage Peer C', '', ['ghost Cancel that copy']]);
  });
});

describe('Keep a copy: the header hint and the live region (SPEC §7.5)', () => {
  test('"You can close this window — it keeps going" while a copy the card or a segment shows is queued, copying or stopping', async () => {
    const { vm } = await keepWindow();
    assert.equal(vm.dmKeepHint(), false);
    for (const job of [keepJob({ state: 'queued' }), keepJob({ state: 'running', progress: 0.1 }), keepJob({ state: 'running', cancelRequested: true })]) {
      vm.discover.modal.jobs = { 'federation-copy': job };
      assert.equal(vm.dmKeepHint(), true, job.state);
    }
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'running', progress: 0.43 }) };
    assert.equal(vm.dmKeepHint(), true, 'the Album segment\'s copy, while This song is chosen');
    vm.discover.modal.jobs = { 'federation-copy': keepJob({ result: { copied: { filepath: inCopies(LATE) } } }) };
    assert.equal(vm.dmKeepHint(), false);
  });

  test('the headline is the live region: the headline alone while it runs (the % is the bar\'s), "headline, sub" once it is over', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    const say = (job) => { vm.discover.modal.jobs = { 'federation-copy@album': job }; const v = vm.dmKeepView(); return [v.status, v.progressText]; };
    assert.deepEqual(say(albumJob({ state: 'queued' })), ['Queued', '']);
    assert.deepEqual(say(albumJob({ state: 'running', progress: 0.43, statusText: '2 of 3 songs · 0.4 MB' })), ['Copying', '43%, 2 of 3 songs · 0.4 MB']);
    assert.deepEqual(say(albumJob({ state: 'running', progress: 0.44, statusText: '2 of 3 songs · 0.5 MB' })), ['Copying', '44%, 2 of 3 songs · 0.5 MB'], 'the same words while the % moves');
    assert.deepEqual(say(albumJob({ result: albumResult({ copied: TAPES.slice(0, 2) }) })), ['In your collection, 2 songs copied', '']);
    assert.deepEqual(say(albumJob({ state: 'failed', error: 'Stage Peer B is unreachable' })), ['Copy failed, Stage Peer B is unreachable', '']);
  });
});

describe('Keep a copy: starts that do not go through, rights lost while open (SPEC §8)', () => {
  const refuse = (vm, slot, status, error, line) => {
    vm.discover.modal.jobRefusals = { [slot]: { status, error } };
    vm.discover.modal.jobErrors = { [slot]: line || error || 'The server did not take that — try again' };
    return card(vm.dmKeepView());
  };

  test('X1 429 · X2 409 someone else · X4 no answer or a 400: the bar stays, the line says why, Try again takes Add\'s place; pressed, it starts again', async () => {
    const { vm, starts } = await keepWindow();
    assert.deepEqual(refuse(vm, 'federation-copy', 429, 'you have 20 jobs queued or running — wait for some to finish (the limit is 20)'), { state: 'refusedStart', kind: 'refused',
      tile: null, headline: '', tone: 'n', pct: null, sub: '', muted: '', progress: null, path: null, retry: null, acts: ['ghost Try again'],
      line: 'Too many copies and downloads are waiting or running on your account. Try again when some finish.' });
    assert.equal(refuse(vm, 'federation-copy', 409, 'someone else on this server is already getting this — try again in a moment').line,
      'Someone else on this server is already getting this. Try again in a moment.');
    assert.equal(refuse(vm, 'federation-copy', 0, '').line, 'The server did not take that — try again');
    assert.equal(refuse(vm, 'federation-copy', 400, 'a album job needs the recommendation\'s album').line, 'The server did not take that — try again');
    vm.dmKeepAct('tryAgain');
    assert.deepEqual(starts, [{ plugin: 'federation-copy', choice: undefined, scope: undefined }]);
  });

  test('X3 the destination changed: the line, and Add itself (the bar already shows the new place) — a refusal outranks a finished job, never a live one', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    const changed = refuse(vm, 'federation-copy@album', 409, 'destination_changed', 'Where files land changed since this window opened. Check the path above and add again.');
    assert.deepEqual([changed.kind, changed.line, changed.acts], ['refused', 'Where files land changed since this window opened. Check the path above and add again.', ['primary Add album · 3 songs']]);
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ failed: TAPES }) }) };
    assert.equal(card(vm.dmKeepView()).kind, 'refused', 'a Retry the server refused: its line');
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'running', progress: 0.1 }) };
    assert.equal(card(vm.dmKeepView()).state, 'copying', 'a copy running after all is the card');
  });

  test('X5 "Uploading Disabled" or the destination gone · X6 jobs not allowed · X7 the plug-in off: the card holds one plain line', async () => {
    const { vm } = await keepWindow();
    const lost = (status, error) => { refuse(vm, 'federation-copy@album', status, error); return [vm.dmKeepLost(), card(vm.dmKeepView()).kind, card(vm.dmKeepView()).line]; };
    assert.deepEqual(lost(403, 'Uploading Disabled'), ['upload', 'lost', 'Your account can’t add files to this server, so copies are off.']);
    assert.deepEqual(lost(403, 'you are not allowed to start discovery jobs on this server'), ['jobs', 'lost', 'Your account can’t start copies on this server.']);
    assert.deepEqual(lost(404, 'unknown discovery plug-in'), ['off', 'lost', 'Copies from connected servers are off on this server right now.']);
    // another plug-in's refusal is Get it's, not Keep's
    vm.discover.modal.jobRefusals = { youtube: { status: 403, error: 'Uploading Disabled' } };
    assert.equal(vm.dmKeepLost(), '');
    // the destination read again found none: the choices go, the section keeps its place
    vm.discover.modal.jobRefusals = {};
    vm.discover.dest.view = { destination: null };
    vm.discover.modal.destLost = true;
    assert.deepEqual([vm.dmKeepChoices(), vm.dmKeepShown(), vm.dmKeepLost()], [[], true, 'upload']);
    // at open, or with no copy plug-in to lose, the section is simply not there
    vm.discover.plugins.list = [];
    assert.deepEqual([vm.dmKeepShown(), vm.dmKeepLost()], [false, '']);
  });
});

describe('Keep a copy: the choice strip\'s markers (vp.js dmKeepSegments, SPEC §6.3)', () => {
  const marks = (vm) => vm.dmKeepSegments().map((s) => [s.scope, s.marker ? `${s.marker.glyph} ${s.marker.tone}` : null, s.sub, s.marker ? s.marker.wordTone : null]);

  test('a segment not chosen with a state of its own: its marker and its word in the sub\'s place, its radio\'s name says it; the chosen one never', async () => {
    const { vm } = await keepWindow();
    const album = (job) => { vm.discover.modal.jobs = { 'federation-copy@album': job }; return marks(vm)[1]; };
    assert.deepEqual(marks(vm), [['song', null, '3:41 · mp3', null], ['album', null, '3 songs', null], ['artist', null, 'Boukmanflow · 1 album', null]]);
    assert.deepEqual(album(albumJob({ state: 'queued' })), ['album', 'clock t3', 'Queued', 't3']);
    assert.deepEqual(album(albumJob({ state: 'running', progress: 0.43 })), ['album', 'dot src', 'Copying · 43%', 'src']);
    assert.equal(vm.dmKeepSegments()[1].aria, 'Album: Borrowed Tapes, 3 songs, copying, 43%');
    assert.deepEqual(album(albumJob({ state: 'running', progress: 0.43, cancelRequested: true })), ['album', 'dot src', 'Stopping…', 't3']);
    assert.equal(vm.dmKeepSegments()[1].aria, 'Album: Borrowed Tapes, 3 songs, stopping');
    assert.deepEqual(album(albumJob({ state: 'running', progress: 0.2, recommendation: tapesRow(STAGE_C, 'x') })), ['album', 'dot other', 'Copying from Stage Peer C', 't3']);
    assert.deepEqual(album(albumJob({ result: albumResult({ copied: TAPES }) })), ['album', 'check ok', 'In your collection', 'ok']);
    assert.equal(vm.dmKeepSegments()[1].aria, 'Album: Borrowed Tapes, 3 songs, in your collection');
    assert.deepEqual(album(albumJob({ result: albumResult({ owned: TAPES }) })), ['album', 'check t3', 'Already yours', 't3']);
    assert.deepEqual(album(albumJob({ result: albumResult({ copied: [TAPES[0]], failed: [TAPES[1]], total: 3, stopped: 'busy' }) })), ['album', 'warn warn', 'Stopped', 'warn']);
    assert.deepEqual(album(albumJob({ result: albumResult({ failed: [TAPES[0]], total: 3, stopped: 'refused' }) })), ['album', 'warn warn', 'Refused', 'warn']);
    assert.deepEqual(album(albumJob({ result: albumResult({ failed: TAPES }) })), ['album', 'warn errt', 'Copy failed', 'errt']);
    // none for a cancelled copy, nothing to copy, a refused start
    assert.deepEqual(album(albumJob({ state: 'cancelled', result: null })), ['album', null, '3 songs', null]);
    assert.deepEqual(album(albumJob({ result: albumResult({ total: 0 }) })), ['album', null, '3 songs', null]);
    // chosen: its plain sub — the card below says the state, once
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES }) }) };
    vm.dmKeepChoose('album');
    assert.deepEqual(marks(vm)[1], ['album', null, '3 songs', null]);
    // This song skipped, seen from the Album choice
    vm.discover.modal.jobs = { 'federation-copy': keepJob({ result: { skipped: 'exists', filepath: inCopies(LATE) } }) };
    assert.deepEqual(marks(vm)[0], ['song', 'warn warn', 'Skipped', 'warn']);
  });

  test('the Artist segment speaks for the newer of this server\'s artist copies, every album or only the missing', async () => {
    const { vm } = await keepWindow({ reads: shiftReads(['Harbour Lights']) });
    const kept = artistJob('artist', { id: 92, result: artistResult('artist', [walkAlbum('Second Shift', { copied: 3 })]) });
    const failed = artistJob('artist-missing', { id: 95, state: 'failed', error: 'Stage Peer B is unreachable' });
    vm.discover.modal.jobs = { 'federation-copy@artist': kept, 'federation-copy@artist-missing': failed };
    assert.deepEqual(marks(vm)[2], ['artist', 'warn errt', 'Copy failed', 'errt']);
    vm.discover.modal.jobs = { 'federation-copy@artist': { ...kept, id: 97 }, 'federation-copy@artist-missing': failed };
    assert.deepEqual(marks(vm)[2], ['artist', 'check ok', 'In your collection', 'ok']);
    // the walk took Borrowed Tapes: the Album segment is checked too (A9's borrowed view)
    vm.discover.modal.jobs = { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [{ ...walkAlbum('Borrowed Tapes'), songs: albumResult({ copied: TAPES }).songs }]) }) };
    assert.deepEqual(marks(vm).slice(1), [['album', 'check ok', 'In your collection', 'ok'], ['artist', 'check ok', 'In your collection', 'ok']]);
    // another server's live copy, and only that
    vm.discover.modal.jobs = { 'federation-copy@artist-missing': artistJob('artist-missing', { state: 'running', progress: 0.4, recommendation: tapesRow(STAGE_C, LATE) }) };
    assert.deepEqual(marks(vm)[2], ['artist', 'dot other', 'Copying from Stage Peer C', 't3']);
  });

  test('the radios\' names say what each copies, each first word its drawn label: "This song: …", "Album: …, 3 songs", "Artist: every album by …, 1 album" — before the listings answer, without a count', async () => {
    const { vm } = await keepWindow();
    assert.deepEqual(vm.dmKeepSegments().map((s) => s.aria), ['This song: 02 - Late Train Verse', 'Album: Borrowed Tapes, 3 songs', 'Artist: every album by Boukmanflow, 1 album']);
    for (const seg of vm.dmKeepSegments()) { assert.ok(seg.aria.startsWith(`${seg.label}:`), `"${seg.aria}" starts with its label (WCAG 2.5.3)`); }
    vm.discover.modal.album = null;
    vm.discover.modal.artist = null;
    assert.deepEqual(vm.dmKeepSegments().map((s) => [s.sub, s.aria]), [['3:41 · mp3', 'This song: 02 - Late Train Verse'], ['', 'Album: Borrowed Tapes'], ['', 'Artist: every album by Boukmanflow']]);
  });
});

describe('Keep a copy: what its buttons do (vp.js dmKeepAct)', () => {
  test('Play your copy: the song next, now; an album\'s copied files in the queue\'s place (already yours: the owned ones) — the window closes', async () => {
    const song = await keepWindow();
    song.vm.discover.modal.jobs = { 'federation-copy': keepJob({ result: { copied: { filepath: inCopies(LATE) } } }) };
    song.vm.dmKeepAct('play');
    assert.deepEqual(song.queued, [[inCopies(LATE), {}, true, 1]]);
    assert.equal(song.vm.discover.modal.open, false);

    const album = await keepWindow({ focus: 'album' });
    album.vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES.slice(0, 2), failed: [TAPES[2]] }) }) };
    album.vm.dmKeepAct('play');
    assert.deepEqual(album.queued, ['cleared', [inCopies(TAPES[0]), {}, true, undefined, false, false], [inCopies(TAPES[1]), {}, true, undefined, false, true]], 'the first plays, the rest follow');
    const owned = await keepWindow({ focus: 'album' });
    owned.vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ owned: TAPES }) }) };
    assert.deepEqual(owned.vm.dmKeepView().files, TAPES.map((t) => `music/Boukmanflow/Harbour Lights/${t}.mp3`));
    // the lists stop at 500: what is listed plays
    const capped = albumResult({ copied: TAPES });
    capped.counts = { ...capped.counts, total: 900, copied: 900 };
    owned.vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: capped }) };
    assert.equal(owned.vm.dmKeepView().files.length, 3);
  });

  test('Show in your library: the file explorer on the folder the files share; Queue appends and says so; an artist\'s copy has no Play', async () => {
    const album = await keepWindow({ focus: 'album' });
    album.vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES }) }) };
    album.vm.dmKeepAct('show');
    assert.deepEqual([album.explored, album.vm.discover.modal.open], [[['copies', 'Boukmanflow', 'Borrowed Tapes']], false]);
    const song = await keepWindow();
    song.vm.discover.modal.jobs = { 'federation-copy': keepJob({ result: { copied: { filepath: inCopies(LATE) } } }) };
    song.vm.dmKeepAct('queue');
    assert.deepEqual([song.queued, song.toasts.map((x) => x.title), song.vm.discover.modal.open], [[[inCopies(LATE), {}, true, undefined, false, true]], ['Added to the queue'], true]);
    const artist = await keepWindow();
    artist.vm.dmKeepChoose('artist');
    artist.vm.discover.modal.keep.onlyMissing = false;
    artist.vm.discover.modal.jobs = { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [walkAlbum('Borrowed Tapes', { copied: 3 })]) }) };
    assert.deepEqual(artist.vm.dmKeepView().actions.map((a) => a.id), ['show']);
    artist.vm.dmKeepAct('play');
    assert.deepEqual(artist.queued, [], 'no Play to press');
  });

  test('Cancel and "Cancel that copy" cancel the copy shown; Change… opens the editor; Retry and Add again start the choice\'s scope; a dimmed button does nothing', async () => {
    const { vm, cancels, starts, loads } = await keepWindow({ focus: 'album' });
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ id: 31, state: 'running' }) };
    await vm.dmKeepAct('cancel');
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ id: 32, state: 'queued', recommendation: tapesRow(STAGE_C, 'x') }) };
    await vm.dmKeepAct('cancelOther');
    assert.deepEqual(cancels, [31, 32]);
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'cancelled', result: null }) };
    vm.dmKeepAct('addAgain');
    vm.discover.modal.jobs = { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [{ ...walkAlbum('Borrowed Tapes'), songs: albumResult({ copied: [TAPES[0]], failed: TAPES.slice(1) }).songs }]) }) };
    assert.equal(vm.dmKeepView().borrowed, 'artist');
    vm.dmKeepAct('retry');
    assert.deepEqual(starts.map((s) => s.scope), ['album', 'album'], 'a Retry on the artist walk\'s view of the album runs the album copy');
    vm.discover.modal.jobBusy = { 'federation-copy@album': true };
    vm.dmKeepAct('retry');
    assert.equal(starts.length, 2, 'aria-disabled: a no-op');
    const song = await keepWindow();
    song.vm.discover.modal.jobs = { 'federation-copy': keepJob({ result: { skipped: 'exists', filepath: inCopies(LATE) } }) };
    song.vm.dmKeepAct('change');
    assert.ok(song.loads.includes('picker'));
    assert.ok(!loads.includes('picker'));
  });
});

describe('Keep a copy: the markup (index.html, vp.js dm-keep-body) and its words (en.json)', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const keepHtml = HTML.slice(HTML.indexOf('<section v-if="dmKeepShown()"'), HTML.indexOf('</section>', HTML.indexOf('<section v-if="dmKeepShown()"')));
  const BODY = VP_SRC.slice(VP_SRC.indexOf('Vue.component(\'dm-keep-body\''), VP_SRC.indexOf('const playlistVue = new Vue('));

  test('the section: an h3 label and the hint; the plain line alone when a right went; one radio group, the radio last in its label; the native checkbox; the body', () => {
    assert.match(keepHtml, /<h3 class="dmodal-label">\{\{ tt\('discover\.modal\.keep'\) \}\}<\/h3><span v-if="dmKeepHint\(\)" class="dmodal-hint">\{\{ tt\('discover\.modal\.getItLiveHint'\) \}\}<\/span>/);
    assert.match(keepHtml, /<div v-if="dmKeepLost\(\)" class="dm-keep-plain"><dm-icon name="info" :size="16"><\/dm-icon><span>/);
    assert.match(keepHtml, /class="dm-segs" role="radiogroup" :aria-label="tt\('discover\.keep\.what'\)"/);
    assert.match(keepHtml, /<label v-for="seg in dmKeepSegments\(\)"[^>]*class="dm-seg"[\s\S]*?<\/span>\s*<input type="radio" name="dm-keep-scope" class="dm-seg-input"[^>]*:aria-label="seg\.aria" v-on:change="dmKeepChoose\(seg\.scope\)">\s*<\/label>/);
    assert.match(keepHtml, /<label v-if="dmKeepMissingChoice\(\)" class="dm-check"><input type="checkbox" v-model="discover\.modal\.keep\.onlyMissing">\{\{ dmKeepMissingLabel\(\) \}\}<\/label>/);
    assert.match(keepHtml, /<dm-keep-body v-if="dmKeepView\(\)" :view="dmKeepView\(\)"><\/dm-keep-body>/);
    assert.ok(!/dm-job-row|dm-choice|role="tab"|javascript:void|<a /.test(keepHtml), 'no job row, no tabs, no anchors');
  });

  test('the body: the bar or the editor, else the outcome — no live region of its own, the bar named by the headline, real buttons, Change… found again by data-dm-change', () => {
    assert.match(BODY, /<dm-dest v-if="view\.bar \|\| \$root\.dmDestEditing\(\)" :scope="view\.scope"><\/dm-dest>\s*<div v-else-if="view\.kind === 'cap'" class="dm-keep-cap">[\s\S]*?<div v-else-if="view\.kind === 'state'" class="dm-out">/);
    assert.match(BODY, /<div id="dm-out-h" class="dm-out-headline" :class="'dm-tone-' \+ view\.tone">\{\{ view\.headline \}\}<\/div>/);
    assert.equal((BODY.match(/role="status"/g) || []).length, 0, 'the section\'s one region speaks (it is mounted before the card first changes)');
    assert.match(BODY, /<span v-if="view\.pct !== null" class="dm-out-pct"/);
    assert.match(BODY, /role="progressbar" aria-labelledby="dm-out-h" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="view\.progress === 'indeterminate' \? null : view\.progress" :aria-valuetext="view\.progressText \|\| null"/);
    assert.match(BODY, /<div v-if="view\.line && view\.kind !== 'cap' && !\$root\.dmDestEditing\(\)" class="dm-keep-line">/, 'the editor takes the refused line\'s place with the bar\'s (a folder\'s cap line is its own block)');
    assert.match(BODY, /<div v-if="view\.actions\.length && !\$root\.dmDestEditing\(\)" class="dm-keep-acts">/);
    assert.match(BODY, /<button v-for="a in view\.actions" :key="a\.id" type="button" class="dm-btn" :class="btnClass\(a\)" :aria-disabled="a\.busy \|\| a\.disabled \? 'true' : null" :data-dm-act="a\.id" :data-dm-change="a\.id === 'change' \? '' : null" v-on:click="\$root\.dmKeepAct\(a\.id\)">/);
    assert.ok(!/<slot name="act">/.test(VP_SRC), 'the bar carries no Add of its own any more');
    // the section's live region: outside every v-if, first in the card, so
    // it is in the page before the first change (§7.5)
    assert.match(keepHtml, /<div class="dm-keep">\s*(?:<!--[\s\S]*?-->\s*)?<div class="dm-sr" role="status">\{\{ dmKeepAnnounce\(\) \}\}<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div v-if="dmKeepLost\(\)"/);
    assert.equal((keepHtml.match(/role="status"/g) || []).length, 1);
    // the drawn segment words are hidden: the radio's own name says them
    assert.match(keepHtml, /<span class="dm-seg-text" aria-hidden="true">/);
  });

  test('en.json: the card\'s words, exactly; the offer-as-title and its idle subs are gone', () => {
    const want = {
      'discover.keep.what': 'What to copy', 'discover.keep.addSong': 'Add this song', 'discover.keep.addLacking': 'Add the songs you lack', 'discover.keep.addEvery': 'Add every album',
      'discover.keep.addMissing': 'Add the missing albums', 'discover.keep.adding': 'Adding…', 'discover.keep.queued': 'Queued', 'discover.keep.copying': 'Copying',
      'discover.keep.stopping': 'Stopping…', 'discover.keep.kept': 'In your collection', 'discover.keep.yours': 'Already yours', 'discover.keep.skipped': 'Skipped',
      'discover.keep.failed': 'Copy failed', 'discover.keep.cancelled': 'Cancelled', 'discover.keep.nothing': 'Nothing to copy', 'discover.keep.done': 'Done',
      'discover.keep.play': 'Play your copy', 'discover.keep.show': 'Show in your library', 'discover.keep.cancelOther': 'Cancel that copy', 'discover.keep.addAgain': 'Add again',
      'discover.keep.tryAgain': 'Try again', 'discover.keep.gaps': 'Retry takes only the gaps', 'discover.keep.haveItAll': 'You have it all',
    };
    for (const [key, text] of Object.entries(want)) { assert.equal(EN[key], text, key); }
    assert.equal(tEn('discover.keep.addAlbum', { count: 1 }), 'Add album · 1 song');
    assert.equal(tEn('discover.keep.addAlbums', { count: 2 }), 'Add 2 albums');
    for (const key of ['addToCollection', 'addToCollectionSub', 'addAlbum', 'addAlbumStart', 'addAlbumSub', 'addAlbumSubNoCount', 'addAlbumSubOwned', 'addArtist', 'addArtistStart',
      'addArtistSub', 'addArtistSubNoCount', 'addMissing', 'addMissingStart', 'addMissingSub', 'addMissingSubNoCount', 'youHave', 'keepAddSong', 'keepAddMissing']) {
      assert.equal(EN[`discover.modal.${key}`], undefined, `discover.modal.${key} is gone`);
      assert.equal(VP_SRC.indexOf(`'discover.modal.${key}'`), -1, `vp.js no longer asks for discover.modal.${key}`);
    }
    // the noise lines stay gone
    assert.ok(!Object.values(EN).some((v) => typeof v === 'string' && /Streams through your server|into your library, as a job/.test(v)));
  });
});

// ── The review of 2026-10-21, against the design of record (SPEC §1–§12):
// each behaviour it fixed, held here ─────────────────────────────────────
describe('Keep a copy: the counts are the artist\'s own albums — never one they only appear on (vp.js)', () => {
  // the spec's sample: Boukmanflow has Borrowed Tapes, Harbour Lights and
  // Second Shift (3 songs each) on Stage Peer B, and appears on Night
  // Market Sampler; the peer's artists-albums listing names all four (V17)
  const sampler = peerAlbumItem('Night Market Sampler', { year: 2024, album_artist: 'Various Artists', artists: ['Various Artists', 'Boukmanflow'], compilation: true });
  const sample = (local) => readsOf({ albumSongs: songsOf(3), localAlbums: local,
    peerAlbums: { albums: [peerAlbumItem('Borrowed Tapes'), peerAlbumItem('Harbour Lights'), peerAlbumItem('Second Shift'), sampler] } });

  test('Listen "3 albums · 9 songs"; Artist "Boukmanflow · 3 albums"; "Add 3 albums" — what the copy takes, not the listing\'s 4', async () => {
    const { vm } = await keepWindow({ reads: sample({ albums: [peerAlbumItem('Harbour Lights')] }) });
    assert.equal(vm.dmArtistFacts(), '3 albums · 9 songs');
    const seg = vm.dmKeepChoices().find((c) => c.scope === 'artist');
    assert.deepEqual([seg.sub, seg.aria], ['Boukmanflow · 3 albums', 'Artist: every album by Boukmanflow, 3 albums']);
    vm.dmKeepChoose('artist');
    vm.discover.modal.keep.onlyMissing = false;
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add 3 albums']);
    vm.discover.modal.keep.onlyMissing = true;
    assert.deepEqual([vm.dmKeepMissingLabel(), card(vm.dmKeepView()).acts], ['Only the 2 albums you don’t have', ['primary Add 2 albums']]);
  });

  test('this library\'s listing unanswered: the peer\'s own count is still known — only what is missing is not', async () => {
    const { vm } = await keepWindow({ reads: sample(null) });
    const a = vm.discover.modal.artist;
    assert.deepEqual([a.theirs, a.theirSongs, a.owned, a.missing, a.local], [3, 9, null, null, null]);
    assert.equal(vm.dmArtistFacts(), '3 albums · 9 songs');
    vm.dmKeepChoose('artist');
    assert.deepEqual([vm.dmKeepScope(), card(vm.dmKeepView()).acts], ['artist', ['primary Add 3 albums']]);
  });
});

describe('Listen in album focus: Add to queue keeps the window open (SPEC §5)', () => {
  test('Add to queue appends the album and says so — the window stays; Play album replaces the queue and closes it', async () => {
    const { vm, fedQueued, toasts } = await keepWindow({ focus: 'album' });
    await vm.dmQueueAlbum(false);
    assert.deepEqual([fedQueued.length, vm.discover.modal.open, toasts.map((x) => x.title)], [3, true, ['3 songs added to the queue']]);
    await vm.dmQueueAlbum(true);
    assert.deepEqual([fedQueued.length, vm.discover.modal.open, toasts.length], [6, false, 1]);
  });
});

describe('Keep a copy: the 2026-10-21 review\'s states (vp.js dmKeepView)', () => {
  test('the one live region: empty while idle; the headline on a transition (never the %); headline and sub once over; a refused start\'s line; a lost right\'s line', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    assert.equal(vm.dmKeepAnnounce(), '');
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'queued' }) };
    assert.equal(vm.dmKeepAnnounce(), 'Queued');
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'running', progress: 0.43, statusText: '1 of 3 songs' }) };
    assert.equal(vm.dmKeepAnnounce(), 'Copying');
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ result: albumResult({ copied: TAPES }) }) };
    assert.equal(vm.dmKeepAnnounce(), 'In your collection, 3 songs copied');
    vm.discover.modal.jobs = {};
    vm.discover.modal.jobRefusals = { 'federation-copy@album': { status: 429, error: 'x' } };
    assert.equal(vm.dmKeepAnnounce(), 'Too many copies and downloads are waiting or running on your account. Try again when some finish.');
    vm.discover.modal.jobRefusals = { 'federation-copy@album': { status: 403, error: 'Uploading Disabled' } };
    assert.equal(vm.dmKeepAnnounce(), 'Your account can’t add files to this server, so copies are off.');
  });

  test('S4: a copy at 0 (its first word, "asking … about the file", before a byte moved) has no % yet — the bar sweeps, the server\'s line stays', async () => {
    const { vm } = await keepWindow();
    const v = withJobs(vm, { 'federation-copy': keepJob({ state: 'running', progress: 0, statusText: 'asking Stage Peer B about the file' }) });
    assert.deepEqual([v.headline, v.pct, v.progress, v.sub], ['Copying', null, 'indeterminate', 'Asking Stage Peer B about the file']);
    assert.equal(vm.dmKeepView().progressText, '');
    vm.dmKeepChoose('album');
    assert.equal(vm.dmKeepSegments()[0].sub, 'Copying', 'its marker names no "0%"');
  });

  test('rule 5: This song refused by the peer (its key may not copy) — amber "Refused by", the admin named, no Retry, no Add; its segment says "Refused"', async () => {
    const { vm } = await keepWindow();
    const refused = keepJob({ result: { stopped: 'refused', peer: STAGE_B, destination: KEEP_DEST } });
    assert.deepEqual(withJobs(vm, { 'federation-copy': refused }), { state: 'refused', kind: 'state', tile: 'warn warn', headline: 'Refused by Stage Peer B', tone: 'warn', pct: null,
      sub: 'Stage Peer B does not allow copies with your server’s key', muted: 'Nothing was copied. Playing it still works; only Stage Peer B’s admin can change this.',
      progress: null, path: null, retry: null, acts: [], line: '' });
    vm.dmKeepChoose('album');
    assert.deepEqual(vm.dmKeepSegments()[0].marker, { glyph: 'warn', tone: 'warn', word: 'Refused', wordTone: 'warn' });
  });

  test('rule 3: another server\'s song is shown in every state, and every state names where it came from', async () => {
    const { vm } = await keepWindow();
    const theirs = (over) => keepJob({ recommendation: tapesRow(STAGE_C, LATE), ...over });
    const sub = (job) => withJobs(vm, { 'federation-copy': job }).sub;
    assert.equal(sub(theirs({ state: 'failed', error: 'Stage Peer C no longer has this file' })), 'From Stage Peer C · Stage Peer C no longer has this file');
    assert.equal(sub(theirs({ state: 'cancelled', result: null })), 'From Stage Peer C · Nothing was copied');
    assert.equal(sub(theirs({ result: { skipped: 'owned', existing: { filepath: 'music/Boukmanflow/Singles/Late.mp3' } } })), 'From Stage Peer C · Your library already has this song · nothing was copied');
    assert.equal(sub(theirs({ result: { skipped: 'exists', filepath: inCopies(LATE) } })), 'From Stage Peer C · A file is already there · nothing was overwritten');
    assert.equal(sub(theirs({ result: {} })), 'From Stage Peer C', 'Done names it too');
    assert.equal(sub(theirs({ result: { copied: { filepath: inCopies(LATE) }, peer: STAGE_C } })), 'Copied from Stage Peer C', 'kept says it its own way');
    const refused = withJobs(vm, { 'federation-copy': theirs({ result: { stopped: 'refused', peer: STAGE_C } }) });
    assert.deepEqual([refused.headline, refused.sub], ['Refused by Stage Peer C', 'Stage Peer C does not allow copies with your server’s key'], 'a refusal names it in its headline');
    assert.equal(sub(keepJob({ state: 'failed', error: 'boom' })), 'boom', 'this server\'s own: no name');
  });

  test('rule 4: an album whose songs were skipped because files sat at their places is Skipped, not "Already yours" — Change…, nothing to play', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    const there = (owned) => {
      const res = albumResult({ owned });
      const rest = TAPES.filter((t) => owned.indexOf(t) === -1);
      res.songs.skipped.push(...rest.map((t) => ({ from: fromPeer(t), why: 'exists', at: inCopies(t) })));
      res.songs.total = 3;
      res.counts = { total: 3, copied: 0, skipped: 3, failed: 0 };
      return albumJob({ result: res });
    };
    assert.deepEqual(withJobs(vm, { 'federation-copy@album': there([]) }), { state: 'skipped', kind: 'state', tile: 'warn warn', headline: 'Skipped', tone: 'warn', pct: null,
      sub: 'A file is already there · nothing was overwritten', muted: '', progress: null, path: 'In copies › Boukmanflow › Borrowed Tapes', retry: null, acts: ['ghost Change…'], line: '' });
    assert.deepEqual(vm.dmKeepView().files, []);
    const mixed = withJobs(vm, { 'federation-copy@album': there([TAPES[0]]) });
    assert.deepEqual([mixed.state, mixed.headline, mixed.acts], ['skipped', 'Skipped', ['ghost Change…']], 'one owned, two in the way: still not all yours');
    assert.equal(withJobs(vm, { 'federation-copy@album': there(TAPES) }).state, 'yours', 'every one owned: Already yours');
    vm.discover.dest.view = { destination: MUSIC_DEFAULT };
    const moved = withJobs(vm, { 'federation-copy@album': there([]) });
    assert.deepEqual([moved.muted, moved.acts, moved.retry], ['Your saved place has changed since.', ['ghost Change…', 'primary Retry'], null]);
  });

  test('R7 every song the walk reached already here: "Already yours", no path, nothing to do (an artist\'s copy has no Play, and copied nothing to show)', async () => {
    const { vm } = await keepWindow({ reads: shiftReads(['Harbour Lights']) });
    vm.dmKeepChoose('artist');
    vm.discover.modal.keep.onlyMissing = false;
    const v = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', [walkAlbum('Harbour Lights', { owned: 3 })]) }) });
    assert.deepEqual([v.state, v.headline, v.sub, v.path, v.acts], ['yours', 'Already yours', 'You have it all · 1 album · 3 already yours', null, []]);
  });

  test('an artist copy in your collection with an album that could not be listed: "Retry takes only the gaps", Retry beside Show', async () => {
    const { vm } = await keepWindow({ reads: shiftReads(['Harbour Lights']) });
    vm.dmKeepChoose('artist');
    vm.discover.modal.keep.onlyMissing = false;
    const albums = [walkAlbum('Borrowed Tapes', { copied: 3 }), walkAlbum('Second Shift', { error: 'Stage Peer B answered 500' })];
    const v = withJobs(vm, { 'federation-copy@artist': artistJob('artist', { result: artistResult('artist', albums) }) });
    assert.deepEqual([v.state, v.sub, v.muted, v.acts], ['kept', '1 album · 3 songs copied · 1 album could not be listed', 'Retry takes only the gaps', ['ghost Show in your library', 'primary Retry']]);
  });

  test('R9\'s "your copy of the albums you didn\'t have" is said of what it copied — not under Already yours or Cancelled', async () => {
    const { vm } = await keepWindow({ reads: shiftReads(['Harbour Lights', 'Borrowed Tapes', 'Second Shift']) });
    vm.dmKeepChoose('artist');
    const say = (over) => withJobs(vm, { 'federation-copy@artist-missing': artistJob('artist-missing', over) }).sub;
    assert.equal(say({ result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 2 })]) }), '1 album · 2 songs copied · your copy of the albums you didn’t have');
    assert.equal(say({ result: artistResult('artist-missing', [], { skippedAlbums: [{ name: 'Second Shift', year: 2021, trackCount: 3, why: 'owned' }] }) }), 'You have it all · 1 album left out');
    assert.equal(say({ state: 'cancelled', result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 2 })], { stopped: 'cancelled' }) }), '1 album · 2 songs copied · the rest stay on Stage Peer B');
    assert.equal(say({ state: 'cancelled', result: null }), 'Nothing was copied');
  });

  test('R9\'s record stands in only when nothing is missing now: with the listings unanswered, or none of the artist\'s albums here, Artist is every album\'s, its Add with it', async () => {
    const missing = artistJob('artist-missing', { id: 95, result: artistResult('artist-missing', [walkAlbum('Second Shift', { copied: 2 })]) });
    const unknown = await keepWindow({ reads: readsOf({ albumSongs: songsOf(3) }) });
    unknown.vm.dmKeepChoose('artist');
    unknown.vm.discover.modal.jobs = { 'federation-copy@artist-missing': missing };
    assert.deepEqual([unknown.vm.dmKeepMissingChoice(), unknown.vm.dmKeepScope(), card(unknown.vm.dmKeepView()).acts], [false, 'artist', ['primary Add every album']]);
    const none = await keepWindow({ reads: shiftReads([]) });
    none.vm.dmKeepChoose('artist');
    none.vm.discover.modal.jobs = { 'federation-copy@artist-missing': missing };
    assert.deepEqual([none.vm.dmKeepMissingChoice(), none.vm.dmKeepScope(), card(none.vm.dmKeepView()).acts], [false, 'artist', ['primary Add 3 albums']]);
  });

  test('another server\'s queued copy reads "Copying from Stage Peer C" on its segment, as a running one does — the block alone says "Queued from"', async () => {
    const { vm } = await keepWindow();
    vm.discover.modal.jobs = { 'federation-copy@album': albumJob({ state: 'queued', recommendation: tapesRow(STAGE_C, 'x') }) };
    const seg = vm.dmKeepSegments()[1];
    assert.deepEqual([seg.marker.glyph, seg.marker.tone, seg.sub, seg.aria], ['dot', 'other', 'Copying from Stage Peer C', 'Album: Borrowed Tapes, 3 songs, copying from Stage Peer C']);
    vm.dmKeepChoose('album');
    assert.equal(card(vm.dmKeepView()).headline, 'Queued from Stage Peer C');
  });

  test('an album credited to its own artist is no compilation: "3 songs", named as the album', async () => {
    const { vm } = await keepWindow({ row: tapesRow(STAGE_B, LATE, { albumArtist: 'boukmanflow ' }) });
    const seg = vm.dmKeepChoices().find((c) => c.scope === 'album');
    assert.deepEqual([vm.dmKeepCompilation(), seg.sub, seg.aria], [false, '3 songs', 'Album: Borrowed Tapes, 3 songs']);
  });
});

describe('Get it in a connected server\'s window (decision 1, 2026-10-21)', () => {
  const YT = { name: 'youtube', title: 'YouTube', capabilities: ['acquire'], scopes: ['song'] };
  const ytJob = (over) => ({ id: 9, plugin: 'youtube', state: 'running', progress: 0.3, statusText: 'downloading', params: {}, recommendation: tapesRow(STAGE_B, LATE), ...over });

  test('while Keep a copy shows, Get it offers nothing — a download this song already has a job for still shows, under no second path bar', async () => {
    const { vm } = await keepWindow({ plugins: [COPY, YT] });
    assert.deepEqual([vm.dmGetItRows(), vm.dmGetItBar()], [[], false]);
    vm.discover.modal.jobs = { youtube: ytJob() };
    assert.deepEqual(vm.dmGetItRows().map((r) => [r.plugin.name, r.row.state, r.row.actions]), [['youtube', 'running', ['cancel']]]);
    assert.equal(vm.dmGetItBar(), false, 'Keep\'s bar says where files land; one editor at a time');
    assert.equal(vm.dmGetItLive(), true, 'Get it\'s hint: its own download is live');
    vm.discover.modal.jobs = { youtube: ytJob({ state: 'failed', progress: null, error: 'x' }), 'federation-copy': keepJob({ state: 'running', progress: 0.2 }) };
    assert.deepEqual([vm.dmGetItLive(), vm.dmKeepHint()], [false, true], 'a live copy is Keep\'s to say, once');
  });

  test('a YouTube job reopened from the strip in a connected server\'s window: its row is there, with its Retry', async () => {
    const { vm } = makeWindow({ reads: STAGE_READS(), plugins: [COPY, YT] });
    const job = ytJob({ state: 'failed', progress: null, error: 'Nothing matched closely enough' });
    await vm.openDiscoverModalForJob(job);
    vm.discover.modal.jobs = { youtube: job };   // what the window's lookup answers
    assert.ok(vm.dmKeepChoices().length > 0, 'Keep a copy shows');
    assert.deepEqual(vm.dmGetItRows().map((r) => [r.plugin.name, r.row.state, r.row.actions]), [['youtube', 'failed', ['retry']]]);
  });

  test('with the copy\'s gate failed, Get it takes Keep\'s place whole — its offers and its bar; a network window as before', async () => {
    const { vm } = await keepWindow({ plugins: [YT] });
    assert.deepEqual([vm.dmKeepChoices(), vm.dmGetItRows().map((r) => r.row.state), vm.dmGetItBar()], [[], ['idle'], true]);
    const lead = makeWindow({ plugins: [COPY, YT] });
    await lead.vm.openDiscoverModal({ title: 'Lead', artist: 'Mo', similarity: 0.5, peer: { endpointId: 'e1' } }, 'p2p', { seedPlain: 'x' });
    assert.deepEqual([lead.vm.dmGetItRows().map((r) => r.plugin.name), lead.vm.dmGetItBar()], [['youtube'], true]);
  });
});

describe('where files land: the 2026-10-21 review (vp.js)', () => {
  test('409 destination_changed redraws the bar from the answer at once — before any read again answers', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    const music = { vpath: 'music', base: '', layout: LAYOUT, source: 'user' };
    w.api.discoveryDestination = () => new Promise(() => {});   // the read again never answers
    w.api.discoveryJobStart = async () => { throw httpError(409, { error: 'destination_changed', destination: music }); };
    await w.vm.dmJobStart(COPY, null, 'album');
    assert.equal(pathLine(w.vm.dmDestPath('album')), 'music › Boukmanflow › Borrowed Tapes');
  });

  test('a window whose own first read finds no destination (the bar drew the last one known) has no Keep a copy — the section hidden, never X5', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    w.server.view = viewOf(null);
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.deepEqual([w.vm.discover.modal.destLost, w.vm.dmKeepLost(), w.vm.dmKeepShown()], [false, '', false]);
  });

  test('a 409 that says there is nowhere now, for an Add pressed before the window\'s own read answered: a right lost while open (X5)', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    let release = null;
    const nowhere = new Promise((resolve) => { release = () => resolve(viewOf(null)); });
    w.api.discoveryDestination = () => nowhere;
    const opening = w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    await flush();
    assert.equal(w.vm.discover.modal.destRead, false, 'the bar draws the last one known');
    w.api.discoveryJobStart = async () => { throw httpError(409, { error: 'destination_changed', destination: null }); };
    await w.vm.dmJobStart(COPY);
    release();
    await opening;
    await flush();
    assert.deepEqual([w.vm.discover.modal.destLost, w.vm.dmKeepLost(), w.vm.dmKeepShown(), card(w.vm.dmKeepView()).line],
      [true, 'upload', true, 'Your account can’t add files to this server, so copies are off.']);
  });

  test('a job pinned to nowhere (null: there was nowhere to put a file) draws no Into line — never the saved place', async () => {
    const { vm } = makeDestWindow();
    await vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    assert.equal(vm.dmJobPath(copyJob({ state: 'queued', params: { scope: 'album', destination: null } })), null);
    assert.equal(jobLine(vm.dmJobPath(copyJob({ state: 'queued', params: { scope: 'album' } }))), 'Into copies › Boukmanflow › Borrowed Tapes', 'no pin at all: the saved place, as before');
  });

  test('under Get it, a moved destination\'s refusal asks to try again — "add again" is Keep\'s', async () => {
    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    w.api.discoveryJobStart = async () => { throw httpError(409, { error: 'destination_changed', destination: COPIES }); };
    await w.vm.dmJobStart({ name: 'youtube' });
    await w.vm.dmJobStart(COPY);
    assert.deepEqual([w.vm.discover.modal.jobErrors.youtube, w.vm.discover.modal.jobErrors['federation-copy']], [
      'Where files land changed since this window opened. Check the path above and try again.',
      'Where files land changed since this window opened. Check the path above and add again.']);
  });

  test('focus that fell out of the window lands on Close when Find elsewhere goes, or the destination is lost while open', async () => {
    const { vm, ticks } = makeWindow({ reads: { ...STAGE_READS(), discoveryPluginResolve: async () => ({ result: { links: [] } }) },
      plugins: [COPY, { name: 'links', title: 'Open elsewhere', capabilities: ['links'] }], realLinks: true });
    await vm.openDiscoverModal(tapesRow(STAGE_B, LATE), 'federation', { focus: 'album', seedPlain: 'x' });
    let closed = 0;
    vm.$refs = { dmodal: { contains: () => false }, dmodalClose: { focus() { closed += 1; } } };
    ticks.splice(0);
    await vm.dmLoadLinks(vm.discover.modal.gen);
    assert.equal(vm.dmFindVisible(), false, 'an answer with no album links: the section goes');
    ticks.splice(0).forEach((f) => f());
    assert.equal(closed, 1);

    const w = makeDestWindow();
    await w.vm.openDiscoverModal(lateTrain(), 'federation', { seedPlain: 'x' });
    let back = 0;
    w.vm.$refs.dmodalClose = { focus() { back += 1; } };
    w.ticks.splice(0);
    w.server.view = viewOf(null);
    await w.vm.dmLoadDestination(w.vm.discover.modal.gen);
    assert.equal(w.vm.discover.modal.destLost, true);
    w.ticks.splice(0).forEach((f) => f());
    assert.equal(back, 1, 'the card became its plain line: the button the keyboard was on went with it');
  });

  test('a poll that moved the card hands the keyboard to nothing that cancels or plays: Change…, the chosen segment, the first other action, else Close', async () => {
    const { vm, ticks } = await keepWindow({ focus: 'album' });
    const asked = [];
    let closed = 0;
    vm.$refs = { dmodal: { contains: () => false, querySelector: (sel) => { asked.push(sel); return null; } }, dmodalClose: { focus() { closed += 1; } } };
    ticks.splice(0);
    vm.dmKeepHold(true);
    ticks.splice(0).forEach((f) => f());
    assert.deepEqual(asked.splice(0), ['.dm-keep [data-dm-change]', '.dm-seg-input:checked', '.dm-land-radio:checked',
      '.dm-keep-acts .dm-btn:not([data-dm-act="cancel"]):not([data-dm-act="cancelOther"]):not([data-dm-act="play"])']);
    assert.equal(closed, 1);
    vm.dmKeepHold();
    ticks.splice(0).forEach((f) => f());
    assert.equal(asked[0], '.dm-keep-acts .dm-btn:last-child', 'a press hands it to the button now in its place');
    assert.match(VP_SRC, /if \(this\.discover\.modal === m\) \{ this\.dmKeepHold\(discoverKeepPresses === 0\); \}/, 'the poll asks the polled way — unless a press is out');
    assert.match(VP_SRC, /discoverKeepPresses \+= 1;\s*try \{ await this\.cancelDiscoverJob\(job\); \} finally \{ discoverKeepPresses -= 1; \}\s*this\.dmKeepHold\(\);/,
      'Cancel → Add again: the press\'s own hand-off, not the poll it set off');
  });

  test('the player\'s hotkeys stay out while a window is open, wherever focus fell (a control it was on went away)', () => {
    const skipWith = (open) => new Function('document', `${vpModuleFn('hotkeysSkip')}\nreturn hotkeysSkip;`)({ querySelector: (sel) => (open && sel === '.dmodal-shadow' ? {} : null) });
    const body = { tagName: 'BODY', closest: () => null };
    assert.equal(skipWith(true)(body), true, 'Space never plays behind the window');
    assert.equal(skipWith(false)(body), false);
  });
});

describe('the window\'s markup and styles after the 2026-10-21 review', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const win = HTML.slice(HTML.indexOf('class="dmodal-shadow"'), HTML.indexOf('id="pop"'));
  const CSS = readFileSync(new URL('../../webapp/alpha/spa.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // every one-line-selector rule of the window's (.dm-*, .dmodal*): selector → bodies
  const rules = [...CSS.matchAll(/(?:^|\n)[ \t]*(\.dm[^{\n]*?)\s*\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const bodyOf = (sel) => rules.filter((r) => r.sel === sel).map((r) => r.body);

  test('every progress bar is named; a failed save is announced and tied to Save', () => {
    const bars = VP_SRC.match(/role="progressbar"[^>]*>/g) || [];
    assert.ok(bars.length >= 3);
    for (const bar of bars) { assert.match(bar, /aria-label(?:ledby)?=/, bar); }
    assert.match(VP_SRC, /<div v-if="picker\.error" id="dm-dest-save-err" class="dm-dest-err" role="alert">/);
    assert.match(VP_SRC, /:aria-describedby="picker\.error \? 'dm-dest-save-err' : null" v-on:click="\$root\.dmPickerSubmit\(\)"/);
  });

  test('the path\'s "›" is drawn, a "/" read; the empty folder\'s head names no count; the meta line\'s "·" travels with its part', () => {
    assert.match(VP_SRC, /<i aria-hidden="true">&rsaquo;<\/i><span class="dm-sr">\/<\/span><template v-if="c\.parts">[\s\S]*?<template v-else>\{\{ c\.text \}\}<\/template>/);
    assert.match(VP_SRC, /!picker\.browse\.failed && picker\.browse\.dirs\.length > 0"><i aria-hidden="true">&middot;<\/i>/);
    assert.match(win, /<span v-for="\(p, i\) in dmMetaParts\(\)" :key="i" class="dmodal-meta-part"><span v-if="i > 0" aria-hidden="true">&middot;<\/span>/);
    assert.match(bodyOf('.dmodal-meta-part')[0], /display: inline-flex/);
  });

  test('Get it\'s path bar is its own (the song\'s), its hint its own rows\' — Keep\'s says it once; Esc reaches the window from the preview tile\'s link', () => {
    assert.match(win, /<dm-dest v-if="dmGetItBar\(\)" scope="song" download><\/dm-dest>/);
    assert.match(win, /<h3 class="dmodal-label">\{\{ tt\('discover\.modal\.getIt'\) \}\}<\/h3><span v-if="dmGetItLive\(\)" class="dmodal-hint">/);
    assert.ok(!/v-on:keydown\.stop(?![.\w])/.test(win), 'no link swallows every key');
    assert.match(win, /v-on:click\.stop v-on:keydown\.enter\.stop v-on:keydown\.space\.stop>/);
  });

  test('spa.css: error text is --errt (--err is never text), every % tabular, no pointer-events: none on a button, no dead .is-disabled', () => {
    for (const r of rules) { assert.ok(!/(?:^|[;\s])color:\s*#e0616a/i.test(r.body), `${r.sel} paints #e0616a as text`); }
    for (const sel of ['.dm-opt-sub-err', '.dm-tag-err', '.dm-opt-ic-err']) { assert.match(bodyOf(sel)[0], /color: var\(--errt\)/, sel); }
    for (const sel of ['.dm-out-pct', '.dm-seg-sub', '.dmodal-meta']) { assert.match(bodyOf(sel)[0], /font-variant-numeric: tabular-nums/, sel); }
    assert.ok(!/\.dm-btn\.is-disabled/.test(CSS));
    for (const r of rules.filter((x) => /^\.dm-btn/.test(x.sel))) { assert.ok(!/pointer-events:\s*none/.test(r.body), r.sel); }
  });

  test('spa.css: the phone sheet sits on the bottom by its auto top margin — a tall one starts at the top and scrolls, never above the screen', () => {
    const phone = CSS.slice(CSS.indexOf('/* Phones: a bottom sheet'), CSS.indexOf('@media (max-width: 480px)', CSS.indexOf('/* Phones: a bottom sheet')));
    assert.match(phone, /\.dmodal-shadow \{ padding: 24px 0 0; align-items: flex-start; \}/);
    assert.match(phone, /\.dmodal \{ width: 100%; margin: auto 0 0; border-radius: 14px 14px 0 0; \}/);
    assert.ok(!/align-items: flex-end/.test(phone));
    assert.match(phone, /\.dm-btn, \.dm-link, \.dm-link:focus, \.dm-chip, \.dm-chip:focus \{ height: 44px; \}/, '44 px targets (the user\'s override of §12)');
    assert.match(phone, /\.dmodal-close \{ top: 6px; right: 6px; width: 44px; height: 44px; \}/);
  });

  test('no dead code, and no comment names the retired tabs or "Add to your collection"', () => {
    assert.ok(!/dmFocusSoon|dmRetryPath/.test(VP_SRC));
    assert.ok(!/Federation view|Add to your collection/.test(VP_SRC));
  });
});

describe('the strip\'s Retry sends the place the copy ran with (vp.js dtRetry)', () => {
  const dtRetry = (api, toasts) => new Function('MSTREAMAPI', 'DISCOVERJOBS', 'iziToast', `return ${vpMethodSrc('dtRetry')}`)(
    api, J, { error: (o) => toasts.push(o) });
  const harness = (view, answer) => {
    const sent = [];
    const toasts = [];
    const reads = [];
    const api = { discoveryJobStart: async (...args) => { sent.push(args); if (answer instanceof Error) { throw answer; } return answer; } };
    const self = {
      discover: { dest: { view } },
      noteDiscoverJob: () => {},
      scheduleDiscoverJobsPoll: () => {},
      dmErrorText: (err) => `words: ${err.message}`,
      dmLoadDestination: () => { reads.push('read'); },
      tt: (k) => tEn(k),
    };
    return { run: (job) => dtRetry(api, toasts).call(self, job), sent, toasts, reads };
  };
  const PIN = { vpath: 'copies', base: '', layout: '{{ALBUMARTIST}}/{{ALBUM}}' };
  const NOW = { vpath: 'copies', base: 'moved', layout: '{{ALBUMARTIST}}/{{ALBUM}}', source: 'user' };
  const job = (over) => ({ plugin: 'federation-copy', recommendation: { title: 'x' }, params: { scope: 'album' }, ...over });

  test('its pin first, else where its result landed, else the place known now, else no key', async () => {
    let h = harness({ destination: NOW }, { job: { id: 9 } });
    await h.run(job({ params: { scope: 'album', destination: PIN } }));
    assert.deepEqual(h.sent[0][4], PIN);
    assert.equal(h.sent[0][3], 'album');
    h = harness({ destination: NOW }, { job: { id: 9 } });
    await h.run(job({ params: { scope: 'album' }, result: { destination: PIN } }));
    assert.deepEqual(h.sent[0][4], PIN, 'a job from before the pin: where its result says it landed');
    h = harness({ destination: NOW }, { job: { id: 9 } });
    await h.run(job({ params: null }));
    assert.deepEqual(h.sent[0][4], NOW, 'nothing on the job: the place known now');
    h = harness(null, { job: { id: 9 } });
    await h.run(job({ params: null }));
    assert.equal(h.sent[0][4], undefined, 'no place known at all: no key, no check');
  });

  test('a 409 destination_changed reads the destination again and toasts its own words; other refusals keep theirs', async () => {
    const moved = Object.assign(new Error('moved'), { status: 409, body: { error: 'destination_changed', destination: NOW } });
    let h = harness({ destination: NOW }, moved);
    await h.run(job({ params: { scope: 'album', destination: PIN } }));
    assert.deepEqual(h.reads, ['read']);
    assert.equal(h.toasts[0].title, tEn('discover.tray.destChanged'));
    const other = Object.assign(new Error('someone else on this server is already getting this'), { status: 409, body: { error: 'someone else on this server is already getting this' } });
    h = harness({ destination: NOW }, other);
    await h.run(job({ params: { scope: 'album', destination: PIN } }));
    assert.deepEqual(h.reads, []);
    assert.equal(h.toasts[0].title, 'words: someone else on this server is already getting this');
  });
});

// ── vp.js: the window entered from a connected server's pages ─────────────
// (SPEC-fed §6, with the user's decisions of 2026-10-23: the mirror keeps
// the layout's leading folders; "Into a folder…" starts as a new folder
// named as the pressed one; the queue row's ⋮ is a way in.) The spec's
// sample: Stage Peer B, its one library "music"; Boukmanflow's own albums
// Borrowed Tapes, Harbour Lights and Second Shift, an appearance on Night
// Market Sampler, songs in no album; this library has Harbour Lights and
// saves copies to "copies" under Artist / Album.
const PEER_BOUK = { albums: [
  peerAlbumItem('Borrowed Tapes'),
  peerAlbumItem('Harbour Lights', { year: 2021, year_min: 2021, year_max: 2021 }),
  peerAlbumItem('Second Shift', { year: 2023, year_min: 2023, year_max: 2023 }),
  peerAlbumItem('Night Market Sampler', { year: 2024, year_min: 2024, year_max: 2024, album_artist: 'Various Artists', artists: ['Color Out', 'Boukmanflow', 'ALM'], compilation: true }),
  { name: null, year: null, album_art_file: null, album_artist: 'Boukmanflow', artists: ['Boukmanflow'], compilation: false, year_min: null, year_max: null, track_count: null },
] };
const LOCAL_HARBOUR = { albums: [peerAlbumItem('Harbour Lights')] };
const TAPES3 = ['01 - Rooftop Cypher', '02 - Late Train Verse', '03 - Corner Store Loop'];
const tapePath = (t, folder = 'Boukmanflow/Borrowed Tapes') => `music/${folder}/${t}.mp3`;
const TAPES_FOLDER = '/music/Boukmanflow/Borrowed Tapes';
// a song's tags as the peer's metadata names them, from its path
const tagsOf = (p, over) => ({ title: p.split('/').pop().replace(/^\d+ - /, '').replace(/\.mp3$/, ''), artist: 'Boukmanflow', 'artist-display': 'Boukmanflow',
  album: p.split('/')[2], year: 2019, duration: 8, format: 'mp3', genres: ['Hip-Hop'], ...over });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
// Stage Peer B as browsing reads it; `asked` records what the window asked
function peerB({ listing = TAPES3.map((t) => tapePath(t)), meta = null, peerAlbums = PEER_BOUK, localAlbums = LOCAL_HARBOUR, albumSongs = songsOf(3), batch = null, scan = null } = {}) {
  const asked = { scans: [], batches: [], metadata: [], albumSongs: [], artistAlbums: [] };
  return { asked, reads: {
    federationPeers: async () => ({ peers: [{ ...STAGE_B, lastSeen: '2026-10-23 09:58:00', lastStatus: 'ok' }] }),
    peer: {
      metadata: async (id, fp) => { asked.metadata.push(fp); return meta ? meta(fp) : { metadata: { format: 'mp3' } }; },
      albumSongs: async (id, q) => { asked.albumSongs.push(q); return albumSongs; },
      artistAlbums: async (id, q) => { asked.artistAlbums.push(q); return peerAlbums; },
      recursiveScan: async (id, dir) => { asked.scans.push(dir); return scan ? scan(dir) : listing; },
      metadataBatch: async (id, paths) => { asked.batches.push(paths); return batch ? batch(paths) : Object.fromEntries(paths.map((p) => [p, { filepath: p, metadata: tagsOf(p) }])); },
    },
    artistAlbums: async () => localAlbums,
  } };
}
// The window over the destination harness, opened from browsing: this
// server's starts and lookups recorded (a folder recommendation answers
// with its own folder key)
async function browseWindow(track, opts, { peer = peerB(), layout = LAYOUT, maxFolderSongs = 1000, wait = true } = {}) {
  const w = makeDestWindow({ reads: peer.reads, server: { view: viewOf({ vpath: 'copies', base: '', layout, source: 'user' }) } });
  w.vm.discover.plugins.maxFolderSongs = maxFolderSongs;
  w.api.currentServer.supportedAudioFiles = { mp3: true, flac: true };
  const starts = [];
  const lookups = [];
  w.api.discoveryJobLookup = async (rec) => { lookups.push(rec); return { key: 'song:k', keys: { song: 'song:k', folder: `folder:${rec.filepath}` }, jobs: [] }; };
  w.api.discoveryJobStart = async (name, rec, choice, scope, destination, landing) => {
    starts.push({ name, rec, scope, destination, landing });
    return { job: { id: 70 + starts.length, plugin: name, key: `${scope}:k`, state: 'queued', params: { scope, landing, destination }, recommendation: rec } };
  };
  const opening = w.vm.openDiscoverModal(track, 'federation', opts);
  if (wait) { await opening; await flush(); }
  return { ...w, asked: peer.asked, starts, lookups, opening };
}
const folderTrack = (path = TAPES_FOLDER, title) => ({ peer: { ...STAGE_B }, filepath: path, title: title || path.split('/').pop() });
const FOLDER_OPTS = { focus: 'folder', scope: 'folder', from: 'browse' };
// a folder copy of this account's, as the jobs route sends it
const folderJob = (over) => ({ id: 95, plugin: 'federation-copy', key: 'folder:bt', state: 'done', progress: null, statusText: null, cancelRequested: false, error: null,
  params: { scope: 'folder', destination: COPIES }, recommendation: { source: 'federation', peer: { ...STAGE_B }, filepath: 'music/Boukmanflow/Borrowed Tapes', title: 'Borrowed Tapes' },
  createdAt: 1000, updatedAt: 1000, finishedAt: 1000, ...over });
const folderResult = ({ copied = [], owned = [], failed = [], landed = 'copies/Boukmanflow/Borrowed Tapes', skippedFiles = [], stopped = null, total } = {}) => {
  const all = total == null ? copied.length + owned.length + failed.length : total;
  return { scope: 'folder', folder: { path: 'music/Boukmanflow/Borrowed Tapes', name: 'Borrowed Tapes', landed }, layout: 'mirror',
    songs: { total: all, copied: copied.map((t) => ({ from: tapePath(t), vpath: 'copies', filepath: `copies/Boukmanflow/Borrowed Tapes/${t}.mp3` })),
      skipped: owned.map((t) => ({ from: tapePath(t), why: 'owned', at: `music/Boukmanflow/Harbour Lights/${t}.mp3` })), failed: failed.map((t) => ({ from: tapePath(t), error: 'x' })) },
    counts: { total: all, copied: copied.length, skipped: owned.length, failed: failed.length }, skippedFiles, stopped, peer: STAGE_B, destination: COPIES };
};
const SLOT_FOLDER = 'federation-copy@folder';

describe('from browsing: album focus — the album page\'s header, a card, a compilation card (SPEC-fed §6.2)', () => {
  const header = { peer: { ...STAGE_B }, album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', year: 2019, albumArt: 'bt.jpg', filepath: null };
  test('the header\'s window: Album chosen, Artist the credit beside it, no View album, no match line', async () => {
    const { vm, lookups } = await browseWindow(header, { focus: 'album', from: 'browse', hide: ['viewAlbum'] });
    const m = vm.discover.modal;
    assert.deepEqual([m.focus, m.from, m.track.artist, m.hide], ['album', 'browse', 'Boukmanflow', ['viewAlbum']], 'Artist is the album\'s credit');
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', '3 songs'], ['artist', 'Boukmanflow · 3 albums']]);
    assert.deepEqual([vm.dmHidden('viewAlbum'), vm.dmHidden('viewArtist')], [true, false]);
    assert.equal(vm.dmKeepStartLabel(), 'Add album · 3 songs');
    assert.equal(pathLine(vm.dmDestPath('album')), 'copies › Boukmanflow › Borrowed Tapes');
    assert.deepEqual(vm.dmMetaParts().map((p) => p.kind), ['status'], 'a browsed item has no similarity: no match line');
    assert.equal(lookups[0].albumArtist, 'Boukmanflow', 'the start and the lookup send the page\'s credit');
  });

  test('a compilation card: Album alone (no strip), whole under its credit, no Listen artist; a card names its own artist; hide keeps only the two links', async () => {
    const comp = { peer: { ...STAGE_B }, album: 'Night Market Sampler', albumArtist: 'Various Artists', artist: null, year: 2024, compilation: true };
    const { vm } = await browseWindow(comp, { focus: 'album', from: 'browse', hide: ['viewArtist', 'viewSomethingElse'] });
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub]), [['album', 'Whole compilation · 3 songs']], 'one choice: no strip');
    assert.equal(vm.discover.modal.track.artist, null, 'no artist fact row, no Artist choice');
    assert.equal(pathLine(vm.dmDestPath('album')), 'copies › Various Artists › Night Market Sampler');
    assert.deepEqual(vm.discover.modal.hide, ['viewArtist']);
    // a card that leaves the artist out: its credit, unless a compilation
    const plain = await browseWindow({ ...comp, artist: undefined, albumArtist: 'Boukmanflow', album: 'Borrowed Tapes', compilation: false }, { focus: 'album', from: 'browse' });
    assert.equal(plain.vm.discover.modal.track.artist, undefined, 'a key it named (even undefined) is the card\'s own');
    const { artist: _drop, ...noKey } = { ...comp };
    const left = await browseWindow(noKey, { focus: 'album', from: 'browse' });
    assert.equal(left.vm.discover.modal.track.artist, null, 'no artist key on a compilation: none');
    const { artist: _drop2, ...noKey2 } = { ...header };
    const own = await browseWindow(noKey2, { focus: 'album', from: 'browse' });
    assert.equal(own.vm.discover.modal.track.artist, 'Boukmanflow');
  });

  test('Discover\'s album window keeps its own: no from, nothing hidden, the row as received', async () => {
    const { vm } = await keepWindow({ focus: 'album' });
    assert.deepEqual([vm.discover.modal.from, vm.discover.modal.hide, vm.discover.modal.folder], [null, [], null]);
  });
});

describe('from browsing: a song names its album\'s credit, or Album waits for one (SPEC-fed §6.1, G8)', () => {
  const genreRow = (over) => ({ peer: { ...STAGE_B }, filepath: tapePath(LATE), title: 'Late Train Verse', artist: 'Boukmanflow', album: 'Borrowed Tapes', year: 2019, duration: 8, ...over });
  test('a genre row with no credit: found in the peer\'s album listing — the one album of that name whose years hold the song\'s — then the album listed by it', async () => {
    const { vm, asked } = await browseWindow(genreRow(), { from: 'browse' });
    assert.equal(vm.discover.modal.track.albumArtist, 'Boukmanflow');
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'album', 'artist']);
    assert.deepEqual(asked.albumSongs.pop(), { album: 'Borrowed Tapes', artist: null, album_artist: 'Boukmanflow', year: 2019 }, 'the album as its credit lists it');
  });

  test('credits that disagree, no match, two matches, the listing not answering: no Album — never the track artist in its place', async () => {
    const split = { albums: [peerAlbumItem('Borrowed Tapes', { album_artist: null })] };
    for (const [peerAlbums, why] of [[split, 'disagree'], [{ albums: [] }, 'no match'], [{ albums: [peerAlbumItem('Borrowed Tapes'), peerAlbumItem('Borrowed Tapes', { year_min: 2018, year_max: 2020 })] }, 'two'], [null, 'no answer']]) {
      const { vm } = await browseWindow(genreRow(), { from: 'browse' }, { peer: peerB({ peerAlbums }) });
      assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'artist'], why);
    }
    // a year outside the album's years is not that album
    const { vm } = await browseWindow(genreRow({ year: 2023 }), { from: 'browse' });
    assert.equal(vm.discover.modal.track.albumArtist, undefined);
  });

  test('the song\'s own album-artist (a server since S2) is the credit; an album page\'s credit wins over both', async () => {
    const meta = (fp) => ({ metadata: tagsOf(fp, { album: 'Night Market Sampler', title: 'Night Market Cypher', 'album-artist': 'Various Artists' }) });
    const { vm } = await browseWindow(genreRow({ album: undefined, title: 'Night Market Cypher' }), { from: 'browse' }, { peer: peerB({ meta, peerAlbums: null }) });
    assert.deepEqual([vm.discover.modal.track.album, vm.discover.modal.track.albumArtist], ['Night Market Sampler', 'Various Artists']);
    assert.ok(vm.dmKeepCompilation(), 'a compilation: Album copies it whole');
    const page = await browseWindow(genreRow({ albumArtist: 'Boukmanflow' }), { from: 'browse', hide: ['viewAlbum'] }, { peer: peerB({ meta: (fp) => ({ metadata: tagsOf(fp, { 'album-artist': 'Somebody Else' }) }) }) });
    assert.equal(page.vm.discover.modal.track.albumArtist, 'Boukmanflow');
  });

  test('the same row on Discover keeps today\'s rule: Album by the track artist when no credit is named', async () => {
    const { vm } = await keepWindow({ row: { ...tapesRow(STAGE_B, LATE), albumArtist: undefined }, reads: readsOf({ albumSongs: songsOf(3), peerAlbums: { albums: [] } }) });
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'album', 'artist']);
  });
});

describe('from browsing: an explorer file row — its tags read into the song (G24), the Folder choice (SPEC-fed §6.3)', () => {
  const fileRow = () => ({ peer: { ...STAGE_B }, filepath: `/${tapePath(LATE)}`, title: `${LATE}.mp3` });
  const FILE_OPTS = { from: 'browse', folder: { path: TAPES_FOLDER, name: 'Borrowed Tapes' } };
  test('before the tags: the file name, no subtitle, This song · Folder; after: the song, Album and Artist appear, Find elsewhere asks, the lookup asks again', async () => {
    const read = deferred();
    const peer = peerB({ meta: () => read.promise });
    const w = await browseWindow(fileRow(), FILE_OPTS, { peer, wait: false });
    await flush();
    const { vm, loads, lookups } = w;
    assert.deepEqual([vm.dmHeadTitle(), vm.dmSubtitle()], [`${LATE}.mp3`, '']);
    assert.deepEqual(vm.dmKeepChoices().map((c) => [c.scope, c.sub, c.aria]), [['song', '', `This song: ${LATE}.mp3`], ['folder', 'Borrowed Tapes', 'Folder: Borrowed Tapes and everything in it']]);
    assert.equal(loads.includes('links'), false, 'Find elsewhere waits for the tags');
    assert.equal(vm.discover.modal.loading, true, '"Looking up…" meanwhile');
    read.resolve({ metadata: tagsOf(tapePath(LATE)) });
    await w.opening;
    await flush();
    assert.deepEqual([vm.dmHeadTitle(), vm.dmSubtitle()], ['Late Train Verse', 'Boukmanflow · Borrowed Tapes · 2019 · 0:08']);
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'album', 'artist', 'folder'], 'This song · Album · Artist · Folder');
    assert.ok(loads.includes('links'));
    assert.deepEqual(lookups.map((r) => [r.title, r.filepath]), [[`${LATE}.mp3`, `/${tapePath(LATE)}`], ['Borrowed Tapes', 'music/Boukmanflow/Borrowed Tapes'],
      ['Late Train Verse', `/${tapePath(LATE)}`], ['Borrowed Tapes', 'music/Boukmanflow/Borrowed Tapes']], 'the song and its folder, again once the song reads as itself');
    assert.equal(vm.discover.modal.recKeys.folder, 'folder:music/Boukmanflow/Borrowed Tapes', 'the folder\'s own key, not the song\'s file (G27)');
  });

  test('Folder chosen: counted once — its sub "3 songs", its name what it copies — the header and Listen stay the song\'s', async () => {
    const { vm, asked } = await browseWindow(fileRow(), FILE_OPTS, { peer: peerB({ meta: (fp) => ({ metadata: tagsOf(fp.slice(1)) }) }) });
    assert.deepEqual(asked.scans, [], 'never on open');
    vm.dmKeepChoose('folder');
    await flush();
    const seg = vm.dmKeepChoices().find((c) => c.scope === 'folder');
    assert.deepEqual([seg.sub, seg.aria], ['3 songs', 'Folder: Borrowed Tapes, 3 songs']);
    vm.dmKeepChoose('song');
    vm.dmKeepChoose('folder');
    await flush();
    assert.deepEqual(asked.scans, [TAPES_FOLDER], 'one scan');
    assert.deepEqual([vm.dmHeadTitle(), vm.dmListenShown(), vm.dmFolderFocus()], ['Late Train Verse', true, false]);
    assert.equal(card(vm.dmKeepView()).acts[0], 'primary Add folder · 3 songs');
    assert.equal(vm.dmLandShown(), true);
  });

  test('no Folder for a song at its library\'s root, nor on Discover — ever', async () => {
    const root = await browseWindow(fileRow(), { from: 'browse', folder: { path: '/music', name: 'music' } });
    assert.equal(root.vm.dmKeepChoices().some((c) => c.scope === 'folder'), false);
    const discover = await keepWindow();
    await discover.vm.openDiscoverModal(tapesRow(STAGE_B, LATE), 'federation', { folder: { path: TAPES_FOLDER, name: 'Borrowed Tapes' } });
    assert.deepEqual(discover.vm.dmKeepChoices().map((c) => c.scope), ['song', 'album', 'artist'], 'a folder from no browse page is no choice');
    assert.equal(discover.vm.discover.modal.folder, null);
  });
});

describe('from browsing: artist focus (SPEC-fed §6.4)', () => {
  const artistOpen = (peer) => browseWindow({ peer: { ...STAGE_B }, artist: 'Boukmanflow' }, { focus: 'artist', from: 'browse' }, { peer });
  test('the header, no Listen, no Find elsewhere, no Get it; Artist alone with only the missing ticked; what it leaves out', async () => {
    const { vm, loads, asked } = await artistOpen();
    assert.deepEqual([vm.dmHeadTitle(), vm.dmSubtitle()], ['Boukmanflow', 'Artist · 4 albums on Stage Peer B']);
    assert.deepEqual(vm.dmMetaParts().map((p) => [p.kind, p.text]), [['status', 'Stage Peer B online']]);
    assert.deepEqual([vm.dmListenShown(), vm.dmFindVisible(), vm.dmGetItRows().length, loads.includes('links')], [false, false, 0, false]);
    assert.deepEqual(asked.metadata, [], 'no file to read');
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['artist'], 'one choice: no strip');
    assert.deepEqual([vm.dmKeepMissingChoice(), vm.dmKeepMissingLabel(), vm.dmKeepScope()], [true, 'Only the 2 albums you don’t have', 'artist-missing']);
    assert.equal(vm.dmKeepLeftOut(), 'Leaves out Night Market Sampler: Boukmanflow only appears on it. Songs outside an album stay out too.');
    assert.equal(pathLine(vm.dmDestPath(vm.dmKeepScope())), 'copies › Boukmanflow › one folder per album');
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add 2 albums']);
    vm.discover.modal.keep.onlyMissing = false;
    assert.deepEqual(card(vm.dmKeepView()).acts, ['primary Add 3 albums']);
  });

  test('several albums left out are counted; nothing left out says nothing', async () => {
    const two = { albums: PEER_BOUK.albums.slice(0, 4).concat(peerAlbumItem('Block Party', { album_artist: 'Various Artists', artists: ['Boukmanflow'], compilation: true })) };
    assert.equal((await artistOpen(peerB({ peerAlbums: two }))).vm.dmKeepLeftOut(), 'Leaves out 2 albums Boukmanflow only appears on.');
    assert.equal((await artistOpen(peerB({ peerAlbums: { albums: PEER_BOUK.albums.slice(0, 3) } }))).vm.dmKeepLeftOut(), '');
  });

  test('the left-out line under Artist in a browsed album\'s window; never in Discover\'s', async () => {
    const browsed = await browseWindow({ peer: { ...STAGE_B }, album: 'Borrowed Tapes', albumArtist: 'Boukmanflow', year: 2019 }, { focus: 'album', from: 'browse', hide: ['viewAlbum'] });
    assert.equal(browsed.vm.dmKeepLeftOut(), '', 'Album chosen: nothing to say');
    browsed.vm.dmKeepChoose('artist');
    assert.match(browsed.vm.dmKeepLeftOut(), /^Leaves out Night Market Sampler/);
    const discover = await keepWindow({ focus: 'album', reads: readsOf({ albumSongs: songsOf(3), peerAlbums: PEER_BOUK, localAlbums: LOCAL_HARBOUR }) });
    discover.vm.dmKeepChoose('artist');
    assert.equal(discover.vm.dmKeepLeftOut(), '');
  });
});

describe('from browsing: folder focus — the header, the count, Listen (SPEC-fed §6.5.1–§6.5.3)', () => {
  test('one recursive listing on open: "Counting…" with Listen dimmed and Add uncounted, then "3 songs · no subfolders"', async () => {
    const answer = deferred();
    const w = await browseWindow(folderTrack(), FOLDER_OPTS, { peer: peerB({ scan: () => answer.promise }), wait: false });
    await flush();
    const { vm, asked, fedQueued } = w;
    assert.deepEqual([vm.dmHeadTitle(), vm.dmSubtitle()], ['Borrowed Tapes', 'Folder · music › Boukmanflow › Borrowed Tapes']);
    assert.deepEqual(vm.dmMetaParts().map((p) => [p.kind, p.text]), [['status', 'Stage Peer B'], ['text', 'Counting…']], 'a grey dot while it counts');
    assert.deepEqual([vm.dmFolderReady(), vm.dmFolderPlaySub(), vm.dmKeepStartLabel('folder')], [false, '', 'Add folder'], 'Add never waits on the count');
    vm.dmQueueFolder(false);
    assert.equal(fedQueued.length, 0);
    answer.resolve(TAPES3.map((t) => tapePath(t)).concat(['music/Boukmanflow/Borrowed Tapes/cover.jpg', 'music/Boukmanflow/Borrowed Tapes/.hidden.mp3']));
    await w.opening;
    assert.deepEqual(vm.dmMetaParts().map((p) => p.text), ['Stage Peer B online', '3 songs', 'no subfolders'], 'what the copy takes: no picture, no dot file');
    assert.deepEqual([vm.dmFolderReady(), vm.dmFolderPlaySub(), vm.dmKeepStartLabel('folder')], [true, '3 songs', 'Add folder · 3 songs']);
    assert.deepEqual(asked.scans, [TAPES_FOLDER]);
    assert.deepEqual(vm.dmRecommendation(), { source: 'federation', peer: { ...STAGE_B }, filepath: 'music/Boukmanflow/Borrowed Tapes', title: 'Borrowed Tapes' });
    assert.deepEqual([vm.dmFindVisible(), vm.dmGetItRows().length, vm.dmKeepChoices().map((c) => c.scope)], [false, 0, ['folder']]);
  });

  test('Listen: Add to queue queues them all in path order and says so; Play folder plays the first, the rest after it, and closes', async () => {
    const { vm, fedQueued, toasts, queued } = await browseWindow(folderTrack(), FOLDER_OPTS);
    vm.dmQueueFolder(false);
    assert.deepEqual(fedQueued.map((a) => [a[1], a[3]]), TAPES3.map((t) => [tapePath(t), true]));
    assert.deepEqual([toasts.pop().title, vm.discover.modal.open], ['Added to the queue', true]);
    vm.dmQueueFolder(true);
    assert.deepEqual([queued.pop(), fedQueued.slice(3).map((a) => a[3]), vm.discover.modal.open], ['cleared', [false, true, true], false]);
  });

  test('subfolders, a big folder (locale numbers), a count that failed, a peer not answering', async () => {
    const bouk = ['Borrowed Tapes', 'Harbour Lights', 'Second Shift'].flatMap((a) => TAPES3.map((t) => tapePath(t, `Boukmanflow/${a}`)));
    const nine = await browseWindow(folderTrack('/music/Boukmanflow'), FOLDER_OPTS, { peer: peerB({ listing: bouk }) });
    assert.deepEqual(nine.vm.dmMetaParts().slice(1).map((p) => p.text), ['9 songs', '3 subfolders']);
    const archive = Array.from({ length: 1240 }, (_, i) => `music/Night Owl Radio Archive/Show ${i % 56}/Hour ${i}.mp3`);
    const big = await browseWindow(folderTrack('/music/Night Owl Radio Archive'), FOLDER_OPTS, { peer: peerB({ listing: archive }) });
    assert.deepEqual(big.vm.dmMetaParts().slice(1).map((p) => p.text), ['1,240 songs', '56 subfolders']);
    assert.equal(big.vm.dmFolderPlaySub(), '1,240 songs');
    const failed = await browseWindow(folderTrack(), FOLDER_OPTS, { peer: peerB({ scan: () => { throw httpError(502, { error: 'peer unreachable' }); } }) });
    const parts = failed.vm.dmMetaParts();
    assert.deepEqual([parts[0].dot, parts.pop().text], ['off', 'Couldn’t count its songs'], 'not answering: no read of the window\'s came back');
    assert.match(parts[0].text, /^Stage Peer B not answering$/);
    assert.match(parts[1].text, /^last seen /);
    assert.deepEqual([failed.vm.dmFolderReady(), failed.vm.dmKeepStartLabel('folder'), failed.vm.dmLandShown()], [false, 'Add folder', true], 'landings stay; Add is never disabled for offline');
    assert.equal(card(failed.vm.dmKeepView()).acts[0], 'primary Add folder');
    assert.equal(failed.vm.dmKeepView().actions[0].disabled, false);
  });
});

describe('from browsing: where a folder lands (SPEC-fed §6.5.4, user decisions 1–2)', () => {
  test('As on Stage Peer B (the default): its own folders under the saved library, at most 3 files, its path inside "music" — no Change…', async () => {
    const { vm } = await browseWindow(folderTrack(), FOLDER_OPTS);
    assert.deepEqual(vm.dmLandings().map((l) => [l.mode, l.label, l.sub, l.on]), [
      ['mirror', 'As on Stage Peer B', 'Its own folders, as they are there', true],
      ['folder', 'Into a folder…', 'One you pick, for this copy only', false],
      ['tags', 'By your layout', 'Each song by its tags, like any other copy', false]]);
    const p = vm.dmDestPath('folder');
    assert.deepEqual([pathLine(p), p.files, vm.dmMirrorFoot()], ['copies › Boukmanflow › Borrowed Tapes', { lines: TAPES3.map((t) => `${t}.mp3`), more: 0 }, 'Its path inside “music” on Stage Peer B']);
    const v = vm.dmKeepView();
    assert.deepEqual([v.kind, v.bar, v.landing, card(v).acts], ['idle', false, 'mirror', ['primary Add folder · 3 songs']], 'no path bar, no Change…: the layout does not apply');
  });

  test('user decision 1 (S3): the layout\'s leading folders lead the mirror too — "copies › From friends › Boukmanflow › Borrowed Tapes"; the G18 line is gone', async () => {
    const { vm } = await browseWindow(folderTrack(), FOLDER_OPTS, { layout: 'From friends/{{ALBUMARTIST}}/{{ALBUM}}' });
    const p = vm.dmDestPath('folder');
    assert.equal(pathLine(p), 'copies › From friends › Boukmanflow › Borrowed Tapes');
    assert.deepEqual(p.crumbs.map((c) => c.kind), ['base', 'rendered', 'rendered']);
    assert.equal(EN['discover.keep.landing.leadUnused'], undefined);
    assert.equal(VP_SRC.indexOf('leadUnused'), -1);
  });

  test('a folder of subfolders: each file under its folder, then "and 6 more songs" — never the whole folder', async () => {
    const bouk = ['Borrowed Tapes', 'Harbour Lights', 'Second Shift'].flatMap((a) => TAPES3.map((t) => tapePath(t, `Boukmanflow/${a}`)));
    const { vm } = await browseWindow(folderTrack('/music/Boukmanflow'), FOLDER_OPTS, { peer: peerB({ listing: bouk }) });
    const p = vm.dmDestPath('folder');
    assert.deepEqual([pathLine(p), p.files.lines, tEn('discover.keep.moreFiles', { count: p.files.more })],
      ['copies › Boukmanflow', TAPES3.map((t) => `Borrowed Tapes/${t}.mp3`), 'and 6 more songs']);
  });

  test('Into a folder…: a new folder named as the pressed one in the saved library, its list always open, Up, a folder, New folder… (user decision 2)', async () => {
    const w = await browseWindow(folderTrack(), FOLDER_OPTS);
    const { vm, calls } = w;
    calls.listed.length = 0;
    vm.dmLandChoose('folder');
    await flush();
    const m = vm.discover.modal;
    assert.deepEqual([m.keep.into, vm.dmIntoCrumbs(), calls.listed], [{ vpath: 'copies', path: 'Borrowed Tapes' }, ['copies', 'Borrowed Tapes'], ['/copies']],
      'looked for in its library: a place not there yet is never asked for');
    assert.deepEqual([m.keep.tree.dirs, vm.dmIntoMissing(), vm.dmIntoStraight()], [[], true, ''], 'not there yet — the first file makes it; named as the pressed one');
    assert.deepEqual([pathLine(vm.dmDestPath('folder')), vm.dmDestPath('folder').files.lines.length], ['copies › Borrowed Tapes', 3]);
    assert.deepEqual(vm.dmFolderLandingSent(), { vpath: 'copies', path: 'Borrowed Tapes' });
    assert.deepEqual([vm.dmLandShown(), vm.dmKeepView().bar], [true, false]);
    vm.dmIntoUp();
    await flush();
    assert.deepEqual([vm.dmIntoCrumbs(), m.keep.tree.dirs, vm.dmIntoMissing()], [['copies'], ['from-peers', 'Boukmanflow'], false]);
    assert.equal(vm.dmIntoStraight(), 'Its files go straight into copies, with no “Borrowed Tapes” folder of their own.', 'the library root: the line names the library');
    vm.dmIntoInto('from-peers');
    await flush();
    assert.deepEqual([vm.dmIntoCrumbs(), m.keep.tree.dirs], [['copies', 'from-peers'], ['Stage Peer B', 'Stage Peer C', '2025 archive']]);
    assert.equal(vm.dmIntoStraight(), 'Its files go straight into from-peers, with no “Borrowed Tapes” folder of their own.');
    // New folder…: the pressed folder's name in it; a brace dims its Add, the place stays
    vm.dmIntoNewFolder();
    assert.deepEqual([m.keep.tree.naming, m.keep.tree.newName], [true, 'Borrowed Tapes']);
    m.keep.tree.newName = 'Tapes {2019}';
    vm.dmIntoNewFolder();
    assert.deepEqual([vm.dmIntoBraced(), m.keep.into.path, vm.dmFolderPlaceOk()], ['Tapes {2019}', 'from-peers', true], 'the name\'s Add does nothing; Add folder still works');
    m.keep.tree.newName = 'From Sam';
    vm.dmIntoNewFolder();
    assert.deepEqual([m.keep.into, m.keep.tree.naming, vm.dmIntoMissing()], [{ vpath: 'copies', path: 'from-peers/From Sam' }, false, true], 'named, known not to exist: nothing listed');
    // Esc while naming: the field goes, the place stays
    vm.dmIntoNewFolder();
    vm.dmIntoNaming(false);
    assert.deepEqual([m.keep.tree.naming, m.keep.into.path], [false, 'from-peers/From Sam']);
    // another library: the pressed folder's name at its root
    vm.dmIntoLibrary('music');
    await flush();
    assert.deepEqual([m.keep.into, calls.listed.pop(), vm.dmIntoMissing()], [{ vpath: 'music', path: 'Borrowed Tapes' }, '/music', true]);
    assert.deepEqual(vm.dmIntoLibraries(), ['music', 'copies']);
    assert.equal(pathLine(vm.dmDestPath('folder')), 'music › Borrowed Tapes', 'the chosen library, not the saved one');
  });

  // The 2026-10-23 live walk (D3): the first place, meant not to exist yet,
  // was listed — a 404 the browser logs as an error on every open.
  test('Into a folder…: a place not known to be there is looked for in the folder above first — never asked for while missing; one there (a row, the folder above one) is listed at once', async () => {
    const w = await browseWindow(folderTrack(), FOLDER_OPTS);
    const { vm, calls } = w;
    const disk = { '/copies': ['Borrowed Tapes', 'from-peers'], '/copies/Borrowed Tapes': ['Bonus'], '/copies/Borrowed Tapes/Bonus': [], '/music': ['ALM'] };
    w.api.dirparser = async (dir) => {
      calls.listed.push(dir);
      if (!(dir in disk)) { throw httpError(404, { error: `Cannot read directory "${dir}" (ENOENT)` }); }
      return { directories: disk[dir].map((name) => ({ name })) };
    };
    const m = vm.discover.modal;
    const step = async (fn) => { calls.listed.length = 0; fn(); await flush(); await flush(); return [calls.listed.slice(), m.keep.tree.dirs, vm.dmIntoMissing()]; };
    assert.deepEqual(await step(() => vm.dmLandChoose('folder')), [['/copies', '/copies/Borrowed Tapes'], ['Bonus'], false], 'an earlier copy made it: found, then listed');
    assert.deepEqual(await step(() => vm.dmIntoInto('Bonus')), [['/copies/Borrowed Tapes/Bonus'], [], false], 'a listed row is there');
    assert.deepEqual(await step(() => vm.dmIntoUp()), [['/copies/Borrowed Tapes'], ['Bonus'], false], 'the folder above one that is there');
    assert.deepEqual(await step(() => vm.dmIntoLibrary('music')), [['/music'], [], true], 'another library\'s first place: not there, not asked for');
    vm.dmIntoNewFolder();
    m.keep.tree.newName = 'Deep';
    assert.deepEqual(await step(() => vm.dmIntoNewFolder()), [[], [], true], 'named: known not to exist');
    assert.deepEqual(await step(() => vm.dmIntoUp()), [['/music'], [], true], 'the folder above one not there yet is looked for too');
    assert.ok(!calls.listed.some((d) => !(d in disk)) && !w.toasts.length, 'nothing missing was ever asked for');
  });

  test('a pressed folder whose name has a brace: the first place keeps it, the note says why, and Add folder waits', async () => {
    const { vm, starts } = await browseWindow(folderTrack('/music/Boukmanflow/Tapes {2019}'), FOLDER_OPTS, { peer: peerB({ listing: TAPES3.map((t) => tapePath(t, 'Boukmanflow/Tapes {2019}')) }) });
    vm.dmLandChoose('folder');
    await flush();
    assert.equal(vm.dmIntoBraced(), 'Tapes {2019}');
    assert.equal(tEn('discover.modal.dest.folderBraces', { folder: vm.dmIntoBraced() }), '“Tapes {2019}” has a brace in its name, which a layout reads as a variable. Rename the folder to start from it.');
    const add = vm.dmKeepView().actions[0];
    assert.deepEqual([add.id, add.disabled], ['add', true]);
    await vm.dmKeepAct('add');
    assert.deepEqual(starts, [], 'a dimmed Add does nothing');
    vm.dmLandChoose('mirror');
    assert.equal(vm.dmKeepView().actions[0].disabled, false, 'as on the peer: its name is the peer\'s word, made safe');
  });

  test('By your layout: the tags read once (100 songs or fewer) — songs that agree draw the exact path and their files; Change… is the layout\'s', async () => {
    const { vm, asked } = await browseWindow(folderTrack(), FOLDER_OPTS);
    vm.dmLandChoose('tags');
    await flush();
    const p = vm.dmDestPath('folder');
    assert.deepEqual([pathLine(p), p.files.lines], ['copies › Boukmanflow › Borrowed Tapes', TAPES3.map((t) => `${t}.mp3`)]);
    assert.deepEqual([vm.dmKeepView().bar, vm.dmPickerLandsAt('folder')], [true, 'Borrowed Tapes lands at'], 'the path bar, its Saved line and Change…');
    vm.discover.modal.picker = { vpath: 'copies' };
    vm.dmLandChoose('mirror');
    assert.equal(vm.discover.modal.picker, null, 'the editor is the layout\'s: it goes with it');
    vm.dmLandChoose('tags');
    await flush();
    assert.equal(asked.batches.length, 1, 'read once');
    assert.deepEqual(asked.batches[0], TAPES3.map((t) => tapePath(t)));
  });

  test('By your layout: three albums are "one folder per album" (no files); disagreeing artists a slot; the album credit (S2) files a compilation; past 100 songs no read', async () => {
    const bouk = ['Borrowed Tapes', 'Harbour Lights', 'Second Shift'].flatMap((a) => TAPES3.map((t) => tapePath(t, `Boukmanflow/${a}`)));
    const per = await browseWindow(folderTrack('/music/Boukmanflow'), FOLDER_OPTS, { peer: peerB({ listing: bouk }) });
    per.vm.dmLandChoose('tags');
    await flush();
    assert.deepEqual([pathLine(per.vm.dmDestPath('folder')), per.vm.dmDestPath('folder').files, per.vm.dmKeepStartLabel('folder')], ['copies › Boukmanflow › one folder per album', null, 'Add folder · 9 songs']);
    const sampler = ['Lantern Street', 'Night Market Cypher', 'Paper Lanterns'].map((t) => `music/Various Artists/Night Market Sampler/${t}.mp3`);
    const artists = { 'Lantern Street': 'Color Out', 'Night Market Cypher': 'Boukmanflow', 'Paper Lanterns': 'ALM' };
    const batchOf = (credit) => (paths) => Object.fromEntries(paths.map((p) => { const title = p.split('/').pop().replace('.mp3', ''); return [p, { filepath: p, metadata: { title, artist: artists[title], album: 'Night Market Sampler', year: 2024, 'album-artist': credit } }]; }));
    const comp = await browseWindow(folderTrack('/music/Various Artists/Night Market Sampler'), FOLDER_OPTS, { peer: peerB({ listing: sampler, batch: batchOf(undefined) }) });
    comp.vm.dmLandChoose('tags');
    await flush();
    const slotted = comp.vm.dmDestPath('folder');
    assert.deepEqual([pathLine(slotted), slotted.files, slotted.slotNote], ['copies › ‹artist› › Night Market Sampler', null, '‹artist› comes from each song’s own tags, so these songs can land in more than one folder.']);
    const credited = await browseWindow(folderTrack('/music/Various Artists/Night Market Sampler'), FOLDER_OPTS, { peer: peerB({ listing: sampler, batch: batchOf('Various Artists') }) });
    credited.vm.dmLandChoose('tags');
    await flush();
    assert.equal(pathLine(credited.vm.dmDestPath('folder')), 'copies › Various Artists › Night Market Sampler');
    const many = Array.from({ length: 101 }, (_, i) => `music/Mix/Song ${i}.mp3`);
    const big = await browseWindow(folderTrack('/music/Mix'), FOLDER_OPTS, { peer: peerB({ listing: many }) });
    big.vm.dmLandChoose('tags');
    await flush();
    assert.deepEqual([big.asked.batches.length, big.vm.discover.modal.folderTags.state, pathLine(big.vm.dmDestPath('folder'))], [0, 'skipped', 'copies › ‹artist› › one folder per album']);
  });
});

describe('from browsing: a folder\'s start, its states on its own landing, the cap (SPEC-fed §6.5.4–§6.5.6)', () => {
  test('Add sends the folder\'s recommendation, where it lands and the destination shown: none as on the peer, the place into a folder, { tags } by the layout', async () => {
    const { vm, starts } = await browseWindow(folderTrack(), FOLDER_OPTS);
    const rec = { source: 'federation', peer: { ...STAGE_B }, filepath: 'music/Boukmanflow/Borrowed Tapes', title: 'Borrowed Tapes' };
    const shown = { vpath: 'copies', base: '', layout: LAYOUT };
    await vm.dmKeepAct('add');
    vm.discover.modal.jobs = {};
    vm.dmLandChoose('folder');
    await vm.dmKeepAct('add');
    vm.discover.modal.jobs = {};
    vm.dmLandChoose('tags');
    await vm.dmKeepAct('add');
    assert.deepEqual(starts, [
      { name: 'federation-copy', rec, scope: 'folder', destination: shown, landing: null },
      { name: 'federation-copy', rec, scope: 'folder', destination: shown, landing: { vpath: 'copies', path: 'Borrowed Tapes' } },
      { name: 'federation-copy', rec, scope: 'folder', destination: shown, landing: { tags: true } }]);
  });

  test('from a file row\'s Folder choice the start is the folder\'s, never the song\'s', async () => {
    const { vm, starts } = await browseWindow({ peer: { ...STAGE_B }, filepath: `/${tapePath(LATE)}`, title: `${LATE}.mp3` }, { from: 'browse', folder: { path: TAPES_FOLDER, name: 'Borrowed Tapes' } });
    vm.dmKeepChoose('folder');
    await flush();
    await vm.dmKeepAct('add');
    assert.deepEqual([starts[0].rec.filepath, starts[0].rec.title, starts[0].scope], ['music/Boukmanflow/Borrowed Tapes', 'Borrowed Tapes', 'folder']);
  });

  test('one folder, one job (G20): while it is live the landings go and its own landing is the path; Retry and Add again reuse it', async () => {
    const { vm, starts } = await browseWindow(folderTrack(), FOLDER_OPTS);
    const intoSam = { vpath: 'copies', path: 'From Sam' };
    vm.discover.modal.jobs = { [SLOT_FOLDER]: folderJob({ state: 'running', progress: 0.43, statusText: '2 of 3 songs · 4.1 MB', params: { scope: 'folder', landing: intoSam, destination: COPIES } }) };
    assert.deepEqual([card(vm.dmKeepView()).path, card(vm.dmKeepView()).acts, card(vm.dmKeepView()).sub, vm.dmLandShown(), vm.dmKeepHint()],
      ['Into copies › From Sam', ['ghost Cancel'], '2 of 3 songs · 4.1 MB', false, true]);
    vm.discover.modal.jobs = { [SLOT_FOLDER]: folderJob({ state: 'queued', params: { scope: 'folder', destination: COPIES } }) };
    assert.equal(card(vm.dmKeepView()).path, 'Into copies › Boukmanflow › Borrowed Tapes', 'as on the peer');
    // cancelled after one song, into From Sam: Add again adds there
    vm.discover.modal.jobs = { [SLOT_FOLDER]: folderJob({ state: 'cancelled', params: { scope: 'folder', landing: intoSam, destination: COPIES }, result: folderResult({ copied: [TAPES3[0]], landed: 'copies/From Sam', total: 3 }) }) };
    const c = card(vm.dmKeepView());
    assert.deepEqual([c.sub, c.path, c.retry, c.acts], ['1 song copied · the rest stay on Stage Peer B', null, 'Add again adds to copies › From Sam', ['primary Add again']]);
    assert.equal(vm.dmKeepView().retryPath.suffix, '', 'its own place, not "your saved place now"');
    vm.dmLandChoose('tags');
    await vm.dmKeepAct('addAgain');
    assert.deepEqual(starts.pop().landing, intoSam, 'the job\'s own landing, whatever the landings say');
  });

  test('F7 / F8 / F9 / F10 / F12 / F15: counted in songs; files left out unless gaps say more; In where it landed; no Retry past the cap', async () => {
    const { vm } = await browseWindow(folderTrack(), FOLDER_OPTS);
    const at = (over) => { vm.discover.modal.jobs = { [SLOT_FOLDER]: folderJob(over) }; return card(vm.dmKeepView()); };
    const left = [{ from: 'music/Boukmanflow/Borrowed Tapes/notes.txt', why: 'unsupported' }, { from: 'music/Boukmanflow/Borrowed Tapes/.cover', why: 'ignored' }];
    const kept = at({ result: folderResult({ copied: TAPES3.slice(0, 2), owned: [TAPES3[2]], skippedFiles: left }) });
    assert.deepEqual([kept.state, kept.sub, kept.muted, kept.path, kept.acts], ['kept', '2 songs copied · 1 already yours', '2 files left out: not music this server plays, or hidden',
      'In copies › Boukmanflow › Borrowed Tapes', ['ghost Show in your library', 'primary Play your copy']]);
    assert.deepEqual(vm.dmKeepView().folder, ['copies', 'Boukmanflow', 'Borrowed Tapes']);
    const gaps = at({ result: folderResult({ copied: TAPES3.slice(0, 2), failed: [TAPES3[2]], skippedFiles: left }) });
    assert.deepEqual([gaps.sub, gaps.muted, gaps.acts], ['2 songs copied · 1 failed', 'Retry takes only the gaps', ['secondary Play your copy', 'primary Retry']]);
    const yours = at({ result: folderResult({ owned: TAPES3 }) });
    assert.deepEqual([yours.headline, yours.sub], ['Already yours', 'You have it all · 3 already yours']);
    const stopped = at({ result: folderResult({ copied: [TAPES3[0]], total: 3, stopped: 'quota' }) });
    assert.deepEqual([stopped.headline, stopped.sub, stopped.acts], ['Stage Peer B’s transfer limit stopped it', '1 song copied · 2 not copied · try again later', ['primary Retry']]);
    const failed = at({ result: folderResult({ failed: TAPES3, landed: 'copies/Boukmanflow/Borrowed Tapes' }) });
    assert.deepEqual([failed.headline, failed.sub, failed.path, failed.acts], ['Copy failed', 'Nothing was copied · 3 failed', null, ['primary Retry']]);
    const cap = at({ state: 'failed', error: '“Night Owl Radio Archive” on Stage Peer B holds 1240 songs — add its folders one at a time (the limit is 1000; an admin can raise it under Discovery › Jobs)' });
    assert.deepEqual([cap.headline, cap.acts], ['Copy failed', []], 'Retry would fail again: the words name the limit');
    const thrown = at({ state: 'failed', error: 'Stage Peer B has no songs under “Borrowed Tapes”' });
    assert.deepEqual(thrown.acts, ['primary Retry']);
  });

  test('over the cap (S1): the card holds the cap line alone — no landings, no Add; a server that says no cap shows none', async () => {
    const archive = Array.from({ length: 1240 }, (_, i) => `music/Night Owl Radio Archive/Show ${i % 56}/Hour ${i}.mp3`);
    const { vm } = await browseWindow(folderTrack('/music/Night Owl Radio Archive'), FOLDER_OPTS, { peer: peerB({ listing: archive }) });
    const v = vm.dmKeepView();
    assert.deepEqual([v.kind, v.bar, v.actions, vm.dmLandShown()], ['cap', false, [], false]);
    assert.equal(v.line, '“Night Owl Radio Archive” holds 1,240 songs, more than one copy takes here (1,000). Keep its folders one at a time.');
    assert.equal(vm.dmKeepAnnounce(), v.line);
    const older = await browseWindow(folderTrack('/music/Night Owl Radio Archive'), FOLDER_OPTS, { peer: peerB({ listing: archive }), maxFolderSongs: null });
    assert.deepEqual([older.vm.dmKeepView().kind, older.vm.dmLandShown()], ['idle', true]);
  });

  test('a strip row reopens a folder job in folder focus, on its own landing (G17); an artist page\'s artist job as the artist', async () => {
    const w = makeDestWindow({ reads: peerB().reads });
    const job = folderJob({ state: 'running', params: { scope: 'folder', landing: { vpath: 'copies', path: 'From Sam' }, destination: COPIES } });
    await w.vm.openDiscoverModalForJob(job);
    const m = w.vm.discover.modal;
    assert.deepEqual([m.focus, m.keep.scope, w.vm.dmKeepChosen(), w.vm.dmHeadTitle()], ['folder', 'folder', 'folder', 'Borrowed Tapes']);
    m.jobs = { [SLOT_FOLDER]: job };
    assert.equal(card(w.vm.dmKeepView()).path, 'Into copies › From Sam');
    const artist = makeDestWindow({ reads: peerB().reads });
    await artist.vm.openDiscoverModalForJob(keepJob({ params: { scope: 'artist-missing' }, recommendation: { source: 'federation', peer: { ...STAGE_B }, artist: 'Boukmanflow' } }));
    assert.deepEqual([artist.vm.discover.modal.focus, artist.vm.dmKeepScope()], ['artist', 'artist-missing']);
  });

  test('the strip\'s Retry sends a folder job\'s own landing', async () => {
    const sent = [];
    const retry = new Function('MSTREAMAPI', 'DISCOVERJOBS', 'iziToast', `return ${vpMethodSrc('dtRetry')}`)({ discoveryJobStart: async (...args) => { sent.push(args); return {}; } }, J, { error() {} });
    await retry.call({ discover: { dest: { view: null } }, noteDiscoverJob() {}, scheduleDiscoverJobsPoll() {}, dmLoadDestination() {}, tt: tEn },
      folderJob({ state: 'failed', params: { scope: 'folder', landing: { tags: true }, destination: COPIES } }));
    assert.deepEqual([sent[0][3], sent[0][5]], ['folder', { tags: true }]);
  });
});

describe('from browsing: the keyboard goes back to the control it came from (G25)', () => {
  const opener = new Function(`${vpModuleFn('dmOpenerOf')}\nreturn dmOpenerOf;`)();
  const back = new Function(`${vpModuleFn('dmAttrValue')}\n${vpModuleFn('dmFocusBack')}\nreturn dmFocusBack;`)();
  const node = (tagName, attrs = {}, over = {}) => {
    const el = { tagName, isConnected: true, focused: 0, attrs, getAttribute: (n) => (n in attrs ? String(attrs[n]) : null), hasAttribute: (n) => n in attrs,
      setAttribute: (n, v) => { attrs[n] = String(v); }, closest: () => null, getClientRects: () => [{}], focus() { el.focused += 1; }, ...over };
    return el;
  };
  const docOf = (found, queries = []) => ({ querySelector: (sel) => { queries.push(sel); return found[sel] || null; } });
  test('a browse control carries its key; redrawn, the control with that key in the header, the list or the queue', () => {
    const keep = node('BUTTON', { 'data-keep-key': '1|album|Borrowed Tapes|Boukmanflow' });
    const o = opener(keep);
    assert.deepEqual(o, { el: keep, sel: null, key: '1|album|Borrowed Tapes|Boukmanflow' });
    assert.equal(back(o, docOf({})), keep, 'still there: itself');
    // the filter redrew the row: the old one is gone, the new one carries the key
    const redrawn = node('BUTTON', { 'data-keep-key': '1|album|Borrowed Tapes|Boukmanflow' });
    const queries = [];
    assert.equal(back({ ...o, el: { ...keep, isConnected: false } }, docOf({ '#filelist [data-keep-key="1|album|Borrowed Tapes|Boukmanflow"]': redrawn }, queries)), redrawn);
    assert.deepEqual(queries, ['#browse-head [data-keep-key="1|album|Borrowed Tapes|Boukmanflow"]', '#filelist [data-keep-key="1|album|Borrowed Tapes|Boukmanflow"]']);
    // a row the list reused for another item carries another key
    const reused = node('BUTTON', { 'data-keep-key': '1|song|other.mp3' });
    assert.equal(back({ el: reused, sel: null, key: '1|song|late.mp3' }, docOf({ '#filelist [data-keep-key="1|song|late.mp3"]': redrawn })), redrawn);
    // quotes in a key stay inside the selector
    assert.equal(back({ el: null, sel: null, key: '1|folder|music/Say "hi"' }, docOf({ '#browse-head [data-keep-key="1|folder|music/Say \\"hi\\""]': redrawn })), redrawn);
  });

  test('gone: the header\'s Keep a copy…, else the panel\'s title (the phone tab where the title is hidden); a queue row\'s ⋮ (m.js keys it "{peer}|queue|{file}") hands over to the queue', () => {
    const gone = { el: null, sel: null, key: '1|song|late.mp3' };
    const keepBtn = node('BUTTON');
    assert.equal(back(gone, docOf({ '#browse-head .browse-keep': keepBtn })), keepBtn);
    const title = node('H5');
    assert.equal(back(gone, docOf({ 'h5.panel_one_name': title })), title);
    assert.deepEqual([title.attrs.tabindex, title.focused], ['-1', 1]);
    const tab = node('DIV');
    assert.equal(back(gone, docOf({ 'h5.panel_one_name': node('H5', {}, { getClientRects: () => [] }), '.m-tab.panel_one_name': tab })), tab, 'the hidden title gives way to the tab');
    const queue = node('UL');
    assert.equal(back({ el: null, sel: null, key: '1|queue|music/x.mp3' }, docOf({ '#playlist ul.collection': queue, '#browse-head .browse-keep': keepBtn })), queue);
    const row = node('SPAN', { 'data-keep-key': '1|queue|music/x.mp3' });
    assert.equal(back({ el: null, sel: null, key: '1|queue|music/x.mp3' }, docOf({ '#playlist [data-keep-key="1|queue|music/x.mp3"]': row })), row, 'the ⋮ that shows the song now');
    // a queue row the list reused for another song: that song's ⋮ is not this one
    const other = node('SPAN', { 'data-keep-key': '1|queue|music/y.mp3' });
    assert.equal(back({ el: other, sel: null, key: '1|queue|music/x.mp3' }, docOf({ '#playlist ul.collection': queue })), queue);
  });
});

describe('the pages read their gate again when the window learns it changed (SPEC-fed §3)', () => {
  test('a start refused 403 or 404, and a saved destination, call the watchers; other refusals do not', async () => {
    const w = await browseWindow(folderTrack(), FOLDER_OPTS);
    let heard = 0;
    w.gateWatchers.push(() => { heard += 1; });
    for (const [status, want] of [[403, 1], [404, 2], [429, 2], [409, 2]]) {
      w.api.discoveryJobStart = async () => { throw httpError(status, { error: status === 403 ? 'Uploading Disabled' : 'x' }); };
      w.vm.discover.modal.jobRefusals = {};
      await w.vm.dmJobStart(COPY, null, 'folder', null);
      assert.equal(heard, want, String(status));
    }
    w.vm.dmOpenPicker();
    w.vm.dmPickerChoose(w.vm.dmPickerPresets()[1].layout);
    await w.vm.dmPickerSubmit();
    assert.equal(heard, 3, 'a save');
    assert.match(VP_SRC, /mstreamModule\.watchKeepGate = \(fn\) => \{\s*if \(typeof fn !== 'function'\) \{ return \(\) => \{\}; \}\s*discoverGateWatchers\.push\(fn\);/);
  });
});

describe('the plug-in listing\'s folder cap is kept for the window and the page (S1)', () => {
  test('ensureDiscoverPlugins keeps jobs.maxFolderSongs; an older server says none', async () => {
    for (const [jobs, want] of [[{ allowed: true, maxFolderSongs: 1000 }, 1000], [{ allowed: true }, null]]) {
      const self = { discover: { plugins: { list: null, jobsAllowed: false, maxFolderSongs: null } } };
      const ensure = new Function('MSTREAMAPI', 'DISCOVERJOBS', `let discoverPluginsPromise = null; return ${vpMethodSrc('ensureDiscoverPlugins')}`)(
        { currentServer: { host: '' }, discoveryPlugins: async () => ({ plugins: [COPY], jobs }) }, J);
      await ensure.call(self);
      assert.deepEqual([self.discover.plugins.jobsAllowed, self.discover.plugins.maxFolderSongs], [true, want]);
    }
    assert.match(VP_SRC, /jobsAllowed: discoverState\.plugins\.jobsAllowed === true, maxFolderSongs: discoverState\.plugins\.maxFolderSongs \}/);
  });
});

describe('the window\'s markup for browsing (index.html, spa.css) and its words (en.json)', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const win = HTML.slice(HTML.indexOf('class="dmodal-shadow"'), HTML.indexOf('id="pop"'));
  const CSS = readFileSync(new URL('../../webapp/alpha/spa.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  test('the header\'s art by focus; no Listen for an artist; a folder\'s Listen dimmed until counted; View album / View artist hidden by the page', () => {
    assert.match(win, /'dmodal-art-artist': dmArtistFocus\(\), 'dmodal-art-folder': dmFolderFocus\(\)/);
    assert.match(win, /<section v-if="dmListenShown\(\)" class="dmodal-section">/);
    assert.match(win, /<div v-if="dmFolderFocus\(\)" class="dm-play">\s*<button type="button" class="dm-play-btn" v-on:click="dmQueueFolder\(true\)" :aria-disabled="dmFolderReady\(\) \? null : 'true'" :aria-label="tt\('discover\.modal\.playFolder'\)">/);
    assert.match(win, /v-on:click="dmQueueFolder\(false\)" :aria-disabled="dmFolderReady\(\) \? null : 'true'">/);
    assert.equal((win.match(/<button v-if="!dmHidden\('viewAlbum'\)"/g) || []).length, 2);
    assert.equal((win.match(/<button v-if="!dmHidden\('viewArtist'\)"/g) || []).length, 1);
  });

  test('the landings: one radio group labelled "Where it lands", the radio last in its label; Into a folder…: a group, chips, the list, New folder…; the left-out line', () => {
    assert.match(win, /<div id="dm-land-l" class="dm-land-label">\{\{ tt\('discover\.keep\.landing'\) \}\}<\/div>\s*<div class="dm-land" role="radiogroup" aria-labelledby="dm-land-l">/);
    assert.match(win, /<label v-for="l in dmLandings\(\)"[^>]*class="dm-land-opt"[\s\S]*?<\/span><\/span>\s*<input type="radio" name="dm-land" class="dm-land-radio"[^>]*v-on:change="dmLandChoose\(l\.mode\)">\s*<\/label>/);
    assert.match(win, /class="dm-land-into" role="group" aria-labelledby="dm-land-l"/);
    assert.match(win, /<div class="dm-dest-tree" role="group" :aria-label="tt\('discover\.modal\.dest\.foldersIn', \{ library: dmFolderInto\(\)\.vpath \}\)">/);
    assert.match(win, /data-dm-newfolder v-on:click="dmIntoNewFolder\(\)"/);
    assert.match(win, /ref="dmIntoName" v-model="discover\.modal\.keep\.tree\.newName" v-on:keydown\.enter\.prevent="dmIntoNewFolder\(\)"/);
    assert.match(win, /<button type="button" class="dm-btn" :aria-disabled="dmIntoBraced\(\) \? 'true' : null" v-on:click="dmIntoNewFolder\(\)">/);
    assert.match(win, /<div v-if="dmKeepLeftOut\(\)" class="dm-keep-out">/);
    // the order inside the card: the strip, the checkbox, the left-out line, the landings, the body
    const order = ['class="dm-segs"', 'class="dm-check"', 'class="dm-keep-out"', 'v-if="dmLandShown()"', '<dm-keep-body'].map((x) => win.indexOf(x));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    assert.ok(!/role="status"/.test(win.slice(win.indexOf('v-if="dmLandShown()"'), win.indexOf('<dm-keep-body'))), 'the section keeps its one live region');
  });

  test('spa.css: landing rows 40 px (44 on a phone), the native radio in sight, the cap line, the round artist art', () => {
    assert.match(CSS, /\.dm-land-opt \{\s*display: grid; grid-template-columns: 16px minmax\(0, 1fr\);[^}]*min-height: 40px;/);
    assert.match(CSS, /\.dmodal \.dm-land-opt \.dm-land-radio \{[^}]*opacity: 1; pointer-events: auto; accent-color: var\(--src\)/);
    const phone = CSS.slice(CSS.indexOf('.dm-keep { padding: 10px; }'), CSS.indexOf('}', CSS.indexOf('.dm-land-into .dm-input, .dm-land-into .dm-input[type="text"] { height: 44px; }')));
    assert.match(phone, /\.dm-land-opt \{ min-height: 44px; \}/);
    assert.match(CSS, /\.dm-keep-cap > svg \{[^}]*color: var\(--warn\)/);
    assert.match(CSS, /\.dmodal-art\.dmodal-art-artist \{ border-radius: 50%; \}/);
    assert.match(CSS, /\.dm-play-btn\[aria-disabled="true"\] \{ opacity: \.45;/);
  });

  test('en.json: the window\'s new words, exactly', () => {
    const want = {
      'discover.keep.folder': 'Folder', 'discover.keep.folderAria': 'Folder: {{name}} and everything in it', 'discover.keep.landing': 'Where it lands',
      'discover.keep.landing.mirror': 'As on {{peer}}', 'discover.keep.landing.mirrorSub': 'Its own folders, as they are there', 'discover.keep.landing.folder': 'Into a folder…',
      'discover.keep.landing.folderSub': 'One you pick, for this copy only', 'discover.keep.landing.tags': 'By your layout', 'discover.keep.landing.tagsSub': 'Each song by its tags, like any other copy',
      'discover.keep.landing.mirrorFoot': 'Its path inside “{{library}}” on {{peer}}', 'discover.keep.landing.thisCopyOnly': 'For this copy only · nothing is saved to your account',
      'discover.keep.addFolderUncounted': 'Add folder', 'discover.keep.folderCap': '“{{name}}” holds {{count}} songs, more than one copy takes here ({{cap}}). Keep its folders one at a time.',
      'discover.modal.folderSub': 'Folder · {{path}}', 'discover.modal.artistSub': 'Artist · {{albums}} on {{peer}}', 'discover.modal.counting': 'Counting…',
      'discover.modal.countFailed': 'Couldn’t count its songs', 'discover.modal.noSubfolders': 'no subfolders', 'discover.modal.playFolder': 'Play folder',
    };
    for (const [key, text] of Object.entries(want)) { assert.equal(EN[key], text, key); }
    for (const [key, one, other] of [['discover.keep.folderAriaCount', 'Folder: X, 1 song', 'Folder: X, 2 songs'], ['discover.keep.moreFiles', 'and 1 more song', 'and 2 more songs'],
      ['discover.keep.addFolder', 'Add folder · 1 song', 'Add folder · 2 songs'], ['discover.keep.filesLeftOut', '1 file left out: not music this server plays, or hidden', '2 files left out: not music this server plays, or hidden'],
      ['discover.modal.subfolders', '1 subfolder', '2 subfolders']]) {
      assert.deepEqual([tEn(key, { count: 1, name: 'X' }), tEn(key, { count: 2, name: 'X' })], [one, other], key);
    }
    // every key the window asks for has its English
    for (const [, key] of VP_SRC.matchAll(/tt\('((?:discover\.modal|discover\.keep)\.[\w.]*\w)'/g)) { assert.ok(EN[key] !== undefined, key); }
  });
});

// ── the 2026-10-23 review of the window entered from browsing ────────────
describe('from browsing: a song\'s album credit is one the peer\'s album list bears out (rule 1)', () => {
  const SPLIT_FILE = 'music/ALM/Split Series/01 - Shared Wall.mp3';
  const splitRow = (over) => ({ peer: { ...STAGE_B }, filepath: SPLIT_FILE, title: 'Shared Wall', artist: 'ALM', album: 'Split Series', year: 2022, duration: 10, ...over });
  const splitMeta = (credit) => () => ({ metadata: { title: 'Shared Wall', artist: 'ALM', album: 'Split Series', year: 2022, format: 'mp3', ...(credit ? { 'album-artist': credit } : {}) } });
  const listed = (albumArtist) => ({ albums: [peerAlbumItem('Split Series', { year: 2022, year_min: 2022, year_max: 2022, album_artist: albumArtist, artists: ['ALM', 'Night Owl Radio'] })] });

  test('half of an album split between two artists names its own artist; the list says the album\'s songs disagree: no Album', async () => {
    const { vm } = await browseWindow(splitRow(), { from: 'browse' }, { peer: peerB({ meta: splitMeta('ALM'), peerAlbums: listed(null) }) });
    assert.equal(vm.discover.modal.track.albumArtist, undefined);
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'artist']);
  });

  test('the list bears the song\'s credit out, or does not answer: the song\'s own stands; Album appears once known and never goes', async () => {
    const borne = await browseWindow(splitRow(), { from: 'browse' }, { peer: peerB({ meta: splitMeta('ALM'), peerAlbums: listed('ALM') }) });
    assert.equal(borne.vm.discover.modal.track.albumArtist, 'ALM');
    const silent = await browseWindow(splitRow(), { from: 'browse' }, { peer: peerB({ meta: splitMeta('ALM'), peerAlbums: null }) });
    assert.deepEqual(silent.vm.dmKeepChoices().map((c) => c.scope), ['song', 'album', 'artist']);
    // the list still out: no Album yet — it is never drawn and then taken away
    const later = deferred();
    const peer = peerB({ meta: splitMeta('ALM') });
    peer.reads.peer.artistAlbums = () => later.promise;
    const w = await browseWindow(splitRow(), { from: 'browse' }, { peer, wait: false });
    await flush();
    assert.deepEqual(w.vm.dmKeepChoices().map((c) => c.scope).includes('album'), false);
    later.resolve(listed(null));
    await w.opening;
    await flush();
    assert.deepEqual(w.vm.dmKeepChoices().map((c) => c.scope), ['song', 'artist']);
  });

  test('a song of an album page that says its songs disagree: no Album, whatever the song or the list names', async () => {
    const { vm } = await browseWindow(splitRow(), { from: 'browse', hide: ['viewAlbum'], creditsDisagree: true }, { peer: peerB({ meta: splitMeta('ALM'), peerAlbums: listed('ALM') }) });
    assert.equal(vm.discover.modal.creditsDisagree, true);
    assert.equal(vm.discover.modal.track.albumArtist, undefined);
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['song', 'artist']);
    const discover = await keepWindow();
    await discover.vm.openDiscoverModal(tapesRow(STAGE_B, LATE), 'federation', { creditsDisagree: true });
    assert.equal(discover.vm.discover.modal.creditsDisagree, false, 'only from a connected server\'s pages');
  });

  test('a compilation\'s album page header: one choice (Album), no Artist fact row, whole under its credit', async () => {
    const head = { peer: { ...STAGE_B }, album: 'Night Market Sampler', albumArtist: 'Various Artists', artist: null, year: 2024, albumArt: null, compilation: true, filepath: null };
    const { vm } = await browseWindow(head, { focus: 'album', from: 'browse', hide: ['viewAlbum'] });
    assert.deepEqual(vm.dmKeepChoices().map((c) => c.scope), ['album']);
    assert.equal(vm.discover.modal.track.artist, null);
    assert.equal(pathLine(vm.dmDestPath('album')), 'copies › Various Artists › Night Market Sampler');
  });

  test('View album from a compilation card\'s window says the album is one', async () => {
    const { vm, viewed } = makeWindow();
    await vm.openDiscoverModal({ peer: { ...STAGE_B }, album: 'Night Market Sampler', albumArtist: 'Various Artists', artist: null, year: 2024, compilation: true }, 'federation', { focus: 'album', from: 'browse' });
    vm.dmViewAlbum();
    assert.equal(viewed[0]['data-compilation'], 'true');
  });
});

describe('from browsing: the keyboard in a folder\'s window (the 2026-10-23 review)', () => {
  test('a new folder being named goes with the landings that showed it: another landing, another choice, a copy started', async () => {
    const { vm } = await browseWindow(folderTrack(), FOLDER_OPTS);
    const tree = () => vm.discover.modal.keep.tree;
    vm.dmLandChoose('folder');
    await flush();
    vm.dmIntoNewFolder();
    assert.equal(tree().naming, true);
    vm.dmLandChoose('mirror');
    assert.deepEqual([tree().naming, tree().newName], [false, '']);
    vm.dmLandChoose('folder');
    vm.dmIntoNewFolder();
    await vm.dmKeepAct('add');
    assert.equal(tree().naming, false, 'the copy under way: the landings went');
    const file = await browseWindow({ peer: { ...STAGE_B }, filepath: `/${tapePath(LATE)}`, title: `${LATE}.mp3` }, { from: 'browse', folder: { path: TAPES_FOLDER, name: 'Borrowed Tapes' } });
    file.vm.dmKeepChoose('folder');
    file.vm.dmLandChoose('folder');
    await flush();
    file.vm.dmIntoNewFolder();
    file.vm.dmKeepChoose('song');
    assert.equal(file.vm.discover.modal.keep.tree.naming, false);
  });

  test('a count past the cap takes the landings and Add away: the keyboard goes to Close, never to the page behind', async () => {
    const archive = Array.from({ length: 1240 }, (_, i) => `music/Night Owl Radio Archive/Show ${i % 56}/Hour ${i}.mp3`);
    const answer = deferred();
    const w = await browseWindow(folderTrack('/music/Night Owl Radio Archive'), FOLDER_OPTS, { peer: peerB({ scan: () => answer.promise }), wait: false });
    w.vm.$refs.dmodalClose = w.el('close');
    await flush();
    w.tick();
    w.el('add').focus();
    answer.resolve(archive);
    await w.opening;
    await flush();
    assert.equal(w.vm.dmKeepView().kind, 'cap');
    w.tick();
    assert.equal(w.focused(), 'close');
  });
});

describe('the strip\'s Retry refused for a right or the plug-in gone: the pages read their gate again', () => {
  test('403 and 404 tell the watchers; a 409 does not', async () => {
    for (const [status, want] of [[403, 1], [404, 1], [409, 0], [429, 0]]) {
      const retry = new Function('MSTREAMAPI', 'DISCOVERJOBS', 'iziToast', `return ${vpMethodSrc('dtRetry')}`)(
        { discoveryJobStart: () => Promise.reject(httpError(status, { error: 'x' })) }, J, { error() {} });
      let heard = 0;
      await retry.call({ discover: { dest: { view: null } }, noteDiscoverJob() {}, scheduleDiscoverJobsPoll() {}, dmLoadDestination() {}, dmErrorText: () => 'x', dmKeepGateChanged() { heard += 1; }, tt: tEn },
        folderJob({ state: 'failed', params: { scope: 'folder', destination: COPIES } }));
      assert.equal(heard, want, String(status));
    }
  });
});

describe('the window keeps no older plug-in listing than the page that offered the way in (SPEC-fed §3)', () => {
  const take = VP_SRC.match(/mstreamModule\.takeDiscoverPlugins = (\(listing\) => \{[\s\S]*?\n {2}\});/)[1];
  const harness = (api) => {
    const state = { plugins: { available: true, list: null, jobsAllowed: false, maxFolderSongs: null } };
    const h = new Function('MSTREAMAPI', 'DISCOVERJOBS', 'discoverState', `let discoverPluginsPromise = null;
      return { ensure: ${vpMethodSrc('ensureDiscoverPlugins')}, take: ${take} };`)(api, J, state);
    return { state, ...h, self: { discover: state } };
  };
  test('the page\'s read becomes the window\'s: the list, the right to start jobs, the folder cap', () => {
    const { state, take: give } = harness({});
    give({ plugins: [COPY], jobs: { allowed: true, maxFolderSongs: 500 } });
    assert.deepEqual([state.plugins.list, state.plugins.jobsAllowed, state.plugins.maxFolderSongs], [[COPY], true, 500]);
    give({ plugins: [], jobs: { allowed: false } });
    assert.deepEqual([state.plugins.list, state.plugins.jobsAllowed, state.plugins.maxFolderSongs], [[], false, null], 'a right gone, the copy gone: the window says so too');
    state.plugins.available = false;
    give({ plugins: [COPY], jobs: { allowed: true } });
    assert.deepEqual(state.plugins.list, [], 'no plug-ins on this server: nothing taken');
  });
  test('an older read of the window\'s own, answering after the page\'s, does not undo it', async () => {
    const old = deferred();
    const h = harness({ currentServer: { host: '' }, discoveryPlugins: () => old.promise });
    const asking = h.ensure.call(h.self);
    h.take({ plugins: [], jobs: { allowed: false } });
    old.resolve({ plugins: [COPY], jobs: { allowed: true, maxFolderSongs: 1000 } });
    await asking;
    assert.deepEqual([h.state.plugins.list, h.state.plugins.jobsAllowed], [[], false]);
  });
});

describe('the window\'s smaller markup rules (the 2026-10-23 review)', () => {
  const HTML = readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const CSS = readFileSync(new URL('../../webapp/alpha/spa.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  test('a landing radio is named by its label alone, described by its sub (read once each)', () => {
    assert.match(HTML, /<span :id="'dm-land-name-' \+ l\.mode" class="dm-land-name">\{\{ l\.label \}\}<\/span>/);
    assert.match(HTML, /class="dm-land-radio"[^>]*:aria-labelledby="'dm-land-name-' \+ l\.mode" :aria-describedby="'dm-land-sub-' \+ l\.mode"/);
  });
  test('the folder list\'s rows are plain buttons (the chosen folder is its head, never a row)', () => {
    assert.match(HTML, /<button v-for="d in discover\.modal\.keep\.tree\.dirs" :key="d" type="button" class="dm-dest-node" v-on:click="dmIntoInto\(d\)">/);
  });
  test('the queue menu\'s "Keep a copy…" is a button that opens a dialog, drawn as the menu\'s other entries', () => {
    assert.match(HTML, /<button type="button" id="pop-d-keep" class="pop-list-item pop-list-btn" style="display: none;" aria-haspopup="dialog" onclick="browseKeepQueue\(\);">/);
    assert.match(CSS, /\.pop-list-btn \{[^}]*width: 100%;[^}]*background: transparent;/);
    assert.match(CSS, /\.pop-list-btn:focus \{ background-color: rgba\(255,255,255,\.1\); outline: none; \}/);
  });
  test('a queue row\'s ⋮ carries the key of the song it shows now (the window\'s keyboard goes back to that song\'s, or to the queue)', () => {
    assert.match(VP_SRC, /class="np-queue-action popperMenu pop-d" title="More" :data-keep-key="song\.federation \? song\.federation\.peerId \+ '\|queue\|' \+ song\.filepath : null"/);
  });
  test('a long name with no space breaks anywhere in the window\'s notes', () => {
    for (const sel of ['dm-keep-out', 'dm-keep-cap', 'dm-land-note', 'dm-land-foot']) {
      assert.match(CSS, new RegExp(`\\.${sel} \\{[^}]*overflow-wrap: anywhere;`), sel);
    }
    assert.match(CSS, /\.dm-keep-out > span, \.dm-keep-cap > span, \.dm-land-note > span \{ min-width: 0; \}/);
  });
});

describe('the window\'s counts and a folder\'s credits that disagree (the 2026-10-23 review)', () => {
  test('counts in the app\'s language (DISCOVERJOBS.fmtCount), the cap line\'s too', () => {
    assert.match(vpMethodSrc('dmCount'), /text\.replace\(String\(n\), DISCOVERJOBS\.fmtCount\(n\)\)/);
    assert.match(vpMethodSrc('dmFolderCap'), /count: DISCOVERJOBS\.fmtCount\(scan\.songs\), cap: DISCOVERJOBS\.fmtCount\(cap\)/);
    assert.ok(!/toLocaleString\(\)/.test(VP_SRC), 'no count in the browser\'s own locale');
  });

  test('By your layout over a folder whose songs\' album credits disagree: "‹album artist›", and the note says why', async () => {
    const paths = TAPES3.map((t) => tapePath(t));
    const batch = (ps) => Object.fromEntries(ps.map((p, i) => [p, { filepath: p, metadata: tagsOf(p, { 'album-artist': i === 2 ? 'Various Artists' : 'Boukmanflow' }) }]));
    const { vm } = await browseWindow(folderTrack(), FOLDER_OPTS, { peer: peerB({ listing: paths, batch }) });
    vm.dmLandChoose('tags');
    await flush();
    const p = vm.dmDestPath('folder');
    assert.deepEqual([pathLine(p), p.files], ['copies › ‹album artist› › Borrowed Tapes', null]);
    assert.equal(p.slotNote, '‹album artist› comes from each song’s own tags, so these songs can land in more than one folder.');
  });
});
