// Peer Recommendations' clip and the aside player (webapp/alpha/vp.js;
// docs/peer-recommendations-plan.md §2 items 10–14, §5.4–§5.5, §4.1
// "webapp-peer-recs-clip.test.mjs"), and the page's three API calls
// (webapp/alpha/api.js).
//
// vp.js's aside player (asideEl … asideMainPlaying, module functions) and
// the clip controller (the clip* methods of its playlist component) are
// sliced out of the file by name and run over fakes: one Audio class that
// counts its elements and fires their events, a main player whose
// playPause() toggles playerStats.playing (its Vue watcher — asynchronous
// and coalesced — delivered by the test), a scripted
// MSTREAMAPI.discoveryPreview, and a fake clock for the 429 waits and the
// queued press. PEERRECS is the real module. Leads carry the tile the
// server's own leadTile stamps.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { leadTile } from '../../src/state/discovery-peer-view.js';

const require = createRequire(import.meta.url);
const PR = require('../../webapp/alpha/peer-recs.js');
const VP_SRC = readFileSync(new URL('../../webapp/alpha/vp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const API_SRC = readFileSync(new URL('../../webapp/alpha/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// One method of a vp.js component (`      name: function (`), one module
// function (`  function name(`), one module-level one-line declaration.
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
function vpModuleDecl(name) {
  const m = new RegExp(`\\n  (?:const|let) ${name} = [^\\n]*;\\n`).exec(VP_SRC);
  assert.ok(m, `vp.js no longer declares ${name} on one line — update this test`);
  return m[0].trim();
}

const ASIDE_FNS = ['asideMainStats', 'asideEl', 'asideClaim', 'asideStart', 'asidePlay', 'asidePause', 'asideResume', 'asideStop', 'asideMainPlaying',
  'blankDiscoverClip', 'clipPreviewOf', 'dmTileOf'];
const DECLS = ['aside', 'CLIP_LIVE', 'CLIP_QUEUE_MS', 'CLIP_RESULTS_MAX', 'clipNet', 'clipRetryTimer', 'clipWatchers'];
const CLIP_METHODS = ['clipProvider', 'clipToggle', 'clipStart', 'clipHandlers', 'clipAsk', 'clipPump', 'clipSend', 'clipPlay', 'clipSettle', 'clipEnd',
  'clipHalt', 'clipPrefetch', 'clipPause', 'clipResume', 'clipStop', 'clipReset', 'clipRemember', 'clipState', 'clipEmit',
  // the window's tile clip, on the same aside (owner 'window')
  'playDiscoverPreview', 'stopDiscoverPreview'];

const DEEZER = { name: 'deezer', title: 'Deezer', capabilities: ['preview'] };
const ITUNES = { name: 'itunes', title: 'Apple Music', capabilities: ['preview'] };
const KITCHEN = 'b2'.repeat(32);
const lead = (title, artist, album, exportId) => ({
  source: 'p2p', title, artist, album, year: 2021, duration: 200, similarity: 0.8, exportId,
  peer: { endpointId: KITCHEN, name: 'Kitchen Radio', label: 'Kitchen Radio' }, tile: leadTile({ artist, album, title }),
});
const SIGNAL = lead('Signal Fires', 'Paper Lantern', 'Night Ferry', 'k1');
const HARBOR = lead('Harbor Lights', 'Paper Lantern', 'Night Ferry', 'k2');
const LONG = lead('Long Exposure', 'Marlowe Fields', 'Daylight Savings', 'k3');
const ARCADE = lead('Arcade Rain', 'Juniper Static', 'Neon Psalms', 'k4');
const NIGHT_FERRY = 'paper lantern|night ferry';
const previewOf = (l, over) => ({
  provider: 'deezer', url: `https://cdn.example/${l.exportId}.mp3`, seconds: 30, title: l.title, artist: l.artist, album: l.album,
  link: `https://www.deezer.com/track/${l.exportId}`, artwork: `https://cdn.example/${l.exportId}.jpg`, attribution: 'Preview from Deezer', match: 0.97, ...over,
});
// The resolve's answers as statusReq hands them over.
const ok = (l, over) => ({ status: 200, body: { plugin: 'deezer', result: { preview: previewOf(l, over) } } });
const none = () => ({ status: 200, body: { plugin: 'deezer', result: { preview: null } } });
const busy = () => ({ status: 429, body: { error: 'plug-in deezer is rate-limited right now — try again shortly' } });
const off = () => ({ status: 403, body: { error: 'discovery plug-ins are disabled' } });
const down = () => ({ status: 0, body: null });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve, answer: () => promise }; };
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); } };

