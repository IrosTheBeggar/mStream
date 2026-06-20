/**
 * Configurable bulk-download size cap (config.downloadSizeLimit).
 *
 * The /api/v1/download/* zip routes sum their source files before streaming
 * and reject an over-limit request with 413 (a clean status, not a truncated
 * archive). '0' = unlimited. The limit is read live, so the admin API can
 * raise/lower it with no reboot.
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

describe('download size limit', () => {
  let server, token, fileVpath, dirVpath;

  before(async () => {
    // Boot with a 1KB cap — every real audio file is well over it.
    server = await startServer({
      dlnaMode: 'disabled',
      waitForScan: false,
      users: [{ username: 'paul', password: 'p', admin: true, vpaths: ['testlib'] }],
      extraConfig: { downloadSizeLimit: '1KB' },
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

  test('directory download over the limit → 413', async () => {
    const r = await post('/api/v1/download/directory', { directory: dirVpath });
    assert.equal(r.status, 413);
  });

  test('zip download over the limit → 413', async () => {
    const r = await post('/api/v1/download/zip', { fileArray: JSON.stringify([fileVpath]) });
    assert.equal(r.status, 413);
  });

  test('admin rejects a malformed size string → 400', async () => {
    const r = await post('/api/v1/admin/config/download-size-limit', { downloadSizeLimit: 'banana' });
    assert.equal(r.status, 400);
  });

  test('admin can raise the limit live; the same download then streams (200)', async () => {
    const set = await post('/api/v1/admin/config/download-size-limit', { downloadSizeLimit: '1GB' });
    assert.equal(set.status, 200);

    const r = await post('/api/v1/download/directory', { directory: dirVpath });
    assert.equal(r.status, 200);
    await r.arrayBuffer(); // drain the zip stream so the connection closes
  });
});
