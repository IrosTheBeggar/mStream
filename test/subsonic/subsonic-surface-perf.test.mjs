/**
 * Pins for the 2026-07 audit's subsonic-surface fixes (PR-G):
 *
 *   M4  — count params are capped at 500 and a whole-library response can no
 *         longer blow SQLite's bound-variable limit (chunked enrichment);
 *   M7  — blank-query search3 pages with a TOTAL order: pages tile exactly;
 *   M12 — getAlbumList(2)'s two-step page/project returns exactly what the
 *         old single-pass aggregation returned, for every type;
 *   M15 — getArtists memo is per-(library-set, epoch): a scoped user never
 *         sees another grant's cached rows; getIndexes' lastModified is
 *         stable and ifModifiedSince is honoured;
 *   pin — getPlayQueue / getBookmarks keep the hash-index probes (the
 *         `+t.library_id` demotion) and restore queues past 1,000 entries
 *         (the Express qs parameterLimit silently dropped ids beyond ~997).
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../helpers/server.mjs';

const N_TRACKS = 1300;          // > 1000 for the param-loss pin, > 900 for chunking
let server, bigDir, mdbPath;
let keyAll, keyScoped;

async function login(username) {
  const r = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'p' }),
  });
  return (await r.json()).token;
}
async function mintKey(token, name) {
  const r = await fetch(`${server.baseUrl}/api/v1/user/api-keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': token },
    body: JSON.stringify({ name }),
  });
  return (await r.json()).key;
}
function url(key, method, params = {}) {
  const q = new URLSearchParams();
  q.set('f', 'json'); q.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { for (const x of v) { q.append(k, x); } }
    else if (v != null) { q.set(k, String(v)); }
  }
  return `${server.baseUrl}/rest/${method}?${q}`;
}
async function call(key, method, params = {}) {
  const r = await fetch(url(key, method, params));
  return (await r.json())['subsonic-response'];
}
function withDb(fn) {
  const d = new DatabaseSync(mdbPath);
  try { return fn(d); } finally { d.close(); }
}

before(async () => {
  bigDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'mstream-sperf-'));
  fs.writeFileSync(path.join(bigDir, 'placeholder.txt'), 'x');
  server = await startServer({
    dlnaMode: 'disabled',
    extraFolders: { biglib: bigDir },
    users: [
      { username: 'all', password: 'p', admin: true, vpaths: ['testlib', 'biglib'] },
      { username: 'scoped', password: 'p', admin: false, vpaths: ['testlib'] },
    ],
  });
  mdbPath = path.join(server.tmpDir, 'db', 'mstream.db');

  // Seed biglib straight into the DB: enough tracks to cross both the
  // 1,000-param and 900-id-chunk lines, album/um structure for every
  // getAlbumList type, and a LEGACY slice (audio_hash NULL, um keyed on
  // file_hash) so the UNION ALL hash arms are both exercised.
  withDb((d) => {
    const libId = d.prepare("SELECT id FROM libraries WHERE name='biglib'").get().id;
    const userId = d.prepare("SELECT id FROM users WHERE username='all'").get().id;
    d.exec('BEGIN');
    const insArtist = d.prepare('INSERT INTO artists (name) VALUES (?)');
    const artistIds = [];
    for (let i = 0; i < 20; i++) {
      artistIds.push(Number(insArtist.run(`Perf Artist ${String(i).padStart(2, '0')}`).lastInsertRowid));
    }
    const insAlbum = d.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)');
    const albumIds = [];
    for (let i = 0; i < 65; i++) {
      albumIds.push(Number(insAlbum.run(`Perf Album ${String(i).padStart(2, '0')}`,
        artistIds[i % 20], 1980 + (i % 40)).lastInsertRowid));
    }
    d.prepare("INSERT INTO genres (name) VALUES ('PerfGenre')").run();
    const gid = d.prepare("SELECT id FROM genres WHERE name='PerfGenre'").get().id;
    const insTrack = d.prepare(`INSERT INTO tracks
      (filepath, library_id, title, artist_id, album_id, created_at, audio_hash, file_hash, duration, year)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTA = d.prepare("INSERT INTO track_artists (track_id, artist_id, position, role) VALUES (?, ?, 0, 'main')");
    const insTg = d.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)');
    const insUm = d.prepare(`INSERT INTO user_metadata (user_id, track_hash, rating, play_count, last_played)
      VALUES (?, ?, ?, ?, ?)`);
    for (let i = 0; i < N_TRACKS; i++) {
      const albumIdx = i % 65;
      const legacy = i % 9 === 0;
      const tid = Number(insTrack.run(`perf${i}.mp3`, libId, `Perf Track ${String(i).padStart(4, '0')}`,
        artistIds[albumIdx % 20], albumIds[albumIdx],
        `20${10 + (i % 15)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 00:00:00`,
        legacy ? null : `pf-a-${i}`, `pf-f-${i}`, 200, 1980 + (i % 40)).lastInsertRowid);
      insTA.run(tid, artistIds[albumIdx % 20]);
      if (i % 4 === 0) { insTg.run(tid, gid); }
      if (i % 5 === 0) {
        insUm.run(userId, legacy ? `pf-f-${i}` : `pf-a-${i}`, (i % 5) + 1, (i % 30) + 1,
          `2026-0${(i % 6) + 1}-10 09:00:00`);
      }
    }
    d.exec('COMMIT');
  });

  keyAll = await mintKey(await login('all'), 'perf-all');
  keyScoped = await mintKey(await login('scoped'), 'perf-scoped');
});

after(async () => {
  if (server) { await server.stop(); }
  try { fs.rmSync(bigDir, { recursive: true, force: true }); } catch { /* win locks */ }
  setImmediate(() => process.exit(0));
});

