#!/usr/bin/env node
// API error-code smoke: what the server answers for the CALLER's mistakes on
// the path- and name-taking routes, checked against a REAL server booted from
// this checkout.
//
// Companion to the integration suites that pin the same contracts
// deterministically (admin-path-validation, vpath-access-codes,
// explorer-missing-path, admin-users-codes). This harness adds what those
// deliberately avoid: the REAL home directory for `~`, hostile filesystem
// inputs (symlink loops, unreadable folders, an over-long name, a NUL byte),
// the routes that catch the resolver's errors themselves (which must stay
// unchanged), a library add → scan → browse → serve → delete lifecycle with
// the reboot a delete triggers, and a grep of the server log for crash lines.
//
// USAGE
//   npm run test:smoke:api-errors        (= node test/smoke/api-error-codes-smoke.mjs)
//
// NEEDS
//   Node only, plus the fixture library (built once by `npm test`'s pretest;
//   that needs ffmpeg at bin/ffmpeg the first time). No external daemons.
//
// WHAT IT DOES
//   Boots a throwaway server through test/helpers/server.mjs (fresh temp data
//   dir, free port, writeLogs on) with an admin and a non-admin, adds a
//   library nobody was granted and one granted to both, runs ~110 checks and
//   prints a table. Exit 1 on any mismatch. Everything it creates lives in
//   temp dirs. The EACCES legs skip as root and on Windows; the symlink legs
//   skip where symlinks cannot be created. It READS `~` but never writes to
//   it; the one `~/…` library it adds (only when the fixture tree is under
//   the home directory) points at the fixture tree and is removed again.
//
// The answers being checked (all 4xx with a reason, never a bare 500):
//   - admin file explorer / library add: `~` expansion, absolute-existing
//     roots, fs errors mapped to 404/400, 409 duplicate vpath, 404 unknown;
//   - the vpath resolver: an ungranted or unknown library is the SAME 404
//     (existence not revealed), on every route that resolves a path;
//   - user-facing explorer/download routes: a missing or unreadable path is
//     404/400 with the caller's VIRTUAL path, never the library's root;
//   - rate-song applies the caller's library access;
//   - user management: duplicate username 409, unknown 404;
//   - routes with their own catch keep their historical answers.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const HOME = os.homedir();
const NUL = String.fromCharCode(0);
const POSIX_NONROOT = process.platform !== 'win32' && process.getuid?.() !== 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ADMIN = { username: 'admin', password: 'pw-admin' };
const BOB   = { username: 'bob',   password: 'pw-bob' };
const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]).toString('base64');

// ── scratch filesystem (all under one temp dir) ────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-api-smoke-'));
const P = (...p) => path.join(tmp, ...p);
for (const d of ['private', 'shared/sub', 'shared/temp', 'shared/locked', 'hostile/unicode dir ✓/sub', 'hostile/noaccess', 'hostile/parent000/child', 'lib-a', 'lib-b', 'dele']) {
  await fs.mkdir(P(d), { recursive: true });
}
await fs.writeFile(P('private', 'secret.mp3'), 'x');
await fs.writeFile(P('shared', 'song.mp3'), 'x');
await fs.writeFile(P('shared', 'sub', 'x.mp3'), 'x');
await fs.writeFile(P('shared', 'list.m3u'), ['sub/x.mp3', 'song.mp3', ''].join('\n'));
await fs.writeFile(P('hostile', 'file.txt'), 'x');
await fs.writeFile(P('lib-a', 'dummy.mp3'), 'x');
let symlinksOk = true;
try {
  await fs.symlink('loop', P('shared', 'loop'));
  await fs.symlink('loop', P('hostile', 'loop'));
  await fs.symlink(P('lib-a'), P('link-dir'));
  await fs.symlink(path.join(tmp, 'definitely', 'not', 'here'), P('lib-a', 'dangling'));
} catch { symlinksOk = false; }
const lockedDirs = [P('shared', 'locked'), P('hostile', 'noaccess'), P('hostile', 'parent000')];
if (POSIX_NONROOT) { for (const d of lockedDirs) { await fs.chmod(d, 0o000); } }

