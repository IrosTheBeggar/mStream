/**
 * webapp/assets/js/mstream.server-audio.js — the /server-remote player, and
 * specifically what it does on page load: it must ADOPT the engine's state
 * (queue, position, volume), never impose the page's own.
 *
 * The engine outlives the page: reload /server-remote and the music keeps
 * playing, so the client asks the engine what it holds and rebuilds "Now
 * Playing" from the answer. That restore used to wait for
 * `MSTREAMAPI.currentServer.token` to become truthy first, retrying every
 * 500 ms with no limit. On a server with NO users there is no token, ever —
 * so the wait never ended and the list stayed empty while the engine played
 * on (found by the 2026-09-20 smoke round, in a real browser against a real
 * engine). The gate bought nothing: the page is only served to a session the
 * server already accepted, and the webapp's deferred scripts put the token in
 * place before DOMContentLoaded.
 *
 * webapp/ has no browser test harness, so this runs the REAL client file in a
 * vm context against stub globals — a fake fetch standing in for the server,
 * hand-cranked timers, and the two lines of MSTREAMAPI the client reads.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(__dirname, '..', '..', 'webapp', 'assets', 'js', 'mstream.server-audio.js');
const SRC = fs.readFileSync(CLIENT_PATH, 'utf8');

const QUEUE = '/api/v1/server-playback/queue';
const VOLUME = '/api/v1/server-playback/volume';
const A = 'lib/Album/01 - One.mp3';
const B = 'lib/Album/02 - Two.mp3';
const X = 'lib/Other/09 - Queued From The Page.mp3';

const ok = (body) => ({ ok: true, status: 200, body, json: () => Promise.resolve(body) });
const fail = (status) => ({ ok: false, status, json: () => Promise.resolve({ error: 'Server audio player is not running' }) });

// Let every settled promise chain run (fetch → json → restore → lookups).
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setImmediate(r)); } };

/**
 * Boot the client the way /server-remote does: `serverAudioMode` set first,
 * the script run while the document is still loading, DOMContentLoaded fired
 * by the test. `queueReplies` is consumed one reply per GET /queue; the last
 * one repeats. `engineUp: false` makes every /status a 503.
 */
function bootClient({ token = '', cookie = '', queueReplies = [ok({ queue: [], current_index: null })], engineUp = true }) {
  const calls = [];       // every fetch: { path, method, token, body }
  const timers = [];      // pending setTimeout callbacks: { fn, ms }
  const warnings = [];
  let domReady = null;
  let queueCalls = 0;
  let engineIndex = null;  // what /status reports: the index of the last queue reply served

  const sandbox = {
    serverAudioMode: true,
    console: { log() {}, warn: (m) => warnings.push(String(m)), error() {} },
    setInterval: () => 1,                                   // the 2 Hz status poll: not under test
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: {
      readyState: 'loading',
      cookie,
      head: { appendChild() {} },
      createElement: () => ({ textContent: '' }),
      addEventListener: (name, fn) => { if (name === 'DOMContentLoaded') { domReady = fn; } },
    },
    MSTREAMAPI: {
      currentServer: { token },
      lookupMetadata: (filepath) => Promise.resolve({ metadata: { title: `title of ${filepath}` } }),
    },
    fetch: (url, opts = {}) => {
      calls.push({ path: url, method: opts.method || 'GET', token: opts.headers && opts.headers['x-access-token'], body: opts.body });
      if (url === QUEUE) {
        const reply = queueReplies[Math.min(queueCalls, queueReplies.length - 1)];
        queueCalls += 1;
        if (reply.ok) { engineIndex = reply.body.current_index; }
        return Promise.resolve(reply);
      }
      if (!engineUp) { return Promise.resolve(fail(503)); }
      return Promise.resolve(ok({ playing: true, position: 12, duration: 90, volume: 0.5, queue_index: engineIndex }));
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: CLIENT_PATH });
  assert.equal(typeof domReady, 'function', 'the client no longer starts on DOMContentLoaded — update this test');

  return {
    player: sandbox.MSTREAMPLAYER,
    calls,
    timers,
    warnings,
    queueRequests: () => calls.filter((c) => c.path === QUEUE),
    volumePosts: () => calls.filter((c) => c.path === VOLUME).map((c) => JSON.parse(c.body)),
    ready: async () => { domReady(); await settle(); },
    // Fire every timer that is pending right now (not the ones they schedule).
    flushTimers: async () => { for (const t of timers.splice(0)) { t.fn(); } await settle(); },
  };
}

// Array.from, not .map(): arrays born inside the vm context carry that realm's
// Array.prototype, which deepStrictEqual (rightly) tells apart from ours.
const paths = (player) => Array.from(player.playlist, (s) => s.rawFilePath);
const titles = (player) => Array.from(player.playlist, (s) => s.metadata.title);