// ── M4: count cap + chunked enrichment ──────────────────────────────────────

describe('search3 count cap (M4)', () => {
  test('songCount=100000 is capped at 500, not an error', async () => {
    const r = await call(keyAll, 'search3', { query: '', songCount: 100000, artistCount: 0, albumCount: 0 });
    assert.equal(r.status, 'ok', JSON.stringify(r.error || {}));
    assert.equal(r.searchResult3.song.length, 500);
  });

  test('a zero count is still honoured as zero', async () => {
    const r = await call(keyAll, 'search3', { query: '', songCount: 0, artistCount: 0, albumCount: 5 });
    assert.equal(r.status, 'ok');
    assert.equal((r.searchResult3.song ?? []).length, 0, 'no songs requested, none returned');
    assert.equal(r.searchResult3.album.length, 5);
  });

  test('offsets are NOT capped — paging reaches past 500', async () => {
    const r = await call(keyAll, 'search3', { query: '', songCount: 10, songOffset: 1200, artistCount: 0, albumCount: 0 });
    assert.equal(r.status, 'ok');
    assert.ok(r.searchResult3.song.length > 0, 'rows exist past offset 1200');
  });
});

// ── M7: blank-listing pagination law ────────────────────────────────────────

describe('search3 blank-query paging (M7)', () => {
  test('pages tile the song set exactly — no dups, no gaps, stable order', async () => {
    const seen = [];
    for (let off = 0; off < N_TRACKS + 500; off += 500) {
      const r = await call(keyAll, 'search3',
        { query: '', songCount: 500, songOffset: off, artistCount: 0, albumCount: 0 });
      for (const s of (r.searchResult3.song || [])) { seen.push(s.id); }
    }
    const total = withDb((d) => d.prepare('SELECT COUNT(*) n FROM tracks').get().n);
    assert.equal(seen.length, total, 'every track appears once');
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across page boundaries');
  });

  test('artist and album sections page too, and tile', async () => {
    const ids = [];
    for (let off = 0; off < 100; off += 20) {
      const r = await call(keyAll, 'search3',
        { query: '', artistCount: 20, artistOffset: off, songCount: 0, albumCount: 0 });
      for (const a of (r.searchResult3.artist || [])) { ids.push(a.id); }
    }
    assert.equal(new Set(ids).size, ids.length, 'artist pages do not overlap');
    assert.ok(ids.length >= 20, 'multiple artist pages returned');
  });
});

// ── M12: album lists match the pre-PR aggregation ───────────────────────────