class FakeAudio {
  constructor() { FakeAudio.made.push(this); this.on = {}; this.src = ''; this.paused = true; this.currentTime = 0; this.plays = []; this.refuse = null; }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  play() {
    this.plays.push(this.src);
    if (this.refuse) { const err = this.refuse; this.refuse = null; return Promise.reject(err); }
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  fire(type) { (this.on[type] || []).forEach((fn) => fn()); }
}
FakeAudio.made = [];

function makeClip({ plugins = [DEEZER], playing = false, answers = [], available = true } = {}) {
  FakeAudio.made = [];
  // the main player: playPause() toggles; its watcher is delivered by the
  // test, as Vue does — later, and only for a value that changed
  const player = { playerStats: { playing }, toggles: [], delivered: playing,
    playPause() { player.playerStats.playing = !player.playerStats.playing; player.toggles.push(player.playerStats.playing ? 'play' : 'pause'); } };
  const clock = { now: 0, list: [], seq: 0 };
  const setT = (fn, ms) => { clock.seq += 1; clock.list.push({ id: clock.seq, at: clock.now + ms, ms, fn }); return clock.seq; };
  const clearT = (id) => { clock.list = clock.list.filter((x) => x.id !== id); };
  const calls = [];
  const queue = answers.slice();
  const api = {
    discoveryPreview: (name, rec) => {
      calls.push({ name, title: rec.title, rec });
      assert.ok(queue.length > 0, `an unexpected resolve for ${rec.title}`);
      const next = queue.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next);
    },
  };
  const body = `
    ${DECLS.map(vpModuleDecl).join('\n')}
    ${ASIDE_FNS.map(vpModuleFn).join('\n')}
    return {
      methods: { ${CLIP_METHODS.map((n) => `${n}: ${vpMethodSrc(n)}`).join(',\n')} },
      blank: blankDiscoverClip, aside, clipNet, watchers: clipWatchers, asideMainPlaying, asideStop,
    };`;
  const mod = new Function('PEERRECS', 'MSTREAMAPI', 'MSTREAMPLAYER', 'Audio', 'setTimeout', 'clearTimeout', body)(PR, api, player, FakeAudio, setT, clearT);
  const vm = {
    discover: { plugins: { available, list: plugins }, clip: mod.blank(), modal: { playing: null } },
    $set(o, k, v) { o[k] = v; }, $delete(o, k) { delete o[k]; },
    ensureDiscoverPlugins: async () => vm.discover.plugins.list,
    ...mod.methods,
  };
  const events = [];
  mod.watchers.push((ev) => events.push(ev));
  const deliver = () => {
    if (player.playerStats.playing !== player.delivered) { player.delivered = player.playerStats.playing; mod.asideMainPlaying(player.delivered); }
  };
  // a step: its promises settle, then the main player's watcher runs
  const step = async () => { await settle(); deliver(); await settle(); };
  const tick = async (ms) => {
    const end = clock.now + ms;
    for (;;) {
      const due = clock.list.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) { break; }
      clock.list = clock.list.filter((x) => x !== due);
      clock.now = due.at;
      due.fn();
      await step();
    }
    clock.now = end;
  };
  // the user presses the main player's play
  const userPlays = async () => { player.playerStats.playing = true; await step(); };
  const el = () => FakeAudio.made[0];
  const types = () => events.map((e) => e.type);
  return { vm, mod, api, calls, queue, player, clock, events, types, step, tick, userPlays, el, c: vm.discover.clip };
}

