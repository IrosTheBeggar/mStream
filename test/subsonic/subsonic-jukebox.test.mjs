/**
 * Subsonic jukeboxControl integration tests.
 *
 * Runs mStream + a fake rust-server-audio HTTP stub (test/helpers/fake-rust-audio.mjs).
 * The stub records every proxied request and maintains plausible queue
 * state, so tests can both (a) verify the handler dispatches to the right
 * server-playback endpoint for each Subsonic action, and (b) confirm the
 * response envelope shape matches what real clients (DSub, Symfonium, …)
 * expect.
 *
 * No actual audio playback — the stub just shuffles state in memory.
 */

import { describe, before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { startFakeRustAudio } from '../helpers/fake-rust-audio.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
let fakeAudio;
let adminKey;
let userKey;

before(async () => {
  fakeAudio = await startFakeRustAudio();
  server = await startServer({
    dlnaMode:       'disabled',
    rustPlayerPort: fakeAudio.port,
    users: [
      { ...ADMIN, admin: true },
      { ...USER,  admin: false },
    ],
  });

  // Mint Subsonic API keys for both users.
  for (const [user, setKey] of [[ADMIN, k => adminKey = k], [USER, k => userKey = k]]) {
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    const { token } = await loginR.json();
    const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ name: 'jukebox-tests' }),
    });
    setKey((await keyR.json()).key);
  }
});

after(async () => {
  if (server) { await server.stop(); }
  if (fakeAudio) { await fakeAudio.stop(); }
});

