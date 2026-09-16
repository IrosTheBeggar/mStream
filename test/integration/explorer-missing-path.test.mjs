/**
 * User-facing path routes answer 404/400 — not 500 — when the path the
 * caller named is gone, is the wrong kind, or is unreadable.
 *
 * POST /api/v1/file-explorer called getDirectoryContents with no try/catch,
 * so a folder deleted since the client last listed it (or a typo inside a
 * GRANTED library) made fs.readdir reject with ENOENT and the terminal
 * handler answer an unhandled 500 "Server Error" with a stack in the log.
 * Reproduced 2026-09-15. The recursive listing, the two m3u routes and the
 * directory download failed the same way. PR #990 fixed exactly this for
 * the admin explorer; the mapping now lives in util/file-explorer.js
 * (pathReadError) and is shared. User-facing messages show the caller's
 * VIRTUAL path — a non-admin must not learn a library's root on disk.
 *
 * Boots in public mode (zero users) with a library of its own, so nothing
 * here touches the shared fixture tree that other suites list and count.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

let server, root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-scratchlib-'));
  await fs.mkdir(path.join(root, 'album'));
  await fs.writeFile(path.join(root, 'album', 'song.mp3'), 'x');
  await fs.writeFile(path.join(root, 'notes.txt'), 'x');
  server = await startServer({
    dlnaMode: 'disabled',
    waitForScan: false,
    extraFolders: { scratch: root },
    extraConfig: { writeLogs: true },   // to assert HOW failures are logged
  });
});

after(async () => {
  if (server) { await server.stop(); }
  if (root) {
    await fs.chmod(path.join(root, 'locked'), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function api(route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const noRootLeak = msg => assert.ok(!msg.includes(root), `message leaks the library root: ${msg}`);

describe('POST /api/v1/file-explorer — missing or unreadable folder inside a granted library', () => {
  test('folder that does not exist → 404 ENOENT, message shows the virtual path only', async () => {
    const r = await api('/api/v1/file-explorer', { directory: '/scratch/no-such-subdir/' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read directory "/scratch/no-such-subdir/" (ENOENT)');
    noRootLeak(r.body.error);
  });

  test('a file where a folder was expected → 404', async () => {
    const r = await api('/api/v1/file-explorer', { directory: '/scratch/notes.txt/' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    // libuv reports ENOTDIR for a scandir on a file on every platform we
    // ship; ENOENT is tolerated in case a filesystem says otherwise.
    assert.match(r.body.error, /^Cannot read directory "\/scratch\/notes\.txt\/" \((ENOTDIR|ENOENT)\)$/);
    noRootLeak(r.body.error);
  });

  test('the library root and a real folder still list (control)', async () => {
    const top = await api('/api/v1/file-explorer', { directory: '/scratch/' });
    assert.equal(top.status, 200, JSON.stringify(top.body));
    assert.deepEqual(top.body.directories, [{ name: 'album' }]);
    const album = await api('/api/v1/file-explorer', { directory: '/scratch/album/' });
    assert.equal(album.status, 200, JSON.stringify(album.body));
    assert.equal(album.body.files[0]?.name, 'song.mp3');
  });

  // chmod 000 means nothing to root and nothing to Windows ACLs.
  const canProvokeEacces = process.platform !== 'win32' && process.getuid?.() !== 0;
  test('unreadable folder → 400 EACCES', { skip: !canProvokeEacces }, async () => {
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      const r = await api('/api/v1/file-explorer', { directory: '/scratch/locked/' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'Cannot read directory "/scratch/locked/" (EACCES)');
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});

describe('the other user-facing path routes map the same way', () => {
  test('POST /file-explorer/recursive on a missing folder → 404 ENOENT', async () => {
    const r = await api('/api/v1/file-explorer/recursive', { directory: '/scratch/no-such-subdir/' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read directory "/scratch/no-such-subdir/" (ENOENT)');
  });

  // The smoke round for this change found the recursive listing of a whole
  // library answering 400 (before: 500) as soon as ONE subfolder was
  // unreadable: the recursion's readdir failure propagated and the route
  // could only name the top folder. A bad subfolder is skipped now, like an
  // entry that cannot be stat-ed; only the requested folder itself fails.
  const canProvokeEacces = process.platform !== 'win32' && process.getuid?.() !== 0;
  test('POST /file-explorer/recursive skips an unreadable subfolder instead of failing', { skip: !canProvokeEacces }, async () => {
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      const r = await api('/api/v1/file-explorer/recursive', { directory: '/scratch/' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, ['scratch/album/song.mp3']);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  test('POST /file-explorer/m3u on a missing playlist → 404 ENOENT', async () => {
    const r = await api('/api/v1/file-explorer/m3u', { path: '/scratch/no-such.m3u' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read playlist "/scratch/no-such.m3u" (ENOENT)');
    noRootLeak(r.body.error);
  });

  test('POST /file-explorer/m3u on a folder → 404 EISDIR', async () => {
    const r = await api('/api/v1/file-explorer/m3u', { path: '/scratch/album' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read playlist "/scratch/album" (EISDIR)');
  });

  test('POST /file-explorer/m3u with no path → 400 (validation; was a TypeError 500)', async () => {
    const r = await api('/api/v1/file-explorer/m3u', {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  test('POST /download/directory on a missing folder → 404 ENOENT', async () => {
    const r = await api('/api/v1/download/directory', { directory: '/scratch/no-such-subdir/' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read directory "/scratch/no-such-subdir/" (ENOENT)');
  });

  test('POST /download/m3u on a missing playlist → 404 ENOENT', async () => {
    const r = await api('/api/v1/download/m3u', { path: '/scratch/no-such.m3u' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Cannot read playlist "/scratch/no-such.m3u" (ENOENT)');
  });

  test('the server log shows rejections, not crashes, for these routes', async () => {
    const logDir = path.join(server.tmpDir, 'logs');
    const rejected = /Rejected POST \/api\/v1\/download\/m3u .*404: Cannot read playlist/;
    let log = '';
    for (let i = 0; i < 50 && !rejected.test(log); i++) {   // the file transport flushes asynchronously
      log = '';
      for (const f of await fs.readdir(logDir).catch(() => [])) { log += await fs.readFile(path.join(logDir, f), 'utf8'); }
      if (!rejected.test(log)) { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.match(log, rejected);
    assert.doesNotMatch(log, /Server error on route \/api\/v1\/(file-explorer|download)/);
  });
});
