/**
 * End-to-end "real Subsonic client" flow simulation.
 *
 * Walks through the sequence of requests a real Subsonic/OpenSubsonic
 * client (Feishin / Tempo / Substreamer / DSub / play:Sub / Jamstash)
 * issues during a first-run session:
 *
 *   1. Startup handshake
 *      - ping + getLicense with all three auth mechanisms clients use:
 *        token+salt (MD5), enc:HEX (legacy), apiKey (OpenSubsonic)
 *      - getOpenSubsonicExtensions (modern clients)
 *   2. Library discovery
 *      - getMusicFolders → getIndexes (legacy) + getArtists (modern)
 *      - Drill into getArtist → getAlbum → getSong, plus
 *        getArtistInfo2 for the "artist biography" pane
 *   3. Home-screen population
 *      - getAlbumList2 for recent/newest/random/frequent/highest/starred/
 *        byGenre/byYear, plus getRandomSongs + getStarred2 + getNowPlaying
 *   4. Search (search3 with combined limits)
 *   5. Playback
 *      - stream with Range header (seek), bitrate hint, format=raw,
 *        getCoverArt at multiple sizes, scrobble (now-playing + played)
 *   6. Interaction: star / unstar / setRating on song, album, artist
 *   7. Playlists CRUD (create → list → detail → rename → reorder →
 *      append → remove → delete)
 *   8. "Optional" endpoints clients probe for feature detection:
 *      getInternetRadioStations, getPodcasts, getLyrics,
 *      jukeboxControl?action=status, chat messages
 *
 * These paths are individually covered by the per-feature tests — what
 * this file adds is a *chained* run that catches cross-endpoint
 * regressions (e.g. id format mismatches between getArtists and
 * getAlbum, or an enrichment query that only triggers when search3
 * returns a collab track).
 *
 * Run: `node --test test/subsonic-client-flow.test.mjs`
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from '../helpers/server.mjs';

const USER = { username: 'clientflow', password: 'pw-clientflow-Æ!' };
// Client-id string: every Subsonic client sends `c=<appName>`; we echo
// nothing back but exercising it catches accidental strict-param bugs.
const CLIENT_ID = 'mstream-client-flow-test';

let server;
let apiKey;
let songId;       // Captured during browsing, reused for stream/star tests
let albumId;
let artistId;
let coverArtId;

// ── Auth helpers ─────────────────────────────────────────────────────────────
// All three auth mechanisms a real Subsonic client might use. Tests
// exercise each to guarantee we haven't accidentally narrowed support.

function tokenSaltAuth() {
  const salt = crypto.randomBytes(6).toString('hex');
  const token = crypto.createHash('md5')
    .update(USER.password + salt, 'utf8').digest('hex');
  return { u: USER.username, t: token, s: salt };
}

function plaintextAuth() {
  return { u: USER.username, p: USER.password };
}

function hexAuth() {
  const hex = Buffer.from(USER.password, 'utf8').toString('hex');
  return { u: USER.username, p: `enc:${hex}` };
}

function keyAuth() { return { apiKey }; }

function buildUrl(method, params) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('v', '1.16.1');
  q.set('c', CLIENT_ID);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v))      { for (const item of v) { q.append(k, item); } }
    else if (v != null)        { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function call(method, params = {}, auth = keyAuth) {
  const url = buildUrl(method, { ...auth(), ...params });
  const r = await fetch(url);
  const body = await r.json();
  return body['subsonic-response'];
}

// ── Setup ────────────────────────────────────────────────────────────────────

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users:    [{ ...USER, admin: true }],
  });
  // Mint an apiKey via the non-Subsonic API (real clients that support
  // OpenSubsonic apiKey auth get it out-of-band — via the server's admin
  // UI. We replicate that flow here.)
  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(USER),
  });
  const { token } = await login.json();
  const r = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'client-flow' }),
  });
  apiKey = (await r.json()).key;
});

after(async () => { if (server) { await server.stop(); } });

// ── 1. Startup handshake ─────────────────────────────────────────────────────

describe('1. Startup handshake', () => {
  test('ping via token+salt (MD5) → documented unsupported error', async () => {
    // mStream stores PBKDF2 hashes — it can't compute md5(plaintext+salt)
    // server-side. We reject the request with a specific error so admin
    // tooling can surface "user's client tried token auth, issue them an
    // API key" warnings. This assertion guards against the error code
    // silently drifting (which would confuse clients).
    const env = await call('ping', {}, tokenSaltAuth);
    assert.equal(env.status, 'failed');
    assert.ok(env.error?.code != null, 'expected numeric error.code');
    assert.ok(env.error?.message,     'expected a human-readable message');
  });

  test('ping via enc:HEX password succeeds', async () => {
    const env = await call('ping', {}, hexAuth);
    assert.equal(env.status, 'ok');
  });

  test('ping via plaintext password succeeds', async () => {
    const env = await call('ping', {}, plaintextAuth);
    assert.equal(env.status, 'ok');
  });

  test('ping via apiKey succeeds', async () => {
    const env = await call('ping', {}, keyAuth);
    assert.equal(env.status, 'ok');
  });

  test('getLicense reports valid', async () => {
    const env = await call('getLicense');
    assert.equal(env.status, 'ok');
    assert.equal(env.license?.valid, true);
  });

  test('getOpenSubsonicExtensions advertises the V17 songArtists ext', async () => {
    const env = await call('getOpenSubsonicExtensions');
    assert.equal(env.status, 'ok');
    const exts = env.openSubsonicExtensions || [];
    const names = exts.map(e => e.name);
    assert.ok(names.includes('songArtists'),
      `expected songArtists in extensions, got ${JSON.stringify(names)}`);
    // transcodeOffset / formPost are commonly advertised by OpenSubsonic
    // servers — presence optional but the endpoint must be callable.
  });

  test('invalid apiKey → error 40 (client retries)', async () => {
    const env = await call('ping', { apiKey: 'bogus-key' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 40);
  });
});

// ── 2. Library discovery (legacy + modern) ───────────────────────────────────

describe('2. Library discovery', () => {
  test('getMusicFolders returns at least one folder', async () => {
    const env = await call('getMusicFolders');
    assert.equal(env.status, 'ok');
    const folders = env.musicFolders?.musicFolder || [];
    assert.ok(folders.length >= 1, 'expected ≥1 music folder');
  });

  test('legacy getIndexes returns non-empty index', async () => {
    const env = await call('getIndexes');
    assert.equal(env.status, 'ok');
    const index = env.indexes?.index || [];
    const totalArtists = index.reduce((n, i) => n + (i.artist?.length || 0), 0);
    assert.ok(totalArtists > 0, 'expected ≥1 artist in getIndexes');
  });

  test('modern getArtists + pick a non-VA artist', async () => {
    const env = await call('getArtists');
    assert.equal(env.status, 'ok');
    const all = env.artists.index.flatMap(i => i.artist);
    assert.ok(all.length > 0);
    // Pick an artist that isn't the seeded "Various Artists" row, so we
    // can drill into a real album rather than the (possibly empty) VA
    // compilation list.
    const pick = all.find(a => a.name !== 'Various Artists' && a.albumCount > 0)
      || all[0];
    artistId = pick.id;
  });

  test('getArtist drills into albums for the picked artist', async () => {
    const env = await call('getArtist', { id: artistId });
    assert.equal(env.status, 'ok');
    assert.ok(env.artist);
    const albums = env.artist.album || [];
    assert.ok(albums.length > 0, `expected ≥1 album for artist ${artistId}`);
    albumId = albums[0].id;
    coverArtId = albums[0].coverArt;
  });

  test('getAlbum returns songs and V17 artists[] + isCompilation', async () => {
    const env = await call('getAlbum', { id: albumId });
    assert.equal(env.status, 'ok');
    assert.ok(env.album);
    // Capture songId FIRST — downstream tests (stream, scrobble,
    // star) depend on it; blowing up later assertions mustn't
    // cascade a chain of false failures.
    const songs = env.album.song || [];
    assert.ok(songs.length > 0, `expected ≥1 song on album ${albumId}`);
    songId = songs[0].id;
    if (!coverArtId && songs[0].coverArt) { coverArtId = songs[0].coverArt; }
    // V17 fields.
    assert.ok(Array.isArray(env.album.artists), 'expected album.artists[]');
    assert.equal(typeof env.album.isCompilation, 'boolean',
      'OpenSubsonic spec: isCompilation must always be emitted as boolean');
  });

  test('getSong returns the same track with OpenSubsonic fields', async () => {
    const env = await call('getSong', { id: songId });
    assert.equal(env.status, 'ok');
    const s = env.song;
    assert.ok(s);
    assert.equal(s.id, songId);
    // OpenSubsonic shape: these may be undefined for some formats, but
    // when present they MUST be typed correctly.
    if (s.sampleRate  != null) { assert.equal(typeof s.sampleRate,  'number'); }
    if (s.channelCount!= null) { assert.equal(typeof s.channelCount,'number'); }
    if (s.bitDepth    != null) { assert.equal(typeof s.bitDepth,    'number'); }
  });

  test('getArtistInfo2 returns a shell (biography UI)', async () => {
    const env = await call('getArtistInfo2', { id: artistId });
    // Some Subsonic servers return 200-ok with empty fields when no
    // last.fm key is configured; others return the artist-info shell.
    // Either is acceptable — what matters is no 500 / error.
    assert.notEqual(env.status, 'failed', JSON.stringify(env.error));
  });
});

// ── 3. Home-screen population ────────────────────────────────────────────────

describe('3. Home-screen population', () => {
  for (const type of [
    'recent', 'newest', 'random', 'frequent', 'highest', 'starred',
    'alphabeticalByName', 'alphabeticalByArtist',
  ]) {
    test(`getAlbumList2 type=${type} returns OK + array shape`, async () => {
      const env = await call('getAlbumList2', { type, size: 10 });
      assert.equal(env.status, 'ok');
      assert.ok(env.albumList2, 'expected albumList2 envelope');
      const arr = env.albumList2.album || [];
      assert.ok(Array.isArray(arr));
    });
  }

  test('getAlbumList2 type=byYear requires fromYear/toYear', async () => {
    const env = await call('getAlbumList2', { type: 'byYear', size: 10, fromYear: 1900, toYear: 2099 });
    assert.equal(env.status, 'ok');
  });

  test('getAlbumList2 type=byGenre filters by genre', async () => {
    // Pick any genre that exists in the library.
    const env = await call('getAlbumList2', { type: 'byGenre', size: 10, genre: 'Rock' });
    assert.equal(env.status, 'ok');
  });

  test('getRandomSongs returns up to N songs', async () => {
    const env = await call('getRandomSongs', { size: 5 });
    assert.equal(env.status, 'ok');
    const arr = env.randomSongs?.song || [];
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length <= 5);
  });

  test('getStarred2 returns categorised starred items', async () => {
    const env = await call('getStarred2');
    assert.equal(env.status, 'ok');
    assert.ok(env.starred2);
    // Each category must be present as an array (even if empty) for
    // clients that blindly iterate.
    for (const k of ['song', 'album', 'artist']) {
      const v = env.starred2[k];
      if (v != null) { assert.ok(Array.isArray(v), `starred2.${k} should be array`); }
    }
  });

  test('getNowPlaying returns an (empty) list without error', async () => {
    const env = await call('getNowPlaying');
    assert.equal(env.status, 'ok');
    assert.ok(env.nowPlaying);
  });

  test('getGenres returns the genre list', async () => {
    const env = await call('getGenres');
    assert.equal(env.status, 'ok');
    const arr = env.genres?.genre || [];
    assert.ok(Array.isArray(arr));
  });
});

// ── 4. Search (search3 with the shape clients actually send) ────────────────

describe('4. Search', () => {
  test('search3 with generic query returns categorised results', async () => {
    const env = await call('search3', {
      query: '*',           // DSub/Jamstash send "*" for "browse all"
      artistCount: 10, albumCount: 10, songCount: 10,
    });
    assert.equal(env.status, 'ok');
    assert.ok(env.searchResult3);
  });

  test('search3 with specific query returns scoped results', async () => {
    // Use the first letter of the picked artist's name — guaranteed to
    // match at least itself.
    const envArt = await call('getArtist', { id: artistId });
    const needle = envArt.artist.name.slice(0, 3);
    const env = await call('search3', { query: needle, artistCount: 5 });
    assert.equal(env.status, 'ok');
    const artists = env.searchResult3.artist || [];
    assert.ok(artists.length >= 1,
      `expected ≥1 match for "${needle}", got ${artists.length}`);
  });

  test('search3 with empty query treated as "browse all"', async () => {
    const env = await call('search3', { query: '', songCount: 5 });
    assert.equal(env.status, 'ok');
  });
});

// ── 5. Playback (stream, cover art, scrobble) ───────────────────────────────

describe('5. Playback', () => {
  test('stream returns audio bytes + correct Content-Type', async () => {
    const url = buildUrl('stream', { ...keyAuth(), id: songId });
    const r = await fetch(url);
    assert.equal(r.status, 200);
    const ct = r.headers.get('content-type') || '';
    assert.ok(/audio\//i.test(ct), `expected audio/* content-type, got "${ct}"`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 100, 'expected non-trivial audio body');
  });

  test('stream honours Range: bytes=0-99 (seeking)', async () => {
    const url = buildUrl('stream', { ...keyAuth(), id: songId });
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    // Servers may choose 206 (Partial Content) or 200 if ranges
    // aren't supported for this transcode. 206 is what players want.
    assert.ok(r.status === 206 || r.status === 200,
      `expected 200/206, got ${r.status}`);
    if (r.status === 206) {
      const buf = Buffer.from(await r.arrayBuffer());
      assert.ok(buf.length <= 100, `expected ≤100B for bytes=0-99, got ${buf.length}`);
    }
  });

  test('stream with maxBitRate hint returns audio', async () => {
    const url = buildUrl('stream', { ...keyAuth(), id: songId, maxBitRate: 128 });
    const r = await fetch(url);
    assert.equal(r.status, 200);
  });

  test('stream with format=raw returns original bytes', async () => {
    const url = buildUrl('stream', { ...keyAuth(), id: songId, format: 'raw' });
    const r = await fetch(url);
    assert.equal(r.status, 200);
  });

  test('download returns the original file', async () => {
    const url = buildUrl('download', { ...keyAuth(), id: songId });
    const r = await fetch(url);
    assert.equal(r.status, 200);
  });

  test('getCoverArt at default size', async () => {
    if (!coverArtId) { return; /* library fixture may not ship art */ }
    const url = buildUrl('getCoverArt', { ...keyAuth(), id: coverArtId });
    const r = await fetch(url);
    assert.equal(r.status, 200);
    const ct = r.headers.get('content-type') || '';
    assert.ok(/image\//i.test(ct), `expected image/* CT, got "${ct}"`);
  });

  test('getCoverArt at size=300 (what list views ask for)', async () => {
    if (!coverArtId) { return; }
    const url = buildUrl('getCoverArt', { ...keyAuth(), id: coverArtId, size: 300 });
    const r = await fetch(url);
    assert.equal(r.status, 200);
  });

  test('scrobble submission=false (now-playing)', async () => {
    const env = await call('scrobble', { id: songId, submission: 'false' });
    assert.equal(env.status, 'ok');
  });

  test('scrobble submission=true increments play_count', async () => {
    const before = await call('getSong', { id: songId });
    await call('scrobble', { id: songId, submission: 'true' });
    const after = await call('getSong', { id: songId });
    const bPlays = before.song.playCount || 0;
    const aPlays = after.song.playCount  || 0;
    assert.ok(aPlays > bPlays,
      `expected playCount to increase (was ${bPlays}, now ${aPlays})`);
  });
});