describe('the aside player: one element, the main player paused once and resumed once (§2 items 13–14)', () => {
  test('one <audio> element for every clip and every window tile — Safari plays a reused one again without a press', async () => {
    const h = makeClip({ answers: [ok(SIGNAL), ok(HARBOR)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    await h.vm.clipStart(HARBOR);
    await h.step();
    h.vm.playDiscoverPreview('deezer', previewOf(LONG));
    await h.step();
    await h.vm.clipStart(SIGNAL);   // the visit's answer: no call
    await h.step();
    assert.equal(FakeAudio.made.length, 1);
    assert.deepEqual(h.el().plays, ['https://cdn.example/k1.mp3', 'https://cdn.example/k2.mp3', 'https://cdn.example/k3.mp3', 'https://cdn.example/k1.mp3']);
    assert.equal(h.el().preload, 'auto');
    assert.equal(h.calls.length, 2);
  });

  test('main playing: paused when the first clip starts (not while it is asked for), kept paused across three hand-offs, resumed once', async () => {
    const asked = deferred();
    const h = makeClip({ playing: true, answers: [asked.answer, ok(HARBOR), ok(LONG)] });
    h.vm.clipStart(SIGNAL);
    await h.step();
    assert.deepEqual([h.c.status, h.player.toggles], ['resolving', []], 'it plays on while the clip is asked for');
    asked.resolve(ok(SIGNAL));
    await h.step();
    assert.deepEqual([h.c.status, h.player.toggles, h.player.playerStats.playing], ['playing', ['pause'], false]);
    // 1: the next lead (Preview all, ⏭)
    await h.vm.clipStart(HARBOR);
    await h.step();
    // 2: a window's tile takes the aside
    h.vm.playDiscoverPreview('deezer', previewOf(ARCADE));
    await h.step();
    assert.deepEqual([h.c.status, h.events[h.events.length - 1].type, h.events[h.events.length - 1].why, h.vm.discover.modal.playing], ['idle', 'stopped', 'preempted', 'deezer']);
    // 3: the page's clip takes it back
    await h.vm.clipStart(LONG);
    await h.step();
    assert.deepEqual([h.c.status, h.vm.discover.modal.playing], ['playing', null], 'the tile let go');
    assert.deepEqual(h.player.toggles, ['pause'], 'no resume / pause blip between clips');
    assert.equal(h.vm.clipStop('user'), true);
    await h.step();
    assert.deepEqual([h.player.toggles, h.player.playerStats.playing, h.c.status], [['pause', 'play'], true, 'idle'], 'resumed once, and its own resume ends nothing');
    assert.equal(h.vm.clipStop('user'), false, 'nothing live: a second stop is nothing');
    assert.deepEqual(h.player.toggles, ['pause', 'play']);
  });

  test('main not playing: never touched — not by a clip, a tile, a hand-off, an end or a stop', async () => {
    const h = makeClip({ answers: [ok(SIGNAL), ok(HARBOR)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    h.el().fire('ended');
    await h.vm.clipStart(HARBOR);
    await h.step();
    h.vm.playDiscoverPreview('deezer', previewOf(LONG));
    h.vm.stopDiscoverPreview();
    h.vm.clipStop('user');
    await h.step();
    assert.deepEqual(h.player.toggles, []);
  });

  test('a session ends by itself once nobody carries it on: a clip played out, a none, a refused play — each resumes the main player once', async () => {
    const h = makeClip({ playing: true, answers: [ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    h.el().fire('ended');
    await h.step();
    assert.deepEqual([h.c.status, h.types().slice(-1)[0], h.player.toggles], ['idle', 'ended', ['pause', 'play']]);
    // Preview all: the listener starts the next lead inside 'ended' — the session goes on
    const all = makeClip({ playing: true, answers: [ok(SIGNAL), none(), ok(LONG)] });
    const next = { ended: HARBOR, none: LONG };
    all.mod.watchers.push((ev) => { if (next[ev.type] && ev.key !== PR.leadKey(LONG)) { all.vm.clipStart(next[ev.type]); } });
    await all.vm.clipStart(SIGNAL);
    await all.step();
    all.el().fire('ended');
    await all.step();
    assert.deepEqual([all.c.key, all.c.status, all.player.toggles], [PR.leadKey(LONG), 'playing', ['pause']], 'Harbor Lights had none: skipped, the main player still paused');
    all.el().fire('ended');
    await all.step();
    assert.deepEqual(all.player.toggles, ['pause', 'play'], 'the chain ended: resumed once');
    // a play() the browser refuses (the element is the first clip's): failed, and the session ends
    const h2 = makeClip({ playing: true, answers: [ok(SIGNAL), ok(HARBOR)] });
    await h2.vm.clipStart(SIGNAL);
    await h2.step();
    h2.el().refuse = Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
    await h2.vm.clipStart(HARBOR);
    await h2.step();
    assert.deepEqual([h2.c.status, h2.types().slice(-1)[0], h2.player.toggles], ['failed', 'failed', ['pause', 'play']]);
    // an AbortError is the aside's own pause or swap: nothing
    const h3 = makeClip({ answers: [ok(SIGNAL)] });
    await h3.vm.clipStart(SIGNAL);
    await h3.step();
    h3.el().refuse = Object.assign(new Error('interrupted'), { name: 'AbortError' });
    h3.vm.clipPause();
    h3.vm.clipResume();
    await h3.step();
    assert.equal(h3.c.status, 'playing');
  });

  test('the user starting the main player ends the clip, and nothing resumes the main player for it later', async () => {
    const h = makeClip({ playing: true, answers: [ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.deepEqual(h.player.toggles, ['pause']);
    await h.userPlays();
    assert.deepEqual([h.c.status, h.types().slice(-1)[0], h.events[h.events.length - 1].why, h.el().paused], ['idle', 'stopped', 'main', true]);
    h.vm.clipStop('user');
    h.el().fire('ended');
    await h.step();
    assert.deepEqual(h.player.toggles, ['pause'], 'never played again by the clip');
    // paused clips too
    const p = makeClip({ playing: true, answers: [ok(SIGNAL)] });
    await p.vm.clipStart(SIGNAL);
    await p.step();
    p.vm.clipPause();
    await p.userPlays();
    assert.deepEqual([p.c.status, p.player.toggles], ['idle', ['pause']]);
    // a clip asked for while the main player was paused: the user's play cancels it before it starts
    const asked = deferred();
    const q = makeClip({ playing: false, answers: [asked.answer] });
    q.vm.clipStart(SIGNAL);
    await q.step();
    await q.userPlays();
    assert.deepEqual([q.c.status, q.types().slice(-1)[0]], ['idle', 'stopped']);
    asked.resolve(ok(SIGNAL));
    await q.step();
    assert.deepEqual([q.c.status, FakeAudio.made.length, q.player.toggles], ['idle', 0, []], 'its answer plays nothing');
    assert.equal(q.c.results[PR.leadKey(SIGNAL)].status, 'ready', 'and is kept for the visit');
    // the main player's own song change while the first clip is asked for ends nothing
    const song = deferred();
    const s = makeClip({ playing: true, answers: [song.answer] });
    s.vm.clipStart(SIGNAL);
    await s.step();
    s.player.playerStats.playing = false;
    await s.step();
    s.player.playerStats.playing = true;
    await s.step();
    assert.equal(s.c.status, 'resolving');
    song.resolve(ok(SIGNAL));
    await s.step();
    assert.deepEqual([s.c.status, s.player.toggles], ['playing', ['pause']]);
  });

  test('the window\'s tile and the page\'s clip preempt each other; stopDiscoverPreview leaves a page clip alone', async () => {
    const h = makeClip({ playing: true, answers: [ok(SIGNAL), ok(HARBOR)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    h.vm.stopDiscoverPreview();
    await h.step();
    assert.deepEqual([h.c.status, h.el().paused, h.player.toggles], ['playing', false, ['pause']], 'a window opening or closing: the clip plays on');
    h.vm.playDiscoverPreview('deezer', previewOf(LONG));
    await h.step();
    assert.deepEqual([h.c.status, h.events[h.events.length - 1].why, h.vm.discover.modal.playing, h.el().src], ['idle', 'preempted', 'deezer', 'https://cdn.example/k3.mp3']);
    h.el().fire('timeupdate');
    assert.equal(h.types().slice(-1)[0], 'stopped', 'the tile\'s events are not the clip\'s');
    await h.vm.clipStart(HARBOR);
    await h.step();
    assert.deepEqual([h.vm.discover.modal.playing, h.c.status], [null, 'playing']);
    h.vm.stopDiscoverPreview();
    assert.equal(h.c.status, 'playing');
    // the tile played out: the window's session ends, the main player plays again
    const t = makeClip({ playing: true });
    t.vm.playDiscoverPreview('deezer', previewOf(LONG));
    t.el().fire('ended');
    await t.step();
    assert.deepEqual([t.vm.discover.modal.playing, t.player.toggles], [null, ['pause', 'play']]);
  });
});

describe('the clip: pacing, 429s and the visit\'s answers (§5.5)', () => {
  test('a 429 from deezer: waiting, 5 s, one retry that plays', async () => {
    const h = makeClip({ answers: [busy(), ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.deepEqual([h.c.status, h.types().slice(-1)[0], h.events[h.events.length - 1].ms], ['waiting', 'waiting', 5000]);
    await h.tick(4999);
    assert.equal(h.calls.length, 1);
    await h.tick(1);
    assert.deepEqual([h.calls.length, h.c.status], [2, 'playing']);
  });

  test('still 429: "No preview" for that press only — nothing kept, the next press asks again', async () => {
    const h = makeClip({ answers: [busy(), busy(), ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.tick(5000);
    assert.deepEqual([h.c.status, h.types().slice(-1)[0], h.events[h.events.length - 1].state.status], ['failed', 'failed', 'failed']);
    assert.equal(PR.leadKey(SIGNAL) in h.c.results, false, 'transient');
    assert.equal(h.clock.list.length, 0, 'one retry only');
    await h.vm.clipToggle(SIGNAL);
    await h.step();
    assert.deepEqual([h.calls.length, h.c.status], [3, 'playing']);
  });

  test('itunes waits 60 s', async () => {
    const h = makeClip({ plugins: [ITUNES, DEEZER], answers: [busy(), ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.equal(h.calls[0].name, 'itunes', 'the first preview plug-in, no other');
    assert.equal(h.events[h.events.length - 1].ms, 60000);
    await h.tick(59999);
    assert.equal(h.calls.length, 1);
    await h.tick(1);
    assert.deepEqual([h.calls.map((x) => x.name), h.c.status], [['itunes', 'itunes'], 'playing']);
  });

  test('no answer at all is "No preview" for that press, never retried; any other refusal too', async () => {
    for (const answer of [down(), { status: 502, body: { error: 'x' } }, { status: 200, body: { result: null } }, { status: 404, body: null }]) {
      const h = makeClip({ answers: [answer] });
      await h.vm.clipStart(SIGNAL);
      await h.step();
      assert.deepEqual([h.c.status, h.calls.length, h.clock.list.length, Object.keys(h.c.results).length], ['failed', 1, 0, 0], String(answer.status));
    }
  });

  test('preview: null is "No preview" for the visit: kept, and a replay asks nothing', async () => {
    const h = makeClip({ answers: [none()] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.deepEqual([h.c.status, h.types().slice(-1)[0], h.c.results[PR.leadKey(SIGNAL)]], ['none', 'none', { status: 'none', preview: null }]);
    await h.vm.clipToggle(SIGNAL);
    await h.step();
    assert.deepEqual([h.calls.length, h.c.status, h.types().slice(-1)[0]], [1, 'none', 'none']);
    // a preview without a URL plays nothing either
    const bare = makeClip({ answers: [ok(SIGNAL, { url: '' })] });
    await bare.vm.clipStart(SIGNAL);
    await bare.step();
    assert.equal(bare.c.status, 'none');
  });

  test('the results cache: a lead answered once plays again without a call', async () => {
    const h = makeClip({ answers: [ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    h.vm.clipStop('user');
    await h.vm.clipToggle(SIGNAL);
    await h.step();
    assert.deepEqual([h.calls.length, h.c.status, h.c.preview.attribution], [1, 'playing', 'Preview from Deezer']);
    // at most CLIP_RESULTS_MAX kept, the oldest dropped
    const cap = Number(vpModuleDecl('CLIP_RESULTS_MAX').match(/\d+/)[0]);
    const results = {};
    for (let i = 0; i <= cap; i++) { h.vm.clipRemember(results, `k${i}`, { status: 'none', preview: null }); }
    assert.deepEqual([Object.keys(results).length, 'k0' in results, `k${cap}` in results], [cap, false, true]);
  });

  test('a prefetch never retries and never plays; its answer is the visit\'s; none while another resolve is out', async () => {
    const h = makeClip({ answers: [busy(), ok(HARBOR)] });
    assert.equal(await h.vm.clipPrefetch(HARBOR), true);
    assert.deepEqual([h.calls.length, h.clock.list.length, Object.keys(h.c.results).length, FakeAudio.made.length], [1, 0, 0, 0], 'a 429: dropped');
    assert.equal(await h.vm.clipPrefetch(HARBOR), true);
    assert.deepEqual(h.c.results[PR.leadKey(HARBOR)].status, 'ready');
    assert.equal(await h.vm.clipPrefetch(HARBOR), false, 'answered already');
    assert.deepEqual([h.c.status, FakeAudio.made.length], ['idle', 0]);
    await h.vm.clipStart(HARBOR);
    await h.step();
    assert.deepEqual([h.calls.length, h.c.status], [2, 'playing'], 'played from it');
    // one in flight: a prefetch never joins a press's resolve
    const asked = deferred();
    const q = makeClip({ answers: [asked.answer] });
    q.vm.clipStart(SIGNAL);
    await settle();
    assert.equal(await q.vm.clipPrefetch(HARBOR), false);
    assert.equal(q.calls.length, 1);
    asked.resolve(ok(SIGNAL));
    await q.step();
  });

  test('one resolve in flight: a press meanwhile waits for it, and a newer press takes the queued one\'s place', async () => {
    const first = deferred();
    const h = makeClip({ answers: [first.answer, ok(LONG)] });
    h.vm.clipStart(SIGNAL);
    await settle();
    h.vm.clipStart(HARBOR);
    await settle();
    h.vm.clipStart(LONG);
    await settle();
    assert.deepEqual(h.calls.map((x) => x.title), ['Signal Fires'], 'one out');
    assert.deepEqual([h.c.key, h.c.status], [PR.leadKey(LONG), 'resolving']);
    first.resolve(ok(SIGNAL));
    await h.step();
    assert.deepEqual([h.calls.length, h.c.results[PR.leadKey(SIGNAL)].status, FakeAudio.made.length], [1, 'ready', 0], 'its answer kept, not played');
    await h.tick(299);
    assert.equal(h.calls.length, 1);
    await h.tick(1);
    assert.deepEqual([h.calls.map((x) => x.title), h.c.status, h.el().src], [['Signal Fires', 'Long Exposure'], 'playing', 'https://cdn.example/k3.mp3'], 'Harbor Lights was never asked');
    // a queued press whose lead a look ahead answered meanwhile plays from it
    const look = deferred();
    const p = makeClip({ answers: [look.answer] });
    p.vm.clipPrefetch(HARBOR);
    await settle();
    p.vm.clipStart(HARBOR);
    await settle();
    look.resolve(ok(HARBOR));
    await p.step();
    await p.tick(300);
    assert.deepEqual([p.calls.length, p.c.status], [1, 'playing']);
  });

  test('the gen fence: an older clip\'s answer, retry or audio event changes nothing', async () => {
    const h = makeClip({ answers: [busy(), ok(HARBOR)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.equal(h.c.status, 'waiting');
    await h.vm.clipStart(HARBOR);
    await h.step();
    await h.tick(5000);
    assert.deepEqual([h.calls.map((x) => x.title), h.c.key, h.c.status], [['Signal Fires', 'Harbor Lights'], PR.leadKey(HARBOR), 'playing'], 'no retry for Signal Fires');
    // the clip's own handlers from before a hand-off
    const stale = h.vm.clipHandlers(h.c.gen - 1);
    stale.ended();
    stale.error();
    stale.stopped('preempted');
    stale.time(12);
    assert.deepEqual([h.c.status, h.c.at], ['playing', 0]);
    // after a stop the element's events reach nobody
    const n = h.events.length;
    h.vm.clipStop('user');
    h.el().fire('ended');
    h.el().fire('error');
    h.el().fire('timeupdate');
    assert.deepEqual(h.types().slice(n), ['stopped']);
  });

  test('art only when the preview found the lead\'s own album and artist (https): every row of the album earns it', async () => {
    const h = makeClip({ answers: [ok(SIGNAL), ok(LONG, { album: 'Daylight Savings (Deluxe)' }), ok(ARCADE, { artist: 'Someone Else' }), ok(HARBOR, { artwork: 'http://cdn.example/k2.jpg' })] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    assert.deepEqual(h.c.art, { [NIGHT_FERRY]: 'https://cdn.example/k1.jpg' });
    const art = h.events.find((e) => e.type === 'art');
    assert.deepEqual([art.tileKey, art.url], [NIGHT_FERRY, 'https://cdn.example/k1.jpg']);
    assert.equal(SIGNAL.tile.key, HARBOR.tile.key, 'one album, one tile key');
    for (const l of [LONG, ARCADE]) {
      await h.vm.clipStart(l);
      await h.step();
      assert.equal(l.tile.key in h.c.art, false, l.title);
    }
    await h.vm.clipStart(HARBOR);
    await h.step();
    assert.equal(h.c.art[NIGHT_FERRY], 'https://cdn.example/k1.jpg', 'a plain-http artwork changes nothing');
    assert.equal(h.events.filter((e) => e.type === 'art').length, 1);
    // a lead without an album earns nothing
    const single = lead('Copper Dawn', 'Kestrel & Vine', null, 'k9');
    const s = makeClip({ answers: [ok(single, { album: '' })] });
    await s.vm.clipStart(single);
    await s.step();
    assert.deepEqual(s.c.art, {});
  });

  test('clipReset: the clip stops, the visit\'s art and answers are forgotten — and an answer asked before it is not kept', async () => {
    const h = makeClip({ playing: true, answers: [ok(SIGNAL)] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    h.events.length = 0;
    h.vm.clipReset();
    await h.step();
    assert.deepEqual(h.types(), ['stopped', 'reset']);
    assert.equal(h.events[0].why, 'reset');
    assert.deepEqual([h.c.key, h.c.status, h.c.art, h.c.results, h.el().paused, h.player.toggles], [null, 'idle', {}, {}, true, ['pause', 'play']]);
    const asked = deferred();
    const r = makeClip({ answers: [asked.answer] });
    r.vm.clipStart(SIGNAL);
    await settle();
    r.vm.clipReset();
    asked.resolve(ok(SIGNAL));
    await r.step();
    assert.deepEqual([r.c.results, r.c.status, FakeAudio.made.length], [{}, 'idle', 0]);
  });

  test('a 403 switches it off: the visit reset, and watchers hear "off"', async () => {
    const h = makeClip({ answers: [ok(SIGNAL), off()] });
    await h.vm.clipStart(SIGNAL);
    await h.step();
    await h.vm.clipStart(HARBOR);
    await h.step();
    assert.deepEqual(h.types().slice(-3), ['stopped', 'reset', 'off']);
    assert.deepEqual([h.c.status, h.c.art, h.c.results], ['idle', {}, {}]);
  });

  test('the play icon: start, pause, resume in place; a press while it is still asked for cancels it', async () => {
    const asked = deferred();
    const h = makeClip({ playing: true, answers: [asked.answer, ok(SIGNAL)] });
    h.vm.clipToggle(SIGNAL);
    await settle();
    await h.vm.clipToggle(SIGNAL);
    assert.deepEqual([h.c.status, h.events[h.events.length - 1].why], ['idle', 'user']);
    asked.resolve(ok(SIGNAL));
    await h.step();
    assert.deepEqual([FakeAudio.made.length, h.player.toggles], [0, []], 'nothing played');
    await h.vm.clipToggle(SIGNAL);
    await h.step();
    assert.equal(h.c.status, 'playing', 'from the visit\'s answer');
    await h.vm.clipToggle(SIGNAL);
    assert.deepEqual([h.c.status, h.el().paused, h.player.toggles], ['paused', true, ['pause']], 'the main player stays paused');
    await h.vm.clipToggle(SIGNAL);
    assert.deepEqual([h.c.status, h.el().paused, h.el().plays.length], ['playing', false, 2]);
    assert.deepEqual(h.types().filter((t) => t === 'paused' || t === 'playing'), ['playing', 'paused', 'playing']);
  });

  test('its position in quarter seconds while it plays; the end is idle; every event carries the clip\'s snapshot', async () => {
    const h = makeClip({ answers: [ok(SIGNAL, { seconds: 29 })] });
    await h.vm.clipStart(SIGNAL, { tile: { key: 'other', hue: 5, letter: 'O' } });
    await h.step();
    assert.deepEqual(h.c.tile, { key: 'other', hue: 5, letter: 'O' }, 'the page\'s tile when it hands one');
    h.el().currentTime = 12.3;
    h.el().fire('timeupdate');
    h.el().currentTime = 12.32;
    h.el().fire('timeupdate');
    const time = h.events.filter((e) => e.type === 'time');
    assert.deepEqual([time.length, h.c.at, h.c.seconds], [1, 12.25, 29], 'one event per quarter');
    assert.deepEqual(time[0].state, { key: PR.leadKey(SIGNAL), raw: SIGNAL, tile: h.c.tile, status: 'playing', preview: h.c.preview, at: 12.25, seconds: 29, live: true });
    assert.equal(time[0].key, PR.leadKey(SIGNAL));
    h.el().fire('ended');
    assert.deepEqual([h.c.status, h.c.at, h.vm.clipState().live], ['idle', 0, false]);
    assert.deepEqual(h.types(), ['resolving', 'art', 'playing', 'time', 'ended']);
    assert.deepEqual(h.c.art, { other: 'https://cdn.example/k1.jpg' }, 'earned for the tile the clip was started with');
    // no preview plug-in: none, and nothing asked
    const bare = makeClip({ plugins: [] });
    await bare.vm.clipStart(SIGNAL);
    assert.deepEqual([bare.c.status, bare.calls.length], ['none', 0]);
    assert.equal(await bare.vm.clipPrefetch(SIGNAL), false);
    assert.equal(bare.vm.clipProvider(), null);
    assert.equal(makeClip({ available: false }).vm.clipProvider(), null, 'plug-ins off');
  });
});

describe('vp.js wiring: the watcher, a server switch, the exports', () => {
  test('the main player\'s watcher asks the aside first; one `new Audio()` in the file; the old per-tile element is gone', () => {
    assert.match(VP_SRC, /'playerStats\.playing': function\(isPlaying\) \{\n(?: {8}\/\/[^\n]*\n)? {8}asideMainPlaying\(isPlaying\);\n {8}if \(!this\.altLayout\.waveformBar\) return;/);
    assert.equal((VP_SRC.match(/new Audio\(/g) || []).length, 1);
    assert.ok(!/discoverPreviewAudio|discoverPreviewPausedMain/.test(VP_SRC));
  });

  test('a server switch stops the window\'s tile and the clip where they are (no resume) and forgets the visit', () => {
    const at = VP_SRC.indexOf('mstreamModule.setDiscoveryPluginsAvailable = ');
    const fn = VP_SRC.slice(at, VP_SRC.indexOf('\n  };\n', at));
    assert.match(fn, /asideStop\('window', false\);\n {4}asideStop\('clip', false\);\n {4}playlistVue\.clipReset\(\);/);
  });

  test('the page\'s way in: clip* exports, clipArt / clipResult / clipState, watchClip', () => {
    for (const name of ['clipToggle', 'clipStart', 'clipPrefetch', 'clipPause', 'clipResume', 'clipStop', 'clipReset', 'clipState', 'clipArt', 'clipResult', 'watchClip']) {
      assert.match(VP_SRC, new RegExp(`\\n  mstreamModule\\.${name} = `), name);
    }
    assert.match(VP_SRC, /mstreamModule\.watchClip = \(fn\) => \{\n {4}if \(typeof fn !== 'function'\) \{ return \(\) => \{\}; \}\n {4}clipWatchers\.push\(fn\);/);
  });
});

describe('api.js: the strip, the Add and the preview calls (plan §3.2, §3.3, §3.6)', () => {
  function makeApi(answer) {
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const a = typeof answer === 'function' ? answer(url) : answer;
      if (a instanceof Error) { throw a; }
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) { throw new SyntaxError('no json'); } return a.body; } };
    };
    const api = new Function('fetch', 'localStorage', 'Cookies', 'document', 'window', `${API_SRC}\nreturn MSTREAMAPI;`)(fetch, {}, {}, {}, {});
    api.currentServer.host = 'http://h/';
    api.currentServer.token = 'tok';
    return { api, sent };
  }
  const ID = 'c3'.repeat(32);

  test('discoveryP2pPeers: GET, the token, the body; it throws like req() — 403 off, 404 an older server', async () => {
    const peers = { canAdd: true, shelf: { held: 1, searchable: 1, running: true }, peers: [] };
    const a = makeApi({ status: 200, body: peers });
    assert.deepEqual(await a.api.discoveryP2pPeers(), peers);
    assert.deepEqual([a.sent[0].url, a.sent[0].method, a.sent[0].headers['x-access-token']], ['http://h/api/v1/discovery/p2p/peers', 'GET', 'tok']);
    for (const status of [403, 404]) {
      const b = makeApi({ status, body: { error: 'no' } });
      await assert.rejects(b.api.discoveryP2pPeers(), (err) => err.status === status && err.body.error === 'no');
    }
  });

  test('discoveryP2pAdd: POST { endpointId } to the admin route → { status, body }, never a throw', async () => {
    const a = makeApi({ status: 202, body: { endpointId: ID, state: 'adding', code: null, at: 'x' } });
    assert.deepEqual(await a.api.discoveryP2pAdd(ID), { status: 202, body: { endpointId: ID, state: 'adding', code: null, at: 'x' } });
    assert.deepEqual([a.sent[0].url, a.sent[0].method, a.sent[0].body, a.sent[0].headers['x-access-token']],
      ['http://h/api/v1/admin/discovery/p2p/peer-dbs/add', 'POST', { endpointId: ID }, 'tok']);
    assert.deepEqual(await makeApi({ status: 409, body: { error: 'blocked' } }).api.discoveryP2pAdd(ID), { status: 409, body: { error: 'blocked' } });
    assert.deepEqual(await makeApi({ status: 500 }).api.discoveryP2pAdd(ID), { status: 500, body: null }, 'no JSON: no body');
    assert.deepEqual(await makeApi(new TypeError('Failed to fetch')).api.discoveryP2pAdd(ID), { status: 0, body: null }, 'nothing answered');
  });

  test('discoveryPreview: the plug-in\'s resolve, its name encoded, the lead as the recommendation → { status, body }', async () => {
    const a = makeApi({ status: 429, body: { error: 'rate-limited' } });
    assert.deepEqual(await a.api.discoveryPreview('dee zer', SIGNAL), { status: 429, body: { error: 'rate-limited' } });
    assert.deepEqual([a.sent[0].url, a.sent[0].method, a.sent[0].body], ['http://h/api/v1/discovery/plugins/dee%20zer/resolve', 'POST', { recommendation: SIGNAL }]);
    assert.deepEqual((await makeApi(ok(SIGNAL)).api.discoveryPreview('deezer', SIGNAL)).body.result.preview.attribution, 'Preview from Deezer');
    assert.deepEqual(await makeApi(new TypeError('offline')).api.discoveryPreview('deezer', SIGNAL), { status: 0, body: null });
  });
});