// ── server ─────────────────────────────────────────────────────────────
const server = await startServer({
  dlnaMode: 'disabled',
  extraConfig: { writeLogs: true },
  users: [ { ...ADMIN, admin: true, vpaths: ['testlib'] }, { ...BOB, admin: false, vpaths: ['testlib'] } ],
});
const login = async u => (await (await fetch(`${server.baseUrl}/api/v1/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) })).json()).token;
let adminJwt = await login(ADMIN);
const bobJwt = await login(BOB);

async function call(method, route, body, jwt = adminJwt, extraHeaders = {}, rawBody = false) {
  const headers = { ...extraHeaders };
  if (!rawBody) { headers['Content-Type'] = 'application/json'; }
  if (jwt) { headers['x-access-token'] = jwt; }
  const r = await fetch(`${server.baseUrl}${route}`, { method, headers,
    body: body === undefined ? undefined : (rawBody ? body : JSON.stringify(body)) });
  const ct = r.headers.get('content-type') || '';
  if (!/json|text|html/.test(ct)) { const buf = await r.arrayBuffer(); return { status: r.status, body: `<${ct} ${buf.byteLength} bytes>`, ct }; }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, ct };
}
const adminExplore = body => call('POST', '/api/v1/admin/file-explorer', body, adminJwt);
const explore  = (dir, jwt = bobJwt, extra = {}) => call('POST', '/api/v1/file-explorer', { directory: dir, ...extra }, jwt);
const put      = body => call('PUT', '/api/v1/admin/directory', body, adminJwt);
const del      = body => call('DELETE', '/api/v1/admin/directory', body, adminJwt);
const symlinks = body => call('POST', '/api/v1/admin/directory/follow-symlinks', body, adminJwt);
const libs     = () => call('GET', '/api/v1/admin/directories', undefined, adminJwt);
const rate     = (filepath, rating, jwt = bobJwt) => call('POST', '/api/v1/db/rate-song', { filepath, rating }, jwt);
const ACCESS   = v => `User does not have access to path ${v}`;
const REJECT   = '"directory" must be an absolute path that exists';
const noLeak   = b => !JSON.stringify(b).includes(tmp) && !JSON.stringify(b).includes(server.musicDir);

// ── runner ─────────────────────────────────────────────────────────────
const rows = [];
let n = 0;
const section = t => rows.push({ section: t });
async function check(label, fn, expect, pred) {
  let r; try { r = await fn(); } catch (e) { r = { status: 'ERR', body: e.message }; }
  let ok = r.status === expect, note = '';
  if (ok && pred) { try { ok = !!pred(r.body, r); if (!ok) { note = 'body predicate failed'; } } catch (e) { ok = false; note = e.message; } }
  rows.push({ n: ++n, ok, label, expect, got: r.status, short: (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 96), note });
  return r;
}
const skip = (label, why) => rows.push({ n: ++n, ok: true, label, expect: 'skip', got: '-', short: why, note: '' });
const info = (label, text) => rows.push({ n: ++n, ok: true, label, expect: 'info', got: '-', short: text, note: '' });
async function firstTrack(dir, jwt, depth = 0) {
  const r = await explore(dir, jwt);
  if (r.status !== 200) { throw new Error(`firstTrack ${dir}: ${r.status} ${JSON.stringify(r.body)}`); }
  if (r.body.files?.length) { return `${r.body.path}${r.body.files[0].name}`; }
  if (depth > 4 || !r.body.directories?.length) { throw new Error(`no track under ${dir}`); }
  return firstTrack(`${r.body.path}${r.body.directories[0].name}/`, jwt, depth + 1);
}
async function waitScanIdle(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await call('GET', '/api/v1/scan/status');
    const q = st.body?.queue || {};
    if (st.status === 200 && !q.scanning && q.activeTask !== 'scan' && !(q.queued || []).includes('scan')) { return true; }
    await sleep(200);
  }
  return false;
}

try {
  const relFixtures = path.relative(HOME, server.musicDir);
  const fixturesUnderHome = relFixtures && !relFixtures.startsWith('..') && !path.isAbsolute(relFixtures);
  const homeLibPath = fixturesUnderHome ? '~/' + relFixtures.split(path.sep).join('/') : null;
  const tracksBefore = (await call('GET', '/api/v1/db/status')).body?.totalFileCount || 0;

  // ── A. admin file explorer ──────────────────────────────────────────
  section('POST /api/v1/admin/file-explorer (admin; real HOME)');
  const home = await check('~ → real home', () => adminExplore({ directory: '~' }), 200, b => b.path === HOME);
  const firstHomeDir = home.body?.directories?.[0]?.name;
  await check('~/ (trailing slash) → home', () => adminExplore({ directory: '~/' }), 200, b => b.path === HOME);
  if (firstHomeDir) {
    await check(`~/${firstHomeDir} → home + the rest`, () => adminExplore({ directory: `~/${firstHomeDir}` }), 200, b => b.path === path.join(HOME, firstHomeDir));
    await check(`~\\${firstHomeDir} (backslash form) → same`, () => adminExplore({ directory: `~\\${firstHomeDir}` }), 200, b => b.path === path.join(HOME, firstHomeDir));
    await check('webapp flow: path from the ~ answer + joinDirectory', () => adminExplore({ directory: home.body.path, joinDirectory: firstHomeDir }), 200, b => b.path === path.join(HOME, firstHomeDir));
  } else { skip('~/<subdir> forms', 'home directory has no subdirectories'); }
  await check('~/../ → normalised parent of home', () => adminExplore({ directory: '~/../' }), 200, b => b.path === path.join(HOME, '../'));
  await check('/ (filesystem root) → 200', () => adminExplore({ directory: path.parse(HOME).root }), 200, b => b.directories.length > 0);
  await check('unicode + spaces dir → 200', () => adminExplore({ directory: P('hostile', 'unicode dir ✓') }), 200, b => b.directories[0]?.name === 'sub');
  if (symlinksOk) { await check('dir with a dangling symlink entry → 200 (entry skipped)', () => adminExplore({ directory: P('lib-a') }), 200, b => b.directories.length === 0); }
  await check('~/definitely-not-here → 404 ENOENT', () => adminExplore({ directory: '~/definitely-not-here' }), 404, b => /\(ENOENT\)$/.test(b.error));
  await check('~alice (not expanded, relative) → 404 ENOENT', () => adminExplore({ directory: '~alice' }), 404, b => /\(ENOENT\)$/.test(b.error));
  await check('regular file → 404 ENOTDIR', () => adminExplore({ directory: P('hostile', 'file.txt') }), 404, b => /\((ENOTDIR|ENOENT)\)$/.test(b.error));
  if (POSIX_NONROOT) { await check('chmod-000 dir → 400 EACCES', () => adminExplore({ directory: P('hostile', 'noaccess') }), 400, b => /\(EACCES\)$/.test(b.error)); } else { skip('chmod-000 dir → 400 EACCES', 'root or Windows'); }
  if (symlinksOk) { await check('symlink loop → 400 ELOOP', () => adminExplore({ directory: P('hostile', 'loop') }), 400, b => /\(ELOOP\)$/.test(b.error)); } else { skip('symlink loop → 400 ELOOP', 'symlinks unavailable'); }
  await check('300-char component → 400 ENAMETOOLONG', () => adminExplore({ directory: P('hostile', 'a'.repeat(300)) }), 400, b => /\(ENAMETOOLONG\)$/.test(b.error));
  await check('NUL byte → 400 ERR_INVALID_ARG_VALUE', () => adminExplore({ directory: P('hostile', NUL + 'x') }), 400, b => /\(ERR_INVALID_ARG_VALUE\)$/.test(b.error));
  await check('empty string → 400 (Joi)', () => adminExplore({ directory: '' }), 400);
  await check('empty body → 400 (Joi)', () => adminExplore({}), 400);
  await check('directory: 123 → 400 (Joi)', () => adminExplore({ directory: 123 }), 400);

  // ── B. library add / follow-symlinks ────────────────────────────────
  section('PUT /api/v1/admin/directory + follow-symlinks (admin)');
  await check('relative code/music → 400', () => put({ directory: 'code/music', vpath: 'r1' }), 400, b => b.error.startsWith(REJECT) && /not an absolute path/.test(b.error));
  await check('relative ./music → 400', () => put({ directory: './music', vpath: 'r2' }), 400, b => /not an absolute path/.test(b.error));
  await check('C:\\Music (foreign-platform form) → 400', () => put({ directory: 'C:\\Music', vpath: 'r3' }), 400, b => b.error.startsWith(REJECT));
  await check('~alice/Music → 400', () => put({ directory: '~alice/Music', vpath: 'r4' }), 400, b => /not an absolute path/.test(b.error));
  await check('absolute path that does not exist → 400 ENOENT', () => put({ directory: P('definitely-missing'), vpath: 'r5' }), 400, b => /\(ENOENT\)$/.test(b.error));
  await check('~/definitely-missing → 400 ENOENT', () => put({ directory: '~/definitely-missing', vpath: 'r6' }), 400, b => /\(ENOENT\)$/.test(b.error));
  await check('regular file → 400 not a directory', () => put({ directory: P('hostile', 'file.txt'), vpath: 'r7' }), 400, b => /not a directory/.test(b.error));
  if (POSIX_NONROOT) { await check('child of a chmod-000 parent → 400 EACCES', () => put({ directory: P('hostile', 'parent000', 'child'), vpath: 'r8' }), 400, b => /\(EACCES\)$/.test(b.error)); } else { skip('child of a chmod-000 parent → 400 EACCES', 'root or Windows'); }
  await check('NUL byte → 400', () => put({ directory: P('hostile', NUL + 'x'), vpath: 'r9' }), 400, b => b.error.startsWith(REJECT));
  await check('empty directory → 400 (Joi)', () => put({ directory: '', vpath: 'r10' }), 400);
  await check('missing vpath → 400 (Joi)', () => put({ directory: P('lib-a') }), 400);
  await check('vpath "bad name" → 400 (Joi, before the path check)', () => put({ directory: P('lib-a'), vpath: 'bad name' }), 400);
  await check('nothing was added by the rejections', libs, 200, b => Object.keys(b).join() === 'testlib');
  await check('good absolute dir → 200 (smokeA)', () => put({ directory: P('lib-a'), vpath: 'smokeA' }), 200);
  if (symlinksOk) { await check('symlink-to-dir root → 200 (stat follows)', () => put({ directory: P('link-dir'), vpath: 'smokeLink' }), 200); }
  await check('trailing-slash root → 200, stored as given (smokeB)', () => put({ directory: P('lib-b') + path.sep, vpath: 'smokeB' }), 200);
  await check('private (no autoAccess) → 200', () => put({ directory: P('private'), vpath: 'private' }), 200);
  await check('shared (autoAccess) → 200', () => put({ directory: P('shared'), vpath: 'shared', autoAccess: true }), 200);
  await check('dele (for the delete/reboot leg) → 200', () => put({ directory: P('dele'), vpath: 'dele' }), 200);
  if (homeLibPath) { await check(`${homeLibPath} (the fixture tree via ~, autoAccess) → 200`, () => put({ directory: homeLibPath, vpath: 'homelib', autoAccess: true }), 200); } else { skip('~/… library add', 'fixture tree is not under the home directory'); }
  await check('stored roots: as given, and the ~ one expanded', libs, 200, b =>
    b.smokeA.root === P('lib-a') && b.smokeB.root === P('lib-b') + path.sep && (!homeLibPath || b.homelib.root === server.musicDir));
  await check('duplicate vpath, valid dir → 409', () => put({ directory: P('lib-b'), vpath: 'smokeA' }), 409, b => b.error === "'smokeA' already exists");
  await check('duplicate vpath, bad dir → 400 (path check runs first)', () => put({ directory: P('nope'), vpath: 'smokeA' }), 400, b => /\(ENOENT\)$/.test(b.error));
  await check('smokeA root untouched after the 409', libs, 200, b => b.smokeA.root === P('lib-a'));
  await check('follow-symlinks unknown vpath → 404', () => symlinks({ vpath: 'ghost', followSymlinks: true }), 404, b => b.error === "'ghost' not found");
  await check('follow-symlinks known vpath → 200', () => symlinks({ vpath: 'smokeA', followSymlinks: true }), 200);
  await check('flag visible in GET directories', libs, 200, b => b.smokeA.followSymlinks === true);
  await check('follow-symlinks missing flag → 400 (Joi)', () => symlinks({ vpath: 'smokeA' }), 400);

  // ── C. lifecycle of the ~-added library ─────────────────────────────
  section('the ~-added library is real: scanned, browsable, served');
  if (homeLibPath) {
    const idle = await waitScanIdle();
    const tracksAfter = (await call('GET', '/api/v1/db/status')).body?.totalFileCount || 0;
    info(`scan queue idle: ${idle}; totalFileCount ${tracksBefore} → ${tracksAfter}`, tracksAfter > tracksBefore ? 'homelib indexed' : 'no growth observed');
    await check('regular explorer lists /homelib/ from the stored root', () => explore('/homelib/', adminJwt), 200, b => (b.files?.length || 0) + (b.directories?.length || 0) > 0);
    let file = null;
    try { file = await firstTrack('/homelib/', adminJwt); } catch { /* handled below */ }
    if (file) {
      const url = '/media' + file.split('/').map(encodeURIComponent).join('/');
      await check('GET /media/homelib/… serves bytes (express.static mount got the expanded root)', () => call('GET', url, undefined, adminJwt), 200, b => typeof b === 'string' && b.length > 0);
    } else { rows.push({ n: ++n, ok: false, label: 'no audio file found under /homelib/', expect: 200, got: '-', short: '', note: '' }); }
  } else { skip('lifecycle of the ~-added library', 'fixture tree is not under the home directory'); }

  // ── D. the resolver: ungranted or unknown library ───────────────────
  section('vpath resolver as bob (non-admin): ungranted or unknown library is the same 404');
  const r1 = await check('/private/ (exists, not granted) → 404 access message', () => explore('/private/'), 404, b => b.error === ACCESS('private'));
  const r2 = await check('/ghost/ (does not exist) → 404, same message shape', () => explore('/ghost/'), 404, b => b.error === ACCESS('ghost'));
  rows.push({ n: ++n, ok: r1.status === r2.status && String(r1.body?.error).replace('private', '#') === String(r2.body?.error).replace('ghost', '#'),
    label: 'no-leak: ungranted and nonexistent are indistinguishable', expect: 'same', got: 'same', short: '', note: '' });
  await check('/testlib/ (granted) → 200', () => explore('/testlib/'), 200, b => b.path === '/testlib/');
  await check('/shared/ (granted via autoAccess) → 200', () => explore('/shared/'), 200, b => b.files.some(f => f.name === 'song.mp3'));
  await check('~ (several libraries) → 200 root listing without private', () => explore('~'), 200, b => b.path === '/' && !b.directories.some(d => d.name === 'private'));
  await check('/private (no trailing slash) → 404', () => explore('/private'), 404, b => b.error === ACCESS('private'));
  await check('/PRIVATE/ (case differs) → 404', () => explore('/PRIVATE/'), 404, b => b.error === ACCESS('PRIVATE'));
  await check('/private/../testlib/ normalises into a granted library → 200', () => explore('/private/../testlib/'), 200, b => b.path === '/testlib/');
  await check('/../../etc/ traversal → 404, not 500', () => explore('/../../etc/'), 404, b => /does not have access/.test(b.error));
  await check('/testlib/../../etc/passwd traversal → 404, not 500', () => explore('/testlib/../../etc/passwd'), 404, b => /does not have access/.test(b.error));
  await check('admin (real user, not granted private) → 404 access message', () => explore('/private/', adminJwt), 404, b => b.error === ACCESS('private'));
  await check('no token → 401', () => explore('/private/', null), 401);
  await check('POST /file-explorer/recursive /private/ → 404', () => call('POST', '/api/v1/file-explorer/recursive', { directory: '/private/' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /file-explorer/mkdir under /private/ → 404', () => call('POST', '/api/v1/file-explorer/mkdir', { directory: '/private/newdir' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /file-explorer/mkdir under /shared/ → 200 (control)', () => call('POST', '/api/v1/file-explorer/mkdir', { directory: '/shared/smoke-dir' }, bobJwt), 200);
  await check('POST /file-explorer/upload to /private/ → 404', () => call('POST', '/api/v1/file-explorer/upload', 'x', bobJwt, { 'data-location': '/private/x.mp3', 'Content-Type': 'application/octet-stream' }, true), 404, b => b.error === ACCESS('private'));
  await check('POST /file-explorer/m3u in /private/ → 404', () => call('POST', '/api/v1/file-explorer/m3u', { path: '/private/list.m3u' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /download/m3u in /private/ → 404', () => call('POST', '/api/v1/download/m3u', { path: '/private/list.m3u' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /download/directory /private/ → 404', () => call('POST', '/api/v1/download/directory', { directory: '/private/' }, bobJwt), 404, b => b.error === ACCESS('private'));
  const granted = await firstTrack('/testlib/', bobJwt);
  const grantedDir = granted.slice(0, granted.lastIndexOf('/') + 1);
  await check('POST /download/directory granted album → 200 zip (control)', () => call('POST', '/api/v1/download/directory', { directory: grantedDir }, bobJwt), 200, (b, r) => /zip/.test(r.ct));
  await check('POST /download/zip [private, granted] → 200 zip; the ungranted entry is skipped (own catch)', () => call('POST', '/api/v1/download/zip', { fileArray: JSON.stringify(['/private/secret.mp3', granted]) }, bobJwt), 200, (b, r) => /zip/.test(r.ct));
  await check('POST /album-art/upload for /private/ → 404 (catch honours WebError)', () => call('POST', '/api/v1/album-art/upload', { filepath: '/private/secret.mp3', image: fakePng }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /lastfm/scrobble-by-filepath for /private/ → 404', () => call('POST', '/api/v1/lastfm/scrobble-by-filepath', { filePath: '/private/secret.mp3' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('POST /ytdl/ into /private/ → 404 (before any download)', () => call('POST', '/api/v1/ytdl/', { directory: '/private/', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, bobJwt), 404, b => b.error === ACCESS('private'));
  await check('GET /db/waveform for /private/ → 403 access denied (own catch, unchanged)', () => call('GET', `/api/v1/db/waveform?filepath=${encodeURIComponent('/private/secret.mp3')}`, undefined, bobJwt), 403, b => b.error === 'access denied');
  await check('GET /transcode/private/secret.mp3 → 404 file not found (own catch, unchanged)', () => call('GET', '/transcode/private/secret.mp3', undefined, bobJwt), 404, b => b.error === 'file not found');
  await check('GET /torrent/preflight?path=/private/x → 200 with reason = the access message', () => call('GET', `/api/v1/torrent/preflight?path=${encodeURIComponent('/private/x')}`, undefined, bobJwt), 200, b => b.reason === ACCESS('private'));
  await check('POST /server-playback/play (admin, ungranted file) → 400 with the message (own catch)', () => call('POST', '/api/v1/server-playback/play', { file: '/private/secret.mp3' }, adminJwt), 400, b => b.error === ACCESS('private'));

  // ── E. rate-song ────────────────────────────────────────────────────
  section('POST /api/v1/db/rate-song applies the caller\'s library access');
  await check('bob on a track in a library he was not granted → 404 access', () => rate('/private/secret.mp3', 5), 404, b => b.error === ACCESS('private'));
  await check('bob on an unknown library → the same 404', () => rate('/ghost/x.mp3', 5), 404, b => b.error === ACCESS('ghost'));
  await check('admin (not granted private) → 404 access', () => rate('/private/secret.mp3', 5, adminJwt), 404, b => b.error === ACCESS('private'));
  await check('bob rates a granted track 7 → 200', () => rate(granted, 7), 200);
  await check('the rating is visible in explorer metadata', () => explore(grantedDir, bobJwt, { pullMetadata: true }), 200, b => b.files.find(x => `${b.path}${x.name}` === granted)?.metadata?.metadata?.rating === 7);
  await check('bob clears the rating (null) → 200', () => rate(granted, null), 200);
  await check('granted library, file not in the DB → 404 File Not Found (unchanged)', () => rate('/testlib/does-not-exist.mp3', 5), 404, b => b.error === 'File Not Found');
  await check('rating 11 → 400 (Joi)', () => rate(granted, 11), 400);
  await check('no token → 401', () => rate(granted, 5, null), 401);

  // ── F. user-facing routes: missing or unreadable path ───────────────
  section('user path routes (bob on the granted library `shared`): fs errors are 404/400 with the VIRTUAL path');
  await check('missing folder → 404 ENOENT, no root on disk in the message', () => explore('/shared/no-such/'), 404, b => b.error === 'Cannot read directory "/shared/no-such/" (ENOENT)' && noLeak(b));
  await check('file as folder → 404 ENOTDIR', () => explore('/shared/song.mp3/'), 404, b => /"\/shared\/song\.mp3\/" \((ENOTDIR|ENOENT)\)$/.test(b.error) && noLeak(b));
  if (POSIX_NONROOT) { await check('chmod-000 folder → 400 EACCES', () => explore('/shared/locked/'), 400, b => b.error === 'Cannot read directory "/shared/locked/" (EACCES)'); } else { skip('chmod-000 folder → 400 EACCES', 'root or Windows'); }
  if (symlinksOk) { await check('symlink loop → 400 ELOOP', () => explore('/shared/loop/'), 400, b => /\(ELOOP\)$/.test(b.error)); } else { skip('symlink loop → 400 ELOOP', 'symlinks unavailable'); }
  await check('300-char component → 400 ENAMETOOLONG', () => explore('/shared/' + 'a'.repeat(300) + '/'), 400, b => /\(ENAMETOOLONG\)$/.test(b.error));
  await check('NUL byte → 400 ERR_INVALID_ARG_VALUE', () => explore('/shared/' + NUL + 'x/'), 400, b => /\(ERR_INVALID_ARG_VALUE\)$/.test(b.error));
  await check('list a folder, delete it on disk, list again → 404', async () => {
    const first = await explore('/shared/temp/'); if (first.status !== 200) { return first; }
    await fs.rm(P('shared', 'temp'), { recursive: true });
    return explore('/shared/temp/');
  }, 404, b => b.error === 'Cannot read directory "/shared/temp/" (ENOENT)');
  await check('/shared/sub/ → 200 (control)', () => explore('/shared/sub/'), 200, b => b.files[0]?.name === 'x.mp3');
  await check('granted album with pullMetadata → 200 (the wrapped call still batches metadata)', () => explore(grantedDir, bobJwt, { pullMetadata: true }), 200, b => b.files.every(f => 'metadata' in f));
  await check('missing folder in a library bob lacks → 404 ACCESS message (resolver wins)', () => explore('/private/no-such/'), 404, b => b.error === ACCESS('private'));
  await check('recursive: missing folder → 404 ENOENT', () => call('POST', '/api/v1/file-explorer/recursive', { directory: '/shared/no-such/' }, bobJwt), 404, b => b.error === 'Cannot read directory "/shared/no-such/" (ENOENT)');
  await check('recursive: /shared/ → 200 listing (an unreadable subfolder is skipped, not fatal)', () => call('POST', '/api/v1/file-explorer/recursive', { directory: '/shared/' }, bobJwt), 200, b => Array.isArray(b) && b.some(p => /shared\/sub\/x\.mp3$/.test(p)));
  await check('explorer m3u: missing playlist → 404 ENOENT', () => call('POST', '/api/v1/file-explorer/m3u', { path: '/shared/no-such.m3u' }, bobJwt), 404, b => b.error === 'Cannot read playlist "/shared/no-such.m3u" (ENOENT)');
  await check('explorer m3u: folder as playlist → 404 EISDIR', () => call('POST', '/api/v1/file-explorer/m3u', { path: '/shared/sub' }, bobJwt), 404, b => /\(EISDIR\)$/.test(b.error));
  await check('explorer m3u: no path → 400 (validation)', () => call('POST', '/api/v1/file-explorer/m3u', {}, bobJwt), 400);
  await check('explorer m3u: real playlist → 200 with its entries (control)', () => call('POST', '/api/v1/file-explorer/m3u', { path: '/shared/list.m3u' }, bobJwt), 200, b => Array.isArray(b.files) && b.files.length === 2);
  await check('download/directory: missing folder → 404 ENOENT', () => call('POST', '/api/v1/download/directory', { directory: '/shared/no-such/' }, bobJwt), 404, b => b.error === 'Cannot read directory "/shared/no-such/" (ENOENT)');
  await check('download/directory: a file → 400 Not A Directory (unchanged branch)', () => call('POST', '/api/v1/download/directory', { directory: '/shared/song.mp3' }, bobJwt), 400, b => b.error === 'Not A Directory');
  await check('download/directory: /shared/sub/ → 200 zip (control)', () => call('POST', '/api/v1/download/directory', { directory: '/shared/sub/' }, bobJwt), 200, (b, r) => /zip/.test(r.ct));
  await check('download/m3u: missing playlist → 404 ENOENT', () => call('POST', '/api/v1/download/m3u', { path: '/shared/no-such.m3u' }, bobJwt), 404, b => b.error === 'Cannot read playlist "/shared/no-such.m3u" (ENOENT)');
  await check('download/m3u: folder as playlist → 404 EISDIR', () => call('POST', '/api/v1/download/m3u', { path: '/shared/sub' }, bobJwt), 404, b => /\(EISDIR\)$/.test(b.error));
  await check('download/m3u: real playlist → 200 zip (control)', () => call('POST', '/api/v1/download/m3u', { path: '/shared/list.m3u' }, bobJwt), 200, (b, r) => /zip/.test(r.ct));
  await check('admin explorer on the same missing folder → 404 with the ABSOLUTE path (admins see the filesystem)', () => adminExplore({ directory: P('shared', 'no-such') }), 404, b => b.error === `Cannot read directory "${P('shared', 'no-such')}" (ENOENT)`);

  // ── G. user management ──────────────────────────────────────────────
  section('admin user management: duplicate username 409, unknown 404');
  await check('PUT /admin/users with an existing username → 409', () => call('PUT', '/api/v1/admin/users', { username: 'bob', password: 'x', vpaths: ['testlib'] }), 409, b => b.error === "'bob' already exists");
  for (const [label, method, route, body] of [
    ['DELETE /admin/users',              'DELETE', '/api/v1/admin/users',                { username: 'ghost' }],
    ['POST /admin/users/password',       'POST',   '/api/v1/admin/users/password',       { username: 'ghost', password: 'x' }],
    ['POST /admin/users/lastfm',         'POST',   '/api/v1/admin/users/lastfm',         { username: 'ghost', lastfmUser: 'x', lastfmPassword: 'y' }],
    ['POST /admin/users/vpaths',         'POST',   '/api/v1/admin/users/vpaths',         { username: 'ghost', vpaths: ['testlib'] }],
    ['POST /admin/users/access',         'POST',   '/api/v1/admin/users/access',         { username: 'ghost', admin: false, allowMkdir: true, allowUpload: true }],
    ['POST /admin/users/torrent-access', 'POST',   '/api/v1/admin/users/torrent-access', { username: 'ghost', allowTorrent: true }],
  ]) {
    await check(`${label} for an unknown user → 404`, () => call(method, route, body), 404, b => b.error === "'ghost' does not exist");
  }
  await check('POST /admin/users/vpaths for a real user → 200 (control)', () => call('POST', '/api/v1/admin/users/vpaths', { username: 'bob', vpaths: ['testlib', 'shared'] }), 200);
  await check('GET /admin/users still lists both users', () => call('GET', '/api/v1/admin/users'), 200, b => 'bob' in b && 'admin' in b);

  // ── H. library delete + the reboot it triggers ──────────────────────
  section('DELETE /api/v1/admin/directory');
  await check('unknown vpath → 404', () => del({ vpath: 'ghost' }), 404, b => b.error === "'ghost' not found");
  await check('"../x" (unanchored delete pattern) → 404, not 500', () => del({ vpath: '../x' }), 404);
  await check('server still serving right after the 404s (no reboot)', libs, 200, b => 'dele' in b);
  await check('known vpath dele → 200 (this path reboots the server)', () => del({ vpath: 'dele' }), 200);
  let back = false;
  for (let i = 0; i < 300 && !back; i++) {
    try {
      const r = await call('GET', '/api/v1/admin/directories');
      if (r.status === 200) { back = true; break; }
      if (r.status === 401 || r.status === 403) { adminJwt = await login(ADMIN); }
    } catch { /* rebooting */ }
    await sleep(200);
  }
  await check('server back after the reboot; dele gone, the rest intact', libs, 200, b => !('dele' in b) && 'smokeA' in b && 'shared' in b);
  if (homeLibPath) {
    await check('cleanup: DELETE homelib → 200 (second reboot)', () => del({ vpath: 'homelib' }), 200);
    for (let i = 0; i < 300; i++) { try { if ((await call('GET', '/api/v1/admin/directories')).status === 200) { break; } } catch { /* rebooting */ } await sleep(200); }
  }

  // ── I. auth ordering ────────────────────────────────────────────────
  section('auth: guard ordering unchanged');
  await check('bob (non-admin): admin file-explorer → 403 Admin access required', () => call('POST', '/api/v1/admin/file-explorer', { directory: '~' }, bobJwt), 403, b => b.error === 'Admin access required');
  await check('bob (non-admin): PUT bad path → 403 (auth before validation)', () => call('PUT', '/api/v1/admin/directory', { directory: 'code/music', vpath: 'x' }, bobJwt), 403);
  await check('bob (non-admin): PUT duplicate user → 403 (auth before the 409)', () => call('PUT', '/api/v1/admin/users', { username: 'bob', password: 'x', vpaths: [] }, bobJwt), 403);
  await check('no token: admin file-explorer → 401', () => call('POST', '/api/v1/admin/file-explorer', { directory: '~' }, null), 401);
} catch (e) {
  rows.push({ n: ++n, ok: false, label: `HARNESS EXCEPTION: ${e.stack || e.message}`, expect: '-', got: '-', short: '', note: '' });
} finally {
  await sleep(300);   // let the file transport flush
  const logDir = path.join(server.tmpDir, 'logs');
  let log = '';
  for (const f of await fs.readdir(logDir).catch(() => [])) { log += await fs.readFile(path.join(logDir, f), 'utf8'); }
  const crashes = log.split('\n').filter(l => l.includes('Server error on route'));
  const rejected = log.split('\n').filter(l => /Rejected (POST|GET|PUT|DELETE) \/api\/v1\//.test(l));
  const redact = s => s.replaceAll(tmp, '$TMP').replaceAll(server.musicDir, '$FIXTURES').replaceAll(HOME, '~');
  console.log(`server ${server.baseUrl}   HOME=${HOME}   scratch=${tmp}\n`);
  for (const r of rows) {
    if (r.section) { console.log(`\n== ${r.section} ==`); continue; }
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${String(r.n).padStart(3)}  ${r.label.padEnd(92)} ${String(r.got).padStart(4)} (exp ${r.expect})  ${redact(r.short)}${r.note ? '  <-- ' + r.note : ''}`);
  }
  const all = rows.filter(r => !r.section);
  const failed = all.filter(r => !r.ok);
  const skipped = all.filter(r => r.expect === 'skip');
  console.log(`\n${all.length} checks, ${failed.length} failed, ${skipped.length} skipped`);
  console.log(`log: ${crashes.length} "Server error on route" line(s); ${rejected.length} warn-level rejections`);
  for (const l of crashes) { console.log('  CRASH: ' + redact(l).slice(0, 220)); }
  await server.stop();
  if (POSIX_NONROOT) { for (const d of lockedDirs) { await fs.chmod(d, 0o755).catch(() => {}); } }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
}