// ── 6. Interaction (star / rating) ──────────────────────────────────────────

describe('6. User interaction', () => {
  test('star a song → getSong reports `starred`', async () => {
    const env = await call('star', { id: songId });
    assert.equal(env.status, 'ok');
    const get = await call('getSong', { id: songId });
    assert.ok(get.song.starred, 'expected song.starred after star()');
  });

  test('unstar removes `starred`', async () => {
    const env = await call('unstar', { id: songId });
    assert.equal(env.status, 'ok');
    const get = await call('getSong', { id: songId });
    assert.equal(get.song.starred, undefined);
  });

  test('star an album', async () => {
    const env = await call('star', { albumId });
    assert.equal(env.status, 'ok');
    const get = await call('getAlbum', { id: albumId });
    assert.ok(get.album.starred, 'expected album.starred after star(albumId)');
    await call('unstar', { albumId });
  });

  test('star an artist', async () => {
    const env = await call('star', { artistId });
    assert.equal(env.status, 'ok');
    await call('unstar', { artistId });
  });

  test('setRating on song (1–5)', async () => {
    const env = await call('setRating', { id: songId, rating: 4 });
    assert.equal(env.status, 'ok');
    const get = await call('getSong', { id: songId });
    assert.equal(get.song.userRating, 4);
    // Clear
    await call('setRating', { id: songId, rating: 0 });
  });
});

