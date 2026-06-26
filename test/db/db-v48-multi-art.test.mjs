/**
 * V48 migration tests: the multi-art data model.
 *
 * V48 adds art_files (one row per distinct image, 'cached' in the
 * album-art directory vs 'reference' in place in a library) + the
 * track_art / album_art / artist_art junction sets, plus the
 * default-pointer companion columns (album_art_source / album_art_pinned
 * on tracks and albums; image_file / image_source / image_pinned on
 * artists). Existing single art is seeded into the model so current
 * covers carry over as the default.
 *
 * Covers:
 *   - Schema shape: new tables + columns exist with the right affinity /
 *     nullability / defaults; user_version advances; not rescanRequired.
 *   - Upgrade seed: a V47 DB with real art data gets one deduped
 *     art_files row per distinct cover and a junction link per
 *     track/album that had one; artless rows get nothing; artists are
 *     untouched.
 *   - Fresh-DB seed is a no-op (empty chain replay).
 *   - Dedup indexes: partial UNIQUE per kind — cached by cache_file,
 *     reference by (library_id, rel_path), no cross-kind collision.
 *   - CASCADE topology: deleting a track / album / artist / art_files
 *     row / library removes exactly the junction (and reference-art)
 *     rows hanging off it.
 *
 * Forward-only — same convention as V1-V47 (recovery for a bad
 * migration is delete-DB + rescan, or restore from backup).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function getColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === column);
}

// node:sqlite rows have a null prototype, which assert/strict's deepEqual
// treats as a mismatch against object literals — re-shape to plain objects.
const plain = rows => rows.map(r => ({ ...r }));

function freshDb({ upToVersion } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, upToVersion ? { upToVersion } : {});
  return db;
}

// Build the canonical seed fixture on a V47 DB:
//   lib ─ artistA ─ album1 (cover shared.jpg)    ─ t1 (shared.jpg)
//                                                └ t2 (shared.jpg)
//        artistB ─ album2 (cover own.jpg)        ─ t3 (own.jpg)
//                                                └ t4 (no art)
//        artistA ─ album3 (cover albumonly.jpg)  ─ t6 (no art)
//                                                └ t7 ('' junk art)
//   + albumless t5 with its own loose.jpg
// Distinct covers in use: shared/own/loose/albumonly → 4 art_files.
// album3's cover exercises the albums branch of the seed's UNION (a
// cover no track carries); t7's '' exercises the junk-data filter.
function buildV47Fixture(db) {
  const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('Music', '/music')").run().lastInsertRowid);
  const artistA = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist A')").run().lastInsertRowid);
  const artistB = Number(db.prepare("INSERT INTO artists (name) VALUES ('Artist B')").run().lastInsertRowid);
  const album1 = Number(db.prepare("INSERT INTO albums (name, artist_id, year, album_art_file) VALUES ('Album One', ?, 2001, 'shared.jpg')").run(artistA).lastInsertRowid);
  const album2 = Number(db.prepare("INSERT INTO albums (name, artist_id, year, album_art_file) VALUES ('Album Two', ?, 2002, 'own.jpg')").run(artistB).lastInsertRowid);
  const album3 = Number(db.prepare("INSERT INTO albums (name, artist_id, year, album_art_file) VALUES ('Album Three', ?, 2003, 'albumonly.jpg')").run(artistA).lastInsertRowid);
  const insTrack = db.prepare(
    'INSERT INTO tracks (filepath, library_id, title, artist_id, album_id, album_art_file) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const ids = {};
  ids.t1 = Number(insTrack.run('a/1.mp3', libId, 'T1', artistA, album1, 'shared.jpg').lastInsertRowid);
  ids.t2 = Number(insTrack.run('a/2.mp3', libId, 'T2', artistA, album1, 'shared.jpg').lastInsertRowid);
  ids.t3 = Number(insTrack.run('b/3.mp3', libId, 'T3', artistB, album2, 'own.jpg').lastInsertRowid);
  ids.t4 = Number(insTrack.run('b/4.mp3', libId, 'T4', artistB, album2, null).lastInsertRowid);
  ids.t5 = Number(insTrack.run('loose/5.mp3', libId, 'T5', artistA, null, 'loose.jpg').lastInsertRowid);
  ids.t6 = Number(insTrack.run('c/6.mp3', libId, 'T6', artistA, album3, null).lastInsertRowid);
  ids.t7 = Number(insTrack.run('c/7.mp3', libId, 'T7', artistA, album3, '').lastInsertRowid);
  return { libId, artistA, artistB, album1, album2, album3, ...ids };
}

function finishMigrations(db) {
  // Continue the chain from wherever the fixture left it.
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= current) { continue; }
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}

// ── Schema shape ────────────────────────────────────────────────────────────

describe('V48 schema shape', () => {
  test('MIGRATIONS contains a v48 entry, not rescanRequired', () => {
    const v48 = MIGRATIONS.find(m => m.version === 48);
    assert.ok(v48, 'missing v48 migration');
    assert.match(v48.sql, /CREATE TABLE IF NOT EXISTS art_files/);
    // No scanner binds the new columns yet; existing art is preserved as
    // the default immediately. The full image set lands with the scanner
    // PR behind a force-rescan, not on upgrade.
    assert.ok(!v48.rescanRequired, 'V48 should not force a rescan on upgrade');
  });

  test('applying all migrations leaves user_version = SCHEMA_VERSION', () => {
    const db = freshDb();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 48, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
    db.close();
  });

  test('junction + art_files tables exist with expected columns', () => {
    // Capped at V48 — like the V36 delta test — so LATER migrations that
    // extend these tables (V50 added art_files.content_hash) don't break
    // this snapshot of what V48 itself created.
    const db = freshDb({ upToVersion: 48 });
    for (const table of ['art_files', 'track_art', 'album_art', 'artist_art']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      assert.ok(cols.length > 0, `${table} should exist`);
      if (table !== 'art_files') {
        assert.deepEqual(
          cols.sort(),
          [`${table === 'track_art' ? 'track' : table === 'album_art' ? 'album' : 'artist'}_id`,
            'art_id', 'picture_type', 'position', 'source'].sort(),
          `${table} columns`
        );
      }
    }
    const af = db.prepare('PRAGMA table_info(art_files)').all().map(c => c.name).sort();
    assert.deepEqual(af, ['byte_size', 'cache_file', 'created_at', 'height', 'id', 'kind', 'library_id', 'rel_path', 'width'].sort());
    db.close();
  });

  test('default-pointer companion columns exist (tracks, albums, artists)', () => {
    const db = freshDb();
    for (const [table, prefix] of [['tracks', 'album_art'], ['albums', 'album_art']]) {
      const src = getColumn(db, table, `${prefix}_source`);
      assert.ok(src && src.type.toUpperCase() === 'TEXT' && src.notnull === 0, `${table}.${prefix}_source`);
      const pin = getColumn(db, table, `${prefix}_pinned`);
      assert.ok(pin && pin.type.toUpperCase() === 'INTEGER' && pin.notnull === 1, `${table}.${prefix}_pinned`);
      assert.equal(pin.dflt_value, '0', `${table}.${prefix}_pinned defaults 0`);
    }
    for (const col of ['image_file', 'image_source']) {
      const c = getColumn(db, 'artists', col);
      assert.ok(c && c.type.toUpperCase() === 'TEXT' && c.notnull === 0, `artists.${col}`);
    }
    const pin = getColumn(db, 'artists', 'image_pinned');
    assert.ok(pin && pin.notnull === 1 && pin.dflt_value === '0', 'artists.image_pinned');
    db.close();
  });

  test('fresh DB: seed is a no-op (no phantom art rows)', () => {
    const db = freshDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_art').get().n, 0);
    db.close();
  });

  test('V47→V48 column delta is exactly the documented additions', () => {
    // Same guard the V36 test keeps for tracks.source: a later edit to
    // V48 that smuggles in (or drops) a column surfaces here.
    const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).sort();
    const before = freshDb({ upToVersion: 47 });
    const after = freshDb({ upToVersion: 48 });
    assert.deepEqual(
      cols(after, 'tracks').filter(c => !cols(before, 'tracks').includes(c)),
      ['album_art_pinned', 'album_art_source']
    );
    assert.deepEqual(
      cols(after, 'albums').filter(c => !cols(before, 'albums').includes(c)),
      ['album_art_pinned', 'album_art_source']
    );
    assert.deepEqual(
      cols(after, 'artists').filter(c => !cols(before, 'artists').includes(c)),
      ['image_file', 'image_pinned', 'image_source']
    );
    before.close(); after.close();
  });
});

// ── Upgrade seed ────────────────────────────────────────────────────────────

describe('V48 upgrade seed from single-art', () => {
  test('one deduped art_files row per distinct cover; junctions link every owner', () => {
    const db = freshDb({ upToVersion: 47 });
    const fx = buildV47Fixture(db);
    finishMigrations(db);

    // 4 distinct covers in use → 4 cached rows: no duplicate for the
    // album-shared one, the album-only cover seeds via the UNION's albums
    // branch, and t7's '' junk value seeds NOTHING.
    const files = plain(db.prepare("SELECT kind, cache_file FROM art_files ORDER BY cache_file").all());
    assert.deepEqual(files, [
      { kind: 'cached', cache_file: 'albumonly.jpg' },
      { kind: 'cached', cache_file: 'loose.jpg' },
      { kind: 'cached', cache_file: 'own.jpg' },
      { kind: 'cached', cache_file: 'shared.jpg' },
    ]);

    // Every track with a real cover got exactly one link; artless t4/t6
    // and ''-junk t7 got none.
    const trackLinks = plain(db.prepare(`
      SELECT t.title, af.cache_file, ta.source, ta.picture_type, ta.position
        FROM track_art ta
        JOIN tracks t ON t.id = ta.track_id
        JOIN art_files af ON af.id = ta.art_id
       ORDER BY t.title
    `).all());
    assert.deepEqual(trackLinks, [
      { title: 'T1', cache_file: 'shared.jpg', source: null, picture_type: null, position: 0 },
      { title: 'T2', cache_file: 'shared.jpg', source: null, picture_type: null, position: 0 },
      { title: 'T3', cache_file: 'own.jpg',    source: null, picture_type: null, position: 0 },
      { title: 'T5', cache_file: 'loose.jpg',  source: null, picture_type: null, position: 0 },
    ]);

    // Every album links its cover — including album3, whose cover no
    // track carries. Artists are untouched.
    const albumLinks = plain(db.prepare(`
      SELECT al.name, af.cache_file FROM album_art aa
        JOIN albums al ON al.id = aa.album_id
        JOIN art_files af ON af.id = aa.art_id
       ORDER BY al.name
    `).all());
    assert.deepEqual(albumLinks, [
      { name: 'Album One', cache_file: 'shared.jpg' },
      { name: 'Album Three', cache_file: 'albumonly.jpg' },
      { name: 'Album Two', cache_file: 'own.jpg' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artist_art').get().n, 0);
    assert.deepEqual(
      { ...db.prepare('SELECT image_file, image_source, image_pinned FROM artists WHERE id = ?').get(fx.artistA) },
      { image_file: null, image_source: null, image_pinned: 0 }
    );

    // The denormalized default pointers are untouched by the seed.
    assert.equal(db.prepare('SELECT album_art_file FROM tracks WHERE id = ?').get(fx.t1).album_art_file, 'shared.jpg');
    assert.equal(db.prepare('SELECT album_art_pinned FROM tracks WHERE id = ?').get(fx.t1).album_art_pinned, 0);
    db.close();
  });
});

// ── Dedup indexes ───────────────────────────────────────────────────────────

describe('V48 art_files dedup indexes', () => {
  test('cached rows dedup by cache_file; reference rows by (library_id, rel_path); kinds never collide', () => {
    const db = freshDb();
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L', '/l')").run().lastInsertRowid);

    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'x.jpg')").run();
    // Same cache_file again → partial UNIQUE rejects; OR IGNORE no-ops.
    const dup = db.prepare("INSERT OR IGNORE INTO art_files (kind, cache_file) VALUES ('cached', 'x.jpg')").run();
    assert.equal(Number(dup.changes), 0);
    assert.throws(
      () => db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'x.jpg')").run(),
      /UNIQUE/
    );

    db.prepare("INSERT INTO art_files (kind, library_id, rel_path) VALUES ('reference', ?, 'a/x.jpg')").run(libId);
    const dupRef = db.prepare("INSERT OR IGNORE INTO art_files (kind, library_id, rel_path) VALUES ('reference', ?, 'a/x.jpg')").run(libId);
    assert.equal(Number(dupRef.changes), 0);
    // Same rel_path in a DIFFERENT library is a different image.
    const lib2 = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L2', '/l2')").run().lastInsertRowid);
    db.prepare("INSERT INTO art_files (kind, library_id, rel_path) VALUES ('reference', ?, 'a/x.jpg')").run(lib2);

    // The partial indexes don't cross kinds: a reference row leaves
    // cache_file NULL and a cached row leaves library_id/rel_path NULL,
    // and neither collides with the other.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 3);

    // Probe the partiality itself: a non-'cached' row carrying a
    // colliding cache_file is OUTSIDE idx_art_files_cache's WHERE clause,
    // so it does not trip the UNIQUE — proving the index really is
    // kind-scoped (a plain UNIQUE on cache_file would throw here).
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('reference', 'x.jpg')").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files').get().n, 4);
    db.close();
  });

  test('junction PK rejects duplicate (owner, art) pairs; OR IGNORE no-ops', () => {
    // The dedup contract the scanner PR's INSERT OR IGNORE relies on.
    const db = freshDb();
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L', '/l')").run().lastInsertRowid);
    const trackId = Number(db.prepare("INSERT INTO tracks (filepath, library_id, title) VALUES ('a.mp3', ?, 'T')").run(libId).lastInsertRowid);
    const artId = Number(db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'c.jpg')").run().lastInsertRowid);
    db.prepare('INSERT INTO track_art (track_id, art_id, position) VALUES (?, ?, 0)').run(trackId, artId);
    assert.throws(
      () => db.prepare('INSERT INTO track_art (track_id, art_id, position) VALUES (?, ?, 5)').run(trackId, artId),
      /UNIQUE|PRIMARY/
    );
    const ignored = db.prepare('INSERT OR IGNORE INTO track_art (track_id, art_id, position) VALUES (?, ?, 5)').run(trackId, artId);
    assert.equal(Number(ignored.changes), 0);
    // The original link (and its position) survives untouched.
    assert.equal(db.prepare('SELECT position FROM track_art WHERE track_id = ? AND art_id = ?').get(trackId, artId).position, 0);
    db.close();
  });
});

// ── CASCADE topology ────────────────────────────────────────────────────────

describe('V48 cascade topology', () => {
  // One fixture, four deletion angles. Junction rows must follow their
  // owner row AND their art row; reference art_files must follow their
  // library. (All three writers run PRAGMA foreign_keys = ON — manager.js,
  // scanner.mjs, rust-parser — so CASCADE is live in production.)
  function buildArtFixture(db) {
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L', '/l')").run().lastInsertRowid);
    const artistId = Number(db.prepare("INSERT INTO artists (name) VALUES ('A')").run().lastInsertRowid);
    const albumId = Number(db.prepare("INSERT INTO albums (name, artist_id) VALUES ('Al', ?)").run(artistId).lastInsertRowid);
    const trackId = Number(db.prepare("INSERT INTO tracks (filepath, library_id, title, artist_id, album_id) VALUES ('a/t.mp3', ?, 'T', ?, ?)").run(libId, artistId, albumId).lastInsertRowid);
    const cached = Number(db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'c.jpg')").run().lastInsertRowid);
    const ref = Number(db.prepare("INSERT INTO art_files (kind, library_id, rel_path) VALUES ('reference', ?, 'a/cover.jpg')").run(libId).lastInsertRowid);
    db.prepare('INSERT INTO track_art (track_id, art_id, position) VALUES (?, ?, 0)').run(trackId, cached);
    db.prepare('INSERT INTO track_art (track_id, art_id, position) VALUES (?, ?, 1)').run(trackId, ref);
    db.prepare('INSERT INTO album_art (album_id, art_id, position) VALUES (?, ?, 0)').run(albumId, cached);
    db.prepare('INSERT INTO artist_art (artist_id, art_id, position) VALUES (?, ?, 0)').run(artistId, ref);
    return { libId, artistId, albumId, trackId, cached, ref };
  }
  const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  test('deleting a track removes its track_art links only', () => {
    const db = freshDb();
    const fx = buildArtFixture(db);
    db.prepare('DELETE FROM tracks WHERE id = ?').run(fx.trackId);
    assert.equal(count(db, 'track_art'), 0);
    assert.equal(count(db, 'album_art'), 1, 'album link survives');
    assert.equal(count(db, 'artist_art'), 1, 'artist link survives');
    assert.equal(count(db, 'art_files'), 2, 'art rows themselves survive (orphan reaping is a separate concern)');
    db.close();
  });

  test('deleting an art_files row removes every junction link to it', () => {
    const db = freshDb();
    const fx = buildArtFixture(db);
    db.prepare('DELETE FROM art_files WHERE id = ?').run(fx.ref);
    assert.equal(count(db, 'track_art'), 1, 'only the cached link remains');
    assert.equal(count(db, 'artist_art'), 0);
    assert.equal(count(db, 'album_art'), 1);
    db.close();
  });

  test('deleting an album / artist removes its junction links', () => {
    const db = freshDb();
    const fx = buildArtFixture(db);
    // Track references both rows via FK — remove it first so the album
    // and artist deletes are legal in this synthetic fixture.
    db.prepare('DELETE FROM tracks WHERE id = ?').run(fx.trackId);
    db.prepare('DELETE FROM albums WHERE id = ?').run(fx.albumId);
    db.prepare('DELETE FROM artists WHERE id = ?').run(fx.artistId);
    assert.equal(count(db, 'album_art'), 0);
    assert.equal(count(db, 'artist_art'), 0);
    db.close();
  });

  test('deleting a library cascades its reference art (and their links); cached art survives', () => {
    const db = freshDb();
    const fx = buildArtFixture(db);
    db.prepare('DELETE FROM libraries WHERE id = ?').run(fx.libId);
    const kinds = db.prepare('SELECT kind FROM art_files ORDER BY kind').all().map(r => r.kind);
    assert.deepEqual(kinds, ['cached'], 'reference rows follow their library; cached rows are library-independent');
    // The track went with the library; every junction row pointing at
    // either the track or the deleted reference art is gone too.
    assert.equal(count(db, 'track_art'), 0);
    assert.equal(count(db, 'artist_art'), 0);
    db.close();
  });
});
