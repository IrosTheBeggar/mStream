/**
 * The live playlist in the webapp (m.js): the Live Playlist window's
 * Enable / Disable (setLivePlaylist) and the page's start-up, which turns
 * it on again from localStorage's 'live-playlist-auto-start' (init).
 *
 * What is pinned:
 *   - Enable with "Start Live Playlist Automatically" ticked keeps the
 *     playlist's name for the next load, which turns it on again with the
 *     playlist's rows; unticked, it keeps nothing;
 *   - Disable forgets it: the next load starts with no live playlist.
 *
 * Same technique as webapp-add-all.test.mjs: the real code is sliced out of
 * m.js and run against stub globals.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'webapp', 'alpha', 'm.js'), 'utf8').replace(/\r\n/g, '\n');

function sliceFn(name) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `m.js no longer defines ${name}() — update this test`);
  const end = lines.indexOf('}', start);
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
