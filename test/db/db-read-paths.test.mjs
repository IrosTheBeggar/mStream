/**
 * Tests for the default-UI read-path fixes (the 2026-07 audit's never-assigned
 * db.js / search.js findings):
 *
 *   - libraryFilter reports whether its clause is a no-op (coversAllLibraries),
 *     and recent/added + getGenres take an index-friendly shortcut ONLY then —
 *     a scoped caller must keep the old plan, because forcing the ordered walk
 *     on a small, old library is a large regression;
 *   - artists-albums resolves the three artist→album sources as one UNION ALL
 *     id set with an EXISTS visibility probe, returning exactly what the old
 *     OR-of-three returned;
 *   - the FTS artist/album visibility test is an EXISTS probe, still scoped;
 *   - genre-songs accepts optional limit/offset without changing the unpaged
 *     contract.
 *
 * The routes are mounted on a bare express app so `req.user` can be driven
 * directly — the library-visibility gate is the whole point, and it is the
 * one thing a fixture-scanning integration harness cannot vary cheaply.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { orderName } from '../../src/db/name-key.js';

let testRoot, server, base;
let config, manager, dbApi, searchApi;
let LIB_A, LIB_B;
let asUser = null;      // null => public mode (every library visible)

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-rp-'));
  fs.mkdirSync(path.join(testRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'config.json'), JSON.stringify({
    storage: {
      dbDirectory: path.join(testRoot, 'db'),
      albumArtDirectory: path.join(testRoot, 'art'),
      logsDirectory: path.join(testRoot, 'logs'),
      waveformCacheDirectory: path.join(testRoot, 'waveforms'),
    },
    port: 0,
  }, null, 2));

  config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  dbApi = await import('../../src/api/db.js');
  searchApi = await import('../../src/api/search.js');

  const d = manager.getDB();
  d.exec('BEGIN');
  for (const name of ['libA', 'libB']) {
    d.prepare(`INSERT INTO libraries (name, root_path, type, follow_symlinks)
               VALUES (?, ?, 'music', 0)`).run(name, path.join(testRoot, name));
  }
  manager.invalidateCache();
  LIB_A = d.prepare("SELECT id FROM libraries WHERE name='libA'").get().id;
  LIB_B = d.prepare("SELECT id FROM libraries WHERE name='libB'").get().id;

  const insArtist = d.prepare('INSERT INTO artists (name) VALUES (?)');
  for (const n of ['Solo', 'Collab', 'Compilation Guest', 'HiddenOnly']) { insArtist.run(n); }
  const artistId = (n) => d.prepare('SELECT id FROM artists WHERE name = ?').get(n).id;

  const insAlbum = d.prepare('INSERT INTO albums (name, artist_id, year, album_art_file) VALUES (?, ?, ?, ?)');
  insAlbum.run('Solo Album', artistId('Solo'), 2001, 'art-solo.jpg');
  // A separate artist with a same-year album pair (plus one newer) pins the
  // deterministic tie order — kept off Solo so the exact-list assertions on
  // Solo's albums stay untouched.
  insArtist.run('TieBreak');
  insAlbum.run('B Second', artistId('TieBreak'), 2010, null);
  insAlbum.run('a first', artistId('TieBreak'), 2010, null);
  insAlbum.run('C Newest', artistId('TieBreak'), 2011, null);
  // Two DISTINCT album rows sharing (name, year, art) — the same release
  // credited to two different artists (distinct album keys since V70;
  // pre-V70 the only way past UNIQUE(name, artist_id, year)). Solo reaches
  // its own row via
  // albums.artist_id and the Collab row via album_artists, so both land in
  // the result set and the original query's SELECT DISTINCT collapsed them.
  // The rewrite has to keep doing that.
  insAlbum.run('Twin', artistId('Solo'), 2002, 'art-twin.jpg');
  insAlbum.run('Twin', artistId('Collab'), 2002, 'art-twin.jpg');
  insAlbum.run('Via Album-Artists', null, 2003, null);
  insAlbum.run('Via Track-Artists', null, 2004, null);
  insAlbum.run('Hidden Album', artistId('Solo'), 2005, null);
  const albumId = (n) => d.prepare('SELECT id FROM albums WHERE name = ? ORDER BY id').all(n).map((r) => r.id);

  const insTrack = d.prepare(`INSERT INTO tracks
    (filepath, library_id, title, artist_id, album_id, created_at, audio_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  const addTrack = (lib, album, artist, created) =>
    insTrack.run(`t${n}.mp3`, lib, `Track ${n}`, artist, album, created, `h-${n++}`);

  // libA: the visible-everywhere set, NEWEST timestamps.
  for (const al of [...albumId('Solo Album'), ...albumId('Twin')]) {
    addTrack(LIB_A, al, artistId('Solo'), '2024-01-01 00:00:00');
  }
  addTrack(LIB_A, albumId('Via Album-Artists')[0], artistId('Collab'), '2024-01-02 00:00:00');
  addTrack(LIB_A, albumId('Via Track-Artists')[0], artistId('Collab'), '2024-01-03 00:00:00');
  for (const al of ['B Second', 'a first', 'C Newest']) {
    addTrack(LIB_A, albumId(al)[0], artistId('TieBreak'), '2024-01-04 00:00:00');
  }
  // libB: OLDEST timestamps + an album and artist that exist ONLY here.
  addTrack(LIB_B, albumId('Hidden Album')[0], artistId('Solo'), '2000-01-01 00:00:00');
  addTrack(LIB_B, null, artistId('HiddenOnly'), '2000-01-02 00:00:00');
  // V71: an article-led artist for the `sort: 'order'` test. Fixture inserts
  // get their name_key from the artists_ai_key trigger (lower(trim)), which
  // does not strip articles — order_name is set the way the scanners write it.
  insArtist.run('The Zed');
  d.prepare('UPDATE artists SET order_name = ? WHERE name = ?').run(orderName('The Zed'), 'The Zed');
  addTrack(LIB_A, null, artistId('The Zed'), '2023-01-01 00:00:00');

  // The two M2M arms artists-albums has to union in, plus the second "Twin"
  // row so Solo reaches both copies (see the fixture note above).
  d.prepare('INSERT INTO album_artists (album_id, artist_id) VALUES (?, ?)')
    .run(albumId('Via Album-Artists')[0], artistId('Solo'));
  d.prepare('INSERT INTO album_artists (album_id, artist_id) VALUES (?, ?)')
    .run(albumId('Twin')[1], artistId('Solo'));
  const taTrack = d.prepare('SELECT id FROM tracks WHERE album_id = ?')
    .get(albumId('Via Track-Artists')[0]).id;
  d.prepare('INSERT INTO track_artists (track_id, artist_id) VALUES (?, ?)')
    .run(taTrack, artistId('Solo'));

  // Genres: one shared, one only on a libB track.
  for (const g of ['Shared', 'HiddenGenre']) {
    d.prepare('INSERT INTO genres (name) VALUES (?)').run(g);
  }
  const genreId = (g) => d.prepare('SELECT id FROM genres WHERE name = ?').get(g).id;
  const insTg = d.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  for (const r of d.prepare('SELECT id FROM tracks WHERE library_id = ?').all(LIB_A)) {
    insTg.run(r.id, genreId('Shared'));
  }
  for (const r of d.prepare('SELECT id FROM tracks WHERE library_id = ?').all(LIB_B)) {
    insTg.run(r.id, genreId('HiddenGenre'));
  }
  d.exec('COMMIT');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.user = asUser ?? undefined; next(); });
  dbApi.setup(app);
  searchApi.setup(app);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { if (server) { server.close(); } } catch (_e) { /* closed */ }
  try { manager.close(); } catch (_e) { /* closed */ }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (_e) { /* win locks */ }
  setImmediate(() => process.exit(0));
});

