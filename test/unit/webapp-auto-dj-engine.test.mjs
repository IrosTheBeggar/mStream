/**
 * The Auto DJ seeds in the player (webapp/assets/js/mstream.player.js; the
 * seeds model is AUTODJ.seeds in webapp/alpha/auto-dj.js, pinned by
 * auto-dj-seeds.test.mjs).
 *
 * What is pinned:
 *   - the random-songs body: More like as `similarTo` (pins first past
 *     eight) with `minSimilarity`, Less like as `lessLike` only to a server
 *     whose picker takes negatives, nothing while the scan is unfinished,
 *     and no more "sonic seed required" throw;
 *   - a DJ pick joins More like as it starts playing, before the top-up;
 *   - the user's Next: a quick skip leaves More like, a learned one joins
 *     Less like and re-rolls the DJ rows ahead as the replacement lands;
 *     picks of an older queue generation are discarded and asked again,
 *     and so is a batch a generation move cut short; the cooldowns advance
 *     only for the songs a landing queues;
 *   - a clear is a lane edge (the box, the deferred bootstrap), the heal of
 *     a refused seed (never sent again in its lane, the song playing
 *     included), the Skipped ring, the fan-out's negatives, and the panel's
 *     events;
 *   - the genre kind (`genreSource`, the Genres drawer's Generated | Tags):
 *     only with the filter on and narrowed, to a server whose version is
 *     known to take it — the local ask by /api/'s, each peer by its health
 *     `server` — and an answer asked under a kind is not re-checked on its
 *     genres; each peer's kind is read with the body, so a filter change
 *     while a round is out never marks an answer asked without one as
 *     asked under one.
 *
 * The player's closure functions are sliced out of the file and run against
 * the real AUTODJ module and stub servers, as webapp-auto-dj-moods does.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYER = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webapp', 'assets', 'js', 'mstream.player.js'), 'utf8');

const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  get length() { return _store.size; },
  key: (i) => Array.from(_store.keys())[i] ?? null,
};
const AUTODJ = require('../../webapp/alpha/auto-dj.js');
const SEEDS = AUTODJ.seeds;

beforeEach(() => {
  _store.clear();
  AUTODJ._internals.rehydrate();
  AUTODJ.reset();
});

// A function inside the player's module closure: two-space indent, ends at
// the first line that is exactly `  }`.
function sliceFn(name) {
  const lines = PLAYER.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`  function ${name}(`) || l.startsWith(`  async function ${name}(`));
  assert.ok(start >= 0, `mstream.player.js no longer defines ${name}() — update this test`);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`could not find the end of ${name}()`);
}

const FNS = [
  '_buildAutoDjBody', '_autoDjSongBlocked', '_federatedPeers', '_askPeerRandomSongs', '_autoDjFederatedPick',
  '_currentRow', '_sonicOn', '_wireTakesNegatives', '_fanOutRoute', '_fillBareSeeds', '_seedsBeginPick',
  '_emitAutoDj', '_updateAutoDjAnchorsOnSongChange', '_judgeQuickSkip', '_negativesSent', '_landDjPicks',
  '_dropRerolled', '_isSkippedBlend', '_isSeedRefusal', '_healSonicSeeds', '_autoDjRunOnce', 'autoDJ',
  '_showSimilarArtistsInfoStrip', '_seedsOnClear', '_seedsOnToggle', '_noteRingSkip', '_topUpIfLast',
];

// What an async API returns: the stub's value as a settled promise and a
// throw as a rejection, its side effects at the call — an async arrow's
// behaviour, without one that awaits nothing.
const resolving = (fn) => (...args) => {
  try {
    return Promise.resolve(fn(...args));
  } catch (err) {
    return Promise.reject(err);
  }
};

/** The player's Auto DJ functions over stub servers. `answers` are what this
 * server's random-songs returns, in turn (an Error rejects, a function is
 * called for its answer). */
