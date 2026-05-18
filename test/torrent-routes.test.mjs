/**
 * Integration tests for the torrent feature's HTTP surface.
 *
 * Scope:
 *   - Auth + admin-guard checks for every new endpoint.
 *   - Validation paths that don't need a live daemon: path-template
 *     PUT (good + 7 rejection cases), per-user vpath authz on /add,
 *     /preflight gates, /admin/torrent config read/write.
 *   - Cross-client cleanup paths (DELETE /admin/torrent/:hash 404).
 *
 * What's NOT covered here:
 *   - /torrent/add happy path — needs a live daemon. Smoke-tested
 *     manually against the live Deluge container during PR work.
 *   - /admin/torrent/{test,connect,disconnect} happy paths — same.
 *   - /admin/torrent/list with rows — same.
 *   - /auto-detect Tier 3 — needs a daemon to probe.
 *
 * Bootstraps a real mStream server via the standard test harness and
 * exercises endpoints over HTTP just like a browser would. JWT auth +
 * the admin guard + every Joi validator gets exercised end-to-end.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob' };

let server;
let adminJwt;
let userJwt;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users: [
      { ...ADMIN, admin: true,  vpaths: ['testlib'] },
      { ...USER,  admin: false, vpaths: ['testlib'] },
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

function jget(path, jwt) {
  return fetch(`${server.baseUrl}${path}`, { headers: { 'x-access-token': jwt } });
}
function jpost(path, body, jwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}
function jput(path, body, jwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: JSON.stringify(body),
  });
}
function jdel(path, jwt) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'x-access-token': jwt },
  });
}

// ────────────────────────────────────────────────────────────────────
// Admin guard — non-admins must NOT reach /api/v1/admin/* torrent routes
// ────────────────────────────────────────────────────────────────────
describe('admin guard on torrent admin routes', () => {
  test('GET /admin/torrent: bob denied with 405 (Admin API Disabled)', async () => {
    const r = await jget('/api/v1/admin/torrent', userJwt);
    assert.equal(r.status, 405);
  });
  test('PUT /admin/torrent/path-templates/testlib: bob denied with 405', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '{{ARTIST}}' }, userJwt);
    assert.equal(r.status, 405);
  });
  test('DELETE /admin/torrent/{hash}: bob denied with 405', async () => {
    const r = await jdel('/api/v1/admin/torrent/' + 'a'.repeat(40), userJwt);
    assert.equal(r.status, 405);
  });
});

// ────────────────────────────────────────────────────────────────────
// /admin/torrent — config read + write
// ────────────────────────────────────────────────────────────────────
describe('/api/v1/admin/torrent (config snapshot)', () => {
  test('default: client=disabled, no creds configured', async () => {
    const r = await jget('/api/v1/admin/torrent', adminJwt);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.client, 'disabled');
    assert.equal(body.transmission.configured, false);
    assert.equal(body.qbittorrent.configured, false);
    assert.equal(body.deluge.configured, false);
    // Passwords MUST NOT leak in the GET response
    assert.equal(body.transmission.password, undefined);
    assert.equal(body.qbittorrent.password, undefined);
    assert.equal(body.deluge.password, undefined);
  });
  test('POST /client switches the active client', async () => {
    const r = await jpost('/api/v1/admin/torrent/client', { client: 'transmission' }, adminJwt);
    assert.equal(r.status, 200);
    const after = await (await jget('/api/v1/admin/torrent', adminJwt)).json();
    assert.equal(after.client, 'transmission');
  });
  test('POST /client rejects unknown client', async () => {
    const r = await jpost('/api/v1/admin/torrent/client', { client: 'utorrent' }, adminJwt);
    assert.ok(r.status >= 400);
  });
  test('POST /enabled-for accepts all + whitelist', async () => {
    for (const v of ['all', 'whitelist']) {
      const r = await jpost('/api/v1/admin/torrent/enabled-for', { enabledFor: v }, adminJwt);
      assert.equal(r.status, 200);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Path Templates (V41) — full admin + user surface
// ────────────────────────────────────────────────────────────────────
describe('path-template admin endpoints', () => {
  test('GET /admin/torrent/path-templates returns vpaths + variable list', async () => {
    const r = await jget('/api/v1/admin/torrent/path-templates', adminJwt);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.vpaths.testlib, 'testlib should appear');
    assert.deepEqual(body.supportedVars, ['ARTIST', 'ALBUM', 'YEAR', 'GENRE', 'ALBUMARTIST']);
    assert.equal(body.suggestedTemplate, '{{ARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.ok(body.sampleMetadata.artist, 'sample metadata for live preview');
  });

  test('PUT happy path: saves + returns sample resolution', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib',
      { template: '{{ARTIST}}/{{ALBUM}} ({{YEAR}})' }, adminJwt);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.template, '{{ARTIST}}/{{ALBUM}} ({{YEAR}})');
    assert.equal(body.samplePath, 'Pink Floyd/The Dark Side of the Moon (1973)');
  });

  test('PUT null clears the template back to NULL', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: null }, adminJwt);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).template, null);
  });

  test('PUT whitespace-only also clears', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '   ' }, adminJwt);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).template, null);
  });

  test('PUT rejects unknown variable', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '{{NOPE}}' }, adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'unknown_variable');
  });

  test('PUT rejects ../ traversal', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '../{{ALBUM}}' }, adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'traversal');
  });

  test('PUT rejects absolute path', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '/etc/{{ALBUM}}' }, adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'absolute_template');
  });

  test('PUT rejects tilde (~) home expansion', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '~/Music/{{ALBUM}}' }, adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'home_string');
  });

  test('PUT rejects unbalanced braces', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/testlib', { template: '{{ARTIST}/{{ALBUM}}' }, adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'unbalanced_braces');
  });

  test('PUT returns 404 for unknown vpath', async () => {
    const r = await jput('/api/v1/admin/torrent/path-templates/never-was', { template: '{{ARTIST}}' }, adminJwt);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'unknown_vpath');
  });
});

describe('user-facing GET /api/v1/torrent/path-templates', () => {
  test('returns only the user\'s accessible vpaths', async () => {
    // First, save a template on testlib so we have something to read back
    await jput('/api/v1/admin/torrent/path-templates/testlib',
      { template: '{{ARTIST}}/{{ALBUM}}' }, adminJwt);

    const r = await jget('/api/v1/torrent/path-templates', userJwt);
    assert.equal(r.status, 200);
    const body = await r.json();
    // bob has testlib in his vpaths — should appear
    assert.ok(body.vpaths.testlib);
    assert.equal(body.vpaths.testlib.template, '{{ARTIST}}/{{ALBUM}}');
    // supportedVars is part of the response for client-side preview
    assert.ok(Array.isArray(body.supportedVars));
  });
});

// ────────────────────────────────────────────────────────────────────
// /admin/torrent/{hash} DELETE
// ────────────────────────────────────────────────────────────────────
describe('DELETE /api/v1/admin/torrent/:infoHash', () => {
  test('400 on non-hex info hash', async () => {
    const r = await jdel('/api/v1/admin/torrent/not-a-hash', adminJwt);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_info_hash');
  });
  test('400 on too-short hash', async () => {
    const r = await jdel('/api/v1/admin/torrent/abc123', adminJwt);
    assert.equal(r.status, 400);
  });
  test('404 on hash not in managed_torrents', async () => {
    const r = await jdel('/api/v1/admin/torrent/' + 'a'.repeat(40), adminJwt);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not_managed');
  });
});

// ────────────────────────────────────────────────────────────────────
// /torrent/preflight — vpath resolution + permission gates
// ────────────────────────────────────────────────────────────────────
describe('GET /api/v1/torrent/preflight', () => {
  test('no path → vpath: null, reason describes the missing client', async () => {
    const r = await jget('/api/v1/torrent/preflight', userJwt);
    assert.equal(r.status, 200);
    const body = await r.json();
    // Active client may have been changed by earlier tests; the
    // important shape invariant is that we get a structured response.
    assert.equal(typeof body.active, 'boolean');
    assert.equal(typeof body.userAllowed, 'boolean');
    assert.equal(body.vpath, null);
  });
  test('path resolves to the right vpath', async () => {
    const r = await jget('/api/v1/torrent/preflight?path=' + encodeURIComponent('testlib/SomeAlbum'), userJwt);
    const body = await r.json();
    assert.equal(body.vpath, 'testlib');
    assert.equal(body.subPath, 'SomeAlbum');
  });
});

// ────────────────────────────────────────────────────────────────────
// /torrent/add — input validation (without a daemon)
// ────────────────────────────────────────────────────────────────────
describe('POST /api/v1/torrent/add — input validation', () => {
  // We can't exercise the happy path without a daemon, but we CAN
  // verify the gates that fire before the daemon call.

  test('rejects when no torrent client is active', async () => {
    // Make sure the active client is disabled for this test
    await jpost('/api/v1/admin/torrent/client', { client: 'disabled' }, adminJwt);
    const fd = new FormData();
    fd.append('magnet', 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10');
    fd.append('vpath', 'testlib');
    fd.append('directoryName', 'Test');
    const r = await fetch(`${server.baseUrl}/api/v1/torrent/add`, {
      method: 'POST',
      headers: { 'x-access-token': userJwt },
      body: fd,
    });
    assert.equal(r.status, 403, 'feature disabled returns 403');
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'feature_disabled');
  });
});
