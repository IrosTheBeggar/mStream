/**
 * Model-mood sync tests — V80 track_moods + the reconcile in
 * src/db/mood-sync.js that mirrors discovery_tracks.mood_scores into it.
 *
 * Same harness as genre-sync.test.mjs: the injectable core against a fresh
 * in-memory mstream.db (full migrations) and a temp-file discovery.db.
 * Covers:
 *
 *   - V80 shape: track_moods columns, cascade with the track.
 *   - the registry contract: the effnet heads are exactly the columns.
 *   - parseMoodScores: column order, missing keys, junk.
 *   - reconcile: every track sharing a hash, idempotence, score changes,
 *     NULL scores clearing rows, inactive-model rows left alone, unknown
 *     hashes / malformed payloads skipped; removeModelMoods.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { applyAllMigrations } from '../helpers/apply-migrations.mjs';
import {
  MOOD_COLUMNS, parseMoodScores, reconcileModelMoods, removeModelMoods,
} from '../../src/db/mood-sync.js';
import { EMBEDDING_MODELS, activeMoodVersion } from '../../src/db/discovery-features-lib.js';
import { initDiscoveryDb, closeDiscoveryDb } from '../../src/db/discovery-db.js';

const MODEL = 'test-model';
const EMB = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
const SCORES = {
  danceable: 0.81, happy: 0.2, sad: 0.05, relaxed: 0.4,
  aggressive: 0.01, party: 0.6, acoustic: 0.1, instrumental: 0.9,
};

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
function seedDiscoveryRow(hash, moodScores, modelId = MODEL) {
  ddb.prepare(`
    INSERT OR REPLACE INTO discovery_tracks
      (audio_hash, updated_at, export_id, artist, title, duration, model_id, model_version, embedding,
       mood_scores, mood_version)
    VALUES (?, ?, ?, 'Artist', 'Title', 120, ?, '1', ?, ?, ?)
  `).run(hash, ++seq, `anon:${hash}:${seq}`, modelId, EMB,
    moodScores === null ? null : (typeof moodScores === 'string' ? moodScores : JSON.stringify(moodScores)),
    moodScores === null ? null : '1');
}

function moodRow(db, trackId) {
  return db.prepare('SELECT * FROM track_moods WHERE track_id = ?').get(trackId) ?? null;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-mood-sync-'));
  ddb = initDiscoveryDb(path.join(tmpDir, 'discovery.db'));
});

after(() => {
  closeDiscoveryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  ddb.exec('DELETE FROM discovery_tracks');
});

// ── V80 schema shape + the registry contract ────────────────────────────────

describe('V80 schema shape', () => {
  test('SCHEMA_VERSION covers V80 and the migration is registered', () => {
    assert.ok(SCHEMA_VERSION >= 80, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
    const v80 = MIGRATIONS.find((m) => m.version === 80);
    assert.ok(v80, 'missing v80 migration');
    assert.ok(!v80.rescanRequired, 'a new table — no rescan');
  });

  test('track_moods has a column per head and goes with its track', () => {
    const db = freshMain();
    const cols = db.prepare('PRAGMA table_info(track_moods)').all().map((c) => c.name);
    assert.deepEqual(cols, ['track_id', ...MOOD_COLUMNS]);

    db.prepare('INSERT INTO track_moods (track_id, happy) VALUES (100, 0.5)').run();
    db.prepare('DELETE FROM tracks WHERE id = 100').run();
    assert.equal(moodRow(db, 100), null, 'ON DELETE CASCADE');
    db.close();
  });

  test('the effnet heads are exactly the table columns, each with a pinned file', () => {
    const { moods } = EMBEDDING_MODELS['effnet-discogs'];
    assert.deepEqual(moods.heads.map((h) => h.key).sort(), [...MOOD_COLUMNS].sort());
    for (const h of moods.heads) {
      assert.ok(h.positive === 0 || h.positive === 1, `${h.key}: positive class index`);
      assert.match(h.file.sha256, /^[0-9a-f]{64}$/, `${h.key}: sha256 pin`);
      assert.match(h.file.url, /^https:\/\/github\.com\/IrosTheBeggar\/mStream\/releases\/download\//,
        `${h.key}: project-hosted mirror`);
      assert.ok(h.file.url.endsWith(`/${h.file.filename}`));
    }
    assert.equal(new Set(moods.heads.map((h) => h.file.filename)).size, moods.heads.length);
  });

  test('activeMoodVersion: the model pin, or null when off or headless', () => {
    assert.equal(activeMoodVersion({ discoveryModel: 'effnet-discogs' }), EMBEDDING_MODELS['effnet-discogs'].moods.version);
    assert.equal(activeMoodVersion({ discoveryModel: 'effnet-discogs', analyzeMoods: false }), null);
    assert.equal(activeMoodVersion({ discoveryModel: 'no-such-model' }), null);
  });
});

// ── parseMoodScores ─────────────────────────────────────────────────────────

describe('parseMoodScores', () => {
  test('orders scores by column; missing and non-numeric keys are NULL', () => {
    const out = parseMoodScores(JSON.stringify({ happy: 0.5, instrumental: 1, sad: 'x', extra: 0.3 }));
    assert.equal(out.length, MOOD_COLUMNS.length);
    assert.equal(out[MOOD_COLUMNS.indexOf('happy')], 0.5);
    assert.equal(out[MOOD_COLUMNS.indexOf('instrumental')], 1);
    assert.equal(out[MOOD_COLUMNS.indexOf('sad')], null);
    assert.equal(out[MOOD_COLUMNS.indexOf('danceable')], null);
  });

  test('malformed payloads are rejected', () => {
    assert.equal(parseMoodScores('not json'), null);
    assert.equal(parseMoodScores('[0.1, 0.2]'), null);
    assert.equal(parseMoodScores('null'), null);
  });
});

// ── reconcile core ──────────────────────────────────────────────────────────

describe('reconcileModelMoods', () => {
  test('writes a row for every track sharing the canonical hash', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    const stats = reconcileModelMoods(db, ddb, MODEL);

    assert.equal(stats.written, 2);
    for (const id of [100, 102]) {
      const row = moodRow(db, id);
      for (const k of MOOD_COLUMNS) { assert.equal(row[k], SCORES[k], `${id}.${k}`); }
    }
    assert.equal(moodRow(db, 103), null, 'unrelated track untouched');
    db.close();
  });

  test('file_hash fallback resolves tracks with no audio_hash', () => {
    const db = freshMain();
    seedDiscoveryRow('h2', { happy: 0.7 });
    reconcileModelMoods(db, ddb, MODEL);
    assert.equal(moodRow(db, 101).happy, 0.7);
    db.close();
  });

  test('idempotent: a second run writes nothing', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    const stats = reconcileModelMoods(db, ddb, MODEL);
    assert.equal(stats.written, 0);
    assert.equal(stats.removed, 0);
    db.close();
  });

  test('changed scores rewrite the row', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    seedDiscoveryRow('h1', { ...SCORES, happy: 0.95 });
    const stats = reconcileModelMoods(db, ddb, MODEL);
    assert.equal(stats.written, 2);
    assert.equal(moodRow(db, 100).happy, 0.95);
    db.close();
  });

  test('a row re-written without scores (moods off) clears the tracks', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    seedDiscoveryRow('h1', null);
    const stats = reconcileModelMoods(db, ddb, MODEL);
    assert.equal(stats.removed, 2);
    assert.equal(moodRow(db, 100), null);
    assert.equal(moodRow(db, 102), null);
    db.close();
  });

  test('rows pinned to another model are left alone (mid-migration stability)', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    const stats = reconcileModelMoods(db, ddb, 'other-model');
    assert.equal(stats.rows, 0);
    assert.equal(moodRow(db, 100).happy, SCORES.happy);
    db.close();
  });

  test('unknown hashes and malformed payloads are skipped without damage', () => {
    const db = freshMain();
    seedDiscoveryRow('h4', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    seedDiscoveryRow('gone-from-library', SCORES);
    seedDiscoveryRow('h4', 'not valid json');
    seedDiscoveryRow('h1', SCORES);

    const stats = reconcileModelMoods(db, ddb, MODEL);
    assert.equal(stats.rows, 1, 'only the healthy, mapped row counts');
    assert.equal(moodRow(db, 103).happy, SCORES.happy, 'malformed payload leaves its row as it was');
    assert.equal(moodRow(db, 100).happy, SCORES.happy);
    db.close();
  });

  test('removeModelMoods empties the table', () => {
    const db = freshMain();
    seedDiscoveryRow('h1', SCORES);
    reconcileModelMoods(db, ddb, MODEL);
    assert.equal(removeModelMoods(db), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_moods').get().n, 0);
    assert.equal(removeModelMoods(db), 0, 'nothing left to remove');
    db.close();
  });
});
