/**
 * Globally-disabled features (noMkdir / noUpload) must return 403 Forbidden,
 * not 500. These endpoints threw `new WebError('... Disabled')` with no status
 * code, which defaulted to 500 — a server-error response for a deliberate
 * "this is turned off" condition. The per-user permission variant right below
 * each already returned 403; this makes the global switch consistent.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

describe('globally-disabled features return 403 (not 500)', () => {
  let server, token;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      users: [{ username: 'paul', password: 'p', admin: true, vpaths: ['testlib'] }],
      extraConfig: { noMkdir: true, noUpload: true },
    });
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'paul', password: 'p' }),
    });
    token = (await r.json()).token;
  });

  after(async () => { if (server) { await server.stop(); } });

  // Each check fires before any body parsing, so a minimal POST is enough.
  const post = (path, body) => fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body || {}),
  });

  test('file-explorer/mkdir with noMkdir → 403', async () => {
    const r = await post('/api/v1/file-explorer/mkdir', { directory: 'testlib/foo' });
    assert.equal(r.status, 403);
  });

  test('file-explorer/upload with noUpload → 403', async () => {
    const r = await post('/api/v1/file-explorer/upload', {});
    assert.equal(r.status, 403);
  });

  test('ytdl with noUpload → 403', async () => {
    const r = await post('/api/v1/ytdl/', {});
    assert.equal(r.status, 403);
  });
});
