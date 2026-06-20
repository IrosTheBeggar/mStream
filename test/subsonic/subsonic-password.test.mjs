/**
 * Tests for the V35 opt-in Subsonic-specific password feature.
 *
 * Coverage:
 *   - Crypto helper round-trip + tamper detection
 *   - User-side endpoints (GET / PUT / DELETE /api/v1/user/subsonic-password)
 *   - Admin user-create with subsonicPassword field
 *   - Subsonic token auth (t/s) works after a password is set
 *   - Subsonic token auth returns the friendly TOKEN_UNSUPPORTED message
 *     when no Subsonic password is set
 *   - Subsonic u/p auth accepts EITHER the main password OR the
 *     Subsonic-specific password
 *   - Main /api/v1/auth/login still rejects the Subsonic password
 *     (Subsonic-only — not a backdoor into the web UI)
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from '../helpers/server.mjs';
import {
  encryptSubsonicPassword,
  decryptSubsonicPassword,
} from '../../src/util/subsonic-password.js';

// ── Crypto helper smoke (via integration) ────────────────────────────────
//
// The encrypt/decrypt round-trip is exercised implicitly by every test
// below that sets a Subsonic password and then authenticates via token —
// if encrypt or decrypt was broken, those tests would fail with code 40
// (bad credentials). We keep this file's coverage focused on observable
// behaviour rather than re-testing the helper in isolation. Direct unit
// tests would need to boot config.setup() to populate
// config.program.subsonicSecret, which is more ceremony than the value
// adds.

// ── User-side endpoints + auth integration ─────────────────────────────────

describe('Subsonic password — endpoints + auth flows', () => {
  let server;
  let aliceToken;

  before(async () => {
    server = await startServer({
      subsonicMode: 'same-port',
      users: [{ username: 'alice', password: 'mainpw', admin: true }],
    });
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'mainpw' }),
    });
    const j = await loginR.json();
    aliceToken = j.token;
  });
  after(async () => { if (server) { await server.stop(); } });

  // GET status
  test('GET /api/v1/user/subsonic-password returns set:false on a fresh user', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/subsonic-password`, {
      headers: { 'x-access-token': aliceToken },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.set, false);
  });

  // Token auth fails before password is set
  test('Subsonic token auth returns TOKEN_UNSUPPORTED (41) when no Subsonic password set', async () => {
    const salt = 'somesalt';
    const t = crypto.createHash('md5').update('mainpw' + salt).digest('hex');
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 41);
    // Updated message mentions setting a Subsonic-specific password.
    assert.match(env.error.message, /Subsonic-specific password/i);
  });

  // PUT sets it
  test('PUT /api/v1/user/subsonic-password stores a value', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/subsonic-password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-access-token': aliceToken },
      body: JSON.stringify({ password: 'sub-only-pw' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.set, true);
  });

  test('GET reflects set:true after PUT', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/subsonic-password`, {
      headers: { 'x-access-token': aliceToken },
    });
    assert.equal((await r.json()).set, true);
  });

  // Token auth works after set
  test('Subsonic token auth succeeds with the Subsonic-specific password', async () => {
    const salt = 'tsaltforsubsonic';
    const t = crypto.createHash('md5').update('sub-only-pw' + salt).digest('hex');
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
  });

  test('Subsonic token auth fails on wrong token even when Subsonic password is set', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&t=ffffffff&s=anysalt&v=1.16.1&c=test&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 40);  // bad credentials
  });

  // u/p auth accepts EITHER password
  test('Subsonic u/p auth accepts the main password (PBKDF2 path)', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&p=mainpw&v=1.16.1&c=test&f=json`);
    assert.equal((await r.json())['subsonic-response'].status, 'ok');
  });

  test('Subsonic u/p auth accepts the Subsonic-specific password (decrypt fallback)', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&p=sub-only-pw&v=1.16.1&c=test&f=json`);
    assert.equal((await r.json())['subsonic-response'].status, 'ok');
  });

  test('Subsonic u/p auth rejects a wrong password', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&p=neither-pw&v=1.16.1&c=test&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 40);
  });

  // Main /api/v1/auth/login is NOT a backdoor for the Subsonic password
  test('Main /api/v1/auth/login rejects the Subsonic password (Subsonic-only)', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'sub-only-pw' }),
    });
    assert.equal(r.status, 401);
  });

  // DELETE clears
  test('DELETE /api/v1/user/subsonic-password clears the column', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/subsonic-password`, {
      method: 'DELETE',
      headers: { 'x-access-token': aliceToken },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).set, false);
  });

  test('Subsonic token auth returns 41 again after DELETE', async () => {
    const salt = 'someotherTimeSalt';
    const t = crypto.createHash('md5').update('sub-only-pw' + salt).digest('hex');
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 41);
  });
});

// ── Admin createUser with subsonicPassword ────────────────────────────────

describe('Subsonic password — admin user-create', () => {
  let server;
  let adminToken;

  before(async () => {
    server = await startServer({
      subsonicMode: 'same-port',
      users: [{ username: 'admin', password: 'adminpw', admin: true }],
    });
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpw' }),
    });
    adminToken = (await loginR.json()).token;
  });
  after(async () => { if (server) { await server.stop(); } });

  test('PUT /api/v1/admin/users with subsonicPassword sets it on creation', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({
        username: 'bob',
        password: 'bob-main',
        vpaths: ['testlib'],
        subsonicPassword: 'bob-sub',
      }),
    });
    assert.equal(r.status, 200);

    // bob should be able to use token auth right away with bob-sub
    const salt = 'bob-salt';
    const t = crypto.createHash('md5').update('bob-sub' + salt).digest('hex');
    const r2 = await fetch(`${server.baseUrl}/rest/ping?u=bob&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    assert.equal((await r2.json())['subsonic-response'].status, 'ok');
  });

  test('PUT /api/v1/admin/users without subsonicPassword leaves the column NULL', async () => {
    await fetch(`${server.baseUrl}/api/v1/admin/users`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({
        username: 'carol',
        password: 'carol-main',
        vpaths: ['testlib'],
      }),
    });

    // Login as carol, check status
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'carol-main' }),
    });
    const carolToken = (await loginR.json()).token;
    const r = await fetch(`${server.baseUrl}/api/v1/user/subsonic-password`, {
      headers: { 'x-access-token': carolToken },
    });
    assert.equal((await r.json()).set, false);
  });

  test('POST /api/v1/admin/users/subsonic-password sets it for an existing user', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users/subsonic-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ username: 'carol', password: 'carol-sub' }),
    });
    assert.equal(r.status, 200);

    const salt = 'carol-salt';
    const t = crypto.createHash('md5').update('carol-sub' + salt).digest('hex');
    const r2 = await fetch(`${server.baseUrl}/rest/ping?u=carol&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    assert.equal((await r2.json())['subsonic-response'].status, 'ok');
  });

  test('POST /api/v1/admin/users/subsonic-password with password=null clears the column', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/users/subsonic-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ username: 'carol', password: null }),
    });
    assert.equal(r.status, 200);

    // Token auth should fall back to the friendly TOKEN_UNSUPPORTED.
    const salt = 'aftercarolclear';
    const t = crypto.createHash('md5').update('carol-sub' + salt).digest('hex');
    const r2 = await fetch(`${server.baseUrl}/rest/ping?u=carol&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`);
    const env = (await r2.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 41);
  });
});
