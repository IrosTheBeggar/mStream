/**
 * V78: audio_analysis_lookups keeps the bpm / musical_key essentia measured,
 * seeded from tracks whose values are provably essentia's (bpm_source =
 * 'essentia'), for every ledger outcome. A 'tag' row is never a source — a
 * tag value in the ledger would come back through the worker's refill after
 * the user removed the tag. Not rescanRequired; the scanner contract stays.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SCANNER_SCHEMA_CONTRACT, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

describe('V78 audio_analysis_lookups measured values', () => {
  test('registered as plain SQL, not rescanRequired, no scanner contract change', () => {
    const v78 = MIGRATIONS.find((m) => m.version === 78);
    assert.ok(v78, 'missing v78 migration');
    assert.match(v78.sql, /ALTER TABLE audio_analysis_lookups ADD COLUMN bpm/);
    assert.match(v78.sql, /ALTER TABLE audio_analysis_lookups ADD COLUMN musical_key/);
    assert.ok(!v78.rescanRequired, 'a forced rescan by a pre-fix scanner is exactly the wipe being fixed');
    assert.ok(SCHEMA_VERSION >= 78);
    assert.notEqual(SCANNER_SCHEMA_CONTRACT, 78, 'the scanners never read or write the new columns');
  });

  test('the seed copies essentia values for every outcome and never a tag value', () => {
    const db = freshDb();
    applyAllMigrations(db, { upToVersion: 77 });
    assert.ok(!columns(db, 'audio_analysis_lookups').includes('bpm'));
    db.prepare("INSERT INTO libraries (name, root_path) VALUES ('m', '/m')").run();
    const track = (fp, { audio = null, file = `f-${fp}`, bpm = null, key = null, src = null }) => db.prepare(`
      INSERT INTO tracks (filepath, library_id, title, file_hash, audio_hash, bpm, musical_key, bpm_source)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)`).run(fp, fp, file, audio, bpm, key, src);
    const ledger = (hash, outcome) => db.prepare(`
      INSERT INTO audio_analysis_lookups (audio_hash, last_attempt_at, outcome, attempts) VALUES (?, 100, ?, 1)`)
      .run(hash, outcome);

    track('pure', { audio: 'h-pure', bpm: 93, key: 'E major', src: 'essentia' });     ledger('h-pure', 'analyzed');
    track('half', { audio: 'h-half', bpm: 93, src: 'essentia' });                      ledger('h-half', 'analyzed');
    track('mixed', { audio: 'h-mixed', bpm: 128, key: 'C minor', src: 'tag' });        ledger('h-mixed', 'analyzed');
    track('stuck', { audio: 'h-stuck' });                                              ledger('h-stuck', 'analyzed');
    // A half-analysed track retried after its cooldown — the ledger now says
    // lowconf / error, yet the values on the track are essentia's.
    track('lowconf', { audio: 'h-lowconf', bpm: 90, src: 'essentia' });                ledger('h-lowconf', 'lowconf');
    track('error', { audio: 'h-error', key: 'A minor', src: 'essentia' });             ledger('h-error', 'error');
    // Two copies of one audio, one tagged since: the essentia copy seeds.
    track('dup-tag', { audio: 'h-dup', bpm: 140, key: 'Bm', src: 'tag' });
    track('dup-ess', { audio: 'h-dup', bpm: 97, key: 'D major', src: 'essentia' });    ledger('h-dup', 'analyzed');
    // A track keyed by file_hash alone (no audio hash extracted).
    track('fileonly', { audio: null, file: 'h-file', bpm: 91, key: 'G major', src: 'essentia' }); ledger('h-file', 'analyzed');

    applyAllMigrations(db, { fromVersion: 77 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const rows = Object.fromEntries(db.prepare(
      'SELECT audio_hash, outcome, bpm, musical_key FROM audio_analysis_lookups ORDER BY audio_hash').all()
      .map((r) => [r.audio_hash, [r.outcome, r.bpm, r.musical_key]]));
    assert.deepEqual(rows, {
      'h-pure': ['analyzed', 93, 'E major'],
      'h-half': ['analyzed', 93, null],
      'h-mixed': ['analyzed', null, null],      // ambiguous: left value-less (legacy rule)
      'h-stuck': ['analyzed', null, null],      // legacy: eligible again
      'h-lowconf': ['lowconf', 90, null],
      'h-error': ['error', null, 'A minor'],
      'h-dup': ['analyzed', 97, 'D major'],
      'h-file': ['analyzed', 91, 'G major'],
    });
    db.close();
  });

  test('a fresh install has the columns and an empty ledger', () => {
    const db = freshDb();
    applyAllMigrations(db);
    assert.ok(columns(db, 'audio_analysis_lookups').includes('bpm'));
    assert.ok(columns(db, 'audio_analysis_lookups').includes('musical_key'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audio_analysis_lookups').get().n, 0);
    db.close();
  });
});
