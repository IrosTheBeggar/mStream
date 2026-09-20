/**
 * The route layer of server-side playback (src/api/server-playback.js):
 * proxyRoute — the one handler behind all seventeen proxied routes — and the
 * two response mappers.
 *
 * What these pin:
 *   - "no backend answered" is recognised by TYPE (a 503 WebError), never by
 *     message text. The old handlers grepped for "not running", so an engine
 *     timeout on /play came back as a 400.
 *   - a 503 is answered quietly by the handler; anything else a proxy throws
 *     propagates to the terminal error handler instead of being flattened to
 *     a 503 that hides a real bug
 *   - input is judged BEFORE the backend is touched: a bad body or a library
 *     the caller lacks is their error whether or not anything is running
 *   - the backend's own status and body pass through (a 409 is its answer),
 *     and the response mapper only runs on a success
 *   - no absolute filesystem path reaches a client: /status's `file` is
 *     translated like /queue always was
 *
 * No server, no database, no backend: the proxy is a fake and `toVpath` is
 * injected.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proxyRoute, statusForClient, queueForClient, UNAVAILABLE_PAGE } from '../../src/api/server-playback.js';
import WebError from '../../src/util/web-error.js';

// Just enough of an Express response to record what a handler answered.
function fakeRes() {
  return {
    statusCode: null,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

// A recording proxy that answers with `answer`, or rejects with it if it is
// an Error.
function fakeProxy(answer = { status: 200, data: { ok: true } }) {
  const calls = [];
  const proxy = (method, rustPath, body) => {
    calls.push({ method, rustPath, body });
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { proxy, calls };
}

const toVpath = (abs) => `lib/${abs.split(/[\\/]/).pop()}`;

describe('proxyRoute', () => {
  test('a POST forwards the request body; a missing body becomes {}', async () => {
    const { proxy, calls } = fakeProxy();
    const handler = proxyRoute(proxy, 'POST', '/seek');

    await handler({ body: { position: 12 } }, fakeRes());
    await handler({}, fakeRes());

    assert.deepEqual(calls, [
      { method: 'POST', rustPath: '/seek', body: { position: 12 } },
      { method: 'POST', rustPath: '/seek', body: {} },
    ]);
  });

  test('a GET sends no body', async () => {
    const { proxy, calls } = fakeProxy();
    await proxyRoute(proxy, 'GET', '/status')({ body: { ignored: true } }, fakeRes());
    assert.deepEqual(calls, [{ method: 'GET', rustPath: '/status', body: undefined }]);
  });

  test('mapBody decides what the backend gets', async () => {
    const { proxy, calls } = fakeProxy();
    const handler = proxyRoute(proxy, 'POST', '/play', { mapBody: (req) => ({ file: `/abs/${req.body.file}` }) });
    const res = fakeRes();

    await handler({ body: { file: 'a.mp3' } }, res);

    assert.deepEqual(calls[0].body, { file: '/abs/a.mp3' });
    assert.equal(res.statusCode, 200);
  });

  test('input is judged before the backend: a mapBody throw propagates and nothing is proxied', async () => {
    const { proxy, calls } = fakeProxy(new WebError('Server audio player is not running', 503));
    const rejected = new WebError("User does not have access to path nolib", 404);
    const handler = proxyRoute(proxy, 'POST', '/play', { mapBody: () => { throw rejected; } });
    const res = fakeRes();

    await assert.rejects(() => handler({ body: {} }, res), (err) => err === rejected, 'the terminal handler gets the original error');
    assert.equal(calls.length, 0, 'a request that was never valid must not reach the backend');
    assert.equal(res.statusCode, null, 'and the handler answered nothing itself');
  });

  test('the backend’s status and body pass through, and a failure is not mapped', async () => {
    const { proxy } = fakeProxy({ status: 409, data: { error: 'Already at end of queue' } });
    let mapped = 0;
    const res = fakeRes();

    await proxyRoute(proxy, 'POST', '/next', { mapResult: (d) => { mapped += 1; return d; } })({}, res);

    assert.equal(res.statusCode, 409, 'a queue-state conflict is the backend’s answer, not a proxy failure');
    assert.deepEqual(res.body, { error: 'Already at end of queue' });
    assert.equal(mapped, 0, 'an error body has no paths to translate');
  });

  test('mapResult shapes a success', async () => {
    const { proxy } = fakeProxy({ status: 200, data: { queue: ['/abs/a.mp3'] } });
    const res = fakeRes();

    await proxyRoute(proxy, 'GET', '/queue', { mapResult: (d) => queueForClient(d, toVpath) })({}, res);

    assert.deepEqual(res.body, { queue: ['lib/a.mp3'] });
  });

  test('"no backend answered" is a quiet 503 — by type, whatever the message says', async () => {
    for (const message of ['Server audio player is not running', 'Server audio player timed out', 'CLI audio player is not running']) {
      const { proxy } = fakeProxy(new WebError(message, 503));
      const res = fakeRes();

      await proxyRoute(proxy, 'POST', '/play', { mapBody: () => ({ file: '/abs/a.mp3' }) })({ body: {} }, res);

      assert.equal(res.statusCode, 503, `"${message}" must be a 503 — a timeout used to come back as a 400`);
      assert.deepEqual(res.body, { error: message });
    }
  });

  test('any other proxy failure propagates instead of hiding as a 503', async () => {
    const boom = new TypeError('cannot read properties of undefined');
    const { proxy } = fakeProxy(boom);
    const res = fakeRes();

    await assert.rejects(() => proxyRoute(proxy, 'GET', '/status')({}, res), (err) => err === boom);
    assert.equal(res.statusCode, null, 'a bug is the terminal handler’s to report, with its stack');
  });

  test('a message that merely SAYS "not running" is not the unavailable state', async () => {
    const lookalike = new Error('worker is not running');
    const { proxy } = fakeProxy(lookalike);
    await assert.rejects(() => proxyRoute(proxy, 'GET', '/status')({}, fakeRes()), (err) => err === lookalike);
  });
});

describe('statusForClient', () => {
  const active = { backend: 'rust', player: 'mstream-player' };

  test('translates the current track and names the backend', () => {
    const out = statusForClient({ playing: true, file: 'C:\\Music\\Artist\\song.mp3', queue_index: 2 }, active, toVpath);
    assert.deepEqual(out, { playing: true, file: 'lib/song.mp3', queue_index: 2, backend: 'rust', player: 'mstream-player' });
  });

  test('no absolute path survives, on either platform’s shape', () => {
    for (const abs of ['C:\\Users\\paul\\Music\\a.mp3', '/srv/music/a.mp3']) {
      const out = statusForClient({ file: abs }, active, toVpath);
      assert.equal(out.file, 'lib/a.mp3');
      assert.ok(!/^[A-Za-z]:|^\/|\\/.test(out.file), `leaked: ${out.file}`);
    }
  });

  test('an idle backend’s empty file stays empty', () => {
    assert.equal(statusForClient({ playing: false, file: '' }, active, toVpath).file, '');
  });

  test('does not mutate what the backend returned', () => {
    const data = { file: '/srv/music/a.mp3' };
    statusForClient(data, active, toVpath);
    assert.deepEqual(data, { file: '/srv/music/a.mp3' });
  });

  test('anything that is not a status object passes through untouched', () => {
    assert.equal(statusForClient(null, active, toVpath), null);
    assert.deepEqual(statusForClient([1, 2], active, toVpath), [1, 2]);
    assert.equal(statusForClient('raw', active, toVpath), 'raw');
  });
});

describe('queueForClient', () => {
  test('translates every entry and keeps the rest of the body', () => {
    const out = queueForClient({ queue: ['/srv/music/a.mp3', '/srv/music/b.mp3'], current_index: 1 }, toVpath);
    assert.deepEqual(out, { queue: ['lib/a.mp3', 'lib/b.mp3'], current_index: 1 });
  });

  test('a body with no queue array passes through untouched', () => {
    assert.deepEqual(queueForClient({ raw: 'not json' }, toVpath), { raw: 'not json' });
    assert.deepEqual(queueForClient({ queue: 'nope' }, toVpath), { queue: 'nope' });
    assert.equal(queueForClient(null, toVpath), null);
  });
});

describe('the unavailable page', () => {
  test('only gives advice the lifecycle can honour', () => {
    // The proxy only talks to an engine the server spawned itself, so a
    // hand-started binary is never reachable — the old copy said otherwise.
    assert.ok(!/start the mstream-player binary/i.test(UNAVAILABLE_PAGE));
    assert.match(UNAVAILABLE_PAGE, /autoBootServerAudio/);
    assert.match(UNAVAILABLE_PAGE, /mpv, MPD, VLC or MPlayer/);
    assert.match(UNAVAILABLE_PAGE, /href="\/server-remote">Retry</);
  });
});
