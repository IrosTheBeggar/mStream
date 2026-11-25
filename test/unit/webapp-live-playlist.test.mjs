/**
 * The live playlist in the webapp (m.js): the Live Playlist window's
 * Enable / Disable (setLivePlaylist), the page's start-up, which turns it
 * on again from localStorage's 'live-playlist-auto-start' (init), and the
 * Discover page's and Sonic Path's adds to the queue, which it mirrors.
 *
 * What is pinned:
 *   - Enable with "Start Live Playlist Automatically" ticked keeps the
 *     playlist's name for the next load, which turns it on again with the
 *     playlist's rows; unticked, it keeps nothing;
 *   - Disable forgets it: the next load starts with no live playlist;
 *   - while one is on, each of those adds — Discover's row and its +,
 *     Queue all and Shuffle; Sonic Path's row, Play and Queue all — saves
 *     the whole queue to it once, the add's rows in it and in the queue's
 *     order, and sends no add-song of its own; with none on, nothing is
 *     saved;
 *   - so do vp.js's own Discover adds: the now-playing panel's list (a
 *     row, + Queue all, an artist's ▶) and the recommendation window's
 *     Queue and Play your copy, whose album Play saves the new queue once
 *     and never the emptied one first.
 *
 * Same technique as webapp-add-all.test.mjs: the real code is sliced out of
 * m.js (and vp.js's real addSongWizard, saveLiveQueue and Discover methods
 * out of their module) and run against stub globals.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('webapp', 'alpha', 'm.js');
const VP = read('webapp', 'alpha', 'vp.js');

function sliceFn(name) {
  const lines = SRC.split('\n');
  const header = (l) => l.split(' (').join('(');
  const start = lines.findIndex((l) => header(l).startsWith(`function ${name}(`) || header(l).startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() — update this test`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

function sliceConst(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  assert.ok(start >= 0, `m.js no longer defines const ${name} — update this test`);
  return lines.slice(start, lines.indexOf('};', start) + 1).join('\n');
}

// vp.js's module members, out of its closure: a function, or an arrow
// assigned to mstreamModule.
function vpInner(name) {
  const lines = VP.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`  function ${name}(`) || l.startsWith(`  mstreamModule.${name} = `));
  assert.ok(start >= 0, `vp.js no longer defines ${name} — update this test`);
  const end = lines.findIndex((l, i) => i > start && (l === '  }' || l === '  };'));
  return lines.slice(start, end + 1).join('\n');
}

// init()'s last block: the live playlist the last visit asked to start.
function startUpBlock() {
  const init = sliceFn('init');
  const at = init.indexOf("localStorage.getItem('live-playlist-auto-start')");
  assert.ok(at >= 0, 'init() no longer reads live-playlist-auto-start — update this test');
  const start = init.lastIndexOf('\n  try{\n', at);
  const end = init.indexOf('\n  }catch(err) {}\n', at);
  assert.ok(start >= 0 && end > at, 'init()\'s live-playlist block moved — update this test');
  return init.slice(start, end + '\n  }catch(err) {}\n'.length);
}

const ROAD_TRIP = [
  { filepath: 'demo/Boukmanflow/Dolo.mp3', metadata: { title: 'Dolo' } },
  { filepath: 'demo/Boukmanflow/6AM.mp3', metadata: { title: '6AM' } },
];

// One visit: the window's fields, the player, the server, and the
// browser's storage, which outlives the visit (`storage`).
function makeVisit(storage) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, { id, value: '', checked: false, hidden: false, disabled: false,
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } });
    }
    return els.get(id);
  };
  const calls = { loaded: [], queued: [], cleared: 0, saved: 0, closed: 0, failures: [] };
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  const VUEPLAYERCORE = {
    livePlaylist: { name: false },
    addSongWizard: (filepath, metadata, lookup, position, live, autoPlayOff) => { calls.queued.push({ filepath, live, autoPlayOff }); },
    saveLiveQueue: () => { calls.saved++; },
  };
  const S = new Function('document', 'localStorage', 'VUEPLAYERCORE', 'MSTREAMAPI', 'MSTREAMPLAYER', 'myModal', 'boilerplateFailure', `
    'use strict';
    ${sliceFn('setLivePlaylist')}
    return {
      setLivePlaylist,
      startUp: async () => {${startUpBlock()}},
    };
  `)({ getElementById: el }, localStorage, VUEPLAYERCORE,
    { loadPlaylist: (name) => { calls.loaded.push(name); return Promise.resolve(ROAD_TRIP); } },
    { clearPlaylist: () => { calls.cleared++; } },
    { close: () => { calls.closed++; } },
    (err) => { calls.failures.push(err); });
  // The window as the user leaves it: Use an existing playlist, one picked.
  const pick = (name, autoStart) => {
    el('radio-use-existing').checked = true;
    el('live-playlist-select').value = name;
    el('persist_live_queue').checked = autoStart;
  };
  return { S, calls, el, pick, live: () => VUEPLAYERCORE.livePlaylist.name };
}

describe('the live playlist and the next visit', () => {
  test('Enable with "Start automatically" ticked: the next visit starts it again, with its rows', async () => {
    const storage = new Map();
    const one = makeVisit(storage);
    one.pick('Road Trip', true);
    await one.S.setLivePlaylist();
    assert.equal(one.live(), 'Road Trip');
    assert.equal(storage.get('live-playlist-auto-start'), 'Road Trip');
    assert.equal(one.el('set_live_playlist').value, 'Disable Live Playlist');
    const next = makeVisit(storage);
    await next.S.startUp();
    assert.equal(next.live(), 'Road Trip');
    assert.deepEqual(next.calls.loaded, ['Road Trip']);
    assert.deepEqual(next.calls.queued.map((q) => q.filepath), ROAD_TRIP.map((r) => r.filepath));
    assert.deepEqual(one.calls.failures, []);
  });

  test('unticked: nothing kept, the next visit starts without it', async () => {
    const storage = new Map();
    const one = makeVisit(storage);
    one.pick('Road Trip', false);
    await one.S.setLivePlaylist();
    assert.equal(one.live(), 'Road Trip');
    assert.ok(!storage.has('live-playlist-auto-start'));
    const next = makeVisit(storage);
    await next.S.startUp();
    assert.equal(next.live(), false);
  });

  test('Disable forgets it: the next visit starts with no live playlist', async () => {
    const storage = new Map();
    const one = makeVisit(storage);
    one.pick('Road Trip', true);
    await one.S.setLivePlaylist();
    // the window opened again: Disable Live Playlist (the box still ticked)
    await one.S.setLivePlaylist();
    assert.equal(one.live(), false);
    assert.equal(one.el('set_live_playlist').value, 'Enable Live Playlist');
    assert.equal(one.calls.closed, 2);
    assert.ok(!storage.has('live-playlist-auto-start'), 'the auto-start goes with it');
    const next = makeVisit(storage);
    await next.S.startUp();
    assert.equal(next.live(), false, 'the next visit has none');
    assert.deepEqual(next.calls.loaded, []);
    assert.equal(next.calls.cleared, 0, 'the queue left alone');
    assert.deepEqual(one.calls.failures, []);
  });
});

// ── the adds a live playlist mirrors ────────────────────────────────────
// A just-enough DOM for Sonic Path's page: an element's innerHTML start
// tags become its descendants (flat, in document order), found by id or by
// an [attribute] selector; a listener fires on demand.
const decode = (v) => String(v).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function makeEl(tag, attrs = {}) {
  const el = { tag, attrs, kids: [], listeners: [], html: '', style: {}, value: '' };
  el.getAttribute = (n) => (Object.hasOwn(el.attrs, n) ? el.attrs[n] : null);
  el.addEventListener = (type, fn) => { el.listeners.push({ type, fn }); };
  el.fire = (type) => { el.listeners.filter((l) => l.type === type).forEach((l) => l.fn({ type, target: el })); };
  el.querySelectorAll = (sel) => {
    const m = sel.match(/^\[([\w-]+)\]$/);
    assert.ok(m, `only [attr] selectors here: ${sel}`);
    return el.kids.filter((k) => Object.hasOwn(k.attrs, m[1]));
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el.html,
    set: (h) => {
      el.html = String(h);
      el.kids = [...el.html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)].map((m) => makeEl(m[1].toLowerCase(),
        Object.fromEntries([...m[2].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)].map((a) => [a[1], decode(a[2] ?? '')]))));
    },
  });
  return el;
}

const track = (name, artist = 'Boukmanflow') => ({ filepath: `demo/${artist}/${name}.mp3`, metadata: { title: name, artist } });
const DISCOVER = [track('Dolo'), track('6AM'), track('SkyWalk'), track('Bout2skate')];
const PATH_ROWS = [track('Destiny', 'ALM'), track('Swing', 'ALM'), track('Téranga', 'ALM')];

// vp.js's real addSongWizard and saveLiveQueue over a player that keeps a
// queue, under m.js's Discover and Sonic Path code. `live`: the live
// playlist's name, or false.
function makeApp({ live = 'Road Trip', queue = [track('Guard Up!')] } = {}) {
  const calls = { saved: [], addSong: [], toasts: [] };
  const filelist = makeEl('div', { id: 'filelist' });
  const document = {
    getElementById: (id) => (id === 'filelist' ? filelist : filelist.kids.find((k) => k.attrs.id === id) || null),
  };
  const player = {
    playlist: [],
    positionCache: { val: -1 },
    transcodeOptions: { serverEnabled: false, frontendEnabled: false },
    addSong: (song) => { player.playlist.push(song); },
    insertSongAt: (song, at) => { player.playlist.splice(at, 0, song); },
    clearPlaylist: () => { player.playlist.length = 0; player.positionCache.val = -1; },
    getCurrentSong: () => null,
  };
  const api = {
    currentServer: { host: 'http://host/', token: 'TOK' },
    savePlaylist: (title, songs, isLive) => { calls.saved.push({ title, songs, live: isLive }); return Promise.resolve({}); },
    addToPlaylist: (name, song) => { calls.addSong.push({ name, song }); return Promise.resolve({}); },
    lookupMetadata: (fp) => Promise.resolve({ filepath: fp, metadata: null }),
  };
  const iziToast = { success: (o) => calls.toasts.push(o.title), info: (o) => calls.toasts.push(o.title), warning: (o) => calls.toasts.push(o.title) };
  const t = (k) => k;
  const vue = new Function('MSTREAMPLAYER', 'MSTREAMAPI', 'iziToast', 't', `
    'use strict';
    const mstreamModule = { livePlaylist: { name: false }, altLayout: { waveformBar: false } };
    let warnedMixedQueue = false;
    ${vpInner('localQueueFilepaths')}
    ${vpInner('saveLiveQueue')}
    mstreamModule.saveLiveQueue = saveLiveQueue;
    ${vpInner('addSongWizard')}
    return mstreamModule;
  `)(player, api, iziToast, t);
  // the queue the live playlist was turned on over, already in it
  for (const r of queue) { vue.addSongWizard(r.filepath, r.metadata, false, undefined, false, true); }
  vue.livePlaylist.name = live;
  const S = new Function('document', 'VUEPLAYERCORE', 'MSTREAMPLAYER', 'MSTREAMAPI', 'iziToast', 't', 'DISCOVER', `
    'use strict';
    const DISCOVERYPAGE = {};
    const discoveryView = { shown: { tracks: DISCOVER, allTracks: DISCOVER, peers: [], peerAlbums: [] } };
    const setBrowserRootPanel = () => {};
    // the page's other controls: wired, never pressed here
    const sonicPathHideBanner = () => {};
    const sonicPathBuild = () => {};
    const sonicPathStartOver = () => {};
    const sonicPathPick = () => {};
    const sonicPathUsePlaying = () => {};
    const openSavePlaylistModal = () => {};
    ${sliceConst('entityMap')}
    ${sliceConst('SONICPATH')}
    ${['escapeHtml', 'onDiscoveryClick', 'discoveryAction', 'discoveryQueueAll', 'sonicPathPlay', 'sonicPathPanel'].map(sliceFn).join('\n')}
    return { onDiscoveryClick, discoveryQueueAll, sonicPathPlay, sonicPathPanel, SONICPATH };
  `)(document, vue, player, api, iziToast, t, DISCOVER);
  // a click on the Discover page, on an element carrying data-dp (the row
  // itself or one of its buttons)
  const discoverClick = (tag, attrs) => {
    const el = { tag, getAttribute: (n) => (Object.hasOwn(attrs, n) ? String(attrs[n]) : null) };
    el.closest = (sel) => (sel === '[data-dp]' ? el : null);
    S.onDiscoveryClick({ target: el });
  };
  // Sonic Path's journey on screen
  const pathPage = () => {
    Object.assign(S.SONICPATH, { view: 'results', rows: PATH_ROWS.map((r) => ({ ...r, similarity: 0.9 })), start: { title: 'Destiny' }, end: { title: 'Téranga' }, fetched: true });
    S.sonicPathPanel();
    return {
      row: (i) => filelist.kids.find((k) => k.attrs['data-spath-row'] === String(i)),
      button: (id) => filelist.kids.find((k) => k.attrs.id === id),
    };
  };
  const queuePaths = () => player.playlist.map((s) => s.filepath);
  return { S, calls, player, discoverClick, pathPage, queuePaths };
}

const paths = (rows) => rows.map((r) => r.filepath);
const GUARD = track('Guard Up!').filepath;

describe('a live playlist and the Discover page\'s and Sonic Path\'s adds', () => {
  test('Discover: a row\'s click and its + each save the whole queue, that row in it, once; no add-song', () => {
    const app = makeApp();
    app.discoverClick('div', { 'data-dp': 'queue', 'data-i': 0 });
    assert.deepEqual(app.queuePaths(), [GUARD, DISCOVER[0].filepath]);
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: app.queuePaths(), live: true }]);
    app.discoverClick('button', { 'data-dp': 'queue', 'data-i': 2 });
    assert.deepEqual(app.calls.saved.map((c) => c.songs), [[GUARD, DISCOVER[0].filepath], [GUARD, DISCOVER[0].filepath, DISCOVER[2].filepath]]);
    assert.deepEqual(app.calls.addSong, [], 'the add itself stays off the live playlist: one save, never a second copy');
    assert.deepEqual(app.calls.toasts, ['discover.modal.queued', 'discover.modal.queued']);
  });

  test('Discover: Queue all and Shuffle each save the whole queue once, in the order queued', () => {
    const app = makeApp();
    app.S.discoveryQueueAll(false);
    assert.deepEqual(app.queuePaths(), [GUARD, ...paths(DISCOVER)]);
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: [GUARD, ...paths(DISCOVER)], live: true }]);
    app.S.discoveryQueueAll(true);
    assert.equal(app.calls.saved.length, 2);
    assert.deepEqual(app.calls.saved[1].songs, app.queuePaths(), 'the shuffled order, as queued');
    assert.deepEqual([...app.calls.saved[1].songs.slice(5)].sort(), [...paths(DISCOVER)].sort());
    assert.deepEqual(app.calls.addSong, []);
  });

  test('Sonic Path: a row\'s click, Queue all and Play each save the whole queue once — Play\'s, the path alone', () => {
    const app = makeApp();
    const page = app.pathPage();
    page.row(1).fire('click');
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: [GUARD, PATH_ROWS[1].filepath], live: true }]);
    page.button('spath-queue').fire('click');
    assert.deepEqual(app.calls.saved[1].songs, [GUARD, PATH_ROWS[1].filepath, ...paths(PATH_ROWS)]);
    page.button('spath-play').fire('click');
    assert.deepEqual(app.queuePaths(), paths(PATH_ROWS), 'Play: the path replaces the queue');
    assert.deepEqual(app.calls.saved[2], { title: 'Road Trip', songs: paths(PATH_ROWS), live: true });
    assert.equal(app.calls.saved.length, 3);
    assert.deepEqual(app.calls.addSong, []);
  });

  test('with no live playlist on, the same adds save nothing', () => {
    const app = makeApp({ live: false });
    app.discoverClick('div', { 'data-dp': 'queue', 'data-i': 1 });
    app.S.discoveryQueueAll(true);
    const page = app.pathPage();
    page.row(0).fire('click');
    page.button('spath-queue').fire('click');
    page.button('spath-play').fire('click');
    assert.deepEqual([app.calls.saved, app.calls.addSong], [[], []]);
    assert.deepEqual(app.queuePaths(), paths(PATH_ROWS));
  });
});

// ── vp.js's own Discover adds ───────────────────────────────────────────
// The now-playing panel's Discover list (a row, + Queue all, an artist's
// ▶) and the recommendation window (Queue on a found file or a kept copy,
// Play your copy), as vp.js's methods, over its real addSongWizard and
// saveLiveQueue.
function vpMethod(name) {
  const lines = VP.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`      ${name}: function (`));
  assert.ok(start >= 0, `vp.js no longer has the ${name} method — update this test`);
  const end = lines.indexOf('      },', start);
  return lines.slice(start, end + 1).join('\n');
}

const VP_ADDS = ['playDiscoverFile', 'queueDiscoverFile', 'dmKeepPlay', 'queueDiscoverTrack', 'queueAllDiscover', 'queueArtistEntryPoints'];

function makeVue({ live = 'Road Trip', queue = [track('Guard Up!')] } = {}) {
  const calls = { saved: [], addSong: [], toasts: [], closed: 0 };
  const player = {
    playlist: [],
    positionCache: { val: -1 },
    transcodeOptions: { serverEnabled: false, frontendEnabled: false },
    addSong: (song) => { player.playlist.push(song); if (player.positionCache.val < 0) { player.positionCache.val = 0; } },
    insertSongAt: (song, at) => { player.playlist.splice(at, 0, song); player.positionCache.val = at; },
    clearPlaylist: () => { player.playlist.length = 0; player.positionCache.val = -1; },
    getCurrentSong: () => null,
    resetCurrentMetadata: () => {},
  };
  const api = {
    currentServer: { host: 'http://host/', token: 'TOK' },
    savePlaylist: (title, songs, isLive) => { calls.saved.push({ title, songs, live: isLive }); return Promise.resolve({}); },
    addToPlaylist: (name, song) => { calls.addSong.push({ name, song }); return Promise.resolve({}); },
    lookupMetadata: (fp) => Promise.resolve({ filepath: fp, metadata: null }),
  };
  const iziToast = { success: (o) => calls.toasts.push(o.title), info: (o) => calls.toasts.push(o.title), warning: (o) => calls.toasts.push(o.title) };
  const S = new Function('MSTREAMPLAYER', 'MSTREAMAPI', 'iziToast', 't', 'DISCOVER', 'calls', `
    'use strict';
    const mstreamModule = { livePlaylist: { name: false }, altLayout: { waveformBar: false } };
    let warnedMixedQueue = false;
    ${vpInner('localQueueFilepaths')}
    ${vpInner('saveLiveQueue')}
    mstreamModule.saveLiveQueue = saveLiveQueue;
    ${vpInner('addSongWizard')}
    ${vpInner('clearQueue')}
    const vm = {
      tt: (k) => k,
      closeDiscoverModal() { calls.closed++; },
      discover: { tracks: DISCOVER },
      ${VP_ADDS.map(vpMethod).join('\n')}
    };
    return { mstreamModule, vm };
  `)(player, api, iziToast, (k) => k, DISCOVER, calls);
  for (const r of queue) { S.mstreamModule.addSongWizard(r.filepath, r.metadata, false, undefined, false, true); }
  S.mstreamModule.livePlaylist.name = live;
  return { vm: S.vm, calls, player, queuePaths: () => player.playlist.map((s) => s.filepath) };
}

const KEPT = ['copies/Boukmanflow/Borrowed Tapes/01.mp3', 'copies/Boukmanflow/Borrowed Tapes/02.mp3'];

describe('a live playlist and vp.js\'s own Discover adds', () => {
  test('the now-playing panel\'s Discover list: a row, + Queue all and an artist\'s ▶ each save the whole queue once; no add-song', () => {
    const app = makeVue();
    app.vm.queueDiscoverTrack(DISCOVER[0]);
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: [GUARD, DISCOVER[0].filepath], live: true }]);
    app.vm.queueAllDiscover();
    assert.equal(app.calls.saved.length, 2, '+ Queue all: one save for all its rows');
    assert.deepEqual(app.calls.saved[1].songs, [GUARD, DISCOVER[0].filepath, ...paths(DISCOVER)]);
    app.vm.queueArtistEntryPoints({ artist: 'ALM', entryPoints: PATH_ROWS });
    assert.equal(app.calls.saved.length, 3, 'an artist\'s ▶: one save');
    assert.deepEqual(app.calls.saved[2].songs, app.queuePaths());
    assert.deepEqual(app.queuePaths(), [GUARD, DISCOVER[0].filepath, ...paths(DISCOVER), ...paths(PATH_ROWS)]);
    assert.deepEqual(app.calls.addSong, [], 'the adds stay off the live playlist: one save, never a second copy');
  });

  test('the recommendation window: Queue on a found file or a kept copy saves the whole queue once, and Play your copy (a song) once, by its insert', () => {
    const app = makeVue();
    app.vm.queueDiscoverFile(KEPT[0]);
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: [GUARD, KEPT[0]], live: true }]);
    assert.deepEqual(app.calls.toasts, ['discover.modal.queued']);
    app.vm.dmKeepPlay({ scope: 'song', files: [KEPT[1]] });
    assert.deepEqual(app.queuePaths(), [GUARD, KEPT[1], KEPT[0]], 'the song next, now');
    assert.deepEqual(app.calls.saved.map((c) => c.songs), [[GUARD, KEPT[0]], [GUARD, KEPT[1], KEPT[0]]]);
    assert.deepEqual([app.calls.addSong, app.calls.closed], [[], 1]);
  });

  test('Keep a copy, Play an album: the live playlist gets the new queue in one save, never an empty one first', () => {
    const app = makeVue();
    app.vm.dmKeepPlay({ scope: 'album', files: KEPT });
    assert.deepEqual(app.queuePaths(), KEPT, 'the album in the queue\'s place');
    assert.deepEqual(app.calls.saved, [{ title: 'Road Trip', songs: KEPT, live: true }]);
    assert.deepEqual([app.calls.addSong, app.calls.closed], [[], 1]);
  });

  test('with no live playlist on, the same adds save nothing', () => {
    const app = makeVue({ live: false });
    app.vm.queueDiscoverTrack(DISCOVER[1]);
    app.vm.queueAllDiscover();
    app.vm.queueArtistEntryPoints({ artist: 'ALM', entryPoints: PATH_ROWS });
    app.vm.queueDiscoverFile(KEPT[0]);
    app.vm.dmKeepPlay({ scope: 'album', files: KEPT });
    assert.deepEqual([app.calls.saved, app.calls.addSong], [[], []]);
    assert.deepEqual(app.queuePaths(), KEPT);
  });
});
