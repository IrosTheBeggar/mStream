/**
 * archiver is loaded on demand (src/util/lazy-archiver.js) rather than at boot.
 *
 * That makes every zip endpoint the place where a resolution failure would
 * first surface, so each one is exercised here to the point of REAL ZIP BYTES
 * — a 200 with the right Content-Disposition proves the handler ran, but only
 * the "PK" local-file-header magic proves archiver itself loaded and produced
 * an archive. In a `bun build --compile` standalone binary a dep that was not
 * bundled fails exactly here and nowhere earlier.
 *
 * /api/v1/admin/logs/download also had NO coverage before this, and it is the
 * handler the lazy load converted from sync to async — the shape
 * download-routes.test.mjs's header warns about (an un-awaited throw in
 * Express 5 becomes an unhandled rejection and the client hangs with no
 * status). Each request below carries an AbortSignal so that regression fails
 * fast instead of stalling the run.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

function findMp3(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findMp3(full); if (r) { return r; } }
    else if (e.name.endsWith('.mp3')) { return full; }
  }
  return null;
}

// Every zip starts with a local file header: 0x50 0x4b ("PK"). An EMPTY
// archive instead starts with the end-of-central-directory record, PK\x05\x06,
// so assert only the two-byte signature and check for non-emptiness
// separately.
async function assertZip(res, what) {
  assert.equal(res.status, 200, `${what}: expected 200`);
  assert.match(res.headers.get('content-disposition') || '', /attachment/,
    `${what}: expected an attachment disposition`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, `${what}: body was empty`);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK',
    `${what}: body is not a zip (first bytes ${JSON.stringify(buf.subarray(0, 8).toString('latin1'))})`);
}

describe('lazily-loaded archiver still produces real zips', () => {
  let server, token, fileVpath, dirVpath;

  before(async () => {
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      users: [{ username: 'paul', password: 'p', admin: true, vpaths: ['testlib'] }],
    });
    const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'paul', password: 'p' }),
    });
    token = (await login.json()).token;

    const file = findMp3(server.musicDir);
    const relFile = path.relative(server.musicDir, file).split(path.sep).join('/');
    fileVpath = `testlib/${relFile}`;
    dirVpath = `testlib/${relFile.split('/').slice(0, -1).join('/')}`;
  });

  after(async () => { if (server) { await server.stop(); } });

  const post = (p, body) => fetch(`${server.baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const get = (p) => fetch(`${server.baseUrl}${p}`, {
    headers: { 'x-access-token': token },
    signal: AbortSignal.timeout(15000),
  });

  test('POST /download/directory streams a real zip', async () => {
    await assertZip(await post('/api/v1/download/directory', { directory: dirVpath }),
      'download/directory');
  });

  test('POST /download/zip streams a real zip', async () => {
    await assertZip(await post('/api/v1/download/zip', { fileArray: JSON.stringify([fileVpath]) }),
      'download/zip');
  });

  test('GET /admin/logs/download streams a real zip (sync -> async handler)', async () => {
    await assertZip(await get('/api/v1/admin/logs/download'), 'admin/logs/download');
  });

  test('a second request reuses the cached module and still works', async () => {
    // The loader memoises; this guards the cache path, not just the cold one.
    await assertZip(await get('/api/v1/admin/logs/download'), 'admin/logs/download (cached)');
  });
});
