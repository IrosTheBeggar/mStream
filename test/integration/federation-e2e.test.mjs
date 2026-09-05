/**
 * Federation read-only keys end-to-end over plain HTTP (no iroh needed —
 * the key is the credential; the endpoint is just a rendezvous):
 *
 * Scenario A (server WITH users, federation enabled):
 *   - admin mints a key scoped to one library via the admin API
 *   - health returns exactly the granted library list
 *   - db browse is scoped (granted-lib artists only), /media serves granted
 *     files and 404s ungranted ones, file-explorer lists granted libraries
 *     only (its mkdir/upload writes stay 403)
 *   - writes and off-allowlist reads are 403; bogus/missing keys are 401
 *   - revocation kills the key on the next request; reset-binding 404s on
 *     unknown ids
 *
 * Scenario B (NO users = public mode, federation enabled) — the
 * branch-ordering pin: public mode grants anonymous requests everything, but
 * a federation key must STILL be scoped to its grants. If the wall checked
 * public mode first, the key would silently see every library.
 *
 * Guest tokens (state/federation-guest.js) get the same treatment in both
 * scenarios: signed here with the spawned server's secret (read back out of
 * its config.json) exactly as the server itself would mint them — the mint
 * ROUTE needs a bound key, i.e. a real iroh handshake, and is covered by
 * federation-browse's two-server suite. Over plain HTTP the guest rides the
 * ordinary token slots and must land on the key's scope, the key's
 * allowlist, and die with the key; and in public mode a forged one must be
 * a 401, never the public user.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import jwt from 'jsonwebtoken';
import { parseFederationTicket, buildFederationTicket } from '../../src/state/federation.js';

async function makeLibDir(prefix, fileName, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(dir, fileName), content, 'utf8');
  return dir;
}

const fedHeaders = (key, extra = {}) => ({ 'x-federation-key': key, 'Content-Type': 'application/json', ...extra });
const tokenHeaders = (token) => ({ 'x-access-token': token, 'Content-Type': 'application/json' });

// The spawned server's JWT secret — config.setup generated it into the
// config file at boot. Signing with it is exactly what mintGuestToken does.
async function serverSecret(srv) {
  return JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8')).secret;
}
const signGuest = (secret, keyId, extra = {}) =>
  jwt.sign({ federationGuest: true, federationKeyId: keyId, ...extra }, secret, extra.exp ? {} : { expiresIn: '1h' });

describe('federation keys e2e (server with users)', () => {
  let srv, sharedDir, privateDir, adminToken, fedKey, keyId;

  before(async () => {
    sharedDir = await makeLibDir('mstream-fed-shared-', 'hello.txt', 'hello from shared');
    privateDir = await makeLibDir('mstream-fed-private-', 'secret.txt', 'do not leak');

    srv = await startServer({
      extraFolders: { shared: sharedDir, private: privateDir },
      extraConfig: { federation: { enabled: true } },
      users: [{ username: 'boss', password: 'pw', admin: true, vpaths: ['testlib', 'shared', 'private'] }],
    });

    const login = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'pw' }),
    });
    adminToken = (await login.json()).token;

    const mint = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: JSON.stringify({ name: "Bob's NAS", vpaths: ['shared'] }),
    });
    assert.equal(mint.status, 200);
    ({ key: fedKey, id: keyId } = await mint.json());
    assert.match(fedKey, /^fedk_/);
  });

  after(async () => {
    await srv?.stop();
    for (const d of [sharedDir, privateDir]) {
      if (d) { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
    }
  });

  test('health reports the granted libraries only', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(fedKey) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.libraries, ['shared']);
    assert.ok(j.server, 'reports a server version');
    assert.ok(j.name, 'reports a display name');
  });

  test('db browse is scoped to the granted library', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/db/artists`, {
      method: 'POST', headers: fedHeaders(fedKey), body: '{}',
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // 'shared' holds only hello.txt — the fixture artists live in testlib,
    // which this key was NOT granted.
    assert.deepEqual(j.artists, []);

    // Sanity check the assertion has teeth: the admin sees fixture artists.
    const full = await fetch(`${srv.baseUrl}/api/v1/db/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': adminToken },
      body: '{}',
    });
    assert.ok((await full.json()).artists.length > 0, 'fixture library should have artists');
  });

  test('/media serves granted files and 404s ungranted vpaths', async () => {
    const ok = await fetch(`${srv.baseUrl}/media/shared/hello.txt`, { headers: fedHeaders(fedKey) });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'hello from shared');

    const priv = await fetch(`${srv.baseUrl}/media/private/secret.txt`, { headers: fedHeaders(fedKey) });
    assert.equal(priv.status, 404);

    const testlib = await fetch(`${srv.baseUrl}/media/testlib/`, { headers: fedHeaders(fedKey) });
    assert.equal(testlib.status, 404);
  });

  test('file explorer browses granted libraries only; its writes stay 403', async () => {
    // Root listing comes from req.user.vpaths — the key's grants, nothing else.
    const root = await fetch(`${srv.baseUrl}/api/v1/file-explorer`, {
      method: 'POST', headers: fedHeaders(fedKey), body: JSON.stringify({ directory: '' }),
    });
    assert.equal(root.status, 200);
    assert.deepEqual((await root.json()).directories, [{ name: 'shared' }]);

    // Browsing inside the granted library lists its audio files.
    await fs.writeFile(path.join(sharedDir, 'track.mp3'), 'pretend audio', 'utf8');
    const shared = await fetch(`${srv.baseUrl}/api/v1/file-explorer`, {
      method: 'POST', headers: fedHeaders(fedKey), body: JSON.stringify({ directory: '/shared' }),
    });
    assert.equal(shared.status, 200);
    const listing = await shared.json();
    assert.equal(listing.path, '/shared/');
    assert.deepEqual(listing.files.map((f) => f.name), ['track.mp3']);

    // An ungranted library must not be browsable (getVPathInfo refuses).
    const priv = await fetch(`${srv.baseUrl}/api/v1/file-explorer`, {
      method: 'POST', headers: fedHeaders(fedKey), body: JSON.stringify({ directory: '/private' }),
    });
    assert.ok(!priv.ok, 'ungranted library browse must not succeed');

    // The file-explorer write siblings stay off the allowlist.
    const mkdir = await fetch(`${srv.baseUrl}/api/v1/file-explorer/mkdir`, {
      method: 'POST', headers: fedHeaders(fedKey), body: JSON.stringify({ directory: '/shared/new' }),
    });
    assert.equal(mkdir.status, 403);
  });

  test('writes and off-allowlist reads are 403', async () => {
    const write = await fetch(`${srv.baseUrl}/api/v1/db/rate-song`, {
      method: 'POST', headers: fedHeaders(fedKey), body: JSON.stringify({ filepath: 'x', rating: 5 }),
    });
    assert.equal(write.status, 403);

    const perUserRead = await fetch(`${srv.baseUrl}/api/v1/db/rated`, { headers: fedHeaders(fedKey) });
    assert.equal(perUserRead.status, 403);

    const admin = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, { headers: fedHeaders(fedKey) });
    assert.equal(admin.status, 403);
  });

  test('bogus and missing credentials are 401', async () => {
    const bogus = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders('fedk_wrong') });
    assert.equal(bogus.status, 401);

    const none = await fetch(`${srv.baseUrl}/api/v1/federation/health`);
    assert.equal(none.status, 401);
  });

  test('reset-binding 404s on an unknown key id', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/424242/reset-binding`, {
      method: 'POST', headers: { 'x-access-token': adminToken },
    });
    assert.equal(r.status, 404);
  });

  test('admin status reflects the booted endpoint; minted keys carry swap-ready tickets', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/federation`, {
      headers: { 'x-access-token': adminToken },
    });
    assert.equal(r.status, 200);
    const status = await r.json();
    assert.equal(status.enabled, true);

    if (!status.available) {
      // No @number0/iroh binary on this platform — the HTTP side of
      // federation still works (everything above), tickets are just null.
      return;
    }
    assert.equal(status.running, true, 'boot wiring should have started the endpoint');
    assert.ok(status.endpointId, 'running endpoint reports its id');

    const keys = await (await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      headers: { 'x-access-token': adminToken },
    })).json();
    const mine = keys.find((k) => k.id === keyId);
    assert.ok(mine, 'minted key is listed');
    assert.match(mine.ticket, /^mstrfed1:/);
    const parsed = parseFederationTicket(mine.ticket);
    assert.equal(parsed.apiKey, fedKey);
    assert.deepEqual(parsed.libraries, ['shared']);
    assert.ok(parsed.endpointTicket.length > 0);
  });

  test('peer admin routes: add/parse errors, duplicates, list, test 404, remove', async () => {
    const adminH = { 'Content-Type': 'application/json', 'x-access-token': adminToken };

    const garbage = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, {
      method: 'POST', headers: adminH, body: JSON.stringify({ ticket: 'not-a-ticket' }),
    });
    assert.equal(garbage.status, 400);

    // Syntactically valid ticket pointing nowhere — adding succeeds (the
    // endpoint string is opaque until dialed); the async first health check
    // just fails quietly.
    const fakeTicket = buildFederationTicket({
      endpointTicket: 'endpointfake', key: 'fedk_fake-peer-key', serverName: 'Fake Friend', libraries: ['x'],
    });
    const add = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, {
      method: 'POST', headers: adminH, body: JSON.stringify({ ticket: fakeTicket }),
    });
    assert.equal(add.status, 200);
    const added = await add.json();
    assert.equal(added.name, 'Fake Friend');
    assert.deepEqual(added.ticketLibraries, ['x']);

    const dup = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, {
      method: 'POST', headers: adminH, body: JSON.stringify({ ticket: fakeTicket }),
    });
    assert.equal(dup.status, 400);

    const list = await (await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, { headers: adminH })).json();
    assert.ok(list.some((p) => p.id === added.id));

    const testMissing = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers/424242/test`, {
      method: 'POST', headers: adminH,
    });
    assert.equal(testMissing.status, 404);

    const del = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers/${added.id}`, {
      method: 'DELETE', headers: adminH,
    });
    assert.equal(del.status, 200);
    const delAgain = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers/${added.id}`, {
      method: 'DELETE', headers: adminH,
    });
    assert.equal(delAgain.status, 404);
  });

  test('a guest token lands on the key\'s scope through the ordinary token slots', async () => {
    const guest = signGuest(await serverSecret(srv), keyId);

    // Header slot: health shows the key's grants and /api/ says who we are.
    const health = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(guest) });
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).libraries, ['shared']);
    const info = await (await fetch(`${srv.baseUrl}/api/`, { headers: tokenHeaders(guest) })).json();
    assert.equal(info.user.federation, true);
    assert.equal(info.user.federationGuest, true);
    assert.deepEqual(info.user.vpaths, ['shared']);
    assert.equal(info.admin, undefined, 'never the admin layer');

    // Query slot, the way stream and art URLs carry it: granted media
    // streams, ungranted 404s — the key's scoping, verbatim.
    const ok = await fetch(`${srv.baseUrl}/media/shared/hello.txt?token=${guest}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'hello from shared');
    assert.equal((await fetch(`${srv.baseUrl}/media/private/secret.txt?token=${guest}`)).status, 404);
  });

  test('a guest is held to the allowlist and cannot mint guests', async () => {
    const guest = signGuest(await serverSecret(srv), keyId);
    const write = await fetch(`${srv.baseUrl}/api/v1/db/rate-song`, {
      method: 'POST', headers: tokenHeaders(guest), body: JSON.stringify({ filepath: 'x', rating: 5 }),
    });
    assert.equal(write.status, 403);
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/db/rated`, { headers: tokenHeaders(guest) })).status, 403);
    // On the allowlist (for the KEY's sake), refused by the route itself.
    const mint = await fetch(`${srv.baseUrl}/api/v1/federation/guest`, { method: 'POST', headers: tokenHeaders(guest) });
    assert.equal(mint.status, 403);
    assert.match((await mint.json()).error, /guest cannot mint/i);
  });

  test('the mint route refuses local users and keys that never completed the handshake', async () => {
    // A logged-in admin has no key to mint for.
    const asUser = await fetch(`${srv.baseUrl}/api/v1/federation/guest`, { method: 'POST', headers: tokenHeaders(adminToken) });
    assert.equal(asUser.status, 403);
    // Over plain HTTP the key is unbound (no iroh dial happened): refused.
    const asKey = await fetch(`${srv.baseUrl}/api/v1/federation/guest`, { method: 'POST', headers: fedHeaders(fedKey) });
    assert.equal(asKey.status, 403);
    assert.match((await asKey.json()).error, /not bound/i);
  });

  test('bad guest tokens are 401: expired, foreign signature, unknown key', async () => {
    const secret = await serverSecret(srv);
    const expired = signGuest(secret, keyId, { exp: Math.floor(Date.now() / 1000) - 60 });
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(expired) })).status, 401);
    const forged = jwt.sign({ federationGuest: true, federationKeyId: keyId }, 'not-the-secret');
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(forged) })).status, 401);
    const orphan = signGuest(secret, 424242);
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(orphan) })).status, 401);
  });

  test('revocation kills the key on the next request — and its guests', async () => {
    const guest = signGuest(await serverSecret(srv), keyId);
    const del = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys/${keyId}`, {
      method: 'DELETE', headers: { 'x-access-token': adminToken },
    });
    assert.equal(del.status, 200);

    const r = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(fedKey) });
    assert.equal(r.status, 401);
    const g = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(guest) });
    assert.equal(g.status, 401, 'a still-valid guest token dies with its key');
  });
});

describe('federation keys e2e (public mode — the branch-ordering pin)', () => {
  let srv, sharedDir, privateDir, fedKey, keyId;

  before(async () => {
    sharedDir = await makeLibDir('mstream-fed-pub-shared-', 'hello.txt', 'public shared');
    privateDir = await makeLibDir('mstream-fed-pub-private-', 'secret.txt', 'public private');

    // No users -> every anonymous request gets the full-access public user.
    srv = await startServer({
      extraFolders: { shared: sharedDir, private: privateDir },
      extraConfig: { federation: { enabled: true } },
    });

    // Public mode: the admin API is open, so mint without a token.
    const mint = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pub-peer', vpaths: ['shared'] }),
    });
    assert.equal(mint.status, 200);
    ({ key: fedKey, id: keyId } = await mint.json());
  });

  after(async () => {
    await srv?.stop();
    for (const d of [sharedDir, privateDir]) {
      if (d) { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
    }
  });

  test('anonymous requests see everything, the federation key stays scoped', async () => {
    // Anonymous (public user): full access, proving the server IS wide open.
    const anon = await fetch(`${srv.baseUrl}/media/private/secret.txt`);
    assert.equal(anon.status, 200);

    // Federation key: still only its grant. If the wall ran the public-mode
    // branch first this would be 200 — the exact bug this test pins.
    const health = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedHeaders(fedKey) });
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).libraries, ['shared']);

    const priv = await fetch(`${srv.baseUrl}/media/private/secret.txt`, { headers: fedHeaders(fedKey) });
    assert.equal(priv.status, 404);

    const ok = await fetch(`${srv.baseUrl}/media/shared/hello.txt`, { headers: fedHeaders(fedKey) });
    assert.equal(ok.status, 200);
  });

  test('guest tokens are scoped in public mode too, and a forged one is a 401 — never the public user', async () => {
    const secret = await serverSecret(srv);
    const guest = signGuest(secret, keyId);
    assert.equal((await fetch(`${srv.baseUrl}/media/private/secret.txt?token=${guest}`)).status, 404,
      'a valid guest must not inherit public mode\'s everything');
    assert.equal((await fetch(`${srv.baseUrl}/media/shared/hello.txt?token=${guest}`)).status, 200);

    // A token that merely CLAIMS to be a guest is verified in the guest
    // branch and refused there. Falling through to public mode would hand
    // anyone who can spell the claim the whole library.
    const forged = jwt.sign({ federationGuest: true, federationKeyId: keyId }, 'not-the-secret');
    assert.equal((await fetch(`${srv.baseUrl}/media/private/secret.txt?token=${forged}`)).status, 401);
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: tokenHeaders(forged) })).status, 401);
  });
});
