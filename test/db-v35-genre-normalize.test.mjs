/**
 * V35 migration tests — genre canonicalisation.
 *
 * V35 has two pieces, tested separately here:
 *
 *   1. The SQL migration (SCHEMA_V35) does case-fold dedup of the
 *      `genres` table. "Jazz" / "jazz" / "JAZZ" collapse to a single
 *      row, and every track_genres row that pointed at a non-canonical
 *      copy gets redirected to the surviving (lowest-id) row.
 *
 *   2. canonicaliseExistingGenres() in src/db/manager.js walks the
 *      post-migration `genres` table and applies the full canonicalisation
 *      pipeline: punctuation collapse ("Hip-Hop" → "Hip Hop"), `&`
 *      folding ("Drum & Bass" → "Drum and Bass"), and the display-form
 *      override map ("edm" → "EDM", "k-pop" → "K-Pop", "RnB" → "R&B").
 *      Idempotent: a second pass over an already-canonicalised table
 *      writes nothing.
 *
 * Also covers:
 *   - The bundled MusicBrainz JSON (data/mb-genres.json) is present
 *     and parses correctly. Without it, canonicalisation silent-degrades
 *     to "preserve user input," which would mask scanner bugs.
 *   - canonicalGenreName / normaliseForLookup behave as the algorithm
 *     described above.
 *
 * V35 is forward-only — no rollback script. The genres table is built
 * from on-disk ID3 tags at scan time, so recovery from a bad V35 is
 * `rm save/db/mstream.db && restart` (fresh rescan picks up canonical
 * forms via the scanner's findOrCreateGenre / find_or_create_genre).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';
import {
  canonicalGenreName,
  normaliseForLookup,
  _internals as genreCanonicalInternals,
} from '../src/db/genre-canonical.js';
import { canonicaliseExistingGenres } from '../src/db/manager.js';
import { applyAllMigrations } from './helpers/apply-migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seed the libraries table with a single row (id=1). Tracks have a
// NOT NULL FK on library_id, so every test that needs a track row
// needs a library to attach to.
function seedLibrary(db) {
  db.prepare('INSERT INTO libraries (name, root_path) VALUES (?, ?)').run('Music', '/music');
}

// Build a fresh in-memory DB at exactly version 34 (the schema state
// just before V35), then return it. Tests that exercise the V35 SQL
// migration in isolation seed track_genres / genres on this DB and
// then apply only the V35 SQL chunk via db.exec(...).
function dbAtV34() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db, { upToVersion: 34 });
  seedLibrary(db);
  return db;
}

// Build a fresh in-memory DB with every migration applied (i.e. V35
// SQL has already run). Use for canonicaliseExistingGenres() tests
// that just need an empty post-V35 surface to insert their own rows
// into; the SQL has nothing to do because the table is empty.
function dbAtCurrent() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(db);
  seedLibrary(db);
  return db;
}

// Seed a track row in library id=1 (created by seedLibrary). The
// scanner populates artist/album/etc. for real; tests just need a
// track id to attach genre rows to.
function seedTrack(db, filepath = 'track.mp3') {
  const result = db.prepare(
    `INSERT INTO tracks (filepath, library_id, scan_id, title) VALUES (?, 1, 1, 'Untitled')`
  ).run(filepath);
  return Number(result.lastInsertRowid);
}

function insertGenre(db, name) {
  return Number(db.prepare('INSERT INTO genres (name) VALUES (?)').run(name).lastInsertRowid);
}

function linkTrackGenre(db, trackId, genreId) {
  db.prepare('INSERT INTO track_genres (track_id, genre_id) VALUES (?, ?)').run(trackId, genreId);
}

// node:sqlite returns rows as null-prototype objects, which
// assert.deepEqual (strict mode) refuses to match against regular
// object literals. Re-wrap each row through Object.assign so the
// prototype is the default. Same pattern as test/db-fts5-triggers.test.mjs.
function plain(rows) {
  if (Array.isArray(rows)) {
    return rows.map(r => ({ ...r }));
  }
  return rows == null ? rows : { ...rows };
}

// ── Schema shape ─────────────────────────────────────────────────────────────

describe('V35 schema shape', () => {
  test('SCHEMA_VERSION is at least 35', () => {
    assert.ok(SCHEMA_VERSION >= 35, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  });

  test('MIGRATIONS contains a v35 entry with a SQL string', () => {
    const v35 = MIGRATIONS.find(m => m.version === 35);
    assert.ok(v35, 'missing v35 migration');
    assert.equal(typeof v35.sql, 'string');
    // Spot-check the SQL touches both halves of the dedup (track_genres
    // redirect AND orphan-genres delete). If someone reshapes V35 they
    // need to update this test too.
    assert.match(v35.sql, /INSERT OR IGNORE INTO track_genres/);
    assert.match(v35.sql, /DELETE FROM genres/);
  });

  test('v35 is NOT marked rescanRequired (data preserved by dedup)', () => {
    const v35 = MIGRATIONS.find(m => m.version === 35);
    assert.ok(!v35.rescanRequired, 'V35 preserves track→genre links — no rescan needed');
  });

  test('applying all migrations leaves user_version = SCHEMA_VERSION', () => {
    const db = dbAtCurrent();
    const v = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(v, SCHEMA_VERSION);
    db.close();
  });
});

// ── MB reference data ────────────────────────────────────────────────────────

describe('MusicBrainz reference data', () => {
  test('data/mb-genres.json exists and parses', () => {
    const jsonPath = path.resolve(__dirname, '..', 'data', 'mb-genres.json');
    assert.ok(fs.existsSync(jsonPath), `${jsonPath} should exist`);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(Array.isArray(parsed.genres), 'genres is an array');
    // MB had ~2,140 entries as of 2026-05. A real fetch would land in
    // the 1,500+ range; a stub / mock list would be tiny. The threshold
    // catches "someone replaced this with placeholder data."
    assert.ok(parsed.genres.length > 1000, `expected > 1000 genres, got ${parsed.genres.length}`);
  });

  test('genre-canonical.js loaded the MB list (Set is populated)', () => {
    // The module reads the JSON at module-init time. If the read failed
    // for any reason, MB_GENRES stays at size 0 and we silently degrade
    // to "preserve user input."
    assert.ok(genreCanonicalInternals.mbGenresSize() > 1000,
      `MB_GENRES Set should be populated; got ${genreCanonicalInternals.mbGenresSize()}`);
  });

  test('MB list contains common genres in their normalised form', () => {
    // Sanity check — common genres should be lookup-hits regardless of
    // their MB source spelling (hip-hop vs hip hop, etc.). The MB list
    // is normalised on load, so we query it with the normalised form.
    assert.ok(genreCanonicalInternals.hasMbGenre('jazz'),     'jazz in MB');
    assert.ok(genreCanonicalInternals.hasMbGenre('rock'),     'rock in MB');
    assert.ok(genreCanonicalInternals.hasMbGenre('hip hop'),  'hip hop in MB');
    assert.ok(genreCanonicalInternals.hasMbGenre('pop'),      'pop in MB');
  });
});

// ── normaliseForLookup ───────────────────────────────────────────────────────

describe('normaliseForLookup', () => {
  test('lowercases input', () => {
    assert.equal(normaliseForLookup('JAZZ'), 'jazz');
    assert.equal(normaliseForLookup('Hip Hop'), 'hip hop');
  });

  test('collapses hyphens and underscores to spaces', () => {
    assert.equal(normaliseForLookup('hip-hop'), 'hip hop');
    assert.equal(normaliseForLookup('drum_and_bass'), 'drum and bass');
    assert.equal(normaliseForLookup('K-Pop'), 'k pop');
  });

  test('folds & to " and "', () => {
    assert.equal(normaliseForLookup('Drum & Bass'), 'drum and bass');
    assert.equal(normaliseForLookup('R&B'), 'r and b');
  });

  test('collapses whitespace and trims', () => {
    assert.equal(normaliseForLookup('  Hip   Hop  '), 'hip hop');
    assert.equal(normaliseForLookup('\trock\n'), 'rock');
  });

  test('handles empty / null input safely', () => {
    assert.equal(normaliseForLookup(''), '');
    assert.equal(normaliseForLookup('   '), '');
    assert.equal(normaliseForLookup(null), '');
    assert.equal(normaliseForLookup(undefined), '');
  });

  test('is idempotent', () => {
    const inputs = ['Hip-Hop', 'EDM', 'R&B', '  Lo-Fi  ', 'Drum & Bass'];
    for (const s of inputs) {
      const once = normaliseForLookup(s);
      const twice = normaliseForLookup(once);
      assert.equal(twice, once, `${s} -> ${once} not idempotent`);
    }
  });
});

// ── canonicalGenreName ───────────────────────────────────────────────────────

describe('canonicalGenreName', () => {
  test('returns Title Case form for MB-known genres', () => {
    assert.equal(canonicalGenreName('Jazz'),     'Jazz');
    assert.equal(canonicalGenreName('JAZZ'),     'Jazz');
    assert.equal(canonicalGenreName('jazz'),     'Jazz');
    assert.equal(canonicalGenreName('hip hop'),  'Hip Hop');
    assert.equal(canonicalGenreName('Hip-Hop'),  'Hip Hop');
    assert.equal(canonicalGenreName('hip-hop'),  'Hip Hop');
  });

  test('applies acronym overrides regardless of input casing', () => {
    assert.equal(canonicalGenreName('EDM'), 'EDM');
    assert.equal(canonicalGenreName('edm'), 'EDM');
    assert.equal(canonicalGenreName('Edm'), 'EDM');
    assert.equal(canonicalGenreName('idm'), 'IDM');
    assert.equal(canonicalGenreName('R&B'), 'R&B');
    assert.equal(canonicalGenreName('r&b'), 'R&B');
    assert.equal(canonicalGenreName('RnB'), 'R&B');
    assert.equal(canonicalGenreName('rnb'), 'R&B');
  });

  test('applies separator overrides for K-Pop / J-Pop / Lo-Fi etc.', () => {
    assert.equal(canonicalGenreName('K-Pop'), 'K-Pop');
    assert.equal(canonicalGenreName('k pop'), 'K-Pop');
    assert.equal(canonicalGenreName('K Pop'), 'K-Pop');
    assert.equal(canonicalGenreName('j-pop'), 'J-Pop');
    assert.equal(canonicalGenreName('Lo-Fi'), 'Lo-Fi');
    assert.equal(canonicalGenreName('lo fi'), 'Lo-Fi');
  });

  test('folds & to " and " on MB matches via Drum & Bass', () => {
    // MB has "drum and bass"; folding "&" via the normaliser routes
    // both forms to the same MB hit and produces the title-cased name.
    assert.equal(canonicalGenreName('Drum & Bass'),  'Drum And Bass');
    assert.equal(canonicalGenreName('drum and bass'), 'Drum And Bass');
  });

  test('preserves user input for unknown genres', () => {
    // Made-up genres should pass through with the original casing —
    // a typo or a niche tag is better preserved than mangled.
    assert.equal(canonicalGenreName('VaporTwitch'),     'VaporTwitch');
    assert.equal(canonicalGenreName('  My-Genre  '),    'My-Genre');
  });

  test('returns null for empty / whitespace / null input', () => {
    assert.equal(canonicalGenreName(''),    null);
    assert.equal(canonicalGenreName('   '), null);
    assert.equal(canonicalGenreName(null),  null);
    assert.equal(canonicalGenreName(undefined), null);
  });

  test('is idempotent on canonical output', () => {
    // Applying canonicalGenreName twice should be a no-op — important
    // for the canonicaliseExistingGenres pass which runs on every boot.
    const inputs = ['Jazz', 'EDM', 'Hip-Hop', 'K-Pop', 'R&B', 'Lo-Fi',
                    'VaporTwitch', 'My-Genre'];
    for (const s of inputs) {
      const once = canonicalGenreName(s);
      const twice = canonicalGenreName(once);
      assert.equal(twice, once, `${s} -> ${once} not idempotent`);
    }
  });
});

// ── V35 SQL: case-fold dedup ─────────────────────────────────────────────────

describe('V35 SQL migration: case-fold dedup of genres table', () => {
  function applyV35Sql(db) {
    const v35 = MIGRATIONS.find(m => m.version === 35);
    db.exec(v35.sql);
    db.exec('PRAGMA user_version = 35');
  }

  test('collapses Jazz / jazz / JAZZ into a single row (lowest id wins)', () => {
    const db = dbAtV34();
    const trackId = seedTrack(db);

    const jazzId  = insertGenre(db, 'Jazz');
    const jazzLid = insertGenre(db, 'jazz');
    const jazzCid = insertGenre(db, 'JAZZ');
    linkTrackGenre(db, trackId, jazzId);
    linkTrackGenre(db, trackId, jazzLid);
    linkTrackGenre(db, trackId, jazzCid);

    applyV35Sql(db);

    // One genre row survives — the lowest id (Jazz).
    const survivors = db.prepare(
      `SELECT id, name FROM genres WHERE LOWER(name) = 'jazz' ORDER BY id`
    ).all();
    assert.equal(survivors.length, 1, 'one Jazz row should remain');
    assert.equal(survivors[0].id, jazzId);
    assert.equal(survivors[0].name, 'Jazz');

    // track_genres redirected — the (track, jazzId) row exists; the
    // (track, jazzLid) and (track, jazzCid) rows are gone.
    const links = db.prepare(
      'SELECT genre_id FROM track_genres WHERE track_id = ? ORDER BY genre_id'
    ).all(trackId);
    assert.deepEqual(plain(links), [{ genre_id: jazzId }]);

    db.close();
  });

  test('preserves rows that have no case-fold duplicates', () => {
    const db = dbAtV34();
    insertGenre(db, 'Rock');
    insertGenre(db, 'Pop');
    insertGenre(db, 'Hip-Hop');

    applyV35Sql(db);

    const names = db.prepare('SELECT name FROM genres ORDER BY name').all().map(r => r.name);
    // Pure case-fold dedup — punctuation differences like Hip-Hop vs
    // Hip Hop are handled by the JS pass, not the SQL. These three
    // distinct rows survive untouched.
    assert.deepEqual(names, ['Hip-Hop', 'Pop', 'Rock']);
    db.close();
  });

  test('a track tagged with BOTH variants ends up with a single link', () => {
    // Edge case: a single track has track_genres rows pointing at
    // BOTH "Jazz" and "jazz". The redirect inserts (track, jazzId) ←
    // INSERT OR IGNORE on the PK, then the orphan-row delete cleans
    // up. No PK violation, no duplicate links.
    const db = dbAtV34();
    const trackId = seedTrack(db);
    const jazzId  = insertGenre(db, 'Jazz');
    const jazzLid = insertGenre(db, 'jazz');
    linkTrackGenre(db, trackId, jazzId);
    linkTrackGenre(db, trackId, jazzLid);

    applyV35Sql(db);

    const links = db.prepare(
      'SELECT genre_id FROM track_genres WHERE track_id = ?'
    ).all(trackId);
    assert.equal(links.length, 1, 'one link survives');
    assert.equal(links[0].genre_id, jazzId);
    db.close();
  });

  test('is idempotent — a second apply is a no-op', () => {
    const db = dbAtV34();
    insertGenre(db, 'Jazz');
    insertGenre(db, 'jazz');
    applyV35Sql(db);

    const afterFirst = db.prepare('SELECT id, name FROM genres ORDER BY id').all();
    applyV35Sql(db);  // second pass
    const afterSecond = db.prepare('SELECT id, name FROM genres ORDER BY id').all();

    assert.deepEqual(plain(afterSecond), plain(afterFirst));
    db.close();
  });
});

// ── canonicaliseExistingGenres: punctuation + display-form pass ──────────────

describe('canonicaliseExistingGenres post-migration pass', () => {
  test('renames "Hip-Hop" to "Hip Hop" when no conflict exists', () => {
    const db = dbAtCurrent();
    const id = insertGenre(db, 'Hip-Hop');

    const stats = canonicaliseExistingGenres(db);
    assert.equal(stats.renamed, 1);
    assert.equal(stats.merged, 0);

    const row = db.prepare('SELECT id, name FROM genres').get();
    assert.equal(row.id, id);
    assert.equal(row.name, 'Hip Hop');
    db.close();
  });

  test('merges "Hip-Hop" into existing "Hip Hop" row when both exist', () => {
    const db = dbAtCurrent();
    const trackId = seedTrack(db);

    const hipDashId = insertGenre(db, 'Hip-Hop');
    const hipSpcId  = insertGenre(db, 'Hip Hop');
    linkTrackGenre(db, trackId, hipDashId);

    const stats = canonicaliseExistingGenres(db);
    assert.equal(stats.merged, 1);
    assert.equal(stats.renamed, 0);

    const rows = db.prepare('SELECT id, name FROM genres ORDER BY id').all();
    assert.deepEqual(plain(rows), [{ id: hipSpcId, name: 'Hip Hop' }]);

    // The track's link redirects to the surviving genre.
    const links = db.prepare('SELECT genre_id FROM track_genres WHERE track_id = ?').all(trackId);
    assert.deepEqual(plain(links), [{ genre_id: hipSpcId }]);
    db.close();
  });

  test('applies display-form overrides ("edm" → "EDM")', () => {
    const db = dbAtCurrent();
    insertGenre(db, 'edm');

    const stats = canonicaliseExistingGenres(db);
    assert.equal(stats.renamed, 1);

    const name = db.prepare('SELECT name FROM genres').get().name;
    assert.equal(name, 'EDM');
    db.close();
  });

  test('applies separator overrides ("k pop" + "K-Pop" → single "K-Pop")', () => {
    const db = dbAtCurrent();
    const trackId = seedTrack(db);
    const kSpcId  = insertGenre(db, 'k pop');
    const kDashId = insertGenre(db, 'K-Pop');
    linkTrackGenre(db, trackId, kSpcId);
    linkTrackGenre(db, trackId, kDashId);

    canonicaliseExistingGenres(db);

    // K-Pop (dash form) is the override target. The "k pop" row's
    // canonical also resolves to "K-Pop", so it merges into the dash
    // row that already exists. Only one survivor.
    const rows = db.prepare('SELECT id, name FROM genres ORDER BY id').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, kDashId);
    assert.equal(rows[0].name, 'K-Pop');

    // Track had links to both → after merge, exactly one link survives
    // pointing at the canonical row.
    const links = db.prepare('SELECT genre_id FROM track_genres WHERE track_id = ?').all(trackId);
    assert.deepEqual(plain(links), [{ genre_id: kDashId }]);
    db.close();
  });

  test('a track linked to BOTH variants ends up with one link after merge', () => {
    // The (track, hipDashId) and (track, hipSpcId) track_genres rows
    // both exist pre-pass. INSERT OR IGNORE on the (track, hipSpcId)
    // redirect is a no-op (it already exists), and CASCADE on the
    // hipDashId delete drops the (track, hipDashId) row. Net result:
    // one link to hipSpcId. Guards against future regressions where
    // someone removes the INSERT OR IGNORE and gets PK violations.
    const db = dbAtCurrent();
    const trackId = seedTrack(db);
    const hipDashId = insertGenre(db, 'Hip-Hop');
    const hipSpcId  = insertGenre(db, 'Hip Hop');
    linkTrackGenre(db, trackId, hipDashId);
    linkTrackGenre(db, trackId, hipSpcId);

    canonicaliseExistingGenres(db);

    const links = db.prepare(
      'SELECT genre_id FROM track_genres WHERE track_id = ?'
    ).all(trackId);
    assert.equal(links.length, 1);
    assert.equal(links[0].genre_id, hipSpcId);
    db.close();
  });

  test('is idempotent — a second pass writes zero rows', () => {
    const db = dbAtCurrent();
    insertGenre(db, 'Hip-Hop');
    insertGenre(db, 'edm');
    insertGenre(db, 'k-pop');

    canonicaliseExistingGenres(db);
    const after1 = db.prepare('SELECT id, name FROM genres ORDER BY id').all();

    const stats2 = canonicaliseExistingGenres(db);
    const after2 = db.prepare('SELECT id, name FROM genres ORDER BY id').all();

    assert.equal(stats2.renamed, 0, 'no further renames on a canonical DB');
    assert.equal(stats2.merged,  0, 'no further merges on a canonical DB');
    assert.deepEqual(plain(after2), plain(after1));
    db.close();
  });

  test('preserves unknown-to-MB genres unchanged', () => {
    const db = dbAtCurrent();
    insertGenre(db, 'VaporTwitch');
    insertGenre(db, 'My Niche Genre');

    const stats = canonicaliseExistingGenres(db);
    assert.equal(stats.renamed, 0);
    assert.equal(stats.merged, 0);

    const names = db.prepare('SELECT name FROM genres ORDER BY name').all().map(r => r.name);
    assert.deepEqual(names, ['My Niche Genre', 'VaporTwitch']);
    db.close();
  });

  test('no-op on an empty genres table', () => {
    const db = dbAtCurrent();
    const stats = canonicaliseExistingGenres(db);
    assert.equal(stats.renamed, 0);
    assert.equal(stats.merged, 0);
    db.close();
  });

  test('merge survives even when source row has multiple linked tracks', () => {
    // Realistic case: a library has 40 tracks tagged "Hip-Hop" and 10
    // tagged "Hip Hop". After merge, all 50 link to the surviving row.
    const db = dbAtCurrent();
    const hipDashId = insertGenre(db, 'Hip-Hop');
    const hipSpcId  = insertGenre(db, 'Hip Hop');
    const tracks = [];
    for (let i = 0; i < 5; i++) {
      const t = seedTrack(db, `track-dash-${i}.mp3`);
      tracks.push(t);
      linkTrackGenre(db, t, hipDashId);
    }
    for (let i = 0; i < 3; i++) {
      const t = seedTrack(db, `track-spc-${i}.mp3`);
      tracks.push(t);
      linkTrackGenre(db, t, hipSpcId);
    }

    canonicaliseExistingGenres(db);

    // Every track now links to the surviving row.
    for (const t of tracks) {
      const links = db.prepare(
        'SELECT genre_id FROM track_genres WHERE track_id = ?'
      ).all(t);
      assert.equal(links.length, 1, `track ${t} should have 1 link`);
      assert.equal(links[0].genre_id, hipSpcId);
    }

    // hipDashId row is gone.
    const survivors = db.prepare(
      `SELECT id FROM genres WHERE name IN ('Hip-Hop', 'Hip Hop') ORDER BY id`
    ).all();
    assert.deepEqual(plain(survivors), [{ id: hipSpcId }]);
    db.close();
  });
});
