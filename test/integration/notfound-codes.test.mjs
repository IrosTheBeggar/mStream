/**
 * "Not found" conditions should return 404, not a flattened 400 / a 500.
 *
 *  - album-art set/upload threw `Error('Track not found')` inside applyAlbumArt,
 *    which the route's catch turned into 400. Now it's a WebError(404) and the
 *    catch honours its status (other bad-image errors still 400).
 *  - DELETE /admin/ssl with no cert configured threw a bare Error → 500 (and
 *    TypeError'd outright when ssl was absent). Now a clean 404.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

// Valid PNG magic bytes + padding to clear the endpoint's >=100-byte check.
// Jimp can't decode it, but saveImageToCache swallows that, so the request
// still reaches the track lookup — the path under test.
const fakePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200),
]).toString('base64');

describe('not-found codes (album art + admin ssl)', () => {
  let server, token;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      users: [{ username: 'paul', password: 'p', admin: true, vpaths: ['testlib'] }],
    });
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'paul', password: 'p' }),
    });
    token = (await r.json()).token;
  });

  after(async () => { if (server) { await server.stop(); } });

  const post = (path, body) => fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body),
  });

  test('album-art/upload for a non-existent track → 404 (not 400)', async () => {
    const r = await post('/api/v1/album-art/upload', {
      filepath: 'testlib/does/not/exist.mp3',
      image: fakePng,
    });
    assert.equal(r.status, 404);
  });

  test('album-art/upload with a malformed (too-small) image still → 400', async () => {
    const r = await post('/api/v1/album-art/upload', {
      filepath: 'testlib/does/not/exist.mp3',
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), // 4 bytes
    });
    assert.equal(r.status, 400);
  });

  test('DELETE /admin/ssl with no cert configured → 404 (not 500)', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/ssl`, {
      method: 'DELETE',
      headers: { 'x-access-token': token },
    });
    assert.equal(r.status, 404);
  });
});
