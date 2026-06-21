/**
 * Mode-switching tests for the Subsonic API.
 *
 * Each describe block spawns its own mStream instance in a different mode
 * so they don't cross-contaminate. This file exists separately from
 * test/subsonic.test.mjs because each test file runs in its own process
 * under `node --test` — which is exactly what we want for isolated mode
 * fixtures.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

// ── disabled (default off) ──────────────────────────────────────────────────

describe('Subsonic mode=disabled', () => {
  let server;

  before(async () => {
    server = await startServer({
      dlnaMode:     'disabled',
      subsonicMode: 'disabled',
      users:        [{ username: 'alice', password: 'x', admin: true }],
    });
  });

  after(async () => { if (server) { await server.stop(); } });

  test('/rest routes are not mounted', async () => {
    // With no Subsonic mount, the path falls through every registered route;
    // mStream's catch-all eventually returns something — the important thing
    // is that it does NOT return a Subsonic envelope.
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&p=x&f=json`);
    const text = await r.text();
    assert.ok(!text.includes('"subsonic-response"'), 'should not see subsonic envelope when disabled');
  });

  test('admin endpoint reports mode=disabled', async () => {
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: 'alice', password: 'x' }),
    });
    const { token } = await loginR.json();
    const r = await fetch(`${server.baseUrl}/api/v1/admin/subsonic`, {
      headers: { 'x-access-token': token },
    });
    const body = await r.json();
    assert.equal(body.mode, 'disabled');
    assert.equal(typeof body.port, 'number');
  });
});

// ── separate-port ───────────────────────────────────────────────────────────

describe('Subsonic mode=separate-port', () => {
  let server;

  before(async () => {
    server = await startServer({
      dlnaMode:     'disabled',
      subsonicMode: 'separate-port',
      users:        [{ username: 'alice', password: 'x', admin: true }],
    });
  });

  after(async () => { if (server) { await server.stop(); } });

  test('main port does not expose /rest', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?u=alice&p=x&f=json`);
    const text = await r.text();
    assert.ok(!text.includes('"subsonic-response"'), 'main port should not carry Subsonic in separate-port mode');
  });

  test('Subsonic port serves /rest', async () => {
    const r = await fetch(`${server.subsonicBaseUrl}/rest/ping?u=alice&p=x&f=json`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body['subsonic-response'].status, 'ok');
  });

  test('Subsonic port rejects bad credentials', async () => {
    const r = await fetch(`${server.subsonicBaseUrl}/rest/ping?u=alice&p=wrong&f=json`);
    const body = await r.json();
    assert.equal(body['subsonic-response'].status, 'failed');
    assert.equal(body['subsonic-response'].error.code, 40);
  });

  test('separate-port server runs on the configured port', () => {
    assert.notEqual(server.subsonicBaseUrl, server.baseUrl);
  });
});
