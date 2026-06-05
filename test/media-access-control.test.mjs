/**
 * The /media route must only serve a library to users who have that library in
 * their vpath list — the same authorization getVPathInfo() applies to the
 * file-explorer and download routes. Before this check, any authenticated user
 * could fetch any library's files by guessing the URL.
 *
 * A user without access is treated like one requesting an unknown library (404)
 * rather than 403, so the existence of libraries they can't see isn't revealed.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

function findMp3(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findMp3(full); if (r) { return r; } }
    else if (e.name.endsWith('.mp3')) { return full; }
  }
  return null;
}

describe('media route enforces vpath access control', () => {
  let server, otherDir, mediaPath, aliceJwt, bobJwt;

  before(async () => {
    // alice can see `testlib`; bob can see only `otherlib`.
    otherDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mstream-otherlib-'));
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      extraFolders: { otherlib: otherDir },
      users: [
        { username: 'alice', password: 'pw-alice', admin: true,  vpaths: ['testlib'] },
        { username: 'bob',   password: 'pw-bob',   admin: false, vpaths: ['otherlib'] },
      ],
    });

    const file = findMp3(server.musicDir);
    const rel = path.relative(server.musicDir, file).split(path.sep).map(encodeURIComponent).join('/');
    mediaPath = `/media/testlib/${rel}`;

    const login = async (username, password) => {
      const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return (await r.json()).token;
    };
    aliceJwt = await login('alice', 'pw-alice');
    bobJwt   = await login('bob',   'pw-bob');
  });

  after(async () => {
    if (server) { await server.stop(); }
    if (otherDir) { await fs.promises.rm(otherDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('user WITH the library in their vpaths gets the file', async () => {
    const r = await fetch(server.baseUrl + mediaPath, { headers: { 'x-access-token': aliceJwt } });
    assert.equal(r.status, 200);
  });

  test('user WITHOUT the library gets 404 (denied; existence not leaked)', async () => {
    const r = await fetch(server.baseUrl + mediaPath, { headers: { 'x-access-token': bobJwt } });
    assert.equal(r.status, 404);
  });

  test('unauthenticated request is rejected by the auth wall', async () => {
    const r = await fetch(server.baseUrl + mediaPath);
    assert.equal(r.status, 401);
  });
});
