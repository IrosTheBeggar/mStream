/**
 * POST /api/v1/sync/manifest — the paged library manifest behind the app's
 * local mirror / offline index (mstream_music BACKUP_SYNC_PLAN.md):
 *
 *   - every visible track, ascending id, as the lite `{filepath, metadata}`
 *     row plus the sync identity fields (size / mtime / hashes / scheme);
 *   - id-cursor paging with no gaps or overlap, even when a row lands
 *     mid-walk, and a full last page still ends with `next: null`;
 *   - the same library scoping as every db/* route (grant + ignoreVPaths);
 *   - a revision that moves on add / delete / mtime bump / art backfill /
 *     scope change and returns to its old value when the set is restored,
 *     doubling as a strong ETag: If-None-Match on the first page → 304, a
 *     cursor never short-circuits;
 *   - the per-user rating rides in the lite block (pins trackQuery's
 *     user-id-first parameter order);
 *   - Joi validation → 400 through the same handler shape server.js mounts.
 *
 * Mounted on a bare express app so req.user can be driven directly, like
 * db-read-paths.test.mjs.
 */

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import Joi from 'joi';

let testRoot, server, base;
let manager, dbApi, syncApi;
let LIB_A, LIB_B, ALICE, BOB, FIRST, USER_ID;
let asUser = null;      // null => public mode (every library visible)
const ids = {};         // fixture track ids by label, in insertion order

// One track row with every column the manifest surfaces. Deterministic
// per-row values (hashes f<n>/a<n>, mtime 1.7e12 + n s, created 2024-01-0n)
// so assertions can name them.
function addTrack(label, lib, filepath, artist, album, track, size, art) {
  const n = Object.keys(ids).length + 1;
  const r = manager.getDB().prepare(`INSERT INTO tracks
    (filepath, library_id, title, artist_id, album_id, track_number, disc_number, year,
     duration, format, file_size, file_hash, audio_hash, hash_v, modified, created_at,
     album_art_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(filepath, lib, `Track ${n}`, artist, album, track, 1, 2001, 200 + n,
      path.extname(filepath).slice(1), size, `f${n}`, `a${n}`, 2,
      1_700_000_000_000 + n * 1000, `2024-01-0${n} 00:00:00`, art);
  ids[label] = Number(r.lastInsertRowid);
  return ids[label];
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-sync-'));
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

  const config = await import('../../src/state/config.js');
  await config.setup(path.join(testRoot, 'config.json'));
  manager = await import('../../src/db/manager.js');
  manager.initDB();
  dbApi = await import('../../src/api/db.js');
  syncApi = await import('../../src/api/sync.js');

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
  ALICE = Number(insArtist.run('Alice').lastInsertRowid);
  BOB = Number(insArtist.run('Bob').lastInsertRowid);
  const insAlbum = d.prepare(
    'INSERT INTO albums (name, artist_id, year, album_art_file) VALUES (?, ?, ?, ?)');
  FIRST = Number(insAlbum.run('First', ALICE, 2001, 'aa.jpg').lastInsertRowid);
  const second = Number(insAlbum.run('Second', BOB, 2002, null).lastInsertRowid);
  const hidden = Number(insAlbum.run('Hidden', BOB, 2003, null).lastInsertRowid);

  addTrack('a1', LIB_A, 'Alice/First/01.flac', ALICE, FIRST, 1, 1000, 'aa.jpg');
  addTrack('a2', LIB_A, 'Alice/First/02.flac', ALICE, FIRST, 2, 2000, 'aa.jpg');
  addTrack('b1', LIB_A, 'Bob/Second/01.mp3', BOB, second, 1, 3000, null);
  // The shape a Windows-hosted scan stores; the wire form is forward-slash.
  addTrack('b2', LIB_A, 'Bob\\Second\\02.mp3', BOB, second, 2, 4000, null);
  addTrack('h1', LIB_B, 'Hidden/01.ogg', BOB, hidden, 1, 5000, null);

  for (const g of ['Rock', 'Jazz']) { d.prepare('INSERT INTO genres (name) VALUES (?)').run(g); }
  const genreId = (g) => d.prepare('SELECT id FROM genres WHERE name = ?').get(g).id;
  const insTg = d.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  insTg.run(ids.a1, genreId('Rock'));
  insTg.run(ids.a2, genreId('Rock'));
  insTg.run(ids.h1, genreId('Jazz'));

  // A real user with one rating: user_metadata keys on COALESCE(audio_hash,
  // file_hash), i.e. 'a1' for track a1.
  USER_ID = Number(d.prepare(
    "INSERT INTO users (username, password, salt, is_admin) VALUES ('rater', '!', '!', 0)")
    .run().lastInsertRowid);
  d.prepare('INSERT INTO user_metadata (user_id, track_hash, rating) VALUES (?, ?, ?)')
    .run(USER_ID, 'a1', 8);
  d.exec('COMMIT');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.user = asUser ?? undefined; next(); });
  syncApi.setup(app);
  // The shape server.js mounts: Joi validation → 400, anything else → 500.
  app.use((error, _req, res, _next) => {
    res.status(error instanceof Joi.ValidationError ? 400 : 500).json({ error: error.message });
  });
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

async function manifest(body = {}, headers = {}) {
  const r = await fetch(`${base}/api/v1/sync/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, etag: r.headers.get('etag'), text, body: text ? JSON.parse(text) : null };
}
// Scope the next calls to a library set (the federation-grant shape, which is
// the same input libraryFilter sees for a vpath-restricted user); `id` drives
// the per-user joins.
const scopeTo = (libIds, id = null) => { asUser = libIds ? { id, libraryIds: libIds } : null; };
const entryIds = (r) => r.body.entries.map((e) => e.id);

