/**
 * Integration contract for the GET /admin PAGE gate (src/server.js).
 *
 * The gate used to check only that the session cookie carried a VALID jwt —
 * not that the user held the admin role. Every /api/v1/admin/* call the panel
 * makes is role-gated, so a logged-in non-admin was served the whole admin
 * shell and then watched all ~25 of its requests get rejected. Four of the
 * panel's loaders had no error branch, so their tabs (Directories, Users,
 * Settings, Transcode) hung on a spinner forever.
 *
 * The gate now checks the role and bounces non-admins to the player. It must
 * NOT bounce them to /login: their session is perfectly valid, and logging
 * back in returns the same non-admin user — that would loop.
 *
 * Companion to the API-side role check, which answers 403 'Admin access
 * required' (it answered 405 'Admin API Disabled' before, which was
 * indistinguishable from the whole admin API being switched off).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
const jwts = {};
const cookies = {};

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    waitForScan: false,
    users: [
      { ...ADMIN, admin: true },
      { ...USER,  admin: false },
    ],
  });
  for (const u of [ADMIN, USER]) {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    jwts[u.username] = (await r.json()).token;
    cookies[u.username] = r.headers.getSetCookie()
      .find(c => c.startsWith('x-access-token='))
      .split(';')[0];
  }
});

after(async () => {
  if (server) { await server.stop(); }
});

// The page gate reads the COOKIE (not the x-access-token header) — that is
// what a browser navigating to /admin actually sends.
function getAdminPage(cookie) {
  return fetch(`${server.baseUrl}/admin`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
}

describe('GET /admin page gate — role', () => {
  test('admin is served the panel', async () => {
    // The gate calls next(); express.static then 301s /admin -> /admin/ to
    // add the directory's trailing slash. Follow it and assert what the
    // operator actually ends up looking at.
    const r = await fetch(`${server.baseUrl}/admin`, {
      headers: { cookie: cookies.admin },
      redirect: 'follow',
    });
    assert.equal(r.status, 200);
    assert.ok(r.url.endsWith('/admin/'), `expected to land on /admin/, got ${r.url}`);
    const html = await r.text();
    assert.ok(html.includes('<title>mStream Admin</title>'), 'expected the admin panel HTML');
  });

  test('non-admin is redirected to the player, NOT to /login', async () => {
    const r = await getAdminPage(cookies.bob);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/',
      'a non-admin has a valid session — bouncing to /login would loop');
  });

  test('no cookie at all still redirects to /login', async () => {
    const r = await getAdminPage(null);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });

  test('a garbage cookie redirects to /login', async () => {
    const r = await getAdminPage('x-access-token=not-a-jwt');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });
});

describe('admin API role check — status + body', () => {
  test('non-admin gets 403 "Admin access required"', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      headers: { 'x-access-token': jwts.bob },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'Admin access required' });
  });

  test('the role rejection is distinguishable from the API being disabled', async () => {
    // 'Admin API Disabled' is reserved for adminAccess.mode='none'
    // (lockAdmin), which still answers 405. A role failure must not
    // masquerade as the whole API being switched off.
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      headers: { 'x-access-token': jwts.bob },
    });
    const body = await r.json();
    assert.notEqual(r.status, 405);
    assert.notEqual(body.error, 'Admin API Disabled');
  });

  test('admin still gets through', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      headers: { 'x-access-token': jwts.admin },
    });
    assert.equal(r.status, 200);
  });
});
