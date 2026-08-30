/**
 * The browsing face of federation (src/api/federation-browse.js) — the
 * OUTBOUND half that lets a local user open a peer and look around:
 *
 *   GET /api/v1/federation/peers                 peers this user can browse
 *   ALL /api/v1/federation/peers/:id/api/<path>  one allowlisted read
 *   GET /api/v1/federation/peers/:id/art/<file>  that peer's album art
 *
 * Part 1 (no iroh needed) pins the guards, using a syntactically valid
 * ticket that points nowhere — the peer row is real, the endpoint is not:
 *   - the peers projection never leaks api_key / endpoint_ticket
 *   - off-allowlist routes are refused BEFORE the peer is even looked up
 *   - unknown peer ids 404
 *   - all three routes 403 when federation is off
 *   - a FEDERATION KEY cannot reach any of them (no proxy chaining): the
 *     routes are off the inbound allowlist, so the wall answers 403
 *   - ping advertises federationBrowse only once a peer exists
 *
 * Part 2 (skips without the iroh binary) is the real thing: two spawned
 * servers, B pairs with A over a pasted ticket, and B's webapp routes read
 * A's library through the bridge.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { buildFederationTicket } from '../../src/state/federation.js';
import http from 'node:http';

let irohAvailable = true;
try { await import('@number0/iroh'); } catch { irohAvailable = false; }

const json = (token) => ({ 'Content-Type': 'application/json', 'x-access-token': token });

// A GET that sends the request-target verbatim. fetch/WHATWG resolves `.`/`..`
// segments (even percent-encoded like %2e%2e) client-side, so a literal
// traversal segment only reaches the server through a low-level client.
function rawGet(baseUrl, rawPath, headers = {}) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: rawPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('federation browse proxy — guards', () => {
  let srv, libDir, adminToken, peerId;

  before(async () => {
    libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fedbrowse-'));
    await fs.writeFile(path.join(libDir, 'song.txt'), 'a local file', 'utf8');

    srv = await startServer({
      extraFolders: { shared: libDir },
      extraConfig: { federation: { enabled: true } },
      users: [
        { username: 'boss', password: 'pw', admin: true, vpaths: ['testlib', 'shared'] },
        { username: 'listener', password: 'pw', admin: false, vpaths: ['shared'] },
      ],
    });

    const login = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'pw' }),
    });
    adminToken = (await login.json()).token;

    // A peer row whose endpoint points nowhere. Everything short of an
    // actual dial is exercisable against it.
    const ticket = buildFederationTicket({
      endpointTicket: 'endpointfake', key: 'fedk_unreachable-peer', serverName: 'Ghost NAS', libraries: ['music'],
    });
    const add = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, {
      method: 'POST', headers: json(adminToken), body: JSON.stringify({ ticket }),
    });
    assert.equal(add.status, 200);
    peerId = (await add.json()).id;
  });

  after(async () => {
    await srv?.stop();
    if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('the peers list is a projection — no api_key, no endpoint_ticket', async () => {
    const res = await fetch(`${srv.baseUrl}/api/v1/federation/peers`, { headers: json(adminToken) });
    assert.equal(res.status, 200);
    const { peers } = await res.json();

    assert.equal(peers.length, 1);
    assert.deepEqual(Object.keys(peers[0]).sort(), ['id', 'lastSeen', 'lastStatus', 'name', 'useDiscovery']);
    assert.equal(peers[0].name, 'Ghost NAS');

    // The credential columns must not appear under ANY key spelling.
    const serialized = JSON.stringify(peers);
    assert.ok(!serialized.includes('fedk_'), 'the peer api key must never reach a non-admin projection');
    assert.ok(!serialized.includes('endpointfake'), 'the endpoint ticket must never reach a non-admin projection');
  });

  test('a non-admin user may list peers (browsing is not an admin action)', async () => {
    const login = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'listener', password: 'pw' }),
    });
    const listenerToken = (await login.json()).token;

    const res = await fetch(`${srv.baseUrl}/api/v1/federation/peers`, { headers: json(listenerToken) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).peers.length, 1);

    // ...but the admin route stays admin-only.
    const admin = await fetch(`${srv.baseUrl}/api/v1/admin/federation/peers`, { headers: json(listenerToken) });
    assert.equal(admin.status, 403);
  });

  test('off-allowlist routes are refused, and refused before the peer lookup', async () => {
    // A write the peer would never serve.
    const write = await fetch(`${srv.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/db/rate-song`, {
      method: 'POST', headers: json(adminToken), body: JSON.stringify({ filepath: 'x', rating: 10 }),
    });
    assert.equal(write.status, 403);

    // A read that is deliberately NOT shared (per-user stats).
    const stats = await fetch(`${srv.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/db/rated`, {
      method: 'POST', headers: json(adminToken), body: '{}',
    });
    assert.equal(stats.status, 403);

    // A `..` path segment is rejected (400) before the allowlist screen or any
    // dial. Sent raw (see rawGet): fetch resolves the `..` away client-side, so
    // the old fetch form 403'd for the wrong reason — the server never saw a
    // `..` at all.
    const traverse = await rawGet(
      srv.baseUrl,
      `/api/v1/federation/peers/${peerId}/api/api/v1/db/../../etc/passwd`,
      { 'x-access-token': adminToken },
    );
    assert.equal(traverse.status, 400);

    // The shape that made this matter: a prefix-allowlisted path (/media/) with
    // a `..` that undici would normalize on the wire into an off-allowlist
    // route. Must be refused before the peer is dialed.
    const prefixTraverse = await rawGet(
      srv.baseUrl,
      `/api/v1/federation/peers/${peerId}/api/media/../api/v1/db/rated`,
      { 'x-access-token': adminToken },
    );
    assert.equal(prefixTraverse.status, 400);

    // Same answer for a peer that does not exist: the route is screened
    // first, so an off-allowlist path never reaches the database.
    const ghost = await fetch(`${srv.baseUrl}/api/v1/federation/peers/424242/api/api/v1/db/rate-song`, {
      method: 'POST', headers: json(adminToken), body: '{}',
    });
    assert.equal(ghost.status, 403);
  });

  test('an unknown peer on an allowlisted route is a 404', async () => {
    const res = await fetch(`${srv.baseUrl}/api/v1/federation/peers/424242/api/api/v1/db/albums`, {
      method: 'POST', headers: json(adminToken), body: '{}',
    });
    assert.equal(res.status, 404);

    const art = await fetch(`${srv.baseUrl}/api/v1/federation/peers/424242/art/cover.jpg`, {
      headers: json(adminToken),
    });
    assert.equal(art.status, 404);
  });

  test('a federation key cannot chain a proxy through us', async () => {
    const mint = await fetch(`${srv.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST', headers: json(adminToken), body: JSON.stringify({ name: 'chainer', vpaths: ['shared'] }),
    });
    assert.equal(mint.status, 200);
    const { key } = await mint.json();

    const fedH = { 'x-federation-key': key, 'Content-Type': 'application/json' };
    // Sanity: the key itself works on an allowlisted route.
    const ok = await fetch(`${srv.baseUrl}/api/v1/federation/health`, { headers: fedH });
    assert.equal(ok.status, 200);

    // None of the browse routes are on that allowlist.
    for (const url of [
      `${srv.baseUrl}/api/v1/federation/peers`,
      `${srv.baseUrl}/api/v1/federation/peers/${peerId}/art/cover.jpg`,
    ]) {
      assert.equal((await fetch(url, { headers: fedH })).status, 403, url);
    }
    const proxied = await fetch(`${srv.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/db/albums`, {
      method: 'POST', headers: fedH, body: '{}',
    });
    assert.equal(proxied.status, 403);
  });

  test('ping advertises federationBrowse once a peer exists', async () => {
    const res = await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: json(adminToken) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).federationBrowse, true);
  });
});

describe('federation browse proxy — federation disabled', () => {
  let srv, libDir, token;

  before(async () => {
    libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-fedbrowse-off-'));
    await fs.writeFile(path.join(libDir, 'song.txt'), 'a local file', 'utf8');
    srv = await startServer({
      extraFolders: { shared: libDir },
      users: [{ username: 'boss', password: 'pw', admin: true, vpaths: ['testlib', 'shared'] }],
    });
    const login = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'pw' }),
    });
    token = (await login.json()).token;
  });

  after(async () => {
    await srv?.stop();
    if (libDir) { await fs.rm(libDir, { recursive: true, force: true }).catch(() => {}); }
  });

  test('every browse route 403s and ping keeps the feature hidden', async () => {
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/peers`, { headers: json(token) })).status, 403);
    assert.equal((await fetch(`${srv.baseUrl}/api/v1/federation/peers/1/art/cover.jpg`, { headers: json(token) })).status, 403);

    const proxied = await fetch(`${srv.baseUrl}/api/v1/federation/peers/1/api/api/v1/db/albums`, {
      method: 'POST', headers: json(token), body: '{}',
    });
    assert.equal(proxied.status, 403);

    const ping = await fetch(`${srv.baseUrl}/api/v1/ping`, { headers: json(token) });
    assert.equal((await ping.json()).federationBrowse, false);
  });
});

// ── Part 2: B browses A's library through a real iroh bridge ────────────────

describe('federation browse proxy over iroh (B reads A)', {
  skip: irohAvailable ? false : 'no @number0/iroh binary for this platform',
}, () => {
  let srvA, srvB, sharedA, privateA, peerId;

  before(async () => {
    // ── A: the peer being browsed. Two libraries, one granted. ──
    sharedA = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-browse-a-shared-'));
    privateA = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-browse-a-private-'));
    await fs.writeFile(path.join(sharedA, 'shared-track.txt'), 'a track A shares', 'utf8');
    await fs.writeFile(path.join(privateA, 'private-track.txt'), 'A keeps this', 'utf8');

    srvA = await startServer({
      extraFolders: { ashared: sharedA, aprivate: privateA },
      extraConfig: { federation: { enabled: true, serverName: 'Server A' } },
    });

    // A is in public mode (no users), so minting needs no token.
    const mint = await fetch(`${srvA.baseUrl}/api/v1/admin/federation/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'server-b', vpaths: ['ashared'] }),
    });
    assert.equal(mint.status, 200);
    const minted = await mint.json();
    assert.ok(minted.ticket, 'A should issue a ticket (its endpoint is up)');

    // ── B: the browser. Pairs with A exactly as the admin UI would. ──
    srvB = await startServer({ extraConfig: { federation: { enabled: true, serverName: 'Server B' } } });

    const add = await fetch(`${srvB.baseUrl}/api/v1/admin/federation/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: minted.ticket }),
    });
    assert.equal(add.status, 200);
    peerId = (await add.json()).id;
  });

  after(async () => {
    await srvB?.stop();
    await srvA?.stop();
    for (const d of [sharedA, privateA]) {
      if (d) { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
    }
  });

  test("B's peers list names A", async () => {
    const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers`);
    assert.equal(res.status, 200);
    const { peers } = await res.json();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, peerId);
  });

  test('the file explorer lists only the libraries A granted', async () => {
    const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/file-explorer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = (body.directories || []).map(d => d.name);
    assert.deepEqual(names, ['ashared'], 'only the granted library should be visible through the proxy');
  });

  test('a db read reaches A and comes back as JSON', async () => {
    const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/db/albums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.ok(Array.isArray(body.albums), 'the peer answers the same shape the local route does');
  });

  test('a GET read works too, and the bridge is reused', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/federation/health`);
      assert.equal(res.status, 200);
      const health = await res.json();
      assert.deepEqual(health.libraries, ['ashared']);
      assert.equal(health.name, 'Server A');
    }
  });

  test('every route the peer panels call is proxyable', async () => {
    // The Peers panel offers Albums / Artists / Genres / Recently Added /
    // Files. Albums and the explorer are covered above; these are the rest,
    // pinned here because each one is a separate entry in the allowlist and
    // a typo in the webapp's peer wrappers would 403 silently.
    // Includes the album/genre drill-downs (getAlbumSongs / getGenreSongs) and
    // the recursive Add-All — each is its own allowlist entry the peer wrappers
    // call, and dropping one would 403 silently in the UI. Empty-result requests
    // keep the assertions independent of A's fixture content.
    const calls = [
      ['api/v1/db/artists', '{}', b => Array.isArray(b.artists)],
      ['api/v1/db/genres', '{}', b => Array.isArray(b.genres)],
      ['api/v1/db/recent/added', JSON.stringify({ limit: '100' }), b => Array.isArray(b)],
      ['api/v1/db/search', JSON.stringify({ search: 'a' }), b => typeof b === 'object'],
      ['api/v1/db/artists-albums', JSON.stringify({ artist: 'Icarus' }), b => Array.isArray(b.albums)],
      ['api/v1/db/album-songs', JSON.stringify({ album: 'zzz-none', artist: null, year: null }), b => Array.isArray(b)],
      ['api/v1/db/genre-songs', JSON.stringify({ genre: 'zzz-none' }), b => Array.isArray(b)],
      ['api/v1/file-explorer/recursive', JSON.stringify({ directory: '/ashared' }), b => typeof b === 'object' && b !== null],
    ];

    for (const [route, body, shapeOk] of calls) {
      const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(res.status, 200, `${route} should proxy`);
      assert.ok(shapeOk(await res.json()), `${route} should come back in its normal shape`);
    }
  });

  test("A's own auth wall still refuses an ungranted library through the proxy", async () => {
    const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/api/api/v1/file-explorer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/aprivate' }),
    });
    // Whatever A decides, it must not be a 200 with A's private listing.
    assert.notEqual(res.status, 200);
  });

  test('a missing cover on A becomes a 404 here, not a 502', async () => {
    const res = await fetch(`${srvB.baseUrl}/api/v1/federation/peers/${peerId}/art/no-such-cover.jpg`);
    assert.equal(res.status, 404, 'the peer answered — the proxy forwards its status verbatim');
  });
});
