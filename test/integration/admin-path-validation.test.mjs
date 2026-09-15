/**
 * PUT /api/v1/admin/directory + POST /api/v1/admin/file-explorer — path
 * validation and `~` expansion.
 *
 * Both routes used to answer an unhandled 500 "Server Error" for inputs
 * that are the caller's mistake, with the reason visible only in the
 * server log:
 *   - PUT /admin/directory sent the raw path to admin.addDirectory, whose
 *     fs.stat threw for `~`, `~/Music`, a relative `code/music`, or an
 *     absolute path that does not exist.
 *   - POST /admin/file-explorer expanded only the bare `~`; `~/code` was
 *     read literally and the readdir's ENOENT went unhandled.
 *   - A vpath that already exists (PUT), or one that does not (DELETE,
 *     POST …/follow-symlinks), threw a plain Error out of
 *     src/util/admin.js — the same unhandled 500.
 *
 * These pin the 4xx answers and their messages, the shared `~` rule, and
 * that good paths still work end to end (the EXPANDED root is what gets
 * stored). The server is spawned with HOME/USERPROFILE pointed at a temp
 * dir, so `~` resolves somewhere the test controls on every platform, and
 * with zero users, so every request is an admin (public-access mode).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const REJECT_PREFIX = '"directory" must be an absolute path that exists';

let server;
let fakeHome;   // what the spawned server sees as `~`
let plainDir;   // an existing absolute directory outside `~`
let filePath;   // a regular file — exists, but is not a directory

before(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-home-'));
  plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-lib-'));
  await fs.mkdir(path.join(fakeHome, 'music', 'sub'), { recursive: true });
  filePath = path.join(fakeHome, 'notes.txt');
  await fs.writeFile(filePath, 'x');
  server = await startServer({
    dlnaMode: 'disabled',
    waitForScan: false,
    env: { HOME: fakeHome, USERPROFILE: fakeHome },
  });
});

after(async () => {
  if (server) { await server.stop(); }
  for (const dir of [fakeHome, plainDir]) {
    if (dir) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
});

async function api(method, route, body) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const explore    = body => api('POST', '/api/v1/admin/file-explorer', body);
const addLibrary = body => api('PUT', '/api/v1/admin/directory', body);
const libraries  = () => api('GET', '/api/v1/admin/directories');

describe('POST /api/v1/admin/file-explorer — `~` forms and readdir failures', () => {
  test('bare `~` still lists the home directory', async () => {
    const r = await explore({ directory: '~' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, fakeHome);
    assert.ok(r.body.directories.some(d => d.name === 'music'), JSON.stringify(r.body));
  });

  test('`~/music` expands to home + the rest (was read literally → 500)', async () => {
    const r = await explore({ directory: '~/music' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, path.join(fakeHome, 'music'));
    assert.deepEqual(r.body.directories, [{ name: 'sub' }]);
  });

  test('`~` + joinDirectory still composes onto the expanded home', async () => {
    const r = await explore({ directory: '~', joinDirectory: 'music' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, path.join(fakeHome, 'music'));
  });

  test('`~/…` that does not exist → 404 naming ENOENT and the expanded path', async () => {
    const r = await explore({ directory: '~/does-not-exist' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /ENOENT/);
    assert.ok(r.body.error.includes(path.join(fakeHome, 'does-not-exist')), r.body.error);
  });

  test('absolute path that does not exist → 404 ENOENT', async () => {
    const r = await explore({ directory: path.join(plainDir, 'missing') });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /ENOENT/);
  });

  test('a regular file → 404 (not a directory)', async () => {
    const r = await explore({ directory: filePath });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    // libuv reports ENOTDIR for a scandir on a file on every platform we
    // ship; ENOENT is tolerated in case a filesystem says otherwise.
    assert.match(r.body.error, /ENOTDIR|ENOENT/);
  });

  test('`~user` forms are not expanded (no user lookups) → 404 like any missing path', async () => {
    const r = await explore({ directory: '~nobody-here/music' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /ENOENT/);
  });

  test('a NUL byte in the path → 400 ERR_INVALID_ARG_VALUE (Node rejects it before the syscall)', async () => {
    const r = await explore({ directory: '/tmp/\u0000x' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /ERR_INVALID_ARG_VALUE/);
  });

  // chmod 000 means nothing to root and nothing to Windows ACLs, so the
  // EACCES leg runs only where it can actually be provoked.
  const canProvokeEacces = process.platform !== 'win32' && process.getuid?.() !== 0;
  test('an unreadable folder → 400 EACCES', { skip: !canProvokeEacces }, async () => {
    const locked = path.join(fakeHome, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      const r = await explore({ directory: '~/locked' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /EACCES/);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});

describe('PUT /api/v1/admin/directory — root must be an absolute directory that exists', () => {
  // [label, directory (or thunk for paths known only after before()), reason]
  const rejected = [
    ['a relative path',                          'code/music',                          /not an absolute path/],
    ['an absolute path that does not exist',     () => path.join(plainDir, 'missing'),  /ENOENT/],
    ['`~/…` that does not exist (expanded, then stat-ed)', '~/does-not-exist',          /ENOENT/],
    ['a regular file',                           () => filePath,                        /not a directory/],
    ['a `~user` form (never expanded)',          '~alice/Music',                        /not an absolute path/],
    ['a path with a NUL byte',                   '/tmp/\u0000x',                        /ERR_INVALID_ARG_VALUE/],
  ];
  rejected.forEach(([label, dir, why], i) => {
    test(`${label} → 400 with the reason`, async () => {
      const directory = typeof dir === 'function' ? dir() : dir;
      const r = await addLibrary({ directory, vpath: `bad${i}` });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok(r.body.error.startsWith(REJECT_PREFIX), r.body.error);
      assert.match(r.body.error, why);
    });
  });

  test('no rejected root was stored', async () => {
    const r = await libraries();
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['testlib']);
  });

  test('`~/music` is accepted and stored as the expanded absolute path', async () => {
    const r = await addLibrary({ directory: '~/music', vpath: 'homelib' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const libs = await libraries();
    assert.equal(libs.body.homelib?.root, path.join(fakeHome, 'music'));
  });

  test('a plain absolute directory still works as before', async () => {
    const r = await addLibrary({ directory: plainDir, vpath: 'abslib' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const libs = await libraries();
    assert.equal(libs.body.abslib?.root, plainDir);
  });
});

// Runs after the PUT suite above has stored `homelib` and `abslib`
// (node:test runs top-level suites in file order).
describe('library name answers — duplicate and unknown vpath are 4xx, not crashes', () => {
  test('PUT with a vpath that already exists → 409, stored root untouched', async () => {
    const r = await addLibrary({ directory: path.join(fakeHome, 'music'), vpath: 'abslib' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "'abslib' already exists");
    const libs = await libraries();
    assert.equal(libs.body.abslib?.root, plainDir);
  });

  test('POST /directory/follow-symlinks for an unknown vpath → 404', async () => {
    const r = await api('POST', '/api/v1/admin/directory/follow-symlinks',
      { vpath: 'ghost', followSymlinks: true });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "'ghost' not found");
  });

  test('DELETE an unknown vpath → 404; nothing removed, server still up', async () => {
    const r = await api('DELETE', '/api/v1/admin/directory', { vpath: 'ghost' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "'ghost' not found");
    // A successful DELETE reboots the HTTP server; the 404 path must not.
    const libs = await libraries();
    assert.equal(libs.status, 200);
    assert.deepEqual(Object.keys(libs.body).sort(), ['abslib', 'homelib', 'testlib']);
  });
});
