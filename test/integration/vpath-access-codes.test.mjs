/**
 * getVPathInfo (src/util/vpath.js) rejections are 404s, not crashes.
 *
 * A signed-in user who asked for a library they were not granted — or one
 * that does not exist — got an unhandled 500 "Server Error": the resolver
 * threw plain Errors, which the terminal handler in src/server.js logs as a
 * crash (error level, stack) and answers as 500. Reproduced 2026-09-15 with
 * a non-admin user and a library added without autoAccess. Every route that
 * resolves a virtual path without its own try/catch (file-explorer,
 * download, album art, scrobbling, ytdl, …) behaved the same way.
 *
 * Both rejections are 404 rather than 403 on purpose: the access check runs
 * before the library lookup, so a caller sees the same answer for a library
 * they lack and for one that does not exist — the /media/:vpath gate makes
 * the same choice. These pin the status, the messages (torrent.js surfaces
 * them), the no-leak property, that a granted library still works, and that
 * the server log records a rejection rather than a crash.
 *
 * POST /api/v1/db/rate-song used to resolve WITHOUT req.user, so that check
 * was skipped there: a user could rate (and so probe) tracks in a library
 * they were never granted, and an unknown library answered
 * `Library '<vpath>' not found` — the one route where a signed-in caller
 * could tell a missing library from an ungranted one. The last describe
 * pins that it now resolves like every other route.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const BOB   = { username: 'bob',   password: 'pw-bob' };

let server, privateDir, adminJwt, bobJwt;

async function login(u) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
  });
  return (await r.json()).token;
}
async function api(method, route, body, jwt) {
  const r = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': jwt },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const explore = (dir, jwt) => api('POST', '/api/v1/file-explorer', { directory: dir }, jwt);

// First audio file under `dir` (as a virtual path), found by walking the
// explorer — the fixture library is Artist/Album/track, but don't hardcode
// names.
async function firstTrack(dir, jwt, depth = 0) {
  const r = await explore(dir, jwt);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.files?.length) { return `${r.body.path}${r.body.files[0].name}`; }
  assert.ok(depth < 4 && r.body.directories?.length, `no audio file under ${dir}`);
  return firstTrack(`${r.body.path}${r.body.directories[0].name}/`, jwt, depth + 1);
}

before(async () => {
  privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-private-'));
  server = await startServer({
    dlnaMode: 'disabled',
    // waitForScan stays at its default (true): the rate-song control below
    // needs testlib's tracks in the DB.
    // writeLogs so the suite can assert HOW the rejection was logged.
    extraConfig: { writeLogs: true },
    users: [
      { ...ADMIN, admin: true,  vpaths: ['testlib'] },
      { ...BOB,   admin: false, vpaths: ['testlib'] },
    ],
  });
  adminJwt = await login(ADMIN);
  bobJwt   = await login(BOB);
  // A library nobody was granted (autoAccess defaults to false).
  const r = await api('PUT', '/api/v1/admin/directory', { directory: privateDir, vpath: 'private' }, adminJwt);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

after(async () => {
  if (server) { await server.stop(); }
  if (privateDir) { await fs.rm(privateDir, { recursive: true, force: true }).catch(() => {}); }
});

describe('vpath resolution — an ungranted or unknown library is 404, not 500', () => {
  test('bob on a library he was not granted → 404 with the access message', async () => {
    const r = await explore('/private/', bobJwt);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'User does not have access to path private');
  });

  test('bob on a library that does not exist → the same 404 (existence is not revealed)', async () => {
    const r = await explore('/ghost/', bobJwt);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'User does not have access to path ghost');
  });

  test('a granted library still lists (control)', async () => {
    const r = await explore('/testlib/', bobJwt);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, '/testlib/');
  });

  test('the same resolver on a download route → 404, not 500', async () => {
    const r = await api('POST', '/api/v1/download/directory', { directory: '/private/' }, bobJwt);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'User does not have access to path private');
  });

  test('the server log records a warn-level rejection, not a crash', async () => {
    const logDir = path.join(server.tmpDir, 'logs');
    const rejected = /Rejected POST \/api\/v1\/file-explorer .*404: User does not have access to path private/;
    let log = '';
    for (let i = 0; i < 50 && !rejected.test(log); i++) {   // the file transport flushes asynchronously
      log = '';
      for (const f of await fs.readdir(logDir).catch(() => [])) {
        log += await fs.readFile(path.join(logDir, f), 'utf8');
      }
      if (!rejected.test(log)) { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.match(log, rejected);
    assert.doesNotMatch(log, /Server error on route \/api\/v1\/(file-explorer|download|db)/);
  });
});

describe('POST /api/v1/db/rate-song — applies the caller\'s library access', () => {
  test('bob rating a track in a library he was not granted → 404 access message', async () => {
    const r = await api('POST', '/api/v1/db/rate-song', { filepath: '/private/x.mp3', rating: 5 }, bobJwt);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'User does not have access to path private');
  });

  test('unknown library → the same 404 (no longer "Library not found")', async () => {
    const r = await api('POST', '/api/v1/db/rate-song', { filepath: '/ghost/x.mp3', rating: 5 }, adminJwt);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, 'User does not have access to path ghost');
  });

  test('a granted track still rates (control)', async () => {
    const filepath = await firstTrack('/testlib/', bobJwt);
    const r = await api('POST', '/api/v1/db/rate-song', { filepath, rating: 5 }, bobJwt);
    assert.equal(r.status, 200, `${filepath}: ${JSON.stringify(r.body)}`);
  });
});