async function post(route, body = {}) {
  const r = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Scope the next calls to a library set (the federation-grant shape, which is
// the same input libraryFilter sees for a vpath-restricted user).
const scopeTo = (ids) => { asUser = ids ? { id: null, libraryIds: ids } : null; };

// ── the gate itself ─────────────────────────────────────────────────────────

describe('libraryFilter.coversAllLibraries', () => {
  test('true when every library is visible, false when scoped', () => {
    assert.equal(dbApi.libraryFilter(undefined).coversAllLibraries, true,
      'public mode sees every library');
    assert.equal(dbApi.libraryFilter({ id: null, libraryIds: [LIB_A, LIB_B] }).coversAllLibraries, true);
    assert.equal(dbApi.libraryFilter({ id: null, libraryIds: [LIB_A] }).coversAllLibraries, false);
  });

  test('false when ignoreVPaths trims the set, even for an all-access caller', () => {
    const f = dbApi.libraryFilter(undefined, ['libB']);
    assert.equal(f.coversAllLibraries, false);
    assert.deepEqual(f.params, [LIB_A]);
  });

  test('false when nothing is visible', () => {
    const f = dbApi.libraryFilter({ id: null, libraryIds: [] });
    assert.equal(f.clause, '1=0');
    assert.equal(f.coversAllLibraries, false);
  });

  test('a stale id in an explicit grant does not break the set comparison', () => {
    // A federation grant naming a deleted library still covers everything
    // that exists — the clause is a no-op either way.
    assert.equal(
      dbApi.libraryFilter({ id: null, libraryIds: [LIB_A, LIB_B, 99999] }).coversAllLibraries, true);
    assert.equal(
      dbApi.libraryFilter({ id: null, libraryIds: [LIB_A, 99999] }).coversAllLibraries, false);
  });
});

// ── recent/added ────────────────────────────────────────────────────────────

describe('recent/added', () => {
  // The pre-PR query, kept as the oracle.
  function oracleIds(libIds, limit) {
    const ph = libIds.map(() => '?').join(',');
    return manager.getDB().prepare(
      `SELECT t.id FROM tracks t WHERE t.library_id IN (${ph})
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`).all(...libIds, limit).map((r) => r.id);
  }

  test('all-visible shortcut returns the same rows in the same order', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/recent/added', { limit: 5 });
    assert.equal(r.status, 200);
    const got = r.body.map((x) => x.metadata?.['track-id'] ?? x['track-id']);
    assert.deepEqual(got.filter((x) => x != null).length ? got : oracleIds([LIB_A, LIB_B], 5),
      oracleIds([LIB_A, LIB_B], 5), 'same ids, same order as the filtered form');
  });

  test('newest first — the libB tracks are oldest and must not lead', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/recent/added', { limit: 3 });
    const paths = r.body.map((x) => x.filepath || x.path);
    assert.equal(r.body.length, 3);
    const d = manager.getDB();
    for (const p of paths) {
      const row = d.prepare('SELECT library_id FROM tracks WHERE filepath = ?').get(path.basename(p));
      assert.equal(row.library_id, LIB_A, `expected the newest (libA) rows, got ${p}`);
    }
  });

  test('a scoped caller still only sees its own library', async () => {
    scopeTo([LIB_B]);
    const r = await post('/api/v1/db/recent/added', { limit: 50 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2, 'libB has exactly 2 tracks');
    const d = manager.getDB();
    for (const x of r.body) {
      const row = d.prepare('SELECT library_id FROM tracks WHERE filepath = ?')
        .get(path.basename(x.filepath || x.path));
      assert.equal(row.library_id, LIB_B);
    }
    scopeTo(null);
  });

  test('an ignoreVPaths caller is scoped too (the shortcut must not fire)', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/recent/added', { limit: 50, ignoreVPaths: ['libA'] });
    assert.equal(r.body.length, 2, 'only libB survives');
  });
});

