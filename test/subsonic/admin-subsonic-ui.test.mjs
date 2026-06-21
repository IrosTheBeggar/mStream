/**
 * Integration tests for the admin-panel Subsonic data endpoints.
 *
 * These back the admin UI widgets added alongside this file (see
 * webapp/admin/index.js `subsonicView`). Each endpoint gets a happy-path
 * shape check plus an admin-only guard check where applicable.
 *
 *   GET    /api/v1/admin/subsonic/stats                  methods + now-playing
 *   GET    /api/v1/admin/subsonic/test                   ping-myself probe
 *   GET    /api/v1/admin/subsonic/jukebox                rust-server-audio status
 *   GET    /api/v1/admin/subsonic/token-auth-attempts    token-auth warning log
 *   DELETE /api/v1/admin/subsonic/token-auth-attempts    clear the log
 *   POST   /api/v1/admin/subsonic/mint-key               mint a key for another user
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { startFakeRustAudio } from '../helpers/fake-rust-audio.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
let fakeAudio;
let adminJwt;
let userJwt;

before(async () => {
  fakeAudio = await startFakeRustAudio();
  server = await startServer({
    dlnaMode: 'disabled',
    rustPlayerPort: fakeAudio.port,
    users: [
      { ...ADMIN, admin: true },
      { ...USER,  admin: false },
    ],
  });
  for (const [u, setJwt] of [[ADMIN, v => adminJwt = v], [USER, v => userJwt = v]]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    setJwt((await r.json()).token);
  }
});

after(async () => {
  if (server) { await server.stop(); }
  if (fakeAudio) { await fakeAudio.stop(); }
});

function adminGet(path, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, { headers: { 'x-access-token': jwt } });
}
function adminPost(path, body, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}
function adminDelete(path, jwt = adminJwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'DELETE', headers: { 'x-access-token': jwt },
  });
}

// ── /stats ────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/subsonic/stats', () => {
  test('returns methods list + empty nowPlaying on a quiet server', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/stats');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.methodsImplemented > 40,
      `expected >40 Subsonic methods implemented, got ${body.methodsImplemented}`);
    assert.ok(Array.isArray(body.methods));
    assert.equal(body.methods.length, body.methodsImplemented);
    assert.ok(body.methods.includes('ping'));
    assert.ok(body.methods.includes('jukeboxControl'));
    // Methods are sorted for stable UI rendering.
    const sorted = [...body.methods].sort();
    assert.deepEqual(body.methods, sorted);
    assert.deepEqual(body.nowPlaying, []);
  });

  test('nowPlaying populates after a scrobble+submission=false signal', async () => {
    // Scrobble via Subsonic: register alice as now-playing without bumping counts.
    // First mint a key so we can auth as admin against /rest.
    const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminJwt },
      body: JSON.stringify({ name: 'stats-test' }),
    });
    const key = (await keyR.json()).key;
    // Pick any song to be "playing".
    const randR = await fetch(
      `${server.baseUrl}/rest/getRandomSongs?f=json&apiKey=${key}&size=1`);
    const songId = (await randR.json())['subsonic-response'].randomSongs.song[0].id;
    await fetch(
      `${server.baseUrl}/rest/scrobble?f=json&apiKey=${key}&id=${songId}&submission=false`);

    const r = await adminGet('/api/v1/admin/subsonic/stats');
    const body = await r.json();
    assert.ok(body.nowPlaying.length >= 1, 'nowPlaying should contain at least one entry');
    const np = body.nowPlaying[0];
    assert.equal(np.username, ADMIN.username);
    assert.equal(np.trackId, parseInt(songId, 10));
    // Title is resolved from the tracks join — not null for a real fixture.
    assert.ok(typeof np.title === 'string' && np.title.length > 0);
    assert.ok(np.sinceMs >= 0);
  });

  test('admin-only', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/stats', userJwt);
    assert.equal(r.status, 405);
  });
});

// ── /test ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/subsonic/test', () => {
  test('returns { ok: true } and a latency when Subsonic is on same-port mode', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/test');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ok');
    assert.ok(body.latencyMs >= 0);
    assert.equal(body.version, '1.16.1');
    // URL is advisory — confirm it looks right.
    assert.ok(body.url.includes('/rest/ping'));
  });

  test('admin-only', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/test', userJwt);
    assert.equal(r.status, 405);
  });
});

// ── /jukebox ──────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/subsonic/jukebox', () => {
  test('when autoBootServerAudio is false (default), reports available:false', async () => {
    // The default test server has autoBootServerAudio = false; the handler
    // bails before even reaching the rust-server-audio stub.
    const r = await adminGet('/api/v1/admin/subsonic/jukebox');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.available, false);
    assert.ok(typeof body.reason === 'string');
  });

  test('admin-only', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/jukebox', userJwt);
    assert.equal(r.status, 405);
  });
});

// ── /token-auth-attempts ──────────────────────────────────────────────────

describe('token-auth-attempts endpoint', () => {
  test('empty initially, populates when a client tries token auth', async () => {
    // Clear first so we don't pick up attempts from earlier in the session.
    await adminDelete('/api/v1/admin/subsonic/token-auth-attempts');
    const before = await (await adminGet('/api/v1/admin/subsonic/token-auth-attempts')).json();
    assert.deepEqual(before.attempts, []);

    // Simulate a Subsonic client using token auth — our auth layer records it.
    await fetch(
      `${server.baseUrl}/rest/ping?f=json&u=alice&t=deadbeef&s=salt&c=DSub/3.2`);
    await fetch(
      `${server.baseUrl}/rest/ping?f=json&u=alice&t=cafebabe&s=salt&c=Symfonium/9`);

    const r = await adminGet('/api/v1/admin/subsonic/token-auth-attempts');
    const body = await r.json();
    assert.ok(body.attempts.length >= 2, `expected at least 2 attempts, got ${body.attempts.length}`);
    // Most-recent first; check the shape.
    const first = body.attempts[0];
    assert.equal(typeof first.at, 'number');
    assert.ok(first.client?.startsWith('Symfonium') || first.client?.startsWith('DSub'));
  });

  test('DELETE clears the buffer', async () => {
    await fetch(`${server.baseUrl}/rest/ping?f=json&u=x&t=y&s=z&c=test`);
    const before = await (await adminGet('/api/v1/admin/subsonic/token-auth-attempts')).json();
    assert.ok(before.attempts.length >= 1);

    const d = await adminDelete('/api/v1/admin/subsonic/token-auth-attempts');
    assert.equal(d.status, 200);

    const after = await (await adminGet('/api/v1/admin/subsonic/token-auth-attempts')).json();
    assert.deepEqual(after.attempts, []);
  });

  test('admin-only', async () => {
    const r = await adminGet('/api/v1/admin/subsonic/token-auth-attempts', userJwt);
    assert.equal(r.status, 405);
  });
});

// ── /mint-key ─────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/subsonic/mint-key', () => {
  test('admin mints a key on behalf of another user; key then authenticates as them', async () => {
    const r = await adminPost('/api/v1/admin/subsonic/mint-key', {
      username: USER.username, name: 'admin-minted',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.username, USER.username);
    assert.equal(body.name, 'admin-minted');
    assert.ok(typeof body.key === 'string' && body.key.length >= 20);

    // The key should authenticate as bob — ping using that key and confirm
    // the response carries bob's identity by hitting getUser.
    const probe = await fetch(
      `${server.baseUrl}/rest/getUser?f=json&apiKey=${encodeURIComponent(body.key)}`);
    const env = (await probe.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
    assert.equal(env.user.username, USER.username);
  });

  test('404 when username does not exist', async () => {
    const r = await adminPost('/api/v1/admin/subsonic/mint-key', {
      username: 'not-a-real-user', name: 'x',
    });
    assert.equal(r.status, 404);
  });

  test('admin-only', async () => {
    const r = await adminPost('/api/v1/admin/subsonic/mint-key',
      { username: ADMIN.username, name: 'x' }, userJwt);
    assert.equal(r.status, 405);
  });
});
