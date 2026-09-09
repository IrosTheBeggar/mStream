/**
 * The album-API fields (album-API series, PR 4): /db/albums and
 * /db/artists-albums items carry `album_artist`, `artists`, `compilation` and
 * the V70 aggregates (`year_min`, `year_max`, `track_count`, `duration`) next
 * to the legacy trio, and /db/album-songs takes an `album_artist` selector.
 *
 * What is pinned here:
 *   - the DISTINCT collapse over (name, year, album_art_file) survives, and the
 *     new fields describe the GROUP: one credit when the rows agree, null when
 *     they disagree, the union of the rows' main credits, MAX(compilation);
 *   - rows without album credits fall back to their primary artist;
 *   - the legacy keys keep their values and stay first in each item;
 *   - same-name albums come back newest first (the pinned tie order);
 *   - library visibility is still an EXISTS probe — a hidden-library album
 *     drops out, and the counts are the album rows' own aggregates;
 *   - the singles entry names the requested artist and nulls the aggregates;
 *   - album-songs `album_artist` narrows a namesake album by primary-artist
 *     key, by main credit, or by the verbatim display string; without `album`
 *     it matches the track artist; null bodies are still accepted.
 *
 * Same bare-express harness as db-read-paths: `req.user` is driven directly
 * so the library gate can be varied per call.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

let testRoot, server, base;
let config, manager, dbApi;
let LIB_A, LIB_B;
let asUser = null;

const LEGACY_KEYS = ['name', 'year', 'album_art_file'];
const NEW_KEYS = ['album_artist', 'artists', 'compilation', 'year_min', 'year_max', 'track_count', 'duration'];

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-af-'));
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
  for (const n of ['Ann', 'Bob', 'Cid', 'Solo Singer']) { insArtist.run(n); }
  const artistId = (n) => d.prepare('SELECT id FROM artists WHERE name = ?').get(n).id;
  const VA = artistId('Various Artists');   // seeded by the V17 migration

  // (name, artist_id, year, art, album_artist, compilation, year_min, year_max, track_count, duration_total)
  const insAlbum = d.prepare(`INSERT INTO albums
    (name, artist_id, year, album_art_file, album_artist, compilation, year_min, year_max, track_count, duration_total, agg_dirty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  // One credit, one row.
  insAlbum.run('Solo', artistId('Ann'), 2001, 'solo.jpg', 'Ann', 0, 2001, 2001, 2, 300.5);
  // A joined display string with two main credits.
  insAlbum.run('Duet', artistId('Ann'), 2002, 'duet.jpg', 'Ann & Bob', 0, 2001, 2003, 3, 450);
  // A compilation credited to Various Artists.
  insAlbum.run('Mix', VA, 2005, 'mix.jpg', 'Various Artists', 1, 1999, 2005, 4, 800);
  // Two rows that collapse into one card and DISAGREE on the credit.
  insAlbum.run('Twin', artistId('Ann'), 2003, 'twin.jpg', 'Ann', 0, 2003, 2003, 3, 100.5);
  insAlbum.run('Twin', artistId('Bob'), 2003, 'twin.jpg', 'Bob', 0, 2003, 2004, 2, 200);
  // Two rows that collapse and AGREE (the tag names Ann on both; the primary
  // artist differs, which is what the tag is for).
  insAlbum.run('Same', artistId('Ann'), 2004, 'same.jpg', 'Ann', 0, 2004, 2004, 1, 60);
  insAlbum.run('Same', artistId('Bob'), 2004, 'same.jpg', 'Ann', 0, 2004, 2004, 1, 60);
  // No tag, no credits: falls back to the primary artist.
  insAlbum.run('Legacy', artistId('Cid'), 2006, null, null, 0, 2006, 2006, 1, 30);
  // Namesakes with different years and art: the pinned order is newest first.
  insAlbum.run('Tie', artistId('Ann'), 2010, 'tie-a.jpg', 'Ann', 0, 2010, 2010, 1, 10);
  insAlbum.run('Tie', artistId('Bob'), 2009, 'tie-b.jpg', 'Bob', 0, 2009, 2009, 1, 10);
  // Lives only in libB.
  insAlbum.run('Hidden', artistId('Cid'), 2007, null, 'Cid', 0, 2007, 2007, 1, 30);
  const albumIds = (n) => d.prepare('SELECT id FROM albums WHERE name = ? ORDER BY id').all(n).map((r) => r.id);
  const albumId = (n, i = 0) => albumIds(n)[i];

  const insTrack = d.prepare(`INSERT INTO tracks
    (filepath, library_id, title, artist_id, album_id, year, created_at, audio_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  const addTrack = (lib, album, artist, year = null) =>
    insTrack.run(`t${n}.mp3`, lib, `Track ${n}`, artist, album, year, '2024-01-01 00:00:00', `h-${n++}`);

  addTrack(LIB_A, albumId('Solo'), artistId('Ann'), 2001);
  addTrack(LIB_A, albumId('Solo'), artistId('Ann'), 2001);
  addTrack(LIB_A, albumId('Duet'), artistId('Ann'), 2002);
  addTrack(LIB_A, albumId('Mix'), artistId('Ann'), 1999);
  addTrack(LIB_A, albumId('Mix'), artistId('Bob'), 2005);
  addTrack(LIB_A, albumId('Twin', 0), artistId('Ann'), 2003);
  addTrack(LIB_A, albumId('Twin', 1), artistId('Bob'), 2003);
  addTrack(LIB_A, albumId('Same', 0), artistId('Ann'), 2004);
  addTrack(LIB_A, albumId('Same', 1), artistId('Bob'), 2004);
  addTrack(LIB_A, albumId('Legacy'), artistId('Cid'), 2006);
  addTrack(LIB_A, albumId('Tie', 0), artistId('Ann'), 2010);
  addTrack(LIB_A, albumId('Tie', 1), artistId('Bob'), 2009);
  addTrack(LIB_B, albumId('Hidden'), artistId('Cid'), 2007);
  // Singles: one by Ann (the primary artist), one where Ann is only featured.
  addTrack(LIB_A, null, artistId('Ann'), 2020);
  addTrack(LIB_A, null, artistId('Solo Singer'), 2021);

  // Main album credits, in tag order. 'Legacy' and the second 'Twin' row get none.
  const insCredit = d.prepare('INSERT INTO album_artists (album_id, artist_id, role, position) VALUES (?, ?, ?, ?)');
  insCredit.run(albumId('Solo'), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Duet'), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Duet'), artistId('Bob'), 'main', 1);
  insCredit.run(albumId('Mix'), VA, 'main', 0);
  insCredit.run(albumId('Twin', 0), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Same', 0), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Same', 1), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Tie', 0), artistId('Ann'), 'main', 0);
  insCredit.run(albumId('Tie', 1), artistId('Bob'), 'main', 0);
  insCredit.run(albumId('Hidden'), artistId('Cid'), 'main', 0);
  // Track credits (the scanners write one per track; the fixture only needs
  // two): Bob's main credit on the compilation puts Mix on his page through
  // the track_artists arm, and a featured credit on Solo Singer's single lets
  // the singles bucket be reached through a performer credit.
  const insTrackCredit = d.prepare('INSERT INTO track_artists (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)');
  const bobOnMix = d.prepare('SELECT id FROM tracks WHERE album_id = ? AND artist_id = ?').get(albumId('Mix'), artistId('Bob')).id;
  insTrackCredit.run(bobOnMix, artistId('Bob'), 'main', 0);
  const featSingle = d.prepare('SELECT id FROM tracks WHERE album_id IS NULL AND artist_id = ?').get(artistId('Solo Singer')).id;
  insTrackCredit.run(featSingle, artistId('Ann'), 'featured', 1);
  d.exec('COMMIT');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.user = asUser ?? undefined; next(); });
  dbApi.setup(app);
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
async function get(route) {
  const r = await fetch(`${base}${route}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const scopeTo = (ids) => { asUser = ids ? { id: null, libraryIds: ids } : null; };
const byName = (albums, name) => albums.filter((a) => a.name === name);

// ── /db/albums ──────────────────────────────────────────────────────────────

describe('/db/albums items', () => {
  test('carry the legacy trio first, then the credit and aggregate fields', async () => {
    scopeTo(null);
    const r = await get('/api/v1/db/albums');
    assert.equal(r.status, 200);
    const solo = byName(r.body.albums, 'Solo');
    assert.equal(solo.length, 1);
    assert.deepEqual(Object.keys(solo[0]), [...LEGACY_KEYS, ...NEW_KEYS]);
    assert.deepEqual(solo[0], {
      name: 'Solo', year: 2001, album_art_file: 'solo.jpg',
      album_artist: 'Ann', artists: ['Ann'], compilation: false,
      year_min: 2001, year_max: 2001, track_count: 2, duration: 300.5,
    });
  });

  test('a joined ALBUMARTIST keeps its display string and lists every main credit in tag order', async () => {
    scopeTo(null);
    const [duet] = byName((await get('/api/v1/db/albums')).body.albums, 'Duet');
    assert.equal(duet.album_artist, 'Ann & Bob');
    assert.deepEqual(duet.artists, ['Ann', 'Bob']);
    assert.equal(duet.compilation, false);
    assert.deepEqual([duet.year_min, duet.year_max], [2001, 2003]);
  });

  test('a compilation is flagged and credited to Various Artists', async () => {
    scopeTo(null);
    const [mix] = byName((await get('/api/v1/db/albums')).body.albums, 'Mix');
    assert.equal(mix.compilation, true);
    assert.equal(mix.album_artist, 'Various Artists');
    assert.deepEqual(mix.artists, ['Various Artists']);
  });

  test('collapsed rows that disagree yield a null album_artist, the union of credits and summed counts', async () => {
    scopeTo(null);
    const twin = byName((await get('/api/v1/db/albums')).body.albums, 'Twin');
    assert.equal(twin.length, 1, 'the (name, year, art) collapse is preserved');
    assert.equal(twin[0].album_artist, null);
    // Row one is credited to Ann; row two has no credit and falls back to Bob.
    assert.deepEqual(twin[0].artists, ['Ann', 'Bob']);
    assert.equal(twin[0].track_count, 5);
    assert.equal(twin[0].duration, 300.5);
    assert.deepEqual([twin[0].year_min, twin[0].year_max], [2003, 2004]);
  });

  test('collapsed rows that agree keep the shared credit', async () => {
    scopeTo(null);
    const same = byName((await get('/api/v1/db/albums')).body.albums, 'Same');
    assert.equal(same.length, 1);
    assert.equal(same[0].album_artist, 'Ann');
    assert.deepEqual(same[0].artists, ['Ann']);
    assert.equal(same[0].track_count, 2);
  });

  test('a row without tag or credits falls back to its primary artist', async () => {
    scopeTo(null);
    const [legacy] = byName((await get('/api/v1/db/albums')).body.albums, 'Legacy');
    assert.equal(legacy.album_artist, 'Cid');
    assert.deepEqual(legacy.artists, ['Cid']);
    assert.equal(legacy.album_art_file, null);
  });

  test('namesakes come back newest first, the list otherwise by name', async () => {
    scopeTo(null);
    const names = (await get('/api/v1/db/albums')).body.albums.map((a) => `${a.name}/${a.year}`);
    assert.deepEqual(names, [
      'Duet/2002', 'Hidden/2007', 'Legacy/2006', 'Mix/2005', 'Same/2004', 'Solo/2001',
      'Tie/2010', 'Tie/2009', 'Twin/2003',
    ]);
  });

  test('a hidden-library album drops out for a scoped caller; the rest is unchanged', async () => {
    scopeTo([LIB_A]);
    const r = await post('/api/v1/db/albums', {});
    assert.equal(byName(r.body.albums, 'Hidden').length, 0);
    assert.equal(byName(r.body.albums, 'Solo')[0].track_count, 2);
    scopeTo(null);
  });
});

// ── /db/artists-albums ──────────────────────────────────────────────────────

describe('/db/artists-albums items', () => {
  test('the same item shape, and the singles entry names the requested artist', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/artists-albums', { artist: 'ann' });
    assert.equal(r.status, 200);
    const solo = byName(r.body.albums, 'Solo');
    assert.deepEqual(Object.keys(solo[0]), [...LEGACY_KEYS, ...NEW_KEYS]);
    assert.equal(solo[0].album_artist, 'Ann');
    // Duet reaches Ann through both the primary artist and a credit: one card.
    assert.equal(byName(r.body.albums, 'Duet').length, 1);
    const singles = r.body.albums.filter((a) => a.name === null);
    assert.equal(singles.length, 1, 'Ann has album-less tracks');
    assert.deepEqual(singles[0], {
      name: null, year: null, album_art_file: null,
      album_artist: 'Ann', artists: ['Ann'], compilation: false,
      year_min: null, year_max: null, track_count: null, duration: null,
    });
  });

  test('order is year DESC, then name, then art — the Tie pair keeps its years apart', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/artists-albums', { artist: 'Bob' });
    const got = r.body.albums.filter((a) => a.name !== null).map((a) => `${a.name}/${a.year}`);
    assert.deepEqual(got, ['Tie/2009', 'Mix/2005', 'Same/2004', 'Twin/2003', 'Duet/2002']);
  });

  test('a card is the whole album, not the artist\'s fragment of it', async () => {
    scopeTo(null);
    // Bob reaches only the second Twin row, but the card aggregates every
    // visible row of the (name, year, art) group — the same object
    // /db/albums returns — so sending it back to album-songs plays the album.
    const [viaBob] = byName((await post('/api/v1/db/artists-albums', { artist: 'Bob' })).body.albums, 'Twin');
    const [viaList] = byName((await get('/api/v1/db/albums')).body.albums, 'Twin');
    assert.deepEqual(viaBob, viaList);
    assert.equal(viaBob.album_artist, null);
    assert.deepEqual(viaBob.artists, ['Ann', 'Bob']);
    assert.equal(viaBob.track_count, 5);
  });

  test('a scoped caller only reaches an album through its own visible rows', async () => {
    // Cid's only album in libA is Legacy; Hidden lives in libB. With libA
    // alone visible, Hidden is gone from his page, and Legacy is intact.
    scopeTo([LIB_A]);
    const names = (await post('/api/v1/db/artists-albums', { artist: 'Cid' })).body.albums.map((a) => a.name);
    assert.deepEqual(names, ['Legacy']);
    scopeTo(null);
  });
});

// ── /db/album-songs album_artist ────────────────────────────────────────────

describe('/db/album-songs album_artist', () => {
  const titles = (r) => r.body.map((t) => t.metadata.title).sort();

  test('without it, a namesake album returns every fragment (the pre-series contract)', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: 'Twin', year: 2003 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
  });

  test('narrows by the primary artist, matched on the normalised key', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: 'Twin', year: 2003, album_artist: ' BOB ' });
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].metadata.artist, 'Bob');
  });

  test('narrows by a main credit and by the verbatim display string', async () => {
    scopeTo(null);
    const viaCredit = await post('/api/v1/db/album-songs', { album: 'Duet', album_artist: 'Bob' });
    assert.equal(viaCredit.body.length, 1, 'Bob is a main credit on Duet, not its primary artist');
    const viaDisplay = await post('/api/v1/db/album-songs', { album: 'Duet', album_artist: 'Ann & Bob' });
    assert.equal(viaDisplay.body.length, 1);
    const nobody = await post('/api/v1/db/album-songs', { album: 'Duet', album_artist: 'Cid' });
    assert.deepEqual(nobody.body, []);
  });

  test('the collapsed card that agrees opens fully with its shared credit', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: 'Same', year: 2004, album_artist: 'Ann' });
    assert.equal(r.body.length, 2, 'both rows carry the Ann tag');
  });

  test('without an album it matches the track artist, performer credits included', async () => {
    scopeTo(null);
    const r = await post('/api/v1/db/album-songs', { album: null, album_artist: 'Ann' });
    assert.deepEqual(titles(r), ['Track 13', 'Track 14'], 'her own single plus the one she is featured on');
  });

  test('null fields and unknown keys are still accepted; an empty selector is ignored', async () => {
    scopeTo(null);
    const nulls = await post('/api/v1/db/album-songs', { album: 'Solo', artist: null, year: null, album_artist: null, extra: 1 });
    assert.equal(nulls.status, 200);
    assert.equal(nulls.body.length, 2);
    const empty = await post('/api/v1/db/album-songs', { album: 'Solo', album_artist: '' });
    assert.equal(empty.body.length, 2);
  });

  test('a hidden-library album stays hidden with the selector too', async () => {
    scopeTo([LIB_A]);
    const r = await post('/api/v1/db/album-songs', { album: 'Hidden', album_artist: 'Cid' });
    assert.deepEqual(r.body, []);
    scopeTo(null);
  });
});