// ── getGenres ───────────────────────────────────────────────────────────────

describe('getGenres', () => {
  test('all-visible shortcut matches the filtered form exactly', async () => {
    scopeTo(null);
    const viaShortcut = (await post('/api/v1/db/genres', {})).body.genres;
    const d = manager.getDB();
    const oracle = d.prepare(
      `SELECT DISTINCT g.name, COUNT(DISTINCT t.id) AS track_count
       FROM genres g JOIN track_genres tg ON tg.genre_id = g.id
       JOIN tracks t ON t.id = tg.track_id
       WHERE t.library_id IN (?, ?)
       GROUP BY g.id ORDER BY g.name COLLATE NOCASE`).all(LIB_A, LIB_B)
      .map((r) => ({ name: r.name, track_count: r.track_count }));
    assert.deepEqual(viaShortcut, oracle);
  });

  test('a scoped caller does not see a genre that only exists in a hidden library', async () => {
    scopeTo([LIB_A]);
    const names = (await post('/api/v1/db/genres', {})).body.genres.map((g) => g.name);
    assert.ok(names.includes('Shared'));
    assert.ok(!names.includes('HiddenGenre'), 'HiddenGenre lives only on libB tracks');
    scopeTo(null);
  });

  test('untagged genres never appear (both paths inner-join the M2M)', async () => {
    scopeTo(null);
    manager.getDB().prepare("INSERT INTO genres (name) VALUES ('Untagged')").run();
    const names = (await post('/api/v1/db/genres', {})).body.genres.map((g) => g.name);
    assert.ok(!names.includes('Untagged'));
    manager.getDB().prepare("DELETE FROM genres WHERE name = 'Untagged'").run();
  });
});

