/**
 * V53 lyrics tests: tracks.lyrics_source provenance + the lyrics column
 * on fts_tracks.
 *
 * Three angles:
 *   1. Schema shape after all migrations (column + recreated triggers).
 *   2. Backfill correctness on an upgrade from v52 (lyrics_source derived
 *      from the existing V19 lyrics columns; fts_tracks.lyrics repopulated
 *      via COALESCE; the other FTS columns survive the table rebuild).
 *   3. Steady-state triggers keep fts_tracks.lyrics in sync on
 *      insert/update, with embedded-over-synced COALESCE precedence.
 *
 * Same strategy as db-fts5-backfill.test.mjs: stop the runner at the
 * version before the one under test, seed deterministic fixture data,
 * then apply the target migration in isolation and inspect the result.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function freshDbAllMigrations() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  return db;
}

function getV53() {
  const v53 = MIGRATIONS.find(m => m.version === 53);
  if (!v53) throw new Error('V53 migration not found');
  return v53;
}

// Seed a library + artist + album on a db migrated up to v52, returning ids.
function seedV52(db) {
  const libId = Number(db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music').lastInsertRowid);
  const artistId = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run('John Lennon').lastInsertRowid);
  const albumId = Number(db.prepare('INSERT INTO albums (name, artist_id, year) VALUES (?, ?, ?)').run('Imagine', artistId, 1971).lastInsertRowid);
  return { libId, artistId, albumId };
}

describe('V53 schema shape', () => {
  test('SCHEMA_VERSION is 53 and is the last migration', () => {
    assert.equal(SCHEMA_VERSION, 53);
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1].version, 53);
  });

  test('tracks gains a lyrics_source column', () => {
    const db = freshDbAllMigrations();
    const cols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
    assert.ok(cols.includes('lyrics_source'), 'tracks.lyrics_source missing');
    db.close();
  });

  test('fts_tracks gains a lyrics column (5 columns total)', () => {
    const db = freshDbAllMigrations();
    const cols = db.prepare('PRAGMA table_info(fts_tracks)').all().map(c => c.name);
    assert.deepEqual(cols, ['title', 'artist_name', 'album_name', 'filepath', 'lyrics']);
    db.close();
  });

  test('all nine FTS sync triggers still exist after the rebuild', () => {
    const db = freshDbAllMigrations();
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_fts' ORDER BY name"
    ).all().map(r => r.name);
    assert.deepEqual(triggers, [
      'albums_ad_fts', 'albums_ai_fts', 'albums_au_fts',
      'artists_ad_fts', 'artists_ai_fts', 'artists_au_fts',
      'tracks_ad_fts', 'tracks_ai_fts', 'tracks_au_fts',
    ]);
    db.close();
  });

  test('tracks_au_fts watches the lyrics columns in its UPDATE OF allowlist', () => {
    const db = freshDbAllMigrations();
    const sql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tracks_au_fts'"
    ).get().sql;
    assert.match(sql, /UPDATE OF title, artist_id, album_id, filepath, lyrics_embedded, lyrics_synced_lrc/i);
    db.close();
  });
});

describe('V53 lyrics_source backfill (upgrade from v52)', () => {
  function seedAndUpgrade() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyAllMigrations(db, { upToVersion: 52 });
    const { libId, artistId, albumId } = seedV52(db);

    const ins = db.prepare(
      `INSERT INTO tracks (filepath, library_id, title, artist_id, album_id,
         lyrics_embedded, lyrics_synced_lrc, lyrics_sidecar_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // A: plain embedded only.
    const aId = Number(ins.run('a.flac', libId, 'Imagine', artistId, albumId,
      'imagine all the people living life in peace', null, null).lastInsertRowid);
    // B: synced-only tag (no sidecar mtime).
    const bId = Number(ins.run('b.flac', libId, 'Mind Games', artistId, albumId,
      null, '[00:12.00]love is the answer and you know that for sure', null).lastInsertRowid);
    // C: sidecar (synced text + a sidecar mtime).
    const cId = Number(ins.run('c.flac', libId, 'Jealous Guy', artistId, albumId,
      null, '[00:05.00]i was dreaming of the past', 1700000000000).lastInsertRowid);
    // D: no lyrics at all.
    const dId = Number(ins.run('d.flac', libId, 'Instrumental', artistId, albumId,
      null, null, null).lastInsertRowid);

    const v53 = getV53();
    db.exec('BEGIN'); db.exec(v53.sql); db.exec('PRAGMA user_version = 53'); db.exec('COMMIT');
    return { db, aId, bId, cId, dId };
  }

  test('lyrics_source is derived: embedded / sidecar / NULL', () => {
    const { db, aId, bId, cId, dId } = seedAndUpgrade();
    const src = id => db.prepare('SELECT lyrics_source FROM tracks WHERE id = ?').get(id).lyrics_source;
    assert.equal(src(aId), 'embedded', 'plain embedded → embedded');
    assert.equal(src(bId), 'embedded', 'synced tag (no sidecar) → embedded');
    assert.equal(src(cId), 'sidecar', 'sidecar mtime present → sidecar');
    assert.equal(src(dId), null, 'no lyrics → NULL');
    db.close();
  });

  test('fts_tracks.lyrics is repopulated via COALESCE(embedded, synced)', () => {
    const { db, aId, bId, dId } = seedAndUpgrade();
    const lyr = id => db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics;
    assert.match(lyr(aId), /imagine all the people/);
    assert.match(lyr(bId), /love is the answer/, 'synced text falls through COALESCE');
    assert.equal(lyr(dId), null, 'lyric-less track has NULL lyrics in the index');
    db.close();
  });

  test('lyrics are searchable after the upgrade, and existing columns survive the rebuild', () => {
    const { db, aId } = seedAndUpgrade();
    // A lyric word that appears in no title/artist/album.
    const lyricHits = db.prepare("SELECT rowid FROM fts_tracks WHERE fts_tracks MATCH 'peace'").all();
    assert.equal(lyricHits.length, 1);
    assert.equal(lyricHits[0].rowid, aId);
    // The rebuild preserved the denormalised artist_name (search still works).
    const artistHits = db.prepare("SELECT COUNT(*) AS c FROM fts_tracks WHERE fts_tracks MATCH 'lennon'").get().c;
    assert.equal(artistHits, 4, 'all four seeded tracks still searchable by artist');
    db.close();
  });
});

describe('V53 fts_tracks lyrics triggers (steady state)', () => {
  function seedTrack(db, { embedded = null, synced = null } = {}) {
    const libId = Number(db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music').lastInsertRowid);
    return Number(db.prepare(
      `INSERT INTO tracks (filepath, library_id, title, lyrics_embedded, lyrics_synced_lrc)
       VALUES (?, ?, ?, ?, ?)`
    ).run('t.flac', libId, 'Track', embedded, synced).lastInsertRowid);
  }

  test('insert trigger indexes lyrics; track is matchable by a lyric word', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { embedded: 'here comes the sunshine after the rain' });
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /sunshine/);
    const hits = db.prepare("SELECT rowid FROM fts_tracks WHERE fts_tracks MATCH 'sunshine'").all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rowid, id);
    db.close();
  });

  test('updating lyrics_embedded reindexes (old text no longer matches)', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { embedded: 'first version of the words' });
    db.prepare('UPDATE tracks SET lyrics_embedded = ? WHERE id = ?').run('totally different replacement text', id);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM fts_tracks WHERE fts_tracks MATCH 'first'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM fts_tracks WHERE fts_tracks MATCH 'replacement'").get().c, 1);
    db.close();
  });

  test('COALESCE precedence: embedded wins; clearing it surfaces the synced text', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { embedded: 'plainword here', synced: '[00:01.00]syncedword here' });
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /plainword/);
    db.prepare('UPDATE tracks SET lyrics_embedded = NULL WHERE id = ?').run(id);
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /syncedword/);
    db.close();
  });

  test('a non-allowlisted column update does not disturb the indexed lyrics', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { embedded: 'stable lyric content' });
    db.prepare('UPDATE tracks SET year = ? WHERE id = ?').run(1999, id);
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /stable lyric content/);
    db.close();
  });
});