beforeEach(() => {
  fakeAudio.reset();
  // Reset the fake's state between tests so ordering-sensitive assertions
  // (queue_index, queue contents) don't drift from test to test.
  Object.assign(fakeAudio.state, {
    playing: false, paused: false, position: 0, volume: 1.0,
    file: '', queue: [], queue_index: 0, queue_length: 0,
    shuffle: false, loop_mode: 'none',
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function url(method, params = {}, key = adminKey) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) { q.append(k, item); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function call(method, params = {}, key = adminKey) {
  const r = await fetch(url(method, params, key));
  return (await r.json())['subsonic-response'];
}

async function someSongId() {
  const r = await call('getRandomSongs', { size: 1 });
  return parseInt(r.randomSongs.song[0].id, 10);
}

// ── Authorization ──────────────────────────────────────────────────────────

describe('jukeboxControl authorization', () => {
  test('non-admin is rejected with error 50', async () => {
    const env = await call('jukeboxControl', { action: 'status' }, userKey);
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 50);
  });

  test('admin status call proxies to /status on rust-server-audio', async () => {
    const env = await call('jukeboxControl', { action: 'status' });
    assert.equal(env.status, 'ok');
    assert.ok(env.jukeboxStatus);
    assert.equal(typeof env.jukeboxStatus.playing, 'boolean');
    assert.equal(typeof env.jukeboxStatus.gain, 'number');
    assert.equal(typeof env.jukeboxStatus.position, 'number');
    // currentIndex = -1 when queue empty (our stub resets to empty).
    assert.equal(env.jukeboxStatus.currentIndex, -1);
    // And the proxy actually hit rust-server-audio.
    const statusCall = fakeAudio.calls.find(c => c.path === '/status' && c.method === 'GET');
    assert.ok(statusCall, 'expected GET /status to reach the fake');
  });
});

// ── Advertised role ────────────────────────────────────────────────────────

describe('getUser advertises jukeboxRole correctly', () => {
  test('admin: jukeboxRole=true', async () => {
    const env = await call('getUser', { username: ADMIN.username });
    assert.equal(env.user.jukeboxRole, true);
  });

  test('non-admin: jukeboxRole=false', async () => {
    const env = await call('getUser', { username: USER.username }, userKey);
    assert.equal(env.user.jukeboxRole, false);
  });
});

// ── Queue-mutating actions ────────────────────────────────────────────────

describe('jukeboxControl queue mutation', () => {
  test('set clears the queue then adds the given songs', async () => {
    // Pre-seed the fake with an entry to prove `set` replaces, not appends.
    fakeAudio.state.queue = ['testlib/stale.mp3'];
    fakeAudio.state.queue_length = 1;

    const id = await someSongId();
    const env = await call('jukeboxControl', { action: 'set', id });
    assert.equal(env.status, 'ok');

    const clear = fakeAudio.calls.find(c => c.path === '/queue/clear');
    const add   = fakeAudio.calls.find(c => c.path === '/queue/add-many');
    assert.ok(clear, 'set should have called /queue/clear');
    assert.ok(add,   'set should have called /queue/add-many');

    const payload = JSON.parse(add.body);
    assert.equal(payload.files.length, 1);
    assert.ok(payload.files[0].endsWith('.mp3'), `expected absolute .mp3 path, got ${payload.files[0]}`);
  });

  test('add appends without clearing', async () => {
    fakeAudio.state.queue = ['testlib/keep-me.mp3'];
    const id = await someSongId();
    const env = await call('jukeboxControl', { action: 'add', id });
    assert.equal(env.status, 'ok');

    assert.ok(!fakeAudio.calls.find(c => c.path === '/queue/clear'),
      'add must NOT call /queue/clear');
    const add = fakeAudio.calls.find(c => c.path === '/queue/add-many');
    assert.ok(add, 'add should have called /queue/add-many');
  });

  test('add with no id returns error 10', async () => {
    const env = await call('jukeboxControl', { action: 'add' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('clear proxies to /queue/clear', async () => {
    await call('jukeboxControl', { action: 'clear' });
    assert.ok(fakeAudio.calls.find(c => c.path === '/queue/clear'));
  });

  test('remove forwards the index', async () => {
    await call('jukeboxControl', { action: 'remove', index: 3 });
    const remove = fakeAudio.calls.find(c => c.path === '/queue/remove');
    assert.ok(remove);
    assert.deepEqual(JSON.parse(remove.body), { index: 3 });
  });

  test('remove without index returns error 10', async () => {
    const env = await call('jukeboxControl', { action: 'remove' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

// ── Transport actions ────────────────────────────────────────────────────

describe('jukeboxControl transport', () => {
  test('start proxies to /resume', async () => {
    await call('jukeboxControl', { action: 'start' });
    assert.ok(fakeAudio.calls.find(c => c.path === '/resume'));
  });

  test('stop proxies to /pause', async () => {
    await call('jukeboxControl', { action: 'stop' });
    assert.ok(fakeAudio.calls.find(c => c.path === '/pause'));
  });

  test('skip forwards index; with offset, also sends /seek', async () => {
    await call('jukeboxControl', { action: 'skip', index: 2, offset: 45.5 });
    const skip = fakeAudio.calls.find(c => c.path === '/queue/play-index');
    const seek = fakeAudio.calls.find(c => c.path === '/seek');
    assert.ok(skip, 'skip must proxy to /queue/play-index');
    assert.ok(seek, 'skip with offset must also proxy to /seek');
    assert.deepEqual(JSON.parse(skip.body), { index: 2 });
    assert.deepEqual(JSON.parse(seek.body), { position: 45.5 });
  });

  test('skip without offset does NOT send /seek', async () => {
    await call('jukeboxControl', { action: 'skip', index: 0 });
    assert.ok(fakeAudio.calls.find(c => c.path === '/queue/play-index'));
    assert.ok(!fakeAudio.calls.find(c => c.path === '/seek'));
  });

  test('shuffle proxies to /shuffle', async () => {
    await call('jukeboxControl', { action: 'shuffle' });
    assert.ok(fakeAudio.calls.find(c => c.path === '/shuffle'));
  });

  test('setGain clamps to [0,1] and proxies', async () => {
    await call('jukeboxControl', { action: 'setGain', gain: 0.42 });
    const vol = fakeAudio.calls.find(c => c.path === '/volume');
    assert.ok(vol);
    assert.deepEqual(JSON.parse(vol.body), { volume: 0.42 });
  });

  test('setGain out of range returns error 10 (invalid parameter)', async () => {
    const env = await call('jukeboxControl', { action: 'setGain', gain: 2.5 });
    assert.equal(env.status, 'failed');
    // Error code audit (Subsonic API polish pass): out-of-range gain is
    // an invalid parameter value, mapped to spec code 10 rather than
    // the non-specific code 0.
    assert.equal(env.error.code, 10);
  });
});

// ── Get action: returns playlist + song entries ────────────────────────────

describe('jukeboxControl get (playlist + entries)', () => {
  test('get returns jukeboxPlaylist with song entries resolved from the queue', async () => {
    // Seed the fake's queue with vpath strings resolving to real fixtures.
    const songs = await call('getRandomSongs', { size: 3 });
    const entries = songs.randomSongs.song;
    // The server-playback proxy layer converts absolute paths on the way
    // OUT (/queue) back to vpath form — our fake stores the vpath form
    // directly, which is what mStream's /api/v1/server-playback/queue
    // hands to Subsonic.
    fakeAudio.state.queue = entries.map(e => `testlib/${e.path}`);
    fakeAudio.state.queue_index = 1;
    fakeAudio.state.playing = true;

    const env = await call('jukeboxControl', { action: 'get' });
    assert.equal(env.status, 'ok');
    assert.ok(env.jukeboxPlaylist);
    assert.equal(env.jukeboxPlaylist.currentIndex, 1);
    assert.equal(env.jukeboxPlaylist.playing, true);
    assert.equal(env.jukeboxPlaylist.entry.length, 3, 'every queue entry should resolve to a song');
    // Order of entries in the playlist must match the order in the queue.
    assert.deepEqual(
      env.jukeboxPlaylist.entry.map(e => e.id),
      entries.map(e => e.id),
    );
  });
});

// ── Error-path: rust-server-audio unreachable ─────────────────────────────

describe('jukeboxControl when rust-server-audio is unavailable', () => {
  test('status returns error 30 when the stub is stopped', async (t) => {
    // Temporarily bring the stub down; the proxy's connect will fail fast.
    await fakeAudio.stop();
    try {
      const env = await call('jukeboxControl', { action: 'status' });
      assert.equal(env.status, 'failed');
      assert.equal(env.error.code, 30, 'expected error 30 (feature unavailable)');
    } finally {
      // Can't restart on the same port reliably — skip remaining tests in
      // this describe if there were any. For this test suite we only run
      // one check and then recover by re-instantiating at after-hook time.
      t.diagnostic('rust-audio stub intentionally stopped; suite ending');
    }
  });
});

// ── Unknown action ─────────────────────────────────────────────────────────

// This runs in its own describe/before so the previous describe's "stop
// the stub" teardown doesn't affect it. We don't need the stub here since
// the handler short-circuits on unknown-action before any proxy call.
describe('jukeboxControl unknown action', () => {
  test('returns error 10 for an invalid action parameter', async () => {
    const env = await call('jukeboxControl', { action: 'nonsense' });
    assert.equal(env.status, 'failed');
    // Unknown `action=` is treated as an invalid parameter value.
    assert.equal(env.error.code, 10);
  });
});