describe('server-audio client: restoring the queue on page load', () => {
  test('a server with NO users: the queue comes back with no token anywhere, and without waiting', async () => {
    const c = bootClient({ token: '', cookie: '', queueReplies: [ok({ queue: [A, B], current_index: 1 })] });
    await c.ready();

    assert.deepEqual(paths(c.player), [A, B]);
    assert.equal(c.player.positionCache.val, 1, 'the highlighted row is the one the engine is on');
    assert.deepEqual(titles(c.player), [`title of ${A}`, `title of ${B}`], 'titles come from the metadata lookups');
    assert.equal(c.queueRequests().length, 1);
    assert.equal(c.queueRequests()[0].token, '', 'a public server gets an empty token header, not a wait for one');
    assert.deepEqual(c.timers, [], 'nothing is left polling for a token');
    assert.deepEqual(c.warnings, []);
  });

  test('a server with users: the webapp\'s API token rides along', async () => {
    const c = bootClient({ token: 'api-token', queueReplies: [ok({ queue: [A], current_index: 0 })] });
    await c.ready();

    assert.deepEqual(paths(c.player), [A]);
    assert.equal(c.queueRequests()[0].token, 'api-token');
    assert.equal(c.player.playlist[0].authToken, 'api-token');
  });

  test('no API token in the page, only the login cookie: the cookie is used', async () => {
    const c = bootClient({ token: '', cookie: 'lang=en; x-access-token=cookie-token', queueReplies: [ok({ queue: [A], current_index: 0 })] });
    await c.ready();

    assert.deepEqual(paths(c.player), [A]);
    assert.equal(c.queueRequests()[0].token, 'cookie-token');
  });

  test('an empty engine queue leaves the list alone and schedules nothing', async () => {
    const c = bootClient({ queueReplies: [ok({ queue: [], current_index: null })] });
    await c.ready();

    assert.deepEqual(paths(c.player), []);
    assert.equal(c.player.positionCache.val, -1);
    assert.deepEqual(c.timers, []);
  });

  test('a load that fails is retried, and the retry restores the queue', async () => {
    const c = bootClient({ queueReplies: [fail(503), ok({ queue: [A, B], current_index: 0 })] });
    await c.ready();

    assert.deepEqual(paths(c.player), [], 'a 503 is not "the queue is empty"');
    assert.equal(c.timers.length, 1, 'one retry is pending');
    assert.equal(c.timers[0].ms, 1000);

    await c.flushTimers();
    assert.deepEqual(paths(c.player), [A, B]);
    assert.equal(c.queueRequests().length, 2);
    assert.deepEqual(c.timers, []);
    assert.deepEqual(c.warnings, []);
  });

  test('it gives up after five attempts and says so once', async () => {
    const c = bootClient({ queueReplies: [fail(503)] });
    await c.ready();
    for (let i = 0; i < 10 && c.timers.length > 0; i++) { await c.flushTimers(); }

    assert.equal(c.queueRequests().length, 5);
    assert.deepEqual(c.timers, [], 'no retry loop survives the last attempt');
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /Could not load the server audio queue: HTTP 503/);
    assert.deepEqual(paths(c.player), []);
  });

  test('a retry that lands after a song was queued from the page rebuilds the list — no duplicates, same array', async () => {
    // The engine already holds A. The first load fails; the listener queues X
    // from the file explorer; the retry then reports the engine's truth: A, X.
    const c = bootClient({ queueReplies: [fail(503), ok({ queue: [A, X], current_index: 0 })] });
    await c.ready();
    const list = c.player.playlist;

    assert.equal(c.player.addSong({ rawFilePath: X, filepath: X, metadata: { title: 'from the page' } }), true);
    await settle();
    assert.deepEqual(paths(c.player), [X]);
    assert.deepEqual(JSON.parse(c.calls.find((call) => call.path === `${QUEUE}/add`).body), { file: X });

    await c.flushTimers();
    assert.deepEqual(paths(c.player), [A, X], 'appending would have shown X twice');
    assert.equal(c.player.playlist, list, 'the list is rebuilt in place: Vue watches this array');
    assert.equal(c.player.positionCache.val, 0);
  });
});

// The webapp restores "my last volume" from localStorage while it boots
// (vp.js created() → MSTREAMPLAYER.changeVolume), before DOMContentLoaded.
// That is right for a browser player. Here the volume is the ROOM's: the
// restore made merely opening the remote on another device yank the engine
// to whatever that device last used (seen in the same smoke round: an engine
// set to 0 jumped to 0.5 on page load).
describe('server-audio client: the volume belongs to the engine', () => {
  test('booting the page does not push this browser\'s saved volume onto the engine', async () => {
    const c = bootClient({});
    c.player.changeVolume(80);                    // vp.js created(), before the page is ready
    await c.ready();

    assert.deepEqual(c.volumePosts(), [], 'the engine was told to change volume by a page load');
    assert.equal(c.player.playerStats.volume, 50, 'the slider shows the ENGINE\'s volume');
  });

  test('once the engine\'s volume is known, the slider drives it', async () => {
    const c = bootClient({});
    await c.ready();
    c.player.changeVolume(30);
    await settle();

    assert.deepEqual(c.volumePosts(), [{ volume: 0.3 }]);
    assert.equal(c.player.playerStats.volume, 30);
  });

  test('the page asks for the engine\'s state as soon as it is ready, not at the first poll tick', async () => {
    const c = bootClient({});
    await c.ready();

    assert.ok(c.calls.some((call) => call.path === '/api/v1/server-playback/status'), 'no status request at DOMContentLoaded');
    assert.equal(c.player.playerStats.playing, true);
  });

  test('while the engine is unreachable, a volume change is not sent', async () => {
    const c = bootClient({ engineUp: false });
    await c.ready();
    c.player.changeVolume(30);
    await settle();

    assert.deepEqual(c.volumePosts(), []);
  });
});
