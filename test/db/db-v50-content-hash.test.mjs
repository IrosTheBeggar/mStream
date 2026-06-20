/**
 * V50 migration tests: art_files.content_hash.
 *
 * V50 adds the image-identity column (lowercase MD5 hex of the image
 * bytes) + a plain lookup index. Cached rows are backfilled in SQL from
 * their content-addressed filename stem (the cache IS named by the same
 * MD5); reference rows start NULL and the scanners hash them on the
 * forced rescan (rescanRequired).
 *
 * Forward-only — same convention as V1-V49.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function freshDb({ upToVersion } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, upToVersion ? { upToVersion } : {});
  return db;
}

function finishMigrations(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= current) { continue; }
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}

describe('V50 schema shape', () => {
  test('MIGRATIONS contains v50, rescanRequired (reference hashes need the forced rescan)', () => {
    const v50 = MIGRATIONS.find(m => m.version === 50);
    assert.ok(v50, 'missing v50 migration');
    assert.match(v50.sql, /ADD COLUMN content_hash/);
    assert.equal(v50.rescanRequired, true);
    assert.ok(SCHEMA_VERSION >= 50, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  });

  test('column + lookup index exist after the chain', () => {
    const db = freshDb();
    const col = db.prepare('PRAGMA table_info(art_files)').all().find(c => c.name === 'content_hash');
    assert.ok(col && col.type.toUpperCase() === 'TEXT' && col.notnull === 0, 'content_hash TEXT NULL');
    const idx = db.prepare("PRAGMA index_list(art_files)").all().map(i => i.name);
    assert.ok(idx.includes('idx_art_files_hash'), 'lookup index present');
    db.close();
  });
});

describe('V50 backfill from cache filenames', () => {
  test('cached rows get their filename stem (lowercased); references and junk stay NULL', () => {
    const db = freshDb({ upToVersion: 49 });
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L', '/l')").run().lastInsertRowid);
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'abc123def.jpeg')").run();
    // Mixed-case stem — the backfill lowercases (cache names are written
    // lowercase by the scanners, but a decade of DBs can carry drift).
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'ABC999.jpg')").run();
    // No extension dot → unparseable → left NULL (fail open).
    db.prepare("INSERT INTO art_files (kind, cache_file) VALUES ('cached', 'no-extension')").run();
    db.prepare("INSERT INTO art_files (kind, library_id, rel_path) VALUES ('reference', ?, 'a/cover.jpg')").run(libId);
    finishMigrations(db);

    const rows = db.prepare(
      'SELECT kind, cache_file, rel_path, content_hash FROM art_files ORDER BY id').all().map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { kind: 'cached', cache_file: 'abc123def.jpeg', rel_path: null, content_hash: 'abc123def' },
      { kind: 'cached', cache_file: 'ABC999.jpg', rel_path: null, content_hash: 'abc999' },
      { kind: 'cached', cache_file: 'no-extension', rel_path: null, content_hash: null },
      { kind: 'reference', cache_file: null, rel_path: 'a/cover.jpg', content_hash: null },
    ]);
    db.close();
  });

  test('the downloader probe: equality lookup over the index finds both identities', () => {
    const db = freshDb();
    const libId = Number(db.prepare("INSERT INTO libraries (name, root_path) VALUES ('L', '/l')").run().lastInsertRowid);
    const h = 'd41d8cd98f00b204e9800998ecf8427e';
    db.prepare("INSERT INTO art_files (kind, cache_file, content_hash) VALUES ('cached', ?, ?)").run(`${h}.jpg`, h);
    db.prepare("INSERT INTO art_files (kind, library_id, rel_path, content_hash) VALUES ('reference', ?, 'a/x.jpg', ?)").run(libId, h);
    // The same content as two identities is LEGAL (non-unique index) and
    // exactly what the gallery dedupe / downloader probe joins on.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM art_files WHERE content_hash = ?').get(h).n, 2);
    db.close();
  });
});