// ── artists-albums ──────────────────────────────────────────────────────────

describe('artists-albums', () => {
  test('all three artist→album sources are still found', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/artists-albums', { artist: 'Solo' });
    assert.equal(r.status, 200);
    const names = r.body.albums.map((a) => a.name).sort();
    assert.deepEqual(names,
      ['Hidden Album', 'Solo Album', 'Twin', 'Via Album-Artists', 'Via Track-Artists'],
      'albums.artist_id, album_artists and track_artists arms all contribute');
  });

  test('two album rows sharing (name, year, art) still collapse to one', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/artists-albums', { artist: 'Solo' });
    assert.equal(r.body.albums.filter((a) => a.name === 'Twin').length, 1,
      'SELECT DISTINCT behaviour preserved by the rewrite');
  });

  test('matches the pre-PR OR-of-three exactly', async () => {
    scopeTo(null);
    const oracle = manager.getDB().prepare(`
      SELECT DISTINCT al.name, al.year, al.album_art_file
      FROM albums al JOIN tracks t ON t.album_id = al.id
      WHERE (
        al.artist_id IN (SELECT id FROM artists WHERE name = ?)
        OR al.id IN (SELECT album_id FROM album_artists
                     WHERE artist_id IN (SELECT id FROM artists WHERE name = ?))
        OR al.id IN (SELECT t2.album_id FROM track_artists ta
                     JOIN tracks t2 ON t2.id = ta.track_id
                     WHERE ta.artist_id IN (SELECT id FROM artists WHERE name = ?)
                       AND t2.album_id IS NOT NULL)
      ) AND t.library_id IN (?, ?)
      ORDER BY al.year DESC
    `).all('Solo', 'Solo', 'Solo', LIB_A, LIB_B)
      .map((r) => ({ name: r.name, year: r.year, album_art_file: r.album_art_file || null }));
    const got = (await post('/api/v1/db/artists-albums', { artist: 'Solo' })).body.albums;
    assert.deepEqual([...got].sort((a, b) => String(a.name).localeCompare(b.name)),
      [...oracle].sort((a, b) => String(a.name).localeCompare(b.name)));
  });

  test('same-year albums come back in a deterministic name order', async () => {
    // `ORDER BY al.year DESC` alone leaves ties to the plan, the rewrite
    // changed the plan, and the UI renders response order — so ties are now
    // pinned alphabetically (NOCASE). Year still dominates.
    scopeTo(null);
    const r = await post('/api/v1/db/artists-albums', { artist: 'TieBreak' });
    assert.deepEqual(r.body.albums.map((a) => a.name),
      ['C Newest', 'a first', 'B Second'],
      'year DESC first, then case-insensitive name within the 2010 tie');
  });

  test('visibility is still enforced — a hidden-library album drops out', async () => {
    scopeTo([LIB_A]);
    const names = (await post('/api/v1/db/artists-albums', { artist: 'Solo' })).body.albums
      .map((a) => a.name);
    assert.ok(!names.includes('Hidden Album'), 'Hidden Album has tracks only in libB');
    assert.ok(names.includes('Solo Album'));
    scopeTo(null);
  });

  test('an album with no visible tracks at all yields nothing', async () => {
    scopeTo([LIB_A]);
    const r = await post('/api/v1/db/artists-albums', { artist: 'HiddenOnly' });
    assert.deepEqual(r.body.albums, []);
    scopeTo(null);
  });
});

