/**
 * Integration tests for the admin mount-guard reset endpoint.
 *
 *   POST /api/v1/admin/directory/reset-sentinel { vpath }
 *
 * Writes the .mstream.md sentinel to the library's root_path. Use
 * cases (per src/api/admin.js): operator intentionally emptied a
 * library, or recovering from a read-only-locked mount that prevented
 * the previous scan from writing the sentinel.
 *
 * The scanner-side enforcement of the sentinel is covered by
 * test/scanner-mount-guard.test.mjs. This file just asserts the
 * admin HTTP shape + auth gate.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
let adminJwt;
let userJwt;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
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
});

function adminPost(body, jwt = adminJwt) {
  return fetch(`${server.baseUrl}/api/v1/admin/directory/reset-sentinel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/admin/directory/reset-sentinel', () => {
  test('writes the sentinel for an existing library', async () => {
    // startServer creates a library 'testlib' rooted at musicDir.
    // After the initial scan ran during server boot, that library
    // already has its sentinel written. Delete it, then call the
    // endpoint and verify it comes back.
    const sentinel = path.join(server.musicDir, '.mstream.md');
    try { fs.unlinkSync(sentinel); } catch { /* may not exist if scan was quick */ }
    assert.equal(fs.existsSync(sentinel), false, 'pre-condition: sentinel removed');

    const r = await adminPost({ vpath: 'testlib' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body.vpath, 'testlib');
    assert.ok(body.path && body.path.endsWith('.mstream.md'),
      `response includes the sentinel path: ${body.path}`);
    assert.equal(fs.existsSync(sentinel), true,
      'sentinel exists on disk after the reset call');
  });

  test('is idempotent — calling twice succeeds both times', async () => {
    const r1 = await adminPost({ vpath: 'testlib' });
    const r2 = await adminPost({ vpath: 'testlib' });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });

  test('rejects unknown vpath', async () => {
    // Joi-validated rejections (bad shape) surface as 403; runtime
    // throws from inside the route handler (library not found, etc.)
    // surface as 500 — matches the existing /api/v1/admin/directory
    // PUT/DELETE pattern at admin.js:267 / :291.
    const r = await adminPost({ vpath: 'doesnotexist' });
    assert.equal(r.status, 500,
      `unknown vpath surfaces as 500 (runtime throw, not Joi) — got ${r.status}`);
  });

  test('rejects missing vpath in body', async () => {
    const r = await adminPost({});
    assert.equal(r.status, 403);
  });

  test('rejects non-admin caller (405 from outer admin guard)', async () => {
    const r = await adminPost({ vpath: 'testlib' }, userJwt);
    assert.equal(r.status, 405);
  });

  test('rejects anonymous caller', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/directory/reset-sentinel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vpath: 'testlib' }),
    });
    assert.ok([401, 403, 405].includes(r.status),
      `anon → 401/403/405, got ${r.status}`);
  });
});
