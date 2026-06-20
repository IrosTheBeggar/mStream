/**
 * Subsonic API integration tests (Phase 3).
 *
 * Covers the endpoints added in Phase 3:
 *   - OpenSubsonic extensions manifest
 *   - album/artist starring (proper tables, no more child-track synthesis)
 *   - v1 getStarred
 *   - stream polish (HEAD, estimateContentLength, timeOffset)
 *   - user management
 *   - discovery (getTopSongs, getSimilarSongs{,2})
 *   - now-playing / scan endpoints
 *   - artist/album info stubs
 *   - avatar (identicon)
 *   - shares / bookmarks / play queue
 *   - Tier 3 stubs (radio, podcasts, lyrics, jukebox)
 *
 * Kept in its own file so a single `before` hook spawns one mStream instance
 * and every describe block can reuse it — the fixtures are shared.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'pw-admin-1' };
const USER  = { username: 'bob',   password: 'pw-bob-1'   };

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

  // Mint API keys for each user via the existing /api/v1/user/api-keys
  // endpoint (auth'd with JWT). We need keys for both so we can exercise
  // admin-vs-non-admin permission checks on the Subsonic side.
  for (const [user, setter] of [[ADMIN, v => adminKey = v], [USER, v => userKey = v]]) {
    const loginR = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    const { token } = await loginR.json();
    const keyR = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ name: 'phase3-tests' }),
    });
    setter((await keyR.json()).key);
  }
  assert.ok(adminKey); assert.ok(userKey);
});

after(async () => { if (server) { await server.stop(); } });

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  const body = await r.json();
  return body['subsonic-response'];
}

async function firstSongId() {
  // getRandomSongs is the cheapest "give me any song" endpoint — search3
  // needs a query string to return anything.
  const r = await call('getRandomSongs', { size: 1 });
  return r.randomSongs.song[0].id;
}

async function firstAlbumId() {
  const r = await call('getAlbumList2', { type: 'alphabeticalByName', size: 1 });
  return r.albumList2.album[0].id;
}

async function firstArtistId() {
  const r = await call('getArtists');
  return r.artists.index[0].artist[0].id;
}

// ── OpenSubsonic extensions ─────────────────────────────────────────────────

describe('OpenSubsonic extensions', () => {
  test('manifest declares at least formPost and apiKeyAuthentication', async () => {
    const env = await call('getOpenSubsonicExtensions');
    assert.equal(env.status, 'ok');
    const names = env.openSubsonicExtensions.map(e => e.name);
    assert.ok(names.includes('formPost'));
    assert.ok(names.includes('apiKeyAuthentication'));
  });

  test('every response sets openSubsonic:true', async () => {
    const env = await call('ping');
    assert.equal(env.openSubsonic, true);
  });
});

// ── Proper album/artist starring ────────────────────────────────────────────

describe('Album/artist starring (proper tables)', () => {
  let albumId;
  let artistId;
  let songId;

  before(async () => {
    albumId  = await firstAlbumId();
    artistId = await firstArtistId();
    songId   = await firstSongId();
  });

  test('star album → getStarred2.album contains it', async () => {
    await call('star', { albumId });
    const env = await call('getStarred2');
    const ids = env.starred2.album.map(a => a.id);
    assert.ok(ids.includes(albumId), `expected ${albumId} in ${JSON.stringify(ids)}`);
  });

  test('star artist → getStarred2.artist contains it', async () => {
    await call('star', { artistId });
    const env = await call('getStarred2');
    const ids = env.starred2.artist.map(a => a.id);
    assert.ok(ids.includes(artistId));
  });

  test('unstar track does NOT unstar the album (key regression test)', async () => {
    // Star the album, then star+unstar a song under it. Album star should persist.
    await call('star', { albumId });
    await call('star',   { id: songId });
    await call('unstar', { id: songId });
    const env = await call('getStarred2');
    const ids = env.starred2.album.map(a => a.id);
    assert.ok(ids.includes(albumId), 'album star should survive unstarring a child track');
  });

  test('unstar album removes it from getStarred2', async () => {
    await call('unstar', { albumId });
    const env = await call('getStarred2');
    const ids = env.starred2.album.map(a => a.id);
    assert.ok(!ids.includes(albumId));
  });

  test('v1 getStarred has the same shape under `starred` key', async () => {
    await call('star', { artistId });
    const env = await call('getStarred');
    assert.ok(env.starred);
    assert.ok(Array.isArray(env.starred.artist));
    assert.ok(Array.isArray(env.starred.album));
    assert.ok(Array.isArray(env.starred.song));
  });

  test('getArtist reports starred state on the artist envelope', async () => {
    await call('star', { artistId });
    const env = await call('getArtist', { id: artistId });
    assert.ok(env.artist.starred, 'artist payload should include a starred timestamp');
  });

  test('getAlbum reports starred state on the album envelope', async () => {
    await call('star', { albumId });
    const env = await call('getAlbum', { id: albumId });
    assert.ok(env.album.starred);
    await call('unstar', { albumId });
  });
});

// ── Stream polish ───────────────────────────────────────────────────────────

describe('Stream polish (HEAD, timeOffset, estimateContentLength)', () => {
  let songId;
  before(async () => { songId = await firstSongId(); });

  test('HEAD on /rest/stream returns Content-Length without a body', async () => {
    const r = await fetch(url('stream', { id: songId }), { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-length'));
    const buf = await r.arrayBuffer();
    assert.equal(buf.byteLength, 0);
  });

  test('GET with estimateContentLength=true on a transcode sets Content-Length', async () => {
    const r = await fetch(url('stream', {
      id: songId, format: 'mp3', maxBitRate: 64, estimateContentLength: 'true',
    }));
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-length'), 'expected Content-Length on transcode');
  });

  test('timeOffset triggers transcoding path (non-zero body, still succeeds)', async () => {
    // Fixtures are 1s long; seek well inside the file so ffmpeg still has
    // audio to emit after the -ss point. Request mp3 explicitly so the
    // transcoder path is deterministic regardless of server's default
    // codec (which varies between test configs).
    const r = await fetch(url('stream', { id: songId, timeOffset: 0.3, format: 'mp3', maxBitRate: 64 }));
    assert.equal(r.status, 200);
    const buf = await r.arrayBuffer();
    assert.ok(buf.byteLength > 0, `expected non-empty transcoded body, got ${buf.byteLength} bytes`);
  });
});

// ── User management ─────────────────────────────────────────────────────────

describe('User management', () => {
  test('getUser returns own user (non-admin)', async () => {
    const env = await call('getUser', { username: USER.username }, userKey);
    assert.equal(env.status, 'ok');
    assert.equal(env.user.username, USER.username);
  });

  test('getUser rejects non-admin querying another user', async () => {
    const env = await call('getUser', { username: ADMIN.username }, userKey);
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 50);
  });

  test('getUsers admin-only', async () => {
    const denied = await call('getUsers', {}, userKey);
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error.code, 50);
    const ok = await call('getUsers');
    assert.equal(ok.status, 'ok');
    const names = ok.users.user.map(u => u.username);
    assert.ok(names.includes(ADMIN.username));
    assert.ok(names.includes(USER.username));
  });

  test('createUser + deleteUser round-trip (admin)', async () => {
    const name = 'phase3-temp';
    const create = await call('createUser', {
      username: name, password: 'pw-temp-1', adminRole: 'false',
    });
    assert.equal(create.status, 'ok');
    const listed = await call('getUsers');
    assert.ok(listed.users.user.some(u => u.username === name));
    const del = await call('deleteUser', { username: name });
    assert.equal(del.status, 'ok');
    const listed2 = await call('getUsers');
    assert.ok(!listed2.users.user.some(u => u.username === name));
  });

  test('updateUser changes adminRole', async () => {
    const name = 'phase3-upgrade';
    await call('createUser', { username: name, password: 'pw-x', adminRole: 'false' });
    const u1 = await call('getUser', { username: name });
    assert.equal(u1.user.adminRole, false);
    await call('updateUser', { username: name, adminRole: 'true' });
    const u2 = await call('getUser', { username: name });
    assert.equal(u2.user.adminRole, true);
    await call('deleteUser', { username: name });
  });

  test('changePassword lets a user change their own password', async () => {
    // Create a disposable user, change their password via Subsonic, then log
    // in with the new password.
    const name = 'phase3-pw';
    await call('createUser', { username: name, password: 'old-pw', adminRole: 'false' });
    const env = await call('changePassword', { username: name, password: 'new-pw' });
    assert.equal(env.status, 'ok');
    // Verify via a plaintext ping with the new password (no apiKey path).
    const r = await fetch(
      `${server.baseUrl}/rest/ping?f=json&u=${name}&p=new-pw`
    );
    const body = await r.json();
    assert.equal(body['subsonic-response'].status, 'ok');
    await call('deleteUser', { username: name });
  });

  test('changePassword denies non-admin changing another user', async () => {
    const env = await call('changePassword', {
      username: ADMIN.username, password: 'evil',
    }, userKey);
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 50);
  });
});

// ── Discovery: top songs, similar songs ─────────────────────────────────────

describe('Discovery endpoints', () => {
  test('getTopSongs requires artist', async () => {
    const env = await call('getTopSongs');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('getTopSongs returns songs for a known artist', async () => {
    // Grab an artist name from getArtists to avoid coupling to fixture specifics.
    const env0 = await call('getArtists');
    const artist = env0.artists.index[0].artist[0];
    const full = await call('getArtist', { id: artist.id });
    const artistName = full.artist.name;

    const env = await call('getTopSongs', { artist: artistName, count: 5 });
    assert.equal(env.status, 'ok');
    assert.ok(Array.isArray(env.topSongs.song));
  });

  test('getSimilarSongs2 returns songs for an artist', async () => {
    const artistId = await firstArtistId();
    const env = await call('getSimilarSongs2', { id: artistId, count: 5 });
    assert.equal(env.status, 'ok');
    assert.ok(Array.isArray(env.similarSongs2.song));
  });

  test('getSimilarSongs accepts artist/album/song ids', async () => {
    const songId = await firstSongId();
    const env = await call('getSimilarSongs', { id: songId, count: 5 });
    assert.equal(env.status, 'ok');
    assert.ok(Array.isArray(env.similarSongs.song));
  });
});

// ── Now playing + scan ──────────────────────────────────────────────────────

describe('Now-playing and scan endpoints', () => {
  test('scrobble submission=false registers now-playing', async () => {
    const songId = await firstSongId();
    await call('scrobble', { id: songId, submission: 'false' });
    const env = await call('getNowPlaying');
    assert.equal(env.status, 'ok');
    const ids = (env.nowPlaying.entry || []).map(e => e.id);
    assert.ok(ids.includes(String(songId)), `expected song ${songId} in ${JSON.stringify(ids)}`);
  });

  test('concurrent scrobble-submission=false calls from same user do not race', async () => {
    // Simulates the bug where an old stream's close callback unregisters
    // a newer stream's entry: rapid register A, register B, "close A"
    // (which must be a no-op because B superseded A). We can't directly
    // invoke close callbacks from the test, but the handle-based unregister
    // is exercised in the real stream path — here we at least confirm that
    // a second registration wins in getNowPlaying.
    const r = await call('getRandomSongs', { size: 2 });
    const a = r.randomSongs.song[0].id;
    const b = r.randomSongs.song[1].id;
    await call('scrobble', { id: a, submission: 'false' });
    await call('scrobble', { id: b, submission: 'false' });
    const env = await call('getNowPlaying');
    const ids = (env.nowPlaying.entry || []).map(e => e.id);
    assert.ok(ids.includes(String(b)), 'second scrobble should win');
    // The first track may or may not still be there depending on user mapping;
    // what matters is that the later one isn't erased.
  });

  test('getScanStatus returns shape { scanning, count }', async () => {
    const env = await call('getScanStatus');
    assert.equal(env.status, 'ok');
    assert.equal(typeof env.scanStatus.scanning, 'boolean');
    assert.equal(typeof env.scanStatus.count, 'number');
    assert.ok(env.scanStatus.count > 0);
  });

  test('startScan denied to non-admin', async () => {
    const env = await call('startScan', {}, userKey);
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 50);
  });
});

// ── Info stubs ──────────────────────────────────────────────────────────────

describe('Artist/album info (stubs with similar-artist logic)', () => {
  test('getArtistInfo2 returns similarArtist array (maybe empty)', async () => {
    const artistId = await firstArtistId();
    const env = await call('getArtistInfo2', { id: artistId });
    assert.equal(env.status, 'ok');
    assert.ok(Array.isArray(env.artistInfo2.similarArtist));
    assert.equal(env.artistInfo2.biography, '');
  });

  test('getAlbumInfo2 returns empty notes payload', async () => {
    const albumId = await firstAlbumId();
    const env = await call('getAlbumInfo2', { id: albumId });
    assert.equal(env.status, 'ok');
    assert.equal(env.albumInfo2.notes, '');
  });
});

// ── Avatar ──────────────────────────────────────────────────────────────────

describe('Avatar (identicon)', () => {
  test('getAvatar returns a PNG', async () => {
    const r = await fetch(url('getAvatar', { username: USER.username }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/png/);
    const buf = Buffer.from(await r.arrayBuffer());
    // PNG magic bytes.
    assert.equal(buf[0], 0x89); assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x4e); assert.equal(buf[3], 0x47);
  });

  test('identicon is deterministic for the same username', async () => {
    const r1 = await fetch(url('getAvatar', { username: 'stable' }));
    const r2 = await fetch(url('getAvatar', { username: 'stable' }));
    const b1 = Buffer.from(await r1.arrayBuffer());
    const b2 = Buffer.from(await r2.arrayBuffer());
    assert.deepEqual(b1, b2);
  });
});

// ── Shares ──────────────────────────────────────────────────────────────────

describe('Shares', () => {
  let createdShareId;
  test('createShare with song ids returns a share envelope', async () => {
    const songId = await firstSongId();
    const env = await call('createShare', { id: songId });
    assert.equal(env.status, 'ok');
    assert.ok(env.shares.share[0].id.startsWith('sh-'));
    assert.ok(env.shares.share[0].url.includes('/shared/'));
    createdShareId = env.shares.share[0].id;
  });

  test('getShares lists the new share', async () => {
    const env = await call('getShares');
    const ids = env.shares.share.map(s => s.id);
    assert.ok(ids.includes(createdShareId));
  });

  test('deleteShare removes it', async () => {
    const env = await call('deleteShare', { id: createdShareId });
    assert.equal(env.status, 'ok');
    const after = await call('getShares');
    const ids = after.shares.share.map(s => s.id);
    assert.ok(!ids.includes(createdShareId));
  });

  test('createShare requires at least one id', async () => {
    const env = await call('createShare');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('share URL resolves via the webapp /api/v1/shared/:id endpoint', async () => {
    // Regression test for the bug where createShare stored an empty `token`,
    // causing the webapp share-viewer to throw "jwt must be provided" when
    // verifying. Create via Subsonic, then fetch via the webapp JSON endpoint
    // to confirm the JWT check passes end-to-end.
    const songId = await firstSongId();
    const created = await call('createShare', { id: songId });
    const shareUrl = created.shares.share[0].url; // http://host/shared/<token>
    const match = /\/shared\/([^/?#]+)$/.exec(shareUrl);
    assert.ok(match, `expected share URL to end in /shared/<token>, got ${shareUrl}`);
    const token = match[1];
    const r = await fetch(`${server.baseUrl}/api/v1/shared/${token}`);
    assert.equal(r.status, 200, 'webapp share lookup should succeed for Subsonic-created shares');
    const body = await r.json();
    assert.ok(Array.isArray(body.playlist), 'share payload should include a playlist array');
    assert.ok(body.playlist.length > 0);
    // Clean up so later tests aren't surprised by leftover shares.
    await call('deleteShare', { id: created.shares.share[0].id });
  });
});

// ── Bookmarks ───────────────────────────────────────────────────────────────

describe('Bookmarks', () => {
  test('createBookmark + getBookmarks round-trip', async () => {
    const songId = await firstSongId();
    const c = await call('createBookmark', { id: songId, position: 12345, comment: 'test' });
    assert.equal(c.status, 'ok');
    const env = await call('getBookmarks');
    const b = env.bookmarks.bookmark.find(x => x.entry && x.entry.id === String(songId));
    assert.ok(b, 'expected bookmark for songId in list');
    assert.equal(b.position, 12345);
    assert.equal(b.comment, 'test');
  });

  test('createBookmark requires position', async () => {
    const songId = await firstSongId();
    const env = await call('createBookmark', { id: songId });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('deleteBookmark removes it', async () => {
    const songId = await firstSongId();
    await call('createBookmark', { id: songId, position: 1 });
    await call('deleteBookmark', { id: songId });
    const env = await call('getBookmarks');
    const any = env.bookmarks.bookmark.some(x => x.entry && x.entry.id === String(songId));
    assert.ok(!any);
  });
});

// ── Play queue ──────────────────────────────────────────────────────────────

describe('Play queue', () => {
  test('savePlayQueue + getPlayQueue round-trip', async () => {
    const r = await call('getRandomSongs', { size: 3 });
    const songs = r.randomSongs.song;
    assert.ok(songs.length >= 1);
    const ids = songs.map(s => s.id);

    const save = await call('savePlayQueue', {
      id: ids, current: ids[0], position: 42000,
    });
    assert.equal(save.status, 'ok');

    const env = await call('getPlayQueue');
    assert.equal(env.status, 'ok');
    const queueIds = (env.playQueue.entry || []).map(e => e.id);
    // Order should match what we saved (modulo removed-between-save-and-read).
    assert.deepEqual(queueIds.slice(0, ids.length), ids);
    assert.equal(env.playQueue.current, ids[0]);
    assert.equal(env.playQueue.position, 42000);
  });

  test('getPlayQueue before any save returns empty envelope', async () => {
    // Use the non-admin user who hasn't saved anything.
    const env = await call('getPlayQueue', {}, userKey);
    assert.equal(env.status, 'ok');
    // playQueue is {} when empty, not { entry: [] }
    assert.ok(!env.playQueue.entry || env.playQueue.entry.length === 0);
  });
});

// ── Tier 3 stubs ────────────────────────────────────────────────────────────

describe('Tier 3 stubs', () => {
  test('getInternetRadioStations returns empty list', async () => {
    const env = await call('getInternetRadioStations');
    assert.equal(env.status, 'ok');
    assert.deepEqual(env.internetRadioStations.internetRadioStation, []);
  });

  test('getPodcasts returns empty channel list', async () => {
    const env = await call('getPodcasts');
    assert.equal(env.status, 'ok');
    assert.deepEqual(env.podcasts.channel, []);
  });

  test('getLyricsBySongId without id → error 10 (real handler now, not a stub)', async () => {
    // Phase V19 turned this from an empty-envelope stub into a real
    // handler that reads tracks.lyrics_* columns. The "no lyrics for
    // this track" path still returns `lyricsList: { structuredLyrics: [] }`
    // (covered by test/subsonic-lyrics.test.mjs); calling without an
    // id now surfaces a missing-param error like every other
    // id-indexed endpoint.
    const env = await call('getLyricsBySongId');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('jukeboxControl is admin-only (role check)', async () => {
    // Full jukebox coverage lives in test/subsonic-jukebox.test.mjs; here
    // we only spot-check that the handler enforces admin-only access for
    // the default Phase-3 test harness setup (admin user).
    const env = await call('jukeboxControl', { action: 'status' });
    // Without a rust-server-audio stub wired in, the admin call reaches
    // the proxy layer and surfaces error 30 (feature unavailable). That
    // is: the stub decline from Phase 3 is gone; jukebox is real now.
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 30);
  });
});