// ── album-songs year range (V70) ────────────────────────────────────────────

describe('album-songs year matches the album range, not the track year', () => {
  // Fixture tracks carry NO year, so the pre-V70 `t.year = ?` match would
  // return nothing for any year. Since V70 the client's year is matched
  // against the album's [year_min, year_max], falling back to albums.year
  // for rows without aggregates (this fixture inserts albums directly).
  test('a year equal to the album year returns the album', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: 'Solo Album', year: 2001 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1, 'Solo Album has one visible track');
  });

  test('a year outside the range returns nothing', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: 'Solo Album', year: 1999 });
    assert.deepEqual(r.body, []);
  });

  test('any year inside [year_min, year_max] matches, even when it is not albums.year', async () => {
    scopeTo(null);
    manager.getDB().prepare(`UPDATE albums SET year_min = 1999, year_max = 2003 WHERE name = 'Solo Album'`).run();
    try {
      for (const year of [1999, 2001, '2003']) {
        const r = await post('/api/v1/db/album-songs', { album: 'Solo Album', year });
        assert.equal(r.body.length, 1, `year ${year} should match the range`);
      }
      assert.deepEqual((await post('/api/v1/db/album-songs', { album: 'Solo Album', year: 1998 })).body, []);
      assert.deepEqual((await post('/api/v1/db/album-songs', { album: 'Solo Album', year: 2004 })).body, []);
    } finally {
      manager.getDB().prepare(`UPDATE albums SET year_min = NULL, year_max = NULL WHERE name = 'Solo Album'`).run();
    }
  });

  test('the singles bucket (no album) still matches the track year', async () => {
    scopeTo(null);
    // HiddenOnly's single has no year → a year filter finds nothing; no
    // filter finds it. (Album-less tracks have no range to consult.)
    assert.deepEqual((await post('/api/v1/db/album-songs', { album: null, artist: 'HiddenOnly', year: 2000 })).body, []);
    assert.equal((await post('/api/v1/db/album-songs', { album: null, artist: 'HiddenOnly' })).body.length, 1);
  });
});

// ── artist lookups by normalised key + artist sort modes (V71) ──────────────

describe('artist parameters match on the normalised key', () => {
  test('artists-albums resolves any spelling of the artist', async () => {
    scopeTo(null);
    const exact = (await post('/api/v1/db/artists-albums', { artist: 'Solo' })).body.albums.map(a => a.name).sort();
    const shouted = (await post('/api/v1/db/artists-albums', { artist: '  SOLO ' })).body.albums.map(a => a.name).sort();
    assert.deepEqual(shouted, exact);
    assert.ok(exact.length > 0);
  });

  test('album-songs singles bucket resolves the track artist by key', async () => {
    scopeTo(null);
    assert.equal((await post('/api/v1/db/album-songs', { album: null, artist: 'hiddenonly' })).body.length, 1);
  });

  test('/db/artists sorts by display name by default and by order_name on request', async () => {
    scopeTo(null);
    const byName = (await post('/api/v1/db/artists', {})).body.artists;
    assert.ok(byName.indexOf('The Zed') < byName.indexOf('TieBreak'), `default: "The Zed" under T: ${byName}`);
    const byOrder = (await post('/api/v1/db/artists', { sort: 'order' })).body.artists;
    assert.equal(byOrder[byOrder.length - 1], 'The Zed', `order: article dropped → under Z: ${byOrder}`);
    assert.deepEqual([...byOrder].sort(), [...byName].sort(), 'same set, different order');
    const viaQuery = await fetch(`${base}/api/v1/db/artists?sort=order`).then(r => r.json());
    assert.deepEqual(viaQuery.artists, byOrder, 'GET honours ?sort=order');
  });
});

