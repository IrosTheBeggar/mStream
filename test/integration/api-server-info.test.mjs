/**
 * The layered GET /api/ endpoint (src/api/server-info.js) — the auth matrix.
 *
 * The endpoint sits BEFORE the auth wall and resolves credentials itself
 * (authApi.resolveOptionalUser), so this suite pins the full contract
 * against real spawned servers:
 *
 *  - users-server, no credentials  → 200, base layer ONLY (the deliberate
 *    public surface: version + capability booleans, nothing else);
 *  - present-but-invalid token     → 401 (an error, never a silent
 *    downgrade to the public layer);
 *  - plain user                    → base + `user` (the ping boot payload,
 *    minus the legacy playlists / allowYoutubeDownload / discoveryPath
 *    fields), no `admin`;
 *  - admin user                    → base + `user` + `admin`;
 *  - ping parity                   → /api/'s `user` object equals
 *    /api/v1/ping's body (minus playlists / identity fields) — the
 *    drift-lock on the shared payload builder;
 *  - share token                   → base only (shares fetch a playlist,
 *    they are not a session);
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
 *  - public mode + lockAdmin       → demoted user layer, no admin layer.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { startServer } from '../helpers/server.mjs';

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

  test('no credentials on a users-server: the base layer ONLY', async () => {
    const r = await api();
    assert.equal(r.status, 200, 'the bottom layer is public');
    const j = await r.json();
    assert.equal(typeof j.server, 'string');
    assert.match(j.server, /^\d+\.\d+\.\d+/);
    assert.deepEqual(j.apiVersions, ['1']);
    assert.equal(typeof j.features.subsonic, 'boolean');
    assert.equal(j.features.discoveryReady, false, 'discovery off in this config');
    assert.ok(!('user' in j), 'no user layer without credentials');
    assert.ok(!('admin' in j), 'no admin layer without credentials');
  });

  test('a presented-but-invalid token is a 401, not a downgrade', async () => {
    const r = await api({ 'x-access-token': 'not-a-jwt' });
    assert.equal(r.status, 401);
  });

  test('plain user: base + user layer, no admin layer', async () => {
    const r = await api({ 'x-access-token': userToken });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.user.username, 'pleb');
    assert.equal(j.user.admin, false);
    assert.equal(j.user.federation, false);
    assert.deepEqual(j.user.vpaths, ['testlib']);
    assert.ok(!('playlists' in j.user), 'playlists are a resource, not a capability');
    assert.ok(!('allowYoutubeDownload' in j.user), 'velvet-only legacy field stays on ping');
    assert.ok(!('discoveryPath' in j.user), 'redundant-with-discovery legacy field stays on ping');
    assert.equal(typeof j.user.noUpload, 'boolean');
    assert.equal(typeof j.user.noMkdir, 'boolean');
    assert.equal(typeof j.user.noFileModify, 'boolean');
    assert.ok('testlib' in j.user.vpathMetaData, 'library type metadata rides along');
    assert.equal(j.user.discovery, false);
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
    assert.equal(j.user.username, 'boss');
    assert.equal(j.user.admin, true);
    assert.ok(j.admin, 'admin layer present');
    assert.ok(Number.isInteger(j.admin.uptime) && j.admin.uptime >= 0);
    assert.equal(typeof j.admin.nodeVersion, 'string');
    assert.equal(typeof j.admin.platform, 'string');
    assert.ok(Number.isInteger(j.admin.dbSchemaVersion) && j.admin.dbSchemaVersion >= 67,
      'live PRAGMA user_version');
    assert.equal(j.admin.lockAdmin, false);
  });

  test('drift-lock: /api/ user layer === ping payload (modulo playlists/identity)', async () => {
    const fromApi = (await (await api({ 'x-access-token': userToken })).json()).user;
    const pingR = await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: { 'x-access-token': userToken } });
    assert.equal(pingR.status, 200, 'ping unchanged behind the wall');
    const ping = await pingR.json();

    const { username: _u, admin: _a, federation: _f, ...bootFromApi } = fromApi;
    // Ping's frozen contract = the shared builder + three legacy fields.
    const { playlists, allowYoutubeDownload, discoveryPath, ...pingRest } = ping;
    assert.ok(Array.isArray(playlists), 'ping still carries playlists');
    assert.equal(allowYoutubeDownload, !ping.noUpload,
      'ping still carries the velvet field, with its historical value');
    assert.equal(discoveryPath, ping.discovery,
      'ping still carries discoveryPath, identical to discovery as always');
    assert.deepEqual(bootFromApi, pingRest,
      'both routes serve the SAME builder output — any drift is a bug');
  });

  test('share token: base layer only', async () => {
    const shareR = await fetch(`${srv.baseUrl}/api/v1/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': userToken },
      body: JSON.stringify({ playlist: ['testlib/anything.mp3'] }),
    });
    assert.equal(shareR.status, 200);
    const { token } = await shareR.json();
    assert.ok(token, 'share creation returns its token');

    const r = await api({ 'x-access-token': token });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.server, 'string');
    assert.ok(!('user' in j), 'a share token is not a session');
    assert.ok(!('admin' in j));
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

    // The deliverable: a federated caller reads version + capabilities.
    const r = await api({ 'x-federation-key': key });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.server, 'string', 'version visible over federation');
    assert.equal(typeof j.features.subsonic, 'boolean');
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
      assert.equal(j.user.username, 'mstream-user');
      assert.equal(j.user.admin, true, 'public mode is effectively admin');
      assert.equal(j.user.federation, false);
      assert.ok(j.admin, 'admin layer present in public mode');
      assert.equal(j.admin.lockAdmin, false);
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
});
