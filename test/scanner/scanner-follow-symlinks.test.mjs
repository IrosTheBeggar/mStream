/**
 * V21: per-library `followSymlinks` flag (default false).
 *
 * Builds a tiny library with ONE real track and ONE symlink pointing
 * OUTSIDE the library root. Scans with the library default (false),
 * asserts the symlink target is NOT indexed. Flips the library's flag
 * to true via the admin endpoint, triggers a rescan, asserts the
 * symlink target IS now indexed. Flips it back to false, rescans,
 * asserts the outside-target is dropped again.
 *
 * Windows hosts without developer-mode symlink permissions skip the
 * test gracefully (creating a symlink throws EPERM).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FFMPEG = process.platform === 'win32'
  ? path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe')
  : path.join(REPO_ROOT, 'bin', 'ffmpeg', 'ffmpeg');

const ADMIN = { username: 'sym-admin', password: 'pw-sym' };

let server;
let libDir;     // where the library lives — scanner walks this
let outsideDir; // where the symlink target lives — scanner must NOT index
let token;
let symlinkWorks = false;

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`)));
  });
}

async function makeFlac(fullPath, title) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await runFfmpeg([
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-ac', '2', '-c:a', 'flac',
    '-metadata', `artist=Sym Test`,
    '-metadata', `title=${title}`,
    '-metadata', `album=Sym Album`,
    fullPath,
  ]);
}

async function adminToken() {
  if (token) { return token; }
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  token = (await r.json()).token;
  return token;
}

async function triggerRescan() {
  const tk = await adminToken();
  // force-rescan re-walks every file and re-evaluates per-library flags.
  await fetch(`${server.baseUrl}/api/v1/admin/db/scan/force-rescan`, {
    method: 'POST', headers: { 'x-access-token': tk },
  });
  // Wait briefly for the scan to START (the endpoint just queues tasks).
  // Without this, the next poll might see locked=false from the lull
  // between the queue-up and the first scanner spawn.
  await new Promise(r => setTimeout(r, 250));
  // Now wait until the scan reports idle. /db/status requires auth.
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const r = await fetch(`${server.baseUrl}/api/v1/db/status`, {
      headers: { 'x-access-token': tk },
    });
    if (r.ok) {
      const j = await r.json();
      if (!j.locked) { return j.totalFileCount; }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('rescan did not finish within 20s');
}

async function setLibraryFollowSymlinks(value) {
  const tk = await adminToken();
  await fetch(`${server.baseUrl}/api/v1/admin/directory/follow-symlinks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': tk },
    body: JSON.stringify({ vpath: 'symtest', followSymlinks: value }),
  });
}

before(async () => {
  if (!fsSync.existsSync(FFMPEG)) {
    throw new Error(`bundled ffmpeg missing at ${FFMPEG}`);
  }

  libDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-sym-lib-'));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-sym-out-'));

  // One file INSIDE the library.
  await makeFlac(path.join(libDir,     'inside.flac'), 'Inside Track');
  // One file OUTSIDE — only reachable if we follow the symlink.
  await makeFlac(path.join(outsideDir, 'outside.flac'), 'Outside Track');

  // Plant the symlink inside the library pointing to the outside file.
  try {
    await fs.symlink(path.join(outsideDir, 'outside.flac'),
                     path.join(libDir,    'linked.flac'));
    symlinkWorks = true;
  } catch (err) {
    // Windows without developer mode denies non-admin symlink creation.
    // Skip the whole suite rather than fake-pass.
    if (err.code === 'EPERM') {
      console.error('[test] symlink creation denied; skipping follow-symlinks suite');
      symlinkWorks = false;
    } else { throw err; }
  }

  server = await startServer({
    dlnaMode: 'disabled',
    users: [{ ...ADMIN, admin: true }],
    extraFolders: { symtest: libDir },
  });

  // Give admin access to both the default fixtures and our symtest
  // library (the harness creates users with vpaths: ['testlib'] by
  // default).
  await fetch(`${server.baseUrl}/api/v1/admin/users/vpaths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': await adminToken() },
    body: JSON.stringify({ username: ADMIN.username, vpaths: ['testlib', 'symtest'] }),
  });

  // waitForScanComplete in the harness returns as soon as the FIRST
  // library finishes (locked=false + totalFileCount>0 briefly between
  // serialized scans). Force an explicit rescan to guarantee symtest
  // has been walked before the first assertion runs.
  await triggerRescan();
});

after(async () => {
  if (server)     { await server.stop(); }
  if (libDir)     { await fs.rm(libDir,     { recursive: true, force: true }).catch(() => {}); }
  if (outsideDir) { await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {}); }
});

async function symtestTitles() {
  // Enumerate tracks the scanner indexed under the `symtest` vpath
  // via /db/search. Filter to titles whose filepath lives under the
  // symtest library so we don't pick up stray fixtures from
  // testlib.
  const tk = await adminToken();
  const r = await fetch(`${server.baseUrl}/api/v1/db/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': tk },
    body: JSON.stringify({ search: 'Track', noArtists: true, noAlbums: true, noFiles: true }),
  });
  const j = await r.json();
  const hits = (j.title || []).filter(s => (s.filepath || '').startsWith('symtest/'));
  // `name` is "Artist - Title"; extract just the title for assertions.
  return hits.map(s => s.name.replace(/^.*? - /, '')).sort();
}

describe('V21 per-library followSymlinks', () => {
  test('default (follow=false): symlink target is NOT indexed', async (t) => {
    if (!symlinkWorks) { t.skip('symlink creation denied on this host'); return; }
    const titles = await symtestTitles();
    assert.ok(titles.includes('Inside Track'), 'Inside Track must be indexed');
    assert.ok(!titles.includes('Outside Track'),
      `Outside Track must NOT be indexed with follow=false; got ${JSON.stringify(titles)}`);
  });

  test('per-library flag=true: rescan picks up the symlink', async (t) => {
    if (!symlinkWorks) { t.skip('symlink creation denied on this host'); return; }
    await setLibraryFollowSymlinks(true);
    await triggerRescan();
    const titles = await symtestTitles();
    assert.ok(titles.includes('Inside Track'));
    assert.ok(titles.includes('Outside Track'),
      `Outside Track must be indexed after flag=true; got ${JSON.stringify(titles)}`);
  });

  test('per-library flag=false: rescan drops the symlink target', async (t) => {
    if (!symlinkWorks) { t.skip('symlink creation denied on this host'); return; }
    await setLibraryFollowSymlinks(false);
    await triggerRescan();
    const titles = await symtestTitles();
    assert.ok(titles.includes('Inside Track'));
    assert.ok(!titles.includes('Outside Track'),
      `Outside Track must be dropped after flag=false; got ${JSON.stringify(titles)}`);
  });

  test('/api/v1/admin/directories surfaces the per-library state', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/admin/directories`, {
      headers: { 'x-access-token': await adminToken() },
    });
    const dirs = await r.json();
    assert.ok(dirs.symtest);
    // After the previous test set it back to false.
    assert.equal(dirs.symtest.followSymlinks, false,
      `expected false, got ${JSON.stringify(dirs.symtest.followSymlinks)}`);
  });
});