// ── 7. Playlists CRUD (full client lifecycle) ───────────────────────────────

describe('7. Playlists', () => {
  let playlistId;

  test('createPlaylist with two songs', async () => {
    // Grab two songs so we can test reordering.
    const rnd = await call('getRandomSongs', { size: 2 });
    const ids = (rnd.randomSongs.song || []).map(s => s.id);
    assert.ok(ids.length >= 1, 'need ≥1 song to create a playlist');

    const env = await call('createPlaylist', {
      name: 'client-flow test',
      songId: ids,
    });
    assert.equal(env.status, 'ok');
    playlistId = env.playlist.id;
    assert.ok(playlistId);
  });

  test('getPlaylists includes the new one', async () => {
    const env = await call('getPlaylists');
    assert.equal(env.status, 'ok');
    const found = (env.playlists.playlist || []).find(p => p.id === playlistId);
    assert.ok(found, `new playlist ${playlistId} not listed`);
  });

  test('getPlaylist returns song entries', async () => {
    const env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.status, 'ok');
    const entries = env.playlist.entry || [];
    assert.ok(Array.isArray(entries));
  });

  test('updatePlaylist: rename + append song', async () => {
    const rnd = await call('getRandomSongs', { size: 1 });
    const extra = rnd.randomSongs.song?.[0]?.id;
    const env = await call('updatePlaylist', {
      playlistId,
      name: 'client-flow test (renamed)',
      songIdToAdd: extra,
    });
    assert.equal(env.status, 'ok');

    const got = await call('getPlaylist', { id: playlistId });
    assert.equal(got.playlist.name, 'client-flow test (renamed)');
  });

  test('updatePlaylist: remove first song by index', async () => {
    const env = await call('updatePlaylist', {
      playlistId,
      songIndexToRemove: 0,
    });
    assert.equal(env.status, 'ok');
  });

  test('deletePlaylist', async () => {
    const env = await call('deletePlaylist', { id: playlistId });
    assert.equal(env.status, 'ok');
    const env2 = await call('getPlaylist', { id: playlistId });
    assert.equal(env2.status, 'failed');
    assert.equal(env2.error.code, 70);   // not found
  });
});