describe('sync/manifest', () => {
  test('lists every visible track ascending by id with lite metadata + sync identity', async () => {
    scopeTo(null);
    const r = await manifest();
    assert.equal(r.status, 200);
    const { revision, scanning, next, entries } = r.body;
    assert.equal(typeof revision, 'string');
    assert.equal(scanning, false);
    assert.equal(next, null, 'one page holds the whole fixture');
    assert.deepEqual(entryIds(r), [ids.a1, ids.a2, ids.b1, ids.b2, ids.h1]);

    const e = entries[0];
    assert.equal(e.filepath, 'libA/Alice/First/01.flac');
    assert.deepEqual(Object.keys(e.metadata).sort(), [...dbApi.LITE_METADATA_FIELDS].sort(),
      'metadata is exactly the lite block');
    assert.equal(e.metadata.title, 'Track 1');
    assert.equal(e.metadata.artist, 'Alice');
    assert.equal(e.metadata.album, 'First');
    assert.equal(e.metadata.track, 1);
    assert.equal(e.metadata.duration, 201);
    assert.equal(e.metadata['album-art'], 'aa.jpg');
    assert.deepEqual(e.metadata.genres, ['Rock']);
    assert.equal(e.metadata.rating, null, 'public mode has no user to rate as');

    assert.equal(e.id, ids.a1);
    assert.equal(e['file-size'], 1000);
    assert.equal(e.modified, 1_700_000_001_000);
    assert.equal(e.hash, 'f1');
    assert.equal(e['audio-hash'], 'a1');
    assert.equal(e['hash-v'], 2);
    assert.equal(e.format, 'flac');
    assert.equal(e['album-id'], FIRST);
    assert.equal(e['artist-id'], ALICE);
    assert.equal(e['created-at'], '2024-01-01 00:00:00');
    // The sync fields are an explicit allowlist — nothing else from the full
    // block leaks to the top level.
    assert.equal('bitrate' in e, false);
    assert.equal('play-count' in e.metadata, false);
    assert.deepEqual(entries.find((x) => x.id === ids.h1).metadata.genres, ['Jazz']);
  });

  test('renders backslash filepaths with forward slashes', async () => {
    scopeTo(null);
    const r = await manifest();
    assert.equal(r.body.entries.find((e) => e.id === ids.b2).filepath, 'libA/Bob/Second/02.mp3');
  });

  test('scopes to the caller\'s libraries and honours ignoreVPaths', async () => {
    scopeTo([LIB_B]);
    assert.deepEqual(entryIds(await manifest()), [ids.h1]);

    scopeTo(null);
    const trimmed = await manifest({ ignoreVPaths: ['libB'] });
    assert.deepEqual(entryIds(trimmed), [ids.a1, ids.a2, ids.b1, ids.b2]);

    scopeTo([]);
    const nothing = await manifest();
    assert.equal(nothing.status, 200);
    assert.deepEqual(nothing.body.entries, []);
    assert.equal(nothing.body.next, null);
    assert.equal(typeof nothing.body.revision, 'string');
  });

  test('the per-user rating rides in the lite block', async () => {
    scopeTo([LIB_A, LIB_B], USER_ID);
    const r = await manifest();
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.find((e) => e.id === ids.a1).metadata.rating, 8);
    assert.equal(r.body.entries.find((e) => e.id === ids.a2).metadata.rating, null);
  });

  test('ETag / If-None-Match: 304 on a matching tag, first page only', async () => {
    scopeTo(null);
    const first = await manifest();
    assert.equal(first.status, 200);
    assert.equal(first.etag, `"${first.body.revision}"`, 'the ETag is the quoted revision');

    const again = await manifest({}, { 'If-None-Match': first.etag });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    assert.equal(again.etag, first.etag, 'a 304 still carries the ETag');

    assert.equal((await manifest({}, { 'If-None-Match': `W/${first.etag}` })).status, 304,
      'a weak tag with the same value matches');
    assert.equal((await manifest({}, { 'If-None-Match': `"stale", ${first.etag}` })).status, 304,
      'any tag in a list matches');

    const stale = await manifest({}, { 'If-None-Match': '"nope"' });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.entries.length, 5);

    const paged = await manifest({ cursor: 0 }, { 'If-None-Match': first.etag });
    assert.equal(paged.status, 200, 'a cursor is a walk in progress — never a 304');
    assert.equal(paged.body.entries.length, 5);
  });

  test('pages by id with no gaps or overlap, even when a row lands mid-walk', async () => {
    scopeTo(null);
    const p1 = await manifest({ limit: 2 });
    assert.deepEqual(entryIds(p1), [ids.a1, ids.a2]);
    assert.equal(p1.body.next, ids.a2);

    // A scan adds a track while the client is between pages.
    addTrack('late', LIB_A, 'Late/01.mp3', BOB, null, 1, 6000, null);

    const p2 = await manifest({ limit: 2, cursor: p1.body.next });
    assert.deepEqual(entryIds(p2), [ids.b1, ids.b2]);
    assert.equal(p2.body.next, ids.b2);

    const p3 = await manifest({ limit: 2, cursor: p2.body.next });
    assert.deepEqual(entryIds(p3), [ids.h1, ids.late], 'the new row appears at the end');
    assert.equal(p3.body.next, null, 'a full last page still ends the walk');

    const walked = [...entryIds(p1), ...entryIds(p2), ...entryIds(p3)];
    assert.deepEqual(walked, [...new Set(walked)], 'no duplicates');
    assert.deepEqual(walked, entryIds(await manifest()), 'the pages are the whole listing');
  });

  test('revision: stable when nothing changed, moves on add / mtime / art / delete / scope', async () => {
    scopeTo(null);
    const r0 = (await manifest()).body.revision;
    assert.equal((await manifest()).body.revision, r0, 'a no-op call is a no-op');

    const d = manager.getDB();
    const extra = addTrack('extra', LIB_A, 'Extra/01.mp3', BOB, null, 1, 7000, null);
    const r1 = (await manifest()).body.revision;
    assert.notEqual(r1, r0, 'an added row');

    d.prepare('UPDATE tracks SET modified = modified + 5000 WHERE id = ?').run(extra);
    const r2 = (await manifest()).body.revision;
    assert.notEqual(r2, r1, 'a changed file (mtime)');

    d.prepare("UPDATE tracks SET album_art_file = 'zz.jpg' WHERE id = ?").run(extra);
    const r3 = (await manifest()).body.revision;
    assert.notEqual(r3, r2, 'the art backfill, which leaves mtime alone');

    d.prepare('DELETE FROM tracks WHERE id = ?').run(extra);
    const r4 = (await manifest()).body.revision;
    assert.notEqual(r4, r3, 'a deleted row');
    assert.equal(r4, r0, 'the original set is the original revision — the string is a pure function of it');

    scopeTo([LIB_A]);
    assert.notEqual((await manifest()).body.revision, r0, 'a different scope is a different revision');
  });

  test('validation failures are 400s', async () => {
    scopeTo(null);
    for (const body of [
      { limit: 0 }, { limit: 5001 }, { limit: 1.5 }, { cursor: -1 }, { cursor: 'x' },
      { ignoreVPaths: 'libB' }, { bogus: true },
    ]) {
      const r = await manifest(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} must be rejected`);
      assert.equal(typeof r.body.error, 'string');
    }
  });
});
