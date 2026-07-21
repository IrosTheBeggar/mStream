/**
 * V59 tests: tracks.lyrics_search_text + the re-pointed fts_tracks.lyrics.
 *
 * V53 indexed COALESCE(lyrics_embedded, lyrics_synced_lrc) — raw LRC —
 * so `[mm:ss.xx]` stamp DIGITS were tokens and any 2-digit query matched
 * most synced tracks via timestamps. V59 derives the stripped
 * lyrics_search_text (via lrcToSearchText) and the index becomes
 * COALESCE(lyrics_embedded, lyrics_search_text).
 *
 * Three angles, mirroring db-fts5-lyrics.test.mjs:
 *   1. Upgrade from v58: the js hook populates lyrics_search_text for
 *      existing synced rows inside the migration, the FTS rebuild indexes
 *      it, and timestamp digits stop matching.
 *   2. Schema shape: column present, triggers recreated, allowlist grew.
 *   3. Steady-state: the writer contract — synced writes carry
 *      lyrics_search_text; the COALESCE precedence; a synced-only write
 *      without search text is (by design) not lyric-searchable.
 *
 * V59 is the first migration with a `js` hook; applying it through
 * applyAllMigrations exercises the hook the same way the manager.js
 * runner does.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { lrcToSearchText } from '../../src/api/subsonic/lrc-parser.js';

function freshDbAllMigrations() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
  applyAllMigrations(db);
  return db;
}

const TAYLOR_LRC = [
  '[ar:Header Artist]',
  '[00:22.10]I do not know about you',
  '[00:26.45]I am feeling twenty two',
].join('\n');

describe('V59 registration', () => {
  test('V59 is registered, carries the js hook, and SCHEMA_VERSION covers it', () => {
    const v59 = MIGRATIONS.find(m => m.version === 59);
    assert.ok(v59, 'V59 must be in MIGRATIONS');
    assert.equal(typeof v59.js, 'function', 'V59 must carry the js population hook');
    assert.ok(SCHEMA_VERSION >= 59);
  });
});

describe('V59 upgrade from v58 (js-hook population + FTS rebuild)', () => {
  function seedAndUpgrade() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    applyAllMigrations(db, { upToVersion: 58 });

    const libId = Number(db.prepare(
      'INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music').lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO tracks (filepath, library_id, title, lyrics_embedded, lyrics_synced_lrc, lyrics_source)
       VALUES (?, ?, ?, ?, ?, ?)`);
    // A: synced-only (sidecar-style raw LRC with stamps + a header tag).
    const syncedId = Number(ins.run('synced.flac', libId, 'TwentyTwo',
      null, TAYLOR_LRC, 'sidecar').lastInsertRowid);
    // B: provider-backfilled synced (same population path, different source).
    const lrclibId = Number(ins.run('lrclib.flac', libId, 'Backfilled',
      null, '[00:05.00]provider words here', 'lrclib').lastInsertRowid);
    // C: plain embedded only — no synced, nothing to derive.
    const plainId = Number(ins.run('plain.flac', libId, 'Plain',
      'hello darkness my old friend', null, 'embedded').lastInsertRowid);
    // D: no lyrics at all.
    const noneId = Number(ins.run('none.flac', libId, 'Instrumental',
      null, null, null).lastInsertRowid);

    // Pre-upgrade sanity: the V53-era index DOES match stamp digits —
    // the exact bug under repair.
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "22"*'`).get().c, 1,
      'pre-V59 a stamp-digit query matches (bug present)');

    applyAllMigrations(db, { fromVersion: 58 });
    return { db, syncedId, lrclibId, plainId, noneId };
  }

  test('lyrics_search_text is populated for every synced row, stripped', () => {
    const { db, syncedId, lrclibId, plainId, noneId } = seedAndUpgrade();
    const st = id => db.prepare('SELECT lyrics_search_text FROM tracks WHERE id = ?').get(id).lyrics_search_text;
    assert.equal(st(syncedId), 'I do not know about you\nI am feeling twenty two');
    assert.equal(st(syncedId), lrcToSearchText(TAYLOR_LRC),
      'population uses the same derivation as the writers');
    assert.equal(st(lrclibId), 'provider words here');
    assert.equal(st(plainId), null, 'no synced source → NULL');
    assert.equal(st(noneId), null);
    db.close();
  });

  test('stamp digits and header-tag words stop matching; lyric words still match', () => {
    const { db, syncedId } = seedAndUpgrade();
    const count = expr => db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH ?`).get(`{lyrics} : ${expr}`).c;
    assert.equal(count('"22"*'), 0, 'timestamp seconds no longer match');
    assert.equal(count('"26"*'), 0, 'nor any other stamp field');
    assert.equal(count('"header"*'), 0, '[ar:] header-tag words are not lyrics');
    assert.equal(count('"feeling"*'), 1, 'real lyric words still match');
    assert.equal(db.prepare(
      `SELECT rowid FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "feeling"*'`).get().rowid, syncedId);
    db.close();
  });

  test('embedded text still wins the COALESCE and the rebuild preserves other columns', () => {
    const { db, plainId } = seedAndUpgrade();
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(plainId).lyrics,
      /hello darkness/);
    // Titles survived the rebuild (denormalised columns re-read).
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{title} : "instrumental"*'`).get().c, 1);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    db.close();
  });
});

describe('V59 schema shape', () => {
  test('tracks gains lyrics_search_text', () => {
    const db = freshDbAllMigrations();
    const cols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
    assert.ok(cols.includes('lyrics_search_text'));
    db.close();
  });

  test('tracks_au_fts allowlist covers lyrics_search_text; index reads it via COALESCE', () => {
    const db = freshDbAllMigrations();
    const sql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tracks_au_fts'").get().sql;
    assert.match(sql, /UPDATE OF title, artist_id, album_id, filepath, lyrics_embedded, lyrics_synced_lrc, lyrics_search_text/i);
    assert.match(sql, /COALESCE\(NEW\.lyrics_embedded, NEW\.lyrics_search_text\)/i);
    db.close();
  });
});

describe('V59 steady-state writer contract', () => {
  function seedTrack(db, { embedded = null, synced = null, searchText } = {}) {
    const libId = Number(db.prepare(
      'INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music').lastInsertRowid);
    // Default mirrors the real writers: search_text derived from synced.
    const st = searchText !== undefined ? searchText : lrcToSearchText(synced);
    return Number(db.prepare(
      `INSERT INTO tracks (filepath, library_id, title, lyrics_embedded, lyrics_synced_lrc, lyrics_search_text)
       VALUES (?, ?, ?, ?, ?, ?)`).run('t.flac', libId, 'Track', embedded, synced, st).lastInsertRowid);
  }

  test('a writer-shaped synced insert is searchable by words, not stamps', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { synced: TAYLOR_LRC });
    const hits = db.prepare(
      `SELECT rowid FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "twenty"*'`).all();
    assert.deepEqual(hits.map(h => h.rowid), [id]);
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "22"*'`).get().c, 0);
    db.close();
  });

  test('COALESCE precedence: embedded wins; clearing it surfaces the search text', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { embedded: 'plainword here', synced: '[00:01.00]syncedword here' });
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /plainword/);
    db.prepare('UPDATE tracks SET lyrics_embedded = NULL WHERE id = ?').run(id);
    assert.match(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /syncedword/);
    assert.doesNotMatch(db.prepare('SELECT lyrics FROM fts_tracks WHERE rowid = ?').get(id).lyrics, /01/,
      'the surfaced value is the STRIPPED rendition');
    db.close();
  });

  test('synced without search text is not lyric-searchable (the documented contract)', () => {
    // A writer that sets lyrics_synced_lrc but not lyrics_search_text has
    // broken the SCHEMA_V59 writer contract; the failure mode is a silent
    // drop from lyric search — pinned here so it stays a KNOWN mode.
    const db = freshDbAllMigrations();
    seedTrack(db, { synced: '[00:01.00]ghostword here', searchText: null });
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "ghostword"*'`).get().c, 0);
    db.close();
  });

  test('updating lyrics_search_text alone reindexes (allowlist member)', () => {
    const db = freshDbAllMigrations();
    const id = seedTrack(db, { synced: '[00:01.00]before text' });
    db.prepare('UPDATE tracks SET lyrics_search_text = ? WHERE id = ?').run('after text', id);
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "before"*'`).get().c, 0);
    assert.equal(db.prepare(
      `SELECT count(*) AS c FROM fts_tracks WHERE fts_tracks MATCH '{lyrics} : "after"*'`).get().c, 1);
    db.close();
  });
});
