/**
 * The webapp's two flow actions (webapp/alpha/m.js), over the real pure half
 * (webapp/alpha/queue-flow.js) and the real queue writer
 * (MSTREAMPLAYER.applyQueueOrder in webapp/assets/js/mstream.player.js):
 *
 *   - Add All In Flow Order: Add All's rows, sent to POST /api/v1/db/flow
 *     (a peer's through the proxy) and queued in the answer's order,
 *     continuing from the queue's last song; any failure still adds them, in
 *     list order, with one toast; a busy button ignores a second click.
 *   - Flow (remaining songs / whole queue): the queue reordered in place
 *     without touching playback — no goToSong, the playing song stays
 *     current — matched onto whatever moved while the answer was out, shuffle
 *     off, the live queue saved, and an Undo that only undoes the newest flow
 *     on an unchanged queue. A failure changes nothing.
 *
 * Like webapp-add-all, this slices the real functions out of m.js, vp.js
 * (addSongWizard / addFederationSongWizard) and the player, and runs them
 * against stub globals; a rename fails the slice loudly.
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
const M_SRC = read('webapp', 'alpha', 'm.js');
const VP_SRC = read('webapp', 'alpha', 'vp.js');
const PLAYER_SRC = read('webapp', 'assets', 'js', 'mstream.player.js');
const HTML = read('webapp', 'index.html');
const require = createRequire(import.meta.url);
const QF = require('../../webapp/alpha/queue-flow.js');

// ── source slicing ──────────────────────────────────────────────────
function sliceFn(name) {
  const lines = M_SRC.split('\n');
  const header = (l) => l.split(' (').join('(');   // `function escapeHtml (string)`
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() at top level — update this test`);
  for (let i = start; i < lines.length; i++) { if (lines[i] === '}') { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of ${name}()`);
}
function sliceConst(name) {
  const lines = M_SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  for (let i = start; i < lines.length; i++) { if (lines[i] === '};') { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of const ${name}`);
}
function sliceModuleFn(src, file, name, ends) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`  mstreamModule.${name} = `));
  assert.ok(start >= 0, `${file} no longer defines mstreamModule.${name} — update this test`);
  for (let i = start; i < lines.length; i++) { if (ends.includes(lines[i])) { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of mstreamModule.${name}`);
}

const FLOW_FNS = [...M_SRC.matchAll(/^(?:async )?function (flow\w*)\(/gm)].map((m) => m[1]);
const FNS = ['escapeHtml', 'peerOf', 'queueRow', 'browsingListMetadata', 'addAllRows', 'addAll', 'addAllFlow', 'applyServerContext', ...FLOW_FNS];

// ── fixtures ────────────────────────────────────────────────────────
const PEER = { id: 7, name: 'Pi' };
const esc = (p) => p.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
// A queue row as the wizards build it: the raw path, the escaped filepath.
const row = (p, meta = {}, peer = null) => ({
  rawFilePath: p, filepath: peer ? p : esc(p), url: `u:${p}`, metadata: meta,
  ...(peer ? { federation: { peerId: peer, peerName: 'Pi' } } : {}),
});
const rows = (n, prefix = 'L', meta = (i) => ({ bpm: 100 + i })) => Array.from({ length: n }, (_, i) => row(`${prefix}/${i}.mp3`, meta(i)));
const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise((r) => setImmediate(r)); } };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// The route's layout for a toy solve: [start] + the rest reversed, then the
// unanalysed and unplaced songs. An escaped path (%23, %25, %3F — a queue
// row restored from a saved playlist) is unplaced: the server can't resolve it.
function reversed({ unanalysed = [], signals = true, end = null, identity = false } = {}) {
  return (server, body) => {
    const n = body.songs.length;
    const pin = body.start === 0;
    const unplaced = body.songs.map((s, i) => (/%(23|25|3F)/.test(s) ? i : -1)).filter((i) => i >= 0);
    const out = new Set([...unplaced, ...unanalysed]);
    const run = [];
    for (let i = 0; i < n; i++) { if (!(pin && i === 0) && !out.has(i)) { run.push(i); } }
    if (!identity) { run.reverse(); }
    const keep = (i) => !(pin && i === 0);
    const order = [...(pin ? [0] : []), ...run, ...unanalysed.filter(keep), ...unplaced.filter(keep)];
    const a = { order, songs: order.map((i) => body.songs[i]), unplaced, unanalysed,
      signals: { sound: signals, tempo: false, key: false, energy: false }, solver: 'complete', stats: null };
    if (body.returnEnd) { a.end = end; }
    return a;
  };
}

// ── the sandbox ─────────────────────────────────────────────────────
function makeSandbox({
  flowOrder = 1, queue = [], pos = -1, shuffle = false, autoDJ = false, shouldLoop = false,
  serverAudio = undefined, noApply = false, answer = reversed(), timeoutMs, initialTimer = null, otherSong,
} = {}) {
  const log = { flowCalls: [], toasts: [], busy: [], saves: 0, queued: [], lookups: [], shuffles: [], cached: [], applies: 0 };

  // ── the player: the real applyQueueOrder + resetPositionCache ──
  const timers = [];
  const cur = { songObject: pos >= 0 ? queue[pos] : undefined };
  // The other player: what setCachedSong last loaded on it.
  const other = { songObject: otherSong };
  const player = {
    playlist: queue.slice(),
    positionCache: { val: pos },
    playerStats: { shuffle, autoDJ, shouldLoop },
    ignoreVPaths: {},
    transcodeOptions: { serverEnabled: false, frontendEnabled: false },
    addSong(song, autoPlayOff) {
      log.queued.push({ song, autoPlayOff });
      player.playlist.push(song);
      if (player.playlist.length === 1) { player.positionCache.val = 0; cur.songObject = song; }
    },
    insertSongAt() { throw new Error('flow appends; it must not insert'); },
    setShuffle(v) { log.shuffles.push(v); player.playerStats.shuffle = v; },
    getCurrentSong: () => cur.songObject,
    resetCurrentMetadata() {},
  };
  const internals = new Function('mstreamModule', 'getCurrentPlayer', 'getOtherPlayer', 'setCachedSong', 'setTimeout', 'clearTimeout', 'goToSong', 'initialTimer', `
    'use strict';
    let cacheTimer = initialTimer;
    const cacheTimeout = 30000;
    ${sliceModuleFn(PLAYER_SRC, 'mstream.player.js', 'resetPositionCache', ['  }', '  };'])}
    ${sliceModuleFn(PLAYER_SRC, 'mstream.player.js', 'applyQueueOrder', ['  }', '  };'])}
    return { timer: () => cacheTimer };
  `)(player, () => cur, () => other, (i) => { log.cached.push(i); other.songObject = player.playlist[i]; },
    (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    (t) => { if (t) { t.cleared = true; } },
    () => { throw new Error('goToSong must never run'); }, initialTimer);
  const realApply = player.applyQueueOrder;
  player.applyQueueOrder = (order) => { log.applies++; return realApply(order); };
  if (noApply) { delete player.applyQueueOrder; }

  // ── the API ──
  const api = {
    currentServer: { host: 'http://host/', token: 'TOK', ...(flowOrder === 'absent' ? {} : { flowOrder }) },
    answer,
    flow: (body, opts) => { log.flowCalls.push({ server: null, body: JSON.parse(JSON.stringify(body)), opts }); return Promise.resolve().then(() => api.answer(null, body, opts)); },
    peer: {
      flow: (id, body, opts) => { log.flowCalls.push({ server: id, body: JSON.parse(JSON.stringify(body)), opts }); return Promise.resolve().then(() => api.answer(id, body, opts)); },
    },
    lookupMetadata: (fp) => { log.lookups.push(fp); return Promise.resolve({ metadata: null }); },
    addToPlaylist: () => Promise.resolve({}),
  };

  // ── vp.js: the real wizards, and the busy / save hooks ──
  const core = {
    altLayout: { waveformBar: false }, livePlaylist: { name: false }, prefetchWaveform() {},
    setFlowBusy: (on) => { log.busy.push(on); },
    saveLiveQueue: () => { log.saves++; },
  };
  new Function('mstreamModule', 'MSTREAMPLAYER', 'MSTREAMAPI', 'saveLiveQueue', `
    'use strict';
    ${sliceModuleFn(VP_SRC, 'vp.js', 'addSongWizard', ['  };'])}
    ${sliceModuleFn(VP_SRC, 'vp.js', 'addFederationSongWizard', ['  };'])}
  `)(core, player, api, () => {});

  // ── the page ──
  const classes = new Set(['flow-add-btn', 'super-hide']);
  const attrs = new Map([['aria-busy', 'false']]);
  const btn = {
    classList: { toggle: (c, on) => { if (on) { classes.add(c); } else { classes.delete(c); } }, contains: (c) => classes.has(c) },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    blurred: 0,
    blur() { btn.blurred++; },
  };
  const pop = { style: { visibility: 'visible' } };
  let panel = [];
  const document = {
    body: { classList: { toggle() {} } },
    getElementById: (id) => ({ flow_add_all_btn: btn, pop })[id] || null,
    getElementsByClassName: (cls) => (cls !== 'filez' ? [] : panel.map((r) => ({
      getAttribute: (k) => (k === 'data-file_location' ? r.fp : k === 'data-peer' ? (r.peer == null ? null : String(r.peer)) : null),
    }))),
  };
  const toast = (kind) => (o) => { log.toasts.push({ kind, ...o }); };
  const iziToast = { warning: toast('warning'), info: toast('info'), success: toast('success'), show: toast('show') };
  const QUEUEFLOW = timeoutMs ? { ...QF, flowRuns: (items, o) => QF.flowRuns(items, { ...o, timeoutMs }) } : QF;

  const globals = {
    document, MSTREAMAPI: api, MSTREAMPLAYER: player, VUEPLAYERCORE: core, QUEUEFLOW, iziToast,
    t: (k) => k, console: { warn() {}, error() {}, log() {} }, serverAudioMode: serverAudio,
    // applyServerContext's other work
    writeReadOnlyNote: () => {}, keepGateRefresh: () => {},
  };
  const body = `
    'use strict';
    let currentBrowsingList = [];
    let peerContext = null;
    const knownPeers = new Map([[${PEER.id}, ${JSON.stringify(PEER)}]]);
    ${sliceConst('entityMap')}
    ${sliceConst('flowSession')}
    ${FNS.map(sliceFn).join('\n\n')}
    return {
      ${FNS.join(', ')},
      flowSession,
      setList(l) { currentBrowsingList = l; },
      setPeerContext(p) { peerContext = p; },
    };
  `;
  const names = Object.keys(globals);
  const S = new Function(...names, body)(...names.map((n) => globals[n]));
  return Object.assign(S, {
    log, player, cur, other, api, btn, pop, timers, internals,
    setPanel(list, peer = null) {
      panel = list.map((r) => ({ fp: r.fp, peer }));
      S.setList(list.filter((r) => r.meta).map((r) => ({ type: 'file', path: r.fp, metadata: r.meta })));
    },
    hidden: () => classes.has('super-hide'),
    order: () => player.playlist.slice(),
    clickUndo(k = -1) {
      const t = log.toasts.filter((x) => x.kind === 'show').at(k);
      t.buttons[0][1]({ hide() {} }, {});
    },
  });
}

const panelRows = (paths, meta = (i) => ({ title: `T${i}`, bpm: 100 + i })) => paths.map((fp, i) => ({ fp, meta: meta(i) }));

// ── the player's applyQueueOrder ────────────────────────────────────
describe('MSTREAMPLAYER.applyQueueOrder', () => {
  test('in place, position follows the playing song, playback untouched, the new next song cached at once', () => {
    const q = rows(5);
    const old = { fn() { throw new Error('the old timer must not fire'); }, cleared: false };
    // The other player holds q[2], the next song before the flow.
    const S = makeSandbox({ queue: q, pos: 1, initialTimer: old, otherSong: q[2] });
    const arr = S.player.playlist;
    assert.equal(S.player.applyQueueOrder([q[3], q[0], q[1], q[4], q[2]]), true);
    assert.equal(S.player.playlist, arr, 'the same array');
    assert.deepEqual(arr, [q[3], q[0], q[1], q[4], q[2]]);
    assert.equal(S.player.positionCache.val, 2);
    assert.equal(S.cur.songObject, q[1]);
    assert.equal(old.cleared, true, 'the pending timer (old index) is dropped');
    assert.equal(S.internals.timer(), undefined);
    assert.equal(S.timers.length, 0, 'no 30 s wait: a flow late in a track keeps its preload');
    assert.deepEqual(S.log.cached, [3], 'the new next song, q[4]');
    assert.equal(S.other.songObject, q[4]);

    // The other player already holds the next song: not loaded again.
    assert.equal(S.player.applyQueueOrder([q[0], q[1], q[4], q[3], q[2]]), true);
    assert.equal(S.player.positionCache.val, 1);
    assert.deepEqual(S.log.cached, [3]);
  });

  test('loop on at the end caches the first song; the end without loop and nothing playing cache nothing; shuffle leaves the timer', () => {
    const q = rows(3);
    const loop = makeSandbox({ queue: q, pos: 0, shouldLoop: true });
    loop.player.applyQueueOrder([q[1], q[2], q[0]]);
    assert.deepEqual(loop.log.cached, [0]);

    const end = makeSandbox({ queue: q, pos: 0 });
    end.player.applyQueueOrder([q[1], q[2], q[0]]);
    assert.deepEqual(end.log.cached, []);

    const idle = makeSandbox({ queue: q, pos: -1 });
    idle.player.applyQueueOrder([q[2], q[1], q[0]]);
    assert.equal(idle.player.positionCache.val, -1);
    assert.deepEqual(idle.log.cached, []);
    assert.equal(idle.timers.length, 0);

    const old = { fn() {}, cleared: false };
    const shuf = makeSandbox({ queue: q, pos: 0, shuffle: true, initialTimer: old });
    assert.equal(shuf.player.applyQueueOrder([q[2], q[0], q[1]]), true);
    assert.equal(old.cleared, false);
    assert.equal(shuf.timers.length, 0);
    assert.equal(shuf.internals.timer(), old);
  });

  test('false, and nothing changes, for a wrong length, a foreign row or a duplicate; itself and 20,000 rows work', () => {
    const q = rows(4);
    const S = makeSandbox({ queue: q, pos: 1 });
    for (const bad of [[q[0], q[1], q[2]], [q[0], q[1], q[2], row('x')], [q[0], q[0], q[2], q[3]], null]) {
      assert.equal(S.player.applyQueueOrder(bad), false);
      assert.deepEqual(S.order(), q);
      assert.deepEqual(S.log.cached, []);
    }
    assert.equal(S.player.applyQueueOrder(S.player.playlist), true);
    assert.deepEqual(S.order(), q);

    const big = rows(20000);
    const B = makeSandbox({ queue: big, pos: 19999 });
    assert.equal(B.player.applyQueueOrder(big.slice().reverse()), true);
    assert.equal(B.player.playlist[0], big[19999]);
    assert.equal(B.player.playlist.length, 20000);
    assert.equal(B.player.positionCache.val, 0);
  });
});

// ── Add All In Flow Order ───────────────────────────────────────────
describe('Add All In Flow Order', () => {
  const PATHS = ['music/a #1.mp3', 'music/b 100%.mp3', 'music/c?.mp3', 'music/d.mp3'];

  test('a local panel: one call with raw paths; queued in answer order with their metadata, unflowed last', async () => {
    const S = makeSandbox({ answer: reversed({ unanalysed: [1] }) });
    S.setPanel(panelRows(PATHS));
    await S.addAllFlow();
    await settle();
    assert.equal(S.log.flowCalls.length, 1);
    assert.deepEqual(S.log.flowCalls[0], { server: null, body: { songs: PATHS }, opts: S.log.flowCalls[0].opts });
    assert.ok(S.log.flowCalls[0].opts.signal, 'an abort signal rides along');
    assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), [PATHS[3], PATHS[2], PATHS[0], PATHS[1]]);
    assert.deepEqual(S.log.queued.map((q) => q.song.metadata.title), ['T3', 'T2', 'T0', 'T1']);
    assert.deepEqual(S.log.lookups, []);
    assert.deepEqual(S.log.toasts, []);
  });

  test("the queue's last song on this server leads (start 0) and is not queued again", async () => {
    const last = row('Q/last.mp3', { bpm: 120 });
    const S = makeSandbox({ queue: [row('Q/first.mp3'), last], pos: 0 });
    S.setPanel(panelRows(PATHS.slice(0, 3)));
    await S.addAllFlow();
    await settle();
    assert.deepEqual(S.log.flowCalls[0].body, { songs: ['Q/last.mp3', ...PATHS.slice(0, 3)], start: 0 });
    assert.equal(S.player.playlist.length, 5);
    assert.deepEqual(S.order().slice(2).map((s) => s.rawFilePath), [PATHS[2], PATHS[1], PATHS[0]]);
  });

  test("a peer's last song gives after from its BPM / key, or nothing without them", async () => {
    const S = makeSandbox({ queue: [row('P/x.mp3', { bpm: 128, 'musical-key': '8A' }, 7)], pos: 0 });
    S.setPanel(panelRows(PATHS.slice(0, 2)));
    await S.addAllFlow();
    assert.deepEqual(S.log.flowCalls[0].body, { songs: PATHS.slice(0, 2), after: { bpm: 128, key: '8A' } });
    const N = makeSandbox({ queue: [row('P/x.mp3', {}, 7)], pos: 0 });
    N.setPanel(panelRows(PATHS.slice(0, 2)));
    await N.addAllFlow();
    assert.deepEqual(N.log.flowCalls[0].body, { songs: PATHS.slice(0, 2) });
  });

  test('a peer panel goes through the proxy and queues federation rows', async () => {
    const S = makeSandbox();
    S.setPeerContext(PEER);
    S.setPanel(panelRows(['p/1.mp3', 'p/2.mp3', 'p/3.mp3']), 7);
    await S.addAllFlow();
    assert.equal(S.log.flowCalls[0].server, 7);
    assert.deepEqual(S.log.queued.map((q) => [q.song.rawFilePath, q.song.federation.peerId]), [['p/3.mp3', 7], ['p/2.mp3', 7], ['p/1.mp3', 7]]);
  });

  test('a refusing peer: list order and a toast; the button hides there, the next click makes no call; home still shows it', async () => {
    const S = makeSandbox({ answer: () => { throw err(403); } });
    S.setPeerContext(PEER);
    S.flowAddAllGate();
    assert.equal(S.hidden(), false);
    S.setPanel(panelRows(['p/1.mp3', 'p/2.mp3', 'p/3.mp3']), 7);
    await S.addAllFlow();
    await settle();
    assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), ['p/1.mp3', 'p/2.mp3', 'p/3.mp3']);
    assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title]), [['warning', 'flow.addFailed']]);
    assert.equal(S.hidden(), true);
    await S.addAllFlow();
    assert.equal(S.log.flowCalls.length, 1, 'no second call to a refusing peer');
    assert.equal(S.log.queued.length, 6);
    S.setPeerContext(null);
    S.flowAddAllGate();
    assert.equal(S.hidden(), false);
  });

  test('500, 429, a network error or a timeout: every row once, in list order, one warning', async () => {
    const answers = [() => { throw err(500); }, () => { throw err(429); }, () => { throw new TypeError('Failed to fetch'); }, () => new Promise(() => {})];
    for (const answer of answers) {
      const S = makeSandbox({ answer, timeoutMs: 20 });
      S.setPanel(panelRows(PATHS));
      await S.addAllFlow();
      await settle();
      assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), PATHS);
      assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title]), [['warning', 'flow.addFailed']]);
      assert.equal(S.btn.getAttribute('aria-busy'), 'false');
    }
    const T = makeSandbox({ answer: () => new Promise(() => {}), timeoutMs: 20 });
    T.setPanel(panelRows(PATHS));
    await T.addAllFlow();
    assert.equal(T.log.flowCalls[0].opts.signal.aborted, true, 'the timed-out call is aborted');
  });

  test('a mouse press leaves no focus on the button; a key press keeps it', async () => {
    const S = makeSandbox({ answer: reversed() });
    S.setPanel(panelRows(PATHS.slice(0, 3)));
    await S.addAllFlow({ detail: 1, currentTarget: S.btn });
    assert.equal(S.btn.blurred, 1, 'Space after a click must pause, not add the panel again');
    await S.addAllFlow({ detail: 0, currentTarget: S.btn });
    assert.equal(S.btn.blurred, 1, 'Enter or Space on the focused button');
    assert.equal(S.log.flowCalls.length, 2);
  });

  test('busy: aria-busy / aria-disabled while out; a second click is ignored; a redraw changes nothing', async () => {
    const d = deferred();
    const S = makeSandbox({ answer: () => d.promise });
    S.setPanel(panelRows(PATHS.slice(0, 3)));
    const first = S.addAllFlow();
    await settle();
    assert.equal(S.btn.getAttribute('aria-busy'), 'true');
    assert.equal(S.btn.getAttribute('aria-disabled'), 'true');
    S.setPanel(panelRows(['other/1.mp3', 'other/2.mp3']));
    await S.addAllFlow();
    assert.equal(S.log.flowCalls.length, 1);
    assert.equal(S.log.queued.length, 0);
    d.resolve(reversed()(null, S.log.flowCalls[0].body));
    await first;
    await settle();
    assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), [PATHS[2], PATHS[1], PATHS[0]]);
    assert.equal(S.btn.getAttribute('aria-busy'), 'false');
    assert.equal(S.btn.getAttribute('aria-disabled'), 'false');

    const F = makeSandbox({ answer: () => { throw err(500); } });
    F.setPanel(panelRows(PATHS));
    await F.addAllFlow();
    assert.equal(F.btn.getAttribute('aria-busy'), 'false');
    assert.equal(F.flowSession.addBusy, false);
  });

  test('zero rows do nothing; one row is queued without a call', async () => {
    const S = makeSandbox();
    await S.addAllFlow();
    assert.equal(S.log.queued.length, 0);
    S.setPanel(panelRows(['one.mp3']));
    await S.addAllFlow();
    await settle();
    assert.equal(S.log.flowCalls.length, 0);
    assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), ['one.mp3']);
  });

  test('more than 1000 rows: the first 1000 (999 after a lead) flow, the rest follow in list order', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `m/${i}.mp3`);
    const S = makeSandbox();
    S.setPanel(panelRows(many));
    await S.addAllFlow();
    await settle();
    assert.equal(S.log.flowCalls[0].body.songs.length, 1000);
    const got = S.log.queued.map((q) => q.song.rawFilePath);
    assert.equal(got[0], 'm/999.mp3');
    assert.deepEqual(got.slice(1000), many.slice(1000));

    const L = makeSandbox({ queue: [row('Q/last.mp3')], pos: 0 });
    L.setPanel(panelRows(many));
    await L.addAllFlow();
    assert.equal(L.log.flowCalls[0].body.songs.length, 1000);
    assert.equal(L.log.flowCalls[0].body.songs[0], 'Q/last.mp3');
    assert.equal(L.log.flowCalls[0].body.songs[999], 'm/998.mp3');
  });

  test('a server switch reads the gate again: a refused peer hides the button, home shows it', () => {
    const S = makeSandbox();
    S.flowSession.refusedPeers.add(PEER.id);
    S.setPeerContext(PEER);
    S.applyServerContext();
    assert.equal(S.hidden(), true);
    S.setPeerContext(null);
    S.applyServerContext();
    assert.equal(S.hidden(), false);
    S.setPeerContext({ id: 9, name: 'Other' });
    S.applyServerContext();
    assert.equal(S.hidden(), false, 'a peer not yet refused is probed by calling');
  });

  test('the gate: flowOrder 0 or absent hides the button, 1 or more shows it', () => {
    for (const [flowOrder, hidden] of [[0, true], ['absent', true], [1, false], [2, false]]) {
      const S = makeSandbox({ flowOrder });
      S.flowAddAllGate();
      assert.equal(S.hidden(), hidden, String(flowOrder));
    }
  });

  test('plain Add All is unchanged: list order, no call', async () => {
    const S = makeSandbox();
    S.setPanel(panelRows(PATHS));
    S.addAll();
    await settle();
    assert.equal(S.log.flowCalls.length, 0);
    assert.deepEqual(S.log.queued.map((q) => q.song.rawFilePath), PATHS);
  });
});

// ── Flow the queue ──────────────────────────────────────────────────
describe('Flow the queue', () => {

  test('remaining: the playing song leads, earlier songs stay, shuffle off, saved, an Undo toast', async () => {
    const q = rows(6);
    const S = makeSandbox({ queue: q, pos: 2, shuffle: true });
    const arr = S.player.playlist;
    await S.flowQueue('remaining');
    assert.deepEqual(S.log.flowCalls[0].body, { songs: ['L/2.mp3', 'L/3.mp3', 'L/4.mp3', 'L/5.mp3'], start: 0 });
    assert.equal(S.player.playlist, arr);
    assert.deepEqual(S.order(), [q[0], q[1], q[2], q[5], q[4], q[3]]);
    assert.equal(S.player.positionCache.val, 2);
    assert.equal(S.cur.songObject, q[2]);
    assert.deepEqual(S.log.shuffles, [false]);
    assert.equal(S.log.saves, 1);
    assert.equal(S.pop.style.visibility, 'hidden');
    assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title, t.buttons && t.buttons.length]), [['show', 'flow.flowed', 1]]);
    assert.match(S.log.toasts[0].buttons[0][0], /flow\.undo/);
  });

  test('whole: the playing song moves to the top and stays current; played songs follow in flow order', async () => {
    const q = rows(5);
    const S = makeSandbox({ queue: q, pos: 2 });
    await S.flowQueue('whole');
    // the upcoming songs first, then the played ones: the 999-song cap takes what is still to come
    assert.deepEqual(S.log.flowCalls[0].body, { songs: ['L/2.mp3', 'L/3.mp3', 'L/4.mp3', 'L/0.mp3', 'L/1.mp3'], start: 0 });
    assert.deepEqual(S.order(), [q[2], q[1], q[0], q[4], q[3]]);
    assert.equal(S.player.positionCache.val, 0);
    assert.equal(S.cur.songObject, q[2]);
  });

  test('nothing playing: both choices flow the whole queue with neither start nor after', async () => {
    for (const mode of ['remaining', 'whole']) {
      const q = rows(4);
      const S = makeSandbox({ queue: q, pos: -1 });
      await S.flowQueue(mode);
      assert.deepEqual(S.log.flowCalls[0].body, { songs: ['L/0.mp3', 'L/1.mp3', 'L/2.mp3', 'L/3.mp3'] });
      assert.deepEqual(S.order(), [q[3], q[2], q[1], q[0]]);
      assert.equal(S.player.positionCache.val, -1);
    }
  });

  test('a mixed queue: the playing song’s server first with the pin, then the peer joined by end', async () => {
    const L0 = row('L/0.mp3', { bpm: 120 });
    const P1 = row('P/1.mp3', {}, 7);
    const L2 = row('L/2.mp3');
    const P3 = row('P/3.mp3', {}, 7);
    const L4 = row('L/4.mp3');
    const P5 = row('P/5.mp3', {}, 7);
    const X6 = row('L/x%23y.mp3');   // a restored row: escaped, so unplaced
    const queue = [L0, P1, L2, P3, L4, P5, X6];
    const S = makeSandbox({ queue, pos: 0, answer: reversed({ end: { index: 2, bpm: 124, key: '8A' } }) });
    await S.flowQueue('whole');
    assert.deepEqual(S.log.flowCalls.map((c) => c.server), [null, 7]);
    assert.deepEqual(S.log.flowCalls[0].body, { songs: ['L/0.mp3', 'L/2.mp3', 'L/4.mp3', 'L/x%23y.mp3'], start: 0, returnEnd: true });
    assert.deepEqual(S.log.flowCalls[1].body, { songs: ['P/1.mp3', 'P/3.mp3', 'P/5.mp3'], after: { bpm: 124, key: '8A' } });
    assert.deepEqual(S.order(), [L0, L4, L2, P5, P3, P1, X6]);

    const R = makeSandbox({ queue, pos: 0, answer: (server, body) => { if (server === 7) { throw err(404); } return reversed()(server, body); } });
    await R.flowQueue('whole');
    assert.deepEqual(R.order(), [L0, L4, L2, P1, P3, P5, X6], "the refused peer's rows wait at the tail in queue order");
  });

  test('while the answer is out: appended rows follow, a removed row is skipped', async () => {
    const q = rows(5);
    const d = deferred();
    const S = makeSandbox({ queue: q, pos: 1, answer: () => d.promise });
    const pending = S.flowQueue('remaining');
    await settle();
    const dj = row('DJ/1.mp3');
    S.player.playlist.push(dj);
    S.player.playlist.splice(3, 1);   // q[3]
    d.resolve(reversed()(null, S.log.flowCalls[0].body));
    await pending;
    assert.deepEqual(S.order(), [q[0], q[1], q[4], q[2], dj]);
    assert.equal(S.player.positionCache.val, 1);
  });

  test('while the answer is out: playback moving on in remaining mode still applies', async () => {
    const q = rows(6);
    const d = deferred();
    const S = makeSandbox({ queue: q, pos: 1, answer: () => d.promise });
    const pending = S.flowQueue('remaining');
    await settle();
    S.player.positionCache.val = 2;
    S.cur.songObject = q[2];
    d.resolve(reversed()(null, S.log.flowCalls[0].body));
    await pending;
    assert.deepEqual(S.order(), [q[0], q[1], q[2], q[5], q[4], q[3]]);
    assert.equal(S.player.positionCache.val, 2);
  });

  test('while the answer is out: a new song in whole mode drops the answer with one toast', async () => {
    const q = rows(4);
    const d = deferred();
    const S = makeSandbox({ queue: q, pos: 1, answer: () => d.promise });
    const pending = S.flowQueue('whole');
    await settle();
    S.player.positionCache.val = 2;
    S.cur.songObject = q[2];
    d.resolve(reversed()(null, S.log.flowCalls[0].body));
    await pending;
    assert.deepEqual(S.order(), q);
    assert.equal(S.log.applies, 0);
    assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title]), [['warning', 'flow.failed']]);
  });

  test('any failure: the same array in the same order, shuffle as it was, one warning, no Undo', async () => {
    const malformed = () => ({ order: [0, 0, 1, 2], signals: { sound: true } });
    const answers = [() => { throw err(500); }, () => { throw err(429); }, () => { throw new TypeError('offline'); }, () => { throw err(403); }, malformed, () => new Promise(() => {})];
    for (const answer of answers) {
      const q = rows(4);
      const S = makeSandbox({ queue: q, pos: 0, shuffle: true, answer, timeoutMs: 20 });
      const arr = S.player.playlist;
      await S.flowQueue('remaining');
      assert.equal(S.player.playlist, arr);
      assert.deepEqual(S.order(), q);
      assert.equal(S.player.playerStats.shuffle, true);
      assert.equal(S.log.saves, 0);
      assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title]), [['warning', 'flow.failed']]);
      assert.deepEqual(S.log.busy, [true, false]);
    }
  });

  test('no signals: unchanged, an info toast; an answer that changes nothing: success, no apply', async () => {
    const q = rows(4);
    const S = makeSandbox({ queue: q, pos: 0, answer: reversed({ signals: false }) });
    await S.flowQueue('remaining');
    assert.deepEqual(S.order(), q);
    assert.deepEqual(S.log.toasts.map((t) => [t.kind, t.title]), [['info', 'flow.nothing']]);

    const same = makeSandbox({ queue: q, pos: 0, shuffle: true, answer: reversed({ identity: true }) });
    await same.flowQueue('remaining');
    assert.equal(same.log.applies, 0);
    assert.deepEqual(same.log.shuffles, [false]);
    assert.deepEqual(same.log.toasts.map((t) => [t.kind, t.title, t.buttons]), [['success', 'flow.flowed', undefined]]);
  });

  test('Undo: the old order back through the same path, playback untouched, saved again', async () => {
    const q = rows(5);
    const S = makeSandbox({ queue: q, pos: 1 });
    await S.flowQueue('whole');
    assert.deepEqual(S.order(), [q[1], q[0], q[4], q[3], q[2]]);
    S.clickUndo();
    assert.deepEqual(S.order(), q);
    assert.equal(S.player.positionCache.val, 1);
    assert.equal(S.cur.songObject, q[1]);
    assert.equal(S.log.saves, 2);
    S.clickUndo();
    assert.equal(S.log.saves, 2, 'once');
  });

  test('Undo does nothing after the queue changed, or once a newer flow ran', async () => {
    const q = rows(5);
    const S = makeSandbox({ queue: q, pos: 0 });
    await S.flowQueue('remaining');
    S.player.playlist.push(row('late.mp3'));
    const before = S.order();
    S.clickUndo();
    assert.deepEqual(S.order(), before);

    // the same rows dragged into another order, the playing song in place
    const D = makeSandbox({ queue: q, pos: 0 });
    await D.flowQueue('remaining');
    const pl = D.player.playlist;
    [pl[2], pl[3]] = [pl[3], pl[2]];
    const dragged = D.order();
    D.clickUndo();
    assert.deepEqual(D.order(), dragged, 'a drag since the flow: Undo would throw it away');

    const T = makeSandbox({ queue: q, pos: 0 });
    await T.flowQueue('remaining');
    T.api.answer = reversed();   // flows the flowed rows back
    await T.flowQueue('remaining');
    const now = T.order();
    T.clickUndo(0);
    assert.deepEqual(T.order(), now, "the first toast's Undo is spent");
    T.clickUndo(1);
    assert.notDeepEqual(T.order(), now);
    assert.equal(T.log.saves, 3);
  });

  test('Undo does nothing once another song plays (it would replay one and skip another)', async () => {
    for (const mode of ['remaining', 'whole']) {
      const q = rows(5);
      const S = makeSandbox({ queue: q, pos: 1 });
      await S.flowQueue(mode);
      const flowed = S.order();
      const at = S.player.positionCache.val;
      // Next: the song after the playing one starts, the queue as Flow left it
      S.player.positionCache.val = at + 1;
      S.cur.songObject = flowed[at + 1];
      S.clickUndo();
      assert.deepEqual(S.order(), flowed, mode);
      assert.equal(S.log.saves, 1, mode);
      // and back on the song that was playing, it undoes
      S.player.positionCache.val = at;
      S.cur.songObject = flowed[at];
      S.clickUndo();
      assert.deepEqual(S.order(), q, mode);
      assert.equal(S.log.saves, 2, mode);
    }
  });

  test('one flow toast at a time: each replaces the last; Undo never takes focus', async () => {
    const q = rows(5);
    const S = makeSandbox({ queue: q, pos: 0 });
    await S.flowQueue('remaining');
    S.api.answer = () => { throw err(500); };
    await S.flowQueue('remaining');
    S.api.answer = reversed({ signals: false });
    await S.flowQueue('remaining');
    const A = makeSandbox({ answer: () => { throw err(500); } });
    A.setPanel(panelRows(['a.mp3', 'b.mp3']));
    await A.addAllFlow();
    const all = [...S.log.toasts, ...A.log.toasts];
    assert.deepEqual(all.map((t) => [t.kind, t.title]), [['show', 'flow.flowed'], ['warning', 'flow.failed'], ['info', 'flow.nothing'], ['warning', 'flow.addFailed']]);
    for (const t of all) {
      assert.equal(t.id, 'flow-toast');
      assert.equal(t.displayMode, 'replace');
      assert.equal(t.position, 'topCenter');
    }
    const undo = S.log.toasts[0].buttons[0];
    assert.ok(!undo[2], 'no autofocus flag on Undo');
  });

  test('not allowed: Auto DJ on, server audio, flowOrder 0, a player without applyQueueOrder', async () => {
    const q = rows(4);
    for (const opts of [{ autoDJ: true }, { serverAudio: true }, { flowOrder: 0 }, { noApply: true }]) {
      const S = makeSandbox({ queue: q, pos: 0, ...opts });
      await S.flowQueue('whole');
      assert.equal(S.log.flowCalls.length, 0, JSON.stringify(opts));
      assert.deepEqual(S.log.toasts, []);
    }
  });

  test('busy: a second Flow while one is out makes no call; busy goes true then false', async () => {
    const q = rows(4);
    const d = deferred();
    const S = makeSandbox({ queue: q, pos: 0, answer: () => d.promise });
    const pending = S.flowQueue('remaining');
    await settle();
    await S.flowQueue('whole');
    assert.equal(S.log.flowCalls.length, 1);
    assert.deepEqual(S.log.busy, [true]);
    d.resolve(reversed()(null, S.log.flowCalls[0].body));
    await pending;
    assert.deepEqual(S.log.busy, [true, false]);
    assert.equal(S.flowSession.queueBusy, false);
  });

  test('fewer than two songs to reorder: no call', async () => {
    const q = rows(3);
    const S = makeSandbox({ queue: q, pos: 1 });
    await S.flowQueue('remaining');
    assert.equal(S.log.flowCalls.length, 0);
  });
});

// ── the Now Playing bar's Flow menu (vp.js) and the ping's gate (m.js) ──
// playlistVue's flow methods, sliced from vp.js and bound to a stub vm.
function vpMethod(name) {
  const lines = VP_SRC.split('\n');
  const from = lines.findIndex((l) => l.startsWith('  const playlistVue = new Vue('));
  assert.ok(from >= 0, 'vp.js no longer defines playlistVue — update this test');
  const start = lines.findIndex((l, i) => i > from && l.startsWith(`      ${name}: function`));
  assert.ok(start >= 0, `playlistVue no longer has ${name}() — update this test`);
  for (let i = start; i < lines.length; i++) { if (lines[i] === '      },') { return lines.slice(start, i + 1).join('\n'); } }
  throw new Error(`could not find the end of ${name}()`);
}
const MENU_METHODS = ['flowToggle', 'flowClose', 'flowOutside', 'flowFocusOut', 'flowChoose', 'flowCan'];

function makeMenu({ queue = rows(4), pos = 0 } = {}) {
  const log = { focused: [], chosen: [], blurred: [] };
  const listeners = [];
  const el = (id, wrap) => ({ id, focus() { log.focused.push(id); }, blur() { log.blurred.push(id); }, closest: (sel) => (sel === '.flow-wrap' && wrap ? {} : null) });
  const toggle = el('flow_queue_btn', true);
  const items = { remaining: el('remaining', true), whole: el('whole', true) };
  const outside = el('elsewhere', false);
  const flowState = { available: false, busy: false, open: false };
  const vm = { flow: flowState, playlist: queue, positionCache: { val: pos }, $nextTick: (fn) => fn() };
  const document = {
    addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture }); },
    removeEventListener: (type, fn, capture) => {
      const i = listeners.findIndex((x) => x.type === type && x.fn === fn && x.capture === capture);
      if (i >= 0) { listeners.splice(i, 1); }
    },
    // the template disables a choice flowCan refuses
    querySelector: (sel) => {
      assert.equal(sel, '#flow_menu button:not([disabled])');
      return (vm.flowCan('remaining') && items.remaining) || (vm.flowCan('whole') && items.whole) || null;
    },
    getElementById: (id) => (id === 'flow_queue_btn' ? toggle : null),
  };
  const methods = new Function('document', 'QUEUEFLOW', 'flowQueue', `'use strict'; return {\n${MENU_METHODS.map(vpMethod).join('\n')}\n};`)(
    document, QF, (mode) => { log.chosen.push(mode); });
  for (const name of MENU_METHODS) { vm[name] = methods[name].bind(vm); }
  const hooks = {};
  new Function('mstreamModule', 'flowState', `
    'use strict';
    ${sliceModuleFn(VP_SRC, 'vp.js', 'setFlowAvailable', ['  };'])}
    ${sliceModuleFn(VP_SRC, 'vp.js', 'setFlowBusy', ['  };'])}
  `)(hooks, flowState);
  const mousedowns = () => listeners.filter((x) => x.type === 'mousedown' && x.capture === true);
  return { vm, log, flowState, hooks, items, toggle, outside, listeners, mousedowns };
}

describe('the Flow menu (vp.js)', () => {
  test('open: the capture listener, focus on the first enabled choice; busy ignores the toggle', () => {
    const M = makeMenu({ queue: rows(4), pos: 0 });
    M.vm.flowToggle();
    assert.equal(M.flowState.open, true);
    assert.equal(M.mousedowns().length, 1);
    assert.deepEqual(M.log.focused, ['remaining']);

    const last = makeMenu({ queue: rows(4), pos: 3 });   // nothing after the playing song
    last.vm.flowToggle();
    assert.deepEqual(last.log.focused, ['whole'], 'Remaining songs is disabled there');

    const busy = makeMenu();
    busy.flowState.busy = true;
    busy.vm.flowToggle();
    assert.equal(busy.flowState.open, false);
    assert.equal(busy.listeners.length, 0);
    assert.deepEqual(busy.log.focused, []);
  });

  test('the toggle again closes it without moving focus; Escape closes it and focus returns to Flow', () => {
    const M = makeMenu();
    M.vm.flowToggle();
    M.vm.flowToggle();
    assert.equal(M.flowState.open, false);
    assert.equal(M.listeners.length, 0);
    assert.deepEqual(M.log.focused, ['remaining']);

    M.vm.flowToggle();
    M.vm.flowClose(true);   // the template's keydown.esc
    assert.equal(M.flowState.open, false);
    assert.equal(M.listeners.length, 0);
    assert.deepEqual(M.log.focused, ['remaining', 'remaining', 'flow_queue_btn']);
    assert.ok(HTML.includes('class="flow-wrap" v-on:keydown.esc="flowClose(true)" v-on:focusout="flowFocusOut"'));
  });

  test('a mousedown outside closes it and drops the listener; one inside leaves it open', () => {
    const M = makeMenu();
    M.vm.flowToggle();
    const [{ fn }] = M.mousedowns();
    fn({ target: M.items.whole });
    assert.equal(M.flowState.open, true);
    fn({ target: M.outside });
    assert.equal(M.flowState.open, false);
    assert.equal(M.listeners.length, 0);
    assert.deepEqual(M.log.focused, ['remaining'], 'no refocus on a click away');
  });

  test('focus leaving it (Tab) closes it; within it, or dropped by a click, it stays', () => {
    const M = makeMenu();
    M.vm.flowToggle();
    M.vm.flowFocusOut({ relatedTarget: M.items.whole });
    assert.equal(M.flowState.open, true, 'Tab to Whole queue');
    M.vm.flowFocusOut({ relatedTarget: null });
    assert.equal(M.flowState.open, true, "a click that drops focus is the mousedown's to judge");
    M.vm.flowFocusOut({ relatedTarget: M.outside });
    assert.equal(M.flowState.open, false, 'Tab past the menu');
    assert.equal(M.listeners.length, 0);
    assert.deepEqual(M.log.focused, ['remaining']);
  });

  test('a mouse press leaves no focus on Flow; a key press keeps it there', () => {
    const click = (el) => ({ detail: 1, currentTarget: el });
    const key = (el) => ({ detail: 0, currentTarget: el });

    const M = makeMenu();
    M.vm.flowToggle(click(M.toggle));
    assert.equal(M.flowState.open, true);
    assert.deepEqual(M.log.blurred, ['flow_queue_btn']);
    assert.deepEqual(M.log.focused, ['remaining'], 'the first choice still takes focus');
    M.vm.flowChoose('whole', click(M.items.whole));
    assert.equal(M.flowState.open, false);
    assert.deepEqual(M.log.focused, ['remaining'], 'no refocus after a mouse choice');
    assert.deepEqual(M.log.chosen, ['whole']);
    M.vm.flowToggle(click(M.toggle));
    M.vm.flowToggle(click(M.toggle));
    assert.equal(M.flowState.open, false, 'closed by a second click');
    assert.equal(M.log.blurred.length, 3);

    const busy = makeMenu();
    busy.flowState.busy = true;
    busy.vm.flowToggle(click(busy.toggle));
    assert.deepEqual(busy.log.blurred, ['flow_queue_btn'], 'busy still drops a click\'s focus');

    const K = makeMenu();
    K.vm.flowToggle(key(K.toggle));
    K.vm.flowChoose('remaining', key(K.items.remaining));
    assert.deepEqual(K.log.blurred, []);
    assert.deepEqual(K.log.focused, ['remaining', 'flow_queue_btn']);
  });

  test('a choice closes the menu, returns focus to Flow and runs flowQueue', () => {
    for (const mode of ['remaining', 'whole']) {
      const M = makeMenu();
      M.vm.flowToggle();
      M.vm.flowChoose(mode);
      assert.equal(M.flowState.open, false);
      assert.equal(M.listeners.length, 0);
      assert.deepEqual(M.log.focused, ['remaining', 'flow_queue_btn']);
      assert.deepEqual(M.log.chosen, [mode]);
    }
  });

  test('flowCan: two or more songs in what queueSubject would send', () => {
    for (const [n, pos] of [[0, -1], [1, 0], [2, 0], [2, 1], [3, 1], [4, -1], [5, 4]]) {
      const queue = rows(n);
      const M = makeMenu({ queue, pos });
      for (const mode of ['remaining', 'whole']) {
        assert.equal(M.vm.flowCan(mode), QF.queueSubject(queue, pos, mode).subject.length >= 2, `${n} songs, at ${pos}, ${mode}`);
      }
    }
    assert.equal(makeMenu({ queue: rows(3), pos: 2 }).vm.flowCan('remaining'), false);
    assert.equal(makeMenu({ queue: rows(3), pos: 2 }).vm.flowCan('whole'), true);
  });

  test('setFlowAvailable / setFlowBusy: only true shows or busies; either way off closes the menu', () => {
    const M = makeMenu();
    M.hooks.setFlowAvailable(true);
    assert.equal(M.flowState.available, true);
    M.vm.flowToggle();
    M.hooks.setFlowBusy(true);
    assert.deepEqual([M.flowState.busy, M.flowState.open], [true, false]);
    M.hooks.setFlowBusy(false);
    assert.equal(M.flowState.busy, false);
    M.vm.flowToggle();
    M.hooks.setFlowAvailable(false);
    assert.deepEqual([M.flowState.available, M.flowState.open], [false, false]);
    M.hooks.setFlowAvailable(1);
    assert.equal(M.flowState.available, false, 'strictly true');
  });
});

describe("the player's hotkeys leave Flow's controls alone (vp.js hotkeysSkip)", () => {
  test('Space / Enter on Flow, its choices, Add All In Flow Order and the Undo press them', () => {
    const start = VP_SRC.indexOf('\n  function hotkeysSkip(');
    assert.ok(start >= 0, 'vp.js no longer defines hotkeysSkip() — update this test');
    const src = VP_SRC.slice(start + 1, VP_SRC.indexOf('\n  }\n', start) + '\n  }'.length);
    const skip = new Function('document', `${src}\nreturn hotkeysSkip;`)({ querySelector: () => null });
    const target = (tagName, classes = []) => ({ tagName, isContentEditable: false,
      // a descendant selector ('#a .b') matches when every part does
      closest: (sel) => (sel.split(/,\s*/).some((one) => one.split(/\s+/).every((part) => classes.includes(part.replace(/^\./, '')))) ? {} : null) });
    assert.equal(skip(target('BUTTON', ['flow-wrap', 'flow-btn'])), true, 'Flow');
    assert.equal(skip(target('BUTTON', ['flow-wrap', 'flow-menu-item'])), true, 'a choice');
    assert.equal(skip(target('BUTTON', ['flow-add-btn'])), true, 'Add All In Flow Order');
    assert.equal(skip(target('BUTTON', ['#flow-toast', 'iziToast-buttons'])), true, 'the flow toast\'s Undo');
    assert.equal(skip(target('BUTTON', ['iziToast-buttons'])), false, 'another toast\'s button (a delete confirm): Space still pauses');
    assert.equal(skip(target('BUTTON')), false, 'a button elsewhere: the hotkey plays');
    assert.ok(HTML.includes('class="flow-add-btn super-hide"'));
  });
});

