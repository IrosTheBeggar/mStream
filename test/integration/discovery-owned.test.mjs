/**
 * The batched owned lookup over HTTP (src/api/discovery-owned.js):
 *
 *   POST /api/v1/discovery/owned   { songs, albums, artists } → one answer each, in order
 *
 * Against the fixture library (test/helpers/fixtures.mjs: Icarus — Be
 * Somebody, Later Works; Vosto — Night Drive, Untitled EP), with users so
 * the library scoping is real: dana sees testlib, eli only an empty
 * library of his own, the admin both. Also the boot flag and the refusals:
 * no arm, a batch past the cap, a bad entry, a jukebox session, a paired
 * server's key.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const DANA = { username: 'dana', password: 'pw-dana' };
const ELI = { username: 'eli', password: 'pw-eli' };
const OWNED = '/api/v1/discovery/owned';
let server;
let emptyDir;
let adminToken;
let danaToken;
let eliToken;

async function login(u) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u),
  });
  return (await r.json()).token;
}
const hdr = (token) => ({ 'Content-Type': 'application/json', 'x-access-token': token });
const post = (token, route, body) => fetch(`${server.baseUrl}${route}`, { method: 'POST', headers: hdr(token), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (token, route) => fetch(`${server.baseUrl}${route}`, { headers: hdr(token) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe('discovery owned lookup (POST /api/v1/discovery/owned)', () => {
  before(async () => {
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-owned-empty-'));
    server = await startServer({
      dlnaMode: 'disabled',
      extraFolders: { empty: emptyDir },
      extraConfig: { federation: { enabled: true } },
      users: [
        { ...ADMIN, admin: true, vpaths: ['testlib', 'empty'] },
        { ...DANA, vpaths: ['testlib'] },
        { ...ELI, vpaths: ['empty'] },
      ],
    });
    adminToken = await login(ADMIN);
    danaToken = await login(DANA);
    eliToken = await login(ELI);
  });
  after(async () => {
    if (server) { await server.stop(); }
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  test('the boot payload advertises the route (a flag, never a probe)', async () => {
    const r = await get(danaToken, '/api/');
    assert.equal(r.status, 200);
    assert.equal(r.body.features.discoveryOwned, true);
  });

  test('songs: by tags, told apart by track and length; by hash; the tag arm needs all three; unknown is null', async () => {
    const meta = await post(danaToken, '/api/v1/db/metadata', { filepath: 'testlib/Icarus/Be Somebody/02 - Rise.mp3' });
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    const { hash } = meta.body.metadata;
    assert.ok(hash, 'the fixture carries a file hash');
    const r = await post(danaToken, OWNED, { songs: [
      { artist: 'Icarus', title: 'Rise', album: 'Be Somebody' },
      { artist: 'icarus', title: 'rise', album: 'be somebody', track: 2, disk: '1' },
      { artist: 'Icarus', title: 'Rise', album: 'Be Somebody', track: 7 },
      { artist: 'Icarus', title: 'Rise', album: 'Be Somebody', duration: 600 },
      { hash },
      { hash: 'nothing-like-it', artist: 'Icarus', title: 'Rise', album: 'Be Somebody' },
      { artist: 'Icarus', title: 'Rise' },
      { artist: 'Ghost', title: 'Nothing', album: 'Nowhere' },
      { filepath: 'shared/x.mp3', similarity: 0.9, extra: true },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rise = { vpath: 'testlib', filepath: 'testlib/Icarus/Be Somebody/02 - Rise.mp3', by: 'tags' };
    assert.deepEqual(r.body.songs, [
      rise,
      rise,
      null,
      null,
      { ...rise, by: 'hash' },
      rise,
      null,
      null,
      null,
    ]);
    assert.deepEqual(r.body.albums, []);
    assert.deepEqual(r.body.artists, []);
  });

  test('albums: by the album\'s credit (the artist scopes\' comparison), or by name alone', async () => {
    const r = await post(danaToken, OWNED, { albums: [
      { album: 'Be Somebody', albumArtist: 'Icarus' },
      { album: 'be somebody', artist: 'ICARUS' },
      { album: 'Night Drive', albumArtist: 'Icarus' },
      { album: 'night drive' },
      { album: 'Untitled EP' },
      { album: 'Ghost Album' },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.albums, [true, true, false, true, true, false]);
  });

  test('artists: owned by a track of theirs; have and missing against the names the asker sent', async () => {
    const r = await post(danaToken, OWNED, { artists: [
      { name: 'icarus', albums: ['Be Somebody', 'Later Works', 'Lost Tapes'] },
      { name: 'Vosto', albums: ['night drive'] },
      { name: 'Vosto' },
      { name: 'Nobody', albums: ['Anything'] },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.artists, [
      { owned: true, have: 2, missing: ['Lost Tapes'] },
      { owned: true, have: 1, missing: [] },
      { owned: true, have: 0, missing: [] },
      { owned: false, have: 0, missing: ['Anything'] },
    ]);
  });

  test('every arm is scoped to the libraries the caller may see', async () => {
    const body = {
      songs: [{ artist: 'Icarus', title: 'Rise', album: 'Be Somebody' }],
      albums: [{ album: 'Be Somebody', albumArtist: 'Icarus' }],
      artists: [{ name: 'Icarus', albums: ['Be Somebody'] }],
    };
    const eli = await post(eliToken, OWNED, body);
    assert.equal(eli.status, 200, JSON.stringify(eli.body));
    assert.deepEqual(eli.body, { songs: [null], albums: [false], artists: [{ owned: false, have: 0, missing: ['Be Somebody'] }] },
      'a library hidden from the user is not theirs');
    const admin = await post(adminToken, OWNED, body);
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.albums, [true]);
    assert.equal(admin.body.songs[0].by, 'tags');
  });

  test('refusals: no arm, a batch past the cap, a bad entry; a jukebox session; a paired server\'s key', async () => {
    assert.equal((await post(danaToken, OWNED, {})).status, 400, 'at least one arm');
    assert.equal((await post(danaToken, OWNED, { songs: Array.from({ length: 501 }, () => ({ title: 'x' })) })).status, 400, 'past the cap');
    assert.equal((await post(danaToken, OWNED, { albums: [{ artist: 'no album name' }] })).status, 400, 'an album entry names its album');
    assert.equal((await post(danaToken, OWNED, { songs: 'nope' })).status, 400);
    // A jukebox guest holds the account minus its writes — and the library
    // is not the guest's to ask about (auth.js buildJukeboxUser).
    const { default: WebSocket } = await import('ws');
    const juke = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/?token=${danaToken}`);
      ws.on('message', (m) => { const j = JSON.parse(String(m)); if (j.token) { resolve({ ws, token: j.token }); } });
      ws.on('error', reject);
    });
    try {
      const r = await post(juke.token, OWNED, { artists: [{ name: 'Icarus' }] });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.match(r.body.error, /jukebox session/);
    } finally {
      juke.ws.close();
    }
    // A paired server's key reaches the read allowlist and nothing else.
    const mint = await post(adminToken, '/api/v1/admin/federation/keys', { name: 'peer', vpaths: ['testlib'] });
    assert.equal(mint.status, 200, JSON.stringify(mint.body));
    const fed = await fetch(`${server.baseUrl}${OWNED}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-federation-key': mint.body.key }, body: JSON.stringify({ artists: [{ name: 'Icarus' }] }),
    });
    assert.equal(fed.status, 403);
  });
});
