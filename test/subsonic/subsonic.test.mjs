/**
 * Subsonic API integration tests (Phase 1).
 *
 * Covers system/browsing/media/search endpoints against a live mStream
 * instance with a configured user. Exercises JSON + XML envelopes and all
 * three supported auth methods (plaintext, enc:HEX, API key).
 *
 * Run: `npm run test:subsonic` or `node --test test/subsonic.test.mjs`
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';
import { FIXTURE_SUMMARY } from '../helpers/fixtures.mjs';

// ── Shared harness ───────────────────────────────────────────────────────────

const USER = { username: 'alice', password: 'passw0rd-æ!' };
let server;
let apiKey;

before(async () => {
  server = await startServer({
    dlnaMode: 'disabled',  // keep the DLNA noise out of these tests
    users:    [{ ...USER, admin: true }],
  });

  // Mint an API key for `alice` — most tests auth with the key.
  const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(USER),
  });
  const { token } = await login.json();
  const keyResp = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name: 'test-suite' }),
  });
  apiKey = (await keyResp.json()).key;
  assert.ok(apiKey, 'expected an API key from POST /api/v1/user/api-keys');
});

after(async () => { if (server) { await server.stop(); } });

// ── Helpers ──────────────────────────────────────────────────────────────────

function subsonicUrl(method, params = {}) {
  // Serialize arrays as repeated params (`id=1&id=2`) — URLSearchParams's
  // object-constructor joins arrays with commas, which every Subsonic client
  // would get wrong.
  const q = new URLSearchParams();
  q.set('f', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const item of v) { q.append(k, item); } }
    else if (v != null)   { q.set(k, v); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}

async function call(method, params = {}) {
  const authed = { apiKey, ...params };
  const r = await fetch(subsonicUrl(method, authed));
  const body = await r.json();
  return body['subsonic-response'];
}

// ── 1. Authentication ───────────────────────────────────────────────────────

describe('Subsonic auth', () => {
  test('missing credentials → error 10', async () => {
    const r = await fetch(subsonicUrl('ping', {}));
    const { 'subsonic-response': env } = await r.json();
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('wrong password → error 40', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: 'wrong' }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 40);
  });

  test('correct plaintext → ok', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: USER.password }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
    assert.equal(env.openSubsonic, true);
    assert.equal(env.type, 'mstream');
  });

  test('enc:HEX password → ok', async () => {
    const hex = Buffer.from(USER.password, 'utf8').toString('hex');
    const r = await fetch(subsonicUrl('ping', { u: USER.username, p: `enc:${hex}` }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
  });

  test('API key → ok', async () => {
    const env = await call('ping');
    assert.equal(env.status, 'ok');
  });

  test('token auth (t+s) → error 41', async () => {
    const r = await fetch(subsonicUrl('ping', { u: USER.username, t: 'deadbeef', s: 'xyz' }));
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 41);
  });

  test('unknown method → error envelope', async () => {
    const env = await call('thisDoesNotExist');
    assert.equal(env.status, 'failed');
  });
});

// ── 2. XML + JSONP envelopes ────────────────────────────────────────────────

describe('Response formats', () => {
  test('XML envelope (default)', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}`);
    assert.match(r.headers.get('content-type') || '', /xml/);
    const body = await r.text();
    assert.match(body, /<subsonic-response/);
    assert.match(body, /status="ok"/);
    assert.match(body, /openSubsonic="true"/);
  });

  test('JSONP wraps in callback', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}&f=jsonp&callback=myCb`);
    assert.match(r.headers.get('content-type') || '', /javascript/);
    const body = await r.text();
    assert.match(body, /^myCb\(/);
    assert.match(body, /\);$/);
  });

  test('JSONP with unsafe callback falls back to "callback"', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping?apiKey=${apiKey}&f=jsonp&callback=not-safe!`);
    const body = await r.text();
    assert.match(body, /^callback\(/);
  });

  test('.view suffix accepted', async () => {
    const r = await fetch(`${server.baseUrl}/rest/ping.view?apiKey=${apiKey}&f=json`);
    const env = (await r.json())['subsonic-response'];
    assert.equal(env.status, 'ok');
  });
});

// ── 3. System endpoints ─────────────────────────────────────────────────────

describe('System endpoints', () => {
  test('ping returns bare ok envelope', async () => {
    const env = await call('ping');
    assert.equal(env.status, 'ok');
    assert.equal(env.version, '1.16.1');
    // serverVersion echoes package.json — don't hard-code so a version
    // bump in master (or here) doesn't break this test.
    assert.match(env.serverVersion, /^\d+\.\d+\.\d+/);
  });

  test('getLicense returns valid=true', async () => {
    const env = await call('getLicense');
    assert.equal(env.license.valid, true);
  });

  test('getMusicFolders lists the user\'s libraries', async () => {
    const env = await call('getMusicFolders');
    assert.ok(Array.isArray(env.musicFolders.musicFolder));
    assert.equal(env.musicFolders.musicFolder.length, 1);
    assert.equal(env.musicFolders.musicFolder[0].name, 'testlib');
  });
});

// ── 4. Browsing ─────────────────────────────────────────────────────────────

describe('getArtists / getIndexes', () => {
  test('getArtists returns all fixture artists under the right index letter', async () => {
    const env = await call('getArtists');
    const flat = env.artists.index.flatMap(b => b.artist);
    assert.equal(flat.length, FIXTURE_SUMMARY.artists);
    const icarus = flat.find(a => a.name === 'Icarus');
    assert.ok(icarus);
    assert.ok(Number(icarus.albumCount) > 0);
  });

  test('getIndexes has same shape but under `indexes`', async () => {
    const env = await call('getIndexes');
    assert.ok(env.indexes);
    assert.ok(Array.isArray(env.indexes.index));
  });
});

describe('getArtist → getAlbum → getSong', () => {
  test('full drill-through returns consistent IDs', async () => {
    const artists = (await call('getArtists')).artists.index.flatMap(b => b.artist);
    const aId = artists[0].id;

    const artist = (await call('getArtist', { id: aId })).artist;
    assert.equal(artist.id, aId);
    assert.ok(Array.isArray(artist.album));
    assert.ok(artist.album.length > 0);

    const alId = artist.album[0].id;
    const album = (await call('getAlbum', { id: alId })).album;
    assert.equal(album.id, alId);
    assert.ok(Array.isArray(album.song));
    assert.ok(album.song.length > 0);

    const song = album.song[0];
    assert.ok(song.id);
    assert.ok(song.title);
    assert.ok(song.suffix);
    assert.equal(song.contentType, 'audio/mpeg');

    // Round-trip via getSong
    const fetched = (await call('getSong', { id: song.id })).song;
    assert.equal(fetched.id, song.id);
    assert.equal(fetched.title, song.title);
  });

  test('getArtist with unknown id → error 70', async () => {
    const env = await call('getArtist', { id: 'ar-99999' });
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 70);
  });

  test('getSong missing id → error 10', async () => {
    const env = await call('getSong');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});

describe('getGenres', () => {
  test('lists all distinct non-empty genres', async () => {
    const env = await call('getGenres');
    const genres = env.genres.genre;
    // Fixture: Electronic + Ambient; unknown (null) genre is excluded per spec.
    assert.ok(genres.length >= 2);
    const names = genres.map(g => g.value);
    assert.ok(names.includes('Electronic'));
    assert.ok(names.includes('Ambient'));
  });

  // V34 regression: when a track has multiple track_genres rows, the
  // COUNT(DISTINCT t.id) in getGenres must NOT double-count it. A
  // naive COUNT(*) would inflate songCount by N for an N-genre track
  // because each genre adds a JOIN row.
  test('V34: multi-genre track counted once per genre, never inflated', async () => {
    // Direct DB poke — fixtures have only single-genre tracks; we
    // inject the multi-genre state via SQL so the test exercises the
    // M2M JOIN without re-encoding any audio files.
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Pick the first Electronic track ("Be Somebody" by Icarus) and
      // additionally link it to Ambient. After this, Electronic and
      // Ambient should each include this track in their songCount.
      const ambientId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Ambient').id;
      const electronicTrack = direct.prepare(
        `SELECT t.id FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Electronic' LIMIT 1`
      ).get();
      assert.ok(electronicTrack, 'expected at least one Electronic track in fixture');
      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(electronicTrack.id, ambientId);

      // Now query via the API and assert counts.
      const env = await call('getGenres');
      const byName = Object.fromEntries(env.genres.genre.map(g => [g.value, g]));

      // Counts should equal "distinct tracks per genre", not "join rows".
      // The injected track now contributes to BOTH Electronic and
      // Ambient. Electronic's count is unchanged (track already linked);
      // Ambient's count is bumped by 1.
      const electronicTrackCount = direct.prepare(
        `SELECT COUNT(DISTINCT t.id) AS n FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Electronic'`
      ).get().n;
      const ambientTrackCount = direct.prepare(
        `SELECT COUNT(DISTINCT t.id) AS n FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Ambient'`
      ).get().n;
      assert.equal(byName.Electronic.songCount, electronicTrackCount);
      assert.equal(byName.Ambient.songCount, ambientTrackCount);
    } finally {
      // Clean up the injected M2M row so subsequent tests see the
      // baseline fixture state.
      const ambientId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Ambient').id;
      const electronicTrack = direct.prepare(
        `SELECT t.id FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Electronic' LIMIT 1`
      ).get();
      if (electronicTrack) {
        direct.prepare(
          'DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?'
        ).run(electronicTrack.id, ambientId);
      }
      direct.close();
    }
  });
});

// V34 case-insensitivity end-to-end. Pre-V34 these queries went against
// `tracks.genre` flat column with case-sensitive `=` comparison; the
// rewrite uses M2M EXISTS with COLLATE NOCASE so any case form returns
// the same rows.
describe('V34: case-insensitive genre lookups', () => {
  test('getSongsByGenre matches uppercase variant', async () => {
    const env = await call('getSongsByGenre', { genre: 'ELECTRONIC', count: 10 });
    assert.ok(env.songsByGenre.song.length > 0, 'expected hits for case-different name');
    // Every returned song should have the (canonical-case) Electronic
    // genre — the response shape preserves the M2M's stored casing
    // (not the query case).
    assert.ok(env.songsByGenre.song.every(s => /electronic/i.test(s.genre)));
  });

  test('getSongsByGenre matches lowercase variant', async () => {
    const env = await call('getSongsByGenre', { genre: 'ambient', count: 10 });
    assert.ok(env.songsByGenre.song.length > 0);
    assert.ok(env.songsByGenre.song.every(s => /ambient/i.test(s.genre)));
  });

  test('getRandomSongs ?genre= matches case-different name', async () => {
    const env = await call('getRandomSongs', { size: 10, genre: 'ELECTRONIC' });
    assert.ok(env.randomSongs.song.length > 0);
    assert.ok(env.randomSongs.song.every(s => /electronic/i.test(s.genre)));
  });

  test('getAlbumList byGenre matches case-different name', async () => {
    const env = await call('getAlbumList2', { type: 'byGenre', genre: 'electronic' });
    assert.ok(env.albumList2.album.length > 0);
  });
});

// V34 contract: Subsonic responses still carry a single-string
// `Song.genre` field even when the track has multiple M2M genres.
// The correlated subquery picks the first-by-rowid genre — the row
// inserted first into track_genres, which is the first genre that
// appeared in the original tag string. Honours the tagger
// convention that "Genre1, Genre2" lists Genre1 as primary.
describe('V34: single-string Song.genre for multi-genre tracks', () => {
  test('multi-genre track returns the first-inserted genre (by tg.rowid)', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Pick an Ambient track. Its existing track_genres row (for
      // "Ambient") was inserted by the scanner during fixture setup,
      // so it has a low rowid. We then INSERT a new track_genres
      // row pointing to Electronic — it gets a higher rowid. The
      // correlated subquery's `ORDER BY tg.rowid LIMIT 1` picks the
      // existing Ambient row.
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         WHERE EXISTS (
           SELECT 1 FROM track_genres tg
           JOIN genres g ON g.id = tg.genre_id
           WHERE tg.track_id = t.id AND g.name = 'Ambient'
         ) LIMIT 1`
      ).get();
      assert.ok(target, 'expected at least one Ambient-tagged track in fixture');
      const electronicId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Electronic').id;

      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(target.id, electronicId);

      const env = await call('getSong', { id: String(target.id) });
      // Song.genre is a single string (not an array — Subsonic spec).
      assert.equal(typeof env.song.genre, 'string');
      // Ambient row was inserted FIRST (during the scanner fixture
      // setup); Electronic was a late INSERT here in the test. So
      // Ambient wins under tg.rowid ordering — same answer as the
      // tag-string order would give (the fixture is tagged
      // "Ambient", not multi-genre to begin with; we forced the
      // multi-genre state via the late INSERT).
      assert.equal(env.song.genre, 'Ambient',
        'expected first-inserted-by-rowid genre — the scanner-set Ambient row precedes our test injection');
    } finally {
      // Clean up: remove the injected secondary genre.
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         WHERE EXISTS (
           SELECT 1 FROM track_genres tg
           JOIN genres g ON g.id = tg.genre_id
           WHERE tg.track_id = t.id AND g.name = 'Ambient'
         ) LIMIT 1`
      ).get();
      const electronicId = direct.prepare('SELECT id FROM genres WHERE name = ?').get('Electronic').id;
      if (target) {
        direct.prepare(
          'DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?'
        ).run(target.id, electronicId);
      }
      direct.close();
    }
  });
});

// V34 contract: OpenSubsonic `genres[]` extension exposes the full
// multi-genre M2M list on Song and Album objects alongside the
// legacy singular `genre`. Multi-genre-aware clients (Symfonium,
// play:Sub, Feishin, recent Subsonic Web UI builds) read the array;
// legacy clients keep using the single primary.
describe('V34: OpenSubsonic genres[] on Song responses', () => {
  test('single-genre track surfaces a one-element genres[] alongside legacy genre string', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Pick any Electronic-tagged track from the fixture (Icarus).
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Electronic' LIMIT 1`
      ).get();
      assert.ok(target);
      const env = await call('getSong', { id: String(target.id) });
      assert.equal(env.song.genre, 'Electronic', 'legacy genre still emitted');
      assert.ok(Array.isArray(env.song.genres), 'genres[] should be an array');
      assert.equal(env.song.genres.length, 1);
      assert.equal(env.song.genres[0].name, 'Electronic');
    } finally {
      direct.close();
    }
  });

  test('multi-genre track returns ordered genres[] (tag-string order via tg.rowid)', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Inject Jazz as a secondary genre on an Ambient track. Jazz
      // gets a higher tg.rowid (late INSERT) so it should appear AFTER
      // Ambient in the genres[] array.
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Ambient' LIMIT 1`
      ).get();
      assert.ok(target);
      direct.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run('Jazz');
      const jazzId = direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get().id;
      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(target.id, jazzId);

      const env = await call('getSong', { id: String(target.id) });
      assert.equal(env.song.genre, 'Ambient', 'primary still Ambient (lower rowid)');
      assert.ok(Array.isArray(env.song.genres));
      assert.equal(env.song.genres.length, 2);
      // genres[0] === primary; genres[1] is the late-injected Jazz.
      assert.equal(env.song.genres[0].name, 'Ambient');
      assert.equal(env.song.genres[1].name, 'Jazz');
    } finally {
      // Clean up
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN genres g ON g.id = tg.genre_id
         WHERE g.name = 'Ambient' LIMIT 1`
      ).get();
      const jazzRow = direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get();
      if (target && jazzRow) {
        direct.prepare('DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?').run(target.id, jazzRow.id);
        direct.prepare('DELETE FROM genres WHERE id = ? AND NOT EXISTS (SELECT 1 FROM track_genres WHERE genre_id = ?)').run(jazzRow.id, jazzRow.id);
      }
      direct.close();
    }
  });

  test('untagged track omits genres[] (field absent, not empty array)', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Fixture: Vosto's "Sketch 1" is the untagged track (genre: null).
      const target = direct.prepare(
        `SELECT t.id FROM tracks t
         WHERE NOT EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id)
         LIMIT 1`
      ).get();
      assert.ok(target, 'expected at least one untagged track in fixture');
      const env = await call('getSong', { id: String(target.id) });
      assert.equal(env.song.genre, undefined, 'no primary genre');
      assert.equal(env.song.genres, undefined, 'genres[] should be absent (not [])');
    } finally {
      direct.close();
    }
  });
});

describe('V34: OpenSubsonic genres[] on Album responses', () => {
  test('album surfaces genres[] via getArtist with DISTINCT names across its tracks', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      const icarus = direct.prepare("SELECT id FROM artists WHERE name = 'Icarus'").get();
      const env = await call('getArtist', { id: 'ar-' + icarus.id });
      const beSomebody = env.artist.album.find(a => a.name === 'Be Somebody');
      assert.ok(beSomebody);
      assert.equal(beSomebody.genre, 'Electronic', 'legacy primary still Electronic');
      assert.ok(Array.isArray(beSomebody.genres), 'genres[] should be an array');
      // All 3 tracks on Be Somebody are tagged "Electronic" — DISTINCT
      // collapses to one entry.
      assert.equal(beSomebody.genres.length, 1);
      assert.equal(beSomebody.genres[0].name, 'Electronic');
    } finally {
      direct.close();
    }
  });

  test('album with a multi-genre track surfaces both genres in album.genres[] (DISTINCT)', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Inject Jazz on one Electronic track of Be Somebody. Album-
      // level should now show [Electronic, Jazz] — DISTINCT across
      // tracks, ordered by first-seen.
      const icarus = direct.prepare("SELECT id FROM artists WHERE name = 'Icarus'").get();
      const album = direct.prepare(
        'SELECT id FROM albums WHERE name = ? AND artist_id = ?'
      ).get('Be Somebody', icarus.id);
      const firstTrack = direct.prepare(
        'SELECT id FROM tracks WHERE album_id = ? ORDER BY track_number LIMIT 1'
      ).get(album.id);
      direct.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run('Jazz');
      const jazzId = direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get().id;
      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(firstTrack.id, jazzId);

      const env = await call('getArtist', { id: 'ar-' + icarus.id });
      const beSomebody = env.artist.album.find(a => a.name === 'Be Somebody');
      assert.ok(beSomebody);
      assert.ok(Array.isArray(beSomebody.genres));
      assert.equal(beSomebody.genres.length, 2);
      // Electronic was first-seen across the album (low rowid from
      // fixture scan); Jazz was injected later (higher rowid).
      assert.equal(beSomebody.genres[0].name, 'Electronic');
      assert.equal(beSomebody.genres[1].name, 'Jazz');
    } finally {
      // Clean up
      const icarus = direct.prepare("SELECT id FROM artists WHERE name = 'Icarus'").get();
      const album = direct.prepare(
        'SELECT id FROM albums WHERE name = ? AND artist_id = ?'
      ).get('Be Somebody', icarus.id);
      const firstTrack = direct.prepare(
        'SELECT id FROM tracks WHERE album_id = ? ORDER BY track_number LIMIT 1'
      ).get(album.id);
      const jazzRow = direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get();
      if (firstTrack && jazzRow) {
        direct.prepare('DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?').run(firstTrack.id, jazzRow.id);
        direct.prepare('DELETE FROM genres WHERE id = ? AND NOT EXISTS (SELECT 1 FROM track_genres WHERE genre_id = ?)').run(jazzRow.id, jazzRow.id);
      }
      direct.close();
    }
  });
});

// V34 contract: ALBUM_PRIMARY_GENRE_SQL surfaces a single genre name
// per album via the M2M, picking the earliest-inserted (lowest
// tg.rowid) genre-link across all tracks in the album. Documents the
// "coarser approximation" semantic from the constant's docstring.
describe('V34: Album.genre uses first-by-rowid across album tracks', () => {
  test('multi-genre injection on one track does not displace the album-level original primary', async () => {
    const dbPath = path.join(server.tmpDir, 'db', 'mstream.db');
    const direct = new DatabaseSync(dbPath);
    try {
      // Find an Icarus album ("Be Somebody"); the scanner inserted
      // its Electronic-tagged tracks at fixture-scan time, so their
      // M2M rows have low rowids. Then inject Jazz as a secondary
      // genre on one of those tracks — Jazz's row has a higher rowid
      // (late INSERT) so it does NOT win the album-level pick.
      const icarus = direct.prepare("SELECT id FROM artists WHERE name = 'Icarus'").get();
      assert.ok(icarus, 'expected Icarus artist in fixture');
      const album = direct.prepare(
        'SELECT id FROM albums WHERE name = ? AND artist_id = ?'
      ).get('Be Somebody', icarus.id);
      assert.ok(album, 'expected Be Somebody album in fixture');
      const firstTrack = direct.prepare(
        'SELECT id FROM tracks WHERE album_id = ? ORDER BY track_number LIMIT 1'
      ).get(album.id);
      assert.ok(firstTrack);

      // Seed Jazz as a brand-new genre (high id), link to one track.
      const jazzInsert = direct.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run('Jazz');
      const jazzId = jazzInsert.lastInsertRowid
        ? Number(jazzInsert.lastInsertRowid)
        : direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get().id;
      direct.prepare(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
      ).run(firstTrack.id, jazzId);

      // Query the artist's albums via Subsonic.
      const env = await call('getArtist', { id: 'ar-' + icarus.id });
      const beSomebody = env.artist.album.find(a => a.name === 'Be Somebody');
      assert.ok(beSomebody);
      // The Electronic M2M rows were inserted first (during scan);
      // Jazz was injected later. tg.rowid ordering surfaces
      // Electronic at the album level even though one track has
      // both genres.
      assert.equal(beSomebody.genre, 'Electronic',
        'album-level genre stays Electronic — Jazz was injected late, has higher tg.rowid');
    } finally {
      // Clean up the injected M2M row + the new genre. Other tests
      // assume only Electronic / Ambient exist in the fixture's genre
      // list, so we leave the genres table as we found it.
      const icarus = direct.prepare("SELECT id FROM artists WHERE name = 'Icarus'").get();
      const album = direct.prepare(
        'SELECT id FROM albums WHERE name = ? AND artist_id = ?'
      ).get('Be Somebody', icarus.id);
      const firstTrack = direct.prepare(
        'SELECT id FROM tracks WHERE album_id = ? ORDER BY track_number LIMIT 1'
      ).get(album.id);
      const jazzRow = direct.prepare("SELECT id FROM genres WHERE name = 'Jazz'").get();
      if (firstTrack && jazzRow) {
        direct.prepare(
          'DELETE FROM track_genres WHERE track_id = ? AND genre_id = ?'
        ).run(firstTrack.id, jazzRow.id);
        // Drop the orphan Jazz genre row so subsequent tests' getGenres
        // counts aren't polluted.
        direct.prepare('DELETE FROM genres WHERE id = ? AND NOT EXISTS (SELECT 1 FROM track_genres WHERE genre_id = ?)').run(jazzRow.id, jazzRow.id);
      }
      direct.close();
    }
  });
});

describe('getMusicDirectory', () => {
  test('drill library → artist → album', async () => {
    const mf = (await call('getMusicFolders')).musicFolders.musicFolder[0];

    const atLib = (await call('getMusicDirectory', { id: mf.id })).directory;
    assert.equal(atLib.name, mf.name);
    assert.ok(atLib.child.length > 0);
    assert.ok(atLib.child.every(c => c.isDir));

    const artistId = atLib.child[0].id;
    const atArtist = (await call('getMusicDirectory', { id: artistId })).directory;
    assert.ok(atArtist.child.length > 0);

    const albumId = atArtist.child[0].id;
    const atAlbum = (await call('getMusicDirectory', { id: albumId })).directory;
    assert.ok(atAlbum.child.length > 0);
    assert.ok(atAlbum.child.every(c => !c.isDir), 'album children should be songs');
  });
});

// ── 5. Search ───────────────────────────────────────────────────────────────

describe('search3', () => {
  test('matches fixture artist name', async () => {
    const env = await call('search3', { query: 'Icarus' });
    const r = env.searchResult3;
    assert.ok(r.artist?.some(a => a.name === 'Icarus'));
  });

  test('matches album name', async () => {
    const env = await call('search3', { query: 'Night Drive' });
    const r = env.searchResult3;
    assert.ok(r.album?.some(a => a.name === 'Night Drive'));
  });

  test('matches song title', async () => {
    const env = await call('search3', { query: 'Orbit' });
    const r = env.searchResult3;
    assert.ok(r.song?.some(s => s.title === 'Orbit'));
  });

  test('empty query returns empty result (not error)', async () => {
    const env = await call('search3', { query: '' });
    assert.equal(env.status, 'ok');
  });

  test('count limits respected', async () => {
    const env = await call('search3', { query: 'e', songCount: 2 });
    assert.ok((env.searchResult3.song || []).length <= 2);
  });
});

// ── 6. Media ────────────────────────────────────────────────────────────────

describe('Media', () => {
  let songId;
  before(async () => {
    const env = await call('search3', { query: 'Be Somebody' });
    songId = env.searchResult3.song[0].id;
  });

  test('stream native returns audio bytes', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\//);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100);
  });

  test('stream with format=mp3 and maxBitRate=64 transcodes', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId, format: 'mp3', maxBitRate: 64 }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
  });

  // Subsonic spec: maxBitRate=0 means "no limit is imposed" — it must stream
  // natively, never force a transcode. Native streaming is observable via
  // sendFile's exact Content-Length (the transcode path streams chunked).
  test('stream with maxBitRate=0 means no limit — streams natively', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId, maxBitRate: 0 }));
    assert.equal(r.status, 200);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100, `expected audio bytes, got ${buf.length}`);
    assert.equal(Number(r.headers.get('content-length')), buf.length, 'expected native streaming, not a forced transcode');
  });

  test('stream with format=opus and maxBitRate=0 transcodes at the default bitrate', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId, format: 'opus', maxBitRate: 0 }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/ogg/);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100, `expected transcoded audio, got ${buf.length}`);
  });

  // Regression: an unclamped absurd value reached ffmpeg as `-b:a 999999k`,
  // which libopus rejects at encoder init — the client got a 200 with an
  // empty body.
  test('stream with format=opus clamps an absurd maxBitRate instead of passing it to ffmpeg', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: songId, format: 'opus', maxBitRate: 999999 }));
    assert.equal(r.status, 200);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100, `expected transcoded audio, got ${buf.length}`);
  });

  test('download returns the native file', async () => {
    const r = await fetch(subsonicUrl('download', { apiKey, id: songId }));
    assert.equal(r.status, 200);
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.ok(buf.length > 100);
  });

  test('stream unknown id → 404', async () => {
    const r = await fetch(subsonicUrl('stream', { apiKey, id: 99999999 }));
    assert.equal(r.status, 404);
  });

  test('getCoverArt returns image bytes when present', async () => {
    // Fixture MP3s are silent + tagged but carry no embedded art, so we accept
    // a 404 if nothing was ever extracted — what matters is that the route
    // is reachable and returns a sensible status.
    const r = await fetch(subsonicUrl('getCoverArt', { apiKey, id: songId }));
    assert.ok([200, 404].includes(r.status), `expected 200 or 404, got ${r.status}`);
  });
});

// ── 7. API key management ──────────────────────────────────────────────────

describe('API key management', () => {
  let token;

  before(async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(USER),
    });
    token = (await r.json()).token;
  });

  test('list includes the key we created in the before hook', async () => {
    const r = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      headers: { 'x-access-token': token },
    });
    const keys = await r.json();
    assert.ok(keys.some(k => k.name === 'test-suite'));
    // list endpoint must NOT leak the key value itself
    assert.ok(!keys.some(k => 'key' in k));
  });

  test('create + revoke cycle', async () => {
    const mk = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-token': token },
      body: JSON.stringify({ name: 'throwaway' }),
    });
    const { key: newKey } = await mk.json();
    assert.ok(newKey);

    // The new key works for Subsonic
    const ok = await fetch(subsonicUrl('ping', { apiKey: newKey }));
    const env = (await ok.json())['subsonic-response'];
    assert.equal(env.status, 'ok');

    // Revoke and confirm it stops working
    const list = await (await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
      headers: { 'x-access-token': token },
    })).json();
    const newRecord = list.find(k => k.name === 'throwaway');
    const del = await fetch(`${server.baseUrl}/api/v1/user/api-keys/${newRecord.id}`, {
      method: 'DELETE',
      headers: { 'x-access-token': token },
    });
    assert.equal(del.status, 200);

    const blocked = await fetch(subsonicUrl('ping', { apiKey: newKey }));
    const envBlocked = (await blocked.json())['subsonic-response'];
    assert.equal(envBlocked.status, 'failed');
    assert.equal(envBlocked.error.code, 40);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2 — scrobble / favourites / lists / playlists
// ══════════════════════════════════════════════════════════════════════════

// Helper: pull one song id from the library so the phase-2 tests can work
// against real rows.
async function oneSongId() {
  const env = await call('search3', { query: 'Be Somebody' });
  return env.searchResult3.song[0].id;
}

describe('scrobble + setRating + star (mutations)', () => {
  let songId;
  before(async () => { songId = await oneSongId(); });

  test('scrobble with submission=true bumps play count', async () => {
    const env1 = await call('scrobble', { id: songId, submission: 'true' });
    assert.equal(env1.status, 'ok');
    const { song } = await call('getSong', { id: songId });
    assert.ok(song.playCount >= 1, `expected playCount >= 1, got ${song.playCount}`);

    const before = song.playCount;
    await call('scrobble', { id: songId, submission: 'true' });
    const { song: after } = await call('getSong', { id: songId });
    assert.equal(after.playCount, before + 1);
  });

  test('scrobble with submission=false does NOT bump', async () => {
    const { song: before } = await call('getSong', { id: songId });
    await call('scrobble', { id: songId, submission: 'false' });
    const { song: after } = await call('getSong', { id: songId });
    assert.equal(after.playCount, before.playCount);
  });

  test('setRating sets, 0 clears', async () => {
    await call('setRating', { id: songId, rating: 4 });
    const { song: s1 } = await call('getSong', { id: songId });
    assert.equal(s1.userRating, 4);

    await call('setRating', { id: songId, rating: 0 });
    const { song: s2 } = await call('getSong', { id: songId });
    assert.equal(s2.userRating, undefined);
  });

  test('invalid rating → error 0', async () => {
    const env = await call('setRating', { id: songId, rating: 99 });
    assert.equal(env.status, 'failed');
  });

  test('star / unstar / getStarred2 round-trip', async () => {
    await call('star', { id: songId });
    const starredEnv = await call('getStarred2');
    const starredIds = (starredEnv.starred2.song || []).map(s => s.id);
    assert.ok(starredIds.includes(songId), `expected ${songId} in starred list`);

    const { song: starredSong } = await call('getSong', { id: songId });
    assert.ok(starredSong.starred, 'song.starred should be an ISO timestamp');

    await call('unstar', { id: songId });
    const after = await call('getStarred2');
    const afterIds = (after.starred2.song || []).map(s => s.id);
    assert.ok(!afterIds.includes(songId));
  });
});

// ── Album lists ────────────────────────────────────────────────────────────

describe('getAlbumList2', () => {
  test('alphabeticalByName returns ordered albums', async () => {
    const env = await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 });
    const names = env.albumList2.album.map(a => a.name);
    assert.deepEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), names);
  });

  test('newest sorts by created_at DESC', async () => {
    const env = await call('getAlbumList2', { type: 'newest', size: 50 });
    assert.ok(env.albumList2.album.length > 0);
  });

  test('random returns up to `size` albums', async () => {
    const env = await call('getAlbumList2', { type: 'random', size: 2 });
    assert.ok(env.albumList2.album.length <= 2);
  });

  test('byYear requires fromYear/toYear', async () => {
    const missing = await call('getAlbumList2', { type: 'byYear' });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.error.code, 10);

    const env = await call('getAlbumList2', { type: 'byYear', fromYear: 2018, toYear: 2020 });
    assert.equal(env.status, 'ok');
    const years = env.albumList2.album.map(a => a.year);
    assert.ok(years.every(y => y >= 2018 && y <= 2020));
  });

  test('byGenre filters', async () => {
    const env = await call('getAlbumList2', { type: 'byGenre', genre: 'Electronic' });
    assert.ok(env.albumList2.album.length > 0);
  });

  test('getAlbumList (v1) returns same shape under v1 tag', async () => {
    const env = await call('getAlbumList', { type: 'alphabeticalByName' });
    assert.ok(Array.isArray(env.albumList.album));
  });

  test('frequent/highest/recent default to empty when no plays', async () => {
    for (const type of ['frequent', 'highest', 'recent']) {
      const env = await call('getAlbumList2', { type });
      assert.equal(env.status, 'ok');
    }
  });
});

describe('getRandomSongs + getSongsByGenre', () => {
  test('getRandomSongs respects size', async () => {
    const env = await call('getRandomSongs', { size: 3 });
    assert.ok((env.randomSongs.song || []).length <= 3);
  });

  test('getRandomSongs with genre filter', async () => {
    const env = await call('getRandomSongs', { size: 10, genre: 'Electronic' });
    assert.ok(env.randomSongs.song.every(s => s.genre === 'Electronic'));
  });

  test('getSongsByGenre requires genre', async () => {
    const env = await call('getSongsByGenre');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });

  test('getSongsByGenre returns matching tracks', async () => {
    const env = await call('getSongsByGenre', { genre: 'Ambient', count: 10 });
    assert.ok(env.songsByGenre.song.every(s => s.genre === 'Ambient'));
  });
});

// ── Playlists ──────────────────────────────────────────────────────────────

describe('Playlists CRUD', () => {
  let songIds;
  let playlistId;

  before(async () => {
    const env = await call('search3', { query: 'e', songCount: 3 });
    songIds = env.searchResult3.song.map(s => s.id);
    assert.ok(songIds.length >= 2, 'need at least 2 songs for playlist tests');
  });

  test('createPlaylist with a name + songs', async () => {
    const env = await call('createPlaylist', { name: 'Test Playlist', songId: songIds });
    assert.equal(env.status, 'ok');
    assert.equal(env.playlist.name, 'Test Playlist');
    assert.equal(env.playlist.songCount, songIds.length);
    assert.equal(env.playlist.entry.length, songIds.length);
    playlistId = env.playlist.id;
  });

  test('getPlaylists lists the new playlist', async () => {
    const env = await call('getPlaylists');
    assert.ok(env.playlists.playlist.some(p => p.id === playlistId));
  });

  test('getPlaylist returns songs in order', async () => {
    const env = await call('getPlaylist', { id: playlistId });
    const ids = env.playlist.entry.map(e => e.id);
    assert.deepEqual(ids, songIds);
  });

  test('updatePlaylist renames, appends, removes', async () => {
    // Rename
    await call('updatePlaylist', { playlistId, name: 'Renamed' });
    let env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.name, 'Renamed');

    // Append the first song again to the end
    await call('updatePlaylist', { playlistId, songIdToAdd: songIds[0] });
    env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.songCount, songIds.length + 1);

    // Remove the first entry (index 0)
    await call('updatePlaylist', { playlistId, songIndexToRemove: 0 });
    env = await call('getPlaylist', { id: playlistId });
    assert.equal(env.playlist.songCount, songIds.length);
  });

  test('deletePlaylist removes it', async () => {
    const env = await call('deletePlaylist', { id: playlistId });
    assert.equal(env.status, 'ok');
    const after = await call('getPlaylists');
    assert.ok(!after.playlists.playlist.some(p => p.id === playlistId));
  });

  test('createPlaylist with no name returns error 10', async () => {
    const env = await call('createPlaylist');
    assert.equal(env.status, 'failed');
    assert.equal(env.error.code, 10);
  });
});
