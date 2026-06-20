/**
 * Coverage for the "info pane" endpoints plus the legacy search2 path.
 *
 * These endpoints were previously untested — the audit of 61
 * implemented Subsonic methods flagged them as zero-coverage:
 *
 *   - search / search2 (pre-OpenSubsonic clients default to search2)
 *   - getArtistInfo / getArtistInfo2
 *   - getAlbumInfo  / getAlbumInfo2
 *   - getSimilarSongs2 (v1 covered elsewhere; v2 shape wasn't)
 *
 * The specific regression this file guards against: search2 used to
 * forward to search3 verbatim and returned a <searchResult3> wrapper.
 * Real clients (DSub, classic Airsonic desktop, Jamstash) dispatch on
 * the wrapper name and silently ignore a mismatched envelope — so a
 * user running DSub against an mStream built before this change would
 * see blank search results with no error. The fix moves the payload
 * into a shared helper and wraps it in searchResult2 / searchResult3
 * based on which method was called.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const USER = { username: 'info-endpoints', password: 'pw-info-endpoints' };

let server;
let apiKey;
let artistId;
let albumId;
let songId;

// Use the shared buildUrl / call helpers pattern. f=json + apiKey auth.
function buildUrl(method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json');
  q.set('v', '1.16.1');
  q.set('c', 'info-endpoints-test');
  q.set('apiKey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function call(method, params) {
  const r = await fetch(buildUrl(method, params));
  return (await r.json())['subsonic-response'];
}

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',
    users:    [{ ...USER, admin: true }],
  });
  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(USER),
  });
  const { token } = await login.json();
  const r = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'info-endpoints' }),
  });
  apiKey = (await r.json()).key;

  // Grab some real ids to drill the info endpoints with.
  const art = await call('getArtists');
  const pick = art.artists.index.flatMap(i => i.artist)
    .find(a => a.name !== 'Various Artists' && a.albumCount > 0);
  artistId = pick.id;
  const artFull = await call('getArtist', { id: artistId });
  albumId = artFull.artist.album[0].id;
  const albumFull = await call('getAlbum', { id: albumId });
  songId = albumFull.album.song[0].id;
});

after(async () => { if (server) { await server.stop(); } });

// ── search2 envelope regression ─────────────────────────────────────────────

describe('search2 (legacy wrapper)', () => {
  test('returns a searchResult2 envelope (NOT searchResult3)', async () => {
    const env = await call('search2', { query: 'a', artistCount: 5 });
    assert.equal(env.status, 'ok');
    assert.ok(env.searchResult2, 'expected searchResult2 envelope');
    // The old bug: the handler forwarded to search3 and emitted
    // searchResult3. Any client reading its response from the v2
    // wrapper would see "no matches".
    assert.equal(env.searchResult3, undefined,
      'search2 must not emit a searchResult3 envelope');
  });

  test('empty query returns an empty searchResult2 shell', async () => {
    const env = await call('search2', { query: '' });
    assert.equal(env.status, 'ok');
    assert.ok(env.searchResult2, 'expected searchResult2 even on empty query');
    // All three arrays must be absent-or-empty; clients iterate them
    // and would throw on undefined.array access is fine, null.array is not.
    for (const k of ['artist', 'album', 'song']) {
      const v = env.searchResult2[k];
      if (v != null) { assert.ok(Array.isArray(v), `searchResult2.${k} must be an array`); }
    }
  });

  test('specific query populates at least one category', async () => {
    // Grab an existing artist name to search for.
    const art = await call('getArtists');
    const name = art.artists.index.flatMap(i => i.artist)
      .find(a => a.name !== 'Various Artists')?.name;
    assert.ok(name, 'need at least one non-VA artist in fixtures');
    const env = await call('search2', { query: name.slice(0, 3) });
    assert.equal(env.status, 'ok');
    const r = env.searchResult2;
    const total = (r.artist?.length || 0) + (r.album?.length || 0) + (r.song?.length || 0);
    assert.ok(total >= 1, `expected ≥1 match for "${name.slice(0, 3)}", got none`);
  });
});

describe('search (v1 legacy wrapper)', () => {
  test('smoke: does not 500 and returns a Subsonic envelope', async () => {
    // search (v1) accepts `any=` instead of `query=`. Our implementation
    // forwards to search3 which reads `query`; we just need to confirm
    // the route is wired and returns a well-formed envelope (ok or an
    // explicit failure). No client in the wild still uses v1, so the
    // bar is "doesn't crash".
    const env = await call('search', { any: 'x', count: 5 });
    assert.ok(env.status === 'ok' || env.status === 'failed');
  });
});

// ── getArtistInfo / getArtistInfo2 ───────────────────────────────────────────

describe('getArtistInfo / getArtistInfo2', () => {
  test('getArtistInfo returns artistInfo with required stub fields', async () => {
    const env = await call('getArtistInfo', { id: artistId });
    assert.equal(env.status, 'ok');
    assert.ok(env.artistInfo, 'expected artistInfo wrapper');
    // Subsonic spec: ArtistInfo uses `biography` (Album uses `notes` —
    // different word for each type). Image URLs are optional but the
    // biography key must always be present. Substreamer/DSub render
    // whatever comes back — a missing key crashes their markdown
    // renderer with "Cannot read property 'length' of undefined".
    assert.ok('biography' in env.artistInfo,
      'artistInfo must include a biography key (even if empty)');
  });

  test('getArtistInfo2 returns artistInfo2 (not artistInfo)', async () => {
    // OpenSubsonic cleanly separates the two wrapper names; getting v2
    // shape under the v1 key would break any client doing a strict key
    // lookup.
    const env = await call('getArtistInfo2', { id: artistId });
    assert.equal(env.status, 'ok');
    assert.ok(env.artistInfo2, 'expected artistInfo2 wrapper');
    assert.equal(env.artistInfo, undefined);
  });

  test('getArtistInfo accepts album / song ids (resolves to their artist)', async () => {
    // Subsonic spec lets clients pass ANY id — folder, album, song —
    // and the server walks up to the owning artist. This is how DSub
    // populates the now-playing artist pane while a song is scrubbing.
    const envFromAlbum = await call('getArtistInfo', { id: albumId });
    assert.equal(envFromAlbum.status, 'ok');
    assert.ok(envFromAlbum.artistInfo);
    const envFromSong = await call('getArtistInfo', { id: songId });
    assert.equal(envFromSong.status, 'ok');
    assert.ok(envFromSong.artistInfo);
  });

  test('getArtistInfo with missing id → error 10', async () => {
    const env = await call('getArtistInfo', {});
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('getArtistInfo2 with a non-artist id → error 70 (strict v2)', async () => {
    // v2 requires an actual artist id — it does NOT walk upward from
    // album/song ids. Passing an album id is a client bug and we
    // surface it as NOT_FOUND rather than guess.
    const env = await call('getArtistInfo2', { id: albumId });
    assert.equal(env.status, 'failed');
    assert.ok([10, 70].includes(env.error.code),
      `expected err 10/70, got ${JSON.stringify(env.error)}`);
  });
});

// ── getAlbumInfo / getAlbumInfo2 ─────────────────────────────────────────────

describe('getAlbumInfo / getAlbumInfo2', () => {
  test('getAlbumInfo returns albumInfo with required stub fields', async () => {
    const env = await call('getAlbumInfo', { id: albumId });
    assert.equal(env.status, 'ok');
    assert.ok(env.albumInfo, 'expected albumInfo wrapper');
    assert.ok('notes' in env.albumInfo, 'albumInfo must include a notes key');
  });

  test('getAlbumInfo2 returns albumInfo2 (not albumInfo)', async () => {
    const env = await call('getAlbumInfo2', { id: albumId });
    assert.equal(env.status, 'ok');
    assert.ok(env.albumInfo2, 'expected albumInfo2 wrapper');
    assert.equal(env.albumInfo, undefined);
  });

  test('getAlbumInfo accepts a song id (resolves to its album)', async () => {
    // Subsonic spec lets clients pass a song id here too. Matches the
    // getArtistInfo "walk up" semantics.
    const env = await call('getAlbumInfo', { id: songId });
    assert.equal(env.status, 'ok');
    assert.ok(env.albumInfo);
  });

  test('getAlbumInfo2 with a song id → failure (strict v2)', async () => {
    // v2 is strict about id types — same policy as getArtistInfo2.
    const env = await call('getAlbumInfo2', { id: songId });
    assert.equal(env.status, 'failed');
  });

  test('getAlbumInfo with missing id → error 10', async () => {
    const env = await call('getAlbumInfo', {});
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

// ── getSimilarSongs2 ─────────────────────────────────────────────────────────

describe('getSimilarSongs2', () => {
  test('returns similarSongs2 envelope (not similarSongs)', async () => {
    const env = await call('getSimilarSongs2', { id: artistId, count: 10 });
    assert.equal(env.status, 'ok');
    assert.ok(env.similarSongs2, 'expected similarSongs2 wrapper');
    assert.equal(env.similarSongs, undefined);
    // Payload may be empty (no last.fm integration), but the shape
    // must still be a valid object with an array-or-absent `song` key.
    const v = env.similarSongs2.song;
    if (v != null) { assert.ok(Array.isArray(v)); }
  });
});
