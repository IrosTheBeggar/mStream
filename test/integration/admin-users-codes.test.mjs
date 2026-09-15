/**
 * Admin user management: a duplicate username is 409 and an unknown one is
 * 404 — not an unhandled 500.
 *
 * The helpers in src/util/admin.js (addUser, deleteUser, editUserPassword,
 * editUserVPaths, editUserAccess, setUserLastFM, editUserAllowTorrent) threw
 * plain Errors for `'<username>' already exists` / `does not exist`, which
 * the terminal handler in src/server.js logs as a crash (error level, stack)
 * and answers as 500 "Server Error". Same class as the library-name fixes
 * in #990–#992; the routes are pass-throughs, so a WebError's status is what
 * the client sees.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const BOB   = { username: 'bob',   password: 'pw-bob' };

let server, adminJwt;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    waitForScan: false,
    users: [
      { ...ADMIN, admin: true,  vpaths: ['testlib'] },
      { ...BOB,   admin: false, vpaths: ['testlib'] },
    ],
  });
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  adminJwt = (await r.json()).token;
});

after(async () => { if (server) { await server.stop(); } });

async function api(method, route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': adminJwt },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

describe('admin user management — duplicate and unknown usernames are 4xx, not crashes', () => {
  test('PUT /admin/users with an existing username → 409', async () => {
    const r = await api('PUT', '/api/v1/admin/users', { username: 'bob', password: 'x', vpaths: ['testlib'] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "'bob' already exists");
  });

  const unknown = [
    ['DELETE /admin/users',              'DELETE', '/api/v1/admin/users',                { username: 'ghost' }],
    ['POST /admin/users/password',       'POST',   '/api/v1/admin/users/password',       { username: 'ghost', password: 'x' }],
    ['POST /admin/users/lastfm',         'POST',   '/api/v1/admin/users/lastfm',         { username: 'ghost', lastfmUser: 'x', lastfmPassword: 'y' }],
    ['POST /admin/users/vpaths',         'POST',   '/api/v1/admin/users/vpaths',         { username: 'ghost', vpaths: ['testlib'] }],
    ['POST /admin/users/access',         'POST',   '/api/v1/admin/users/access',         { username: 'ghost', admin: false, allowMkdir: true, allowUpload: true }],
    ['POST /admin/users/torrent-access', 'POST',   '/api/v1/admin/users/torrent-access', { username: 'ghost', allowTorrent: true }],
  ];
  for (const [label, method, route, body] of unknown) {
    test(`${label} for an unknown user → 404`, async () => {
      const r = await api(method, route, body);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "'ghost' does not exist");
    });
  }

  test('the same edit on a real user still succeeds and both users remain (control)', async () => {
    const r = await api('POST', '/api/v1/admin/users/vpaths', { username: 'bob', vpaths: ['testlib'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const users = await api('GET', '/api/v1/admin/users');
    assert.equal(users.status, 200, JSON.stringify(users.body));
    assert.ok('bob' in users.body && 'admin' in users.body, JSON.stringify(users.body));
  });
});