function makeEngine({ server = {}, answers = [], embeddings = null } = {}) {
  const asked = [];
  const queued = [];
  const toasts = [];
  const timers = [];
  const bootstraps = [];
  const removed = [];
  const counts = { saved: 0 };
  const mm = {
    playlist: [],
    positionCache: { val: -1 },
    current: null,
    playerStats: { autoDJ: true, metadata: {}, currentTime: 0, duration: 0 },
    getCurrentSong: () => mm.current,
    removeSongAtPosition: (i) => { removed.push(mm.playlist[i]); mm.playlist.splice(i, 1); },
  };
  const api = {
    currentServer: { vpaths: ['music'], discovery: true, autoDj: 1, moodFilters: false, federationBrowse: false, ...server },
    getRandomSong: resolving((body) => {
      asked.push({ to: 'local', body });
      const a = answers.shift();
      if (a instanceof Error) { throw a; }
      return typeof a === 'function' ? a(body) : a;
    }),
    discoveryEmbeddings: resolving((paths) => (typeof embeddings === 'function' ? embeddings(paths) : embeddings)),
    lookupMetadata: resolving((filepath) => ({ filepath, metadata: null })),
    federationPeers: resolving(() => ({ peers: [] })),
    peer: { health: resolving(() => ({})), randomSongs: resolving(() => ({ songs: [] })), discoveryEmbeddings: resolving(() => null) },
  };
  const vpc = {
    addSongWizard: resolving((filepath, metadata) => {
      mm.playlist.push({ rawFilePath: filepath, filepath, metadata });
      queued.push(filepath);
    }),
    addFederationSongWizard: (peer, filepath, metadata) => {
      mm.playlist.push({ rawFilePath: filepath, filepath, metadata, federation: { peerId: peer.id } });
      queued.push(`${peer.id}:${filepath}`);
    },
    saveLiveQueue: () => { counts.saved++; },
  };
  const globals = {
    AUTODJ,
    MSTREAMAPI: api,
    VUEPLAYERCORE: vpc,
    mstreamModule: mm,
    _fetchSimilarArtists: resolving(() => []),
    t: (k) => k,
    iziToast: { warning: (o) => toasts.push(o), info: () => {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    _autoDjQueueN: (n) => { bootstraps.push(n); },
  };
  const body = `
    'use strict';
    let autoDjIgnoreArray = [];
    let _fedPeersCache = null;
    const FED_PEERS_TTL_MS = 5 * 60 * 1000;
    let _djQueueGen = 0;
    let _rerollOwed = null;
    const _autoDjListeners = new Set();
    const _bareAsked = new Set();
    let _autoDjInFlight = null;
    let _autoDjAbortController = null;
    let _autoDjSimilarCache = { sourceArtist: null, artists: null };
    let playSession = null;
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      fns: { ${FNS.join(', ')} },
      get gen() { return _djQueueGen; },
      set gen(v) { _djQueueGen = v; },
      get owed() { return _rerollOwed; },
      set owed(v) { _rerollOwed = v; },
      set session(v) { playSession = v; },
      listeners: _autoDjListeners,
    };
  `;
  const names = Object.keys(globals);
  const E = new Function(...names, body)(...names.map((n) => globals[n]));
  return { E, mm, api, vpc, asked, queued, toasts, timers, bootstraps, removed, counts };
}

// Queue rows (song objects as addSongWizard builds them) and answers.
const row = (name, meta = {}, extra = {}) => ({
  rawFilePath: `music/${name}.mp3`, filepath: `music/${name}.mp3`, metadata: { title: name, artist: `${name} band`, ...meta }, ...extra,
});
const djRow = (name, lane, extra = {}) => row(name, { _djPicked: true, _djLane: lane }, extra);
const answer = (names, ignoreList = [1, 2]) => ({
  songs: names.map((n) => ({ filepath: `music/${n}.mp3`, metadata: { title: n, artist: `${n} band` } })),
  ignoreList,
});
const song = (name, extra = {}) => ({ owner: null, path: `music/${name}.mp3`, title: name, artist: '', album: '', art: null, duration: null, ...extra });
const refusal = (status, error) => Object.assign(new Error(`refused ${status}`), { status, body: { error } });

// A running lane: the DJ on, its first pick made.
function lane() {
  SEEDS.setArmed(true);
  SEEDS.laneEdge({});
  SEEDS.beginPick({ current: null });
}

function playing(eng, rows, pos, { heardMs = 1500, durationMs = 200000 } = {}) {
  eng.mm.playlist = rows;
  eng.mm.positionCache.val = pos;
  eng.mm.current = rows[pos];
  eng.E.session = { filePath: rows[pos].rawFilePath, playedMs: heardMs, durationMs };
}

const paths = (rows) => rows.map((r) => r.path);

// ─────────────────────────────────────────────────────────────────────
// 1. the body
// ─────────────────────────────────────────────────────────────────────

describe('the random-songs body: More like and Less like on the wire', () => {
  test('similarTo carries More like, pins first past eight, with minSimilarity', async () => {
    _store.set('mstream-dj-sonicAnchorMode', JSON.stringify('locked'));
    _store.set('mstream-dj-seedsRows', JSON.stringify([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ list: 'more', path: `music/pin${i}.mp3`, title: `pin${i}`, pinned: true, origin: 'manual', at: 1 })),
      { list: 'more', path: 'music/anchor.mp3', title: 'anchor', pinned: false, origin: 'anchor', at: 2 },
    ]));
    AUTODJ._internals.rehydrate();
    const { E } = makeEngine();
    AUTODJ.setState({ sonicEnabled: true, sonicMinSimilarity: 0.7 });
    const { body } = await E.fns._buildAutoDjBody({});
    assert.deepEqual(body.similarTo, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `music/pin${i}.mp3`));
    assert.equal(body.minSimilarity, 0.7);

    _store.clear();
    AUTODJ._internals.rehydrate();
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('more', song('a'));
    SEEDS.onPlay(song('b'), { lanePick: true });
    assert.deepEqual((await E.fns._buildAutoDjBody({})).body.similarTo, ['music/a.mp3', 'music/b.mp3'], 'Drift: oldest first');
  });

  test('lessLike only with sonic on, a server at autoDj ≥ 1 with discovery, and readiness not false', async () => {
    const { E, api } = makeEngine();
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('less', song('skip1'));
    SEEDS.add('less', song('skip2'));
    const build = async () => (await E.fns._buildAutoDjBody({})).body;
    assert.deepEqual((await build()).lessLike, ['music/skip1.mp3', 'music/skip2.mp3']);
    api.currentServer.autoDj = 0;
    assert.equal('lessLike' in await build(), false, 'a picker from before negatives');
    delete api.currentServer.autoDj;
    assert.equal('lessLike' in await build(), false, 'before the ping answers');
    api.currentServer.autoDj = 2;
    api.currentServer.discoveryReady = false;
    assert.equal('lessLike' in await build(), false, 'the scan has not finished');
    api.currentServer.discoveryReady = undefined;
    assert.equal((await build()).lessLike.length, 2, 'unknown readiness reads ready');
    api.currentServer.discovery = false;
    assert.equal('lessLike' in await build(), false, 'discovery off');
    api.currentServer.discovery = true;
    AUTODJ.setState({ sonicEnabled: false });
    assert.equal('lessLike' in await build(), false, 'sonic off');
  });

  test('no lessLike key when Less like is empty', async () => {
    const { E } = makeEngine();
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('more', song('a'));
    const { body } = await E.fns._buildAutoDjBody({});
    assert.equal('lessLike' in body, false);
    assert.deepEqual(body.similarTo, ['music/a.mp3']);
  });

  test('Stay close with no rows sends lessLike and neither sonic field', async () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true });
    SEEDS.setMode('locked');
    lane();
    SEEDS.add('less', song('skip'));
    playing(eng, [row('cur')], 0);
    const { body } = await eng.E.fns._buildAutoDjBody({});
    assert.deepEqual(body.lessLike, ['music/skip.mp3']);
    assert.equal('similarTo' in body, false);
    assert.equal('minSimilarity' in body, false);
  });

  test('sonic off sends none of the four', async () => {
    const eng = makeEngine();
    lane();
    SEEDS.add('more', song('a'));
    SEEDS.add('less', song('b'));
    playing(eng, [row('cur')], 0);
    const { body } = await eng.E.fns._buildAutoDjBody({});
    for (const key of ['similarTo', 'minSimilarity', 'lessLike', 'similarToVector']) {
      assert.equal(key in body, false, key);
    }
  });

  test('a server whose scan has not finished (discoveryReady: false) gets no positives; unknown readiness does', async () => {
    const eng = makeEngine({ server: { discoveryReady: false } });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('more', song('a'));
    playing(eng, [row('cur')], 0);
    const before = await eng.E.fns._buildAutoDjBody({});
    assert.equal('similarTo' in before.body, false);
    assert.equal('minSimilarity' in before.body, false);
    eng.api.currentServer.discoveryReady = undefined;
    assert.deepEqual((await eng.E.fns._buildAutoDjBody({})).body.similarTo, ['music/a.mp3']);
    eng.api.currentServer.discoveryReady = true;
    assert.deepEqual((await eng.E.fns._buildAutoDjBody({})).body.similarTo, ['music/a.mp3']);
  });

  test('no anchor no longer throws', async () => {
    const { E } = makeEngine();
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    const { body } = await E.fns._buildAutoDjBody({});
    assert.equal('similarTo' in body, false);
    assert.equal('minSimilarity' in body, false);
    assert.equal(/sonic seed required|sonicSeedNeeded/.test(PLAYER), false, 'the throw and its toast are gone');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. join before the top-up
// ─────────────────────────────────────────────────────────────────────

describe('a DJ pick joins More like before the top-up', () => {
  test('goToSong resets the metadata before it tops up', () => {
    const src = sliceFn('goToSong');
    const reset = src.indexOf('mstreamModule.resetCurrentMetadata();');
    const topUp = src.indexOf('_topUpIfLast(position);');
    assert.ok(reset > 0, 'goToSong resets the metadata');
    assert.ok(topUp > reset, 'the top-up comes after the starting song joined');
    assert.equal(/\bautoDJ\(\)/.test(src), false, 'goToSong itself no longer calls autoDJ()');
    assert.match(sliceFn('_topUpIfLast'), /position === mstreamModule\.playlist\.length - 1\) \{\s*autoDJ\(\);/);
  });

  test('a DJ pick that starts playing is in the next body', async () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('more', song('pin'));
    const pick = djRow('pick', SEEDS.laneId());
    playing(eng, [pick], 0);
    eng.E.fns._updateAutoDjAnchorsOnSongChange(pick);
    assert.deepEqual((await eng.E.fns._buildAutoDjBody({})).body.similarTo, ['music/pin.mp3', 'music/pick.mp3']);
    const old = djRow('old', SEEDS.laneId() - 1);
    playing(eng, [pick, old], 1);
    eng.E.fns._updateAutoDjAnchorsOnSongChange(old);
    assert.deepEqual(paths(SEEDS.view().more), ['music/pick.mp3', 'music/pin.mp3'], "an old lane's pick never joins as it plays");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. the quick-skip judge
// ─────────────────────────────────────────────────────────────────────

describe("the quick-skip judge (the user's Next)", () => {
  test('a DJ pick heard 1.5 s with a next row is a skip; learned with Learn on', () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    lane();
    const id = SEEDS.laneId();
    const pick = djRow('pick', id);
    const next = djRow('next', id);
    const later = djRow('later', id);
    SEEDS.onPlay(SEEDS.factsFromSong(pick), { lanePick: true });
    playing(eng, [pick, next, later], 0);
    const gen = eng.E.gen;
    const owed = eng.E.fns._judgeQuickSkip();
    const v = SEEDS.view();
    assert.deepEqual(v.more, []);
    assert.deepEqual(v.less.map((r) => [r.path, r.pinned, r.origin]), [['music/pick.mp3', false, 'skip']]);
    assert.equal(eng.E.gen, gen + 1, 'a learned skip moves the queue generation');
    assert.equal(owed.stale.length, 1);
    assert.equal(owed.stale[0], later, 'the DJ rows after the row the Next lands on, by identity');
  });

  test('no next row, heard under a second, 30 s, half a known length, DJ off, Stay close: no skip', () => {
    const cases = [
      ['no next row', { rows: 1 }],
      ['heard under a second', { heardMs: 999 }],
      ['30 s', { heardMs: 30000 }],
      ['half a known length', { heardMs: 10000, durationMs: 20000 }],
      ['DJ off', { off: true }],
      ['Stay close', { locked: true }],
    ];
    for (const [name, c] of cases) {
      _store.clear();
      AUTODJ._internals.rehydrate();
      const eng = makeEngine();
      AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
      lane();
      const id = SEEDS.laneId();
      const pick = djRow('pick', id);
      SEEDS.onPlay(SEEDS.factsFromSong(pick), { lanePick: true });
      if (c.locked) { SEEDS.setMode('locked'); }
      if (c.off) { eng.mm.playerStats.autoDJ = false; }
      const rows = c.rows === 1 ? [pick] : [pick, djRow('next', id)];
      playing(eng, rows, 0, { heardMs: c.heardMs ?? 1500, durationMs: c.durationMs ?? 200000 });
      assert.equal(eng.E.fns._judgeQuickSkip(), null, name);
      assert.deepEqual(paths(SEEDS.view().more), ['music/pick.mp3'], `${name}: More like keeps it`);
      assert.deepEqual(SEEDS.view().less, [], name);
    }
  });

  test('the blended user song leaves More like and teaches nothing; the next answer passes over it', async () => {
    const eng = makeEngine({ answers: [answer(['cur', 'other'])] });
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    SEEDS.setArmed(true);
    SEEDS.laneEdge({});
    const cur = row('cur');
    const next = row('next');
    playing(eng, [cur, next], 0, { heardMs: 2000 });
    eng.E.fns._seedsBeginPick();
    assert.deepEqual(SEEDS.view().more.map((r) => [r.path, r.origin]), [['music/cur.mp3', 'opener']], 'the lane start blended it');
    const gen = eng.E.gen;
    assert.equal(eng.E.fns._judgeQuickSkip(), null, 'nothing to re-roll');
    assert.equal(eng.E.gen, gen);
    assert.deepEqual(SEEDS.view().more, []);
    assert.deepEqual(SEEDS.view().less, [], 'nothing learned from the user\'s own song');
    assert.equal(SEEDS.skippedBlendKey(), 'local|music/cur.mp3');
    eng.mm.positionCache.val = 1;
    eng.mm.current = next;
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'queued');
    assert.deepEqual(eng.queued, ['music/other.mp3']);
  });

  test('a peer pick leaves More like but is not learned', () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    lane();
    const pick = djRow('peerpick', SEEDS.laneId(), { federation: { peerId: 7, peerName: 'P' } });
    SEEDS.onPlay(SEEDS.factsFromSong(pick), { lanePick: true });
    assert.deepEqual(SEEDS.view().more.map((r) => r.key), ['7|music/peerpick.mp3']);
    playing(eng, [pick, row('next')], 0);
    assert.equal(eng.E.fns._judgeQuickSkip(), null);
    assert.deepEqual(SEEDS.view().more, []);
    assert.deepEqual(SEEDS.view().less, []);
  });

  test('a Less like row that ran out before the skip re-rolls nothing', () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: false });
    lane();
    SEEDS.quickSkip(song('gone'), { djPick: true, learn: true, now: Date.now() - 31 * 60000 });
    const id = SEEDS.laneId();
    const pick = djRow('pick', id);
    SEEDS.onPlay(SEEDS.factsFromSong(pick), { lanePick: true });
    playing(eng, [pick, djRow('next', id), djRow('later', id)], 0);
    const gen = eng.E.gen;
    assert.equal(eng.E.fns._judgeQuickSkip(), null);
    assert.equal(eng.E.gen, gen, 'the expiry is not taken for the skip\'s doing');
    assert.deepEqual(SEEDS.view().more, [], 'the skip still took the pick out');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. the re-roll and stale picks
// ─────────────────────────────────────────────────────────────────────

describe('the re-roll and stale picks', () => {
  test('a learned skip names the DJ rows after the landed row', () => {
    const eng = makeEngine();
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true });
    lane();
    const id = SEEDS.laneId();
    const pick = djRow('pick', id);
    const user1 = row('user1');
    const dj2 = djRow('dj2', id);
    const user3 = row('user3');
    const dj4 = djRow('dj4', id - 1);
    SEEDS.onPlay(SEEDS.factsFromSong(pick), { lanePick: true });
    playing(eng, [pick, user1, dj2, user3, dj4], 0);
    const owed = eng.E.fns._judgeQuickSkip();
    assert.equal(owed.stale.length, 2);
    assert.ok(owed.stale[0] === dj2 && owed.stale[1] === dj4, 'any lane\'s DJ rows after the landed one, by identity');
  });

  test('the landing drops them nearest first, at most as many as it brought, and queues one per row dropped', async () => {
    const eng = makeEngine();
    lane();
    const id = SEEDS.laneId();
    const cur = djRow('cur', id);
    const dj1 = djRow('dj1', id);
    const user = row('user');
    const dj2 = djRow('dj2', id);
    playing(eng, [cur, dj1, user, dj2], 0);
    eng.E.owed = { stale: [dj1, dj2] };
    const picks = [{ filepath: 'music/new1.mp3', meta: { title: 'new1' }, peer: null }];
    assert.equal(await eng.E.fns._landDjPicks(picks, { gen: eng.E.gen, lane: id }), 'queued');
    assert.deepEqual(eng.removed, [dj1], 'the nearest stale row');
    assert.deepEqual(eng.mm.playlist.map((r) => r.metadata.title), ['cur', 'user', 'dj2', 'new1']);
    assert.equal(eng.E.owed, null, 'the re-roll is settled');
    assert.deepEqual([eng.mm.playlist[3].metadata._djPicked, eng.mm.playlist[3].metadata._djLane], [true, id]);
    assert.equal(eng.counts.saved, 1, 'a live playlist is saved after the drop');
  });

  test('nothing droppable with rows ahead queues nothing; the last row takes the whole batch', async () => {
    const eng = makeEngine();
    lane();
    const id = SEEDS.laneId();
    const cur = djRow('cur', id);
    const picks = [
      { filepath: 'music/p1.mp3', meta: {}, peer: null },
      { filepath: 'music/p2.mp3', meta: {}, peer: null },
    ];
    playing(eng, [cur, row('user')], 0);
    eng.E.owed = { stale: [djRow('gone', id)] };
    assert.equal(await eng.E.fns._landDjPicks(picks, { gen: eng.E.gen, lane: id }), 'none');
    assert.deepEqual(eng.queued, []);
    playing(eng, [cur], 0);
    eng.E.owed = { stale: [] };
    assert.equal(await eng.E.fns._landDjPicks(picks, { gen: eng.E.gen, lane: id }), 'queued');
    assert.deepEqual(eng.queued, ['music/p1.mp3', 'music/p2.mp3']);
  });

  test('a pick whose generation moved is discarded before its side effects and asked again', async () => {
    const answers = [
      () => { eng.E.gen += 1; return answer(['stale'], [99]); },
      answer(['fresh'], [1, 2]),
    ];
    const eng = makeEngine({ answers });
    lane();
    await eng.E.fns.autoDJ();
    assert.equal(eng.asked.length, 2, 'asked again');
    assert.deepEqual(eng.asked[1].body.ignoreList, [], "the stale answer's ignoreList was never kept");
    assert.deepEqual(eng.queued, ['music/fresh.mp3']);
    assert.deepEqual(AUTODJ.getArtistHistory(), ['fresh band'], 'no cooldown from the stale pick');
    assert.deepEqual(AUTODJ.getIgnoreList(), [1, 2]);
    assert.deepEqual(eng.toasts, []);
  });

  test('a batch whose generation moves during an awaited add queues no more of it, and is run again', async () => {
    const eng = makeEngine();
    lane();
    eng.vpc.addSongWizard = resolving((filepath) => { eng.queued.push(filepath); eng.E.gen += 1; });
    const picks = ['a', 'b', 'c'].map((n) => ({ filepath: `music/${n}.mp3`, meta: {}, peer: null }));
    assert.equal(await eng.E.fns._landDjPicks(picks, { gen: eng.E.gen, lane: SEEDS.laneId() }), 'stale',
      'the queue moved on: autoDJ() asks again for the new one');
    assert.deepEqual(eng.queued, ['music/a.mp3']);
    // a move during the last add of a batch (here its only one) is the same
    eng.queued.length = 0;
    assert.equal(await eng.E.fns._landDjPicks(picks.slice(0, 1), { gen: eng.E.gen, lane: SEEDS.laneId() }), 'stale');
    assert.deepEqual(eng.queued, ['music/a.mp3']);
  });

  // A live playlist: each add awaits its save (MSTREAMAPI.addToPlaylist),
  // and [during](n) runs while the n-th add is out.
  function savingAdds(eng, during) {
    let adds = 0;
    eng.vpc.addSongWizard = async (filepath, metadata) => {
      eng.mm.playlist.push({ rawFilePath: filepath, filepath, metadata });
      eng.queued.push(filepath);
      adds++;
      await Promise.resolve();
      during(adds);
    };
  }

  test('a learned skip between two awaited adds of a batch runs the pick again: the re-roll lands', async () => {
    const eng = makeEngine({ answers: [answer(['n1', 'n2']), answer(['r1', 'r2'])] });
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true, djLimit: 2 });
    lane();
    const id = SEEDS.laneId();
    const d1 = djRow('d1', id);
    SEEDS.onPlay(SEEDS.factsFromSong(d1), { lanePick: true });
    playing(eng, [d1, djRow('d2', id), djRow('d3', id)], 0);
    savingAdds(eng, (n) => {
      if (n !== 1) { return; }
      // the user's Next on d1 (mstreamModule.nextSong): judged, the move,
      // then its autoDJ() joins the pick in flight
      const owed = eng.E.fns._judgeQuickSkip();
      assert.deepEqual(owed.stale.map((r) => r.metadata.title), ['d3', 'n1'], 'd3 and the song just added were chosen without the negative');
      eng.mm.positionCache.val = 1;
      eng.mm.current = eng.mm.playlist[1];
      eng.E.owed = owed;
      eng.E.fns.autoDJ();
    });
    await eng.E.fns.autoDJ();
    assert.equal(eng.asked.length, 2, 'asked again for the new queue');
    assert.deepEqual(eng.asked[1].body.lessLike, ['music/d1.mp3'], 'with the negative');
    assert.equal(eng.E.owed, null, 'the re-roll is settled');
    assert.deepEqual(eng.mm.playlist.map((r) => r.metadata.title), ['d1', 'd2', 'r1', 'r2'], 'the stale rows replaced');
    assert.deepEqual(eng.toasts, []);
  });

  test('a learned skip onto the song just added, now the last row, still gets its lookahead', async () => {
    const eng = makeEngine({ answers: [answer(['n1', 'n2']), answer(['r1', 'r2'])] });
    AUTODJ.setState({ sonicEnabled: true, learnFromSkips: true, djLimit: 2 });
    lane();
    const dk = djRow('dk', SEEDS.laneId());
    SEEDS.onPlay(SEEDS.factsFromSong(dk), { lanePick: true });
    playing(eng, [dk], 0);
    savingAdds(eng, (n) => {
      if (n !== 1) { return; }
      assert.equal(eng.E.fns._judgeQuickSkip(), null, 'no DJ row after the one the Next lands on');
      eng.mm.positionCache.val = 1;
      eng.mm.current = eng.mm.playlist[1];
      eng.E.fns._topUpIfLast(1); // goToSong(n1): it is the last row
    });
    await eng.E.fns.autoDJ();
    assert.equal(eng.asked.length, 2);
    assert.deepEqual(eng.mm.playlist.map((r) => r.metadata.title), ['dk', 'n1', 'r1', 'r2']);
    assert.deepEqual(eng.toasts, []);
  });

  test('a Clear Playlist during an awaited add refills the queue', async () => {
    const eng = makeEngine({ answers: [answer(['n1', 'n2']), answer(['r1', 'r2'])] });
    AUTODJ.setState({ djLimit: 2 });
    lane();
    playing(eng, [djRow('dk', SEEDS.laneId())], 0);
    savingAdds(eng, (n) => {
      if (n !== 1) { return; }
      eng.mm.playlist.length = 0;
      eng.mm.positionCache.val = -1;
      eng.mm.current = null;
      eng.E.fns._seedsOnClear(true, true);
    });
    await eng.E.fns.autoDJ();
    assert.equal(eng.asked.length, 2);
    assert.deepEqual(eng.mm.playlist.map((r) => [r.metadata.title, r.metadata._djLane]), [['r1', SEEDS.laneId()], ['r2', SEEDS.laneId()]],
      'the new lane\'s picks');
    assert.deepEqual(eng.toasts, []);
  });

  test('a trimmed re-roll leaves only the queued songs\' artists in the cooldown; the answer\'s ignoreList is kept', async () => {
    const eng = makeEngine({ answers: [answer(['n1', 'n2', 'n3'], [7, 8, 9])] });
    AUTODJ.setState({ djLimit: 3 });
    lane();
    const id = SEEDS.laneId();
    const d2 = djRow('d2', id);
    playing(eng, [djRow('d0', id), djRow('d1', id), d2, row('u')], 1);
    eng.E.owed = { stale: [d2] };
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'queued');
    assert.deepEqual(eng.queued, ['music/n1.mp3'], 'one song per row dropped');
    assert.deepEqual(AUTODJ.getArtistHistory(), ['n1 band'], 'n2 and n3 were never queued');
    assert.deepEqual(AUTODJ.getIgnoreList(), [7, 8, 9], 'the phone takes the answer\'s list too');
  });

  test('a re-roll that queues nothing leaves no artist in the cooldown', async () => {
    const eng = makeEngine({ answers: [answer(['Replacement'], [42])] });
    lane();
    const id = SEEDS.laneId();
    playing(eng, [djRow('cur', id), row('user')], 0);
    eng.E.owed = { stale: [djRow('gone', id)] };
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'none');
    assert.deepEqual(eng.queued, []);
    assert.deepEqual(AUTODJ.getArtistHistory(), []);
    assert.deepEqual(AUTODJ.getIgnoreList(), [42]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. clears
// ─────────────────────────────────────────────────────────────────────

describe('a clear is a lane edge (_seedsOnClear)', () => {
  test('a user clear with the box ticked takes the pins when the queue held a row', () => {
    const { E } = makeEngine();
    lane();
    SEEDS.add('more', song('pin'));
    E.fns._seedsOnClear(true, true);
    assert.deepEqual(paths(SEEDS.view().more), ['music/pin.mp3'], 'the box off: pins stay');
    AUTODJ.setState({ clearPinsOnQueueClear: true });
    E.fns._seedsOnClear(true, false);
    assert.deepEqual(paths(SEEDS.view().more), ['music/pin.mp3'], 'an empty queue: the box does nothing');
    const lane0 = SEEDS.laneId();
    const gen0 = E.gen;
    E.fns._seedsOnClear(true, true);
    assert.deepEqual(SEEDS.view().more, []);
    assert.equal(SEEDS.laneId(), lane0 + 1);
    assert.equal(E.gen, gen0 + 1);
  });

  test('the boot clear never takes them', () => {
    const { E } = makeEngine();
    AUTODJ.setState({ clearPinsOnQueueClear: true });
    lane();
    SEEDS.add('more', song('pin'));
    E.fns._seedsOnClear(false, true);
    assert.deepEqual(paths(SEEDS.view().more), ['music/pin.mp3']);
    const clear = PLAYER.slice(PLAYER.indexOf('mstreamModule.clearPlaylist = function (opts) {'));
    assert.match(clear, /const userClear = !\(opts && opts\.userClear === false\);\s*const hadRows = mstreamModule\.playlist\.length > 0;/);
    assert.match(clear.slice(0, clear.indexOf('\n  }\n')), /_seedsOnClear\(userClear, hadRows\);/);
  });

  test('rows added right after a clear start the lane: no bootstrap', () => {
    const { E, mm, timers, bootstraps } = makeEngine();
    lane();
    E.fns._seedsOnClear(true, true);
    assert.deepEqual(bootstraps, [], 'not at once');
    mm.playlist.push(row('replacing'));
    timers.forEach((fn) => fn());
    assert.deepEqual(bootstraps, []);
  });

  test('an empty queue after a clear bootstraps two', () => {
    const { E, mm, timers, bootstraps } = makeEngine();
    lane();
    E.fns._seedsOnClear(true, true);
    timers.forEach((fn) => fn());
    assert.deepEqual(bootstraps, [2]);
    mm.playerStats.autoDJ = false;
    E.fns._seedsOnClear(true, false);
    assert.equal(timers.length, 1, 'with the DJ off nothing is scheduled');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. the heal of a refused seed
// ─────────────────────────────────────────────────────────────────────

describe('the dead-seed heal', () => {
  test('an unanalysed unpinned row is dropped and the pick retried', async () => {
    const eng = makeEngine({
      answers: [refusal(400, 'Sonic seed track has not been analyzed yet'), answer(['ok'])],
      embeddings: (ps) => ({
        model: { id: 'm' },
        dim: 2,
        tracks: ps.map((p) => ({ filePath: p, notAnalyzed: p === 'music/a.mp3', embedding: p === 'music/a.mp3' ? null : 'AAAAAAAAAAA=' })),
      }),
    });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.onPlay(song('a'), { lanePick: true });
    SEEDS.onPlay(song('b'), { lanePick: true });
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'queued');
    assert.deepEqual(eng.asked.map((a) => a.body.similarTo), [['music/a.mp3', 'music/b.mp3'], ['music/b.mp3']]);
    assert.deepEqual(paths(SEEDS.view().more), ['music/b.mp3']);
    assert.deepEqual(eng.queued, ['music/ok.mp3']);
  });

  test('a pinned culprit is set aside for the lane', async () => {
    const eng = makeEngine({ answers: [refusal(404, 'Track not found'), answer(['ok'])] });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.add('more', song('pin'));
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'queued');
    assert.deepEqual(eng.asked.map((a) => a.body.similarTo), [['music/pin.mp3'], undefined]);
    assert.deepEqual(paths(SEEDS.view().more), ['music/pin.mp3'], 'still listed');
    assert.deepEqual(SEEDS.positives({}), [], 'out of this lane\'s requests');
    SEEDS.laneEdge({});
    assert.deepEqual(SEEDS.positives({}).map((p) => p.path), ['music/pin.mp3'], 'a new lane tries it again');
  });

  test("no culprit keeps today's toast", async () => {
    const eng = makeEngine({ answers: [refusal(400, 'No tracks have been analyzed yet')] });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.onPlay(song('a'), { lanePick: true });
    await eng.E.fns.autoDJ();
    assert.equal(eng.asked.length, 1);
    assert.deepEqual(eng.toasts.map((t) => [t.title, t.message]), [['autoDJ.sonicToastTitle', 'autoDJ.sonicSeedUnanalyzed']]);
    assert.deepEqual(paths(SEEDS.view().more), ['music/a.mp3']);
    const two = makeEngine({
      answers: [refusal(400, 'Sonic seed track has not been analyzed yet')],
      embeddings: (ps) => ({ model: { id: 'm' }, dim: 2, tracks: ps.map((p) => ({ filePath: p, notAnalyzed: false, embedding: 'AAAAAAAAAAA=' })) }),
    });
    SEEDS.onPlay(song('b'), { lanePick: true });
    await assert.rejects(two.E.fns._autoDjRunOnce(null), (err) => err.djToast && err.djToast.message === 'autoDJ.sonicSeedUnanalyzed');
    assert.deepEqual(paths(SEEDS.view().more), ['music/b.mp3', 'music/a.mp3'], 'no row explains it: nothing dropped');
  });

  // A server that refuses every body seeded with [path] (not analysed yet)
  // and otherwise answers with the song 'ok'.
  const refusing = (path) => (body) => {
    if (Array.isArray(body.similarTo) && body.similarTo.includes(path)) {
      throw refusal(400, 'Sonic seed track has not been analyzed yet');
    }
    return answer(['ok']);
  };

  test('a refused blend that is the song playing is not sent again: the retry goes plain', async () => {
    const server = refusing('music/S.mp3');
    const eng = makeEngine({ answers: [server, server, server] });
    AUTODJ.setState({ sonicEnabled: true });
    // Drift, no pins: the lane starts on the user's song S, not analysed yet
    SEEDS.setArmed(true);
    SEEDS.laneEdge({});
    const S = row('S');
    playing(eng, [S], 0);
    await eng.E.fns.autoDJ();
    assert.deepEqual(eng.asked.map((a) => a.body.similarTo), [['music/S.mp3'], undefined], 'the refused seed is not sent again');
    assert.equal('minSimilarity' in eng.asked[1].body, false);
    assert.deepEqual(eng.toasts, [], 'no failure');
    assert.deepEqual(eng.queued, ['music/ok.mp3'], 'the pick lands');
    assert.deepEqual(SEEDS.view().more, [], 'the blend left More like');
    assert.equal('similarTo' in (await eng.E.fns._buildAutoDjBody({})).body, false, 'nor is it the fallback later in the lane');
  });

  test('a lone unanalysed DJ pick, playing and the only More like row, is not sent again either', async () => {
    const server = refusing('music/P.mp3');
    const eng = makeEngine({ answers: [server, server, server] });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    const P = djRow('P', SEEDS.laneId());
    playing(eng, [P], 0);
    eng.E.fns._updateAutoDjAnchorsOnSongChange(P);
    assert.deepEqual(paths(SEEDS.view().more), ['music/P.mp3'], 'it joined as it started');
    await eng.E.fns.autoDJ();
    assert.deepEqual(eng.asked.map((a) => a.body.similarTo), [['music/P.mp3'], undefined]);
    assert.deepEqual(eng.toasts, []);
    assert.deepEqual(eng.queued, ['music/ok.mp3']);
  });

  test('a refusal that lands after a lane edge heals nothing and is asked again', async () => {
    const answers = [() => { eng.E.gen += 1; throw refusal(400, 'Sonic seed track has not been analyzed yet'); }];
    const eng = makeEngine({ answers });
    AUTODJ.setState({ sonicEnabled: true });
    lane();
    SEEDS.onPlay(song('a'), { lanePick: true });
    assert.equal(await eng.E.fns._autoDjRunOnce(null), 'stale');
    assert.deepEqual(paths(SEEDS.view().more), ['music/a.mp3'], 'nothing dropped');
    assert.deepEqual(SEEDS.positives({}).map((p) => p.path), ['music/a.mp3'], 'nothing set aside');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. the Skipped ring
// ─────────────────────────────────────────────────────────────────────

describe('the Skipped ring from endPlaySession (_noteRingSkip)', () => {
  test('a skip heard 2 s joins the ring and emits skip; one under a second or counted does not', () => {
    const { E } = makeEngine();
    const heard = [];
    E.listeners.add((r) => heard.push(r));
    E.fns._noteRingSkip({ outcome: 'skipped', playedMs: 2000, durationMs: 200000 }, row('two'));
    assert.deepEqual(SEEDS.recentSkips().map((f) => f.path), ['music/two.mp3']);
    assert.deepEqual(heard, ['skip']);
    E.fns._noteRingSkip({ outcome: 'skipped', playedMs: 999 }, row('short'));
    E.fns._noteRingSkip({ outcome: 'skipped', playedMs: 30000 }, row('counted'));
    E.fns._noteRingSkip({ outcome: 'skipped', playedMs: 11000, durationMs: 20000 }, row('half'));
    E.fns._noteRingSkip({ outcome: 'completed', playedMs: 2000 }, row('done'));
    E.fns._noteRingSkip({ outcome: 'skipped', playedMs: 2000 }, null);
    assert.deepEqual(SEEDS.recentSkips().map((f) => f.path), ['music/two.mp3']);
    assert.deepEqual(heard, ['skip']);
    assert.match(sliceFn('endPlaySession'),
      /const play = MSTREAMPLAYSESSION\.finish\(session, outcome\);\s*if \(!play\) \{ return; \}\s*_noteRingSkip\(play, song\);/);
    assert.match(sliceFn('beginPlaySession'), /playSessionSong = song;/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. the fan-out and Less like
// ─────────────────────────────────────────────────────────────────────

describe('the fan-out and Less like', () => {
  const ans = (name, sim, extra = {}) => ({
    songs: [{ filepath: `music/${name}.mp3`, metadata: { title: name, artist: `${name} band` } }],
    ignoreList: [],
    sonic: { similarities: [sim] },
    ...extra,
  });

  function fanOut(local, peerAnswer) {
    const eng = makeEngine({ server: { federationBrowse: true } });
    const { api } = eng;
    api.federationPeers = resolving(() => ({ peers: [{ id: 7, name: 'Peer' }] }));
    api.peer.health = resolving(() => ({ discovery: { modelId: 'm1' } }));
    api.discoveryEmbeddings = resolving(() => ({ model: { id: 'm1' }, dim: 2, tracks: [{ embedding: AUTODJ.encodeWireVector([1, 0]) }] }));
    api.getRandomSong = resolving((body) => { eng.asked.push({ to: 'local', body }); return local; });
    api.peer.randomSongs = resolving((id, body) => { eng.asked.push({ to: id, body }); return peerAnswer; });
    AUTODJ.setState({ sonicEnabled: true, federatedEnabled: true });
    lane();
    SEEDS.add('more', song('seed'));
    SEEDS.add('less', song('skip'));
    return eng;
  }

  test("the local ask carries lessLike, no peer's does", async () => {
    const eng = fanOut(ans('l', 0.9), ans('p', 0.5));
    assert.equal(await eng.E.fns._autoDjFederatedPick(null), true);
    const local = eng.asked.find((a) => a.to === 'local');
    const peer = eng.asked.find((a) => a.to === 7);
    assert.deepEqual(local.body.lessLike, ['music/skip.mp3']);
    assert.equal('lessLike' in peer.body, false);
    assert.equal('similarTo' in local.body, false, 'the vector replaces the path seed');
    assert.deepEqual(eng.queued, ['music/l.mp3']);
  });

  test('an avoided local song loses to a clean peer song', async () => {
    const eng = fanOut(
      ans('l', 0.95, { lessLike: { used: 1, ignored: 0, threshold: 0.8, avoided: [true] } }),
      ans('p', 0.6),
    );
    assert.equal(await eng.E.fns._autoDjFederatedPick(null), true);
    assert.deepEqual(eng.queued, ['7:music/p.mp3']);
  });

  test('a trimmed re-roll advances only the servers whose songs it queues, and only their artists', async () => {
    const eng = fanOut(ans('l', 0.5, { ignoreList: [5] }), ans('p', 0.9, { ignoreList: [6] }));
    AUTODJ.setState({ djLimit: 2 });
    const id = SEEDS.laneId();
    const d2 = djRow('d2', id);
    playing(eng, [djRow('d0', id), djRow('d1', id), d2, row('u')], 1);
    eng.E.owed = { stale: [d2] };
    assert.equal(await eng.E.fns._autoDjFederatedPick(null), true);
    assert.deepEqual(eng.queued, ['7:music/p.mp3'], 'the best song, for the one row dropped');
    assert.deepEqual(AUTODJ.getPeerIgnoreList(7), [6]);
    assert.deepEqual(AUTODJ.getIgnoreList(), [], 'this server\'s song was not queued: its list stays');
    assert.deepEqual(AUTODJ.getArtistHistory(), ['p band']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. the panel's events
// ─────────────────────────────────────────────────────────────────────

describe('Start, Stop and a clear tell the panel (_seedsOnToggle, _seedsOnClear)', () => {
  test('a Start and a Stop are lane edges that emit dj; a clear emits queue', () => {
    const { E } = makeEngine();
    const heard = [];
    E.listeners.add((r) => heard.push(r));
    SEEDS.add('more', song('held'));
    const lane0 = SEEDS.laneId();
    const gen0 = E.gen;
    E.fns._seedsOnToggle(true);
    assert.equal(SEEDS.laneId(), lane0 + 1);
    assert.equal(E.gen, gen0 + 1);
    assert.equal(SEEDS.add('more', song('x')), true);
    assert.deepEqual(SEEDS.positives({}), [], 'armed, before the first pick: edits are still held aside');
    E.owed = { stale: [] };
    E.fns._seedsOnToggle(false);
    assert.equal(E.owed, null, 'a Stop settles a re-roll still owed');
    assert.equal(SEEDS.laneId(), lane0 + 2);
    E.fns._seedsOnClear(true, false);
    assert.deepEqual(heard, ['dj', 'dj', 'queue']);
    assert.deepEqual(paths(SEEDS.view().more), ['music/x.mp3', 'music/held.mp3'], 'the user\'s rows outlive Start and Stop');
    const toggle = PLAYER.slice(PLAYER.indexOf('mstreamModule.toggleAutoDJ = () => {'));
    assert.ok(toggle.indexOf('_seedsOnToggle(true);') < toggle.indexOf('_autoDjQueueN(2);'), 'the lane edge comes before the bootstrap');
    assert.match(PLAYER, /setActionHandler\('nexttrack', function\(\) \{ mstreamModule\.nextSong\(\); \}\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. the genre kind on the wire (the Genres drawer's Generated | Tags)
// ─────────────────────────────────────────────────────────────────────

describe('the genre kind on the wire', () => {
  test('genreSource rides with genres only when narrowed, on, and this server is known to take it', async () => {
    const { E, api } = makeEngine({ server: { version: '6.33.1' } });
    const build = async () => (await E.fns._buildAutoDjBody({})).body;
    AUTODJ.setGenreFilter({ mode: 'whitelist', genres: ['Jazz'], source: 'model' });
    let body = await build();
    assert.deepEqual(body.genres, ['Jazz']);
    assert.equal(body.genreMode, 'whitelist');
    assert.equal(body.genreSource, 'model');
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Jazz'], source: 'tag' });
    assert.equal((await build()).genreSource, 'tag');

    for (const version of ['6.32.1', undefined, '6.33.1-velvet']) {
      api.currentServer.version = version;
      body = await build();
      assert.deepEqual(body.genres, ['Jazz'], String(version));
      assert.equal('genreSource' in body, false, `${version}: not known to take it`);
    }

    api.currentServer.version = '6.33.1';
    AUTODJ.setGenreFilter({ mode: 'whitelist', genres: ['Jazz'], source: null });
    body = await build();
    assert.deepEqual(body.genres, ['Jazz']);
    assert.equal('genreSource' in body, false, 'Mixed');

    AUTODJ.setGenreFilter({ mode: 'whitelist', genres: [], source: 'model' });
    body = await build();
    assert.equal('genres' in body, false, 'off: nothing chosen');
    assert.equal('genreSource' in body, false);
    AUTODJ.setState({ djGenreEnabled: false, djGenres: ['Jazz'], djGenreSource: 'model' });
    body = await build();
    assert.equal('genres' in body, false, "an older client's off filter, with a list");
    assert.equal('genreSource' in body, false);
  });

  test('a song the server let through under a kind is not re-checked on its genres', async () => {
    const tagged = { title: 't', genres: ['Rock'] };
    const rockThenJazz = () => [
      { songs: [{ filepath: 'music/tagged.mp3', metadata: { title: 'tagged', artist: 'a', genres: ['Rock'] } }], ignoreList: [1] },
      { songs: [{ filepath: 'music/other.mp3', metadata: { title: 'other', artist: 'b', genres: ['Jazz'] } }], ignoreList: [1, 2] },
    ];
    const kind = makeEngine({ server: { version: '6.33.1' }, answers: rockThenJazz() });
    lane();
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Rock'], source: 'model' });
    assert.equal(kind.E.fns._autoDjSongBlocked(tagged, null, null, true), false, 'asked under a kind');
    assert.equal(kind.E.fns._autoDjSongBlocked(tagged, null, null, false), true, 'asked under Mixed');
    assert.equal(kind.E.fns._autoDjSongBlocked(tagged, null, null), true, 'no kind given: as before');
    await kind.E.fns.autoDJ();
    assert.equal(kind.asked.length, 1);
    assert.equal(kind.asked[0].body.genreSource, 'model');
    assert.deepEqual(kind.queued, ['music/tagged.mp3'], "skipping the model's Rock keeps a song tagged Rock");
    assert.deepEqual(kind.toasts, []);

    const mixed = makeEngine({ server: { version: '6.33.1' }, answers: rockThenJazz() });
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Rock'], source: null });
    await mixed.E.fns.autoDJ();
    assert.equal(mixed.asked.length, 2, 'under Mixed the Rock song is dropped and the pick asked again');
    assert.equal('genreSource' in mixed.asked[0].body, false);
    assert.deepEqual(mixed.queued, ['music/other.mp3']);
    assert.deepEqual(mixed.toasts, []);
  });

  test('the fan-out: the local ask and a peer known to take it carry the kind; an older or unknown peer gets genres only', async () => {
    const eng = makeEngine({ server: { federationBrowse: true, version: '6.33.1' } });
    const { api } = eng;
    api.federationPeers = resolving(() => ({ peers: [{ id: 7, name: 'New' }, { id: 8, name: 'Old' }] }));
    api.peer.health = resolving((id) => (id === 7
      ? { server: '6.33.1', discovery: { modelId: 'm1' } }
      : { discovery: { modelId: 'm1' } }));
    api.discoveryEmbeddings = resolving(() => ({ model: { id: 'm1' }, dim: 2, tracks: [{ embedding: AUTODJ.encodeWireVector([1, 0]) }] }));
    const rock = (name, sim) => ({
      songs: [{ filepath: `music/${name}.mp3`, metadata: { title: name, artist: `${name} band`, genres: ['Rock'] } }],
      ignoreList: [],
      sonic: { similarities: [sim] },
    });
    api.getRandomSong = resolving((body) => { eng.asked.push({ to: 'local', body }); return rock('local', 0.5); });
    api.peer.randomSongs = resolving((id, body) => { eng.asked.push({ to: id, body }); return rock(`peer${id}`, id === 8 ? 0.9 : 0.6); });
    AUTODJ.setState({ sonicEnabled: true, federatedEnabled: true, djLimit: 3 });
    lane();
    SEEDS.add('more', song('seed'));
    AUTODJ.setGenreFilter({ mode: 'blacklist', genres: ['Rock'], source: 'tag' });

    assert.equal(await eng.E.fns._autoDjFederatedPick(null), true);
    const local = eng.asked.find((a) => a.to === 'local').body;
    const seven = eng.asked.find((a) => a.to === 7).body;
    const eight = eng.asked.find((a) => a.to === 8).body;
    for (const [who, body] of [['local', local], ['7', seven], ['8', eight]]) {
      assert.deepEqual(body.genres, ['Rock'], who);
      assert.equal(body.genreMode, 'blacklist', who);
    }
    assert.equal(local.genreSource, 'tag');
    assert.equal(seven.genreSource, 'tag');
    assert.equal('genreSource' in eight, false, 'a peer not known to take the key');
    // Peer 8's Rock-tagged song has the best cosine, but it was asked without
    // a kind: blocked on its genres. The other two were asked under Tags (a
    // Rock link of theirs may be the model's): kept, best cosine first.
    assert.deepEqual(eng.queued, ['7:music/peer7.mp3', 'music/local.mp3']);
  });

  test("a peer's kind is read with the body: the filter turned on while a round is out puts no kind on its ask, and its answer is still re-checked", async () => {
    // Peer 7 (6.33.1) answers Rock at the best cosine, this server Ambient.
    // The filter is off as the round starts; Only Ambient under Generated is
    // chosen in the Genres drawer while the seeds' vectors load, or once
    // every ask is out.
    for (const when of ['embeddings', 'asks']) {
      // a fresh start, as beforeEach gives
      _store.clear();
      AUTODJ._internals.rehydrate();
      AUTODJ.reset();
      const eng = makeEngine({ server: { federationBrowse: true, version: '6.33.1' } });
      const { api } = eng;
      const choose = (at) => {
        if (at === when) { AUTODJ.setGenreFilter({ mode: 'whitelist', genres: ['Ambient'], source: 'model' }); }
      };
      const one = (name, genres, sim) => ({
        songs: [{ filepath: `music/${name}.mp3`, metadata: { title: name, artist: `${name} band`, genres } }],
        ignoreList: [],
        sonic: { similarities: [sim] },
      });
      api.federationPeers = resolving(() => ({ peers: [{ id: 7, name: 'New' }] }));
      api.peer.health = resolving(() => ({ server: '6.33.1', discovery: { modelId: 'm1' } }));
      api.discoveryEmbeddings = resolving(() => {
        choose('embeddings');
        return { model: { id: 'm1' }, dim: 2, tracks: [{ embedding: AUTODJ.encodeWireVector([1, 0]) }] };
      });
      api.getRandomSong = resolving((body) => { eng.asked.push({ to: 'local', body }); return one('local-ambient', ['Ambient'], 0.5); });
      api.peer.randomSongs = resolving((id, body) => {
        eng.asked.push({ to: id, body });
        choose('asks');
        return one('peer-rock', ['Rock'], 0.9);
      });
      AUTODJ.setState({ sonicEnabled: true, federatedEnabled: true });
      lane();
      SEEDS.add('more', song('seed'));

      assert.equal(await eng.E.fns._autoDjFederatedPick(null), true, when);
      assert.equal(AUTODJ.genreSourceFor({ version: '6.33.1' }), 'model', `${when}: the filter is on now`);
      assert.deepEqual(eng.asked.map((a) => a.to), ['local', 7], when);
      for (const a of eng.asked) {
        assert.equal('genres' in a.body, false, `${when}: ${a.to} was asked with the filter off`);
        assert.equal('genreSource' in a.body, false, `${when}: so no kind to ${a.to}`);
      }
      // Asked under no kind, peer 7's Rock song is checked on its genres and
      // blocked under Only Ambient: this server's Ambient song is queued.
      assert.deepEqual(eng.queued, ['music/local-ambient.mp3'], when);
    }
  });

  test("_federatedPeers keeps each peer's version (federation health's server)", async () => {
    const { E, api } = makeEngine();
    api.federationPeers = resolving(() => ({ peers: [{ id: 7, name: 'a' }, { id: 8, name: 'b' }, { id: 9, name: 'c' }, { id: 10, name: 'd' }] }));
    api.peer.health = resolving((id) => {
      if (id === 9) { throw new Error('unreachable'); }
      if (id === 10) { return { server: 6, discovery: { modelId: 'm1' } }; }
      return id === 7 ? { server: '6.33.1', discovery: { modelId: 'm1' } } : { discovery: { modelId: 'm1' } };
    });
    const peers = await E.fns._federatedPeers();
    assert.deepEqual(peers.map((p) => [p.id, p.version]), [[7, '6.33.1'], [8, null], [9, null], [10, null]]);
    assert.deepEqual(peers[0], { id: 7, name: 'a', modelId: 'm1', version: '6.33.1' });
    assert.equal(peers[2].modelId, null, 'a failed health sits the session out');
  });
});