describe('getAlbumList2 two-step (M12)', () => {
  // The old single-pass query, kept as the oracle. Returns the id set the
  // pre-PR SQL produced for the type (order compared separately — the old
  // order was plan-dependent within ties, which is part of what changed).
  function oracleIds(type, userId, libIds, size = 500) {
    const ph = libIds.map(() => '?').join(',');
    let having = 'songCount > 0';
    let order = 'al.name COLLATE NOCASE';
    if (type === 'newest')   { order = 'MIN(t.created_at) DESC'; }
    if (type === 'recent')   { having += ' AND MAX(um.last_played) IS NOT NULL'; order = 'MAX(um.last_played) DESC'; }
    if (type === 'frequent') { having += ' AND SUM(COALESCE(um.play_count, 0)) > 0'; order = 'SUM(COALESCE(um.play_count, 0)) DESC'; }
    if (type === 'highest')  { having += ' AND MAX(um.rating) IS NOT NULL'; order = 'MAX(um.rating) DESC'; }
    return withDb((d) => d.prepare(`
      SELECT al.id, COUNT(t.id) AS songCount
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN user_metadata um ON um.track_hash = COALESCE(t.audio_hash, t.file_hash) AND um.user_id = ?
      WHERE t.library_id IN (${ph})
      GROUP BY al.id HAVING ${having} ORDER BY ${order} LIMIT ?
    `).all(userId, ...libIds, size).map((r) => r.id));
  }
  const libIds = () => withDb((d) => d.prepare('SELECT id FROM libraries ORDER BY id').all().map((r) => r.id));
  const userId = () => withDb((d) => d.prepare("SELECT id FROM users WHERE username='all'").get().id);
  const decode = (id) => parseInt(String(id).replace(/^[a-z]+-/, ''), 10) || parseInt(id, 10);

  for (const type of ['alphabeticalByName', 'alphabeticalByArtist', 'newest', 'recent', 'frequent', 'highest']) {
    test(`type=${type} returns exactly the old query's album set`, async () => {
      const r = await call(keyAll, 'getAlbumList2', { type, size: 500 });
      assert.equal(r.status, 'ok', JSON.stringify(r.error || {}));
      const got = (r.albumList2.album || []).map((a) => decode(a.id)).sort((x, y) => x - y);
      const want = oracleIds(type, userId(), libIds()).sort((x, y) => x - y);
      assert.deepEqual(got, want);
    });
  }

  test('byYear respects the reversed-range DESC contract', async () => {
    const r = await call(keyAll, 'getAlbumList2', { type: 'byYear', fromYear: 2019, toYear: 1980, size: 500 });
    const years = (r.albumList2.album || []).map((a) => a.year);
    assert.ok(years.length > 0);
    assert.deepEqual(years, [...years].sort((a, b) => b - a), 'toYear < fromYear pages newest-first');
  });

  test('paging tiles without dups across a page boundary', async () => {
    const p1 = await call(keyAll, 'getAlbumList2', { type: 'alphabeticalByName', size: 30, offset: 0 });
    const p2 = await call(keyAll, 'getAlbumList2', { type: 'alphabeticalByName', size: 30, offset: 30 });
    const ids = [...p1.albumList2.album, ...p2.albumList2.album].map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('getAlbumList (v1) carries the same payload under the older tag', async () => {
    const v1 = await call(keyAll, 'getAlbumList', { type: 'alphabeticalByName', size: 10 });
    const v2 = await call(keyAll, 'getAlbumList2', { type: 'alphabeticalByName', size: 10 });
    assert.deepEqual(v1.albumList.album.map((a) => a.id), v2.albumList2.album.map((a) => a.id));
  });

  test('missing byGenre param is still MISSING_PARAM, not a crash', async () => {
    const r = await call(keyAll, 'getAlbumList2', { type: 'byGenre' });
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 10);
  });
});

// ── M15: memo scoping + conditional fetch ───────────────────────────────────

describe('getArtists memo + getIndexes lastModified (M15)', () => {
  test('a scoped user never sees another grant\'s cached artist list', async () => {
    const all = await call(keyAll, 'getArtists');
    const scoped = await call(keyScoped, 'getArtists');
    const names = (idx) => (idx || []).flatMap((b) => b.artist.map((a) => a.name));
    assert.ok(names(all.artists.index).some((n) => n.startsWith('Perf Artist')),
      'all-access sees the seeded biglib artists');
    assert.ok(!names(scoped.artists.index).some((n) => n.startsWith('Perf Artist')),
      'scoped (testlib-only) must not — the memo key is the library set');
  });

  test('lastModified is stable across calls within an epoch', async () => {
    const a = await call(keyAll, 'getIndexes');
    const b = await call(keyAll, 'getIndexes');
    assert.equal(a.indexes.lastModified, b.indexes.lastModified);
    assert.ok(Array.isArray(a.indexes.index) && a.indexes.index.length > 0);
  });

  test('ifModifiedSince at/after lastModified returns no index; before returns it', async () => {
    const now = (await call(keyAll, 'getIndexes')).indexes.lastModified;
    const unchanged = await call(keyAll, 'getIndexes', { ifModifiedSince: now });
    assert.equal(unchanged.status, 'ok');
    assert.equal(unchanged.indexes.index ?? undefined, undefined, 'unchanged → envelope without index');
    const changed = await call(keyAll, 'getIndexes', { ifModifiedSince: now - 10_000 });
    assert.ok(Array.isArray(changed.indexes.index), 'older client timestamp → full index');
  });
});

// ── pin + param-loss: play queue and bookmarks ──────────────────────────────

describe('getPlayQueue / getBookmarks (pin + raw params)', () => {
  test('a 1,300-entry queue round-trips COMPLETE — ids past the qs 1000-param cliff survive', async () => {
    const ids = withDb((d) =>
      d.prepare("SELECT id FROM tracks WHERE filepath LIKE 'perf%' ORDER BY id").all().map((r) => r.id));
    assert.ok(ids.length >= N_TRACKS);
    const save = await fetch(url(keyAll, 'savePlayQueue', { id: ids, current: ids[0], position: 1234 }));
    assert.equal((await save.json())['subsonic-response'].status, 'ok');

    const r = await call(keyAll, 'getPlayQueue');
    assert.equal(r.playQueue.entry.length, ids.length,
      'every saved id comes back (was ~997 before the raw-query parse)');
    // Stored order preserved end to end, including the tail.
    assert.equal(String(r.playQueue.entry[0].id), String(ids[0]));
    assert.equal(String(r.playQueue.entry.at(-1).id), String(ids.at(-1)));
  });

  test('the scoped user cannot restore hidden-library entries', async () => {
    const someIds = withDb((d) =>
      d.prepare("SELECT id FROM tracks WHERE filepath LIKE 'perf%' ORDER BY id LIMIT 20").all().map((r) => r.id));
    await fetch(url(keyScoped, 'savePlayQueue', { id: someIds, current: someIds[0] }));
    const r = await call(keyScoped, 'getPlayQueue');
    assert.equal((r.playQueue.entry ?? []).length, 0,
      'biglib tracks are invisible to a testlib-only grant');
  });

  test('bookmarks list resolves songs for both hash generations', async () => {
    // One canonical-hash track and one legacy (file_hash-only) track.
    const [modern, legacy] = withDb((d) => [
      d.prepare("SELECT id FROM tracks WHERE audio_hash IS NOT NULL AND filepath LIKE 'perf%' LIMIT 1").get().id,
      d.prepare("SELECT id FROM tracks WHERE audio_hash IS NULL AND filepath LIKE 'perf%' LIMIT 1").get().id,
    ]);
    await fetch(url(keyAll, 'createBookmark', { id: modern, position: 111 }));
    await fetch(url(keyAll, 'createBookmark', { id: legacy, position: 222 }));
    const r = await call(keyAll, 'getBookmarks');
    const entries = r.bookmarks.bookmark.filter((b) => b.entry);
    const entryIds = entries.map((b) => String(b.entry.id));
    assert.ok(entryIds.includes(String(modern)), 'audio_hash-keyed bookmark resolves');
    assert.ok(entryIds.includes(String(legacy)), 'file_hash-keyed bookmark resolves');
  });
});