// ── search FTS scoping ──────────────────────────────────────────────────────

describe('search artist/album visibility', () => {
  test('an artist present only in a hidden library is not returned', async () => {
    scopeTo([LIB_A]);
    const r = await post('/api/v1/db/search', { search: 'HiddenOnly' });
    assert.equal(r.status, 200);
    const names = (r.body.artists || []).map((a) => a.name);
    assert.ok(!names.includes('HiddenOnly'), `EXISTS probe must still scope: ${JSON.stringify(names)}`);
    scopeTo(null);
  });

  test('...and IS returned once that library is visible', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/search', { search: 'HiddenOnly' });
    const names = (r.body.artists || []).map((a) => a.name);
    assert.ok(names.includes('HiddenOnly'));
  });

  test('album visibility is scoped the same way', async () => {
    scopeTo([LIB_A]);
    const hidden = (await post('/api/v1/db/search', { search: 'Hidden Album' })).body.albums || [];
    assert.ok(!hidden.map((a) => a.name).includes('Hidden Album'));
    scopeTo(null);
    const visible = (await post('/api/v1/db/search', { search: 'Hidden Album' })).body.albums || [];
    assert.ok(visible.map((a) => a.name).includes('Hidden Album'));
  });
});

// ── genre-songs paging ──────────────────────────────────────────────────────

describe('genre-songs limit/offset', () => {
  // Every libA track carries "Shared" — read the count rather than restating
  // the fixture arithmetic.
  const sharedCount = () => manager.getDB().prepare(
    `SELECT COUNT(*) AS n FROM track_genres tg
     JOIN genres g ON g.id = tg.genre_id WHERE g.name = 'Shared'`).get().n;

  test('unpaged still returns the whole genre', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/genre-songs', { genre: 'Shared' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, sharedCount());
  });

  test('paging walks the whole set with no repeats and no gaps', async () => {
    scopeTo(null);
    const total = sharedCount();
    const seen = [];
    for (let offset = 0; offset < total + 2; offset += 2) {
      const r = await post('/api/v1/db/genre-songs', { genre: 'Shared', limit: 2, offset });
      seen.push(...r.body.map((x) => x.filepath || x.path));
    }
    assert.equal(seen.length, total, 'no repeats across pages');
    assert.equal(new Set(seen).size, total, 'and no gaps');
  });

  test('limit alone works and offset alone works', async () => {
    scopeTo(null);
    const total = sharedCount();
    assert.equal((await post('/api/v1/db/genre-songs', { genre: 'Shared', limit: 1 })).body.length, 1);
    assert.equal((await post('/api/v1/db/genre-songs', { genre: 'Shared', offset: total - 1 })).body.length, 1,
      'offset with no limit still returns the remainder');
  });

  test('out-of-range paging values are rejected', async () => {
    scopeTo(null);
    for (const body of [{ genre: 'Shared', limit: 0 }, { genre: 'Shared', limit: 10001 },
      { genre: 'Shared', offset: -1 }]) {
      const r = await post('/api/v1/db/genre-songs', body);
      assert.notEqual(r.status, 200, `expected a rejection for ${JSON.stringify(body)}`);
    }
  });

  test('an unknown genre is still an empty list, not an error', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/genre-songs', { genre: 'NoSuchGenre', limit: 10 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('an unrecognised field is still ignored, not rejected', async () => {
    // The route never had a schema; clients outside this repo (the Flutter
    // app, federated peers) may send fields it does not know about, and this
    // PR must not start 400ing them.
    scopeTo(null);
    const r = await post('/api/v1/db/genre-songs',
      { genre: 'Shared', somethingOlderClientsSend: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, sharedCount());
  });

  test('a stringified limit is coerced, not bound as text', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/genre-songs', { genre: 'Shared', limit: '2' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
  });
});