describe("init: the ping's flowOrder (m.js)", () => {
  test('a generation of 1 or more shows Flow, except in server audio; the browse bar is gated too', () => {
    const init = sliceFn('init');
    const from = init.indexOf('    MSTREAMAPI.currentServer.flowOrder = ');
    const lineEnd = init.indexOf('\n', init.indexOf('VUEPLAYERCORE.setFlowAvailable(', from));
    assert.ok(from >= 0 && lineEnd > from, 'init no longer reads flowOrder — update this test');
    const block = init.slice(from, lineEnd);
    for (const [response, serverAudio, shown, stored] of [
      [{ flowOrder: 1 }, false, true, 1], [{ flowOrder: 2 }, false, true, 2], [{ flowOrder: 0 }, false, false, 0],
      [{}, false, false, 0], [{ flowOrder: null }, false, false, 0], [{ flowOrder: 1 }, true, false, 1],
    ]) {
      const api = { currentServer: {} };
      const seen = { available: [], gates: 0 };
      new Function('MSTREAMAPI', 'response', 'flowAddAllGate', 'VUEPLAYERCORE', 'serverAudioMode', `
        'use strict';
        ${sliceFn('flowServerAudio')}
        ${block}
      `)(api, response, () => { seen.gates++; }, { setFlowAvailable: (on) => seen.available.push(on) }, serverAudio);
      const label = JSON.stringify([response, serverAudio]);
      assert.equal(api.currentServer.flowOrder, stored, label);
      assert.deepEqual(seen.available, [shown], label);
      assert.equal(seen.gates, 1, label);
    }
  });
});

