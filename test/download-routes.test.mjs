/**
 * Download routes must return an HTTP status on a pre-stream error, not hang.
 *
 * The handlers used to be sync wrappers that did
 * `worker(req,res).catch(err => { throw err })`. In Express 5 the throw lands
 * in a promise nobody awaits → unhandled rejection → the error middleware is
 * never reached → the client connection hangs with no status. Making the
 * handlers async + `await` lets Express forward the rejection so a validation
 * / bad-path error becomes a real 4xx.
 *
 * Each request uses a short AbortSignal timeout so a regression (the hang)
 * fails fast and loud instead of stalling the whole test run.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

describe('download routes return a status on pre-stream errors (no hung connection)', () => {
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
    signal: AbortSignal.timeout(8000),
  });

  // Missing required field → 400 (validation). The AbortSignal in `post`
  // still guards the original concern: a regression to the old dropped-promise
  // bug would hang and time out rather than return a status.
  test('m3u with no path → 400', async () => {
    const r = await post('/api/v1/download/m3u', {});
    assert.equal(r.status, 400);
  });

  test('directory with no directory → 400', async () => {
    const r = await post('/api/v1/download/directory', {});
    assert.equal(r.status, 400);
  });

  test('directory pointing at a file → 400 Not A Directory', async () => {
    const r = await post('/api/v1/download/directory', { directory: fileVpath });
    assert.equal(r.status, 400);
  });

  test('directory pointing at a real directory still streams a zip (200)', async () => {
    const r = await post('/api/v1/download/directory', { directory: dirVpath });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment/);
    await r.arrayBuffer(); // drain the stream so the connection closes cleanly
  });
});
