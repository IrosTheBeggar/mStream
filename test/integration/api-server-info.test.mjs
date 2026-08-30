/**
 * The layered GET /api/ endpoint (src/api/server-info.js) — the auth matrix.
 *
 * The endpoint sits BEHIND the auth wall, and the tokenless 401 is a
 * CLIENT-FACING CONTRACT: third-party mobile apps probe /api/ (as they
 * always probed ping) with no token and read 401 as "show the login
 * form" / 200 as "public server". This suite pins that plus the full
 * layer matrix against real spawned servers:
 *
 *  - users-server, no credentials  → 401 (the login-detection signal —
 *    NEVER an anonymous 200; #932 briefly broke this);
 *  - present-but-invalid token     → 401;
 *  - plain user                    → base (`server`, `apiVersions`, the
 *    capability `features` — no `subsonic`, removed) + `user` (the
 *    caller-scoped half of the ping payload), no `admin`;
 *  - admin user                    → base + `user` + `admin`;
 *  - ping parity                   → /api/'s `user` object equals
 *    /api/v1/ping's body (minus playlists / identity fields) — the
 *    drift-lock on the shared payload builder;
 *  - share token                   → 401 (shares fetch a playlist, they
 *    are not a session — the wall's path gating covers /api/ like ping);
 *  - federation key                → base + `user` scoped to the key's
 *    grants, `federation: true`, never `admin` — the mobile-app
 *    "version and capabilities over federation" deliverable;
 *  - federation allowlist          → /api/ allowed, but ping (and every
 *    other unlisted route) still 403s — adding /api loosened nothing;
 *  - bogus federation key          → 401;
 *  - jukebox JWT, dead session     → 401 (correctly signed is not enough);
 *  - disclosure pins               → users-table columns (password, salt,
 *    scrobbler credentials, …) and the fed user's internal fields are
 *    asserted ABSENT from the response by name;
 *  - public mode (no users)        → user + admin layers, matching how
 *    public mode behaves everywhere else (deliberate — public mode IS
 *    admin on every other route; lockAdmin is the hardening lever);
 *  - public mode + lockAdmin       → demoted user layer, no admin layer;
 *  - REAL admin + lockAdmin        → user.admin stays true (identity),
 *    but a locked admin API serves NO admin params — the layer's absence
 *    beside user.admin=true is how a client tells "locked" from "not an
 *    admin" (two boots on one data dir: the lock refuses the admin API,
 *    so the account must predate it).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { startServer } from '../helpers/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function pollReady(base, getExitCode, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getExitCode() !== null) { throw new Error(`server exited with code ${getExitCode()}`); }
    try {
      const r = await fetch(`${base}/api/`);
      if (r.status < 500) { return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server never became ready within ${timeoutMs}ms`);
}

describe('layered /api/ server info', () => {
  let srv;
  let adminToken, userToken;

  const api = (headers = {}) => fetch(`${srv.baseUrl}/api/`, { headers });

  before(async () => {
    srv = await startServer({
      users: [
        { username: 'boss', password: 'pw', admin: true },
        { username: 'pleb', password: 'pw', admin: false },
      ],
      // Federation ON so a minted key can authenticate at the HTTP wall.
      extraConfig: { federation: { enabled: true } },
    });
    const login = async (username) => {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'pw' }),
      });
      assert.equal(r.status, 200, `login for ${username}`);
      return (await r.json()).token;
    };
    adminToken = await login('boss');
    userToken = await login('pleb');
  });

  after(async () => { await srv?.stop(); });

  test('no credentials on a users-server: 401 — the login-detection contract', async () => {
    // THE contract this endpoint must never lose again: third-party
    // clients probe /api/ tokenless and read 401 as "authenticate first".
    // An anonymous 200 here makes every server look public (#932's
    // regression). Public-access mode is the one place tokenless gets a
    // 200 — pinned in the public-mode suite below.
    const r = await api();
    assert.equal(r.status, 401, 'tokenless on a users-server MUST 401');
  });

  test('a presented-but-invalid token is a 401, not a downgrade', async () => {
    const r = await api({ 'x-access-token': 'not-a-jwt' });
    assert.equal(r.status, 401);
  });

  test('plain user: base + user layer, no admin layer', async () => {
    const r = await api({ 'x-access-token': userToken });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.server, 'string', 'every authenticated response carries the version');
    assert.match(j.server, /^\d+\.\d+\.\d+/);
    assert.deepEqual(j.apiVersions, ['1']);
    assert.ok(!('subsonic' in j.features), 'subsonic flag removed (feature on its way out)');
    assert.equal(j.features.discoveryReady, false, 'discovery off in this config');
    assert.equal(j.features.discovery, false);
    assert.equal(j.features.discoveryP2p, false);
    assert.ok('transcode' in j.features, 'transcode capability is a server fact');
    assert.equal(typeof j.features.supportedAudioFiles, 'object');
    assert.equal(j.user.username, 'pleb');
    assert.equal(j.user.admin, false);
    assert.equal(j.user.federation, false);
    assert.deepEqual(j.user.vpaths, ['testlib']);
    assert.ok(!('playlists' in j.user), 'playlists are a resource, not a capability');
    assert.ok(!('allowYoutubeDownload' in j.user), 'velvet-only legacy field stays on ping');
    assert.ok(!('discoveryPath' in j.user), 'redundant-with-discovery legacy field stays on ping');
    for (const cap of ['transcode', 'supportedAudioFiles', 'discovery', 'discoveryP2p']) {
      assert.ok(!(cap in j.user), `server-wide capability '${cap}' lives in features, not user`);
    }
    assert.equal(typeof j.user.noUpload, 'boolean');
    assert.equal(typeof j.user.noMkdir, 'boolean');
    assert.equal(typeof j.user.noFileModify, 'boolean');
    assert.equal(typeof j.user.federationDiscovery, 'boolean',
      'peer-relationship-derived flag stays caller-scoped');
    assert.ok('testlib' in j.user.vpathMetaData, 'library type metadata rides along');
    assert.ok(!('admin' in j), 'no admin layer for a non-admin');

    // The disclosure contract: `user` is built ADDITIVELY from explicit
    // fields — the resolved req.user internally spreads the full users-table
    // row (password hash, salt, scrobbler credentials, …) and NONE of it may
    // reach the response. The drift-lock test can't catch a leak introduced
    // inside the shared builder (ping would leak identically), so pin the
    // sensitive columns by name.
    for (const secret of ['password', 'salt', 'token', 'id',
      'lastfm_user', 'lastfm_password', 'listenbrainz_token']) {
      assert.ok(!(secret in j.user), `users-table column '${secret}' must never reach the response`);
    }
  });

  test('admin user: all three layers', async () => {
    const r = await api({ 'x-access-token': adminToken });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.server, 'string');
    assert.equal(j.user.username, 'boss');
    assert.equal(j.user.admin, true);
    assert.ok(j.admin, 'admin layer present');
    assert.ok(Number.isInteger(j.admin.uptime) && j.admin.uptime >= 0);
    assert.equal(typeof j.admin.nodeVersion, 'string');
    assert.equal(typeof j.admin.platform, 'string');
    assert.ok(Number.isInteger(j.admin.dbSchemaVersion) && j.admin.dbSchemaVersion >= 67,
      'live PRAGMA user_version');
  });

  test('drift-lock: ping === /api/ user half + features half (modulo legacy/identity)', async () => {
    const apiJ = await (await api({ 'x-access-token': userToken })).json();
    const pingR = await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: { 'x-access-token': userToken } });
    assert.equal(pingR.status, 200, 'ping unchanged behind the wall');
    const ping = await pingR.json();

    // Ping's frozen flat contract = the caller-scoped half (/api/'s
    // `user` minus identity) + the capabilities half (/api/'s `features`
    // minus the /api/-only discoveryReady) + three legacy fields.
    const { username: _u, admin: _a, federation: _f, ...userHalf } = apiJ.user;
    const { discoveryReady: _dr, ...capsHalf } = apiJ.features;
    const { playlists, allowYoutubeDownload, discoveryPath, ...pingRest } = ping;
    assert.ok(Array.isArray(playlists), 'ping still carries playlists');
    assert.equal(allowYoutubeDownload, !ping.noUpload,
      'ping still carries the velvet field, with its historical value');
    assert.equal(discoveryPath, ping.discovery,
      'ping still carries discoveryPath, identical to discovery as always');
    assert.deepEqual(pingRest, { ...userHalf, ...capsHalf },
      'ping is exactly the two shared builders flattened — any drift is a bug');
  });

  test('share token: 401 — shares fetch a playlist, they are not a session', async () => {
    const shareR = await fetch(`${srv.baseUrl}/api/v1/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': userToken },
      body: JSON.stringify({ playlist: ['testlib/anything.mp3'] }),
    });
    assert.equal(shareR.status, 200);
    const { token } = await shareR.json();
    assert.ok(token, 'share creation returns its token');

    // The wall's share-token path gating covers /api/ like it covers
    // ping: shares can only fetch their playlist's routes.
    const r = await api({ 'x-access-token': token });
    assert.equal(r.status, 401);
  });

  test('federation key: scoped user layer, never admin — and the allowlist stays tight', async () => {
    const mintR = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ name: 'matrix-key', vpaths: ['testlib'] }),
    });
    assert.equal(mintR.status, 200, 'admin minted a federation key');
    const { key } = await mintR.json();
    assert.match(key, /^fedk_/);

    // The deliverable: a federated caller reads the version and
    // capabilities with its key, plus its granted-library view.
    const r = await api({ 'x-federation-key': key });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.server, 'string', 'version visible over federation');
    assert.ok(j.features, 'capabilities visible over federation');
    assert.equal(typeof j.features.discovery, 'boolean');
    assert.equal(j.user.federation, true);
    assert.equal(j.user.admin, false);
    assert.deepEqual(j.user.vpaths, ['testlib'], 'scoped to the key grants');
    assert.ok(!('playlists' in j.user));
    assert.ok(!('admin' in j), 'a federation key can never see the admin layer');
    assert.ok(!('federationLimits' in j.user) && !('federationKeyId' in j.user),
      'the synthetic fed user\'s internal fields stay internal');

    // Adding /api to the allowlist loosened NOTHING else: ping (and every
    // other unlisted route) still refuses the key.
    const ping = await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: { 'x-federation-key': key } });
    assert.equal(ping.status, 403, 'ping stays off the federation allowlist');
  });

  test('a bogus federation key is a 401', async () => {
    const r = await api({ 'x-federation-key': 'fedk_definitely_not_real' });
    assert.equal(r.status, 401);
  });

  test('a jukebox token without a live session is a 401', async () => {
    // A CORRECTLY-SIGNED jukebox JWT whose WebSocket session no longer
    // exists (or never did) must 401 like the wall does — not downgrade to
    // the public layer. Signed with the spawned server's own secret, read
    // back from its generated config.
    const { secret } = JSON.parse(
      await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));
    const stale = jwt.sign({ username: 'pleb', jukebox: true }, secret);
    const r = await api({ 'x-access-token': stale });
    assert.equal(r.status, 401, 'dead jukebox session → error, not the public layer');
  });
});

describe('layered /api/ in public-access mode', () => {
  test('no users: tokenless callers get user AND admin layers', { timeout: 120000 }, async () => {
    const pub = await startServer({ waitForScan: false });
    try {
      const j = await (await fetch(`${pub.baseUrl}/api/`)).json();
      assert.equal(typeof j.server, 'string',
        'the tokenless probe gets a 200 + version ONLY in public mode — the "no login needed" answer');
      assert.equal(j.user.username, 'mstream-user');
      assert.equal(j.user.admin, true, 'public mode is effectively admin');
      assert.equal(j.user.federation, false);
      assert.ok(j.admin, 'admin layer present in public mode');
    } finally {
      await pub.stop();
    }
  });

  test('no users + lockAdmin: demoted user layer, NO admin layer', { timeout: 120000 }, async () => {
    const locked = await startServer({ waitForScan: false, extraConfig: { lockAdmin: true } });
    try {
      const j = await (await fetch(`${locked.baseUrl}/api/`)).json();
      assert.equal(j.user.admin, false, 'lockAdmin demotes the implicit user');
      assert.equal(j.user.noUpload, true, 'write permissions forced off');
      assert.ok(!('admin' in j), 'no admin layer under lockAdmin');
    } finally {
      await locked.stop();
    }
  });

  test('a REAL admin under lockAdmin: identity stays true, NO admin layer', { timeout: 180000 }, async () => {
    // lockAdmin refuses the admin API, so the admin account must exist
    // BEFORE the lock — the real-world shape: a running server gets
    // locked and rebooted. Boot 1 creates the admin; boot 2 reuses the
    // same data dir with the lock on.
    const srv1 = await startServer({
      waitForScan: false,
      users: [{ username: 'boss', password: 'pw', admin: true }],
    });
    const { tmpDir } = srv1;
    // Keep the data dir: kill the child directly (the helper's stop()
    // would delete tmpDir).
    srv1.proc.kill('SIGKILL');
    await new Promise((r) => srv1.proc.once('exit', r));

    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    cfg.lockAdmin = true;
    // Fresh port — Windows can race re-binding a just-killed listener;
    // the identity lives in the data dir, not the port.
    cfg.port = await freePort();
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    const proc2 = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', cfgPath],
      { cwd: REPO_ROOT, stdio: 'ignore' });
    const base = `http://127.0.0.1:${cfg.port}`;
    try {
      await pollReady(base, () => proc2.exitCode);
      const loginR = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'pw' }),
      });
      assert.equal(loginR.status, 200, 'login still works under lockAdmin');
      const { token } = await loginR.json();

      const j = await (await fetch(`${base}/api/`, { headers: { 'x-access-token': token } })).json();
      assert.equal(j.user.admin, true, 'the identity fact survives the lock');
      assert.ok(!('admin' in j), 'a locked admin API serves no admin params');
      assert.ok(j.user, 'the user layer itself is unaffected');
    } finally {
      try { proc2.kill('SIGKILL'); } catch { /* already gone */ }
      await new Promise((r) => { if (proc2.exitCode !== null) { r(); } else { proc2.once('exit', r); } });
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