// ── strings and markup ──────────────────────────────────────────────
describe('strings and markup', () => {
  test("every 'flow.*' key the webapp uses is in en.json, and in no other locale", () => {
    const en = JSON.parse(read('webapp', 'locales', 'en.json'));
    const used = new Set();
    for (const src of [M_SRC, VP_SRC, HTML]) {
      // t('flow.x') / tt('flow.x') in code, data-i18n="flow.x" in markup
      for (const m of src.matchAll(/\btt?\(\s*['"](flow\.[A-Za-z]+)['"]|data-i18n="(flow\.[A-Za-z]+)"/g)) { used.add(m[1] || m[2]); }
    }
    for (const k of ['flow.addAll', 'flow.queue', 'flow.remaining', 'flow.whole', 'flow.flowed', 'flow.undo', 'flow.failed', 'flow.addFailed', 'flow.nothing']) {
      assert.ok(used.has(k), `${k} is used`);
    }
    for (const k of used) { assert.equal(typeof en[k], 'string', `${k} in en.json`); }
    const dir = path.join(ROOT, 'webapp', 'locales');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'en.json' && x !== 'languages.json')) {
      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      assert.deepEqual(keys.filter((k) => k.startsWith('flow.')), [], `${f} has no flow.* keys`);
    }
  });

  test('index.html: the script, the browse-bar button, the Now Playing control; Add All untouched', () => {
    const qf = HTML.indexOf('<script defer src="alpha/queue-flow.js"></script>');
    assert.ok(qf > 0);
    assert.ok(qf < HTML.indexOf('<script defer src="alpha/m.js"></script>'));

    const btn = HTML.match(/<button [^>]*id="flow_add_all_btn"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(btn, 'a <button>');
    for (const bit of ['class="flow-add-btn super-hide"', 'aria-label="Add All In Flow Order"', 'data-i18n="flow.addAll"', 'data-i18n-attr="aria-label"', 'onclick="addAllFlow(event);"', 'class="spinner"', 'aria-busy="false"']) {
      assert.ok(btn[0].includes(bit), bit);
    }

    const bar = HTML.slice(HTML.indexOf('id="playlist-buttons"'), HTML.indexOf('tooltip.livePlaylist'));
    for (const bit of ['v-if="flow.available && !playerStats.autoDJ"', ':aria-expanded=', ':aria-busy=', 'id="flow_queue_btn"', "flowChoose('remaining', $event)", "flowChoose('whole', $event)", ":aria-label=\"tt('flow.queue')\""]) {
      assert.ok(bar.includes(bit), bit);
    }

    assert.ok(HTML.includes('<svg onclick="addAll();" class="pointer" xmlns="http://www.w3.org/2000/svg" height="24" width="24"><title data-i18n="tooltip.addAllToQueue">Add All To Queue</title>'));
  });
});