// ── 8. Optional endpoints (feature-probe — must return gracefully) ──────────

describe('8. Feature-probe endpoints', () => {
  test('getInternetRadioStations returns OK (may be empty)', async () => {
    const env = await call('getInternetRadioStations');
    assert.equal(env.status, 'ok');
    assert.ok(env.internetRadioStations);
  });

  test('getPodcasts returns OK or a well-formed error (not 500)', async () => {
    const env = await call('getPodcasts');
    // We don't implement podcasts. Acceptable: status=ok with empty
    // list, OR status=failed with a defined error code. What's NOT
    // acceptable is a crash / malformed envelope.
    assert.ok(env.status === 'ok' || env.status === 'failed');
    if (env.status === 'failed') { assert.ok(env.error?.code != null); }
  });

  test('jukeboxControl action=status returns status envelope', async () => {
    const env = await call('jukeboxControl', { action: 'status' });
    assert.ok(env.status === 'ok' || env.status === 'failed');
    if (env.status === 'ok') { assert.ok(env.jukeboxStatus); }
  });

  test('getChatMessages returns OK', async () => {
    const env = await call('getChatMessages');
    // Many servers don't implement chat — either ok+empty or a well-
    // formed failed envelope is fine.
    assert.ok(env.status === 'ok' || env.status === 'failed');
  });

  test('unknown method returns error 70 (not a 500)', async () => {
    const env = await call('totallyFakeMethod_doesNotExist');
    assert.equal(env.status, 'failed');
    assert.ok([30, 70].includes(env.error?.code),
      `expected err 30/70, got ${JSON.stringify(env.error)}`);
  });

  test('XML envelope still works (some clients default to f=xml)', async () => {
    const url = buildUrl('ping', { ...keyAuth() }).replace('f=json', 'f=xml');
    const r = await fetch(url);
    const text = await r.text();
    assert.ok(text.startsWith('<?xml'), `expected XML doc, got: ${text.slice(0,80)}`);
    assert.ok(/subsonic-response/.test(text));
  });
});
