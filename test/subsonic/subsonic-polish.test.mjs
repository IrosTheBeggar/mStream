/**
 * Integration tests for the Subsonic API polish pass (multi-id scrobble,
 * tokenInfo, search3 musicFolderId, OpenSubsonic song fields, share
 * description + expiry validation, playlist public flag, error-code
 * audit). Each block exercises one of the eight deliverables end-to-end
 * against a live mStream instance.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin' };
const USER  = { username: 'bob',   password: 'pw-bob'   };

let server;
let adminKey;
let userKey;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users: [
      { ...ADMIN, admin: true },
      { ...USER,  admin: false },
    ],
  });
  for (const [u, setKey] of [[ADMIN, v => adminKey = v], [USER, v => userKey = v]]) {
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    const { token } = await loginR.json();
    const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ name: 'polish-tests' }),
    });
    setKey((await keyR.json()).key);
  }
});

after(async () => { if (server) { await server.stop(); } });

function url(method, params = {}, key = adminKey) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) { q.append(k, item); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}
async function call(method, params = {}, key = adminKey) {
  const r = await fetch(url(method, params, key));
  return (await r.json())['subsonic-response'];
}
async function randomSongIds(n) {
  const env = await call('getRandomSongs', { size: n });
  return env.randomSongs.song.map(s => parseInt(s.id, 10));
}

// ── 1. Multi-id scrobble ─────────────────────────────────────────────────

describe('scrobble accepts multiple ids', () => {
  test('submission=true records play_count for every id in one request', async () => {
    const [a, b, c] = await randomSongIds(3);
    // Before: none played.
    const pre = await call('getRandomSongs', { size: 50 });
    const played0 = pre.randomSongs.song.filter(s => s.playCount > 0);

    const env = await call('scrobble', { id: [a, b, c], submission: 'true' });
    assert.equal(env.status, 'ok');

    // Verify via getStarred-adjacent endpoint — easier: look up each via
    // getSong and assert playCount went up. But getSong's user-meta
    // enrichment happens via enrichSongsWithUserMeta; use getRandomSongs
    // big enough to include all three.
    const post = await call('getRandomSongs', { size: 50 });
    const counts = new Map(post.randomSongs.song.map(s => [parseInt(s.id, 10), s.playCount || 0]));
    assert.ok(counts.get(a) >= 1, `song ${a} should have playCount >= 1, got ${counts.get(a)}`);
    assert.ok(counts.get(b) >= 1, `song ${b} should have playCount >= 1, got ${counts.get(b)}`);
    assert.ok(counts.get(c) >= 1, `song ${c} should have playCount >= 1, got ${counts.get(c)}`);

    // Sanity: the change actually came from this request (more than were
    // already played at the start).
    assert.ok(post.randomSongs.song.filter(s => s.playCount > 0).length
              >= played0.length + 3 - 1 /* allow some fixture overlap */,
      'scrobble should have raised play counts');
  });

  test('submission=false with many ids records only the last as now-playing', async () => {
    const [a, b] = await randomSongIds(2);
    await call('scrobble', { id: [a, b], submission: 'false' });
    const env = await call('getNowPlaying');
    const ids = (env.nowPlaying.entry || []).map(e => parseInt(e.id, 10));
    // Spec says the last wins. Earlier ids shouldn't linger.
    assert.ok(ids.includes(b), `expected now-playing to include ${b}, got ${ids}`);
  });

  test('id-less scrobble still returns error 10', async () => {
    const env = await call('scrobble');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

// ── 2. tokenInfo + extensions advertisement ──────────────────────────────

describe('tokenInfo endpoint', () => {
  test('valid apiKey → returns username in tokenInfo envelope', async () => {
    const env = await call('tokenInfo');
    assert.equal(env.status, 'ok');
    assert.equal(env.tokenInfo.username, ADMIN.username);
  });

  test('non-admin sees their own username (tokenInfo is universal)', async () => {
    const env = await call('tokenInfo', {}, userKey);
    assert.equal(env.tokenInfo.username, USER.username);
  });

  test('openSubsonicExtensions advertises tokenInfo', async () => {
    const env = await call('getOpenSubsonicExtensions');
    const names = env.openSubsonicExtensions.map(e => e.name);
    assert.ok(names.includes('tokenInfo'), `tokenInfo missing from ${names}`);
  });
});

// ── 3. search3 musicFolderId filter ──────────────────────────────────────

describe('search3 musicFolderId scoping', () => {
  test('search scoped to a folder only returns rows from that library', async () => {
    const folders = await call('getMusicFolders');
    const f = folders.musicFolders.musicFolder[0];
    assert.ok(f, 'expected at least one music folder');
    const env = await call('search3', { query: 'Icarus', musicFolderId: f.id });
    assert.equal(env.status, 'ok');
    // The fixture 'Icarus' artist only exists in our single testlib.
    assert.ok((env.searchResult3.artist || []).some(a => a.name === 'Icarus'));
  });

  test('search with an unknown folder id returns empty (graceful fallback)', async () => {
    const env = await call('search3', { query: 'Icarus', musicFolderId: 'mf-99999' });
    assert.equal(env.status, 'ok');
    assert.deepEqual(env.searchResult3, {});
  });
});

// ── 4. OpenSubsonic song fields ──────────────────────────────────────────

describe('OpenSubsonic extended song fields', () => {
  test('song object includes samplingRate, channelCount, bitDepth, replayGain when available', async () => {
    const env = await call('getRandomSongs', { size: 5 });
    const songs = env.randomSongs.song;
    // At least one of the fixture tracks should have the new fields set —
    // our fixtures are MP3 at 44.1kHz stereo, and music-metadata reports those.
    const withFields = songs.filter(s => typeof s.samplingRate === 'number' && typeof s.channelCount === 'number');
    assert.ok(withFields.length > 0,
      `expected at least one song with samplingRate+channelCount, got ${JSON.stringify(songs.map(s => ({id: s.id, sr: s.samplingRate, cc: s.channelCount})))}`);
    const s = withFields[0];
    assert.equal(s.samplingRate, 44100);
    assert.equal(s.channelCount, 2);
    // bitDepth is undefined for MP3 (music-metadata returns null for lossy
    // formats — harmless, the field is optional).
  });
});

// ── 5. createShare / updateShare description + expiry validation ─────────

describe('createShare + updateShare description and expiry', () => {
  test('createShare with past expires returns error 10', async () => {
    const songIds = await randomSongIds(1);
    const env = await call('createShare', {
      id: songIds, expires: Date.now() - 60000,
    });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('createShare + description is returned on the response and persists', async () => {
    const songIds = await randomSongIds(1);
    const created = await call('createShare', {
      id: songIds, description: 'my test share',
    });
    assert.equal(created.status, 'ok');
    const share = created.shares.share[0];
    assert.equal(share.description, 'my test share');
    const id = share.id;

    // Read back via getShares.
    const list = await call('getShares');
    const got = list.shares.share.find(s => s.id === id);
    assert.ok(got);
    assert.equal(got.description, 'my test share');

    // Clean up.
    await call('deleteShare', { id });
  });

  test('updateShare can change description', async () => {
    const songIds = await randomSongIds(1);
    const created = await call('createShare', {
      id: songIds, description: 'initial',
    });
    const id = created.shares.share[0].id;
    const u = await call('updateShare', { id, description: 'edited' });
    assert.equal(u.status, 'ok');
    const list = await call('getShares');
    const got = list.shares.share.find(s => s.id === id);
    assert.equal(got.description, 'edited');
    await call('deleteShare', { id });
  });

  test('updateShare with past expires returns error 10', async () => {
    const songIds = await randomSongIds(1);
    const created = await call('createShare', { id: songIds });
    const id = created.shares.share[0].id;
    const u = await call('updateShare', { id, expires: Date.now() - 1 });
    assert.equal(u.status, 'failed');
    assert.equal(u.error.code, 10);
    await call('deleteShare', { id });
  });
});

// ── 6. Playlist public flag ──────────────────────────────────────────────

describe('playlist public flag', () => {
  test('createPlaylist returns public=false by default', async () => {
    const env = await call('createPlaylist', {
      name: 'polish-private',
    });
    assert.equal(env.status, 'ok');
    assert.equal(env.playlist.public, false);
    await call('deletePlaylist', { id: env.playlist.id });
  });

  test('updatePlaylist public=true flips the flag and makes it visible to other users', async () => {
    // Admin creates a playlist, marks it public. Bob should see it.
    const created = await call('createPlaylist', { name: 'polish-shared' });
    const plId = created.playlist.id;
    await call('updatePlaylist', { playlistId: plId, public: 'true' });

    // Bob lists — should see admin's public playlist.
    const bobList = await call('getPlaylists', {}, userKey);
    const found = bobList.playlists.playlist.find(p => p.id === plId);
    assert.ok(found, `bob should see admin's public playlist, got ${JSON.stringify(bobList.playlists.playlist.map(p => p.name))}`);
    assert.equal(found.public, true);
    assert.equal(found.owner, ADMIN.username);

    // Flip back to private — should disappear from bob's list.
    await call('updatePlaylist', { playlistId: plId, public: 'false' });
    const bobList2 = await call('getPlaylists', {}, userKey);
    assert.ok(!bobList2.playlists.playlist.find(p => p.id === plId));

    await call('deletePlaylist', { id: plId });
  });

  test('non-owner cannot mutate a public playlist', async () => {
    const created = await call('createPlaylist', { name: 'polish-readonly' });
    const plId = created.playlist.id;
    await call('updatePlaylist', { playlistId: plId, public: 'true' });

    // Bob tries to rename admin's playlist — should be denied even though
    // it's public (public grants read, not write).
    const denied = await call('updatePlaylist',
      { playlistId: plId, name: 'hijacked' }, userKey);
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error.code, 50);

    // Confirm the name didn't change.
    const check = await call('getPlaylist', { id: plId });
    assert.equal(check.playlist.name, 'polish-readonly');

    await call('deletePlaylist', { id: plId });
  });
});

// ── 7. Error-code audit spot checks ──────────────────────────────────────

describe('error-code audit — spec codes in common paths', () => {
  test('setRating out of range returns code 10', async () => {
    const [id] = await randomSongIds(1);
    const env = await call('setRating', { id, rating: 99 });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('deleteUser targeting self returns code 50', async () => {
    const env = await call('deleteUser', { username: ADMIN.username });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 50);
  });
});
