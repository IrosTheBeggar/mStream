/**
 * Model-genre sync tests — V79 provenance columns + the reconcile in
 * src/db/genre-sync.js that feeds discovery_tracks.genre_tags into the
 * real genre tables as source='model' rows.
 *
 * Uses the injectable core (reconcileModelGenres) against a fresh
 * in-memory mstream.db (full migrations) and a temp-file discovery.db, so
 * no server boot and no manager singletons for the main side. Covers:
 *
 *   - V79 shape: track_genres.source default 'tag', genres.parent.
 *   - parseGenreTags: two-level split, dedup, junk hardening.
 *   - linking both hierarchy levels; duplicate files sharing one hash.
 *   - case-insensitive genre reuse + parent backfill (never overwrite).
 *   - 'tag' wins on collision; sync only deletes rows it owns.
 *   - idempotence; stale-link removal when predictions change; healing
 *     after a scanner-style track_genres wipe.
 *   - inactive-model rows / unknown hashes / malformed JSON are skipped.
 *   - modelGenresMode 'untagged' (the default): tagged tracks get no model
 *     links and lose old ones; 'all' links every track; removeModelGenres.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import { parseGenreTags, reconcileModelGenres, removeModelGenres } from '../../src/db/genre-sync.js';
import { initDiscoveryDb, closeDiscoveryDb } from '../../src/db/discovery-db.js';

const MODEL = 'test-model';
const EMB = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

let tmpDir;
let ddb;

function freshMain() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db);
  db.exec(`
    INSERT INTO libraries (id, name, root_path) VALUES (1, 'music', '/music');
    INSERT INTO tracks (id, filepath, library_id, title, audio_hash, file_hash) VALUES
      (100, 'a/one.mp3',  1, 'One',       'h1', 'f1'),
      (101, 'a/two.mp3',  1, 'Two',       NULL, 'h2'),
      (102, 'a/copy.mp3', 1, 'One Copy',  'h1', 'f3'),
      (103, 'a/four.mp3', 1, 'Four',      'h4', 'f4');
  `);
  return db;
}

let seq = 0;
function seedDiscoveryRow(hash, genreTags, modelId = MODEL) {
  ddb.prepare(`
    INSERT INTO discovery_tracks
      (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
    VALUES (?, ?, ?, 'Artist', 'Title', 120, ?, '1', ?, ?)
  `).run(hash, ++seq, `anon:${hash}:${seq}`, modelId,
    EMB, genreTags === null ? null : JSON.stringify(genreTags));
}

function modelLinks(db, trackId) {
  return db.prepare(`
    SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
    WHERE tg.track_id = ? AND tg.source = 'model' ORDER BY g.name
  `).all(trackId).map((r) => r.name);
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-genre-sync-'));
  ddb = initDiscoveryDb(path.join(tmpDir, 'discovery.db'));
});

after(() => {
  closeDiscoveryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  ddb.exec('DELETE FROM discovery_tracks');
});

// ── V79 schema shape ────────────────────────────────────────────────────────

describe('V79 schema shape', () => {
  test('SCHEMA_VERSION covers V79 and the migration is registered', () => {
    assert.ok(SCHEMA_VERSION >= 79, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
    const v79 = MIGRATIONS.find((m) => m.version === 79);
    assert.ok(v79, 'missing v79 migration');
    assert.match(v79.sql, /ALTER TABLE track_genres ADD COLUMN source/i);
    assert.ok(!v79.rescanRequired, 'pure column adds — no rescan');
  });

  test('track_genres.source defaults to tag; genres.parent exists', () => {
    const db = freshMain();
    db.exec(`
      INSERT INTO genres (name) VALUES ('Rock');
      INSERT INTO track_genres (track_id, genre_id) VALUES (100, 1);
    `);
    const link = db.prepare('SELECT source FROM track_genres WHERE track_id = 100').get();
    assert.equal(link.source, 'tag', 'scanner-style inserts land as tag-sourced');
    const g = db.prepare('SELECT parent FROM genres WHERE name = ?').get('Rock');
    assert.equal(g.parent, null);
    db.close();
  });
});

// ── parseGenreTags ──────────────────────────────────────────────────────────

describe('parseGenreTags', () => {
  test('splits Genre---Style into both levels with parent linkage', () => {
    assert.deepEqual(parseGenreTags('["Electronic---Synthwave"]'), [
      { name: 'Synthwave', parent: 'Electronic' },
      { name: 'Electronic', parent: null },
    ]);
  });

  test('dedups shared parents and repeated styles case-insensitively', () => {
    const out = parseGenreTags('["Electronic---Synthwave", "Electronic---Chillwave", "electronic---SYNTHWAVE"]');
    assert.deepEqual(out.map((e) => e.name).sort(), ['Chillwave', 'Electronic', 'Synthwave']);
  });

  test('single-level tags pass through with no parent', () => {
    assert.deepEqual(parseGenreTags('["Ambient"]'), [{ name: 'Ambient', parent: null }]);
  });

  test('junk is skipped or rejected: non-strings, blanks, malformed JSON', () => {
    assert.deepEqual(parseGenreTags('[42, "  ", "Rock", null]'), [{ name: 'Rock', parent: null }]);
    assert.equal(parseGenreTags('{"not":"array"}'), null);
    assert.equal(parseGenreTags('not json'), null);
  });
});

// ── reconcile core ──────────────────────────────────────────────────────────

describe('reconcileModelGenres', () => {
  test('links both levels for every track sharing the canonical hash', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    const stats = reconcileModelGenres(db, ddb, MODEL);

    assert.deepEqual(modelLinks(db, 100), ['Electronic', 'Synthwave']);
    assert.deepEqual(modelLinks(db, 102), ['Electronic', 'Synthwave'], 'duplicate file gets the same links');
    assert.deepEqual(modelLinks(db, 103), [], 'unrelated track untouched');
    const style = db.prepare('SELECT parent FROM genres WHERE name = ?').get('Synthwave');
    assert.equal(style.parent, 'Electronic');
    assert.equal(stats.genresCreated, 2);
    assert.equal(stats.linksAdded, 4);
    db.close();
  });

  test('file_hash fallback resolves tracks with no audio_hash', () => {
    const db = freshMain();
    seedDiscoveryRow('h2', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 101), ['Ambient']);
    db.close();
  });

  test('reuses existing genre rows case-insensitively and backfills parent', () => {
    const db = freshMain();
    db.exec("INSERT INTO genres (name) VALUES ('electronic')");
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    const stats = reconcileModelGenres(db, ddb, MODEL);

    assert.equal(stats.genresCreated, 1, 'only Synthwave is new');
    const rows = db.prepare("SELECT name, parent FROM genres WHERE name COLLATE NOCASE = 'electronic'").all();
    assert.equal(rows.length, 1, 'no duplicate case-variant row');
    db.close();
  });

  test('never overwrites an existing non-NULL parent', () => {
    const db = freshMain();
    db.exec("INSERT INTO genres (name, parent) VALUES ('Synthwave', 'Electro')");
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL);
    const g = db.prepare("SELECT parent FROM genres WHERE name = 'Synthwave'").get();
    assert.equal(g.parent, 'Electro', 'first-seen parent is kept');
    db.close();
  });

  test("tag wins on collision — the pair keeps source='tag' ('all' mode)", () => {
    const db = freshMain();
    db.exec(`
      INSERT INTO genres (name) VALUES ('Synthwave');
      INSERT INTO track_genres (track_id, genre_id, source) VALUES (100, 1, 'tag');
    `);
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL, { mode: 'all' });

    const link = db.prepare(
      'SELECT source FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = 100 AND g.name = ?'
    ).get('Synthwave');
    assert.equal(link.source, 'tag');
    db.close();
  });

  test('idempotent: a second run makes zero changes', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL);
    const stats = reconcileModelGenres(db, ddb, MODEL);
    assert.equal(stats.linksAdded, 0);
    assert.equal(stats.linksRemoved, 0);
    assert.equal(stats.genresCreated, 0);
    db.close();
  });

  test("removes stale model links when predictions change, keeps tag links ('all' mode)", () => {
    const db = freshMain();
    db.exec(`
      INSERT INTO genres (name) VALUES ('Rock');
      INSERT INTO track_genres (track_id, genre_id, source) VALUES (100, 1, 'tag');
    `);
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL, { mode: 'all' });

    ddb.exec('DELETE FROM discovery_tracks');
    seedDiscoveryRow('h1', ['Electronic---Chillwave']);
    const stats = reconcileModelGenres(db, ddb, MODEL, { mode: 'all' });

    assert.deepEqual(modelLinks(db, 100), ['Chillwave', 'Electronic']);
    assert.ok(stats.linksRemoved >= 1, 'Synthwave link dropped');
    const tagLink = db.prepare(
      "SELECT COUNT(*) AS n FROM track_genres WHERE track_id = 100 AND source = 'tag'"
    ).get();
    assert.equal(tagLink.n, 1, 'tag-sourced Rock link untouched');
    db.close();
  });

  test('heals a scanner-style track_genres wipe', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL);
    db.exec('DELETE FROM track_genres');   // what deleteTrackGenres does per re-parsed track
    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), ['Electronic', 'Synthwave']);
    db.close();
  });

  test('an empty prediction list clears the model links it owns', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), ['Ambient']);

    ddb.exec('DELETE FROM discovery_tracks');
    seedDiscoveryRow('h1', []);
    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), []);
    db.close();
  });

  test('rows pinned to another model are ignored (mid-migration stability)', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL);

    // The active model flips; h1's row now belongs to the OLD pin. Its
    // links must neither update nor be torn down until re-embedding lands.
    const stats = reconcileModelGenres(db, ddb, 'other-model');
    assert.equal(stats.rows, 0);
    assert.deepEqual(modelLinks(db, 100), ['Ambient'], 'links stay until the new pin covers the track');
    db.close();
  });

  test('unknown hashes and malformed payloads are skipped without damage', () => {
    const db = freshMain();
    seedDiscoveryRow('gone-from-library', ['Ambient']);
    ddb.prepare(`
      INSERT INTO discovery_tracks
        (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding, genre_tags)
      VALUES ('h1', ?, 'anon:h1:bad', 'A', 'T', 120, ?, '1', ?, 'not valid json')
    `).run(++seq, MODEL, EMB);
    seedDiscoveryRow('h4', ['Rock']);

    const stats = reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 103), ['Rock'], 'healthy rows still process');
    assert.deepEqual(modelLinks(db, 100), [], 'malformed row leaves its tracks alone');
    assert.equal(stats.rows, 1, 'only the healthy, mapped row counts');
    db.close();
  });
});

// ── which tracks: modelGenresMode ───────────────────────────────────────────

describe("modelGenresMode 'untagged' (the default)", () => {
  // Track 100 and 102 are two files of one song (hash h1).
  function tagRock(db, ...trackIds) {
    db.exec("INSERT INTO genres (name) VALUES ('Rock')");
    const gid = db.prepare("SELECT id FROM genres WHERE name = 'Rock'").get().id;
    for (const id of trackIds) {
      db.prepare("INSERT INTO track_genres (track_id, genre_id, source) VALUES (?, ?, 'tag')").run(id, gid);
    }
  }

  test('a tagged file gets no model links; its untagged copy does', () => {
    const db = freshMain();
    tagRock(db, 100);
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL);

    assert.deepEqual(modelLinks(db, 100), []);
    assert.deepEqual(modelLinks(db, 102), ['Electronic', 'Synthwave']);
    db.close();
  });

  test('creates no genre row when every file of the song is tagged', () => {
    const db = freshMain();
    tagRock(db, 100, 102);
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    const stats = reconcileModelGenres(db, ddb, MODEL);

    assert.equal(stats.genresCreated, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM genres WHERE name = 'Synthwave'").get().n, 0);
    db.close();
  });

  test('a file tagged after the model filled it loses its model links', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), ['Ambient']);

    tagRock(db, 100);
    const stats = reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), []);
    assert.deepEqual(modelLinks(db, 102), ['Ambient'], 'the untagged copy keeps its link');
    assert.equal(stats.linksRemoved, 1);
    db.close();
  });

  test('the purge runs even when no discovery row is under the active model', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL);

    tagRock(db, 100);
    reconcileModelGenres(db, ddb, 'other-model');
    assert.deepEqual(modelLinks(db, 100), [], 'tagged: removed');
    assert.deepEqual(modelLinks(db, 102), ['Ambient'], 'untagged: left for the new pin');
    db.close();
  });

  test("switching from 'all' keeps model links only on untagged files", () => {
    const db = freshMain();
    tagRock(db, 100);
    seedDiscoveryRow('h1', ['Electronic---Synthwave']);
    reconcileModelGenres(db, ddb, MODEL, { mode: 'all' });
    assert.deepEqual(modelLinks(db, 100), ['Electronic', 'Synthwave']);

    reconcileModelGenres(db, ddb, MODEL);
    assert.deepEqual(modelLinks(db, 100), []);
    assert.deepEqual(modelLinks(db, 102), ['Electronic', 'Synthwave']);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM track_genres WHERE track_id = 100 AND source = 'tag'").get().n, 1,
      'the tag link stays');
    db.close();
  });

  test('removeModelGenres drops model links only', () => {
    const db = freshMain();
    tagRock(db, 100);
    seedDiscoveryRow('h1', ['Ambient']);
    reconcileModelGenres(db, ddb, MODEL, { mode: 'all' });

    assert.equal(removeModelGenres(db), 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM track_genres WHERE source = 'model'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM track_genres WHERE source = 'tag'").get().n, 1);
    assert.equal(removeModelGenres(db), 0, 'nothing left to remove');
    db.close();
  });
});
