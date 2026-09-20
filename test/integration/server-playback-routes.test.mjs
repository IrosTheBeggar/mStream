/**
 * /api/v1/server-playback/* and /server-remote through a real server.
 *
 * No test host has an audio backend (the helper points the engine fetch at a
 * dead port, and CI runners carry no mpv/MPD/VLC/MPlayer), so this pins what
 * the route layer owes a caller when NOTHING is running — which is also the
 * state where the old handlers went wrong:
 *
 *   - the per-user gate: the flag or the admin role, on the API and the page
 *   - every proxied route answers a JSON 503 rather than hanging or 500ing
 *   - input is judged before the backend: a malformed body is a 400 and a
 *     library the caller lacks is a 404, even with no backend to reach. The
 *     old handlers decided 503-vs-400 by grepping the error text, which also
 *     flattened vpath's deliberate 404 to a 400.
 *   - /server-remote serves the unavailable page, with advice that is true
 *
 * The backend-up half (path translation, playback, the UI) is covered by the
 * unit tests with a fake proxy and by the real-engine smoke; it cannot run
 * here. If a developer's machine happens to have a CLI player installed, the
 * assertions that need "no backend" skip themselves.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

let srv;
const tokens = {};

async function call(method, pathname, { token, body } = {}) {
  const headers = {};
  if (token) { headers['x-access-token'] = token; }
  if (body !== undefined) { headers['content-type'] = 'application/json'; }
  const r = await fetch(`${srv.baseUrl}${pathname}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
}

async function login(username) {
  const r = await call('POST', '/api/v1/auth/login', { body: { username, password: 'pw' } });
  assert.equal(r.status, 200, `login for ${username}`);
  return r.json.token;
}

// Every proxied route, with a body that gets past input validation.
const FILE = 'testlib/any/track.mp3';   // only the LIBRARY has to exist for the path to resolve
const ROUTES = [
  ['POST', '/pause'], ['POST', '/resume'], ['POST', '/stop'], ['POST', '/next'], ['POST', '/previous'], ['POST', '/loop'],
  ['POST', '/seek', { position: 10 }], ['POST', '/volume', { volume: 0.5 }], ['POST', '/shuffle', { value: true }],
  ['GET', '/status'], ['GET', '/queue'],
  ['POST', '/play', { file: FILE }], ['POST', '/queue/add', { file: FILE }], ['POST', '/queue/add-many', { files: [FILE, FILE] }],
  ['POST', '/queue/play-index', { index: 0 }], ['POST', '/queue/remove', { index: 0 }], ['POST', '/queue/clear'],
];

describe('server-playback routes', () => {
  let noBackend = false;

  before(async () => {
    srv = await startServer({
      waitForScan: false,
      users: [
        { username: 'boss', password: 'pw', admin: true },
        { username: 'pleb', password: 'pw', admin: false },
      ],
    });
    tokens.boss = await login('boss');
    tokens.pleb = await login('pleb');

    // A non-admin WITH the flag. The helper's user shape has no slot for it.
    const made = await call('PUT', '/api/v1/admin/users', {
      token: tokens.boss,
      body: { username: 'dj', password: 'pw', vpaths: ['testlib'], admin: false, allowServerAudio: true },
    });
    assert.equal(made.status, 200, made.text);
    tokens.dj = await login('dj');

    const info = await call('GET', '/api/v1/admin/server-audio/info', { token: tokens.boss });
    noBackend = info.json.backend === null;
  });

  after(async () => { await srv?.stop(); });

  test('the gate: neither flag nor admin → 403, on the API and on the page', async () => {
    for (const [method, route, body] of ROUTES) {
      const r = await call(method, `/api/v1/server-playback${route}`, { token: tokens.pleb, body });
      assert.equal(r.status, 403, `${method} ${route} must be gated`);
      assert.deepEqual(r.json, { error: 'Server audio access disabled for this user' });
    }
    const page = await call('GET', '/server-remote', { token: tokens.pleb });
    assert.equal(page.status, 403);
  });

  test('the gate: the flag lets a non-admin through, and so does the admin role', async () => {
    for (const who of ['dj', 'boss']) {
      const api = await call('GET', '/api/v1/server-playback/status', { token: tokens[who] });
      assert.notEqual(api.status, 403, `${who} reaches the API`);
      const page = await call('GET', '/server-remote', { token: tokens[who] });
      assert.notEqual(page.status, 403, `${who} reaches the page`);
    }
  });

  test('no backend: every proxied route answers a JSON 503', async (t) => {
    if (!noBackend) { return t.skip('a CLI player is installed on this host, so a backend is up'); }
    for (const [method, route, body] of ROUTES) {
      const r = await call(method, `/api/v1/server-playback${route}`, { token: tokens.dj, body });
      assert.equal(r.status, 503, `${method} ${route}: ${r.text}`);
      assert.deepEqual(r.json, { error: 'Server audio player is not running' });
    }
  });

  test('no backend: /server-remote is the unavailable page, and its advice is true', async (t) => {
    if (!noBackend) { return t.skip('a CLI player is installed on this host, so a backend is up'); }
    const page = await call('GET', '/server-remote', { token: tokens.dj });
    assert.equal(page.status, 503);
    assert.match(page.text, /<h1>Server Audio Unavailable<\/h1>/);
    assert.match(page.text, /autoBootServerAudio/);
    assert.ok(!/start the mstream-player binary/i.test(page.text), 'a hand-started engine is never reachable');
  });

  test('input is judged before the backend: a malformed body is a 400', async () => {
    const cases = [
      ['/play', {}],
      ['/play', { file: 5 }],
      ['/play', { file: '' }],
      ['/queue/add', {}],
      ['/queue/add-many', {}],
      ['/queue/add-many', { files: 'testlib/a.mp3' }],
      ['/queue/add-many', { files: [FILE, 7] }],
    ];
    for (const [route, body] of cases) {
      const r = await call('POST', `/api/v1/server-playback${route}`, { token: tokens.dj, body });
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} → ${r.status} ${r.text}`);
      assert.equal(typeof r.json.error, 'string');
    }
  });

  test('input is judged before the backend: a library the caller lacks is vpath’s 404', async () => {
    for (const [route, body] of [
      ['/play', { file: 'nolib/track.mp3' }],
      ['/queue/add', { file: 'nolib/track.mp3' }],
      ['/queue/add-many', { files: [FILE, 'nolib/track.mp3'] }],
    ]) {
      const r = await call('POST', `/api/v1/server-playback${route}`, { token: tokens.dj, body });
      assert.equal(r.status, 404, `${route} → ${r.status} ${r.text}`);
      assert.deepEqual(r.json, { error: 'User does not have access to path nolib' });
    }
  });
});
